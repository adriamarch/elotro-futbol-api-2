// ElOtroFútbol - Worker API
// Rutas: /api/login, /api/me, /api/me/sesiones, /api/articles, /api/results, /api/media, /api/custom-clubs, /api/articles/:id/comments, /api/comments/:id/vote, /api/comments/:id/report, /api/admin/comments, /api/admin/comments/reported, /api/club-info, /api/admin/club-info, /api/track/view, /api/track/reading, /api/track/result-view, /api/admin/analiticas/* (resumen, mas-leidas, fuentes, autores, tiempo-lectura, idiomas, partidos-seguidos, gsc), /sitemap-noticias.xml, /sitemap-news.xml, /rss.xml

// Escapa los caracteres especiales de XML para que un título o slug con
// "&", "<", ">", comillas, etc. no rompa el XML del sitemap.
function escaparXml(texto) {
  return String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Convierte una fecha guardada por SQLite ("YYYY-MM-DD HH:MM:SS", UTC) o
// un ISO string en el formato de fecha simple "YYYY-MM-DD" que espera
// <lastmod> en un sitemap. Si no hay fecha o no se puede parsear, se omite
// (mejor no mandar <lastmod> que mandar uno inventado o mal formado).
function fechaParaSitemap(valor) {
  if (!valor) return null;
  const fecha = new Date(valor.includes("T") || valor.endsWith("Z") ? valor : `${valor.replace(" ", "T")}Z`);
  if (Number.isNaN(fecha.getTime())) return null;
  return fecha.toISOString().slice(0, 10);
}


// Convierte una fecha a texto en el mismo formato que usa SQLite para
// datetime('now') ("YYYY-MM-DD HH:MM:SS", en UTC, sin milisegundos ni
// separador "T"/"Z"). Es imprescindible guardar "programado_para" con
// este formato exacto: al ser una columna TEXT, la comparación
// "programado_para <= datetime('now')" del disparador programado es una
// comparación de texto, no de fechas, así que un ISO string normal
// (con "T"/"Z"/milisegundos) nunca es "menor o igual" aunque la hora ya
// haya pasado, y las noticias programadas se quedarían sin publicar.
function aSqliteDatetimeUTC(fecha) {
  return fecha.toISOString().slice(0, 19).replace("T", " ");
}

// Convierte una fecha guardada por SQLite o un ISO string al formato
// RFC-822 que exige la especificación RSS 2.0 para <pubDate>
// (p.ej. "Tue, 18 Aug 2026 10:00:00 GMT"). Si no hay fecha o no se
// puede parsear, se omite (igual que fechaParaSitemap con <lastmod>).
function fechaParaRss(valor) {
  if (!valor) return null;
  const fecha = new Date(valor.includes("T") || valor.endsWith("Z") ? valor : `${valor.replace(" ", "T")}Z`);
  if (Number.isNaN(fecha.getTime())) return null;
  return fecha.toUTCString();
}

// Quita etiquetas HTML y colapsa espacios para obtener un extracto de
// texto plano a partir del contenido (HTML) de una noticia, usable como
// <description> en RSS. Trunca a "limite" caracteres sin cortar una
// palabra a la mitad.
function extractoTexto(html, limite = 300) {
  const texto = String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (texto.length <= limite) return texto;
  return texto.slice(0, texto.lastIndexOf(" ", limite)) + "…";
}

// "fecha_partido" se guarda tal cual la escribe el redactor en el
// <input type="datetime-local"> del panel (hora de Madrid, SIN
// información de zona horaria: "2026-08-08T15:40"), pero tanto el reloj
// del cron como Date.now() trabajan en UTC. Sin corregir el desfase, un
// partido puesto a las 15:40 no arrancaba solo hasta las 17:40 (CEST,
// UTC+2) o las 16:40 (CET, UTC+1) según la época del año.
//
// Devuelve el desplazamiento en minutos que hay que RESTAR a una fecha
// interpretada como Madrid para obtener el instante UTC real
// equivalente (p.ej. 120 en horario de verano, 60 en horario de
// invierno). Se calcula pidiéndole al motor de Intl el offset vigente
// en Madrid para el instante indicado (por defecto, ahora), así el
// cambio de hora de primavera/otoño se gestiona solo, sin tablas de
// fechas hardcodeadas.
function offsetMadridEnMinutos(instante = new Date()) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instante).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  // Instante que esos mismos "dígitos de reloj" representarían si
  // fuesen UTC, comparado con el instante real: la diferencia es el
  // offset de Madrid en ese momento (Date.UTC no lanza nunca).
  const comoSiFueraUTC = Date.UTC(
    partes.year, partes.month - 1, partes.day, partes.hour, partes.minute, partes.second
  );
  return Math.round((comoSiFueraUTC - instante.getTime()) / 60000);
}

// Convierte "fecha_partido" (hora de Madrid, formato "YYYY-MM-DDTHH:MM")
// al datetime UTC equivalente en formato SQLite ("YYYY-MM-DD HH:MM:SS"),
// para poder compararlo con datetime('now') sin desfase horario. null si
// no trae hora (solo fecha, longitud distinta de 16).
function fechaPartidoAUtcSqlite(fechaPartido) {
  if (!fechaPartido || fechaPartido.length !== 16) return null;
  const comoSiFueraUTC = new Date(`${fechaPartido}:00Z`);
  if (isNaN(comoSiFueraUTC.getTime())) return null;
  const offset = offsetMadridEnMinutos(comoSiFueraUTC);
  const real = new Date(comoSiFueraUTC.getTime() - offset * 60000);
  return aSqliteDatetimeUTC(real);
}

// Whitelist de orígenes permitidos para CORS: solo el dominio de
// producción (con y sin "www") y localhost en varios puertos habituales
// de desarrollo. Antes se devolvía "*" para cualquier origen. Esta copia
// de index.js corre dentro de Railway (ver server-railway.js), que ya
// aplica su propia whitelist vía el middleware cors() de Hono; esto es
// una segunda capa por si esta función se invoca fuera de ese flujo.
const ORIGENES_PERMITIDOS = [
  "https://elotrofutbol.media",
  "https://www.elotrofutbol.media",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8788",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8788",
];

function origenPermitido(origin) {
  return !!origin && ORIGENES_PERMITIDOS.includes(origin);
}

let ORIGEN_PETICION_ACTUAL = null;

function cors(resp, origin) {
  const efectivo = origin !== undefined ? origin : ORIGEN_PETICION_ACTUAL;
  if (origenPermitido(efectivo)) {
    resp.headers.set("Access-Control-Allow-Origin", efectivo);
    resp.headers.set("Vary", "Origin");
  }
  resp.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  // Sin esto, el JavaScript del navegador no puede leer estas cabeceras
  // aunque viajen en la respuesta: por defecto, fetch() en un origen
  // cruzado solo expone al código de la página un pequeño conjunto de
  // cabeceras "seguras" (Content-Type, Cache-Control...), y cualquier
  // cabecera personalizada como X-Failover-Backend queda oculta para
  // response.headers.get(...) salvo que el servidor la liste aquí
  // explícitamente. Sin esta línea, el frontend no tiene forma de saber
  // que una respuesta con status 200 vino en realidad de Railway a través
  // del reenvío interno del Worker (ver fetchRailway más abajo).
  resp.headers.set("Access-Control-Expose-Headers", "X-Failover-Backend,X-Failover-Test,X-Failover-Reason,X-Data-Staleness-Ms,X-Data-Staleness-Stale,X-Data-Staleness-Warning");
  return resp;
}
function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    // "no-store" evita que Cloudflare (u otro caché intermedio) sirva una
    // respuesta antigua para peticiones GET repetidas a la misma URL, como
    // pasaba con /api/results/:id al refrescar el modal de partido: sin
    // esta cabecera el marcador/estado podían quedarse "pegados" al primer
    // valor que se pidió, aunque los eventos sí se actualizaran.
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));
}

// ---------- Utils crypto ----------
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes.buffer;
}
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBuf(saltHex), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bufToHex(bits);
}
function randomSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return bufToHex(arr.buffer);
}

// ---------- Traducciones de artículos ----------
// Idiomas a los que se puede traducir una noticia/crónica, además del
// castellano (que es siempre el idioma base, obligatorio). La traducción
// a cada uno es opcional: la hace el propio redactor al subir o editar
// el artículo, no hay traducción automática.
const IDIOMAS_TRADUCCION = ["eu", "ca", "gl", "en"];

// Un idioma se considera "traducido" (disponible) cuando tiene, como
// mínimo, título Y contenido. El subtítulo es opcional incluso dentro
// de un idioma ya traducido (igual que en castellano). Se centraliza
// aquí para que backend y frontend usen exactamente el mismo criterio.
function idiomaCompleto(campos) {
  return Boolean(campos.titulo && campos.contenido);
}

// Normaliza un valor de texto venido del body: recorta espacios y
// convierte cadenas vacías (o solo espacios) en null. Cualquier valor
// no-string (undefined, null, número raro) también se resuelve a null,
// para que nunca se cuele algo distinto de TEXT|NULL en la BD.
function normalizarTexto(valor) {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim();
  return limpio ? limpio : null;
}

// Construye, a partir del body recibido, los pares columna->valor para
// las columnas _eu/_ca/_gl/_en de titulo/subtitulo/contenido. Si el
// redactor no ha escrito nada en un idioma (o lo ha borrado), se guarda
// NULL para que esa noticia se marque como no disponible en ese idioma.
//
// Regla de integridad: si un idioma tiene subtítulo y/o contenido pero
// falta el título (por ejemplo el redactor borró solo el título por
// error), ese idioma se descarta entero -> los tres campos van a NULL.
// Así se evita el estado inconsistente "hay traducción pero sin título",
// que rompería el selector de idioma y el listado de artículos.
// Si en cambio falta el contenido (con o sin título), el idioma tampoco
// se considera válido, por el mismo motivo: una noticia sin cuerpo no es
// una traducción utilizable.
function extraerTraducciones(body) {
  const campos = {};
  const avisos = [];
  for (const idioma of IDIOMAS_TRADUCCION) {
    const t = (body.traducciones && body.traducciones[idioma]) || {};
    const titulo = normalizarTexto(t.titulo);
    const subtitulo = normalizarTexto(t.subtitulo);
    const contenido = normalizarTexto(t.contenido);

    if (idiomaCompleto({ titulo, contenido })) {
      campos[`titulo_${idioma}`] = titulo;
      campos[`subtitulo_${idioma}`] = subtitulo;
      campos[`contenido_${idioma}`] = contenido;
    } else {
      // Incompleto: se descarta el idioma entero, pero si había algo
      // escrito se avisa en la respuesta para que el redactor lo sepa
      // (evita que un texto a medias "desaparezca" en silencio).
      if (titulo || subtitulo || contenido) {
        avisos.push(
          `${idioma}: falta ${titulo ? "" : "título"}${!titulo && !contenido ? " y " : ""}${contenido ? "" : "contenido"} — no se ha guardado esta traducción.`
        );
      }
      campos[`titulo_${idioma}`] = null;
      campos[`subtitulo_${idioma}`] = null;
      campos[`contenido_${idioma}`] = null;
    }
  }
  return { campos, avisos };
}

// Añade a un artículo ya leído de la BD el campo "idiomas_disponibles":
// la lista de idiomas (además de "es", siempre presente) que tienen al
// menos título y contenido traducidos. Lo usa el frontend para el
// selector de idioma y para el aviso "Disponible en...".
function conIdiomasDisponibles(article) {
  const idiomas_disponibles = ["es"];
  for (const idioma of IDIOMAS_TRADUCCION) {
    if (idiomaCompleto({ titulo: article[`titulo_${idioma}`], contenido: article[`contenido_${idioma}`] })) {
      idiomas_disponibles.push(idioma);
    }
  }
  return { ...article, idiomas_disponibles, imagen_foco: focoDePortada(article) };
}

// El foco de recorte ("qué parte de la foto no se debe recortar nunca")
// se guarda por cada foto dentro del array "imagenes", no en la columna
// "imagen_url". Para que las tarjetas, el hero y las mini-cards de la
// portada respeten ese mismo foco (y no solo la foto grande del
// artículo), se busca aquí la foto del array que coincide con la
// portada (imagen_url) y se expone su foco como "imagen_foco" en cada
// artículo devuelto por la API. Si no hay foco guardado, se usa el
// centro ("50% 50%"), que es lo mismo que hacía object-position antes.
//
// La comparación no puede ser un simple "===": hay noticias donde la
// URL guardada en "imagen_url" y la guardada dentro del array difieren
// en detalles que no cambian la imagen real (espacios sueltos, mayúsculas
// en el dominio, "http" vs "https", o una barra final), normalmente
// porque la portada se guardó en momentos distintos del array. Por eso
// se compara también una versión normalizada de la URL antes de rendirse
// y caer en la primera foto del array (que es la portada por diseño
// según el esquema de la tabla).
function normalizarUrlImagen(u) {
  if (typeof u !== "string") return "";
  try {
    return decodeURIComponent(u.trim()).toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  } catch {
    return u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

function focoDePortada(article) {
  if (!article || !article.imagenes) return "50% 50%";
  let imagenes;
  try {
    imagenes = typeof article.imagenes === "string" ? JSON.parse(article.imagenes) : article.imagenes;
  } catch {
    return "50% 50%";
  }
  if (!Array.isArray(imagenes) || imagenes.length === 0) return "50% 50%";

  // 1) Coincidencia exacta de URL.
  let portada = imagenes.find((img) => img && img.url === article.imagen_url);

  // 2) Si no coincide exactamente, se prueba con la URL normalizada.
  if (!portada && article.imagen_url) {
    const objetivo = normalizarUrlImagen(article.imagen_url);
    portada = imagenes.find((img) => img && normalizarUrlImagen(img.url) === objetivo);
  }

  // 3) Si sigue sin encontrarse, se usa la primera foto (no tweet) del
  // array, que es la portada por defecto según el diseño original de la
  // tabla.
  if (!portada) portada = imagenes.find((img) => img && img.tipo !== "tweet");

  return (portada && portada.foco) || "50% 50%";
}

// ---------- Notificaciones por correo ----------
// Avisa a la redacción por email cada vez que se sube contenido (fotos/vídeos)
// o se publica una crónica. Usa Resend (mismo servicio que TGN Fan Shop).
// Requiere el secreto RESEND_API_KEY (wrangler secret put RESEND_API_KEY).
// Si no está configurado, o falla el envío, no rompe la subida: solo se
// registra el error en los logs del Worker.
const EMAIL_NOTIFICACIONES = "elotrofutbolmedio@gmail.com";
const SITIO_URL = "https://elotrofutbol.media";
// Dominio de este mismo Worker (la API), distinto del sitio web
// (SITIO_URL). Cualquier enlace que apunte a una ruta /api/... del
// propio Worker (como la baja del boletín) tiene que usar API_URL, no
// SITIO_URL: ese dominio sirve el frontend estático y nunca llega a
// procesar rutas /api/..., así que un enlace construido con SITIO_URL
// ahí simplemente no funciona (ver public/js/config.js, que es donde el
// frontend usa este mismo dominio como API_URL).
const API_URL = "https://api.elotrofutbol.media";

function escapeHtmlEmail(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Página de mantenimiento temporal (ver "MODO MANTENIMIENTO TEMPORAL" en
// el fetch handler). "horaHasta" es un texto libre opcional (p.ej. "00:00
// (medianoche, hora española)") que se muestra si se ha configurado la
// variable MAINTENANCE_HASTA; si no, se omite esa frase sin dejar un
// hueco raro.
function paginaMantenimiento(horaHasta, desdeISO) {
  const fraseHora = horaHasta
    ? `Volvemos sobre las <strong>${escapeHtmlEmail(horaHasta)}</strong>.`
    : "Volvemos en breve.";
  // Igual que en public/mantenimiento.html: se expone el instante real
  // de inicio del mantenimiento (MAINTENANCE_DESDE) para que, si esta
  // plantilla de reserva llegara a tener su propia barra de progreso en
  // el futuro, calcule el % real en vez de inventar un ciclo fijo. Hoy
  // esta plantilla de texto no incluye barra de progreso, pero se deja
  // aquí disponible por si se añade.
  void desdeISO;
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>ELOTROFÚTBOLTV — En mantenimiento</title>
<style>
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-14px); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .55; }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }
  body {
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(circle at 20% 20%, #0f3d5c 0%, #0a2540 45%, #061627 100%);
    color: #eaf2f8;
    overflow: hidden;
    position: relative;
  }
  body::before, body::after {
    content: "";
    position: absolute;
    border-radius: 50%;
    filter: blur(60px);
    opacity: .35;
  }
  body::before {
    width: 420px; height: 420px;
    background: #e63946;
    top: -120px; left: -120px;
  }
  body::after {
    width: 380px; height: 380px;
    background: #1d7a8c;
    bottom: -140px; right: -100px;
  }
  .card {
    position: relative;
    z-index: 1;
    max-width: 480px;
    margin: 24px;
    padding: 48px 36px;
    text-align: center;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 24px;
    backdrop-filter: blur(14px);
    box-shadow: 0 25px 60px rgba(0,0,0,0.45);
  }
  .ball {
    font-size: 56px;
    display: inline-block;
    animation: float 3s ease-in-out infinite;
  }
  h1 {
    margin: 20px 0 8px;
    font-size: 26px;
    letter-spacing: .3px;
    color: #ffffff;
  }
  p {
    margin: 0 0 6px;
    font-size: 15.5px;
    line-height: 1.6;
    color: #c6d6e2;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 22px;
    padding: 8px 16px;
    border-radius: 999px;
    background: rgba(230, 57, 70, 0.15);
    border: 1px solid rgba(230, 57, 70, 0.4);
    color: #ff9aa2;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: .4px;
    text-transform: uppercase;
  }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #ff5a64;
    animation: pulse 1.4s ease-in-out infinite;
  }
  .brand {
    margin-top: 28px;
    font-size: 13px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: rgba(234,242,248,0.45);
  }
  .brand b { color: rgba(234,242,248,0.75); }
</style>
</head>
<body>
  <div class="card">
    <span class="ball">⚽</span>
    <h1>Estamos haciendo un ajuste rápido</h1>
    <p>ELOTROFÚTBOLTV vuelve enseguida, mejor que nunca.</p>
    <p>${fraseHora}</p>
    <div class="badge"><span class="dot"></span>Mantenimiento en curso</div>
    <div class="brand">EL<b>OTRO</b>FÚTBOLTV</div>
  </div>
</body>
</html>`;
}

// Plantilla HTML compartida por todos los avisos: cabecera con el logo
// sobre fondo marino, franja roja de acento, una etiqueta de tipo, título,
// una lista de datos clave (autor, club, etc.) y un botón de acción.
// Todo con estilos en línea (tablas) porque así es como hay que maquetar
// para que se vea bien en Gmail, Outlook, etc.
function plantillaEmail({ etiqueta, titulo, filas = [], parrafo, boton }) {
  const filasHtml = filas
    .filter((f) => f && f.valor)
    .map(
      (f) => `
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#9aa0ab;width:110px;vertical-align:top;">${escapeHtmlEmail(f.etiqueta)}</td>
          <td style="padding:6px 0;font-size:14px;color:#0c1b2e;font-weight:600;">${escapeHtmlEmail(f.valor)}</td>
        </tr>`
    )
    .join("");

  const botonHtml = boton
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:26px;">
        <tr>
          <td style="border-radius:24px;background:#d1132e;">
            <a href="${boton.url}" style="display:inline-block;padding:12px 26px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#ffffff;text-decoration:none;">${escapeHtmlEmail(boton.texto)}</a>
          </td>
        </tr>
      </table>`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef1f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 4px 18px rgba(12,27,46,.12);">
          <tr>
            <td style="background:#0c1b2e;padding:22px 28px;">
              <img src="${SITIO_URL}/img/logo.png" alt="ELOTROFÚTBOLTV" height="34" style="display:block;">
            </td>
          </tr>
          <tr><td style="height:4px;background:#d1132e;line-height:0;font-size:0;">&nbsp;</td></tr>
          <tr>
            <td style="padding:32px 28px 8px;">
              <span style="display:inline-block;background:#eef1f5;color:#d1132e;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;padding:4px 11px;border-radius:12px;">${escapeHtmlEmail(etiqueta)}</span>
              <h1 style="margin:14px 0 6px;font-size:21px;line-height:1.3;color:#0c1b2e;">${escapeHtmlEmail(titulo)}</h1>
              ${parrafo ? `<p style="margin:0 0 4px;font-size:14px;line-height:1.5;color:#5a6270;">${escapeHtmlEmail(parrafo)}</p>` : ""}
            </td>
          </tr>
          ${filasHtml ? `
          <tr>
            <td style="padding:6px 28px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#eef1f5;border-radius:8px;padding:14px 16px;">
                ${filasHtml}
              </table>
            </td>
          </tr>` : ""}
          <tr>
            <td style="padding:8px 28px 34px;">
              ${botonHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px;background:#f7f8fa;border-top:1px solid #eee;">
              <p style="margin:0;font-size:11.5px;color:#9aa0ab;">Aviso automático de ELOTROFÚTBOLTV · No hace falta responder a este correo.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------- Newsletter / boletín semanal ----------
// Formulario público de suscripción (portada y pie de página) +
// disparador programado que, una vez a la semana, manda un resumen de
// las últimas noticias publicadas a todos los suscriptores activos.
// Usa el mismo Resend que el resto de avisos por email del sitio.

function generarTokenBaja() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function emailValido(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Etiqueta legible de cada competición para los encabezados de sección
// de clasificación dentro del boletín.
function competicionLabelEmail(comp) {
  const NOMBRES = {
    hypermotion: "LaLiga Hypermotion",
    primera_federacion: "Primera Federación (RFEF)",
    segunda_federacion: "Segunda Federación (RFEF)",
  };
  return NOMBRES[comp] || comp;
}

// Tabla de clasificación en HTML compatible con clientes de correo
// (nada de flexbox/grid: todo con <table> y estilos inline). Se recorta
// a "limite" filas (el boletín es un resumen, no la clasificación
// completa) y añade una fila indicando cuántos equipos quedan fuera.
//
// Los estilos inline son el fallback para clientes que ignoran
// <style>/media queries (Outlook, Gmail app antigua...); las clases
// (eof-*) son las que el bloque <style> de plantillaNewsletter
// sobreescribe con prefers-color-scheme para los clientes que sí lo
// soportan (Apple Mail, iOS/macOS Mail, Gmail en la mayoría de casos).
function tablaClasificacionEmail(tabla, limite = 10) {
  const visibles = tabla.slice(0, limite);
  const filas = visibles
    .map((f, i) => {
      const pos = i + 1;
      const dg = f.gf - f.gc;
      const destacada = pos <= 3;
      return `
        <tr>
          <td class="${destacada ? "eof-pos-top" : "eof-texto-suave"}" style="padding:7px 6px;font-size:12.5px;color:${destacada ? "#d1132e" : "#5a6270"};font-weight:${destacada ? "700" : "400"};border-bottom:1px solid #eef1f5;text-align:center;">${pos}</td>
          <td class="eof-texto" style="padding:7px 6px;font-size:12.5px;color:#0c1b2e;font-weight:${destacada ? "700" : "500"};border-bottom:1px solid #eef1f5;">${escapeHtmlEmail(f.equipo)}</td>
          <td class="eof-texto-suave" style="padding:7px 6px;font-size:12px;color:#5a6270;border-bottom:1px solid #eef1f5;text-align:center;">${f.pj}</td>
          <td class="eof-texto-suave" style="padding:7px 6px;font-size:12px;color:#5a6270;border-bottom:1px solid #eef1f5;text-align:center;">${dg > 0 ? "+" + dg : dg}</td>
          <td class="eof-texto" style="padding:7px 6px;font-size:13px;color:#0c1b2e;font-weight:700;border-bottom:1px solid #eef1f5;text-align:center;">${f.pts}</td>
        </tr>`;
    })
    .join("");

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">
      <thead>
        <tr>
          <th class="eof-etiqueta" style="padding:0 6px 6px;font-size:10px;color:#9aa0ab;text-transform:uppercase;letter-spacing:.4px;text-align:center;">#</th>
          <th class="eof-etiqueta" style="padding:0 6px 6px;font-size:10px;color:#9aa0ab;text-transform:uppercase;letter-spacing:.4px;text-align:left;">Equipo</th>
          <th class="eof-etiqueta" style="padding:0 6px 6px;font-size:10px;color:#9aa0ab;text-transform:uppercase;letter-spacing:.4px;text-align:center;">PJ</th>
          <th class="eof-etiqueta" style="padding:0 6px 6px;font-size:10px;color:#9aa0ab;text-transform:uppercase;letter-spacing:.4px;text-align:center;">DG</th>
          <th class="eof-etiqueta" style="padding:0 6px 6px;font-size:10px;color:#9aa0ab;text-transform:uppercase;letter-spacing:.4px;text-align:center;">Pts</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>
    ${tabla.length > limite ? `<p class="eof-etiqueta" style="margin:8px 2px 0;font-size:11px;color:#9aa0ab;">+ ${tabla.length - limite} equipos más · clasificación completa en la web</p>` : ""}`;
}

// Bloque de una sección de clasificación completa (competición, con una
// sub-tarjeta por grupo si los tiene) dentro del boletín.
function seccionClasificacionEmail(competicion, grupos) {
  if (!grupos.length) return "";
  const bloquesGrupo = grupos
    .map(({ grupo, tabla }) => `
      <div class="eof-bloque-alt" style="background:#f7f8fa;border-radius:10px;padding:14px 14px 6px;margin-bottom:${grupo ? "12px" : "0"};">
        ${grupo ? `<p class="eof-texto" style="margin:0 0 8px;font-size:12.5px;font-weight:700;color:#0c1b2e;">${escapeHtmlEmail(grupo)}</p>` : ""}
        ${tablaClasificacionEmail(tabla)}
      </div>`)
    .join("");

  return `
    <tr>
      <td style="padding:6px 28px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
          <tr><td style="width:4px;background:#d1132e;border-radius:2px;">&nbsp;</td>
          <td style="padding-left:10px;">
            <h3 class="eof-texto" style="margin:0;font-size:15px;color:#0c1b2e;">${escapeHtmlEmail(competicionLabelEmail(competicion))}</h3>
          </td></tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 28px 26px;">
        ${bloquesGrupo}
      </td>
    </tr>`;
}

// Tarjeta compacta de un resultado destacado (marcador ya finalizado).
function resultadoDestacadoEmail(r) {
  return `
    <tr>
      <td style="padding:0 0 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="eof-bloque-alt" style="background:#f7f8fa;border-radius:8px;">
          <tr>
            <td style="padding:11px 14px;">
              <span class="eof-etiqueta" style="display:block;font-size:9.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#9aa0ab;margin-bottom:5px;">${escapeHtmlEmail(competicionLabelEmail(r.competicion))}${r.grupo ? " · " + escapeHtmlEmail(r.grupo) : ""}</span>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td class="eof-texto" style="font-size:13.5px;color:#0c1b2e;font-weight:600;text-align:left;">${escapeHtmlEmail(r.equipo_local)}</td>
                  <td style="font-size:15px;color:#d1132e;font-weight:800;text-align:center;white-space:nowrap;padding:0 8px;">${r.goles_local} – ${r.goles_visitante}</td>
                  <td class="eof-texto" style="font-size:13.5px;color:#0c1b2e;font-weight:600;text-align:right;">${escapeHtmlEmail(r.equipo_visitante)}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

// Tarjeta de invitación a votar una encuesta: nunca se puede votar desde
// el propio correo (los clientes de email no admiten esa interactividad
// de forma fiable ni segura), así que el botón siempre lleva a la web,
// donde ya se exige sesión de lector verificada para registrar el voto.
function encuestaEmail(p) {
  return `
    <tr>
      <td style="padding:0 0 10px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="eof-bloque-encuesta" style="background:#fff7f2;border:1px solid #f7d9d9;border-radius:8px;">
          <tr>
            <td style="padding:14px 16px;">
              <p class="eof-texto" style="margin:0 0 10px;font-size:13.5px;line-height:1.4;color:#0c1b2e;font-weight:600;">🗳️ ${escapeHtmlEmail(p.pregunta)}</p>
              <a href="${SITIO_URL}/index.html#encuestas" style="display:inline-block;padding:8px 16px;border-radius:20px;background:#d1132e;color:#ffffff;text-decoration:none;font-size:11.5px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;">Votar en la web</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

// Plantilla propia del boletín (distinta de plantillaEmail: aquí hace
// falta listar varias noticias con foto y varios bloques de datos —
// clasificaciones, resultados y encuestas —, no una única tarjeta de
// aviso).
//
// ---------- Modo oscuro ----------
// El Worker no puede saber si un suscriptor concreto tiene activado el
// modo oscuro EN LA WEB (esa elección vive en el localStorage de su
// navegador y nunca llega al servidor), así que el correo no puede
// replicar exactamente esa preferencia. Lo que sí es fiable y es el
// estándar en newsletters es adaptarse al modo oscuro/claro del CLIENTE
// DE CORREO (Apple Mail, iOS Mail, Outlook, Gmail...), que normalmente
// seguirá el modo del sistema operativo del destinatario: se declara
// soporte con <meta name="color-scheme"> y se sobreescriben los colores
// con una media query "prefers-color-scheme: dark" en un <style> del
// <head>, usando la misma paleta oscura que ya tiene la web (ver
// [data-theme="dark"] en public/css/style.css) para que el correo y el
// sitio se sientan coherentes. Los estilos inline se mantienen como
// fallback para clientes que ignoran <style>/media queries (Outlook de
// escritorio, versiones antiguas de Gmail): esos siempre verán el modo
// claro, que es un resultado seguro y legible en cualquier caso.
function plantillaNewsletter({ articulos, bajaUrl, clasificaciones = [], resultadosDestacados = [], encuestas = [] }) {
  const tarjetas = articulos
    .map((a) => {
      const url = urlNoticia(a.categoria, a.slug);
      const foto = a.imagen_url
        ? `<img src="${escapeHtmlEmail(a.imagen_url)}" alt="" width="504" style="display:block;width:100%;max-width:504px;border-radius:10px 10px 0 0;">`
        : "";
      return `
        <tr>
          <td style="padding:0 0 20px;">
            <a href="${url}" style="text-decoration:none;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="eof-tarjeta" style="background:#ffffff;border:1px solid #eef1f5;border-radius:10px;overflow:hidden;">
                ${foto ? `<tr><td>${foto}</td></tr>` : ""}
                <tr>
                  <td style="padding:14px 16px;">
                    <span class="eof-etiqueta-cat" style="display:inline-block;background:#eef1f5;color:#d1132e;font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;padding:3px 9px;border-radius:10px;margin-bottom:8px;">${escapeHtmlEmail(categoriaLabelEmail(a.categoria))}</span>
                    <h2 class="eof-texto" style="margin:0;font-size:16.5px;line-height:1.35;color:#0c1b2e;font-family:Georgia,serif;">${escapeHtmlEmail(a.titulo)}</h2>
                  </td>
                </tr>
              </table>
            </a>
          </td>
        </tr>`;
    })
    .join("");

  const seccionResultados = resultadosDestacados.length
    ? `
    <tr>
      <td style="padding:6px 28px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
          <tr><td style="width:4px;background:#d1132e;border-radius:2px;">&nbsp;</td>
          <td style="padding-left:10px;"><h3 class="eof-texto" style="margin:0;font-size:15px;color:#0c1b2e;">Resultados destacados</h3></td></tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 28px 26px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${resultadosDestacados.map(resultadoDestacadoEmail).join("")}</table>
      </td>
    </tr>`
    : "";

  const seccionesClasificacion = clasificaciones
    .map(({ competicion, grupos }) => seccionClasificacionEmail(competicion, grupos))
    .join("");

  const seccionEncuestas = encuestas.length
    ? `
    <tr>
      <td style="padding:6px 28px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
          <tr><td style="width:4px;background:#d1132e;border-radius:2px;">&nbsp;</td>
          <td style="padding-left:10px;"><h3 class="eof-texto" style="margin:0;font-size:15px;color:#0c1b2e;">Encuestas abiertas</h3></td></tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 28px 26px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${encuestas.map(encuestaEmail).join("")}</table>
      </td>
    </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  /* Fallback para clientes que sí soportan <style> pero no la media
     query (poco frecuente, pero por si acaso): se queda en claro. */
  .eof-fondo-pagina{background:#eef1f5;}
  .eof-tarjeta-principal{background:#ffffff;box-shadow:0 8px 28px rgba(12,27,46,.14);}

  @media (prefers-color-scheme: dark) {
    /* Misma paleta que [data-theme="dark"] en public/css/style.css,
       para que el correo se sienta como una extensión de la web. */
    body, .eof-fondo-pagina{background:#11161f !important;}
    .eof-tarjeta-principal{background:#1a2130 !important;box-shadow:0 8px 28px rgba(0,0,0,.45) !important;}
    .eof-tarjeta{background:#1a2130 !important;border-color:#2a3242 !important;}
    .eof-bloque-alt{background:#171d29 !important;}
    .eof-bloque-encuesta{background:#241a1c !important;border-color:#40262b !important;}
    .eof-texto, .eof-texto h1, .eof-texto h2, .eof-texto h3, .eof-texto p{color:#e7eaf0 !important;}
    h1.eof-texto, h2.eof-texto, h3.eof-texto{color:#e7eaf0 !important;}
    .eof-texto-suave{color:#9aa4b8 !important;}
    .eof-etiqueta{color:#9aa4b8 !important;}
    .eof-etiqueta-cat{background:#241a1c !important;}
    .eof-pos-top{color:#ff5b73 !important;}
    .eof-pie{background:#171d29 !important;border-top-color:#2a3242 !important;}
    .eof-pie p, .eof-pie a{color:#7e879b !important;}
    .eof-divisor{border-top-color:#2a3242 !important;}
    .eof-subrayado{color:#e7eaf0 !important;}
    /* El rojo, celeste y demás colores de marca se mantienen iguales en
       ambos modos (igual que en la web): no se tocan aquí. */
  }
</style>
</head>
<body class="eof-fondo-pagina" style="margin:0;padding:0;background:#eef1f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="eof-fondo-pagina" style="background:#eef1f5;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="eof-tarjeta-principal" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 28px rgba(12,27,46,.14);">

          <!-- Cabecera (se mantiene igual en los dos modos: es --marino,
               igual que la cabecera de la propia web) -->
          <tr>
            <td style="background:linear-gradient(135deg,#0c1b2e,#132840);padding:26px 28px;">
              <img src="${SITIO_URL}/img/logo.png" alt="ELOTROFÚTBOLTV" height="32" style="display:block;">
            </td>
          </tr>
          <tr><td style="height:4px;background:#d1132e;line-height:0;font-size:0;">&nbsp;</td></tr>

          <!-- Titular -->
          <tr>
            <td style="padding:30px 28px 8px;">
              <span class="eof-etiqueta-cat" style="display:inline-block;background:#fff0f0;color:#d1132e;font-size:10.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;padding:4px 11px;border-radius:12px;">Boletín semanal</span>
              <h1 class="eof-texto" style="margin:14px 0 6px;font-size:22px;line-height:1.3;color:#0c1b2e;font-family:Georgia,serif;">Tu resumen de la semana</h1>
              <p class="eof-texto-suave" style="margin:0;font-size:13.5px;color:#5a6270;">Noticias, resultados y clasificaciones de LaLiga Hypermotion, Primera y Segunda Federación.</p>
            </td>
          </tr>

          <!-- Noticias -->
          <tr>
            <td style="padding:20px 28px 4px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tarjetas}</table>
            </td>
          </tr>

          <tr><td style="padding:6px 28px;"><div class="eof-divisor" style="border-top:1px solid #eef1f5;">&nbsp;</div></td></tr>

          <!-- Resultados destacados -->
          ${seccionResultados}

          <tr><td style="padding:0 28px;"><div class="eof-divisor" style="border-top:1px solid #eef1f5;">&nbsp;</div></td></tr>

          <!-- Clasificaciones -->
          <tr>
            <td style="padding:20px 28px 2px;">
              <h2 class="eof-etiqueta" style="margin:0 0 2px;font-size:12px;color:#9aa0ab;text-transform:uppercase;letter-spacing:.6px;">Clasificaciones</h2>
            </td>
          </tr>
          ${seccionesClasificacion}

          <!-- Encuestas -->
          ${seccionEncuestas}

          <!-- CTA (el botón rojo se mantiene igual en los dos modos) -->
          <tr>
            <td style="padding:4px 28px 34px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:24px;background:#d1132e;">
                    <a href="${SITIO_URL}" style="display:inline-block;padding:13px 28px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#ffffff;text-decoration:none;">Ver más en ELOTROFÚTBOLTV</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Pie -->
          <tr>
            <td class="eof-pie" style="padding:18px 28px;background:#f7f8fa;border-top:1px solid #eee;">
              <p style="margin:0 0 6px;font-size:11.5px;color:#9aa0ab;">Recibes este correo porque te suscribiste al boletín de ELOTROFÚTBOLTV.</p>
              <p style="margin:0;font-size:11.5px;color:#9aa0ab;"><a href="${bajaUrl}" style="color:#9aa0ab;">Darme de baja</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------- Clasificación para el boletín ----------
// Mismo cálculo que hace el frontend en clasificacion.html (3 puntos por
// victoria, 1 por empate, solo partidos "finalizado"; aquí no hace falta
// contar los "en_juego" como provisionales porque el boletín es semanal,
// no en vivo), reimplementado en el worker para poder incrustarlo como
// tabla HTML dentro del email.
function calcularClasificacionBoletin(partidos) {
  const tabla = {};
  function fila(equipo) {
    if (!tabla[equipo]) {
      tabla[equipo] = { equipo, pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, pts: 0 };
    }
    return tabla[equipo];
  }
  partidos.forEach((p) => {
    if (p.estado !== "finalizado") return;
    if (p.goles_local === null || p.goles_local === undefined || p.goles_visitante === null || p.goles_visitante === undefined) return;
    const local = fila(p.equipo_local);
    const visitante = fila(p.equipo_visitante);
    local.pj++; visitante.pj++;
    local.gf += p.goles_local; local.gc += p.goles_visitante;
    visitante.gf += p.goles_visitante; visitante.gc += p.goles_local;
    if (p.goles_local > p.goles_visitante) {
      local.pg++; local.pts += 3; visitante.pp++;
    } else if (p.goles_local < p.goles_visitante) {
      visitante.pg++; visitante.pts += 3; local.pp++;
    } else {
      local.pe++; visitante.pe++; local.pts++; visitante.pts++;
    }
  });
  return Object.values(tabla).sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    const dgA = a.gf - a.gc, dgB = b.gf - b.gc;
    if (dgB !== dgA) return dgB - dgA;
    if (b.gf !== a.gf) return b.gf - a.gf;
    return a.equipo.localeCompare(b.equipo, "es");
  });
}

// Recupera, para una competición dada, la clasificación de cada grupo (o
// una única clasificación si la competición no tiene grupos, como
// LaLiga Hypermotion). Devuelve un array de { grupo, tabla } — "grupo"
// es null cuando la competición es de grupo único.
async function obtenerClasificacionesPorGrupo(env, competicion) {
  const { results: partidos } = await env.DB.prepare(
    "SELECT grupo, equipo_local, equipo_visitante, goles_local, goles_visitante, estado FROM results WHERE competicion = ?"
  ).bind(competicion).all();

  const gruposPresentes = [...new Set(partidos.map((p) => p.grupo).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "es")
  );

  if (!gruposPresentes.length) {
    const tabla = calcularClasificacionBoletin(partidos);
    return tabla.length ? [{ grupo: null, tabla }] : [];
  }

  return gruposPresentes
    .map((grupo) => ({
      grupo,
      tabla: calcularClasificacionBoletin(partidos.filter((p) => p.grupo === grupo)),
    }))
    .filter((g) => g.tabla.length);
}

// Un puñado de resultados destacados de la última semana para el
// boletín: los últimos partidos finalizados (con marcador), más
// recientes primero, de las tres competiciones que sigue el sitio.
async function obtenerResultadosDestacadosBoletin(env, desde) {
  const { results } = await env.DB.prepare(
    `SELECT competicion, grupo, equipo_local, equipo_visitante, goles_local, goles_visitante, fecha_partido
     FROM results
     WHERE estado = 'finalizado' AND fecha_partido >= ?
       AND goles_local IS NOT NULL AND goles_visitante IS NOT NULL
     ORDER BY fecha_partido DESC LIMIT 6`
  ).bind(desde).all();
  return results;
}

// Encuestas actualmente abiertas y visibles en portada, para invitar a
// votar desde el boletín (el voto en sí exige entrar en la web con
// sesión de lector verificada, así que aquí solo se enlaza, nunca se
// permite votar desde el propio correo).
async function obtenerEncuestasAbiertasBoletin(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, pregunta FROM polls WHERE estado = 'abierta' AND en_portada = 1
     ORDER BY orden_portada ASC, id DESC LIMIT 3`
  ).all();
  return results;
}

function categoriaLabelEmail(cat) {
  const CATEGORIAS = {
    hypermotion: "LaLiga Hypermotion",
    primera_federacion: "Primera Federación",
    segunda_federacion: "Segunda Federación",
    general: "General",
    amistoso: "Amistoso",
    arbitraje: "Arbitraje",
    jurisdiccion: "Jurisdicción deportiva",
  };
  return CATEGORIAS[cat] || cat || "";
}

// Convierte el valor interno de "categoria" (algunos con guion bajo, como
// "primera_federacion") en el segmento de URL bonita (con guion normal,
// "primera-federacion"), para que /futbol/[categoria]/slug quede siempre
// con guiones y no mezcle formatos. Si llega una categoría vacía o
// desconocida, cae a "general" para no generar una URL con un segmento
// vacío o con guion bajo suelto.
function categoriaUrlSlug(cat) {
  const normalizada = (cat || "").toString().trim().toLowerCase().replace(/_/g, "-");
  return normalizada || "general";
}

// Construye la URL "bonita" (/futbol/categoria/slug) de una noticia a
// partir de su categoría y slug. Único punto donde se arma este formato
// en el worker, para que un cambio futuro de estructura de URLs no
// obligue a tocar cada sitio donde se enlaza a una noticia.
function urlNoticia(categoria, slug) {
  return `${SITIO_URL}/futbol/${categoriaUrlSlug(categoria)}/${encodeURIComponent(slug)}`;
}

// Envía el boletín a todos los suscriptores activos vía Resend, en
// lotes (la API de Resend admite varios destinatarios por llamada, pero
// se agrupan en lotes moderados para no depender de un límite exacto
// que pueda cambiar). Un fallo enviando un lote no interrumpe el resto.
async function enviarBoletinALista(env, { destinatarios, articulos, clasificaciones = [], resultadosDestacados = [], encuestas = [] }) {
  if (!env.RESEND_API_KEY) {
    console.log("RESEND_API_KEY no configurado: boletín semanal omitido");
    return;
  }
  const TAMANO_LOTE = 45; // límite prudente por debajo del máximo habitual de Resend por llamada
  for (let i = 0; i < destinatarios.length; i += TAMANO_LOTE) {
    const lote = destinatarios.slice(i, i + TAMANO_LOTE);
    // El enlace de baja es individual por suscriptor, así que el HTML
    // también tiene que serlo: se manda una llamada por persona dentro
    // del lote en paralelo (Resend no permite variar el cuerpo entre
    // destinatarios de una misma llamada).
    await Promise.all(
      lote.map(async (s) => {
        const bajaUrl = `${API_URL}/api/newsletter/baja?token=${encodeURIComponent(s.baja_token)}`;
        try {
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: env.RESEND_FROM || "ELOTROFÚTBOLTV <notificaciones@elotrofutbol.media>",
              to: [s.email],
              subject: "Tu resumen semanal de ELOTROFÚTBOLTV",
              html: plantillaNewsletter({ articulos, bajaUrl, clasificaciones, resultadosDestacados, encuestas }),
            }),
          });
          if (!resp.ok) {
            console.log("Error enviando boletín a", s.email, resp.status, await resp.text());
          }
        } catch (err) {
          console.log("Error enviando boletín a", s.email, err.message);
        }
      })
    );
  }
}

// Comprueba si toca enviar el boletín semanal (han pasado 7 días o más
// desde el último envío registrado, o nunca se envió) y, si toca, lo
// manda con las noticias publicadas desde entonces. Llamado desde
// "scheduled" en cada ejecución del cron junto con las demás tareas
// programadas; como el cron ya corre cada minuto para otras cosas, aquí
// solo se decide si ESTA ejecución concreta debe disparar el envío.
async function enviarBoletinSemanalSiToca(env) {
  try {
    const fila = await env.DB.prepare(
      "SELECT ultimo_envio_at FROM newsletter_envios WHERE id = 1"
    ).first();
    const ultimo = fila && fila.ultimo_envio_at ? new Date(fila.ultimo_envio_at + "Z") : null;
    const ahora = new Date();
    const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
    if (ultimo && ahora - ultimo < SIETE_DIAS_MS) return; // aún no toca

    const { results: destinatarios } = await env.DB.prepare(
      "SELECT email, baja_token FROM newsletter_suscriptores WHERE activo = 1"
    ).all();
    if (!destinatarios.length) {
      // No hay a quién mandarlo, pero se registra igualmente el intento
      // para no comprobarlo en cada minuto durante toda la semana.
      await env.DB.prepare(
        "UPDATE newsletter_envios SET ultimo_envio_at = datetime('now') WHERE id = 1"
      ).run();
      return;
    }

    const desde = (ultimo || new Date(ahora - SIETE_DIAS_MS)).toISOString().replace("T", " ").slice(0, 19);
    const { results: articulos } = await env.DB.prepare(
      `SELECT slug, titulo, categoria, imagen_url FROM articles
       WHERE publicado = 1 AND fecha_publicacion >= ?
       ORDER BY fecha_publicacion DESC LIMIT 8`
    ).bind(desde).all();

    if (!articulos.length) {
      // Nada nuevo que contar esta semana: se registra el envío igual
      // (para que no se acumulen semanas) pero no se manda correo vacío.
      await env.DB.prepare(
        "UPDATE newsletter_envios SET ultimo_envio_at = datetime('now') WHERE id = 1"
      ).run();
      return;
    }

    // Clasificación completa (por grupo cuando aplica) de las tres
    // competiciones que sigue el sitio, resultados destacados de la
    // semana y encuestas abiertas en portada, todo para incrustar en el
    // boletín junto con las noticias.
    const COMPETICIONES_BOLETIN = ["hypermotion", "primera_federacion", "segunda_federacion"];
    const clasificaciones = [];
    for (const competicion of COMPETICIONES_BOLETIN) {
      const grupos = await obtenerClasificacionesPorGrupo(env, competicion);
      if (grupos.length) clasificaciones.push({ competicion, grupos });
    }
    const resultadosDestacados = await obtenerResultadosDestacadosBoletin(env, desde);
    const encuestas = await obtenerEncuestasAbiertasBoletin(env);

    await enviarBoletinALista(env, { destinatarios, articulos, clasificaciones, resultadosDestacados, encuestas });
    await env.DB.prepare(
      "UPDATE newsletter_envios SET ultimo_envio_at = datetime('now') WHERE id = 1"
    ).run();
  } catch (err) {
    console.log("Error en el envío semanal del boletín:", err.message);
  }
}

async function enviarEmailNotificacion(env, { asunto, texto, html }, { destinatario } = {}) {
  if (!env.RESEND_API_KEY) {
    console.log("RESEND_API_KEY no configurado: aviso por email omitido ->", asunto);
    return;
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM || "ELOTROFÚTBOLTV <notificaciones@elotrofutbol.media>",
        to: [destinatario || EMAIL_NOTIFICACIONES],
        subject: asunto,
        text: texto,
        html: html || undefined,
      }),
    });
    if (!resp.ok) {
      console.log("Error al enviar email de notificación:", resp.status, await resp.text());
    }
  } catch (err) {
    console.log("Error al enviar email de notificación:", err.message);
  }
}
// ---------- Equipos de un usuario (hasta 3 clubes) ----------
// Se guardan en la columna "equipo" como un array JSON en texto, p. ej.
// '["Real Madrid","FC Barcelona"]'. Antes era un unico club en texto
// plano; parsearEquipos() sigue aceptando ese formato antiguo (lo
// convierte en un array de un elemento) para no romper datos ya
// guardados. Un admin puede asignar hasta 3 equipos a cada persona
// desde "Usuarios"; la propia persona solo puede consultarlos, nunca
// editarlos, desde "Mis datos".
function parsearEquipos(valor) {
  if (!valor) return [];
  try {
    const parsed = JSON.parse(valor);
    if (Array.isArray(parsed)) return parsed.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim());
  } catch {
    if (typeof valor === "string" && valor.trim()) return [valor.trim()];
  }
  return [];
}
// Valida y normaliza la lista de equipos recibida del panel: hasta 3
// equipos (0, 1, 2 o 3 son validos), sin duplicados ni vacios. Devuelve
// { error } si no cumple, o { equipos } con el array ya limpio.
function validarEquipos(valorRecibido) {
  let lista = [];
  if (Array.isArray(valorRecibido)) {
    lista = valorRecibido;
  } else if (typeof valorRecibido === "string" && valorRecibido.trim()) {
    lista = [valorRecibido];
  }
  const limpios = [...new Set(lista.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim()))];
  if (limpios.length > 3) return { error: "Puedes seleccionar como maximo 3 equipos." };
  return { equipos: limpios };
}

// ---------- Club(es) de un artículo (previas/crónicas con 2 clubes) ----
// Igual patrón que parsearEquipos()/validarEquipos() (equipo de un
// usuario): la columna "club" de articles sigue siendo TEXT, pero puede
// contener o bien un único nombre de club en texto plano (caso normal:
// noticia/análisis/opinión/entrevista, o previa/crónica antes de este
// cambio), o un array JSON de exactamente 2 clubes en texto (p. ej.
// '["Real Madrid","FC Barcelona"]'), usado cuando una previa o crónica
// se vincula a un resultado y por tanto habla de ambos equipos del
// partido. parsearClubArticulo() distingue ambos casos para quien
// necesite leer con qué club(es) se relaciona un artículo.
function parsearClubArticulo(valor) {
  if (!valor) return [];
  try {
    const parsed = JSON.parse(valor);
    if (Array.isArray(parsed)) return parsed.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim());
  } catch {
    // No es JSON: es el caso normal de club único en texto plano.
  }
  if (typeof valor === "string" && valor.trim()) return [valor.trim()];
  return [];
}
// Versión legible de "club" para mostrar en emails/notificaciones: un
// club único se muestra tal cual, y los 2 clubes de una previa/crónica
// vinculada se muestran unidos por " - " (p. ej. "Real Madrid - FC
// Barcelona"), en vez del texto crudo del array JSON.
function clubArticuloLegible(valorClub) {
  const clubes = parsearClubArticulo(valorClub);
  return clubes.join(" - ");
}
// Construye el valor a guardar en la columna "club" a partir de los dos
// equipos de un resultado vinculado (previa/crónica). Siempre devuelve
// el array JSON de 2 clubes, incluso si por algún motivo vinieran
// iguales o vacíos (se filtran los vacíos antes de guardar).
function clubArticuloDesdeResultado(equipoLocal, equipoVisitante) {
  const clubes = [equipoLocal, equipoVisitante]
    .filter((c) => typeof c === "string" && c.trim())
    .map((c) => c.trim());
  return clubes.length ? JSON.stringify(clubes) : null;
}
// Resuelve el valor final a guardar en "club" para un artículo, según su
// tipo. Para "previa" y "cronica" el club ya no lo elige el redactor a
// mano en el panel (ver Fase 2): se deriva siempre de los dos equipos
// del resultado vinculado, así que hace falta un resultado_id válido y
// con ambos equipos. Para el resto de tipos (noticia, análisis, opinión,
// entrevista) el comportamiento no cambia: se guarda tal cual el club
// que venga en el body (un único nombre, o vacío/null para "General").
// Devuelve { error } si es previa/crónica sin resultado vinculado, o
// { club } con el valor final (string simple, o el array JSON de 2
// clubes) listo para el INSERT/UPDATE.
async function resolverClubArticulo(env, tipo, resultadoId, clubBody) {
  if (tipo !== "previa" && tipo !== "cronica") {
    return { club: clubBody || null };
  }
  if (!resultadoId) {
    return { error: "Una previa o crónica debe tener un resultado vinculado para poder guardarse (el club se toma automáticamente de los dos equipos del partido)." };
  }
  const resultado = await env.DB.prepare("SELECT equipo_local, equipo_visitante FROM results WHERE id = ?")
    .bind(resultadoId).first();
  if (!resultado) {
    return { error: "El resultado vinculado ya no existe. Elige de nuevo el partido." };
  }
  const club = clubArticuloDesdeResultado(resultado.equipo_local, resultado.equipo_visitante);
  if (!club) {
    return { error: "El resultado vinculado no tiene los dos equipos definidos." };
  }
  return { club };
}

// ---------- "Última hora": PIN de 4 dígitos único y compartido ----------
// Permite a cualquier redactor publicar directamente (sin pasar por
// borrador) una noticia/crónica/opinión/entrevista puntual y urgente.
// No es un PIN por persona: es un único PIN aleatorio, guardado en la
// tabla settings, que solo puede ver un admin desde el panel. Cada vez
// que se usa correctamente para publicar, se regenera automáticamente,
// así que un PIN que se ha filtrado o compartido de más solo sirve
// para esa publicación.
function validarPin4Digitos(pin) {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}
function generarPin4Digitos() {
  const arr = new Uint8Array(1);
  crypto.getRandomValues(arr);
  // 0000-9999, con el 0 a la izquierda si hace falta.
  const n = Math.floor((arr[0] / 256) * 10000);
  return String(n).padStart(4, "0");
}
async function obtenerUltimaHoraPin(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ultima_hora_pin'").first();
  return row ? row.value : null;
}
async function regenerarUltimaHoraPin(env) {
  const nuevo = generarPin4Digitos();
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('ultima_hora_pin', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(nuevo).run();
  return nuevo;
}
async function comprobarUltimaHora(env, pinRecibido) {
  if (!validarPin4Digitos(pinRecibido)) return false;
  const actual = await obtenerUltimaHoraPin(env);
  if (!actual || pinRecibido !== actual) return false;
  // Correcto: se regenera de inmediato para que no se pueda reutilizar.
  await regenerarUltimaHoraPin(env);
  return true;
}

// ---------- Banner flotante de "última hora" (distinto del PIN de arriba) ----------
// Ver el comentario gemelo en worker/src/index.js: esto es la marca
// visual (banner rojo fijo en toda la web), no el PIN de publicación
// directa. Nombre de columna distinto (banner_urgente) para no
// confundir los dos conceptos.
//
// En minutos (no horas): sql-compat.js traduce SQLite -> Postgres para
// las consultas que llegan aquí por failover, y solo tiene patrón de
// traducción ya hecho para "+N minutes" / "+N days" en
// datetime('now', ...), no para "hours".
const BANNER_URGENTE_DURACION_MINUTOS = 120; // 2 horas
function calcularBannerUrgenteHasta(activar) {
  return activar ? `datetime('now', '+${BANNER_URGENTE_DURACION_MINUTOS} minutes')` : "NULL";
}

// ---------- Publicación directa según el nivel del colaborador ----------
// A partir del sistema de niveles, un redactor de Nivel 2 o superior ya
// no necesita el PIN de "Última hora" para publicar directamente: la
// confianza de poder publicar sin revisión se la da su nivel. Un
// redactor de Nivel 1 (o sin nivel, por compatibilidad con datos
// antiguos) sigue exactamente igual que antes: todo pasa por revisión
// salvo que use el PIN de "Última hora" para ese caso puntual. Se
// consulta el nivel siempre en la base de datos (no se guarda en el
// JWT) para que un ascenso o descenso de nivel tenga efecto inmediato,
// sin esperar a que la persona vuelva a iniciar sesión.
async function obtenerNivelUsuario(env, uid) {
  const user = await env.DB.prepare("SELECT nivel, rol FROM users WHERE id = ?").bind(uid).first();
  if (user && user.rol === "admin") return NIVEL_MAXIMO;
  return (user && user.nivel) || 1;
}

function generatePassword(length = 10) {
  // Excluye caracteres fácilmente confundibles (0/O, 1/l/I) al mostrarla
  // en pantalla para dársela a la persona.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => chars[b % chars.length]).join("");
}

// ---------- JWT (HS256) ----------
function b64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJSON(obj) {
  return b64url(JSON.stringify(obj));
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}
// Igual que b64urlDecode, pero para trozos que contienen texto (JSON de
// un JWT): atob() trata la salida como bytes "binarios" de 1 carácter
// cada uno, así que un nombre con letras como "à" (2 bytes en UTF-8) se
// corrompe si se usa tal cual. Aquí se reinterpretan esos bytes como
// UTF-8 antes de devolver la cadena, para que JSON.parse() reciba texto
// correcto (p. ej. el "name" de Google en verificarGoogleIdToken).
function b64urlDecodeTexto(str) {
  const binario = b64urlDecode(str);
  const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}
async function signHS256(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

// ---------- Firma RS256 + Search Console ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa de todo este bloque (JWT Bearer de cuenta de servicio de
// Google, RFC 7523). Duplicado aquí para que el panel de analíticas
// también funcione si el failover pone a este worker (Railway) a
// atender las lecturas (ver apiFetch()/circuit breaker en
// public/js/config.js).
async function signRS256(data, clavePrivadaPem) {
  const pem = clavePrivadaPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

async function obtenerTokenGoogleServiceAccount(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.GSC_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const clavePrivada = env.GSC_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
  const sinFirmar = `${b64urlJSON(header)}.${b64urlJSON(claim)}`;
  const jwt = `${sinFirmar}.${await signRS256(sinFirmar, clavePrivada)}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.access_token) {
    throw new Error((data && (data.error_description || data.error)) || `Google devolvió ${resp.status} al pedir el token`);
  }
  return data.access_token;
}

async function calcularGscAnaliticas(env, dias) {
  if (!env.GSC_SERVICE_ACCOUNT_EMAIL || !env.GSC_SERVICE_ACCOUNT_KEY || !env.GSC_SITE_URL) {
    return { conectado: false };
  }

  try {
    const accessToken = await obtenerTokenGoogleServiceAccount(env);

    const hoy = new Date();
    const fin = new Date(hoy);
    fin.setDate(fin.getDate() - 2);
    const inicio = new Date(fin);
    inicio.setDate(inicio.getDate() - dias);
    const aFecha = (d) => d.toISOString().slice(0, 10);

    const pedirGsc = async (dimensions, rowLimit) => {
      const resp = await fetch(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(env.GSC_SITE_URL)}/searchAnalytics/query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            startDate: aFecha(inicio),
            endDate: aFecha(fin),
            dimensions,
            rowLimit,
          }),
        }
      );
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        throw new Error((data && data.error && data.error.message) || `Google devolvió ${resp.status}`);
      }
      return data.rows || [];
    };

    const [filasDiarias, filasConsultas] = await Promise.all([
      pedirGsc(["date"], 1000),
      pedirGsc(["query"], 15),
    ]);

    const totalClics = filasDiarias.reduce((s, f) => s + (f.clicks || 0), 0);
    const totalImpresiones = filasDiarias.reduce((s, f) => s + (f.impressions || 0), 0);
    const posicionPonderada = filasDiarias.reduce((s, f) => s + (f.position || 0) * (f.impressions || 0), 0);

    return {
      conectado: true,
      totales: {
        clics: totalClics,
        impresiones: totalImpresiones,
        ctr: totalImpresiones ? Math.round((totalClics / totalImpresiones) * 1000) / 10 : 0,
        posicion: totalImpresiones ? Math.round((posicionPonderada / totalImpresiones) * 10) / 10 : 0,
      },
      serie: filasDiarias.map((f) => ({
        fecha: f.keys[0],
        clics: f.clicks || 0,
        impresiones: f.impressions || 0,
      })),
      consultas: filasConsultas.map((f) => ({
        consulta: f.keys[0],
        clics: f.clicks || 0,
        impresiones: f.impressions || 0,
        ctr: Math.round((f.ctr || 0) * 1000) / 10,
        posicion: Math.round((f.position || 0) * 10) / 10,
      })),
    };
  } catch (err) {
    console.error("[analiticas/gsc] fallo consultando Search Console:", err);
    return { conectado: true, error: err.message || "Error desconocido consultando Search Console" };
  }
}

async function createJWT(payload, secret, expiresInSec = 60 * 60 * 12) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSec };
  const data = `${b64urlJSON(header)}.${b64urlJSON(fullPayload)}`;
  const sig = await signHS256(data, secret);
  return `${data}.${sig}`;
}
async function verifyJWT(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = await signHS256(`${h}.${p}`, secret);
  if (expected !== s) return null;
  const payload = JSON.parse(b64urlDecodeTexto(p));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}
// Ver el porqué completo en requireAuth: cubre el hueco entre que se crea
// una sesión en D1 y que llega replicada a esta tabla "sessions" (este
// Worker es el secundario/Railway; D1 sigue siendo la autoridad -- ver
// sync/tables.mjs), sin el cual el failover automático PRIMARY->SECONDARY
// podía devolver 403 en peticiones perfectamente legítimas justo tras un
// login. 5 minutos = varias pasadas del scheduler de sync (~60s por
// defecto) de margen, sin dejar la ventana abierta indefinidamente para
// una sesión revocada de verdad.
const TOLERANCIA_SESION_NO_REPLICADA_SEGUNDOS = 5 * 60;

async function requireAuth(request, env, url) {
  const auth = request.headers.get("Authorization") || "";
  let token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  // La descarga se abre como enlace normal del navegador (no un fetch),
  // así que no puede llevar cabecera Authorization; en ese caso concreto
  // se acepta también el token como parámetro ?token= de la URL.
  if (!token && url) token = url.searchParams.get("token");
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;
  // Además de que el JWT en sí sea válido, la sesión (fila en la tabla
  // "sessions") tiene que seguir existiendo y no estar revocada: así,
  // cerrar una sesión desde "Mis sesiones" la invalida al momento aunque
  // el JWT todavía no haya caducado. Los JWT antiguos (emitidos antes de
  // este cambio) no llevan "sid"; se siguen aceptando hasta que caduquen
  // por sí solos, para no desconectar a todo el mundo de golpe.
  if (payload.sid) {
    const sesion = await env.DB.prepare(
      "SELECT id, last_seen_at FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
    ).bind(payload.sid, payload.uid).first();
    if (!sesion) {
      // Ver requireAuth en worker/src/index.js (D1) para la explicación
      // completa de esta tolerancia.
      const emitidoHaceSegundos = payload.iat ? Math.floor(Date.now() / 1000) - payload.iat : Infinity;
      if (emitidoHaceSegundos > TOLERANCIA_SESION_NO_REPLICADA_SEGUNDOS) return null;
    } else {
      // No bloqueamos la respuesta por esto: es solo para que la lista de
      // "Mis sesiones" muestre cuándo se ha usado cada una por última vez.
      // Throttle a 5 minutos: sin esto, cada request autenticado (que puede
      // ser decenas por minuto en uso normal del panel) dispara un UPDATE,
      // multiplicando innecesariamente las escrituras en D1 solo para un
      // dato que no necesita esa precisión.
      const yaReciente = sesion.last_seen_at &&
        (Date.now() - new Date(sesion.last_seen_at.replace(" ", "T") + "Z").getTime()) < 5 * 60 * 1000;
      if (!yaReciente) {
        env.DB.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?")
          .bind(payload.sid).run().catch(() => {});
      }
    }
  }
  return payload;
}

// ---------- Sesiones (dispositivos con la sesión iniciada) ----------
function generarIdSesion() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Convierte la cabecera User-Agent en una descripción legible tipo
// "Chrome en Windows" o "Safari en iPhone", para que cada persona
// reconozca de un vistazo qué dispositivo es cada sesión. Es una
// heurística sencilla (no una librería de detección completa), pero
// cubre bien los casos habituales.
function describirDispositivo(userAgent) {
  const ua = userAgent || "";
  let so = "Dispositivo desconocido";
  if (/iPhone/i.test(ua)) so = "iPhone";
  else if (/iPad/i.test(ua)) so = "iPad";
  else if (/Android/i.test(ua)) so = "Android";
  else if (/Macintosh|Mac OS X/i.test(ua)) so = "Mac";
  else if (/Windows/i.test(ua)) so = "Windows";
  else if (/Linux/i.test(ua)) so = "Linux";

  let navegador = "Navegador desconocido";
  if (/Edg\//i.test(ua)) navegador = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) navegador = "Opera";
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) navegador = "Chrome";
  else if (/CriOS/i.test(ua)) navegador = "Chrome";
  else if (/FxiOS/i.test(ua)) navegador = "Firefox";
  else if (/Firefox\//i.test(ua)) navegador = "Firefox";
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) navegador = "Safari";

  return `${navegador} en ${so}`;
}

// Crea la fila de sesión en la BD y el JWT correspondiente (con el "sid"
// incrustado), en un único paso: se usa tanto al iniciar sesión como en
// cualquier sitio que hasta ahora emitía un token nuevo (cambio de
// nombre, etc.), para que esos casos también queden como sesiones
// listables y cerrables.
//
// "Mismo dispositivo" se aproxima por user_id + user_agent: si ya hay una
// sesión sin revocar de ese usuario con ese mismo User-Agent, se reutiliza
// esa misma fila (se actualiza IP y last_seen_at y se le asigna un JWT
// nuevo) en vez de insertar otra. Así, cerrar sesión y volver a entrar
// desde el mismo navegador no duplica la entrada en "Mis sesiones": solo
// hay una fila por dispositivo, no una por cada inicio de sesión.
async function crearSesion(env, request, user) {
  const userAgent = request.headers.get("User-Agent") || null;
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || null;

  const existente = await env.DB.prepare(
    `SELECT id FROM sessions WHERE user_id = ? AND user_agent IS ? AND revoked_at IS NULL
     ORDER BY last_seen_at DESC LIMIT 1`
  ).bind(user.id, userAgent).first();

  let id;
  if (existente) {
    id = existente.id;
    await env.DB.prepare(
      `UPDATE sessions SET ip = ?, last_seen_at = datetime('now') WHERE id = ?`
    ).bind(ip, id).run();
  } else {
    id = generarIdSesion();
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, user_agent, ip) VALUES (?, ?, ?, ?)`
    ).bind(id, user.id, userAgent, ip).run();
  }

  const token = await createJWT(
    { uid: user.id, username: user.username, nombre: user.nombre, rol: user.rol, sid: id },
    env.JWT_SECRET
  );
  return token;
}

// ---------- Sesiones de lectores (cuentas públicas, ver readers/reader_sessions) ----------
// Mismo patrón que requireAuth/crearSesion de arriba, pero con su propio
// payload de JWT (lleva "rid" en vez de "uid") para que un token de
// lector nunca pueda confundirse con uno de redactor/admin ni colarse
// en una ruta protegida del panel.
async function requireReaderAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload || !payload.rid) return null;
  if (payload.sid) {
    const sesion = await env.DB.prepare(
      "SELECT id, last_seen_at FROM reader_sessions WHERE id = ? AND reader_id = ? AND revoked_at IS NULL"
    ).bind(payload.sid, payload.rid).first();
    if (!sesion) return null;
    // Mismo throttle de 5 minutos que requireAuth, por el mismo motivo.
    const yaReciente = sesion.last_seen_at &&
      (Date.now() - new Date(sesion.last_seen_at.replace(" ", "T") + "Z").getTime()) < 5 * 60 * 1000;
    if (!yaReciente) {
      env.DB.prepare("UPDATE reader_sessions SET last_seen_at = datetime('now') WHERE id = ?")
        .bind(payload.sid).run().catch(() => {});
    }
  }
  return payload;
}

async function crearSesionLector(env, request, reader) {
  const userAgent = request.headers.get("User-Agent") || null;
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || null;

  const existente = await env.DB.prepare(
    `SELECT id FROM reader_sessions WHERE reader_id = ? AND user_agent IS ? AND revoked_at IS NULL
     ORDER BY last_seen_at DESC LIMIT 1`
  ).bind(reader.id, userAgent).first();

  let id;
  if (existente) {
    id = existente.id;
    await env.DB.prepare(
      `UPDATE reader_sessions SET ip = ?, last_seen_at = datetime('now') WHERE id = ?`
    ).bind(ip, id).run();
  } else {
    id = generarIdSesion();
    await env.DB.prepare(
      `INSERT INTO reader_sessions (id, reader_id, user_agent, ip) VALUES (?, ?, ?, ?)`
    ).bind(id, reader.id, userAgent, ip).run();
  }

  return createJWT(
    { rid: reader.id, nombre: reader.nombre, email: reader.email, sid: id },
    env.JWT_SECRET
  );
}

// ---------- Verificación del id_token de Google (login de lectores) ----------
// Ver el comentario largo en worker/src/index.js (Worker principal):
// esta es la misma función, replicada aquí para que el failover a
// Railway/Postgres soporte el mismo login con Google sin depender del
// principal estando vivo.
let cacheGoogleJWKS = null;
async function getGoogleJWK(kid, forzarRefresco = false) {
  if (!cacheGoogleJWKS || forzarRefresco) {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!res.ok) throw new Error("No se han podido obtener las claves públicas de Google");
    const data = await res.json();
    cacheGoogleJWKS = data.keys || [];
  }
  return cacheGoogleJWKS.find((k) => k.kid === kid) || null;
}

async function verificarGoogleIdToken(idToken, googleClientId) {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  const header = JSON.parse(b64urlDecodeTexto(h));
  const payload = JSON.parse(b64urlDecodeTexto(p));

  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") return null;
  if (payload.aud !== googleClientId) return null;
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) return null;
  if (!payload.email) return null;

  let jwk = await getGoogleJWK(header.kid);
  if (!jwk) jwk = await getGoogleJWK(header.kid, true);
  if (!jwk) return null;

  const clavePublica = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const firmaBytes = Uint8Array.from(b64urlDecode(s), (c) => c.charCodeAt(0));
  const datosFirmados = new TextEncoder().encode(`${h}.${p}`);
  const valido = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    clavePublica,
    firmaBytes,
    datosFirmados
  );
  if (!valido) return null;

  return payload;
}

// ---------- Verificación del id_token de Microsoft (login de lectores) ----------
// Ver el comentario largo en worker/src/index.js (Worker principal):
// esta es la misma función, replicada aquí para que el failover a
// Railway/Postgres soporte el mismo login con Microsoft sin depender
// del principal estando vivo.
let cacheMicrosoftJWKS = null;
async function getMicrosoftJWK(kid, forzarRefresco = false) {
  if (!cacheMicrosoftJWKS || forzarRefresco) {
    const res = await fetch("https://login.microsoftonline.com/common/discovery/v2.0/keys");
    if (!res.ok) throw new Error("No se han podido obtener las claves públicas de Microsoft");
    const data = await res.json();
    cacheMicrosoftJWKS = data.keys || [];
  }
  return cacheMicrosoftJWKS.find((k) => k.kid === kid) || null;
}

async function verificarMicrosoftIdToken(idToken, microsoftClientId) {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  const header = JSON.parse(b64urlDecodeTexto(h));
  const payload = JSON.parse(b64urlDecodeTexto(p));

  if (typeof payload.iss !== "string") return null;
  if (!payload.iss.startsWith("https://login.microsoftonline.com/") || !payload.iss.endsWith("/v2.0")) return null;
  if (payload.aud !== microsoftClientId) return null;
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) return null;
  if (!payload.email && !payload.preferred_username) return null;

  let jwk = await getMicrosoftJWK(header.kid);
  if (!jwk) jwk = await getMicrosoftJWK(header.kid, true);
  if (!jwk) return null;

  const clavePublica = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const firmaBytes = Uint8Array.from(b64urlDecode(s), (c) => c.charCodeAt(0));
  const datosFirmados = new TextEncoder().encode(`${h}.${p}`);
  const valido = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    clavePublica,
    firmaBytes,
    datosFirmados
  );
  if (!valido) return null;

  if (!payload.email && payload.preferred_username) payload.email = payload.preferred_username;

  return payload;
}

// ---------- Cloudinary ----------
// Sustituye a R2/Drive: los archivos de "Subir contenido" se guardan en
// Cloudinary. Solo hacen falta 3 credenciales fijas (cloud name, api key,
// api secret) que da el panel al crear la cuenta —nada de OAuth ni
// consola de Google Cloud—, y el plan gratis (25 créditos/mes) no cobra
// automáticamente al superarse: avisa y, si no se amplía el plan,
// desactiva la cuenta. Ver README para cómo obtener las credenciales.
async function sha1Hex(text) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-1", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Analíticas propias (vistas y tiempo de lectura) ----------
// Ver db/migrations/006_analiticas.sql para las tablas article_views/
// article_reading y public/panel-analiticas.html (panel) para cómo se
// consumen estos datos. Mismas funciones que worker/src/index.js (D1),
// duplicadas aquí para que el panel funcione igual sirviéndose desde
// este worker (Postgres/Railway).

// Hash no reversible de IP + User-Agent + día, solo para poder deduplicar
// varias vistas de la misma persona el mismo día sin guardar nada que la
// identifique. Cambia cada día a propósito (no hace falta identificar de
// forma permanente a nadie, solo evitar inflar "visitas únicas" con
// recargas de la misma sesión de lectura).
async function hashVisitante(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ua = request.headers.get("User-Agent") || "";
  const dia = new Date().toISOString().slice(0, 10);
  return sha1Hex(`${ip}|${ua}|${dia}|${env.JWT_SECRET || ""}`);
}

// Hash no reversible de IP + User-Agent, SIN el día (a diferencia de
// hashVisitante de arriba). Sirve únicamente para "lectores nuevos vs.
// recurrentes" (ver calcularRecurrenciaAnaliticas): como no cambia de
// un día a otro, agrupar por esta columna y contar días distintos con
// vistas SÍ permite detectar si la misma persona ha vuelto en más de
// un día dentro del rango. No se usa para nada más (visitas únicas por
// artículo, fuentes, etc. siguen usando visitante_hash, que sí cambia
// cada día a propósito para no inflar esas cifras con recargas).
async function hashVisitanteEstable(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ua = request.headers.get("User-Agent") || "";
  return sha1Hex(`estable|${ip}|${ua}|${env.JWT_SECRET || ""}`);
}

// Clasifica el tráfico a partir de la cabecera Referer, igual que hace
// GA4 con sus canales por defecto: directo (sin referer o referer del
// propio dominio con origin distinto, ver más abajo), buscador, redes
// sociales, o referido genérico (cualquier otra web que enlaza).
const DOMINIOS_BUSCADORES = ["google.", "bing.", "duckduckgo.", "yahoo.", "ecosia.", "yandex."];
const DOMINIOS_REDES_SOCIALES = ["facebook.com", "twitter.com", "x.com", "t.co", "instagram.com", "tiktok.com", "whatsapp.com", "telegram.org", "t.me", "linkedin.com", "reddit.com", "threads.net"];

function clasificarFuenteTrafico(referer, siteUrl) {
  if (!referer) return { fuente: "directo", dominio: null };
  let dominioReferer;
  try {
    dominioReferer = new URL(referer).hostname.replace(/^www\./, "");
  } catch {
    return { fuente: "directo", dominio: null };
  }
  let dominioPropio = "";
  try {
    dominioPropio = new URL(siteUrl).hostname.replace(/^www\./, "");
  } catch {}
  if (dominioPropio && dominioReferer === dominioPropio) return { fuente: "interno", dominio: null };
  if (DOMINIOS_BUSCADORES.some((d) => dominioReferer.includes(d))) return { fuente: "buscador", dominio: dominioReferer };
  if (DOMINIOS_REDES_SOCIALES.some((d) => dominioReferer.includes(d))) return { fuente: "redes_sociales", dominio: dominioReferer };
  return { fuente: "referido", dominio: dominioReferer };
}

// Mismo criterio simple que describirDispositivo() (arriba, para las
// sesiones), reducido a las tres categorías que muestra el panel.
function clasificarDispositivo(userAgent) {
  const ua = userAgent || "";
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|Android/i.test(ua)) return "movil";
  return "escritorio";
}

// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa: bots/crawlers/herramientas SEO que sí ejecutan JavaScript y
// disparaban analiticas-tracking.js igual que un lector real, inflando
// "páginas vistas".
const PATRONES_USER_AGENT_BOT = [
  "bot", "spider", "crawl", "slurp", "headless", "phantomjs", "puppeteer",
  "playwright", "selenium", "lighthouse", "pagespeed", "gptbot", "ccbot",
  "bytespider", "ahrefsbot", "semrushbot", "mj12bot", "dotbot", "petalbot",
  "facebookexternalhit", "discordbot", "telegrambot", "whatsapp", "slackbot",
  "vkshare", "pinterest", "embedly", "quora link preview", "linkedinbot",
  "screaming frog", "seokicks", "uptimerobot", "monitor", "curl", "wget",
  "python-requests", "axios", "postmanruntime", "insomnia",
];
function esUserAgentBot(userAgent) {
  const ua = (userAgent || "").toLowerCase();
  if (!ua) return true;
  return PATRONES_USER_AGENT_BOT.some((p) => ua.includes(p));
}

// Sube un archivo a Cloudinary sin ninguna transformación (se conserva la
// calidad original). Devuelve { publicId, resourceType, url }.
async function subirACloudinary(env, fileBytes, mimeType, nombreArchivo) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await sha1Hex(`timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`);

  const form = new FormData();
  form.append("file", new Blob([fileBytes], { type: mimeType }));
  form.append("api_key", env.CLOUDINARY_API_KEY);
  form.append("timestamp", timestamp.toString());
  form.append("signature", signature);

  const resp = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/auto/upload`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    const cuerpoError = await resp.text();
    console.error(`Cloudinary respondió ${resp.status} al subir "${nombreArchivo || "(sin nombre)"}" (${mimeType || "tipo desconocido"}): ${cuerpoError}`);
    throw new Error(`Cloudinary (${resp.status}): ${cuerpoError}`);
  }
  const data = await resp.json();
  // HEIC/HEIF (formato por defecto de las fotos de iPhone) no lo renderiza
  // ningún navegador directamente: si se devuelve tal cual, la miniatura
  // de previsualización del panel (que usa la URL en crudo, sin pasar por
  // cloudinaryOptimizada) se queda rota, aunque la imagen ya esté bien
  // subida y en el sitio público sí se vea (ahí siempre se pide con
  // f_auto). Se inserta f_auto/q_auto para que la URL guardada sea
  // directamente compatible con cualquier navegador desde el primer
  // momento, sin perder la posibilidad de pedir luego otras
  // transformaciones sobre esa misma URL en el resto del sitio.
  let url = data.secure_url;
  const esHeic = mimeType === "image/heic" || mimeType === "image/heif" || /\.(heic|heif)$/i.test(nombreArchivo || "");
  if (esHeic) {
    const marca = "/upload/";
    const i = url.indexOf(marca);
    if (i !== -1) url = url.slice(0, i + marca.length) + "f_auto,q_auto/" + url.slice(i + marca.length);
  }
  return { publicId: data.public_id, resourceType: data.resource_type, url };
}

// ---------- Validación de archivos subidos (imágenes y vídeos) ----------
// Punto único de configuración: tanto "Subir contenido" (/api/media,
// fotos y vídeos de la mediateca) como "Subir imagen suelta"
// (/api/subir-imagen, usado en la foto de perfil y en las fotos de una
// noticia/crónica) validan el archivo aquí antes de tocar Cloudinary, así
// los formatos admitidos, los límites de tamaño y los mensajes de error
// son siempre los mismos en toda la web en vez de estar duplicados (y
// potencialmente desincronizados) en cada sitio donde se sube algo.
const TIPOS_IMAGEN_PERMITIDOS = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/heic", "image/heif"];
const TIPOS_VIDEO_PERMITIDOS = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/mpeg"];
// Las imágenes no tienen límite de tamaño propio: Cloudinary y el límite
// de payload de Workers son los únicos topes reales.
const LIMITE_VIDEO_BYTES = 90 * 1024 * 1024; // 90 MB (el plan gratis de Workers corta la petición entera a los 100 MB)

// Algunos navegadores (sobre todo en Android, o Safari en ciertas
// versiones) no rellenan bien file.type para archivos HEIC/HEIF y lo
// dejan vacío o con un valor genérico: si eso pasa, se cae a mirar la
// extensión del nombre del archivo antes de rechazarlo, para no dar un
// falso error de "formato no compatible" con una foto que en realidad sí
// se podría subir.
function extensionImagenPermitida(nombreArchivo) {
  const ext = (nombreArchivo || "").split(".").pop().toLowerCase();
  return ["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif"].includes(ext);
}

function esImagenPermitida(mimeType) {
  return TIPOS_IMAGEN_PERMITIDOS.includes(mimeType);
}

// Devuelve un mensaje de error si el archivo no es válido, o null si se
// puede subir. `permitirVideo` distingue el caso de "Subir contenido"
// (admite fotos y vídeos) del de "Subir imagen suelta" (solo fotos).
function validarArchivoSubida(file, { permitirVideo = false } = {}) {
  if (!file || typeof file === "string") return "Falta el archivo";
  if (esImagenPermitida(file.type)) {
    return null;
  }
  // MIME vacío o no reconocido (típico de HEIC en algunos navegadores):
  // se admite igualmente si la extensión del archivo es una de las
  // permitidas, en vez de rechazarlo directamente.
  if ((!file.type || file.type === "application/octet-stream") && extensionImagenPermitida(file.name)) {
    return null;
  }
  if (permitirVideo && TIPOS_VIDEO_PERMITIDOS.includes(file.type)) {
    if (file.size > LIMITE_VIDEO_BYTES) return "El vídeo no puede superar los 90 MB";
    return null;
  }
  return permitirVideo
    ? "Solo se admiten fotos (JPG, PNG, WEBP, GIF, AVIF, HEIC/HEIF) o vídeos (MP4, MOV, WEBM, MKV, MPEG)"
    : "Solo se admiten imágenes en un formato compatible (JPG, PNG, WEBP, GIF, AVIF o HEIC/HEIF)";
}

// Valida el archivo y, si es correcto, lo sube a Cloudinary tal cual
// llega, sin recomprimir ni transformar. Lanza un error con
// `esValidacion: true` cuando el problema es el propio archivo (para
// devolver un 400 con el mensaje tal cual), y un error normal si falla
// la subida a Cloudinary (para devolver un 502).
// Valida el archivo y, si es correcto, lo sube a Cloudinary tal cual
// llega, sin recomprimir ni transformar. Lanza un error con
// `esValidacion: true` cuando el problema es el propio archivo (para
// devolver un 400 con el mensaje tal cual), y un error normal si falla
// la subida a Cloudinary (para devolver un 502).
// `fileBytes`, si se pasa, evita volver a leer el archivo entero por
// segunda vez cuando quien llama ya lo había leído antes (p. ej. para
// calcular el hash de duplicados en /api/media): con archivos grandes
// (vídeos de decenas de MB), tener dos copias del archivo entero vivas
// en memoria a la vez podía agotar la memoria del Worker (límite de
// 128 MB) y tirar la petición entera con un 502 sin ningún mensaje de
// error legible.
async function procesarSubidaArchivo(env, file, opciones, fileBytes) {
  const errorValidacion = validarArchivoSubida(file, opciones);
  if (errorValidacion) {
    const error = new Error(errorValidacion);
    error.esValidacion = true;
    throw error;
  }
  const bytes = fileBytes || (await file.arrayBuffer());
  const subida = await subirACloudinary(env, bytes, file.type, file.name);
  // El hash se calcula sobre los bytes ya leídos, así no hace falta
  // volver a leer el archivo entero una segunda vez.
  subida.hash = await sha256Hex(bytes);
  return subida;
}

// Hash SHA-256 (en hexadecimal) del contenido binario de un archivo.
// Se usa para detectar duplicados por contenido real, no por nombre: dos
// archivos con el mismo hash son bit a bit idénticos aunque se hayan
// renombrado o se les haya cambiado el título/descripción al subirlos.
async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function borrarDeCloudinary(env, publicId, resourceType) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await sha1Hex(`public_id=${publicId}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`);

  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", env.CLOUDINARY_API_KEY);
  form.append("timestamp", timestamp.toString());
  form.append("signature", signature);

  return fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/destroy`, {
    method: "POST",
    body: form,
  });
}

// Posiciones válidas para cada foto (que no sea la portada, que siempre
// se muestra arriba del todo) dentro de una noticia/crónica: "inicio"
// la inserta al principio del cuerpo del texto; "personalizada" la inserta
// tras el número de párrafo indicado en "trasParrafo"; "galeria" la deja
// en la tira de miniaturas final (comportamiento clásico). Se sigue
// aceptando en la validación "medio"/"final" (formato antiguo) para no
// romper noticias ya guardadas antes de este cambio.
// "collage" es una foto que forma parte de un collage personalizable
// (varias fotos combinadas en una sola cuadrícula dentro del texto): se
// comporta, a efectos de posición dentro del artículo, igual que
// "inicio"/"personalizada" (usa también "trasParrafo"), pero varias
// fotos comparten el mismo "grupo" (id de collage) y "plantilla" (2, 3 o
// 4 fotos, con la disposición concreta dentro de esa plantilla).
const POSICIONES_IMAGEN_VALIDAS = ["inicio", "personalizada", "medio", "final", "galeria", "collage"];
// Los tweets incrustados en el cuerpo de la noticia usan el mismo sistema
// de posición que las fotos ("inicio"/"personalizada"/"galeria" ya
// definidas arriba), pero no tienen sentido en "galería final" (no son
// una foto que mostrar en el carrusel) ni en "collage". Se guardan
// dentro del mismo array "imagenes" (ver normalizarImagenes) marcados con
// tipo:"tweet" para reutilizar toda la lógica de posición/párrafo ya
// existente en vez de duplicar un sistema aparte.
const POSICIONES_TWEET_VALIDAS = ["inicio", "personalizada", "galeria"];
// Plantillas de collage admitidas: cuántas fotos lleva cada una. La
// disposición visual concreta de cada plantilla la decide el CSS
// (public/css/style.css, .collage-<plantilla>), no el backend.
const PLANTILLAS_COLLAGE_VALIDAS = ["2-horizontal", "2-vertical", "3-una-grande", "3-fila", "4-cuadricula"];

// Normaliza el array de fotos de una noticia/crónica. Admite tanto el
// formato antiguo (array de URLs en texto plano) como el nuevo, con un
// objeto por foto que además guarda en qué posición del texto se debe
// insertar y el punto de la imagen que no se debe recortar nunca (el
// "foco", en formato CSS object-position, p. ej. "50% 30%").
// Competiciones para las que tiene sentido enlazar el partido finalizado
// con su ficha en Flashscore (Primera Federación, Segunda Federación y
// LaLiga Hypermotion, que es la LaLiga2 actual). Los amistosos y el resto
// de competiciones nunca guardan este enlace, aunque venga en el body.
const COMPETICIONES_CON_FLASHSCORE = ["hypermotion", "primera_federacion", "segunda_federacion"];
function flashscoreUrlValido(competicion, estado, url) {
  if (!url) return null;
  if (!COMPETICIONES_CON_FLASHSCORE.includes(competicion)) return null;
  if (estado !== "finalizado") return null;
  const limpia = String(url).trim();
  return limpia || null;
}

// ID numérico de un tweet a partir de cualquier URL habitual de X/Twitter
// (espejo de idTweetDesdeUrl en admin.js, para validar en el servidor
// igual que se valida en el editor).
function idTweetDesdeUrlServidor(url) {
  const match = String(url || "").match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i);
  return match ? match[1] : null;
}

// Código corto de un post/reel de Instagram a partir de su URL (espejo
// de idInstagramDesdeUrl en admin.js).
function idInstagramDesdeUrlServidor(url) {
  const match = String(url || "").match(/instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/i);
  return match ? match[1] : null;
}

// Espejo de plataformaEmbedDesdeUrl en admin.js: "twitter", "instagram"
// o null si la URL no tiene pinta de ser ninguna de las dos cosas. El
// botón "Añadir tweet o post" del panel es único para ambas redes, así
// que aquí también hay que aceptar y distinguir las dos igual.
function plataformaEmbedDesdeUrlServidor(url) {
  if (idTweetDesdeUrlServidor(url)) return "twitter";
  if (idInstagramDesdeUrlServidor(url)) return "instagram";
  return null;
}

function normalizarImagenes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") {
        const url = item.trim();
        return url ? { url, posicion: "galeria", foco: "50% 50%" } : null;
      }
      if (item && typeof item === "object" && item.tipo === "tweet" && typeof item.url === "string") {
        const url = item.url.trim();
        const plataforma = plataformaEmbedDesdeUrlServidor(url);
        if (!url || !plataforma) return null;
        const posicion = POSICIONES_TWEET_VALIDAS.includes(item.posicion) ? item.posicion : "galeria";
        const resultado = { tipo: "tweet", url, plataforma, posicion };
        if (posicion === "personalizada") {
          const n = parseInt(item.trasParrafo, 10);
          resultado.trasParrafo = Number.isFinite(n) && n > 0 ? n : 1;
        }
        return resultado;
      }
      if (item && typeof item === "object" && typeof item.url === "string") {
        const url = item.url.trim();
        if (!url) return null;
        const posicion = POSICIONES_IMAGEN_VALIDAS.includes(item.posicion) ? item.posicion : "galeria";
        const foco = typeof item.foco === "string" && /^\d{1,3}% \d{1,3}%$/.test(item.foco.trim()) ? item.foco.trim() : "50% 50%";
        const resultado = { url, posicion, foco };
        if (posicion === "personalizada" || posicion === "collage") {
          const n = parseInt(item.trasParrafo, 10);
          resultado.trasParrafo = Number.isFinite(n) && n > 0 ? n : 1;
        }
        if (posicion === "collage") {
          // "grupo" identifica qué fotos van juntas en el mismo collage
          // (varias filas del array pueden compartir el mismo id de
          // grupo); "plantilla" es la disposición elegida para ese
          // grupo y se repite igual en todas sus fotos.
          resultado.grupo = typeof item.grupo === "string" && item.grupo.trim() ? item.grupo.trim() : "collage-1";
          resultado.plantilla = PLANTILLAS_COLLAGE_VALIDAS.includes(item.plantilla) ? item.plantilla : "2-horizontal";
        }
        // Crédito/cita de la fotografía (autor, agencia...), opcional.
        if (typeof item.credito === "string" && item.credito.trim()) {
          resultado.credito = item.credito.trim();
        }
        return resultado;
      }
      return null;
    })
    .filter(Boolean);
}

// ---------- Alineaciones ----------
// Devuelve las alineaciones (normalmente 0, 1 o 2: local y visitante)
// ligadas a una noticia o a un partido, ya con "jugadores" convertido de
// JSON guardado a array de verdad, listas para mandar al frontend.
async function obtenerAlineaciones(env, columna, id) {
  if (!id) return [];
  const { results } = await env.DB.prepare(
    `SELECT * FROM alineaciones WHERE ${columna} = ? ORDER BY id ASC`
  ).bind(id).all();
  return (results || []).map((a) => {
    try {
      a.jugadores = JSON.parse(a.jugadores || "[]");
    } catch {
      a.jugadores = [];
    }
    return a;
  });
}

// Últimas alineaciones guardadas de un equipo (mirando sus partidos más
// recientes, jugara como local o visitante), para poder copiarlas al
// editar la alineación de un partido nuevo -botón "Copiar de un partido
// anterior" en el panel-. Solo mira alineaciones colgadas de result_id
// (partidos), no las sueltas de una noticia sin partido vinculado.
async function obtenerUltimasAlineacionesEquipo(env, equipo, excluirResultId, limite = 3) {
  if (!equipo) return [];
  const { results: partidos } = await env.DB.prepare(
    `SELECT id, competicion, jornada, fecha_partido, equipo_local, equipo_visitante
     FROM results
     WHERE (equipo_local = ? OR equipo_visitante = ?)
       AND estado = 'finalizado'
       AND id != ?
     ORDER BY fecha_partido DESC
     LIMIT 20`
  ).bind(equipo, equipo, excluirResultId || 0).all();
  if (!partidos.length) return [];

  const idsPartidos = partidos.map((p) => p.id);
  const placeholders = idsPartidos.map(() => "?").join(",");
  const { results: alineaciones } = await env.DB.prepare(
    `SELECT * FROM alineaciones WHERE result_id IN (${placeholders}) AND equipo = ?`
  ).bind(...idsPartidos, equipo).all();

  const mapaPorPartido = {};
  alineaciones.forEach((a) => { mapaPorPartido[a.result_id] = a; });

  const salida = [];
  for (const partido of partidos) {
    const alineacion = mapaPorPartido[partido.id];
    if (!alineacion) continue;
    let jugadores = [];
    try {
      jugadores = JSON.parse(alineacion.jugadores || "[]");
    } catch {
      jugadores = [];
    }
    const rival = partido.equipo_local === equipo ? partido.equipo_visitante : partido.equipo_local;
    salida.push({
      alineacion_id: alineacion.id,
      result_id: partido.id,
      rival,
      jornada: partido.jornada,
      fecha_partido: partido.fecha_partido,
      formacion: alineacion.formacion,
      escudo_url: alineacion.escudo_url,
      jugadores,
    });
    if (salida.length >= limite) break;
  }
  return salida;
}

// Valida y normaliza el array de jugadores que manda el editor visual
// del panel: descarta entradas sin nombre, recorta dorsales/coordenadas
// a rangos razonables y no deja pasar campos inesperados.
function normalizarJugadoresAlineacion(raw) {
  if (!Array.isArray(raw)) return [];
  let capitanAsignado = false;
  return raw
    .map((j) => {
      if (!j || typeof j !== "object") return null;
      const nombre = typeof j.nombre === "string" ? j.nombre.trim() : "";
      if (!nombre) return null;
      const titular = j.titular !== false;
      const esCapitan = j.capitan === true && !capitanAsignado;
      if (esCapitan) capitanAsignado = true;
      const jugador = {
        nombre,
        dorsal: Number.isFinite(parseInt(j.dorsal, 10)) ? parseInt(j.dorsal, 10) : null,
        titular,
        capitan: esCapitan,
      };
      if (titular) {
        jugador.x = Math.max(0, Math.min(100, Number.isFinite(+j.x) ? +j.x : 50));
        jugador.y = Math.max(0, Math.min(100, Number.isFinite(+j.y) ? +j.y : 50));
      }
      return jugador;
    })
    .filter(Boolean)
    .slice(0, 30); // 11 titulares + suplentes razonables, tope de seguridad
}

// ---------- Historial de acciones (auditoría, solo admins) ----------
// Deja constancia de cada acción relevante que hace cada persona
// (quién, qué, cuándo y sobre qué), para que un admin pueda revisar la
// actividad del equipo desde el panel ("Historial"). No debe romper
// nunca la operación principal: si falla el registro, solo se anota en
// los logs del Worker.
async function registrarActividad(env, request, payload, { accion, entidad = null, entidad_id = null, descripcion, detalle = null }) {
  try {
    // "request" puede venir vacío cuando la actividad la registra el propio
    // sistema (p. ej. el disparador programado publicando una noticia) y no
    // hay ninguna petición HTTP de por medio.
    const ip = request ? (request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || null) : null;
    await env.DB.prepare(
      `INSERT INTO activity_log (usuario_id, usuario_nombre, usuario_rol, accion, entidad, entidad_id, descripcion, detalle, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      payload?.uid ?? null,
      payload?.nombre ?? "Desconocido",
      payload?.rol ?? "desconocido",
      accion,
      entidad,
      entidad_id !== null && entidad_id !== undefined ? String(entidad_id) : null,
      descripcion,
      detalle ? JSON.stringify(detalle) : null,
      ip
    ).run();
  } catch (err) {
    console.log("Error al registrar actividad:", err.message);
  }
}

function slugify(text) {
  return text
    .toString()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 90);
}

// Genera un slug único a partir de un título, evitando choques con el
// slug de otro artículo (o con un slug antiguo ya guardado en
// article_slug_redirects, para no reutilizar por error un enlace que
// todavía puede estar circulando apuntando a otra noticia).
// "idPropio" es el id del propio artículo (al editar), para no chocar
// contra su propio slug actual si el título no ha cambiado de verdad.
async function slugUnico(env, titulo, idPropio) {
  let base = slugify(titulo);
  if (!base) base = "noticia";
  let slug = base;
  let intento = 0;
  while (true) {
    const chocaConArticulo = await env.DB.prepare(
      "SELECT id FROM articles WHERE slug = ? AND id != ?"
    ).bind(slug, idPropio || -1).first();
    const chocaConRedirect = await env.DB.prepare(
      "SELECT article_id FROM article_slug_redirects WHERE slug_antiguo = ? AND article_id != ?"
    ).bind(slug, idPropio || -1).first();
    if (!chocaConArticulo && !chocaConRedirect) return slug;
    intento++;
    slug = `${base}-${intento > 1 ? intento : Date.now().toString().slice(-5)}`;
  }
}

// Al guardar un artículo cuyo slug ha cambiado (porque todavía no está
// "congelado", ver slug_congelado en schema.sql), guarda el slug antiguo
// en article_slug_redirects para que quien entre con el enlace viejo se
// redirija automáticamente al nuevo, en vez de encontrarse un "no
// encontrada". No hace nada si el slug no ha cambiado.
async function registrarRedirectSiCambia(env, articleId, slugAntiguo, slugNuevo) {
  if (!slugAntiguo || slugAntiguo === slugNuevo) return;
  await env.DB.prepare(
    `INSERT INTO article_slug_redirects (slug_antiguo, article_id) VALUES (?, ?)
     ON CONFLICT(slug_antiguo) DO UPDATE SET article_id = excluded.article_id, created_at = datetime('now')`
  ).bind(slugAntiguo, articleId).run();
  // Si alguna redirección antigua apuntaba precisamente al slug nuevo que
  // acabamos de "liberar" en otro artículo... no debería darse (slugUnico
  // ya evita choques), así que no hace falta contemplarlo aquí.
}

// Cuenta los caracteres de texto "real" de una noticia/crónica, quitando
// las etiquetas HTML del editor (para que el mínimo/máximo se aplique al
// texto que de verdad va a leer la persona, no a las marcas de formato).
function longitudTextoPlano(html) {
  if (!html) return 0;
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim().length;
}

const CONTENIDO_MIN = 2000;
const CONTENIDO_MAX = 8000;

// ---------- Sistema de niveles y recompensas ----------
// Umbrales de publicaciones (contenido PUBLICADO, no borradores) que
// hacen falta para poder OPTAR a cada nivel. Cumplirlos no sube el
// nivel automáticamente (lo decide un admin, ver PUT /api/users/:id/nivel);
// esto es solo lo que se usa para calcular el progreso y decir si la
// persona "ya está en condiciones de que la evalúen".
const NIVELES_REQUISITOS = {
  1: null, // Principiante: nivel inicial, no requiere nada.
  2: { noticia: 30, cronica: 15, opinion: 3, entrevista: 1 },
  3: { noticia: 50, cronica: 25, opinion: 4, entrevista: 1 },
  4: { noticia: 60, cronica: 30, opinion: 6, entrevista: 2 },
};

const NIVELES_INFO = {
  1: {
    nombre: "Principiante", emoji: "🟢",
    descripcion: "Todo el contenido pasa por revisión de un administrador antes de publicarse.",
  },
  2: {
    nombre: "Aprendiz", emoji: "🔵",
    descripcion: "Publica noticias, crónicas y artículos de opinión sin revisión previa.",
  },
  3: {
    nombre: "Maestro", emoji: "🟣",
    descripcion: "Publicación sin revisión + puede publicar contenido del medio en Instagram y TikTok.",
  },
  4: {
    nombre: "Experto", emoji: "🟠",
    descripcion: "Puede revisar y corregir noticias de otros, optar al consejo de administración y a coordinaciones.",
  },
};

// Cuenta, por tipo, cuántos artículos PUBLICADOS tiene un autor. Se
// cuentan solo publicados (publicado = 1): un borrador o una noticia
// programada todavía no cuenta como "trabajo demostrado". Se cuentan
// tanto los artículos en los que la persona es autora principal como
// aquellos en los que firma como coautora: si ayudó a sacar la noticia
// adelante, debe contarle igual para su progreso de nivel, no solo al
// autor principal.
async function contarPublicacionesPorTipo(env, autorId) {
  const { results } = await env.DB.prepare(
    `SELECT tipo, COUNT(*) AS total FROM articles
     WHERE (autor_id = ? OR coautor_id = ?) AND publicado = 1
     GROUP BY tipo`
  ).bind(autorId, autorId).all();
  const conteo = { noticia: 0, cronica: 0, opinion: 0, entrevista: 0 };
  for (const fila of results) {
    if (conteo[fila.tipo] !== undefined) conteo[fila.tipo] = fila.total;
  }
  return conteo;
}

// Igual que contarPublicacionesPorTipo, pero para VARIOS autores a la
// vez con una sola consulta (en vez de una por usuario). La usa
// GET /api/users para no lanzar una query por cada fila de la tabla de
// usuarios del panel (antes: N usuarios listados = N consultas
// idénticas escaneando "articles" una y otra vez; ver panel Analíticas >
// Queries de Cloudflare D1, "rows read" de esta consulta).
//
// UNION ALL en vez de "WHERE autor_id IN (...) OR coautor_id IN (...)":
// así cada mitad puede usar su propio índice (idx_articles_autor_publicado
// / idx_articles_coautor_publicado) en vez de forzar un escaneo completo
// por culpa del OR.
async function contarPublicacionesPorTipoDeVarios(env, autorIds) {
  const idsUnicos = [...new Set(autorIds.filter((id) => id != null))];
  const conteos = new Map(idsUnicos.map((id) => [id, { noticia: 0, cronica: 0, opinion: 0, entrevista: 0 }]));
  if (idsUnicos.length === 0) return conteos;
  const placeholders = idsUnicos.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT autor_id AS id, tipo, COUNT(*) AS total FROM articles
     WHERE autor_id IN (${placeholders}) AND publicado = 1
     GROUP BY autor_id, tipo
     UNION ALL
     SELECT coautor_id AS id, tipo, COUNT(*) AS total FROM articles
     WHERE coautor_id IN (${placeholders}) AND publicado = 1
     GROUP BY coautor_id, tipo`
  ).bind(...idsUnicos, ...idsUnicos).all();
  for (const fila of results) {
    const conteo = conteos.get(fila.id);
    if (conteo && conteo[fila.tipo] !== undefined) conteo[fila.tipo] += fila.total;
  }
  return conteos;
}

// Dado el conteo actual de publicaciones, calcula el detalle de
// progreso hacia un nivel concreto (cuánto lleva y cuánto le falta de
// cada tipo) y si ya cumple todas las cifras mínimas.
function calcularProgresoNivel(conteo, requisitos) {
  if (!requisitos) return { cumple: true, detalle: [] };
  const detalle = Object.entries(requisitos).map(([tipo, necesarios]) => ({
    tipo,
    actual: conteo[tipo] || 0,
    necesarios,
    cumple: (conteo[tipo] || 0) >= necesarios,
  }));
  return { cumple: detalle.every((d) => d.cumple), detalle };
}

// Construye el objeto de progreso completo de un usuario: nivel
// actual, conteo de publicaciones, progreso hacia el siguiente nivel
// (si existe uno por encima de NIVEL_MAXIMO) y si ya está en
// condiciones de que un admin lo evalúe para el ascenso.
const NIVEL_MAXIMO = 4;

async function construirProgresoNivel(env, usuario, conteoPrecalculado) {
  // Los admins publican directamente, revisan todo y no tienen que
  // demostrar nada con cifras: a efectos de "Mi progreso" y de la
  // tabla de Usuarios se muestran siempre en el nivel máximo, aunque
  // en la columna `nivel` de la base de datos se queden en 1 por
  // defecto (ver migracion_niveles.sql). Como es rol, no cifra, no
  // tiene sentido calcular ni mostrar progreso hacia "el siguiente
  // nivel": no hay ninguno por encima.
  const esAdmin = usuario.rol === "admin";
  const nivelActual = esAdmin ? NIVEL_MAXIMO : (usuario.nivel || 1);
  // Si quien llama ya calculó el conteo de varios usuarios a la vez
  // (ver contarPublicacionesPorTipoDeVarios, usado por GET /api/users
  // para no lanzar una query por usuario), se reutiliza en vez de
  // volver a consultar la base de datos.
  const conteo = conteoPrecalculado || await contarPublicacionesPorTipo(env, usuario.id);
  const siguienteNivel = !esAdmin && nivelActual < NIVEL_MAXIMO ? nivelActual + 1 : null;
  const progresoSiguiente = siguienteNivel
    ? calcularProgresoNivel(conteo, NIVELES_REQUISITOS[siguienteNivel])
    : null;

  return {
    nivel_actual: nivelActual,
    nivel_info: NIVELES_INFO[nivelActual] || NIVELES_INFO[1],
    nivel_nota: esAdmin ? null : (usuario.nivel_nota || null),
    publicaciones: conteo,
    nivel_maximo: nivelActual >= NIVEL_MAXIMO,
    es_admin: esAdmin,
    siguiente_nivel: siguienteNivel,
    siguiente_nivel_info: siguienteNivel ? NIVELES_INFO[siguienteNivel] : null,
    progreso: progresoSiguiente
      ? {
          cumple_requisitos: progresoSiguiente.cumple,
          detalle: progresoSiguiente.detalle,
        }
      : null,
  };
}

// ---------- Permisos por autor + solicitudes de edición ----------
// Minutos que dura el permiso de edición sobre una entidad concreta una
// vez aprobada una solicitud (tiempo de sobra para hacer la edición sin
// tener que estar pidiéndolo cada vez, pero sin dejarlo abierto para
// siempre: pasado este tiempo, si quiere volver a tocarlo tiene que
// pedirlo de nuevo).
const EDIT_GRANT_MINUTOS = 120;

// Comprueba si "payload" (el usuario autenticado) puede editar/borrar la
// entidad indicada: un admin siempre puede; un redactor solo si es el
// autor, o si tiene una solicitud aprobada y todavía dentro de la
// ventana de tiempo concedida para esa entidad exacta.
async function puedeEditarEntidad(env, payload, tipoEntidad, autorId) {
  if (payload.rol === "admin") return true;
  if (autorId && autorId === payload.uid) return true;
  return false; // el permiso temporal por solicitud se comprueba aparte con id de entidad
}

async function tienePermisoTemporal(env, payload, tipoEntidad, entidadId) {
  if (payload.rol === "admin") return true;
  const permiso = await env.DB.prepare(
    `SELECT id FROM edit_requests
     WHERE tipo_entidad = ? AND entidad_id = ? AND solicitante_id = ? AND estado = 'aprobada'
       AND permiso_expira_at IS NOT NULL AND permiso_expira_at > datetime('now')
     ORDER BY resuelta_at DESC LIMIT 1`
  ).bind(tipoEntidad, entidadId, payload.uid).first();
  return Boolean(permiso);
}

// Combina las comprobaciones: autoría directa (o coautoría, si se
// pasa), atajo general para "resultado" (cualquier redactor puede
// editar/borrar el resultado de cualquier otro, incluido su minuto a
// minuto/cronómetro en directo -decisión explícita: los partidos son
// contenido compartido del equipo, no propiedad exclusiva de quien lo
// creó, y cualquier redactor puede necesitar tomar el relevo de un
// partido en directo-), nivel 4 para "articulo" (revisa/corrige
// contenido de cualquiera sin tener que pedir permiso, ver documento
// de niveles), o permiso temporal concedido por una solicitud aprobada.
async function puedeEditar(env, payload, tipoEntidad, entidadId, autorId, coautorId) {
  if (payload.rol === "admin") return true;
  if (tipoEntidad === "resultado") return true;
  if (autorId && autorId === payload.uid) return true;
  if (coautorId && coautorId === payload.uid) return true;
  if (tipoEntidad === "articulo") {
    const nivel = await obtenerNivelUsuario(env, payload.uid);
    if (nivel >= 4) return true;
  }
  return tienePermisoTemporal(env, payload, tipoEntidad, entidadId);
}

// Publica las noticias programadas cuyo "programado_para" ya se ha
// cumplido (usado por el disparador programado, ver "scheduled" más
// abajo). Se publican todas las que toquen en cada ejecución, no solo
// una, por si el disparador ha tardado en pasar por lo que sea.
// ---------- MINUTO A MINUTO: arranque automático del cronómetro ----------
// Única función que "arranca" un partido, la use quien la use (cron,
// botón manual de "En juego", o "Iniciar partido" del panel). Así nunca
// hay un partido en_juego sin cronómetro corriendo, sea cual sea el
// camino por el que se puso en_juego.
//
//   minutoInicial: minuto en el que debe arrancar a contar el reloj (0
//   normalmente; >0 cuando se arranca tarde, ver más abajo).
async function iniciarCronometroPartido(env, resultadoId, minutoInicial = 0) {
  const minutos = Number.isFinite(minutoInicial) && minutoInicial > 0 ? Math.floor(minutoInicial) : 0;
  // Se limpia aviso_desatendido_mitad al (re)arrancar el partido, sea la
  // primera vez o tras reabrirlo (estaba finalizado/retrasado/anulado y
  // un admin lo vuelve a poner en juego). Sin este reset, un partido que
  // ya había avisado por, digamos, la 2ª parte se quedaba con esa mitad
  // "gastada" para siempre: si se reabría y volvía a quedarse sin cubrir
  // en la misma mitad, revisarPartidosDesatendidos() ya no mandaba el
  // correo (bug: "no llega el correo aunque no se esté cubriendo"). Es
  // un partido distinto desde cero en la práctica, así que el contador
  // de avisos también debe arrancar de cero.
  //
  // COALESCE(goles_local, 0) / COALESCE(goles_visitante, 0): un partido
  // "programado" tiene goles_local/goles_visitante a NULL hasta que
  // alguien anota el primer gol o lo pone a mano a 0-0. Si este cronómetro
  // se arranca desde el cron automático en vez de desde el formulario
  // manual, esos campos se quedaban en NULL al pasar a "en_juego".
  // calcularClasificacion() en clasificacion.html/calendario.html descarta
  // cualquier partido "en_juego" con goles NULL, así que ese partido en
  // vivo desaparecía de la clasificación en vivo -- explicando por qué
  // "a veces va y a veces no" según qué camino había arrancado cada
  // partido. Con COALESCE, cualquier partido que llegue aquí sin
  // marcador queda a 0-0 en vez de NULL.
  await env.DB.prepare(
    `UPDATE results SET inicio_cronometro_at = datetime('now', ?), cronometro_pausado_en = NULL,
       ajuste_cronometro_minutos = 0, estado = 'en_juego', aviso_desatendido_mitad = NULL,
       goles_local = COALESCE(goles_local, 0), goles_visitante = COALESCE(goles_visitante, 0)
       WHERE id = ?`
  ).bind(`-${minutos} minutes`, resultadoId).run();
}

// Revisa cada minuto (mismo cron que ya revisaba artículos programados)
// los partidos "programado" cuya fecha_partido ya haya llegado, y los
// pasa a "en_juego" arrancando el cronómetro desde 0 en ese instante.
// Si el cron tarda en pasar (el propio cron trigger de Cloudflare no es
// al segundo exacto) el minuto empieza a contar desde 0 igualmente: el
// desfase de esos segundos/minuto es asumible y no afecta al resto de
// la lógica (mismo criterio que ya usa "Iniciar partido" manual).
async function iniciarPartidosProgramadosCuyaHoraHaLlegado(env) {
  // "fecha_partido" es hora de Madrid tal cual la escribió el redactor,
  // no UTC (ver fechaPartidoAUtcSqlite más arriba). Comparar su texto
  // directamente contra datetime('now') -que sí es UTC- desfasaba el
  // arranque automático 1-2h según la época del año. Se filtran primero
  // en SQL los candidatos con hora conocida (barato), y la comparación
  // fina de instante ya corregida se hace en JS.
  //
  // Se contemplan DOS estados de partido, cada uno mirando su propia
  // columna de hora:
  //   - "programado": fecha_partido (la hora original).
  //   - "retrasado": fecha_partido_retrasado (la nueva hora fijada al
  //     retrasar el partido). Antes de este cambio, un partido
  //     retrasado se quedaba en "retrasado" para siempre por mucho que
  //     pasara su nueva hora -- el redactor tenía que arrancarlo a mano
  //     porque nada volvía a comprobar esta columna una vez guardada.
  const { results: candidatosProgramados } = await env.DB.prepare(
    `SELECT id, fecha_partido FROM results
     WHERE estado = 'programado' AND fecha_partido IS NOT NULL
       AND length(fecha_partido) = 16` // "YYYY-MM-DDTHH:MM": solo si se conoce la hora, no solo la fecha
  ).all();
  const { results: candidatosRetrasados } = await env.DB.prepare(
    `SELECT id, fecha_partido_retrasado AS fecha_partido FROM results
     WHERE estado = 'retrasado' AND fecha_partido_retrasado IS NOT NULL
       AND length(fecha_partido_retrasado) = 16`
  ).all();
  const candidatos = [...candidatosProgramados, ...candidatosRetrasados];
  const ahoraSqlite = aSqliteDatetimeUTC(new Date());
  const pendientes = candidatos.filter((p) => {
    const inicioUtc = fechaPartidoAUtcSqlite(p.fecha_partido);
    return inicioUtc !== null && inicioUtc <= ahoraSqlite;
  });
  for (const partido of pendientes) {
    await iniciarCronometroPartido(env, partido.id, 0);
    // Comprobación defensiva por si, justo en el minuto en que pasa el
    // cron, el redactor ha pulsado "Iniciar partido" a mano casi a la
    // vez: sin esto podían colarse dos "Comienza el partido" para el
    // mismo encuentro (ver también la comprobación gemela en el POST de
    // /eventos, que cubre el caso opuesto: cron primero, botón después).
    const yaTieneInicio = await env.DB.prepare(
      "SELECT id FROM match_events WHERE resultado_id = ? AND tipo = 'inicio_partido' LIMIT 1"
    ).bind(partido.id).first();
    if (yaTieneInicio) continue;
    await env.DB.prepare(
      `INSERT INTO match_events (resultado_id, tipo, equipo, minuto, orden) VALUES (?, 'inicio_partido', 'ninguno', 0, 0)`
    ).bind(partido.id).run();
  }
}

// Minuto a partir del cual se pita el descanso solo, si nadie lo ha
// hecho a mano todavía. Igual que "inicio_partido" se inserta solo al
// arrancar el cronómetro (ver iniciarPartidosProgramadosCuyaHoraHaLlegado),
// este evento "descanso" se inserta solo al llegar el cronómetro a este
// minuto, sin esperar a que el redactor pulse el botón del panel.
const MINUTO_DESCANSO_AUTOMATICO = 45;

// Revisa cada minuto (mismo cron que ya revisa partidos programados y
// partidos desatendidos) los partidos "en_juego" cuyo cronómetro sigue
// corriendo y ya ha alcanzado MINUTO_DESCANSO_AUTOMATICO, y les inserta
// el evento "descanso" solo si todavía no existe uno para ese partido.
// Se limita a partidos con el cronómetro corriendo (no pausado): si ya
// está pausado es que alguien ya ha pitado algo (descanso, hidratación...)
// y no hay que tocarlo.
async function crearDescansoAutomaticoAlMinuto45(env) {
  const { results: partidos } = await env.DB.prepare(
    `SELECT id, inicio_cronometro_at, cronometro_pausado_en, ajuste_cronometro_minutos
     FROM results WHERE estado = 'en_juego' AND cronometro_pausado_en IS NULL`
  ).all();
  if (!partidos.length) return;

  for (const partido of partidos) {
    const minuto = minutoEnVivoServidor(partido);
    if (minuto < MINUTO_DESCANSO_AUTOMATICO) continue;

    const yaHuboDescanso = await env.DB.prepare(
      "SELECT id FROM match_events WHERE resultado_id = ? AND tipo = 'descanso' LIMIT 1"
    ).bind(partido.id).first();
    if (yaHuboDescanso) continue;

    await env.DB.prepare(
      `INSERT INTO match_events (resultado_id, tipo, equipo, minuto, orden) VALUES (?, 'descanso', 'ninguno', ?, 0)`
    ).bind(partido.id, MINUTO_DESCANSO_AUTOMATICO).run();
  }
}

// Minuto real (de cronómetro) a partir del cual se considera que nadie
// va a cubrir ya el final del partido y el cron lo cierra solo. Subido
// de 100 a 150 (ver mismo cambio en worker/src/index.js) para dar mucho
// más margen antes de intervenir.
const MINUTO_FIN_PARTIDO_AUTOMATICO = 150;

// Minuto con el que se REGISTRA el evento "fin_partido" y el marcador
// del partido cuando lo cierra el cron (no el minuto real en el que se
// detecta, MINUTO_FIN_PARTIDO_AUTOMATICO). Ver comentario gemelo en
// worker/src/index.js.
const MINUTO_REGISTRADO_FIN_AUTOMATICO = 90;

// Revisa cada minuto los partidos "en_juego" cuyo cronómetro sigue
// corriendo y ya ha superado MINUTO_FIN_PARTIDO_AUTOMATICO, y les
// inserta el evento "fin_partido" (con el mismo efecto que pulsar el
// botón a mano: pasa el partido a 'finalizado', ver POST /eventos) solo
// si todavía no existe uno para ese partido. Igual que con el descanso,
// se limita a partidos con el cronómetro corriendo: si ya está pausado
// (por ejemplo en el descanso o una hidratación) no se toca -no hay
// riesgo de "colarse" cerrando un partido que solo está parado un
// momento-, y ese caso ya lo cubre revisarPartidosDesatendidos() con su
// propio aviso. Marca finalizado_no_cubierto = 1 (ver misma columna en
// worker/src/index.js) para el aviso "FINALIZADO NO CUBIERTO" del panel.
async function crearFinPartidoAutomaticoAlMinuto90(env) {
  const { results: partidos } = await env.DB.prepare(
    `SELECT id, inicio_cronometro_at, cronometro_pausado_en, ajuste_cronometro_minutos
     FROM results WHERE estado = 'en_juego' AND cronometro_pausado_en IS NULL`
  ).all();
  if (!partidos.length) return;

  for (const partido of partidos) {
    const minuto = minutoEnVivoServidor(partido);
    if (minuto < MINUTO_FIN_PARTIDO_AUTOMATICO) continue;

    const yaHuboFin = await env.DB.prepare(
      "SELECT id FROM match_events WHERE resultado_id = ? AND tipo = 'fin_partido' LIMIT 1"
    ).bind(partido.id).first();
    if (yaHuboFin) continue;

    await env.DB.prepare(
      `INSERT INTO match_events (resultado_id, tipo, equipo, minuto, orden) VALUES (?, 'fin_partido', 'ninguno', ?, 0)`
    ).bind(partido.id, MINUTO_REGISTRADO_FIN_AUTOMATICO).run();
    await env.DB.prepare(
      "UPDATE results SET estado = 'finalizado', aviso_desatendido_mitad = NULL, finalizado_no_cubierto = 1 WHERE id = ?"
    ).bind(partido.id).run();
  }
}

// ---------- MINUTO A MINUTO: aviso de partido "desatendido" ----------
// Detecta partidos que llevan el cronómetro corriendo (nadie ha pulsado
// "Descanso" ni "Fin del partido") mucho más allá de lo normal, señal
// de que el redactor asignado se ha despistado o se ha ido y el
// partido se ha quedado sin nadie cubriéndolo desde el panel. Antes de
// este aviso, un partido podía llegar al minuto 80 sin que se hubiera
// pitado ni el descanso porque nadie estaba mirando el panel.
//
// Dos situaciones se consideran "desatendido":
//   1) El cronómetro sigue corriendo (no pausado) y ya ha superado el
//      minuto UMBRAL_PRIMERA_PARTE_SIN_DESCANSO sin que exista un
//      evento "descanso" registrado: la primera parte no dura tanto en
//      ningún partido real, así que el reloj se ha "olvidado" corriendo.
//   2) El cronómetro está pausado en el descanso (evento "descanso" es
//      el último evento de tipo pausa) desde hace más de
//      UMBRAL_DESCANSO_SIN_REANUDAR minutos: el redactor no ha pulsado
//      "Iniciar 2ª parte".
// Se manda como máximo un aviso por email por cada mitad del partido
// (al autor del partido, con copia a EMAIL_NOTIFICACIONES si no tiene
// correo): uno para la 1ª parte y otro, independiente, para la 2ª. Se
// guarda en aviso_desatendido_mitad qué mitades ya han avisado, para no
// repetirlo cada minuto (el cron pasa cada minuto) ni tampoco varias
// veces dentro de la misma mitad si hay algún toque suelto de por medio
// -- así se evita mandar una "petada" de correos seguidos por un solo
// partido desatendido.
const UMBRAL_PRIMERA_PARTE_SIN_DESCANSO = 55; // minutos
const UMBRAL_SEGUNDA_PARTE_SIN_FINAL = 100; // minutos (aprox. 2ª parte + prórroga larga)
const UMBRAL_DESCANSO_SIN_REANUDAR = 25; // minutos parado en el descanso

// Umbral de partido "colgado": el cronómetro lleva corriendo días sin que
// nadie lo haya cerrado (bug, redactor que se fue de vacaciones, servidor
// que se cayó a mitad, etc.). 2000' son >33h de partido en juego, algo
// que nunca pasa en un partido real. A diferencia del aviso "desatendido"
// de arriba (que solo avisa), este caso ADEMÁS cambia el estado a
// 'colgado': como el frontend público filtra explícitamente por
// estado === "en_juego" en calendario.html, clasificacion.html y
// minuto-a-minuto.html, cambiar el estado basta para que el partido deje
// de aparecer como "en directo" en la web sin tocar nada del frontend.
// Sigue siendo consultable desde el panel de admin (que si no filtra por
// estado, lo trae igual) para que un admin lo revise y lo corrija a mano.
const UMBRAL_PARTIDO_COLGADO = 2000; // minutos

async function marcarPartidosColgados(env, ctx) {
  const { results: partidos } = await env.DB.prepare(
    `SELECT id, competicion, jornada, equipo_local, equipo_visitante, autor_id, autor_nombre,
            inicio_cronometro_at, cronometro_pausado_en, ajuste_cronometro_minutos
     FROM results WHERE estado = 'en_juego'`
  ).all();
  if (!partidos.length) return [];

  const idsColgados = [];
  for (const partido of partidos) {
    const minuto = minutoEnVivoServidor(partido);
    if (minuto < UMBRAL_PARTIDO_COLGADO) continue;

    await env.DB.prepare("UPDATE results SET estado = 'colgado' WHERE id = ?").bind(partido.id).run();
    idsColgados.push(partido.id);

    const nombrePartido = `${partido.equipo_local} - ${partido.equipo_visitante}`;
    const enlacePanel = `${SITIO_URL}/admin/minuto-a-minuto.html?id=${partido.id}`;
    const motivo = `El cronómetro lleva corriendo sin parar desde hace más de ${Math.floor(minuto / 60 / 24)} días (minuto ${minuto}) sin que se haya registrado el final del partido. Se ha ocultado automáticamente de la web mientras se revisa.`;

    let destinatario = EMAIL_NOTIFICACIONES;
    if (partido.autor_id) {
      const autor = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(partido.autor_id).first();
      if (autor?.email) destinatario = autor.email;
    }

    // Aviso deliberadamente distinto y más grave que el de "desatendido":
    // no es un despiste de unos minutos, es un partido que lleva DÍAS
    // colgado y ya se ha ocultado solo de la web -requiere intervención
    // manual sí o sí, no basta con seguir cubriéndolo-.
    const enviar = enviarEmailNotificacion(env, {
      asunto: `🚨 URGENTE: partido colgado y ocultado automáticamente: ${nombrePartido}`,
      texto: `${motivo}\n\nPartido: ${nombrePartido} (jornada ${partido.jornada})\nRedactor asignado: ${partido.autor_nombre || "sin asignar"}\n\nEntra al panel para corregir el estado del partido: ${enlacePanel}`,
      html: plantillaEmail({
        etiqueta: "🚨 Aviso urgente",
        titulo: "Partido colgado: ocultado automáticamente",
        parrafo: motivo,
        filas: [
          { etiqueta: "Partido", valor: nombrePartido },
          { etiqueta: "Jornada", valor: String(partido.jornada) },
          { etiqueta: "Redactor", valor: partido.autor_nombre || "Sin asignar" },
          { etiqueta: "Minutos corriendo", valor: String(minuto) },
        ],
        boton: { texto: "Revisar en el panel", url: enlacePanel },
      }),
    }, { destinatario });

    if (destinatario !== EMAIL_NOTIFICACIONES) {
      ctx.waitUntil(enviar);
      ctx.waitUntil(enviarEmailNotificacion(env, {
        asunto: `🚨 URGENTE: partido colgado y ocultado automáticamente: ${nombrePartido}`,
        texto: `${motivo}\n\nPartido: ${nombrePartido} (jornada ${partido.jornada})\nRedactor asignado: ${partido.autor_nombre || "sin asignar"}\n\nEntra al panel para corregir el estado del partido: ${enlacePanel}`,
      }, { destinatario: EMAIL_NOTIFICACIONES }));
    } else {
      ctx.waitUntil(enviar);
    }

    await registrarActividad(env, null, { uid: null, nombre: "Vigilancia de partidos", rol: "sistema" }, {
      accion: "partido_colgado_ocultado", entidad: "resultado", entidad_id: partido.id,
      descripcion: `Aviso urgente: ${nombrePartido} — ${motivo}`,
    });
  }
  return idsColgados;
}

function minutoEnVivoServidor(resultado) {
  if (resultado.cronometro_pausado_en !== null && resultado.cronometro_pausado_en !== undefined) {
    return resultado.cronometro_pausado_en;
  }
  if (!resultado.inicio_cronometro_at) return 0;
  const inicioMs = new Date(String(resultado.inicio_cronometro_at).replace(" ", "T") + "Z").getTime();
  if (isNaN(inicioMs)) return 0;
  const ajuste = Number.isInteger(resultado.ajuste_cronometro_minutos) ? resultado.ajuste_cronometro_minutos : 0;
  return Math.max(0, Math.floor((Date.now() - inicioMs) / 60000) + ajuste);
}

async function revisarPartidosDesatendidos(env, ctx) {
  // Los partidos ya marcados como 'colgado' (ver marcarPartidosColgados,
  // que corre justo antes en el cron) se excluyen aquí para no duplicar
  // avisos: ese caso ya manda su propio email, más urgente, y ya no
  // está en estado 'en_juego' de todas formas.
  const { results: partidos } = await env.DB.prepare(
    `SELECT id, competicion, jornada, equipo_local, equipo_visitante, autor_id, autor_nombre,
            inicio_cronometro_at, cronometro_pausado_en, ajuste_cronometro_minutos,
            aviso_desatendido_mitad
     FROM results WHERE estado = 'en_juego'`
  ).all();
  if (!partidos.length) return;

  for (const partido of partidos) {
    const corriendo = partido.cronometro_pausado_en === null || partido.cronometro_pausado_en === undefined;
    const minuto = minutoEnVivoServidor(partido);

    // A qué mitad del partido pertenece la situación de riesgo detectada,
    // para repartir como mucho un aviso por mitad (ver comentario de la
    // columna aviso_desatendido_mitad) en vez de un único aviso para todo
    // el partido: así un partido que se queda desatendido en la 1ª parte
    // y luego, tras retomarlo, vuelve a quedarse desatendido en la 2ª,
    // puede avisar de nuevo esa segunda vez en lugar de quedarse callado.
    let motivo = null;
    let mitad = null;
    if (corriendo && minuto >= UMBRAL_SEGUNDA_PARTE_SIN_FINAL) {
      motivo = `El cronómetro sigue corriendo y ya marca el minuto ${minuto} sin que se haya registrado el final del partido.`;
      mitad = "segunda";
    } else if (corriendo && minuto >= UMBRAL_PRIMERA_PARTE_SIN_DESCANSO) {
      const yaHuboDescanso = await env.DB.prepare(
        "SELECT id FROM match_events WHERE resultado_id = ? AND tipo = 'descanso' LIMIT 1"
      ).bind(partido.id).first();
      if (!yaHuboDescanso) {
        motivo = `El cronómetro sigue corriendo y ya marca el minuto ${minuto} sin que se haya pitado el descanso.`;
        mitad = "primera";
      } else {
        // Ya hubo descanso pero el cronómetro sigue corriendo por encima
        // del umbral de la 1ª parte: en realidad ya estamos en la 2ª.
        motivo = `El cronómetro sigue corriendo y ya marca el minuto ${minuto} sin que se haya registrado el final del partido.`;
        mitad = "segunda";
      }
    } else if (!corriendo) {
      const ultimaPausa = await env.DB.prepare(
        `SELECT tipo, created_at FROM match_events WHERE resultado_id = ? AND tipo IN ('descanso', 'pausa_hidratacion')
         ORDER BY id DESC LIMIT 1`
      ).bind(partido.id).first();
      if (ultimaPausa && ultimaPausa.tipo === "descanso") {
        const desdeMs = new Date(String(ultimaPausa.created_at).replace(" ", "T") + "Z").getTime();
        const minutosParado = isNaN(desdeMs) ? 0 : Math.floor((Date.now() - desdeMs) / 60000);
        if (minutosParado >= UMBRAL_DESCANSO_SIN_REANUDAR) {
          motivo = `El partido lleva parado en el descanso ${minutosParado} minutos sin que se haya iniciado la 2ª parte.`;
          // El descanso es la frontera entre mitades: se cuenta como
          // aviso de la 1ª parte (es el cierre pendiente de esa mitad).
          mitad = "primera";
        }
      }
    }

    const mitadesAvisadas = (partido.aviso_desatendido_mitad || "").split("_").filter(Boolean);

    if (!motivo) {
      // Si el partido ya no está en situación de riesgo pero se había
      // avisado antes, no se toca nada: cada mitad solo se limpia
      // cuando termina el partido o se reinicia desde cero (abajo),
      // así no se vuelve a avisar dentro de la misma mitad nada más
      // resolverse un despiste puntual.
      continue;
    }
    if (mitadesAvisadas.includes(mitad)) continue; // ya avisado en esta mitad, no se repite

    const nuevoValor = [...new Set([...mitadesAvisadas, mitad])].join("_");
    await env.DB.prepare("UPDATE results SET aviso_desatendido_mitad = ? WHERE id = ?").bind(nuevoValor, partido.id).run();

    let destinatario = EMAIL_NOTIFICACIONES;
    if (partido.autor_id) {
      const autor = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(partido.autor_id).first();
      if (autor?.email) destinatario = autor.email;
    }
    const nombrePartido = `${partido.equipo_local} - ${partido.equipo_visitante}`;
    const enlacePanel = `${SITIO_URL}/admin/minuto-a-minuto.html?id=${partido.id}`;

    const enviar = enviarEmailNotificacion(env, {
      asunto: `⚠️ Partido posiblemente sin cubrir: ${nombrePartido}`,
      texto: `${motivo}\n\nPartido: ${nombrePartido} (jornada ${partido.jornada})\nRedactor asignado: ${partido.autor_nombre || "sin asignar"}\n\nRevisa el panel de Minuto a Minuto: ${enlacePanel}`,
      html: plantillaEmail({
        etiqueta: "Aviso automático",
        titulo: "Partido posiblemente sin cubrir",
        parrafo: motivo,
        filas: [
          { etiqueta: "Partido", valor: nombrePartido },
          { etiqueta: "Jornada", valor: String(partido.jornada) },
          { etiqueta: "Redactor", valor: partido.autor_nombre || "Sin asignar" },
        ],
        boton: { texto: "Abrir Minuto a Minuto", url: enlacePanel },
      }),
    }, { destinatario });

    // Si el aviso va al autor, se manda también copia a la cuenta
    // general de notificaciones para que un admin pueda intervenir
    // aunque el redactor no vea el correo a tiempo.
    if (destinatario !== EMAIL_NOTIFICACIONES) {
      ctx.waitUntil(enviar);
      ctx.waitUntil(enviarEmailNotificacion(env, {
        asunto: `⚠️ Partido posiblemente sin cubrir: ${nombrePartido}`,
        texto: `${motivo}\n\nPartido: ${nombrePartido} (jornada ${partido.jornada})\nRedactor asignado: ${partido.autor_nombre || "sin asignar"}\n\nRevisa el panel de Minuto a Minuto: ${enlacePanel}`,
      }, { destinatario: EMAIL_NOTIFICACIONES }));
    } else {
      ctx.waitUntil(enviar);
    }

    await registrarActividad(env, null, { uid: null, nombre: "Vigilancia de partidos", rol: "sistema" }, {
      accion: "aviso_partido_desatendido", entidad: "resultado", entidad_id: partido.id,
      descripcion: `Aviso automático: ${nombrePartido} — ${motivo}`,
    });
  }
}

async function publicarArticulosProgramados(env) {
  const { results: pendientes } = await env.DB.prepare(
    `SELECT id, slug, titulo, subtitulo, tipo, categoria, club, autor_nombre, coautor_nombre, imagen_url
     FROM articles
     WHERE publicado = 0 AND programado_para IS NOT NULL AND programado_para <= datetime('now')`
  ).all();

  for (const articulo of pendientes) {
    const fechaPublicacion = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE articles SET publicado = 1, programado_para = NULL, slug_congelado = 1, fecha_publicacion = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).bind(articulo.id).run();

    const tipoLabel = { noticia: "Noticia", cronica: "Crónica", opinion: "Opinión", entrevista: "Entrevista" }[articulo.tipo] || "Artículo";
    const firmaAutores = articulo.coautor_nombre ? `${articulo.autor_nombre} y ${articulo.coautor_nombre}` : articulo.autor_nombre;

    await enviarEmailNotificacion(env, {
      asunto: `Nueva ${tipoLabel.toLowerCase()} publicada (programada): ${articulo.titulo}`,
      texto: `Se ha publicado automáticamente, tal y como estaba programada, "${articulo.titulo}" (${tipoLabel}) en ELOTROFÚTBOLTV, firmada por ${firmaAutores}.\n\nVerla en la web: ${urlNoticia(articulo.categoria, articulo.slug)}`,
      html: plantillaEmail({
        etiqueta: `Nueva ${tipoLabel.toLowerCase()} (programada)`,
        titulo: articulo.titulo,
        parrafo: articulo.subtitulo || null,
        filas: [
          { etiqueta: "Autor", valor: firmaAutores },
          { etiqueta: "Categoría", valor: articulo.club || articulo.categoria },
        ],
        boton: { texto: "Ver la noticia", url: urlNoticia(articulo.categoria, articulo.slug) },
      }),
    });

    await registrarActividad(env, null, { uid: null, nombre: "Publicación programada", rol: "sistema" }, {
      accion: "publicar_articulo_programado", entidad: "articulo", entidad_id: articulo.slug,
      descripcion: `Se ha publicado automáticamente, tal y como estaba programada, "${tipoLabel.toLowerCase()}": "${articulo.titulo}"`,
    });
  }
}
// ================================================================
// ALERTA DE CUOTA DIARIA DE D1 (prevención tras el aviso del
// 1-sep-2026: la cuenta agotó las 5.000.000 lecturas/día gratuitas de
// D1 y la web entera cayó en failover a Railway durante horas sin que
// nadie se enterara hasta revisar los logs a mano).
//
// Consulta la GraphQL Analytics API de Cloudflare (requiere los
// secretos CF_API_TOKEN y CF_ACCOUNT_ID, ver README) para saber cuántas
// filas se han leído de D1 en las últimas 24h, y manda un email de
// aviso si se supera el 80% del límite gratuito. Esta llamada NO
// consume cuota de D1 (es a la API de Cloudflare, no a la base de
// datos), así que es segura de hacer con frecuencia; aun así se limita
// a una vez por hora (guardado en settings) para no ser ruidosa ni
// generar tráfico de más sin necesidad.
//
// Un solo aviso por umbral y por día (guardado en settings) para no
// mandar un email cada hora una vez superado el 80%.
// ================================================================
const LIMITE_DIARIO_D1_FILAS_LEIDAS = 5_000_000;
const UMBRAL_AVISO_CUOTA_D1 = 0.8; // avisa al superar el 80% del límite

async function comprobarCuotaD1SiToca(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    // Sin credenciales configuradas: no es un error, simplemente esta
    // comprobación está desactivada hasta que se configuren los
    // secretos (ver README, sección "Alerta de cuota de D1").
    return;
  }

  try {
    const ultimaComprobacion = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'ultima_comprobacion_cuota_d1'"
    ).first();
    if (ultimaComprobacion?.value) {
      const minutosDesde = (Date.now() - new Date(ultimaComprobacion.value).getTime()) / 60000;
      // Antes cada 1h: un pico como el del 1-sep-2026 (13M filas en un
      // día) puede agotar la cuota entera en minutos, así que el aviso
      // por email llegaba tarde para servir de nada. 15 min reduce ese
      // margen sin disparar demasiadas llamadas a la API de Cloudflare
      // (esta llamada no consume cuota de D1, solo tráfico normal).
      if (minutosDesde < 15) return;
    }

    // Guardamos la marca de "comprobado ahora" ANTES de llamar a la API
    // externa: si la llamada falla o tarda, no queremos que el próximo
    // disparo del cron (dentro de 1 minuto) lo intente otra vez de
    // inmediato -- una comprobación por hora es más que suficiente y
    // así no se amontonan llamadas si la API de Cloudflare responde
    // lenta.
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('ultima_comprobacion_cuota_d1', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(new Date().toISOString()).run();

    const consulta = `
      query {
        viewer {
          accounts(filter: { accountTag: "${env.CF_ACCOUNT_ID}" }) {
            d1AnalyticsAdaptiveGroups(
              limit: 1
              filter: { datetime_geq: "${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}" }
            ) {
              sum { readQueries rowsRead }
            }
          }
        }
      }
    `;

    const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.CF_API_TOKEN}`,
      },
      body: JSON.stringify({ query: consulta }),
    });

    if (!resp.ok) {
      console.error(`[cuota-d1] La API de Cloudflare respondió ${resp.status} al pedir analíticas.`);
      return;
    }

    const datos = await resp.json();
    if (datos.errors?.length) {
      console.error("[cuota-d1] Error de GraphQL:", JSON.stringify(datos.errors));
      return;
    }

    const grupos = datos?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups || [];
    const filasLeidas = grupos.reduce((acc, g) => acc + (g.sum?.rowsRead || 0), 0);
    const porcentaje = filasLeidas / LIMITE_DIARIO_D1_FILAS_LEIDAS;

    console.log(`[cuota-d1] Filas leídas últimas 24h: ${filasLeidas.toLocaleString("es-ES")} (${(porcentaje * 100).toFixed(1)}% del límite gratuito).`);

    if (porcentaje < UMBRAL_AVISO_CUOTA_D1) return;

    // Un solo aviso por día natural (UTC, que es cuando D1 resetea la
    // cuota), aunque el cron siga comprobando cada hora mientras el
    // consumo se mantenga alto.
    const hoyUTC = new Date().toISOString().slice(0, 10);
    const ultimoAviso = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'ultimo_aviso_cuota_d1_fecha'"
    ).first();
    if (ultimoAviso?.value === hoyUTC) return;

    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('ultimo_aviso_cuota_d1_fecha', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(hoyUTC).run();

    const filasFmt = filasLeidas.toLocaleString("es-ES");
    const limiteFmt = LIMITE_DIARIO_D1_FILAS_LEIDAS.toLocaleString("es-ES");
    await enviarEmailNotificacion(env, {
      asunto: `⚠️ Aviso: D1 al ${(porcentaje * 100).toFixed(0)}% de su cuota diaria gratuita`,
      texto: `La base de datos D1 de ElOtroFútbolTV ha leído ${filasFmt} filas en las últimas 24h, ` +
        `un ${(porcentaje * 100).toFixed(0)}% del límite gratuito diario (${limiteFmt}).\n\n` +
        `Si se supera el 100%, la web entera empezará a fallar en 500 y pasará automáticamente a ` +
        `servir desde la copia de Railway (con datos desactualizados) hasta que la cuota se resetee ` +
        `a medianoche UTC.\n\n` +
        `Revisa el panel de Analíticas: si alguien lo ha usado con el filtro de 365 días, suele ser ` +
        `la causa más probable de un pico así.`,
      html: plantillaEmail({
        etiqueta: "⚠️ Aviso de cuota",
        titulo: "D1 se acerca a su límite diario",
        parrafo: `Se han leído ${filasFmt} de ${limiteFmt} filas permitidas hoy (${(porcentaje * 100).toFixed(0)}%). ` +
          `Si se agota, la web caerá en failover a Railway con datos desactualizados hasta medianoche UTC.`,
        filas: [
          { etiqueta: "Filas leídas (24h)", valor: filasFmt },
          { etiqueta: "Límite diario gratuito", valor: limiteFmt },
          { etiqueta: "Porcentaje consumido", valor: `${(porcentaje * 100).toFixed(1)}%` },
        ],
      }),
    }, { destinatario: EMAIL_NOTIFICACIONES });
  } catch (error) {
    console.error("[cuota-d1] Error al comprobar la cuota:", error);
  }
}



const FAILOVER_HEADER = "X-Failover-Backend";
const FAILOVER_TEST_HEADER = "X-Failover-Test";
const FAILOVER_REASON_HEADER = "X-Failover-Reason";

// ---------- Aviso de datos desfasados durante failover ----------
// Complementa la cabecera X-Data-Staleness-Warning (pasiva, solo visible
// si alguien mira las devtools): manda un email cuando el failover lleva
// sirviendo datos con más de 30 min de desfase, para que no dependa de
// que alguien esté mirando en ese momento -- mismo patrón anti-spam que
// comprobarCuotaD1SiToca (un aviso cada 30 min, guardado en settings).
async function avisarStalenessSiToca(env, staleForMsTexto) {
  try {
    const ultimoAviso = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'ultimo_aviso_staleness_failover'"
    ).first();
    const ahora = Date.now();
    if (ultimoAviso?.value) {
      const minutosDesde = (ahora - new Date(ultimoAviso.value).getTime()) / 60000;
      if (minutosDesde < 30) return;
    }
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('ultimo_aviso_staleness_failover', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(new Date(ahora).toISOString()).run();

    const staleForMs = parseInt(staleForMsTexto || "0", 10);
    const minutos = Math.round(staleForMs / 60000);
    await enviarEmailNotificacion(env, {
      asunto: `⚠️ Failover activo sirviendo datos con ${minutos} min de desfase`,
      texto: `La web está sirviendo desde Railway (failover) y el sincronizador D1->Postgres ` +
        `lleva aproximadamente ${minutos} minutos sin avanzar. Esto significa que los datos que ` +
        `ven los usuarios ahora mismo pueden estar desactualizados por ese tiempo.\n\n` +
        `Revisa que sync/scheduler.mjs siga corriendo en Railway y que D1 no siga agotado más ` +
        `tiempo del esperado. Si D1 ya se ha recuperado, el sincronizador debería ponerse al día ` +
        `solo; si el desfase sigue creciendo, es señal de que el proceso está caído.`,
    });
  } catch (err) {
    console.error("[staleness-aviso] fallo al comprobar/enviar (no crítico):", err);
  }
}


// ================================================================
// El aviso por email (comprobarCuotaD1SiToca, arriba) solo informa: si
// un pico de lecturas ocurre entre dos comprobaciones (cada 1h), la
// cuota se agota igualmente antes de que llegue el email. Esto añade
// un límite que SÍ corta tráfico:
//
// 1. CACHÉ_ANALITICAS: cada sub-ruta de /api/admin/analiticas/* se
//    cachea en KV durante CACHE_ANALITICAS_TTL_SEGUNDOS. Si el admin
//    recarga el panel 20 veces seguidas, D1 solo se consulta una vez
//    por ventana de caché, sin perder utilidad real (los números de
//    analíticas no cambian segundo a segundo).
//
// 2. RANGO MÁXIMO: ?dias=365 puede escanear un año entero de
//    article_views/article_reading. Se capa a RANGO_ANALITICAS_MAX_DIAS
//    salvo que se pida explícitamente vía header interno (no vía
//    querystring, para que no sea un simple "cambia la URL").
//
// 3. CORTACIRCUITOS GLOBAL: un contador en KV (incrementado en cada
//    petición a una ruta "pesada") que, al superar un umbral horario,
//    fuerza que esas rutas devuelvan 503 en vez de seguir golpeando
//    D1. Se autorrepara solo (el contador expira) sin intervención
//    manual -- a diferencia del modo mantenimiento manual de hoy.
//
// Todo esto vive en KV (ELOTROFUTBOL_KV), no en D1: consultarlo NO
// consume cuota de lecturas de D1.
// ================================================================

const RANGO_ANALITICAS_MAX_DIAS = 90;
const CACHE_ANALITICAS_TTL_SEGUNDOS = 600; // 10 minutos

// Presupuesto horario de peticiones a rutas "pesadas" (analíticas y
// cualquier otra que se registre con protegerRutaPesada). No es un
// conteo exacto de filas D1 (eso solo lo sabe Cloudflare a posteriori),
// sino un límite preventivo de cuántas veces se puede golpear una ruta
// cara por hora -- suficiente para frenar tanto un bucle/bot como un
// admin dejando el dashboard en autorefresco.
const LIMITE_PETICIONES_PESADAS_POR_HORA = 60;

// Incrementa el contador de la ventana horaria actual para `clave` y
// devuelve true si YA se ha superado el límite (es decir: hay que
// cortar y no tocar D1). Falla "abierto" (deja pasar) si KV no está
// configurado o falla, para que un problema de KV nunca tumbe el sitio
// entero -- el cortacircuitos es una capa extra, no la única defensa.
async function superaLimitePeticionesPesadas(env, clave) {
  if (!env.ELOTROFUTBOL_KV) return false;
  try {
    const ventana = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const kvKey = `cortacircuitos:${clave}:${ventana}`;
    const actual = parseInt((await env.ELOTROFUTBOL_KV.get(kvKey)) || "0", 10);
    if (actual >= LIMITE_PETICIONES_PESADAS_POR_HORA) return true;
    await env.ELOTROFUTBOL_KV.put(kvKey, String(actual + 1), { expirationTtl: 3600 });
    return false;
  } catch (err) {
    console.error("[cortacircuitos] fallo al comprobar KV, dejando pasar:", err);
    return false;
  }
}

// Envuelve una ruta cara en caché de KV: si hay una respuesta reciente
// guardada bajo `cacheKey`, la devuelve sin tocar D1; si no, ejecuta
// `generar` (que sí consulta D1), guarda el resultado y lo devuelve.
async function conCacheKV(env, cacheKey, ttlSegundos, generar) {
  if (env.ELOTROFUTBOL_KV) {
    try {
      const cacheado = await env.ELOTROFUTBOL_KV.get(cacheKey, "json");
      if (cacheado) return { datos: cacheado, deCache: true };
    } catch (err) {
      console.error("[cache-kv] fallo al leer, se consulta D1:", err);
    }
  }
  const datos = await generar();
  if (env.ELOTROFUTBOL_KV) {
    try {
      await env.ELOTROFUTBOL_KV.put(cacheKey, JSON.stringify(datos), { expirationTtl: ttlSegundos });
    } catch (err) {
      console.error("[cache-kv] fallo al guardar (no crítico):", err);
    }
  }
  return { datos, deCache: false };
}

// ---------- Consultas reales de cada sub-ruta de analíticas ----------
// Extraídas a funciones aparte (mismo SQL de siempre, sin cambios) para
// poder envolver cada una en conCacheKV desde el router sin duplicar
// las queries. `desde` ya viene con el rango capado a
// RANGO_ANALITICAS_MAX_DIAS aplicado por el router.

async function calcularResumenAnaliticas(env, desde) {
  const kpis = await env.DB.prepare(
    `SELECT
       COUNT(*) AS paginas_vistas,
       COUNT(DISTINCT visitante_hash) AS visitantes,
       COUNT(DISTINCT article_id) AS noticias_con_vistas
     FROM article_views WHERE created_at >= ${desde}`
  ).first();

  const lectura = await env.DB.prepare(
    `SELECT AVG(segundos) AS media_segundos, AVG(scroll_maximo) AS media_scroll
     FROM article_reading WHERE created_at >= ${desde}`
  ).first();

  const { results: evolucion } = await env.DB.prepare(
    `SELECT date(created_at) AS fecha,
            COUNT(*) AS vistas,
            COUNT(DISTINCT visitante_hash) AS visitantes
     FROM article_views
     WHERE created_at >= ${desde}
     GROUP BY date(created_at)
     ORDER BY fecha ASC`
  ).all();

  const { results: dispositivosFilas } = await env.DB.prepare(
    `SELECT dispositivo, COUNT(*) AS vistas
     FROM article_views WHERE created_at >= ${desde}
     GROUP BY dispositivo`
  ).all();

  const dispositivos = { movil: 0, escritorio: 0, tablet: 0 };
  for (const fila of dispositivosFilas || []) {
    if (fila.dispositivo in dispositivos) dispositivos[fila.dispositivo] = Number(fila.vistas) || 0;
  }

  return {
    vistas: kpis?.paginas_vistas || 0,
    visitantes: kpis?.visitantes || 0,
    noticias_con_vistas: kpis?.noticias_con_vistas || 0,
    tiempo_medio_segundos: Math.round(lectura?.media_segundos || 0),
    completitud: Math.round((lectura?.media_scroll || 0) * 10) / 10,
    evolucion_diaria: evolucion || [],
    dispositivos,
    kpis: {
      paginas_vistas: kpis?.paginas_vistas || 0,
      visitantes: kpis?.visitantes || 0,
      noticias_con_vistas: kpis?.noticias_con_vistas || 0,
      tiempo_medio_lectura_segundos: Math.round(lectura?.media_segundos || 0),
    },
  };
}

async function calcularMasLeidasAnaliticas(env, desde, limit) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.slug, a.titulo, a.categoria, a.autor_nombre,
            COUNT(v.id) AS vistas,
            COUNT(DISTINCT v.visitante_hash) AS visitantes,
            (SELECT AVG(r.segundos) FROM article_reading r WHERE r.article_id = a.id AND r.created_at >= ${desde}) AS tiempo_medio_segundos
     FROM article_views v
     JOIN articles a ON a.id = v.article_id
     WHERE v.created_at >= ${desde}
     GROUP BY a.id
     ORDER BY vistas DESC
     LIMIT ?`
  ).bind(limit).all();
  return { noticias: (results || []).map((n) => ({ ...n, tiempo_medio_segundos: Math.round(n.tiempo_medio_segundos || 0) })) };
}

async function calcularFuentesAnaliticas(env, desde) {
  const { results } = await env.DB.prepare(
    `SELECT fuente, COUNT(*) AS vistas
     FROM article_views WHERE created_at >= ${desde}
     GROUP BY fuente ORDER BY vistas DESC`
  ).all();
  const { results: referidos } = await env.DB.prepare(
    `SELECT referer_dominio AS dominio, fuente, COUNT(*) AS vistas
     FROM article_views
     WHERE created_at >= ${desde} AND referer_dominio IS NOT NULL
     GROUP BY referer_dominio, fuente ORDER BY vistas DESC LIMIT 15`
  ).all();
  return { fuentes: results || [], dominios: referidos || [] };
}

async function calcularAutoresAnaliticas(env, desde) {
  // Ver la versión gemela en worker/src/index.js (D1) para la
  // explicación completa: se quita el "WHERE id IN (?,?,?...)" con un
  // parámetro por artículo (rompía el límite de 100 parámetros
  // bindeados de D1 con tráfico real) en favor de un JOIN. Vistas y
  // lecturas se siguen agregando por separado para evitar el fan-out de
  // un doble JOIN (articles x article_views x article_reading).
  const { results: vistasPorArticulo } = await env.DB.prepare(
    `SELECT a.id, a.autor_nombre, COUNT(v.id) AS vistas
     FROM article_views v
     JOIN articles a ON a.id = v.article_id
     WHERE v.created_at >= ${desde} AND a.autor_nombre IS NOT NULL
     GROUP BY a.id, a.autor_nombre`
  ).all();
  if (!vistasPorArticulo || vistasPorArticulo.length === 0) return { autores: [] };

  const { results: lecturasPorArticulo } = await env.DB.prepare(
    `SELECT article_id, AVG(segundos) AS tiempo_medio_segundos
     FROM article_reading WHERE created_at >= ${desde}
     GROUP BY article_id`
  ).all();

  const lecturaPorId = new Map((lecturasPorArticulo || []).map((r) => [r.article_id, r.tiempo_medio_segundos]));

  const porAutor = new Map();
  for (const art of vistasPorArticulo) {
    const acumulado = porAutor.get(art.autor_nombre) || { autor: art.autor_nombre, noticias: 0, vistas: 0, sumaTiempo: 0, conTiempo: 0 };
    acumulado.noticias += 1;
    acumulado.vistas += Number(art.vistas) || 0;
    const tiempo = lecturaPorId.get(art.id);
    if (tiempo != null) { acumulado.sumaTiempo += tiempo; acumulado.conTiempo += 1; }
    porAutor.set(art.autor_nombre, acumulado);
  }

  const autores = [...porAutor.values()]
    .map((a) => ({
      autor: a.autor,
      noticias: a.noticias,
      vistas: a.vistas,
      tiempo_medio_segundos: Math.round(a.conTiempo ? a.sumaTiempo / a.conTiempo : 0),
    }))
    .sort((a, b) => b.vistas - a.vistas);

  return { autores };
}

async function calcularTiempoLecturaAnaliticas(env, desde) {
  const { results } = await env.DB.prepare(
    `SELECT a.categoria,
            AVG(r.segundos) AS tiempo_medio_segundos,
            COUNT(r.id) AS lecturas,
            AVG(r.scroll_maximo) AS scroll_medio
     FROM article_reading r
     JOIN articles a ON a.id = r.article_id
     WHERE r.created_at >= ${desde}
     GROUP BY a.categoria
     ORDER BY tiempo_medio_segundos DESC`
  ).all();
  return {
    categorias: (results || []).map((c) => ({
      ...c,
      tiempo_medio_segundos: Math.round(c.tiempo_medio_segundos || 0),
      scroll_medio: Math.round(c.scroll_medio || 0),
    })),
  };
}

// ---------- Idiomas más usados al leer una noticia ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa.
const NOMBRES_IDIOMA = { es: "Castellano", eu: "Euskera", ca: "Català", gl: "Galego", en: "English" };
async function calcularIdiomasAnaliticas(env, desde) {
  const { results } = await env.DB.prepare(
    `SELECT idioma, COUNT(*) AS vistas
     FROM article_views WHERE created_at >= ${desde}
     GROUP BY idioma ORDER BY vistas DESC`
  ).all();
  const total = (results || []).reduce((suma, fila) => suma + (Number(fila.vistas) || 0), 0);
  return {
    idiomas: (results || []).map((fila) => ({
      idioma: fila.idioma,
      nombre: NOMBRES_IDIOMA[fila.idioma] || fila.idioma,
      vistas: Number(fila.vistas) || 0,
      porcentaje: total ? Math.round(((Number(fila.vistas) || 0) / total) * 1000) / 10 : 0,
    })),
  };
}

// ---------- Partidos más seguidos (minuto a minuto) ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa.
async function calcularPartidosMasSeguidosAnaliticas(env, desde, limit) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.competicion, r.grupo, r.jornada, r.equipo_local, r.equipo_visitante,
            r.goles_local, r.goles_visitante, r.estado, r.fecha_partido,
            COUNT(v.id) AS vistas,
            COUNT(DISTINCT v.visitante_hash) AS visitantes
     FROM result_views v
     JOIN results r ON r.id = v.result_id
     WHERE v.created_at >= ${desde}
     GROUP BY r.id
     ORDER BY vistas DESC
     LIMIT ?`
  ).bind(limit).all();
  return { partidos: results || [] };
}

// ---------- Franja horaria con más tráfico ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa. substr() es SQL estándar (Postgres lo soporta como alias de
// substring), así que no necesita traducción en sql-compat.js.
async function calcularHorasAnaliticas(env, desde) {
  const { results } = await env.DB.prepare(
    `SELECT CAST(substr(created_at, 12, 2) AS INTEGER) AS hora, COUNT(*) AS vistas
     FROM article_views WHERE created_at >= ${desde}
     GROUP BY hora ORDER BY hora ASC`
  ).all();
  const porHora = new Map((results || []).map((f) => [Number(f.hora), Number(f.vistas) || 0]));
  const horas = [];
  for (let h = 0; h < 24; h++) horas.push({ hora: h, vistas: porHora.get(h) || 0 });
  return { horas };
}

// ---------- Rendimiento por tipo de artículo ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa.
async function calcularTiposAnaliticas(env, desde) {
  // Mismo fix que calcularCategoriasAnaliticas/calcularAutoresAnaliticas
  // (ver la versión gemela en worker/src/index.js, D1, para la
  // explicación completa): sin "WHERE id IN (?,?,?...)" dinámico.
  const { results: vistasPorArticulo } = await env.DB.prepare(
    `SELECT a.id, a.tipo,
            COUNT(v.id) AS vistas,
            COUNT(DISTINCT v.visitante_hash) AS visitantes
     FROM article_views v
     JOIN articles a ON a.id = v.article_id
     WHERE v.created_at >= ${desde}
     GROUP BY a.id, a.tipo`
  ).all();
  if (!vistasPorArticulo || vistasPorArticulo.length === 0) return { tipos: [] };

  const { results: lecturasPorArticulo } = await env.DB.prepare(
    `SELECT article_id, AVG(segundos) AS tiempo_medio_segundos
     FROM article_reading WHERE created_at >= ${desde}
     GROUP BY article_id`
  ).all();

  const lecturaPorId = new Map((lecturasPorArticulo || []).map((r) => [r.article_id, r.tiempo_medio_segundos]));

  const porTipo = new Map();
  for (const art of vistasPorArticulo) {
    const tipo = art.tipo || "noticia";
    const acumulado = porTipo.get(tipo) || { tipo, noticias: 0, vistas: 0, visitantes: 0, sumaTiempo: 0, conTiempo: 0 };
    acumulado.noticias += 1;
    acumulado.vistas += Number(art.vistas) || 0;
    acumulado.visitantes += Number(art.visitantes) || 0;
    const tiempo = lecturaPorId.get(art.id);
    if (tiempo != null) { acumulado.sumaTiempo += tiempo; acumulado.conTiempo += 1; }
    porTipo.set(tipo, acumulado);
  }

  const tipos = [...porTipo.values()]
    .map((t) => ({
      tipo: t.tipo,
      noticias: t.noticias,
      vistas: t.vistas,
      visitantes: t.visitantes,
      tiempo_medio_segundos: Math.round(t.conTiempo ? t.sumaTiempo / t.conTiempo : 0),
    }))
    .sort((a, b) => b.vistas - a.vistas);

  return { tipos };
}

// ---------- Engagement por scroll ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa.
async function calcularEngagementScrollAnaliticas(env, desde) {
  const fila = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN scroll_maximo >= 75 THEN 1 ELSE 0 END) AS t_75_100,
       SUM(CASE WHEN scroll_maximo >= 50 AND scroll_maximo < 75 THEN 1 ELSE 0 END) AS t_50_75,
       SUM(CASE WHEN scroll_maximo >= 25 AND scroll_maximo < 50 THEN 1 ELSE 0 END) AS t_25_50,
       SUM(CASE WHEN scroll_maximo < 25 OR scroll_maximo IS NULL THEN 1 ELSE 0 END) AS t_0_25
     FROM article_reading WHERE created_at >= ${desde}`
  ).first();
  return {
    total: Number(fila?.total) || 0,
    tramos: {
      "75_100": Number(fila?.t_75_100) || 0,
      "50_75": Number(fila?.t_50_75) || 0,
      "25_50": Number(fila?.t_25_50) || 0,
      "0_25": Number(fila?.t_0_25) || 0,
    },
  };
}

// ---------- Vistas últimas 24 horas ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa. datetime('now', '-1 days') lo traduce sql-compat.js a
// (CURRENT_TIMESTAMP + INTERVAL '-1 days').
async function calcularUltimas24hAnaliticas(env) {
  const { results } = await env.DB.prepare(
    `SELECT substr(created_at, 1, 13) AS hora_cubo, COUNT(*) AS vistas
     FROM article_views
     WHERE created_at >= datetime('now', '-1 days')
     GROUP BY hora_cubo ORDER BY hora_cubo ASC`
  ).all();
  const porCubo = new Map((results || []).map((f) => [f.hora_cubo, Number(f.vistas) || 0]));

  const horas = [];
  const ahora = new Date();
  for (let i = 23; i >= 0; i--) {
    const fecha = new Date(ahora.getTime() - i * 3600 * 1000);
    const cubo = fecha.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    const cuboEspacio = cubo.replace("T", " ");
    horas.push({ hora: `${cubo}:00`, vistas: porCubo.get(cuboEspacio) || porCubo.get(cubo) || 0 });
  }
  return { horas };
}

// ---------- Buscador de noticia por titular ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa.
async function calcularBuscarNoticiaAnaliticas(env, desde, q) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.slug, a.titulo, a.tipo, a.categoria, a.autor_nombre,
            COUNT(v.id) AS vistas,
            COUNT(DISTINCT v.visitante_hash) AS visitantes,
            AVG(r.segundos) AS tiempo_medio_segundos,
            AVG(r.scroll_maximo) AS scroll_medio
     FROM articles a
     LEFT JOIN article_views v ON v.article_id = a.id AND v.created_at >= ${desde}
     LEFT JOIN article_reading r ON r.article_id = a.id AND r.created_at >= ${desde}
     WHERE a.titulo LIKE ?
     GROUP BY a.id
     ORDER BY vistas DESC
     LIMIT 20`
  ).bind(`%${q}%`).all();
  return {
    noticias: (results || []).map((n) => ({
      ...n,
      vistas: Number(n.vistas) || 0,
      visitantes: Number(n.visitantes) || 0,
      tiempo_medio_segundos: Math.round(n.tiempo_medio_segundos || 0),
      scroll_medio: Math.round(n.scroll_medio || 0),
    })),
  };
}

// ---------- Rendimiento por categoría ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa: se quita el "WHERE id IN (?,?,?...)" con un parámetro por
// artículo (rompía el límite de 100 parámetros bindeados de D1 con
// tráfico real) en favor de un único JOIN.
async function calcularCategoriasAnaliticas(env, desde) {
  const { results } = await env.DB.prepare(
    `SELECT a.categoria,
            COUNT(v.id) AS vistas,
            COUNT(DISTINCT v.visitante_hash) AS visitantes,
            COUNT(DISTINCT a.id) AS noticias
     FROM article_views v
     JOIN articles a ON a.id = v.article_id
     WHERE v.created_at >= ${desde}
     GROUP BY a.categoria
     ORDER BY vistas DESC`
  ).all();

  const categorias = (results || []).map((c) => ({
    categoria: c.categoria || "general",
    noticias: Number(c.noticias) || 0,
    vistas: Number(c.vistas) || 0,
    visitantes: Number(c.visitantes) || 0,
  }));
  return { categorias };
}

// ---------- Lectores nuevos vs. recurrentes ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa: visitante_hash no sirve para esto (incluye el día a
// propósito), se usa visitante_estable en su lugar.
async function calcularRecurrenciaAnaliticas(env, desde) {
  const { results } = await env.DB.prepare(
    `SELECT visitante_estable, COUNT(DISTINCT date(created_at)) AS dias_distintos
     FROM article_views WHERE created_at >= ${desde} AND visitante_estable IS NOT NULL
     GROUP BY visitante_estable`
  ).all();
  let nuevos = 0;
  let recurrentes = 0;
  for (const fila of results || []) {
    if (Number(fila.dias_distintos) > 1) recurrentes += 1;
    else nuevos += 1;
  }
  return { nuevos, recurrentes };
}

// ---------- Borrado de datos de tracking ----------
// Ver la versión gemela en worker/src/index.js (D1) para la explicación
// completa.
async function borrarDatosAnaliticas(env, { todo, dias }) {
  if (todo) {
    const fila = await env.DB.prepare(`SELECT COUNT(*) AS n FROM article_views`).first();
    await env.DB.prepare(`DELETE FROM article_views`).run();
    return { filas_borradas: Number(fila?.n) || 0 };
  }
  const desde = `datetime('now', '-${dias} days')`;
  const fila = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM article_views WHERE created_at >= ${desde}`
  ).first();
  await env.DB.prepare(`DELETE FROM article_views WHERE created_at >= ${desde}`).run();
  return { filas_borradas: Number(fila?.n) || 0 };
}

export default {
  // Expuestas también como propiedades del handler (no solo usadas
  // dentro de "scheduled" más abajo) para que server-railway.js pueda
  // dispararlas bajo demanda desde /api/internal/cron-respaldo, sin
  // depender de que Railway tenga soporte nativo de "cron trigger" como
  // Cloudflare Workers -- ver ese endpoint para el porqué completo.
  publicarArticulosProgramados,
  iniciarPartidosProgramadosCuyaHoraHaLlegado,
  marcarPartidosColgados,
  revisarPartidosDesatendidos,
  enviarBoletinSemanalSiToca,

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    ORIGEN_PETICION_ACTUAL = request.headers.get("Origin");

    /*
     * ============================================================
     * CORS
     * ============================================================
     */

    if (method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    /*
     * ============================================================
     * MODO MANTENIMIENTO TEMPORAL
     *
     * Activado a mano mientras D1 tiene la cuota diaria de lecturas
     * agotada (1-sep-2026, ver aviso). Se desactiva solo comentando o
     * borrando la variable MAINTENANCE_MODE en wrangler.toml (o en el
     * dashboard de Cloudflare, sin necesitar redeploy si se cambia ahí).
     * No afecta a /api/internal/* (drain-pending-writes, cron-respaldo)
     * para no romper la sincronización con Railway mientras tanto, ni al
     * bypass con el header X-Maintenance-Bypass para poder seguir
     * probando desde el panel de admin.
     * ============================================================
     */
    if (
      env.MAINTENANCE_MODE === "true" &&
      !path.startsWith("/api/internal/") &&
      request.headers.get("X-Maintenance-Bypass") !== env.MAINTENANCE_BYPASS_SECRET
    ) {
      // Servimos el MISMO archivo mantenimiento.html que usa el sitio
      // (public/mantenimiento.html, en el otro proyecto de Cloudflare,
      // el Worker "elotrofutboltv"). Como este Worker de la API no tiene
      // acceso directo a esos archivos (son proyectos distintos, sin
      // binding ASSETS aquí), lo pedimos por HTTP a
      // https://elotrofutbol.media/mantenimiento.html. Así solo hay que
      // editar un archivo para que el diseño de mantenimiento cambie en
      // los dos sitios a la vez.
      // Si esa petición fallara (el frontend caído, timeout, etc.), no
      // dejamos la API sin respuesta: usamos paginaMantenimiento() como
      // reserva, que genera un HTML equivalente sin depender de nada
      // externo.
      let html;
      try {
        const respuestaSitio = await fetch("https://elotrofutbol.media/mantenimiento.html", {
          cf: { cacheTtl: 0 },
        });
        // OJO: el propio sitio devuelve mantenimiento.html con status 503
        // (no 200) cuando está en mantenimiento, así que NO comprobamos
        // response.ok aquí -- comprobamos que haya contenido de verdad.
        const texto = await respuestaSitio.text();
        if (!texto || texto.length < 100) throw new Error("Respuesta vacía o demasiado corta");
        // El sitio (Pages) ya inyecta MAINTENANCE_DESDE en su propia
        // copia de MAINTENANCE_DESDE (ver public/_worker.js), así que
        // normalmente esto llega ya resuelto. Por si acaso ese proyecto
        // no lo hubiera sustituido (versión desincronizada), lo
        // resolvemos también aquí con la variable de ESTE Worker, para
        // que la barra de progreso nunca se quede con el placeholder
        // literal sin sustituir.
        html = texto.includes("__MAINTENANCE_DESDE_ISO__")
          ? texto.replace("__MAINTENANCE_DESDE_ISO__", escapeHtmlEmail(env.MAINTENANCE_DESDE || ""))
          : texto;
      } catch (err) {
        html = paginaMantenimiento(env.MAINTENANCE_HASTA || null, env.MAINTENANCE_DESDE || null);
      }
      return new Response(html, {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Retry-After": "3600",
          "Cache-Control": "no-store",
        },
      });
    }

    /*
     * ============================================================
     * CORTACIRCUITOS DE RUTAS PESADAS (prevención dura de cuota D1)
     *
     * Antes de llegar a cualquier ruta de /api/admin/analiticas, se
     * comprueba el presupuesto horario en KV. Si se ha superado, se
     * corta aquí con 503 sin ejecutar ninguna consulta a D1 -- esto es
     * lo que evita que un pico (bucle, bot, admin con autorefresco)
     * repita lo de hoy, en vez de solo avisar por email después de que
     * ya haya pasado. Ver comprobarCuotaD1SiToca para el aviso, y
     * conCacheKV/RANGO_ANALITICAS_MAX_DIAS para las otras dos capas.
     * ============================================================
     */
    if (path.startsWith("/api/admin/analiticas")) {
      if (await superaLimitePeticionesPesadas(env, "analiticas")) {
        return json(
          {
            error:
              "Panel de analíticas temporalmente limitado para proteger la cuota de la base de datos. Inténtalo de nuevo en unos minutos.",
          },
          503
        );
      }
    }

    /*
     * ============================================================
     * SITEMAP DE NOTICIAS
     *
     * GET /sitemap-noticias.xml
     *
     * El sitemap.xml estático de /public solo lista páginas fijas
     * (portada, categorías...) porque no puede conocer las noticias, que
     * viven en la base de datos. Este endpoint genera al vuelo el sitemap
     * de todas las noticias publicadas, para que robots.txt pueda
     * apuntarlo y Google las descubra sin depender solo de enlaces
     * internos.
     *
     * Cacheado 1 hora (incluso en el propio Cloudflare, vía "cache:" de
     * fetch) porque un sitemap no necesita estar al segundo: lo importante
     * es que exista y se actualice con regularidad, no en tiempo real.
     * ============================================================
     */

    if (path === "/sitemap-noticias.xml" && method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          `SELECT slug, titulo, categoria, imagen_url, imagenes, fecha_publicacion, updated_at FROM articles
           WHERE publicado = 1
           ORDER BY fecha_publicacion DESC
           LIMIT 50000`
        ).all();

        const urls = results.map((articulo) => {
          const lastmod = fechaParaSitemap(articulo.updated_at || articulo.fecha_publicacion);

          // Extensión "image:" del protocolo de sitemaps: además de la
          // <loc> de la noticia, se listan sus imágenes para que Google
          // las pueda indexar en Google Imágenes aunque no las rastree
          // desde la propia página. Se juntan "imagen_url" (portada) y el
          // array JSON "imagenes", sin duplicados.
          let listaImagenes = [];
          try {
            const adicionales = articulo.imagenes ? JSON.parse(articulo.imagenes) : [];
            // Los tweets incrustados (tipo:"tweet") no son fotos: se
            // excluyen para no meter la URL de un tweet como si fuera una
            // imagen en el sitemap.
            listaImagenes = [articulo.imagen_url, ...(Array.isArray(adicionales) ? adicionales.filter((v) => !(v && v.tipo === "tweet")) : [])]
              .filter(Boolean);
          } catch {
            listaImagenes = articulo.imagen_url ? [articulo.imagen_url] : [];
          }
          listaImagenes = [...new Set(listaImagenes)];

          const bloquesImagen = listaImagenes.map((src) => [
            "    <image:image>",
            `      <image:loc>${escaparXml(src)}</image:loc>`,
            articulo.titulo ? `      <image:caption>${escaparXml(articulo.titulo)}</image:caption>` : null,
            "    </image:image>",
          ].filter(Boolean).join("\n")).join("\n");

          return [
            "  <url>",
            `    <loc>${escaparXml(urlNoticia(articulo.categoria, articulo.slug))}</loc>`,
            lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
            "    <changefreq>weekly</changefreq>",
            "    <priority>0.6</priority>",
            bloquesImagen || null,
            "  </url>",
          ].filter(Boolean).join("\n");
        }).join("\n");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="https://www.google.com/schemas/sitemap-image/1.1">\n${urls}\n</urlset>\n`;

        return cors(new Response(xml, {
          status: 200,
          headers: {
            "Content-Type": "application/xml; charset=UTF-8",
            "Cache-Control": "public, max-age=3600",
          },
        }));
      } catch (err) {
        // Si la base de datos falla, mejor devolver un sitemap vacío pero
        // válido que un error 500: así un rastreador que llegue en ese
        // momento no ve un sitemap "roto", solo uno sin URLs esta vez.
        return cors(new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n`,
          { status: 200, headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "no-store" } }
        ));
      }
    }

    /*
     * ============================================================
     * GOOGLE NEWS SITEMAP
     *
     * GET /sitemap-news.xml
     *
     * El sitemap normal (/sitemap-noticias.xml) sirve para que Google
     * indexe las noticias en la búsqueda normal, pero para aparecer en
     * Google News específicamente hace falta un sitemap con el
     * namespace "news" (news:publication, news:publication_date,
     * news:title) y, según la propia especificación de Google, con
     * SOLO las noticias de las últimas 48 horas (a diferencia del
     * sitemap normal, que lista todo el histórico). Un artículo con más
     * de 48h simplemente deja de aparecer aquí sin que eso afecte a su
     * indexación normal, que sigue cubierta por /sitemap-noticias.xml.
     * ============================================================
     */

    if (path === "/sitemap-news.xml" && method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          `SELECT slug, titulo, categoria, fecha_publicacion FROM articles
           WHERE publicado = 1
             AND fecha_publicacion >= datetime('now', '-48 hours')
           ORDER BY fecha_publicacion DESC
           LIMIT 1000`
        ).all();

        const urls = results.map((articulo) => {
          // news:publication_date exige fecha+hora en formato W3C
          // (ISO 8601), no la fecha simple "YYYY-MM-DD" que usa
          // <lastmod> en el sitemap normal.
          const fecha = new Date(
            articulo.fecha_publicacion.includes("T") || articulo.fecha_publicacion.endsWith("Z")
              ? articulo.fecha_publicacion
              : `${articulo.fecha_publicacion.replace(" ", "T")}Z`
          );
          if (Number.isNaN(fecha.getTime())) return null;

          return [
            "  <url>",
            `    <loc>${escaparXml(urlNoticia(articulo.categoria, articulo.slug))}</loc>`,
            "    <news:news>",
            "      <news:publication>",
            "        <news:name>ELOTROFÚTBOLTV</news:name>",
            "        <news:language>es</news:language>",
            "      </news:publication>",
            `      <news:publication_date>${fecha.toISOString()}</news:publication_date>`,
            `      <news:title>${escaparXml(articulo.titulo)}</news:title>`,
            articulo.categoria ? `      <news:keywords>${escaparXml(articulo.categoria)}</news:keywords>` : null,
            "    </news:news>",
            "  </url>",
          ].filter(Boolean).join("\n");
        }).filter(Boolean).join("\n");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="https://www.google.com/schemas/sitemap-news/0.9">\n${urls}\n</urlset>\n`;

        return cors(new Response(xml, {
          status: 200,
          headers: {
            "Content-Type": "application/xml; charset=UTF-8",
            // Cacheado más corto que el sitemap normal: al depender de
            // una ventana móvil de 48h, conviene refrescarlo más a
            // menudo para que un artículo recién cumplidas las 48h
            // desaparezca sin esperar una hora entera.
            "Cache-Control": "public, max-age=600",
          },
        }));
      } catch (err) {
        return cors(new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="https://www.google.com/schemas/sitemap-news/0.9"></urlset>\n`,
          { status: 200, headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "no-store" } }
        ));
      }
    }

    /*
     * ============================================================
     * FEED RSS
     *
     * GET /rss.xml
     *
     * RSS 2.0 estándar con las últimas noticias publicadas, para
     * agregadores (Google News, lectores RSS, otros medios que enlacen
     * la web). Mismo patrón y mismo cacheado que /sitemap-noticias.xml:
     * se genera al vuelo desde la base de datos y se cachea 1 hora,
     * porque un feed no necesita estar al segundo.
     * ============================================================
     */

    if (path === "/rss.xml" && method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          `SELECT slug, titulo, subtitulo, contenido, categoria, autor_nombre, fecha_publicacion, updated_at
           FROM articles
           WHERE publicado = 1
           ORDER BY fecha_publicacion DESC
           LIMIT 100`
        ).all();

        const items = results.map((articulo) => {
          const link = urlNoticia(articulo.categoria, articulo.slug);
          const pubDate = fechaParaRss(articulo.fecha_publicacion);
          const descripcion = articulo.subtitulo?.trim() || extractoTexto(articulo.contenido);
          return [
            "  <item>",
            `    <title>${escaparXml(articulo.titulo)}</title>`,
            `    <link>${link}</link>`,
            `    <guid isPermaLink="true">${link}</guid>`,
            descripcion ? `    <description>${escaparXml(descripcion)}</description>` : null,
            articulo.categoria ? `    <category>${escaparXml(articulo.categoria)}</category>` : null,
            articulo.autor_nombre ? `    <author>${escaparXml(articulo.autor_nombre)}</author>` : null,
            pubDate ? `    <pubDate>${pubDate}</pubDate>` : null,
            "  </item>",
          ].filter(Boolean).join("\n");
        }).join("\n");

        const ultimaActualizacion = fechaParaRss(results[0]?.updated_at || results[0]?.fecha_publicacion) || new Date().toUTCString();

        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="https://www.w3.org/2005/Atom">\n<channel>\n  <title>ELOTROFÚTBOLTV</title>\n  <link>https://elotrofutbol.media</link>\n  <description>Últimas noticias de fútbol modesto: Primera Federación, Segunda Federación y más.</description>\n  <language>es</language>\n  <lastBuildDate>${ultimaActualizacion}</lastBuildDate>\n  <atom:link href="https://elotrofutbol.media/rss.xml" rel="self" type="application/rss+xml" />\n${items}\n</channel>\n</rss>\n`;

        return cors(new Response(xml, {
          status: 200,
          headers: {
            "Content-Type": "application/rss+xml; charset=UTF-8",
            "Cache-Control": "public, max-age=3600",
          },
        }));
      } catch (err) {
        // Mismo criterio que el sitemap: mejor un feed vacío pero válido
        // que un error 500.
        return cors(new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>ELOTROFÚTBOLTV</title><link>https://elotrofutbol.media</link><description>Últimas noticias de fútbol modesto.</description></channel></rss>\n`,
          { status: 200, headers: { "Content-Type": "application/rss+xml; charset=UTF-8", "Cache-Control": "no-store" } }
        ));
      }
    }

    /*
     * ============================================================
     * FAILOVER_TEST
     *
     * FAILOVER_TEST=1
     *
     * NO ejecutamos el backend principal.
     * Mandamos la petición directamente a Railway.
     *
     * Esto permite comprobar que el failover funciona de verdad.
     * ============================================================
     */

    if (env.FAILOVER_TEST === "1") {
      console.log("[FAILOVER] TEST ACTIVADO → Railway");

      return await fetchRailway(
        request,
        path,
        "FAILOVER_TEST",
        env,
        ctx
      );
    }

    /*
     * ============================================================
     * HEALTH CHECK
     *
     * Este endpoint comprueba el backend PRINCIPAL.
     *
     * Si D1 funciona:
     *   200
     *
     * Si D1 falla:
     *   503
     *
     * Esto permite detectar que el backend principal está
     * realmente degradado.
     * ============================================================
     */

    if (path === "/api/health" && method === "GET") {
      try {
        const started = Date.now();

        await env.DB.prepare(
          "SELECT 1 AS ok"
        ).first();

        return json(
          {
            status: "ok",
            database: true,
            storage: null,
            responseTime: Date.now() - started,
            api: "primary",
            failover: false
          },
          200
        );
      } catch (error) {
        console.error("[health] D1 error:", error);

        return json(
          {
            status: "degraded",
            database: false,
            storage: null,
            responseTime: null,
            api: "primary",
            failover: false
          },
          503
        );
      }
    }

    /*
     * ============================================================
     * NEWSLETTER / BOLETÍN SEMANAL
     *
     * POST /api/newsletter/suscribir  { email }
     * GET  /api/newsletter/baja?token=...
     *
     * Suscripción pública desde el formulario de portada/pie de página.
     * Sin autenticación (cualquiera puede suscribirse), pero valida el
     * formato del email y no revela si un email ya estaba suscrito (para
     * no filtrar esa información a quien pruebe direcciones ajenas): en
     * ambos casos responde igual, éxito.
     * ============================================================
     */

    if (path === "/api/newsletter/suscribir" && method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "JSON inválido" }, 400);
      }
      const email = (body && body.email ? String(body.email) : "").trim().toLowerCase();
      if (!emailValido(email)) {
        return json({ error: "Introduce un email válido" }, 400);
      }
      try {
        const existente = await env.DB.prepare(
          "SELECT id, activo FROM newsletter_suscriptores WHERE email = ?"
        ).bind(email).first();
        if (existente) {
          if (!existente.activo) {
            await env.DB.prepare(
              "UPDATE newsletter_suscriptores SET activo = 1, baja_at = NULL WHERE id = ?"
            ).bind(existente.id).run();
          }
          return json({ ok: true });
        }
        await env.DB.prepare(
          "INSERT INTO newsletter_suscriptores (email, baja_token) VALUES (?, ?)"
        ).bind(email, generarTokenBaja()).run();
        return json({ ok: true });
      } catch (err) {
        console.error("[newsletter/suscribir]", err);
        return json({ error: "No se pudo completar la suscripción" }, 500);
      }
    }

    // ---------- Contacto de prensa ----------
    // Formulario público (página contacto.html): no requiere autenticación,
    // pero sí validación básica para no ser un vector fácil de spam/abuso.
    // No se guarda en base de datos (no hace falta un historial consultable
    // desde el panel todavía): se reenvía directamente por email al buzón
    // del medio vía Resend, igual que el resto de notificaciones.
    if (path === "/api/contacto-prensa" && method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "JSON inválido" }, 400);
      }
      const nombre = (body && body.nombre ? String(body.nombre) : "").trim().slice(0, 200);
      const email = (body && body.email ? String(body.email) : "").trim().toLowerCase();
      const medio = (body && body.medio ? String(body.medio) : "").trim().slice(0, 200);
      const mensaje = (body && body.mensaje ? String(body.mensaje) : "").trim().slice(0, 5000);

      if (!nombre) return json({ error: "Indica tu nombre" }, 400);
      if (!emailValido(email)) return json({ error: "Introduce un email válido" }, 400);
      if (!mensaje) return json({ error: "Escribe un mensaje" }, 400);

      try {
        const textoPlano = [
          `Nombre: ${nombre}`,
          `Email: ${email}`,
          medio ? `Medio/organización: ${medio}` : null,
          "",
          mensaje,
        ].filter((l) => l !== null).join("\n");

        await enviarEmailNotificacion(env, {
          asunto: `Contacto de prensa: ${nombre}`,
          texto: textoPlano,
          html: `<p><strong>Nombre:</strong> ${escapeHtmlEmail(nombre)}</p>
<p><strong>Email:</strong> ${escapeHtmlEmail(email)}</p>
${medio ? `<p><strong>Medio/organización:</strong> ${escapeHtmlEmail(medio)}</p>` : ""}
<p><strong>Mensaje:</strong></p>
<p>${escapeHtmlEmail(mensaje).replace(/\n/g, "<br>")}</p>`,
        });
        return json({ ok: true });
      } catch (err) {
        console.error("[contacto-prensa]", err);
        return json({ error: "No se pudo enviar el mensaje. Inténtalo de nuevo o escribe directamente a contacto@elotrofutbol.media." }, 500);
      }
    }

    if (path === "/api/newsletter/baja" && method === "GET") {
      const token = url.searchParams.get("token") || "";
      if (!token) return new Response("Enlace no válido.", { status: 400 });
      try {
        const res = await env.DB.prepare(
          "UPDATE newsletter_suscriptores SET activo = 0, baja_at = datetime('now') WHERE baja_token = ? AND activo = 1"
        ).bind(token).run();
        const huboBaja = res && res.meta && res.meta.changes > 0;
        return new Response(
          `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Baja del boletín</title></head>
           <body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#0c1b2e;">
             <h1 style="font-size:20px;">${huboBaja ? "Te has dado de baja" : "Ese enlace ya no es válido"}</h1>
             <p style="color:#5a6270;">${huboBaja ? "Ya no recibirás el boletín semanal de ELOTROFÚTBOLTV." : "Puede que ya te hubieras dado de baja antes."}</p>
             <p><a href="${SITIO_URL}" style="color:#d1132e;">Volver a la portada</a></p>
           </body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      } catch (err) {
        console.error("[newsletter/baja]", err);
        return new Response("No se pudo procesar la baja.", { status: 500 });
      }
    }

    /*
     * ============================================================
     * DRENAJE DE LA COLA DE ESCRITURAS PENDIENTES (secundaria -> D1)
     *
     * Invocado por Railway (worker-secondary/src/pending-writes.js /
     * sync/scheduler.mjs) cada vez que detecta que D1 ha vuelto a
     * responder. Reproduce, una a una y en orden de creación, las
     * escrituras que se atendieron en Postgres durante un failover y que
     * todavía no se aplicaron aquí -- ver db/migrations/003_pending_writes.sql
     * en worker-secondary para el porqué completo.
     *
     * Protegido por un secreto compartido (INTERNAL_SYNC_SECRET) en vez de
     * requireAuth normal: quien llama es el propio backend, no un usuario
     * con sesión, y este endpoint no debe ser alcanzable por el público.
     * ============================================================
     */

    if (path === "/api/internal/drain-pending-writes" && method === "POST") {
      return await drainPendingWrites(request, env, ctx);
    }

    /*
     * ============================================================
     * FUNCIONAMIENTO NORMAL
     *
     * Aquí debe ejecutarse el código ORIGINAL de tu Worker.
     *
     * IMPORTANTE:
     *
     * NO hagas:
     *
     * fetch("https://api.elotrofutbol.media/...")
     *
     * porque este Worker ya está detrás de ese dominio.
     *
     * Tu código principal debe ejecutarse directamente aquí.
     * ============================================================
     */

    // Cortacircuito por ruta (ver definición arriba, junto a
    // fetchRailway): si esta ruta+método viene fallando de forma
    // sostenida en el primario, se salta el intento y se va directo a
    // Railway, en vez de sumar un intento fallido al primario en CADA
    // petición mientras dura el problema.
    const circuitoInfo = await circuitoEstaAbierto(env, method, path);
    if (circuitoInfo.abierto) {
      return await fetchRailway(
        request,
        path,
        "CIRCUITO_ABIERTO",
        env,
        ctx
      );
    }

    try {
      const primaryResponse = await handlePrimary(
        request,
        env,
        ctx
      );

      /*
       * ==========================================================
       * RESPUESTA NORMAL DEL PRINCIPAL
       * ==========================================================
       *
       * 2xx / 3xx / 4xx:
       *
       * No hacemos failover.
       *
       * Solo hacemos failover ante errores 5xx.
       */

      if (primaryResponse.status < 500) {
        // Éxito (o al menos, no es un fallo del servidor): limpia
        // cualquier contador de fallos que hubiera para esta ruta. Se
        // hace con ctx.waitUntil porque no es algo que deba retrasar la
        // respuesta al usuario -es limpieza de estado, no parte de la
        // respuesta en sí-.
        ctx.waitUntil(circuitoRegistrarExitoPrimario(env, method, path, circuitoInfo.habiaRegistro));

        const headers = new Headers(
          primaryResponse.headers
        );

        headers.set(
          FAILOVER_HEADER,
          "PRIMARY"
        );

        headers.set(
          FAILOVER_TEST_HEADER,
          "false"
        );

        return new Response(
          primaryResponse.body,
          {
            status: primaryResponse.status,
            statusText: primaryResponse.statusText,
            headers
          }
        );
      }

      /*
       * ==========================================================
       * PRINCIPAL RESPONDE 5XX
       *
       * → RAILWAY
       * ==========================================================
       */

      let cuerpoErrorPrimario = "";
      try {
        cuerpoErrorPrimario = await primaryResponse.clone().text();
      } catch (e) {
        cuerpoErrorPrimario = `[no se pudo leer el body: ${e.message}]`;
      }
      console.error(
        `[FAILOVER] Principal respondió ${primaryResponse.status}. ` +
        `Activando Railway. Body: ${cuerpoErrorPrimario}`
      );

      // Igual que el éxito de arriba: no debe retrasar la respuesta al
      // usuario, así que se registra en segundo plano. El failover a
      // Railway de ESTA petición ya se decide con el contador actual
      // (antes de sumar este fallo); el efecto de este fallo se nota a
      // partir de la SIGUIENTE petición a la misma ruta.
      ctx.waitUntil(circuitoRegistrarFalloPrimario(env, method, path));

      return await fetchRailway(
        request,
        path,
        `PRIMARY_${primaryResponse.status}`,
        env,
        ctx
      );

    } catch (primaryError) {

      /*
       * ==========================================================
       * ERROR DE EJECUCIÓN DEL PRINCIPAL
       *
       * → RAILWAY
       * ==========================================================
       */

      console.error(
        "[FAILOVER] Error en backend principal:",
        primaryError
      );

      ctx.waitUntil(circuitoRegistrarFalloPrimario(env, method, path));

      return await fetchRailway(
        request,
        path,
        "PRIMARY_EXCEPTION",
        env,
        ctx
      );
    }
  },

  // Disparador programado (cron trigger, ver "crons" en wrangler.toml):
  // revisa cada minuto si hay alguna noticia programada cuya hora ya ha
  // llegado y, si es así, la publica sola sin que nadie tenga que entrar
  // al panel a esa hora.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(publicarArticulosProgramados(env));
    ctx.waitUntil(iniciarPartidosProgramadosCuyaHoraHaLlegado(env));
    ctx.waitUntil(crearDescansoAutomaticoAlMinuto45(env));
    ctx.waitUntil(crearFinPartidoAutomaticoAlMinuto90(env));
    // marcarPartidosColgados va ANTES de revisarPartidosDesatendidos:
    // pasa a 'colgado' los partidos con más de 2000' corriendo, para que
    // ya no aparezcan como 'en_juego' cuando se ejecute la revisión de
    // "desatendido" justo después y no se dupliquen los avisos.
    ctx.waitUntil(marcarPartidosColgados(env, ctx).then(() => revisarPartidosDesatendidos(env, ctx)));
    ctx.waitUntil(enviarBoletinSemanalSiToca(env));
    // Comprobación de cuota de D1 (ver "ALERTA DE CUOTA DIARIA DE D1"
    // más abajo). Se autolimita a una vez por hora internamente, así
    // que es seguro dejarla en el cron de cada minuto.
    ctx.waitUntil(comprobarCuotaD1SiToca(env));
  },
};


/*
 * ================================================================
 * EJECUTAR RAILWAY
 * ================================================================
 */

/*
 * ================================================================
 * DRENAJE DE LA COLA DE ESCRITURAS PENDIENTES
 *
 * Railway (worker-secondary) es quien guarda la cola en Postgres, porque
 * el Worker de Cloudflare no puede abrir una conexión TCP normal a
 * Postgres (el driver "pg" necesita sockets que el runtime de Workers no
 * ofrece salvo la API específica de cloudflare:sockets, que "pg" no usa).
 * Por eso el flujo es al revés de lo que sería más natural: Railway LEE su
 * propia cola y la EMPUJA aquí por HTTP, en vez de que el Worker vaya a
 * buscarla.
 *
 * Body esperado: { writes: [{ write_id, method, path, query_string, body,
 * authorization_header }, ...] }, en el mismo orden en que se crearon (así
 * dos escrituras sobre el mismo registro se aplican en el orden correcto).
 *
 * Para cada una se construye un Request sintético y se llama directamente
 * a handlePrimary -- la MISMA función que atiende peticiones normales, con
 * las mismas validaciones y checks de permiso, para no crear un segundo
 * camino de escritura con reglas distintas.
 *
 * Devuelve el resultado de cada intento para que Railway actualice su cola
 * (applied/failed) -- este endpoint no borra ni modifica pending_writes,
 * eso es responsabilidad exclusiva de quien la guarda.
 * ================================================================
 */
async function drainPendingWrites(request, env, ctx) {
  const secretEsperado = env.INTERNAL_SYNC_SECRET;
  if (!secretEsperado) {
    // Fallo cerrado: si no hay secreto configurado, este endpoint no debe
    // aceptar NADA, ni siquiera con una cabecera vacía coincidiendo con
    // "undefined" por error de configuración en ambos lados.
    return json({ error: "Endpoint interno no configurado" }, 503);
  }
  const secretRecibido = request.headers.get("X-Internal-Sync-Secret");
  if (!secretRecibido || secretRecibido !== secretEsperado) {
    return json({ error: "No autorizado" }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const writes = Array.isArray(payload?.writes) ? payload.writes : [];
  if (writes.length === 0) return json({ results: [] });
  // Límite defensivo: un lote descontrolado (p.ej. un bug generando miles
  // de filas) no debe poder tumbar esta invocación ni consumir todo el CPU
  // time del Worker. Railway simplemente manda el resto en la siguiente
  // llamada (se ejecuta cada vez que detecta que D1 volvió).
  const LOTE_MAXIMO = 50;
  const lote = writes.slice(0, LOTE_MAXIMO);

  const resultados = [];
  for (const w of lote) {
    if (!w || !w.write_id || !w.method || !w.path) {
      resultados.push({ write_id: w?.write_id ?? null, status: "failed", result_status: null, result_body: "Entrada de cola inválida (faltan campos)" });
      continue;
    }
    try {
      const urlInterna = `https://internal.elotrofutbol.media${w.path}${w.query_string || ""}`;
      const headers = new Headers();
      if (w.authorization_header) headers.set("Authorization", w.authorization_header);
      headers.set("Content-Type", "application/json");
      // Mismo write_id que, si esta escritura creó una fila en Postgres
      // durante el failover, ya se guardó en su columna origin_write_id
      // (ver server-railway.js/pending-writes.js). Al reproducirla aquí
      // contra D1 con el mismo id, la fila que D1 cree (si es un INSERT)
      // queda etiquetada igual, y sync/incremental.mjs puede reconciliarla
      // con la de Postgres en vez de duplicarla -- ver
      // worker/migracion_origin_write_id.sql para el porqué completo.
      if (w.write_id) headers.set("X-Write-Id", w.write_id);
      const reqSintetico = new Request(urlInterna, {
        method: w.method,
        headers,
        body: (w.method === "GET" || w.method === "HEAD") ? undefined : (w.body ?? undefined),
      });
      const resp = await handlePrimary(reqSintetico, env, ctx);
      const cuerpoResp = await resp.text().catch(() => "");
      resultados.push({
        write_id: w.write_id,
        status: resp.status < 400 ? "applied" : "failed",
        result_status: resp.status,
        // Se trunca por si el error incluye algo largo (stack, HTML de
        // error genérico); esto es solo para diagnóstico en pending_writes.
        result_body: cuerpoResp.slice(0, 2000),
      });
    } catch (error) {
      console.error(`[drain-pending-writes] error reproduciendo ${w.method} ${w.path}:`, error);
      resultados.push({
        write_id: w.write_id,
        status: "failed",
        result_status: null,
        result_body: String(error?.message || error).slice(0, 2000),
      });
    }
  }

  return json({ results: resultados });
}

// ============================================================
// CORTACIRCUITO DE FAILOVER POR RUTA (server-side, en KV)
// ============================================================
//
// Contexto del problema: sin esto, cada petición individual que llega al
// Worker mientras UNA ruta concreta está devolviendo 5xx en el primario
// (p.ej. un bug puntual en /api/polls/portada, o D1 con un problema
// aislado a esa consulta) intentaba SIEMPRE primero contra el primario
// -que fallaba- y LUEGO hacía failover a Railway. Con tráfico sostenido a
// alta frecuencia contra esa misma ruta (un bucle de reintentos del
// cliente, un bot, o simplemente mucho tráfico normal coincidiendo con el
// fallo), esto duplica el trabajo en cada petición: un intento fallido al
// primario más una petición completa a Railway, sin ningún límite. Es lo
// que se vio en producción el 2026-09-04: ~30 peticiones/segundo a
// /api/polls/portada, cada una golpeando primario Y Railway, sostenido
// varios minutos -Railway terminó con "Killed" (OOM) por la carga real
// generada, no por logs.
//
// Nótese que esto es DISTINTO del circuit breaker que ya existe en el
// navegador (public/js/config.js, eofApiState): aquel vive en memoria de
// cada pestaña del navegador y solo protege a ESE cliente. Este vive en
// KV (compartido entre TODOS los isolates del Worker, en todas las
// regiones) y protege al propio backend de tener que intentar el
// primario en cada petición de CUALQUIER cliente mientras una ruta está
// claramente caída.
//
// Diseño (a propósito más simple que el del navegador, sin "half-open"):
//   - Se cuenta, en KV, cuántos 5xx consecutivos ha dado el primario para
//     una ruta+método concretos (normalizando IDs numéricos en la ruta,
//     ver normalizarRutaParaCircuito, para que /api/articles/123 y
//     /api/articles/456 compartan contador -si no, un bucle que varía el
//     ID nunca acumularía fallos "de la misma ruta").
//   - Al llegar a CIRCUITO_FALLOS_PARA_ABRIR, se guarda una marca "abierto
//     hasta <timestamp>" con TTL en KV.
//   - Mientras el circuito esté abierto para esa ruta, las peticiones
//     entrantes se envían DIRECTAMENTE a Railway, sin intentar el
//     primario -así se evita el doble trabajo, y el primario deja de
//     recibir presión de una ruta que ya se sabe que está fallando,
//     dándole margen para recuperarse en vez de seguir recibiendo el
//     mismo volumen de tráfico que causó/acompaña el problema-.
//   - Pasado CIRCUITO_ABIERTO_MS, la siguiente petición vuelve a intentar
//     el primario (sin contador de "medio abierto": si vuelve a fallar,
//     se reabre inmediatamente con el próximo fallo).
//   - Un solo 5xx aislado NO abre el circuito (evita que un error puntual
//     tumbe la ruta entera durante 20s); hace falta que se repita.
//
// Todo esto es "best effort": si KV falla o no está disponible, se
// comporta exactamente como antes (intenta primario en cada petición) --
// nunca debe ser la causa de que una petición no se atienda.
const CIRCUITO_FALLOS_PARA_ABRIR = 5;
const CIRCUITO_ABIERTO_MS = 20_000;
const CIRCUITO_KV_PREFIX = "circuito:";

// Caché en memoria del isolate (no en KV) del último resultado "circuito
// cerrado, sin registro" para cada ruta+método, con vida muy corta. Un
// mismo isolate de Cloudflare Workers atiende muchas peticiones seguidas
// mientras está caliente, y la inmensa mayoría son a las mismas rutas de
// siempre (home, artículo, resultados...) con el circuito cerrado casi
// siempre. Sin este caché, cada una de esas peticiones hace su propio
// get() a KV aunque la respuesta vaya a ser la misma que hace 200ms.
// Con un TTL de un par de segundos no se pierde capacidad de reacción
// real (abrir el circuito sigue tardando como mucho eso de más en
// notarse) pero se evita repetir la misma lectura de KV muchísimas veces
// por segundo en tráfico alto. Solo se cachea el caso "cerrado y sin
// registro" (el 99% de las veces): en cuanto haya CUALQUIER registro en
// KV para una ruta (fallos acumulados, o circuito abierto) se deja de
// usar este caché para esa ruta y se consulta KV en cada petición, para
// no arriesgarse a servir un "cerrado" cacheado mientras el circuito
// real ya está abierto.
const CIRCUITO_CACHE_ISOLATE_TTL_MS = 2000;
const circuitoCacheIsolate = new Map();

function normalizarRutaParaCircuito(path) {
  // Los IDs numéricos varían por petición pero deben compartir contador
  // (/api/articles/123, /api/articles/456 -> /api/articles/:id). Sin
  // esto, un bucle contra distintos IDs de una ruta con bug nunca
  // acumularía suficientes fallos para abrir el circuito.
  return path.replace(/\/\d+(?=\/|$)/g, "/:id");
}

function claveCircuito(method, path) {
  return `${CIRCUITO_KV_PREFIX}${method}:${normalizarRutaParaCircuito(path)}`;
}

// Devuelve { abierto, habiaRegistro }: "abierto" es lo que ya se usaba
// para decidir si saltar al failover; "habiaRegistro" indica si existía
// CUALQUIER entrada en KV para esta ruta+método (esté abierta o solo con
// fallos acumulados sin llegar a abrir). Se usa para evitar un DELETE de
// KV innecesario en cada petición exitosa (ver circuitoRegistrarExitoPrimario
// más abajo): en el caso normal (ruta sana, sin fallos previos) no hay
// nada que limpiar, así que no hace falta la escritura. Antes se
// llamaba a delete() en TODAS las peticiones con éxito -es decir,
// prácticamente todo el tráfico del sitio, al pasar este worker por
// delante de cada petición- aunque el 99% de las veces no había ninguna
// clave que borrar; cada delete() cuenta como una operación de
// escritura en KV igual que un put(), así que esto por sí solo disparaba
// el consumo de KV muy por encima de lo necesario.
async function circuitoEstaAbierto(env, method, path) {
  if (!env.ELOTROFUTBOL_KV) return { abierto: false, habiaRegistro: false };
  const clave = claveCircuito(method, path);
  const cacheado = circuitoCacheIsolate.get(clave);
  if (cacheado && Date.now() < cacheado.expiraEn) {
    return { abierto: false, habiaRegistro: false };
  }
  try {
    const valor = await env.ELOTROFUTBOL_KV.get(clave);
    if (!valor) {
      circuitoCacheIsolate.set(clave, { expiraEn: Date.now() + CIRCUITO_CACHE_ISOLATE_TTL_MS });
      return { abierto: false, habiaRegistro: false };
    }
    const datos = JSON.parse(valor);
    const abierto = typeof datos.abiertoHasta === "number" && Date.now() < datos.abiertoHasta;
    return { abierto, habiaRegistro: true };
  } catch (error) {
    // No dejar que un fallo leyendo KV bloquee la petición: se comporta
    // como si el circuito estuviera cerrado (intenta primario, como
    // siempre se ha hecho).
    console.warn("[circuito] no se pudo leer estado, se asume cerrado:", error.message);
    return { abierto: false, habiaRegistro: false };
  }
}

async function circuitoRegistrarFalloPrimario(env, method, path) {
  if (!env.ELOTROFUTBOL_KV) return;
  const clave = claveCircuito(method, path);
  // Invalida el caché en memoria del isolate: a partir de ahora esta
  // ruta sí tiene un registro real en KV (fallos acumulados o circuito
  // abierto), así que las próximas peticiones deben volver a consultar
  // KV en cada una, no servir el "cerrado" cacheado (ver
  // circuitoEstaAbierto y el comentario junto a CIRCUITO_CACHE_ISOLATE_TTL_MS).
  circuitoCacheIsolate.delete(clave);
  try {
    const actual = await env.ELOTROFUTBOL_KV.get(clave);
    const datos = actual ? JSON.parse(actual) : { fallos: 0, abiertoHasta: 0 };
    // Si el circuito ya estaba abierto, este fallo no suma al contador de
    // "fallos consecutivos para abrir" -ya está abierto-, pero si acaba
    // de expirar el TTL de apertura anterior, se trata como un fallo
    // nuevo tras haber estado cerrado.
    const yaAbierto = Date.now() < datos.abiertoHasta;
    const nuevosFallos = yaAbierto ? datos.fallos : datos.fallos + 1;
    const abrirAhora = nuevosFallos >= CIRCUITO_FALLOS_PARA_ABRIR;
    const nuevoEstado = {
      fallos: abrirAhora ? 0 : nuevosFallos, // se resetea el contador al abrir
      abiertoHasta: abrirAhora ? Date.now() + CIRCUITO_ABIERTO_MS : datos.abiertoHasta,
    };
    // TTL generoso (el doble del tiempo que el circuito puede estar
    // abierto): suficiente para que la clave sobreviva mientras el
    // circuito está abierto, pero sin dejar contadores de fallos
    // colgados en KV indefinidamente si la ruta se recupera y no vuelve
    // a fallar.
    await env.ELOTROFUTBOL_KV.put(clave, JSON.stringify(nuevoEstado), {
      expirationTtl: Math.ceil((CIRCUITO_ABIERTO_MS * 2) / 1000),
    });
    if (abrirAhora && !yaAbierto) {
      console.warn(
        `[circuito] ABIERTO para ${method} ${normalizarRutaParaCircuito(path)} tras ` +
        `${CIRCUITO_FALLOS_PARA_ABRIR} fallos consecutivos del primario. ` +
        `Las próximas peticiones a esta ruta irán directas a Railway durante ${CIRCUITO_ABIERTO_MS / 1000}s.`
      );
    }
  } catch (error) {
    console.warn("[circuito] no se pudo registrar fallo:", error.message);
  }
}

// Solo borra la clave si de verdad existía (habiaRegistro=true), para no
// gastar una escritura de KV en el caso normal (ruta sana, nunca ha
// fallado, no hay nada que limpiar) -- ver el comentario en
// circuitoEstaAbierto. Antes se llamaba siempre, sin comprobar antes si
// hacía falta.
async function circuitoRegistrarExitoPrimario(env, method, path, habiaRegistro) {
  if (!env.ELOTROFUTBOL_KV || !habiaRegistro) return;
  const clave = claveCircuito(method, path);
  try {
    // Un éxito limpia el contador de fallos por completo (no hace falta
    // esperar un TTL): la ruta ha demostrado estar sana de nuevo.
    await env.ELOTROFUTBOL_KV.delete(clave);
  } catch (error) {
    // No es crítico: el peor caso es que el contador tarde un poco más
    // en resetearse (el TTL de arriba lo limpia de todas formas).
  }
}

// Resumen periódico del volumen de peticiones que van a Railway por
// tener el circuito abierto (ver fetchRailway más abajo). Vive en
// memoria del isolate (no en KV): cada isolate de Cloudflare Workers es
// efímero y de corta vida, así que no hace falta compartir este contador
// entre isolates -es solo para no generar una línea de log por cada
// petición mientras dura un mismo isolate atendiendo tráfico hacia una
// ruta con el circuito abierto-.
const RESUMEN_FAILOVER_INTERVALO_MS = 30_000;
const contadorFailoverPorCircuito = { total: 0, timer: null };
function programarResumenFailoverPorCircuito() {
  if (contadorFailoverPorCircuito.timer) return;
  contadorFailoverPorCircuito.timer = setTimeout(() => {
    console.log(
      `[FAILOVER] ${contadorFailoverPorCircuito.total} petición(es) enviadas directas a Railway ` +
      `por circuito abierto en los últimos ${RESUMEN_FAILOVER_INTERVALO_MS / 1000}s.`
    );
    contadorFailoverPorCircuito.total = 0;
    contadorFailoverPorCircuito.timer = null;
  }, RESUMEN_FAILOVER_INTERVALO_MS);
}

async function fetchRailway(
  request,
  path,
  reason,
  env,
  ctx
) {
  // BUG (incidente): antes se usaba `RAILWAY_URL` a secas, una variable
  // que no existía en ningún sitio de este archivo (ni const de módulo, ni
  // en env) -> ReferenceError: RAILWAY_URL is not defined en cuanto se
  // intentaba hacer failover. Se lee de env.RAILWAY_URL, con la misma URL
  // pública que ya se usaba como valor por defecto en public/js/config.js
  // como fallback si no está configurada.
  //
  // Además: cuando este mismo archivo corre DENTRO de Railway (importado
  // por server-railway.js, con env.RUNNING_IN_RAILWAY = true — ver ese
  // archivo), "hacer failover a Railway" no tiene sentido: Railway ya es
  // quien está atendiendo la petición. Si su propia consulta a Postgres
  // falla, reenviarse a su propia URL pública solo crea una petición HTTP
  // extra contra sí mismo con el mismo resultado. En ese caso se deja que
  // el error original se propague en vez de reenviar.
  if (env.RUNNING_IN_RAILWAY) {
    console.log(
      `[FAILOVER] Petición dentro de Railway, no se reenvía a sí mismo (${reason})`
    );
    throw new Error(
      `No se puede hacer failover a Railway: ya se está ejecutando en Railway (motivo original: ${reason})`
    );
  }

  const railwayUrl =
    (env.RAILWAY_URL || "https://elotro-futbol-api-production.up.railway.app") +
    path +
    new URL(request.url).search;

  // Antes: console.log incondicional por CADA petición reenviada a
  // Railway. Bajo el patrón visto en producción (una ruta fallando de
  // forma sostenida, ~30 peticiones/segundo durante minutos) esto por sí
  // solo generaba miles de líneas en wrangler tail. Con reason ===
  // "CIRCUITO_ABIERTO" (ver circuitoEstaAbierto arriba) puede seguir
  // habiendo ese mismo volumen de peticiones yendo directas a Railway
  // mientras el circuito sigue abierto -es justo el caso que el
  // cortacircuito no puede evitar del todo, solo evita el intento
  // duplicado contra el primario-, así que aquí también se resume en vez
  // de loguear una línea por petición cuando la razón es el circuito.
  // Para el resto de razones (PRIMARY_5xx puntual, excepción, test
  // manual) sí interesa ver cada una: son mucho menos frecuentes y cada
  // una es señal de un fallo real distinto.
  if (reason === "CIRCUITO_ABIERTO") {
    contadorFailoverPorCircuito.total++;
    programarResumenFailoverPorCircuito();
  } else {
    console.log(
      `[FAILOVER] Railway → ${request.method} ${path} (${reason})`
    );
  }

  try {
    /*
     * request.clone() es importante.
     *
     * Permite enviar el mismo request a Railway aunque
     * anteriormente haya sido utilizado por el backend principal.
     */

    const railwayHeaders = new Headers(request.headers);
    // Marca INTERNA (no confundir con FAILOVER_REASON_HEADER, que va en la
    // respuesta hacia el navegador): le dice a server-railway.js que esta
    // petición llega por un failover real gestionado por el Worker, no por
    // alguien pegando directamente a Railway (pruebas manuales, curl,
    // etc.). Es la señal que usa pending-writes.js para decidir si una
    // escritura debe encolarse para reproducirse luego contra D1 -- sin
    // esto, tráfico de prueba contra Railway generaría entradas de cola
    // que nunca deberían haber existido.
    railwayHeaders.set("X-Failover-Origin", "worker-primary");
    railwayHeaders.set("X-Failover-Origin-Reason", reason);

    const railwayRequest = new Request(
      railwayUrl,
      {
        method: request.method,
        headers: railwayHeaders,

        body:
          request.method === "GET" ||
          request.method === "HEAD"
            ? undefined
            : request.clone().body,

        redirect: "follow"
      }
    );

    const railwayResponse =
      await fetch(railwayRequest);

    const headers =
      new Headers(railwayResponse.headers);

    /*
     * Cabeceras para verificar visualmente el failover.
     */

    headers.set(
      FAILOVER_HEADER,
      "RAILWAY"
    );

    headers.set(
      FAILOVER_TEST_HEADER,
      reason === "FAILOVER_TEST"
        ? "true"
        : "false"
    );

    headers.set(
      FAILOVER_REASON_HEADER,
      reason
    );

    headers.set(
      "Cache-Control",
      "no-store"
    );

    // Sin esto, el frontend no puede leer X-Failover-Backend/etc: por
    // defecto el navegador oculta cabeceras personalizadas a fetch() en
    // peticiones cross-origin salvo que se listen aquí explícitamente
    // (ver el mismo razonamiento en la función cors() de este archivo).
    headers.set(
      "Access-Control-Expose-Headers",
      "X-Failover-Backend,X-Failover-Test,X-Failover-Reason,X-Data-Staleness-Ms,X-Data-Staleness-Stale,X-Data-Staleness-Warning"
    );

    // Railway marca X-Data-Staleness-Warning cuando el sincronizador
    // D1->Postgres lleva más de 30 min sin avanzar (ver
    // UMBRAL_AVISO_STALENESS_MS en worker-secondary/src/server-railway.js).
    // Se avisa por email para que esto no se descubra solo mirando la
    // consola del navegador, como pasó el 1-sep-2026.
    if (ctx && headers.get("X-Data-Staleness-Warning") === "true") {
      ctx.waitUntil(avisarStalenessSiToca(env, headers.get("X-Data-Staleness-Ms")));
    }

    // FORZAMOS el CORS aquí, en vez de confiar en que Railway lo haya
    // puesto (server-railway.js lo añade normalmente vía el middleware
    // cors() de Hono, pero si Railway está caído, reiniciándose, o el
    // error ocurre a nivel de plataforma/proxy antes de llegar a Hono, su
    // respuesta llega sin cabecera CORS). Sin esto, el navegador bloquea
    // la respuesta de Railway con un error de CORS que oculta el error
    // real (que puede ser un 502/503/500 legítimo), como pasaba en
    // producción: la consola mostraba "blocked by CORS policy" en vez del
    // fallo real de Railway. Se usa la whitelist en vez de un origen fijo.
    if (origenPermitido(ORIGEN_PETICION_ACTUAL)) {
      headers.set("Access-Control-Allow-Origin", ORIGEN_PETICION_ACTUAL);
      headers.set("Vary", "Origin");
    }
    headers.set(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS"
    );
    headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization"
    );

    /*
     * Si Railway responde correctamente,
     * devolvemos su respuesta original.
     */

    return new Response(
      railwayResponse.body,
      {
        status: railwayResponse.status,
        statusText: railwayResponse.statusText,
        headers
      }
    );

  } catch (railwayError) {

    /*
     * ============================================================
     * FALLAN PRINCIPAL Y RAILWAY
     * ============================================================
     */

    console.error(
      "[FAILOVER] Railway también ha fallado:",
      railwayError
    );

    const respuestaFailoverTotal = new Response(
      JSON.stringify(
        {
          status: "FAILOVER_ERROR",
          backend: "NONE",
          message:
            "Primary and Railway unavailable",
          failover_reason: reason,
          railway_error:
            railwayError?.message ||
            String(railwayError)
        },
        null,
        2
      ),
      {
        status: 502,
        headers: {
          "Content-Type":
            "application/json",
          "Cache-Control":
            "no-store",

          "Access-Control-Expose-Headers":
            "X-Failover-Backend,X-Failover-Test,X-Failover-Reason",

          [FAILOVER_HEADER]:
            "NONE",

          [FAILOVER_TEST_HEADER]:
            reason === "FAILOVER_TEST"
              ? "true"
              : "false",

          [FAILOVER_REASON_HEADER]:
            reason
        }
      }
    );
    if (origenPermitido(ORIGEN_PETICION_ACTUAL)) {
      respuestaFailoverTotal.headers.set("Access-Control-Allow-Origin", ORIGEN_PETICION_ACTUAL);
      respuestaFailoverTotal.headers.set("Vary", "Origin");
    }
    return respuestaFailoverTotal;
  }
}


/*
 * ================================================================
 * BACKEND PRINCIPAL
 * ================================================================
 *
 * IMPORTANTE:
 *
 * AQUÍ VA EL RESTO DEL CÓDIGO ACTUAL DE TU WORKER.
 *
 * Es decir:
 *
 * - login
 * - artículos
 * - partidos
 * - D1
 * - Minuto a Minuto
 * - usuarios
 * - notificaciones
 * - etc.
 *
 * NO pongas otro "export default".
 *
 * Todo tu código actual debe ejecutarse desde esta función.
 * ================================================================
 */

async function handlePrimary(request, env, ctx) {

  const url = new URL(request.url);
  const path = url.pathname;
  // Presente solo cuando esta petición es la reproducción, contra D1, de
  // una escritura que se atendió antes en Postgres/Railway durante un
  // failover (ver server-railway.js y drainPendingWrites más arriba). Se
  // usa para etiquetar con el mismo id la fila que se cree aquí (si la
  // petición es un INSERT de artículo/resultado), de modo que
  // sync/incremental.mjs pueda reconciliarla con la ya creada en Postgres
  // en vez de duplicarla. NULL en cualquier petición normal (sin
  // failover), que es la inmensa mayoría.
  const origenWriteId = request.headers.get("X-Write-Id") || null;
  const method = request.method;

    try {
      // ================================================================
      // ---------- CUENTAS DE LECTORES (registro/login público) ----------
      // ================================================================
      // Distinto del login de redactores/admin de arriba: esto es para
      // cualquier visitante que quiera comentar las noticias firmando
      // con su nombre real y una insignia de "verificado", en vez de
      // escribir nombre+email sueltos en cada comentario. Usa las
      // tablas "readers"/"reader_sessions" (ver migracion_readers.sql),
      // completamente separadas de "users"/"sessions": un lector nunca
      // tiene acceso al panel de administración.

      // ---------- Registro ----------
      if (path === "/api/readers/register" && method === "POST") {
        const body = await request.json();
        const nombre = normalizarTexto(body.nombre);
        const email = normalizarTexto(body.email)?.toLowerCase() || null;
        const password = typeof body.password === "string" ? body.password : "";

        if (!nombre) return json({ error: "Falta tu nombre" }, 400);
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Introduce un correo electrónico válido" }, 400);
        if (password.length < 8) return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);

        const existente = await env.DB.prepare("SELECT id FROM readers WHERE email = ?").bind(email).first();
        if (existente) return json({ error: "Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña." }, 409);

        const salt = randomSalt();
        const hash = await hashPassword(password, salt);
        const tokenArr = new Uint8Array(32);
        crypto.getRandomValues(tokenArr);
        const verifToken = [...tokenArr].map((b) => b.toString(16).padStart(2, "0")).join("");
        const verifExpira = new Date(Date.now() + 30 * 60 * 1000).toISOString();

        const insertado = await env.DB.prepare(
          `INSERT INTO readers (nombre, email, password_hash, salt, verificacion_token, verificacion_token_expira)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
        ).bind(nombre, email, hash, salt, verifToken, verifExpira).first();

        const enlace = `${SITIO_URL}/verificar-cuenta.html?token=${verifToken}`;
        ctx.waitUntil(enviarEmailNotificacion(env, {
          asunto: "Confirma tu cuenta — ELOTROFÚTBOLTV",
          texto: `Hola ${nombre},\n\nGracias por registrarte en ELOTROFÚTBOLTV. Confirma tu correo entrando en este enlace (caduca en 30 minutos):\n${enlace}\n\nSi no has sido tú, ignora este correo.`,
          html: plantillaEmail({
            etiqueta: "Confirma tu cuenta",
            titulo: `¡Bienvenido/a, ${nombre}!`,
            parrafo: "Confirma tu correo para poder comentar las noticias con tu nombre. El enlace caduca en 30 minutos.",
            boton: { texto: "Confirmar mi correo", url: enlace },
          }),
        }, { destinatario: email }));

        return json({ ok: true, mensaje: "Cuenta creada. Revisa tu correo para confirmarla antes de iniciar sesión." }, 201);
      }

      // ---------- Confirmar correo (registro) ----------
      if (path === "/api/readers/verificar" && method === "POST") {
        const { token } = await request.json();
        if (!token) return json({ error: "Falta el token" }, 400);

        const lector = await env.DB.prepare(
          "SELECT * FROM readers WHERE verificacion_token = ? AND activo = 1"
        ).bind(token).first();
        if (!lector || !lector.verificacion_token_expira || new Date(lector.verificacion_token_expira).getTime() < Date.now()) {
          return json({ error: "El enlace no es válido o ha caducado. Vuelve a registrarte o pide uno nuevo." }, 401);
        }

        await env.DB.prepare(
          "UPDATE readers SET email_verificado = 1, verificacion_token = NULL, verificacion_token_expira = NULL WHERE id = ?"
        ).bind(lector.id).run();

        const tokenSesion = await crearSesionLector(env, request, { ...lector, email_verificado: 1 });
        return json({
          ok: true,
          token: tokenSesion,
          reader: { id: lector.id, nombre: lector.nombre, email: lector.email, email_verificado: true },
        });
      }

      // ---------- Reenviar correo de confirmación ----------
      if (path === "/api/readers/reenviar-verificacion" && method === "POST") {
        const { email } = await request.json();
        const emailNorm = normalizarTexto(email)?.toLowerCase() || null;
        if (!emailNorm) return json({ error: "Falta el correo" }, 400);

        const lector = await env.DB.prepare(
          "SELECT * FROM readers WHERE email = ? AND activo = 1 AND email_verificado = 0"
        ).bind(emailNorm).first();

        // Respuesta idéntica exista o no la cuenta, para no revelar si
        // un correo está registrado (mismo criterio que forgot-password).
        if (lector) {
          const tokenArr = new Uint8Array(32);
          crypto.getRandomValues(tokenArr);
          const verifToken = [...tokenArr].map((b) => b.toString(16).padStart(2, "0")).join("");
          const verifExpira = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          await env.DB.prepare(
            "UPDATE readers SET verificacion_token = ?, verificacion_token_expira = ? WHERE id = ?"
          ).bind(verifToken, verifExpira, lector.id).run();

          const enlace = `${SITIO_URL}/verificar-cuenta.html?token=${verifToken}`;
          ctx.waitUntil(enviarEmailNotificacion(env, {
            asunto: "Confirma tu cuenta — ELOTROFÚTBOLTV",
            texto: `Hola ${lector.nombre},\n\nConfirma tu correo entrando en este enlace (caduca en 30 minutos):\n${enlace}`,
            html: plantillaEmail({
              etiqueta: "Confirma tu cuenta",
              titulo: "Confirma tu correo",
              parrafo: "El enlace caduca en 30 minutos.",
              boton: { texto: "Confirmar mi correo", url: enlace },
            }),
          }, { destinatario: lector.email }));
        }

        return json({ ok: true, mensaje: "Si la cuenta existe y aún no está confirmada, te hemos enviado un nuevo enlace." });
      }

      // ---------- Login de lector ----------
      if (path === "/api/readers/login" && method === "POST") {
        const body = await request.json();
        const email = normalizarTexto(body.email)?.toLowerCase() || null;
        const password = typeof body.password === "string" ? body.password : "";
        if (!email || !password) return json({ error: "Faltan credenciales" }, 400);

        const lector = await env.DB.prepare("SELECT * FROM readers WHERE email = ? AND activo = 1").bind(email).first();
        if (!lector) return json({ error: "Correo o contraseña incorrectos" }, 401);
        const hash = await hashPassword(password, lector.salt);
        if (hash !== lector.password_hash) return json({ error: "Correo o contraseña incorrectos" }, 401);
        if (!lector.email_verificado) {
          return json({ error: "Todavía no has confirmado tu correo. Revisa tu bandeja de entrada.", sinVerificar: true }, 403);
        }

        const token = await crearSesionLector(env, request, lector);
        return json({
          token,
          reader: { id: lector.id, nombre: lector.nombre, email: lector.email, email_verificado: true },
        });
      }

      // ---------- Login/registro de lector con cuenta de Google ----------
      // Ver el comentario largo en worker/src/index.js (Worker
      // principal) para la explicación completa del flujo. Réplica
      // exacta aquí para que funcione también durante un failover.
      if (path === "/api/readers/google" && method === "POST") {
        if (!env.GOOGLE_CLIENT_ID) return json({ error: "El acceso con Google no está configurado" }, 500);
        const { credential } = await request.json();
        if (!credential) return json({ error: "Falta el token de Google" }, 400);

        let datosGoogle;
        try {
          datosGoogle = await verificarGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
        } catch {
          datosGoogle = null;
        }
        if (!datosGoogle) return json({ error: "No se ha podido verificar la cuenta de Google" }, 401);
        if (!datosGoogle.email_verified) return json({ error: "Tu cuenta de Google no tiene el correo verificado" }, 401);

        const googleId = datosGoogle.sub;
        const email = datosGoogle.email.toLowerCase();
        const nombre = datosGoogle.name || email.split("@")[0];
        const avatarUrl = datosGoogle.picture || null;

        let lector = await env.DB.prepare("SELECT * FROM readers WHERE google_id = ? AND activo = 1").bind(googleId).first();

        if (!lector) {
          const porEmail = await env.DB.prepare("SELECT * FROM readers WHERE email = ? AND activo = 1").bind(email).first();
          if (porEmail) {
            await env.DB.prepare(
              "UPDATE readers SET google_id = ?, email_verificado = 1, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?"
            ).bind(googleId, avatarUrl, porEmail.id).run();
            lector = { ...porEmail, google_id: googleId, email_verificado: 1 };
          } else {
            // Mismo motivo que en worker/src/index.js: se evita depender
            // de que password_hash/salt permitan NULL (para no obligar a
            // tocar el esquema también en Postgres si no hace falta) con
            // un hash de contraseña aleatoria que nadie puede reproducir.
            const saltRelleno = randomSalt();
            const arrRelleno = new Uint8Array(32);
            crypto.getRandomValues(arrRelleno);
            const passwordRelleno = [...arrRelleno].map((b) => b.toString(16).padStart(2, "0")).join("");
            const hashRelleno = await hashPassword(passwordRelleno, saltRelleno);
            const insertado = await env.DB.prepare(
              `INSERT INTO readers (nombre, email, password_hash, salt, google_id, avatar_url, email_verificado)
               VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id`
            ).bind(nombre, email, hashRelleno, saltRelleno, googleId, avatarUrl).first();
            lector = { id: insertado.id, nombre, email, google_id: googleId, avatar_url: avatarUrl, email_verificado: 1 };
          }
        }

        const token = await crearSesionLector(env, request, lector);
        return json({
          token,
          reader: { id: lector.id, nombre: lector.nombre, email: lector.email, email_verificado: true, avatar_url: lector.avatar_url || null },
        });
      }

      // ---------- Login/registro de lector con cuenta de Microsoft ----------
      // Ver el comentario largo en worker/src/index.js (Worker
      // principal) para la explicación completa del flujo. Réplica
      // exacta aquí para que funcione también durante un failover.
      if (path === "/api/readers/microsoft" && method === "POST") {
        if (!env.MICROSOFT_CLIENT_ID) return json({ error: "El acceso con Microsoft no está configurado" }, 500);
        const { credential } = await request.json();
        if (!credential) return json({ error: "Falta el token de Microsoft" }, 400);

        let datosMicrosoft;
        try {
          datosMicrosoft = await verificarMicrosoftIdToken(credential, env.MICROSOFT_CLIENT_ID);
        } catch {
          datosMicrosoft = null;
        }
        if (!datosMicrosoft) return json({ error: "No se ha podido verificar la cuenta de Microsoft" }, 401);
        if (!datosMicrosoft.email) return json({ error: "Tu cuenta de Microsoft no tiene un correo asociado" }, 401);

        const microsoftId = datosMicrosoft.oid || datosMicrosoft.sub;
        const email = datosMicrosoft.email.toLowerCase();
        const nombre = datosMicrosoft.name || email.split("@")[0];

        let lector = await env.DB.prepare("SELECT * FROM readers WHERE microsoft_id = ? AND activo = 1").bind(microsoftId).first();

        if (!lector) {
          const porEmail = await env.DB.prepare("SELECT * FROM readers WHERE email = ? AND activo = 1").bind(email).first();
          if (porEmail) {
            await env.DB.prepare(
              "UPDATE readers SET microsoft_id = ?, email_verificado = 1 WHERE id = ?"
            ).bind(microsoftId, porEmail.id).run();
            lector = { ...porEmail, microsoft_id: microsoftId, email_verificado: 1 };
          } else {
            // Mismo motivo que en el flujo de Google: se evita depender
            // de que password_hash/salt permitan NULL con un hash de
            // contraseña aleatoria que nadie puede reproducir.
            const saltRelleno = randomSalt();
            const arrRelleno = new Uint8Array(32);
            crypto.getRandomValues(arrRelleno);
            const passwordRelleno = [...arrRelleno].map((b) => b.toString(16).padStart(2, "0")).join("");
            const hashRelleno = await hashPassword(passwordRelleno, saltRelleno);
            const insertado = await env.DB.prepare(
              `INSERT INTO readers (nombre, email, password_hash, salt, microsoft_id, email_verificado)
               VALUES (?, ?, ?, ?, ?, 1) RETURNING id`
            ).bind(nombre, email, hashRelleno, saltRelleno, microsoftId).first();
            lector = { id: insertado.id, nombre, email, microsoft_id: microsoftId, email_verificado: 1 };
          }
        }

        const token = await crearSesionLector(env, request, lector);
        return json({
          token,
          reader: { id: lector.id, nombre: lector.nombre, email: lector.email, email_verificado: true, avatar_url: lector.avatar_url || null },
        });
      }

      // ---------- Login/registro de lector con cuenta de Discord ----------
      // Ver el comentario largo en worker/src/index.js (Worker
      // principal) para la explicación completa del flujo OAuth 2.0 de
      // Discord (redirect + code + canje server-side, a diferencia de
      // Google/Microsoft). Réplica exacta aquí para que funcione
      // también durante un failover.
      if (path === "/api/readers/discord/iniciar" && method === "GET") {
        if (!env.DISCORD_CLIENT_ID) return json({ error: "El acceso con Discord no está configurado" }, 500);

        const state = randomSalt();
        const volver = url.searchParams.get("volver") || "";
        const redirectUri = `${API_URL}/api/readers/discord/callback`;

        const paramsDiscord = new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "identify email",
          state,
        });

        const headers = new Headers({ Location: `https://discord.com/api/oauth2/authorize?${paramsDiscord}` });
        headers.append(
          "Set-Cookie",
          `eof_discord_state=${state}|${encodeURIComponent(volver)}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`
        );
        return new Response(null, { status: 302, headers });
      }

      if (path === "/api/readers/discord/callback" && method === "GET") {
        const irConError = (mensaje) => Response.redirect(
          `${SITIO_URL}/acceso.html?errorDiscord=${encodeURIComponent(mensaje)}`, 302
        );

        if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return irConError("El acceso con Discord no está configurado");

        const code = url.searchParams.get("code");
        const stateRecibido = url.searchParams.get("state");
        if (!code || !stateRecibido) return irConError("Discord no ha devuelto los datos esperados");

        const cookieCabecera = request.headers.get("Cookie") || "";
        const cookieState = cookieCabecera.match(/eof_discord_state=([^;]+)/)?.[1];
        if (!cookieState) return irConError("La sesión de inicio con Discord ha caducado, inténtalo de nuevo");
        const [stateGuardado, volverGuardado] = decodeURIComponent(cookieState).split("|");
        if (stateGuardado !== stateRecibido) return irConError("No se ha podido verificar el inicio de sesión con Discord");

        const redirectUri = `${API_URL}/api/readers/discord/callback`;

        let tokenData;
        try {
          const resToken = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: env.DISCORD_CLIENT_ID,
              client_secret: env.DISCORD_CLIENT_SECRET,
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
            }),
          });
          if (!resToken.ok) throw new Error("token");
          tokenData = await resToken.json();
        } catch {
          return irConError("No se ha podido verificar la cuenta de Discord");
        }

        let perfilDiscord;
        try {
          const resPerfil = await fetch("https://discord.com/api/users/@me", {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (!resPerfil.ok) throw new Error("perfil");
          perfilDiscord = await resPerfil.json();
        } catch {
          return irConError("No se ha podido obtener tu perfil de Discord");
        }

        if (!perfilDiscord.email) return irConError("Tu cuenta de Discord no tiene un correo verificado asociado");
        if (perfilDiscord.verified === false) return irConError("Verifica primero tu correo en Discord antes de continuar");

        const discordId = perfilDiscord.id;
        const email = perfilDiscord.email.toLowerCase();
        const nombre = perfilDiscord.global_name || perfilDiscord.username || email.split("@")[0];
        const avatarUrl = perfilDiscord.avatar
          ? `https://cdn.discordapp.com/avatars/${discordId}/${perfilDiscord.avatar}.png`
          : null;

        let lector = await env.DB.prepare("SELECT * FROM readers WHERE discord_id = ? AND activo = 1").bind(discordId).first();

        if (!lector) {
          const porEmail = await env.DB.prepare("SELECT * FROM readers WHERE email = ? AND activo = 1").bind(email).first();
          if (porEmail) {
            await env.DB.prepare(
              "UPDATE readers SET discord_id = ?, email_verificado = 1, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?"
            ).bind(discordId, avatarUrl, porEmail.id).run();
            lector = { ...porEmail, discord_id: discordId, email_verificado: 1 };
          } else {
            const saltRelleno = randomSalt();
            const arrRelleno = new Uint8Array(32);
            crypto.getRandomValues(arrRelleno);
            const passwordRelleno = [...arrRelleno].map((b) => b.toString(16).padStart(2, "0")).join("");
            const hashRelleno = await hashPassword(passwordRelleno, saltRelleno);
            const insertado = await env.DB.prepare(
              `INSERT INTO readers (nombre, email, password_hash, salt, discord_id, avatar_url, email_verificado)
               VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id`
            ).bind(nombre, email, hashRelleno, saltRelleno, discordId, avatarUrl).first();
            lector = { id: insertado.id, nombre, email, discord_id: discordId, avatar_url: avatarUrl, email_verificado: 1 };
          }
        }

        const token = await crearSesionLector(env, request, lector);

        const destino = volverGuardado || "index.html";
        const headers = new Headers({
          Location: `${SITIO_URL}/${destino}${destino.includes("?") ? "&" : "?"}sesionDiscord=${token}`,
        });
        headers.append("Set-Cookie", "eof_discord_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
        return new Response(null, { status: 302, headers });
      }

      // ---------- Cerrar sesión de lector ----------
      if (path === "/api/readers/logout" && method === "POST") {
        const payload = await requireReaderAuth(request, env);
        if (payload && payload.sid) {
          await env.DB.prepare("UPDATE reader_sessions SET revoked_at = datetime('now') WHERE id = ?").bind(payload.sid).run();
        }
        return json({ ok: true });
      }

      // ---------- Quién soy (recuperar sesión al recargar la página) ----------
      if (path === "/api/readers/me" && method === "GET") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const lector = await env.DB.prepare("SELECT id, nombre, email, email_verificado, avatar_url FROM readers WHERE id = ? AND activo = 1").bind(payload.rid).first();
        if (!lector) return json({ error: "No autorizado" }, 401);
        return json({ reader: { ...lector, email_verificado: !!lector.email_verificado } });
      }

      // ---------- LEER MI PERFIL COMPLETO (nombre + avatar) ----------
      // Faltaba el GET: cuenta.html lo llama al cargar la pestaña de
      // perfil (ver cargarMiPerfilLector()) para traer también el
      // avatar_url, que /api/readers/me de arriba no incluye. Mismo
      // patrón que /api/me/perfil (redactores) pero con los campos que
      // tiene la tabla "readers".
      if (path === "/api/readers/me/perfil" && method === "GET") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const lector = await env.DB.prepare(
          "SELECT id, nombre, email, email_verificado, avatar_url FROM readers WHERE id = ? AND activo = 1"
        ).bind(payload.rid).first();
        if (!lector) return json({ error: "No autorizado" }, 401);
        return json({ reader: { ...lector, email_verificado: !!lector.email_verificado } });
      }

      // ---------- MIS SESIONES (dispositivos conectados) ----------
      // Mismo patrón que /api/me/sesiones para redactores, pero sobre
      // reader_sessions/readers: cuenta.html la llama desde la pestaña
      // "Dispositivos" (ver cargaSesionesLector()).
      if (path === "/api/readers/me/sesiones" && method === "GET") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { results } = await env.DB.prepare(
          `SELECT id, user_agent, ip, created_at, last_seen_at FROM reader_sessions
           WHERE reader_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC`
        ).bind(payload.rid).all();
        const sesiones = results.map((s) => ({
          id: s.id,
          dispositivo: describirDispositivo(s.user_agent),
          ip: s.ip || null,
          created_at: s.created_at,
          last_seen_at: s.last_seen_at,
          actual: s.id === payload.sid,
        }));
        return json({ sesiones });
      }

      // ---------- CERRAR TODAS LAS DEMÁS SESIONES (lector) ----------
      // Va antes del DELETE de una sesión concreta con id, para no
      // confundirla con /api/readers/me/sesiones/:id.
      if (path === "/api/readers/me/sesiones/otras" && method === "DELETE") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        await env.DB.prepare(
          "UPDATE reader_sessions SET revoked_at = datetime('now') WHERE reader_id = ? AND id != ? AND revoked_at IS NULL"
        ).bind(payload.rid, payload.sid || "").run();
        return json({ ok: true });
      }

      // ---------- CERRAR UNA SESIÓN CONCRETA (lector) ----------
      // Solo se puede cerrar una sesión propia (nunca la de otro
      // lector): se filtra siempre por reader_id = payload.rid.
      const sesionLectorMatch = path.match(/^\/api\/readers\/me\/sesiones\/([a-f0-9]+)$/);
      if (sesionLectorMatch && method === "DELETE") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = sesionLectorMatch[1];
        const sesion = await env.DB.prepare(
          "SELECT id FROM reader_sessions WHERE id = ? AND reader_id = ? AND revoked_at IS NULL"
        ).bind(id, payload.rid).first();
        if (!sesion) return json({ error: "Sesión no encontrada" }, 404);
        await env.DB.prepare("UPDATE reader_sessions SET revoked_at = datetime('now') WHERE id = ?").bind(id).run();
        return json({ ok: true, era_la_actual: id === payload.sid });
      }

      // ---------- Cambio de contraseña propia (lector logueado) ----------
      // Mismo patrón que /api/me/password para redactores: pide la
      // contraseña actual, valida la nueva y cierra el resto de
      // sesiones abiertas de este lector por seguridad.
      if (path === "/api/readers/me/password" && method === "PUT") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { actual, nueva } = await request.json();
        if (!actual || !nueva) return json({ error: "Faltan campos" }, 400);
        if (nueva.length < 8) return json({ error: "La nueva contraseña debe tener al menos 8 caracteres" }, 400);

        const lector = await env.DB.prepare("SELECT * FROM readers WHERE id = ? AND activo = 1").bind(payload.rid).first();
        if (!lector) return json({ error: "Cuenta no encontrada" }, 404);

        const hashActual = await hashPassword(actual, lector.salt);
        if (hashActual !== lector.password_hash) return json({ error: "La contraseña actual no es correcta" }, 401);

        const nuevaSalt = randomSalt();
        const nuevaHash = await hashPassword(nueva, nuevaSalt);
        await env.DB.prepare("UPDATE readers SET password_hash = ?, salt = ? WHERE id = ?")
          .bind(nuevaHash, nuevaSalt, lector.id).run();

        // Igual que con redactores: cerrar la contraseña cierra el
        // resto de sesiones abiertas en otros dispositivos/navegadores,
        // manteniendo la sesión actual.
        await env.DB.prepare(
          "UPDATE reader_sessions SET revoked_at = datetime('now') WHERE reader_id = ? AND id != ? AND revoked_at IS NULL"
        ).bind(lector.id, payload.sid || "").run();

        return json({ ok: true });
      }

      // ---------- Editar perfil propio (lector logueado): nombre + avatar ----------
      // público/cuenta.html la llama como GET y PUT a
      // /api/readers/me/perfil. El GET está justo arriba, junto a
      // /api/readers/me. Se reutiliza el mismo patrón que
      // /api/readers/me/password: requireReaderAuth + devolver un JWT
      // nuevo (el frontend guarda { token, reader } tras cada guardado
      // para reflejar el cambio sin tener que volver a iniciar sesión).
      if (path === "/api/readers/me/perfil" && method === "PUT") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const body = await request.json();
        const nombre = normalizarTexto(body.nombre)?.trim() || "";
        if (!nombre) return json({ error: "El nombre no puede estar vacío" }, 400);
        const avatarUrl = typeof body.avatar_url === "string" ? body.avatar_url.trim() || null : null;

        const lector = await env.DB.prepare("SELECT * FROM readers WHERE id = ? AND activo = 1").bind(payload.rid).first();
        if (!lector) return json({ error: "Cuenta no encontrada" }, 404);

        await env.DB.prepare("UPDATE readers SET nombre = ?, avatar_url = ? WHERE id = ?")
          .bind(nombre, avatarUrl, lector.id).run();

        // Se reemite el JWT (mismo sid, no se cierra ninguna sesión) para
        // que el objeto "reader" que guarda el frontend en localStorage
        // quede con el nombre/avatar nuevos sin tener que volver a hacer
        // login. Mismos campos en el payload que crearSesionLector, para
        // no cambiar la forma del JWT que ya emite el login normal.
        const token = await createJWT(
          { rid: lector.id, nombre, email: lector.email, sid: payload.sid },
          env.JWT_SECRET
        );
        return json({
          token,
          reader: { id: lector.id, nombre, email: lector.email, email_verificado: !!lector.email_verificado, avatar_url: avatarUrl },
        });
      }

      // ---------- Recuperar contraseña de lector: paso 1 ----------
      if (path === "/api/readers/forgot-password" && method === "POST") {
        const { email } = await request.json();
        const emailNorm = normalizarTexto(email)?.toLowerCase() || null;
        if (!emailNorm) return json({ error: "Falta el correo" }, 400);

        const lector = await env.DB.prepare("SELECT * FROM readers WHERE email = ? AND activo = 1").bind(emailNorm).first();
        if (lector) {
          const tokenArr = new Uint8Array(32);
          crypto.getRandomValues(tokenArr);
          const token = [...tokenArr].map((b) => b.toString(16).padStart(2, "0")).join("");
          const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          await env.DB.prepare("UPDATE readers SET reset_token = ?, reset_token_expira = ? WHERE id = ?")
            .bind(token, expira, lector.id).run();

          const enlace = `${SITIO_URL}/recuperar-cuenta.html?token=${token}`;
          ctx.waitUntil(enviarEmailNotificacion(env, {
            asunto: "Recupera tu contraseña — ELOTROFÚTBOLTV",
            texto: `Hola ${lector.nombre},\n\nHas pedido recuperar tu contraseña. Entra en este enlace para poner una nueva (caduca en 30 minutos):\n${enlace}\n\nSi no has sido tú, ignora este correo.`,
            html: plantillaEmail({
              etiqueta: "Recuperar contraseña",
              titulo: "Pon una contraseña nueva",
              parrafo: "Si no has pedido tú este cambio, ignora este correo. El enlace caduca en 30 minutos.",
              boton: { texto: "Poner contraseña nueva", url: enlace },
            }),
          }, { destinatario: lector.email }));
        }

        return json({ ok: true, mensaje: "Si el correo está registrado, te hemos enviado un enlace para poner una nueva contraseña." });
      }

      // ---------- Recuperar contraseña de lector: paso 2 ----------
      if (path === "/api/readers/forgot-password/confirmar" && method === "POST") {
        const { token, nueva } = await request.json();
        if (!token || !nueva) return json({ error: "Faltan campos" }, 400);
        if (nueva.length < 8) return json({ error: "La nueva contraseña debe tener al menos 8 caracteres" }, 400);

        const lector = await env.DB.prepare("SELECT * FROM readers WHERE reset_token = ? AND activo = 1").bind(token).first();
        if (!lector || !lector.reset_token_expira || new Date(lector.reset_token_expira).getTime() < Date.now()) {
          return json({ error: "El enlace no es válido o ha caducado. Pide uno nuevo desde \"He olvidado mi contraseña\"." }, 401);
        }

        const nuevaSalt = randomSalt();
        const nuevaHash = await hashPassword(nueva, nuevaSalt);
        await env.DB.prepare(
          "UPDATE readers SET password_hash = ?, salt = ?, reset_token = NULL, reset_token_expira = NULL WHERE id = ?"
        ).bind(nuevaHash, nuevaSalt, lector.id).run();

        await env.DB.prepare(
          "UPDATE reader_sessions SET revoked_at = datetime('now') WHERE reader_id = ? AND revoked_at IS NULL"
        ).bind(lector.id).run();

        return json({ ok: true });
      }


      // ---------- LOGIN ----------
      if (path === "/api/login" && method === "POST") {
        const { username, password } = await request.json();
        if (!username || !password) return json({ error: "Faltan credenciales" }, 400);
        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND activo = 1").bind(username).first();
        if (!user) return json({ error: "Usuario o contraseña incorrectos" }, 401);
        const hash = await hashPassword(password, user.salt);
        if (hash !== user.password_hash) return json({ error: "Usuario o contraseña incorrectos" }, 401);
        const token = await crearSesion(env, request, user);
        ctx.waitUntil(registrarActividad(env, request, { uid: user.id, nombre: user.nombre, rol: user.rol }, {
          accion: "login", entidad: "sesion", descripcion: `${user.nombre} ha iniciado sesión`,
        }));
        return json({ token, user: { id: user.id, username: user.username, nombre: user.nombre, rol: user.rol, nivel: user.rol === "admin" ? NIVEL_MAXIMO : (user.nivel || 1), email: user.email || null, avatar_url: user.avatar_url || null, avatar_foco: user.avatar_foco || null } });
      }

      // ---------- GUARDAR EMAIL (primer inicio de sesión) ----------
      if (path === "/api/me/email" && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { email } = await request.json();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
          return json({ error: "Introduce un correo electrónico válido" }, 400);
        }
        await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email.trim(), payload.uid).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_email_propio", entidad: "usuario", entidad_id: payload.uid,
          descripcion: `${payload.nombre} ha guardado su correo electrónico`,
        }));
        return json({ ok: true, email: email.trim() });
      }

      // ---------- RECUPERAR CONTRASEÑA: paso 1, solicitar el enlace ----------
      // Antes este endpoint cambiaba la contraseña con solo mandar
      // usuario + correo, sin ninguna verificación de que quien lo pide
      // es realmente el dueño de la cuenta (un correo personal no es un
      // secreto: puede saberse o adivinarse fácilmente en una redacción
      // pequeña donde todos se conocen). Ahora se genera un token de un
      // solo uso, caduca a los 30 minutos, y solo se puede usar si llega
      // por el enlace enviado a la bandeja de entrada del correo
      // guardado, vía Resend (mismo servicio que el resto de avisos).
      //
      // Por seguridad, la respuesta es siempre la misma exista o no la
      // cuenta/correo (para no revelar si un usuario existe): el aviso
      // real de "no coinciden" ya no se muestra en el propio formulario.
      if (path === "/api/forgot-password" && method === "POST") {
        const { username, email } = await request.json();
        if (!username || !email) return json({ error: "Faltan campos" }, 400);

        const user = await env.DB.prepare(
          "SELECT * FROM users WHERE username = ? AND email = ? AND activo = 1"
        ).bind(username.trim(), email.trim()).first();

        if (user) {
          const tokenArr = new Uint8Array(32);
          crypto.getRandomValues(tokenArr);
          const token = [...tokenArr].map((b) => b.toString(16).padStart(2, "0")).join("");
          const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          await env.DB.prepare("UPDATE users SET reset_token = ?, reset_token_expira = ? WHERE id = ?")
            .bind(token, expira, user.id).run();

          const enlace = `${SITIO_URL}/admin/login.html?reset=${token}`;
          ctx.waitUntil(enviarEmailNotificacion(env, {
            asunto: "Recupera tu contraseña — ELOTROFÚTBOLTV",
            texto: `Hola ${user.nombre},\n\nHas pedido recuperar tu contraseña en ELOTROFÚTBOLTV. Entra en este enlace para poner una nueva (caduca en 30 minutos):\n${enlace}\n\nSi no has sido tú, ignora este correo: tu contraseña actual sigue siendo válida.`,
            html: plantillaEmail({
              etiqueta: "Recuperar contraseña",
              titulo: "Pon una contraseña nueva",
              parrafo: "Si no has pedido tú este cambio, ignora este correo: tu contraseña actual sigue siendo válida. El enlace caduca en 30 minutos.",
              boton: { texto: "Poner contraseña nueva", url: enlace },
            }),
          }, { destinatario: user.email }));

          ctx.waitUntil(registrarActividad(env, request, { uid: user.id, nombre: user.nombre, rol: user.rol }, {
            accion: "solicitar_recuperar_password", entidad: "usuario", entidad_id: user.id,
            descripcion: `${user.nombre} ha solicitado recuperar su contraseña por correo`,
          }));
        }

        return json({ ok: true, mensaje: "Si los datos son correctos, te hemos enviado un enlace a tu correo para poner una contraseña nueva." });
      }

      // ---------- RECUPERAR CONTRASEÑA: paso 2, usar el enlace del correo ----------
      if (path === "/api/forgot-password/confirmar" && method === "POST") {
        const { token, nueva } = await request.json();
        if (!token || !nueva) return json({ error: "Faltan campos" }, 400);
        if (nueva.length < 8) return json({ error: "La nueva contraseña debe tener al menos 8 caracteres" }, 400);

        const user = await env.DB.prepare(
          "SELECT * FROM users WHERE reset_token = ? AND activo = 1"
        ).bind(token).first();
        if (!user || !user.reset_token_expira || new Date(user.reset_token_expira).getTime() < Date.now()) {
          return json({ error: "El enlace no es válido o ha caducado. Pide uno nuevo desde \"He olvidado mi contraseña\"." }, 401);
        }

        const nuevaSalt = randomSalt();
        const nuevaHash = await hashPassword(nueva, nuevaSalt);
        await env.DB.prepare(
          "UPDATE users SET password_hash = ?, salt = ?, reset_token = NULL, reset_token_expira = NULL WHERE id = ?"
        ).bind(nuevaHash, nuevaSalt, user.id).run();

        // Igual que al cambiar la contraseña desde el panel: cierra
        // cualquier sesión que hubiera abierta en otros dispositivos.
        await env.DB.prepare(
          "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL"
        ).bind(user.id).run();

        ctx.waitUntil(registrarActividad(env, request, { uid: user.id, nombre: user.nombre, rol: user.rol }, {
          accion: "recuperar_password", entidad: "usuario", entidad_id: user.id,
          descripcion: `${user.nombre} ha recuperado su contraseña mediante "He olvidado mi contraseña"`,
        }));

        return json({ ok: true });
      }

      // ---------- DEBUG TEMPORAL: diagnóstico de la auto-transición de partidos ----------
      // Endpoint de solo lectura para ver, sin tocar nada, por qué un
      // partido "programado" no se está pasando solo a "en_juego": qué
      // hora cree el worker que es, cómo se está convirtiendo
      // fecha_partido, y si el filtro lo está cogiendo o no. Requiere
      // login (cualquier usuario del panel) para no dejarlo abierto al
      // público. BORRAR este bloque una vez confirmado el arreglo.
      if (path === "/api/debug/cron-partidos" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const ahora = new Date();
        const ahoraSqlite = aSqliteDatetimeUTC(ahora);
        const { results: candidatos } = await env.DB.prepare(
          `SELECT id, equipo_local, equipo_visitante, fecha_partido, estado
           FROM results WHERE estado = 'programado' AND fecha_partido IS NOT NULL
           ORDER BY fecha_partido DESC LIMIT 30`
        ).all();
        const diagnostico = candidatos.map((p) => {
          const longitudOk = p.fecha_partido && p.fecha_partido.length === 16;
          const inicioUtcSqlite = longitudOk ? fechaPartidoAUtcSqlite(p.fecha_partido) : null;
          return {
            id: p.id,
            partido: `${p.equipo_local} - ${p.equipo_visitante}`,
            fecha_partido_guardada: p.fecha_partido,
            longitud: p.fecha_partido ? p.fecha_partido.length : null,
            pasa_filtro_longitud_16: longitudOk,
            inicio_convertido_a_utc_sqlite: inicioUtcSqlite,
            deberia_estar_en_juego: inicioUtcSqlite !== null && inicioUtcSqlite <= ahoraSqlite,
          };
        });
        return json({
          ahora_utc_iso: ahora.toISOString(),
          ahora_utc_sqlite: ahoraSqlite,
          offset_madrid_minutos_ahora: offsetMadridEnMinutos(ahora),
          total_programados_con_fecha: candidatos.length,
          partidos: diagnostico,
        });
      }

      // Endpoint hermano del anterior, pero que SÍ ejecuta de verdad
      // iniciarPartidosProgramadosCuyaHoraHaLlegado (la misma función
      // que llama el cron cada minuto). Sirve para descartar si el
      // problema está en la lógica (que ya hemos visto que no, el
      // cálculo de horas es correcto) o en que el cron trigger de
      // Cloudflare simplemente no se está disparando en producción: si
      // al llamar esto a mano el partido pasado de hora SÍ cambia a
      // "en_juego", el bug está 100% en el cron trigger (revisar en el
      // dashboard de Cloudflare -> Workers -> este worker -> Triggers
      // -> Cron Triggers, que exista "* * * * *" y esté activo).
      // BORRAR junto con el endpoint anterior una vez confirmado.
      if (path === "/api/debug/cron-partidos/ejecutar" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const antes = await env.DB.prepare(
          `SELECT id, equipo_local, equipo_visitante, fecha_partido, estado FROM results
           WHERE estado = 'programado' AND fecha_partido IS NOT NULL AND length(fecha_partido) = 16`
        ).all();
        await iniciarPartidosProgramadosCuyaHoraHaLlegado(env);
        const idsAntes = antes.results.map((p) => p.id);
        let despues = { results: [] };
        if (idsAntes.length) {
          despues = await env.DB.prepare(
            `SELECT id, equipo_local, equipo_visitante, estado FROM results WHERE id IN (${idsAntes.map(() => "?").join(",")})`
          ).bind(...idsAntes).all();
        }
        const estadoDespuesPorId = Object.fromEntries(despues.results.map((p) => [p.id, p.estado]));
        const cambiados = antes.results
          .filter((p) => estadoDespuesPorId[p.id] === "en_juego")
          .map((p) => ({ id: p.id, partido: `${p.equipo_local} - ${p.equipo_visitante}`, fecha_partido: p.fecha_partido }));
        return json({
          mensaje: cambiados.length
            ? "La función SÍ funciona: estos partidos se han pasado a en_juego al ejecutarla a mano. El bug está en que el cron trigger no se dispara solo en Cloudflare."
            : "No había ningún partido pendiente de activar en este momento (o ya estaban todos al día).",
          partidos_activados_ahora: cambiados,
        });
      }

      // Limpieza puntual: borra duplicados de "inicio_partido" que ya
      // se hubieran colado ANTES de este arreglo (se queda con el más
      // antiguo -el id más bajo- de cada partido y borra el resto).
      // Solo lectura+borrado de match_events, no toca goles/tarjetas.
      // BORRAR junto con los demás endpoints de debug una vez usado.
      if (path === "/api/debug/cron-partidos/limpiar-duplicados" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { results: duplicados } = await env.DB.prepare(
          `SELECT id, resultado_id FROM match_events WHERE tipo = 'inicio_partido' AND id NOT IN (
             SELECT MIN(id) FROM match_events WHERE tipo = 'inicio_partido' GROUP BY resultado_id
           )`
        ).all();
        for (const dup of duplicados) {
          await env.DB.prepare("DELETE FROM match_events WHERE id = ?").bind(dup.id).run();
        }
        return json({ ok: true, eliminados: duplicados.length, detalle: duplicados });
      }

      // Endpoint temporal: aplica el SQL de
      // worker/migracion_jornadas_calendario_datos.sql directamente contra
      // Postgres (por eso usa env.PGPOOL, no env.DB: necesita ejecutar el
      // archivo entero de un tirón, con sus múltiples INSERT, en vez de
      // sentencia a sentencia). Solo tiene sentido en Railway/Postgres,
      // donde este archivo sí existe en disco (../worker/... relativo a
      // worker-secondary). BORRAR esta ruta, la línea PGPOOL en
      // server-railway.js y el export de pool en postgres-db.js una vez
      // aplicada la migración.
      if (path === "/api/debug/migrar-jornadas-calendario" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!env.PGPOOL) return json({ error: "PGPOOL no disponible en este entorno" }, 400);
        try {
          const fs = await import("node:fs");
          const path2 = await import("node:path");
          const { fileURLToPath } = await import("node:url");
          const __dirname2 = path2.dirname(fileURLToPath(import.meta.url));
          const sqlPath = path2.join(__dirname2, "..", "..", "worker", "migracion_jornadas_calendario_datos.sql");
          const sql = fs.readFileSync(sqlPath, "utf8");
          await env.PGPOOL.query(sql);
          return json({ ok: true, mensaje: "Migración de jornadas_calendario aplicada." });
        } catch (error) {
          return json({ error: "Fallo al aplicar la migración", detalle: error.message }, 500);
        }
      }

      // ---------- ME ----------
      if (path === "/api/me" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        return json({ user: payload });
      }

      // ---------- CAMBIO DE CONTRASEÑA PROPIA ----------
      if (path === "/api/me/password" && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { actual, nueva } = await request.json();
        if (!actual || !nueva) return json({ error: "Faltan campos" }, 400);
        if (nueva.length < 8) return json({ error: "La nueva contraseña debe tener al menos 8 caracteres" }, 400);

        const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.uid).first();
        if (!user) return json({ error: "Usuario no encontrado" }, 404);

        const hashActual = await hashPassword(actual, user.salt);
        if (hashActual !== user.password_hash) return json({ error: "La contraseña actual no es correcta" }, 401);

        const nuevaSalt = randomSalt();
        const nuevaHash = await hashPassword(nueva, nuevaSalt);
        await env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?")
          .bind(nuevaHash, nuevaSalt, user.id).run();

        // Por seguridad, cambiar la contraseña cierra todas las demás
        // sesiones (en otros dispositivos/navegadores): si alguien cambia
        // la contraseña porque sospecha que otra persona tiene acceso a
        // su cuenta, esa otra sesión queda invalidada al momento. La
        // sesión actual (desde la que se ha hecho el cambio) se mantiene.
        await env.DB.prepare(
          "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id != ? AND revoked_at IS NULL"
        ).bind(user.id, payload.sid || "").run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "cambiar_password_propia", entidad: "usuario", entidad_id: payload.uid,
          descripcion: `${payload.nombre} ha cambiado su contraseña`,
        }));

        return json({ ok: true });
      }

      // ---------- MIS SESIONES (dispositivos con sesión iniciada) ----------
      // Lista las sesiones activas (no revocadas) de la persona conectada:
      // desde qué dispositivo/navegador, con qué IP, cuándo se inició y
      // cuándo se ha usado por última vez. Permite reconocer accesos que
      // no se reconocen y cerrarlos.
      if (path === "/api/me/sesiones" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { results } = await env.DB.prepare(
          `SELECT id, user_agent, ip, created_at, last_seen_at FROM sessions
           WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC`
        ).bind(payload.uid).all();
        const sesiones = results.map((s) => ({
          id: s.id,
          dispositivo: describirDispositivo(s.user_agent),
          ip: s.ip || null,
          created_at: s.created_at,
          last_seen_at: s.last_seen_at,
          actual: s.id === payload.sid,
        }));
        return json({ sesiones });
      }

      // ---------- CERRAR TODAS LAS DEMÁS SESIONES ----------
      // Va antes del DELETE de una sesión concreta con id, para no
      // confundirla con /api/me/sesiones/:id.
      if (path === "/api/me/sesiones/otras" && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        await env.DB.prepare(
          "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id != ? AND revoked_at IS NULL"
        ).bind(payload.uid, payload.sid || "").run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "cerrar_otras_sesiones", entidad: "sesion",
          descripcion: `${payload.nombre} ha cerrado el resto de sus sesiones abiertas`,
        }));
        return json({ ok: true });
      }

      // ---------- CERRAR UNA SESIÓN CONCRETA ----------
      // Solo se puede cerrar una sesión propia (nunca la de otra
      // persona): se filtra siempre por user_id = payload.uid.
      const sesionMatch = path.match(/^\/api\/me\/sesiones\/([a-f0-9]+)$/);
      if (sesionMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = sesionMatch[1];
        const sesion = await env.DB.prepare(
          "SELECT id FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
        ).bind(id, payload.uid).first();
        if (!sesion) return json({ error: "Sesión no encontrada" }, 404);
        await env.DB.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?").bind(id).run();
        const eraLaActual = id === payload.sid;
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "cerrar_sesion", entidad: "sesion", entidad_id: id,
          descripcion: eraLaActual
            ? `${payload.nombre} ha cerrado su sesión actual desde "Mis sesiones"`
            : `${payload.nombre} ha cerrado una sesión abierta en otro dispositivo`,
        }));
        return json({ ok: true, era_la_actual: eraLaActual });
      }

      // ---------- NOVEDADES: cuándo las ha visto por última vez ----------
      // Se guarda en el servidor (no solo en localStorage del navegador)
      // para que, si se pierde la sesión o se borran las cookies/datos
      // del navegador, al volver a entrar no le vuelvan a salir como
      // nuevas las novedades que ya había visto.
      if (path === "/api/me/notif-visto" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const user = await env.DB.prepare("SELECT notif_visto_at FROM users WHERE id = ?").bind(payload.uid).first();
        return json({ visto: (user && user.notif_visto_at) || null });
      }

      if (path === "/api/me/notif-visto" && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const ahora = new Date().toISOString();
        await env.DB.prepare("UPDATE users SET notif_visto_at = ? WHERE id = ?").bind(ahora, payload.uid).run();
        return json({ ok: true, visto: ahora });
      }
      // Cada persona puede editar su propio nombre y correo. Devolvemos un
      // token nuevo porque el nombre va incrustado en el JWT (se usa, por
      // ejemplo, para la cabecera del panel), así el cambio se ve al
      // momento sin tener que volver a iniciar sesión.
      // ---------- LEER MI PERFIL COMPLETO (bio, avatar, redes...) ----------
      // El JWT solo lleva lo justo (uid/username/nombre/rol) para no
      // hacerlo enorme; el resto del perfil (biografía, foto, redes
      // sociales propias) se consulta aparte para rellenar el formulario
      // de "Mis datos" del panel.
      if (path === "/api/me/perfil" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const user = await env.DB.prepare(
          "SELECT id, username, nombre, rol, email, bio, experiencia, avatar_url, equipo, redes_sociales FROM users WHERE id = ?"
        ).bind(payload.uid).first();
        if (!user) return json({ error: "Usuario no encontrado" }, 404);
        let redes = {};
        if (user.redes_sociales) {
          try { redes = JSON.parse(user.redes_sociales); } catch { redes = {}; }
        }
        // El equipo se devuelve como array (aunque en la BD solo hubiera
        // uno guardado con el formato antiguo) para que el panel lo
        // muestre igual en todos los casos. Es de solo lectura aqui: la
        // propia persona lo ve pero no puede cambiarlo (ver PUT abajo).
        const equipos = parsearEquipos(user.equipo);
        return json({ user: { ...user, equipo: equipos, redes_sociales: undefined, redes } });
      }

      // ---------- EDITAR MI PERFIL (nombre / correo / bio / avatar / redes) ----------
      // Cada persona puede editar su propio perfil: nombre, correo,
      // biografía, foto y redes sociales propias (distintas de las redes
      // del medio, que solo puede tocar un admin desde /api/settings).
      // Este perfil es público: lo puede ver cualquiera desde su página
      // de autor (GET /api/autores/:id), enlazada desde sus noticias.
      // Devolvemos un token nuevo porque el nombre va incrustado en el
      // JWT (se usa, por ejemplo, para la cabecera del panel), así el
      // cambio se ve al momento sin tener que volver a iniciar sesión.
      if (path === "/api/me/perfil" && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const body = await request.json();
        const nombre = typeof body.nombre === "string" ? body.nombre.trim() : "";
        if (!nombre) return json({ error: "El nombre no puede estar vacío" }, 400);
        let email = null;
        if (body.email !== undefined && body.email !== null && body.email.trim() !== "") {
          email = body.email.trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return json({ error: "Introduce un correo electrónico válido" }, 400);
          }
        }
        const bio = typeof body.bio === "string" ? body.bio.trim().slice(0, 600) : null;
        const experiencia = typeof body.experiencia === "string" ? body.experiencia.trim().slice(0, 1200) : null;
        const avatarUrl = typeof body.avatar_url === "string" && body.avatar_url.trim() ? body.avatar_url.trim() : null;
        // El equipo NO se puede editar desde el propio perfil: es de solo
        // lectura para la persona (se muestra bloqueado en "Mis datos") y
        // solo un admin puede cambiarlo, desde "Usuarios" (PUT /api/users/:id).
        // Por eso aqui se ignora cualquier "equipo" que llegue en el body.

        // Igual que en /api/settings: solo se guardan claves conocidas y
        // con valores de texto, para no guardar basura en la BD.
        const redesLimpias = {};
        if (body.redes && typeof body.redes === "object" && !Array.isArray(body.redes)) {
          for (const [key, val] of Object.entries(body.redes)) {
            if (["twitter", "instagram", "tiktok", "youtube"].includes(key) && typeof val === "string" && val.trim() !== "") {
              redesLimpias[key] = val.trim();
            }
          }
        }

        const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.uid).first();
        if (!user) return json({ error: "Usuario no encontrado" }, 404);

        // Para que el historial diga exactamente qué se ha tocado (y no
        // un genérico "nombre, bio, foto o redes" aunque solo se haya
        // cambiado una cosa), comparamos cada campo con su valor anterior.
        const redesAnteriores = (() => {
          if (!user.redes_sociales) return {};
          try { return JSON.parse(user.redes_sociales); } catch { return {}; }
        })();
        const cambios = [];
        if (user.nombre !== nombre) cambios.push("nombre");
        if ((user.email || null) !== email) cambios.push("correo");
        if ((user.bio || null) !== bio) cambios.push("biografía");
        if ((user.experiencia || null) !== experiencia) cambios.push("experiencia");
        if ((user.avatar_url || null) !== avatarUrl) cambios.push("foto de perfil");
        if (JSON.stringify(redesAnteriores) !== JSON.stringify(redesLimpias)) cambios.push("redes sociales");

        await env.DB.prepare("UPDATE users SET nombre = ?, email = ?, bio = ?, experiencia = ?, avatar_url = ?, redes_sociales = ? WHERE id = ?")
          .bind(nombre, email, bio, experiencia, avatarUrl, Object.keys(redesLimpias).length ? JSON.stringify(redesLimpias) : null, user.id).run();

        // Mantenemos el mismo "sid": es la misma sesión de antes, solo
        // cambia el nombre incrustado en el JWT, así que no tiene sentido
        // crear una fila de sesión nueva por simplemente editar el perfil.
        const token = await createJWT({ uid: user.id, username: user.username, nombre, rol: user.rol, sid: payload.sid }, env.JWT_SECRET);
        const descripcionCambios = cambios.length
          ? `${nombre} ha editado su perfil: ${cambios.join(", ")}`
          : `${nombre} ha guardado su perfil sin cambios`;
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_perfil_propio", entidad: "usuario", entidad_id: payload.uid,
          descripcion: descripcionCambios,
          detalle: cambios.length ? { campos: cambios } : null,
        }));
        return json({
          ok: true,
          token,
          user: { id: user.id, username: user.username, nombre, rol: user.rol, email, bio, experiencia, avatar_url: avatarUrl, equipo: parsearEquipos(user.equipo), redes: redesLimpias },
        });
      }

      // ---------- MI PROGRESO (nivel y publicaciones) ----------
      // Progreso propio del colaborador conectado: nivel actual,
      // publicaciones contabilizadas y lo que le falta para el
      // siguiente nivel. Se usa en "Ajustes de cuenta" → "Mi progreso",
      // que se refresca solo (polling) sin que la persona tenga que
      // recargar la página.
      if (path === "/api/me/nivel" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const user = await env.DB.prepare("SELECT id, nivel, nivel_nota, rol FROM users WHERE id = ?").bind(payload.uid).first();
        if (!user) return json({ error: "Usuario no encontrado" }, 404);
        const progreso = await construirProgresoNivel(env, user);
        return json(progreso);
      }

      // ---------- SETTINGS (redes sociales y otros ajustes del medio) ----------
      // Se guardan todos juntos en una tabla clave/valor para poder editarlos
      // desde un único sitio (el panel de administración) en vez de tener
      // que tocar el código en varios archivos distintos.
      if (path === "/api/settings" && method === "GET") {
        const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'redes_sociales'").first();
        let redes = {};
        if (row) {
          try { redes = JSON.parse(row.value); } catch { redes = {}; }
        }
        return json({ redes });
      }

      if (path === "/api/settings" && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede modificar las redes sociales" }, 403);
        const body = await request.json();
        if (!body.redes || typeof body.redes !== "object" || Array.isArray(body.redes)) {
          return json({ error: "Faltan las redes sociales" }, 400);
        }
        // Solo guardamos texto (URLs); descartamos claves vacías o con
        // valores que no sean texto, para no guardar basura.
        const redesLimpias = {};
        for (const [key, val] of Object.entries(body.redes)) {
          if (typeof val === "string" && val.trim() !== "") redesLimpias[key] = val.trim();
        }
        await env.DB.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('redes_sociales', ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
        ).bind(JSON.stringify(redesLimpias)).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_settings", entidad: "settings",
          descripcion: `Ha modificado las redes sociales del medio`,
        }));
        return json({ ok: true, redes: redesLimpias });
      }

      // ---------- AUTORES (cualquier usuario logueado) ----------
      // Lista ligera (solo id + nombre) de redactores/admins activos, para
      // poder elegir "quién ha hecho la noticia" al crear o editar una
      // noticia/crónica sin depender de quién la esté subiendo. A
      // diferencia de /api/users, no exige rol admin ni expone datos
      // sensibles (usuario, correo, rol...).
      if (path === "/api/autores" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, nombre, equipo, redes_sociales FROM users WHERE activo = 1 ORDER BY nombre"
        ).all();
        const autores = results.map((a) => {
          let redes = {};
          if (a.redes_sociales) {
            try { redes = JSON.parse(a.redes_sociales); } catch { redes = {}; }
          }
          return { ...a, equipo: parsearEquipos(a.equipo), redes_sociales: undefined, redes };
        });
        return json({ autores });
      }

      // ---------- PERFIL PÚBLICO DE AUTOR ----------
      // Página pública (autor.html) a la que se enlaza desde el nombre del
      // autor en cada noticia: no exige sesión ni admin, cualquiera puede
      // verla. Solo se devuelven los datos pensados para ser públicos
      // (nombre, biografía, foto, redes propias) y sus noticias/crónicas
      // ya publicadas; nunca usuario, correo, rol, etc.
      const autorPublicoMatch = path.match(/^\/api\/autores\/(\d+)$/);
      if (autorPublicoMatch && method === "GET") {
        const id = parseInt(autorPublicoMatch[1], 10);
        const autor = await env.DB.prepare(
          "SELECT id, nombre, bio, experiencia, avatar_url, equipo, redes_sociales FROM users WHERE id = ? AND activo = 1"
        ).bind(id).first();
        if (!autor) return json({ error: "Autor no encontrado" }, 404);

        let redes = {};
        if (autor.redes_sociales) {
          try { redes = JSON.parse(autor.redes_sociales); } catch { redes = {}; }
        }

        const { results: articulos } = await env.DB.prepare(
          `SELECT id, slug, titulo, subtitulo, contenido, categoria, club, imagen_url, imagenes, autor_id, autor_nombre, coautor_id, coautor_nombre, fecha_publicacion
           FROM articles WHERE (autor_id = ? OR coautor_id = ?) AND publicado = 1 ORDER BY fecha_publicacion DESC LIMIT 30`
        ).bind(id, id).all();

        return json({
          autor: { id: autor.id, nombre: autor.nombre, bio: autor.bio || "", experiencia: autor.experiencia || "", avatar_url: autor.avatar_url || "", equipo: parsearEquipos(autor.equipo), redes },
          articulos: articulos.map((a) => ({ ...a, imagen_foco: focoDePortada(a), imagenes: undefined })),
        });
      }

      // ---------- HISTORIAL DE ACCIONES (solo admins) ----------
      // Permite filtrar por usuario, acción, entidad, texto libre (busca
      // en la descripción) y rango de fechas. Paginado con limit/offset.
      if (path === "/api/activity" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede ver el historial" }, 403);

        const usuarioId = url.searchParams.get("usuario_id");
        const accion = url.searchParams.get("accion");
        const entidad = url.searchParams.get("entidad");
        const q = url.searchParams.get("q");
        const desde = url.searchParams.get("desde"); // YYYY-MM-DD
        const hasta = url.searchParams.get("hasta"); // YYYY-MM-DD
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);

        let query = "SELECT * FROM activity_log WHERE 1=1";
        const binds = [];
        if (usuarioId) { query += " AND usuario_id = ?"; binds.push(parseInt(usuarioId, 10)); }
        if (accion) { query += " AND accion = ?"; binds.push(accion); }
        if (entidad) { query += " AND entidad = ?"; binds.push(entidad); }
        if (q) { query += " AND (descripcion LIKE ? OR usuario_nombre LIKE ?)"; binds.push(`%${q}%`, `%${q}%`); }
        if (desde) { query += " AND created_at >= ?"; binds.push(`${desde} 00:00:00`); }
        if (hasta) { query += " AND created_at <= ?"; binds.push(`${hasta} 23:59:59`); }
        // Si no se pasa "desde", se acota igualmente a los últimos 90 días
        // por defecto: sin esto, el COUNT(*) de abajo escaneaba
        // activity_log entera (solo crece, nunca se purga) cada vez que se
        // abría el panel de Actividad sin filtros — esta ruta ya fue la
        // causa de agotar la cuota diaria de D1 el 1-sep-2026.
        if (!desde) { query += " AND created_at >= datetime('now', '-90 days')"; }

        let countQuery = query.replace("SELECT *", "SELECT COUNT(*) AS total");
        const totalRow = await env.DB.prepare(countQuery).bind(...binds).first();

        query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
        binds.push(limit, offset);
        const { results } = await env.DB.prepare(query).bind(...binds).all();

        // Lista de acciones y usuarios distintos, para rellenar los
        // desplegables de filtro en el panel sin tener que traerse todo
        // el historial. IMPORTANTE: acotado a los últimos 90 días -- sin
        // este filtro, estas dos consultas escaneaban la tabla
        // activity_log ENTERA (que solo crece, nunca se purga) cada vez
        // que se abría el panel de Actividad, y fueron la causa de
        // agotar la cuota diaria gratuita de lecturas de D1 (ver aviso
        // del 1-sep-2026). 90 días es de sobra para los desplegables de
        // filtro sin necesitar leer años de histórico en cada carga.
        const { results: accionesDistintas } = await env.DB.prepare(
          "SELECT DISTINCT accion FROM activity_log WHERE created_at >= datetime('now', '-90 days') ORDER BY accion"
        ).all();
        const { results: usuariosDistintos } = await env.DB.prepare(
          "SELECT DISTINCT usuario_id, usuario_nombre FROM activity_log WHERE usuario_id IS NOT NULL AND created_at >= datetime('now', '-90 days') ORDER BY usuario_nombre"
        ).all();
        // Se añade el equipo de cada usuario (si lo tiene) para poder
        // diferenciar en el desplegable de filtro a usuarios con el mismo
        // nombre, igual que se hace en el selector de autor de la noticia.
        const { results: equiposUsuarios } = await env.DB.prepare(
          "SELECT id, equipo FROM users"
        ).all();
        const equipoPorUsuarioId = {};
        equiposUsuarios.forEach((u) => { equipoPorUsuarioId[u.id] = parsearEquipos(u.equipo); });
        const usuariosConEquipo = usuariosDistintos.map((u) => ({
          ...u,
          usuario_equipo: equipoPorUsuarioId[u.usuario_id] || [],
        }));

        return json({
          actividad: results,
          total: totalRow ? totalRow.total : 0,
          acciones: accionesDistintas.map((a) => a.accion),
          usuarios: usuariosConEquipo,
        });
      }

      // ---------- NEWSLETTER: suscriptores (solo admins) ----------
      if (path === "/api/newsletter/suscriptores" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede ver los suscriptores" }, 403);
        const { results } = await env.DB.prepare(
          "SELECT id, email, activo, created_at, baja_at FROM newsletter_suscriptores ORDER BY created_at DESC"
        ).all();
        // Se adjunta aquí también cuándo fue el último envío automático y
        // cuándo tocaría el próximo (mismo criterio de "7 días desde el
        // último" que usa enviarBoletinSemanalSiToca), para que el panel
        // pueda mostrarlo sin necesitar un endpoint aparte. Un envío
        // manual (POST /api/newsletter/enviar) no toca newsletter_envios
        // a propósito, así que esta fecha es siempre la del ciclo
        // automático semanal, no la del último envío puntual que haya
        // hecho un admin.
        const filaEnvio = await env.DB.prepare(
          "SELECT ultimo_envio_at FROM newsletter_envios WHERE id = 1"
        ).first();
        const ultimoEnvioAt = filaEnvio && filaEnvio.ultimo_envio_at ? filaEnvio.ultimo_envio_at : null;
        const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
        let proximoEnvioAt = null;
        if (ultimoEnvioAt) {
          const ultimoMs = new Date(ultimoEnvioAt + "Z").getTime();
          if (!isNaN(ultimoMs)) {
            proximoEnvioAt = new Date(ultimoMs + SIETE_DIAS_MS).toISOString();
          }
        }
        // Si nunca se ha registrado un envío automático, enviarBoletinSemanalSiToca()
        // lo dispara en el siguiente pase del cron (no espera 7 días la
        // primera vez): se refleja aquí como "ahora mismo" en vez de null.
        return json({
          suscriptores: results,
          ultimo_envio_at: ultimoEnvioAt,
          proximo_envio_at: proximoEnvioAt || (ultimoEnvioAt ? null : new Date().toISOString()),
        });
      }

      if (path.match(/^\/api\/newsletter\/suscriptores\/\d+$/) && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede eliminar suscriptores" }, 403);
        const id = Number(path.split("/").pop());
        await env.DB.prepare("DELETE FROM newsletter_suscriptores WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      // ---------- NEWSLETTER: envío manual (solo admins) ----------
      // Complementa el envío automático semanal (enviarBoletinSemanalSiToca,
      // disparado desde el cron): permite a un admin forzar un envío puntual
      // -por ejemplo tras una noticia importante, sin esperar al día que
      // toque- y elegir a quién exactamente se le manda, en vez de siempre
      // "a todos los activos". No toca newsletter_envios (esa tabla es solo
      // para el cálculo de "cuándo toca" del envío automático semanal), así
      // que un envío manual no adelanta ni retrasa el próximo boletín
      // automático.
      if (path === "/api/newsletter/enviar" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede enviar el boletín" }, 403);
        const body = await request.json().catch(() => ({}));

        // "suscriptor_ids" es opcional: si no se manda (o se manda vacío
        // con "todos: true"), se envía a todos los suscriptores activos,
        // igual que el envío automático. Si se manda una lista de ids, se
        // envía solo a esos (deben seguir activos: no tiene sentido
        // reactivar a alguien que se dio de baja solo por seleccionarlo).
        let destinatarios;
        if (Array.isArray(body.suscriptor_ids) && body.suscriptor_ids.length) {
          const ids = body.suscriptor_ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n));
          if (!ids.length) return json({ error: "Selección de destinatarios no válida" }, 400);
          const placeholders = ids.map(() => "?").join(",");
          const { results } = await env.DB.prepare(
            `SELECT email, baja_token FROM newsletter_suscriptores WHERE activo = 1 AND id IN (${placeholders})`
          ).bind(...ids).all();
          destinatarios = results;
        } else {
          const { results } = await env.DB.prepare(
            "SELECT email, baja_token FROM newsletter_suscriptores WHERE activo = 1"
          ).all();
          destinatarios = results;
        }
        if (!destinatarios.length) {
          return json({ error: "No hay ningún destinatario activo para esa selección" }, 400);
        }

        // Mismo criterio de contenido que el envío automático: las últimas
        // noticias publicadas (hasta 8). Un admin que quiera mandar un
        // boletín puntual normalmente lo hace precisamente para difundir
        // lo último publicado, así que no hace falta un formulario aparte
        // para elegir artículos.
        const { results: articulos } = await env.DB.prepare(
          `SELECT slug, titulo, categoria, imagen_url FROM articles
           WHERE publicado = 1 ORDER BY fecha_publicacion DESC LIMIT 8`
        ).all();
        if (!articulos.length) {
          return json({ error: "No hay noticias publicadas para incluir en el boletín" }, 400);
        }

        // Mismos bloques que el envío automático semanal: clasificación
        // por competición/grupo, resultados destacados recientes (última
        // semana) y encuestas abiertas en portada.
        const COMPETICIONES_BOLETIN = ["hypermotion", "primera_federacion", "segunda_federacion"];
        const clasificaciones = [];
        for (const competicion of COMPETICIONES_BOLETIN) {
          const grupos = await obtenerClasificacionesPorGrupo(env, competicion);
          if (grupos.length) clasificaciones.push({ competicion, grupos });
        }
        const hace7dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
        const resultadosDestacados = await obtenerResultadosDestacadosBoletin(env, hace7dias);
        const encuestas = await obtenerEncuestasAbiertasBoletin(env);

        await enviarBoletinALista(env, { destinatarios, articulos, clasificaciones, resultadosDestacados, encuestas });

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "newsletter_envio_manual", entidad: "newsletter", entidad_id: null,
          descripcion: `Ha enviado el boletín manualmente a ${destinatarios.length} suscriptor(es)`,
        }));

        return json({ ok: true, enviados: destinatarios.length });
      }

      // ---------- LECTORES (cuentas públicas, solo lectura para admins) ----------
      // Solo lectura desde el panel: los lectores se gestionan a sí mismos
      // (registro, verificación, contraseña) desde la web pública. Nunca se
      // devuelve password_hash ni salt.
      if (path === "/api/readers" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede ver los lectores" }, 403);
        const { results } = await env.DB.prepare(
          "SELECT id, nombre, email, email_verificado, activo, created_at FROM readers ORDER BY created_at DESC"
        ).all();
        return json({ readers: results });
      }

      // ---------- USUARIOS (solo admins) ----------
      // Nunca se devuelve password_hash ni salt: las contraseñas están
      // cifradas y no se pueden consultar, solo restablecer.
      if (path === "/api/users" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede ver los usuarios" }, 403);
        const { results } = await env.DB.prepare(
          "SELECT id, username, nombre, rol, activo, email, equipo, avatar_url, nivel, nivel_nota, created_at FROM users ORDER BY nombre"
        ).all();
        // El progreso de nivel de TODOS los usuarios se calcula con una
        // sola consulta agregada (antes: una consulta por usuario,
        // repitiendo un escaneo completo de "articles" tantas veces como
        // usuarios hubiera listados; ver contarPublicacionesPorTipoDeVarios).
        // Al pasarle el conteo ya calculado, construirProgresoNivel no
        // vuelve a tocar la base de datos, así que resolver todo en
        // paralelo aquí ya no dispara ninguna consulta extra.
        const conteos = await contarPublicacionesPorTipoDeVarios(env, results.map((u) => u.id));
        const users = await Promise.all(results.map(async (u) => ({
          ...u,
          equipo: parsearEquipos(u.equipo),
          progreso_nivel: await construirProgresoNivel(env, u, conteos.get(u.id)),
        })));
        return json({ users });
      }

      if (path === "/api/users" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede crear usuarios" }, 403);
        const body = await request.json();
        if (!body.username || !body.nombre) return json({ error: "Faltan campos obligatorios" }, 400);
        const username = body.username.trim().toLowerCase();
        if (!/^[a-z0-9_.]+$/.test(username)) {
          return json({ error: "El usuario solo puede tener letras, números, puntos y guiones bajos" }, 400);
        }
        const existe = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
        if (existe) return json({ error: "Ya existe un usuario con ese nombre de usuario" }, 400);

        const passwordInicial = body.password && body.password.length >= 8 ? body.password : generatePassword();
        const salt = randomSalt();
        const hash = await hashPassword(passwordInicial, salt);
        const rol = body.rol === "admin" ? "admin" : "redactor";

        // El equipo es opcional, pero si se manda alguno hay que elegir
        // hasta 3 (ver validarEquipos).
        const { error: errorEquipo, equipos: equiposNuevos } = validarEquipos(body.equipo);
        if (errorEquipo) return json({ error: errorEquipo }, 400);
        const equipoNuevo = equiposNuevos.length ? JSON.stringify(equiposNuevos) : null;

        await env.DB.prepare(
          `INSERT INTO users (username, password_hash, salt, nombre, rol, activo, email, equipo) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        ).bind(username, hash, salt, body.nombre, rol, body.email ? body.email.trim() : null, equipoNuevo).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_usuario", entidad: "usuario", entidad_id: username,
          descripcion: `Ha creado el usuario "${username}" (${rol})`,
        }));

        // La contraseña en claro solo se devuelve aquí, en el momento de
        // crear el usuario, para que el admin pueda comunicársela.
        return json({ ok: true, username, password: passwordInicial });
      }

      // ---------- USUARIOS: restablecer contraseña ----------
      const resetPassMatch = path.match(/^\/api\/users\/(\d+)\/reset-password$/);
      if (resetPassMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede restablecer contraseñas" }, 403);
        const id = parseInt(resetPassMatch[1]);
        const user = await env.DB.prepare("SELECT id, username FROM users WHERE id = ?").bind(id).first();
        if (!user) return json({ error: "Usuario no encontrado" }, 404);

        const body = await request.json().catch(() => ({}));
        const nuevaPassword = body.nueva && body.nueva.length >= 8 ? body.nueva : generatePassword();
        const salt = randomSalt();
        const hash = await hashPassword(nuevaPassword, salt);
        await env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").bind(hash, salt, id).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "restablecer_password", entidad: "usuario", entidad_id: id,
          descripcion: `Ha restablecido la contraseña de "${user.username}"`,
        }));

        return json({ ok: true, username: user.username, password: nuevaPassword });
      }

      // ---------- USUARIOS: cambiar de nivel (a mano, por un admin) ----------
      // El nivel nunca sube solo por cumplir las cifras: lo decide un
      // admin evaluando también calidad, puntualidad, cumplimiento de
      // normas, etc. (ver documento del sistema de niveles). Esta ruta
      // permite subir o bajar el nivel de cualquier colaborador, con un
      // motivo opcional, dejando constancia en nivel_historial y en el
      // historial general de actividad.
      const nivelMatch = path.match(/^\/api\/users\/(\d+)\/nivel$/);
      if (nivelMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede cambiar el nivel de un colaborador" }, 403);
        const id = parseInt(nivelMatch[1]);
        const user = await env.DB.prepare("SELECT id, nombre, nivel, rol FROM users WHERE id = ?").bind(id).first();
        if (!user) return json({ error: "Usuario no encontrado" }, 404);
        // Los admins siempre están al nivel máximo mientras tengan ese
        // rol: no se les puede subir ni bajar a mano. Si se quiere que
        // un admin vuelva a tener un nivel "normal", primero hay que
        // quitarle el rol de administrador.
        if (user.rol === "admin") {
          return json({ error: "Los administradores están siempre en el nivel máximo y no se puede editar su nivel mientras tengan ese rol" }, 400);
        }

        const body = await request.json().catch(() => ({}));
        const nuevoNivel = parseInt(body.nivel);
        if (![1, 2, 3, 4].includes(nuevoNivel)) {
          return json({ error: "El nivel debe ser 1, 2, 3 o 4" }, 400);
        }
        const nota = typeof body.nota === "string" ? body.nota.trim().slice(0, 500) : null;
        const nivelAnterior = user.nivel || 1;

        await env.DB.prepare("UPDATE users SET nivel = ?, nivel_nota = ? WHERE id = ?")
          .bind(nuevoNivel, nota, id).run();

        if (nuevoNivel !== nivelAnterior) {
          await env.DB.prepare(
            `INSERT INTO nivel_historial (usuario_id, usuario_nombre, nivel_anterior, nivel_nuevo, motivo, cambiado_por_id, cambiado_por_nombre)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(user.id, user.nombre, nivelAnterior, nuevoNivel, nota, payload.uid, payload.nombre).run();
        }

        const subeOBaja = nuevoNivel > nivelAnterior ? "subido" : (nuevoNivel < nivelAnterior ? "bajado" : "actualizado");
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "cambiar_nivel_usuario", entidad: "usuario", entidad_id: id,
          descripcion: `Ha ${subeOBaja} el nivel de "${user.nombre}" de ${nivelAnterior} a ${nuevoNivel}${nota ? `: ${nota}` : ""}`,
          detalle: { nivel_anterior: nivelAnterior, nivel_nuevo: nuevoNivel, nota },
        }));

        const userActualizado = await env.DB.prepare("SELECT id, nivel, nivel_nota, rol FROM users WHERE id = ?").bind(id).first();
        const progreso = await construirProgresoNivel(env, userActualizado);
        return json({ ok: true, ...progreso });
      }

      // ---------- USUARIOS: historial de cambios de nivel ----------
      const nivelHistorialMatch = path.match(/^\/api\/users\/(\d+)\/nivel-historial$/);
      if (nivelHistorialMatch && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede ver el historial de niveles" }, 403);
        const id = parseInt(nivelHistorialMatch[1]);
        const { results } = await env.DB.prepare(
          `SELECT nivel_anterior, nivel_nuevo, motivo, cambiado_por_nombre, created_at
           FROM nivel_historial WHERE usuario_id = ? ORDER BY created_at DESC LIMIT 50`
        ).bind(id).all();
        return json({ historial: results });
      }

      // ---------- USUARIOS: editar / eliminar ----------
      const userMatch = path.match(/^\/api\/users\/(\d+)$/);
      if (userMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede editar usuarios" }, 403);
        const id = parseInt(userMatch[1]);
        const body = await request.json();
        const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
        if (!user) return json({ error: "Usuario no encontrado" }, 404);

        // Evita que un admin se quite a sí mismo el rol o se desactive,
        // para no quedarse fuera del panel por error.
        if (id === payload.uid && body.rol && body.rol !== "admin") {
          return json({ error: "No puedes quitarte a ti mismo el rol de administrador" }, 400);
        }
        if (id === payload.uid && body.activo === false) {
          return json({ error: "No puedes desactivar tu propia cuenta" }, 400);
        }

        // El equipo solo lo puede cambiar un admin (esta ruta ya exige
        // rol admin arriba). Si no se manda "equipo" en el body, se deja
        // el que ya tuviera; si se manda, se valida que no pase de 3.
        let equipoActualizado = user.equipo;
        if (body.equipo !== undefined) {
          const { error: errorEquipo, equipos: equiposNuevos } = validarEquipos(body.equipo);
          if (errorEquipo) return json({ error: errorEquipo }, 400);
          equipoActualizado = equiposNuevos.length ? JSON.stringify(equiposNuevos) : null;
        }

        await env.DB.prepare(
          `UPDATE users SET nombre = ?, rol = ?, activo = ?, email = ?, equipo = ? WHERE id = ?`
        ).bind(
          body.nombre !== undefined ? body.nombre : user.nombre,
          body.rol === "admin" || body.rol === "redactor" ? body.rol : user.rol,
          body.activo === undefined ? user.activo : (body.activo ? 1 : 0),
          body.email !== undefined ? (body.email ? body.email.trim() : null) : user.email,
          equipoActualizado,
          id
        ).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_usuario", entidad: "usuario", entidad_id: id,
          descripcion: `Ha editado el usuario "${user.username}"`,
          detalle: body,
        }));

        return json({ ok: true });
      }

      if (userMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede eliminar usuarios" }, 403);
        const id = parseInt(userMatch[1]);
        if (id === payload.uid) return json({ error: "No puedes eliminar tu propia cuenta" }, 400);
        const userBorrado = await env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(id).first();
        // El historial de acciones guarda el nombre en texto aparte
        // (usuario_nombre), así que al eliminar la cuenta solo hace
        // falta soltar la referencia (usuario_id) para no chocar con la
        // clave foránea; las entradas de su actividad pasada se
        // conservan igual. Lo mismo para el resto de tablas que
        // referencian users(id): se limpia o reasigna la referencia
        // antes de borrar, si no D1 rechaza el DELETE por FOREIGN KEY.
        await env.DB.prepare("UPDATE activity_log SET usuario_id = NULL WHERE usuario_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE articles SET autor_id = NULL WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE articles SET coautor_id = NULL WHERE coautor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE media SET autor_id = NULL WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE results SET autor_id = NULL WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE custom_clubs SET autor_id = NULL WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE alineaciones SET autor_id = NULL WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE comments SET moderado_por_id = NULL WHERE moderado_por_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE club_info SET autor_id = NULL WHERE autor_id = ?").bind(id).run();
        // solicitante_id es NOT NULL en club_info_solicitudes: no se puede
        // poner a NULL (mismo caso que nivel_historial.usuario_id más
        // abajo), así que se borran las solicitudes que hizo esta persona.
        await env.DB.prepare("DELETE FROM club_info_solicitudes WHERE solicitante_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE club_info_solicitudes SET resuelta_por_id = NULL WHERE resuelta_por_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
        // usuario_id es NOT NULL en nivel_historial: no se puede poner a
        // NULL, así que se borra su historial de cambios de nivel.
        await env.DB.prepare("DELETE FROM nivel_historial WHERE usuario_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE nivel_historial SET cambiado_por_id = NULL WHERE cambiado_por_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM edit_requests WHERE solicitante_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE edit_requests SET autor_id = NULL WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE edit_requests SET resuelta_por_id = NULL WHERE resuelta_por_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "eliminar_usuario", entidad: "usuario", entidad_id: id,
          descripcion: `Ha eliminado el usuario "${userBorrado ? userBorrado.username : id}"`,
        }));
        return json({ ok: true });
      }

      // ---------- MEDIA: subir contenido (fotos/vídeos) ----------
      // Cualquier usuario logueado (redactor o admin) puede subir. El
      // archivo se guarda en Cloudinary tal cual llega —sin recomprimir
      // ni transformar— para no perder ni un ápice de calidad.
      if (path === "/api/media" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);

        const form = await request.formData();
        const file = form.get("archivo");
        const titulo = (form.get("titulo") || "").toString().trim();
        const descripcion = (form.get("descripcion") || "").toString().trim();
        const club = (form.get("club") || "").toString().trim();

        if (!file || typeof file === "string") return json({ error: "Falta el archivo" }, 400);
        if (!titulo) return json({ error: "Falta el título" }, 400);
        if (titulo.length > 200) return json({ error: "El título es demasiado largo (máximo 200 caracteres)" }, 400);
        if (descripcion.length > 2000) return json({ error: "La descripción es demasiado larga (máximo 2000 caracteres)" }, 400);
        if (file.size === 0) return json({ error: "El archivo está vacío" }, 400);

        // Antes de gastar tiempo y ancho de banda subiendo el archivo a
        // Cloudinary, calculamos su hash y comprobamos si ya existe algo
        // idéntico en la mediateca. Así el aviso de "ya se ha subido
        // este archivo" llega rápido y sin subir nada dos veces. Estos
        // mismos bytes se reutilizan más abajo para la subida en sí (ver
        // procesarSubidaArchivo): con archivos grandes, leer el archivo
        // dos veces significaba tener dos copias enteras en memoria a la
        // vez y podía agotar la memoria del Worker.
        let fileBytes, hashArchivo;
        try {
          fileBytes = await file.arrayBuffer();
          hashArchivo = await sha256Hex(fileBytes);
        } catch (err) {
          return json({ error: "No se pudo leer el archivo" }, 400);
        }
        // La comprobación de duplicados es un "extra": si por lo que sea
        // falla (p. ej. la columna hash_archivo no existe todavía porque
        // no se ha ejecutado migracion_media_hash.sql en esta base de
        // datos), no debe tirar abajo la subida entera. Se registra el
        // fallo pero se continúa sin bloquear por duplicado en ese caso.
        let duplicado = null;
        try {
          duplicado = await env.DB.prepare(
            "SELECT id, titulo, autor_nombre FROM media WHERE hash_archivo = ?"
          ).bind(hashArchivo).first();
        } catch (err) {
          console.error("Comprobación de duplicados en /api/media falló (se continúa sin bloquear):", err.message);
        }
        if (duplicado) {
          return json({
            error: `Este archivo ya se subió antes con el título "${duplicado.titulo}"${duplicado.autor_nombre ? ` (por ${duplicado.autor_nombre})` : ""}. No se puede subir el mismo contenido dos veces.`,
            duplicado: true,
            mediaId: duplicado.id,
          }, 409);
        }

        // Se sube el archivo completo, byte a byte, sin ninguna
        // recodificación ni compresión: se guarda en Cloudinary
        // exactamente como llega, así se conserva la calidad original.
        // La validación (formato y tamaño) y la subida pasan por el mismo
        // punto único que usa /api/subir-imagen.
        let subida;
        try {
          subida = await procesarSubidaArchivo(env, file, { permitirVideo: true }, fileBytes);
        } catch (err) {
          if (err.esValidacion) return json({ error: err.message }, 400);
          return json({ error: "No se pudo subir el archivo a Cloudinary. Comprueba tu conexión e inténtalo de nuevo.", detail: err.message }, 502);
        }
        const esFoto = esImagenPermitida(file.type) || ((!file.type || file.type === "application/octet-stream") && extensionImagenPermitida(file.name));

        // hash_archivo es una columna añadida por una migración manual
        // que hay que ejecutar aparte: si no se ha aplicado en esta base
        // de datos, la columna no existe y el INSERT de más abajo fallaba
        // siempre (con el archivo YA subido a Cloudinary, lo peor
        // posible). Se intenta primero con hash_archivo y, si falla
        // específicamente porque la columna no existe (mensaje de
        // SQLite o de PostgreSQL, según cuál esté detrás de env.DB aquí),
        // se reintenta sin ella.
        try {
          await env.DB.prepare(
            `INSERT INTO media (cloudinary_public_id, cloudinary_resource_type, cloudinary_url, titulo, descripcion, tipo, nombre_archivo, content_type, tamano_bytes, autor_id, autor_nombre, club, hash_archivo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            subida.publicId, subida.resourceType, subida.url,
            titulo, descripcion || null, esFoto ? "foto" : "video",
            file.name, file.type, file.size, payload.uid, payload.nombre, club || null, hashArchivo
          ).run();
        } catch (err) {
          const esColumnaFaltante = /no such column|no column named|column .* does not exist/i.test(err.message || "") && /hash_archivo/i.test(err.message || "");
          if (esColumnaFaltante) {
            try {
              await env.DB.prepare(
                `INSERT INTO media (cloudinary_public_id, cloudinary_resource_type, cloudinary_url, titulo, descripcion, tipo, nombre_archivo, content_type, tamano_bytes, autor_id, autor_nombre, club)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                subida.publicId, subida.resourceType, subida.url,
                titulo, descripcion || null, esFoto ? "foto" : "video",
                file.name, file.type, file.size, payload.uid, payload.nombre, club || null
              ).run();
            } catch (err2) {
              ctx.waitUntil(borrarDeCloudinary(env, subida.publicId, subida.resourceType));
              return json({ error: "No se pudo guardar el archivo. Inténtalo de nuevo.", detail: err2.message }, 500);
            }
          } else {
          // Red de seguridad final por si dos subidas del mismo archivo
          // llegan casi a la vez (condición de carrera): el índice único
          // de la base de datos rechaza la segunda, y aquí deshacemos lo
          // ya subido a Cloudinary para no dejar un archivo huérfano.
          const esDuplicadoBD = /unique/i.test(err.message || "");
          ctx.waitUntil(borrarDeCloudinary(env, subida.publicId, subida.resourceType));
          if (esDuplicadoBD) {
            return json({ error: "Este archivo ya se ha subido (se ha detectado justo ahora, puede que alguien lo subiera al mismo tiempo).", duplicado: true }, 409);
          }
          return json({ error: "No se pudo guardar el archivo. Inténtalo de nuevo.", detail: err.message }, 500);
          }
        }

        ctx.waitUntil(enviarEmailNotificacion(env, {
          asunto: `Nuevo ${esFoto ? "foto" : "vídeo"} subido: ${titulo}`,
          texto: `${payload.nombre} ha subido "${titulo}" (${esFoto ? "foto" : "vídeo"}) a ELOTROFÚTBOLTV.${club ? `\nClub: ${club}` : ""}${descripcion ? `\nDescripción: ${descripcion}` : ""}\n\nEntra en el panel de administración para verlo y descargarlo.`,
          html: plantillaEmail({
            etiqueta: `Nuevo ${esFoto ? "foto" : "vídeo"}`,
            titulo,
            parrafo: descripcion || null,
            filas: [
              { etiqueta: "Subido por", valor: payload.nombre },
              { etiqueta: "Club", valor: club },
            ],
            boton: { texto: "Ver en el panel", url: `${SITIO_URL}/admin/panel.html` },
          }),
        }));

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "subir_media", entidad: "media", entidad_id: subida.publicId,
          descripcion: `Ha subido ${esFoto ? "una foto" : "un vídeo"}: "${titulo}"`,
        }));

        return json({ ok: true });
      }

      // ---------- SUBIR IMAGEN SUELTA (foto de perfil, fotos de una noticia...) ----------
      // A diferencia de /api/media (que además guarda un registro en la
      // mediateca para poder descargarlo más tarde), este endpoint solo
      // sube la imagen a Cloudinary y devuelve su URL, para pegarla
      // directamente en el campo de foto de perfil o en las fotos de una
      // noticia/crónica sin pasar por ningún listado.
      if (path === "/api/subir-imagen" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);

        const form = await request.formData();
        const file = form.get("imagen");
        try {
          const subida = await procesarSubidaArchivo(env, file, { permitirVideo: false });
          return json({ url: subida.url });
        } catch (err) {
          if (err.esValidacion) return json({ error: err.message }, 400);
          return json({ error: "No se pudo subir la imagen", detail: err.message }, 502);
        }
      }

      const mediaMatch = path.match(/^\/api\/media\/(\d+)$/);

      // ---------- MEDIA: listado ----------
      // Los administradores ven todo lo subido por el equipo; un redactor
      // normal solo ve (y por tanto solo puede editar) lo que ha subido él.
      if (path === "/api/media" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const base = "SELECT id, cloudinary_url, titulo, descripcion, tipo, nombre_archivo, content_type, tamano_bytes, autor_id, autor_nombre, club, created_at FROM media";
        const { results } = payload.rol === "admin"
          ? await env.DB.prepare(`${base} ORDER BY created_at DESC`).all()
          : await env.DB.prepare(`${base} WHERE autor_id = ? ORDER BY created_at DESC`).bind(payload.uid).all();
        return json({ media: results });
      }

      // ---------- MEDIA: editar título/club/descripción ----------
      // Solo puede editar un archivo la persona que lo subió (comparando
      // autor_id con el usuario autenticado); no se puede sustituir el
      // archivo en sí, solo sus datos.
      if (mediaMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(mediaMatch[1]);
        const registro = await env.DB.prepare("SELECT autor_id FROM media WHERE id = ?").bind(id).first();
        if (!registro) return json({ error: "No encontrado" }, 404);
        if (registro.autor_id !== payload.uid) {
          return json({ error: "Solo la persona que subió este contenido puede editarlo" }, 403);
        }
        const body = await request.json();
        const titulo = (body.titulo || "").toString().trim();
        if (!titulo) return json({ error: "Falta el título" }, 400);
        const descripcion = (body.descripcion || "").toString().trim();
        const club = (body.club || "").toString().trim();
        await env.DB.prepare(
          "UPDATE media SET titulo = ?, descripcion = ?, club = ? WHERE id = ?"
        ).bind(titulo, descripcion || null, club || null, id).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_media", entidad: "media", entidad_id: id,
          descripcion: `Ha editado el contenido "${titulo}"`,
        }));
        return json({ ok: true });
      }

      // ---------- MEDIA: descarga del archivo original (solo admins) ----------
      const mediaDownloadMatch = path.match(/^\/api\/media\/(\d+)\/descargar$/);
      if (mediaDownloadMatch && method === "GET") {
        const payload = await requireAuth(request, env, url);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede descargar contenido" }, 403);
        const id = parseInt(mediaDownloadMatch[1]);
        const registro = await env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(id).first();
        if (!registro) return json({ error: "No encontrado" }, 404);

        const objeto = await fetch(registro.cloudinary_url);
        if (!objeto.ok) return json({ error: "El archivo ya no está disponible" }, 404);

        const headers = new Headers();
        headers.set("Content-Type", registro.content_type);
        headers.set("Content-Length", registro.tamano_bytes.toString());
        headers.set("Content-Disposition", `attachment; filename="${registro.nombre_archivo.replace(/"/g, "")}"`);
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "descargar_media", entidad: "media", entidad_id: id,
          descripcion: `Ha descargado el archivo "${registro.nombre_archivo}"`,
        }));
        return cors(new Response(objeto.body, { headers }));
      }

      // ---------- MEDIA: eliminar (solo admins) ----------
      if (mediaMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede eliminar contenido" }, 403);
        const id = parseInt(mediaMatch[1]);
        const registro = await env.DB.prepare("SELECT cloudinary_public_id, cloudinary_resource_type FROM media WHERE id = ?").bind(id).first();
        if (!registro) return json({ error: "No encontrado" }, 404);
        await borrarDeCloudinary(env, registro.cloudinary_public_id, registro.cloudinary_resource_type);
        await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(id).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "eliminar_media", entidad: "media", entidad_id: id,
          descripcion: `Ha eliminado un contenido multimedia (id ${id})`,
        }));
        return json({ ok: true });
      }

      // ---------- ARTICLES: lista pública / creación ----------
      // ---------- Banner flotante de "última hora" (público) ----------
      // Ver el comentario gemelo en worker/src/index.js.
      if (path === "/api/articles/banner-urgente" && method === "GET") {
        const fila = await env.DB.prepare(
          `SELECT slug, titulo, categoria FROM articles
           WHERE banner_urgente = 1 AND banner_urgente_hasta > datetime('now') AND publicado = 1
           ORDER BY banner_urgente_hasta DESC LIMIT 1`
        ).first();
        if (!fila) return json({ activo: false });
        return json({
          activo: true,
          titulo: fila.titulo,
          url: urlNoticia(fila.categoria, fila.slug),
        });
      }
      const desactivarBannerMatch = path.match(/^\/api\/articles\/(\d+)\/banner-urgente$/);
      if (desactivarBannerMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(desactivarBannerMatch[1], 10);
        const articulo = await env.DB.prepare("SELECT autor_id, coautor_id FROM articles WHERE id = ?").bind(id).first();
        if (!articulo) return json({ error: "Noticia no encontrada" }, 404);
        if (!(await puedeEditar(env, payload, "articulo", id, articulo.autor_id, articulo.coautor_id))) {
          return json({ error: "No puedes modificar esta noticia." }, 403);
        }
        const nivelUsuario = payload.rol === "admin" ? NIVEL_MAXIMO : await obtenerNivelUsuario(env, payload.uid);
        if (payload.rol !== "admin" && nivelUsuario < 2) {
          return json({ error: "No tienes permiso para gestionar el banner de última hora." }, 403);
        }
        await env.DB.prepare("UPDATE articles SET banner_urgente = 0, banner_urgente_hasta = NULL, updated_at = datetime('now') WHERE id = ?").bind(id).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "quitar_banner_urgente", entidad: "articulo", entidad_id: id,
          descripcion: `Ha quitado el banner de última hora de la noticia #${id}.`,
        }));
        return json({ ok: true });
      }

      if (path === "/api/articles" && method === "GET") {
        const categoria = url.searchParams.get("categoria");
        const club = url.searchParams.get("club");
        const tipo = url.searchParams.get("tipo");
        const autorId = url.searchParams.get("autor_id");
        const destacado = url.searchParams.get("destacado");
        const busqueda = url.searchParams.get("q");
        // Filtro por slug exacto: lo usa el _worker.js de Cloudflare Pages
        // para resolver, dado el slug suelto de un enlace antiguo
        // (noticia.html?slug=...), a qué categoría pertenece y así poder
        // hacer el 301 a la URL bonita /futbol/{categoria}/{slug}.
        const slugExacto = url.searchParams.get("slug");
        // Tope máximo de 2000 (mismo criterio que /api/results): sin este
        // cap, cualquiera podía pedir ?limit=100000 y forzar un
        // escaneo/orden gigante sobre articles. Antes el tope era 100, lo
        // que dejaba fuera del panel de Redacción > Noticias cualquier
        // noticia que no estuviera entre las 100 más recientes (el
        // buscador de ese listado solo filtra en texto DENTRO de lo ya
        // traído), aunque siguiera existiendo en la base de datos.
        const limitPedido = parseInt(url.searchParams.get("limit") || "30", 10);
        const limit = Number.isInteger(limitPedido) && limitPedido > 0 ? Math.min(limitPedido, 2000) : 30;
        let admin = url.searchParams.get("admin") === "1";
        if (admin) {
          // La vista "admin" incluye borradores no publicados, así que
          // exige un token válido; si no lo hay, se trata como pública.
          const payload = await requireAuth(request, env);
          if (!payload) admin = false;
        }

        // Columnas necesarias para tarjetas/listados. Se mantiene
        // "contenido" (el resumen de portada lo usa como fallback cuando
        // no hay subtítulo, ver public/js/main.js), pero se excluyen las
        // 4 variantes traducidas del cuerpo completo (contenido_eu/ca/gl/
        // en): son columnas grandes de HTML que los listados nunca
        // muestran. Para saber qué idiomas están completos
        // (conIdiomasDisponibles exige título Y contenido no vacíos) basta
        // con la LONGITUD del contenido traducido, no su texto: se pide
        // como "contenido_XX_len" y se traduce a un booleano equivalente
        // a tener contenido, sin transferir el HTML entero.
        let query = `SELECT id, slug, titulo, subtitulo, contenido, tipo, categoria, club, imagen_url, imagenes,
            resultado_id, autor_id, autor_nombre, coautor_id, coautor_nombre, destacado, publicado,
            estado_borrador, programado_para, slug_congelado, fecha_publicacion, created_at, updated_at,
            titulo_eu, LENGTH(contenido_eu) AS contenido_eu_len,
            titulo_ca, LENGTH(contenido_ca) AS contenido_ca_len,
            titulo_gl, LENGTH(contenido_gl) AS contenido_gl_len,
            titulo_en, LENGTH(contenido_en) AS contenido_en_len,
            ficha_tecnica
          FROM articles WHERE 1=1`;
        const binds = [];
        if (!admin) {
          query += " AND publicado = 1";
        }
        if (slugExacto) { query += " AND slug = ?"; binds.push(slugExacto); }
        if (categoria) { query += " AND categoria = ?"; binds.push(categoria); }
        // "club" puede ser un único nombre en texto plano (caso normal) o
        // un array JSON de 2 clubes en texto (previa/crónica vinculada a
        // un resultado, ver resolverClubArticulo): se busca coincidencia
        // exacta del valor completo (club único que es justo ese) o el
        // nombre apareciendo como elemento del array JSON. Se usan
        // comillas dobles alrededor del nombre buscado para que el LIKE
        // sobre el array (p. ej. '["Real Madrid","FC Barcelona"]') no dé
        // falsos positivos con un club cuyo nombre sea substring de otro.
        if (club) {
          query += " AND (club = ? OR club LIKE ?)";
          binds.push(club, `%"${club}"%`);
        }
        if (tipo) { query += " AND tipo = ?"; binds.push(tipo); }
        if (autorId) { query += " AND autor_id = ?"; binds.push(parseInt(autorId, 10)); }
        if (destacado === "1") { query += " AND destacado = 1"; }
        if (destacado === "0") { query += " AND destacado = 0"; }
        // Solo se busca en el título, no en "contenido" (el cuerpo entero
        // del artículo): un LIKE '%x%' sobre una columna de texto largo no
        // puede usar índice por el comodín inicial y provoca un full table
        // scan leyendo el contenido completo de cada artículo. Si hace
        // falta buscar también en el cuerpo, la solución correcta es una
        // tabla FTS5 de SQLite, no este LIKE.
        if (busqueda) { query += " AND titulo LIKE ?"; binds.push(`%${busqueda}%`); }
        query += " ORDER BY fecha_publicacion DESC LIMIT ?";
        binds.push(limit);

        const { results } = await env.DB.prepare(query).bind(...binds).all();
        // Reconstruye, a partir de las longitudes pedidas, los mismos
        // campos "contenido_XX" que espera conIdiomasDisponibles (solo le
        // importa si están vacíos o no), sin haber transferido el texto.
        const articulosParaIdiomas = results.map((a) => ({
          ...a,
          contenido_eu: a.contenido_eu_len ? "x" : null,
          contenido_ca: a.contenido_ca_len ? "x" : null,
          contenido_gl: a.contenido_gl_len ? "x" : null,
          contenido_en: a.contenido_en_len ? "x" : null,
        }));
        return json({
          articles: articulosParaIdiomas.map((a) => {
            const { contenido_eu_len, contenido_ca_len, contenido_gl_len, contenido_en_len, ...resto } = conIdiomasDisponibles(a);
            return resto;
          }),
        });
      }
      if (path === "/api/articles" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const body = await request.json();
        if (!body.titulo || !body.contenido) return json({ error: "Faltan campos obligatorios" }, 400);

        // Un redactor de Nivel 1 no puede publicar directamente noticias,
        // crónicas, artículos de opinión ni entrevistas: se guardan
        // siempre como borrador salvo que use "Última hora" con su PIN
        // de 4 dígitos. A partir de Nivel 2, el redactor ya publica
        // directo sin necesitar el PIN. Un admin siempre publica directo.
        let esUltimaHora = false;
        let nivelUsuario = payload.rol === "admin" ? NIVEL_MAXIMO : null;
        if (payload.rol !== "admin" && body.publicado !== false) {
          nivelUsuario = await obtenerNivelUsuario(env, payload.uid);
          if (nivelUsuario < 2) {
            esUltimaHora = await comprobarUltimaHora(env, body.ultima_hora_pin);
            if (!esUltimaHora) body.publicado = false;
          }
        }

        // Programar publicación: un admin, o un redactor de Nivel 2+ (que
        // ya publica directo sin PIN de "Última hora"), puede dejar una
        // noticia programada para publicarse sola en una fecha/hora
        // futura. Si se manda "programado_para" con una fecha futura
        // válida, la noticia se guarda como no publicada (la publicará el
        // disparador programado del Worker cuando llegue esa hora) y sin
        // estado de borrador (no es un borrador normal, es una programación).
        let programadoPara = null;
        if (nivelUsuario === null) nivelUsuario = await obtenerNivelUsuario(env, payload.uid);
        if ((payload.rol === "admin" || nivelUsuario >= 2) && body.programado_para) {
          const fechaProgramada = new Date(body.programado_para);
          // Se compara por minuto, no por milisegundo exacto: el input del
          // panel solo tiene granularidad de minuto, así que si se programa
          // para "dentro de 1 minuto" no debe rechazarse solo porque, con
          // la latencia de red hasta que la petición llega aquí, el reloj
          // exacto ya lo haya superado en unos segundos.
          const inicioMinutoActual = Math.floor(Date.now() / 60000) * 60000;
          if (!isNaN(fechaProgramada.getTime()) && fechaProgramada.getTime() >= inicioMinutoActual) {
            programadoPara = aSqliteDatetimeUTC(fechaProgramada);
            body.publicado = false;
          }
        }

        // Estado del borrador (solo aplica si no se publica): "terminado"
        // o "en_proceso", según lo que haya contestado el redactor en la
        // notificación que se le muestra al guardar como borrador. Si se
        // publica directamente, no aplica (se guarda NULL).
        const estadoBorrador = body.publicado === false && !programadoPara
          ? (body.estado_borrador === "terminado" ? "terminado" : "en_proceso")
          : null;

        // Un borrador guardado como "en proceso" (todavía se está
        // escribiendo) no tiene por qué cumplir los límites de longitud:
        // esos límites solo aplican a lo que se publica o se marca como
        // borrador "terminado".
        const longitudContenido = longitudTextoPlano(body.contenido);
        if (estadoBorrador !== "en_proceso") {
          if (longitudContenido < CONTENIDO_MIN) {
            return json({ error: `El contenido debe tener al menos ${CONTENIDO_MIN} caracteres (tiene ${longitudContenido}).` }, 400);
          }
          if (longitudContenido > CONTENIDO_MAX) {
            return json({ error: `El contenido no puede superar los ${CONTENIDO_MAX} caracteres (tiene ${longitudContenido}).` }, 400);
          }
        }
        let slug = await slugUnico(env, body.slug || body.titulo, null);

        // Varias fotos: se guardan como JSON (con su posición dentro del
        // texto y su foco de recorte); la marcada como portada hace además
        // de "imagen_url", que es la que usan las tarjetas y el hero.
        const imagenes = normalizarImagenes(body.imagenes);
        const imagenPortada = body.imagen_url || (imagenes.find((i) => i.tipo !== "tweet") || {}).url || null;
        // Es obligatorio poner al menos una imagen de portada por noticia.
        // Un borrador "en proceso" (todavía se está escribiendo) puede no
        // tenerla todavía, igual que puede no cumplir los límites de
        // longitud del contenido; para cualquier otro caso (publicada,
        // programada o borrador "terminado") es obligatoria.
        if (!imagenPortada && estadoBorrador !== "en_proceso") {
          return json({ error: "Debes añadir al menos una imagen de portada a la noticia." }, 400);
        }
        const resultadoId = body.resultado_id ? parseInt(body.resultado_id, 10) : null;

        // Club(es) del artículo: para previa/crónica se derivan siempre
        // del resultado vinculado (ambos equipos del partido), no del
        // selector de club del panel (ver resolverClubArticulo). Para el
        // resto de tipos no cambia nada.
        const { error: errorClub, club: clubFinal } = await resolverClubArticulo(env, body.tipo, resultadoId, body.club);
        if (errorClub) return json({ error: errorClub }, 400);

        // Autor de la noticia: por defecto quien la está subiendo, pero se
        // puede elegir a otra persona (p. ej. cuando quien sube la noticia
        // no es quien la ha redactado). Se busca siempre en la tabla de
        // usuarios (y no en el JWT) para firmar con el nombre actual y
        // para no poder "firmar" con un nombre inventado.
        const idAutorElegido = body.autor_id ? parseInt(body.autor_id, 10) : payload.uid;
        const autorElegido = await env.DB.prepare("SELECT id, nombre FROM users WHERE id = ? AND activo = 1")
          .bind(idAutorElegido).first();
        const autorId = autorElegido ? autorElegido.id : payload.uid;
        const autorNombre = autorElegido ? autorElegido.nombre : payload.nombre;

        // Segundo autor (coautor) opcional: una noticia se puede firmar
        // entre dos personas. Solo aporta el nombre extra; no cambia
        // permisos de edición ni nada más (eso lo sigue decidiendo el
        // autor principal). Si no se elige nadie o coincide con el
        // principal, se deja sin coautor.
        let coautorId = null, coautorNombre = null;
        if (body.coautor_id) {
          const idCoautorElegido = parseInt(body.coautor_id, 10);
          if (idCoautorElegido && idCoautorElegido !== autorId) {
            const coautorElegido = await env.DB.prepare("SELECT id, nombre FROM users WHERE id = ? AND activo = 1")
              .bind(idCoautorElegido).first();
            if (coautorElegido) { coautorId = coautorElegido.id; coautorNombre = coautorElegido.nombre; }
          }
        }

        const { campos: traducciones, avisos: avisosTraduccion } = extraerTraducciones(body);

        // El slug queda "congelado" desde el momento de crear la noticia
        // solo si se publica directamente (nace ya con enlace real y
        // compartible). Si nace como borrador o programada, el slug
        // sigue "vivo": se recalculará a partir del título en cada
        // guardado posterior hasta que se publique de verdad (ver PUT y
        // publicarArticulosProgramados).
        const slugCongelado = body.publicado !== false ? 1 : 0;

        // Ficha técnica del partido (solo tiene sentido para crónicas). Se
        // manda ya normalizada desde el panel (ver admin.js,
        // obtenerFichaTecnicaFormulario); aquí solo se guarda tal cual como
        // JSON, o NULL si no se manda o viene vacía.
        const fichaTecnica = (body.tipo === "cronica" && body.ficha_tecnica && Object.keys(body.ficha_tecnica).length)
          ? JSON.stringify(body.ficha_tecnica)
          : null;

        // Banner urgente: mismo criterio que en worker/src/index.js (ver
        // comentario allí) -- solo admin o redactor Nivel 2+ puede
        // activarlo, y la duración la calcula el servidor.
        if (nivelUsuario === null) nivelUsuario = await obtenerNivelUsuario(env, payload.uid);
        const puedeActivarBanner = payload.rol === "admin" || nivelUsuario >= 2;
        const activarBanner = puedeActivarBanner && body.banner_urgente === true;

        await env.DB.prepare(
          `INSERT INTO articles (slug, titulo, subtitulo, contenido, tipo, categoria, club, imagen_url, imagenes, resultado_id, autor_id, autor_nombre, coautor_id, coautor_nombre, destacado, publicado, estado_borrador, programado_para, slug_congelado, fecha_publicacion, updated_at,
            titulo_eu, subtitulo_eu, contenido_eu, titulo_ca, subtitulo_ca, contenido_ca, titulo_gl, subtitulo_gl, contenido_gl, titulo_en, subtitulo_en, contenido_en, origin_write_id, ficha_tecnica, banner_urgente, banner_urgente_hasta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${calcularBannerUrgenteHasta(activarBanner)})`
        ).bind(
          slug, body.titulo, body.subtitulo || null, body.contenido,
          body.tipo || "noticia", body.categoria || "hypermotion", clubFinal,
          imagenPortada, imagenes.length ? JSON.stringify(imagenes) : null, resultadoId,
          autorId, autorNombre, coautorId, coautorNombre,
          body.destacado ? 1 : 0, body.publicado === false ? 0 : 1, estadoBorrador, programadoPara, slugCongelado,
          programadoPara || body.fecha_publicacion || new Date().toISOString(),
          traducciones.titulo_eu, traducciones.subtitulo_eu, traducciones.contenido_eu,
          traducciones.titulo_ca, traducciones.subtitulo_ca, traducciones.contenido_ca,
          traducciones.titulo_gl, traducciones.subtitulo_gl, traducciones.contenido_gl,
          traducciones.titulo_en, traducciones.subtitulo_en, traducciones.contenido_en,
          origenWriteId, fichaTecnica, activarBanner ? 1 : 0
        ).run();

        const publicado = body.publicado !== false;
        const tipoLabel = { noticia: "Noticia", cronica: "Crónica", opinion: "Opinión", entrevista: "Entrevista" }[body.tipo] || "Artículo";
        const firmaAutores = coautorNombre ? `${autorNombre} y ${coautorNombre}` : autorNombre;
        if (programadoPara) {
          // No se manda aviso por email al programarla: se mandará el
          // aviso normal de "publicada" cuando el disparador programado
          // la publique de verdad a su hora.
        } else if (publicado) {
          ctx.waitUntil(enviarEmailNotificacion(env, {
            asunto: `Nueva ${tipoLabel.toLowerCase()} publicada: ${body.titulo}`,
            texto: `${payload.nombre} ha publicado "${body.titulo}" (${tipoLabel}) en ELOTROFÚTBOLTV, firmada por ${firmaAutores}.\n\nVerla en la web: ${urlNoticia(body.categoria, slug)}`,
            html: plantillaEmail({
              etiqueta: `Nueva ${tipoLabel.toLowerCase()}`,
              titulo: body.titulo,
              parrafo: body.subtitulo || null,
              filas: [
                { etiqueta: "Autor", valor: firmaAutores },
                { etiqueta: "Subida por", valor: payload.nombre },
                { etiqueta: "Categoría", valor: body.club || body.categoria },
              ],
              boton: { texto: "Ver la noticia", url: urlNoticia(body.categoria, slug) },
            }),
          }));
        } else if (estadoBorrador === "terminado") {
          // Los borradores marcados como "terminados" (el redactor ha
          // respondido que sí en la notificación de "¿está terminada la
          // noticia?" al guardar) avisan por correo, pero sin enlace
          // publico (todavia no existe: el articulo no es visible en la
          // web hasta que se publique) y con una etiqueta distinta para
          // no confundirlo con una publicacion real. Si el redactor ha
          // dicho que todavía la está escribiendo ("en_proceso") no se
          // manda ningún correo, para no generar avisos de más.
          ctx.waitUntil(enviarEmailNotificacion(env, {
            asunto: `Nuevo borrador terminado: ${body.titulo}`,
            texto: `${payload.nombre} ha guardado el borrador "${body.titulo}" (${tipoLabel}) en ELOTROFÚTBOLTV, firmado por ${firmaAutores}, marcándolo como terminado. Todavía no está publicado.`,
            html: plantillaEmail({
              etiqueta: "Borrador terminado",
              titulo: body.titulo,
              parrafo: body.subtitulo || null,
              filas: [
                { etiqueta: "Autor", valor: firmaAutores },
                { etiqueta: "Guardado por", valor: payload.nombre },
                { etiqueta: "Categoría", valor: body.club || body.categoria },
              ],
            }),
          }));
        }

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: programadoPara ? "programar_articulo" : (publicado ? "crear_articulo" : "guardar_borrador"), entidad: "articulo", entidad_id: slug,
          descripcion: programadoPara
            ? `Ha programado "${tipoLabel.toLowerCase()}": "${body.titulo}" para publicarse el ${programadoPara}`
            : `Ha ${publicado ? "publicado" : "guardado el borrador de"} "${tipoLabel.toLowerCase()}": "${body.titulo}"${estadoBorrador ? ` (${estadoBorrador === "terminado" ? "terminado" : "en proceso"})` : ""}${esUltimaHora ? " (Última hora)" : ""}`,
        }));

        return json({ ok: true, slug, publicado, estado_borrador: estadoBorrador, programado_para: programadoPara, avisos_traduccion: avisosTraduccion });
      }

      // ---------- ARTICLE individual ----------
      const articleMatch = path.match(/^\/api\/articles\/([^/]+)$/);
      if (articleMatch && method === "GET") {
        const key = articleMatch[1];
        let article = await env.DB.prepare(
          "SELECT * FROM articles WHERE (slug = ?1 OR id = ?2) AND publicado = 1"
        ).bind(key, isNaN(key) ? -1 : parseInt(key)).first();

        // Si no hay noticia publicada con ese slug/id, se comprueba si
        // quien pregunta está autenticado y tiene permiso para editarla
        // (autor, coautor o admin): así el panel puede cargar un
        // borrador sin publicar -por ejemplo para gestionar sus
        // alineaciones o collages mientras se edita- sin que la web
        // pública llegue nunca a ver noticias no publicadas.
        if (!article) {
          const payloadAuth = await requireAuth(request, env);
          if (payloadAuth) {
            const borrador = await env.DB.prepare(
              "SELECT * FROM articles WHERE (slug = ?1 OR id = ?2)"
            ).bind(key, isNaN(key) ? -1 : parseInt(key)).first();
            if (borrador && await puedeEditar(env, payloadAuth, "articulo", borrador.id, borrador.autor_id, borrador.coautor_id)) {
              article = borrador;
            }
          }
        }

        if (!article) {
          // No está publicada con ese slug/id. Puede ser por dos motivos
          // (aparte de que simplemente no exista, ver el 404 al final):
          //
          // 1) Es un slug antiguo de una noticia cuyo título cambió
          //    mientras estaba en borrador/programada, y el slug se
          //    recalculó (ver "slug_congelado" en schema.sql): se
          //    redirige al slug actual.
          // 2) Es una noticia programada que todavía no ha llegado a su
          //    hora de publicación: se devuelve la info mínima para que
          //    la web pueda pintar un contador, sin publicado.
          const redirect = await env.DB.prepare(
            `SELECT a.slug FROM article_slug_redirects r
             JOIN articles a ON a.id = r.article_id
             WHERE r.slug_antiguo = ?`
          ).bind(key).first();
          if (redirect && redirect.slug !== key) {
            return json({ redirect: redirect.slug });
          }

          const programada = await env.DB.prepare(
            `SELECT slug, titulo, tipo, categoria, imagen_url, programado_para
             FROM articles WHERE slug = ?1 AND publicado = 0 AND programado_para IS NOT NULL AND programado_para > datetime('now')`
          ).bind(key).first();
          if (programada) {
            return json({ programado: programada });
          }

          return json({ error: "No encontrado" }, 404);
        }

        const articleConIdiomas = conIdiomasDisponibles(article);
        Object.assign(article, articleConIdiomas);

        // Fotos adicionales: de JSON guardado a array de verdad. Se
        // normalizan aquí también para que las noticias guardadas antes de
        // tener posición/foco de recorte (solo URLs en texto) lleguen al
        // frontend con el mismo formato que las nuevas.
        try {
          article.imagenes = normalizarImagenes(article.imagenes ? JSON.parse(article.imagenes) : []);
        } catch {
          article.imagenes = [];
        }

        // Si la noticia/crónica está vinculada a un partido, se adjunta
        // aquí su marcador para que la web lo pueda mostrar.
        if (article.resultado_id) {
          const resultado = await env.DB.prepare("SELECT * FROM results WHERE id = ?").bind(article.resultado_id).first();
          if (resultado) {
            // Se adjuntan también los goles/tarjetas del partido (tabla
            // match_events) para poder mostrar el detalle completo
            // (goles, tarjetas, estadio...) directamente dentro de la
            // noticia, no solo el marcador.
            const { results: eventos } = await env.DB.prepare(
              "SELECT * FROM match_events WHERE resultado_id = ? ORDER BY minuto ASC, minuto_extra ASC, orden ASC"
            ).bind(article.resultado_id).all();
            resultado.eventos = eventos || [];
          }
          article.resultado = resultado || null;
        } else {
          article.resultado = null;
        }

        // Si la noticia está vinculada a un partido, las alineaciones son
        // una única entidad compartida colgada del partido (result_id),
        // no de la noticia: así una noticia y su partido siempre muestran
        // exactamente la misma alineación, sin duplicados ni versiones
        // desincronizadas entre sí. Solo cuando NO hay partido vinculado
        // la noticia puede tener alineaciones propias (article_id).
        article.alineaciones = article.resultado_id
          ? await obtenerAlineaciones(env, "result_id", article.resultado_id)
          : await obtenerAlineaciones(env, "article_id", article.id);

        return json({ article });
      }

      // ---------- Tracking: registrar una vista de noticia ----------
      // Lo llama el cliente (ver public/js/analiticas-tracking.js) justo
      // al abrir noticia.html, una vez por carga de página. Público, sin
      // autenticación: cualquier lector genera vistas.
      if (path === "/api/track/view" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const slugOId = typeof body.slug === "string" ? body.slug : "";
        if (!slugOId) return json({ error: "Falta el slug de la noticia" }, 400);

        // Ver la explicación completa en worker/src/index.js (D1): bots
        // que ejecutan JS inflaban "páginas vistas".
        if (esUserAgentBot(request.headers.get("User-Agent"))) {
          return new Response(null, { status: 204 });
        }

        const articulo = await env.DB.prepare(
          "SELECT id FROM articles WHERE (slug = ?1 OR id = ?2) AND publicado = 1"
        ).bind(slugOId, isNaN(slugOId) ? -1 : parseInt(slugOId)).first();
        if (!articulo) return json({ error: "Noticia no encontrada" }, 404);

        const visitanteHash = await hashVisitante(request, env);
        const visitanteEstable = await hashVisitanteEstable(request, env);
        const { fuente, dominio } = clasificarFuenteTrafico(request.headers.get("Referer"), SITIO_URL);
        const dispositivo = clasificarDispositivo(request.headers.get("User-Agent"));
        const IDIOMAS_VALIDOS = ["es", "eu", "ca", "gl", "en"];
        const idioma = IDIOMAS_VALIDOS.includes(body.idioma) ? body.idioma : "es";

        const inserted = await env.DB.prepare(
          `INSERT INTO article_views (article_id, visitante_hash, visitante_estable, fuente, referer_dominio, dispositivo, idioma)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
        ).bind(articulo.id, visitanteHash, visitanteEstable, fuente, dominio, dispositivo, idioma).first();

        // El id de la vista se devuelve para que el beacon de tiempo de
        // lectura (más abajo) lo referencie al salir de la página; así
        // cada fila de article_reading queda ligada a la vista exacta
        // que la originó, no solo al artículo.
        return json({ ok: true, view_id: inserted.id });
      }

      // ---------- Tracking: vista de un partido (minuto-a-minuto) ----------
      // Ver la versión gemela en worker/src/index.js (D1) para la
      // explicación completa.
      if (path === "/api/track/result-view" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const resultId = parseInt(body.result_id, 10);
        if (!resultId) return json({ error: "Falta el id del partido" }, 400);

        if (esUserAgentBot(request.headers.get("User-Agent"))) {
          return new Response(null, { status: 204 });
        }

        const partido = await env.DB.prepare("SELECT id FROM results WHERE id = ?").bind(resultId).first();
        if (!partido) return json({ error: "Partido no encontrado" }, 404);

        const visitanteHash = await hashVisitante(request, env);
        await env.DB.prepare(
          `INSERT INTO result_views (result_id, visitante_hash) VALUES (?, ?)`
        ).bind(resultId, visitanteHash).run();

        return json({ ok: true });
      }

      // ---------- Tracking: cerrar una vista con el tiempo de lectura ----------
      // Se manda con navigator.sendBeacon, tanto en un "heartbeat"
      // periódico mientras la pestaña sigue abierta como en el cierre
      // final (ver public/js/analiticas-tracking.js): puede llegar varias
      // veces para la MISMA vista, y en cualquier momento (o no llegar
      // nunca, si se cierra el navegador de golpe) -- no se puede exigir
      // que exista una vista "abierta" de forma estricta, solo que
      // view_id sea uno real.
      //
      // UPSERT en vez de INSERT: con el heartbeat, la primera llamada
      // para un view_id crea la fila y las siguientes la ACTUALIZAN (no
      // añaden filas nuevas), así el AVG(segundos)/AVG(scroll_maximo) del
      // panel sigue contando cada vista una sola vez aunque haya mandado
      // varios heartbeats. Requiere el índice único de
      // db/migrations/007_article_reading_upsert.sql sobre
      // article_reading(view_id).
      if (path === "/api/track/reading" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const viewId = parseInt(body.view_id, 10);
        let segundos = parseInt(body.segundos, 10);
        const scrollMaximo = body.scroll_maximo != null ? Math.max(0, Math.min(100, parseInt(body.scroll_maximo, 10))) : null;
        if (!viewId || isNaN(segundos)) return json({ error: "Faltan datos" }, 400);
        // Tope de 30 minutos por vista: una pestaña olvidada abierta no
        // debe desvirtuar la media de tiempo de lectura.
        segundos = Math.max(0, Math.min(segundos, 1800));

        const vista = await env.DB.prepare("SELECT article_id FROM article_views WHERE id = ?").bind(viewId).first();
        if (!vista) return json({ error: "Vista no encontrada" }, 404);

        // No se usa el helper genérico "?" -> "$n" de sql-compat aquí
        // porque translateSql() no traduce ON CONFLICT (no hace falta,
        // es sintaxis nativa de Postgres en ambos lados D1/Postgres para
        // este caso -- D1/SQLite acepta "ON CONFLICT(col) DO UPDATE"
        // igual). Se mantiene el mismo texto de consulta en los dos
        // workers (D1 y Postgres) a propósito, para que no diverjan.
        await env.DB.prepare(
          `INSERT INTO article_reading (view_id, article_id, segundos, scroll_maximo)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (view_id) DO UPDATE
           SET segundos = EXCLUDED.segundos, scroll_maximo = EXCLUDED.scroll_maximo`
        ).bind(viewId, vista.article_id, segundos, scrollMaximo).run();

        return json({ ok: true });
      }

      if (articleMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(articleMatch[1]);

        // Solo el autor (o coautor, o un admin, o alguien con una
        // solicitud de edición aprobada y vigente para esta noticia)
        // puede editarla.
        const articuloParaPermiso = await env.DB.prepare("SELECT slug, autor_id, coautor_id, publicado, estado_borrador, fecha_publicacion, slug_congelado, resultado_id, tipo, categoria, club, ficha_tecnica, banner_urgente FROM articles WHERE id = ?").bind(id).first();
        if (!articuloParaPermiso) return json({ error: "Noticia no encontrada" }, 404);
        if (!(await puedeEditar(env, payload, "articulo", id, articuloParaPermiso.autor_id, articuloParaPermiso.coautor_id))) {
          return json({ error: "No puedes editar esta noticia porque no es tuya. Solicita permiso al autor o a un administrador." }, 403);
        }
        // Para que quede constancia en el historial de que esta edición
        // es una "revisión" (Nivel 4 corrigiendo contenido de otra
        // persona) y no una edición normal de lo propio, salvo que
        // además tenga un permiso temporal aprobado por edit_requests
        // (en ese caso ya queda igualmente registrado como antes).
        const esEdicionAjenaPorNivel4 = payload.rol !== "admin"
          && articuloParaPermiso.autor_id !== payload.uid
          && articuloParaPermiso.coautor_id !== payload.uid
          && !(await tienePermisoTemporal(env, payload, "articulo", id));
        // Un borrador marcado como "terminado" ya ha avisado por email a
        // la redacción de que está listo para subir: se bloquea para que
        // nadie (salvo un admin, o un redactor Nivel 4 revisando/
        // corrigiendo contenido ajeno) lo siga tocando, para no publicar
        // por error una versión distinta de la que se avisó. En cuanto un
        // admin lo publica, "estado_borrador" se limpia (ver más abajo) y
        // recupera el poder de edición con normalidad.
        const nivelParaBloqueoTerminado = payload.rol === "admin"
          ? NIVEL_MAXIMO
          : await obtenerNivelUsuario(env, payload.uid);
        if (nivelParaBloqueoTerminado < 4 && !articuloParaPermiso.publicado && articuloParaPermiso.estado_borrador === "terminado") {
          return json({ error: "Esta noticia está marcada como \"terminada\" y en espera de que un administrador la publique. No se puede editar hasta entonces." }, 403);
        }

        const body = await request.json();

        // Un redactor de Nivel 1 no puede publicar directamente una noticia
        // NUEVA al editarla: si no es admin y no ha llegado a Nivel 2,
        // cualquier intento de dejarla publicada (true, o sin mandar el
        // campo, que por defecto publicaría) se guarda sin publicar salvo
        // que use "Última hora" con su PIN. Pero esto solo se aplica
        // mientras la noticia todavía no estaba publicada: si ya lo
        // estaba, simplemente editarla (p. ej. corregir una errata) no
        // debe despublicarla y devolverla a borrador, o cualquier
        // redactor de Nivel 1 la haría desaparecer de la web sin querer
        // cada vez que la retocase.
        let nivelUsuario = payload.rol === "admin" ? NIVEL_MAXIMO : null;
        if (payload.rol !== "admin" && body.publicado !== false && !articuloParaPermiso.publicado) {
          nivelUsuario = await obtenerNivelUsuario(env, payload.uid);
          if (nivelUsuario < 2) {
            const puedeUltimaHora = await comprobarUltimaHora(env, body.ultima_hora_pin);
            if (!puedeUltimaHora) body.publicado = false;
          }
        }

        // Programar publicación (igual que al crear): un admin, o un
        // redactor de Nivel 2+, puede dejarla programada para una fecha/
        // hora futura.
        let programadoPara = null;
        if (nivelUsuario === null) nivelUsuario = await obtenerNivelUsuario(env, payload.uid);
        if ((payload.rol === "admin" || nivelUsuario >= 2) && body.programado_para) {
          const fechaProgramada = new Date(body.programado_para);
          // Mismo criterio que al crear: comparar por minuto, no por
          // milisegundo exacto, para no perder la programación por la
          // latencia de red entre que se envía y llega al servidor.
          const inicioMinutoActual = Math.floor(Date.now() / 60000) * 60000;
          if (!isNaN(fechaProgramada.getTime()) && fechaProgramada.getTime() >= inicioMinutoActual) {
            programadoPara = aSqliteDatetimeUTC(fechaProgramada);
            body.publicado = false;
          }
        }

        // Igual que al crear: si se guarda como borrador, se registra si
        // el redactor lo ha marcado como "terminado" o "en_proceso" en la
        // notificación del panel, para decidir más abajo si se avisa por
        // email a la redacción o no.
        const estadoBorrador = body.publicado === false && !programadoPara
          ? (body.estado_borrador === "terminado" ? "terminado" : "en_proceso")
          : null;

        // Un borrador "en proceso" no tiene por qué cumplir los límites de
        // longitud todavía (ver mismo criterio al crear la noticia).
        if (body.contenido !== undefined && estadoBorrador !== "en_proceso") {
          const longitudContenido = longitudTextoPlano(body.contenido);
          if (longitudContenido < CONTENIDO_MIN) {
            return json({ error: `El contenido debe tener al menos ${CONTENIDO_MIN} caracteres (tiene ${longitudContenido}).` }, 400);
          }
          if (longitudContenido > CONTENIDO_MAX) {
            return json({ error: `El contenido no puede superar los ${CONTENIDO_MAX} caracteres (tiene ${longitudContenido}).` }, 400);
          }
        }

        const imagenes = normalizarImagenes(body.imagenes);
        const imagenPortada = body.imagen_url || (imagenes.find((i) => i.tipo !== "tweet") || {}).url || null;
        // Es obligatorio poner al menos una imagen de portada por noticia,
        // igual que al crear. Un borrador "en proceso" puede seguir sin
        // ella; para publicar, programar o marcar como "terminado" hace falta.
        if (!imagenPortada && estadoBorrador !== "en_proceso") {
          return json({ error: "Debes añadir al menos una imagen de portada a la noticia." }, 400);
        }
        const resultadoId = body.resultado_id ? parseInt(body.resultado_id, 10) : null;

        // Si se ha elegido un autor en el formulario, se actualiza; si no
        // se manda nada, se deja el autor que ya tenía la noticia. Se
        // busca siempre en la tabla de usuarios para firmar con el nombre
        // actual y no poder "firmar" con un nombre inventado.
        const articuloActual = await env.DB.prepare("SELECT autor_id, autor_nombre, coautor_id, coautor_nombre FROM articles WHERE id = ?").bind(id).first();
        const idAutorElegido = body.autor_id
          ? parseInt(body.autor_id, 10)
          : (articuloActual ? articuloActual.autor_id : payload.uid);
        const autorElegido = await env.DB.prepare("SELECT id, nombre FROM users WHERE id = ? AND activo = 1")
          .bind(idAutorElegido).first();
        const autorId = autorElegido ? autorElegido.id : (articuloActual ? articuloActual.autor_id : payload.uid);
        const autorNombre = autorElegido ? autorElegido.nombre : (articuloActual ? articuloActual.autor_nombre : payload.nombre);

        // Segundo autor (coautor) opcional, igual que al crear. Si se
        // manda explícitamente "coautor_id: null" (o vacío) se quita el
        // coautor que hubiera; si no se manda el campo, se deja el que
        // ya tenía.
        let coautorId = articuloActual ? articuloActual.coautor_id : null;
        let coautorNombre = articuloActual ? articuloActual.coautor_nombre : null;
        if (Object.prototype.hasOwnProperty.call(body, "coautor_id")) {
          coautorId = null; coautorNombre = null;
          if (body.coautor_id) {
            const idCoautorElegido = parseInt(body.coautor_id, 10);
            if (idCoautorElegido && idCoautorElegido !== autorId) {
              const coautorElegido = await env.DB.prepare("SELECT id, nombre FROM users WHERE id = ? AND activo = 1")
                .bind(idCoautorElegido).first();
              if (coautorElegido) { coautorId = coautorElegido.id; coautorNombre = coautorElegido.nombre; }
            }
          }
        }

        const { campos: traducciones, avisos: avisosTraduccion } = extraerTraducciones(body);

        // Slug: mientras la noticia no se haya publicado nunca todavía
        // (ni lo estaba ya, ni lo está quedando ahora mismo por esta
        // misma edición), el slug sigue "vivo" y se recalcula a partir
        // del título en cada guardado. En cuanto se publica de verdad
        // (aquí mismo, o -para las programadas- cuando el disparador
        // programado la publique sola, ver publicarArticulosProgramados),
        // se congela para siempre. Si el slug cambia, se guarda el
        // antiguo en article_slug_redirects para no romper enlaces ya
        // compartidos.
        const vaAPublicarseAhora = body.publicado !== false && !programadoPara;
        const slugSigueVivo = !articuloParaPermiso.slug_congelado && !articuloParaPermiso.publicado;
        let slug = articuloParaPermiso.slug;
        if (slugSigueVivo && body.titulo) {
          slug = await slugUnico(env, body.titulo, id);
        }
        const slugCongeladoFinal = (articuloParaPermiso.slug_congelado || vaAPublicarseAhora) ? 1 : 0;

        // La fecha de publicación no debe "saltar" al día de hoy solo por
        // editar una noticia que ya estaba publicada de antes (eso movería
        // también la fecha de la imagen para redes, que debe quedarse fija
        // en el día real en que se subió la noticia). Solo se usa la fecha
        // que manda el formulario (el momento de guardar) cuando el
        // artículo se publica por primera vez en esta edición; si ya
        // estaba publicado, se conserva la fecha_publicacion que ya tenía.
        const fechaPublicacionFinal = programadoPara
          ? programadoPara
          : (articuloParaPermiso.publicado && articuloParaPermiso.fecha_publicacion)
            ? articuloParaPermiso.fecha_publicacion
            : (body.fecha_publicacion || new Date().toISOString());

        // Ficha técnica del partido (solo crónicas). Igual que al crear:
        // si se manda el campo, se guarda tal cual (o se borra si llega
        // vacío/null); si no se manda en absoluto, se conserva la que ya
        // hubiera (p. ej. una edición que solo toca el título no debe
        // borrar la ficha técnica ya rellenada).
        const tipoFinal = body.tipo || articuloParaPermiso.tipo || "noticia";
        // Categoría y club: se usan los que vengan en el body si se manda
        // ese campo; si no se manda en absoluto (undefined), se conserva
        // lo que ya tenía la noticia, para que una edición que no los
        // toca (p. ej. solo corregir el título) no los borre.
        const categoriaFinal = body.categoria !== undefined ? body.categoria : (articuloParaPermiso.categoria || "hypermotion");
        // Club: para previa/crónica se deriva siempre del resultado
        // vinculado (ver resolverClubArticulo), usando el tipo y el
        // resultado_id finales de esta edición.
        const resultadoIdFinal = body.resultado_id !== undefined ? resultadoId : articuloParaPermiso.resultado_id;
        const { error: errorClub, club: clubFinal } = await resolverClubArticulo(
          env, tipoFinal, resultadoIdFinal,
          body.club !== undefined ? body.club : articuloParaPermiso.club
        );
        if (errorClub) return json({ error: errorClub }, 400);
        let fichaTecnica = articuloParaPermiso.ficha_tecnica || null;
        if (Object.prototype.hasOwnProperty.call(body, "ficha_tecnica")) {
          fichaTecnica = (tipoFinal === "cronica" && body.ficha_tecnica && Object.keys(body.ficha_tecnica).length)
            ? JSON.stringify(body.ficha_tecnica)
            : null;
        } else if (tipoFinal !== "cronica") {
          fichaTecnica = null;
        }

        // Banner urgente al editar: mismo criterio que al crear (admin o
        // Nivel 2+). Si el campo no se manda, se conserva el estado que
        // ya tuviera la noticia.
        let bannerUrgenteFinal = articuloParaPermiso.banner_urgente ? 1 : 0;
        let bannerUrgenteHastaSQL = null; // null = no tocar esta columna
        if (Object.prototype.hasOwnProperty.call(body, "banner_urgente")) {
          if (nivelUsuario === null) nivelUsuario = await obtenerNivelUsuario(env, payload.uid);
          const puedeActivarBanner = payload.rol === "admin" || nivelUsuario >= 2;
          const activarBanner = puedeActivarBanner && body.banner_urgente === true;
          bannerUrgenteFinal = activarBanner ? 1 : 0;
          bannerUrgenteHastaSQL = calcularBannerUrgenteHasta(activarBanner);
        }

        await env.DB.prepare(
          `UPDATE articles SET slug=?, titulo=?, subtitulo=?, contenido=?, tipo=?, categoria=?, club=?, imagen_url=?, imagenes=?, resultado_id=?, autor_id=?, autor_nombre=?, coautor_id=?, coautor_nombre=?, destacado=?, publicado=?, estado_borrador=?, programado_para=?, slug_congelado=?, fecha_publicacion=?, updated_at=datetime('now'),
            titulo_eu=?, subtitulo_eu=?, contenido_eu=?, titulo_ca=?, subtitulo_ca=?, contenido_ca=?, titulo_gl=?, subtitulo_gl=?, contenido_gl=?, titulo_en=?, subtitulo_en=?, contenido_en=?, ficha_tecnica=?, banner_urgente=?${bannerUrgenteHastaSQL !== null ? `, banner_urgente_hasta=${bannerUrgenteHastaSQL}` : ""}
           WHERE id=?`
        ).bind(
          slug, body.titulo, body.subtitulo || null, body.contenido, body.tipo || "noticia",
          categoriaFinal, clubFinal || null, imagenPortada,
          imagenes.length ? JSON.stringify(imagenes) : null, resultadoId,
          autorId, autorNombre, coautorId, coautorNombre,
          body.destacado ? 1 : 0, body.publicado === false ? 0 : 1, estadoBorrador, programadoPara, slugCongeladoFinal,
          fechaPublicacionFinal,
          traducciones.titulo_eu, traducciones.subtitulo_eu, traducciones.contenido_eu,
          traducciones.titulo_ca, traducciones.subtitulo_ca, traducciones.contenido_ca,
          traducciones.titulo_gl, traducciones.subtitulo_gl, traducciones.contenido_gl,
          traducciones.titulo_en, traducciones.subtitulo_en, traducciones.contenido_en,
          fichaTecnica, bannerUrgenteFinal, id
        ).run();
        await registrarRedirectSiCambia(env, id, articuloParaPermiso.slug, slug);

        // Si esta edición vincula por primera vez la noticia a un
        // partido (no lo tenía antes y ahora sí), cualquier alineación
        // que la noticia tuviera colgada de sí misma (article_id) pasa a
        // colgar del partido (result_id): a partir de ahora la noticia y
        // el partido comparten una única alineación sincronizada, en vez
        // de arriesgarse a que queden dos copias independientes que se
        // desincronicen entre sí. Si el partido ya tenía sus propias
        // alineaciones, las de la noticia quedarían "de más": se
        // descartan (se borran) para no dejar filas duplicadas del mismo
        // equipo colgando del mismo partido.
        if (resultadoId && !articuloParaPermiso.resultado_id) {
          const alineacionesPropias = await obtenerAlineaciones(env, "article_id", id);
          if (alineacionesPropias.length) {
            const alineacionesPartido = await obtenerAlineaciones(env, "result_id", resultadoId);
            const equiposYaEnPartido = new Set(alineacionesPartido.map((a) => a.equipo));
            for (const a of alineacionesPropias) {
              if (equiposYaEnPartido.has(a.equipo)) {
                // Ya hay una alineación de ese mismo equipo en el
                // partido: se descarta la de la noticia para no duplicar.
                await env.DB.prepare("DELETE FROM alineaciones WHERE id = ?").bind(a.id).run();
              } else {
                await env.DB.prepare("UPDATE alineaciones SET article_id = NULL, result_id = ? WHERE id = ?").bind(resultadoId, a.id).run();
              }
            }
          }
        }

        // Igual que al crear: solo se avisa por email la primera vez que
        // el borrador pasa a "terminado" (si ya lo estaba y se sigue
        // guardando sin publicar -p. ej. un admin retocándolo antes de
        // subirlo-, no se repite el aviso cada vez que se guarda). Si se
        // ha publicado, o si sigue "en_proceso", tampoco se manda correo
        // aquí (al publicar de verdad ya llega el aviso de "Última hora"/
        // publicación por otro sitio del flujo).
        const yaEstabaTerminado = articuloParaPermiso.estado_borrador === "terminado";
        if (body.publicado === false && estadoBorrador === "terminado" && !yaEstabaTerminado) {
          const tipoLabel = { noticia: "Noticia", cronica: "Crónica", opinion: "Opinión", entrevista: "Entrevista" }[body.tipo] || "Artículo";
          const firmaAutores = coautorNombre ? `${autorNombre} y ${coautorNombre}` : autorNombre;
          ctx.waitUntil(enviarEmailNotificacion(env, {
            asunto: `Borrador terminado: ${body.titulo}`,
            texto: `${payload.nombre} ha editado y marcado como terminado el borrador "${body.titulo}" (${tipoLabel}) en ELOTROFÚTBOLTV, firmado por ${firmaAutores}. Todavía no está publicado.`,
            html: plantillaEmail({
              etiqueta: "Borrador terminado",
              titulo: body.titulo,
              parrafo: body.subtitulo || null,
              filas: [
                { etiqueta: "Autor", valor: firmaAutores },
                { etiqueta: "Guardado por", valor: payload.nombre },
                { etiqueta: "Categoría", valor: body.club || body.categoria },
              ],
            }),
          }));
        }

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_articulo", entidad: "articulo", entidad_id: id,
          descripcion: `Ha editado la noticia/crónica "${body.titulo}"${estadoBorrador ? ` (${estadoBorrador === "terminado" ? "borrador terminado" : "borrador en proceso"})` : ""}${esEdicionAjenaPorNivel4 ? " (revisión de contenido ajeno, Nivel 4)" : ""}`,
        }));
        return json({ ok: true, slug, publicado: body.publicado === false ? 0 : 1, estado_borrador: estadoBorrador, programado_para: programadoPara, avisos_traduccion: avisosTraduccion });
      }

      if (articleMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(articleMatch[1]);
        const articuloBorrado = await env.DB.prepare("SELECT titulo, autor_id, coautor_id FROM articles WHERE id = ?").bind(id).first();
        if (!articuloBorrado) return json({ error: "Noticia no encontrada" }, 404);
        // El borrado NO se abre a Nivel 4 igual que la edición: el
        // documento de niveles dice "revisar y corregir", no "eliminar
        // lo de otros". Por eso aquí se comprueba autoría/coautoría/admin
        // o permiso temporal aprobado, sin el atajo de nivel que sí tiene
        // puedeEditar() para PUT.
        const puedeBorrar = payload.rol === "admin"
          || articuloBorrado.autor_id === payload.uid
          || articuloBorrado.coautor_id === payload.uid
          || (await tienePermisoTemporal(env, payload, "articulo", id));
        if (!puedeBorrar) {
          return json({ error: "No puedes eliminar esta noticia porque no es tuya. Solicita permiso al autor o a un administrador." }, 403);
        }
        await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "eliminar_articulo", entidad: "articulo", entidad_id: id,
          descripcion: `Ha eliminado la noticia/crónica "${articuloBorrado ? articuloBorrado.titulo : id}"`,
        }));
        return json({ ok: true });
      }

      // ---------- ÚLTIMA HORA: PIN único, solo visible/regenerable por un admin ----------
      if (path === "/api/settings/ultima-hora-pin" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede ver el PIN de Última hora" }, 403);
        const pin = await obtenerUltimaHoraPin(env);
        return json({ pin });
      }
      // Lo regenera a mano (por si se ha compartido de más y quiere invalidarlo
      // ya, sin esperar a que se use). También se regenera solo tras cada uso.
      if (path === "/api/settings/ultima-hora-pin/regenerar" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede regenerar el PIN de Última hora" }, 403);
        const pin = await regenerarUltimaHoraPin(env);
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "regenerar_pin_ultima_hora", entidad: "settings", entidad_id: 0,
          descripcion: `Ha regenerado el PIN de "Última hora"`,
        }));
        return json({ ok: true, pin });
      }

      // ---------- SOLICITUDES DE EDICIÓN ----------
      // Un redactor pide permiso para editar una noticia/crónica/opinión/
      // entrevista o un resultado que no es suyo. Lo puede aprobar
      // cualquiera de los dos: un admin, o el autor original.
      if (path === "/api/edit-requests" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        // Sin filtro: un admin ve todas. Un redactor ve solo las que ha
        // hecho él, o las que le tocaría aprobar (porque es el autor
        // original de la entidad en cuestión).
        let query = `SELECT * FROM edit_requests WHERE 1=1`;
        const binds = [];
        if (payload.rol !== "admin") {
          query += ` AND (solicitante_id = ? OR autor_id = ?)`;
          binds.push(payload.uid, payload.uid);
        }
        const estado = url.searchParams.get("estado");
        if (estado) { query += " AND estado = ?"; binds.push(estado); }
        query += " ORDER BY created_at DESC LIMIT 200";
        const { results } = await env.DB.prepare(query).bind(...binds).all();

        // Se enriquece cada solicitud con los datos que necesita el panel
        // para mostrar el detalle completo a un admin: quién la pide, de
        // quién es originalmente el contenido, y qué noticia/resultado es
        // exactamente (título, tipo, estado de publicación...).
        //
        // ANTES: esto lanzaba hasta 4 queries POR CADA fila (solicitante,
        // autor, entidad, resuelta_por) con un .map(async ...) -con el
        // límite de 200 filas de arriba, hasta 800 queries individuales
        // en una sola petición HTTP-. Es exactamente el patrón "N+1" que
        // más RAM/CPU consume: cada prepare().bind().first() es su propio
        // round-trip. Se sustituye por un puñado de consultas por LOTES
        // con "IN (...)", una única vez para todas las filas, y luego se
        // cruzan en memoria con Maps (barato, ya en el Worker). Mismo
        // arreglo aplicado en worker/src/index.js (API principal): debe
        // mantenerse igual en ambas para el failover.
        const idsUsuarios = [...new Set(
          results.flatMap((s) => [s.solicitante_id, s.autor_id, s.resuelta_por_id]).filter((id) => id != null)
        )];
        const idsResultados = [...new Set(
          results.filter((s) => s.tipo_entidad === "resultado").map((s) => s.entidad_id)
        )];
        const idsArticulos = [...new Set(
          results.filter((s) => s.tipo_entidad !== "resultado").map((s) => s.entidad_id)
        )];

        const [usuariosRows, resultadosRows, articulosRows] = await Promise.all([
          idsUsuarios.length
            ? env.DB.prepare(
                `SELECT id, nombre, username, email FROM users WHERE id IN (${idsUsuarios.map(() => "?").join(",")})`
              ).bind(...idsUsuarios).all()
            : { results: [] },
          idsResultados.length
            ? env.DB.prepare(
                `SELECT id, equipo_local, equipo_visitante, competicion, estado FROM results WHERE id IN (${idsResultados.map(() => "?").join(",")})`
              ).bind(...idsResultados).all()
            : { results: [] },
          idsArticulos.length
            ? env.DB.prepare(
                `SELECT id, titulo, subtitulo, tipo, categoria, publicado, estado_borrador FROM articles WHERE id IN (${idsArticulos.map(() => "?").join(",")})`
              ).bind(...idsArticulos).all()
            : { results: [] },
        ]);

        const usuariosPorId = new Map(usuariosRows.results.map((u) => [u.id, u]));
        const resultadosPorId = new Map(resultadosRows.results.map((r) => [r.id, r]));
        const articulosPorId = new Map(articulosRows.results.map((a) => [a.id, a]));

        const solicitudes = results.map((s) => {
          const solicitante = usuariosPorId.get(s.solicitante_id) || null;
          const autor = s.autor_id ? (usuariosPorId.get(s.autor_id) || null) : null;
          const entidad = s.tipo_entidad === "resultado"
            ? (resultadosPorId.get(s.entidad_id) || null)
            : (articulosPorId.get(s.entidad_id) || null);
          const resuelta_por = s.resuelta_por_id ? (usuariosPorId.get(s.resuelta_por_id) || null) : null;
          return {
            ...s,
            solicitante_nombre: solicitante ? solicitante.nombre : null,
            solicitante_username: solicitante ? solicitante.username : null,
            solicitante_email: solicitante ? solicitante.email : null,
            autor_nombre: autor ? autor.nombre : null,
            autor_username: autor ? autor.username : null,
            entidad_titulo: entidad ? (entidad.titulo || (entidad.equipo_local && entidad.equipo_visitante ? `${entidad.equipo_local} - ${entidad.equipo_visitante}` : null)) : null,
            entidad_subtitulo: entidad ? (entidad.subtitulo || null) : null,
            entidad_tipo: entidad ? (entidad.tipo || null) : null,
            entidad_categoria: entidad ? (entidad.categoria || entidad.competicion || null) : null,
            entidad_publicado: entidad ? (s.tipo_entidad === "resultado" ? null : Boolean(entidad.publicado)) : null,
            entidad_estado_borrador: entidad ? (entidad.estado_borrador || null) : null,
            entidad_existe: Boolean(entidad),
            resuelta_por_nombre: resuelta_por ? resuelta_por.nombre : null,
          };
        });

        return json({ solicitudes });
      }

      if (path === "/api/edit-requests" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const body = await request.json();
        const tipoEntidad = body.tipo_entidad === "resultado" ? "resultado" : "articulo";
        const entidadId = parseInt(body.entidad_id, 10);
        if (!entidadId) return json({ error: "Falta el elemento a solicitar" }, 400);

        const tabla = tipoEntidad === "resultado" ? "results" : "articles";
        const camposEntidad = tipoEntidad === "resultado" ? "autor_id" : "autor_id, coautor_id";
        const entidad = await env.DB.prepare(`SELECT ${camposEntidad} FROM ${tabla} WHERE id = ?`).bind(entidadId).first();
        if (!entidad) return json({ error: "El elemento no existe" }, 404);

        // Si ya puede editarlo (es suyo, es coautor, es admin, o ya tiene
        // un permiso vigente), no tiene sentido crear una solicitud nueva.
        if (await puedeEditar(env, payload, tipoEntidad, entidadId, entidad.autor_id, entidad.coautor_id)) {
          return json({ error: "Ya puedes editar este elemento, no hace falta solicitarlo." }, 400);
        }

        // Evita duplicar solicitudes: si ya hay una pendiente igual, no
        // se crea otra.
        const yaExiste = await env.DB.prepare(
          `SELECT id FROM edit_requests WHERE tipo_entidad=? AND entidad_id=? AND solicitante_id=? AND estado='pendiente'`
        ).bind(tipoEntidad, entidadId, payload.uid).first();
        if (yaExiste) return json({ error: "Ya tienes una solicitud pendiente para este elemento." }, 400);

        await env.DB.prepare(
          `INSERT INTO edit_requests (tipo_entidad, entidad_id, solicitante_id, autor_id, motivo, estado)
           VALUES (?, ?, ?, ?, ?, 'pendiente')`
        ).bind(tipoEntidad, entidadId, payload.uid, entidad.autor_id || null, body.motivo ? String(body.motivo).slice(0, 500) : null).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "solicitar_edicion", entidad: tipoEntidad, entidad_id: entidadId,
          descripcion: `${payload.nombre} ha solicitado permiso para editar ${tipoEntidad === "resultado" ? "un resultado" : "una noticia/crónica"} que no es suya`,
        }));
        return json({ ok: true });
      }

      const editRequestMatch = path.match(/^\/api\/edit-requests\/(\d+)$/);
      if (editRequestMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(editRequestMatch[1]);
        const body = await request.json();
        const accion = body.accion === "rechazar" ? "rechazar" : "aprobar";

        const solicitud = await env.DB.prepare("SELECT * FROM edit_requests WHERE id = ?").bind(id).first();
        if (!solicitud) return json({ error: "Solicitud no encontrada" }, 404);
        if (solicitud.estado !== "pendiente") return json({ error: "Esta solicitud ya se ha resuelto" }, 400);

        // Solo puede resolverla un admin o el autor original de la entidad.
        const esAutorOriginal = solicitud.autor_id && solicitud.autor_id === payload.uid;
        if (payload.rol !== "admin" && !esAutorOriginal) {
          return json({ error: "Solo un administrador o el autor original pueden responder a esta solicitud" }, 403);
        }

        if (accion === "rechazar") {
          await env.DB.prepare(
            `UPDATE edit_requests SET estado='rechazada', resuelta_por_id=?, resuelta_at=datetime('now') WHERE id=?`
          ).bind(payload.uid, id).run();
        } else {
          await env.DB.prepare(
            `UPDATE edit_requests SET estado='aprobada', resuelta_por_id=?, resuelta_at=datetime('now'),
              permiso_expira_at=datetime('now', '+${EDIT_GRANT_MINUTOS} minutes') WHERE id=?`
          ).bind(payload.uid, id).run();
        }

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: accion === "rechazar" ? "rechazar_solicitud_edicion" : "aprobar_solicitud_edicion",
          entidad: solicitud.tipo_entidad, entidad_id: solicitud.entidad_id,
          descripcion: `${payload.nombre} ha ${accion === "rechazar" ? "rechazado" : "aprobado"} una solicitud de edición`,
        }));
        return json({ ok: true });
      }

      // ---------- RESULTS ----------
      // ---------- CLUBES PERSONALIZADOS ("Otro equipo") ----------
      // Lista pública (no requiere login) de los clubes que se han ido
      // añadiendo a mano desde "Otro equipo (no está en la lista)". El
      // frontend los combina con los fijos de public/js/clubs.js para
      // que, a partir de la primera vez que se usa un equipo nuevo,
      // aparezca ya en el desplegable normal en vez de tener que volver
      // a escribirlo cada vez.
      if (path === "/api/custom-clubs" && method === "GET") {
        const categoria = url.searchParams.get("categoria");
        let query = "SELECT nombre, categoria, escudo_url FROM custom_clubs";
        const binds = [];
        if (categoria) {
          query += " WHERE categoria = ?";
          binds.push(categoria);
        }
        query += " ORDER BY nombre COLLATE NOCASE ASC";
        const { results: clubes } = await env.DB.prepare(query).bind(...binds).all();
        return json({ clubes });
      }

      // Da de alta un club nuevo (o actualiza su escudo si ya existía en
      // esa misma categoría). Requiere login, igual que crear un
      // resultado o una noticia, que es desde donde se llama.
      if (path === "/api/custom-clubs" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const body = await request.json();
        const nombre = normalizarTexto(body.nombre);
        const categoria = normalizarTexto(body.categoria);
        if (!nombre) return json({ error: "Falta el nombre del club" }, 400);
        if (!categoria) return json({ error: "Falta la categoría del club" }, 400);
        const escudoUrl = normalizarTexto(body.escudo_url);
        await env.DB.prepare(
          `INSERT INTO custom_clubs (nombre, categoria, escudo_url, autor_id, autor_nombre)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(nombre, categoria) DO UPDATE SET
             escudo_url = COALESCE(excluded.escudo_url, custom_clubs.escudo_url)`
        ).bind(nombre, categoria, escudoUrl, payload.uid, payload.nombre).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_club_personalizado", entidad: "club",
          descripcion: `Ha añadido "${nombre}" a la lista de clubes de ${categoria}`,
        }));
        return json({ ok: true });
      }

      // ---------- TIENDA DE ACREDITACIÓN (gorra, camiseta, micro...) ----------
      // Sin pasarela de pago: el pago se hace por Bizum fuera de la web y
      // un admin (o un redactor con permiso "puede_gestionar_tienda") lo
      // confirma a mano desde el panel. Ver worker/migracion_tienda.sql.

      // Comprueba si quien hace la petición puede gestionar TODOS los
      // pedidos de la tienda (verlos y cambiarles el estado), no solo
      // los suyos propios: los admin siempre pueden, y además cualquier
      // usuario al que se le haya dado el permiso puede_gestionar_tienda.
      async function puedeGestionarTienda(env, payload) {
        if (payload.rol === "admin") return true;
        const fila = await env.DB.prepare(
          "SELECT puede_gestionar_tienda FROM users WHERE id = ?"
        ).bind(payload.uid).first();
        return !!(fila && fila.puede_gestionar_tienda === 1);
      }

      // Catálogo de productos activos, visible para cualquier persona
      // logueada en el panel (no hace falta ser admin para ver la tienda).
      if (path === "/api/tienda/productos" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { results: productos } = await env.DB.prepare(
          `SELECT id, nombre, descripcion, precio_centimos, imagen_url, variantes
           FROM tienda_productos WHERE activo = 1 ORDER BY orden ASC, id ASC`
        ).all();
        return json({
          productos: productos.map((p) => ({
            ...p,
            variantes: p.variantes ? JSON.parse(p.variantes) : [],
          })),
        });
      }

      // ---------- Gestión del catálogo (crear/editar/activar productos) ----------
      // Todo lo de aquí abajo solo para quien puede gestionar la tienda
      // (admin o redactor con el permiso concedido).

      // Listado completo, incluidos los productos desactivados, para la
      // subtab "Productos" del panel de gestión.
      if (path === "/api/tienda/productos/todos" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!(await puedeGestionarTienda(env, payload))) {
          return json({ error: "No tienes permiso para gestionar la tienda" }, 403);
        }
        const { results: productos } = await env.DB.prepare(
          `SELECT id, nombre, descripcion, precio_centimos, imagen_url, variantes, activo, orden
           FROM tienda_productos ORDER BY orden ASC, id ASC`
        ).all();
        return json({
          productos: productos.map((p) => ({
            ...p,
            variantes: p.variantes ? JSON.parse(p.variantes) : [],
          })),
        });
      }

      // Valida y normaliza los campos de un producto recibidos del panel,
      // compartido entre crear y editar. Lanza un Error con el mensaje a
      // mostrar si algo no es válido.
      function validarCamposProducto(body) {
        const nombre = normalizarTexto(body.nombre);
        if (!nombre) throw new Error("Falta el nombre del producto");
        const precio = Number(body.precio_centimos);
        if (!Number.isInteger(precio) || precio <= 0) {
          throw new Error("El precio no es válido (debe ser un número de céntimos mayor que 0)");
        }
        let variantes = [];
        if (Array.isArray(body.variantes)) {
          variantes = body.variantes
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .filter(Boolean);
        }
        return {
          nombre,
          descripcion: normalizarTexto(body.descripcion),
          precio_centimos: precio,
          imagen_url: normalizarTexto(body.imagen_url),
          variantes: JSON.stringify(variantes),
          orden: Number.isInteger(Number(body.orden)) ? Number(body.orden) : 0,
        };
      }

      // Crea un producto nuevo en el catálogo.
      if (path === "/api/tienda/productos" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!(await puedeGestionarTienda(env, payload))) {
          return json({ error: "No tienes permiso para gestionar la tienda" }, 403);
        }
        const body = await request.json();
        let campos;
        try {
          campos = validarCamposProducto(body);
        } catch (err) {
          return json({ error: err.message }, 400);
        }
        const { meta } = await env.DB.prepare(
          `INSERT INTO tienda_productos (nombre, descripcion, precio_centimos, imagen_url, variantes, orden)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(campos.nombre, campos.descripcion, campos.precio_centimos, campos.imagen_url, campos.variantes, campos.orden).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_producto_tienda", entidad: "producto_tienda", entidad_id: meta.last_row_id,
          descripcion: `${payload.nombre} ha creado el producto "${campos.nombre}" en la tienda`,
        }));

        return json({ ok: true, id: meta.last_row_id });
      }

      // Edita un producto existente (datos, o solo activo/inactivo si el
      // body trae únicamente ese campo).
      if (path.match(/^\/api\/tienda\/productos\/\d+$/) && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!(await puedeGestionarTienda(env, payload))) {
          return json({ error: "No tienes permiso para gestionar la tienda" }, 403);
        }
        const productoId = parseInt(path.split("/").pop(), 10);
        const body = await request.json();

        // Cambio rápido de solo "activo" (activar/desactivar desde el
        // interruptor de la lista), sin tener que reenviar todos los campos.
        if (typeof body.activo === "boolean" && Object.keys(body).length === 1) {
          const resultado = await env.DB.prepare(
            "UPDATE tienda_productos SET activo = ? WHERE id = ?"
          ).bind(body.activo ? 1 : 0, productoId).run();
          if (!resultado.meta.changes) return json({ error: "Producto no encontrado" }, 404);
          ctx.waitUntil(registrarActividad(env, request, payload, {
            accion: "actualizar_producto_tienda", entidad: "producto_tienda", entidad_id: productoId,
            descripcion: `${payload.nombre} ha ${body.activo ? "activado" : "desactivado"} un producto de la tienda`,
          }));
          return json({ ok: true });
        }

        let campos;
        try {
          campos = validarCamposProducto(body);
        } catch (err) {
          return json({ error: err.message }, 400);
        }
        const activo = typeof body.activo === "boolean" ? (body.activo ? 1 : 0) : undefined;
        const resultado = await env.DB.prepare(
          `UPDATE tienda_productos
           SET nombre = ?, descripcion = ?, precio_centimos = ?, imagen_url = ?, variantes = ?, orden = ?,
               activo = ${activo === undefined ? "activo" : "?"}
           WHERE id = ?`
        ).bind(...(activo === undefined
          ? [campos.nombre, campos.descripcion, campos.precio_centimos, campos.imagen_url, campos.variantes, campos.orden, productoId]
          : [campos.nombre, campos.descripcion, campos.precio_centimos, campos.imagen_url, campos.variantes, campos.orden, activo, productoId]
        )).run();
        if (!resultado.meta.changes) return json({ error: "Producto no encontrado" }, 404);

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "actualizar_producto_tienda", entidad: "producto_tienda", entidad_id: productoId,
          descripcion: `${payload.nombre} ha editado el producto "${campos.nombre}" en la tienda`,
        }));

        return json({ ok: true });
      }

      // Crea un pedido nuevo, en estado "pendiente_pago": el redactor
      // acaba de elegir el producto, todavía no se ha confirmado que el
      // Bizum haya llegado. "referencia_pago" es lo que el propio
      // redactor escribe (p.ej. el concepto que ha puesto en el Bizum)
      // para que sea fácil de localizar al confirmarlo.
      if (path === "/api/tienda/pedidos" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const body = await request.json();
        const productoId = parseInt(body.producto_id, 10);
        if (!productoId) return json({ error: "Falta el producto" }, 400);
        const producto = await env.DB.prepare(
          "SELECT * FROM tienda_productos WHERE id = ? AND activo = 1"
        ).bind(productoId).first();
        if (!producto) return json({ error: "Ese producto no está disponible" }, 404);

        const variantesDisponibles = producto.variantes ? JSON.parse(producto.variantes) : [];
        const variante = normalizarTexto(body.variante);
        if (variantesDisponibles.length > 0 && !variantesDisponibles.includes(variante)) {
          return json({ error: "Elige una talla/variante válida" }, 400);
        }
        const referenciaPago = normalizarTexto(body.referencia_pago);

        const { meta } = await env.DB.prepare(
          `INSERT INTO tienda_pedidos
             (usuario_id, producto_id, producto_nombre, variante, precio_centimos, referencia_pago)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(payload.uid, producto.id, producto.nombre, variantesDisponibles.length ? variante : null,
               producto.precio_centimos, referenciaPago).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_pedido_tienda", entidad: "pedido_tienda", entidad_id: meta.last_row_id,
          descripcion: `${payload.nombre} ha pedido "${producto.nombre}"${variante ? " (" + variante + ")" : ""} en la tienda`,
        }));

        return json({ ok: true, pedido_id: meta.last_row_id });
      }

      // Pedidos del propio redactor (para ver en qué estado está lo que
      // ha pedido: pendiente de pago, pagado, enviado...).
      if (path === "/api/tienda/mis-pedidos" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { results: pedidos } = await env.DB.prepare(
          `SELECT id, producto_nombre, variante, precio_centimos, estado, referencia_pago, created_at
           FROM tienda_pedidos WHERE usuario_id = ? ORDER BY created_at DESC`
        ).bind(payload.uid).all();
        return json({ pedidos });
      }

      // El propio redactor cancela un pedido suyo, pero solo mientras
      // siga "pendiente_pago" (una vez pagado/enviado ya no se puede
      // cancelar desde aquí; eso lo gestiona quien administra la tienda).
      if (path.match(/^\/api\/tienda\/mis-pedidos\/\d+\/cancelar$/) && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const pedidoId = parseInt(path.split("/")[3], 10);
        const pedido = await env.DB.prepare(
          "SELECT id, usuario_id, estado, producto_nombre FROM tienda_pedidos WHERE id = ?"
        ).bind(pedidoId).first();
        if (!pedido || pedido.usuario_id !== payload.uid) {
          return json({ error: "Pedido no encontrado" }, 404);
        }
        if (pedido.estado !== "pendiente_pago") {
          return json({ error: "Solo puedes cancelar un pedido mientras está pendiente de pago" }, 400);
        }
        await env.DB.prepare(
          `UPDATE tienda_pedidos SET estado = 'cancelado', gestionado_en = datetime('now')
           WHERE id = ?`
        ).bind(pedidoId).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "cancelar_pedido_tienda", entidad: "pedido_tienda", entidad_id: pedidoId,
          descripcion: `${payload.nombre} ha cancelado su pedido "${pedido.producto_nombre}" en la tienda`,
        }));

        return json({ ok: true });
      }

      // El propio redactor borra un pedido suyo del historial (distinto
      // de cancelar: esto elimina la fila por completo). Solo se permite
      // si el pedido ya está en un estado "cerrado" (cancelado o
      // enviado): mientras está pendiente de pago o ya pagado pero sin
      // enviar, primero hay que cancelarlo o esperar a que se gestione,
      // para no perder de vista un Bizum que aún puede estar en curso.
      if (path.match(/^\/api\/tienda\/mis-pedidos\/\d+$/) && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const pedidoId = parseInt(path.split("/").pop(), 10);
        const pedido = await env.DB.prepare(
          "SELECT id, usuario_id, estado, producto_nombre FROM tienda_pedidos WHERE id = ?"
        ).bind(pedidoId).first();
        if (!pedido || pedido.usuario_id !== payload.uid) {
          return json({ error: "Pedido no encontrado" }, 404);
        }
        if (!["cancelado", "enviado"].includes(pedido.estado)) {
          return json({ error: "Solo puedes borrar un pedido cancelado o ya enviado" }, 400);
        }
        await env.DB.prepare("DELETE FROM tienda_pedidos WHERE id = ?").bind(pedidoId).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "borrar_pedido_tienda", entidad: "pedido_tienda", entidad_id: pedidoId,
          descripcion: `${payload.nombre} ha borrado su pedido "${pedido.producto_nombre}" de la tienda`,
        }));

        return json({ ok: true });
      }

      // Todos los pedidos de todo el mundo: solo para quien puede
      // gestionar la tienda (admin o redactor con el permiso concedido).
      if (path === "/api/tienda/pedidos" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!(await puedeGestionarTienda(env, payload))) {
          return json({ error: "No tienes permiso para gestionar la tienda" }, 403);
        }
        const estado = url.searchParams.get("estado");
        let query = `SELECT tp.id, tp.producto_nombre, tp.variante, tp.precio_centimos, tp.estado,
                            tp.referencia_pago, tp.nota_gestion, tp.created_at, tp.gestionado_en,
                            u.nombre AS redactor_nombre, u.email AS redactor_email
                     FROM tienda_pedidos tp
                     JOIN users u ON u.id = tp.usuario_id`;
        const binds = [];
        if (estado) {
          query += " WHERE tp.estado = ?";
          binds.push(estado);
        }
        query += " ORDER BY tp.created_at DESC";
        const { results: pedidos } = await env.DB.prepare(query).bind(...binds).all();
        return json({ pedidos });
      }

      // Cambia el estado de un pedido (confirmar pago, marcar enviado,
      // cancelar...). Solo quien puede gestionar la tienda.
      if (path.match(/^\/api\/tienda\/pedidos\/\d+$/) && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!(await puedeGestionarTienda(env, payload))) {
          return json({ error: "No tienes permiso para gestionar la tienda" }, 403);
        }
        const pedidoId = parseInt(path.split("/").pop(), 10);
        const body = await request.json();
        const estadosValidos = ["pendiente_pago", "pagado", "enviado", "cancelado"];
        if (!estadosValidos.includes(body.estado)) {
          return json({ error: "Estado no válido" }, 400);
        }
        // Distinguimos "no han mandado nota_gestion" (se mantiene la que
        // hubiera) de "han mandado una cadena vacía" (se borra a propósito,
        // p.ej. al vaciar el campo de nota en el panel).
        const seEnviaNota = typeof body.nota_gestion === "string";
        const notaGestion = seEnviaNota ? normalizarTexto(body.nota_gestion) : undefined;
        const resultado = await env.DB.prepare(
          `UPDATE tienda_pedidos
           SET estado = ?, nota_gestion = ${seEnviaNota ? "?" : "nota_gestion"},
               gestionado_por = ?, gestionado_en = datetime('now')
           WHERE id = ?`
        ).bind(...(seEnviaNota ? [body.estado, notaGestion, payload.uid, pedidoId] : [body.estado, payload.uid, pedidoId])).run();
        if (!resultado.meta.changes) return json({ error: "Pedido no encontrado" }, 404);

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "actualizar_pedido_tienda", entidad: "pedido_tienda", entidad_id: pedidoId,
          descripcion: `${payload.nombre} ha marcado el pedido #${pedidoId} de la tienda como "${body.estado}"`,
        }));

        return json({ ok: true });
      }

      // Borra un pedido por completo (no solo cambiarle el estado). Solo
      // quien puede gestionar la tienda; sin restricción de estado, ya
      // que quien gestiona puede necesitar limpiar pedidos duplicados,
      // de prueba o mal introducidos en cualquier momento.
      if (path.match(/^\/api\/tienda\/pedidos\/\d+$/) && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!(await puedeGestionarTienda(env, payload))) {
          return json({ error: "No tienes permiso para gestionar la tienda" }, 403);
        }
        const pedidoId = parseInt(path.split("/").pop(), 10);
        const pedido = await env.DB.prepare(
          "SELECT id, producto_nombre FROM tienda_pedidos WHERE id = ?"
        ).bind(pedidoId).first();
        if (!pedido) return json({ error: "Pedido no encontrado" }, 404);

        await env.DB.prepare("DELETE FROM tienda_pedidos WHERE id = ?").bind(pedidoId).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "borrar_pedido_tienda", entidad: "pedido_tienda", entidad_id: pedidoId,
          descripcion: `${payload.nombre} ha borrado el pedido #${pedidoId} ("${pedido.producto_nombre}") de la tienda`,
        }));

        return json({ ok: true });
      }

      // ---------- Comentarios de lectores ----------
      // Número de denuncias distintas que hacen que un comentario se
      // oculte automáticamente de la web en espera de revisión manual.
      const DENUNCIAS_PARA_OCULTAR = 3;

      // Público: solo texto/nombre/email del propio comentario, sin
      // exponer nunca el email de otros comentarios ya aprobados. Los
      // comentarios aprobados pero auto-ocultados por denuncias no se
      // devuelven hasta que un admin los revise.
      const comentariosArticuloMatch = path.match(/^\/api\/articles\/(\d+)\/comments$/);
      if (comentariosArticuloMatch && method === "GET") {
        const articleId = parseInt(comentariosArticuloMatch[1]);
        const { results: comentarios } = await env.DB.prepare(
          `SELECT id, nombre, texto, created_at, likes, dislikes, reader_id
           FROM comments
           WHERE article_id = ? AND estado = 'aprobado' AND oculto_por_denuncia = 0
           ORDER BY created_at ASC`
        ).bind(articleId).all();
        return json({ comentarios });
      }

      if (comentariosArticuloMatch && method === "POST") {
        const articleId = parseInt(comentariosArticuloMatch[1]);
        const articulo = await env.DB.prepare("SELECT id FROM articles WHERE id = ? AND publicado = 1").bind(articleId).first();
        if (!articulo) return json({ error: "Noticia no encontrada" }, 404);

        const body = await request.json();

        // Si quien comenta tiene sesión de lector (cuenta verificada),
        // se ignoran el nombre/email que mande el body y se usan los de
        // su cuenta: así nadie puede firmar un comentario con un nombre
        // distinto al de su cuenta ya verificada.
        const payloadLector = await requireReaderAuth(request, env);
        let readerId = null;
        let nombre, email;
        if (payloadLector) {
          const lector = await env.DB.prepare(
            "SELECT id, nombre, email FROM readers WHERE id = ? AND activo = 1 AND email_verificado = 1"
          ).bind(payloadLector.rid).first();
          if (lector) {
            readerId = lector.id;
            nombre = lector.nombre;
            email = lector.email;
          }
        }
        if (!readerId) {
          nombre = normalizarTexto(body.nombre);
          email = normalizarTexto(body.email);
        }

        const texto = normalizarTexto(body.texto);
        if (!nombre) return json({ error: "Falta tu nombre" }, 400);
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "El email no es válido" }, 400);
        if (!texto) return json({ error: "El comentario no puede estar vacío" }, 400);
        if (texto.length > 2000) return json({ error: "El comentario es demasiado largo (máximo 2000 caracteres)" }, 400);

        const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || null;
        await env.DB.prepare(
          `INSERT INTO comments (article_id, nombre, email, texto, ip, reader_id) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(articleId, nombre, email, texto, ip, readerId).run();

        return json({ ok: true, mensaje: "Comentario enviado. Se publicará en cuanto lo revise la redacción." });
      }

      // ---------- Encuestas ----------
      // Solo puede votar un lector con cuenta, logueado (sesión válida,
      // vía requireReaderAuth, igual que para comentar) y con el email
      // verificado: mismo requisito que ya existe para comentar. Una
      // encuesta puede vivir en una noticia (article_id), en portada
      // (en_portada), en ambos sitios, o solo en portada sin noticia.

      // Cierra automáticamente las encuestas cuya fecha límite ya pasó.
      // Se llama antes de leer resultados/listas para no depender de un
      // cron aparte; es barato (solo toca las que tocan) y evita que se
      // seleccione en el filtro "abierta" pero de verdad se pueda votar.
      async function cerrarEncuestasCaducadas(env) {
        await env.DB.prepare(
          `UPDATE polls SET estado = 'cerrada', updated_at = datetime('now')
           WHERE estado = 'abierta' AND cierra_en IS NOT NULL AND cierra_en <= datetime('now')`
        ).run();
      }

      // Arma el objeto de encuesta con recuento de votos por opción y,
      // si se pasa readerId, qué opción votó ese lector (o null si no ha
      // votado). Los recuentos siempre se devuelven (no hay razón para
      // ocultar resultados agregados), lo único restringido es el voto.
      async function obtenerEncuestaConResultados(env, poll, readerId) {
        const { results: opciones } = await env.DB.prepare(
          `SELECT po.id, po.texto, po.orden, COUNT(pv.id) AS votos
           FROM poll_options po
           LEFT JOIN poll_votes pv ON pv.option_id = po.id
           WHERE po.poll_id = ?
           GROUP BY po.id
           ORDER BY po.orden ASC, po.id ASC`
        ).bind(poll.id).all();

        const totalVotos = opciones.reduce((acc, o) => acc + o.votos, 0);

        let miVoto = null;
        if (readerId) {
          const voto = await env.DB.prepare(
            "SELECT option_id FROM poll_votes WHERE poll_id = ? AND reader_id = ?"
          ).bind(poll.id, readerId).first();
          if (voto) miVoto = voto.option_id;
        }

        return {
          id: poll.id,
          pregunta: poll.pregunta,
          article_id: poll.article_id,
          en_portada: !!poll.en_portada,
          estado: poll.estado,
          cierra_en: poll.cierra_en,
          total_votos: totalVotos,
          mi_voto: miVoto,
          opciones: opciones.map((o) => ({ id: o.id, texto: o.texto, votos: o.votos })),
        };
      }

      // Comprueba que quien llama es un lector con cuenta activa, sesión
      // válida y correo verificado. Devuelve el id del lector, o null +
      // motivo si no cumple algún requisito (para poder distinguir en el
      // frontend "no has iniciado sesión" de "verifica tu correo").
      async function requireReaderVerificado(request, env) {
        const payloadLector = await requireReaderAuth(request, env);
        if (!payloadLector) return { readerId: null, motivo: "no_logueado" };
        const lector = await env.DB.prepare(
          "SELECT id, email_verificado FROM readers WHERE id = ? AND activo = 1"
        ).bind(payloadLector.rid).first();
        if (!lector) return { readerId: null, motivo: "no_logueado" };
        if (!lector.email_verificado) return { readerId: null, motivo: "no_verificado" };
        return { readerId: lector.id, motivo: null };
      }

      // Público: encuesta(s) destacada(s) en portada, ya abiertas o
      // cerradas (para poder seguir mostrando resultados finales un
      // tiempo tras cerrarse). Puede haber varias a la vez, ordenadas
      // por orden_portada.
      if (path === "/api/polls/portada" && method === "GET") {
        await cerrarEncuestasCaducadas(env);
        const { results: encuestas } = await env.DB.prepare(
          `SELECT * FROM polls WHERE en_portada = 1 ORDER BY orden_portada ASC, id DESC`
        ).all();

        const { readerId } = await requireReaderVerificado(request, env);
        const conResultados = await Promise.all(
          encuestas.map((p) => obtenerEncuestaConResultados(env, p, readerId))
        );
        return json({ encuestas: conResultados });
      }

      // Público: la encuesta ligada a una noticia concreta (si tiene).
      const encuestaArticuloMatch = path.match(/^\/api\/articles\/(\d+)\/poll$/);
      if (encuestaArticuloMatch && method === "GET") {
        await cerrarEncuestasCaducadas(env);
        const articleId = parseInt(encuestaArticuloMatch[1]);
        const poll = await env.DB.prepare(
          "SELECT * FROM polls WHERE article_id = ? ORDER BY id DESC LIMIT 1"
        ).bind(articleId).first();
        if (!poll) return json({ encuesta: null });

        const { readerId } = await requireReaderVerificado(request, env);
        const conResultados = await obtenerEncuestaConResultados(env, poll, readerId);
        return json({ encuesta: conResultados });
      }

      // Público: votar. Exige lector con cuenta activa, sesión válida y
      // correo verificado; si no cumple alguno de los tres, error 403
      // con un "motivo" que el frontend usa para mostrar el aviso
      // correcto (iniciar sesión / verificar correo) en vez de las
      // opciones de voto.
      const votoEncuestaMatch = path.match(/^\/api\/polls\/(\d+)\/vote$/);
      if (votoEncuestaMatch && method === "POST") {
        const pollId = parseInt(votoEncuestaMatch[1]);
        const { readerId, motivo } = await requireReaderVerificado(request, env);
        if (!readerId) return json({ error: "No autorizado para votar", motivo }, 403);

        const poll = await env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(pollId).first();
        if (!poll) return json({ error: "Encuesta no encontrada" }, 404);
        if (poll.estado !== "abierta" || (poll.cierra_en && poll.cierra_en <= new Date().toISOString().slice(0, 19).replace("T", " "))) {
          if (poll.estado === "abierta") {
            await env.DB.prepare("UPDATE polls SET estado = 'cerrada', updated_at = datetime('now') WHERE id = ?").bind(poll.id).run();
          }
          return json({ error: "Esta encuesta ya está cerrada" }, 409);
        }

        const body = await request.json();
        const optionId = parseInt(body.option_id);
        if (!optionId) return json({ error: "Falta la opción elegida" }, 400);
        const opcion = await env.DB.prepare(
          "SELECT id FROM poll_options WHERE id = ? AND poll_id = ?"
        ).bind(optionId, pollId).first();
        if (!opcion) return json({ error: "Opción no válida para esta encuesta" }, 400);

        // Un solo voto por lector y encuesta: si ya había votado, esto
        // cambia su voto a la nueva opción en vez de sumar uno nuevo.
        await env.DB.prepare(
          `INSERT INTO poll_votes (poll_id, option_id, reader_id) VALUES (?, ?, ?)
           ON CONFLICT(poll_id, reader_id) DO UPDATE SET option_id = excluded.option_id, created_at = datetime('now')`
        ).bind(pollId, optionId, readerId).run();

        const conResultados = await obtenerEncuestaConResultados(env, poll, readerId);
        return json({ ok: true, encuesta: conResultados });
      }

      // ---------- Encuestas: gestión desde el panel (redactores/admin) ----------
      // Listado para el panel: todas las encuestas, con su recuento de
      // votos y, si está ligada, el título de la noticia para mostrarlo
      // en la tabla sin tener que hacer una petición aparte.
      if (path === "/api/admin/polls" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        await cerrarEncuestasCaducadas(env);

        const { results: encuestas } = await env.DB.prepare(
          `SELECT p.*, a.titulo AS articulo_titulo, a.slug AS articulo_slug
           FROM polls p
           LEFT JOIN articles a ON a.id = p.article_id
           ORDER BY p.created_at DESC`
        ).all();

        // ANTES: una query de opciones+votos POR CADA encuesta vía
        // obtenerEncuestaConResultados (N+1, sin LIMIT, crece con el
        // histórico de encuestas). Se sustituye por UNA sola consulta que
        // trae ya agregadas las opciones+votos de TODAS las encuestas del
        // listado, y se reparte en memoria con un Map por poll_id. Mismo
        // arreglo aplicado en worker/src/index.js (API principal).
        const idsEncuestas = encuestas.map((p) => p.id);
        const opcionesPorEncuesta = new Map(idsEncuestas.map((id) => [id, []]));
        if (idsEncuestas.length) {
          const { results: opcionesTodas } = await env.DB.prepare(
            `SELECT po.id, po.poll_id, po.texto, po.orden, COUNT(pv.id) AS votos
             FROM poll_options po
             LEFT JOIN poll_votes pv ON pv.option_id = po.id
             WHERE po.poll_id IN (${idsEncuestas.map(() => "?").join(",")})
             GROUP BY po.id
             ORDER BY po.orden ASC, po.id ASC`
          ).bind(...idsEncuestas).all();
          for (const o of opcionesTodas) {
            opcionesPorEncuesta.get(o.poll_id).push(o);
          }
        }

        const conResultados = encuestas.map((p) => {
          const opciones = opcionesPorEncuesta.get(p.id) || [];
          const totalVotos = opciones.reduce((acc, o) => acc + o.votos, 0);
          return {
            id: p.id,
            pregunta: p.pregunta,
            article_id: p.article_id,
            en_portada: !!p.en_portada,
            estado: p.estado,
            cierra_en: p.cierra_en,
            total_votos: totalVotos,
            mi_voto: null,
            opciones: opciones.map((o) => ({ id: o.id, texto: o.texto, votos: o.votos })),
            articulo_titulo: p.articulo_titulo || null,
            articulo_slug: p.articulo_slug || null,
            orden_portada: p.orden_portada,
          };
        });
        return json({ encuestas: conResultados });
      }

      // Crear encuesta. article_id y en_portada son independientes: se
      // puede marcar cualquier combinación (incluida ninguna, aunque en
      // ese caso la encuesta no se mostraría en ningún sitio del
      // frontend hasta que se ligue a algo).
      if (path === "/api/admin/polls" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);

        const body = await request.json();
        const pregunta = normalizarTexto(body.pregunta);
        if (!pregunta) return json({ error: "Falta la pregunta de la encuesta" }, 400);
        if (pregunta.length > 200) return json({ error: `La pregunta es demasiado larga (máximo 200 caracteres, tiene ${pregunta.length})` }, 400);

        const opciones = Array.isArray(body.opciones)
          ? body.opciones.map((o) => normalizarTexto(o)).filter(Boolean)
          : [];
        if (opciones.length < 2) return json({ error: "La encuesta necesita al menos 2 opciones" }, 400);
        if (opciones.length > 10) return json({ error: "Máximo 10 opciones por encuesta" }, 400);
        const opcionLarga = opciones.find((o) => o.length > 100);
        if (opcionLarga) return json({ error: `Una opción es demasiado larga (máximo 100 caracteres): "${opcionLarga.slice(0, 40)}..."` }, 400);
        const opcionesUnicas = new Set(opciones.map((o) => o.toLowerCase()));
        if (opcionesUnicas.size !== opciones.length) return json({ error: "Hay opciones repetidas: cada opción debe ser distinta" }, 400);

        let articleId = null;
        if (body.article_id) {
          const articulo = await env.DB.prepare("SELECT id FROM articles WHERE id = ?").bind(parseInt(body.article_id)).first();
          if (!articulo) return json({ error: "La noticia indicada no existe" }, 400);
          articleId = articulo.id;
        }

        const enPortada = body.en_portada ? 1 : 0;
        const ordenPortada = Number.isFinite(body.orden_portada) ? body.orden_portada : 0;
        const cierraEn = normalizarTexto(body.cierra_en) || null;
        if (cierraEn) {
          const fechaCierre = new Date(cierraEn.replace(" ", "T"));
          if (isNaN(fechaCierre.getTime())) return json({ error: "La fecha de cierre no es válida" }, 400);
          if (fechaCierre.getTime() <= Date.now()) return json({ error: "La fecha de cierre debe ser futura" }, 400);
        }

        const { meta } = await env.DB.prepare(
          `INSERT INTO polls (pregunta, article_id, en_portada, orden_portada, cierra_en, autor_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(pregunta, articleId, enPortada, ordenPortada, cierraEn, payload.uid).run();

        const pollId = meta.last_row_id;
        for (let i = 0; i < opciones.length; i++) {
          await env.DB.prepare(
            "INSERT INTO poll_options (poll_id, texto, orden) VALUES (?, ?, ?)"
          ).bind(pollId, opciones[i], i).run();
        }

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_encuesta", entidad: "encuesta", entidad_id: pollId,
          descripcion: `Ha creado la encuesta "${pregunta}"`,
        }));

        const poll = await env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(pollId).first();
        return json({ ok: true, encuesta: await obtenerEncuestaConResultados(env, poll, null) });
      }

      // Editar encuesta existente: pregunta, a qué noticia está ligada,
      // si sale en portada y en qué orden, y fecha de cierre. Las
      // opciones solo se pueden editar (texto, añadir, quitar) mientras
      // la encuesta no tenga ningún voto todavía: en cuanto hay un voto,
      // tocar las opciones desbarataría los resultados (o directamente
      // los borraría, por el ON DELETE CASCADE de poll_votes.option_id),
      // así que a partir de ahí "opciones" en el body se ignora.
      const editarEncuestaMatch = path.match(/^\/api\/admin\/polls\/(\d+)$/);
      if (editarEncuestaMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const pollId = parseInt(editarEncuestaMatch[1]);
        const poll = await env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(pollId).first();
        if (!poll) return json({ error: "Encuesta no encontrada" }, 404);
        if (!(await puedeEditarEntidad(env, payload, "encuesta", poll.autor_id))) {
          return json({ error: "No tienes permiso para editar esta encuesta" }, 403);
        }

        const body = await request.json();
        const pregunta = normalizarTexto(body.pregunta) || poll.pregunta;
        if (pregunta.length > 200) return json({ error: `La pregunta es demasiado larga (máximo 200 caracteres, tiene ${pregunta.length})` }, 400);

        let articleId = poll.article_id;
        if (body.article_id !== undefined) {
          if (body.article_id === null || body.article_id === "") {
            articleId = null;
          } else {
            const articulo = await env.DB.prepare("SELECT id FROM articles WHERE id = ?").bind(parseInt(body.article_id)).first();
            if (!articulo) return json({ error: "La noticia indicada no existe" }, 400);
            articleId = articulo.id;
          }
        }

        const enPortada = body.en_portada !== undefined ? (body.en_portada ? 1 : 0) : poll.en_portada;
        const ordenPortada = Number.isFinite(body.orden_portada) ? body.orden_portada : poll.orden_portada;
        const cierraEn = body.cierra_en !== undefined ? (normalizarTexto(body.cierra_en) || null) : poll.cierra_en;
        if (cierraEn) {
          const fechaCierre = new Date(cierraEn.replace(" ", "T"));
          if (isNaN(fechaCierre.getTime())) return json({ error: "La fecha de cierre no es válida" }, 400);
        }
        const estado = body.estado === "abierta" || body.estado === "cerrada" ? body.estado : poll.estado;

        // ¿Tiene votos ya? Si los tiene, "opciones" se ignora aunque
        // venga en el body (protege los resultados existentes).
        const { total_votos: totalVotosActuales } = await env.DB.prepare(
          "SELECT COUNT(*) AS total_votos FROM poll_votes WHERE poll_id = ?"
        ).bind(pollId).first();

        if (Array.isArray(body.opciones) && totalVotosActuales === 0) {
          const opciones = body.opciones.map((o) => normalizarTexto(o)).filter(Boolean);
          if (opciones.length < 2) return json({ error: "La encuesta necesita al menos 2 opciones" }, 400);
          if (opciones.length > 10) return json({ error: "Máximo 10 opciones por encuesta" }, 400);
          const opcionLarga = opciones.find((o) => o.length > 100);
          if (opcionLarga) return json({ error: `Una opción es demasiado larga (máximo 100 caracteres): "${opcionLarga.slice(0, 40)}..."` }, 400);
          const opcionesUnicas = new Set(opciones.map((o) => o.toLowerCase()));
          if (opcionesUnicas.size !== opciones.length) return json({ error: "Hay opciones repetidas: cada opción debe ser distinta" }, 400);

          await env.DB.prepare("DELETE FROM poll_options WHERE poll_id = ?").bind(pollId).run();
          for (let i = 0; i < opciones.length; i++) {
            await env.DB.prepare(
              "INSERT INTO poll_options (poll_id, texto, orden) VALUES (?, ?, ?)"
            ).bind(pollId, opciones[i], i).run();
          }
        }

        await env.DB.prepare(
          `UPDATE polls SET pregunta = ?, article_id = ?, en_portada = ?, orden_portada = ?,
                            cierra_en = ?, estado = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).bind(pregunta, articleId, enPortada, ordenPortada, cierraEn, estado, pollId).run();

        const actualizada = await env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(pollId).first();
        return json({ ok: true, encuesta: await obtenerEncuestaConResultados(env, actualizada, null) });
      }

      // Cerrar/reabrir encuesta manualmente (atajo sin tener que mandar
      // el resto de campos, para el botón de "Cerrar" del panel).
      const cerrarEncuestaMatch = path.match(/^\/api\/admin\/polls\/(\d+)\/cerrar$/);
      if (cerrarEncuestaMatch && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const pollId = parseInt(cerrarEncuestaMatch[1]);
        const poll = await env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(pollId).first();
        if (!poll) return json({ error: "Encuesta no encontrada" }, 404);
        if (!(await puedeEditarEntidad(env, payload, "encuesta", poll.autor_id))) {
          return json({ error: "No tienes permiso para cerrar esta encuesta" }, 403);
        }
        await env.DB.prepare(
          "UPDATE polls SET estado = 'cerrada', updated_at = datetime('now') WHERE id = ?"
        ).bind(pollId).run();
        return json({ ok: true });
      }

      const reabrirEncuestaMatch = path.match(/^\/api\/admin\/polls\/(\d+)\/reabrir$/);
      if (reabrirEncuestaMatch && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const pollId = parseInt(reabrirEncuestaMatch[1]);
        const poll = await env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(pollId).first();
        if (!poll) return json({ error: "Encuesta no encontrada" }, 404);
        if (!(await puedeEditarEntidad(env, payload, "encuesta", poll.autor_id))) {
          return json({ error: "No tienes permiso para reabrir esta encuesta" }, 403);
        }
        await env.DB.prepare(
          "UPDATE polls SET estado = 'abierta', updated_at = datetime('now') WHERE id = ?"
        ).bind(pollId).run();
        return json({ ok: true });
      }

      // Borrar encuesta (arrastra opciones y votos por ON DELETE CASCADE).
      if (editarEncuestaMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const pollId = parseInt(editarEncuestaMatch[1]);
        const poll = await env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(pollId).first();
        if (!poll) return json({ error: "Encuesta no encontrada" }, 404);
        if (!(await puedeEditarEntidad(env, payload, "encuesta", poll.autor_id))) {
          return json({ error: "No tienes permiso para borrar esta encuesta" }, 403);
        }
        await env.DB.prepare("DELETE FROM polls WHERE id = ?").bind(pollId).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "borrar_encuesta", entidad: "encuesta", entidad_id: pollId,
          descripcion: `Ha borrado la encuesta "${poll.pregunta}"`,
        }));
        return json({ ok: true });
      }

      // Votos (like/dislike) de un comentario ya publicado. `votanteId` es
      // un identificador anónimo generado por el navegador (localStorage),
      // no una cuenta: solo sirve para no permitir votar dos veces el
      // mismo comentario desde el mismo navegador, y para poder cambiar o
      // quitar el voto. Enviar `valor: 0` quita el voto ya emitido.
      const votoComentarioMatch = path.match(/^\/api\/comments\/(\d+)\/vote$/);
      if (votoComentarioMatch && method === "POST") {
        const id = parseInt(votoComentarioMatch[1]);
        const comentario = await env.DB.prepare(
          "SELECT id FROM comments WHERE id = ? AND estado = 'aprobado' AND oculto_por_denuncia = 0"
        ).bind(id).first();
        if (!comentario) return json({ error: "Comentario no encontrado" }, 404);

        const body = await request.json();
        const votanteId = normalizarTexto(body.votanteId);
        const valor = Number(body.valor);
        if (!votanteId) return json({ error: "Falta identificador de votante" }, 400);
        if (![1, -1, 0].includes(valor)) return json({ error: "Voto no válido" }, 400);

        const existente = await env.DB.prepare(
          "SELECT valor FROM comment_votes WHERE comment_id = ? AND votante_id = ?"
        ).bind(id, votanteId).first();

        if (valor === 0) {
          if (existente) {
            const columna = existente.valor === 1 ? "likes" : "dislikes";
            await env.DB.prepare("DELETE FROM comment_votes WHERE comment_id = ? AND votante_id = ?").bind(id, votanteId).run();
            await env.DB.prepare(`UPDATE comments SET ${columna} = MAX(0, ${columna} - 1) WHERE id = ?`).bind(id).run();
          }
        } else if (!existente) {
          await env.DB.prepare(
            "INSERT INTO comment_votes (comment_id, votante_id, valor) VALUES (?, ?, ?)"
          ).bind(id, votanteId, valor).run();
          const columna = valor === 1 ? "likes" : "dislikes";
          await env.DB.prepare(`UPDATE comments SET ${columna} = ${columna} + 1 WHERE id = ?`).bind(id).run();
        } else if (existente.valor !== valor) {
          await env.DB.prepare(
            "UPDATE comment_votes SET valor = ?, created_at = datetime('now') WHERE comment_id = ? AND votante_id = ?"
          ).bind(valor, id, votanteId).run();
          const columnaQuitar = existente.valor === 1 ? "likes" : "dislikes";
          const columnaSumar = valor === 1 ? "likes" : "dislikes";
          await env.DB.prepare(`UPDATE comments SET ${columnaQuitar} = MAX(0, ${columnaQuitar} - 1), ${columnaSumar} = ${columnaSumar} + 1 WHERE id = ?`).bind(id).run();
        }
        // valor === existente.valor: ya tenía ese voto, no hay nada que hacer.

        const actualizado = await env.DB.prepare("SELECT likes, dislikes FROM comments WHERE id = ?").bind(id).first();
        return json({ ok: true, likes: actualizado.likes, dislikes: actualizado.dislikes, votoActual: valor });
      }

      // Denuncia de un comentario. Se guarda para revisión manual del
      // admin en el panel; si un comentario acumula varias denuncias de
      // navegadores distintos se oculta automáticamente de la web (sin
      // borrarlo ni tocar su moderación) hasta que un admin lo revise.
      const denunciaComentarioMatch = path.match(/^\/api\/comments\/(\d+)\/report$/);
      if (denunciaComentarioMatch && method === "POST") {
        const id = parseInt(denunciaComentarioMatch[1]);
        const comentario = await env.DB.prepare(
          "SELECT id FROM comments WHERE id = ? AND estado = 'aprobado'"
        ).bind(id).first();
        if (!comentario) return json({ error: "Comentario no encontrado" }, 404);

        const body = await request.json();
        const denuncianteId = normalizarTexto(body.votanteId || body.denuncianteId);
        const motivo = normalizarTexto(body.motivo) || null;
        if (!denuncianteId) return json({ error: "Falta identificador de denunciante" }, 400);

        const yaDenunciado = await env.DB.prepare(
          "SELECT id FROM comment_reports WHERE comment_id = ? AND denunciante_id = ?"
        ).bind(id, denuncianteId).first();
        if (yaDenunciado) return json({ ok: true, mensaje: "Ya habías denunciado este comentario." });

        const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || null;
        await env.DB.prepare(
          "INSERT INTO comment_reports (comment_id, denunciante_id, motivo, ip) VALUES (?, ?, ?, ?)"
        ).bind(id, denuncianteId, motivo, ip).run();

        const resultado = await env.DB.prepare(
          "UPDATE comments SET denuncias = denuncias + 1 WHERE id = ? RETURNING denuncias"
        ).bind(id).first();

        if (resultado && resultado.denuncias >= DENUNCIAS_PARA_OCULTAR) {
          await env.DB.prepare("UPDATE comments SET oculto_por_denuncia = 1 WHERE id = ?").bind(id).run();
        }

        return json({ ok: true, mensaje: "Comentario denunciado. La redacción lo revisará." });
      }

      // ================================================================
      // ---------- PANEL DE ANALÍTICAS (datos propios, no GSC) ----------
      // ================================================================
      // Alimenta public/panel-analiticas.html sustituyendo los datos de
      // ejemplo del mockup por consultas reales sobre article_views/
      // article_reading (ver db/migrations/006_analiticas.sql). Solo
      // admin: estos números son de gestión interna, no algo que un
      // redactor normal necesite ver de otras noticias.
      //
      // Todos aceptan ?dias=7|28|90|365 (por defecto 28), igual que el
      // selector de rango del mockup. Mismas consultas que
      // worker/src/index.js (D1); aquí corren sobre Postgres, traducidas
      // por sql-compat.js (datetime('now', '-N days') y date(columna)).

      if (path.startsWith("/api/admin/analiticas") && method === "GET") {
        const payload = await requireAuth(request, env, url);
        if (!payload || payload.rol !== "admin") return json({ error: "Solo un administrador puede ver las analíticas" }, 403);

        // Rango capado a RANGO_ANALITICAS_MAX_DIAS (90): 365 días puede
        // escanear un año entero de article_views/article_reading sin
        // límite de filas (fue la causa más probable de las ~13M filas
        // leídas en un día el 1-sep-2026). Ya no se ofrece 365 como
        // opción real -- si se pide, se sirve como si fueran 90.
        const diasPermitidos = [1, 7, 28, 90];
        let dias = parseInt(url.searchParams.get("dias") || "28", 10);
        if (!diasPermitidos.includes(dias)) dias = Math.min(dias || 28, RANGO_ANALITICAS_MAX_DIAS) || 28;
        const desde = `datetime('now', '-${dias} days')`;

        // Cada sub-ruta se cachea en KV por separado (clave = ruta +
        // días) durante CACHE_ANALITICAS_TTL_SEGUNDOS. Los números de
        // analíticas no necesitan estar al segundo, así que recargar el
        // panel varias veces seguidas no vuelve a golpear D1 hasta que
        // caduque la caché.
        const cacheKey = `analiticas-cache:${path}:${dias}${path === "/api/admin/analiticas/mas-leidas" ? ":" + (url.searchParams.get("limit") || "10") : ""}`;

        // ---------- Resumen: KPIs + evolución diaria + dispositivos ----------
        if (path === "/api/admin/analiticas/resumen") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularResumenAnaliticas(env, desde)
          );
          return json(datos);
        }

        // ---------- Noticias más leídas ----------
        if (path === "/api/admin/analiticas/mas-leidas") {
          const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularMasLeidasAnaliticas(env, desde, limit)
          );
          return json(datos);
        }

        // ---------- Tráfico por fuente ----------
        if (path === "/api/admin/analiticas/fuentes") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularFuentesAnaliticas(env, desde)
          );
          return json(datos);
        }

        // ---------- Rendimiento por autor ----------
        if (path === "/api/admin/analiticas/autores") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularAutoresAnaliticas(env, desde)
          );
          return json(datos);
        }

        // ---------- Tiempo medio de lectura por categoría ----------
        if (path === "/api/admin/analiticas/tiempo-lectura") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularTiempoLecturaAnaliticas(env, desde)
          );
          return json(datos);
        }

        // ---------- Idiomas más usados al leer una noticia ----------
        if (path === "/api/admin/analiticas/idiomas") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularIdiomasAnaliticas(env, desde)
          );
          return json(datos);
        }

        // ---------- Partidos más seguidos ----------
        if (path === "/api/admin/analiticas/partidos-seguidos") {
          const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularPartidosMasSeguidosAnaliticas(env, desde, limit)
          );
          return json(datos);
        }

        // ---------- Search Console (Google) ----------
        if (path === "/api/admin/analiticas/gsc") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularGscAnaliticas(env, dias)
          );
          return json(datos);
        }

        // ---------- Franja horaria con más tráfico ----------
        if (path === "/api/admin/analiticas/horas") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularHorasAnaliticas(env, desde)
          );
          return json(datos);
        }

        // ---------- Rendimiento por tipo de artículo ----------
        if (path === "/api/admin/analiticas/tipos") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularTiposAnaliticas(env, desde)
          );
          return json(datos);
        }

        // ---------- Engagement por scroll ----------
        if (path === "/api/admin/analiticas/engagement-scroll") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularEngagementScrollAnaliticas(env, desde)
          );
          return json(datos);
        }

        // ---------- Vistas últimas 24 horas ----------
        if (path === "/api/admin/analiticas/ultimas-24h") {
          const { datos } = await conCacheKV(env, `analiticas-cache:${path}`, 60, () =>
            calcularUltimas24hAnaliticas(env)
          );
          return json(datos);
        }

        // ---------- Buscador de noticia por titular ----------
        if (path === "/api/admin/analiticas/buscar-noticia") {
          const q = (url.searchParams.get("q") || "").trim();
          if (!q) return json({ noticias: [] });
          const datos = await calcularBuscarNoticiaAnaliticas(env, desde, q);
          return json(datos);
        }

        // ---------- Rendimiento por categoría ----------
        if (path === "/api/admin/analiticas/categorias") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularCategoriasAnaliticas(env, desde)
          );
          return json(datos);
        }

        // ---------- Lectores nuevos vs. recurrentes ----------
        if (path === "/api/admin/analiticas/recurrencia") {
          const { datos } = await conCacheKV(env, cacheKey, CACHE_ANALITICAS_TTL_SEGUNDOS, () =>
            calcularRecurrenciaAnaliticas(env, desde)
          );
          return json(datos);
        }

        return json({ error: "Ruta de analíticas no encontrada" }, 404);
      }

      // ---------- Borrado de datos de tracking (destructivo) ----------
      // Ver la versión gemela en worker/src/index.js (D1) para la
      // explicación completa.
      if (path === "/api/admin/analiticas/datos" && method === "DELETE") {
        const payload = await requireAuth(request, env, url);
        if (!payload || payload.rol !== "admin") return json({ error: "Solo un administrador puede borrar las analíticas" }, 403);

        const todo = url.searchParams.get("todo") === "1";
        let dias = parseInt(url.searchParams.get("dias") || "28", 10);
        if (!Number.isFinite(dias) || dias <= 0) dias = 28;

        const datos = await borrarDatosAnaliticas(env, { todo, dias });
        return json(datos);
      }


      // Admin: listar (por estado), aprobar/rechazar y borrar.
      if (path === "/api/admin/comments" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede moderar comentarios" }, 403);

        const estado = url.searchParams.get("estado") || "pendiente";
        const { results: comentarios } = await env.DB.prepare(
          `SELECT c.*, a.titulo AS articulo_titulo, a.slug AS articulo_slug, a.categoria AS articulo_categoria
           FROM comments c JOIN articles a ON a.id = c.article_id
           WHERE c.estado = ? ORDER BY c.created_at DESC`
        ).bind(estado).all();
        return json({ comentarios });
      }

      // Admin: comentarios denunciados por lectores, en espera de
      // revisión manual (independiente de su `estado` de moderación:
      // normalmente estarán aprobados). Ordenados por más denunciados
      // primero para priorizar los casos más claros.
      if (path === "/api/admin/comments/reported" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede moderar comentarios" }, 403);

        const { results: comentarios } = await env.DB.prepare(
          `SELECT c.*, a.titulo AS articulo_titulo, a.slug AS articulo_slug, a.categoria AS articulo_categoria
           FROM comments c JOIN articles a ON a.id = c.article_id
           WHERE c.denuncias > 0 ORDER BY c.oculto_por_denuncia DESC, c.denuncias DESC, c.created_at DESC`
        ).all();
        return json({ comentarios });
      }

      // Admin: quitar la ocultación automática de un comentario denunciado
      // (queda de nuevo visible en la web, si sigue "aprobado") sin tocar
      // el contador de denuncias, que se conserva como registro.
      const desocultarComentarioMatch = path.match(/^\/api\/admin\/comments\/(\d+)\/unhide$/);
      if (desocultarComentarioMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede moderar comentarios" }, 403);

        const id = parseInt(desocultarComentarioMatch[1]);
        const resultado = await env.DB.prepare(
          "UPDATE comments SET oculto_por_denuncia = 0 WHERE id = ?"
        ).bind(id).run();
        if (!resultado.meta.changes) return json({ error: "Comentario no encontrado" }, 404);

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "revisar_denuncia_comentario", entidad: "comentario", entidad_id: id,
          descripcion: "Ha vuelto a mostrar un comentario que estaba oculto por denuncias",
        }));
        return json({ ok: true });
      }

      const comentarioMatch = path.match(/^\/api\/admin\/comments\/(\d+)$/);
      if (comentarioMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede moderar comentarios" }, 403);

        const id = parseInt(comentarioMatch[1]);
        const body = await request.json();
        if (!["aprobado", "rechazado", "pendiente"].includes(body.estado)) {
          return json({ error: "Estado no válido" }, 400);
        }
        const resultado = await env.DB.prepare(
          "UPDATE comments SET estado = ?, moderado_por_id = ?, moderado_at = datetime('now') WHERE id = ?"
        ).bind(body.estado, payload.uid, id).run();
        if (!resultado.meta.changes) return json({ error: "Comentario no encontrado" }, 404);

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "moderar_comentario", entidad: "comentario", entidad_id: id,
          descripcion: `Ha marcado un comentario como "${body.estado}"`,
        }));
        return json({ ok: true });
      }

      if (comentarioMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede borrar comentarios" }, 403);

        const id = parseInt(comentarioMatch[1]);
        const resultado = await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
        if (!resultado.meta.changes) return json({ error: "Comentario no encontrado" }, 404);

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "borrar_comentario", entidad: "comentario", entidad_id: id,
          descripcion: "Ha borrado un comentario",
        }));
        return json({ ok: true });
      }

      // ---------- Ficha informativa de club (entrenador, estadio...) ----------
      if (path === "/api/club-info" && method === "GET") {
        const club = url.searchParams.get("club");
        if (!club) return json({ error: "Falta el club" }, 400);
        const info = await env.DB.prepare(
          "SELECT club, entrenador, estadio, fundacion, ciudad FROM club_info WHERE club = ?"
        ).bind(club).first();
        return json({ info: info || null });
      }

      if (path === "/api/admin/club-info" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { results: fichas } = await env.DB.prepare(
          "SELECT * FROM club_info ORDER BY club COLLATE NOCASE ASC"
        ).all();
        return json({ fichas });
      }

      // Propuestas de ficha de club pendientes de revisión (las crea un
      // redactor de Nivel 1). Un admin o un redactor de Nivel 4 ve TODAS
      // las pendientes (para poder resolverlas); cualquier otro usuario
      // solo ve las suyas propias (para saber en qué punto están).
      if (path === "/api/admin/club-info/solicitudes" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const nivelUsuario = await obtenerNivelUsuario(env, payload.uid);
        const puedeResolver = payload.rol === "admin" || nivelUsuario >= NIVEL_MAXIMO;
        const { results: solicitudes } = puedeResolver
          ? await env.DB.prepare("SELECT * FROM club_info_solicitudes WHERE estado = 'pendiente' ORDER BY created_at ASC").all()
          : await env.DB.prepare("SELECT * FROM club_info_solicitudes WHERE estado = 'pendiente' AND solicitante_id = ? ORDER BY created_at ASC").bind(payload.uid).all();
        return json({ solicitudes, puede_resolver: puedeResolver });
      }

      if (path === "/api/club-info" && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);

        const body = await request.json();
        const club = normalizarTexto(body.club);
        if (!club) return json({ error: "Falta el nombre del club" }, 400);
        const entrenador = normalizarTexto(body.entrenador);
        const estadio = normalizarTexto(body.estadio);
        const ciudad = normalizarTexto(body.ciudad);
        const fundacion = body.fundacion ? parseInt(body.fundacion) : null;
        if (fundacion !== null && (isNaN(fundacion) || fundacion < 1800 || fundacion > 2100)) {
          return json({ error: "El año de fundación no es válido" }, 400);
        }

        // Un redactor de Nivel 1 no aplica el cambio directamente: se
        // guarda como propuesta pendiente de aprobación (por un admin o
        // un redactor de Nivel 4). A partir de Nivel 2 se aplica
        // directo, igual que un admin.
        const nivelUsuario = payload.rol === "admin" ? NIVEL_MAXIMO : await obtenerNivelUsuario(env, payload.uid);
        if (payload.rol !== "admin" && nivelUsuario < 2) {
          await env.DB.prepare(
            `INSERT INTO club_info_solicitudes (club, entrenador, estadio, fundacion, ciudad, solicitante_id, solicitante_nombre)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(club, entrenador, estadio, fundacion, ciudad, payload.uid, payload.nombre).run();

          ctx.waitUntil(registrarActividad(env, request, payload, {
            accion: "proponer_club_info", entidad: "club",
            descripcion: `Ha propuesto una ficha para el ${club}, pendiente de aprobación`,
          }));
          return json({ ok: true, pendiente: true });
        }

        await env.DB.prepare(
          `INSERT INTO club_info (club, entrenador, estadio, fundacion, ciudad, autor_id, autor_nombre, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(club) DO UPDATE SET
             entrenador = excluded.entrenador,
             estadio = excluded.estadio,
             fundacion = excluded.fundacion,
             ciudad = excluded.ciudad,
             autor_id = excluded.autor_id,
             autor_nombre = excluded.autor_nombre,
             updated_at = datetime('now')`
        ).bind(club, entrenador, estadio, fundacion, ciudad, payload.uid, payload.nombre).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_club_info", entidad: "club",
          descripcion: `Ha actualizado la ficha del ${club}`,
        }));
        return json({ ok: true, pendiente: false });
      }

      // Aprobar o rechazar una propuesta de ficha de club. Solo un admin
      // o un redactor de Nivel 4 puede hacerlo.
      if (path.match(/^\/api\/admin\/club-info\/solicitudes\/\d+$/) && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const nivelUsuario = await obtenerNivelUsuario(env, payload.uid);
        if (payload.rol !== "admin" && nivelUsuario < NIVEL_MAXIMO) {
          return json({ error: "No tienes permiso para resolver propuestas" }, 403);
        }

        const id = parseInt(path.split("/").pop());
        const body = await request.json();
        const accion = body.accion === "rechazar" ? "rechazar" : "aprobar";

        const solicitud = await env.DB.prepare("SELECT * FROM club_info_solicitudes WHERE id = ?").bind(id).first();
        if (!solicitud) return json({ error: "Propuesta no encontrada" }, 404);
        if (solicitud.estado !== "pendiente") return json({ error: "Esta propuesta ya se ha resuelto" }, 400);

        if (accion === "aprobar") {
          await env.DB.prepare(
            `INSERT INTO club_info (club, entrenador, estadio, fundacion, ciudad, autor_id, autor_nombre, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(club) DO UPDATE SET
               entrenador = excluded.entrenador,
               estadio = excluded.estadio,
               fundacion = excluded.fundacion,
               ciudad = excluded.ciudad,
               autor_id = excluded.autor_id,
               autor_nombre = excluded.autor_nombre,
               updated_at = datetime('now')`
          ).bind(solicitud.club, solicitud.entrenador, solicitud.estadio, solicitud.fundacion, solicitud.ciudad, solicitud.solicitante_id, solicitud.solicitante_nombre).run();
        }

        await env.DB.prepare(
          `UPDATE club_info_solicitudes SET estado = ?, resuelta_por_id = ?, resuelta_por_nombre = ?, resuelta_at = datetime('now') WHERE id = ?`
        ).bind(accion === "aprobar" ? "aprobada" : "rechazada", payload.uid, payload.nombre, id).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: accion === "aprobar" ? "aprobar_club_info" : "rechazar_club_info",
          entidad: "club", entidad_id: id,
          descripcion: `${payload.nombre} ha ${accion === "aprobar" ? "aprobado" : "rechazado"} la propuesta de ficha del ${solicitud.club}`,
        }));
        return json({ ok: true });
      }

      if (path === "/api/club-info" && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede borrar la ficha de un club" }, 403);
        const club = url.searchParams.get("club");
        if (!club) return json({ error: "Falta el club" }, 400);
        await env.DB.prepare("DELETE FROM club_info WHERE club = ?").bind(club).run();
        return json({ ok: true });
      }

      // Segunda Federación: composición OFICIAL completa de los 5 grupos
      // (90 clubes), temporada 2026/27. MISMA lista que en el worker
      // principal (worker/src/index.js) y que
      // TODOS_LOS_CLUBES_SEGUNDA_FEDERACION en public/js/clubs.js -- si
      // se actualiza una hay que actualizar las tres (no se puede
      // compartir el archivo porque este worker-secondary es el backend
      // de respaldo en Railway y necesita el mismo comportamiento
      // durante un failover). Cada verano, cuando la RFEF redefine los
      // grupos, hay que revisar y actualizar las tres listas.
      //
      // OJO: este cálculo automático es solo un VALOR POR DEFECTO. Si
      // el panel de admin manda explícitamente un body.grupo (porque el
      // redactor lo ha escrito o corregido a mano), esa elección manual
      // SIEMPRE prevalece y nunca se pisa aquí -- ver grupoAGuardar /
      // grupoAGuardarEdicion más abajo.
      const GRUPO_SEGUNDA_FEDERACION_POR_EQUIPO = {
        // Grupo 1
        "Deportivo Alavés B": "Grupo 1",
        "Atlético Astorga": "Grupo 1",
        "Arosa SC": "Grupo 1",
        "Bergantiños": "Grupo 1",
        "CD Basconia": "Grupo 1",
        "Coruxo": "Grupo 1",
        "SD Eibar B": "Grupo 1",
        "Club Portugalete": "Grupo 1",
        "SD Gernika": "Grupo 1",
        "Ourense CF": "Grupo 1",
        "RS Gimnástica de Torrelavega": "Grupo 1",
        "Rayo Cantabria": "Grupo 1",
        "Real Oviedo Vetusta": "Grupo 1",
        "SD Amorebieta": "Grupo 1",
        "Sestao River": "Grupo 1",
        "SD Compostela": "Grupo 1",
        "UD Llanera": "Grupo 1",
        "Club Marino de Luanco": "Grupo 1",
        // Grupo 2
        "CD Arnedo": "Grupo 2",
        "CE Manresa": "Grupo 2",
        "FC Barcelona Atlètic": "Grupo 2",
        "Náxara": "Grupo 2",
        "UE Olot": "Grupo 2",
        "CD Ebro": "Grupo 2",
        "Peña Sport": "Grupo 2",
        "Utebo": "Grupo 2",
        "Reus FC Reddis": "Grupo 2",
        "Atlético Osasuna B": "Grupo 2",
        "SD Logroñés": "Grupo 2",
        "RCD Espanyol B": "Grupo 2",
        "CF Calamocha": "Grupo 2",
        "Terrassa": "Grupo 2",
        "CD Tudelano": "Grupo 2",
        "UD Logroñés B": "Grupo 2",
        "UD Barbastro": "Grupo 2",
        "Girona FC B": "Grupo 2",
        // Grupo 3
        "CD Alcoyano": "Grupo 3",
        "CD Cieza": "Grupo 3",
        "UD Castellonense": "Grupo 3",
        "UCAM Murcia": "Grupo 3",
        "CF La Nucía": "Grupo 3",
        "UD Poblense": "Grupo 3",
        "CF Lorca Deportiva": "Grupo 3",
        "Elche Ilicitano": "Grupo 3",
        "CD Minera": "Grupo 3",
        "SCR Peña Deportiva": "Grupo 3",
        "Real Murcia Imperial": "Grupo 3",
        "Orihuela CF": "Grupo 3",
        "CD Castellón B": "Grupo 3",
        "CF Intercity": "Grupo 3",
        "Valencia Mestalla": "Grupo 3",
        "RCD Mallorca B": "Grupo 3",
        "Yeclano Deportivo": "Grupo 3",
        "CD Atlético Baleares": "Grupo 3",
        // Grupo 4
        "Atlético Antoniano": "Grupo 4",
        "CD Don Benito": "Grupo 4",
        "Salerm Cosmetics Puente Genil": "Grupo 4",
        "CP Mijas Las Lagunas": "Grupo 4",
        "CD Badajoz": "Grupo 4",
        "CD Tenerife B": "Grupo 4",
        "Atlético Central": "Grupo 4",
        "Recreativo de Huelva": "Grupo 4",
        "CD Estepona": "Grupo 4",
        "Xerez CD": "Grupo 4",
        "Linares Deportivo": "Grupo 4",
        "CD Ciudad de Lucena": "Grupo 4",
        "Las Palmas Atlético": "Grupo 4",
        "Betis Deportivo": "Grupo 4",
        "Marbella FC": "Grupo 4",
        "Atlético Sanluqueño": "Grupo 4",
        "UD Tamaraceite": "Grupo 4",
        "Sevilla Atlético": "Grupo 4",
        // Grupo 5
        "Real Madrid C": "Grupo 5",
        "Atlético Albacete": "Grupo 5",
        "Atlético de Madrid C": "Grupo 5",
        "Real Ávila": "Grupo 5",
        "CD Atlético Paso": "Grupo 5",
        "CD Numancia": "Grupo 5",
        "CD Guadalajara": "Grupo 5",
        "Salamanca UDS": "Grupo 5",
        "Calvo Sotelo Puertollano": "Grupo 5",
        "Gimnástica Segoviana": "Grupo 5",
        "RSD Alcalá": "Grupo 5",
        "CF Talavera de la Reina": "Grupo 5",
        "Real Valladolid Promesas": "Grupo 5",
        "CDA Navalcarnero": "Grupo 5",
        "Atlético Tordesillas": "Grupo 5",
        "UD San Sebastián de los Reyes": "Grupo 5",
        "UB Conquense": "Grupo 5",
        "Getafe B": "Grupo 5",
      };
      function grupoAutomaticoSegundaFederacion(competicion, equipoLocal, equipoVisitante) {
        if (competicion !== "segunda_federacion") return null;
        return GRUPO_SEGUNDA_FEDERACION_POR_EQUIPO[equipoLocal]
          || GRUPO_SEGUNDA_FEDERACION_POR_EQUIPO[equipoVisitante]
          || null;
      }

      // Estados válidos de un partido. "retrasado" y "anulado" son
      // nuevos: un partido retrasado sigue "programado" a efectos de
      // cronómetro (no arranca hasta la nueva hora); uno anulado no
      // vuelve a arrancar nunca (se congela tal cual quedase).
      const ESTADOS_RESULTADO_VALIDOS = ["programado", "en_juego", "retrasado", "anulado", "finalizado"];

      // Minutos transcurridos entre la hora programada del partido
      // (fecha_partido) y ahora. Se usa cuando el estado se pone
      // "en_juego" a mano (desde el formulario manual) para arrancar el
      // cronómetro ya avanzado en vez de desde 0, igual que si el cron
      // lo hubiera arrancado a su hora y el redactor solo estuviera
      // corrigiendo el estado a posteriori. 0 si no hay fecha con hora,
      // o si la hora programada todavía no ha llegado.
      function minutosDesdeHoraProgramada(fechaPartido) {
        // fecha_partido es hora de Madrid, no UTC: se convierte con el
        // mismo helper que usa el cron (fechaPartidoAUtcSqlite) antes de
        // restar contra "ahora", si no el cálculo salía desviado 1-2h.
        const inicioUtcSqlite = fechaPartidoAUtcSqlite(fechaPartido);
        if (inicioUtcSqlite === null) return 0; // sin hora conocida ("YYYY-MM-DD" a secas)
        const inicio = new Date(inicioUtcSqlite.replace(" ", "T") + "Z").getTime();
        if (isNaN(inicio)) return 0;
        const minutos = Math.floor((Date.now() - inicio) / 60000);
        return minutos > 0 ? minutos : 0;
      }

      if (path === "/api/results" && method === "GET") {
        const competicion = url.searchParams.get("competicion");
        const estado = url.searchParams.get("estado");
        const grupo = url.searchParams.get("grupo");
        // Filtro por equipo (para la página de equipo y el desplegable de
        // Resultados): un partido "pertenece" a un club tanto si juega en
        // casa como fuera, así que se compara contra las dos columnas.
        const club = url.searchParams.get("club");
        // Filtro opcional por fecha mínima del partido ("YYYY-MM-DD"),
        // pensado para pedir "solo la temporada en curso" sin depender de
        // un LIMIT fijo. Ver el comentario gemelo en worker/src/index.js
        // (mismo endpoint, backend principal) para la explicación completa
        // de por qué era necesario: sin esto, la clasificación calculada
        // en /clasificacion.html podía salir incompleta de forma
        // intermitente en cuanto un grupo acumulaba más de "limit"
        // partidos entre varias temporadas sin archivar. Se incluyen
        // también los partidos con fecha_partido NULL (normalmente
        // recién creados/sin programar todavía) para no perderlos por no
        // tener fecha con la que compararlos.
        const desdeFecha = url.searchParams.get("desde_fecha");
        // El límite era fijo (100) e ignoraba el "?limit=" que ya mandaba
        // el frontend (el panel de admin pide 200 para no dejarse partidos
        // fuera). Si un resultado quedaba fuera de esos 100 primeros, el
        // panel de Minuto a Minuto dejaba de encontrarlo al refrescar tras
        // "Iniciar partido" y se quedaba con los datos previos en memoria
        // (sin inicio_cronometro_at), así que el cronómetro no arrancaba
        // nunca aunque el backend sí lo hubiera guardado bien.
        const limitParam = parseInt(url.searchParams.get("limit"), 10);
        const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 2000 ? limitParam : 100;
        let query = "SELECT * FROM results WHERE 1=1";
        const binds = [];
        if (competicion) { query += " AND competicion = ?"; binds.push(competicion); }
        if (desdeFecha) { query += " AND (fecha_partido >= ? OR fecha_partido IS NULL)"; binds.push(desdeFecha); }
        if (estado) { query += " AND estado = ?"; binds.push(estado); }
        if (grupo) { query += " AND grupo = ?"; binds.push(grupo); }
        if (club) {
          query += " AND (equipo_local = ? OR equipo_visitante = ?)";
          binds.push(club, club);
        }
        // Antes se ordenaba "ORDER BY jornada DESC, fecha_partido DESC": al
        // mezclar todas las competiciones en una sola consulta, eso hacía
        // que el LIMIT se llenara con las jornadas MÁS ALTAS de cada
        // competición antes de llegar a las bajas, así que una jornada 1
        // podía quedar fuera del recorte y desaparecer del panel de admin
        // (que no filtra por competición, solo busca en texto dentro de lo
        // ya traído) aunque siguiera existiendo en la base de datos y
        // apareciera bien en la web pública (que sí filtra por competición
        // en la propia consulta). Se ordena por fecha_partido en su lugar,
        // que es lo relevante para "traer los partidos más recientes" y no
        // deja huecos según la jornada de cada competición.
        query += ` ORDER BY fecha_partido DESC LIMIT ${limit}`;
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        // Se añade el instante del último evento (gol, tarjeta, cambio...)
        // registrado en el minuto a minuto de cada partido, para que el
        // panel de admin pueda distinguir un partido realmente desatendido
        // de uno que sigue corriendo por encima de los umbrales normales
        // pero en el que el redactor SÍ está metiendo eventos (ver
        // avisoPartidoDesatendido en admin.js, que ya no marca "Sin
        // cubrir" si hay actividad reciente). Solo tiene sentido pedirlo
        // para partidos en juego, que son los únicos que ese aviso evalúa.
        const idsEnJuego = results.filter(r => r.estado === "en_juego").map(r => r.id);
        if (idsEnJuego.length) {
          const placeholders = idsEnJuego.map(() => "?").join(",");
          const { results: ultimosEventos } = await env.DB.prepare(
            `SELECT resultado_id, MAX(created_at) AS ultimo_evento_at FROM match_events
             WHERE resultado_id IN (${placeholders}) GROUP BY resultado_id`
          ).bind(...idsEnJuego).all();
          const mapaUltimoEvento = {};
          ultimosEventos.forEach(e => { mapaUltimoEvento[e.resultado_id] = e.ultimo_evento_at; });
          results.forEach(r => { r.ultimo_evento_at = mapaUltimoEvento[r.id] || null; });
        }
        return json({ results });
      }

      if (path === "/api/results" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const body = await request.json();
        if (body.estado && !ESTADOS_RESULTADO_VALIDOS.includes(body.estado)) {
          return json({ error: "Estado no válido" }, 400);
        }
        // No se deja crear un resultado si falta algún dato básico (el
        // frontend ya valida esto mismo, pero se repite aquí para que
        // tampoco se pueda colar un partido incompleto llamando a la API
        // directamente). "jornada" no se exige para "amistoso", que no
        // usa jornadas.
        if (!body.competicion) return json({ error: "Falta la competición" }, 400);
        if (!body.equipo_local || !String(body.equipo_local).trim()) return json({ error: "Falta el equipo local" }, 400);
        if (!body.equipo_visitante || !String(body.equipo_visitante).trim()) return json({ error: "Falta el equipo visitante" }, 400);
        if (String(body.equipo_local).trim().toLowerCase() === String(body.equipo_visitante).trim().toLowerCase()) {
          return json({ error: "El equipo local y el visitante no pueden ser el mismo" }, 400);
        }
        if (!body.fecha_partido) return json({ error: "Falta la fecha del partido" }, 400);
        if (!body.estado) return json({ error: "Falta el estado del partido" }, 400);
        if (body.competicion !== "amistoso" && (body.jornada === undefined || body.jornada === null || body.jornada === "")) {
          return json({ error: "Falta la jornada" }, 400);
        }
        if (body.estado === "retrasado" && !body.fecha_partido_retrasado) {
          return json({ error: "Falta la nueva fecha/hora del partido retrasado" }, 400);
        }
        if ((body.estado === "en_juego" || body.estado === "finalizado") &&
            (body.goles_local === undefined || body.goles_local === null || body.goles_visitante === undefined || body.goles_visitante === null)) {
          return json({ error: "Falta el marcador (goles de ambos equipos)" }, 400);
        }
        // Aviso de posible duplicado: mismo partido (mismos equipos, en
        // cualquier orden -por si se han metido al revés local/visitante-,
        // misma competición, misma fecha/hora Y MISMO MARCADOR) ya
        // existente. Solo se avisa cuando es EXACTAMENTE igual -si el
        // marcador es distinto no tiene sentido el aviso, ya que
        // claramente no es el mismo resultado tecleado dos veces-. No se
        // bloquea la creación -puede ser un caso real, como un derbi que
        // efectivamente se repite en amistoso el mismo día con el mismo
        // resultado-, solo se avisa una vez: si el frontend reenvía la
        // petición con "confirmar_duplicado: true" (tras que el redactor
        // confirme), se crea igualmente sin volver a comprobar.
        if (!body.confirmar_duplicado && body.equipo_local && body.equipo_visitante && body.fecha_partido) {
          const golesLocalBody = body.goles_local ?? null;
          const golesVisitanteBody = body.goles_visitante ?? null;
          const posibleDuplicado = await env.DB.prepare(
            `SELECT id, competicion, grupo, jornada, equipo_local, equipo_visitante, goles_local, goles_visitante, fecha_partido, estado
             FROM results
             WHERE competicion = ? AND fecha_partido = ?
               AND goles_local IS ? AND goles_visitante IS ?
               AND ((equipo_local = ? AND equipo_visitante = ?) OR (equipo_local = ? AND equipo_visitante = ?))
             LIMIT 1`
          ).bind(
            body.competicion, body.fecha_partido,
            golesLocalBody, golesVisitanteBody,
            body.equipo_local, body.equipo_visitante,
            body.equipo_visitante, body.equipo_local
          ).first();
          if (posibleDuplicado) {
            return json({ posible_duplicado: true, partido_existente: posibleDuplicado }, 409);
          }
        }
        const flashscoreUrl = flashscoreUrlValido(body.competicion, body.estado, body.flashscore_url);
        // El grupo de Segunda Federación se rellena automáticamente (ver
        // grupoAutomaticoSegundaFederacion arriba) SOLO cuando el panel
        // no manda ya un grupo explícito; si el redactor lo ha escrito o
        // corregido a mano, esa elección manual prevalece siempre (ver
        // comentario extenso en worker/src/index.js). En el resto de
        // competiciones se sigue respetando siempre lo que mande el
        // panel, igual que antes.
        const grupoCalculado = grupoAutomaticoSegundaFederacion(body.competicion, body.equipo_local, body.equipo_visitante);
        const grupoAGuardar = body.competicion === "segunda_federacion"
          ? (body.grupo || grupoCalculado)
          : (body.grupo || null);
        const insertResult = await env.DB.prepare(
          `INSERT INTO results (competicion, grupo, jornada, equipo_local, equipo_visitante, goles_local, goles_visitante, fecha_partido, estado, ubicacion, flashscore_url, escudo_local_url, escudo_visitante_url, autor_id, autor_nombre, origin_write_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          body.competicion, grupoAGuardar, body.jornada, body.equipo_local, body.equipo_visitante,
          body.goles_local ?? null, body.goles_visitante ?? null, body.fecha_partido || null, body.estado || "programado",
          body.ubicacion || null, flashscoreUrl,
          body.escudo_local_url || null, body.escudo_visitante_url || null,
          payload.uid, payload.nombre, origenWriteId
        ).run();
        const nuevoId = insertResult.meta.last_row_id;
        // Si se crea directamente en estado "en_juego" a mano, se arranca
        // el cronómetro igual que si lo hubiera arrancado el cron a su
        // hora (mismo camino único, ver iniciarCronometroPartido): se
        // calcula cuántos minutos han pasado ya desde la hora programada
        // para no arrancar el reloj desde 0 si en realidad el partido
        // lleva un rato jugándose.
        if (body.estado === "en_juego") {
          await iniciarCronometroPartido(env, nuevoId, minutosDesdeHoraProgramada(body.fecha_partido));
        }
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_resultado", entidad: "resultado",
          descripcion: `Ha creado el partido "${body.equipo_local} vs ${body.equipo_visitante}" (J${body.jornada})`,
        }));
        // Se devuelve el id recién creado para que el panel pueda, sin
        // necesidad de recargar ni entrar en modo edición, mostrar a
        // continuación el bloque de "Goles y tarjetas" del partido.
        return json({ ok: true, id: nuevoId });
      }

      const resultMatch = path.match(/^\/api\/results\/(\d+)$/);
      // Un único resultado por id (sin autenticar, igual que la lista: se
      // usa en el detalle público y, sobre todo, para que el panel de
      // Minuto a Minuto pueda refrescar el estado de "su" partido sin
      // depender de que aparezca dentro de la lista general (que tiene
      // límite y orden propios, y podía dejar el resultado fuera).
      if (resultMatch && method === "GET") {
        const id = parseInt(resultMatch[1]);
        const resultado = await env.DB.prepare("SELECT * FROM results WHERE id = ?").bind(id).first();
        if (!resultado) return json({ error: "Resultado no encontrado" }, 404);
        resultado.alineaciones = await obtenerAlineaciones(env, "result_id", id);
        // Si hay una (o varias) noticia ya publicada vinculada a este
        // partido (crónica, previa...), se adjunta aquí para poder
        // enlazarla desde el propio modal de resultado en la web
        // pública: así, quien ve el marcador puede entrar directamente
        // a leer la noticia sin tener que buscarla aparte. Solo se
        // devuelven las publicadas (nunca un borrador o una programada
        // que todavía no ha salido) y, de haber varias, la más reciente
        // primero.
        const { results: noticiasVinculadas } = await env.DB.prepare(
          `SELECT slug, titulo, tipo, categoria FROM articles
           WHERE resultado_id = ? AND publicado = 1
           ORDER BY fecha_publicacion DESC LIMIT 5`
        ).bind(id).all();
        resultado.noticias_vinculadas = noticiasVinculadas || [];
        return json({ resultado });
      }
      if (resultMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(resultMatch[1]);
        const resultadoParaPermiso = await env.DB.prepare("SELECT autor_id FROM results WHERE id = ?").bind(id).first();
        if (!resultadoParaPermiso) return json({ error: "Resultado no encontrado" }, 404);
        if (!(await puedeEditar(env, payload, "resultado", id, resultadoParaPermiso.autor_id))) {
          return json({ error: "No puedes editar este resultado porque no es tuyo. Solicita permiso al autor o a un administrador." }, 403);
        }
        const body = await request.json();
        if (body.estado && !ESTADOS_RESULTADO_VALIDOS.includes(body.estado)) {
          return json({ error: "Estado no válido" }, 400);
        }
        const estadoAnterior = await env.DB.prepare("SELECT estado, inicio_cronometro_at, fecha_partido FROM results WHERE id = ?").bind(id).first();
        const flashscoreUrl = flashscoreUrlValido(body.competicion, body.estado, body.flashscore_url);
        // Si viene "retrasado" y se manda una nueva hora, se conserva la
        // fecha_partido original y se guarda la nueva en un campo aparte
        // (fecha_partido_retrasado); si no es "retrasado", ese campo se
        // limpia siempre (evita que quede "colgado" de un retraso previo
        // si luego el partido se reprograma o se juega con normalidad).
        const fechaRetrasado = body.estado === "retrasado" ? (body.fecha_partido_retrasado || null) : null;
        // Mismo cálculo automático del grupo que en la creación (POST),
        // con la misma prioridad: si el panel manda body.grupo a mano,
        // se respeta siempre; el cálculo automático es solo el valor
        // por defecto cuando no viene nada (ver POST de arriba).
        const grupoCalculadoEdicion = grupoAutomaticoSegundaFederacion(body.competicion, body.equipo_local, body.equipo_visitante);
        const grupoAGuardarEdicion = body.competicion === "segunda_federacion"
          ? (body.grupo || grupoCalculadoEdicion)
          : (body.grupo || null);
        await env.DB.prepare(
          `UPDATE results SET competicion=?, grupo=?, jornada=?, equipo_local=?, equipo_visitante=?, goles_local=?, goles_visitante=?, penaltis_local=?, penaltis_visitante=?, fecha_partido=?, estado=?, ubicacion=?, flashscore_url=?, escudo_local_url=?, escudo_visitante_url=?, fecha_partido_retrasado=?, finalizado_no_cubierto=0 WHERE id=?`
        ).bind(
          body.competicion, grupoAGuardarEdicion, body.jornada, body.equipo_local, body.equipo_visitante,
          body.goles_local ?? null, body.goles_visitante ?? null,
          body.penaltis_local ?? null, body.penaltis_visitante ?? null,
          body.fecha_partido || null, body.estado || "programado",
          body.ubicacion || null, flashscoreUrl,
          body.escudo_local_url || null, body.escudo_visitante_url || null, fechaRetrasado, id
        ).run();
        // Mismo camino único que la creación y que el cron: si el estado
        // pasa A "en_juego" (viniendo de cualquier otro estado) y el
        // cronómetro no estaba ya corriendo, se arranca ahora mismo,
        // calculando cuántos minutos han pasado desde la hora programada
        // en vez de arrancar desde 0 — por ejemplo, si el partido era a
        // las 14:00 y se marca "En juego" a mano a las 14:15, el
        // cronómetro arranca ya en el minuto 15.
        if (body.estado === "en_juego" && estadoAnterior?.estado !== "en_juego" && !estadoAnterior?.inicio_cronometro_at) {
          await iniciarCronometroPartido(env, id, minutosDesdeHoraProgramada(body.fecha_partido || estadoAnterior?.fecha_partido));
        } else if (body.estado === "en_juego" && estadoAnterior?.estado !== "en_juego") {
          // El partido ya tenía un cronómetro arrancado de una vida
          // anterior (p. ej. estaba "colgado", o se anuló/finalizó y ahora
          // se reabre a "en_juego" sin pasar por "Iniciar partido" de
          // nuevo -- este es justo el caso de la Importación rápida
          // cuando el texto pegado todavía trae "2ª parte"/"Descanso" en
          // vez de "Fin" para un partido que el cron ya había cerrado
          // solo: ver ESTADOS_COMPACTO_A_BACKEND en
          // admin/js/importacion-rapida.js).
          //
          // ANTES aquí NO se tocaba el cronómetro en sí, solo se limpiaba
          // aviso_desatendido_mitad -- pero inicio_cronometro_at se
          // quedaba con el valor VIEJO de esa vida anterior. Si ese
          // partido llevaba ya más de MINUTO_FIN_PARTIDO_AUTOMATICO (150)
          // minutos corriendo desde entonces (típicamente porque fue el
          // propio cron quien lo cerró automáticamente, ver
          // crearFinPartidoAutomaticoAlMinuto90, que NUNCA toca
          // inicio_cronometro_at/cronometro_pausado_en al cerrar), el
          // resultado quedaba "en_juego" con un cronómetro que YA marcaba
          // más de 150' desde el primer segundo: en la siguiente pasada
          // del cron (como mucho 1 minuto después) crearFinPartido-
          // AutomaticoAlMinuto90 lo volvía a cerrar solo, marcando de
          // nuevo finalizado_no_cubierto = 1 -- deshaciendo justo lo que
          // este PUT acababa de limpiar más abajo. Ese era el bug real
          // detrás de "la Importación rápida deja el marcador bien pero
          // el partido sigue saliendo como FINALIZADO NO CUBIERTO": no es
          // que este PUT no limpiara el aviso, es que el cron lo volvía a
          // poner él solo justo después, sin que se notara ninguna otra
          // escritura entre medias.
          //
          // Se reinicia aquí el cronómetro desde AHORA (igual que en la
          // rama de arriba, pero sin el cálculo de minutos desde la hora
          // programada -- ese cálculo es para partidos que arrancan por
          // primera vez, no para reaperturas), para que el partido quede
          // con un cronómetro fresco y no vuelva a activar el cierre
          // automático hasta pasados otros 150 minutos de verdad.
          await iniciarCronometroPartido(env, id, 0);
        }
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_resultado", entidad: "resultado", entidad_id: id,
          descripcion: `Ha editado el partido "${body.equipo_local} vs ${body.equipo_visitante}" (J${body.jornada})`,
        }));
        return json({ ok: true });
      }

      if (resultMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(resultMatch[1]);
        const resultadoBorrado = await env.DB.prepare("SELECT autor_id FROM results WHERE id = ?").bind(id).first();
        if (!resultadoBorrado) return json({ error: "Resultado no encontrado" }, 404);
        if (!(await puedeEditar(env, payload, "resultado", id, resultadoBorrado.autor_id))) {
          return json({ error: "No puedes eliminar este resultado porque no es tuyo. Solicita permiso al autor o a un administrador." }, 403);
        }
        await env.DB.prepare("DELETE FROM results WHERE id = ?").bind(id).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "eliminar_resultado", entidad: "resultado", entidad_id: id,
          descripcion: `Ha eliminado el partido con id ${id}`,
        }));
        return json({ ok: true });
      }

      // MVP (jugador destacado) del partido: endpoint dedicado y ligero
      // en vez de reutilizar el PUT completo de arriba, para que tanto
      // el panel de Minuto a Minuto (que no tiene cargado el formulario
      // entero del partido) como el panel normal puedan marcarlo o
      // quitarlo con una sola llamada, sin arriesgarse a pisar el resto
      // de campos del resultado con un body parcial.
      const resultMvpMatch = path.match(/^\/api\/results\/(\d+)\/mvp$/);
      if (resultMvpMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(resultMvpMatch[1]);
        const resultado = await env.DB.prepare("SELECT autor_id, equipo_local, equipo_visitante FROM results WHERE id = ?").bind(id).first();
        if (!resultado) return json({ error: "Resultado no encontrado" }, 404);
        if (!(await puedeEditar(env, payload, "resultado", id, resultado.autor_id))) {
          return json({ error: "No puedes editar este resultado porque no es tuyo. Solicita permiso al autor o a un administrador." }, 403);
        }
        const body = await request.json();
        // Se admite mandar ambos a null/vacío para "quitar" el MVP ya
        // marcado (p.ej. si el redactor se ha equivocado de jugador y
        // prefiere dejarlo sin marcar de momento en vez de corregirlo).
        const mvpJugador = (body.mvp_jugador || "").trim() || null;
        const mvpEquipo = mvpJugador ? body.mvp_equipo : null;
        if (mvpJugador && !["local", "visitante"].includes(mvpEquipo)) {
          return json({ error: "Equipo del MVP no válido (debe ser 'local' o 'visitante')" }, 400);
        }
        await env.DB.prepare("UPDATE results SET mvp_jugador=?, mvp_equipo=? WHERE id=?")
          .bind(mvpJugador, mvpEquipo, id).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_resultado", entidad: "resultado", entidad_id: id,
          descripcion: mvpJugador
            ? `Ha marcado a "${mvpJugador}" como MVP del partido "${resultado.equipo_local} vs ${resultado.equipo_visitante}"`
            : `Ha quitado el MVP del partido "${resultado.equipo_local} vs ${resultado.equipo_visitante}"`,
        }));
        return json({ ok: true });
      }

      // ---------- ALINEACIONES ----------
      // Once inicial dibujado sobre un campo de fútbol, vinculado a una
      // noticia o a un partido (ver worker/migracion_alineaciones.sql).
      // Se gestionan como su propia entidad (no embebidas dentro de
      // articles/results) porque una noticia o un partido pueden llevar
      // dos alineaciones (local y visitante) y porque así el mismo panel
      // de edición sirve para ambos contextos sin duplicar código.
      // Últimas alineaciones guardadas de un equipo, para el botón
      // "Copiar de un partido anterior" del editor de alineaciones (ver
      // obtenerUltimasAlineacionesEquipo). ?equipo= es obligatorio;
      // ?excluir_result_id= evita traer la alineación del propio
      // partido que se está editando si ya se hubiera guardado antes.
      if (path === "/api/alineaciones/ultimas" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const equipo = url.searchParams.get("equipo");
        if (!equipo || !equipo.trim()) return json({ error: "Falta el equipo" }, 400);
        const excluirResultId = parseInt(url.searchParams.get("excluir_result_id"), 10) || 0;
        const ultimas = await obtenerUltimasAlineacionesEquipo(env, equipo.trim(), excluirResultId, 3);
        return json({ alineaciones: ultimas });
      }

      if (path === "/api/alineaciones" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const body = await request.json();
        const articleId = body.article_id ? parseInt(body.article_id, 10) : null;
        const resultId = body.result_id ? parseInt(body.result_id, 10) : null;
        if ((!articleId && !resultId) || (articleId && resultId)) {
          return json({ error: "La alineación debe ir ligada a una noticia o a un partido (no a ambos)." }, 400);
        }
        if (!body.equipo || !String(body.equipo).trim()) {
          return json({ error: "Falta el nombre del equipo" }, 400);
        }
        // Permiso: se comprueba sobre la noticia o el partido al que se
        // engancha la alineación, igual que se haría para editarlos.
        if (articleId) {
          const art = await env.DB.prepare("SELECT autor_id, coautor_id, resultado_id FROM articles WHERE id = ?").bind(articleId).first();
          if (!art) return json({ error: "Noticia no encontrada" }, 404);
          if (!(await puedeEditar(env, payload, "articulo", articleId, art.autor_id, art.coautor_id))) {
            return json({ error: "No puedes editar esta noticia." }, 403);
          }
          // Si la noticia ya está vinculada a un partido, la alineación
          // debe colgar del partido (result_id), no de la noticia, para
          // que ambos compartan siempre la misma fila y no se desincronicen.
          if (art.resultado_id) {
            return json({ error: "Esta noticia está vinculada a un partido: la alineación se gestiona desde el partido, no desde la noticia." }, 400);
          }
        } else {
          const res = await env.DB.prepare("SELECT autor_id FROM results WHERE id = ?").bind(resultId).first();
          if (!res) return json({ error: "Resultado no encontrado" }, 404);
          if (!(await puedeEditar(env, payload, "resultado", resultId, res.autor_id))) {
            return json({ error: "No puedes editar este resultado." }, 403);
          }
        }
        const jugadores = normalizarJugadoresAlineacion(body.jugadores);
        const insertAlineacion = await env.DB.prepare(
          `INSERT INTO alineaciones (article_id, result_id, equipo, escudo_url, formacion, jugadores, autor_id, autor_nombre, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(
          articleId, resultId, String(body.equipo).trim(), body.escudo_url || null,
          body.formacion || "4-3-3", JSON.stringify(jugadores), payload.uid, payload.nombre
        ).run();
        return json({ ok: true, id: insertAlineacion.meta.last_row_id });
      }

      const alineacionMatch = path.match(/^\/api\/alineaciones\/(\d+)$/);
      if (alineacionMatch && (method === "PUT" || method === "DELETE")) {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(alineacionMatch[1]);
        const alineacion = await env.DB.prepare("SELECT * FROM alineaciones WHERE id = ?").bind(id).first();
        if (!alineacion) return json({ error: "Alineación no encontrada" }, 404);

        // Mismo criterio de permisos que la noticia/el partido al que
        // pertenece (no tiene sentido poder editar la alineación de un
        // partido que no es tuyo, aunque la hayas creado tú misma).
        let autorizado = false;
        if (alineacion.article_id) {
          const art = await env.DB.prepare("SELECT autor_id, coautor_id FROM articles WHERE id = ?").bind(alineacion.article_id).first();
          autorizado = art ? await puedeEditar(env, payload, "articulo", alineacion.article_id, art.autor_id, art.coautor_id) : payload.rol === "admin";
        } else if (alineacion.result_id) {
          const res = await env.DB.prepare("SELECT autor_id FROM results WHERE id = ?").bind(alineacion.result_id).first();
          autorizado = res ? await puedeEditar(env, payload, "resultado", alineacion.result_id, res.autor_id) : payload.rol === "admin";
        }
        if (!autorizado) return json({ error: "No puedes editar esta alineación." }, 403);

        if (method === "DELETE") {
          await env.DB.prepare("DELETE FROM alineaciones WHERE id = ?").bind(id).run();
          return json({ ok: true });
        }

        const body = await request.json();
        if (!body.equipo || !String(body.equipo).trim()) {
          return json({ error: "Falta el nombre del equipo" }, 400);
        }
        const jugadores = normalizarJugadoresAlineacion(body.jugadores);
        await env.DB.prepare(
          `UPDATE alineaciones SET equipo=?, escudo_url=?, formacion=?, jugadores=?, updated_at=datetime('now') WHERE id=?`
        ).bind(
          String(body.equipo).trim(), body.escudo_url || null, body.formacion || "4-3-3",
          JSON.stringify(jugadores), id
        ).run();
        return json({ ok: true });
      }

      // ---------- PANEL MINUTO A MINUTO: cronómetro ----------
      // Solo el día del partido (con un margen de un par de horas antes y
      // después) puede accederse al panel. Se comprueba también en el
      // backend, no solo escondiendo el botón en el frontend, para que no
      // se pueda editar el cronómetro de un partido de otro día llamando
      // directamente a la API.
      const MARGEN_ACCESO_HORAS = 3;
      function dentroDelDiaDelPartido(fechaPartido) {
        if (!fechaPartido) return false;
        const inicio = new Date(fechaPartido.length === 10 ? `${fechaPartido}T00:00:00Z` : `${fechaPartido}:00Z`);
        if (isNaN(inicio.getTime())) return false;
        const ahora = Date.now();
        const desde = inicio.getTime() - MARGEN_ACCESO_HORAS * 3600 * 1000;
        // Día completo del partido (hasta las 23:59 de esa fecha) más el
        // margen de después, para partidos que se alargan.
        const finDelDia = new Date(inicio);
        finDelDia.setUTCHours(23, 59, 59, 999);
        const hasta = finDelDia.getTime() + MARGEN_ACCESO_HORAS * 3600 * 1000;
        return ahora >= desde && ahora <= hasta;
      }

      const cronometroMatch = path.match(/^\/api\/results\/(\d+)\/cronometro$/);
      if (cronometroMatch && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const resultadoId = parseInt(cronometroMatch[1]);
        const resultado = await env.DB.prepare("SELECT autor_id, fecha_partido FROM results WHERE id = ?").bind(resultadoId).first();
        if (!resultado) return json({ error: "Resultado no encontrado" }, 404);
        if (!(await puedeEditar(env, payload, "resultado", resultadoId, resultado.autor_id))) {
          return json({ error: "No puedes gestionar el minuto a minuto de este partido porque no es tuyo. Solicita permiso al autor o a un administrador." }, 403);
        }
        if (!dentroDelDiaDelPartido(resultado.fecha_partido)) {
          return json({ error: "Solo se puede acceder al panel de Minuto a Minuto el día del partido." }, 403);
        }
        const body = await request.json();
        // acciones: "iniciar" (arranca/reanuda el cronómetro desde 0 o
        // desde el minuto pausado — misma función que usan el cron y el
        // "En juego" manual, así los tres caminos quedan siempre
        // sincronizados), "pausar" (congela en un minuto dado, p.ej. al
        // pitar el descanso, la pausa de hidratación o el final), y
        // "ajustar_minuto" (editar a mano el minuto que marca el reloj
        // en este momento, sin tocar el instante real de inicio).
        if (body.accion === "iniciar") {
          // "minuto_inicial" permite retomar el cronómetro justo donde se
          // dejó (p. ej. al empezar la 2ª parte tras el descanso) en vez
          // de volver a contar desde 0.
          const minutoInicial = Number.isInteger(body.minuto_inicial) && body.minuto_inicial > 0 ? body.minuto_inicial : 0;
          await iniciarCronometroPartido(env, resultadoId, minutoInicial);
        } else if (body.accion === "pausar") {
          const minuto = Number.isInteger(body.minuto) ? body.minuto : 0;
          await env.DB.prepare(
            "UPDATE results SET cronometro_pausado_en = ? WHERE id = ?"
          ).bind(minuto, resultadoId).run();
        } else if (body.accion === "ajustar_minuto") {
          // El redactor corrige a mano el minuto que debería marcar el
          // reloj AHORA (p.ej. si el cronómetro se desvió). Si el
          // cronómetro está pausado (descanso/hidratación), se corrige
          // directamente cronometro_pausado_en; si está corriendo, se
          // guarda como desplazamiento sobre inicio_cronometro_at para
          // no perder la referencia real de cuándo empezó el partido.
          if (!Number.isInteger(body.minuto) || body.minuto < 0 || body.minuto > 130) {
            return json({ error: "Minuto no válido" }, 400);
          }
          const actual = await env.DB.prepare("SELECT inicio_cronometro_at, cronometro_pausado_en FROM results WHERE id = ?").bind(resultadoId).first();
          if (actual?.cronometro_pausado_en !== null && actual?.cronometro_pausado_en !== undefined) {
            await env.DB.prepare("UPDATE results SET cronometro_pausado_en = ? WHERE id = ?").bind(body.minuto, resultadoId).run();
          } else if (actual?.inicio_cronometro_at) {
            const inicioMs = new Date(actual.inicio_cronometro_at.replace(" ", "T") + "Z").getTime();
            // "referencia_at" es el instante (mandado por el panel) en
            // que el minuto introducido era realmente ese: el momento
            // en que se leyó "minutoEnVivo()" para precargar el
            // formulario, no el momento en que llega esta petición.
            // Sin esto, el servidor usaba Date.now() -ya más tarde,
            // después de que el redactor pensara/escribiera/confirmara
            // el prompt- y restaba de más esos segundos, dando lugar al
            // desfase de "-1"/"-2" minutos que se veía al corregir.
            // Se valida que sea una fecha real y no esté muy lejos del
            // "ahora" del servidor (60s de margen por si el reloj del
            // navegador está algo desviado); si no, se cae al
            // comportamiento anterior (Date.now()) por seguridad.
            let instanteReferenciaMs = Date.now();
            if (typeof body.referencia_at === "string") {
              const parsed = new Date(body.referencia_at).getTime();
              if (!isNaN(parsed) && Math.abs(parsed - Date.now()) <= 60000) {
                instanteReferenciaMs = parsed;
              }
            }
            const minutosTranscurridos = isNaN(inicioMs) ? 0 : Math.floor((instanteReferenciaMs - inicioMs) / 60000);
            const ajuste = body.minuto - minutosTranscurridos;
            await env.DB.prepare("UPDATE results SET ajuste_cronometro_minutos = ? WHERE id = ?").bind(ajuste, resultadoId).run();
          } else {
            return json({ error: "El cronómetro no se ha iniciado todavía." }, 400);
          }
        } else {
          return json({ error: "Acción no válida (usa 'iniciar', 'pausar' o 'ajustar_minuto')" }, 400);
        }
        // Nota: antes aquí se limpiaba un flag "aviso_desatendido_enviado"
        // con cada acción del cronómetro para permitir un nuevo aviso más
        // adelante. Ya no hace falta: ahora el límite es "máximo un aviso
        // por mitad" (aviso_desatendido_mitad, ver revisarPartidosDesatendidos),
        // así que no hay que resetear nada aquí -- resetear en cada acción
        // era precisamente lo que podía generar varios avisos seguidos
        // dentro de una misma mitad si el partido volvía a quedarse
        // desatendido poco después de un toque suelto.
        // Se devuelve el resultado actualizado para que el panel no tenga
        // que recalcular a mano el instante de inicio del cronómetro.
        const actualizado = await env.DB.prepare("SELECT * FROM results WHERE id = ?").bind(resultadoId).first();
        return json({ ok: true, resultado: actualizado });
      }

      // ---------- MATCH EVENTS (goles, tarjetas) ----------
      // Lista pública de eventos de un partido (se pinta en el modal de
      // detalle de resultados.html). No requiere autenticación, igual que
      // GET /api/results.
      // Tipos de evento admitidos por el panel de Minuto a Minuto. Los
      // primeros cuatro ya existían (goles y tarjetas, con equipo
      // obligatorio); el resto son nuevos y varios de ellos no llevan
      // equipo asociado (se guarda "ninguno").
      const TIPOS_EVENTO_VALIDOS = [
        "gol", "gol_var", "gol_pp", "amarilla", "doble_amarilla", "roja",
        "cambio", "penalti_fallado", "var",
        "inicio_partido", "descanso", "fin_descanso",
        "pausa_hidratacion", "fin_pausa_hidratacion",
        "partido_retrasado", "partido_anulado",
        "penalti_marcado", "penalti_fallado_tanda",
        "fin_partido", "otro",
      ];
      const TIPOS_EVENTO_SIN_EQUIPO = [
        "inicio_partido", "descanso", "fin_descanso",
        "pausa_hidratacion", "fin_pausa_hidratacion",
        "partido_retrasado", "partido_anulado",
        "fin_partido", "otro",
      ];

      // Recalcula goles_local/goles_visitante de un resultado a partir de
      // sus eventos de tipo "gol", y lo marca como "en_juego" si todavía
      // estaba "programado". Se llama después de crear/editar/borrar un
      // evento, para que el marcador del panel de Minuto a Minuto (y el
      // de toda la web) esté siempre sincronizado con los goles
      // registrados, sin que el redactor tenga que ir aparte al
      // formulario de "Editar resultado" a teclear el marcador a mano.
      //
      // Un "gol_var" (gol anulado por el VAR) solo resta uno al
      // marcador del equipo correspondiente si su columna bajar_gol
      // está marcada: eso indica que el gol ya se había pitado y
      // contado antes de que el VAR lo revisara. Si bajar_gol es 0 (el
      // redactor no lo marcó), se registra el evento en el timeline sin
      // tocar el marcador, porque ese gol nunca llegó a sumar. Esta
      // distinción evita restar de más si el redactor solo quiere dejar
      // constancia de una revisión que anula el gol antes de que
      // cambiara el marcador.
      // Un "gol_pp" (gol en propia puerta) se guarda con "equipo" = el
      // equipo del jugador que se lo mete en su propia portería, pero el
      // gol beneficia al equipo CONTRARIO: por eso, a la hora de sumar,
      // se le da la vuelta al equipo (rival() más abajo).
      function rival(equipo) {
        return equipo === "local" ? "visitante" : "local";
      }

      async function recalcularMarcadorDesdeEventos(env, resultadoId) {
        const { results: eventos } = await env.DB.prepare(
          "SELECT tipo, equipo, bajar_gol FROM match_events WHERE resultado_id = ? AND tipo IN ('gol', 'gol_var', 'gol_pp')"
        ).bind(resultadoId).all();
        const contar = (equipo) => eventos.filter((e) => e.tipo === "gol" && e.equipo === equipo).length
          + eventos.filter((e) => e.tipo === "gol_pp" && rival(e.equipo) === equipo).length
          - eventos.filter((e) => e.tipo === "gol_var" && e.equipo === equipo && e.bajar_gol).length;
        const golesLocal = Math.max(0, contar("local"));
        const golesVisitante = Math.max(0, contar("visitante"));
        await env.DB.prepare(
          `UPDATE results SET goles_local = ?, goles_visitante = ?,
             estado = CASE WHEN estado = 'programado' THEN 'en_juego' ELSE estado END
           WHERE id = ?`
        ).bind(golesLocal, golesVisitante, resultadoId).run();
      }

      // Recalcula penaltis_local/penaltis_visitante a partir de los
      // eventos "penalti_marcado" (solo cuentan los marcados; los
      // fallados/parados quedan en el timeline pero no suman). Si no hay
      // ningún evento de tanda todavía, deja ambas columnas en NULL (no
      // hubo tanda de penaltis en este partido), en vez de 0-0.
      async function recalcularPenaltisDesdeEventos(env, resultadoId) {
        const { results: eventos } = await env.DB.prepare(
          "SELECT tipo, equipo FROM match_events WHERE resultado_id = ? AND tipo IN ('penalti_marcado', 'penalti_fallado_tanda')"
        ).bind(resultadoId).all();
        if (!eventos.length) {
          await env.DB.prepare("UPDATE results SET penaltis_local = NULL, penaltis_visitante = NULL WHERE id = ?").bind(resultadoId).run();
          return;
        }
        const contar = (equipo) => eventos.filter((e) => e.tipo === "penalti_marcado" && e.equipo === equipo).length;
        await env.DB.prepare("UPDATE results SET penaltis_local = ?, penaltis_visitante = ? WHERE id = ?")
          .bind(contar("local"), contar("visitante"), resultadoId).run();
      }

      const eventosMatch = path.match(/^\/api\/results\/(\d+)\/eventos$/);
      if (eventosMatch && method === "GET") {
        const resultadoId = parseInt(eventosMatch[1]);
        const { results: eventos } = await env.DB.prepare(
          `SELECT id, tipo, equipo, jugador, jugador_sale, jugador_asistencia, minuto, minuto_extra, orden, bajar_gol
           FROM match_events WHERE resultado_id = ?
           ORDER BY minuto ASC, minuto_extra ASC, orden ASC, id ASC`
        ).bind(resultadoId).all();
        return json({ eventos });
      }

      // Crear un evento. Requiere el mismo permiso de edición que el
      // resultado al que pertenece (autoría, admin, o permiso temporal
      // aprobado por solicitud de edición).
      if (eventosMatch && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const resultadoId = parseInt(eventosMatch[1]);
        const resultado = await env.DB.prepare("SELECT autor_id FROM results WHERE id = ?").bind(resultadoId).first();
        if (!resultado) return json({ error: "Resultado no encontrado" }, 404);
        if (!(await puedeEditar(env, payload, "resultado", resultadoId, resultado.autor_id))) {
          return json({ error: "No puedes editar los eventos de este partido porque no es tuyo. Solicita permiso al autor o a un administrador." }, 403);
        }
        const body = await request.json();
        if (!TIPOS_EVENTO_VALIDOS.includes(body.tipo)) {
          return json({ error: "Tipo de evento no válido" }, 400);
        }
        const equipoRequerido = !TIPOS_EVENTO_SIN_EQUIPO.includes(body.tipo);
        if (equipoRequerido && !["local", "visitante"].includes(body.equipo)) {
          return json({ error: "Equipo no válido (debe ser 'local' o 'visitante')" }, 400);
        }
        if (body.minuto === undefined || body.minuto === null || body.minuto === "") {
          return json({ error: "Falta el minuto" }, 400);
        }
        // "inicio_partido" es un hito único: solo puede haber uno por
        // partido. Sin esta comprobación, si el cron ya había arrancado
        // el partido solo (y ya insertado su "Comienza el partido") y el
        // redactor entraba al panel de Minuto a Minuto y pulsaba
        // "Iniciar partido" igualmente (p.ej. porque cargó el panel un
        // instante antes de que el cron actuase, viendo todavía el botón
        // de inicio), se insertaba un segundo evento idéntico y aparecía
        // duplicado en el timeline. Se devuelve el evento ya existente
        // en vez de crear otro, para no romper el flujo del botón.
        if (body.tipo === "inicio_partido") {
          const existente = await env.DB.prepare(
            "SELECT id FROM match_events WHERE resultado_id = ? AND tipo = 'inicio_partido' LIMIT 1"
          ).bind(resultadoId).first();
          if (existente) return json({ ok: true, id: existente.id, ya_existia: true });
        }
        const { meta } = await env.DB.prepare(
          `INSERT INTO match_events (resultado_id, tipo, equipo, jugador, jugador_sale, jugador_asistencia, minuto, minuto_extra, orden, bajar_gol)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          resultadoId, body.tipo, equipoRequerido ? body.equipo : "ninguno",
          body.jugador || null, body.jugador_sale || null,
          body.tipo === "gol" ? (body.jugador_asistencia || null) : null,
          parseInt(body.minuto, 10), body.minuto_extra ? parseInt(body.minuto_extra, 10) : null,
          body.orden ? parseInt(body.orden, 10) : 0,
          body.tipo === "gol_var" && body.bajar_gol ? 1 : 0
        ).run();
        // Nota: antes aquí se limpiaba un flag "aviso_desatendido_enviado"
        // con cada evento nuevo para permitir otro aviso más adelante.
        // Ya no hace falta: el límite ahora es "máximo un aviso por
        // mitad" (aviso_desatendido_mitad, ver revisarPartidosDesatendidos)
        // y se mantiene tal cual aunque lleguen eventos sueltos dentro de
        // la misma mitad, que es justo lo que evita "la petada" de varios
        // correos seguidos por un solo despiste.
        // Un gol anulado por VAR ("gol_var") no suma como gol normal,
        // pero si el redactor ha marcado "bajar_gol" (porque el gol ya
        // se había pitado y contado antes de la revisión) resta uno del
        // marcador (ver recalcularMarcadorDesdeEventos), así que también
        // hay que recalcular en este caso. Igual que un gol normal, de
        // paso confirma que el partido ya está en juego si seguía
        // "programado".
        if (body.tipo === "gol" || body.tipo === "gol_var" || body.tipo === "gol_pp") await recalcularMarcadorDesdeEventos(env, resultadoId);
        if (body.tipo === "penalti_marcado" || body.tipo === "penalti_fallado_tanda") await recalcularPenaltisDesdeEventos(env, resultadoId);
        if (body.tipo === "fin_partido") {
          // Se limpia también aquí aviso_desatendido_mitad: si este mismo
          // partido se reabre más adelante por otra vía que no pase por
          // iniciarCronometroPartido(), no debe arrastrar avisos de una
          // "vida" anterior del partido. finalizado_no_cubierto se pone
          // explícitamente a 0: cierre MANUAL (ver mismo comentario en
          // worker/src/index.js).
          await env.DB.prepare("UPDATE results SET estado = 'finalizado', aviso_desatendido_mitad = NULL, finalizado_no_cubierto = 0 WHERE id = ?").bind(resultadoId).run();
        }
        if (body.tipo === "partido_retrasado") {
          await env.DB.prepare("UPDATE results SET estado = 'retrasado' WHERE id = ?").bind(resultadoId).run();
        }
        if (body.tipo === "partido_anulado") {
          await env.DB.prepare("UPDATE results SET estado = 'anulado', cronometro_pausado_en = COALESCE(cronometro_pausado_en, ?) WHERE id = ?")
            .bind(parseInt(body.minuto, 10) || 0, resultadoId).run();
        }
        // Cualquier evento nuevo cuenta como "ya se está cubriendo" (ver
        // mismo razonamiento en worker/src/index.js).
        await env.DB.prepare("UPDATE results SET finalizado_no_cubierto = 0 WHERE id = ?").bind(resultadoId).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_evento_partido", entidad: "resultado", entidad_id: resultadoId,
          descripcion: `Ha añadido un evento (${body.tipo}) al partido con id ${resultadoId}`,
        }));
        return json({ ok: true, id: meta.last_row_id });
      }

      const eventoMatch = path.match(/^\/api\/results\/(\d+)\/eventos\/(\d+)$/);
      if (eventoMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const resultadoId = parseInt(eventoMatch[1]);
        const eventoId = parseInt(eventoMatch[2]);
        const resultado = await env.DB.prepare("SELECT autor_id FROM results WHERE id = ?").bind(resultadoId).first();
        if (!resultado) return json({ error: "Resultado no encontrado" }, 404);
        if (!(await puedeEditar(env, payload, "resultado", resultadoId, resultado.autor_id))) {
          return json({ error: "No puedes editar los eventos de este partido porque no es tuyo. Solicita permiso al autor o a un administrador." }, 403);
        }
        const body = await request.json();
        if (!TIPOS_EVENTO_VALIDOS.includes(body.tipo)) {
          return json({ error: "Tipo de evento no válido" }, 400);
        }
        const equipoRequerido = !TIPOS_EVENTO_SIN_EQUIPO.includes(body.tipo);
        if (equipoRequerido && !["local", "visitante"].includes(body.equipo)) {
          return json({ error: "Equipo no válido (debe ser 'local' o 'visitante')" }, 400);
        }
        await env.DB.prepare(
          `UPDATE match_events SET tipo=?, equipo=?, jugador=?, jugador_sale=?, jugador_asistencia=?, minuto=?, minuto_extra=?, orden=?, bajar_gol=?
           WHERE id=? AND resultado_id=?`
        ).bind(
          body.tipo, equipoRequerido ? body.equipo : "ninguno", body.jugador || null, body.jugador_sale || null,
          body.tipo === "gol" ? (body.jugador_asistencia || null) : null,
          parseInt(body.minuto, 10), body.minuto_extra ? parseInt(body.minuto_extra, 10) : null,
          body.orden ? parseInt(body.orden, 10) : 0,
          body.tipo === "gol_var" && body.bajar_gol ? 1 : 0,
          eventoId, resultadoId
        ).run();
        await recalcularMarcadorDesdeEventos(env, resultadoId);
        await recalcularPenaltisDesdeEventos(env, resultadoId);
        // Editar un evento existente también cuenta como "ya se está
        // cubriendo".
        await env.DB.prepare("UPDATE results SET finalizado_no_cubierto = 0 WHERE id = ?").bind(resultadoId).run();
        return json({ ok: true });
      }

      if (eventoMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const resultadoId = parseInt(eventoMatch[1]);
        const eventoId = parseInt(eventoMatch[2]);
        const resultado = await env.DB.prepare("SELECT autor_id FROM results WHERE id = ?").bind(resultadoId).first();
        if (!resultado) return json({ error: "Resultado no encontrado" }, 404);
        if (!(await puedeEditar(env, payload, "resultado", resultadoId, resultado.autor_id))) {
          return json({ error: "No puedes editar los eventos de este partido porque no es tuyo. Solicita permiso al autor o a un administrador." }, 403);
        }
        await env.DB.prepare("DELETE FROM match_events WHERE id=? AND resultado_id=?").bind(eventoId, resultadoId).run();
        await recalcularMarcadorDesdeEventos(env, resultadoId);
        await recalcularPenaltisDesdeEventos(env, resultadoId);
        // Borrar un evento también cuenta como "ya se está cubriendo".
        await env.DB.prepare("UPDATE results SET finalizado_no_cubierto = 0 WHERE id = ?").bind(resultadoId).run();
        return json({ ok: true });
      }

      // Calendario de jornadas (sobre-escritura manual del intRound que
      // da TheSportsDB). Mismos endpoints que en worker/src/index.js
      // (worker principal) — ver ese archivo para el detalle del porqué;
      // aquí se replican para que el panel admin funcione igual si el
      // failover atiende la petición.
      if (path === "/api/jornadas-calendario" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede ver el calendario de jornadas" }, 403);
        const { results } = await env.DB.prepare(
          "SELECT id, competicion, grupo, jornada, fecha_inicio, fecha_fin FROM jornadas_calendario ORDER BY competicion, grupo IS NOT NULL, grupo, fecha_inicio"
        ).all();
        return json({ jornadas: results });
      }

      if (path === "/api/jornadas-calendario" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede editar el calendario de jornadas" }, 403);
        const body = await request.json();
        const competicionesValidas = ["hypermotion", "primera_federacion", "segunda_federacion"];
        if (!competicionesValidas.includes(body.competicion)) return json({ error: "Competición no válida" }, 400);
        const grupo = body.grupo || null;
        const jornada = parseInt(body.jornada, 10);
        if (!Number.isInteger(jornada) || jornada < 1) return json({ error: "Jornada no válida" }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.fecha_inicio || "") || !/^\d{4}-\d{2}-\d{2}$/.test(body.fecha_fin || "")) {
          return json({ error: "Fechas no válidas (formato YYYY-MM-DD)" }, 400);
        }
        if (body.fecha_fin < body.fecha_inicio) return json({ error: "La fecha fin no puede ser anterior a la fecha inicio" }, 400);
        const { meta } = await env.DB.prepare(
          `INSERT INTO jornadas_calendario (competicion, grupo, jornada, fecha_inicio, fecha_fin)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(body.competicion, grupo, jornada, body.fecha_inicio, body.fecha_fin).run();
        return json({ ok: true, id: meta.last_row_id });
      }

      const jornadaCalendarioMatch = path.match(/^\/api\/jornadas-calendario\/(\d+)$/);
      if (jornadaCalendarioMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede editar el calendario de jornadas" }, 403);
        const id = parseInt(jornadaCalendarioMatch[1], 10);
        const body = await request.json();
        const competicionesValidas = ["hypermotion", "primera_federacion", "segunda_federacion"];
        if (!competicionesValidas.includes(body.competicion)) return json({ error: "Competición no válida" }, 400);
        const grupo = body.grupo || null;
        const jornada = parseInt(body.jornada, 10);
        if (!Number.isInteger(jornada) || jornada < 1) return json({ error: "Jornada no válida" }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.fecha_inicio || "") || !/^\d{4}-\d{2}-\d{2}$/.test(body.fecha_fin || "")) {
          return json({ error: "Fechas no válidas (formato YYYY-MM-DD)" }, 400);
        }
        if (body.fecha_fin < body.fecha_inicio) return json({ error: "La fecha fin no puede ser anterior a la fecha inicio" }, 400);
        await env.DB.prepare(
          `UPDATE jornadas_calendario SET competicion=?, grupo=?, jornada=?, fecha_inicio=?, fecha_fin=? WHERE id=?`
        ).bind(body.competicion, grupo, jornada, body.fecha_inicio, body.fecha_fin, id).run();
        return json({ ok: true });
      }

      if (jornadaCalendarioMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede editar el calendario de jornadas" }, 403);
        const id = parseInt(jornadaCalendarioMatch[1], 10);
        await env.DB.prepare("DELETE FROM jornadas_calendario WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (path === "/api/jornadas-calendario/recalcular" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede recalcular jornadas" }, 403);

        const { results: partidos } = await env.DB.prepare(
          `SELECT id, competicion, grupo, fecha_partido, jornada FROM results WHERE fuente = 'auto_api_football'`
        ).all();

        let actualizados = 0;
        for (const partido of partidos) {
          const fecha = (partido.fecha_partido || "").slice(0, 10);
          if (!fecha) continue;
          const fila = await env.DB.prepare(
            `SELECT jornada FROM jornadas_calendario
             WHERE competicion = ? AND (grupo IS ? OR grupo = ?)
               AND fecha_inicio <= ? AND fecha_fin >= ?
             ORDER BY fecha_inicio DESC LIMIT 1`
          ).bind(partido.competicion, partido.grupo, partido.grupo, fecha, fecha).first();
          const jornadaCorrecta = fila ? fila.jornada : null;
          if (jornadaCorrecta !== null && jornadaCorrecta !== partido.jornada) {
            await env.DB.prepare("UPDATE results SET jornada = ? WHERE id = ?")
              .bind(jornadaCorrecta, partido.id).run();
            actualizados++;
          }
        }
        return json({ ok: true, revisados: partidos.length, actualizados });
      }

      return json({ error: "Ruta no encontrada" }, 404);
    } catch (err) {
      return json({ error: "Error del servidor", detail: err.message }, 500);
    }
}