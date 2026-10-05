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

import { ejecutarSincronizacionIncremental } from "./incremental.mjs";
import { drenarEscriturasPendientes } from "./drain.mjs";

const inicio = Date.now();
let fallo = false;

console.log("==============================================");
console.log("ElOtroFútbol - sincronización puntual");
console.log("Inicio:", new Date().toISOString());
console.log("==============================================");

try {
  console.log("[1/2] Sincronización D1 -> PostgreSQL");
  const resultado = await ejecutarSincronizacionIncremental();
  if (resultado?.skipped) {
    console.log("[1/2] Omitida: ya había una sincronización en curso.");
  } else {
    console.log("[1/2] Sincronización completada.");
  }
} catch (error) {
  fallo = true;
  console.error("[1/2] Sincronización FALLIDA:", error?.stack || error);
}

try {
  console.log("[2/2] Drenando escrituras pendientes");
  const resultado = await drenarEscriturasPendientes();
  if (resultado?.skipped) {
    // Sin INTERNAL_SYNC_SECRET el drain no hace nada: lo tratamos como
    // fallo para que no pase desapercibido en Actions.
    fallo = true;
    console.error(`[2/2] Drain omitido (${resultado.reason}).`);
  } else {
    console.log("[2/2] Drain completado.");
  }
} catch (error) {
  fallo = true;
  console.error("[2/2] Drain FALLIDO:", error?.stack || error);
}

const duracion = Date.now() - inicio;
console.log("==============================================");
console.log(fallo ? "SINCRONIZACIÓN CON ERRORES" : "SINCRONIZACIÓN COMPLETADA");
console.log("Duración:", `${duracion} ms`);
console.log("==============================================");

process.exit(fallo ? 1 : 0);
