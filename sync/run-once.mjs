#!/usr/bin/env node
// Ejecutor puntual del sincronizador D1 -> PostgreSQL.
//
// Hace UNA pasada (sync incremental + drain de escrituras pendientes) y
// termina. Pensado para GitHub Actions (.github/workflows/sincronizador.yml)
// en lugar del proceso permanente sync/scheduler.mjs, que se mantiene como
// rollback.
//
// Mismo orden que el scheduler: primero sync D1 -> Postgres y DESPUÉS el
// drain (ver comentario en scheduler.mjs). Cada paso va en su propio
// try/catch, como en el scheduler, para que un fallo del sync no impida
// intentar el drain. Si cualquiera falla, el proceso sale con código 1.
//
// Ojo: ejecutarSincronizacionIncremental() NO lanza excepción cuando una o
// varias tablas terminan con errores (devuelve { status: "error", ... }),
// así que aquí se comprueba el status explícitamente. Antes un sync con
// errores de tabla acababa en "SINCRONIZACIÓN COMPLETADA" con código 0 y el
// workflow salía en verde aunque Postgres se hubiera quedado desactualizado.

import pg from "pg";
import { ejecutarSincronizacionIncremental } from "./incremental.mjs";
import { drenarEscriturasPendientes } from "./drain.mjs";

const inicio = Date.now();
let fallo = false;

const EN_ACTIONS = process.env.GITHUB_ACTIONS === "true";
const MAX_ERRORES_POR_TABLA = 3;
const MAX_LONGITUD_ERROR = 300;

