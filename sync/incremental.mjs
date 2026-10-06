#!/usr/bin/env node
// Sincronización incremental D1 -> PostgreSQL (FASE4.md sección 8).
//
// Mecanismo elegido: timestamps de modificación (columna "updated_at" o,
// para tablas de solo-inserción, "created_at") + comparación de conjunto
// de IDs para detectar borrados en las tablas donde D1 permite DELETE.
// Ver sync/tables.mjs para la justificación tabla a tabla y
// SINCRONIZACION-INCREMENTAL.md para el resumen.
//
// Por qué esto y no otras opciones del documento:
//  - "Cada minuto copiar todas las tablas" (lo que la Fase 4 pide evitar
//    explícitamente): coste O(todas las filas) en cada pasada aunque no
//    cambie nada. Con timestamps el coste es O(filas cambiadas).
//  - IDs incrementales solos: no detectan UPDATEs, solo altas.
//  - Journal/outbox (tabla de cambios escrita por el Worker principal):
//    sería más preciso y detectaría deletes sin comparar IDs, pero exige
//    tocar cada INSERT/UPDATE/DELETE del Worker principal (prohibido por
//    la sección 13: "no modificar la API principal innecesariamente").
//    Los triggers de SQLite (migracion_fase4_sync_tracking.sql) consiguen
//    lo mismo que un outbox para "cuándo cambió algo" sin tocar
//    src/index.js -son la vía menos invasiva-.
//
// Garantías de "no duplicados / no reinicio a medias" (sección 10):
//  - Cada fila se procesa con upsertFila (INSERT ... ON CONFLICT DO
//    UPDATE), que es idempotente por construcción: aplicar la misma fila
//    dos veces dejacomo resultado el mismo estado.
//  - El cursor de cada tabla solo se guarda DESPUÉS de que todas las filas
//    de ese lote se hayan escrito correctamente, así que un corte a mitad
//    de tabla simplemente reprocesa (sin duplicar, por el punto anterior)
//    las mismas filas en la siguiente pasada.
//  - No hay ejecución concurrente: sync_state antes de invocar el
//    scheduler (ver sync/scheduler.mjs) comprueba si ya hay una fila con
//    status = 'running' y, si la hay, se salta esa pasada.

import { pathToFileURL } from "node:url";
import pg from "pg";
import { ejecutarD1, ejecutarD1Paginado, ejecutarD1PaginadoSoloIds, escaparValorD1 } from "./d1-client.mjs";
import { TABLES_IN_ORDER, DEPENDENCIAS_FK } from "./tables.mjs";
import {
  obtenerColumnasPostgres,
  existeTablaPostgres,
  upsertFila,
  upsertFilasLote,
  eliminarFila,
  obtenerIdsPostgresPaginado,
  reconciliarFilasPorOriginWriteId,
  desacoplarUsuarioHuerfano,
  desacoplarResultadoHuerfano,
  sincronizarSecuencia,
  reordenarTablaPorClave,
  escaparIdentificador,
} from "./pg-writer.mjs";

// Antes de borrar una fila huérfana (existe en Postgres pero ya no en D1)
// hay que desacoplar las FKs que otras tablas de Postgres tienen apuntando
// a ella, igual que hace reconciliarTablaAutoritativa (pg-writer.mjs) y que
// worker/src/index.js hace en D1 antes de borrar. Sin esto, el DELETE falla
// por violación de clave foránea (fk_.._autor, fk_sessions_user, etc.) y la
// tabla entera queda marcada "con error" -bloqueando en cascada a sus tablas
// hijas vía DEPENDENCIAS_FK- de forma indefinida, pasada tras pasada.
async function desacoplarHuerfanoSiAplica(client, table, pkValues) {
  if (table === "users") {
    await desacoplarUsuarioHuerfano(client, pkValues[0]);
  } else if (table === "results") {
    await desacoplarResultadoHuerfano(client, pkValues[0]);
  }
}
import { conReintentos } from "./retry.mjs";
import {
  nuevoRunId,
  registrarInicio,
  registrarFin,
  leerCursor,
  guardarCursor,
  ultimaEjecucion,
} from "./state.mjs";

const { Client } = pg;

function pkValuesFromRow(row, pk) {
  return pk.map((c) => row[c]);
}
function pkKey(row, pk) {
  return pk.map((c) => String(row[c])).join("\u0000");
}

// Columnas UNIQUE (aparte de la PK) cuyo conflicto se resuelve borrando la fila
// obsoleta de Postgres. Caso real: un usuario se borra en D1 y se vuelve a
// crear con el mismo username (id nuevo). Postgres todavía tiene la fila
// vieja con ese username, así que el upsert de la fila nueva falla con
// "users_username_key" y, como el borrado de huérfanos va DESPUÉS del upsert,
// la tabla se quedaba en error pasada tras pasada.
//
// Cada entrada es el nombre de una columna o un array de columnas (UNIQUE
// compuesto):
//  - users.username: ver arriba.
//  - push_subscriptions.endpoint: un lector se da de baja (DELETE) y se
//    vuelve a suscribir con el mismo endpoint -> id nuevo en D1; Postgres
//    aún tiene la fila vieja.
//  - votaciones_internas_votos (opcion_id, usuario_id): cambiar un voto
//    nominal en D1 es DELETE + INSERT con id nuevo para la misma pareja;
//    el upsert llega a Postgres ANTES de que el borrado de huérfanos
//    retire la fila vieja y chocaría con el UNIQUE.
const UNICOS_RESOLUBLES = {
  users: ["username"],
  push_subscriptions: ["endpoint"],
  votaciones_internas_votos: [["opcion_id", "usuario_id"]],
};

