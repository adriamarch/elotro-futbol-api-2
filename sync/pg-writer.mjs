// Helpers de escritura en PostgreSQL, compartidos por la migración inicial
// y la sincronización incremental. Toda escritura pasa por aquí para que
// el comportamiento (columnas usadas, ON CONFLICT, parámetros) sea
// idéntico en ambos flujos.

function escaparIdentificador(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export async function obtenerColumnasPostgres(client, table) {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position;`,
    [table]
  );
  return result.rows.map((r) => r.column_name);
}

export async function existeTablaPostgres(client, table) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists;`,
    [table]
  );
  return result.rows[0].exists;
}

export async function contarPostgres(client, table) {
  const result = await client.query(
    `SELECT COUNT(*)::bigint AS count FROM ${escaparIdentificador(table)};`
  );
  return Number(result.rows[0].count);
}

/**
 * Inserta o actualiza (upsert) una fila usando su clave primaria.
 * A diferencia de la migración inicial (que usaba DO NOTHING porque D1
 * seguía siendo autoritativa y bastaba con rellenar huecos), la
 * sincronización incremental necesita DO UPDATE: una fila que cambió en
 * D1 tiene que sobrescribir la versión anterior en PostgreSQL.
 *
 * onConflictAction: "update" (por defecto) o "nothing".
 */
export async function upsertFila(client, table, row, columnas, primaryKeys, { onConflictAction = "update" } = {}) {
  const columnasDisponibles = columnas.filter((c) =>
    Object.prototype.hasOwnProperty.call(row, c)
  );

  const nombresColumnas = columnasDisponibles.map(escaparIdentificador).join(", ");
  const placeholders = columnasDisponibles.map((_, i) => `$${i + 1}`).join(", ");
  const valores = columnasDisponibles.map((c) => row[c]);

  if (primaryKeys.length === 0) {
    // Sin PK (no ocurre en las 16 tablas de este proyecto, pero se deja
    // resuelto por si aparece una tabla nueva sin PK en el futuro): usamos
    // una comprobación de existencia exacta antes de insertar.
    const condiciones = columnasDisponibles
      .map((c, i) => `${escaparIdentificador(c)} = $${i + 1}`)
      .join(" AND ");
    const check = await client.query(
      `SELECT 1 FROM ${escaparIdentificador(table)} WHERE ${condiciones} LIMIT 1;`,
      valores
    );
    if (check.rowCount > 0) return "unchanged";

    await client.query(
      `INSERT INTO ${escaparIdentificador(table)} (${nombresColumnas}) VALUES (${placeholders});`,
      valores
    );
    return "inserted";
  }

  const pkList = primaryKeys.map(escaparIdentificador).join(", ");

  if (onConflictAction === "nothing") {
    const sql = `
      INSERT INTO ${escaparIdentificador(table)} (${nombresColumnas})
      VALUES (${placeholders})
      ON CONFLICT (${pkList}) DO NOTHING;
    `;
    const result = await client.query(sql, valores);
    return result.rowCount > 0 ? "inserted" : "unchanged";
  }

  const columnasNoClave = columnasDisponibles.filter((c) => !primaryKeys.includes(c));

  if (columnasNoClave.length === 0) {
    // Tabla compuesta solo por columnas clave: no hay nada que actualizar,
    // nos comportamos como DO NOTHING.
    const sql = `
      INSERT INTO ${escaparIdentificador(table)} (${nombresColumnas})
      VALUES (${placeholders})
      ON CONFLICT (${pkList}) DO NOTHING;
    `;
    const result = await client.query(sql, valores);
    return result.rowCount > 0 ? "inserted" : "unchanged";
  }

  const setClause = columnasNoClave
    .map((c) => `${escaparIdentificador(c)} = EXCLUDED.${escaparIdentificador(c)}`)
    .join(", ");

  // xmax = 0 es el truco estándar de Postgres para distinguir INSERT de
  // UPDATE dentro de un mismo "INSERT ... ON CONFLICT DO UPDATE".
  const sql = `
    INSERT INTO ${escaparIdentificador(table)} (${nombresColumnas})
    VALUES (${placeholders})
    ON CONFLICT (${pkList}) DO UPDATE SET ${setClause}
    RETURNING (xmax = 0) AS inserted;
  `;
  const result = await client.query(sql, valores);
  return result.rows[0]?.inserted ? "inserted" : "updated";
}


