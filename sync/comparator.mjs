#!/usr/bin/env node
// Comparador D1 <-> PostgreSQL (FASE4.md sección 6).
//
// Para cada tabla, compara:
//   - número de registros
//   - conjunto de IDs (faltantes en PG, sobrantes en PG)
//   - para los IDs presentes en ambos lados: valores columna a columna
//     (registros con valores diferentes)
//   - columnas presentes en D1 pero no en PG y viceversa
//
// No se limita a comparar el recuento (la Fase 4 lo pide explícitamente):
// dos tablas pueden tener el mismo número de filas y aun así tener
// contenido distinto si, por ejemplo, una fila se borró en un lado y se
// insertó otra distinta en el otro.

import { pathToFileURL } from "node:url";
import pg from "pg";
import { ejecutarD1 } from "./d1-client.mjs";
import { TABLES_IN_ORDER } from "./tables.mjs";
import { obtenerColumnasPostgres, existeTablaPostgres } from "./pg-writer.mjs";

const { Client } = pg;
import { CAMPOS_VOLATILES_COMPARADOR, TABLAS_PRIVADAS_COMPARADOR } from "./comparator-config.mjs";

function pkKey(row, pk) {
  return pk.map((c) => String(row[c])).join("\u0000");
}

function normalizar(value) {
  // D1 (SQLite) representa booleanos como 0/1 y pg-node los devuelve tal
  // cual están tipados en PostgreSQL (a veces boolean, a veces integer,
  // según la columna) -en este esquema todas las columnas "booleanas" son
  // INTEGER a ambos lados, pero next-of-kin de tipos (números como string
  // en algunos drivers) se normalizan aquí para no generar falsos
  // positivos de "valor diferente".
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return String(value);
}

// true si el orden físico de la tabla en PostgreSQL (ctid) coincide con el
// orden de su PK; null si la tabla está vacía. Solo se usa en las tablas de
// voto secreto (ordenFisicaPorClave): si no coincide, el orden de llegada de
// los votos es deducible (ver reordenarTablaPorClave en pg-writer.mjs).
async function ordenFisicoEsPorClave(pgClient, name, pk) {
  const col = (c) => `"${c}"::text`;
  const clave = pk.map(col).join(` || '|' || `);
  const orden = pk.map((c) => `"${c}"`).join(", ");
  const r = await pgClient.query(
    `SELECT (SELECT string_agg(${clave}, ',' ORDER BY ctid) FROM "${name}")
          = (SELECT string_agg(${clave}, ',' ORDER BY ${orden}) FROM "${name}") AS ok,
            (SELECT COUNT(*) FROM "${name}") AS n;`
  );
  return Number(r.rows[0].n) === 0 ? null : r.rows[0].ok === true;
}

async function compararTabla(pgClient, tableConfig) {
  const { name, pk } = tableConfig;
  const reporte = {
    table: name,
    d1Count: 0,
    pgCount: 0,
    faltanEnPostgres: [],
    sobranEnPostgres: [],
    valoresDiferentes: [],
    columnasFaltanEnPostgres: [],
    columnasSobranEnPostgres: [],
    avisos: [],
    estado: "OK",
  };

  const existe = await existeTablaPostgres(pgClient, name);
  if (!existe) {
    reporte.estado = "ERROR: tabla no existe en PostgreSQL";
    return reporte;
  }

  const filasD1 = await ejecutarD1(`SELECT * FROM ${name};`);
  const filasPGResult = await pgClient.query(`SELECT * FROM "${name}";`);
  const filasPG = filasPGResult.rows;

  reporte.d1Count = filasD1.length;
  reporte.pgCount = filasPG.length;

  if (filasD1.length > 0) {
    const columnasD1 = Object.keys(filasD1[0]);
    const columnasPG = await obtenerColumnasPostgres(pgClient, name);
    reporte.columnasFaltanEnPostgres = columnasD1.filter((c) => !columnasPG.includes(c));
    reporte.columnasSobranEnPostgres = columnasPG.filter(
      (c) => !columnasD1.includes(c) && !["updated_at"].includes(c) // updated_at añadido en Fase 4, no existe en D1 antes de la migración de tracking en algunas tablas ya migradas
    );
  }

  const mapaD1 = new Map(filasD1.map((r) => [pkKey(r, pk), r]));
  const mapaPG = new Map(filasPG.map((r) => [pkKey(r, pk), r]));

  for (const [key, rowD1] of mapaD1) {
    if (!mapaPG.has(key)) {
      reporte.faltanEnPostgres.push(key);
      continue;
    }
    const rowPG = mapaPG.get(key);
    const camposVolatiles = CAMPOS_VOLATILES_COMPARADOR[name] ?? new Set();
    const columnasComunes = Object.keys(rowD1).filter(
      (c) =>
        Object.prototype.hasOwnProperty.call(rowPG, c) &&
        c !== "updated_at" &&
        !camposVolatiles.has(c)
    );
    const diferentes = columnasComunes.filter(
      (c) => normalizar(rowD1[c]) !== normalizar(rowPG[c])
    );
    if (diferentes.length > 0) {
      reporte.valoresDiferentes.push({ id: key, columnas: diferentes });
    }
  }

  for (const key of mapaPG.keys()) {
    if (!mapaD1.has(key)) reporte.sobranEnPostgres.push(key);
  }

  const sinDiferencias =
    reporte.faltanEnPostgres.length === 0 &&
    reporte.sobranEnPostgres.length === 0 &&
    reporte.valoresDiferentes.length === 0 &&
    reporte.columnasFaltanEnPostgres.length === 0;

  reporte.estado = sinDiferencias ? "OK" : "DIFERENCIAS";

  if (tableConfig.ordenFisicaPorClave) {
    const ordenado = await ordenFisicoEsPorClave(pgClient, name, pk);
    reporte.ordenFisicoPorClave = ordenado;
    if (ordenado === false) {
      reporte.avisos.push(
        "AVISO PRIVACIDAD: el orden físico en PostgreSQL no es el de la PK (el orden de llegada de los votos sería deducible). " +
          "Se corrige solo en la próxima pasada con cambios, o ejecutando npm run sync:initial (idempotente) (ver FASE5)."
      );
    }
  }

  // Voto secreto: nunca se listan claves (ver comparator-config.mjs).
  if (TABLAS_PRIVADAS_COMPARADOR.has(name)) {
    const oculto = "[clave omitida]";
    reporte.faltanEnPostgres = reporte.faltanEnPostgres.map(() => oculto);
    reporte.sobranEnPostgres = reporte.sobranEnPostgres.map(() => oculto);
    reporte.valoresDiferentes = reporte.valoresDiferentes.map((v) => ({ id: oculto, columnas: v.columnas }));
  }
  return reporte;
}