// Anotación visible en el resumen del run de GitHub Actions (no-op fuera de Actions).
function anotarError(titulo, mensaje) {
  if (!EN_ACTIONS) return;
  const limpio = String(mensaje).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::error title=${titulo}::${limpio}`);
}

// Imprime qué tablas fallaron y por qué, para no tener que abrir sync_state
// ni buscar entre miles de líneas de log.
function informarErroresDeSync(resultado) {
  const tablas = (resultado.detail || []).filter((t) => t.errors?.length > 0);
  const r = resultado.resumen || {};
  console.error(`[1/2] Sincronización TERMINÓ CON ERRORES (status=${resultado.status}, errores=${r.errors ?? "?"}, run_id=${resultado.runId}).`);
  for (const t of tablas) {
    const etiqueta = t.skipped ? "omitida" : "con errores";
    console.error(`  - ${t.table} (${etiqueta}): ${t.errors.length} error(es)`);
    for (const e of t.errors.slice(0, MAX_ERRORES_POR_TABLA)) {
      console.error(`      · ${String(e).slice(0, MAX_LONGITUD_ERROR)}`);
    }
    if (t.errors.length > MAX_ERRORES_POR_TABLA) {
      console.error(`      · ... y ${t.errors.length - MAX_ERRORES_POR_TABLA} más (ver sync_state.detail del run ${resultado.runId})`);
    }
  }
  const nombres = tablas.map((t) => t.table).join(", ") || "(ver sync_state.detail)";
  anotarError("Sincronización D1 -> PostgreSQL con errores", `Tablas afectadas: ${nombres}. run_id=${resultado.runId}`);
}


// ---------------------------------------------------------------------------
// Tolerancia a reinicios de PostgreSQL (Railway).
//
// Postgres puede estar reiniciándose ("the database system is starting up",
// ECONNRESET, ECONNREFUSED...). Antes el job fallaba a los ~17 s sin dar
// margen. Ahora:
//   1) Antes de empezar se espera (hasta ESPERA_PG_MAX_MS) a que Postgres
//      acepte conexiones y responda a un SELECT 1.
//   2) Si un paso lanza un error TRANSITORIO de conexión, se reintenta tras
//      comprobar de nuevo que Postgres responde. Errores que no son de
//      conexión (datos, SQL, permisos) NO se reintentan: fallan como siempre.
// Todo es ajustable por variables de entorno, sin tocar código.
// ---------------------------------------------------------------------------
const ESPERA_PG_MAX_MS = Number(process.env.SYNC_ESPERA_PG_MAX_MS || 150_000);
const ESPERA_PG_PASO_MS = Number(process.env.SYNC_ESPERA_PG_PASO_MS || 5_000);
const REINTENTOS_PASO = Number(process.env.SYNC_REINTENTOS_PASO || 2);

const CODIGOS_TRANSITORIOS = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now ("the database system is starting up")
  "08000", "08001", "08003", "08004", "08006", // connection_exception
]);
const PATRON_TRANSITORIO = /starting up|shutting down|recovery mode|connection terminated|connection reset|ECONNRESET|ECONNREFUSED|ETIMEDOUT|read ECONN|terminating connection|server closed the connection/i;

function esErrorTransitorio(error) {
  if (!error) return false;
  if (error.code && CODIGOS_TRANSITORIOS.has(String(error.code))) return true;
  return PATRON_TRANSITORIO.test(String(error.message || error));
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function postgresResponde() {
  if (!process.env.DATABASE_URL) return true; // ya lo avisan los pasos con su propio error
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  // Un error asíncrono del socket no debe tumbar el proceso.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch (error) {
    console.log(`[espera-pg] Postgres aún no responde: ${String(error?.message || error).split("\n")[0]}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function esperarPostgres(motivo) {
  const limite = Date.now() + ESPERA_PG_MAX_MS;
  let primera = true;
  while (true) {
    if (await postgresResponde()) {
      if (!primera) console.log(`[espera-pg] Postgres responde de nuevo (${motivo}).`);
      return true;
    }
    primera = false;
    if (Date.now() + ESPERA_PG_PASO_MS > limite) {
      console.error(`[espera-pg] Postgres no respondió en ${Math.round(ESPERA_PG_MAX_MS / 1000)} s (${motivo}).`);
      return false;
    }
    await dormir(ESPERA_PG_PASO_MS);
  }
}

// Ejecuta un paso; si falla por un error transitorio de conexión, espera a
// Postgres y lo reintenta (máx. REINTENTOS_PASO veces). Devuelve el resultado
// del paso y cuántos reintentos hicieron falta.
async function conReintentoDeConexion(nombre, fn) {
  let reintentos = 0;
  while (true) {
    try {
      const resultado = await fn();
      return { resultado, reintentos };
    } catch (error) {
      if (reintentos >= REINTENTOS_PASO || !esErrorTransitorio(error)) throw error;
      reintentos++;
      console.error(`[${nombre}] Error transitorio de conexión (${String(error?.message || error).split("\n")[0]}). Reintento ${reintentos}/${REINTENTOS_PASO}...`);
      if (!(await esperarPostgres(`antes de reintentar ${nombre}`))) throw error;
    }
  }
}

console.log("==============================================");
console.log("ElOtroFútbol - sincronización puntual");
console.log("Inicio:", new Date().toISOString());
console.log("==============================================");

// Si Postgres se está reiniciando, se le da margen antes de empezar. Si pasado
// el plazo sigue caído, se sigue adelante igualmente: los pasos fallarán con su
// error real y quedará registrado, como antes.
await esperarPostgres("arranque");

try {
  console.log("[1/2] Sincronización D1 -> PostgreSQL");
  const { resultado, reintentos: reint1 } = await conReintentoDeConexion("1/2", () => ejecutarSincronizacionIncremental());
  if (resultado?.skipped && reint1 > 0) {
    // Tras un corte, el candado de la pasada interrumpida puede seguir puesto
    // hasta que caduque: NO es un éxito, no se ha sincronizado nada.
    fallo = true;
    console.error("[1/2] Tras reintentar, sigue el candado de la pasada interrumpida; se sincronizará en la próxima ejecución.");
    anotarError("Sincronización D1 -> PostgreSQL pendiente", "Candado de la pasada anterior aún activo tras un corte de Postgres.");
  } else if (resultado?.skipped) {
    console.log("[1/2] Omitida: ya había una sincronización en curso.");
  } else if (resultado?.status !== "ok") {
    // Cualquier cosa distinta de "ok" (incluido un resultado sin status) es fallo.
    fallo = true;
    informarErroresDeSync(resultado ?? {});
  } else {
    console.log("[1/2] Sincronización completada.");
  }
} catch (error) {
  fallo = true;
  console.error("[1/2] Sincronización FALLIDA:", error?.stack || error);
  anotarError("Sincronización D1 -> PostgreSQL fallida", error?.message || error);
}

try {
  console.log("[2/2] Drenando escrituras pendientes");
  const { resultado } = await conReintentoDeConexion("2/2", () => drenarEscriturasPendientes());
  if (resultado?.skipped) {
    // Sin INTERNAL_SYNC_SECRET el drain no hace nada: lo tratamos como
    // fallo para que no pase desapercibido en Actions.
    fallo = true;
    console.error(`[2/2] Drain omitido (${resultado.reason}).`);
    anotarError("Drain omitido", resultado.reason);
  } else {
    console.log("[2/2] Drain completado.");
  }
} catch (error) {
  fallo = true;
  console.error("[2/2] Drain FALLIDO:", error?.stack || error);
  anotarError("Drain de escrituras pendientes fallido", error?.message || error);
}

const duracion = Date.now() - inicio;
console.log("==============================================");
console.log(fallo ? "SINCRONIZACIÓN CON ERRORES" : "SINCRONIZACIÓN COMPLETADA");
console.log("Duración:", `${duracion} ms`);
console.log("==============================================");

process.exit(fallo ? 1 : 0);