// Devuelve la columna (o array de columnas) UNIQUE implicada si el error es
// un conflicto resoluble (23505 sobre una entrada de UNICOS_RESOLUBLES); si
// no, null.
function columnaUnicaEnConflicto(error, table) {
  if (error?.code !== "23505") return null;
  const candidatas = UNICOS_RESOLUBLES[table];
  if (!candidatas) return null;
  for (const col of candidatas) {
    const cols = Array.isArray(col) ? col : [col];
    if (error.constraint === `${table}_${cols.join("_")}_key`) return col;
  }
  // Fallback por el detalle ("Key (username)=(ana) already exists." o
  // "Key (opcion_id, usuario_id)=(3, 7) already exists."); el patrón
  // también vale con mensajes localizados de Postgres.
  const m = /\(([^)]+)\)=\(/.exec(error.detail || "");
  if (!m) return null;
  const enDetalle = m[1].split(",").map((c) => c.trim());
  return (
    candidatas.find((col) => {
      const cols = Array.isArray(col) ? col : [col];
      return cols.length === enDetalle.length && cols.every((c, i) => c === enDetalle[i]);
    }) ?? null
  );
}

/**
 * Borra de Postgres las filas que ocupan el mismo valor UNIQUE (p.ej. el
 * username) que \`row\` pero con OTRA PK, siempre que esa PK ya no exista en
 * D1 (D1 es la autoridad). Desacopla antes las FKs que apuntan a la fila
 * (desacoplarHuerfanoSiAplica) y todo va en una transacción: o se desacopla
 * y borra, o no cambia nada. Devuelve cuántas filas se borraron.
 *
 * Si la PK "obsoleta" sigue viva en D1 (p.ej. dos usuarios intercambian
 * username y el orden de procesado choca a mitad de pasada), NO se borra
 * nada y se lanza un error explicativo: se arreglará solo cuando esa fila
 * se sincronice.
 */