/** Upsert de varias filas en una sola consulta. Reduce drásticamente el número
 * de round-trips a PostgreSQL en tablas como activity_log. */
export async function upsertFilasLote(client, table, rows, columnas, primaryKeys) {
  if (!rows.length) return { inserted: 0, updated: 0 };
  const columnasDisponibles = columnas.filter((c) => Object.prototype.hasOwnProperty.call(rows[0], c));
  const nombres = columnasDisponibles.map(escaparIdentificador).join(", ");
  const valores = [];
  const grupos = rows.map((row, r) => {
    const placeholders = columnasDisponibles.map((c, i) => {
      valores.push(row[c]);
      return `$${r * columnasDisponibles.length + i + 1}`;
    });
    return `(${placeholders.join(", ")})`;
  }).join(", ");
  const pkList = primaryKeys.map(escaparIdentificador).join(", ");
  const noPk = columnasDisponibles.filter((c) => !primaryKeys.includes(c));
  let sql;
  if (!noPk.length) {
    sql = `INSERT INTO ${escaparIdentificador(table)} (${nombres}) VALUES ${grupos} ON CONFLICT (${pkList}) DO NOTHING RETURNING (xmax = 0) AS inserted;`;
  } else {
    const setClause = noPk.map((c) => `${escaparIdentificador(c)} = EXCLUDED.${escaparIdentificador(c)}`).join(", ");
    sql = `INSERT INTO ${escaparIdentificador(table)} (${nombres}) VALUES ${grupos} ON CONFLICT (${pkList}) DO UPDATE SET ${setClause} RETURNING (xmax = 0) AS inserted;`;
  }
  const result = await client.query(sql, valores);
  let inserted = 0;
  for (const row of result.rows) if (row.inserted) inserted++;
  return { inserted, updated: result.rows.length - inserted };
}

export async function eliminarFila(client, table, primaryKeys, pkValues) {
  const condiciones = primaryKeys
    .map((c, i) => `${escaparIdentificador(c)} = $${i + 1}`)
    .join(" AND ");
  const result = await client.query(
    `DELETE FROM ${escaparIdentificador(table)} WHERE ${condiciones};`,
    pkValues
  );
  return result.rowCount > 0;
}

export async function obtenerIdsPostgres(client, table, primaryKeys) {
  const cols = primaryKeys.map(escaparIdentificador).join(", ");
  const result = await client.query(`SELECT ${cols} FROM ${escaparIdentificador(table)};`);
  return result.rows;
}

/**
 * Igual que obtenerIdsPostgres, pero entrega los IDs por páginas (cursor
 * server-side, con FETCH) en vez de materializar el resultado entero de
 * golpe en memoria del proceso Node. pg no soporta streaming nativo sin
 * una librería aparte (pg-cursor/pg-query-stream), así que se usa un
 * cursor SQL explícito (DECLARE ... CURSOR + FETCH) dentro de una
 * transacción de solo lectura: el propio Postgres retiene el resultado
 * completo en su lado y solo transmite una página cada vez.
 *
 * Necesario para tablas con muchas filas (activity_log, comments, etc.):
 * sin esto, una tabla de varios cientos de miles de IDs se cargaba entera
 * en el array `result.rows` -aun tratándose solo de PKs- antes de poder
 * comparar nada, lo que en el plan free de Railway (RAM limitada) podía
 * sumarse al resto de estructuras en memoria de esa misma pasada
 * (idsD1/idsVistosEnD1, filasD1 de la tabla que sigue en la cola, etc.) y
 * disparar el pico. Igual que ejecutarD1Paginado, se prefiere entregar
 * "una página como mucho" a la vez que dejar que el llamador reduzca cada
 * página inmediatamente (comparación contra un Set) antes de pedir la
 * siguiente, en vez de acumular result.rows completo primero.
 */
