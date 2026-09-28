// Cola de escrituras pendientes de reproducir contra D1 (primaria).
//
// Ver db/migrations/003_pending_writes.sql para el porqué completo. Resumen:
// el sync D1 -> PostgreSQL (FASE 4) es de un solo sentido con D1 como
// autoridad, así que cualquier escritura atendida aquí durante un failover
// se perdería en la siguiente reconciliación si no se reproduce en D1.
//
// Este módulo solo se encarga de ENCOLAR. Reproducirlas contra D1 vive en
// el Worker de Cloudflare (worker/src/index.js,
// /api/internal/drain-pending-writes), porque solo el Worker tiene el
// binding env.DB hacia D1 -- Railway no puede hablar con D1 directamente.

import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});

// Solo estas rutas HTTP representan una escritura real de datos de
// negocio. GET/HEAD nunca se encolan (no hay nada que reproducir). No se
// usa una lista negra ("todo menos GET") para evitar encolar por error
// rutas puramente informativas o el propio drenaje.
const METODOS_ESCRITURA = new Set(["POST", "PUT", "DELETE", "PATCH"]);

// Rutas que se excluyen aunque sean de escritura: no representan datos de
// negocio que deba ver D1 (login solo emite un JWT y no cambia estado
// relevante para D1 más allá de la sesión, que ya sincroniza FASE 4;
// reproducir un login contra D1 no tiene sentido y además filtraría la
// contraseña en texto plano hacia una cola de reintentos).
const RUTAS_EXCLUIDAS = new Set([
  "/api/login",
  "/api/forgot-password",
  "/api/forgot-password/confirmar",
  // Login/logout de lectores: mismo motivo que "/api/login" de arriba
  // (solo emiten/revocan un JWT, no hay datos de negocio que reproducir).
  // El registro y la verificación de correo SÍ se dejan encolar (crean
  // la fila en "readers", que si no se perdería tras un failover).
  "/api/readers/login",
  "/api/readers/logout",
  "/api/readers/me",
  // Dispara internamente publicarArticulosProgramados/etc. (ver
  // ejecutarCronRespaldo en index.js), que ya hacen sus propias
  // escrituras SQL. No tiene body de negocio reproducible: encolarlo
  // solo generaría entradas basura en pending_writes.
  "/api/internal/cron-respaldo",
]);

export function debeEncolarse(method, path) {
  if (!METODOS_ESCRITURA.has(method)) return false;
  if (RUTAS_EXCLUIDAS.has(path)) return false;
  return true;
}

