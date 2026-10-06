#!/usr/bin/env node
// Migración inicial D1 -> PostgreSQL (FASE4.md secciones 3, 4, 5).
//
// Reemplaza a la versión anterior de migrar-d1.cjs (que se deja en el
// repo sin más cambios que un comentario apuntando aquí, por si algo
// externo lo invoca todavía) reutilizando los mismos módulos que usa la
// sincronización incremental (sync/pg-writer.mjs, sync/d1-client.mjs),
// para que ambos caminos de escritura en PostgreSQL se comporten igual.
//
// Idempotencia (sección 3): usa upsertFila con onConflictAction:"nothing"
// -durante la migración inicial D1 sigue siendo la única fuente de verdad
// y no ha habido todavía ninguna sincronización incremental que haya
// podido dejar PostgreSQL más "fresco" que D1, así que no hace falta
// sobreescribir filas que ya están; basta con rellenar huecos-. Ejecutarlo
// dos veces dejaigual el resultado: la segunda vez todo son "unchanged".
//
// IDs (sección 4): se insertan tal cual vienen de D1 (no se generan
// nuevos). Al terminar hay que ejecutar `npm run db:sync-sequences`
// (scripts/sync-identity-sequences.mjs, ya existente desde Fase 3) para
// que las columnas IDENTITY de PostgreSQL no colisionen con esos IDs
// explícitos en el próximo INSERT hecho por la propia API secundaria.

import { pathToFileURL } from "node:url";
import pg from "pg";
import { ejecutarD1, contarD1 } from "./d1-client.mjs";
import { TABLES_IN_ORDER } from "./tables.mjs";
import {
  obtenerColumnasPostgres,
  existeTablaPostgres,
  contarPostgres,
  upsertFila,
  reconciliarTablaAutoritativa,
  reordenarTablaPorClave,
} from "./pg-writer.mjs";
import { conReintentos } from "./retry.mjs";
import { nuevoRunId, registrarInicio, registrarFin } from "./state.mjs";

const { Client } = pg;

async function migrarTabla(client, tableConfig) {
  const { name, pk, syncMode } = tableConfig;
  const detalle = { table: name, inserted: 0, updated: 0, deleted: 0, unchanged: 0, errors: [] };

  const existe = await existeTablaPostgres(client, name);
  if (!existe) {
    detalle.errors.push("La tabla no existe en PostgreSQL, se omite (no se crea esquema automáticamente).");
    return detalle;
  }

  const filas = await conReintentos(() => ejecutarD1(`SELECT * FROM ${name};`), {
    onRetry: ({ intento, error }) => console.warn(`[${name}] reintento lectura D1 (${intento}): ${error.message}`),
  });

  const columnasPG = await obtenerColumnasPostgres(client, name);
  const columnasD1 = filas.length ? Object.keys(filas[0]) : [];
  const columnasUtilizables = columnasD1.filter((c) => columnasPG.includes(c));

  // Una tabla autoritativa vacía en D1 significa que PostgreSQL también
  // debe quedar vacía. No devolvemos antes de reconciliar para poder borrar
  // los registros sobrantes en PG.
  if (filas.length === 0 && syncMode !== "authoritative") {
    console.log(`${name.padEnd(24)} 0 registros en D1, nada que migrar.`);
    return detalle;
  }

  const faltanEnPG = columnasD1.filter((c) => !columnasPG.includes(c));
  if (faltanEnPG.length > 0) {
    console.log(`${name}: columnas en D1 sin equivalente en PostgreSQL (se omiten): ${faltanEnPG.join(", ")}`);
  }

  if (syncMode === "authoritative") {
    try {
      const resultado = await conReintentos(
        () => reconciliarTablaAutoritativa(client, name, filas, columnasUtilizables, pk),
        {
          onRetry: ({ intento, error }) =>
            console.warn(`[${name}] reintento reconciliación inicial (${intento}): ${error.message}`),
        }
      );
      detalle.inserted += resultado.inserted;
      detalle.updated = (detalle.updated || 0) + resultado.updated;
      detalle.deleted = (detalle.deleted || 0) + resultado.deleted;
    } catch (error) {
      detalle.errors.push(`Reconciliación autoritativa: ${error.message}`);
    }
  } else {
    for (const row of filas) {
      try {
        const resultado = await conReintentos(() =>
          upsertFila(client, name, row, columnasUtilizables, pk, { onConflictAction: "nothing" })
        );
        if (resultado === "inserted") detalle.inserted++;
        else detalle.unchanged++;
      } catch (error) {
        detalle.errors.push(`${JSON.stringify(pk.map((c) => row[c]))}: ${error.message}`);
      }
    }
  }

  // Tablas de voto secreto: orden físico por PK (ver reordenarTablaPorClave).
  if (tableConfig.ordenFisicaPorClave) {
    try {
      await reordenarTablaPorClave(client, name);
    } catch (error) {
      console.error(`[${name}] AVISO PRIVACIDAD: no se pudo reordenar la tabla por su PK: ${error.message}`);
    }
  }

  const totalD1 = filas.length;
  const totalPG = await contarPostgres(client, name);
  const estado = totalPG >= totalD1 ? "OK" : `FALTAN ${totalD1 - totalPG}`;
  console.log(`${name.padEnd(24)} PG ${totalPG}/${totalD1}  nuevos=${detalle.inserted}  ${estado}`);

  return detalle;
}

export async function ejecutarMigracionInicial() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Falta DATABASE_URL en las variables de entorno.");
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  const runId = nuevoRunId();
  console.log("\n======================================");
  console.log("   MIGRACIÓN INICIAL D1 -> POSTGRESQL");
  console.log("======================================\n");

  try {
    await registrarInicio(client, { runId, mode: "initial" });

    const detalles = [];
    const resumen = { processed: 0, inserted: 0, updated: 0, deleted: 0, errors: 0 };

    for (const tableConfig of TABLES_IN_ORDER) {
      const detalle = await migrarTabla(client, tableConfig);
      detalles.push(detalle);
      resumen.processed += detalle.inserted + detalle.updated + detalle.deleted + detalle.unchanged;
      resumen.inserted += detalle.inserted;
      resumen.updated += detalle.updated;
      resumen.deleted += detalle.deleted;
      resumen.errors += detalle.errors.length;
    }

    const status = resumen.errors === 0 ? "ok" : "error";
    await registrarFin(client, { runId, status, resumen, detail: { tables: detalles } });

    console.log("\n--------------------------------------");
    console.log(`Insertados: ${resumen.inserted}  Errores: ${resumen.errors}`);
    console.log("--------------------------------------");
    console.log(
      resumen.errors === 0
        ? "\n✅ MIGRACIÓN INICIAL FINALIZADA SIN ERRORES.\n   Ejecuta ahora: npm run db:sync-sequences\n"
        : "\n⚠️ MIGRACIÓN FINALIZADA CON ERRORES. Puedes volver a ejecutarla; es idempotente.\n"
    );

    return { runId, status, resumen, detail: detalles };
  } catch (error) {
    await registrarFin(client, { runId, status: "error", resumen: {}, detail: { fatal: error.message } }).catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  ejecutarMigracionInicial()
    .then((r) => process.exit(r.status === "ok" ? 0 : 1))
    .catch((error) => {
      console.error("ERROR FATAL:", error);
      process.exit(1);
    });
}
