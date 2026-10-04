import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
  ssl: process.env.PGSSL === "disable" ? false : undefined,
  // Railway (proxy TCP) cierra las conexiones inactivas sin avisar; con
  // keepAlive el socket se mantiene vivo y las conexiones del pool no se
  // quedan "muertas" (ECONNRESET en la siguiente consulta).
  keepAlive: true,
  keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_DELAY_MS || 10000),
});

// Sin este manejador, un error en una conexión INACTIVA del pool (Postgres
// reiniciándose, corte de red...) se emite como evento "error" sin oyente y
// tumba el proceso entero de Node. Con él, solo se descarta esa conexión y el
// pool abre otra en la siguiente consulta.
pool.on("error", (err) => {
  console.error("[postgres:pool] error en conexión inactiva (se descarta):", err?.message, err?.code || "");
});

// Errores de conexión/arranque que merecen reintento. No incluye errores de
// SQL (sintaxis, restricciones...) que fallarían igual la segunda vez.
const CODIGOS_TRANSITORIOS = new Set([
  "ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN",
  "57P01", "57P02", "57P03", // admin_shutdown, crash_shutdown, cannot_connect_now ("starting up")
  "08000", "08001", "08003", "08006", // connection_exception*
]);
const MENSAJES_TRANSITORIOS = /Connection terminated|connection timeout|starting up|ECONNRESET|read ECONNRESET|Client has encountered a connection error/i;
function esErrorTransitorio(err) {
  if (!err) return false;
  return CODIGOS_TRANSITORIOS.has(err.code) || MENSAJES_TRANSITORIOS.test(String(err.message || ""));
}
// Para escrituras solo se reintenta si la consulta NO pudo haberse ejecutado
// (no llegó a conectar, o Postgres rechazó la conexión porque arrancaba):
// reintentar un INSERT tras un ECONNRESET a mitad de consulta podría
// duplicarlo si ya se había confirmado.
function fallaAntesDeEjecutar(err) {
  return err?.code === "57P03" || /starting up|connection timeout/i.test(String(err?.message || ""));
}
const ES_LECTURA = /^\s*(SELECT|WITH)\b/i;
const ESPERAS_REINTENTO_MS = [150, 500, 1200];

async function consultaConReintento(sql, params) {
  const lectura = ES_LECTURA.test(sql);
  for (let intento = 0; ; intento++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      const reintentable = lectura ? esErrorTransitorio(err) : fallaAntesDeEjecutar(err);
      if (!reintentable || intento >= ESPERAS_REINTENTO_MS.length) throw err;
      console.warn(`[postgres] error transitorio (${err.code || err.message}), reintento ${intento + 1}/${ESPERAS_REINTENTO_MS.length}`);
      await new Promise((r) => setTimeout(r, ESPERAS_REINTENTO_MS[intento]));
    }
  }
}
const dbConReintento = { query: consultaConReintento };

console.log("[postgres] DATABASE_URL configurada:", Boolean(process.env.DATABASE_URL));

try {
  const u = new URL(process.env.DATABASE_URL);
  console.log("[postgres] host:", u.hostname);
  console.log("[postgres] port:", u.port || "5432");
  console.log("[postgres] database:", u.pathname);
} catch (error) {
  console.error("[postgres] DATABASE_URL inválida:", error.message);
}

const TABLES_WITH_ID = new Set([
  "users","articles","results","match_events","media","custom_clubs",
  "edit_requests","comments","club_info_solicitudes","activity_log",
  "nivel_historial","alineaciones"
]);

