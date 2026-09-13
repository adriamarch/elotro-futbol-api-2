// Script de arranque para el servicio Cron de Railway que dispara el
// respaldo de tareas programadas (ver "/api/internal/cron-respaldo" en
// src/index.js y el comentario junto a esa ruta para el porqué completo).
//
// Un servicio Cron de Railway ejecuta este comando en el horario
// configurado, espera a que termine y se apaga: no es un proceso que
// quede corriendo en bucle (eso sería malgastar recursos), así que este
// script solo hace UNA petición HTTP y termina con el código de salida
// que corresponda.
//
// Variables de entorno necesarias en este servicio Cron (configúralas en
// Railway → tu proyecto → este servicio → Variables):
//   CRON_RESPALDO_URL       URL pública del servicio server-railway.js +
//                           "/api/internal/cron-respaldo"
//                           (ej: https://elotro-futbol-api-production.up.railway.app/api/internal/cron-respaldo)
//   INTERNAL_CRON_SECRET    el MISMO valor puesto en el servicio
//                           server-railway.js (ver server-railway.js, env.INTERNAL_CRON_SECRET)

const url = process.env.CRON_RESPALDO_URL;
const secreto = process.env.INTERNAL_CRON_SECRET;

if (!url || !secreto) {
  console.error(
    "[cron-respaldo] Faltan CRON_RESPALDO_URL o INTERNAL_CRON_SECRET " +
    "en las variables de entorno de este servicio Cron."
  );
  process.exit(1);
}

try {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-Internal-Cron-Secret": secreto },
    signal: controller.signal,
  });
  clearTimeout(timeoutId);

  const cuerpo = await res.text();
  console.log(`[cron-respaldo] Respuesta ${res.status}:`, cuerpo);

  if (!res.ok) {
    process.exit(1);
  }
} catch (error) {
  console.error("[cron-respaldo] Error llamando al endpoint:", error.message);
  process.exit(1);
}