// Encola una escritura ya atendida por Postgres/Railway para que el Worker
// principal la reproduzca contra D1 en cuanto vuelva a estar operativo.
// No lanza si falla el encolado (ver comentario en la llamada): perder el
// registro de la cola es peor que no bloquear la respuesta al usuario, así
// que el error se loguea y ya, no se propaga hacia el llamador.
//
// writeId ahora se recibe ya generado por quien llama (server-railway.js),
// en vez de generarse aquí: así puede pasarse ANTES a handler.fetch como
// cabecera X-Write-Id (ver server-railway.js), de forma que la fila que
// Postgres crea y la fila que D1 creará al reproducir esta escritura
// compartan el mismo origin_write_id desde el primer momento. Si por lo
// que sea no llega un writeId ya generado (llamadas antiguas o de test),
// se genera aquí como red de seguridad -- pero entonces la fila de
// Postgres ya se creó sin ese id en su columna origin_write_id, así que la
// deduplicación en sync/incremental.mjs no podría reconciliarla (mismo
// comportamiento que antes de este cambio: se marca aquí para que quede
// claro en los logs, no falla en silencio).
export async function encolarEscritura({ writeId: writeIdEntrante, method, path, queryString, body, authorizationHeader, userId, originalStatus }) {
  const writeId = writeIdEntrante || crypto.randomUUID();
  if (!writeIdEntrante) {
    // Antes: console.warn por CADA escritura sin writeId pre-generado.
    // Durante un failover real y largo, con tráfico normal llegando, esto
    // podía sumar cientos/miles de líneas en el log de Railway -el propio
    // volumen de logging (buffers de stdout acumulándose si el proceso no
    // puede vaciarlos tan rápido como se generan, más el coste de formatear
    // cada línea) contribuía al pico de memoria que terminaba en "Killed",
    // aparte de ser puro ruido para diagnosticar el failover en sí.
    // Se sustituye por un contador en memoria que se resume periódicamente
    // (ver contadorSinWriteId más abajo): la primera vez que ocurre se
    // avisa igual (para no perder la señal de que algo raro pasa), pero las
    // siguientes se acumulan en silencio y se vuelcan como un único
    // resumen cada RESUMEN_INTERVALO_MS, no una línea por escritura.
    contadorSinWriteId.total++;
    if (contadorSinWriteId.total === 1) {
      console.warn(`[pending-writes] encolando ${method} ${path} sin writeId pre-generado: la fila creada en Postgres (si la hay) no llevará origin_write_id y no podrá reconciliarse automáticamente al llegar de vuelta desde D1. (siguientes ocurrencias se resumirán cada ${RESUMEN_INTERVALO_MS / 1000}s)`);
    }
    programarResumenSinWriteId();
  }
  // Red de seguridad: un cuerpo con bytes 0x00 es binario (PostgreSQL no
  // los admite en TEXT y fallaría con un error genérico). Se dice claro y
  // no se intenta el INSERT.
  if (typeof body === "string" && body.includes("\u0000")) {
    console.error(`[pending-writes] ${method} ${path} no se encola: el cuerpo contiene bytes 0x00 (binario, no reproducible como JSON)`);
    return null;
  }
  try {
    await pool.query(
      `INSERT INTO pending_writes
         (write_id, method, path, query_string, body, authorization_header, user_id, original_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [writeId, method, path, queryString || null, body || null, authorizationHeader || null, userId || null, originalStatus || null]
    );
    // Antes: console.log por CADA escritura encolada -- mismo problema que
    // arriba (verboso en un failover largo). Se sustituye por un contador
    // que también se resume periódicamente, en vez de una línea por
    // escritura. contarPendientes() (usado por /api/internal/pending-writes-count)
    // sigue dando el conteo exacto en cualquier momento si hace falta
    // precisión inmediata; este log es solo para seguimiento en vivo.
    contadorEncoladas.total++;
    programarResumenEncoladas();
    return writeId;
  } catch (error) {
    console.error("[pending-writes] no se pudo encolar la escritura:", error.message);
    return null;
  }
}

// --- Resumen periódico en vez de una línea por escritura ---
//
// RESUMEN_INTERVALO_MS configurable por si se quiere un resumen más o
// menos frecuente sin tocar código. 30s por defecto: suficiente para ver
// el ritmo de encolado en vivo durante un failover sin generar una línea
// por cada request.
const RESUMEN_INTERVALO_MS = Number(process.env.PENDING_WRITES_LOG_INTERVAL_MS || 30_000);

const contadorEncoladas = { total: 0, timer: null };
function programarResumenEncoladas() {
  if (contadorEncoladas.timer) return; // ya hay un resumen programado
  contadorEncoladas.timer = setTimeout(() => {
    console.log(`[pending-writes] ${contadorEncoladas.total} escritura(s) encolada(s) en los últimos ${RESUMEN_INTERVALO_MS / 1000}s.`);
    contadorEncoladas.total = 0;
    contadorEncoladas.timer = null;
  }, RESUMEN_INTERVALO_MS);
  // unref(): no debe mantener vivo el proceso solo por este timer si el
  // resto del proceso ya quiere cerrar (p.ej. en tests o en un shutdown).
  contadorEncoladas.timer.unref?.();
}

const contadorSinWriteId = { total: 0, timer: null };
function programarResumenSinWriteId() {
  if (contadorSinWriteId.timer) return;
  contadorSinWriteId.timer = setTimeout(() => {
    if (contadorSinWriteId.total > 1) {
      console.warn(`[pending-writes] ${contadorSinWriteId.total} escritura(s) sin writeId pre-generado en los últimos ${RESUMEN_INTERVALO_MS / 1000}s.`);
    }
    contadorSinWriteId.total = 0;
    contadorSinWriteId.timer = null;
  }, RESUMEN_INTERVALO_MS);
  contadorSinWriteId.timer.unref?.();
}

export async function contarPendientes() {
  try {
    const r = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM pending_writes GROUP BY status`
    );
    const out = { pending: 0, applied: 0, failed: 0 };
    for (const row of r.rows) out[row.status] = row.n;
    return out;
  } catch (error) {
    console.error("[pending-writes] no se pudo contar pendientes:", error.message);
    return { pending: null, applied: null, failed: null };
  }
}
