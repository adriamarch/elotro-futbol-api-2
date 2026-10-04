#!/usr/bin/env node
// Aplica las migraciones de db/migrations/ contra DATABASE_URL, en orden,
// sin depender de tener `psql` instalado (usa el mismo driver `pg` que ya
// usa el resto del proyecto). Necesario porque install-postgres.sh es un
// script bash que no corre directamente en PowerShell/Windows, y además
// solo conocía la migración 001.
//
// Lleva registro de qué migraciones ya se aplicaron en una tabla
// "schema_migrations", así que ejecutarlo varias veces es seguro: las
// migraciones ya aplicadas se saltan.
//
// Uso:
//   node scripts/migrate.mjs
//
// (equivalente, sin psql, a: psql $DATABASE_URL -f db/migrations/00N_x.sql
// para cada archivo nuevo)

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");

async function asegurarTablaControl(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export async function ejecutarMigraciones() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Falta DATABASE_URL en las variables de entorno.");
  }

  // La primera conexión tras un deploy falla a veces con ECONNRESET (proxy
  // TCP de Railway / Postgres aún ocupado), y como el arranque no espera a
  // reintentar, la migración se quedaba sin aplicar hasta el siguiente
  // deploy. Se reintenta la conexión unas cuantas veces con espera creciente.
  const ESPERAS_MS = [1000, 2000, 4000, 8000];
  let client;
  for (let intento = 0; ; intento++) {
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    });
    // Sin oyente, un error en la conexión (p. ej. un corte a mitad) tumba el proceso.
    client.on("error", (err) => console.error("[migrate] error de conexión:", err.message));
    try {
      await client.connect();
      break;
    } catch (err) {
      try { await client.end(); } catch { /* ya estaba cerrada */ }
      if (intento >= ESPERAS_MS.length) throw err;
      console.warn(`[migrate] no se pudo conectar (${err.message}); reintento ${intento + 1}/${ESPERAS_MS.length} en ${ESPERAS_MS[intento] / 1000}s`);
      await new Promise((r) => setTimeout(r, ESPERAS_MS[intento]));
    }
  }

  try {
    await asegurarTablaControl(client);

    const yaAplicadas = new Set(
      (await client.query(`SELECT filename FROM schema_migrations;`)).rows.map((r) => r.filename)
    );

    const archivos = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let aplicadas = 0;

    for (const archivo of archivos) {
      if (yaAplicadas.has(archivo)) {
        console.log(`= ${archivo} (ya aplicada, se omite)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, archivo), "utf8");
      console.log(`> Aplicando ${archivo}...`);

      try {
        // Los propios archivos .sql ya llevan BEGIN/COMMIT, así que no
        // envolvemos otra transacción alrededor (evita anidar
        // transacciones, que node-postgres no soporta de forma nativa).
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1);`, [archivo]);
        console.log(`  OK ${archivo}`);
        aplicadas++;
      } catch (error) {
        console.error(`  ERROR aplicando ${archivo}: ${error.message}`);
        throw error;
      }
    }

    if (aplicadas === 0) {
      console.log("\nNo había migraciones pendientes.");
    } else {
      console.log(`\n${aplicadas} migración(es) aplicada(s) correctamente.`);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  ejecutarMigraciones().catch((error) => {
    console.error("ERROR FATAL:", error);
    process.exit(1);
  });
}
