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

console.log("==============================================");
console.log("ElOtroFútbol - sincronización puntual");
console.log("Inicio:", new Date().toISOString());
console.log("==============================================");

try {
  console.log("[1/2] Sincronización D1 -> PostgreSQL");
  const resultado = await ejecutarSincronizacionIncremental();
  if (resultado?.skipped) {
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
  const resultado = await drenarEscriturasPendientes();
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
