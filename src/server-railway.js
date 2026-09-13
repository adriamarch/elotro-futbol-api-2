// Punto de entrada para Railway (API secundaria).
//
// IMPORTANTE: este archivo es una capa HTTP nueva, totalmente separada de
// src/index.js (el Worker original de Cloudflare, que NO se toca). Por
// ahora solo expone un endpoint de salud para verificar que el servicio
// arranca correctamente en Railway. Los ~45 endpoints reales de la API
// (login, articles, results, etc.) se migrarán en pasos posteriores,
// reutilizando la lógica de src/index.js poco a poco.
//
// No usa D1 ni ningún binding de Cloudflare: de momento no toca base de
// datos en absoluto.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import crypto from "node:crypto";
import handler from "./index.js";
import { createD1CompatDb, checkPostgres, checkSyncFreshness, pool } from "./postgres-db.js";
import { debeEncolarse, encolarEscritura, contarPendientes } from "./pending-writes.js";
import { ejecutarMigraciones } from "../scripts/migrate.mjs";

const app = new Hono();
// Misma whitelist que worker/src/index.js (ORIGENES_PERMITIDOS): el
// dominio de producción con y sin "www", más localhost en los puertos
// habituales de desarrollo. Antes solo se permitía "https://elotrofutbol.media"
// a secas, lo que ya era mucho más seguro que un origin: "*", pero
// dejaba fuera cualquier prueba en local contra esta API.
app.use(
  "*",
  cors({
    origin: [
      "https://elotrofutbol.media",
      "https://www.elotrofutbol.media",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:8788",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:8788",
    ],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

const env = {
  DB: createD1CompatDb(),
  // Señala a fetchRailway() (src/index.js) que este handler ya se está
  // ejecutando dentro de Railway, para que no intente reenviarse a sí
  // mismo si su propia consulta a Postgres falla (ver fetchRailway).
  RUNNING_IN_RAILWAY: true,
  // URL pública de este mismo servicio de Railway. Solo se usa desde el
  // Worker de Cloudflare (worker/src/index.js) para hacer failover hacia
  // aquí; se mantiene también aquí por si algún endpoint interno la
  // necesita para construir enlaces absolutos.
  RAILWAY_URL:
    process.env.RAILWAY_URL ||
    "https://elotro-futbol-api-production.up.railway.app",
  // Solo para el endpoint temporal /api/debug/migrar-jornadas-calendario
  // (ver src/index.js): permite ejecutar SQL multi-statement directo.
  // BORRAR esta línea junto con ese endpoint una vez usado.
  PGPOOL: pool,
  JWT_SECRET: process.env.JWT_SECRET,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM: process.env.RESEND_FROM,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  // Client ID de OAuth de Google (login "Continuar con Google" de
  // lectores, ver /api/readers/google en src/index.js). Mismo valor que
  // GOOGLE_CLIENT_ID en worker/wrangler.toml.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  // Application (client) ID de la app de Azure para "Iniciar sesión con
  // Microsoft" (lectores, ver /api/readers/microsoft en src/index.js).
  // Mismo valor que MICROSOFT_CLIENT_ID en worker/wrangler.toml.
  MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
  // Client ID y Client Secret de la app de Discord para "Iniciar sesión
  // con Discord" (lectores, ver /api/readers/discord/* en src/index.js).
  // Mismos valores que DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET en
  // worker/wrangler.toml.
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  // Protege POST /api/internal/cron-respaldo (ver src/index.js): debe
  // coincidir con el valor puesto en el cron externo de Railway que
  // llama a este endpoint (cabecera X-Internal-Cron-Secret).
  INTERNAL_CRON_SECRET: process.env.INTERNAL_CRON_SECRET,
  // Opcional: sobrescribe la URL de /api/health del primario que usa
  // ese mismo endpoint para decidir si debe actuar. Si no se define, usa
  // el dominio workers.dev por defecto (ver src/index.js).
  PRIMARY_HEALTH_URL: process.env.PRIMARY_HEALTH_URL,
};

// Fallo rápido y con mensaje claro si falta JWT_SECRET: sin validar esto
// aquí, el servicio arranca sin problema (Node no se queja de una env var
// vacía), pero la primera vez que alguien inicia sesión, el código de
// firma de JWT (signHS256, vía crypto.subtle.importKey con una clave de
// longitud 0) revienta con "DOMException: Zero-length key is not
// supported" -- un error sin relación aparente con "falta una variable de
// entorno", que además solo aparece en el peor momento posible: cuando la
// primaria ya ha caído y el panel entero depende de que el login funcione
// en la secundaria. Mejor no arrancar en absoluto que arrancar roto.
if (!process.env.JWT_SECRET) {
  console.error(
    "[worker-secondary] FALTA la variable de entorno JWT_SECRET. " +
    "Debe tener EXACTAMENTE el mismo valor que el JWT_SECRET configurado " +
    "en el Worker primario de Cloudflare (wrangler secret put JWT_SECRET), " +
    "si no, los tokens emitidos por una API no se podrán validar en la " +
    "otra. Configúrala en las variables de entorno del servicio de " +
    "Railway y vuelve a desplegar."
  );
  process.exit(1);
}

// ================================================================
// PREVENCIÓN: no servir datos viejos en silencio durante un failover
// ================================================================
// checkSyncFreshness() ya existía para /api/health, pero nadie lo veía
// mientras el failover estaba en marcha de verdad -- solo se consultaba
// a mano. Esto lo expone en TODA respuesta servida durante un failover
// real (X-Failover-Origin: worker-primary), como cabecera
// X-Data-Staleness-Ms, para que el frontend (o el propio admin mirando
// las devtools) pueda ver "estos datos llevan X tiempo sin
// sincronizarse" en vez de asumir que son actuales en silencio.
//
// Se cachea en memoria (proceso de Railway) unos segundos: consultar
// sync_cursor es una lectura a Postgres, que es justo la base de datos
// que ya está bajo más carga durante un failover, así que no conviene
// hacerlo en cada petición.
let cacheFrescura = { valor: null, comprobadoEn: 0 };
const TTL_CACHE_FRESCURA_MS = 15_000;

async function frescuraConCache() {
  const ahora = Date.now();
  if (cacheFrescura.valor && ahora - cacheFrescura.comprobadoEn < TTL_CACHE_FRESCURA_MS) {
    // Se ajusta staleForMs con el tiempo transcurrido desde que se
    // cacheó, para que no se quede "congelado" en un valor viejo dentro
    // de la propia ventana de caché.
    const transcurrido = ahora - cacheFrescura.comprobadoEn;
    return { ...cacheFrescura.valor, staleForMs: (cacheFrescura.valor.staleForMs ?? 0) + transcurrido };
  }
  const valor = await checkSyncFreshness();
  cacheFrescura = { valor, comprobadoEn: ahora };
  return valor;
}

// Umbral a partir del cual se considera que el failover lleva "demasiado"
// sirviendo datos desfasados como para avisar de forma más visible (no
// solo la cabecera pasiva): 30 minutos. Con el mecanismo de reset de D1 a
// las 00:00 UTC, un failover normal por cuota agotada no debería superar
// esto salvo que algo más haya ido mal (sincronizador caído, etc.).
const UMBRAL_AVISO_STALENESS_MS = 30 * 60 * 1000;

app.get("/api/health", async (c) => {
  try {
    const database = await checkPostgres();
    // Estado del sincronizador D1 -> PostgreSQL (proceso Node aparte,
    // sync/scheduler.mjs). requireAuth confía en que este proceso esté
    // sano para poder aceptar sesiones aún no replicadas sin arriesgarse a
    // aceptar sesiones revocadas que nunca lleguen a sincronizarse (ver
    // comentario junto a UMBRAL_SYNC_STALE_MS en index.js). Se expone aquí
    // para poder monitorizarlo y alertar si se cae, en vez de descubrirlo
    // solo cuando falla un intento de revocar una sesión.
    const sync = await checkSyncFreshness();
    // Nota deliberada: el estado HTTP (200/503) de este healthcheck sigue
    // dependiendo solo de "database" (Postgres), no del sincronizador. Un
    // sincronizador caído es un problema real (ver requireAuth), pero vive
    // en OTRO proceso/servicio (sync/scheduler.mjs) -- reiniciar este
    // contenedor de server-railway.js no lo arregla. Si este endpoint
    // devolviera 503 por eso, un healthcheck de plataforma (Railway) podría
    // reiniciar el proceso equivocado en bucle sin resolver nada. Por eso
    // "sync" se expone siempre en el body, para monitorización activa
    // (alertas externas), sin acoplarlo al código HTTP de liveness.
    return c.json(
      {
        status: database.ok ? "ok" : "degraded",
        database: database.ok,
        storage: null,
        responseTime: database.responseTime,
        api: "secondary",
        sync: {
          healthy: !sync.stale,
          lastSyncedAt: sync.lastSyncedAt,
          staleForMs: sync.staleForMs,
          reason: sync.reason,
        },
      },
      database.ok ? 200 : 503
    );
  } catch (error) {
    console.error("[health] PostgreSQL error:", error);
    return c.json({ status: "degraded", database: false, storage: null, responseTime: null, api: "secondary" }, 503);
  }
});

// POST /api/internal/cron-respaldo
//
// Dispara en la secundaria (Postgres/Railway) las MISMAS tareas
// periódicas que el Worker principal ejecuta cada minuto vía su cron
// trigger de Cloudflare (ver "async scheduled" al final de este mismo
// archivo index.js, y worker/wrangler.toml -> [triggers]):
//   - publicarArticulosProgramados
//   - iniciarPartidosProgramadosCuyaHoraHaLlegado (arranca el
//     cronómetro de partidos programados cuya hora ya llegó, la pieza
//     que hace que la clasificación se vea "en directo")
//   - revisarPartidosDesatendidos
//   - enviarBoletinSemanalSiToca
//
// A propósito, esta ruta NO comprueba si el primario está vivo o
// caído antes de actuar: se ejecuta SIEMPRE que el cron de Railway la
// llama (cada 5 minutos, ver scripts/cron-respaldo.mjs). Así ambos
// backends quedan sincronizados en todo momento y ninguno depende de
// la salud del otro para que lo "en vivo" funcione -- ya sea que el
// tráfico esté sirviéndose desde el primario o desde el secundario en
// ese instante. Duplicar la ejecución de estas tareas es seguro: cada
// una es idempotente sobre su propia base de datos (una actualiza
// D1, la otra Postgres; nunca la misma fila dos veces con el mismo
// efecto -- iniciarPartidosProgramadosCuyaHoraHaLlegado solo actúa
// sobre partidos en estado "programado" o "retrasado" cuya hora
// correspondiente ya haya llegado).
app.post("/api/internal/cron-respaldo", async (c) => {
  const secretoEsperado = env.INTERNAL_CRON_SECRET;
  if (!secretoEsperado) {
    return c.json({ ok: false, error: "INTERNAL_CRON_SECRET no configurado en este servicio" }, 503);
  }
  const secretoRecibido = c.req.header("X-Internal-Cron-Secret");
  if (!secretoRecibido || secretoRecibido !== secretoEsperado) {
    return c.json({ ok: false, error: "No autorizado" }, 401);
  }

  const ctx = { waitUntil(promise) { return promise; } };
  const tareas = {
    publicarArticulosProgramados: null,
    iniciarPartidosProgramadosCuyaHoraHaLlegado: null,
    // Debe ir ANTES de revisarPartidosDesatendidos: marca como 'colgado'
    // los partidos con más de 2000' corriendo para que la revisión de
    // "desatendido" (que solo mira estado = 'en_juego') ya no los vea y
    // no se manden avisos duplicados. Object.keys conserva el orden de
    // inserción, así que basta con declararlo en este orden.
    marcarPartidosColgados: null,
    revisarPartidosDesatendidos: null,
    enviarBoletinSemanalSiToca: null,
  };
  const errores = {};

  // Se ejecutan en secuencia (no en paralelo) y cada una se envuelve en
  // su propio try/catch: un fallo en una tarea no debe impedir que las
  // demás corran, igual que en el "scheduled" del Worker principal
  // (donde cada ctx.waitUntil(...) es independiente).
  for (const nombre of Object.keys(tareas)) {
    try {
      await handler[nombre](env, ctx);
      tareas[nombre] = "ok";
    } catch (error) {
      tareas[nombre] = "error";
      errores[nombre] = error.message;
      console.error(`[cron-respaldo] fallo en ${nombre}:`, error);
    }
  }

  const huboErrores = Object.keys(errores).length > 0;
  return c.json(
    { ok: !huboErrores, ejecutado_en: new Date().toISOString(), tareas, errores: huboErrores ? errores : undefined },
    huboErrores ? 207 : 200
  );
});

app.all("*", async (c) => {
  if (c.req.path === "/api/health") return c.notFound();
  if (c.req.path === "/api/internal/pending-writes-count") {
    // Solo diagnóstico (panel/monitorización), sin datos sensibles del
    // contenido de las escrituras -- por eso no pasa por requireAuth de
    // index.js. No se expone el contenido de la cola aquí, solo conteos.
    const counts = await contarPendientes();
    return c.json(counts);
  }

  const method = c.req.method;
  const path = c.req.path;
  const esFailoverReal = c.req.header("X-Failover-Origin") === "worker-primary";

  const ctx = { waitUntil(promise) { Promise.resolve(promise).catch((error) => console.error("[waitUntil]", error)); } };

  // Si esta escritura puede necesitar encolarse, hace falta leer el body
  // ANTES de pasarlo a handler.fetch (que también lo consume) -- de ahí el
  // clone(). Para el resto de peticiones (GET, o failover no confirmado)
  // no merece la pena el coste de leer y clonar el body sin necesidad.
  const candidataAEncolar = esFailoverReal && debeEncolarse(method, path);
  let bodyTexto = null;
  if (candidataAEncolar) {
    try {
      bodyTexto = await c.req.raw.clone().text();
    } catch (error) {
      console.error("[pending-writes] no se pudo leer el body para encolar:", error.message);
    }
  }

  // writeId se genera AQUÍ, antes de que Postgres atienda la petición, y no
  // dentro de encolarEscritura() como antes -- así puede pasarse también al
  // handler como cabecera X-Write-Id para que, si la petición crea una fila
  // nueva (POST /api/articles o /api/results), esa fila nazca ya con
  // origin_write_id = writeId en Postgres. Cuando esta misma escritura se
  // reproduzca luego contra D1 (ver drainPendingWrites en
  // worker/src/index.js, que reenvía el mismo write_id de la cola), D1
  // creará su fila con el MISMO origin_write_id, lo que permite a
  // sync/incremental.mjs reconciliar ambas filas como una sola en vez de
  // duplicar (ver worker/migracion_origin_write_id.sql para el porqué
  // completo). Sin esto, el id que ligaba ambos lados solo vivía en la
  // cola (pending_writes.write_id) y nunca llegaba a las tablas de negocio.
  const writeId = candidataAEncolar ? crypto.randomUUID() : null;
  const requestConWriteId = writeId
    ? new Request(c.req.raw, { headers: new Headers(c.req.raw.headers) })
    : c.req.raw;
  if (writeId) requestConWriteId.headers.set("X-Write-Id", writeId);

  const response = await handler.fetch(requestConWriteId, env, ctx);

  // Solo en failover real (no en tráfico de prueba/curl directo a
  // Railway) se añade la cabecera de frescura de datos: es la
  // información que un usuario/frontend necesita para saber si lo que
  // está viendo puede estar desactualizado mientras D1 no responde.
  let respuestaFinal = response;
  if (esFailoverReal) {
    try {
      const frescura = await frescuraConCache();
      const headers = new Headers(response.headers);
      headers.set("X-Data-Staleness-Ms", String(frescura.staleForMs ?? ""));
      headers.set("X-Data-Staleness-Stale", frescura.stale ? "true" : "false");
      if (frescura.staleForMs != null && frescura.staleForMs > UMBRAL_AVISO_STALENESS_MS) {
        headers.set("X-Data-Staleness-Warning", "true");
      }
      respuestaFinal = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      // No dejar que un fallo comprobando frescura tumbe la respuesta
      // real del failover -- es información adicional, no crítica.
      console.error("[staleness] no se pudo anotar la respuesta:", error.message);
    }
  }

  if (candidataAEncolar && response.status < 500) {
    // Solo se encola si Postgres/Railway la atendió con éxito (< 500): si
    // Railway también la rechazó (validación, permisos, etc.), no hay nada
    // que reproducir -- el usuario ya vio el error y no hizo falta cambiar
    // nada. Encolarla igualmente duplicaría trabajo sin sentido cuando D1
    // vuelva, y generaría fallos previsibles en la cola por el mismo
    // motivo que ya falló aquí.
    let userId = null;
    try {
      const auth = c.req.header("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token) {
        const payloadB64 = token.split(".")[1];
        if (payloadB64) {
          const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
          userId = payload.uid ?? null;
        }
      }
    } catch {
      // Decodificación best-effort solo para metadata de auditoría; un
      // JWT raro no debe impedir encolar la escritura.
    }
    ctx.waitUntil(
      encolarEscritura({
        writeId,
        method,
        path,
        queryString: new URL(c.req.url).search,
        body: bodyTexto,
        authorizationHeader: c.req.header("Authorization") || null,
        userId,
        originalStatus: response.status,
      })
    );
  }

  return respuestaFinal;
});

const port = Number(process.env.PORT) || 8080;

// Railway (y contenedores en general) solo enrutan tráfico externo hacia
// 0.0.0.0. Si se escucha en localhost/127.0.0.1 (comportamiento por
// defecto de @hono/node-server), el proceso arranca y pasa el healthcheck
// interno, pero el dominio público nunca llega a conectar.
//
// Antes de abrir el puerto, aplicamos las migraciones pendientes de
// db/migrations/ (ver scripts/migrate.mjs). Es idempotente -- lleva un
// registro en schema_migrations y salta las ya aplicadas -- así que es
// seguro que corra en cada arranque/deploy. Esto evita el bug de
// 2026-09 en el que faltaba newsletter_envios en Postgres porque nadie
// había ejecutado `npm run db:migrate` manualmente tras crear la
// migración 009.
try {
  await ejecutarMigraciones();
} catch (error) {
  console.error(
    "[worker-secondary] ERROR aplicando migraciones al arrancar:",
    error.message
  );
  // No frenamos el arranque: preferimos servir con el esquema que haya
  // (y que el resto de endpoints sigan funcionando) antes que dejar el
  // servicio completamente caído por un problema de migraciones.
}

serve({
  fetch: app.fetch,
  port,
  hostname: "0.0.0.0",
}, (info) => {
  console.log(`[worker-secondary] API secundaria escuchando en 0.0.0.0:${info.port}`);
});