export async function eliminarFilaObsoletaPorUnico(client, table, row, pk, column, { runId, leerD1 = ejecutarD1 } = {}) {
  // "column" es una columna o un array de columnas (UNIQUE compuesto).
  const columnas = Array.isArray(column) ? column : [column];
  const etiqueta = columnas.map((c) => `${c}="${row[c]}"`).join(", ");
  const pkCols = pk.map(escaparIdentificador).join(", ");
  const mismoUnico = columnas.map((c, i) => `${escaparIdentificador(c)} = $${i + 1}`).join(" AND ");
  const mismaPk = pk.map((c, i) => `${escaparIdentificador(c)} = $${columnas.length + i + 1}`).join(" AND ");
  const obsoletas = await client.query(
    `SELECT ${pkCols} FROM ${escaparIdentificador(table)} WHERE ${mismoUnico} AND NOT (${mismaPk});`,
    [...columnas.map((c) => row[c]), ...pkValuesFromRow(row, pk)]
  );
  if (obsoletas.rows.length === 0) return 0;

  let borradas = 0;
  for (const obsoleta of obsoletas.rows) {
    const pkObsoleta = pkValuesFromRow(obsoleta, pk);
    const clave = pkKey(obsoleta, pk);

    const condD1 = pk.map((c, i) => `${c} = ${escaparValorD1(pkObsoleta[i])}`).join(" AND ");
    const enD1 = await leerD1(`SELECT ${pk.join(", ")} FROM ${table} WHERE ${condD1} LIMIT 1;`);
    if (enD1.length > 0) {
      throw new Error(
        `Conflicto de ${etiqueta} en ${table}: Postgres lo tiene en la fila ${clave} y D1 ` +
        `lo asigna a ${pkKey(row, pk)}, pero la fila ${clave} sigue existiendo en D1 (¿cambio de ${columnas.join(", ")} entre ` +
        `filas vivas?). No se borra nada; se resolverá cuando se sincronice la fila ${clave}.`
      );
    }

    await client.query("BEGIN");
    try {
      await desacoplarHuerfanoSiAplica(client, table, pkObsoleta);
      if (await eliminarFila(client, table, pk, pkObsoleta)) borradas++;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    console.warn(
      `[${table}] conflicto de ${etiqueta}: borrada la fila obsoleta ${clave} de Postgres ` +
      `(ya no existe en D1) para poder insertar ${pkKey(row, pk)}.`
    );
    if (runId) {
      // Constancia en sync_deletions, igual que los borrados de huérfanos.
      // Best-effort: ya está commiteado, un fallo aquí no debe tumbar la fila.
      await client.query(
        `INSERT INTO sync_deletions (table_name, record_id, run_id) VALUES ($1, $2, $3);`,
        [table, clave, runId]
      ).catch((e) => console.warn(`[${table}] no se pudo registrar el borrado en sync_deletions: ${e.message}`));
    }
  }
  return borradas;
}

/**
 * upsertFila que, ante un conflicto UNIQUE resoluble (ver UNICOS_RESOLUBLES),
 * borra la fila obsoleta de Postgres y reintenta UNA vez. Cualquier otro
 * error (o un segundo fallo) se propaga tal cual.
 */
export async function upsertFilaResolviendoConflicto(client, table, row, columnas, pk, { runId, detalle, leerD1 } = {}) {
  try {
    return await upsertFila(client, table, row, columnas, pk, { onConflictAction: "update" });
  } catch (error) {
    const columna = columnaUnicaEnConflicto(error, table);
    if (!columna) throw error;
    const borradas = await eliminarFilaObsoletaPorUnico(client, table, row, pk, columna, { runId, leerD1 });
    if (borradas === 0) throw error; // el conflicto no era con una fila obsoleta: no es cosa nuestra
    if (detalle) detalle.deleted += borradas;
    return upsertFila(client, table, row, columnas, pk, { onConflictAction: "update" });
  }
}

// Límite de filas por lote (ya existía: 250) MÁS un límite de bytes
// estimados por lote. El límite por filas por sí solo no protege contra
// tablas con columnas de texto largo (articles.contenido, un artículo con
// HTML/imágenes embebidas puede pesar cientos de KB por fila): 250 filas
// de ese tipo podrían seguir siendo varios MB en un único array de
// `valores` + el string SQL con todos los placeholders, antes de llegar
// siquiera a Postgres. Con este segundo límite, un lote se corta antes de
// las 250 filas si el contenido ya pesa demasiado, y se corta después si
// las filas son ligeras (no penaliza tablas normales con más round-trips
// de los necesarios).
const LOTE_MAX_FILAS = 250;
const LOTE_MAX_BYTES = 4 * 1024 * 1024; // 4MB estimados por lote

// Umbral de aviso de memoria del proceso (RSS), configurable por env var
// para adaptarlo al plan/contenedor real sin tocar código (p.ej. Railway
// free vs un plan con más RAM). Por defecto 400MB: generoso respecto a lo
// que debería consumir este proceso con la lectura paginada, pero por
// debajo del límite típico de un plan pequeño, para avisar con margen.
const UMBRAL_AVISO_RSS_MB = Number(process.env.SYNC_RSS_WARN_MB || 400);

function tamanoAproximadoFila(row) {
  // Estimación barata (no un stringify exacto de todo el objeto en cada
  // fila, que sería el propio coste que queremos evitar): suma la
  // longitud de los valores tipo string/Buffer, que es donde vive
  // prácticamente todo el peso real (contenido HTML, JSON en texto,
  // imágenes en base64 si las hubiera, etc.). Números/booleans/null se
  // cuentan con un coste fijo pequeño.
  let total = 0;
  for (const key in row) {
    const value = row[key];
    if (typeof value === "string") total += value.length;
    else if (Buffer.isBuffer(value)) total += value.length;
    else total += 16;
  }
  return total;
}

/**
 * Trocea un array de filas en sub-lotes respetando DOS límites a la vez:
 * como máximo LOTE_MAX_FILAS filas, y como máximo ~LOTE_MAX_BYTES
 * estimados de contenido. El primer límite que se alcance cierra el lote.
 * Una fila individual que ya supere LOTE_MAX_BYTES por sí sola no se
 * descarta ni se trunca -eso rompería la sincronización de esa fila-,
 * simplemente forma un lote de tamaño 1.
 */
function* trocearEnLotes(filas, { maxFilas = LOTE_MAX_FILAS, maxBytes = LOTE_MAX_BYTES } = {}) {
  let lote = [];
  let bytesLote = 0;
  for (const row of filas) {
    const bytesFila = tamanoAproximadoFila(row);
    if (lote.length > 0 && (lote.length >= maxFilas || bytesLote + bytesFila > maxBytes)) {
      yield lote;
      lote = [];
      bytesLote = 0;
    }
    lote.push(row);
    bytesLote += bytesFila;
  }
  if (lote.length > 0) yield lote;
}

async function hayEjecucionEnCurso(client) {
  const ultima = await ultimaEjecucion(client);
  if (!ultima || ultima.status !== "running") return false;
  // Salvaguarda: si una ejecución quedó "running" por un crash del
  // proceso (nunca llegó a registrarFin), no bloqueamos para siempre.
  // Un run que lleva "running" más de 30 minutos se considera abandonado.
  const iniciado = new Date(ultima.started_at).getTime();
  const minutos = (Date.now() - iniciado) / 60000;
  // Un proceso normal de esta sincronización debe avanzar y cerrar el
  // registro. Si quedó huérfano (por Ctrl+C, cierre de PowerShell, etc.)
  // no debemos bloquear todas las siguientes pasadas durante 30 minutos.
  // A partir de 3 minutos se considera stale y se libera automáticamente.
  if (minutos >= 3) {
    await client.query(
      `UPDATE sync_state
       SET status = 'abandoned', finished_at = CURRENT_TIMESTAMP,
           detail = COALESCE(detail::jsonb, '{}'::jsonb) || jsonb_build_object('reason', 'stale_lock_auto_released')
       WHERE run_id = $1 AND status = 'running';`,
      [ultima.run_id]
    );
    console.warn(`Liberando sincronización huérfana ${ultima.run_id} (${minutos.toFixed(1)} min).`);
    return false;
  }
  return true;
}

// Envuelve la sincronización de una tabla y, al terminar, adelanta su
// secuencia autoincremental a MAX(id) (ver sincronizarSecuencia en
// pg-writer.mjs): sin esto, los inserts sin id que hace Railway después
// chocan con los ids copiados desde D1 ("duplicate key ... _pkey").
// Un fallo aquí no invalida la sincronización de la tabla: se avisa y sigue.
async function sincronizarTabla(client, tableConfig, opts) {
  const detalle = await sincronizarTablaSinSecuencia(client, tableConfig, opts);
  // Tablas de voto secreto: si la pasada cambió algo, se reordenan por PK
  // para que el orden físico no delate el orden de llegada (ver
  // reordenarTablaPorClave en pg-writer.mjs). Un fallo no invalida la
  // sincronización, pero queda anotado como aviso visible.
  if (tableConfig.ordenFisicaPorClave && detalle.inserted + detalle.updated + detalle.deleted > 0) {
    try {
      await reordenarTablaPorClave(client, tableConfig.name);
    } catch (error) {
      console.error(`[${tableConfig.name}] AVISO PRIVACIDAD: no se pudo reordenar la tabla por su PK: ${error.message}`);
      (detalle.warnings ??= []).push(`reordenado por PK: ${error.message}`);
    }
  }
  try {
    if (tableConfig.pk && tableConfig.pk.length === 1) {
      await sincronizarSecuencia(client, tableConfig.name, tableConfig.pk[0]);
    }
  } catch (error) {
    console.warn(`[${tableConfig.name}] no se pudo sincronizar la secuencia: ${error.message}`);
  }
  return detalle;
}

async function sincronizarTablaSinSecuencia(client, tableConfig, { runId }) {
  const { name, pk, changeStrategy, cursorColumn, deleteDetection } = tableConfig;

  const detalle = { table: name, inserted: 0, updated: 0, deleted: 0, errors: [] };
  console.log(`[${name}] inicio`);

  const existe = await existeTablaPostgres(client, name);
  if (!existe) {
    detalle.errors.push("La tabla no existe en PostgreSQL, se omite.");
    return detalle;
  }

  // SYNC_FULL=1 ignora el cursor y relee la tabla entera (resincronización completa puntual).
  const cursor = process.env.SYNC_FULL === "1" ? null : await leerCursor(client, name);
  const columnasPG = await obtenerColumnasPostgres(client, name);

  // Estas tablas son autoritativas: en cada pasada D1 se considera la copia
  // canónica y PostgreSQL se reconcilia hasta quedar exactamente igual.
  // Esto corrige también diferencias históricas que un cursor incremental no
  // detectaría (por ejemplo una fila extra en PG o un valor antiguo).
  //
  // IMPORTANTE (pico de memoria en Railway free): esto se leía antes con un
  // único "SELECT * FROM tabla;" que traía la tabla ENTERA a memoria de
  // golpe (vía subproceso wrangler, con hasta 200MB de buffer) en cada
  // pasada del scheduler -cada 60s por defecto, para 10 tablas
  // "authoritative"-, lo que hacía saltar el límite de RAM del plan free y
  // tumbaba el proceso. Ahora se lee con ejecutarD1Paginado (ver
  // d1-client.mjs): página a página por cursor de PK, aplicando el upsert
  // de cada página contra Postgres antes de pedir la siguiente, así que en
  // memoria solo hay como mucho una página (500 filas) de la tabla en vez
  // de la tabla completa.
  if (tableConfig.syncMode === "authoritative") {
    console.log(`[${name}] leyendo D1 por páginas (reconciliación autoritativa)...`);

    let columnasUtilizables = null; // se fija con la primera página no vacía
    let ultimoCursorValor = cursor?.last_synced_at ?? null;
    const idsVistosEnD1 = new Set(); // solo PKs (string), no filas completas: ligero incluso en tablas grandes
    let totalFilas = 0;
    let erroresColumnas = false;

    try {
      await ejecutarD1Paginado(
        name,
        pk, // una columna o PK compuesta (votaciones_internas_participacion); ver ejecutarD1Paginado
        async (pagina) => {
          totalFilas += pagina.length;

          if (columnasUtilizables === null) {
            columnasUtilizables = Object.keys(pagina[0]).filter((c) => columnasPG.includes(c));
            const faltanEnPG = Object.keys(pagina[0]).filter((c) => !columnasPG.includes(c));
            if (faltanEnPG.length > 0) {
              const motivo = `Columnas D1 sin equivalente en PG: ${faltanEnPG.join(", ")}`;
              detalle.errors.push(motivo);
              // Antes esto solo quedaba en detalle.errors (guardado en
              // sync_runs.detail vía registrarFin) y nunca se imprimía por
              // consola: en los logs de Railway la tabla desaparecía en
              // silencio entre "leyendo D1 por páginas..." y la siguiente
              // tabla, sin ninguna pista de qué había fallado ni de que
              // había fallado. Ver migración 029_results_slug.sql para un
              // caso real que costó bastante diagnosticar por este motivo.
              console.error(`[${name}] ERROR: ${motivo}. Faltan por crear en PostgreSQL (ALTER TABLE ${name} ADD COLUMN ...). Se aborta esta tabla en esta pasada.`);
              erroresColumnas = true;
              return; // ejecutarD1Paginado sigue pidiendo páginas; se corta abajo con el flag
            }
          }
          if (erroresColumnas) return;

          for (const row of pagina) idsVistosEnD1.add(pkKey(row, pk));

          // Igual que en la rama incremental: resuelve primero huérfanas de
          // failover por origin_write_id antes del upsert normal por PK
          // (ver reconciliarFilasPorOriginWriteId en pg-writer.mjs).
          const reconciliacionWriteId = await conReintentos(
            () => reconciliarFilasPorOriginWriteId(client, name, pagina, pk),
            {
              onRetry: ({ intento, error }) =>
                console.warn(`[${name}] reintento reconciliación por origin_write_id, página que termina en ${pagina[pagina.length - 1][pk[0]]} (${intento}): ${error.message}`),
            }
          );
          if (reconciliacionWriteId.huerfanasEliminadas > 0) {
            console.log(`[${name}] reconciliadas ${reconciliacionWriteId.huerfanasEliminadas} fila(s) huérfana(s) de failover por origin_write_id.`);
          }
          if (reconciliacionWriteId.conflictos.length > 0) {
            detalle.errors.push(`${reconciliacionWriteId.conflictos.length} conflicto(s) de origin_write_id sin resolver, ver sync_write_id_conflicts.`);
          }

          try {
            let insertedPagina = 0;
            let updatedPagina = 0;
            for (const subLote of trocearEnLotes(pagina)) {
              const resultado = await conReintentos(
                () => upsertFilasLote(client, name, subLote, columnasUtilizables, pk),
                {
                  onRetry: ({ intento, error }) =>
                    console.warn(`[${name}] reintento sub-lote (${subLote.length} filas) de página que termina en ${pagina[pagina.length - 1][pk[0]]} (${intento}): ${error.message}`),
                }
              );
              insertedPagina += resultado.inserted;
              updatedPagina += resultado.updated;
            }
            detalle.inserted += insertedPagina;
            detalle.updated += updatedPagina;
          } catch (paginaError) {
            console.warn(`[${name}] página falló; reintentando fila a fila: ${paginaError.message}`);
            for (const row of pagina) {
              try {
                const resultado = await conReintentos(() => upsertFilaResolviendoConflicto(client, name, row, columnasUtilizables, pk, { runId, detalle }));
                if (resultado === "inserted") detalle.inserted++;
                else if (resultado === "updated") detalle.updated++;
              } catch (error) {
                const key = pk.map((c) => String(row[c])).join("\u0000");
                detalle.errors.push(`Fila ${key}: ${error.message}`);
                console.error(`[${name}] error definitivo en fila ${key}:`, error.message);
              }
            }
          }

          for (const row of pagina) {
            const value = row[cursorColumn];
            if (value && (!ultimoCursorValor || value > ultimoCursorValor)) ultimoCursorValor = value;
          }
          console.log(`[${name}] progreso ${totalFilas} leídos de D1`);
        },
        { tamanoPagina: 500 }
      );
    } catch (error) {
      detalle.errors.push(`Reconciliación autoritativa: ${error.message}`);
      console.error(`[${name}] ERROR en reconciliación autoritativa (progreso parcial insertados=${detalle.inserted} actualizados=${detalle.updated}): ${error.message}`);
      console.log(`[${name}] fin: insertados=${detalle.inserted} actualizados=${detalle.updated} borrados=${detalle.deleted} errores=${detalle.errors.length}`);
      return detalle;
    }

    if (erroresColumnas) {
      console.log(`[${name}] fin: insertados=${detalle.inserted} actualizados=${detalle.updated} borrados=${detalle.deleted} errores=${detalle.errors.length} (abortada por columnas faltantes en PG)`);
      return detalle;
    }

    console.log(`[${name}] D1: ${totalFilas} registros`);

    // Borrados: cualquier fila que Postgres tenga y que no haya aparecido en
    // ninguna página de D1. idsVistosEnD1 es un Set de solo PKs (strings),
    // no las filas completas, así que sigue siendo barato incluso en tablas
    // con miles de filas.
    try {
      // Paginado por cursor server-side (obtenerIdsPostgresPaginado): en
      // tablas grandes (p.ej. comments, readers) evita traer TODOS los IDs
      // de Postgres de golpe a memoria del proceso Node solo para
      // compararlos contra idsVistosEnD1; se compara página a página.
      await obtenerIdsPostgresPaginado(client, name, pk, async (paginaPG) => {
        for (const row of paginaPG) {
          const key = pkKey(row, pk);
          if (!idsVistosEnD1.has(key)) {
            const pkValues = pkValuesFromRow(row, pk);
            try {
              await conReintentos(
                async () => {
                  await desacoplarHuerfanoSiAplica(client, name, pkValues);
                  return eliminarFila(client, name, pk, pkValues);
                },
                {
                  onRetry: ({ intento, error }) =>
                    console.warn(`[${name}] reintento borrado huérfano ${key} (${intento}): ${error.message}`),
                }
              );
              detalle.deleted++;
            } catch (error) {
              detalle.errors.push(`Borrado ${key}: ${error.message}`);
              console.error(`[${name}] no se pudo borrar el huérfano ${key}:`, error.message);
            }
          }
        }
      });
    } catch (error) {
      detalle.errors.push(`Detección de borrados (autoritativa): ${error.message}`);
      console.error(`[${name}] ERROR en detección de borrados (autoritativa):`, error.message);
    }

    if (ultimoCursorValor && ultimoCursorValor !== cursor?.last_synced_at) {
      await guardarCursor(client, name, { lastSyncedAt: ultimoCursorValor });
    }

    console.log(`[${name}] fin: insertados=${detalle.inserted} actualizados=${detalle.updated} borrados=${detalle.deleted} errores=${detalle.errors.length}`);
    return detalle;
  }

  // 1) Leer de D1 solo las filas cambiadas desde el cursor.
  //
  // IMPORTANTE (mismo problema de pico de RAM que en la rama
  // "authoritative", ver comentario más arriba): esto usaba un único
  // "SELECT * FROM tabla WHERE cursorColumn > ...;" -o, peor aún, sin
  // WHERE en absoluto la primera vez que corre (sin cursor todavía)- que
  // trae de golpe TODAS las filas cambiadas a memoria de Node. En tablas
  // no-authoritative con contenido largo (articles.contenido, etc.) o con
  // muchas filas (match_events, activity_log tras una jornada con muchos
  // partidos, o cualquier tabla en su primera pasada sin cursor) esto
  // podía ser tan grande como el "SELECT * FROM tabla" que ya se arregló
  // arriba. Se pagina igual, por el propio cursorColumn (que ya es la
  // columna de orden natural aquí, no hace falta el PK): cada página se
  // procesa (upsert en Postgres) antes de pedir la siguiente, así que en
  // memoria solo hay como mucho una página (250 filas) de la tabla.
  const TAMANO_PAGINA_INCREMENTAL = 500;
  console.log(`[${name}] leyendo D1 (incremental, por páginas)...`);

  let columnasUtilizables = null; // se fija con la primera página no vacía
  let ultimoCursorValor = cursor?.last_synced_at ?? null;
  let totalFilasLeidas = 0;

  async function procesarPaginaIncremental(pagina) {
    totalFilasLeidas += pagina.length;
    // Diagnóstico: si una sola página (500 filas como máximo) ya pesa
    // varios MB estimados, es una señal de que esta tabla tiene filas
    // mucho más pesadas de lo normal (p.ej. articles.contenido con mucho
    // HTML/base64) y merece bajar TAMANO_PAGINA_INCREMENTAL para esa
    // tabla en el futuro. No se aborta la sincronización por esto -los
    // límites reales (D1_MAX_BUFFER, LOTE_MAX_BYTES) ya cortan por su
    // cuenta-, es solo visibilidad para poder ajustar antes de que
    // llegue a ser un problema.
    const bytesPagina = pagina.reduce((acc, row) => acc + tamanoAproximadoFila(row), 0);
    if (bytesPagina > LOTE_MAX_BYTES) {
      console.warn(`[${name}] página de ${pagina.length} filas pesa ~${(bytesPagina / 1024 / 1024).toFixed(1)}MB estimados (por encima de ${(LOTE_MAX_BYTES / 1024 / 1024).toFixed(0)}MB) — considerar reducir TAMANO_PAGINA_INCREMENTAL para esta tabla.`);
    }
    if (columnasUtilizables === null) {
      columnasUtilizables = Object.keys(pagina[0]).filter((c) => columnasPG.includes(c));
    }

    for (const lote of trocearEnLotes(pagina)) {
      await procesarLoteIncremental(lote, `${lote.length} filas`);
    }
  }

  async function procesarLoteIncremental(lote, etiquetaLote) {
    try {
      // Igual que en la rama autoritativa: resuelve primero cualquier fila
      // huérfana de un failover antes del upsert normal por PK, para que
      // una fila reproducida desde D1 sustituya a su equivalente huérfana
      // de PostgreSQL en vez de duplicarse (ver
      // reconciliarFilasPorOriginWriteId en sync/pg-writer.mjs).
      const reconciliacionWriteId = await conReintentos(
        () => reconciliarFilasPorOriginWriteId(client, name, lote, pk),
        { onRetry: ({ intento, error }) => console.warn(`[${name}] reintento reconciliación por origin_write_id, lote ${etiquetaLote} (${intento}): ${error.message}`) }
      );
      if (reconciliacionWriteId.huerfanasEliminadas > 0) {
        console.log(`[${name}] reconciliadas ${reconciliacionWriteId.huerfanasEliminadas} fila(s) huérfana(s) de failover por origin_write_id (lote ${etiquetaLote}).`);
      }
      if (reconciliacionWriteId.conflictos.length > 0) {
        detalle.errors.push(`${reconciliacionWriteId.conflictos.length} conflicto(s) de origin_write_id sin resolver en lote ${etiquetaLote}, ver sync_write_id_conflicts.`);
      }

      const resultado = await conReintentos(
        () => upsertFilasLote(client, name, lote, columnasUtilizables, pk),
        { onRetry: ({ intento, error }) => console.warn(`[${name}] reintento lote ${etiquetaLote} (${intento}): ${error.message}`) }
      );
      detalle.inserted += resultado.inserted;
      detalle.updated += resultado.updated;
      for (const row of lote) {
        if (row[cursorColumn] && (!ultimoCursorValor || row[cursorColumn] > ultimoCursorValor)) ultimoCursorValor = row[cursorColumn];
      }
    } catch (batchError) {
      console.warn(`[${name}] lote ${etiquetaLote} falló; reintentando fila a fila: ${batchError.message}`);
      for (const row of lote) {
        try {
          const resultado = await conReintentos(() => upsertFilaResolviendoConflicto(client, name, row, columnasUtilizables, pk, { runId, detalle }));
          if (resultado === "inserted") detalle.inserted++;
          else if (resultado === "updated") detalle.updated++;
          if (row[cursorColumn] && (!ultimoCursorValor || row[cursorColumn] > ultimoCursorValor)) ultimoCursorValor = row[cursorColumn];
        } catch (error) {
          detalle.errors.push(`Fila ${pkKey(row, pk)}: ${error.message}`);
          console.error(`[${name}] error definitivo en fila ${pkKey(row, pk)}:`, error.message);
        }
      }
    }
  }

  try {
    if (cursor?.last_synced_at) {
      const cursorInicial = escaparValorD1(cursor.last_synced_at);
      let ultimoValorPagina = null;
      let sinAvance = false;
      for (;;) {
        // ">=" y no ">": created_at/updated_at tienen resolución de segundo y varias filas
        // comparten valor; con ">" se perdían las que empataban con el cursor. El upsert es
        // idempotente. Si una página entera empata y no avanza se usa ">" para no hacer bucle.
        const condicion = ultimoValorPagina === null
          ? `${cursorColumn} >= ${cursorInicial}`
          : `${cursorColumn} ${sinAvance ? ">" : ">="} ${escaparValorD1(ultimoValorPagina)}`;
        const sql = `SELECT * FROM ${name} WHERE ${condicion} ORDER BY ${cursorColumn} ASC LIMIT ${TAMANO_PAGINA_INCREMENTAL};`;
        const pagina = await conReintentos(() => ejecutarD1(sql), {
          onRetry: ({ intento, error }) => console.warn(`[${name}] reintento lectura D1 (${intento}): ${error.message}`),
        });
        if (pagina.length === 0) break;
        await procesarPaginaIncremental(pagina);
        const nuevoValorPagina = pagina[pagina.length - 1][cursorColumn];
        sinAvance = nuevoValorPagina === ultimoValorPagina;
        ultimoValorPagina = nuevoValorPagina;
        console.log(`[${name}] progreso ${totalFilasLeidas} leídos de D1`);
        if (pagina.length < TAMANO_PAGINA_INCREMENTAL) break;
      }
    } else {
      // Sin cursor todavía = primera pasada incremental tras la migración
      // inicial: se pagina igual por cursorColumn desde el principio, en
      // vez de "SELECT * FROM tabla ORDER BY cursorColumn ASC;" sin LIMIT.
      let ultimoValorPagina = null;
      let sinAvance = false;
      for (;;) {
        const where = ultimoValorPagina === null ? "" : `WHERE ${cursorColumn} ${sinAvance ? ">" : ">="} ${escaparValorD1(ultimoValorPagina)} `;
        const sql = `SELECT * FROM ${name} ${where}ORDER BY ${cursorColumn} ASC LIMIT ${TAMANO_PAGINA_INCREMENTAL};`;
        const pagina = await conReintentos(() => ejecutarD1(sql), {
          onRetry: ({ intento, error }) => console.warn(`[${name}] reintento lectura D1 (${intento}): ${error.message}`),
        });
        if (pagina.length === 0) break;
        await procesarPaginaIncremental(pagina);
        const nuevoValorPagina = pagina[pagina.length - 1][cursorColumn];
        sinAvance = nuevoValorPagina === ultimoValorPagina;
        ultimoValorPagina = nuevoValorPagina;
        console.log(`[${name}] progreso ${totalFilasLeidas} leídos de D1`);
        if (pagina.length < TAMANO_PAGINA_INCREMENTAL) break;
      }
    }
  } catch (error) {
    detalle.errors.push(`Lectura paginada de D1: ${error.message}`);
    console.error(`[${name}] ERROR leyendo D1 por páginas (progreso parcial insertados=${detalle.inserted} actualizados=${detalle.updated}): ${error.message}`);
  }

  console.log(`[${name}] D1: ${totalFilasLeidas} registros a procesar`);

  if (ultimoCursorValor && ultimoCursorValor !== cursor?.last_synced_at) {
    await guardarCursor(client, name, { lastSyncedAt: ultimoCursorValor });
  }

  // 2) Detectar borrados (solo en tablas donde D1 permite DELETE).
  //
  // Igual que en la detección de borrados de la rama "authoritative": se
  // pagina tanto la lectura de IDs en D1 (ejecutarD1PaginadoSoloIds, en vez
  // de "SELECT pk FROM tabla;" completo) como la de Postgres
  // (obtenerIdsPostgresPaginado, con cursor server-side). Solo se acumula
  // en memoria el Set de PKs vistos en D1 (strings, ligero incluso en
  // tablas grandes), nunca las filas completas de ninguno de los dos lados.
  if (deleteDetection) {
    try {
      const idsD1 = new Set();
      await ejecutarD1PaginadoSoloIds(name, pk, async (paginaIds) => {
        for (const r of paginaIds) idsD1.add(pkKey(r, pk));
      });

      await obtenerIdsPostgresPaginado(client, name, pk, async (paginaPG) => {
        for (const row of paginaPG) {
          const key = pkKey(row, pk);
          if (!idsD1.has(key)) {
            const pkValues = pkValuesFromRow(row, pk);
            try {
              await conReintentos(
                async () => {
                  await desacoplarHuerfanoSiAplica(client, name, pkValues);
                  return eliminarFila(client, name, pk, pkValues);
                },
                {
                  onRetry: ({ intento, error }) =>
                    console.warn(`[${name}] reintento borrado huérfano ${key} (${intento}): ${error.message}`),
                }
              );
              detalle.deleted++;
              await client.query(
                `INSERT INTO sync_deletions (table_name, record_id, run_id) VALUES ($1, $2, $3);`,
                [name, key, runId]
              );
            } catch (error) {
              detalle.errors.push(`Borrado ${key}: ${error.message}`);
              console.error(`[${name}] no se pudo borrar el huérfano ${key}:`, error.message);
            }
          }
        }
      });
    } catch (error) {
      detalle.errors.push(`Detección de borrados: ${error.message}`);
      console.error(`[${name}] ERROR en detección de borrados:`, error.message);
    }
  }

  console.log(`[${name}] fin: insertados=${detalle.inserted} actualizados=${detalle.updated} borrados=${detalle.deleted} errores=${detalle.errors.length}`);
  return detalle;
}

export async function ejecutarSincronizacionIncremental() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Falta DATABASE_URL en las variables de entorno.");
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  const runId = nuevoRunId();
  const inicio = Date.now();

  try {
    if (await hayEjecucionEnCurso(client)) {
      console.log("Ya hay una sincronización en curso, se omite esta pasada.");
      return { skipped: true };
    }

    await registrarInicio(client, { runId, mode: "incremental" });

    const detallesPorTabla = [];
    const resumen = { processed: 0, inserted: 0, updated: 0, deleted: 0, errors: 0 };
    // Nombres de tabla que fallaron en esta pasada (para poder saltar a sus
    // tablas hijas, ver DEPENDENCIAS_FK en tables.mjs).
    const tablasConError = new Set();

    for (let indice = 0; indice < TABLES_IN_ORDER.length; indice++) {
      const tableConfig = TABLES_IN_ORDER[indice];
      console.log(`\n===== TABLA ${indice + 1}/${TABLES_IN_ORDER.length}: ${tableConfig.name} =====`);

      const padresConError = (DEPENDENCIAS_FK[tableConfig.name] || []).filter((p) =>
        tablasConError.has(p)
      );

      let detalle;
      if (padresConError.length > 0) {
        // No intentamos sincronizar esta tabla: su(s) tabla(s) padre
        // fallaron en esta misma pasada, así que Postgres puede no tener
        // todavía los IDs que esta tabla referencia por FK. Mejor
        // posponerla a la siguiente pasada (sus cursores no avanzan, así
        // que no se pierde nada) que dejarla romperse fila a fila contra
        // la constraint.
        const motivo = `Omitida en esta pasada: depende de ${padresConError.join(", ")}, que falló al sincronizar.`;
        console.warn(`[${tableConfig.name}] ${motivo}`);
        detalle = { table: tableConfig.name, inserted: 0, updated: 0, deleted: 0, errors: [motivo], skipped: true };
      } else {
        detalle = await sincronizarTabla(client, tableConfig, { runId });
      }

      if (detalle.errors.length > 0) {
        tablasConError.add(tableConfig.name);
      }

      detallesPorTabla.push(detalle);
      resumen.processed += detalle.inserted + detalle.updated + detalle.deleted;
      resumen.inserted += detalle.inserted;
      resumen.updated += detalle.updated;
      resumen.deleted += detalle.deleted;
      resumen.errors += detalle.errors.length;

      // Comprobación de memoria del proceso tras cada tabla: pura
      // observabilidad, no cambia el comportamiento de la sincronización.
      // El objetivo es que, si algún día vuelve a aparecer un pico de RAM
      // (una tabla nueva sin configurar bien, un cambio futuro que
      // reintroduzca una lectura sin paginar, etc.), quede una pista clara
      // en los logs de qué tabla estaba procesándose cuando el RSS empezó
      // a crecer de forma anómala, en vez de enterarse solo por el
      // contenedor reiniciado sin más contexto. UMBRAL_AVISO_RSS_MB es
      // deliberadamente generoso (por debajo del límite real del plan)
      // para avisar con margen antes de que el proceso llegue a caerse.
      const rssMB = process.memoryUsage().rss / 1024 / 1024;
      if (rssMB > UMBRAL_AVISO_RSS_MB) {
        console.warn(
          `[memoria] RSS=${rssMB.toFixed(0)}MB tras sincronizar "${tableConfig.name}" ` +
          `(umbral de aviso ${UMBRAL_AVISO_RSS_MB}MB). Puede ser normal en una pasada con ` +
          `muchos cambios acumulados, pero si se repite en la misma tabla en pasadas ` +
          `sucesivas conviene revisar si esa tabla necesita una página o lote más pequeños.`
        );
      }
    }

    const status = resumen.errors === 0 ? "ok" : "error";
    await registrarFin(client, {
      runId,
      status,
      resumen,
      detail: { tables: detallesPorTabla },
    });

    console.log(
      `Sincronización incremental ${status.toUpperCase()} en ${Date.now() - inicio}ms — ` +
        `insertados=${resumen.inserted} actualizados=${resumen.updated} borrados=${resumen.deleted} errores=${resumen.errors}`
    );

    return { runId, status, resumen, detail: detallesPorTabla };
  } catch (error) {
    await registrarFin(client, {
      runId,
      status: "error",
      resumen: {},
      detail: { fatal: error.message },
    }).catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

// Permite ejecutarlo directamente: node sync/incremental.mjs
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  ejecutarSincronizacionIncremental()
    .then((r) => {
      if (r.skipped) process.exit(0);
      process.exit(r.status === "ok" ? 0 : 1);
    })
    .catch((error) => {
      console.error("ERROR FATAL:", error);
      process.exit(1);
    });
}