export async function obtenerIdsPostgresPaginado(client, table, primaryKeys, onPagina, { tamanoPagina = 2000 } = {}) {
  const cols = primaryKeys.map(escaparIdentificador).join(", ");
  const nombreCursor = `cur_ids_${table}_${Math.random().toString(36).slice(2, 8)}`;
  let totalFilas = 0;
  await client.query("BEGIN");
  try {
    await client.query(`DECLARE ${nombreCursor} NO SCROLL CURSOR FOR SELECT ${cols} FROM ${escaparIdentificador(table)};`);
    for (;;) {
      const pagina = await client.query(`FETCH ${tamanoPagina} FROM ${nombreCursor};`);
      if (pagina.rows.length === 0) break;
      await onPagina(pagina.rows);
      totalFilas += pagina.rows.length;
      if (pagina.rows.length < tamanoPagina) break;
    }
    await client.query(`CLOSE ${nombreCursor};`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
  return totalFilas;
}

/**
 * Adelanta la secuencia autoincremental de "table" hasta MAX(id) si se ha
 * quedado por detrás. El sincronizador copia filas de D1 con su id
 * explícito, y eso NO avanza la secuencia de Postgres: cuando después
 * Railway inserta una fila sin id (failover, cron de respaldo...), la
 * secuencia devuelve un id que ya existe y salta
 * "duplicate key value violates unique constraint <tabla>_pkey"
 * (visto en activity_log, match_events y readers). Nunca retrocede la
 * secuencia ni borra filas. Si la columna no tiene secuencia (PK de texto,
 * PK compuesta...) no hace nada.
 */
export async function sincronizarSecuencia(client, table, column = "id") {
  const tabla = escaparIdentificador(table);
  const col = escaparIdentificador(column);
  const seq = await client.query(
    `SELECT pg_get_serial_sequence($1, $2) AS seq;`,
    [`public.${tabla}`, column]
  );
  const nombreSeq = seq.rows[0]?.seq;
  if (!nombreSeq) return false;
  await client.query(
    `SELECT setval($1::regclass, GREATEST((SELECT COALESCE(MAX(${col}), 0) FROM public.${tabla}), 1), (SELECT COUNT(*) > 0 FROM public.${tabla}))
     WHERE (SELECT COALESCE(MAX(${col}), 0) FROM public.${tabla}) >= (SELECT last_value FROM ${nombreSeq});`,
    [nombreSeq]
  );
  return true;
}

export { escaparIdentificador };

/**
 * Reconciliación de filas creadas durante un failover (ver
 * worker/migracion_origin_write_id.sql y
 * worker-secondary/db/migrations/003_pending_writes.sql para el contexto
 * completo).
 *
 * Cuando D1 reproduce una escritura pendiente que era un INSERT, crea una
 * fila con SU PROPIO id (normalmente distinto del que le había asignado
 * PostgreSQL en el momento del failover), pero con el MISMO
 * origin_write_id en ambas filas. Sin este paso, la sincronización normal
 * (upsertFila/upsertFilasLote por PK) trataría esa fila de D1 como una fila
 * nueva más -PK distinto, ON CONFLICT no dispara- y la insertaría como
 * ADICIONAL, dejando la fila original de PostgreSQL (con el id antiguo)
 * huérfana y duplicada.
 *
 * Este paso se ejecuta ANTES del upsert normal de cada lote: para cada fila
 * de D1 que trae origin_write_id, si existe en PostgreSQL una fila con ese
 * mismo origin_write_id pero un PK distinto, se borra esa fila huérfana.
 * El upsert que sigue a continuación entonces sí inserta limpiamente la
 * fila con el PK definitivo de D1 -- el resultado neto es UNA sola fila,
 * nunca dos.
 *
 * No se hace un UPDATE in-place de la fila huérfana (cambiarle el PK) para
 * no complicar las referencias que otras tablas pudieran tener hacia su id
 * antiguo dentro de la propia ventana del failover (por ejemplo, un
 * resultado_id de un artículo creado justo después, también durante el
 * mismo failover, apuntando al id antiguo de PostgreSQL): se borra y se
 * deja que el upsert normal cree la fila limpia con el id ya definitivo, y
 * cualquier referencia rota resultante queda registrada en
 * sync_write_id_conflicts para revisión manual, en vez de intentar
 * repararla en silencio.
 */
export async function reconciliarFilasPorOriginWriteId(client, table, filas, primaryKeys) {
  if (!filas.length) return { huerfanasEliminadas: 0, conflictos: [] };

  const filasConWriteId = filas.filter((row) => row.origin_write_id);
  if (!filasConWriteId.length) return { huerfanasEliminadas: 0, conflictos: [] };

  let huerfanasEliminadas = 0;
  const conflictos = [];
  const pkList = primaryKeys.map(escaparIdentificador).join(", ");

  for (const rowD1 of filasConWriteId) {
    const pkD1 = primaryKeys.map((c) => rowD1[c]);
    const huerfana = await client.query(
      `SELECT ${pkList} FROM ${escaparIdentificador(table)} WHERE origin_write_id = $1;`,
      [rowD1.origin_write_id]
    );
    if (huerfana.rowCount === 0) continue; // no hubo failover para esta fila, o ya se reconcilió antes

    for (const filaHuerfana of huerfana.rows) {
      const pkHuerfana = primaryKeys.map((c) => filaHuerfana[c]);
      const mismoRegistro = pkHuerfana.every((v, i) => String(v) === String(pkD1[i]));
      if (mismoRegistro) continue; // ya reconciliada en una pasada anterior

      const condiciones = primaryKeys.map((c, i) => `${escaparIdentificador(c)} = $${i + 1}`).join(" AND ");
      try {
        await client.query(`DELETE FROM ${escaparIdentificador(table)} WHERE ${condiciones};`, pkHuerfana);
        huerfanasEliminadas++;
        console.warn(
          `[reconciliacion-write-id] ${table}: fila huérfana ${JSON.stringify(pkHuerfana)} ` +
          `(origin_write_id=${rowD1.origin_write_id}) eliminada; sustituida por la fila definitiva ` +
          `de D1 ${JSON.stringify(pkD1)}.`
        );
      } catch (error) {
        // No se aborta el lote por un conflicto de borrado (p.ej. una FK de
        // otra tabla apuntando todavía a esta fila huérfana): se registra
        // para revisión manual y se continúa -- perder la fila entera de la
        // sincronización sería peor que dejar temporalmente el duplicado.
        conflictos.push({ table, pkHuerfana, pkD1, origin_write_id: rowD1.origin_write_id, error: error.message });
        console.error(
          `[reconciliacion-write-id] no se pudo eliminar la fila huérfana ${JSON.stringify(pkHuerfana)} ` +
          `de ${table} (origin_write_id=${rowD1.origin_write_id}): ${error.message}`
        );
        try {
          await client.query(
            `INSERT INTO sync_write_id_conflicts (table_name, origin_write_id, pk_huerfana, pk_d1, error_message)
             VALUES ($1, $2, $3, $4, $5);`,
            [table, rowD1.origin_write_id, JSON.stringify(pkHuerfana), JSON.stringify(pkD1), error.message]
          );
        } catch (logError) {
          // Si ni siquiera se puede dejar constancia del conflicto (p.ej.
          // esta misma migración 004 no se ha aplicado todavía), no se
          // pierde silenciosamente: queda al menos en el log de arriba.
          console.error(`[reconciliacion-write-id] no se pudo registrar el conflicto en sync_write_id_conflicts: ${logError.message}`);
        }
      }
    }
  }

  return { huerfanasEliminadas, conflictos };
}

/**
 * Réplica exacta del desacople que hace worker/src/index.js (D1) antes de
 * borrar un usuario, más las FKs adicionales que existen en Postgres.
 *
 * IMPORTANTE: schema.sql NO refleja el esquema real de Postgres en
 * producción. La fuente de verdad es db/migrations/001_initial_schema.sql,
 * que añade (entre otras) las FKs activity_log.usuario_id y
 * nivel_historial.usuario_id/cambiado_por_id — ambas tablas SÍ existen en
 * Postgres aunque no aparezcan en schema.sql. Esto se confirmó con el error
 * real de producción: "violates foreign key constraint
 * fk_activity_log_usuario on table activity_log".
 *
 * Columnas nullable -> SET NULL. Columnas NOT NULL en el schema
 * (sessions.user_id, edit_requests.solicitante_id,
 * club_info_solicitudes.solicitante_id, nivel_historial.usuario_id)
 * -> DELETE de la fila, igual que D1.
 */
/**
 * Desacopla las FKs que apuntan a results(id) antes de borrar un resultado
 * huérfano (existe en Postgres pero ya no en D1).
 *
 * match_events.resultado_id y alineaciones.result_id son ON DELETE CASCADE
 * (001_initial_schema.sql), así que esas dos se borran solas sin ayuda.
 * Pero articles.resultado_id es una FK simple, SIN ON DELETE CASCADE/SET
 * NULL -es un enlace opcional "crónica -> marcador", no una relación de
 * propiedad-, así que el DELETE de results falla con
 * "articles_resultado_id_fk" en cuanto hay un artículo enlazado a un
 * resultado que D1 ya borró. Al fallar dentro de la transacción de
 * reconciliarTablaAutoritativa, TODA la pasada de "results" hace ROLLBACK
 * -no solo esa fila-, lo que además bloquea articles/match_events/
 * alineaciones/comments en cascada por DEPENDENCIAS_FK (tables.mjs) en
 * todas las pasadas siguientes, indefinidamente.
 */
export async function desacoplarResultadoHuerfano(client, resultId) {
  await client.query('UPDATE articles SET resultado_id = NULL WHERE resultado_id = $1', [resultId]);
}

export async function desacoplarUsuarioHuerfano(client, userId) {
  // SET NULL: mismas columnas que D1, más las exclusivas de Postgres.
  await client.query('UPDATE articles SET autor_id = NULL WHERE autor_id = $1', [userId]);
  await client.query('UPDATE articles SET coautor_id = NULL WHERE coautor_id = $1', [userId]);
  await client.query('UPDATE media SET autor_id = NULL WHERE autor_id = $1', [userId]);
  await client.query('UPDATE results SET autor_id = NULL WHERE autor_id = $1', [userId]);
  await client.query('UPDATE custom_clubs SET autor_id = NULL WHERE autor_id = $1', [userId]);
  await client.query('UPDATE edit_requests SET autor_id = NULL WHERE autor_id = $1', [userId]);
  await client.query('UPDATE edit_requests SET resuelta_por_id = NULL WHERE resuelta_por_id = $1', [userId]);
  await client.query('UPDATE alineaciones SET autor_id = NULL WHERE autor_id = $1', [userId]);
  await client.query('UPDATE comments SET moderado_por_id = NULL WHERE moderado_por_id = $1', [userId]);
  await client.query('UPDATE club_info SET autor_id = NULL WHERE autor_id = $1', [userId]);
  await client.query('UPDATE club_info_solicitudes SET resuelta_por_id = NULL WHERE resuelta_por_id = $1', [userId]);
  await client.query('UPDATE activity_log SET usuario_id = NULL WHERE usuario_id = $1', [userId]);
  await client.query('UPDATE nivel_historial SET cambiado_por_id = NULL WHERE cambiado_por_id = $1', [userId]);

  // DELETE: columnas NOT NULL, no se pueden dejar a NULL (igual que D1 con
  // sessions y nivel_historial).
  await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM edit_requests WHERE solicitante_id = $1', [userId]);
  await client.query('DELETE FROM club_info_solicitudes WHERE solicitante_id = $1', [userId]);
  await client.query('DELETE FROM nivel_historial WHERE usuario_id = $1', [userId]);
}

/**
 * Reconciliación autoritativa D1 -> PostgreSQL.
 *
 * Se usa en tablas pequeñas/sensibles donde PostgreSQL debe quedar como una
 * copia exacta de D1: hace UPSERT de todas las filas de D1 y elimina cualquier
 * PK que exista en PostgreSQL pero no en D1. Todo ocurre dentro de una única
 * transacción de PostgreSQL para evitar estados parcialmente reconciliados.
 *
 * El llamador debe envolver esta función con conReintentos(), porque un error
 * dentro de una transacción deja la transacción abortada y no se puede reintentar
 * una sentencia aislada sobre el mismo cliente.
 */
export async function reconciliarTablaAutoritativa(client, table, filasD1, columnas, primaryKeys) {
  const mapaD1 = new Map(
    filasD1.map((row) => [
      primaryKeys.map((c) => String(row[c])).join("\u0000"),
      row,
    ])
  );

  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  const errores = [];

  // FASE: upsert de todas las filas de D1. Se hace en su propia transacción
  // por lotes: si un lote entero falla (p.ej. un valor inválido en una fila),
  // se reintenta fila a fila para no perder las 249 filas buenas del lote por
  // culpa de una sola -mismo patrón que ya usa el modo incremental en
  // sincronizarTabla/upsertFilasLote más abajo en incremental.mjs-.
  const TAMANO_LOTE = 250;
  for (let i = 0; i < filasD1.length; i += TAMANO_LOTE) {
    const lote = filasD1.slice(i, i + TAMANO_LOTE);
    await client.query("BEGIN");
    try {
      const resultado = await upsertFilasLote(client, table, lote, columnas, primaryKeys);
      await client.query("COMMIT");
      inserted += resultado.inserted;
      updated += resultado.updated;
    } catch (loteError) {
      await client.query("ROLLBACK").catch(() => {});
      console.warn(`[${table}] lote autoritativo ${i + 1}-${i + lote.length} falló; reintentando fila a fila: ${loteError.message}`);
      for (const row of lote) {
        await client.query("BEGIN");
        try {
          const resultado = await upsertFila(client, table, row, columnas, primaryKeys, { onConflictAction: "update" });
          await client.query("COMMIT");
          if (resultado === "inserted") inserted++;
          else if (resultado === "updated") updated++;
        } catch (filaError) {
          await client.query("ROLLBACK").catch(() => {});
          const key = primaryKeys.map((c) => String(row[c])).join("\u0000");
          errores.push(`Fila ${key}: ${filaError.message}`);
          console.error(`[${table}] error definitivo en fila autoritativa ${key}:`, filaError.message);
        }
      }
    }
  }

  // FASE: borrado de huérfanos (existen en Postgres pero ya no en D1). Cada
  // borrado va en su propia transacción para que un huérfano problemático
  // (una FK no contemplada por desacoplarUsuarioHuerfano/
  // desacoplarResultadoHuerfano, o cualquier otro error inesperado) se
  // registre y se salte, en vez de hacer ROLLBACK de todos los borrados ya
  // resueltos en la misma pasada -era exactamente el bug reportado con
  // "results": un huérfano bloqueaba la reconciliación entera, arrastrando
  // en cascada a articles/comments/match_events/alineaciones vía
  // DEPENDENCIAS_FK, pasada tras pasada, indefinidamente.
  const filasPG = await obtenerIdsPostgres(client, table, primaryKeys);
  for (const rowPG of filasPG) {
    const key = primaryKeys.map((c) => String(rowPG[c])).join("\u0000");
    if (!mapaD1.has(key)) {
      await client.query("BEGIN");
      try {
        // Antes de borrar una fila huérfana hay que desacoplar todas las FKs
        // que apuntan a ella en Postgres, si no el DELETE falla por
        // violación de clave foránea.
        if (table === "users") {
          await desacoplarUsuarioHuerfano(client, rowPG.id);
        } else if (table === "results") {
          await desacoplarResultadoHuerfano(client, rowPG.id);
        }
        const values = primaryKeys.map((c) => rowPG[c]);
        const eliminado = await eliminarFila(client, table, primaryKeys, values);
        await client.query("COMMIT");
        if (eliminado) deleted++;
      } catch (deleteError) {
        await client.query("ROLLBACK").catch(() => {});
        errores.push(`Borrado huérfano ${key}: ${deleteError.message}`);
        console.error(`[${table}] no se pudo borrar el huérfano ${key}:`, deleteError.message);
      }
    }
  }

  if (errores.length > 0) {
    const error = new Error(`${errores.length} fila(s) con error en reconciliación autoritativa: ${errores.slice(0, 5).join(" | ")}${errores.length > 5 ? " | ..." : ""}`);
    error.filasConError = errores;
    error.parcial = { inserted, updated, deleted };
    throw error;
  }

  return { inserted, updated, deleted };
}