export async function ejecutarComparacion() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Falta DATABASE_URL en las variables de entorno.");
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  const reportes = [];
  try {
    for (const tableConfig of TABLES_IN_ORDER) {
      const reporte = await compararTabla(client, tableConfig);
      reportes.push(reporte);

      console.log(`\nTABLA: ${reporte.table}`);
      console.log(`D1: ${reporte.d1Count} registros`);
      console.log(`PG: ${reporte.pgCount} registros`);
      const totalDiferencias =
        reporte.faltanEnPostgres.length +
        reporte.sobranEnPostgres.length +
        reporte.valoresDiferentes.length;
      console.log(`Diferencias: ${totalDiferencias}`);
      console.log(`Estado: ${reporte.estado}`);

      if (reporte.faltanEnPostgres.length > 0) {
        console.log(`  Faltan en PG (${reporte.faltanEnPostgres.length}): ${reporte.faltanEnPostgres.slice(0, 10).join(", ")}${reporte.faltanEnPostgres.length > 10 ? "..." : ""}`);
      }
      if (reporte.sobranEnPostgres.length > 0) {
        console.log(`  Sobran en PG (${reporte.sobranEnPostgres.length}): ${reporte.sobranEnPostgres.slice(0, 10).join(", ")}${reporte.sobranEnPostgres.length > 10 ? "..." : ""}`);
      }
      if (reporte.valoresDiferentes.length > 0) {
        console.log(`  Valores distintos (${reporte.valoresDiferentes.length}), ejemplo: ${JSON.stringify(reporte.valoresDiferentes[0])}`);
      }
      if (reporte.columnasFaltanEnPostgres.length > 0) {
        console.log(`  Columnas D1 sin equivalente en PG: ${reporte.columnasFaltanEnPostgres.join(", ")}`);
      }
      if (reporte.ordenFisicoPorClave === true) {
        console.log("  Orden físico en PG = orden de la PK (anonimato del voto secreto preservado)");
      }
      for (const aviso of reporte.avisos) console.log(`  ${aviso}`);
    }

    const conDiferencias = reportes.filter((r) => r.estado !== "OK");
    console.log("\n======================================");
    console.log(
      conDiferencias.length === 0
        ? "✅ TODAS LAS TABLAS COINCIDEN"
        : `⚠️ ${conDiferencias.length} TABLA(S) CON DIFERENCIAS: ${conDiferencias.map((r) => r.table).join(", ")}`
    );
    console.log("======================================\n");

    return reportes;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  ejecutarComparacion()
    .then((reportes) => {
      const hayDiferencias = reportes.some((r) => r.estado !== "OK");
      process.exit(hayDiferencias ? 1 : 0);
    })
    .catch((error) => {
      console.error("ERROR FATAL:", error);
      process.exit(1);
    });
}