import { translateSql } from "./sql-compat.js";
function maybeAddReturning(sql) {
  if (!/^INSERT\s+INTO\s+/i.test(sql) || /\bRETURNING\b/i.test(sql)) return sql;
  const m = sql.match(/^INSERT\s+INTO\s+([\"`]?)([a-zA-Z_][\w]*)\1/i);
  if (!m || !TABLES_WITH_ID.has(m[2])) return sql;
  return `${sql} RETURNING id`;
}

function bindable(sql, params) { return translateSql(sql, params); }

class PreparedStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async first() {
  const q = bindable(this.sql, this.params);
  try {
    const r = await this.db.query(q.sql, q.params);
    return r.rows[0] ?? null;
  } catch (error) {
    if (esErrorTransitorio(error)) throw error; // ya se registró en el reintento; se evita volcar SQL y parámetros
    console.error("[postgres:first]", {
      originalSql: this.sql,
      translatedSql: q.sql,
      params: q.params,
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
      hint: error?.hint,
    });
    throw error;
  }
}
  async all() {
    const q = bindable(this.sql, this.params);
    const r = await this.db.query(q.sql, q.params);
    return { results: r.rows };
  }
  async run() {
    let sql = maybeAddReturning(this.sql);
    const q = bindable(sql, this.params);
    const r = await this.db.query(q.sql, q.params);
    const row = r.rows[0];
    return {
      success: true,
      meta: {
        changes: r.rowCount ?? 0,
        last_row_id: row?.id ?? null,
      },
    };
  }
}

export function createD1CompatDb() {
  return {
    prepare(sql) { return new PreparedStatement(dbConReintento, sql); },
    async batch(statements) {
      let client;
      for (let intento = 0; ; intento++) {
        try { client = await pool.connect(); break; }
        catch (err) {
          if (!fallaAntesDeEjecutar(err) && !esErrorTransitorio(err)) throw err;
          if (intento >= ESPERAS_REINTENTO_MS.length) throw err;
          await new Promise((r) => setTimeout(r, ESPERAS_REINTENTO_MS[intento]));
        }
      }
      let clienteRoto = false;
      try {
        await client.query("BEGIN");
        const results = [];
        for (const statement of statements) {
          const sql = maybeAddReturning(statement.sql);
          const q = bindable(sql, statement.params || []);
          const r = await client.query(q.sql, q.params);
          results.push({ success: true, meta: { changes: r.rowCount ?? 0, last_row_id: r.rows[0]?.id ?? null }, results: r.rows });
        }
        await client.query("COMMIT");
        return results;
      } catch (e) {
        if (esErrorTransitorio(e)) clienteRoto = true;
        // Si la conexión murió, ROLLBACK también falla y taparía el error real.
        try { await client.query("ROLLBACK"); } catch { clienteRoto = true; }
        throw e;
      } finally { client.release(clienteRoto ? true : undefined); }
    },
  };
}

export async function checkPostgres() {
  const started = Date.now();
  const r = await consultaConReintento("SELECT 1 AS ok");
  return { ok: r.rows[0]?.ok === 1, responseTime: Date.now() - started };
}

// Mismo umbral que UMBRAL_SYNC_STALE_MS en requireAuth (index.js): si el
// cursor de sincronización de "sessions" lleva más de esto sin avanzar, el
// sincronizador (sync/scheduler.mjs, proceso Node aparte) se considera
// caído/no desplegado, no solo "con retraso normal".
const UMBRAL_SYNC_STALE_MS = 5 * 60 * 1000;

export async function checkSyncFreshness() {
  try {
    const r = await pool.query(
      "SELECT last_synced_at FROM sync_cursor WHERE table_name = $1",
      ["sessions"]
    );
    const lastSyncedAt = r.rows[0]?.last_synced_at ?? null;
    if (!lastSyncedAt) {
      // Sin fila de cursor todavía: no hay forma de confirmar que el
      // sincronizador haya corrido nunca. Se reporta como "stale" para que
      // salte en monitorización, igual que hace requireAuth (falla cerrado
      // en este mismo caso).
      return { stale: true, lastSyncedAt: null, staleForMs: null, reason: "sin_cursor_todavia" };
    }
    const staleForMs = Date.now() - new Date(lastSyncedAt).getTime();
    return {
      stale: staleForMs > UMBRAL_SYNC_STALE_MS,
      lastSyncedAt,
      staleForMs,
      reason: staleForMs > UMBRAL_SYNC_STALE_MS ? "sincronizador_caido_o_lento" : null,
    };
  } catch (error) {
    console.error("[postgres] no se pudo comprobar sync_cursor:", error.message);
    return { stale: true, lastSyncedAt: null, staleForMs: null, reason: `error: ${error.message}` };
  }
}

export async function closePostgres() { await pool.end(); }

export { pool };
