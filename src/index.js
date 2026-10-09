// ElOtroFútbol - Worker API
// Rutas: /api/login, /api/me, /api/me/sesiones, /api/articles, /api/results, /api/porras, /api/porras/resumen, /api/porras/ranking, /api/media, /api/custom-clubs, /api/articles/:id/comments, /api/comments/:id/vote, /api/comments/:id/report, /api/admin/comments, /api/admin/comments/reported, /api/club-info, /api/admin/club-info, /api/track/view, /api/track/reading, /api/track/result-view, /api/admin/analiticas/* (resumen, mas-leidas, fuentes, autores, tiempo-lectura, idiomas, partidos-seguidos, gsc), /sitemap-noticias.xml, /sitemap-news.xml, /rss.xml

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

// Valida y normaliza el rango "fecha_preferencia_desde"/"...hasta" que
// puede mandar un redactor, opcionalmente, al marcar su borrador como
// "terminado" (ver estado_borrador): una sugerencia de en qué días (y,
// opcionalmente, a qué hora) le gustaría que se publicase la noticia,
// puramente informativa para quien la revise. Solo se guardan si "body"
// no es null (el llamador ya ha comprobado que el borrador se está
// marcando como "terminado": si no, se descartan sin más, ver más abajo
// dónde se llama a esta función).
// Formato: "YYYY-MM-DD" (fecha simple, sin hora, "todo el día" -
// compatible con lo guardado antes de añadir la hora) o
// "YYYY-MM-DDTHH:MM" (con hora opcional, la que manda un
// <input type="datetime-local"> del panel). Se valida con una expresión
// regular estricta en vez de fiarse de "new Date(...)", que aceptaría
// cosas ambiguas.
// Reglas:
//  - Las dos son opcionales; se puede mandar solo "desde" (sin límite
//    superior), o ninguna de las dos.
//  - Si se manda "hasta" sin "desde", se descarta "hasta" (no tiene
//    sentido un rango solo con límite superior).
//  - Si "hasta" es anterior (o igual) a "desde", se descarta "hasta"
//    (rango invertido: se conserva "desde" igualmente, no se rechaza
//    todo el guardado del artículo por esto). La comparación es de
//    texto (mismo formato, mismo orden cronológico), salvo que solo una
//    de las dos lleve hora: entonces se compara solo la parte de fecha,
//    para no descartar por ejemplo "hasta" = mismo día con hora si
//    "desde" es ese mismo día sin hora.
function normalizarPreferenciaFechas(body) {
  const esValida = (v) => typeof v === "string"
    && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v)
    && !Number.isNaN(new Date(`${v.includes("T") ? v : v + "T00:00"}:00Z`).getTime());
  if (!body) return { desde: null, hasta: null };
  const desde = esValida(body.fecha_preferencia_desde) ? body.fecha_preferencia_desde : null;
  let hasta = esValida(body.fecha_preferencia_hasta) ? body.fecha_preferencia_hasta : null;
  if (!desde) hasta = null;
  else if (hasta) {
    const soloFecha = (v) => v.slice(0, 10);
    const comparable = (v) => (v.includes("T") && desde.includes("T")) ? v : soloFecha(v);
    if (comparable(hasta) <= comparable(desde)) hasta = null;
  }
  return { desde, hasta };
}

// Formatea el rango { desde, hasta } de normalizarPreferenciaFechas como
// texto legible en español (DD/MM/AAAA o DD/MM/AAAA a las HH:MM) para
// el email que avisa a la redacción de que un borrador está
// "terminado". Devuelve null si no hay preferencia (no se añade nada al
// email en ese caso).
function formatearPreferenciaFechasEmail({ desde, hasta } = {}) {
  if (!desde) return null;
  const legible = (v) => {
    const [fecha, hora] = v.split("T");
    const [a, m, d] = fecha.split("-");
    return hora ? `${d}/${m}/${a} a las ${hora}` : `${d}/${m}/${a}`;
  };
  return hasta ? `entre el ${legible(desde)} y el ${legible(hasta)}` : `a partir del ${legible(desde)}`;
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
// producción (con y sin "www", por si algún día se activa un redirect
// en vez de forzarlo a nivel DNS/Cloudflare) y localhost en varios
// puertos habituales, para poder probar el frontend en local contra la
// API real sin tener que relajar esto a "*". Antes se devolvía "*" para
// cualquier origen, lo que permite que CUALQUIER web ajena llame a esta
// API directamente desde el navegador de un visitante (con su sesión,
// si la tuviera) y lea la respuesta; con la whitelist, un origen que no
// esté aquí simplemente no recibe cabecera Access-Control-Allow-Origin
// y el navegador bloquea la lectura de la respuesta en ese origen.
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

function cors(resp, origin) {
  // Solo se refleja el origen si está en la whitelist; si no lo está (o
  // no hay cabecera Origin, como en peticiones sin CORS: curl, server a
  // server...), no se manda Access-Control-Allow-Origin y el navegador
  // bloqueará la lectura de la respuesta desde ese origen ajeno.
  if (origenPermitido(origin)) {
    resp.headers.set("Access-Control-Allow-Origin", origin);
    // Necesario en cuanto Access-Control-Allow-Origin deja de ser fijo
    // ("*") y pasa a depender del Origin de cada petición: le dice a
    // cualquier caché (Cloudflare, el propio navegador, un proxy
    // intermedio) que no sirva a un origen la respuesta CORS calculada
    // para otro, o dos pestañas en distintos orígenes podrían acabar
    // compartiendo por caché una respuesta con el Allow-Origin de la
    // otra.
    resp.headers.set("Vary", "Origin");
  }
  resp.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
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
// Origen (cabecera Origin) de la petición que se está gestionando ahora
// mismo, fijado al principio de fetch() para que json() y el resto de
// sitios que llaman a cors() sin pasar el request explícitamente (hay
// más de 40 en este archivo) puedan seguir haciéndolo sin cambiar su
// firma. Cloudflare Workers no comparten esta variable de módulo entre
// peticiones concurrentes: cada invocación de fetch() corre en su propio
// contexto aislado, así que no hay riesgo de que una petición vea el
// origen de otra.
let ORIGEN_PETICION_ACTUAL = null;

// ---------- Caché corta en memoria del isolate ----------
// Cada isolate de Workers atiende muchas peticiones seguidas, así que una
// caché de unos segundos colapsa las ráfagas (p. ej. decenas de lectores
// refrescando el mismo partido cada 15 s) en una sola consulta a la base de
// datos. Es por isolate: no se comparte entre instancias, así que la
// frescura máxima es el TTL (pocos segundos). Guarda la promesa para que las
// peticiones simultáneas también compartan una única consulta.
const CACHE_CORTA = new Map();
const CACHE_CORTA_MAX = 300;
async function memoCorta(clave, ttlMs, cargar) {
  const ahora = Date.now();
  const e = CACHE_CORTA.get(clave);
  if (e && e.exp > ahora) return e.valor;
  if (CACHE_CORTA.size >= CACHE_CORTA_MAX) {
    for (const [k, v] of CACHE_CORTA) { if (v.exp <= ahora) CACHE_CORTA.delete(k); }
    if (CACHE_CORTA.size >= CACHE_CORTA_MAX) CACHE_CORTA.clear();
  }
  const valor = Promise.resolve().then(cargar);
  CACHE_CORTA.set(clave, { exp: ahora + ttlMs, valor });
  try { return await valor; } catch (err) { CACHE_CORTA.delete(clave); throw err; }
}
function invalidarCacheCorta(prefijo) {
  for (const k of [...CACHE_CORTA.keys()]) { if (k.startsWith(prefijo)) CACHE_CORTA.delete(k); }
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
  }), ORIGEN_PETICION_ACTUAL);
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

// Codifica un ArrayBuffer (p. ej. el resultado de crypto.subtle.digest)
// en base64url (RFC 4648 §5: como base64 normal pero con "-"/"_" en vez
// de "+"/"/", y sin "=" de relleno al final). Usado para el
// "code_challenge" de PKCE en el login con X (ver
// /api/readers/x/iniciar): no había ningún helper de codificación en
// este archivo, solo de decodificación (b64urlDecode/b64urlDecodeTexto
// más abajo, que hacen justo lo contrario).
function base64urlDeHash(buffer) {
  const bytes = new Uint8Array(buffer);
  let binario = "";
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
    const contenido = sanearHtmlArticulo(normalizarTexto(t.contenido));

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
  return {
    ...article,
    idiomas_disponibles,
    imagen_foco: focoDePortada(article),
    // Se expone ya como array (en vez del JSON en texto guardado en la
    // columna) para que el panel y la web no tengan que parsearlo cada
    // vez; ver parsearCategoriasAdicionales.
    categorias_adicionales: parsearCategoriasAdicionales(article.categorias_adicionales),
  };
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

  return normalizarFoco(portada && portada.foco);
}

// ---------- FOCO DE IMAGEN: validador ÚNICO del backend ----------
// Espejo de public/js/foco.js (EOF_FOCO.normalizar / texto). TODO foco que
// entra o sale por la API pasa por aquí, para que lo guardado en la BD sea
// siempre "X% Y%" con X e Y entre 0 y 100 (un decimal como máximo). Antes
// había 4 regex distintas repartidas por el archivo que aceptaban cosas
// como "999% 999%" sin límite.
// Acepta "62% 30%", "62 30", "62.5% 30%", "center top", {x, y} y [x, y].
// Cualquier otra cosa (vacío, texto raro, intento de inyección) cae al
// centro o, en normalizarFocoOpcional, a null ("sin foco elegido").
const FOCO_CENTRO = "50% 50%";
const FOCO_PALABRAS_X = { left: 0, center: 50, right: 100 };
const FOCO_PALABRAS_Y = { top: 0, center: 50, bottom: 100 };

function focoANumero(token, palabras) {
  if (token === null || token === undefined) return null;
  const t = String(token).trim().toLowerCase();
  if (!t) return null;
  if (Object.prototype.hasOwnProperty.call(palabras, t)) return palabras[t];
  const m = t.match(/^(-?\d{1,3}(?:\.\d+)?)%?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

function focoComoPar(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  let x = null;
  let y = null;
  if (typeof valor === "object") {
    if (Array.isArray(valor)) {
      x = focoANumero(valor[0], FOCO_PALABRAS_X);
      y = focoANumero(valor[1], FOCO_PALABRAS_Y);
    } else {
      x = focoANumero(valor.x, FOCO_PALABRAS_X);
      y = focoANumero(valor.y, FOCO_PALABRAS_Y);
    }
  } else if (typeof valor === "string" || typeof valor === "number") {
    const texto = String(valor).trim();
    if (texto.length > 40) return null;
    const partes = texto.split(/\s+/);
    if (partes.length === 1) {
      const unico = partes[0].toLowerCase();
      if (unico === "top" || unico === "bottom") {
        x = 50;
        y = FOCO_PALABRAS_Y[unico];
      } else {
        x = focoANumero(unico, FOCO_PALABRAS_X);
        y = 50;
      }
    } else if (partes.length === 2) {
      const a = partes[0].toLowerCase();
      const b = partes[1].toLowerCase();
      if ((a === "top" || a === "bottom") && (b === "left" || b === "right" || b === "center")) {
        x = focoANumero(b, FOCO_PALABRAS_X);
        y = focoANumero(a, FOCO_PALABRAS_Y);
      } else {
        x = focoANumero(a, FOCO_PALABRAS_X);
        y = focoANumero(b, FOCO_PALABRAS_Y);
      }
    }
  }
  if (x === null || y === null) return null;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

// Siempre devuelve un foco válido en formato "X% Y%" (centro si no lo es).
function normalizarFoco(valor) {
  const par = focoComoPar(valor);
  return par ? `${par[0]}% ${par[1]}%` : FOCO_CENTRO;
}

// Igual, pero devuelve null cuando no hay un foco válido: para columnas
// donde NULL significa "sin foco elegido" (media.portada_foco).
function normalizarFocoOpcional(valor) {
  const par = focoComoPar(valor);
  return par ? `${par[0]}% ${par[1]}%` : null;
}

// true si el error es por una columna que aún no existe en esta BD (migración
// manual sin ejecutar). Cubre SQLite/D1 ("no such column", "has no column
// named") y PostgreSQL (código 42703 / "column ... does not exist").
function esErrorColumnaFaltante(err, columna) {
  const msg = (err && err.message) || "";
  const esColumna = (err && err.code === "42703") || /no such column|no column named|column .* does not exist/i.test(msg);
  return esColumna && (!columna || msg.toLowerCase().includes(String(columna).toLowerCase()));
}

// Prueba las consultas de "variantes" en orden (de la más completa a la más
// básica) y devuelve el resultado de la primera que no falle por una columna
// sin migrar. Cualquier otro error se relanza tal cual.
async function consultaConAlternativas(env, variantes, binds) {
  let ultimoError = null;
  for (const sql of variantes) {
    try {
      const st = env.DB.prepare(sql);
      return await (binds && binds.length ? st.bind(...binds) : st).all();
    } catch (err) {
      if (!esErrorColumnaFaltante(err)) throw err;
      ultimoError = err;
    }
  }
  throw ultimoError;
}

// ---------- Notificaciones por correo ----------
// Avisa a la redacción por email cada vez que se sube contenido (fotos/vídeos)
// o se publica una crónica. Usa Resend (mismo servicio que TGN Fan Shop).
// Requiere el secreto RESEND_API_KEY (wrangler secret put RESEND_API_KEY).
// Si no está configurado, o falla el envío, no rompe la subida: solo se
// registra el error en los logs del Worker.
const EMAIL_NOTIFICACIONES = "elotrofutbolmedio@gmail.com";
const SITIO_URL = "https://elotrofutbol.media";

// SEGURIDAD: el parámetro "volver" de los logins por redirect (Discord / X)
// lo controla quien construye el enlace. Se aceptan solo rutas relativas del
// propio sitio (sin esquema, sin "//", sin "..", sin caracteres de control) y
// se rechaza cualquier intento de colar "sesionDiscord"/"sesionX" propios en
// el destino, que permitiría fijar en la víctima una sesión ajena (el
// frontend lee el primer valor que encuentre en la URL).
function volverServidorSeguro(valor) {
  const v = String(valor ?? "");
  if (!v || v.length > 300) return "";
  if (!/^\/?[A-Za-z0-9_\-.\/]*(\?[A-Za-z0-9_\-.=&%,+:~]*)?$/.test(v)) return "";
  const [ruta, query = ""] = v.split("?");
  if (ruta.replace(/^\//, "").includes("//") || ruta.split("/").includes("..")) return "";
  let queryDecodificada;
  try { queryDecodificada = decodeURIComponent(query); } catch { return ""; }
  if (/sesion/i.test(query) || /sesion/i.test(queryDecodificada)) return "";
  return v.replace(/^\/+/, "");
}

// SEGURIDAD (XSS almacenado): avatar_url y las URLs de redes sociales de los
// perfiles se guardaban tal cual y luego se pintaban en HTML/CSS sin escapar
// (p. ej. <a href="${url}"> o url('${avatar}')). Una comilla, un "javascript:"
// o un paréntesis permitían inyectar atributos/scripts en la página pública.
// Solo se aceptan URLs https absolutas, sin credenciales y sin caracteres que
// rompan atributos HTML, cadenas CSS o url(). Devuelve la URL normalizada o
// null si no es válida.
function urlHttpsSegura(valor) {
  const v = String(valor ?? "").trim();
  if (!v || v.length > 500) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
  if (/["'()<>\\\s`]/.test(u.href)) return null;
  return u.href;
}
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

// ---------- Widgets embebibles para lectores ----------
// Nombres legibles de competición para los widgets (no existe ya un mapeo
// de esto en el backend; categoriaLabel() en public/js/config.js es para
// categorías editoriales de artículos, no para competiciones).
const NOMBRE_COMPETICION_WIDGET = {
  hypermotion: "LaLiga Hypermotion",
  primera_federacion: "Primera Federación",
  segunda_federacion: "Segunda Federación",
};

function nombreCompeticionWidget(comp) {
  return NOMBRE_COMPETICION_WIDGET[comp] || comp;
}

// Cabecera/pie común a los 4 widgets: fuente del sistema (nada de Google
// Fonts u otro recurso externo, para que el widget cargue rápido y sin
// depender de terceros dentro del iframe de un sitio ajeno), tema
// claro/oscuro vía ?tema=oscuro, y un script mínimo que informa al
// documento padre de la altura real del contenido (postMessage) para que
// la web que lo embebe pueda ajustar el alto del <iframe> sin scroll
// interno ni recortes. escucha "resize" del propio iframe (p.ej. si una
// imagen tarda en cargar y cambia el alto) además del alto inicial.
function widgetBaseHtml({ tema, tituloPagina, cuerpo, origen }) {
  const oscuro = tema === "oscuro";
  const bg = oscuro ? "#0c1420" : "#ffffff";
  const fg = oscuro ? "#e8ebf0" : "#0c1b2e";
  const fgSuave = oscuro ? "#9aa4b2" : "#5a6472";
  const borde = oscuro ? "#22303f" : "#e6e9ee";
  const acento = "#d1132e";
  const filaAlterna = oscuro ? "#101a28" : "#f7f8fa";
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtmlEmail(tituloPagina)}</title>
<style>
  :root { color-scheme: ${oscuro ? "dark" : "light"}; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 10px 12px 12px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: ${bg}; color: ${fg};
  }
  a { color: inherit; }
  .eof-w-cab {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid ${borde};
  }
  .eof-w-marca {
    display: flex; align-items: center; gap: 6px;
    font-size: 11.5px; font-weight: 800; letter-spacing: .3px;
    text-decoration: none; color: ${fg};
  }
  .eof-w-marca span.eof-w-punto { color: ${acento}; }
  .eof-w-titulo { font-size: 13px; font-weight: 700; color: ${fgSuave}; }
  .eof-w-tabla { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .eof-w-tabla th {
    text-align: left; font-size: 10.5px; text-transform: uppercase;
    letter-spacing: .04em; color: ${fgSuave}; font-weight: 700;
    padding: 4px 6px; border-bottom: 1px solid ${borde};
  }
  .eof-w-tabla td { padding: 5px 6px; border-bottom: 1px solid ${borde}; vertical-align: middle; }
  .eof-w-tabla tr:nth-child(even) td { background: ${filaAlterna}; }
  .eof-w-equipo { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  .eof-w-escudo { width: 16px; height: 16px; object-fit: contain; flex-shrink: 0; }
  .eof-w-pts { font-weight: 800; text-align: center; }
  .eof-w-num { text-align: center; color: ${fgSuave}; }
  .eof-w-partido {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 7px 4px; border-bottom: 1px solid ${borde}; font-size: 12.5px;
  }
  .eof-w-partido:last-child { border-bottom: none; }
  .eof-w-eq { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
  .eof-w-eq.eof-w-eq-der { justify-content: flex-end; text-align: right; }
  .eof-w-eq span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .eof-w-marcador {
    font-weight: 800; font-size: 13px; padding: 2px 8px; border-radius: 6px;
    background: ${oscuro ? "#1a2534" : "#f0f2f5"}; white-space: nowrap; min-width: 46px; text-align: center;
  }
  .eof-w-marcador.eof-w-vivo { background: ${acento}; color: #fff; }
  .eof-w-hora { font-size: 11px; color: ${fgSuave}; white-space: nowrap; min-width: 46px; text-align: center; }
  .eof-w-vacio { padding: 18px 4px; text-align: center; color: ${fgSuave}; font-size: 12.5px; }
  .eof-w-noticia-img { width: 100%; height: auto; display: block; border-radius: 8px; margin-bottom: 8px; }
  .eof-w-noticia-titulo { font-size: 15px; font-weight: 800; line-height: 1.3; margin: 0 0 4px; }
  .eof-w-noticia-titulo a { text-decoration: none; }
  .eof-w-noticia-titulo a:hover { text-decoration: underline; }
  .eof-w-noticia-resumen { font-size: 12.5px; color: ${fgSuave}; line-height: 1.4; margin: 0; }
  .eof-w-pie { margin-top: 8px; text-align: right; }
  .eof-w-pie a { font-size: 10.5px; color: ${fgSuave}; text-decoration: none; }
  .eof-w-pie a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="eof-w-cab">
    <a class="eof-w-marca" href="${origen}/" target="_blank" rel="noopener">EL OTRO<span class="eof-w-punto">FÚTBOL</span></a>
    <span class="eof-w-titulo">${escapeHtmlEmail(tituloPagina)}</span>
  </div>
  ${cuerpo}
  <div class="eof-w-pie"><a href="${origen}/" target="_blank" rel="noopener">elotrofutbol.media →</a></div>
<script>
  // Comunica al documento padre la altura real del widget para que pueda
  // ajustar el alto del iframe (sin esto, un iframe con altura fija deja
  // scroll interno o espacio vacío según cuánto contenido haya). No asume
  // ninguna librería de terceros: un mensaje postMessage simple que la
  // web anfitriona puede escuchar si quiere auto-ajustar, o ignorar si
  // prefiere fijar su propia altura.
  function eofWidgetNotificarAltura() {
    var altura = document.body.scrollHeight;
    try { window.parent.postMessage({ eofWidget: true, altura: altura }, "*"); } catch (e) {}
  }
  window.addEventListener("load", eofWidgetNotificarAltura);
  window.addEventListener("resize", eofWidgetNotificarAltura);
  if (window.ResizeObserver) {
    new ResizeObserver(eofWidgetNotificarAltura).observe(document.body);
  } else {
    setTimeout(eofWidgetNotificarAltura, 400);
  }
</script>
</body>
</html>`;
}

function widgetHtmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      // Cacheado corto en el borde de Cloudflare: son páginas públicas sin
      // datos personalizados, así que un CDN cache de 60s reduce mucho la
      // carga a D1 si un widget se embebe en una web con tráfico alto, sin
      // que el marcador en vivo se quede notablemente desactualizado.
      "Cache-Control": "public, max-age=60",
      // Deliberadamente SIN X-Frame-Options / Content-Security-Policy
      // frame-ancestors restrictiva: el objetivo explícito de esta ruta es
      // que otras webs la carguen dentro de un <iframe>.
    },
  });
}

async function widgetsRouter(path, url, env) {
  const tema = url.searchParams.get("tema") === "oscuro" ? "oscuro" : "claro";
  const origen = "https://elotrofutbol.media";

  if (path === "/widgets/clasificacion") {
    const competicion = url.searchParams.get("competicion") || "hypermotion";
    if (!NOMBRE_COMPETICION_WIDGET[competicion]) {
      return widgetHtmlResponse(widgetBaseHtml({
        tema, origen, tituloPagina: "Clasificación",
        cuerpo: `<div class="eof-w-vacio">Competición no válida.</div>`,
      }));
    }
    const gruposConTabla = await obtenerClasificacionesPorGrupo(env, competicion);
    const grupoParam = url.searchParams.get("grupo");
    const elegido = grupoParam
      ? gruposConTabla.find((g) => g.grupo === grupoParam) || gruposConTabla[0]
      : gruposConTabla[0];
    let cuerpo;
    if (!elegido || !elegido.tabla.length) {
      cuerpo = `<div class="eof-w-vacio">Todavía no hay clasificación disponible.</div>`;
    } else {
      // Tope de 10 filas: un widget embebido es para un vistazo rápido, no
      // para sustituir la página completa de clasificación (que sí enlaza
      // el pie de esta tarjeta).
      const filas = elegido.tabla.slice(0, 10).map((f, i) => `
        <tr>
          <td class="eof-w-num">${i + 1}</td>
          <td>
            <div class="eof-w-equipo">
              ${f.escudoUrl ? `<img class="eof-w-escudo" src="${escapeHtmlEmail(f.escudoUrl)}" alt="" loading="lazy">` : ""}
              <span>${escapeHtmlEmail(f.equipo)}</span>
            </div>
          </td>
          <td class="eof-w-num">${f.pj}</td>
          <td class="eof-w-num">${f.gf - f.gc >= 0 ? "+" : ""}${f.gf - f.gc}</td>
          <td class="eof-w-pts">${f.pts}</td>
        </tr>`).join("");
      cuerpo = `<table class="eof-w-tabla">
        <thead><tr><th>#</th><th>Equipo</th><th class="eof-w-num">PJ</th><th class="eof-w-num">DG</th><th class="eof-w-pts">Pts</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>`;
    }
    return widgetHtmlResponse(widgetBaseHtml({
      tema, origen,
      tituloPagina: nombreCompeticionWidget(competicion) + (elegido && elegido.grupo ? ` · ${elegido.grupo}` : ""),
      cuerpo,
    }));
  }

  if (path === "/widgets/resultados" || path === "/widgets/calendario") {
    const esCalendario = path === "/widgets/calendario";
    const competicion = url.searchParams.get("competicion");
    const club = url.searchParams.get("club");
    let query = "SELECT equipo_local, equipo_visitante, goles_local, goles_visitante, estado, fecha_partido, escudo_local_url, escudo_visitante_url, finalizado_no_cubierto FROM results WHERE 1=1 AND finalizado_no_cubierto = 0";
    const binds = [];
    if (competicion) { query += " AND competicion = ?"; binds.push(competicion); }
    if (club) { query += " AND (equipo_local = ? OR equipo_visitante = ?)"; binds.push(club, club); }
    if (esCalendario) {
      query += " AND estado = 'programado' ORDER BY fecha_partido ASC LIMIT 8";
    } else {
      query += " AND estado IN ('finalizado','en_juego') ORDER BY fecha_partido DESC LIMIT 8";
    }
    const { results: partidos } = await env.DB.prepare(query).bind(...binds).all();
    let cuerpo;
    if (!partidos.length) {
      cuerpo = `<div class="eof-w-vacio">${esCalendario ? "No hay próximos partidos programados." : "Todavía no hay resultados."}</div>`;
    } else {
      const filas = partidos.map((p) => {
        const fecha = p.fecha_partido ? new Date(p.fecha_partido) : null;
        const fechaTexto = fecha && !isNaN(fecha.getTime())
          ? fecha.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" }) + " " + fecha.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
          : "Por confirmar";
        let marcadorHtml;
        if (p.estado === "en_juego") {
          marcadorHtml = `<span class="eof-w-marcador eof-w-vivo">${p.goles_local ?? 0}-${p.goles_visitante ?? 0}</span>`;
        } else if (p.estado === "finalizado") {
          marcadorHtml = `<span class="eof-w-marcador">${p.goles_local ?? 0}-${p.goles_visitante ?? 0}</span>`;
        } else {
          marcadorHtml = `<span class="eof-w-hora">${fechaTexto}</span>`;
        }
        return `<div class="eof-w-partido">
          <div class="eof-w-eq">
            ${p.escudo_local_url ? `<img class="eof-w-escudo" src="${escapeHtmlEmail(p.escudo_local_url)}" alt="" loading="lazy">` : ""}
            <span>${escapeHtmlEmail(p.equipo_local)}</span>
          </div>
          ${marcadorHtml}
          <div class="eof-w-eq eof-w-eq-der">
            <span>${escapeHtmlEmail(p.equipo_visitante)}</span>
            ${p.escudo_visitante_url ? `<img class="eof-w-escudo" src="${escapeHtmlEmail(p.escudo_visitante_url)}" alt="" loading="lazy">` : ""}
          </div>
        </div>`;
      }).join("");
      cuerpo = `<div>${filas}</div>`;
    }
    return widgetHtmlResponse(widgetBaseHtml({
      tema, origen,
      tituloPagina: esCalendario ? "Próximos partidos" : "Resultados",
      cuerpo,
    }));
  }

  if (path === "/widgets/noticia") {
    const categoria = url.searchParams.get("categoria");
    const club = url.searchParams.get("club");
    let query = `SELECT slug, titulo, subtitulo, contenido, categoria, imagen_url, fecha_publicacion
      FROM articles WHERE publicado = 1${SQL_OCULTAR_SEGUNDO_DE_FUSION}`;
    const binds = [];
    if (categoria) { query += " AND categoria = ?"; binds.push(categoria); }
    if (club) { query += " AND (club = ? OR club LIKE ?)"; binds.push(club, `%"${club}"%`); }
    query += " ORDER BY fecha_publicacion DESC LIMIT 1";
    const articulo = await env.DB.prepare(query).bind(...binds).first();
    let cuerpo;
    if (!articulo) {
      cuerpo = `<div class="eof-w-vacio">No hay noticias disponibles.</div>`;
    } else {
      const resumen = articulo.subtitulo || (articulo.contenido || "").replace(/<[^>]+>/g, "").slice(0, 140);
      const urlNoticia = `${origen}/futbol/${encodeURIComponent(articulo.categoria)}/${encodeURIComponent(articulo.slug)}`;
      cuerpo = `
        ${articulo.imagen_url ? `<a href="${urlNoticia}" target="_blank" rel="noopener"><img class="eof-w-noticia-img" src="${escapeHtmlEmail(articulo.imagen_url)}" alt="" loading="lazy"></a>` : ""}
        <p class="eof-w-noticia-titulo"><a href="${urlNoticia}" target="_blank" rel="noopener">${escapeHtmlEmail(articulo.titulo)}</a></p>
        <p class="eof-w-noticia-resumen">${escapeHtmlEmail(resumen)}${resumen.length >= 140 ? "…" : ""}</p>`;
    }
    return widgetHtmlResponse(widgetBaseHtml({
      tema, origen, tituloPagina: "Última noticia", cuerpo,
    }));
  }

  return new Response("Widget no encontrado", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
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
// bloqueHtml (opcional): HTML ya construido y ya escapado por quien llama
// (p. ej. el resumen de partidos sin cubrir, agrupado por tipo). Se pinta
// entre las filas y el botón, con el mismo ancho que el resto.
function plantillaEmail({ etiqueta, titulo, filas = [], parrafo, boton, bloqueHtml }) {
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
          ${bloqueHtml ? `
          <tr>
            <td style="padding:14px 28px 0;">
              ${bloqueHtml}
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
     WHERE estado = 'finalizado' AND finalizado_no_cubierto = 0 AND fecha_partido >= ?
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
    copa_del_rey: "Copa del Rey",
    copa_federacion: "Copa Federación",
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

// ---------- Cuentas de Resend: principal + secundaria (respaldo) ----------
// El plan gratis de Resend tiene un tope diario/mensual de correos. Cuando
// la cuenta principal se queda sin cupo (o falla), los envíos pasan solos a
// una segunda cuenta de Resend. La secundaria es OPCIONAL: sin
// RESEND_API_KEY_2 todo funciona exactamente como antes.
//   Principal:   RESEND_API_KEY    (+ RESEND_FROM   opcional)
//   Secundaria:  RESEND_API_KEY_2  + RESEND_FROM_2 (los DOS son obligatorios para activarla)
// OJO: un dominio solo puede estar activo en UNA cuenta de Resend a la vez,
// así que el remitente de la secundaria (RESEND_FROM_2) tiene que usar otro
// dominio/subdominio verificado en esa cuenta (p. ej. mail2.elotrofutbol.media).
const REMITENTE_RESEND_POR_DEFECTO = "ELOTROFÚTBOLTV <notificaciones@elotrofutbol.media>";
// Si la principal responde "cupo agotado", durante un rato se salta directamente
// a la secundaria (en vez de probar la principal en cada correo, p. ej. en el
// boletín con muchos suscriptores). Solo vive mientras dure este isolate.
let RESEND_PRINCIPAL_AGOTADA_HASTA = 0;

let AVISO_RESEND_SIN_FROM_2_MOSTRADO = false;
function cuentasResend(env) {
  const cuentas = [];
  if (env.RESEND_API_KEY) {
    cuentas.push({ clave: env.RESEND_API_KEY, from: env.RESEND_FROM || REMITENTE_RESEND_POR_DEFECTO });
  }
  // La secundaria SOLO se activa si tiene su propio remitente (RESEND_FROM_2):
  // como un dominio solo puede estar activo en una cuenta de Resend, si se
  // reutilizase el remitente de la principal, la secundaria fallaría siempre
  // con 403 (dominio no verificado en esa cuenta) y no serviría de respaldo.
  if (env.RESEND_API_KEY_2 && env.RESEND_FROM_2) {
    cuentas.push({ clave: env.RESEND_API_KEY_2, from: env.RESEND_FROM_2 });
  } else if (env.RESEND_API_KEY_2 && !AVISO_RESEND_SIN_FROM_2_MOSTRADO) {
    AVISO_RESEND_SIN_FROM_2_MOSTRADO = true;
    console.warn("Resend: RESEND_API_KEY_2 está definida pero falta RESEND_FROM_2; la cuenta secundaria NO se usa (necesita un remitente de otro dominio verificado en esa cuenta)");
  }
  return cuentas;
}

// ¿El fallo es de LA CUENTA (sin cupo, límite de ritmo, clave rechazada,
// dominio no verificado en esa cuenta o caída del servicio)? Entonces
// merece la pena probar con la otra. Si el problema es el propio correo
// (400/422: destinatario o datos inválidos) fallaría igual en la otra.
function esFalloDeCuentaResend(status) {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

// Envía un correo por Resend con respaldo automático. `payload` lleva
// to/subject/text/html (el "from" lo pone cada cuenta). Devuelve la Response
// de Resend (la de la última cuenta probada) o null si no hay ninguna cuenta
// configurada; lanza el error de red solo si fallan todas las cuentas.
async function enviarConResend(env, payload) {
  const cuentas = cuentasResend(env);
  if (!cuentas.length) return null;
  const ahora = Date.now();
  const candidatas = cuentas.length > 1 && ahora < RESEND_PRINCIPAL_AGOTADA_HASTA ? cuentas.slice(1) : cuentas;
  for (let i = 0; i < candidatas.length; i++) {
    const cuenta = candidatas[i];
    const hayOtra = i < candidatas.length - 1;
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cuenta.clave}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: cuenta.from, ...payload }),
      });
      if (resp.ok || !hayOtra || !esFalloDeCuentaResend(resp.status)) return resp;
      const cuerpo = await resp.clone().text();
      if (cuenta === cuentas[0] && /quota_exceeded/i.test(cuerpo)) {
        RESEND_PRINCIPAL_AGOTADA_HASTA = ahora + 30 * 60 * 1000; // 30 min
      }
      console.warn(`Resend: la cuenta con remitente "${cuenta.from}" no puede enviar (${resp.status}); se prueba con la siguiente. ${cuerpo}`);
    } catch (err) {
      if (!hayOtra) throw err;
      console.warn(`Resend: error de red con la cuenta "${cuenta.from}" (${err.message}); se prueba con la siguiente`);
    }
  }
}

// Envía el boletín a todos los suscriptores activos vía Resend, en
// lotes (la API de Resend admite varios destinatarios por llamada, pero
// se agrupan en lotes moderados para no depender de un límite exacto
// que pueda cambiar). Un fallo enviando un lote no interrumpe el resto.
async function enviarBoletinALista(env, { destinatarios, articulos, clasificaciones = [], resultadosDestacados = [], encuestas = [] }) {
  if (!cuentasResend(env).length) {
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
          const resp = await enviarConResend(env, {
            to: [s.email],
            subject: "Tu resumen semanal de ELOTROFÚTBOLTV",
            html: plantillaNewsletter({ articulos, bajaUrl, clasificaciones, resultadosDestacados, encuestas }),
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
// Guardia en memoria del cron por minuto: mientras no toque, no se vuelve a
// leer newsletter_envios en cada tick. Como mucho 1 lectura por hora y
// por isolate (el tope de 1h evita que un cambio manual de
// ultimo_envio_at quede ignorado durante dias).
let BOLETIN_PROXIMA_COMPROBACION_MS = 0;

async function enviarBoletinSemanalSiToca(env) {
  if (Date.now() < BOLETIN_PROXIMA_COMPROBACION_MS) return;
  try {
    const fila = await env.DB.prepare(
      "SELECT ultimo_envio_at FROM newsletter_envios WHERE id = 1"
    ).first();
    const ultimo = fila && fila.ultimo_envio_at ? new Date(fila.ultimo_envio_at + "Z") : null;
    const ahora = new Date();
    const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
    if (ultimo && ahora - ultimo < SIETE_DIAS_MS) {
      // aún no toca: no volver a mirar hasta que toque (como mucho 1h)
      BOLETIN_PROXIMA_COMPROBACION_MS = Math.min(ultimo.getTime() + SIETE_DIAS_MS, Date.now() + 60 * 60 * 1000);
      return;
    }

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
       WHERE publicado = 1${SQL_OCULTAR_SEGUNDO_DE_FUSION} AND fecha_publicacion >= ?
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
  if (!cuentasResend(env).length) {
    console.log("RESEND_API_KEY no configurado: aviso por email omitido ->", asunto);
    return false;
  }
  try {
    const resp = await enviarConResend(env, {
      to: [destinatario || EMAIL_NOTIFICACIONES],
      subject: asunto,
      text: texto,
      html: html || undefined,
    });
    if (!resp || !resp.ok) {
      console.log("Error al enviar email de notificación:", resp && resp.status, resp ? await resp.text() : "");
      return false;
    }
    return true;
  } catch (err) {
    console.log("Error al enviar email de notificación:", err.message);
    return false;
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

// Resuelve el valor final a guardar en "club" (y, para previa/crónica,
// también en "categoria") para un artículo, según su tipo. Para
// "previa" y "cronica" ni el club ni la categoría los elige ya el
// redactor a mano en el panel (ver Fase 2 y Fase 3): ambos se derivan
// siempre del resultado vinculado (los dos equipos, y la competición
// del partido), así que hace falta un resultado_id válido con ambos
// equipos y competición. Además, el estado del partido debe encajar con
// el tipo: una crónica solo tiene sentido de un partido "finalizado", y
// una previa solo de uno que todavía no se ha jugado ("programado" o
// "retrasado"); esto evita crónicas de partidos que no han terminado y
// previas de partidos ya jugados, incluso si alguien manda la petición
// a mano saltándose la comprobación del panel (ver también
// errorEstadoResultadoParaTipo en public/admin/js/admin.js, que hace la
// misma comprobación en el frontend). Para el resto de tipos (noticia,
// análisis, opinión, entrevista) el comportamiento no cambia: se guarda
// tal cual el club que venga en el body (un único nombre, o vacío/null
// para "General"), y la categoría se resuelve aparte (ver
// validarCategoriaSegunAutor). Devuelve { error } si es previa/crónica
// sin resultado vinculado (o sin competición, o con un estado
// incompatible), o { club, categoria } con los valores finales listos
// para el INSERT/UPDATE (categoria es undefined para el resto de tipos,
// ya que ahí la decide validarCategoriaSegunAutor).
async function resolverClubArticulo(env, tipo, resultadoId, clubBody) {
  if (tipo !== "previa" && tipo !== "cronica") {
    return { club: clubBody || null };
  }
  if (!resultadoId) {
    return { error: "Una previa o crónica debe tener un resultado vinculado para poder guardarse (el club y la categoría se toman automáticamente del partido)." };
  }
  const resultado = await env.DB.prepare("SELECT equipo_local, equipo_visitante, competicion, estado FROM results WHERE id = ?")
    .bind(resultadoId).first();
  if (!resultado) {
    return { error: "El resultado vinculado ya no existe. Elige de nuevo el partido." };
  }
  if (tipo === "cronica" && resultado.estado !== "finalizado") {
    return { error: "No puedes guardar una crónica de un partido que todavía no ha terminado." };
  }
  if (tipo === "previa" && resultado.estado !== "programado" && resultado.estado !== "retrasado") {
    return { error: "No puedes guardar una previa de un partido que ya ha terminado o está en juego." };
  }
  const club = clubArticuloDesdeResultado(resultado.equipo_local, resultado.equipo_visitante);
  if (!club) {
    return { error: "El resultado vinculado no tiene los dos equipos definidos." };
  }
  if (!resultado.competicion) {
    return { error: "El resultado vinculado no tiene competición definida." };
  }
  return { club, categoria: resultado.competicion };
}

// ---------- Redactores "sin equipo, con categoría(s) fija(s)" ----------
// Categorías que un admin puede fijar para este tipo de redactor:
// "Arbitraje" y "Jurisdicción deportiva"; si en el futuro se añaden
// más, basta con añadirlas aquí.
const CATEGORIAS_FIJAS_VALIDAS = ["arbitraje", "jurisdiccion"];

// Igual que parsearEquipos(): convierte el JSON en texto guardado en
// "categorias_fijas" a un array de strings. [] si no tiene ninguna.
function parsearCategoriasFijas(valor) {
  if (!valor) return [];
  try {
    const parsed = JSON.parse(valor);
    if (Array.isArray(parsed)) return parsed.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim());
  } catch {
    if (typeof valor === "string" && valor.trim()) return [valor.trim()];
  }
  return [];
}

// Valida la lista de "categorias_fijas" recibida del panel: cada valor
// debe estar en CATEGORIAS_FIJAS_VALIDAS, sin duplicados. Un array vacío
// (o vacío/null/undefined) significa "redactor normal, sin categoría
// fija". Devuelve { error } o { categoriasFijas } con el array ya limpio
// (puede ser []).
function validarCategoriasFijas(valorRecibido) {
  let lista = [];
  if (Array.isArray(valorRecibido)) {
    lista = valorRecibido;
  } else if (typeof valorRecibido === "string" && valorRecibido.trim()) {
    lista = [valorRecibido];
  } else if (valorRecibido === undefined || valorRecibido === null || valorRecibido === "") {
    return { categoriasFijas: [] };
  }
  const limpios = [...new Set(lista.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim()))];
  const noValidos = limpios.filter((c) => !CATEGORIAS_FIJAS_VALIDAS.includes(c));
  if (noValidos.length) return { error: `Categoría fija no válida: ${noValidos.join(", ")}` };
  return { categoriasFijas: limpios };
}

// Si el autor final de una noticia (el que la firma, no necesariamente
// quien la sube: ver "autor_id" en POST/PUT /api/articles) tiene alguna
// "categoría fija" asignada, la categoría de la noticia tiene que ser
// una de esas. Se aplica igual cuando es el propio redactor quien sube
// su noticia que cuando un admin la sube en su nombre eligiéndolo como
// autor: lo que importa es de quién queda firmada, no quién la sube.
// Devuelve { error } si no cumple, o { categoria } con la categoría ya
// validada (o forzada a la única fija disponible, si aplica).
function validarCategoriaSegunAutor(categoriasFijasAutor, categoriaRecibida) {
  if (!categoriasFijasAutor || !categoriasFijasAutor.length) {
    return { categoria: categoriaRecibida || "hypermotion" };
  }
  if (categoriasFijasAutor.length === 1) {
    // Con una sola categoría fija, queda fija de facto: no hace falta
    // que el formulario la mande bien, se fuerza siempre.
    return { categoria: categoriasFijasAutor[0] };
  }
  if (!categoriaRecibida || !categoriasFijasAutor.includes(categoriaRecibida)) {
    return { error: `La categoría de esta noticia debe ser una de las categorías fijas del autor: ${categoriasFijasAutor.join(", ")}.` };
  }
  return { categoria: categoriaRecibida };
}

// ---------- Categoría(s) adicional(es) de una noticia ----------
// Todas las categorías que puede tener una noticia (principal o
// adicional). Coincide con el desplegable "Categoría" del panel (ver
// public/js/config.js, CATEGORIES) más "arbitraje" y "jurisdiccion"
// (solo llegan a través de las categorías fijas de un redactor de ese
// tipo). "copa_del_rey" y "copa_federacion" solo valen como categoría
// principal, NO como adicionales (por eso no están en esta lista).
const CATEGORIAS_ARTICULO_VALIDAS = ["hypermotion", "primera_federacion", "segunda_federacion", "general", "amistoso", "arbitraje", "jurisdiccion"];
const MAX_CATEGORIAS_ADICIONALES = 4;

// Igual que parsearEquipos()/parsearCategoriasFijas(): convierte el JSON
// en texto guardado en "categorias_adicionales" a un array de strings.
// [] si no tiene ninguna.
function parsearCategoriasAdicionales(valor) {
  if (!valor) return [];
  try {
    const parsed = JSON.parse(valor);
    if (Array.isArray(parsed)) return parsed.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim());
  } catch {
    if (typeof valor === "string" && valor.trim()) return [valor.trim()];
  }
  return [];
}

// Valida la lista de "categorias_adicionales" recibida del panel contra
// la categoría principal ya decidida (categoriaPrincipal) y, si el autor
// tiene categoría(s) fija(s), también contra esas (mismo criterio que la
// propia categoría principal: ver validarCategoriaSegunAutor). Quita
// duplicados y la propia principal si se hubiera colado, y limita a
// MAX_CATEGORIAS_ADICIONALES. Devuelve { error } o { categoriasAdicionales }
// con el array ya limpio (puede ser []).
function validarCategoriasAdicionales(valorRecibido, categoriaPrincipal, categoriasFijasAutor) {
  let lista = [];
  if (Array.isArray(valorRecibido)) {
    lista = valorRecibido;
  } else if (typeof valorRecibido === "string" && valorRecibido.trim()) {
    lista = [valorRecibido];
  } else if (valorRecibido === undefined || valorRecibido === null || valorRecibido === "") {
    return { categoriasAdicionales: [] };
  }
  const limpios = [...new Set(
    lista.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim())
  )].filter((c) => c !== categoriaPrincipal);
  const noValidos = limpios.filter((c) => !CATEGORIAS_ARTICULO_VALIDAS.includes(c));
  if (noValidos.length) return { error: `Categoría adicional no válida: ${noValidos.join(", ")}.` };
  if (limpios.length > MAX_CATEGORIAS_ADICIONALES) {
    return { error: `Puedes seleccionar como máximo ${MAX_CATEGORIAS_ADICIONALES} categorías adicionales.` };
  }
  // Un redactor con categoría(s) fija(s) también queda restringido a
  // esas mismas categorías para las adicionales (no puede etiquetar una
  // noticia con una categoría fuera de las suyas).
  if (categoriasFijasAutor && categoriasFijasAutor.length) {
    const fueraDeFijas = limpios.filter((c) => !categoriasFijasAutor.includes(c));
    if (fueraDeFijas.length) {
      return { error: `Las categorías adicionales de esta noticia deben estar entre las categorías fijas del autor: ${categoriasFijasAutor.join(", ")}.` };
    }
  }
  return { categoriasAdicionales: limpios };
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
// Esto es la marca visual (banner rojo fijo en toda la web) que un
// admin/redactor activa a mano desde el panel para una noticia
// concreta. Nada que ver con "ultima_hora_pin" (que es un permiso de
// publicación directa para redactores de Nivel 1); por eso usa un
// nombre de columna distinto (banner_urgente) para no confundir los
// dos conceptos.
//
// La duración SIEMPRE se calcula en el servidor (nunca se acepta un
// valor mandado por el cliente): así nadie puede alargar a mano, desde
// el panel, cuánto tiempo estará el banner activo.
// En minutos (no horas): worker-secondary/src/sql-compat.js traduce
// SQLite -> Postgres para el failover a Railway, y solo tiene patrón de
// traducción ya hecho para "+N minutes" / "+N days" en
// datetime('now', ...), no para "hours". Usar minutos aquí evita tener
// que tocar también ese traductor para añadir un caso nuevo.
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
// btoa() solo admite caracteres Latin1: cualquier nombre de perfil con
// tildes, emojis o caracteres no-ASCII (frecuente en nombres de X,
// Discord, Google...) lo rompe con "btoa() can only operate on
// characters in the Latin1 range" en cuanto entra en el payload del
// JWT (ver b64urlJSON más abajo). Se codifica primero a bytes UTF-8 con
// TextEncoder y se pasan esos bytes a btoa() carácter a carácter, en
// vez del string original -- mismo patrón ya usado para las
// credenciales de X en el intercambio de token.
function b64url(str) {
  const bytesUtf8 = new TextEncoder().encode(str);
  return btoa(String.fromCharCode(...bytesUtf8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
// ---------- Firma RS256 (para el JWT de cuenta de servicio de Google) ----------
// Distinto de signHS256 (arriba, HS256 con secreto compartido, usado
// para nuestros propios JWT de sesión): la API de Google exige que el
// JWT de autorización de una cuenta de servicio vaya firmado con la
// clave PRIVADA RSA de esa cuenta (RS256), igual que hacemos ya para
// VERIFICAR (no firmar) los id_token que llegan de Google/Microsoft en
// verificarGoogleIdToken/verificarMicrosoftIdToken.
async function signRS256(data, clavePrivadaPem) {
  // La clave llega en formato PEM estándar (la que descarga la consola
  // de Google al crear la cuenta de servicio, con las líneas
  // "-----BEGIN PRIVATE KEY-----"): hay que quitar cabecera/pie y
  // saltos de línea, decodificar el base64 restante a bytes DER, e
  // importarla como PKCS8.
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

// Intercambia las credenciales de una cuenta de servicio de Google
// (JSON descargado de la consola de Cloud, guardado como los dos
// secretos GSC_SERVICE_ACCOUNT_EMAIL y GSC_SERVICE_ACCOUNT_KEY) por un
// access_token OAuth de corta duración, con el scope de solo lectura de
// Search Console. Sigue el flujo estándar "JWT Bearer" de Google
// (RFC 7523): un JWT autofirmado que se canjea en /oauth2/v4/token.
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

// ---------- Search Console: KPIs + serie diaria + top consultas ----------
// Consume la API oficial de Search Console (searchanalytics.query),
// autenticada con una cuenta de servicio a la que se le ha dado acceso
// de lectura a la propiedad del sitio desde search.google.com/search-console
// ("Configuración" -> "Usuarios y permisos" -> añadir el email de la
// cuenta de servicio como "Restringido"/lectura). Requiere dos secretos
// (ver README):
//   wrangler secret put GSC_SERVICE_ACCOUNT_EMAIL
//   wrangler secret put GSC_SERVICE_ACCOUNT_KEY
// y la variable GSC_SITE_URL (la propiedad exacta tal y como aparece en
// Search Console, p. ej. "sc-domain:elotrofutbol.media" o
// "https://elotrofutbol.media/").
//
// Si faltan credenciales, se devuelve { conectado:false } (no un error):
// es el estado "todavía no configurado", que el panel ya sabe pintar
// como aviso neutro en vez de como fallo -- antes esto ni siquiera
// llegaba aquí porque la ruta no existía (404 -> "Error de conexión").
async function calcularGscAnaliticas(env, dias) {
  if (!env.GSC_SERVICE_ACCOUNT_EMAIL || !env.GSC_SERVICE_ACCOUNT_KEY || !env.GSC_SITE_URL) {
    return { conectado: false };
  }

  try {
    const accessToken = await obtenerTokenGoogleServiceAccount(env);

    // GSC solo tiene datos con ~2-3 días de retraso respecto a hoy; se
    // pide hasta hace 2 días para no recibir una cola de días vacíos que
    // desvirtúe la serie/los promedios.
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

async function signHS256(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}
async function createJWT(payload, secret, expiresInSec = 60 * 60 * 12) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSec };
  const data = `${b64urlJSON(header)}.${b64urlJSON(fullPayload)}`;
  const sig = await signHS256(data, secret);
  return `${data}.${sig}`;
}
// SEGURIDAD: comparación en tiempo constante (evita ataques de temporización
// al comparar firmas, hashes y secretos).
function comparacionConstante(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

async function verifyJWT(token, secret) {
  // Falla cerrado: sin JWT_SECRET configurado NUNCA se acepta ningún token
  // (antes, un secreto ausente se convertía en la clave literal "undefined",
  // con la que cualquiera podía falsificar tokens de administrador).
  if (typeof token !== "string" || typeof secret !== "string" || secret.length < 16) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let cabecera;
  try { cabecera = JSON.parse(b64urlDecodeTexto(h)); } catch { return null; }
  if (!cabecera || cabecera.alg !== "HS256") return null;
  const expected = await signHS256(`${h}.${p}`, secret);
  if (!comparacionConstante(expected, s)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecodeTexto(p)); } catch { return null; }
  if (!payload || typeof payload !== "object") return null;
  // "exp" obligatorio: un token sin caducidad no se acepta.
  if (typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

// SHA-256 (hex) de un texto: se usa para guardar en base de datos solo el
// HASH de los tokens de recuperación/verificación (el token real solo viaja
// por el enlace del correo). Así, una fuga de la base de datos no permite
// restablecer contraseñas ni confirmar cuentas.
async function sha256Texto(texto) {
  return sha256Hex(new TextEncoder().encode(String(texto ?? "")));
}

// Límite de intentos por IP (+ clave opcional) usando KV. Devuelve true si
// se ha superado. Si KV no está disponible, no bloquea (falla abierto) para
// no tumbar el login por un fallo de infraestructura.
async function limiteExcedido(request, env, accion, max, ventanaSeg, extra = "") {
  try {
    if (!env.ELOTROFUTBOL_KV) return false;
    const ip = request.headers.get("CF-Connecting-IP") || "desconocida";
    const ventana = Math.floor(Date.now() / (ventanaSeg * 1000));
    const sufijo = extra ? `:${String(extra).toLowerCase().slice(0, 80)}` : "";
    const clave = `rl:${accion}:${ip}${sufijo}:${ventana}`;
    const actual = parseInt((await env.ELOTROFUTBOL_KV.get(clave)) || "0", 10);
    if (actual >= max) return true;
    await env.ELOTROFUTBOL_KV.put(clave, String(actual + 1), { expirationTtl: Math.max(60, ventanaSeg * 2) });
    return false;
  } catch {
    return false;
  }
}

// PIN de acceso al formulario público de acreditaciones. Se guarda en
// settings (clave "acreditacion_pin") y lo gestiona un admin desde
// Funcionalidades > Acreditaciones. Sin PIN configurado el formulario
// queda cerrado; la primera vez que un admin abre esa pestaña se genera uno.
const ACREDITACION_PIN_KEY = "acreditacion_pin";
function validarPinAcreditacion(pin) {
  return typeof pin === "string" && /^\d{4,8}$/.test(pin);
}
function generarPinAcreditacion() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, "0");
}
async function obtenerPinAcreditacion(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(ACREDITACION_PIN_KEY).first();
  return row && row.value ? String(row.value) : null;
}
async function guardarPinAcreditacion(env, pin) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(ACREDITACION_PIN_KEY, pin).run();
}
function pinAcreditacionCorrecto(esperado, recibido) {
  if (!esperado || typeof recibido !== "string" || recibido.length !== esperado.length) return false;
  let diff = 0;
  for (let i = 0; i < esperado.length; i++) diff |= esperado.charCodeAt(i) ^ recibido.charCodeAt(i);
  return diff === 0;
}

// Tipos de acreditación que acepta el formulario público (acreditacion.html).
// Deben coincidir con las opciones de esa página.
const ACREDITACION_TIPOS_ACREDITACION = [
  "Prensa / Pupitre",
  "Fotógrafo / Césped",
  "Cabina de prensa (si el club dispone de ella)",
];

// ---------- Configuración editable del formulario de acreditaciones ----------
// Un admin puede cambiar textos y listas desde Funcionalidades > Acreditaciones.
// Se guarda como JSON en settings (clave "acreditacion_config"); sin nada
// guardado se usan los valores por defecto (los de siempre).
const ACREDITACION_CONFIG_KEY = "acreditacion_config";
const ACREDITACION_CONFIG_DEFECTO = {
  titulo: "Formulario de acreditación | ElOtroFútbol",
  intro: "Solicita tu acreditación para cubrir partidos, ruedas de prensa y actos oficiales de Primera Federación y Segunda Federación.",
  aviso: "Las solicitudes serán revisadas por el equipo de administración. El envío del formulario no garantiza la concesión de la acreditación, ya que la decisión final corresponde al club organizador.",
  confirmacion: "Confirmo que los datos facilitados son correctos y entiendo que el envío de esta solicitud no garantiza la concesión de la acreditación.",
  gracias: "Hemos recibido tu solicitud de acreditación. El equipo de administración la revisará y se pondrá en contacto contigo por correo.",
  eventos: ["Rueda de prensa", "Partido de fútbol", "Presentación oficial", "Acto"],
  evento_otro: true,
  acreditaciones: [...ACREDITACION_TIPOS_ACREDITACION],
  secciones: {
    solicitante: "Datos del solicitante",
    cobertura: "Información de la cobertura",
    confirmacion: "Confirmación",
  },
  preguntas: {
    nombre: { etiqueta: "Nombre y apellidos", ayuda: "Tu respuesta", error: "Indica tu nombre y apellidos.", activa: true, obligatoria: true },
    email: { etiqueta: "Correo electrónico", ayuda: "Tu respuesta", error: "Introduce un correo electrónico válido.", activa: true, obligatoria: true },
    dni: { etiqueta: "DNI / NIE", ayuda: "Tu respuesta", error: "Introduce un DNI / NIE válido.", activa: true, obligatoria: true },
    equipo: { etiqueta: "Equipo que deseas cubrir", ayuda: "Elige un equipo…", error: "Elige o escribe el equipo que deseas cubrir.", activa: true, obligatoria: true },
    tipo_evento: { etiqueta: "Tipo de evento", ayuda: "", error: "Elige el tipo de evento.", activa: true, obligatoria: true },
    tipo_acreditacion: { etiqueta: "Tipo de acreditación", ayuda: "", error: "Elige el tipo de acreditación.", activa: true, obligatoria: true },
    funciones: { etiqueta: "Describe brevemente las funciones que realizarás durante la cobertura", ayuda: "Tu respuesta", error: "Describe brevemente tus funciones.", activa: true, obligatoria: true },
    jornada_partido: { etiqueta: "Indica la jornada y partido que quieres cubrir", ayuda: "Tu respuesta", error: "Indica la jornada y el partido.", activa: true, obligatoria: true },
  },
};
// Preguntas que no se pueden ocultar ni hacer opcionales (sin ellas no hay solicitud útil).
const ACREDITACION_PREGUNTAS_FIJAS = ["nombre", "email", "equipo", "tipo_acreditacion"];
function normalizarConfigAcreditacion(raw) {
  const d = ACREDITACION_CONFIG_DEFECTO;
  const r = raw && typeof raw === "object" ? raw : {};
  const texto = (v, def, max) => {
    const t = typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, max) : "";
    return t || def;
  };
  const lista = (v, def) => {
    if (!Array.isArray(v)) return [...def];
    const vistos = new Set();
    const out = [];
    for (const x of v) {
      const t = String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, 150);
      if (t && !vistos.has(t.toLowerCase())) { vistos.add(t.toLowerCase()); out.push(t); }
      if (out.length >= 20) break;
    }
    return out;
  };
  let eventos = lista(r.eventos, d.eventos);
  const eventoOtro = r.evento_otro === undefined ? d.evento_otro : r.evento_otro === true;
  if (!eventos.length && !eventoOtro) eventos = [...d.eventos];
  let acreditaciones = lista(r.acreditaciones, d.acreditaciones);
  if (!acreditaciones.length) acreditaciones = [...d.acreditaciones];
  const rs = r.secciones && typeof r.secciones === "object" ? r.secciones : {};
  const secciones = {
    solicitante: texto(rs.solicitante, d.secciones.solicitante, 100),
    cobertura: texto(rs.cobertura, d.secciones.cobertura, 100),
    confirmacion: texto(rs.confirmacion, d.secciones.confirmacion, 100),
  };
  const rp = r.preguntas && typeof r.preguntas === "object" ? r.preguntas : {};
  const preguntas = {};
  for (const k of Object.keys(d.preguntas)) {
    const dp = d.preguntas[k];
    const p = rp[k] && typeof rp[k] === "object" ? rp[k] : {};
    const fija = ACREDITACION_PREGUNTAS_FIJAS.includes(k);
    preguntas[k] = {
      etiqueta: texto(p.etiqueta, dp.etiqueta, 300),
      // La ayuda (texto gris dentro de la casilla) puede dejarse vacía a propósito.
      ayuda: typeof p.ayuda === "string" ? p.ayuda.replace(/\r/g, "").trim().slice(0, 200) : dp.ayuda,
      error: texto(p.error, dp.error, 200),
      activa: fija ? true : (p.activa === undefined ? dp.activa : p.activa === true),
      obligatoria: fija ? true : (p.obligatoria === undefined ? dp.obligatoria : p.obligatoria === true),
    };
  }
  return {
    titulo: texto(r.titulo, d.titulo, 120),
    intro: texto(r.intro, d.intro, 600),
    aviso: texto(r.aviso, d.aviso, 800),
    confirmacion: texto(r.confirmacion, d.confirmacion, 600),
    gracias: texto(r.gracias, d.gracias, 600),
    eventos,
    evento_otro: eventoOtro,
    acreditaciones,
    secciones,
    preguntas,
  };
}
async function obtenerConfigAcreditacion(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(ACREDITACION_CONFIG_KEY).first();
    if (row && row.value) return normalizarConfigAcreditacion(JSON.parse(String(row.value)));
  } catch {}
  return normalizarConfigAcreditacion(null);
}
// Limpieza y validación compartida por la edición y la importación del panel
// (el formulario público tiene su propia validación, más estricta).
function limpiarDatosAcreditacionAdmin(d, { estricto } = {}) {
  const limpiar = (v, max) => (v ? String(v) : "").replace(/\s+/g, " ").trim().slice(0, max);
  const out = {
    nombre: limpiar(d.nombre, 200),
    email: limpiar(d.email, 200).toLowerCase(),
    dni: limpiar(d.dni, 30).replace(/[\s.-]/g, "").toUpperCase(),
    equipo: limpiar(d.equipo, 200),
    tipo_evento: limpiar(d.tipo_evento, 200),
    tipo_acreditacion: limpiar(d.tipo_acreditacion, 200),
    funciones: (d.funciones ? String(d.funciones) : "").trim().slice(0, 2000),
    jornada_partido: limpiar(d.jornada_partido, 500),
  };
  if (!out.nombre) return { error: "Falta el nombre" };
  if (!emailValido(out.email)) return { error: "Correo no válido" };
  if (!out.equipo) return { error: "Falta el equipo" };
  if (out.dni && (out.dni.length < 5 || !/^[A-Z0-9]+$/.test(out.dni))) return { error: "DNI / NIE no válido" };
  if (estricto) {
    if (!out.dni) return { error: "Falta el DNI / NIE" };
    if (!out.tipo_evento) return { error: "Falta el tipo de evento" };
    if (!out.tipo_acreditacion) return { error: "Falta el tipo de acreditación" };
    if (!out.funciones) return { error: "Faltan las funciones" };
    if (!out.jornada_partido) return { error: "Falta la jornada y partido" };
  }
  return { datos: out };
}

const RESPUESTA_DEMASIADOS_INTENTOS = "Demasiados intentos. Espera unos minutos y vuelve a probar.";
// Sal ficticia para gastar el mismo tiempo de PBKDF2 cuando el usuario no
// existe (evita enumerar usuarios midiendo el tiempo de respuesta).
const SAL_FICTICIA_LOGIN = "00112233445566778899aabbccddeeff";

// SEGURIDAD (secuestro previo de cuenta): si alguien registró un correo ajeno
// con contraseña conocida por él y la víctima entra luego con Google/
// Microsoft/Discord, la cuenta se vinculaba y marcaba como verificada
// conservando la contraseña del atacante. Si la cuenta NO estaba verificada,
// se invalida su contraseña y sus sesiones antes de vincularla.
async function neutralizarCuentaLectorNoVerificada(env, lector) {
  try {
    if (!lector || lector.email_verificado) return;
    const relleno = new Uint8Array(32);
    crypto.getRandomValues(relleno);
    const salt = randomSalt();
    const hash = await hashPassword(bufToHex(relleno.buffer), salt);
    await env.DB.prepare(
      "UPDATE readers SET password_hash = ?, salt = ?, verificacion_token = NULL, verificacion_token_expira = NULL, reset_token = NULL, reset_token_expira = NULL WHERE id = ?"
    ).bind(hash, salt, lector.id).run();
    await env.DB.prepare(
      "UPDATE reader_sessions SET revoked_at = datetime('now') WHERE reader_id = ? AND revoked_at IS NULL"
    ).bind(lector.id).run();
  } catch (err) {
    console.error("[seguridad] no se pudo neutralizar la cuenta no verificada:", err && err.message);
  }
}

// ---------- Saneado del HTML de artículos (anti XSS almacenado) ----------
// Lista blanca de etiquetas/atributos. Todo lo demás se elimina (la etiqueta,
// no su texto). Se aplica al GUARDAR un artículo; el frontend y el worker de
// SEO vuelven a sanear al pintar (defensa en profundidad, y cubre contenido
// ya guardado antes de este cambio).
const SAN_ETIQUETAS = new Set([
  "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "mark", "small",
  "sub", "sup", "span", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
  "a", "img", "figure", "figcaption", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
]);
const SAN_ATRIBUTOS_GLOBALES = new Set(["class", "title", "lang", "dir", "style"]);
const SAN_ATRIBUTOS_POR_ETIQUETA = {
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height", "loading"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  ol: ["start", "type"],
};
const SAN_ETIQUETAS_VACIAS = new Set(["br", "hr", "img"]);

function sanDecodificarEntidades(valor) {
  const nombradas = { colon: ":", tab: "\t", newline: "\n", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(valor)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
    .replace(/&#(\d+);?/g, (_, d) => { const c = parseInt(d, 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
    .replace(/&([a-z]+);/gi, (m, n) => (Object.prototype.hasOwnProperty.call(nombradas, n.toLowerCase()) ? nombradas[n.toLowerCase()] : m));
}
function sanEscaparAtributo(valor) {
  return String(valor).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function sanUrlSegura(valorDecodificado, { permitirDataImagen = false } = {}) {
  const limpio = String(valorDecodificado).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+/g, "");
  if (!limpio) return "";
  if (/^(https?:|mailto:|tel:)/i.test(limpio)) return limpio;
  if (permitirDataImagen && /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+\/=]+$/i.test(limpio)) return limpio;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(limpio)) return ""; // cualquier otro esquema (javascript:, data:, vbscript:...)
  return limpio; // ruta relativa, "#ancla", "/ruta"...
}
function sanEstiloSeguro(valorDecodificado) {
  const v = String(valorDecodificado);
  if (/expression|javascript:|vbscript:|behavior|@import|url\s*\(|\\|<|>|-moz-binding/i.test(v)) return "";
  return v;
}
function sanTextoSuelto(texto) {
  // Texto entre etiquetas: un "<" suelto (etiqueta mal formada) se escapa; las
  // entidades existentes (&amp;, &nbsp;...) se respetan.
  return texto.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanearHtmlArticulo(html) {
  if (typeof html !== "string" || html === "") return html;
  let entrada = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math|form|textarea|select|option|button|link|meta|base|frame|frameset|applet|title)\b[\s\S]*?<\/\1\s*>/gi, "");
  const reEtiqueta = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>\/=`]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  const reAtributo = /([^\s"'<>\/=`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let salida = "";
  let ultimo = 0;
  let m;
  while ((m = reEtiqueta.exec(entrada)) !== null) {
    salida += sanTextoSuelto(entrada.slice(ultimo, m.index));
    ultimo = reEtiqueta.lastIndex;
    const cierre = m[1] === "/";
    const etiqueta = m[2].toLowerCase();
    if (!SAN_ETIQUETAS.has(etiqueta)) continue;
    if (cierre) {
      if (!SAN_ETIQUETAS_VACIAS.has(etiqueta)) salida += `</${etiqueta}>`;
      continue;
    }
    const permitidosEtiqueta = SAN_ATRIBUTOS_POR_ETIQUETA[etiqueta] || [];
    const atributos = [];
    let abreEnNuevaPestana = false;
    let a;
    reAtributo.lastIndex = 0;
    while ((a = reAtributo.exec(m[3] || "")) !== null) {
      const nombre = a[1].toLowerCase();
      if (nombre.startsWith("on")) continue;
      if (!SAN_ATRIBUTOS_GLOBALES.has(nombre) && !permitidosEtiqueta.includes(nombre)) continue;
      const valor = sanDecodificarEntidades(a[2] ?? a[3] ?? a[4] ?? "");
      let valorFinal = valor;
      if (nombre === "href") valorFinal = sanUrlSegura(valor);
      else if (nombre === "src") valorFinal = sanUrlSegura(valor, { permitirDataImagen: true });
      else if (nombre === "style") valorFinal = sanEstiloSeguro(valor);
      else if (nombre === "target") { if (valor.toLowerCase() === "_blank") abreEnNuevaPestana = true; continue; }
      else if (nombre === "rel") continue;
      if ((nombre === "href" || nombre === "src" || nombre === "style") && !valorFinal) continue;
      atributos.push(` ${nombre}="${sanEscaparAtributo(valorFinal)}"`);
    }
    if (etiqueta === "a" && abreEnNuevaPestana) atributos.push(' target="_blank" rel="noopener noreferrer"');
    salida += `<${etiqueta}${atributos.join("")}${SAN_ETIQUETAS_VACIAS.has(etiqueta) ? " /" : ""}>`;
  }
  salida += sanTextoSuelto(entrada.slice(ultimo));
  return salida;
}
// Ver el porqué completo en requireAuth: cubre el hueco entre que se crea
// una sesión en D1 y que llega replicada a la tabla "sessions" del Worker
// secundario (Railway/Postgres), sin el cual el failover automático
// PRIMARY->SECONDARY podía devolver 403 en peticiones perfectamente
// legítimas justo tras un login. 5 minutos = varias pasadas del
// scheduler de sync (~60s por defecto) de margen, sin dejar la ventana
// abierta indefinidamente para una sesión revocada de verdad.
const TOLERANCIA_SESION_NO_REPLICADA_SEGUNDOS = 5 * 60;

async function requireAuth(request, env, url) {
  const auth = request.headers.get("Authorization") || "";
  let token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  // La descarga se abre como enlace normal del navegador (no un fetch),
  // así que no puede llevar cabecera Authorization. SEGURIDAD: el token por
  // URL (?token=) solo se acepta en ESA ruta concreta; en cualquier otra
  // acabaría en historiales, logs y cabeceras Referer.
  if (!token && url && /^\/api\/media\/\d+\/descargar$/.test(url.pathname)) token = url.searchParams.get("token");
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  // "uid" obligatorio: un token de LECTOR (lleva "rid", no "uid") jamás debe
  // valer como sesión de redactor/admin.
  if (!payload || !payload.uid) return null;
  // Además de que el JWT en sí sea válido, la sesión (fila en la tabla
  // "sessions") tiene que seguir existiendo y no estar revocada: así,
  // cerrar una sesión desde "Mis sesiones" la invalida al momento aunque
  // el JWT todavía no haya caducado. Los JWT antiguos (emitidos antes de
  // este cambio) no llevan "sid"; se siguen aceptando hasta que caduquen
  // por sí solos, para no desconectar a todo el mundo de golpe.
  if (payload.sid) {
    // Caché de 20 s SOLO para sesiones válidas (la revocación tarda como
        // máximo 20 s en notarse en este isolate). El panel hace decenas de
        // peticiones por minuto y cada una validaba la sesión en la base.
    const claveSesion = `sesion:${payload.sid}:${payload.uid}`;
    const sesionEnCache = CACHE_CORTA.get(claveSesion);
    const sesion = (sesionEnCache && sesionEnCache.exp > Date.now())
      ? await sesionEnCache.valor
      : await memoCorta(claveSesion, 20000, async () => {
          const fila = await env.DB.prepare(
            "SELECT id, last_seen_at FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
          ).bind(payload.sid, payload.uid).first();
          if (!fila) CACHE_CORTA.delete(claveSesion); // no se cachea lo no encontrado
          return fila;
        });
    if (!sesion) {
      // TOLERANCIA_SESION_NO_REPLICADA_SEGUNDOS: en el Worker secundario
      // (Railway/Postgres), "sessions" no es la tabla original sino una
      // réplica que llega vía worker-secondary/sync (job periódico, ~60s
      // por defecto -- ver sync/scheduler.mjs), no una escritura en el
      // mismo request. Si el failover PRIMARY->SECONDARY (ver
      // eofFetchConTimeout/apiFetch en public/js/config.js) salta justo
      // tras un login o poco después, la sesión puede no haber llegado
      // TODAVÍA a esta réplica aunque el JWT sea perfectamente válido y
      // la sesión SÍ exista en D1 -- eso hacía que /api/admin/analiticas/*
      // (y cualquier otra ruta protegida) devolviera 403 de forma
      // intermitente solo para las peticiones que, por timing, caían en
      // la secundaria, sin que la persona hubiera hecho nada mal.
      //
      // Se admite igualmente si el JWT es "reciente" (por iat, no por
      // exp: un JWT de larga duración recién revocado también debe
      // rechazarse aquí, no solo los de corta duración) -- igual que ya
      // se hace con los JWT antiguos sin "sid". Esto no reintroduce el
      // problema que "sessions" resuelve (cerrar sesión no tiene efecto
      // hasta caducar el JWT): sigue bloqueando de inmediato una sesión
      // revocada hace más de esta ventana, que es el caso real de "cerrar
      // sesión desde otro dispositivo", y cubre solo el hueco de
      // replicación, no un salvoconducto permanente.
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
        sesion.last_seen_at = new Date().toISOString().slice(0, 19).replace("T", " "); // evita repetir el UPDATE mientras la fila está en caché
      }
    }
  }
  return payload;
}

// Variante de requireAuth para las rutas de la TIENDA (/api/tienda/*).
// Mismo motivo que requireAuthSubida (ver más abajo/arriba según worker): una
// sesión válida podía dar 401 "No autorizado" solo porque su fila no estaba
// en la tabla "sessions" de este backend (token emitido por el otro
// backend, réplica con lag, sesión creada en otro sitio). Aquí:
//   - fila de sesión AUSENTE  -> no es motivo de rechazo.
//   - fila de sesión REVOCADA -> se rechaza.
// Siguen siendo obligatorios: JWT firmado y sin caducar, y usuario activo.
async function requireAuthTienda(request, env) {
  const estricto = await requireAuth(request, env);
  if (estricto) return estricto;

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  let payload;
  try {
    payload = await verifyJWT(token, env.JWT_SECRET);
  } catch {
    return null;
  }
  if (!payload || !payload.uid) return null;

  try {
    if (payload.sid) {
      const sesion = await env.DB.prepare(
        "SELECT revoked_at FROM sessions WHERE id = ? AND user_id = ?"
      ).bind(payload.sid, payload.uid).first();
      if (sesion && sesion.revoked_at) return null;
    }
    const usuario = await env.DB.prepare(
      "SELECT id FROM users WHERE id = ? AND activo = 1"
    ).bind(payload.uid).first();
    if (!usuario) return null;
  } catch (err) {
    console.error("requireAuthTienda: no se pudo comprobar la sesión/usuario:", err.message);
    return null;
  }
  return payload;
}

// ---------- Colaboradores: roles y permisos ----------
// Un "colaborador" es cualquier cuenta de users.rol distinta de lector:
// 'admin', 'redactor' o 'fotografo'. Este bloque centraliza en un solo
// sitio qué puede hacer cada rol, para no tener que repetir
// "payload.rol !== 'admin'" (u otras comparaciones sueltas) por todo el
// archivo cada vez que se añade o se matiza un permiso.
//
// IMPORTANTE: de momento este bloque solo AÑADE helpers; no cambia
// ningún comportamiento existente todavía. Los endpoints se migran a
// usar estas funciones en fases posteriores, endpoint a endpoint, para
// poder revisar cada cambio de permisos por separado.
const ROLES_VALIDOS = ["admin", "redactor", "fotografo"];

// Normaliza un rol recibido del cliente (p. ej. al crear/editar un
// usuario): si no es uno de los tres válidos, cae a 'redactor' como
// hacía el código anterior (mantiene el comportamiento por defecto de
// siempre; antes solo existían 'admin' y 'redactor' así que cualquier
// valor no-admin caía en redactor).
function normalizarRolColaborador(rol) {
  return ROLES_VALIDOS.includes(rol) ? rol : "redactor";
}

function esAdmin(payload) {
  return !!payload && payload.rol === "admin";
}

function esRedactor(payload) {
  return !!payload && payload.rol === "redactor";
}

function esFotografo(payload) {
  return !!payload && payload.rol === "fotografo";
}

// Noticias, crónicas, artículos de opinión, entrevistas, resultados,
// minuto a minuto, "Última hora", etc.: contenido editorial de toda la
// vida. Admin y redactor pueden acceder (con los matices de nivel/
// autoría ya existentes en cada endpoint); fotógrafo NO.
function puedeGestionarContenidoEditorial(payload) {
  return esAdmin(payload) || esRedactor(payload);
}

// ---------- Noticias rápidas: validación del body ----------
// Una noticia rápida lleva SOLO tres campos, todos obligatorios: foto
// (URL ya subida con /api/subir-imagen), titular y subtitular.
const NOTICIA_RAPIDA_TITULO_MAX = 120;
const NOTICIA_RAPIDA_SUBTITULO_MAX = 220;

function validarNoticiaRapida(body) {
  const titulo = normalizarTexto(body && body.titulo);
  const subtitulo = normalizarTexto(body && body.subtitulo);
  const imagenUrl = normalizarTexto(body && body.imagen_url);
  if (!titulo) return { error: "Falta el titular" };
  if (titulo.length > NOTICIA_RAPIDA_TITULO_MAX) {
    return { error: `El titular es demasiado largo (máximo ${NOTICIA_RAPIDA_TITULO_MAX} caracteres, tiene ${titulo.length})` };
  }
  if (!subtitulo) return { error: "Falta el subtitular" };
  if (subtitulo.length > NOTICIA_RAPIDA_SUBTITULO_MAX) {
    return { error: `El subtitular es demasiado largo (máximo ${NOTICIA_RAPIDA_SUBTITULO_MAX} caracteres, tiene ${subtitulo.length})` };
  }
  if (!imagenUrl) return { error: "Falta la foto" };
  if (imagenUrl.length > 1000 || !/^https?:\/\//i.test(imagenUrl)) {
    return { error: "La foto no es válida: súbela de nuevo" };
  }
  // Punto de foco de la foto ("X% Y%"): qué parte no se debe recortar
  // nunca en las tarjetas. Si falta o no es válido, se centra.
  const imagenFoco = normalizarFoco(body && body.imagen_foco);
  return { titulo, subtitulo, imagenUrl, imagenFoco };
}

// Galería/imágenes: tabla "media" y (fases siguientes) galería de
// partido. Admin y fotógrafo pueden subir/gestionar; redactor puede
// consultar para adjuntar a sus noticias pero no sube como fotógrafo
// (esto se termina de definir en el Bloque B, ver plan de fases).
function puedeGestionarGaleria(payload) {
  return esAdmin(payload) || esFotografo(payload);
}

// ---------- Bloque B, Fase 12: adjuntar galería/imágenes sueltas a una noticia ----------
// Tabla puente "article_media" (ver migracion_article_media.sql): guarda,
// para cada noticia/crónica, qué imágenes de "media" se han vinculado
// como galería adicional (aparte de "imagenes", que son las fotos
// insertadas dentro del propio cuerpo del texto — ver normalizarImagenes).
// Se admite mandar la selección de dos formas, que se pueden combinar:
//  - body.galeria_resultado_id: vuelca TODA la galería de ese partido
//    (match_gallery) en el momento de guardar, en su mismo orden.
//  - body.media_ids: lista de ids de "media" sueltos, elegidos a mano en
//    el banco general (no necesariamente ligados a ningún partido).
// Se resuelve a una lista final de media_ids (sin duplicados, en el
// orden en que deben aparecer) y se sustituye por completo la fila de
// article_media de esta noticia: es más simple que calcular altas/bajas
// y aquí el volumen por noticia es pequeño (unas pocas decenas de fotos
// como mucho), así que no compensa la complejidad de un diff.
async function sincronizarArticleMedia(env, articleId, body) {
  if (!Object.prototype.hasOwnProperty.call(body, "media_ids") && !Object.prototype.hasOwnProperty.call(body, "galeria_resultado_id")) {
    // Ninguno de los dos campos viene en el body: no se toca la galería
    // ya guardada (permite editar la noticia sin mandar siempre la
    // galería completa, igual que el resto de campos opcionales del PUT).
    return;
  }
  const idsFinales = [];
  const vistos = new Set();
  const agregar = (id) => {
    const n = parseInt(id, 10);
    if (Number.isInteger(n) && !vistos.has(n)) { vistos.add(n); idsFinales.push(n); }
  };

  if (body.galeria_resultado_id) {
    const resultId = parseInt(body.galeria_resultado_id, 10);
    if (Number.isInteger(resultId)) {
      const { results: galeriaPartido } = await env.DB.prepare(
        "SELECT media_id FROM match_gallery WHERE result_id = ? ORDER BY orden ASC, created_at ASC"
      ).bind(resultId).all();
      galeriaPartido.forEach((g) => agregar(g.media_id));
    }
  }
  if (Array.isArray(body.media_ids)) {
    body.media_ids.forEach((id) => agregar(id));
  }

  await env.DB.prepare("DELETE FROM article_media WHERE article_id = ?").bind(articleId).run();
  for (let i = 0; i < idsFinales.length; i++) {
    // Un id de media que ya no exista (borrado mientras tanto) se ignora
    // en vez de romper el guardado de la noticia entera.
    try {
      await env.DB.prepare(
        "INSERT INTO article_media (article_id, media_id, orden) VALUES (?, ?, ?)"
      ).bind(articleId, idsFinales[i], i).run();
    } catch (err) { /* media_id inexistente: se ignora esta fila */ }
  }
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

// Variante de requireAuth SOLO para subidas de archivos (POST /api/media y
// POST /api/subir-imagen).
//
// Problema que resuelve: requireAuth rechaza con 401 "No autorizado" cuando
// la fila de la sesión no se encuentra en la tabla "sessions" y el JWT tiene
// más de 5 minutos. Esa fila puede faltar por motivos que NO son una sesión
// cerrada (réplica con retraso entre D1 y Postgres, sesión creada en el otro
// backend, etc.). En una tanda larga de fotos esto hacía que las primeras
// subieran bien y, pasados unos minutos, el resto salieran "No autorizado"
// con una sesión perfectamente válida.
//
// Aquí se distingue entre:
//   - fila de sesión AUSENTE  -> no se considera motivo de rechazo.
//   - fila de sesión REVOCADA -> se rechaza (cerrar sesión en otro
//                                 dispositivo sigue funcionando).
// Siguen siendo obligatorios: JWT firmado y sin caducar, y que el usuario
// exista y esté activo (activo = 1).
async function requireAuthSubida(request, env) {
  const estricto = await requireAuth(request, env);
  if (estricto) return estricto;

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  let payload;
  try {
    payload = await verifyJWT(token, env.JWT_SECRET);
  } catch {
    return null;
  }
  if (!payload || !payload.uid) return null;

  try {
    if (payload.sid) {
      const sesion = await env.DB.prepare(
        "SELECT revoked_at FROM sessions WHERE id = ? AND user_id = ?"
      ).bind(payload.sid, payload.uid).first();
      if (sesion && sesion.revoked_at) return null;
    }
    const usuario = await env.DB.prepare(
      "SELECT id FROM users WHERE id = ? AND activo = 1"
    ).bind(payload.uid).first();
    if (!usuario) return null;
  } catch (err) {
    console.error("requireAuthSubida: no se pudo comprobar la sesión/usuario:", err.message);
    return null;
  }
  return payload;
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
// Google Identity Services entrega en el navegador un id_token: un JWT
// firmado por Google con RS256 (no HS256 como los nuestros, ver
// createJWT/verifyJWT arriba). Para confiar en él sin ninguna librería
// externa, se valida su firma contra las claves públicas de Google
// (JWKS, rotan de vez en cuando, por eso se piden en cada arranque de
// caché) y se comprueban los campos estándar: que el "issuer" sea
// realmente Google, que la audiencia sea nuestro Client ID (para que un
// id_token emitido para OTRA web no sirva aquí) y que no haya caducado.
//
// Cacheado en memoria del propio Worker (dura mientras el isolate esté
// vivo, normalmente minutos-horas): evita pedir las claves a Google en
// cada login sin arriesgarse a quedarse con una clave ya rotada, porque
// si la verificación falla por "kid" desconocida se vuelve a pedir una
// vez más por si acaso (ver getGoogleJWK).
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

  // "iss" puede venir con o sin "https://" según el flujo de Google.
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

  return payload; // incluye email, email_verified, name, picture, sub...
}

// ---------- Verificación del id_token de Microsoft (login de lectores) ----------
// Mismo patrón que verificarGoogleIdToken: Microsoft Identity Platform
// (MSAL.js en el navegador) entrega un id_token JWT firmado con RS256.
// Se valida su firma contra las claves públicas de Microsoft (JWKS del
// endpoint "common", válido tanto para cuentas personales como de
// organización/Azure AD) y se comprueban issuer, audiencia y caducidad.
//
// El "iss" de Microsoft incluye el tenant ID (algo como
// "https://login.microsoftonline.com/<tenant>/v2.0"), así que a
// diferencia de Google no se compara con un valor fijo: basta con que
// empiece por ese prefijo común a cualquier tenant, ya que la app está
// registrada como "multitenant + cuentas personales" (ver README de
// despliegue). El identificador estable del usuario es "oid" cuando
// existe (recomendado por Microsoft para todos los flujos) y si no
// "sub" como respaldo.
//
// Cacheado en memoria del propio Worker igual que con Google: evita
// pedir las claves a Microsoft en cada login, y si la verificación
// falla por "kid" desconocida se vuelve a pedir una vez más por si la
// clave ha rotado.
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

  // El issuer lleva el tenant id en medio (login.microsoftonline.com/<tenant>/v2.0),
  // por eso se comprueba el prefijo/sufijo en vez de un valor exacto.
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

  // Normaliza el email: algunas cuentas Microsoft solo traen
  // "preferred_username" (que para cuentas personales suele ser el
  // correo real) y no "email".
  if (!payload.email && payload.preferred_username) payload.email = payload.preferred_username;

  return payload; // incluye email, name, oid, sub, preferred_username...
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

// Bots/crawlers/herramientas SEO conocidos que SÍ ejecutan JavaScript
// (headless Chrome, previsualizadores de enlaces, escáneres de SEO) y
// por tanto disparan analiticas-tracking.js igual que una persona real,
// inflando "páginas vistas" sin que sean lectores. Los crawlers básicos
// (Googlebot clásico, sin JS) ya no cuentan porque nunca llegan a cargar
// el script; esta lista cubre a los que sí lo hacen. Coincidencia por
// substring en minúsculas, sin distinguir mayúsculas.
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
  if (!ua) return true; // sin User-Agent: casi siempre un script, nunca un navegador real
  return PATRONES_USER_AGENT_BOT.some((p) => ua.includes(p));
}

// ---------- Cuentas de Cloudinary: principal + secundaria (respaldo) ----------
// El plan gratis de Cloudinary tiene un tope de créditos (almacenamiento +
// ancho de banda + transformaciones). Cuando la cuenta principal se queda
// sin cupo, las subidas nuevas pasan solas a una segunda cuenta de
// Cloudinary. La secundaria es OPCIONAL: si no están sus tres variables,
// todo funciona exactamente como antes con una sola cuenta.
//   Principal:   CLOUDINARY_CLOUD_NAME   / CLOUDINARY_API_KEY   / CLOUDINARY_API_SECRET
//   Secundaria:  CLOUDINARY_CLOUD_NAME_2 / CLOUDINARY_API_KEY_2 / CLOUDINARY_API_SECRET_2
// Los archivos ya subidos NO se mueven: su URL guarda el cloud name de la
// cuenta donde viven, así que se siguen viendo igual, y al borrar se
// elige la cuenta correcta a partir de esa URL.
function cuentasCloudinary(env) {
  const cuentas = [];
  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    cuentas.push({ cloudName: env.CLOUDINARY_CLOUD_NAME, apiKey: env.CLOUDINARY_API_KEY, apiSecret: env.CLOUDINARY_API_SECRET });
  }
  if (env.CLOUDINARY_CLOUD_NAME_2 && env.CLOUDINARY_API_KEY_2 && env.CLOUDINARY_API_SECRET_2) {
    cuentas.push({ cloudName: env.CLOUDINARY_CLOUD_NAME_2, apiKey: env.CLOUDINARY_API_KEY_2, apiSecret: env.CLOUDINARY_API_SECRET_2 });
  }
  return cuentas;
}

// "https://res.cloudinary.com/<cloud_name>/image/upload/..." -> "<cloud_name>"
function cloudNameDeUrlCloudinary(url) {
  const m = /res\.cloudinary\.com\/([^\/]+)\//.exec(url || "");
  return m ? m[1] : null;
}

// ¿Este fallo de Cloudinary se debe a que ESA CUENTA no puede aceptar más
// (sin cupo, desactivada, credenciales rechazadas, límite de peticiones o
// caída del servicio)? Si es así merece la pena probar con la otra cuenta.
// Si el problema es el propio archivo (demasiado pesado, demasiados
// megapíxeles, formato dañado...) NO: fallaría igual en la otra cuenta.
function esFalloDeCuentaCloudinary(status, mensaje) {
  if (status === undefined) return true; // error de red: no llegó a responder
  if (status === 401 || status === 403 || status === 420 || status === 429 || status >= 500) return true;
  const m = (mensaje || "").toLowerCase();
  // Primero las señales claras de que la CUENTA no puede aceptar más (un
  // mensaje tipo "Maximum storage exceeded" contiene "maximum" pero es de
  // cuota, no del archivo), y solo después las del propio archivo.
  if (/quota|credit|storage|disabled|blocked|suspended|usage/.test(m)) return true;
  if (/file size|megapixel|pixel|dimension|resolution|maximum|too large|invalid|unsupported|corrupt/.test(m)) return false;
  return /exceed|limit/.test(m);
}

// Sube un archivo a UNA cuenta concreta de Cloudinary sin ninguna
// transformación (se conserva la calidad original).
async function subirACloudinaryEnCuenta(cuenta, fileBytes, mimeType, nombreArchivo) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await sha1Hex(`timestamp=${timestamp}${cuenta.apiSecret}`);

  const form = new FormData();
  form.append("file", new Blob([fileBytes], { type: mimeType }));
  form.append("api_key", cuenta.apiKey);
  form.append("timestamp", timestamp.toString());
  form.append("signature", signature);

  const resp = await fetch(`https://api.cloudinary.com/v1_1/${cuenta.cloudName}/auto/upload`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    const cuerpoError = await resp.text();
    console.error(`Cloudinary (${cuenta.cloudName}) respondió ${resp.status} al subir "${nombreArchivo || "(sin nombre)"}" (${mimeType || "tipo desconocido"}): ${cuerpoError}`);
    const errCloudinary = new Error(`Cloudinary (${resp.status}): ${cuerpoError}`);
    errCloudinary.cloudinaryStatus = resp.status;
    // Mensaje legible que da Cloudinary (viene como {"error":{"message":"..."}}).
    try { errCloudinary.cloudinaryMensaje = JSON.parse(cuerpoError)?.error?.message || null; } catch {}
    throw errCloudinary;
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
  return { publicId: data.public_id, resourceType: data.resource_type, url, cloudName: cuenta.cloudName };
}

// Sube un archivo a Cloudinary. Prueba primero la cuenta principal y, si
// esta no puede aceptarlo (sin espacio, desactivada, etc.), reintenta
// automáticamente con la secundaria. Devuelve
// { publicId, resourceType, url, cloudName }.
async function subirACloudinary(env, fileBytes, mimeType, nombreArchivo) {
  const cuentas = cuentasCloudinary(env);
  if (!cuentas.length) throw new Error("Cloudinary no está configurado (faltan CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET)");
  let ultimoError;
  for (let i = 0; i < cuentas.length; i++) {
    try {
      return await subirACloudinaryEnCuenta(cuentas[i], fileBytes, mimeType, nombreArchivo);
    } catch (err) {
      ultimoError = err;
      const hayOtraCuenta = i < cuentas.length - 1;
      if (!hayOtraCuenta || !esFalloDeCuentaCloudinary(err.cloudinaryStatus, err.cloudinaryMensaje)) throw err;
      console.warn(`Cloudinary: la cuenta "${cuentas[i].cloudName}" no puede aceptar la subida (${err.cloudinaryStatus ?? "sin respuesta"}); se prueba con la cuenta "${cuentas[i + 1].cloudName}"`);
    }
  }
  throw ultimoError;
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

// D1 admite como máximo 100 variables enlazadas (?) por consulta: un
// "WHERE id IN (?,?,?,...)" con más de 100 ids falla con "too many SQL
// variables". Esta función parte la lista en lotes de 90, lanza las
// consultas y devuelve todas las filas juntas. `construirSql` recibe los
// marcadores ("?,?,?") de cada lote y devuelve el SQL completo.
async function selectPorLotesDeIds(env, ids, construirSql) {
  const TAM_LOTE = 90;
  const lotes = [];
  for (let i = 0; i < ids.length; i += TAM_LOTE) lotes.push(ids.slice(i, i + TAM_LOTE));
  const respuestas = await Promise.all(
    lotes.map((lote) =>
      env.DB.prepare(construirSql(lote.map(() => "?").join(","))).bind(...lote).all()
    )
  );
  return respuestas.flatMap((r) => r.results || []);
}

// Hash SHA-256 (en hexadecimal) del contenido binario de un archivo.
// Se usa para detectar duplicados por contenido real, no por nombre: dos
// archivos con el mismo hash son bit a bit idénticos aunque se hayan
// renombrado o se les haya cambiado el título/descripción al subirlos.
async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function borrarDeCloudinary(env, publicId, resourceType, cloudName) {
  // Se borra en la cuenta donde vive el archivo (cloudName, sacado de su
  // URL o de la propia subida). Si no se sabe cuál es, se prueba en todas:
  // destroy en una cuenta que no lo tiene responde "not found" sin más.
  const cuentas = cuentasCloudinary(env);
  const coincidentes = cloudName ? cuentas.filter((c) => c.cloudName === cloudName) : cuentas;
  // Si este backend no tiene configurada la cuenta donde vive el archivo
  // (p. ej. le faltan las variables _2), antes no se borraba nada y sin
  // avisar; ahora se prueba en las que sí tiene (destroy en una cuenta que
  // no lo tiene responde "not found" sin más).
  const candidatas = coincidentes.length ? coincidentes : cuentas;
  let respuesta = null;
  for (const cuenta of candidatas) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sha1Hex(`public_id=${publicId}&timestamp=${timestamp}${cuenta.apiSecret}`);

    const form = new FormData();
    form.append("public_id", publicId);
    form.append("api_key", cuenta.apiKey);
    form.append("timestamp", timestamp.toString());
    form.append("signature", signature);

    respuesta = await fetch(`https://api.cloudinary.com/v1_1/${cuenta.cloudName}/${resourceType}/destroy`, {
      method: "POST",
      body: form,
    });
  }
  return respuesta;
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
        const foco = normalizarFoco(item.foco);
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

// ---------- Fusión de las previas / crónicas del mismo partido (v2) ----------
// Cuando hay DOS O MÁS previas (o crónicas) PUBLICADAS del mismo partido, la
// web las muestra automáticamente como UNA sola página, dividida en una
// sección por redactor: cada sección con su <h2> (SIEMPRE el nombre del equipo del
// que habla; nunca "La visión de..."), sus fotos recolocadas DENTRO de su sección
// (todas las imágenes de una sección terminan antes de empezar la siguiente), y
// la firma conjunta de todos los autores. Es una fusión al LEER (no se toca la
// base de datos, así que NO hace falta ninguna migración): cada redactor sigue
// teniendo su artículo propio (y sus publicaciones cuentan para su nivel), y si
// una se despublica o se borra, las demás vuelven a verse como correspondan.
//  - La "primera" es la de id más bajo (la primera en crearse): su URL, su
//    título y su fecha son los de la página fusionada. Las demás redirigen a ella.
//  - Qué sección va primero se decide leyendo de qué equipo habla cada texto
//    (título, subtítulo y cuerpo, comparados con los nombres del partido). Con
//    dos textos, si solo uno se identifica, el otro es del equipo contrario.
//    Sin pistas claras se mantiene el orden de creación y se titulan por autor.
//  - Las demás quedan fuera de listados, sitemap, RSS, boletín, widgets, ficha
//    del partido y página de autor (esta última enlaza a la fusionada).
//  - Los comentarios de todas se leen juntos en la página fusionada.
//  - El panel pide por id y sigue viendo cada artículo por separado para
//    poder editarlo (con una insignia "Fusionada" en el listado).
const FUSION_TIPOS = ["previa", "cronica"];
const FUSION_MAX_ARTICULOS = 20;
const SQL_OCULTAR_SEGUNDO_DE_FUSION = ` AND NOT (tipo IN ('previa', 'cronica') AND resultado_id IS NOT NULL AND EXISTS (SELECT 1 FROM articles b WHERE b.resultado_id = articles.resultado_id AND b.tipo = articles.tipo AND b.publicado = 1 AND b.id < articles.id))`;

function escaparHtmlFusion(texto) {
  return String(texto ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Cuenta los bloques de primer nivel de un trozo de HTML (lo mismo que
// "children" en el navegador): se usa para recolocar las fotos "tras el
// párrafo N" de cada sección, que cuenta desde su propio texto.
function contarBloquesHtmlFusion(html) {
  const VACIAS = new Set(["br", "img", "hr", "input", "meta", "link", "wbr", "source"]);
  let profundidad = 0;
  let bloques = 0;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    const cierre = m[1] === "/";
    const nombre = m[2].toLowerCase();
    const autocierre = m[3] === "/" || VACIAS.has(nombre);
    if (cierre) {
      profundidad = Math.max(0, profundidad - 1);
    } else {
      if (profundidad === 0) bloques++;
      if (!autocierre) profundidad++;
    }
  }
  return bloques;
}

// Clave para comparar fotos: la misma foto de Cloudinary puede llegar con otra
// transformación (w_900, f_auto...), otra versión (v123) o con query string, y
// con la URL exacta no se detectaría como repetida. Para Cloudinary se compara
// cuenta + public_id (sin extensión); para el resto, la URL sin query ni hash.
function claveImagenFusion(url) {
  const u = String(url ?? "").trim();
  if (!u) return "";
  const limpia = u.split(/[?#]/)[0];
  const m = limpia.match(/^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(?:image|video)\/upload\/(.+)$/i);
  if (!m) return limpia.replace(/^http:/i, "https:");
  const partes = m[2].split("/");
  while (partes.length > 1 && (/^v\d+$/.test(partes[0]) || /^[a-z]{1,3}_[^/]+$/i.test(partes[0]) || partes[0].includes(","))) partes.shift();
  return `${m[1]}/${partes.join("/").replace(/\.[a-z0-9]{2,4}$/i, "")}`;
}

function parseImagenesFusion(raw) {
  try { return normalizarImagenes(raw ? JSON.parse(raw) : []); } catch { return []; }
}

// ----- Detección de a qué equipo se refiere cada texto -----
const FUSION_PALABRAS_GENERICAS = new Set(["club", "real", "deportivo", "deportiva", "futbol", "sociedad", "sad", "balompie", "union"]);

function normalizarTextoFusion(texto) {
  return String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function textoPlanoFusion(html) {
  return normalizarTextoFusion(String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " "));
}

// Apodos muy usados que la raíz no cubre ("Barça" no empieza por "barcel").
const FUSION_ALIAS_CLAVES = { barcelona: ["barca*"] };

// Claves distintivas de un equipo: palabras de 3+ letras que no sean
// genéricas ("club", "real"...). Las largas se comparan por una raíz de hasta
// 6 letras ("castel*" y no "cast*", para no confundir "Castellón" con
// "castigo" o "casta"); las de 5 letras por su raíz de 4 ("ceut*" cubre Ceuta,
// ceutí, ceutíes). Acabadas en "*" = raíz.
function clavesEquipoFusion(nombre) {
  const claves = [];
  for (const t of normalizarTextoFusion(nombre).split(/[^a-z0-9]+/)) {
    if (t.length < 3 || /^\d+$/.test(t) || FUSION_PALABRAS_GENERICAS.has(t)) continue;
    claves.push(t.length >= 6 ? `${t.slice(0, Math.min(t.length - 2, 6))}*` : t.length === 5 ? `${t.slice(0, 4)}*` : t);
    if (FUSION_ALIAS_CLAVES[t]) claves.push(...FUSION_ALIAS_CLAVES[t]);
  }
  return [...new Set(claves)];
}

// Solo las claves que identifican a UN equipo (las que comparten los dos
// nombres, p. ej. "madrid" en "Real Madrid Castilla" - "Atlético Madrid B",
// no sirven para distinguirlos).
function clavesDistintivasFusion(local, visitante) {
  const l = clavesEquipoFusion(local);
  const v = clavesEquipoFusion(visitante);
  const sl = new Set(l);
  const sv = new Set(v);
  return { local: l.filter((c) => !sv.has(c)), visitante: v.filter((c) => !sl.has(c)) };
}

function contarClavesFusion(textoNormalizado, claves, tope = Infinity) {
  let total = 0;
  for (const c of claves) {
    const patron = c.endsWith("*") ? `${c.slice(0, -1)}[a-z0-9]*` : `${c}(?![a-z0-9])`;
    const m = textoNormalizado.match(new RegExp(`(?:^|[^a-z0-9])${patron}`, "g"));
    if (m) total += Math.min(m.length, tope);
  }
  return total;
}

// Apellido (última palabra) de cada jugador, sin tildes. Solo los de 4+ letras.
function clavesJugadoresFusion(listaNombres) {
  const claves = new Set();
  for (const n of listaNombres || []) {
    const toks = normalizarTextoFusion(n).split(/[^a-z0-9]+/).filter(Boolean);
    const ap = toks[toks.length - 1];
    if (ap && ap.length >= 4 && !/^\d+$/.test(ap)) claves.add(ap);
  }
  return claves;
}

// Pistas EXTRA para saber de qué equipo habla cada texto, sacadas de la base
// de datos y dejadas en "nombres":
//  - nombres.clavesJugadores = { local, visitante }: apellidos de los jugadores
//    de cada equipo (alineaciones del partido + jugadores de los eventos del
//    minuto a minuto). Nombrar a los jugadores de un equipo es una señal mucho
//    más fiable que contar cuántas veces sale el nombre del club.
//  - nombres.ladoAutor = { <autor_id>: "local"|"visitante" }: el equipo que
//    sigue o cubre cada redactor (campo "equipo" de su perfil). Es solo un
//    último recurso cuando el texto no deja claro nada.
// Si algo falla no se rompe la página: simplemente se usan menos pistas.
async function cargarPistasFusion(env, resultadoId, articulos, nombres) {
  const norm = (x) => normalizarTextoFusion(x).trim();
  const nl = norm(nombres.local);
  const nv = norm(nombres.visitante);
  try {
    const jl = [];
    const jv = [];
    const { results: alin } = await env.DB.prepare("SELECT equipo, jugadores FROM alineaciones WHERE result_id = ?").bind(resultadoId).all();
    for (const a of alin || []) {
      const e = norm(a.equipo);
      const lado = e === nl ? "local" : e === nv ? "visitante" : null;
      if (!lado) continue;
      let js = [];
      try { js = JSON.parse(a.jugadores || "[]"); } catch { js = []; }
      for (const j of js) (lado === "local" ? jl : jv).push(j && j.nombre);
    }
    const { results: evs } = await env.DB.prepare(
      "SELECT equipo, jugador, jugador_sale, jugador_asistencia FROM match_events WHERE resultado_id = ? AND equipo IN ('local','visitante')"
    ).bind(resultadoId).all();
    for (const ev of evs || []) {
      const dest = ev.equipo === "local" ? jl : jv;
      dest.push(ev.jugador, ev.jugador_sale, ev.jugador_asistencia);
    }
    const kl = clavesJugadoresFusion(jl.filter(Boolean));
    const kv = clavesJugadoresFusion(jv.filter(Boolean));
    nombres.clavesJugadores = { local: [...kl].filter((k) => !kv.has(k)), visitante: [...kv].filter((k) => !kl.has(k)) };
  } catch (e) {
    console.error("Fusión: no se pudieron leer los jugadores", e);
  }
  try {
    const ids = [...new Set(articulos.map((a) => a.autor_id).filter(Boolean))];
    if (ids.length) {
      const { results: us } = await env.DB.prepare(`SELECT id, equipo FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
      nombres.ladoAutor = {};
      for (const u of us || []) {
        const lados = new Set(parsearEquipos(u.equipo).map(norm).map((c) => (c === nl ? "local" : c === nv ? "visitante" : null)).filter(Boolean));
        if (lados.size === 1) nombres.ladoAutor[u.id] = [...lados][0];
      }
    }
  } catch (e) {
    console.error("Fusión: no se pudo leer el equipo de los autores", e);
  }
}

// { l, v }: puntos a favor de cada equipo. Cuentan el nombre del club (más
// peso en título y subtítulo) y los apellidos de sus jugadores en el texto.
function puntuarLadosFusion(art, claves, clavesJug) {
  const campos = [
    [normalizarTextoFusion(art.titulo), 6],
    [normalizarTextoFusion(art.subtitulo), 4],
    [textoPlanoFusion(art.contenido).slice(0, 700), 3],
    [textoPlanoFusion(art.contenido), 1],
  ];
  let l = 0;
  let v = 0;
  for (const [txt, peso] of campos) {
    if (!txt) continue;
    l += peso * contarClavesFusion(txt, claves.local);
    v += peso * contarClavesFusion(txt, claves.visitante);
  }
  if (clavesJug) {
    const cuerpo = textoPlanoFusion(art.contenido);
    // Tope por jugador para que uno solo (el del hat-trick) no decida todo.
    l += 2 * contarClavesFusion(cuerpo, clavesJug.local || [], 4);
    v += 2 * contarClavesFusion(cuerpo, clavesJug.visitante || [], 4);
  }
  return { l, v };
}

// Devuelve [{ art, i, lado, reparto }] en el orden en que irán las secciones.
// "reparto" va de -1 (todo del visitante) a 1 (todo del local); null si el
// texto no nombra a ninguno. Para decidir se COMPARAN los textos entre sí
// (¿cuál se inclina más hacia el local?), no cada uno por separado: así, un
// texto que habla del Castellón pero cita mucho al rival no se confunde, porque
// el otro texto se inclina todavía más hacia el rival.
function ordenarSeccionesFusion(articulos, nombres) {
  const claves = clavesDistintivasFusion(nombres.local, nombres.visitante);
  const items = articulos.map((art, i) => {
    const { l, v } = puntuarLadosFusion(art, claves, nombres.clavesJugadores);
    const total = l + v;
    return { art, i, lado: null, reparto: total > 0 ? (l - v) / total : null };
  });
  const contrario = (x) => (x === "local" ? "visitante" : "local");
  const ladoDe = (r, umbral) => (r != null && Math.abs(r) >= umbral ? (r > 0 ? "local" : "visitante") : null);

  if (items.length === 2) {
    const [a, b] = items;
    if (a.reparto != null && b.reparto != null) {
      const margen = a.reparto - b.reparto;
      if (Math.abs(margen) >= 0.3) { a.lado = margen > 0 ? "local" : "visitante"; b.lado = contrario(a.lado); }
    } else if (a.reparto != null || b.reparto != null) {
      const [con, sin] = a.reparto != null ? [a, b] : [b, a];
      const lado = ladoDe(con.reparto, 0.3);
      if (lado) { con.lado = lado; sin.lado = contrario(lado); }
    }
  } else {
    for (const x of items) x.lado = ladoDe(x.reparto, 0.4);
  }

  // Último recurso, solo para lo que el texto no ha aclarado: el equipo que
  // sigue el redactor. Nunca se inventa un reparto por orden de creación.
  const delAutor = (x) => (nombres.ladoAutor && x.art.autor_id ? nombres.ladoAutor[x.art.autor_id] || null : null);
  if (items.length === 2 && !items[0].lado && !items[1].lado) {
    const [a, b] = items;
    const pa = delAutor(a);
    const pb = delAutor(b);
    if (pa && (!pb || pb !== pa)) { a.lado = pa; b.lado = contrario(pa); }
    else if (pb && !pa) { b.lado = pb; a.lado = contrario(pb); }
  } else if (items.length > 2) {
    for (const x of items) if (!x.lado) x.lado = delAutor(x);
  }

  const rango = (x) => (x.lado === "local" ? 0 : x.lado === "visitante" ? 1 : 2);
  return items.sort((x, y) => rango(x) - rango(y) || x.i - y.i);
}

function tituloSeccionFusion(item, items, nombres, idioma) {
  const equipo = item.lado === "local" ? nombres.local : item.lado === "visitante" ? nombres.visitante : null;
  const autor = item.art.autor_nombre || "";
  // Nunca se pone un equipo por suerte: si no se sabe de cuál habla, se
  // titula con el partido, que no puede estar equivocado.
  const titulo = equipo || `${nombres.local} - ${nombres.visitante}`;
  const repetido = items.filter((x) => x.lado === item.lado).length > 1;
  return repetido && autor ? `${titulo} · ${autor}` : titulo;
}

// ----- Búsqueda del grupo de un partido -----
// { rol: "primero"|"otro", primero: {id, slug, categoria}, grupo: [{id, slug, categoria}, ...] }
// si el artículo forma parte de una fusión (2 o más publicados del mismo
// partido y tipo), o null si no.
async function buscarGrupoFusionPartido(env, article) {
  if (!article || !article.resultado_id || !FUSION_TIPOS.includes(article.tipo)) return null;
  const { results } = await env.DB.prepare(
    `SELECT id, slug, categoria FROM articles WHERE resultado_id = ? AND tipo = ? AND publicado = 1 ORDER BY id ASC LIMIT ?`
  ).bind(article.resultado_id, article.tipo, FUSION_MAX_ARTICULOS).all();
  if (!results || results.length < 2) return null;
  if (!results.some((r) => r.id === article.id)) return null;
  const primero = results[0];
  return { rol: article.id === primero.id ? "primero" : "otro", primero, grupo: results };
}

// Ids de todos los artículos que se muestran juntos con este (incluido él).
// Sirve para unir los comentarios de la página fusionada.
async function idsGrupoFusion(env, articleId) {
  const art = await env.DB.prepare("SELECT id, tipo, resultado_id, publicado FROM articles WHERE id = ?").bind(articleId).first();
  if (!art || !art.publicado) return [articleId];
  const grupo = await buscarGrupoFusionPartido(env, art);
  return grupo ? grupo.grupo.map((r) => r.id) : [articleId];
}

// Página de autor: sus previas/crónicas que se muestran fusionadas enlazan
// a la página fusionada (slug de la primera) y no salen duplicadas.
async function remapearSlugsFusion(env, articulos) {
  const candidatos = (articulos || []).filter((a) => a && a.resultado_id && FUSION_TIPOS.includes(a.tipo));
  if (!candidatos.length) return articulos;
  const ids = [...new Set(candidatos.map((a) => a.resultado_id))];
  const { results: primeros } = await env.DB.prepare(
    `SELECT p.id, p.slug, p.tipo, p.resultado_id FROM articles p
     WHERE p.publicado = 1 AND p.tipo IN ('previa', 'cronica') AND p.resultado_id IN (${ids.map(() => "?").join(",")})
       AND NOT EXISTS (SELECT 1 FROM articles b WHERE b.resultado_id = p.resultado_id AND b.tipo = p.tipo AND b.publicado = 1 AND b.id < p.id)`
  ).bind(...ids).all();
  const mapa = new Map((primeros || []).map((p) => [`${p.resultado_id}:${p.tipo}`, p]));
  const vistos = new Set();
  const salida = [];
  for (const a of articulos) {
    const clave = `${a.resultado_id}:${a.tipo}`;
    const p = a.resultado_id && FUSION_TIPOS.includes(a.tipo) ? mapa.get(clave) : null;
    if (p) {
      if (vistos.has(clave)) continue;
      vistos.add(clave);
    }
    salida.push(p && p.id !== a.id ? { ...a, slug: p.slug, fusionada: true } : a);
  }
  return salida;
}

// Mezcla "base" (la primera) con "otros" y deja el resultado en base.
// nombres = { local, visitante }.
function fusionarGrupoDePartido(base, otros, nombres) {
  const secciones = ordenarSeccionesFusion([base, ...otros], nombres);
  const h2 = (nombre) => `<h2>${escaparHtmlFusion(nombre)}</h2>`;

  // Texto: una sección por artículo. Todo se calcula ANTES de tocar base.
  const offsets = [];
  let offset = 0;
  let contenido = "";
  for (const s of secciones) {
    offsets.push(offset);
    contenido += h2(tituloSeccionFusion(s, secciones, nombres, null)) + (s.art.contenido || "");
    offset += 1 + contarBloquesHtmlFusion(s.art.contenido);
  }
  // En cada idioma solo se ofrece la traducción si TODAS están traducidas
  // (si no, se quedaría a medias).
  const traducciones = {};
  for (const idioma of IDIOMAS_TRADUCCION) {
    const campo = `contenido_${idioma}`;
    traducciones[campo] = secciones.every((s) => s.art[campo])
      ? secciones.map((s) => h2(tituloSeccionFusion(s, secciones, nombres, idioma)) + s.art[campo]).join("")
      : null;
  }

  // Fotos: las de cada sección se colocan DENTRO de su propia sección
  // (nunca se cuelan en la siguiente): "tras el párrafo N" se limita a los
  // párrafos de esa sección, y las "al final" / "galería" de una sección que
  // no es la última se cierran al final de su texto, antes del <h2> de la
  // siguiente. Solo la galería de la última sección va en el carrusel final.
  // Las "al inicio" de las secciones que no abren la página pasan a ir justo
  // tras su <h2>. Los collages de cada sección cambian de grupo para no
  // mezclarse con los de otra.
  const vistas = new Set([claveImagenFusion(base.imagen_url)].filter(Boolean));
  const todas = [];
  let portada = base.imagen_url || null;
  const ultima = secciones.length - 1;
  secciones.forEach((s, k) => {
    const off = offsets[k];
    const nb = contarBloquesHtmlFusion(s.art.contenido);
    const tras = (t) => off + 1 + (nb > 0 ? Math.min(Math.max(Number(t) || 1, 1), nb) : 0);
    const alFinal = off + 1 + nb;
    const imgs = parseImagenesFusion(s.art.imagenes).map((f) => {
      const g = { ...f };
      const pos = g.posicion;
      if (pos === "inicio") {
        if (k > 0) {
          g.posicion = g.grupo ? "collage" : "personalizada";
          g.trasParrafo = off + 1;
        }
      } else if (pos === "personalizada" || pos === "collage") {
        g.trasParrafo = tras(g.trasParrafo);
      } else if (pos === "medio") {
        g.posicion = "personalizada";
        g.trasParrafo = tras(g.trasParrafo || Math.ceil(nb / 2));
      } else if (pos === "final") {
        g.posicion = "personalizada";
        g.trasParrafo = alFinal;
      } else if (pos === "galeria" && k < ultima) {
        g.posicion = g.grupo ? "collage" : "personalizada";
        g.trasParrafo = alFinal;
      }
      if (g.posicion === "collage" && g.grupo && k > 0) g.grupo = `fusion${k}-${g.grupo}`;
      return g;
    });
    for (const f of imgs) {
      const clave = claveImagenFusion(f.url);
      if (clave && vistas.has(clave)) continue;
      if (clave) vistas.add(clave);
      todas.push(f);
    }
    if (s.art !== base && s.art.imagen_url && !vistas.has(claveImagenFusion(s.art.imagen_url))) {
      vistas.add(claveImagenFusion(s.art.imagen_url));
      if (!portada) portada = s.art.imagen_url;
      else todas.push({ url: s.art.imagen_url, posicion: "personalizada", trasParrafo: off + 1, foco: "50% 50%" });
    }
  });

  // Firma: todos los autores distintos (coautor_* conserva al segundo para
  // lo que ya lo lee; "firmantes" trae la lista completa).
  const firmantes = [];
  const vistosFirma = new Set();
  const anadirFirma = (id, nombre) => {
    if (!nombre) return;
    const clave = id ? `i${id}` : `n${String(nombre).toLowerCase()}`;
    if (vistosFirma.has(clave)) return;
    vistosFirma.add(clave);
    firmantes.push({ id: id || null, nombre });
  };
  for (const a of [base, ...otros]) { anadirFirma(a.autor_id, a.autor_nombre); anadirFirma(a.coautor_id, a.coautor_nombre); }
  const fichaTecnica = [base, ...otros].map((a) => a.ficha_tecnica).find(Boolean) || null;

  base.contenido = contenido;
  Object.assign(base, traducciones);
  base.imagen_url = portada;
  base.imagenes = todas.length ? JSON.stringify(todas) : null;
  if (!base.coautor_id && !base.coautor_nombre && firmantes[1]) {
    base.coautor_id = firmantes[1].id;
    base.coautor_nombre = firmantes[1].nombre;
  }
  base.firmantes = firmantes;
  if (!base.ficha_tecnica && fichaTecnica) base.ficha_tecnica = fichaTecnica;
  base.fusionado_con_slug = otros[0] ? otros[0].slug : null;
  base.fusion = {
    total: secciones.length,
    secciones: secciones.map((s) => ({ lado: s.lado, reparto: s.reparto == null ? null : Math.round(s.reparto * 100) / 100, autor_nombre: s.art.autor_nombre || null, titulo: s.art.titulo, slug: s.art.slug })),
  };
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

// Devuelve (generándolo si hace falta) el slug de la galería pública de
// un partido: "real-valladolid-lugo-2026-03-10" o, si ya existe otro
// partido igual esa fecha (o sin fecha), con un sufijo numérico o de
// timestamp para desempatar, igual que slugUnico() con los artículos.
// Se genera la primera vez que el partido recibe una foto de galería
// (ver POST /api/media) y a partir de ahí ya no cambia, aunque cambien
// los nombres de los equipos: es un enlace que se puede compartir.
async function slugPartidoUnico(env, resultado) {
  if (resultado.slug) return resultado.slug;
  const fecha = (resultado.fecha_partido || "").slice(0, 10);
  let base = slugify(`${resultado.equipo_local} ${resultado.equipo_visitante} ${fecha}`);
  if (!base) base = `partido-${resultado.id}`;
  let slug = base;
  let intento = 0;
  while (true) {
    const choca = await env.DB.prepare("SELECT id FROM results WHERE slug = ? AND id != ?")
      .bind(slug, resultado.id).first();
    if (!choca) break;
    intento++;
    slug = `${base}-${intento > 1 ? intento : Date.now().toString().slice(-5)}`;
  }
  await env.DB.prepare("UPDATE results SET slug = ? WHERE id = ?").bind(slug, resultado.id).run();
  return slug;
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

const CONTENIDO_MIN = 1500;
const CONTENIDO_MAX = 8000;

// ---------- Sistema de niveles y recompensas ----------
// Umbrales de publicaciones (contenido PUBLICADO, no borradores) que
// hacen falta para poder OPTAR a cada nivel. Cumplirlos no sube el
// nivel automáticamente (lo decide un admin, ver PUT /api/users/:id/nivel);
// esto es solo lo que se usa para calcular el progreso y decir si la
// persona "ya está en condiciones de que la evalúen".
//
// "previa" y "analisis" no tienen aquí un umbral propio (se añadieron
// como tipos de contenido nuevos, pero no se ha decidido todavía cuánto
// deben pesar para subir de nivel): se cuentan igualmente en
// contarPublicacionesPorTipo/DeVarios de abajo para que el desglose de
// "Mi progreso" las muestre, pero de momento no hacen falta para
// cumplir ningún nivel. Si en el futuro se quiere que sí cuenten para
// ascender, basta con añadirlas aquí como una clave más.
const NIVELES_REQUISITOS = {
  1: null, // Principiante: nivel inicial, no requiere nada.
  2: { noticia: 20, cronica: 10, opinion: 2, entrevista: 1 },
  3: { noticia: 30, cronica: 15, opinion: 3, entrevista: 1 },
  4: { noticia: 40, cronica: 20, opinion: 4, entrevista: 2 },
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
  // UNION ALL en vez de "WHERE (autor_id = ? OR coautor_id = ?)": el OR
  // entre dos columnas indexadas por separado (idx_articles_autor_publicado
  // / idx_articles_coautor_publicado) impide a SQLite usar ninguno de los
  // dos índices y fuerza un escaneo completo de la tabla en cada llamada
  // -esta consulta se veía en las métricas de D1 de sep-2026 leyendo 112
  // filas por cada fila realmente devuelta-. Con UNION ALL cada mitad usa
  // su propio índice, igual que ya hacía contarPublicacionesPorTipoDeVarios.
  const { results } = await env.DB.prepare(
    `SELECT tipo, COUNT(*) AS total FROM articles
     WHERE autor_id = ? AND publicado = 1
     GROUP BY tipo
     UNION ALL
     SELECT tipo, COUNT(*) AS total FROM articles
     WHERE coautor_id = ? AND publicado = 1
     GROUP BY tipo`
  ).bind(autorId, autorId).all();
  const conteo = { noticia: 0, previa: 0, cronica: 0, analisis: 0, opinion: 0, entrevista: 0 };
  for (const fila of results) {
    if (conteo[fila.tipo] !== undefined) conteo[fila.tipo] += fila.total;
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
  const conteos = new Map(idsUnicos.map((id) => [id, { noticia: 0, previa: 0, cronica: 0, analisis: 0, opinion: 0, entrevista: 0 }]));
  if (idsUnicos.length === 0) return conteos;
  // Se trocea en lotes de 90 ids: D1/SQLite tiene un límite de 100
  // parámetros bind por consulta, y esta plantilla ya reutiliza la
  // misma lista una sola vez (placeholders numerados ?1, ?2... en vez
  // de "?" repetido dos veces), pero si el número de redactores sigue
  // creciendo por encima de 100 volvería a fallar igual. Trocear aquí
  // deja margen sin depender de que nadie recuerde bajar el límite de
  // D1 -- ver el aviso más abajo sobre el incidente que causó esto.
  const LOTE = 90;
  for (let inicio = 0; inicio < idsUnicos.length; inicio += LOTE) {
    const lote = idsUnicos.slice(inicio, inicio + LOTE);
    // Placeholders NUMERADOS (?1, ?2...) en vez de "?" repetido: así la
    // misma lista de ids se puede reutilizar en las dos mitades del UNION
    // ALL (autor_id y coautor_id) pasándola en el bind UNA sola vez, no
    // dos. Con "?" sin numerar y bind(...ids, ...ids) (como estaba antes),
    // una plantilla con más de ~50 usuarios ya superaba el límite de 100
    // parámetros por consulta de D1/SQLite -> la consulta lanzaba una
    // excepción, GET /api/users devolvía 500, y el Worker hacía failover
    // a Railway (que no tiene la columna categorias_fijas en su esquema,
    // así que esa respuesta tampoco la incluía nunca).
    const placeholders = lote.map((_, i) => `?${i + 1}`).join(",");
    const { results } = await env.DB.prepare(
      `SELECT autor_id AS id, tipo, COUNT(*) AS total FROM articles
       WHERE autor_id IN (${placeholders}) AND publicado = 1
       GROUP BY autor_id, tipo
       UNION ALL
       SELECT coautor_id AS id, tipo, COUNT(*) AS total FROM articles
       WHERE coautor_id IN (${placeholders}) AND publicado = 1
       GROUP BY coautor_id, tipo`
    ).bind(...lote).all();
    for (const fila of results) {
      const conteo = conteos.get(fila.id);
      if (conteo && conteo[fila.tipo] !== undefined) conteo[fila.tipo] += fila.total;
    }
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

// ---------- HORARIO DE PUBLICACIÓN (calendario editorial) ----------
// Un admin define, para cada día de la semana, qué tipos de contenido
// se pueden subir ese día (p. ej. "crónicas de la jornada anterior" de
// viernes a miércoles, pero no el jueves). Lo ven todos los redactores en
// Funcionalidades > Horario. Una noticia publicada un día en el que su
// tipo NO está permitido queda marcada como "fuera de calendario"
// (articles.fuera_calendario = 1): se publica igualmente en la web, pero
// no se sube a redes sociales, así que el panel no ofrece "Compartir".
//
// Se guarda en settings (clave 'horario_publicacion') como
//   {"activo": true, "dias": {"lunes": ["noticia","cronica_anterior"], ...}}
// Por defecto (sin nada guardado) el horario está activo y lo que no esté
// marcado cuenta como desactivado. Solo si un admin lo apaga (activo:false)
// se puede subir cualquier tipo cualquier día y nada se marca como fuera de calendario.
const DIAS_HORARIO = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"];
const TIPOS_HORARIO = [
  { id: "noticia", etiqueta: "Noticias" },
  { id: "previa", etiqueta: "Previas" },
  { id: "cronica_actual", etiqueta: "Crónicas de la jornada en curso" },
  { id: "cronica_anterior", etiqueta: "Crónicas de la jornada anterior" },
  { id: "analisis", etiqueta: "Análisis" },
  { id: "opinion", etiqueta: "Opinión" },
  { id: "entrevista", etiqueta: "Entrevistas" },
];
const IDS_TIPOS_HORARIO = TIPOS_HORARIO.map((t) => t.id);
const DIA_SEMANA_POR_INDICE = { Mon: "lunes", Tue: "martes", Wed: "miercoles", Thu: "jueves", Fri: "viernes", Sat: "sabado", Sun: "domingo" };

// Día de la semana y fecha (YYYY-MM-DD) de hoy en hora de Madrid (no en
// UTC: a las 00:30 de un jueves en España, en UTC todavía es miércoles).
function hoyEnMadrid(ahora = new Date()) {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(ahora);
  const get = (t) => (partes.find((p) => p.type === t) || {}).value;
  return { dia: DIA_SEMANA_POR_INDICE[get("weekday")], ymd: `${get("year")}-${get("month")}-${get("day")}` };
}

function normalizarHorarioPublicacion(raw) {
  const dias = {};
  for (const dia of DIAS_HORARIO) {
    const lista = raw && raw.dias && Array.isArray(raw.dias[dia]) ? raw.dias[dia] : [];
    dias[dia] = IDS_TIPOS_HORARIO.filter((id) => lista.includes(id));
  }
  // Sin horario guardado (o ilegible) el horario está ACTIVO: todo lo que no
  // esté marcado en la tabla cuenta como desactivado. Solo se desactiva si un
  // admin lo apaga a propósito (raw.activo === false).
  return { activo: raw ? raw.activo !== false : true, dias };
}

async function obtenerHorarioPublicacion(env) {
  const row = await memoCorta("horario_publicacion", 30000, () => env.DB.prepare("SELECT value FROM settings WHERE key = 'horario_publicacion'").first());
  let raw = null;
  if (row) { try { raw = JSON.parse(row.value); } catch { raw = null; } }
  return normalizarHorarioPublicacion(raw);
}

// ¿La crónica es de una jornada que ya terminó? Se mira el rango de
// fechas de la jornada del partido en jornadas_calendario (terminó si su
// fecha_fin es anterior a hoy). Si esa jornada no tiene rango definido,
// se usa la fecha del propio partido: más de 3 días atrás = anterior.
async function esCronicaDeJornadaAnterior(env, resultadoId, hoyYmd) {
  if (!resultadoId) return false;
  const partido = await env.DB.prepare(
    "SELECT competicion, grupo, jornada, fecha_partido FROM results WHERE id = ?"
  ).bind(resultadoId).first();
  if (!partido) return false;
  const rango = await env.DB.prepare(
    "SELECT fecha_fin FROM jornadas_calendario WHERE competicion = ? AND grupo IS ? AND jornada = ? LIMIT 1"
  ).bind(partido.competicion, partido.grupo || null, partido.jornada).first();
  if (rango && rango.fecha_fin) return rango.fecha_fin < hoyYmd;
  const fechaPartido = String(partido.fecha_partido || "").slice(0, 10);
  if (!fechaPartido) return false;
  const limite = new Date(`${hoyYmd}T00:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() - 3);
  return fechaPartido < limite.toISOString().slice(0, 10);
}

// true si publicar este artículo AHORA cae fuera del horario configurado.
async function estaFueraDeCalendario(env, { tipo, resultado_id, fecha }) {
  const horario = await obtenerHorarioPublicacion(env);
  if (!horario.activo) return false;
  const tipoArticulo = tipo || "noticia";
  const hoy = hoyEnMadrid(fecha || new Date());
  let tipoHorario = tipoArticulo;
  if (tipoArticulo === "cronica") {
    tipoHorario = (await esCronicaDeJornadaAnterior(env, resultado_id, hoy.ymd)) ? "cronica_anterior" : "cronica_actual";
  }
  if (!IDS_TIPOS_HORARIO.includes(tipoHorario)) return false;
  return !horario.dias[hoy.dia].includes(tipoHorario);
}

// Evalúa y guarda la marca en el momento de publicarse (alta, edición que
// publica un borrador, o publicación programada). Devuelve true/false.
async function marcarFueraDeCalendario(env, articuloId, datos) {
  let fuera = false;
  try { fuera = await estaFueraDeCalendario(env, datos); } catch (err) { console.error("horario_publicacion:", err); }
  await env.DB.prepare("UPDATE articles SET fuera_calendario = ?, updated_at = datetime('now') WHERE id = ?").bind(fuera ? 1 : 0, articuloId).run();
  return fuera;
}

// La marca articles.fuera_calendario se guarda una sola vez, al publicar. Eso
// deja sin marcar lo publicado antes de activar el horario (o programado para
// un día no permitido), y el panel seguía ofreciendo "Compartir". Para el
// listado del panel se vuelve a evaluar aquí, al leer, con el horario actual:
// si la fecha de publicación (o la programada) cae en un día en el que su tipo
// no está marcado, se devuelve fuera_calendario = 1. Solo añade marcas; nunca
// quita una que ya estuviera guardada.
function fechaSqlADate(valor) {
  if (!valor) return null;
  let t = String(valor).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += "T12:00:00Z";
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t)) t = t.replace(" ", "T") + (/(Z|[+-]\d{2}:?\d{2})$/.test(t) ? "" : "Z");
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

// Carga en lote (sin una consulta por crónica) lo necesario para saber si
// varias crónicas son de una jornada ya terminada: los partidos por id (en
// trozos, D1 limita a 100 parámetros por consulta) y el calendario de
// jornadas entero (tabla pequeña, una sola lectura). Ver
// aplicarFueraCalendarioEnLectura.
function claveRangoJornada(competicion, grupo, jornada) {
  return `${competicion}|${grupo ? "g:" + grupo : "-"}|${jornada}`;
}

async function cargarContextoJornadas(env, resultadoIds) {
  const ids = [...new Set(resultadoIds.filter(Boolean))];
  const partidos = new Map();
  const rangos = new Map();
  if (!ids.length) return { partidos, rangos };
  for (let i = 0; i < ids.length; i += 80) {
    const trozo = ids.slice(i, i + 80);
    const { results } = await env.DB.prepare(
      `SELECT id, competicion, grupo, jornada, fecha_partido FROM results WHERE id IN (${trozo.map(() => "?").join(",")})`
    ).bind(...trozo).all();
    for (const r of results || []) partidos.set(r.id, r);
  }
  if (partidos.size) {
    const { results } = await env.DB.prepare(
      "SELECT competicion, grupo, jornada, fecha_fin FROM jornadas_calendario"
    ).all();
    for (const r of results || []) {
      const clave = claveRangoJornada(r.competicion, r.grupo, r.jornada);
      if (!rangos.has(clave)) rangos.set(clave, r.fecha_fin);
    }
  }
  return { partidos, rangos };
}

// Misma lógica que esCronicaDeJornadaAnterior, pero sobre datos ya cargados.
function esCronicaDeJornadaAnteriorEnLote(ctx, resultadoId, hoyYmd) {
  if (!resultadoId) return false;
  const partido = ctx.partidos.get(resultadoId);
  if (!partido) return false;
  const fechaFin = ctx.rangos.get(claveRangoJornada(partido.competicion, partido.grupo || null, partido.jornada));
  if (fechaFin) return fechaFin < hoyYmd;
  const fechaPartido = String(partido.fecha_partido || "").slice(0, 10);
  if (!fechaPartido) return false;
  const limite = new Date(`${hoyYmd}T00:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() - 3);
  return fechaPartido < limite.toISOString().slice(0, 10);
}

async function aplicarFueraCalendarioEnLectura(env, articulos) {
  let horario;
  try { horario = await obtenerHorarioPublicacion(env); } catch (err) { console.error("horario_publicacion:", err); return articulos; }
  if (!horario.activo) return articulos;
  const idsCronicas = articulos
    .filter((a) => !a.fuera_calendario && (a.publicado || a.programado_para) && (a.tipo || "noticia") === "cronica" && a.resultado_id)
    .map((a) => a.resultado_id);
  let ctx = { partidos: new Map(), rangos: new Map() };
  if (idsCronicas.length) {
    try { ctx = await cargarContextoJornadas(env, idsCronicas); } catch (err) { console.error("horario_publicacion (jornadas):", err); }
  }
  return articulos.map((a) => {
    if (a.fuera_calendario) return a;
    if (!a.publicado && !a.programado_para) return a; // borrador: aún no se publica
    const fecha = fechaSqlADate(a.publicado ? a.fecha_publicacion : a.programado_para);
    if (!fecha) return a;
    const { dia, ymd } = hoyEnMadrid(fecha);
    const tipoArticulo = a.tipo || "noticia";
    let tipoHorario = tipoArticulo;
    if (tipoArticulo === "cronica") {
      tipoHorario = esCronicaDeJornadaAnteriorEnLote(ctx, a.resultado_id, ymd) ? "cronica_anterior" : "cronica_actual";
    }
    if (!IDS_TIPOS_HORARIO.includes(tipoHorario)) return a;
    return horario.dias[dia].includes(tipoHorario) ? a : { ...a, fuera_calendario: 1 };
  });
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
  // Margen de seguridad al retomar/arrancar con minuto inicial > 0 (p. ej.
  // la 2ª parte tras el descanso, que debe mostrar 45' desde el primer
  // segundo). El reloj se calcula en cada navegador con Math.floor((Date.now()
  // - inicio) / 60000); si el reloj del dispositivo va unos segundos por
  // detrás del servidor, justo al reanudar salía 44:5x y se mostraba el 44.
  // Adelantamos el inicio 10 s para absorber ese desfase.
  const segundosMargen = minutos > 0 ? 10 : 0;
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
  // se arranca desde el cron automático (iniciarPartidosProgramadosCuya-
  // HoraHaLlegado) en vez de desde el formulario manual, esos campos se
  // quedaban en NULL al pasar a "en_juego". calcularClasificacion() en
  // clasificacion.html/calendario.html descarta cualquier partido
  // "en_juego" con goles NULL (no puede calcular puntos provisionales sin
  // marcador), así que ese partido en vivo sencillamente desaparecía de la
  // clasificación en vivo -- mientras que otro partido en vivo arrancado a
  // mano desde el panel (que sí fija 0-0 al pulsar "Iniciar partido") se
  // veía perfectamente. Esto es lo que explicaba que la clasificación en
  // vivo funcionara "solo a veces" o "solo en un grupo": dependía de qué
  // camino había arrancado cada partido en concreto, no de nada relacionado
  // con el grupo/competición. Con COALESCE, cualquier partido que llegue
  // aquí sin marcador queda a 0-0 en vez de NULL, sea cual sea el camino.
  await env.DB.prepare(
    `UPDATE results SET inicio_cronometro_at = datetime('now', ?), cronometro_pausado_en = NULL,
       ajuste_cronometro_minutos = 0, estado = 'en_juego', aviso_desatendido_mitad = NULL,
       goles_local = COALESCE(goles_local, 0), goles_visitante = COALESCE(goles_visitante, 0)
       WHERE id = ?`
  ).bind(`-${minutos * 60 + segundosMargen} seconds`, resultadoId).run();
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
  //
  // Toda la función va envuelta en try/catch, y CADA partido dentro del
  // bucle también por separado: antes, si D1 fallaba (timeout, cuota,
  // error transitorio) al leer los candidatos o al arrancar UN partido
  // concreto, la excepción se propagaba sin capturar. Como esta función
  // se llama desde "scheduled" con ctx.waitUntil(...) y sin ningún
  // try/catch alrededor, ese fallo simplemente desaparecía sin dejar
  // rastro en los logs, y -si el bucle ya había arrancado- todos los
  // partidos que venían DETRÁS del que falló en ese mismo array se
  // quedaban también sin arrancar ese minuto, aunque su hora ya hubiera
  // pasado. Como el cron vuelve a pasar al minuto siguiente, casi
  // siempre se recuperaba solo en la siguiente pasada -- pero eso es
  // justo lo que se estaba viendo: partidos que arrancan "a veces sí, a
  // veces no, sin patrón claro" (depende de en qué partido concreto, o
  // en qué consulta, caía el fallo transitorio de D1 ese minuto). Con
  // cada partido aislado en su propio try/catch, un fallo puntual con
  // UNO no impide que los demás arranquen en la misma pasada, y además
  // queda logueado para poder ver en el dashboard de Cloudflare (Logs)
  // si D1 está fallando de verdad y por qué.
  // Cota superior para no leer TODOS los partidos programados de la
  // temporada en cada tick del cron (1440/dia). fecha_partido es hora de
  // Madrid como texto "YYYY-MM-DDTHH:MM"; Madrid va como mucho 2h por
  // delante de UTC, asi que un partido solo puede haber llegado a su hora
  // si su texto es <= (ahora UTC + 2h). Se usa +3h de margen y la
  // comparacion fina (con el offset real) sigue haciendose en JS mas
  // abajo. No hay cota inferior: un partido que se quedo sin arrancar
  // (caida, error transitorio) se sigue recuperando igual que antes.
  // Los indices (estado, fecha) de migracion_indice_arranque_partidos.sql
  // hacen que esta consulta lea solo los partidos ya vencidos.
  const limiteLocalArranque = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 16);
  let candidatosProgramados = [];
  let candidatosRetrasados = [];
  try {
    ({ results: candidatosProgramados = [] } = await env.DB.prepare(
      `SELECT id, fecha_partido FROM results
       WHERE estado = 'programado' AND fecha_partido IS NOT NULL
         AND length(fecha_partido) = 16
         AND fecha_partido <= ?` // "YYYY-MM-DDTHH:MM": solo si se conoce la hora, no solo la fecha
    ).bind(limiteLocalArranque).all());
  } catch (err) {
    console.error("[arranque automático] fallo leyendo partidos 'programado':", err.message);
  }
  try {
    ({ results: candidatosRetrasados = [] } = await env.DB.prepare(
      `SELECT id, fecha_partido_retrasado AS fecha_partido FROM results
       WHERE estado = 'retrasado' AND fecha_partido_retrasado IS NOT NULL
         AND length(fecha_partido_retrasado) = 16
         AND fecha_partido_retrasado <= ?`
    ).bind(limiteLocalArranque).all());
  } catch (err) {
    console.error("[arranque automático] fallo leyendo partidos 'retrasado':", err.message);
  }
  const candidatos = [...candidatosProgramados, ...candidatosRetrasados];
  const ahoraSqlite = aSqliteDatetimeUTC(new Date());
  const pendientes = candidatos.filter((p) => {
    const inicioUtc = fechaPartidoAUtcSqlite(p.fecha_partido);
    return inicioUtc !== null && inicioUtc <= ahoraSqlite;
  });
  for (const partido of pendientes) {
    try {
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
    } catch (err) {
      // No se relanza: se deja que el bucle siga con el resto de
      // partidos pendientes, y este en concreto se reintentará solo en
      // la siguiente pasada del cron (un minuto después), porque sigue
      // en estado 'programado'/'retrasado' con su hora ya cumplida.
      console.error(`[arranque automático] fallo arrancando el partido ${partido.id}:`, err.message);
    }
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
// Así el descanso queda registrado igual si el redactor está delante
// del panel y pulsa el botón a tiempo, que si se despista: el aviso de
// "desatendido" (ver revisarPartidosDesatendidos) seguía disparándose
// más tarde en ese segundo caso, pero el propio evento no aparecía en
// el timeline hasta que alguien entraba a pulsarlo a mano. Se limita a
// partidos con el cronómetro corriendo (no pausado): si ya está
// pausado es que alguien ya ha pitado algo (descanso, hidratación...)
// y no hay que tocarlo.
async function crearDescansoAutomaticoAlMinuto45(env, partidosEnJuego) {
  // partidosEnJuego (opcional): lista ya cargada por el cron (ver
  // "scheduled" -- se pide UNA sola vez por minuto en vez de que cada
  // una de las 4 funciones que miran 'en_juego' repita la misma
  // consulta a D1). Si no se pasa (llamada suelta, no desde el cron),
  // se sigue consultando aquí como antes.
  const partidos = (partidosEnJuego ?? (await env.DB.prepare(
    `SELECT id, inicio_cronometro_at, cronometro_pausado_en, ajuste_cronometro_minutos
     FROM results WHERE estado = 'en_juego' AND cronometro_pausado_en IS NULL`
  ).all()).results).filter((p) => p.cronometro_pausado_en === null || p.cronometro_pausado_en === undefined);
  if (!partidos.length) return;

  for (const partido of partidos) {
    const minuto = minutoEnVivoServidor(partido);
    if (minuto < MINUTO_DESCANSO_AUTOMATICO) continue;

    const yaHuboDescanso = await env.DB.prepare(
      "SELECT id FROM match_events WHERE resultado_id = ? AND tipo = 'descanso' LIMIT 1"
    ).bind(partido.id).first();
    if (yaHuboDescanso) continue;

    // Igual que el descanso manual del panel (mamPitarDescanso): se PARA
    // el cronómetro en el 45 y se registra el evento. var_motivo =
    // 'automatico' es la marca que usa reanudarSegundaParteAutomatica para
    // saber que este descanso lo puso el cron y que, por tanto, también
    // debe reanudarlo solo (un descanso pitado a mano nunca se reanuda
    // solo). No se pinta en ningún sitio: solo se muestra para tipo 'var'.
    await env.DB.prepare(
      "UPDATE results SET cronometro_pausado_en = ? WHERE id = ? AND cronometro_pausado_en IS NULL"
    ).bind(MINUTO_DESCANSO_AUTOMATICO, partido.id).run();
    await env.DB.prepare(
      `INSERT INTO match_events (resultado_id, tipo, equipo, minuto, orden, var_motivo) VALUES (?, 'descanso', 'ninguno', ?, 0, 'automatico')`
    ).bind(partido.id, MINUTO_DESCANSO_AUTOMATICO).run();
  }
}

// Minutos que dura el descanso automático antes de que el cron reanude
// solo la 2ª parte.
const MINUTOS_DESCANSO_AUTOMATICO = 15;

// Reanuda solo la 2ª parte de los partidos cuyo descanso lo puso el cron
// (crearDescansoAutomaticoAlMinuto45) y llevan ya MINUTOS_DESCANSO_AUTOMATICO
// minutos parados: retoma el cronómetro desde el minuto en el que se
// pausó (45) y registra el evento "fin_descanso" (con orden 1 para que
// quede detrás de "descanso", como hace mamComenzarSegundaParte). Si el
// redactor ya ha reanudado a mano (lo último es "fin_descanso") o el
// descanso lo pitó él (sin marca 'automatico'), no se toca nada.
async function reanudarSegundaParteAutomatica(env, partidosEnJuego) {
  const pausados = (partidosEnJuego ?? (await env.DB.prepare(
    `SELECT id, cronometro_pausado_en FROM results WHERE estado = 'en_juego' AND cronometro_pausado_en IS NOT NULL`
  ).all()).results).filter((p) => p.cronometro_pausado_en !== null && p.cronometro_pausado_en !== undefined);
  for (const partido of pausados) {
    const ultima = await env.DB.prepare(
      `SELECT tipo, var_motivo, created_at FROM match_events
       WHERE resultado_id = ? AND tipo IN ('descanso', 'fin_descanso')
       ORDER BY id DESC LIMIT 1`
    ).bind(partido.id).first();
    if (!ultima || ultima.tipo !== "descanso" || ultima.var_motivo !== "automatico") continue;
    const desdeMs = fechaBdAMs(ultima.created_at);
    if (!Number.isFinite(desdeMs) || Date.now() - desdeMs < MINUTOS_DESCANSO_AUTOMATICO * 60000) continue;

    const minutoReanudar = Number.isInteger(partido.cronometro_pausado_en) && partido.cronometro_pausado_en > 0
      ? partido.cronometro_pausado_en : MINUTO_DESCANSO_AUTOMATICO;
    await iniciarCronometroPartido(env, partido.id, minutoReanudar);
    await env.DB.prepare(
      `INSERT INTO match_events (resultado_id, tipo, equipo, minuto, orden, var_motivo) VALUES (?, 'fin_descanso', 'ninguno', ?, 1, 'automatico')`
    ).bind(partido.id, 45).run();
  }
}

// Minuto real (de cronómetro) a partir del cual se considera que nadie
// va a cubrir ya el final del partido y el cron lo cierra solo. Se ha
// subido de 100 a 150 para dar mucho más margen antes de intervenir
// (tiempo añadido, prórroga de Copa/playoffs, tanda de penaltis...): un
// partido real casi nunca llega aquí sin que alguien haya pitado ya el
// final, así que sigue siendo una red de seguridad, no la forma habitual
// de cerrar partidos.
const MINUTO_FIN_PARTIDO_AUTOMATICO = 150;

// Minuto con el que se REGISTRA el evento "fin_partido" y el marcador
// del partido cuando lo cierra el cron (no el minuto real en el que se
// detecta, MINUTO_FIN_PARTIDO_AUTOMATICO). Un partido real casi nunca
// termina más allá del 90'+añadido, así que dejar constancia de un
// "minuto 150" en el timeline público quedaría raro y fuera de lugar;
// se dejan los 90' como cierre "limpio" y el aviso de que fue un cierre
// automático sin cubrir vive aparte, en finalizado_no_cubierto (ver
// pintarListaResultados en admin.js), no en el minuto del evento.
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
// propio aviso. Además marca finalizado_no_cubierto = 1 para que el
// panel de admin pinte el aviso "FINALIZADO NO CUBIERTO" en la tabla de
// Resultados (ver pintarListaResultados en admin.js).
async function crearFinPartidoAutomaticoAlMinuto90(env, partidosEnJuego) {
  // partidosEnJuego (opcional): ver comentario gemelo en
  // crearDescansoAutomaticoAlMinuto45.
  const partidos = (partidosEnJuego ?? (await env.DB.prepare(
    `SELECT id, inicio_cronometro_at, cronometro_pausado_en, ajuste_cronometro_minutos
     FROM results WHERE estado = 'en_juego' AND cronometro_pausado_en IS NULL`
  ).all()).results).filter((p) => p.cronometro_pausado_en === null || p.cronometro_pausado_en === undefined);
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
    // Mismo efecto que el POST /eventos manual con tipo "fin_partido":
    // pasa el partido a 'finalizado' y limpia aviso_desatendido_mitad
    // (ver comentario gemelo en el endpoint) para no arrastrar avisos
    // de esta "vida" del partido si se reabre más adelante. Se marca
    // además finalizado_no_cubierto = 1 (a diferencia del cierre manual,
    // que nunca toca este campo) para distinguir en el panel un cierre
    // real de uno forzado por inactividad.
    await env.DB.prepare(
      "UPDATE results SET estado = 'finalizado', aviso_desatendido_mitad = NULL, finalizado_no_cubierto = 1 WHERE id = ?"
    ).bind(partido.id).run();
    await invalidarCacheArticuloPartido(env, partido.id);
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
//      minuto UMBRAL_PRIMERA_PARTE_SIN_DESCANSO (o el
//      UMBRAL_SEGUNDA_PARTE_SIN_FINAL, si ya va por la 2ª parte) sin que
//      nadie haya pitado el descanso / el final. Entre el min. 55 y el
//      100 el reloj corre con normalidad SOLO si ya se inició la 2ª
//      parte (evento "fin_descanso"): ver evaluarSituacionDesatendida().
//   2) El cronómetro está pausado en el descanso (evento "descanso" es
//      el último evento de tipo pausa) desde hace más de
//      UMBRAL_DESCANSO_SIN_REANUDAR minutos: el redactor no ha pulsado
//      "Iniciar 2ª parte".
//
// AVISOS EN LOTE (digest) -- por qué ya no se manda un email por partido:
// el plan gratuito de Resend limita a 100 emails al día. Antes se
// mandaba un correo por partido y mitad (al redactor + copia a admin) y,
// como este cron corre en los DOS backends (D1 y Postgres), un sábado
// con ~15 partidos sin cubrir bastaba para agotar el cupo y dejar sin
// aviso al resto de notificaciones del sitio (recuperar contraseña,
// comentarios, boletín...). Ahora el cron solo DETECTA: cada partido
// desatendido (una vez por mitad, igual que antes) se apunta en la
// tabla avisos_desatendidos_cola, y un único email consolidado a la
// cuenta de notificaciones se manda cuando se cumple CUALQUIERA de
// estas dos condiciones:
//   - la cola llega a AVISOS_DESATENDIDOS_LOTE partidos (por defecto 20), o
//   - el aviso más antiguo de la cola lleva esperando más de
//     AVISOS_DESATENDIDOS_ESPERA_MAX_MIN minutos (por defecto 30): así
//     un único partido abandonado no se queda horas sin avisar solo
//     porque nadie más se haya descuidado.
// Con eso, el peor caso pasa de 4 emails por partido (x2 backends) a
// 1 email por cada 20 partidos (o 1 cada 30 min como mucho).
//
// La cola vive en su PROPIA tabla (ver migracion_avisos_desatendidos_cola.sql
// y db/migrations/026_...) y NO en `settings`: el sincronizador D1 ->
// PostgreSQL trata `settings` como tabla autoritativa y borraría la cola
// de Railway en cada pasada (cada 60 s). Cada backend lleva la suya, sin
// sincronizar, igual que cada uno ejecuta ya su propio cron.
const UMBRAL_PRIMERA_PARTE_SIN_DESCANSO = 55; // minutos
const UMBRAL_SEGUNDA_PARTE_SIN_FINAL = 100; // minutos (aprox. 2ª parte + prórroga larga)
const UMBRAL_DESCANSO_SIN_REANUDAR = 25; // minutos parado en el descanso

const AVISOS_DESATENDIDOS_LOTE = 20; // partidos acumulados que disparan el email
const AVISOS_DESATENDIDOS_ESPERA_MAX_MIN = 30; // minutos máx. que espera el aviso más antiguo
// Tope de filas que se listan dentro del email (el resto se resume en
// una línea "y N más") para que un lote enorme no genere un correo
// gigante ni se recorte en el cliente de correo.
const AVISOS_DESATENDIDOS_MAX_FILAS_EMAIL = 40;

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
// NOTA: este aviso NO va por lotes a propósito: es un caso muy raro y
// grave (ya se ha ocultado el partido de la web) que no debe esperar.
const UMBRAL_PARTIDO_COLGADO = 2000; // minutos

async function marcarPartidosColgados(env, ctx, partidosEnJuego) {
  // partidosEnJuego (opcional): ver comentario en
  // crearDescansoAutomaticoAlMinuto45; aquí no se filtra por
  // cronometro_pausado_en porque un partido colgado puede seguir
  // corriendo o no, da igual para este chequeo.
  const partidos = partidosEnJuego ?? (await env.DB.prepare(
    `SELECT id, competicion, jornada, equipo_local, equipo_visitante, autor_id, autor_nombre,
            inicio_cronometro_at, cronometro_pausado_en, ajuste_cronometro_minutos
     FROM results WHERE estado = 'en_juego'`
  ).all()).results;
  if (!partidos.length) return [];

  const idsColgados = [];
  for (const partido of partidos) {
    const minuto = minutoEnVivoServidor(partido);
    if (minuto < UMBRAL_PARTIDO_COLGADO) continue;

    await env.DB.prepare("UPDATE results SET estado = 'colgado' WHERE id = ?").bind(partido.id).run();
    idsColgados.push(partido.id);

    const nombrePartido = `${partido.equipo_local} - ${partido.equipo_visitante}`;
    const enlacePanel = `${SITIO_URL}/admin/panel.html?minuto_a_minuto=${partido.id}`;
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

// ---------- Avisos de partidos sin cubrir: evaluación, validación y agrupación ----------
//
// Interpreta una fecha guardada en la BD como instante UTC (ms). Acepta
// "YYYY-MM-DD HH:MM:SS" (D1), ISO con T/Z/offset y objetos Date (que es
// lo que puede devolver el driver "pg" en Railway). Devuelve NaN si no
// se entiende. Antes cada sitio hacía su propio new Date(String(x)
// .replace(" ", "T") + "Z"), que con un objeto Date daba NaN en silencio.
function fechaBdAMs(valor) {
  if (valor instanceof Date) return valor.getTime();
  if (valor === null || valor === undefined || valor === "") return NaN;
  let raw = String(valor).trim();
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(raw)) {
    raw = raw.includes("T") ? raw + "Z" : raw.replace(" ", "T") + "Z";
  }
  return new Date(raw).getTime();
}

const NOMBRE_COMPETICION_AVISO = {
  hypermotion: "LaLiga Hypermotion",
  primera_federacion: "Primera Federación",
  segunda_federacion: "Segunda Federación",
};

// Si se ha registrado un evento (gol, tarjeta, cambio...) hace menos de
// estos minutos, el partido SÍ se está cubriendo aunque el reloj vaya
// más allá de lo normal. Mismo margen que MAM_MINUTOS_ACTIVIDAD_RECIENTE
// en public/admin/js/admin.js: el email y el "🔴 Sin cubrir" del panel
// deben coincidir (antes el panel ya lo respetaba y el email no).
const AVISOS_DESATENDIDOS_ACTIVIDAD_RECIENTE_MIN = 5;

// Grupos del email, de más a menos grave. "corto" es la etiqueta que
// se usa en el asunto.
const AVISOS_DESATENDIDOS_GRUPOS = [
  { tipo: "sin_final", emoji: "🔴", titulo: "Sin final del partido", corto: "sin final",
    detalle: "El cronómetro sigue corriendo y nadie ha pulsado «Fin del partido»." },
  { tipo: "sin_descanso", emoji: "🟠", titulo: "Sin descanso ni 2ª parte", corto: "sin descanso",
    detalle: "El reloj ha pasado del minuto 45 sin que nadie pitara el descanso ni iniciara la 2ª parte." },
  { tipo: "descanso_sin_reanudar", emoji: "⏸️", titulo: "Parados en el descanso", corto: "parados en el descanso",
    detalle: "Nadie ha pulsado «Comienza la 2ª parte»." },
  { tipo: "cerrado_auto", emoji: "⚫", titulo: "Cerrados automáticamente", corto: "cerrados por el sistema",
    detalle: "El sistema los cerró solo: revisa el marcador y los eventos del tramo final." },
];

async function partidoTieneEvento(env, resultadoId, tipo) {
  const fila = await env.DB.prepare(
    "SELECT id FROM match_events WHERE resultado_id = ? AND tipo = ? LIMIT 1"
  ).bind(resultadoId, tipo).first();
  return !!fila;
}

async function partidoTieneActividadReciente(env, resultadoId) {
  const fila = await env.DB.prepare(
    "SELECT MAX(created_at) AS ultimo FROM match_events WHERE resultado_id = ?"
  ).bind(resultadoId).first();
  const ms = fechaBdAMs(fila && fila.ultimo);
  if (!Number.isFinite(ms)) return false;
  return (Date.now() - ms) / 60000 < AVISOS_DESATENDIDOS_ACTIVIDAD_RECIENTE_MIN;
}

// Decide si un partido "en_juego" está AHORA MISMO sin cubrir y de qué
// tipo. Devuelve null si no lo está, o { tipo, mitad, motivo,
// motivoCorto, minuto }. La usan tanto la detección (cada minuto) como
// la validación justo antes de enviar el resumen, para que las dos
// miren exactamente lo mismo.
//
// El cronómetro NO se reinicia en la 2ª parte: "Comienza la 2ª parte"
// lo reanuda desde el minuto 45 (ver mamComenzarSegundaParte en
// minuto-a-minuto.js) y registra un evento "fin_descanso". Por eso un
// reloj corriendo entre el min. 55 y el 100 es lo NORMAL si ya hay
// "fin_descanso" (2ª parte en marcha). Antes solo se miraba si existía
// un evento "descanso", pero ese evento lo inserta también el cron solo
// al llegar al minuto 45 (crearDescansoAutomaticoAlMinuto45), así que
// casi todos los partidos, con o sin redactor delante, acababan
// marcados como "sin final" hacia el minuto 55 de la 2ª parte. Ahora el
// aviso "sin descanso" salta solo si pasa del minuto 55 SIN
// "fin_descanso": nadie ha pausado el descanso ni iniciado la 2ª parte.
//
// omitirMitades (opcional): mitades ya avisadas. Si la situación que
// tocaría evaluar pertenece a una de ellas se devuelve null sin gastar
// consultas (el cron pasa por aquí cada minuto por cada partido en
// juego; el envío del resumen no pasa esta lista y evalúa todo).
async function evaluarSituacionDesatendida(env, partido, omitirMitades = []) {
  const corriendo = partido.cronometro_pausado_en === null || partido.cronometro_pausado_en === undefined;
  const minuto = minutoEnVivoServidor(partido);
  let situacion = null;

  if (corriendo && minuto >= UMBRAL_SEGUNDA_PARTE_SIN_FINAL) {
    if (omitirMitades.includes("segunda")) return null;
    situacion = {
      tipo: "sin_final", mitad: "segunda",
      motivo: `El cronómetro sigue corriendo y ya marca el minuto ${minuto} sin que se haya registrado el final del partido.`,
      motivoCorto: `min. ${minuto} sin final`,
    };
  } else if (corriendo && minuto >= UMBRAL_PRIMERA_PARTE_SIN_DESCANSO) {
    if (omitirMitades.includes("primera")) return null;
    if (!(await partidoTieneEvento(env, partido.id, "fin_descanso"))) {
      situacion = {
        tipo: "sin_descanso", mitad: "primera",
        motivo: `El cronómetro sigue corriendo y ya marca el minuto ${minuto} sin que nadie haya pausado el descanso ni iniciado la 2ª parte.`,
        motivoCorto: `min. ${minuto} sin descanso`,
      };
    }
  } else if (!corriendo) {
    if (omitirMitades.includes("primera")) return null;
    // Se incluye "fin_descanso" en la búsqueda: si lo último es que se
    // inició la 2ª parte, un reloj pausado después ya no es "parado en
    // el descanso" (antes se seguía contando desde el evento "descanso",
    // que podía tener horas).
    const ultimaPausa = await env.DB.prepare(
      `SELECT tipo, created_at FROM match_events
       WHERE resultado_id = ? AND tipo IN ('descanso', 'fin_descanso', 'pausa_hidratacion')
       ORDER BY id DESC LIMIT 1`
    ).bind(partido.id).first();
    if (ultimaPausa && ultimaPausa.tipo === "descanso") {
      const desdeMs = fechaBdAMs(ultimaPausa.created_at);
      const minutosParado = Number.isFinite(desdeMs) ? Math.floor((Date.now() - desdeMs) / 60000) : 0;
      if (minutosParado >= UMBRAL_DESCANSO_SIN_REANUDAR) {
        situacion = {
          tipo: "descanso_sin_reanudar",
          // El descanso es la frontera entre mitades: se cuenta como
          // aviso de la 1ª parte (es el cierre pendiente de esa mitad).
          mitad: "primera",
          motivo: `El partido lleva parado en el descanso ${minutosParado} minutos sin que se haya iniciado la 2ª parte.`,
          motivoCorto: `${minutosParado} min parado en el descanso`,
        };
      }
    }
  }

  if (!situacion) return null;
  if (await partidoTieneActividadReciente(env, partido.id)) return null;
  return { ...situacion, minuto };
}

// Lee la cola de avisos pendientes (tabla avisos_desatendidos_cola).
// Devuelve siempre un array. encolado_ms se pasa por Number(): el driver
// "pg" devuelve los BIGINT de Postgres como string (no como número, a
// diferencia de D1), y una comparación o un Math.min sobre strings
// fallaría en silencio solo en Railway.
async function leerColaAvisosDesatendidos(env) {
  const { results } = await env.DB.prepare(
    "SELECT resultado_id, partido, jornada, redactor, motivo_corto, encolado_ms FROM avisos_desatendidos_cola ORDER BY encolado_ms ASC"
  ).all();
  return (results || []).map((f) => ({
    id: Number(f.resultado_id),
    partido: f.partido,
    jornada: f.jornada,
    redactor: f.redactor,
    motivoCorto: f.motivo_corto,
    encoladoMs: Number(f.encolado_ms),
  }));
}

// Carga el estado ACTUAL de los partidos de la cola (en tandas de 90:
// D1/SQLite admite como mucho 100 parámetros bind por consulta).
async function cargarPartidosDeAvisos(env, ids) {
  const mapa = new Map();
  const TANDA = 90;
  for (let inicio = 0; inicio < ids.length; inicio += TANDA) {
    const tanda = ids.slice(inicio, inicio + TANDA);
    const { results } = await env.DB.prepare(
      `SELECT id, competicion, jornada, equipo_local, equipo_visitante, autor_nombre, estado, finalizado_no_cubierto,
              inicio_cronometro_at, cronometro_pausado_en, ajuste_cronometro_minutos
       FROM results WHERE id IN (${tanda.map(() => "?").join(",")})`
    ).bind(...tanda).all();
    for (const fila of results || []) mapa.set(Number(fila.id), fila);
  }
  return mapa;
}

// Los avisos esperan en la cola hasta 30 minutos: en ese rato el
// redactor puede haber retomado el partido, haberlo cerrado o haber
// vuelto a meter eventos. Justo antes de enviar se vuelve a mirar cada
// partido y solo pasan los que SIGUEN sin cubrir, ya clasificados por
// tipo y con el minuto actual (no el de hace media hora):
//   - en_juego y todavía desatendido -> su tipo actual
//   - finalizado por el cron (finalizado_no_cubierto) -> "cerrado_auto"
//   - cualquier otra cosa (resuelto, cerrado a mano, oculto por
//     'colgado' -que ya manda su propio email urgente-, borrado) -> se
//     descarta.
async function validarAvisosDesatendidos(env, cola) {
  const filas = await cargarPartidosDeAvisos(env, cola.map((a) => a.id));
  const vigentes = [];
  for (const aviso of cola) {
    const p = filas.get(aviso.id);
    if (!p) continue;

    let tipo = null;
    let motivoCorto = null;
    if (p.estado === "en_juego") {
      const situacion = await evaluarSituacionDesatendida(env, p);
      if (!situacion) continue;
      tipo = situacion.tipo;
      motivoCorto = situacion.motivoCorto;
    } else if (p.estado === "finalizado" && (p.finalizado_no_cubierto === true || Number(p.finalizado_no_cubierto) === 1)) {
      tipo = "cerrado_auto";
      motivoCorto = "cerrado por el sistema";
    } else {
      continue;
    }

    vigentes.push({
      id: aviso.id,
      tipo,
      motivoCorto,
      partido: `${p.equipo_local} - ${p.equipo_visitante}`,
      competicion: NOMBRE_COMPETICION_AVISO[p.competicion] || p.competicion || "",
      jornada: p.jornada,
      redactor: p.autor_nombre || aviso.redactor || null,
    });
  }
  return vigentes;
}

// Agrupa por tipo (de más a menos grave) y, dentro de cada tipo, por
// redactor (los "sin asignar" al final) y jornada.
function agruparAvisosDesatendidos(avisos) {
  const comparar = (a, b) => {
    const sinA = a.redactor ? 0 : 1;
    const sinB = b.redactor ? 0 : 1;
    if (sinA !== sinB) return sinA - sinB;
    const porRedactor = String(a.redactor || "").localeCompare(String(b.redactor || ""), "es");
    if (porRedactor) return porRedactor;
    const porJornada = (Number(a.jornada) || 0) - (Number(b.jornada) || 0);
    if (porJornada) return porJornada;
    return String(a.partido).localeCompare(String(b.partido), "es");
  };
  return AVISOS_DESATENDIDOS_GRUPOS
    .map((g) => ({ ...g, items: avisos.filter((a) => a.tipo === g.tipo).sort(comparar) }))
    .filter((g) => g.items.length > 0);
}

function detalleAvisoDesatendido(a) {
  return [a.competicion, a.jornada ? `J${a.jornada}` : "", a.redactor || "Sin asignar", a.motivoCorto]
    .filter(Boolean)
    .join(" · ");
}

// Construye asunto, texto y HTML del resumen ya agrupado.
function construirDigestAvisosDesatendidos(grupos, motivoEnvio) {
  const total = grupos.reduce((n, g) => n + g.items.length, 0);
  const urlLista = `${SITIO_URL}/admin/panel.html?ir=resultados.lista&sin_cubrir=1`;
  const urlPartido = (id) => `${SITIO_URL}/admin/panel.html?minuto_a_minuto=${id}`;

  // Tope de filas listadas entre TODOS los grupos (los más graves
  // primero); el resto se resume con "y N más" en su grupo.
  let restantes = AVISOS_DESATENDIDOS_MAX_FILAS_EMAIL;
  const visibles = grupos.map((g) => {
    const mostrados = g.items.slice(0, Math.max(0, restantes));
    restantes -= mostrados.length;
    return { ...g, mostrados, ocultos: g.items.length - mostrados.length };
  });

  const porRedactor = new Map();
  for (const g of grupos) {
    for (const a of g.items) {
      const nombre = a.redactor || "Sin asignar";
      porRedactor.set(nombre, (porRedactor.get(nombre) || 0) + 1);
    }
  }
  const resumenRedactores = [...porRedactor.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "es"))
    .map(([nombre, n]) => `${nombre} (${n})`)
    .join(", ");

  const desglose = grupos.map((g) => `${g.items.length} ${g.corto}`).join(", ");
  const asunto = `⚠️ ${total} ${total === 1 ? "partido" : "partidos"} sin cubrir: ${desglose}`;
  const titulo = total === 1 ? "1 partido sin cubrir" : `${total} partidos sin cubrir`;
  const parrafo = motivoEnvio === "lote"
    ? `Se han acumulado ${total} partidos que parecen desatendidos. Solo se listan los que siguen sin resolverse ahora mismo.`
    : `Estos partidos llevan un rato desatendidos y siguen sin resolverse.`;

  const texto = [
    parrafo,
    total > 1 ? `Por redactor: ${resumenRedactores}` : "",
    ...visibles.map((g) => [
      `${g.emoji} ${g.titulo.toUpperCase()} (${g.items.length})`,
      ...g.mostrados.map((a) => `- ${a.partido} · ${detalleAvisoDesatendido(a)}\n  ${urlPartido(a.id)}`),
      g.ocultos > 0 ? `  …y ${g.ocultos} más de este grupo.` : "",
    ].filter(Boolean).join("\n")),
    `Ver todos en el panel: ${urlLista}`,
  ].filter(Boolean).join("\n\n");

  const seccionesHtml = visibles.map((g) => `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 14px;background:#eef1f5;border-radius:8px;padding:12px 16px;">
      <tr><td style="padding:0 0 8px;">
        <div style="font-size:13px;font-weight:700;color:#0c1b2e;">${g.emoji} ${escapeHtmlEmail(g.titulo)} <span style="color:#d1132e;">(${g.items.length})</span></div>
        <div style="margin-top:2px;font-size:12px;line-height:1.4;color:#5a6270;">${escapeHtmlEmail(g.detalle)}</div>
      </td></tr>
      ${g.mostrados.map((a) => `
      <tr><td style="padding:9px 0;border-top:1px solid #dde2ea;">
        <a href="${urlPartido(a.id)}" style="font-size:14px;font-weight:700;color:#0c1b2e;text-decoration:none;">${escapeHtmlEmail(a.partido)}</a>
        <div style="margin-top:3px;font-size:12.5px;line-height:1.45;color:#5a6270;">${escapeHtmlEmail(detalleAvisoDesatendido(a))}</div>
      </td></tr>`).join("")}
      ${g.ocultos > 0 ? `<tr><td style="padding:9px 0 0;border-top:1px solid #dde2ea;font-size:12.5px;color:#5a6270;">…y ${g.ocultos} más de este grupo (revisa el panel)</td></tr>` : ""}
    </table>`).join("");

  const bloqueHtml = `${total > 1 ? `<p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:#5a6270;"><strong style="color:#0c1b2e;">Por redactor:</strong> ${escapeHtmlEmail(resumenRedactores)}</p>` : ""}${seccionesHtml}`;

  const html = plantillaEmail({
    etiqueta: "Aviso automático",
    titulo,
    parrafo,
    bloqueHtml,
    boton: { texto: "Ver sin cubrir en el panel", url: urlLista },
  });
  return { asunto, texto, html };
}

// Manda UN solo email con todos los partidos vigentes, agrupados.
// Devuelve true si había algo que enviar.
async function enviarDigestAvisosDesatendidos(env, avisos, motivoEnvio) {
  if (!avisos.length) return false;
  const { asunto, texto, html } = construirDigestAvisosDesatendidos(agruparAvisosDesatendidos(avisos), motivoEnvio);
  const enviado = await enviarEmailNotificacion(env, { asunto, texto, html }, { destinatario: EMAIL_NOTIFICACIONES });
  if (!enviado) console.log("Resumen de partidos sin cubrir: el envío ha fallado (la cola ya estaba vaciada, no se reintenta).");
  return true;
}

// Detecta partidos desatendidos y los apunta en la cola (una vez por
// mitad, como siempre). El email ya NO sale desde aquí partido a
// partido: lo manda enviarDigestAvisosDesatendidos cuando toca (ver el
// bloque de comentarios "AVISOS EN LOTE" más arriba).
async function revisarPartidosDesatendidos(env, ctx, partidosEnJuego) {
  // Los partidos ya marcados como 'colgado' (ver marcarPartidosColgados,
  // que corre justo antes en el cron) se excluyen aquí para no duplicar
  // avisos: ese caso ya manda su propio email, más urgente, y ya no
  // está en estado 'en_juego' de todas formas.
  //
  // partidosEnJuego (opcional): lista ya cargada por el cron (ver
  // "scheduled"). OJO: si viene de fuera puede faltarle
  // aviso_desatendido_mitad si el llamador cargó una versión reducida;
  // por eso el cron carga siempre la consulta "completa" (con todas las
  // columnas que hacen falta aquí) y se la pasa también a
  // marcarPartidosColgados, que solo usa un subconjunto de ellas.
  const partidos = partidosEnJuego ?? (await env.DB.prepare(
    `SELECT id, competicion, jornada, equipo_local, equipo_visitante, autor_id, autor_nombre,
            inicio_cronometro_at, cronometro_pausado_en, ajuste_cronometro_minutos,
            aviso_desatendido_mitad
     FROM results WHERE estado = 'en_juego'`
  ).all()).results;

  // Aunque no haya partidos en juego hay que mirar la cola igualmente:
  // puede haber avisos pendientes de un partido que ya terminó, y su
  // temporizador de espera máxima debe seguir corriendo para que se
  // envíen. Por eso no hay un "return" temprano aquí.
  for (const partido of partidos) {
    // A qué mitad pertenece la situación (ver evaluarSituacionDesatendida)
    // para repartir como mucho un aviso por mitad (columna
    // aviso_desatendido_mitad) en vez de uno para todo el partido: así
    // un partido desatendido en la 1ª parte que, tras retomarlo, vuelve
    // a desatenderse en la 2ª, puede avisar otra vez.
    //
    // Si el partido ya no está en situación de riesgo pero se había
    // avisado antes, no se toca nada: cada mitad solo se limpia cuando
    // termina el partido o se reinicia desde cero, así no se vuelve a
    // avisar dentro de la misma mitad nada más resolverse un despiste
    // puntual.
    const mitadesAvisadas = (partido.aviso_desatendido_mitad || "").split("_").filter(Boolean);
    const situacion = await evaluarSituacionDesatendida(env, partido, mitadesAvisadas);
    if (!situacion) continue;
    if (mitadesAvisadas.includes(situacion.mitad)) continue; // ya avisado en esta mitad, no se repite

    // Se marca la mitad como avisada YA (aunque el email salga más tarde
    // en el lote): así el mismo partido no se vuelve a apuntar en la
    // cola en el siguiente minuto del cron.
    const nuevoValor = [...new Set([...mitadesAvisadas, situacion.mitad])].join("_");
    await env.DB.prepare("UPDATE results SET aviso_desatendido_mitad = ? WHERE id = ?").bind(nuevoValor, partido.id).run();

    // INSERT ... ON CONFLICT: si el mismo partido ya estaba en la cola
    // (p. ej. se reinició y volvió a desatenderse antes de enviarse el
    // lote), se sustituye su fila en lugar de duplicarla.
    await env.DB.prepare(
      `INSERT INTO avisos_desatendidos_cola (resultado_id, partido, jornada, redactor, motivo_corto, encolado_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(resultado_id) DO UPDATE SET partido = excluded.partido, jornada = excluded.jornada,
         redactor = excluded.redactor, motivo_corto = excluded.motivo_corto, encolado_ms = excluded.encolado_ms`
    ).bind(
      partido.id, `${partido.equipo_local} - ${partido.equipo_visitante}`, partido.jornada,
      partido.autor_nombre || null, situacion.motivoCorto, Date.now()
    ).run();

    await registrarActividad(env, null, { uid: null, nombre: "Vigilancia de partidos", rol: "sistema" }, {
      accion: "aviso_partido_desatendido", entidad: "resultado", entidad_id: partido.id,
      descripcion: `Aviso automático (en cola para el resumen): ${partido.equipo_local} - ${partido.equipo_visitante} — ${situacion.motivo}`,
    });
  }

  const cola = await leerColaAvisosDesatendidos(env);
  if (!cola.length) return;

  // ¿Toca enviar el resumen? Si ya hay un lote completo, o si el aviso
  // más antiguo (la cola viene ordenada por encolado_ms ASC) lleva
  // esperando más de AVISOS_DESATENDIDOS_ESPERA_MAX_MIN. Un encolado_ms
  // ilegible (NaN) cuenta como "ya lleva mucho": mejor avisar de más una
  // vez que dejar un aviso atascado para siempre. Esta decisión usa la
  // cola tal cual (una sola consulta por minuto); la comprobación de
  // que cada partido sigue sin cubrir se hace solo al enviar.
  const esperaMin = Number.isFinite(cola[0].encoladoMs) ? (Date.now() - cola[0].encoladoMs) / 60000 : Infinity;
  const loteCompleto = cola.length >= AVISOS_DESATENDIDOS_LOTE;
  const esperaAgotada = esperaMin >= AVISOS_DESATENDIDOS_ESPERA_MAX_MIN;
  if (!loteCompleto && !esperaAgotada) return;

  // Se vacía la cola ANTES de enviar, y solo las filas que se van a
  // enviar (por id, no un DELETE global): si el envío falla a medias no
  // se reenvía el mismo lote cada minuto quemando cuota -el peor
  // resultado posible aquí sería justo el que se quiere evitar-, y un
  // partido que se apunte mientras tanto (el cron es concurrente entre
  // ctx.waitUntil) no se borra sin haberse enviado. Un aviso perdido por
  // un fallo puntual de Resend es preferible a un bucle de reintentos
  // que agote el cupo diario.
  //
  // Se trocea en lotes de 90 ids (límite de 100 parámetros bind en
  // D1/SQLite, mismo criterio que contarPublicacionesPorTipoDeVarios):
  // si la espera máxima acumula más de 100 partidos (una jornada entera
  // sin nadie cubriendo) un DELETE de una sola vez fallaría con "too many
  // SQL variables" y, al no borrarse la cola, el mismo aviso se
  // reenviaría CADA MINUTO.
  const ids = cola.map((a) => a.id);
  const LOTE_BORRADO = 90;
  for (let inicio = 0; inicio < ids.length; inicio += LOTE_BORRADO) {
    const lote = ids.slice(inicio, inicio + LOTE_BORRADO);
    await env.DB.prepare(
      `DELETE FROM avisos_desatendidos_cola WHERE resultado_id IN (${lote.map(() => "?").join(",")})`
    ).bind(...lote).run();
  }

  // Solo se avisa de lo que sigue sin cubrir en este momento. Si durante
  // la espera se resolvió todo, no se manda nada (y ya no queda nada en
  // la cola).
  const vigentes = await validarAvisosDesatendidos(env, cola);
  if (!vigentes.length) {
    console.log(`Resumen de partidos sin cubrir: ${cola.length} aviso(s) en cola, todos resueltos antes de enviar. No se manda email.`);
    return;
  }
  await enviarDigestAvisosDesatendidos(env, vigentes, loteCompleto ? "lote" : "espera");
}

async function publicarArticulosProgramados(env) {
  const { results: pendientes } = await env.DB.prepare(
    `SELECT id, slug, titulo, subtitulo, tipo, categoria, club, autor_nombre, coautor_nombre, imagen_url, resultado_id
     FROM articles
     WHERE publicado = 0 AND programado_para IS NOT NULL AND programado_para <= datetime('now')`
  ).all();

  for (const articulo of pendientes) {
    const fechaPublicacion = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE articles SET publicado = 1, programado_para = NULL, slug_congelado = 1, fecha_publicacion = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).bind(articulo.id).run();
    // El horario se evalúa en el momento real de publicación, no cuando se programó.
    await marcarFueraDeCalendario(env, articulo.id, { tipo: articulo.tipo, resultado_id: articulo.resultado_id });
    // Aviso push a quien lo tenga activado (nunca lanza ni bloquea la publicacion).
    await notificarPushArticulo(env, articulo);
    // Aviso a los buscadores (IndexNow); nunca lanza.
    await notificarIndexNow(env, [urlNoticia(articulo.categoria, articulo.slug)]);

    const tipoLabel = { noticia: "Noticia", previa: "Previa", cronica: "Crónica", analisis: "Análisis", opinion: "Opinión", entrevista: "Entrevista" }[articulo.tipo] || "Artículo";
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
          { etiqueta: "Categoría", valor: clubArticuloLegible(articulo.club) || articulo.categoria },
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

// Guardia en memoria: la comprobacion es cada 15 min (marca en settings), asi
// que no hace falta leer settings en cada tick del cron por minuto.
let CUOTA_D1_PROXIMA_COMPROBACION_MS = 0;

async function comprobarCuotaD1SiToca(env) {
  if (Date.now() < CUOTA_D1_PROXIMA_COMPROBACION_MS) return;
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
      if (minutosDesde < 15) {
        CUOTA_D1_PROXIMA_COMPROBACION_MS = new Date(ultimaComprobacion.value).getTime() + 15 * 60000;
        return;
      }
    }
    CUOTA_D1_PROXIMA_COMPROBACION_MS = Date.now() + 15 * 60000;

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

// Borra la entrada de caché de "articulo-partido" para un resultado
// concreto (ver más abajo, GET /api/articles/:slug): se llama justo
// después de cualquier cambio en ese partido (marcador, estado, goles,
// tarjetas, alineaciones) para que la próxima visita a su crónica/previa
// recoja el dato nuevo al momento, en vez de esperar a que expire el TTL
// largo (hasta 1h) que ahora tiene esa caché para partidos que no están
// "en_juego". Es "best effort" y nunca debe frenar la petición que la
// dispara: si KV falla o no está configurado, simplemente no se invalida
// nada y la próxima visita servirá el dato cacheado hasta que expire por
// su cuenta -- no es un error grave, así que solo se registra.
async function invalidarCacheArticuloPartido(env, resultadoId) {
  if (!env.ELOTROFUTBOL_KV || !resultadoId) return;
  try {
    await env.ELOTROFUTBOL_KV.delete(`articulo-partido:${resultadoId}`);
  } catch (err) {
    console.error("[cache-articulo-partido] fallo al invalidar (no crítico):", err);
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
  // Antes esto sacaba la lista de article_id con vistas y volvía a
  // consultar articles/article_reading con "WHERE id IN (?,?,?...)",
  // bindeando un parámetro por artículo -- con más de 100 artículos
  // distintos con vistas en el rango, D1 rechaza la consulta por
  // superar su límite de 100 parámetros bindeados por statement (ver
  // la nota completa en calcularCategoriasAnaliticas). Se reescribe
  // igual que esa: vistas y lecturas se agregan por separado (evita el
  // fan-out de un doble JOIN, cada evento se cuenta una vez) pero sin
  // ninguna lista de IDs dinámica -- article_reading se filtra por
  // fecha directamente, no por "IN (ids con vistas)".
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
// Cuenta vistas de article_views agrupadas por la columna `idioma` (ver
// migracion_analiticas_idioma_partidos.sql). Devuelve también el
// porcentaje sobre el total para que el panel pueda pintar barras sin
// tener que recalcularlo en el cliente.
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
// Igual que calcularMasLeidasAnaliticas pero sobre result_views/results,
// para la página pública minuto-a-minuto.html (ver /api/track/result-view).
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
// Agrupa las vistas por hora del día (0-23), sumando todos los días del
// rango: sirve para ver a qué hora suele leer la gente, no una serie
// temporal (para eso está calcularUltimas24hAnaliticas). `created_at` es
// TEXT tipo "YYYY-MM-DD HH:MM:SS" tanto en D1 como en Postgres, así que
// substr(created_at, 12, 2) es válido en ambos motores sin necesitar
// strftime (que sql-compat.js no traduce).
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
// Mismo patrón (agregado por tabla, cruzado en JS) que
// calcularAutoresAnaliticas, para no arrastrar el mismo problema de
// fan-out con un JOIN directo entre articles/article_views/article_reading.
async function calcularTiposAnaliticas(env, desde) {
  // Mismo fix que calcularCategoriasAnaliticas/calcularAutoresAnaliticas:
  // sin "WHERE id IN (?,?,?...)" con un parámetro por artículo (rompía
  // el límite de 100 parámetros de D1 en cuanto había más de 100
  // artículos con vistas en el rango). Vistas y lecturas se agregan por
  // separado, sin lista de IDs dinámica.
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
// Reparte las lecturas del rango en 4 tramos según scroll_maximo (0-100).
// Usamos SUM(CASE WHEN...) en una sola pasada en vez de 4 queries.
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
// A diferencia de calcularHorasAnaliticas (que agrega por hora del día
// sobre todo el rango), esto es una serie temporal real de las últimas
// 24h, en cubos de una hora, para el gráfico de línea del panel. No
// depende de `desde`/`dias`: siempre son las últimas 24h desde ahora.
async function calcularUltimas24hAnaliticas(env) {
  const { results } = await env.DB.prepare(
    `SELECT substr(created_at, 1, 13) AS hora_cubo, COUNT(*) AS vistas
     FROM article_views
     WHERE created_at >= datetime('now', '-1 days')
     GROUP BY hora_cubo ORDER BY hora_cubo ASC`
  ).all();
  const porCubo = new Map((results || []).map((f) => [f.hora_cubo, Number(f.vistas) || 0]));

  // Se generan las 24 franjas horarias siempre, aunque no tengan vistas,
  // para que el eje X del gráfico no salte huecos. hora.slice(11, 16) en
  // el frontend espera "YYYY-MM-DDTHH:MM", de ahí la 'T' en vez del
  // espacio que usa created_at en la base de datos.
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
// Búsqueda simple por coincidencia parcial de título, con sus métricas
// del rango de días activo en el panel. LIKE con comodines en ambos
// lados de `q` funciona igual en SQLite/D1 y Postgres.
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
// Antes esto agregaba article_views por article_id, sacaba la lista de
// IDs con vistas y volvía a consultar articles con "WHERE id IN
// (?,?,?...)" bindeando un parámetro por artículo. Con más de 100
// artículos distintos con vistas en el rango (fácil en 28/90 días con
// tráfico real), esa consulta superaba el límite de 100 parámetros
// bindeados por statement de D1 y fallaba -- por eso esta tarjeta (y
// autores/tipos, mismo patrón) podía quedarse sin datos o dar error
// mientras el resto del panel iba bien. Ahora se hace todo en una sola
// consulta con JOIN, sin lista de IDs dinámica.
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
// "Recurrente" = visitante_estable con vistas en más de un día distinto
// dentro del rango. OJO: no se puede usar visitante_hash aquí -- ese
// hash incluye el día a propósito (ver hashVisitante(), para deduplicar
// recargas del mismo día sin inflar "visitas únicas"), así que un mismo
// visitante_hash SIEMPRE tiene un único día asociado y "recurrentes"
// salía a 0 de forma sistemática. visitante_estable (ver
// hashVisitanteEstable()) es el mismo tipo de hash no reversible pero
// SIN el día, así que si la misma persona aparece en más de un día
// distinto del rango, su visitante_estable sí se repite entre filas de
// días distintos.
//
// Las filas con visitante_estable NULL (vistas registradas antes de
// esta migración, ver migracion_analiticas_recurrencia.sql) se excluyen
// -- no hay forma de saber si esas vistas antiguas eran recurrentes o
// no, así que no se cuentan ni como nuevas ni como recurrentes en vez
// de contarlas mal.
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
// Borra article_views (y, en cascada, article_reading, que referencia
// view_id ON DELETE CASCADE) de un rango de días o de todo el histórico.
// Solo admin (comprobado en el router, igual que el resto de
// /api/admin/analiticas/*). Devuelve cuántas filas de article_views se
// han borrado para que el panel pueda confirmarlo en el toast.
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

/*
 * ================================================================
 * RECORDATORIOS DE INACTIVIDAD DE REDACTORES
 * ================================================================
 * Un redactor activo (users.rol = 'redactor', activo = 1, con email) que
 * pasa 30 días sin subir nada recibe un correo de recordatorio:
 *
 *   - Referencia de inactividad: la fecha de su última noticia (cualquier
 *     tipo, borrador o publicada, ver articles.fecha_publicacion) o, si
 *     nunca ha subido nada, la fecha de creación de su cuenta.
 *   - Aviso 1 al cumplirse 30 días desde esa referencia.
 *   - Avisos 2, 3, 4 y 5: uno cada 5 días desde el aviso anterior.
 *   - El aviso 5 lleva además el texto de incumplimiento de las normas
 *     del medio (apartado 3.6, "Compromiso", de la guía del medio).
 *   - 5 días después del aviso 5, si sigue sin subir nada, se manda UN
 *     correo a los admins diciendo que hay que expulsar a ese usuario
 *     (no se expulsa automáticamente: la decisión sigue siendo de un admin).
 *   - Si en cualquier momento sube algo, el ciclo se reinicia (la nueva
 *     referencia es esa noticia y el contador vuelve a 0).
 *
 * Solo corre en el Worker principal (D1), NO en el cron de respaldo de
 * Railway: si corriese en los dos, cada redactor recibiría cada aviso por
 * duplicado y se gastaría el doble del cupo diario de Resend (100/día).
 * Su estado vive en la tabla propia recordatorios_inactividad (ver
 * migracion_recordatorios_inactividad.sql), que NO se sincroniza con
 * Postgres. Una vez al día (a partir de las 10:00 hora de Madrid) se
 * hace una sola pasada; el resto de ticks del cron salen sin tocar D1.
 */
const INACTIVIDAD_DIAS_HASTA_PRIMER_AVISO = 30;
const INACTIVIDAD_DIAS_ENTRE_AVISOS = 5;
const INACTIVIDAD_AVISOS_HASTA_INCUMPLIMIENTO = 5;
const INACTIVIDAD_DIAS_HASTA_AVISAR_ADMINS = 5;
const INACTIVIDAD_HORA_MADRID = 10;
// Tope de correos de redactores por pasada, para no agotar el cupo diario
// de Resend (p. ej. la primera vez, con muchas cuentas ya vencidas). Lo que
// no quepa hoy se envía en la pasada de mañana: el estado solo avanza
// cuando el correo sale bien.
const INACTIVIDAD_MAX_CORREOS_POR_PASADA = 40;
const INACTIVIDAD_DIA_MS = 24 * 60 * 60 * 1000;
const INACTIVIDAD_KV_CLAVE = "recordatorios_inactividad:ultimo_dia";
let INACTIVIDAD_ULTIMO_DIA_EN_MEMORIA = "";

// Convierte una fecha guardada en D1 ("YYYY-MM-DD HH:MM:SS" en UTC, o ISO
// con "T") a milisegundos. Devuelve null si no se puede interpretar.
function msDesdeFechaBD(valor) {
  if (!valor) return null;
  let texto = String(valor).trim().replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(texto)) texto += "Z";
  const ms = Date.parse(texto);
  return Number.isNaN(ms) ? null : ms;
}

function diaYHoraEnMadrid(instante = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(instante).reduce((acc, parte) => (acc[parte.type] = parte.value, acc), {});
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) };
}

// Días naturales (calendario de Madrid) entre dos instantes. Se usa para los
// intervalos de "5 días" en vez de restar milisegundos: la pasada diaria corre
// en el primer tick del cron tras las 10:00, con segundos de diferencia de un
// día a otro, y con una resta exacta de 5*24h un aviso podía retrasarse un día
// entero por esos segundos.
function diasNaturalesMadridEntre(msAntes, msDespues) {
  const dia = (ms) => Date.parse(diaYHoraEnMadrid(new Date(ms)).dia + "T00:00:00Z");
  return Math.round((dia(msDespues) - dia(msAntes)) / INACTIVIDAD_DIA_MS);
}

function construirEmailRecordatorioInactividad({ nombre, diasSinSubir, numeroAviso }) {
  const enlacePanel = `${SITIO_URL}/admin/login.html`;
  const saludo = nombre ? `Hola ${nombre},` : "Hola,";
  const despedida = ["Un abrazo,", "El equipo de El Otro Fútbol"];
  let asunto;
  let parrafos;

  if (numeroAviso >= INACTIVIDAD_AVISOS_HASTA_INCUMPLIMIENTO) {
    // Último aviso: tono amable, pero aquí sí va la referencia al apartado
    // 3.6 (Compromiso) de la guía del medio y lo que pasará si no hay
    // respuesta (a los 5 días se avisa a los admins, ver más abajo).
    asunto = "Sobre tu colaboración en El Otro Fútbol";
    parrafos = [
      `Llevamos ${diasSinSubir} días sin ver ninguna noticia tuya y ya te hemos escrito varias veces. Sabemos que colaboras de forma totalmente voluntaria y que no es ninguna obligación, así que no queremos agobiarte.`,
      "Aun así, tenemos que comentarte que una inactividad tan prolongada no encaja con el compromiso que aceptaste al unirte al medio, recogido en el apartado 3.6 (Compromiso) de la guía del medio.",
      "Si no puedes o ya no te apetece seguir colaborando, no pasa nada: dínoslo y lo dejamos hablado sin ningún problema. Si prefieres seguir, nos encantaría verte publicar de nuevo. Si en los próximos " + INACTIVIDAD_DIAS_HASTA_AVISAR_ADMINS + " días no sabemos nada de ti, la administración tendrá que valorar tu continuidad en el medio.",
      `Puedes entrar al panel cuando quieras: ${enlacePanel}`,
    ];
  } else if (numeroAviso === 1) {
    asunto = "¡Te echamos de menos en El Otro Fútbol!";
    parrafos = [
      `Hace ya ${diasSinSubir} días que no subes ninguna noticia a El Otro Fútbol y queríamos escribirte para saber cómo estás.`,
      "Sabemos que colaboras por voluntad propia y que no es ninguna obligación, así que no te lo tomes como un reproche: es solo un recordatorio amistoso. Como en su día te comprometiste a colaborar con el medio, nos gustaría contar contigo cuando puedas y tengas ganas.",
      "Si estás liado/a o necesitas algo de nuestra parte, dínoslo sin problema.",
      `Puedes entrar al panel cuando quieras: ${enlacePanel}`,
    ];
  } else {
    asunto = "Un recordatorio amistoso de El Otro Fútbol";
    parrafos = [
      `Solo queríamos recordarte que seguimos contando contigo: ya han pasado ${diasSinSubir} días desde tu última noticia.`,
      "Sabemos que colaboras por voluntad propia y que no es una obligación, así que sin ninguna presión. Simplemente, como te comprometiste con el medio, nos haría ilusión volver a ver tu nombre por aquí cuando te venga bien.",
      "Si estás en una etapa con poco tiempo, cuéntanoslo y lo entendemos perfectamente.",
      `Puedes entrar al panel cuando quieras: ${enlacePanel}`,
    ];
  }

  // Nota final: quien recibe el correo puede creer que lo escribe una persona
  // y contestar a la dirección de envío, que nadie lee.
  const notaAutomatico = "Este es un mensaje automático, por favor no respondas a este correo. Si quieres comentarnos algo, escríbenos por el canal habitual del medio.";
  const texto = [saludo, "", ...parrafos.flatMap((p) => [p, ""]), ...despedida, "", "--", notaAutomatico].join("\n");
  const html = [saludo, ...parrafos, despedida.join("<br>")]
    .map((p, i, todos) => (i === todos.length - 1 ? `<p>${p.split("<br>").map(escapeHtmlEmail).join("<br>")}</p>` : `<p>${escapeHtmlEmail(p)}</p>`))
    .join("") + `<p style="color:#777;font-size:12px;margin-top:24px">${escapeHtmlEmail(notaAutomatico)}</p>`;
  return { asunto, texto, html };
}

async function enviarRecordatoriosInactividadSiToca(env) {
  const ahora = new Date();
  const { dia, hora } = diaYHoraEnMadrid(ahora);
  if (hora < INACTIVIDAD_HORA_MADRID) return;
  if (INACTIVIDAD_ULTIMO_DIA_EN_MEMORIA === dia) return;

  if (!env.ELOTROFUTBOL_KV) {
    console.log("Recordatorios de inactividad omitidos: falta el binding ELOTROFUTBOL_KV");
    return;
  }

  try {
    if ((await env.ELOTROFUTBOL_KV.get(INACTIVIDAD_KV_CLAVE)) === dia) {
      INACTIVIDAD_ULTIMO_DIA_EN_MEMORIA = dia;
      return;
    }
    // Se reclama el día ANTES de trabajar: así un tick del cron que llegue
    // mientras esta pasada aún corre no la duplica (y no se envían correos
    // repetidos). Si la pasada falla, se reintenta al día siguiente.
    await env.ELOTROFUTBOL_KV.put(INACTIVIDAD_KV_CLAVE, dia, { expirationTtl: 3 * INACTIVIDAD_DIA_MS / 1000 });
    INACTIVIDAD_ULTIMO_DIA_EN_MEMORIA = dia;

    const { results: redactores } = await env.DB.prepare(
      `SELECT u.id, u.nombre, u.email, u.created_at,
              (SELECT MAX(a.fecha_publicacion) FROM articles a WHERE a.autor_id = u.id) AS ultima_noticia,
              r.ref_actividad, r.avisos_enviados, r.ultimo_aviso_at, r.admins_avisados_at
       FROM users u
       LEFT JOIN recordatorios_inactividad r ON r.user_id = u.id
       WHERE u.rol = 'redactor' AND u.activo = 1`
    ).all();

    const paraAdmins = [];
    let correosEnviados = 0;

    for (const u of redactores || []) {
      const email = (u.email || "").trim();
      if (!email) continue; // sin correo no se le puede avisar (se pide en su primer login)

      const refMs = Math.max(msDesdeFechaBD(u.created_at) ?? 0, msDesdeFechaBD(u.ultima_noticia) ?? 0);
      if (!refMs) continue;

      // ¿Ha subido algo desde que empezó el ciclo actual? Entonces se reinicia.
      const refGuardadaMs = msDesdeFechaBD(u.ref_actividad);
      const hayCicloPrevio = refGuardadaMs !== null && refMs <= refGuardadaMs;
      const avisos = hayCicloPrevio ? (u.avisos_enviados || 0) : 0;
      const ultimoAvisoMs = hayCicloPrevio ? msDesdeFechaBD(u.ultimo_aviso_at) : null;
      const adminsAvisados = hayCicloPrevio && !!u.admins_avisados_at;
      const diasSinSubir = Math.floor((ahora.getTime() - refMs) / INACTIVIDAD_DIA_MS);

      if (avisos === 0) {
        if (diasSinSubir < INACTIVIDAD_DIAS_HASTA_PRIMER_AVISO) continue;
      } else if (avisos < INACTIVIDAD_AVISOS_HASTA_INCUMPLIMIENTO) {
        if (!ultimoAvisoMs || diasNaturalesMadridEntre(ultimoAvisoMs, ahora.getTime()) < INACTIVIDAD_DIAS_ENTRE_AVISOS) continue;
      } else {
        // Ya tiene los 5 avisos: 5 días después del último, se avisa a los admins (una sola vez).
        if (adminsAvisados || !ultimoAvisoMs) continue;
        if (diasNaturalesMadridEntre(ultimoAvisoMs, ahora.getTime()) >= INACTIVIDAD_DIAS_HASTA_AVISAR_ADMINS) {
          paraAdmins.push({ id: u.id, nombre: u.nombre, email, diasSinSubir, refIso: new Date(refMs).toISOString() });
        }
        continue;
      }

      if (correosEnviados >= INACTIVIDAD_MAX_CORREOS_POR_PASADA) continue; // el resto, mañana

      const numeroAviso = avisos + 1;
      const enviado = await enviarEmailNotificacion(
        env,
        construirEmailRecordatorioInactividad({ nombre: u.nombre, diasSinSubir, numeroAviso }),
        { destinatario: email }
      );
      if (!enviado) continue; // el estado no avanza: se reintenta en la próxima pasada
      correosEnviados++;
      await env.DB.prepare(
        `INSERT INTO recordatorios_inactividad (user_id, ref_actividad, avisos_enviados, ultimo_aviso_at, admins_avisados_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           ref_actividad = excluded.ref_actividad,
           avisos_enviados = excluded.avisos_enviados,
           ultimo_aviso_at = excluded.ultimo_aviso_at,
           admins_avisados_at = NULL,
           updated_at = excluded.updated_at`
      ).bind(u.id, new Date(refMs).toISOString(), numeroAviso, ahora.toISOString()).run();
      await registrarHistorialAviso(env, { userId: u.id, cicloPrevio: hayCicloPrevio, numeroAviso, enviadoAtIso: ahora.toISOString(), diasSinSubir });
      // Pausa entre correos: Resend limita el ritmo de envío (unas 2 peticiones
      // por segundo por defecto) y un 429 por ritmo se trataría como fallo de
      // cuenta, gastando la secundaria sin necesidad.
      await new Promise((resolver) => setTimeout(resolver, 600));
    }

    if (paraAdmins.length) await avisarAdminsDeExpulsion(env, paraAdmins, ahora);
  } catch (err) {
    console.log("Error en los recordatorios de inactividad de redactores:", err.message);
  }
}

// Un único correo a todos los admins con los redactores que hay que
// expulsar en esta pasada. Si ningún admin tiene email, va a la dirección
// general del medio.
async function avisarAdminsDeExpulsion(env, usuarios, ahora) {
  const { results: admins } = await env.DB.prepare(
    "SELECT email FROM users WHERE rol = 'admin' AND activo = 1 AND email IS NOT NULL AND TRIM(email) <> ''"
  ).all();
  const destinatarios = [...new Set((admins || []).map((a) => a.email.trim()))];
  if (!destinatarios.length) destinatarios.push(EMAIL_NOTIFICACIONES);

  const lineas = usuarios.map(
    (u) => `- ${u.nombre} (${u.email}): ${u.diasSinSubir} días sin subir nada; ${INACTIVIDAD_AVISOS_HASTA_INCUMPLIMIENTO} avisos enviados y otros ${INACTIVIDAD_DIAS_HASTA_AVISAR_ADMINS} días sin respuesta.`
  );
  const asunto = usuarios.length === 1
    ? `Se debe expulsar a ${usuarios[0].nombre} por inactividad`
    : `Se debe expulsar a ${usuarios.length} redactores por inactividad`;
  const texto = [
    "Los siguientes redactores han incumplido las normativas del medio (apartado 3.6, Compromiso, de la guía del medio): han recibido los 5 avisos de inactividad y siguen sin subir ninguna noticia.",
    "",
    ...lineas,
    "",
    "Se tiene que expulsar a estos usuarios. La expulsión no es automática: hay que hacerla desde el panel de Usuarios.",
  ].join("\n");
  const html = `<p>Los siguientes redactores han incumplido las normativas del medio (apartado 3.6, Compromiso, de la guía del medio): han recibido los ${INACTIVIDAD_AVISOS_HASTA_INCUMPLIMIENTO} avisos de inactividad y siguen sin subir ninguna noticia.</p><ul>` +
    usuarios.map((u) => `<li><strong>${escapeHtmlEmail(u.nombre)}</strong> (${escapeHtmlEmail(u.email)}): ${u.diasSinSubir} días sin subir nada.</li>`).join("") +
    `</ul><p><strong>Se tiene que expulsar a estos usuarios.</strong> La expulsión no es automática: hay que hacerla desde el panel de Usuarios.</p>`;

  let algunoEnviado = false;
  for (const destinatario of destinatarios) {
    if (await enviarEmailNotificacion(env, { asunto, texto, html }, { destinatario })) algunoEnviado = true;
  }
  if (!algunoEnviado) return; // se reintenta en la próxima pasada

  const marcas = usuarios.map((u) => env.DB.prepare(
    "UPDATE recordatorios_inactividad SET admins_avisados_at = ?, updated_at = datetime('now') WHERE user_id = ?"
  ).bind(ahora.toISOString(), u.id));
  await env.DB.batch(marcas);
}

// Historial de avisos de inactividad: una entrada por aviso enviado en el ciclo
// actual ({ numero, enviado_at, dias_sin_subir }), guardada como JSON en
// recordatorios_inactividad.historial_avisos. Sirve para que los admins vean
// el detalle de cada aviso en Usuarios. Es "best effort": si la columna aún no
// existe (migracion_recordatorios_inactividad_historial.sql sin aplicar) se
// ignora el error y los avisos se envían igual.
function parsearHistorialAvisos(valor) {
  if (!valor) return [];
  try {
    const lista = typeof valor === "string" ? JSON.parse(valor) : valor;
    if (!Array.isArray(lista)) return [];
    return lista
      .filter((h) => h && Number.isFinite(Number(h.numero)) && typeof h.enviado_at === "string")
      .map((h) => ({
        numero: Number(h.numero),
        enviado_at: h.enviado_at,
        dias_sin_subir: Number.isFinite(Number(h.dias_sin_subir)) ? Number(h.dias_sin_subir) : null,
      }));
  } catch {
    return [];
  }
}

async function registrarHistorialAviso(env, { userId, cicloPrevio, numeroAviso, enviadoAtIso, diasSinSubir }) {
  try {
    let historial = [];
    if (cicloPrevio) {
      const fila = await env.DB.prepare("SELECT historial_avisos FROM recordatorios_inactividad WHERE user_id = ?").bind(userId).first();
      historial = parsearHistorialAvisos(fila?.historial_avisos);
    }
    historial = historial.filter((h) => h.numero !== numeroAviso);
    historial.push({ numero: numeroAviso, enviado_at: enviadoAtIso, dias_sin_subir: diasSinSubir });
    await env.DB.prepare(
      "UPDATE recordatorios_inactividad SET historial_avisos = ?, updated_at = datetime('now') WHERE user_id = ?"
    ).bind(JSON.stringify(historial), userId).run();
  } catch (err) {
    console.log("No se pudo guardar el historial del aviso de inactividad:", err.message);
  }
}

// Estado de los avisos de inactividad de cada redactor, para que los admins
// lo vean en Usuarios (GET /api/users). Aplica la MISMA lógica de ciclo que
// enviarRecordatoriosInactividadSiToca: si el redactor ha subido algo después
// de la referencia guardada, el ciclo se reinicia y no tiene avisos vigentes.
// Solo lectura. Si la tabla aún no existe (migración sin aplicar) devuelve un
// mapa vacío y el listado de usuarios sigue funcionando.
async function cargarEstadoInactividadUsuarios(env, usuarios) {
  const mapa = new Map();
  try {
    const [estados, ultimas] = await Promise.all([
      env.DB.prepare(
        "SELECT user_id, ref_actividad, avisos_enviados, ultimo_aviso_at, admins_avisados_at FROM recordatorios_inactividad"
      ).all(),
      env.DB.prepare(
        "SELECT autor_id, MAX(fecha_publicacion) AS ultima_noticia FROM articles WHERE autor_id IS NOT NULL GROUP BY autor_id"
      ).all(),
    ]);
    // El historial va en una consulta aparte: si la columna aún no existe, el
    // resto del estado sigue funcionando.
    const historialPorUsuario = new Map();
    try {
      const { results: hist } = await env.DB.prepare("SELECT user_id, historial_avisos FROM recordatorios_inactividad").all();
      for (const h of hist || []) historialPorUsuario.set(Number(h.user_id), h.historial_avisos);
    } catch (err) {
      console.log("Historial de avisos de inactividad no disponible todavía:", err.message);
    }
    const estadoPorUsuario = new Map((estados.results || []).map((f) => [Number(f.user_id), f]));
    const ultimaPorUsuario = new Map((ultimas.results || []).map((f) => [Number(f.autor_id), f.ultima_noticia]));
    const ahoraMs = Date.now();

    for (const u of usuarios) {
      if (u.rol !== "redactor") continue; // admins y fotógrafos no entran en el ciclo
      const ultimaNoticia = ultimaPorUsuario.get(Number(u.id)) || null;
      const refMs = Math.max(msDesdeFechaBD(u.created_at) ?? 0, msDesdeFechaBD(ultimaNoticia) ?? 0);
      const f = estadoPorUsuario.get(Number(u.id));
      const refGuardadaMs = f ? msDesdeFechaBD(f.ref_actividad) : null;
      const hayCicloVigente = !!f && refGuardadaMs !== null && refMs > 0 && refMs <= refGuardadaMs;
      mapa.set(Number(u.id), {
        dias_sin_subir: refMs ? Math.max(0, Math.floor((ahoraMs - refMs) / INACTIVIDAD_DIA_MS)) : null,
        ultima_noticia: ultimaNoticia,
        referencia_at: refMs ? new Date(refMs).toISOString() : null, // última noticia o, si no hay, alta de la cuenta
        avisos_enviados: hayCicloVigente ? (Number(f.avisos_enviados) || 0) : 0,
        avisos_maximo: INACTIVIDAD_AVISOS_HASTA_INCUMPLIMIENTO,
        dias_hasta_primer_aviso: INACTIVIDAD_DIAS_HASTA_PRIMER_AVISO,
        ultimo_aviso_at: hayCicloVigente ? (f.ultimo_aviso_at || null) : null,
        avisos: hayCicloVigente ? parsearHistorialAvisos(historialPorUsuario.get(Number(u.id))) : [],
        admins_avisados_at: hayCicloVigente ? (f.admins_avisados_at || null) : null,
      });
    }
  } catch (err) {
    console.log("No se pudo cargar el estado de inactividad de los usuarios:", err.message);
  }
  return mapa;
}


/*
 * ================================================================
 * PARTIDAZO DE LA JORNADA
 *
 * Cada jornada se marca automáticamente UN partidazo por liga
 * (LaLiga Hypermotion, Primera Federación y Segunda Federación → 3 por
 * jornada). Es una mecánica fija, sin intervención de la redacción:
 * cada partido de la jornada recibe una puntuación según varios
 * criterios y gana el que más puntos suma.
 *
 * Criterios (ver puntuarPartidazo):
 *  - Derbi: local (misma ciudad) o regional (misma provincia/comunidad),
 *    según la lista curada PARTIDAZO_DERBIS.
 *  - Puntos en disputa: duelo directo por arriba (ambos en puestos de
 *    ascenso/play-off) o por abajo (ambos en puestos de descenso), más
 *    fuerte cuanto más cerca estén en puntos. Se refuerza en el tramo
 *    final de la temporada.
 *  - Choque de líderes / duelo de colistas (ambos entre los 3 primeros
 *    o entre los 3 últimos de su grupo).
 *  - Dos equipos en racha (≥10 de 15 puntos en sus últimos 5 partidos).
 *
 * La clasificación se calcula con los partidos FINALIZADOS de las
 * jornadas anteriores de la temporada en curso, dentro del mismo grupo.
 * En Segunda Federación (varios grupos) se elige UN partidazo entre
 * todos los grupos.
 *
 * Cuándo se calcula: el cron lo llama en cada tick pero se autolimita a
 * una pasada cada PARTIDAZO_INTERVALO_MS. En cada pasada se evalúa la
 * próxima jornada (la primera sin ningún partido empezado) y se vuelve a
 * recalcular mientras no empiece, para ir incorporando resultados y
 * partidos recién creados. En cuanto empieza algún partido de la jornada
 * el partidazo queda congelado (salvo que el elegido se anule/retrase y
 * queden partidos por jugar, en cuyo caso se vuelve a elegir).
 *
 * Se guarda en results: partidazo (0/1), partidazo_puntuacion y
 * partidazo_motivos (JSON con las etiquetas que se enseñan en web y
 * panel). Solo se calcula en el Worker principal: Postgres lo recibe por
 * el sincronizador (ver worker-secondary/db/migrations/035_partidazo.sql).
 * ================================================================
 */
const PARTIDAZO_COMPETICIONES = ["hypermotion", "primera_federacion", "segunda_federacion"];
const PARTIDAZO_INTERVALO_MS = 3 * 60 * 60 * 1000; // una pasada cada 3 h
const PARTIDAZO_KV_CLAVE = "partidazo_ultima_pasada";
let PARTIDAZO_ULTIMA_PASADA_MS = 0;

// Puestos que se consideran "zona alta" (ascenso directo + play-off) y
// "zona baja" (descenso) dentro de cada grupo. Son aproximaciones para
// puntuar el partido, no la normativa exacta: ajustar aquí si hace falta.
const PARTIDAZO_ZONAS = {
  hypermotion: { alta: 6, baja: 4 },
  primera_federacion: { alta: 5, baja: 5 },
  segunda_federacion: { alta: 5, baja: 5 },
};

// Pesos de cada criterio (puntos que suma a la puntuación del partido).
const PARTIDAZO_PESOS = {
  derbiLocal: 40,
  derbiRegional: 25,
  duelo_arriba: 24,
  duelo_abajo: 22,
  choqueLideres: 8,
  duelo_colistas: 6,
  racha: 8,
  factorRectaFinal: 1.25, // multiplica los puntos de clasificación en el último 25% de la liga
};

// Derbis conocidos (nombres tal cual aparecen en public/js/clubs.js).
// "local" = misma ciudad/área metropolitana; "regional" = misma provincia
// o comunidad. Para añadir uno nuevo basta una línea más.
const PARTIDAZO_DERBIS = [
  // LaLiga Hypermotion
  ["Real Oviedo", "Real Sporting", "regional"],
  ["CD Tenerife", "UD Las Palmas", "regional"],
  ["SD Eibar", "Real Sociedad B", "regional"],
  ["Cádiz CF", "UD Almería", "regional"],
  ["Córdoba CF", "Granada CF", "regional"],
  ["Córdoba CF", "Cádiz CF", "regional"],
  ["Granada CF", "UD Almería", "regional"],
  ["Girona FC", "CE Sabadell", "regional"],
  ["Burgos CF", "Real Valladolid CF", "regional"],
  // Primera Federación
  ["Racing Club Ferrol", "RC Deportivo Fabril", "regional"],
  ["Pontevedra CF", "RC Deportivo Fabril", "regional"],
  ["Pontevedra CF", "Racing Club Ferrol", "regional"],
  ["UD Ourense", "Pontevedra CF", "regional"],
  ["CD Lugo", "Racing Club Ferrol", "regional"],
  ["CD Lugo", "RC Deportivo Fabril", "regional"],
  ["Barakaldo CF", "Bilbao Athletic", "local"],
  ["Arenas Club", "Barakaldo CF", "regional"],
  ["Arenas Club", "Bilbao Athletic", "regional"],
  ["Cultural Leonesa", "SD Ponferradina", "regional"],
  ["Zamora CF", "Unionistas de Salamanca CF", "regional"],
  ["AD Mérida", "CP Cacereño", "regional"],
  ["AD Mérida", "CD Extremadura", "regional"],
  ["CD Extremadura", "CP Cacereño", "regional"],
  ["CD Coria", "CP Cacereño", "regional"],
  ["AD Alcorcón", "CF Rayo Majadahonda", "regional"],
  ["Atlético Madrileño", "Real Madrid Castilla", "local"],
  ["Atlético Madrileño", "AD Alcorcón", "regional"],
  ["Real Madrid Castilla", "AD Alcorcón", "regional"],
  ["Real Madrid Castilla", "CF Rayo Majadahonda", "regional"],
  ["Real Murcia CF", "FC Cartagena", "regional"],
  ["Real Murcia CF", "Águilas FC", "regional"],
  ["FC Cartagena", "Águilas FC", "regional"],
  ["Real Zaragoza", "SD Huesca", "regional"],
  ["Real Zaragoza", "CD Teruel", "regional"],
  ["SD Huesca", "CD Teruel", "regional"],
  ["CE Europa", "UE Sant Andreu", "local"],
  ["Gimnàstic de Tarragona", "CE Europa", "regional"],
  ["Real Jaén CF", "Antequera CF", "regional"],
  ["Algeciras CF", "Antequera CF", "regional"],
  // Segunda Federación
  ["Club Portugalete", "Sestao River", "local"],
  ["Club Portugalete", "SD Amorebieta", "regional"],
  ["Sestao River", "CD Basconia", "regional"],
  ["SD Gernika", "SD Amorebieta", "regional"],
  ["UD Llanera", "Club Marino de Luanco", "regional"],
  ["Real Oviedo Vetusta", "Club Marino de Luanco", "regional"],
  ["Real Oviedo Vetusta", "UD Llanera", "regional"],
  ["Arosa SC", "Coruxo", "regional"],
  ["SD Compostela", "Bergantiños", "regional"],
  ["FC Barcelona Atlètic", "RCD Espanyol B", "local"],
  ["CE Manresa", "Terrassa", "regional"],
  ["UE Olot", "Girona FC B", "regional"],
  ["CD Ebro", "Utebo FC", "local"],
  ["Atlético Osasuna B", "CD Tudelano", "regional"],
  ["SD Logroñés", "UD Logroñés B", "local"],
  ["Náxara", "CD Arnedo", "regional"],
  ["UCAM Murcia", "Real Murcia Imperial", "local"],
  ["UD Castellonense", "CD Castellón B", "local"],
  ["CD Alcoyano", "CF La Nucía", "regional"],
  ["Orihuela CF", "Elche Ilicitano", "regional"],
  ["UD Poblense", "CD Atlético Baleares", "regional"],
  ["RCD Mallorca B", "CD Atlético Baleares", "regional"],
  ["RCD Mallorca B", "UD Poblense", "regional"],
  ["Sevilla Atlético", "Betis Deportivo", "local"],
  ["CD Tenerife B", "Las Palmas Atlético", "regional"],
  ["CD Tenerife B", "UD Tamaraceite", "regional"],
  ["Las Palmas Atlético", "UD Tamaraceite", "local"],
  ["Marbella FC", "CD Estepona", "regional"],
  ["Marbella FC", "CP Mijas Las Lagunas", "regional"],
  ["CD Estepona", "CP Mijas Las Lagunas", "regional"],
  ["CD Ciudad de Lucena", "Salerm Cosmetics Puente Genil", "regional"],
  ["CD Badajoz", "CD Don Benito", "regional"],
  ["Real Madrid C", "Atlético de Madrid C", "local"],
  ["Getafe B", "CDA Navalcarnero", "regional"],
  ["RSD Alcalá", "UD San Sebastián de los Reyes", "regional"],
  ["Real Ávila", "Gimnástica Segoviana", "regional"],
  ["Real Valladolid Promesas", "Atlético Tordesillas", "regional"],
];

function normalizarNombreEquipoPartidazo(nombre) {
  return String(nombre || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function claveParejaPartidazo(a, b) {
  return [normalizarNombreEquipoPartidazo(a), normalizarNombreEquipoPartidazo(b)].sort().join("|");
}

const PARTIDAZO_DERBIS_MAPA = new Map(
  PARTIDAZO_DERBIS.map(([a, b, tipo]) => [claveParejaPartidazo(a, b), tipo])
);

// Puntuación de un partido. "ctx" = { tabla: Map(equipo → {pos, pts, pj, forma}),
// zonas: {alta, baja}, nEquipos, rectaFinal }. Devuelve { puntos, motivos, sumaPos }.
function puntuarPartidazo(partido, ctx) {
  let puntos = 0;
  const motivos = [];
  const P = PARTIDAZO_PESOS;

  const tipoDerbi = PARTIDAZO_DERBIS_MAPA.get(claveParejaPartidazo(partido.equipo_local, partido.equipo_visitante));
  if (tipoDerbi === "local") { puntos += P.derbiLocal; motivos.push("Derbi local"); }
  else if (tipoDerbi === "regional") { puntos += P.derbiRegional; motivos.push("Derbi regional"); }

  const a = ctx.tabla.get(partido.equipo_local);
  const b = ctx.tabla.get(partido.equipo_visitante);
  // Con menos de 2 partidos jugados por equipo la clasificación no dice nada.
  if (a && b && a.pj >= 2 && b.pj >= 2) {
    const dif = Math.abs(a.pts - b.pts);
    const cercania = dif <= 3 ? 1 : dif <= 6 ? 0.75 : 0.5;
    const umbralBaja = ctx.nEquipos - ctx.zonas.baja; // pos > umbralBaja = zona de descenso
    let tabla = 0;

    if (a.pos <= ctx.zonas.alta && b.pos <= ctx.zonas.alta) {
      tabla += P.duelo_arriba * cercania;
      motivos.push("Duelo directo por el ascenso");
      if (a.pos <= 3 && b.pos <= 3) { tabla += P.choqueLideres; motivos.push("Choque de líderes"); }
    } else if (a.pos > umbralBaja && b.pos > umbralBaja) {
      tabla += P.duelo_abajo * cercania;
      motivos.push("Duelo directo por la permanencia");
      if (a.pos > ctx.nEquipos - 3 && b.pos > ctx.nEquipos - 3) { tabla += P.duelo_colistas; motivos.push("Duelo de colistas"); }
    }
    if (tabla > 0 && ctx.rectaFinal) { tabla *= P.factorRectaFinal; motivos.push("Recta final de la liga"); }
    puntos += tabla;

    if (a.forma.n >= 5 && b.forma.n >= 5 && a.forma.pts >= 10 && b.forma.pts >= 10) {
      puntos += P.racha; motivos.push("Dos equipos en racha");
    }
  }

  const sumaPos = (ctx.tabla.get(partido.equipo_local)?.pos ?? 99) + (ctx.tabla.get(partido.equipo_visitante)?.pos ?? 99);
  return { puntos: Math.round(puntos), motivos, sumaPos };
}

// Clasificación (y forma de los últimos 5) de un grupo a partir de sus
// partidos finalizados. Reutiliza calcularClasificacionBoletin para el orden.
function tablaParaPartidazo(partidosFinalizados) {
  const filas = calcularClasificacionBoletin(partidosFinalizados);
  const mapa = new Map();
  filas.forEach((f, i) => mapa.set(f.equipo, { pos: i + 1, pts: f.pts, pj: f.pj, forma: { n: 0, pts: 0 } }));
  const porEquipo = new Map();
  partidosFinalizados
    .slice()
    .sort((x, y) => x.jornada - y.jornada)
    .forEach((p) => {
      const gl = p.goles_local, gv = p.goles_visitante;
      const ptsL = gl > gv ? 3 : gl === gv ? 1 : 0;
      const ptsV = gv > gl ? 3 : gl === gv ? 1 : 0;
      if (!porEquipo.has(p.equipo_local)) porEquipo.set(p.equipo_local, []);
      if (!porEquipo.has(p.equipo_visitante)) porEquipo.set(p.equipo_visitante, []);
      porEquipo.get(p.equipo_local).push(ptsL);
      porEquipo.get(p.equipo_visitante).push(ptsV);
    });
  porEquipo.forEach((lista, equipo) => {
    const ultimos = lista.slice(-5);
    const fila = mapa.get(equipo);
    if (fila) fila.forma = { n: ultimos.length, pts: ultimos.reduce((s, x) => s + x, 0) };
  });
  return mapa;
}

function inicioTemporadaPartidazo(ahora = new Date()) {
  const anio = ahora.getUTCMonth() >= 6 ? ahora.getUTCFullYear() : ahora.getUTCFullYear() - 1;
  return `${anio}-07-01`;
}

function timestampFechaPartidazo(p) {
  const ms = msDesdeFechaBD(p.fecha_partido);
  return ms === null ? Infinity : ms;
}

// Grupo "real" de cada equipo, deducido de los propios partidos: dos
// equipos que se han enfrentado (o se van a enfrentar) están en el mismo
// grupo. Así no dependemos de results.grupo, que puede venir vacío (p.ej.
// Primera Federación: el panel lo deja NULL si no se elige a mano, y
// Segunda Federación solo lo autorrellena si el club está en la lista) y
// la clasificación no mezcla grupos distintos.
function gruposPorEquipoPartidazo(partidos) {
  const padre = new Map();
  const raiz = (x) => {
    while (padre.get(x) !== x) { padre.set(x, padre.get(padre.get(x))); x = padre.get(x); }
    return x;
  };
  partidos.forEach((p) => {
    [p.equipo_local, p.equipo_visitante].forEach((e) => { if (!padre.has(e)) padre.set(e, e); });
    const ra = raiz(p.equipo_local), rb = raiz(p.equipo_visitante);
    if (ra !== rb) padre.set(ra, rb);
  });
  const grupo = new Map();
  padre.forEach((_, e) => grupo.set(e, raiz(e)));
  return grupo;
}

// Elige el partidazo entre "candidatos" (partidos pendientes de UNA
// jornada). "partidosTemporada" = todos los de la competición en la
// temporada, para calcular las clasificaciones de cada grupo.
function elegirPartidazoJornada(competicion, jornada, candidatos, partidosTemporada) {
  const zonas = PARTIDAZO_ZONAS[competicion] || { alta: 5, baja: 5 };
  const grupoDe = gruposPorEquipoPartidazo(partidosTemporada);
  const porGrupo = new Map(); // raíz de grupo → { tabla, nEquipos, rectaFinal }

  new Set(candidatos.map((p) => grupoDe.get(p.equipo_local))).forEach((g) => {
    const delGrupo = partidosTemporada.filter((p) => grupoDe.get(p.equipo_local) === g);
    const equipos = new Set();
    delGrupo.forEach((p) => { equipos.add(p.equipo_local); equipos.add(p.equipo_visitante); });
    const previos = delGrupo.filter((p) =>
      p.estado === "finalizado" && p.jornada < jornada &&
      p.goles_local !== null && p.goles_local !== undefined &&
      p.goles_visitante !== null && p.goles_visitante !== undefined
    );
    const nEquipos = equipos.size;
    const jornadasTotales = Math.max(1, (nEquipos - 1) * 2);
    porGrupo.set(g, {
      tabla: tablaParaPartidazo(previos),
      nEquipos,
      rectaFinal: jornada >= Math.ceil(jornadasTotales * 0.75),
    });
  });

  let mejor = null;
  candidatos.forEach((p) => {
    const g = porGrupo.get(grupoDe.get(p.equipo_local));
    const r = puntuarPartidazo(p, { tabla: g.tabla, zonas, nEquipos: g.nEquipos, rectaFinal: g.rectaFinal });
    const entrada = { partido: p, ...r, ts: timestampFechaPartidazo(p) };
    if (
      !mejor ||
      entrada.puntos > mejor.puntos ||
      (entrada.puntos === mejor.puntos && (
        entrada.sumaPos < mejor.sumaPos ||
        (entrada.sumaPos === mejor.sumaPos && (entrada.ts < mejor.ts || (entrada.ts === mejor.ts && p.id < mejor.partido.id)))
      ))
    ) mejor = entrada;
  });
  return mejor;
}

// Un único partidazo ACTIVO por competición: el de la próxima jornada por
// jugar. La jornada se decide por FECHA, no por el número más bajo sin
// empezar: en las ligas con varios grupos (Segunda RFEF tiene 5) las
// jornadas se desfasan por aplazados y partidos entre semana, y casi
// siempre algún grupo ya ha empezado "la jornada N", con lo que mirar solo
// el número dejaba la liga sin partidazo. Se toma el partido pendiente más
// próximo en el tiempo y, de su jornada, todos los pendientes de la misma
// ronda (como máximo PARTIDAZO_VENTANA_DIAS días después).
const PARTIDAZO_VENTANA_DIAS = 9;
const PARTIDAZO_MARGEN_PASADO_MS = 6 * 60 * 60 * 1000;

async function calcularPartidazosCompeticion(env, competicion, desde) {
  const { results } = await env.DB.prepare(
    `SELECT id, grupo, jornada, equipo_local, equipo_visitante, goles_local, goles_visitante,
            estado, fecha_partido, partidazo
     FROM results
     WHERE competicion = ? AND (fecha_partido >= ? OR fecha_partido IS NULL)`
  ).bind(competicion, desde).all();
  const partidos = results || [];
  if (!partidos.length) return 0;
  const ahora = Date.now();
  const sentencias = [];
  const quitar = (p) => sentencias.push(env.DB.prepare(
    "UPDATE results SET partidazo = 0, partidazo_puntuacion = NULL, partidazo_motivos = NULL WHERE id = ? AND partidazo = 1"
  ).bind(p.id));

  // Pendientes con fecha y todavía vigentes (se descartan "programados" con
  // fecha ya muy pasada: partidos que nadie cerró y que falsearían la jornada).
  const pendientes = partidos.filter((p) =>
    p.estado === "programado" && timestampFechaPartidazo(p) >= ahora - PARTIDAZO_MARGEN_PASADO_MS &&
    timestampFechaPartidazo(p) !== Infinity
  );
  if (!pendientes.length) {
    // Nada por jugar con fecha: no hay partidazo activo que mostrar.
    partidos.filter((p) => p.partidazo === 1 && p.estado === "programado").forEach(quitar);
    if (sentencias.length) await env.DB.batch(sentencias);
    return sentencias.length;
  }

  const primero = pendientes.reduce((m, p) => (timestampFechaPartidazo(p) < timestampFechaPartidazo(m) ? p : m));
  const jornada = primero.jornada;
  const limite = timestampFechaPartidazo(primero) + PARTIDAZO_VENTANA_DIAS * 24 * 60 * 60 * 1000;
  const candidatos = pendientes.filter((p) => p.jornada === jornada && timestampFechaPartidazo(p) <= limite);

  // Marcas pendientes de otras rondas (jornada anterior mal cerrada, futuras
  // calculadas antes...) fuera: solo puede haber uno activo.
  const idsCandidatos = new Set(candidatos.map((p) => p.id));
  partidos.filter((p) => p.partidazo === 1 && p.estado === "programado" && !(p.jornada === jornada && idsCandidatos.has(p.id))).forEach(quitar);

  // Si en esa misma jornada el partidazo ya se está jugando o se jugó, queda fijo.
  const fijo = partidos.find((p) => p.jornada === jornada && p.partidazo === 1 && (p.estado === "en_juego" || p.estado === "finalizado"));
  if (!fijo) {
    const mejor = elegirPartidazoJornada(competicion, jornada, candidatos, partidos);
    if (mejor) {
      const motivos = JSON.stringify(mejor.motivos);
      candidatos.filter((p) => p.partidazo === 1 && p.id !== mejor.partido.id).forEach(quitar);
      // El WHERE evita reescribir la fila (y refrescar updated_at → sync) si no cambia nada.
      sentencias.push(env.DB.prepare(
        "UPDATE results SET partidazo = 1, partidazo_puntuacion = ?, partidazo_motivos = ? WHERE id = ? AND (partidazo != 1 OR partidazo_puntuacion IS NOT ? OR partidazo_motivos IS NOT ?)"
      ).bind(mejor.puntos, motivos, mejor.partido.id, mejor.puntos, motivos));
    }
  }
  if (sentencias.length) await env.DB.batch(sentencias);
  return sentencias.length;
}

async function calcularPartidazosSiToca(env) {
  const ahoraMs = Date.now();
  if (ahoraMs - PARTIDAZO_ULTIMA_PASADA_MS < PARTIDAZO_INTERVALO_MS) return;
  PARTIDAZO_ULTIMA_PASADA_MS = ahoraMs;
  try {
    if (env.ELOTROFUTBOL_KV) {
      const ultima = parseInt((await env.ELOTROFUTBOL_KV.get(PARTIDAZO_KV_CLAVE)) || "0", 10);
      if (ahoraMs - ultima < PARTIDAZO_INTERVALO_MS) { PARTIDAZO_ULTIMA_PASADA_MS = Math.max(ultima, PARTIDAZO_ULTIMA_PASADA_MS); return; }
      await env.ELOTROFUTBOL_KV.put(PARTIDAZO_KV_CLAVE, String(ahoraMs), { expirationTtl: 24 * 60 * 60 });
    }
    const desde = inicioTemporadaPartidazo(new Date(ahoraMs));
    for (const competicion of PARTIDAZO_COMPETICIONES) {
      try {
        await calcularPartidazosCompeticion(env, competicion, desde);
      } catch (err) {
        console.log(`Error calculando partidazo (${competicion}):`, err.message);
      }
    }
  } catch (err) {
    console.log("Error en la pasada de partidazos:", err.message);
  }
}


// ============================================================
// NOTIFICACIONES PUSH (Web Push, RFC 8030 + cifrado RFC 8291 + VAPID RFC 8292)
// ============================================================
// Todo se hace con WebCrypto, sin dependencias. Secretos necesarios en el
// worker (ver README del push): VAPID_PRIVATE_JWK (secreto, JSON de la
// clave privada ECDSA P-256 con x, y, d) y, opcionalmente, VAPID_SUBJECT
// (mailto: o https: de contacto; por defecto el del sitio).
//
// Tabla push_subscriptions: una fila por navegador/dispositivo suscrito.
// "noticias" y "partidos" son los dos tipos de aviso que se pueden elegir.
// Si falta VAPID_PRIVATE_JWK el push queda desactivado sin romper nada:
// /api/push/clave responde 503 y los avisos se omiten en silencio.

// Solo se envia a los servicios push de los navegadores. Sin esta lista,
// cualquiera podria registrar como "endpoint" una URL cualquiera y usar el
// worker para hacer peticiones POST a donde quisiera (SSRF).
const PUSH_HOSTS_PERMITIDOS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];
// Tope de destinatarios por aviso: los workers limitan las peticiones
// salientes por ejecucion (1000 en plan de pago). Se deja margen.
const PUSH_MAX_DESTINATARIOS = 900;
const PUSH_LOTE_PARALELO = 25;

let PUSH_CLAVES_CACHE = null;

function pushB64uABytes(b64u) {
  const rel = "=".repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob((b64u + rel).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function pushBytesAB64u(bytes) {
  let s = "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pushConcat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function pushEndpointValido(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") return false;
    if (endpoint.length > 700) return false;
    return PUSH_HOSTS_PERMITIDOS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

// Carga (y cachea en memoria) la clave VAPID. Devuelve null si el push no
// esta configurado o la clave es invalida.
async function pushCargarClaves(env) {
  if (PUSH_CLAVES_CACHE && PUSH_CLAVES_CACHE.origen === env.VAPID_PRIVATE_JWK) return PUSH_CLAVES_CACHE;
  if (!env.VAPID_PRIVATE_JWK) return null;
  try {
    const jwk = typeof env.VAPID_PRIVATE_JWK === "string" ? JSON.parse(env.VAPID_PRIVATE_JWK) : env.VAPID_PRIVATE_JWK;
    const privada = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
    const publicaRaw = pushConcat(new Uint8Array([4]), pushB64uABytes(jwk.x), pushB64uABytes(jwk.y));
    PUSH_CLAVES_CACHE = { origen: env.VAPID_PRIVATE_JWK, privada, publicaB64u: pushBytesAB64u(publicaRaw) };
    return PUSH_CLAVES_CACHE;
  } catch (err) {
    console.error("VAPID_PRIVATE_JWK invalida:", err.message);
    return null;
  }
}

// JWT ES256 para la cabecera Authorization (VAPID).
async function pushFirmarVapid(claves, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const cabecera = pushBytesAB64u(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const claims = pushBytesAB64u(new TextEncoder().encode(JSON.stringify({ aud, exp, sub: subject })));
  const firmando = `${cabecera}.${claims}`;
  // WebCrypto devuelve la firma ECDSA ya en formato r||s (IEEE P1363),
  // que es justo lo que pide JWS.
  const firma = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, claves.privada, new TextEncoder().encode(firmando));
  return `${firmando}.${pushBytesAB64u(firma)}`;
}

async function pushHkdf(salt, ikm, info, longitud) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, longitud * 8);
  return new Uint8Array(bits);
}

// Cifra el mensaje para un navegador concreto (aes128gcm, RFC 8291).
async function pushCifrar(p256dhB64u, authB64u, textoPlano) {
  const uaPublica = pushB64uABytes(p256dhB64u); // 65 bytes
  const authSecret = pushB64uABytes(authB64u); // 16 bytes
  if (uaPublica.length !== 65 || authSecret.length < 8) throw new Error("claves de suscripcion invalidas");

  const par = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublica = new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublica, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secretoEcdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, par.privateKey, 256));

  const enc = new TextEncoder();
  const prk = await pushHkdf(authSecret, secretoEcdh, pushConcat(enc.encode("WebPush: info\0"), uaPublica, asPublica), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await pushHkdf(salt, prk, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await pushHkdf(salt, prk, enc.encode("Content-Encoding: nonce\0"), 12);

  // Un solo registro: datos + delimitador 0x02 (ultimo registro).
  const claro = pushConcat(enc.encode(textoPlano), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, claro));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // tamano de registro 4096
  return pushConcat(salt, rs, new Uint8Array([asPublica.length]), asPublica, cifrado);
}

// Envia un push a una suscripcion. Devuelve el status HTTP del servicio
// push (201 = aceptado; 404/410 = suscripcion caducada).
async function pushEnviarUno(env, claves, sub, mensaje, opciones = {}) {
  const cuerpo = await pushCifrar(sub.p256dh, sub.auth, JSON.stringify(mensaje));
  const subject = env.VAPID_SUBJECT || "mailto:contacto@elotrofutbol.media";
  const jwt = await pushFirmarVapid(claves, sub.endpoint, subject);
  const resp = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${claves.publicaB64u}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(opciones.ttl ?? 3600),
      Urgency: opciones.urgencia || "normal",
      ...(opciones.topic ? { Topic: opciones.topic } : {}),
    },
    body: cuerpo,
  });
  return resp.status;
}

// Envia un aviso a todas las suscripciones de un tipo ("noticias" o
// "partidos"). Nunca lanza: un fallo de push jamas debe romper la
// publicacion de una noticia ni el registro de un gol.
async function pushEnviarATopico(env, topico, mensaje, opciones = {}) {
  try {
    if (topico !== "noticias" && topico !== "partidos") return { enviados: 0 };
    const claves = await pushCargarClaves(env);
    if (!claves) return { enviados: 0, desactivado: true };
    const { results } = await env.DB.prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE ${topico} = 1 ORDER BY id LIMIT ?`
    ).bind(PUSH_MAX_DESTINATARIOS).all();
    const subs = results || [];
    let enviados = 0;
    const caducadas = [];
    for (let i = 0; i < subs.length; i += PUSH_LOTE_PARALELO) {
      const lote = subs.slice(i, i + PUSH_LOTE_PARALELO);
      const estados = await Promise.allSettled(lote.map((s) => pushEnviarUno(env, claves, s, mensaje, opciones)));
      estados.forEach((e, idx) => {
        if (e.status === "fulfilled") {
          if (e.value >= 200 && e.value < 300) enviados++;
          else if (e.value === 404 || e.value === 410) caducadas.push(lote[idx].id);
        }
      });
    }
    for (const id of caducadas) {
      try { await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(id).run(); } catch {}
    }
    return { enviados, caducadas: caducadas.length };
  } catch (err) {
    console.error("Error enviando push:", err.message);
    return { enviados: 0, error: true };
  }
}

function pushRecortar(texto, max) {
  const t = String(texto || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "\u2026" : t;
}

// Aviso de noticia publicada. "articulo" necesita titulo, slug, categoria
// y, opcionalmente, subtitulo e imagen_url.
// ---------- IndexNow ----------
// Avisa a Bing, Yandex, Seznam, Naver... (y a los buscadores que se
// alimentan de ellos, como DuckDuckGo) de que una URL es nueva o ha
// cambiado, en el momento de publicar, sin esperar a que vuelvan a
// leer el sitemap. Google NO participa en IndexNow: para Google siguen
// valiendo sitemap-news.xml, Publisher Center y la inspección de URL.
// La clave no es secreta (es pública por diseño): el buscador la
// verifica leyendo https://elotrofutbol.media/{clave}.txt, que debe
// existir en /public con la clave como contenido. Nunca lanza ni
// bloquea la publicación: si IndexNow falla, solo se registra en log.
const INDEXNOW_KEY_POR_DEFECTO = "ad34c6b21354c5cf6c614cf1a37baebd";
async function notificarIndexNow(env, urls) {
  try {
    const lista = (urls || []).filter(Boolean);
    if (!lista.length) return;
    const key = (env && env.INDEXNOW_KEY) || INDEXNOW_KEY_POR_DEFECTO;
    const host = new URL(SITIO_URL).host;
    const resp = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host,
        key,
        keyLocation: `${SITIO_URL}/${key}.txt`,
        urlList: lista,
      }),
    });
    if (!resp.ok && resp.status !== 202) {
      console.error(`IndexNow respondió ${resp.status} para ${lista.length} URL(s)`);
    }
  } catch (err) {
    console.error("IndexNow falló (se ignora):", err && err.message);
  }
}

async function notificarPushArticulo(env, articulo) {
  try {
    if (!articulo || !articulo.titulo || !articulo.slug) return;
    const imagen = typeof articulo.imagen_url === "string" && articulo.imagen_url.startsWith("https://") ? articulo.imagen_url : undefined;
    await pushEnviarATopico(env, "noticias", {
      titulo: pushRecortar(articulo.titulo, 100),
      cuerpo: pushRecortar(articulo.subtitulo || "Nueva noticia en ElOtroFútbol", 160),
      url: urlNoticia(articulo.categoria, articulo.slug),
      tag: `noticia-${articulo.slug}`.slice(0, 120),
      imagen,
    }, { ttl: 6 * 3600 });
  } catch (err) {
    console.error("notificarPushArticulo:", err.message);
  }
}

// Aviso de gol o de final de partido. Se llama DESPUES de recalcular el
// marcador, para que lo que se envia sea el resultado ya actualizado.
async function notificarPushPartido(env, resultadoId, tipo, evento = {}) {
  try {
    const r = await env.DB.prepare(
      "SELECT equipo_local, equipo_visitante, goles_local, goles_visitante FROM results WHERE id = ?"
    ).bind(resultadoId).first();
    if (!r) return;
    const marcador = `${r.equipo_local} ${r.goles_local ?? 0}-${r.goles_visitante ?? 0} ${r.equipo_visitante}`;
    let titulo, cuerpo;
    if (tipo === "fin_partido") {
      titulo = "\uD83C\uDFC1 Final";
      cuerpo = marcador;
    } else if (tipo === "gol" || tipo === "gol_pp") {
      const minuto = evento.minuto ? ` (${parseInt(evento.minuto, 10)}'${evento.minuto_extra ? "+" + parseInt(evento.minuto_extra, 10) : ""})` : "";
      titulo = tipo === "gol_pp" ? "\u26BD Gol en propia puerta" : "\u26BD \u00A1Gol!";
      cuerpo = `${marcador}${minuto}${evento.jugador && tipo === "gol" ? " \u00B7 " + pushRecortar(evento.jugador, 40) : ""}`;
    } else {
      return;
    }
    await pushEnviarATopico(env, "partidos", {
      titulo,
      cuerpo: pushRecortar(cuerpo, 160),
      url: `${SITIO_URL}/minuto-a-minuto.html?id=${resultadoId}`,
      // Misma tag por partido: cada gol sustituye a la notificacion anterior
      // de ese partido en vez de apilarse.
      tag: `partido-${resultadoId}`,
    }, { ttl: 900, urgencia: "high" });
  } catch (err) {
    console.error("notificarPushPartido:", err.message);
  }
}

// Limite sencillo por IP y hora (KV) para el alta/baja de suscripciones.
// Si KV no esta disponible, no bloquea (falla abierto).
async function pushLimiteExcedido(request, env, maxPorHora = 30) {
  try {
    if (!env.ELOTROFUTBOL_KV) return false;
    const ip = request.headers.get("CF-Connecting-IP") || "desconocida";
    const hora = Math.floor(Date.now() / 3600000);
    const clave = `push-rl:${ip}:${hora}`;
    const actual = parseInt((await env.ELOTROFUTBOL_KV.get(clave)) || "0", 10);
    if (actual >= maxPorHora) return true;
    await env.ELOTROFUTBOL_KV.put(clave, String(actual + 1), { expirationTtl: 7200 });
    return false;
  } catch {
    return false;
  }
}

// Rutas publicas /api/push/*. Devuelve una Response o null si la ruta no
// es de push (para que el router principal siga con las demas).
async function manejarRutasPush(request, env, path, method) {
  if (path === "/api/push/clave" && method === "GET") {
    const claves = await pushCargarClaves(env);
    if (!claves) return json({ error: "Los avisos push no estan disponibles ahora mismo" }, 503);
    return json({ clave: claves.publicaB64u });
  }

  if (path === "/api/push/suscribir" && method === "POST") {
    if (await pushLimiteExcedido(request, env)) return json({ error: "Demasiadas peticiones, prueba mas tarde" }, 429);
    const body = await request.json().catch(() => null);
    const s = body && body.suscripcion;
    const endpoint = s && s.endpoint;
    const p256dh = s && s.keys && s.keys.p256dh;
    const auth = s && s.keys && s.keys.auth;
    if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
      return json({ error: "Suscripcion no valida" }, 400);
    }
    if (!pushEndpointValido(endpoint)) return json({ error: "Servicio de notificaciones no admitido" }, 400);
    if (p256dh.length > 200 || auth.length > 100) return json({ error: "Suscripcion no valida" }, 400);
    try {
      if (pushB64uABytes(p256dh).length !== 65) throw new Error("p256dh");
    } catch {
      return json({ error: "Suscripcion no valida" }, 400);
    }
    const noticias = body.noticias === false ? 0 : 1;
    const partidos = body.partidos === false ? 0 : 1;
    if (!noticias && !partidos) return json({ error: "Elige al menos un tipo de aviso" }, 400);
    const ua = pushRecortar(request.headers.get("User-Agent") || "", 200);
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, noticias, partidos, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
         noticias = excluded.noticias, partidos = excluded.partidos, updated_at = CURRENT_TIMESTAMP`
    ).bind(endpoint, p256dh, auth, noticias, partidos, ua).run();
    return json({ ok: true });
  }

  if (path === "/api/push/baja" && method === "POST") {
    if (await pushLimiteExcedido(request, env)) return json({ error: "Demasiadas peticiones, prueba mas tarde" }, 429);
    const body = await request.json().catch(() => null);
    if (!body || typeof body.endpoint !== "string" || body.endpoint.length > 700) return json({ error: "Falta el endpoint" }, 400);
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(body.endpoint).run();
    return json({ ok: true });
  }

  return null;
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
    // Fijado aquí, al principio de cada petición, para que json() y el
    // resto de cors(resp) sin origen explícito de este archivo (ver
    // ORIGEN_PETICION_ACTUAL más arriba) usen el origen real del
    // visitante en vez de tener que pasarlo a mano en cada uno de los
    // ~40 sitios que devuelven una respuesta.
    ORIGEN_PETICION_ACTUAL = request.headers.get("Origin");

    /*
     * ============================================================
     * CORS
     * ============================================================
     */

    if (method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }), ORIGEN_PETICION_ACTUAL);
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
      // Sin cors() aquí, esta respuesta (503, sin cabecera
      // Access-Control-Allow-Origin) hacía que el navegador la bloqueara
      // como error de CORS en vez de dejar que el JavaScript de la
      // página viera el 503 real. Eso ocultaba la causa real detrás de
      // errores confusos en la consola ("blocked by CORS policy") en vez
      // de un 503 legible, y en las páginas que comprueban el status
      // (como el failover de apiFetch) hacía que un fallo de mantenimiento
      // se tratara como un fallo de RED en vez de un 503 normal -- incluso
      // así el failover acababa funcionando por el catch, pero de forma
      // menos predecible y sin poder diagnosticarlo desde la consola del
      // navegador.
      return cors(new Response(html, {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Retry-After": "3600",
          "Cache-Control": "no-store",
        },
      }), ORIGEN_PETICION_ACTUAL);
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
           WHERE publicado = 1${SQL_OCULTAR_SEGUNDO_DE_FUSION}
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

        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls}\n</urlset>\n`;

        return cors(new Response(xml, {
          status: 200,
          headers: {
            "Content-Type": "application/xml; charset=UTF-8",
            "Cache-Control": "public, max-age=3600",
          },
        }), ORIGEN_PETICION_ACTUAL);
      } catch (err) {
        // Si la base de datos falla, mejor devolver un sitemap vacío pero
        // válido que un error 500: así un rastreador que llegue en ese
        // momento no ve un sitemap "roto", solo uno sin URLs esta vez.
        return cors(new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n`,
          { status: 200, headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "no-store" } }
        ), ORIGEN_PETICION_ACTUAL);
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
           WHERE publicado = 1${SQL_OCULTAR_SEGUNDO_DE_FUSION}
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

        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${urls}\n</urlset>\n`;

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
        }), ORIGEN_PETICION_ACTUAL);
      } catch (err) {
        return cors(new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"></urlset>\n`,
          { status: 200, headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "no-store" } }
        ), ORIGEN_PETICION_ACTUAL);
      }
    }

    /*
     * ============================================================
     * SITEMAP DE CLUBES
     *
     * GET /sitemap-clubes.xml
     *
     * Las fichas de club (/categoria?cat=...&club=...) son los índices
     * que más enlazan a las noticias de cada equipo y rankean por el
     * nombre del club, pero no estaban en ningún sitemap. Se generan
     * al vuelo a partir de los clubes que tienen noticias publicadas
     * (solo noticias de un único club; las de partido con dos clubes
     * se listan desde la ficha de cada uno).
     * ============================================================
     */
    if (path === "/sitemap-clubes.xml" && method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          `SELECT categoria, club, MAX(COALESCE(updated_at, fecha_publicacion)) AS ultima FROM articles
           WHERE publicado = 1${SQL_OCULTAR_SEGUNDO_DE_FUSION}
             AND club IS NOT NULL AND club <> '' AND club NOT LIKE '[%'
           GROUP BY categoria, club
           ORDER BY categoria, club
           LIMIT 5000`
        ).all();

        const urls = results.map((fila) => {
          const lastmod = fechaParaSitemap(fila.ultima);
          const loc = `${SITIO_URL}/categoria?cat=${encodeURIComponent(fila.categoria)}&club=${encodeURIComponent(fila.club)}`;
          return [
            "  <url>",
            `    <loc>${escaparXml(loc)}</loc>`,
            lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
            "    <changefreq>daily</changefreq>",
            "    <priority>0.5</priority>",
            "  </url>",
          ].filter(Boolean).join("\n");
        }).join("\n");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
        return cors(new Response(xml, {
          status: 200,
          headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "public, max-age=3600" },
        }), ORIGEN_PETICION_ACTUAL);
      } catch (err) {
        return cors(new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n`,
          { status: 200, headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "no-store" } }
        ), ORIGEN_PETICION_ACTUAL);
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
           WHERE publicado = 1${SQL_OCULTAR_SEGUNDO_DE_FUSION}
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
        }), ORIGEN_PETICION_ACTUAL);
      } catch (err) {
        // Mismo criterio que el sitemap: mejor un feed vacío pero válido
        // que un error 500.
        return cors(new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>ELOTROFÚTBOLTV</title><link>https://elotrofutbol.media</link><description>Últimas noticias de fútbol modesto.</description></channel></rss>\n`,
          { status: 200, headers: { "Content-Type": "application/rss+xml; charset=UTF-8", "Cache-Control": "no-store" } }
        ), ORIGEN_PETICION_ACTUAL);
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

    // ---------- Notificaciones push (Web Push) ----------
    if (path.startsWith("/api/push/")) {
      const respuestaPush = await manejarRutasPush(request, env, path, method);
      if (respuestaPush) return respuestaPush;
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
      if (await limiteExcedido(request, env, "newsletter", 10, 3600)) {
        return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
      }
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

    // ---------- Acreditaciones: formulario público (acreditacion.html) ----------
    // Cualquier persona con el enlace puede solicitar acreditación para
    // cubrir un partido, rueda de prensa o acto. No requiere sesión. Se
    // guarda en la tabla "acreditaciones" y solo los administradores
    // pueden verla (pestaña Funcionalidades > Acreditaciones del panel).
    // Configuración pública del formulario (textos y listas editables desde el panel).
    if (path === "/api/acreditaciones/config" && method === "GET") {
      const cfgPublica = await obtenerConfigAcreditacion(env);
      let pinLongitud = null;
      try { const p = await obtenerPinAcreditacion(env); if (p) pinLongitud = p.length; } catch {}
      // Solo se expone cuántos dígitos tiene el PIN (para pintar las casillas), nunca el PIN.
      return json({ ...cfgPublica, pin_longitud: pinLongitud });
    }

    // Comprobación del PIN al entrar al formulario (acreditacion.html).
    if (path === "/api/acreditaciones/pin" && method === "POST") {
      if (await limiteExcedido(request, env, "acreditacion-pin", 10, 900)) {
        return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
      }
      const body = await request.json().catch(() => ({}));
      const esperado = await obtenerPinAcreditacion(env);
      if (!esperado) return json({ error: "El formulario de acreditación no está disponible todavía." }, 503);
      if (!pinAcreditacionCorrecto(esperado, String((body && body.pin) || "").trim())) {
        return json({ error: "PIN incorrecto" }, 401);
      }
      return json({ ok: true });
    }

    if (path === "/api/acreditaciones" && method === "POST") {
      if (await limiteExcedido(request, env, "acreditacion", 10, 3600)) {
        return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "JSON inválido" }, 400);
      }
      body = body || {};
      // Campo trampa para bots: un humano nunca lo ve ni lo rellena.
      if (body.web) return json({ ok: true });

      // Sin el PIN correcto no se acepta ninguna solicitud (aunque se salten la pantalla del PIN).
      const pinEsperado = await obtenerPinAcreditacion(env);
      if (!pinEsperado) return json({ error: "El formulario de acreditación no está disponible todavía." }, 503);
      if (!pinAcreditacionCorrecto(pinEsperado, String(body.pin || "").trim())) {
        return json({ error: "PIN incorrecto" }, 401);
      }

      const limpiar = (v, max) => (v ? String(v) : "").replace(/\s+/g, " ").trim().slice(0, max);
      const cfgAcred = await obtenerConfigAcreditacion(env);
      const P = cfgAcred.preguntas;
      const TIPOS_ACREDITACION = cfgAcred.acreditaciones;
      const nombre = limpiar(body.nombre, 200);
      const email = limpiar(body.email, 200).toLowerCase();
      // Una pregunta oculta desde el panel no se pide ni se guarda aunque llegue en la petición.
      const dni = P.dni.activa ? limpiar(body.dni, 30).replace(/[\s.-]/g, "").toUpperCase() : "";
      const equipo = limpiar(body.equipo, 200);
      const tipoEvento = P.tipo_evento.activa ? limpiar(body.tipo_evento, 200) : "";
      const tipoAcreditacion = limpiar(body.tipo_acreditacion, 200);
      const funciones = P.funciones.activa ? (body.funciones ? String(body.funciones) : "").trim().slice(0, 2000) : "";
      const jornadaPartido = P.jornada_partido.activa ? limpiar(body.jornada_partido, 500) : "";

      if (!nombre) return json({ error: P.nombre.error }, 400);
      if (!emailValido(email)) return json({ error: P.email.error }, 400);
      if (P.dni.activa) {
        if (dni ? (dni.length < 5 || !/^[A-Z0-9]+$/.test(dni)) : P.dni.obligatoria) return json({ error: P.dni.error }, 400);
      }
      if (!equipo) return json({ error: P.equipo.error }, 400);
      if (P.tipo_evento.activa && P.tipo_evento.obligatoria && !tipoEvento) return json({ error: P.tipo_evento.error }, 400);
      if (!TIPOS_ACREDITACION.includes(tipoAcreditacion)) return json({ error: P.tipo_acreditacion.error }, 400);
      if (P.funciones.activa && P.funciones.obligatoria && !funciones) return json({ error: P.funciones.error }, 400);
      if (P.jornada_partido.activa && P.jornada_partido.obligatoria && !jornadaPartido) return json({ error: P.jornada_partido.error }, 400);
      if (body.confirmo !== true) return json({ error: "Debes confirmar que los datos son correctos" }, 400);

      try {
        await env.DB.prepare(
          `INSERT INTO acreditaciones
             (nombre, email, dni, equipo, tipo_evento, tipo_acreditacion, funciones, jornada_partido, confirmado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).bind(nombre, email, dni, equipo, tipoEvento, tipoAcreditacion, funciones, jornadaPartido).run();
      } catch (err) {
        console.error("[acreditaciones/crear]", err);
        return json({ error: "No se pudo enviar la solicitud. Inténtalo de nuevo en unos minutos." }, 500);
      }

      // Aviso por correo al equipo: es un extra, si falla la solicitud ya está guardada.
      try {
        await enviarEmailNotificacion(env, {
          asunto: `Nueva solicitud de acreditación: ${nombre} (${equipo})`,
          texto: [
            `Nombre: ${nombre}`, `Correo: ${email}`, `Equipo: ${equipo}`,
            `Evento: ${tipoEvento}`, `Acreditación: ${tipoAcreditacion}`,
            `Jornada y partido: ${jornadaPartido}`, "",
            "Puedes verla y gestionarla en el panel de administración (Funcionalidades > Acreditaciones).",
          ].join("\n"),
          html: `<p>Nueva solicitud de acreditación recibida.</p>
<p><strong>Nombre:</strong> ${escapeHtmlEmail(nombre)}<br>
<strong>Correo:</strong> ${escapeHtmlEmail(email)}<br>
<strong>Equipo:</strong> ${escapeHtmlEmail(equipo)}<br>
<strong>Evento:</strong> ${escapeHtmlEmail(tipoEvento)}<br>
<strong>Acreditación:</strong> ${escapeHtmlEmail(tipoAcreditacion)}<br>
<strong>Jornada y partido:</strong> ${escapeHtmlEmail(jornadaPartido)}</p>
<p>Puedes verla y gestionarla en el panel de administración (Funcionalidades &gt; Acreditaciones).</p>`,
        });
      } catch (err) {
        console.error("[acreditaciones/aviso-email]", err);
      }
      return json({ ok: true });
    }

    // ---------- Contacto de prensa ----------
    // Formulario público (página contacto.html): no requiere autenticación,
    // pero sí validación básica para no ser un vector fácil de spam/abuso.
    // No se guarda en base de datos (no hace falta un historial consultable
    // desde el panel todavía): se reenvía directamente por email al buzón
    // del medio vía Resend, igual que el resto de notificaciones.
    if (path === "/api/contacto-prensa" && method === "POST") {
      if (await limiteExcedido(request, env, "contacto", 5, 3600)) {
        return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
      }
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

    // [SECUNDARIO] Dentro de Railway (server-railway.js, RUNNING_IN_RAILWAY)
    // no hay a dónde hacer failover: Railway ya ES el destino. Sin esto, un
    // fallo de Postgres (p. ej. ECONNRESET) -> 500 -> fetchRailway() se
    // bloquea con 503 FAILOVER_UNAVAILABLE y se TAPA el 500 original con su
    // detalle. Aquí se atiende la petición directamente y se devuelve su
    // respuesta tal cual (o un 500 JSON si hay excepción). Diferencia
    // INTENCIONADA respecto a worker/src/index.js: no la elimines al
    // volver a sincronizar ambos archivos.
    if (env.RUNNING_IN_RAILWAY) {
      try {
        return await handlePrimary(request, env, ctx);
      } catch (err) {
        console.error("[RAILWAY] Error atendiendo la petición:", err);
        return new Response(
          JSON.stringify({ error: "Error del servidor", detail: err?.message || String(err) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Subidas de archivos (fotos/vídeos): NO se hace failover a Railway.
    // Reenviar la subida no sirve de nada (el fallo suele ser del propio
    // archivo, p. ej. Cloudinary lo rechaza) y además Railway responde
    // "No autorizado" porque su tabla de sesiones es una réplica con
    // retraso, lo que tapaba el error real y hacía que unas fotos
    // subieran y otras no. Se devuelve tal cual lo que diga el principal.
    const esSubidaDeArchivo = method === "POST" && (path === "/api/media" || path === "/api/subir-imagen");
    let requestParaFailover;

    try {
      // Se clona el request ANTES de pasarlo a handlePrimary: si el
      // backend principal lee el body (p. ej. `await request.json()` en
      // rutas POST/PUT), el stream original queda consumido/bloqueado, y
      // más abajo, si hace falta failover a Railway, `request.clone()`
      // sobre un request ya leído lanza "This ReadableStream is
      // currently locked to a reader" -- eso hacía que el failover
      // fallara también, dejando la API entera con 502 en cualquier ruta
      // de escritura. Clonando aquí, antes de tocar nada, el clon
      // guardado en requestParaFailover conserva su stream intacto pase
      // lo que pase dentro de handlePrimary.
      requestParaFailover = request.clone();
      const primaryResponse = await handlePrimaryConCache(
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

      if (primaryResponse.status < 500 || esSubidaDeArchivo) {
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

      return await fetchRailway(
        requestParaFailover,
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

      if (esSubidaDeArchivo) {
        return json({
          error: "Error interno del servidor al procesar el archivo. Puede ser demasiado pesado.",
          detail: primaryError && primaryError.message ? primaryError.message : String(primaryError),
        }, 500);
      }

      return await fetchRailway(
        requestParaFailover,
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

    // Reducción de CPU del cron (corre cada minuto, 1440 veces/día):
    // antes crearDescansoAutomaticoAlMinuto45, crearFinPartidoAutomaticoAlMinuto90,
    // marcarPartidosColgados y revisarPartidosDesatendidos hacían CADA
    // UNA su propio SELECT ... WHERE estado = 'en_juego' contra D1 en
    // cada tick, aunque casi siempre esa tabla está vacía (no hay
    // partidos en directo la mayor parte del día). Se sustituyen esas 4
    // consultas por 1 sola aquí, y se le pasa el resultado a las 4
    // funciones para que no repitan la lectura. Si esa única consulta
    // sale vacía, ni siquiera se llaman las 3 que solo tienen sentido
    // con partidos en juego (revisarPartidosDesatendidos sigue
    // llamándose igual, porque también drena la cola de avisos
    // pendientes aunque no haya nada 'en_juego' ahora mismo).
    ctx.waitUntil((async () => {
      let partidosEnJuego = [];
      try {
        const { results } = await env.DB.prepare(
          `SELECT id, competicion, jornada, equipo_local, equipo_visitante, autor_id, autor_nombre,
                  inicio_cronometro_at, cronometro_pausado_en, ajuste_cronometro_minutos,
                  aviso_desatendido_mitad
           FROM results WHERE estado = 'en_juego'`
        ).all();
        partidosEnJuego = results || [];
      } catch (err) {
        console.log("Error leyendo partidos en_juego para el cron:", err.message);
      }

      if (partidosEnJuego.length) {
        const corriendo = partidosEnJuego.filter(
          (p) => p.cronometro_pausado_en === null || p.cronometro_pausado_en === undefined
        );
        await crearDescansoAutomaticoAlMinuto45(env, corriendo);
        await reanudarSegundaParteAutomatica(env, partidosEnJuego);
        await crearFinPartidoAutomaticoAlMinuto90(env, corriendo);
      }

      // marcarPartidosColgados va ANTES de revisarPartidosDesatendidos:
      // pasa a 'colgado' los partidos con más de 2000' corriendo, para
      // que ya no aparezcan como 'en_juego' cuando se ejecute la
      // revisión de "desatendido" justo después y no se dupliquen los
      // avisos. Como marcarPartidosColgados puede cambiar el estado en
      // D1, revisarPartidosDesatendidos vuelve a mirar por sí misma qué
      // sigue 'en_juego' de verdad en vez de reutilizar la lista de
      // arriba, salvo cuando esa lista ya estaba vacía (nada que colgar).
      const idsColgados = partidosEnJuego.length
        ? await marcarPartidosColgados(env, ctx, partidosEnJuego)
        : [];
      const partidosParaDesatendidos = idsColgados.length
        ? undefined // hubo cambios de estado: que revisarPartidosDesatendidos relea D1
        : partidosEnJuego;
      await revisarPartidosDesatendidos(env, ctx, partidosParaDesatendidos);
    })());

    ctx.waitUntil(enviarBoletinSemanalSiToca(env));
    // Recordatorios a redactores inactivos (una pasada al día; ver
    // "RECORDATORIOS DE INACTIVIDAD DE REDACTORES" arriba).
    ctx.waitUntil(enviarRecordatoriosInactividadSiToca(env));
    // Partidazo de la jornada por liga (ver "PARTIDAZO DE LA JORNADA" arriba).
    // Se autolimita a una pasada cada PARTIDAZO_INTERVALO_MS.
    ctx.waitUntil(calcularPartidazosSiToca(env));
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
  if (!secretRecibido || !comparacionConstante(secretRecibido, secretEsperado)) {
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

// Resumen de failovers por circuito abierto (anti-spam de logs).
const contadorFailoverPorCircuito = { total: 0 };
let _resumenFailoverTimer = null;
function programarResumenFailoverPorCircuito() {
  if (_resumenFailoverTimer) return;
  _resumenFailoverTimer = setTimeout(() => {
    if (contadorFailoverPorCircuito.total > 0) {
      console.log(
        `[FAILOVER] Resumen circuito abierto: ${contadorFailoverPorCircuito.total} reenvíos a Railway en esta ventana`
      );
      contadorFailoverPorCircuito.total = 0;
    }
    _resumenFailoverTimer = null;
  }, 30000);
}

async function fetchRailway(
  request,
  path,
  reason,
  env,
  ctx
) {
  /*
   * IMPORTANTE:
   * Si el Worker ya está ejecutándose en Railway, NO podemos hacer
   * failover hacia Railway otra vez.
   *
   * Esto evita el bucle:
   *
   * Principal
   *   ↓ 500
   * Railway
   *   ↓ error
   * Railway
   *   ↓ error
   * Railway...
   *
   * RUNNING_IN_RAILWAY puede llegar como boolean, string o número
   * dependiendo de cómo esté definida la variable de entorno.
   */
  const runningInRailway =
    env?.RUNNING_IN_RAILWAY === true ||
    env?.RUNNING_IN_RAILWAY === "true" ||
    env?.RUNNING_IN_RAILWAY === 1 ||
    env?.RUNNING_IN_RAILWAY === "1";
  if (runningInRailway) {
    console.error(
      `[FAILOVER] Bloqueado: la petición ya está en Railway (${reason}). ` +
      `No se permite reenviar Railway -> Railway.`
    );
    return new Response(
      JSON.stringify({
        status: "FAILOVER_UNAVAILABLE",
        backend: "RAILWAY",
        message:
          "Railway es el backend secundario activo y no puede hacer failover hacia sí mismo.",
        failover_reason: reason
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          [FAILOVER_HEADER]: "RAILWAY",
          [FAILOVER_TEST_HEADER]:
            reason === "FAILOVER_TEST" ? "true" : "false",
          [FAILOVER_REASON_HEADER]: reason
        }
      }
    );
  }
  /*
   * URL del backend secundario.
   *
   * Primero utiliza RAILWAY_URL configurada en las variables
   * de entorno y, si no existe, utiliza la URL pública.
   */
  const railwayBaseUrl =
    env?.RAILWAY_URL ||
    "https://elotro-futbol-api-production.up.railway.app";
  const railwayUrl =
    railwayBaseUrl +
    path +
    new URL(request.url).search;
  /*
   * Evitamos generar miles de logs cuando el circuito está abierto.
   */
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
     * Clonamos el request porque puede haber sido utilizado
     * previamente por el backend principal.
     */
    const railwayHeaders = new Headers(request.headers);
    /*
     * Marca interna para indicar que esta petición procede
     * realmente del failover del Worker.
     */
    railwayHeaders.set(
      "X-ElOtroFutbol-Failover",
      "true"
    );
    railwayHeaders.set(
      "X-ElOtroFutbol-Failover-Reason",
      reason
    );
    /*
     * Evita que la petición de failover vuelva a provocar
     * otro failover en cadena.
     */
    railwayHeaders.set(
      "X-ElOtroFutbol-Failover-Hop",
      "1"
    );
    // Compatibilidad con server-railway / pending-writes: también se
    // envían las cabeceras históricas X-Failover-Origin*.
    railwayHeaders.set("X-Failover-Origin", "worker-primary");
    railwayHeaders.set("X-Failover-Origin-Reason", reason);
    const response = await fetch(railwayUrl, {
      method: request.method,
      headers: railwayHeaders,
      body:
        request.method === "GET" ||
        request.method === "HEAD"
          ? undefined
          : await request.clone().arrayBuffer()
    });
    /*
     * Devolvemos directamente la respuesta de Railway.
     */
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set(
      FAILOVER_HEADER,
      "RAILWAY"
    );
    responseHeaders.set(
      FAILOVER_REASON_HEADER,
      reason
    );
    if (reason === "FAILOVER_TEST") {
      responseHeaders.set(FAILOVER_TEST_HEADER, "true");
    }
    return new Response(
      response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      }
    );
  } catch (error) {
    console.error(
      `[FAILOVER] Error contactando con Railway (${reason}):`,
      error
    );
    return new Response(
      JSON.stringify({
        error: "Error del backend secundario",
        detail:
          error instanceof Error
            ? error.message
            : String(error),
        backend: "RAILWAY",
        failover_reason: reason
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          [FAILOVER_HEADER]: "RAILWAY",
          [FAILOVER_REASON_HEADER]: reason
        }
      }
    );
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

// ---------- Cache corta de GET publicos (por isolate) ----------
// Los listados y fichas publicas (portada, categorias, noticia...) se piden
// muchisimo mas de lo que cambian y cada peticion leia D1 entera. Aqui se
// guarda unos segundos el JSON ya serializado de las rutas GET publicas
// cuya respuesta NO depende de quien pregunta (verificado ruta por ruta:
// ninguna usa requireAuth en su version publica ni escribe en la base de
// datos). Reglas de seguridad:
//   - Solo peticiones SIN cabecera Authorization: el panel (editores,
//     borradores, vista admin) nunca pasa por esta cache.
//   - Solo respuestas 200 JSON "no-store" generadas por json().
//   - Cualquier escritura (POST/PUT/PATCH/DELETE a /api/) vacia la cache de
//     ese isolate; en los demas isolates la frescura maxima es el TTL.
const CACHE_PUBLICA_TTL_MS = {
  "/api/articles": 15000,
  "/api/articles/banner-urgente": 10000,
  "/api/noticias-rapidas": 15000,
  "/api/polls/portada": 15000,
  "/api/settings": 60000,
  "/api/club-info": 60000,
  "/api/media/publica": 30000,
};
const CACHE_PUBLICA = new Map(); // clave -> { exp, texto }
const CACHE_PUBLICA_MAX = 200;
const CACHE_PUBLICA_MAX_BYTES = 512 * 1024;

function ttlCachePublica(request, url) {
  if (request.method !== "GET") return 0;
  if (request.headers.get("Authorization")) return 0;
  if (request.headers.get("X-Write-Id")) return 0;
  const p = url.pathname;
  if (p === "/api/articles" && url.searchParams.get("admin") === "1") return 0;
  if (Object.prototype.hasOwnProperty.call(CACHE_PUBLICA_TTL_MS, p)) return CACHE_PUBLICA_TTL_MS[p];
  // Ficha de noticia: /api/articles/:slug (la version sin sesion solo
  // devuelve noticias publicadas; el borrador del autor exige Authorization).
  if (/^\/api\/articles\/[^/]+$/.test(p)) return 15000;
  return 0;
}

async function handlePrimaryConCache(request, env, ctx) {
  const url = new URL(request.url);
  const ttl = ttlCachePublica(request, url);
  if (!ttl) {
    if (request.method !== "GET" && request.method !== "HEAD" && url.pathname.startsWith("/api/")) {
      CACHE_PUBLICA.clear();
    }
    return handlePrimary(request, env, ctx);
  }
  const clave = url.pathname + url.search;
  const ahora = Date.now();
  const e = CACHE_PUBLICA.get(clave);
  if (e && e.exp > ahora) {
    return cors(new Response(e.texto, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }), ORIGEN_PETICION_ACTUAL);
  }
  const resp = await handlePrimary(request, env, ctx);
  try {
    if (
      resp.status === 200 &&
      (resp.headers.get("Content-Type") || "").startsWith("application/json") &&
      resp.headers.get("Cache-Control") === "no-store"
    ) {
      const texto = await resp.clone().text();
      if (texto.length <= CACHE_PUBLICA_MAX_BYTES) {
        if (CACHE_PUBLICA.size >= CACHE_PUBLICA_MAX) {
          for (const [k, v] of CACHE_PUBLICA) { if (v.exp <= ahora) CACHE_PUBLICA.delete(k); }
          if (CACHE_PUBLICA.size >= CACHE_PUBLICA_MAX) CACHE_PUBLICA.clear();
        }
        CACHE_PUBLICA.set(clave, { exp: ahora + ttl, texto });
      }
    }
  } catch { /* si no se puede guardar, se sirve igual la respuesta normal */ }
  return resp;
}

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
        if (await limiteExcedido(request, env, "lector-registro", 6, 3600)) {
          return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
        }
        const body = await request.json().catch(() => ({}));
        const nombre = normalizarTexto(body.nombre);
        const email = normalizarTexto(body.email)?.toLowerCase() || null;
        const password = typeof body.password === "string" ? body.password : "";

        if (!nombre) return json({ error: "Falta tu nombre" }, 400);
        if (nombre.length > 80) return json({ error: "El nombre es demasiado largo (máximo 80 caracteres)" }, 400);
        if (email && email.length > 254) return json({ error: "Introduce un correo electrónico válido" }, 400);
        if (password.length > 1024) return json({ error: "La contraseña es demasiado larga" }, 400);
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
        ).bind(nombre, email, hash, salt, await sha256Texto(verifToken), verifExpira).first();

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
        ).bind(await sha256Texto(String(token))).first();
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
        if (await limiteExcedido(request, env, "lector-reenviar", 6, 3600)) {
          return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
        }
        const { email } = await request.json().catch(() => ({}));
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
          ).bind(await sha256Texto(verifToken), verifExpira, lector.id).run();

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
        const body = await request.json().catch(() => ({}));
        const email = normalizarTexto(body.email)?.toLowerCase() || null;
        const password = typeof body.password === "string" ? body.password : "";
        if (!email || !password) return json({ error: "Faltan credenciales" }, 400);
        if (email.length > 254 || password.length > 1024) return json({ error: "Correo o contraseña incorrectos" }, 401);
        if (await limiteExcedido(request, env, "lector-login", 20, 900) || await limiteExcedido(request, env, "lector-login-mail", 30, 900, email)) {
          return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
        }

        const lector = await env.DB.prepare("SELECT * FROM readers WHERE email = ? AND activo = 1").bind(email).first();
        if (!lector) {
          await hashPassword(password, SAL_FICTICIA_LOGIN);
          return json({ error: "Correo o contraseña incorrectos" }, 401);
        }
        const hash = await hashPassword(password, lector.salt);
        if (!comparacionConstante(hash, lector.password_hash)) return json({ error: "Correo o contraseña incorrectos" }, 401);
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
      // Un único endpoint para ambos casos (a diferencia de
      // register+login, que son dos pasos separados en el flujo con
      // contraseña): el botón "Continuar con Google" del frontend manda
      // aquí el id_token que entrega Google Identity Services, y:
      //   - si ya existe un lector con ese google_id, es un login normal;
      //   - si no, pero existe un lector con ese mismo email (se
      //     registró antes con correo+contraseña), se vincula google_id
      //     a esa cuenta ya existente (Google ya ha verificado el
      //     correo, así que es seguro asumir que es la misma persona;
      //     a partir de ahora puede entrar por cualquiera de los dos
      //     caminos indistintamente);
      //   - si no existe ninguno de los dos, se crea la cuenta al vuelo,
      //     ya verificada (Google es garantía suficiente) y sin
      //     contraseña (password_hash/salt quedan NULL: puede ponerse
      //     una más adelante desde su perfil si quiere entrar también
      //     sin Google, aunque eso no está aún expuesto en el frontend).
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
            await neutralizarCuentaLectorNoVerificada(env, porEmail);
            // Cuenta ya existente (registrada con correo+contraseña):
            // se vincula en vez de duplicar. Se aprovecha para marcar el
            // correo como verificado si no lo estaba ya (viniendo de
            // Google, lo está).
            await env.DB.prepare(
              "UPDATE readers SET google_id = ?, email_verificado = 1, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?"
            ).bind(googleId, avatarUrl, porEmail.id).run();
            lector = { ...porEmail, google_id: googleId, email_verificado: 1 };
          } else {
            // password_hash/salt son NOT NULL en el esquema original (no
            // se ha tocado esa restricción para evitar recrear la tabla
            // "readers", que tiene claves foráneas desde varias tablas
            // -- reader_sessions, comments, encuestas, porras...-- y
            // recrearla obligaría a recrearlas todas en cascada). Para
            // una cuenta que entra solo con Google no hace falta una
            // contraseña real: se guarda un hash de una contraseña
            // aleatoria que nadie conoce ni puede volver a generar, así
            // que en la práctica equivale a "sin contraseña" (el login
            // normal por email+contraseña nunca podrá adivinarla) sin
            // tener que tocar el esquema de la tabla.
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
      // Mismo patrón que /api/readers/google (ver comentario arriba):
      // un único endpoint para login y registro. El botón "Continuar/
      // Registrarme con Microsoft" del frontend manda aquí el id_token
      // que entrega MSAL.js, y:
      //   - si ya existe un lector con ese microsoft_id, es un login normal;
      //   - si no, pero existe un lector con ese mismo email (registrado
      //     antes con correo+contraseña o con Google), se vincula
      //     microsoft_id a esa cuenta ya existente;
      //   - si no existe ninguno de los dos, se crea la cuenta al
      //     vuelo, ya verificada, sin contraseña real (mismo relleno
      //     aleatorio que en el flujo de Google, ver comentario allí).
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
            await neutralizarCuentaLectorNoVerificada(env, porEmail);
            // Cuenta ya existente: se vincula en vez de duplicar.
            await env.DB.prepare(
              "UPDATE readers SET microsoft_id = ?, email_verificado = 1 WHERE id = ?"
            ).bind(microsoftId, porEmail.id).run();
            lector = { ...porEmail, microsoft_id: microsoftId, email_verificado: 1 };
          } else {
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
      // A diferencia de Google/Microsoft (que entregan un id_token JWT
      // ya firmado, verificable sin más pasos), Discord usa OAuth 2.0
      // "de toda la vida": el navegador va a discord.com, el usuario
      // autoriza, y Discord redirige de vuelta con un "code" de un solo
      // uso que hay que canjear por un access_token llamando a la API
      // de Discord DESDE EL SERVIDOR (con el client_secret, que nunca
      // debe llegar al navegador). Por eso son dos rutas en vez de una:
      //   1) /api/readers/discord/iniciar redirige a Discord;
      //   2) /api/readers/discord/callback recibe el "code" de vuelta,
      //      lo canjea, pide el perfil, y crea/vincula/loguea al lector
      //      exactamente igual que /api/readers/google.
      //
      // "state" (un valor aleatorio de un solo uso) evita ataques CSRF
      // sobre el callback: se guarda en una cookie de corta duración al
      // iniciar y se compara con el que Discord devuelve.
      if (path === "/api/readers/discord/iniciar" && method === "GET") {
        if (!env.DISCORD_CLIENT_ID) return json({ error: "El acceso con Discord no está configurado" }, 500);

        const state = randomSalt();
        const volver = volverServidorSeguro(url.searchParams.get("volver"));
        const redirectUri = `${API_URL}/api/readers/discord/callback`;

        const paramsDiscord = new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "identify email",
          state,
        });

        const headers = new Headers({ Location: `https://discord.com/api/oauth2/authorize?${paramsDiscord}` });
        // Cookie de corta duración: solo hace falta que sobreviva el
        // ida-y-vuelta a Discord (unos segundos/minutos), no una sesión
        // larga. Se guarda también "volver" para no perder a dónde
        // quería ir el usuario tras iniciar sesión.
        headers.append(
          "Set-Cookie",
          `eof_discord_state=${state}|${encodeURIComponent(volver)}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`
        );
        return new Response(null, { status: 302, headers });
      }

      if (path === "/api/readers/discord/callback" && method === "GET") {
        // Cualquier fallo a partir de aquí redirige a acceso.html con un
        // mensaje de error legible, en vez de mostrar un JSON pelado:
        // el usuario ha llegado aquí desde un redirect de Discord, no
        // desde una llamada fetch() del frontend.
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
            await neutralizarCuentaLectorNoVerificada(env, porEmail);
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

        // A diferencia de Google/Microsoft (llamadas fetch() que
        // devuelven JSON al propio frontend), este es un redirect real
        // del navegador: no hay JS esperando la respuesta al otro lado,
        // así que el token de sesión se manda en la URL de vuelta y
        // guardarSesionLector() en el frontend lo recoge de ahí (ver
        // lector-auth.js). Se limpia la cookie de "state", ya usada.
        const destino = volverServidorSeguro(volverGuardado) || "index.html";
        const headers = new Headers({
          Location: `${SITIO_URL}/${destino}${destino.includes("?") ? "&" : "?"}sesionDiscord=${token}`,
        });
        headers.append("Set-Cookie", "eof_discord_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
        return new Response(null, { status: 302, headers });
      }

      // ---------- Login/registro de lector con cuenta de X ----------
      // Mismo patrón que Discord (ver comentario justo arriba: redirect
      // completo, no id_token), pero X exige además PKCE (Proof Key for
      // Code Exchange) de forma obligatoria en OAuth 2.0, a diferencia
      // de Discord: se genera un "code_verifier" aleatorio, se manda su
      // hash ("code_challenge") al autorizar, y el "code_verifier" en
      // claro al canjear el code por el token, para que solo quien
      // inició este flujo concreto (no un atacante que intercepte el
      // code) pueda completarlo.
      //
      // OJO -- PENDIENTE DE DECIDIR: el tier gratuito de la API de X no
      // entrega el email del usuario en el perfil (solo username, id y
      // nombre), a diferencia de Google/Microsoft/Discord. Por ahora,
      // igual que con los demás proveedores, se guarda un
      // password_hash de relleno (sin contraseña real) PERO el campo
      // "email" se rellena con un valor sintético
      // (`x-<id>@x.elotrofutbol.media`, no es un correo real ni
      // entregable) solo para poder cumplir la restricción NOT NULL de
      // "readers.email" sin tocar el esquema de la tabla. Falta decidir
      // qué hacer de verdad (pedir el correo aparte en un paso extra
      // tras el primer login, como ya se hace con redactores, o pasar a
      // un tier de pago de la API de X que sí de el email real) antes
      // de dar esto por terminado: mientras tanto, estas cuentas NO
      // podrán recuperar contraseña por correo ni recibir
      // notificaciones por email, porque ese campo no es una dirección
      // real a la que se pueda escribir.
      if (path === "/api/readers/x/iniciar" && method === "GET") {
        if (!env.X_CLIENT_ID) return json({ error: "El acceso con X no está configurado" }, 500);

        const state = randomSalt();
        const codeVerifier = randomSalt() + randomSalt(); // PKCE exige 43-128 caracteres
        const codeChallenge = base64urlDeHash(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
        const volver = volverServidorSeguro(url.searchParams.get("volver"));
        const redirectUri = `${API_URL}/api/readers/x/callback`;

        const paramsX = new URLSearchParams({
          client_id: env.X_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "users.read tweet.read",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });

        const headers = new Headers({ Location: `https://x.com/i/oauth2/authorize?${paramsX}` });
        // Cookie de corta duración: solo hace falta que sobreviva el
        // ida-y-vuelta a X (unos segundos/minutos). Además de "state" y
        // "volver" (igual que Discord), aquí también hay que guardar
        // "codeVerifier" para el canje del token en el callback, ya que
        // PKCE lo exige y no viaja en la URL de autorización de vuelta.
        headers.append(
          "Set-Cookie",
          `eof_x_state=${state}|${encodeURIComponent(volver)}|${codeVerifier}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`
        );
        return new Response(null, { status: 302, headers });
      }

      if (path === "/api/readers/x/callback" && method === "GET") {
        // Cualquier fallo a partir de aquí redirige a acceso.html con un
        // mensaje de error legible, en vez de mostrar un JSON pelado:
        // el usuario ha llegado aquí desde un redirect de X, no desde
        // una llamada fetch() del frontend.
        const irConError = (mensaje) => Response.redirect(
          `${SITIO_URL}/acceso.html?errorX=${encodeURIComponent(mensaje)}`, 302
        );

        if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET) return irConError("El acceso con X no está configurado");

        const code = url.searchParams.get("code");
        const stateRecibido = url.searchParams.get("state");
        if (!code || !stateRecibido) return irConError("X no ha devuelto los datos esperados");

        const cookieCabecera = request.headers.get("Cookie") || "";
        const cookieState = cookieCabecera.match(/eof_x_state=([^;]+)/)?.[1];
        if (!cookieState) return irConError("La sesión de inicio con X ha caducado, inténtalo de nuevo");
        const [stateGuardado, volverGuardado, codeVerifier] = decodeURIComponent(cookieState).split("|");
        if (stateGuardado !== stateRecibido) return irConError("No se ha podido verificar el inicio de sesión con X");

        const redirectUri = `${API_URL}/api/readers/x/callback`;

        let tokenData;
        try {
          // btoa() falla si CLIENT_ID/CLIENT_SECRET traen algún carácter
          // fuera de Latin1 (p.ej. un espacio Unicode invisible colado al
          // copiar el secret desde el portal de X, o cualquier símbolo
          // no-ASCII): en vez de una Basic Auth codificada a medias o un
          // 500 sin explicación, se codifica manualmente a UTF-8 primero
          // y se pasa esos bytes por btoa() carácter a carácter, que es
          // el patrón estándar para Base64-codificar texto arbitrario en
          // el navegador/Workers sin usar Buffer (Node), no disponible aquí.
          const credencialesBasicas = btoa(
            String.fromCharCode(...new TextEncoder().encode(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`))
          );
          const resToken = await fetch("https://api.x.com/2/oauth2/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: `Basic ${credencialesBasicas}`,
            },
            body: new URLSearchParams({
              client_id: env.X_CLIENT_ID,
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              code_verifier: codeVerifier,
            }),
          });
          if (!resToken.ok) throw new Error("token");
          tokenData = await resToken.json();
        } catch {
          return irConError("No se ha podido verificar la cuenta de X");
        }

        let perfilX;
        try {
          const resPerfil = await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url", {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (!resPerfil.ok) throw new Error("perfil");
          const cuerpoPerfil = await resPerfil.json();
          perfilX = cuerpoPerfil.data;
        } catch {
          return irConError("No se ha podido obtener tu perfil de X");
        }
        if (!perfilX?.id) return irConError("No se ha podido obtener tu perfil de X");

        const xId = perfilX.id;
        const nombre = perfilX.name || perfilX.username || `Usuario de X`;
        const avatarUrl = perfilX.profile_image_url
          ? perfilX.profile_image_url.replace("_normal", "") // X sirve una miniatura pequeña por defecto; se pide el tamaño original quitando el sufijo "_normal" del nombre de archivo.
          : null;
        // Ver comentario largo más arriba: X no da un email real en el
        // tier gratuito, así que se usa uno sintético solo para
        // cumplir el esquema. NO es una dirección real ni entregable.
        const email = `x-${xId}@x.elotrofutbol.media`;

        let lector = await env.DB.prepare("SELECT * FROM readers WHERE x_id = ? AND activo = 1").bind(xId).first();

        if (!lector) {
          const saltRelleno = randomSalt();
          const arrRelleno = new Uint8Array(32);
          crypto.getRandomValues(arrRelleno);
          const passwordRelleno = [...arrRelleno].map((b) => b.toString(16).padStart(2, "0")).join("");
          const hashRelleno = await hashPassword(passwordRelleno, saltRelleno);
          const insertado = await env.DB.prepare(
            `INSERT INTO readers (nombre, email, password_hash, salt, x_id, avatar_url, email_verificado)
             VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id`
          ).bind(nombre, email, hashRelleno, saltRelleno, xId, avatarUrl).first();
          lector = { id: insertado.id, nombre, email, x_id: xId, avatar_url: avatarUrl, email_verificado: 1 };
        }

        const token = await crearSesionLector(env, request, lector);

        // A diferencia de Google/Microsoft (llamadas fetch() que
        // devuelven JSON al propio frontend), este es un redirect real
        // del navegador: no hay JS esperando la respuesta al otro lado,
        // así que el token de sesión se manda en la URL de vuelta y
        // guardarSesionLector() en el frontend lo recoge de ahí (ver
        // lector-auth.js). Se limpia la cookie de "state", ya usada.
        const destino = volverServidorSeguro(volverGuardado) || "index.html";
        const headers = new Headers({
          Location: `${SITIO_URL}/${destino}${destino.includes("?") ? "&" : "?"}sesionX=${token}`,
        });
        headers.append("Set-Cookie", "eof_x_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
        return new Response(null, { status: 302, headers });
      }

      // ---------- Mantenimiento puntual: reparar nombres corrompidos ----------
      // Antes de este arreglo, b64urlDecode() decodificaba el payload del
      // JWT de Google con atob() y lo trataba como si ya fuera texto: como
      // ese payload viene en UTF-8, cualquier carácter no-ASCII del nombre
      // (tildes, "à", "ï", "ç"...) quedaba mal interpretado byte a byte y
      // se guardó así en "readers.nombre" para toda cuenta creada o
      // vinculada con Google antes de corregir b64urlDecodeTexto().
      //
      // Esta ruta re-decodifica esos nombres ya guardados: vuelve a
      // codificarlos como si fueran Latin-1 (para recuperar los bytes
      // UTF-8 originales, que es exactamente el error que se cometió al
      // guardarlos) y los reinterpreta como UTF-8 real. Es un endpoint de
      // admin, de un solo uso -- llamarlo otra vez sobre nombres ya
      // arreglados no debería cambiarlos (no tienen bytes ya rotos que
      // "reparar"), pero conviene borrar esta ruta del código una vez
      // usada en producción, no dejarla ahí de forma permanente.
      if (path === "/api/admin/mantenimiento/reparar-nombres-google" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede ejecutar esto" }, 403);

        const { simular } = await request.json().catch(() => ({ simular: true }));
        const soloSimular = simular !== false;

        const { results } = await env.DB.prepare(
          "SELECT id, nombre FROM readers WHERE google_id IS NOT NULL"
        ).all();

        const cambios = [];
        for (const fila of results) {
          let reparado;
          try {
            // Si el nombre guardado tiene el patrón de corrupción, sus
            // "caracteres" en realidad representan bytes UTF-8 sueltos:
            // reconvertirlo a bytes (Latin-1, 1 carácter = 1 byte) y
            // volver a decodificar como UTF-8 deshace el error original.
            const bytes = Uint8Array.from(fila.nombre, (c) => c.charCodeAt(0));
            reparado = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            // No decodifica como UTF-8 válido: el nombre no tiene el
            // patrón de corrupción esperado (probablemente ya estaba
            // bien), así que se deja tal cual.
            continue;
          }
          // Si tras el "viaje de ida y vuelta" el resultado es idéntico al
          // original, no había nada que reparar (nombre ya correcto,
          // p. ej. "Juan" no cambia). Solo se cuenta como cambio real
          // cuando el texto reparado difiere del guardado.
          if (reparado !== fila.nombre && reparado.trim()) {
            cambios.push({ id: fila.id, antes: fila.nombre, despues: reparado });
          }
        }

        if (!soloSimular) {
          for (const c of cambios) {
            await env.DB.prepare("UPDATE readers SET nombre = ? WHERE id = ?").bind(c.despues, c.id).run();
          }
        }

        return json({ ok: true, simulado: soloSimular, total_revisados: results.length, cambios });
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

        // SEGURIDAD: sin límite de intentos, un token de sesión robado servía
        // para adivinar la contraseña actual por fuerza bruta desde aquí.
        if (typeof actual !== "string" || typeof nueva !== "string" || nueva.length > 200 || actual.length > 200) {
          return json({ error: "Datos no válidos" }, 400);
        }
        if (await limiteExcedido(request, env, "cambio-password-lector", 8, 900, String(payload.rid))) {
          return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
        }
        const hashActual = await hashPassword(actual, lector.salt);
        if (!comparacionConstante(hashActual, lector.password_hash)) return json({ error: "La contraseña actual no es correcta" }, 401);

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
      // Faltaba en este Worker (solo existía como /api/me/perfil en
      // worker-secondary, con otro path): público/cuenta.html la llama
      // como GET y PUT a /api/readers/me/perfil. El GET está justo
      // arriba, junto a /api/readers/me. Se reutiliza el mismo patrón
      // que /api/readers/me/password: requireReaderAuth + devolver un
      // JWT nuevo (el frontend guarda { token, reader } tras cada
      // guardado para reflejar el cambio sin tener que volver a iniciar
      // sesión).
      if (path === "/api/readers/me/perfil" && method === "PUT") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const body = await request.json();
        const nombre = normalizarTexto(body.nombre)?.trim() || "";
        if (!nombre) return json({ error: "El nombre no puede estar vacío" }, 400);
        let avatarUrl = null;
        if (typeof body.avatar_url === "string" && body.avatar_url.trim()) {
          avatarUrl = urlHttpsSegura(body.avatar_url);
          if (!avatarUrl) return json({ error: "La foto de perfil debe ser una URL https válida" }, 400);
        }

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

      // ---------- Guardar email real (lector logueado con X) ----------
      // Ver el comentario largo en /api/readers/x/callback: al entrar
      // con X se guarda un email sintético (x-<id>@x.elotrofutbol.media,
      // no entregable) porque el tier gratuito de la API de X no da el
      // email real. Este endpoint es el paso extra pendiente que se
      // decidió: cuenta.html detecta ese dominio sintético en el email
      // del lector (ver comprobarEmailPendienteX() en lector-auth.js) y
      // pide aquí un correo real la primera vez. Mismo patrón que
      // /api/me/email para redactores, pero sobre "readers" +
      // requireReaderAuth, y comprobando que el nuevo correo no esté ya
      // usado por otra cuenta (readers.email es UNIQUE).
      if (path === "/api/readers/me/email" && method === "PUT") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { email } = await request.json();
        const emailNorm = normalizarTexto(email)?.trim().toLowerCase() || "";
        if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
          return json({ error: "Introduce un correo electrónico válido" }, 400);
        }
        if (emailNorm.endsWith("@x.elotrofutbol.media")) {
          return json({ error: "Introduce tu correo real, no uno generado automáticamente" }, 400);
        }

        const lector = await env.DB.prepare("SELECT * FROM readers WHERE id = ? AND activo = 1").bind(payload.rid).first();
        if (!lector) return json({ error: "Cuenta no encontrada" }, 404);

        const yaUsado = await env.DB.prepare("SELECT id FROM readers WHERE email = ? AND id != ?").bind(emailNorm, lector.id).first();
        if (yaUsado) return json({ error: "Ese correo ya está en uso por otra cuenta" }, 409);

        // Al ser una cuenta de X sin verificación de email propia, se
        // manda un correo de verificación igual que en el registro
        // normal, en vez de darlo por verificado a ciegas: así el campo
        // "email_verificado" sigue significando lo mismo para todas las
        // cuentas, entren como entren.
        // Mismo patrón de caducidad (30 min) y página de destino
        // (verificar-cuenta.html) que /api/readers/reenviar-verificacion,
        // para reutilizar exactamente el mismo flujo de confirmación que
        // ya existe en vez de crear uno paralelo.
        const tokenArr = new Uint8Array(32);
        crypto.getRandomValues(tokenArr);
        const verificacionToken = [...tokenArr].map((b) => b.toString(16).padStart(2, "0")).join("");
        const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString();

        await env.DB.prepare(
          "UPDATE readers SET email = ?, email_verificado = 0, verificacion_token = ?, verificacion_token_expira = ? WHERE id = ?"
        ).bind(emailNorm, await sha256Texto(verificacionToken), expira, lector.id).run();

        const enlace = `${SITIO_URL}/verificar-cuenta.html?token=${verificacionToken}`;
        ctx.waitUntil(enviarEmailNotificacion(env, {
          asunto: "Confirma tu correo — ELOTROFÚTBOLTV",
          texto: `Hola ${lector.nombre},\n\nConfirma tu correo electrónico en ELOTROFÚTBOLTV entrando en este enlace (caduca en 30 minutos):\n${enlace}`,
          html: plantillaEmail({
            etiqueta: "Confirmar correo",
            titulo: "Confirma tu correo electrónico",
            parrafo: "Has añadido este correo a tu cuenta de ELOTROFÚTBOLTV. Confírmalo para poder recuperar tu contraseña y recibir notificaciones. El enlace caduca en 30 minutos.",
            boton: { texto: "Confirmar correo", url: enlace },
          }),
        }, { destinatario: emailNorm }));

        ctx.waitUntil(registrarActividad(env, request, { uid: lector.id, nombre: lector.nombre, rol: "lector" }, {
          accion: "editar_email_propio", entidad: "lector", entidad_id: lector.id,
          descripcion: `${lector.nombre} ha añadido su correo electrónico`,
        }));

        const token = await createJWT(
          { rid: lector.id, nombre: lector.nombre, email: emailNorm, sid: payload.sid },
          env.JWT_SECRET
        );
        return json({
          token,
          reader: { id: lector.id, nombre: lector.nombre, email: emailNorm, email_verificado: false, avatar_url: lector.avatar_url || null },
        });
      }

      // ---------- Recuperar contraseña de lector: paso 1 ----------
      if (path === "/api/readers/forgot-password" && method === "POST") {
        if (await limiteExcedido(request, env, "lector-forgot", 6, 3600)) {
          return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
        }
        const { email } = await request.json().catch(() => ({}));
        const emailNorm = normalizarTexto(email)?.toLowerCase() || null;
        if (!emailNorm) return json({ error: "Falta el correo" }, 400);

        const lector = await env.DB.prepare("SELECT * FROM readers WHERE email = ? AND activo = 1").bind(emailNorm).first();
        if (lector) {
          const tokenArr = new Uint8Array(32);
          crypto.getRandomValues(tokenArr);
          const token = [...tokenArr].map((b) => b.toString(16).padStart(2, "0")).join("");
          const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          await env.DB.prepare("UPDATE readers SET reset_token = ?, reset_token_expira = ? WHERE id = ?")
            .bind(await sha256Texto(token), expira, lector.id).run();

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

        const lector = await env.DB.prepare("SELECT * FROM readers WHERE reset_token = ? AND activo = 1").bind(await sha256Texto(String(token))).first();
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
        let cuerpoLogin;
        try { cuerpoLogin = await request.json(); } catch { return json({ error: "JSON inválido" }, 400); }
        const username = typeof cuerpoLogin?.username === "string" ? cuerpoLogin.username.trim() : "";
        const password = typeof cuerpoLogin?.password === "string" ? cuerpoLogin.password : "";
        if (!username || !password) return json({ error: "Faltan credenciales" }, 400);
        if (username.length > 100 || password.length > 1024) return json({ error: "Usuario o contraseña incorrectos" }, 401);
        if (await limiteExcedido(request, env, "login", 20, 900) || await limiteExcedido(request, env, "login-user", 30, 900, username)) {
          return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
        }
        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND activo = 1").bind(username).first();
        if (!user) {
          await hashPassword(password, SAL_FICTICIA_LOGIN); // mismo coste de tiempo que un usuario real
          return json({ error: "Usuario o contraseña incorrectos" }, 401);
        }
        const hash = await hashPassword(password, user.salt);
        if (!comparacionConstante(hash, user.password_hash)) return json({ error: "Usuario o contraseña incorrectos" }, 401);
        const token = await crearSesion(env, request, user);
        ctx.waitUntil(registrarActividad(env, request, { uid: user.id, nombre: user.nombre, rol: user.rol }, {
          accion: "login", entidad: "sesion", descripcion: `${user.nombre} ha iniciado sesión`,
        }));
        return json({ token, user: { id: user.id, username: user.username, nombre: user.nombre, rol: user.rol, nivel: user.rol === "admin" ? NIVEL_MAXIMO : (user.nivel || 1), email: user.email || null, avatar_url: user.avatar_url || null, avatar_foco: user.avatar_foco || null, categorias_fijas: parsearCategoriasFijas(user.categorias_fijas) } });
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
        if (await limiteExcedido(request, env, "staff-forgot", 6, 3600)) {
          return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
        }
        const { username, email } = await request.json().catch(() => ({}));
        if (typeof username !== "string" || typeof email !== "string" || !username || !email) return json({ error: "Faltan campos" }, 400);

        const user = await env.DB.prepare(
          "SELECT * FROM users WHERE username = ? AND email = ? AND activo = 1"
        ).bind(username.trim(), email.trim()).first();

        if (user) {
          const tokenArr = new Uint8Array(32);
          crypto.getRandomValues(tokenArr);
          const token = [...tokenArr].map((b) => b.toString(16).padStart(2, "0")).join("");
          const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          await env.DB.prepare("UPDATE users SET reset_token = ?, reset_token_expira = ? WHERE id = ?")
            .bind(await sha256Texto(token), expira, user.id).run();

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
        ).bind(await sha256Texto(String(token))).first();
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
        invalidarCacheCorta("sesion:");

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
        if (payload.rol !== "admin") return json({ error: "Solo un administrador" }, 403);
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
        if (payload.rol !== "admin") return json({ error: "Solo un administrador" }, 403);
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
        if (payload.rol !== "admin") return json({ error: "Solo un administrador" }, 403);
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
        if (payload.rol !== "admin") return json({ error: "Solo un administrador" }, 403);
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

        // SEGURIDAD: sin límite de intentos, un token de sesión robado servía
        // para adivinar la contraseña actual por fuerza bruta desde aquí.
        if (typeof actual !== "string" || typeof nueva !== "string" || nueva.length > 200 || actual.length > 200) {
          return json({ error: "Datos no válidos" }, 400);
        }
        if (await limiteExcedido(request, env, "cambio-password-staff", 8, 900, String(payload.uid))) {
          return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
        }
        const hashActual = await hashPassword(actual, user.salt);
        if (!comparacionConstante(hashActual, user.password_hash)) return json({ error: "La contraseña actual no es correcta" }, 401);

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
        invalidarCacheCorta("sesion:");

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
        invalidarCacheCorta("sesion:");
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
        invalidarCacheCorta("sesion:");
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
        const { results: filasPerfil } = await consultaConAlternativas(env, [
          "SELECT id, username, nombre, rol, email, bio, experiencia, avatar_url, avatar_foco, equipo, redes_sociales FROM users WHERE id = ?",
          "SELECT id, username, nombre, rol, email, bio, experiencia, avatar_url, equipo, redes_sociales FROM users WHERE id = ?",
        ], [payload.uid]);
        const user = filasPerfil[0] || null;
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
        return json({ user: { ...user, avatar_foco: normalizarFoco(user.avatar_foco), equipo: equipos, redes_sociales: undefined, redes } });
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
        let avatarUrl = null;
        if (typeof body.avatar_url === "string" && body.avatar_url.trim()) {
          avatarUrl = urlHttpsSegura(body.avatar_url);
          if (!avatarUrl) return json({ error: "La foto de perfil debe ser una URL https válida" }, 400);
        }
        // Encuadre de la foto (qué parte no se recorta en el avatar redondo).
        // Sin foto no hay encuadre: se deja centrado.
        const avatarFoco = avatarUrl ? normalizarFoco(body.avatar_foco) : FOCO_CENTRO;
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
              const urlRed = urlHttpsSegura(val);
              if (!urlRed) return json({ error: `El enlace de ${key} debe ser una URL https válida` }, 400);
              redesLimpias[key] = urlRed;
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
        else if (avatarUrl && normalizarFoco(user.avatar_foco) !== avatarFoco) cambios.push("encuadre de la foto de perfil");
        if (JSON.stringify(redesAnteriores) !== JSON.stringify(redesLimpias)) cambios.push("redes sociales");

        const redesJson = Object.keys(redesLimpias).length ? JSON.stringify(redesLimpias) : null;
        try {
          await env.DB.prepare("UPDATE users SET nombre = ?, email = ?, bio = ?, experiencia = ?, avatar_url = ?, avatar_foco = ?, redes_sociales = ? WHERE id = ?")
            .bind(nombre, email, bio, experiencia, avatarUrl, avatarFoco, redesJson, user.id).run();
        } catch (err) {
          // Columna avatar_foco aún sin migrar: se guarda el resto del perfil
          // igualmente (el encuadre quedará centrado hasta ejecutar la migración).
          if (!esErrorColumnaFaltante(err, "avatar_foco")) throw err;
          console.error("No se pudo guardar avatar_foco (falta migracion_users_avatar_foco.sql):", err.message);
          await env.DB.prepare("UPDATE users SET nombre = ?, email = ?, bio = ?, experiencia = ?, avatar_url = ?, redes_sociales = ? WHERE id = ?")
            .bind(nombre, email, bio, experiencia, avatarUrl, redesJson, user.id).run();
        }

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
          user: { id: user.id, username: user.username, nombre, rol: user.rol, email, bio, experiencia, avatar_url: avatarUrl, avatar_foco: avatarFoco, equipo: parsearEquipos(user.equipo), redes: redesLimpias },
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
        // Lista de TODOS los niveles con sus requisitos (la misma fuente que
        // usa el cálculo del progreso: NIVELES_REQUISITOS) para que "Mi
        // progreso" pueda dibujar el pase de niveles completo sin duplicar
        // las cifras en el frontend. Solo va en este endpoint, no en el
        // listado de usuarios, para no engordar esa respuesta.
        const niveles = Object.keys(NIVELES_INFO).map((n) => ({
          nivel: Number(n),
          ...NIVELES_INFO[n],
          requisitos: NIVELES_REQUISITOS[n] || null,
        }));
        return json({ ...progreso, niveles });
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
          if (typeof val === "string" && val.trim() !== "") {
            if (!/^[a-z0-9_]{1,30}$/i.test(key)) continue;
            const urlRed = urlHttpsSegura(val);
            if (!urlRed) return json({ error: `El enlace de ${key} debe ser una URL https válida` }, 400);
            redesLimpias[key] = urlRed;
          }
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

      // ---------- HORARIO DE PUBLICACIÓN ----------
      // Lo puede consultar cualquier usuario con sesión (los redactores lo
      // ven en Funcionalidades > Horario); solo un admin lo modifica.
      // ¿Se puede compartir esta noticia en redes? Se evalúa en el momento de abrir
      // "Compartir" con el horario actual (no solo con la marca guardada al publicar).
      const compartirPermitidoMatch = path.match(/^\/api\/articles\/(\d+)\/compartir-permitido$/);
      if (compartirPermitidoMatch && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const art = await env.DB.prepare(
          "SELECT id, tipo, resultado_id, publicado, programado_para, fecha_publicacion, fuera_calendario FROM articles WHERE id = ?"
        ).bind(parseInt(compartirPermitidoMatch[1], 10)).first();
        if (!art) return json({ error: "Noticia no encontrada" }, 404);
        const [evaluada] = await aplicarFueraCalendarioEnLectura(env, [art]);
        const fuera = !!(evaluada && evaluada.fuera_calendario);
        return json({ permitido: !fuera, fuera_calendario: fuera });
      }

      if (path === "/api/horario-publicacion" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const horario = await obtenerHorarioPublicacion(env);
        return json({ ...horario, tipos: TIPOS_HORARIO, dias_semana: DIAS_HORARIO, hoy: hoyEnMadrid().dia });
      }

      if (path === "/api/horario-publicacion" && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede modificar el horario de publicación" }, 403);
        const body = await request.json();
        if (!body || typeof body.dias !== "object" || body.dias === null || Array.isArray(body.dias)) {
          return json({ error: "Falta el horario" }, 400);
        }
        const horario = normalizarHorarioPublicacion({ activo: body.activo === true, dias: body.dias });
        await env.DB.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('horario_publicacion', ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
        ).bind(JSON.stringify(horario)).run();
        invalidarCacheCorta("horario_publicacion");
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_settings", entidad: "settings",
          descripcion: `Ha ${horario.activo ? "actualizado" : "desactivado"} el horario de publicación`,
        }));
        return json({ ok: true, ...horario });
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
          "SELECT id, nombre, equipo, categorias_fijas, redes_sociales FROM users WHERE activo = 1 ORDER BY nombre"
        ).all();
        const autores = results.map((a) => {
          let redes = {};
          if (a.redes_sociales) {
            try { redes = JSON.parse(a.redes_sociales); } catch { redes = {}; }
          }
          return { ...a, equipo: parsearEquipos(a.equipo), categorias_fijas: parsearCategoriasFijas(a.categorias_fijas), redes_sociales: undefined, redes };
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
        const { results: filasAutor } = await consultaConAlternativas(env, [
          "SELECT id, nombre, bio, experiencia, avatar_url, avatar_foco, equipo, redes_sociales FROM users WHERE id = ? AND activo = 1",
          "SELECT id, nombre, bio, experiencia, avatar_url, equipo, redes_sociales FROM users WHERE id = ? AND activo = 1",
        ], [id]);
        const autor = filasAutor[0] || null;
        if (!autor) return json({ error: "Autor no encontrado" }, 404);

        let redes = {};
        if (autor.redes_sociales) {
          try { redes = JSON.parse(autor.redes_sociales); } catch { redes = {}; }
        }

        const { results: articulos } = await env.DB.prepare(
          `SELECT id, slug, titulo, subtitulo, contenido, tipo, resultado_id, categoria, club, imagen_url, imagenes, autor_id, autor_nombre, coautor_id, coautor_nombre, fecha_publicacion
           FROM articles WHERE (autor_id = ? OR coautor_id = ?) AND publicado = 1 ORDER BY fecha_publicacion DESC LIMIT 30`
        ).bind(id, id).all();
        const articulosAutor = await remapearSlugsFusion(env, articulos);

        return json({
          autor: { id: autor.id, nombre: autor.nombre, bio: autor.bio || "", experiencia: autor.experiencia || "", avatar_url: autor.avatar_url || "", avatar_foco: normalizarFoco(autor.avatar_foco), equipo: parsearEquipos(autor.equipo), redes },
          articulos: articulosAutor.map((a) => ({ ...a, imagen_foco: focoDePortada(a), imagenes: undefined })),
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

      // ---------- ACREDITACIONES: PIN de acceso al formulario (solo admins) ----------
      if (path === "/api/acreditaciones/pin" && (method === "GET" || method === "PUT")) {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede gestionar el PIN" }, 403);
        let pin = await obtenerPinAcreditacion(env);
        if (method === "PUT") {
          const body = await request.json().catch(() => ({}));
          const pedido = body && body.pin !== undefined && body.pin !== null && body.pin !== "" ? String(body.pin).trim() : null;
          if (pedido !== null && !validarPinAcreditacion(pedido)) {
            return json({ error: "El PIN debe tener entre 4 y 8 dígitos" }, 400);
          }
          pin = pedido !== null ? pedido : generarPinAcreditacion();
          await guardarPinAcreditacion(env, pin);
          await registrarActividad(env, request, payload, {
            accion: "acreditacion_pin",
            entidad: "acreditacion",
            descripcion: "Cambiado el PIN de acceso al formulario de acreditaciones",
          });
        } else if (!pin) {
          pin = generarPinAcreditacion();
          await guardarPinAcreditacion(env, pin);
        }
        return json({ pin });
      }

      // ---------- ACREDITACIONES: configuración editable del formulario (solo admins) ----------
      if (path === "/api/acreditaciones/config" && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede editar el formulario" }, 403);
        const body = await request.json().catch(() => ({}));
        const cfg = normalizarConfigAcreditacion(body && body.restaurar ? null : body);
        await env.DB.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).bind(ACREDITACION_CONFIG_KEY, JSON.stringify(cfg)).run();
        await registrarActividad(env, request, payload, {
          accion: "acreditacion_config",
          entidad: "acreditacion",
          descripcion: body && body.restaurar ? "Restaurado el formulario de acreditaciones a sus valores por defecto" : "Editado el formulario de acreditaciones",
        });
        return json(cfg);
      }

      // ---------- ACREDITACIONES: importar solicitudes (CSV/Excel pegado) (solo admins) ----------
      if (path === "/api/acreditaciones/importar" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede importar acreditaciones" }, 403);
        const body = await request.json().catch(() => ({}));
        const filas = Array.isArray(body && body.filas) ? body.filas : [];
        if (!filas.length) return json({ error: "No hay filas que importar" }, 400);
        if (filas.length > 500) return json({ error: "Máximo 500 filas por importación" }, 400);
        const omitirDuplicadas = !(body && body.omitir_duplicadas === false);
        let importadas = 0, duplicadas = 0;
        const errores = [];
        for (let i = 0; i < filas.length; i++) {
          const f = filas[i] || {};
          const v = limpiarDatosAcreditacionAdmin(f);
          if (v.error) { errores.push({ fila: i + 1, motivo: v.error }); continue; }
          const d = v.datos;
          const estado = ["pendiente", "aprobada", "rechazada"].includes(String(f.estado || "").toLowerCase()) ? String(f.estado).toLowerCase() : "pendiente";
          const nota = (f.nota_admin ? String(f.nota_admin) : "").trim().slice(0, 1000) || null;
          const fechaOk = typeof f.created_at === "string" && /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.test(f.created_at.trim());
          const creada = fechaOk ? f.created_at.trim().replace("T", " ").slice(0, 19) : null;
          try {
            if (omitirDuplicadas) {
              const ya = await env.DB.prepare(
                "SELECT id FROM acreditaciones WHERE email = ? AND equipo = ? AND jornada_partido = ? AND tipo_evento = ?"
              ).bind(d.email, d.equipo, d.jornada_partido, d.tipo_evento).first();
              if (ya) { duplicadas++; continue; }
            }
            const revisor = estado !== "pendiente" ? (payload.nombre || null) : null;
            const revisadoAt = estado !== "pendiente" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null;
            if (creada) {
              await env.DB.prepare(
                `INSERT INTO acreditaciones
                   (nombre, email, dni, equipo, tipo_evento, tipo_acreditacion, funciones, jornada_partido, confirmado, estado, nota_admin, revisado_por, revisado_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
              ).bind(d.nombre, d.email, d.dni, d.equipo, d.tipo_evento, d.tipo_acreditacion, d.funciones, d.jornada_partido, estado, nota, revisor, revisadoAt, creada).run();
            } else {
              await env.DB.prepare(
                `INSERT INTO acreditaciones
                   (nombre, email, dni, equipo, tipo_evento, tipo_acreditacion, funciones, jornada_partido, confirmado, estado, nota_admin, revisado_por, revisado_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
              ).bind(d.nombre, d.email, d.dni, d.equipo, d.tipo_evento, d.tipo_acreditacion, d.funciones, d.jornada_partido, estado, nota, revisor, revisadoAt).run();
            }
            importadas++;
          } catch (err) {
            console.error("[acreditaciones/importar]", err);
            errores.push({ fila: i + 1, motivo: "Error al guardar" });
          }
        }
        await registrarActividad(env, request, payload, {
          accion: "acreditacion_importar",
          entidad: "acreditacion",
          descripcion: `Importadas ${importadas} acreditaciones (${duplicadas} duplicadas, ${errores.length} con error)`,
        });
        return json({ ok: true, importadas, duplicadas, errores });
      }

      // ---------- ACREDITACIONES: bandeja del panel (solo admins) ----------
      if (path === "/api/acreditaciones" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede ver las acreditaciones" }, 403);
        const { results } = await env.DB.prepare(
          `SELECT id, nombre, email, dni, equipo, tipo_evento, tipo_acreditacion, funciones,
                  jornada_partido, estado, nota_admin, revisado_por, revisado_at, created_at
           FROM acreditaciones ORDER BY created_at DESC, id DESC LIMIT 2000`
        ).all();
        return json({ acreditaciones: results || [] });
      }

      if (path.match(/^\/api\/acreditaciones\/\d+$/) && method === "PATCH") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede gestionar las acreditaciones" }, 403);
        const id = Number(path.split("/").pop());
        const body = await request.json().catch(() => ({}));
        const editaDatos = !!(body.datos && typeof body.datos === "object");
        const estado = String(body.estado || "");
        if (!(editaDatos && !estado) && !["pendiente", "aprobada", "rechazada"].includes(estado)) {
          return json({ error: "Estado no válido" }, 400);
        }
        const nota = (body.nota_admin ? String(body.nota_admin) : "").trim().slice(0, 1000);
        const existente = await env.DB.prepare("SELECT id, nombre FROM acreditaciones WHERE id = ?").bind(id).first();
        if (!existente) return json({ error: "Solicitud no encontrada" }, 404);
        if (editaDatos) {
          const v = limpiarDatosAcreditacionAdmin(body.datos);
          if (v.error) return json({ error: v.error }, 400);
          const d = v.datos;
          await env.DB.prepare(
            `UPDATE acreditaciones
               SET nombre = ?, email = ?, dni = ?, equipo = ?, tipo_evento = ?, tipo_acreditacion = ?, funciones = ?, jornada_partido = ?, updated_at = datetime('now')
             WHERE id = ?`
          ).bind(d.nombre, d.email, d.dni, d.equipo, d.tipo_evento, d.tipo_acreditacion, d.funciones, d.jornada_partido, id).run();
          await registrarActividad(env, request, payload, {
            accion: "acreditacion_editada",
            entidad: "acreditacion",
            entidad_id: id,
            descripcion: `Editados los datos de la acreditación de ${d.nombre}`,
          });
          if (!estado) return json({ ok: true });
        }
        await env.DB.prepare(
          `UPDATE acreditaciones
             SET estado = ?, nota_admin = ?, revisado_por = ?, revisado_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`
        ).bind(estado, nota || null, payload.nombre || null, id).run();
        await registrarActividad(env, request, payload, {
          accion: "acreditacion_" + estado,
          entidad: "acreditacion",
          entidad_id: id,
          descripcion: `Acreditación de ${existente.nombre} marcada como ${estado}`,
        });
        return json({ ok: true });
      }

      if (path.match(/^\/api\/acreditaciones\/\d+$/) && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (payload.rol !== "admin") return json({ error: "Solo un administrador puede eliminar acreditaciones" }, 403);
        const id = Number(path.split("/").pop());
        await env.DB.prepare("DELETE FROM acreditaciones WHERE id = ?").bind(id).run();
        return json({ ok: true });
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
           WHERE publicado = 1${SQL_OCULTAR_SEGUNDO_DE_FUSION} ORDER BY fecha_publicacion DESC LIMIT 8`
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
          "SELECT id, username, nombre, rol, activo, email, equipo, categorias_fijas, avatar_url, nivel, nivel_nota, created_at FROM users ORDER BY nombre"
        ).all();
        // El progreso de nivel de TODOS los usuarios se calcula con una
        // sola consulta agregada (antes: una consulta por usuario,
        // repitiendo un escaneo completo de "articles" tantas veces como
        // usuarios hubiera listados; ver contarPublicacionesPorTipoDeVarios).
        // Al pasarle el conteo ya calculado, construirProgresoNivel no
        // vuelve a tocar la base de datos, así que resolver todo en
        // paralelo aquí ya no dispara ninguna consulta extra.
        const conteos = await contarPublicacionesPorTipoDeVarios(env, results.map((u) => u.id));
        // Avisos de inactividad enviados a cada redactor (ver
        // cargarEstadoInactividadUsuarios): se muestran en la tabla de Usuarios.
        const inactividad = await cargarEstadoInactividadUsuarios(env, results);
        const users = await Promise.all(results.map(async (u) => ({
          ...u,
          equipo: parsearEquipos(u.equipo),
          categorias_fijas: parsearCategoriasFijas(u.categorias_fijas),
          progreso_nivel: await construirProgresoNivel(env, u, conteos.get(u.id)),
          inactividad: inactividad.get(Number(u.id)) || null,
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
        const rol = normalizarRolColaborador(body.rol);

        // Categoría(s) fija(s) (redactor "sin equipo, con categoría
        // fija", p. ej. Arbitraje): si se asigna alguna, este redactor
        // no tiene equipo, así que se ignora cualquier "equipo" recibido
        // en ese caso.
        const { error: errorCategoriasFijas, categoriasFijas } = validarCategoriasFijas(body.categorias_fijas);
        if (errorCategoriasFijas) return json({ error: errorCategoriasFijas }, 400);

        // El equipo es opcional, pero si se manda alguno hay que elegir
        // hasta 3 (ver validarEquipos). No aplica si tiene categoría(s) fija(s).
        const { error: errorEquipo, equipos: equiposNuevos } = validarEquipos(body.equipo);
        if (errorEquipo) return json({ error: errorEquipo }, 400);
        const equipoNuevo = (!categoriasFijas.length && equiposNuevos.length) ? JSON.stringify(equiposNuevos) : null;
        const categoriasFijasNuevo = categoriasFijas.length ? JSON.stringify(categoriasFijas) : null;

        await env.DB.prepare(
          `INSERT INTO users (username, password_hash, salt, nombre, rol, activo, email, equipo, categorias_fijas) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
        ).bind(username, hash, salt, body.nombre, rol, body.email ? body.email.trim() : null, equipoNuevo, categoriasFijasNuevo).run();

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
        // El sistema de niveles mide la confianza para publicar contenido
        // editorial sin revisión (ver publicarSinRevision): un fotógrafo
        // no publica noticias ni crónicas, así que no tiene sentido darle
        // un nivel de redactor.
        if (esFotografo(user)) {
          return json({ error: "El nivel de colaborador no aplica a un fotógrafo" }, 400);
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
        // Si se le va a quitar el rol de admin a este usuario (o se le
        // asigna cualquier otro rol) y era el nivel máximo solo por ser
        // admin, al pasar a redactor/fotógrafo su nivel real es el que
        // ya tuviera guardado (por defecto 1); esto ya lo resuelve
        // obtenerNivelUsuario/construirProgresoNivel leyendo `nivel` de
        // la fila, así que no hace falta tocar nada más aquí.
        if (id === payload.uid && body.activo === false) {
          return json({ error: "No puedes desactivar tu propia cuenta" }, 400);
        }

        // Categoría(s) fija(s): solo las puede cambiar un admin (misma
        // ruta). Si no se manda "categorias_fijas" en el body, se deja
        // la lista que ya tuviera.
        let categoriasFijasActualizadas = parsearCategoriasFijas(user.categorias_fijas);
        if (body.categorias_fijas !== undefined) {
          const { error: errorCategoriasFijas, categoriasFijas } = validarCategoriasFijas(body.categorias_fijas);
          if (errorCategoriasFijas) return json({ error: errorCategoriasFijas }, 400);
          categoriasFijasActualizadas = categoriasFijas;
        }
        const categoriasFijasParaGuardar = categoriasFijasActualizadas.length ? JSON.stringify(categoriasFijasActualizadas) : null;

        // El equipo solo lo puede cambiar un admin (esta ruta ya exige
        // rol admin arriba). Si no se manda "equipo" en el body, se deja
        // el que ya tuviera; si se manda, se valida que no pase de 3. Un
        // redactor con categoría(s) fija(s) no tiene equipo: si se le
        // asigna alguna (aquí o ya la tuviera), el equipo se vacía.
        let equipoActualizado = categoriasFijasActualizadas.length ? null : user.equipo;
        if (!categoriasFijasActualizadas.length && body.equipo !== undefined) {
          const { error: errorEquipo, equipos: equiposNuevos } = validarEquipos(body.equipo);
          if (errorEquipo) return json({ error: errorEquipo }, 400);
          equipoActualizado = equiposNuevos.length ? JSON.stringify(equiposNuevos) : null;
        }

        await env.DB.prepare(
          `UPDATE users SET nombre = ?, rol = ?, activo = ?, email = ?, equipo = ?, categorias_fijas = ? WHERE id = ?`
        ).bind(
          body.nombre !== undefined ? body.nombre : user.nombre,
          body.rol !== undefined ? normalizarRolColaborador(body.rol) : user.rol,
          body.activo === undefined ? user.activo : (body.activo ? 1 : 0),
          body.email !== undefined ? (body.email ? body.email.trim() : null) : user.email,
          equipoActualizado,
          categoriasFijasParaGuardar,
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
        // tienda_pedidos.usuario_id es NOT NULL y apunta a users(id): si esta
        // persona tiene pedidos, borrarla rompería la clave foránea. Se avisa
        // con un 409 claro (un 5xx o una excepción harían failover a Railway
        // y taparían el motivo real con un 401 engañoso).
        try {
          const pedidos = await env.DB.prepare("SELECT COUNT(*) AS n FROM tienda_pedidos WHERE usuario_id = ?").bind(id).first();
          if (pedidos && Number(pedidos.n) > 0) {
            return json({ error: "Este usuario tiene pedidos en la tienda y no se puede eliminar. Desactívalo en su lugar." }, 409);
          }
        } catch (e) {
          if (!/no such table|does not exist/i.test(String(e && e.message))) throw e;
        }
        // El historial de acciones guarda el nombre en texto aparte
        // (usuario_nombre), así que al eliminar la cuenta solo hace
        // falta soltar la referencia (usuario_id) para no chocar con la
        // clave foránea; las entradas de su actividad pasada se
        // conservan igual. Lo mismo para el resto de tablas que
        // referencian users(id): se limpia o reasigna la referencia
        // antes de borrar, si no D1 rechaza el DELETE por FOREIGN KEY.
        await env.DB.prepare("UPDATE activity_log SET usuario_id = NULL WHERE usuario_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE articles SET autor_id = NULL, updated_at = datetime('now') WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE articles SET coautor_id = NULL, updated_at = datetime('now') WHERE coautor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE media SET autor_id = NULL WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE results SET autor_id = NULL WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE custom_clubs SET autor_id = NULL WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE alineaciones SET autor_id = NULL, updated_at = datetime('now') WHERE autor_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE comments SET moderado_por_id = NULL WHERE moderado_por_id = ?").bind(id).run();
        await env.DB.prepare("UPDATE club_info SET autor_id = NULL, updated_at = datetime('now') WHERE autor_id = ?").bind(id).run();
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
        // Referencias a users(id) que faltaban por soltar (todas nullables):
        // sin esto, el DELETE FROM users lanzaba FOREIGN KEY constraint.
        for (const sqlLimpieza of [
          "UPDATE match_gallery SET vinculado_por_id = NULL WHERE vinculado_por_id = ?",
          "UPDATE polls SET autor_id = NULL WHERE autor_id = ?",
          "UPDATE tienda_pedidos SET gestionado_por = NULL WHERE gestionado_por = ?",
        ]) {
          try { await env.DB.prepare(sqlLimpieza).bind(id).run(); }
          catch (e) { if (!/no such table|no such column|does not exist/i.test(String(e && e.message))) throw e; }
        }
        try {
          await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
        } catch (e) {
          if (/FOREIGN KEY|foreign key|violates/i.test(String(e && e.message))) {
            console.error("DELETE users: clave foránea pendiente:", e.message);
            return json({ error: "No se puede eliminar: el usuario aún tiene datos vinculados (" + e.message + ")" }, 409);
          }
          throw e;
        }
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
        const payload = await requireAuthSubida(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);

        const form = await request.formData();
        const file = form.get("archivo");
        const titulo = (form.get("titulo") || "").toString().trim();
        const descripcion = (form.get("descripcion") || "").toString().trim();
        const club = (form.get("club") || "").toString().trim();
        // avisoLote=1: esta subida forma parte de una tanda; el correo se manda
        // UNA vez al final (POST /api/media/aviso-lote), no uno por archivo.
        const avisoEnLote = (form.get("avisoLote") || "").toString() === "1";
        // Vinculación automática a la galería del partido (ver Fase 1 del
        // rediseño): si se manda resultId, esta foto/vídeo se enlaza sola
        // a match_gallery al terminar de subirse, sin pasar por el paso
        // aparte de "Galería de partido". "equipo" indica de cuál de los
        // dos equipos del partido es (para las pestañas de la galería
        // pública); puede ir vacío si es una foto general del partido.
        const resultIdRaw = (form.get("resultId") || "").toString().trim();
        const resultId = resultIdRaw ? parseInt(resultIdRaw) : null;
        let equipoGaleria = (form.get("equipo") || "").toString().trim().toLowerCase();
        if (equipoGaleria !== "local" && equipoGaleria !== "visitante") equipoGaleria = null;
        // Portada elegida por quien sube el vídeo (segundo exacto del que
        // se extrae el fotograma de portada en la galería). Opcional: si
        // no se manda, se sigue usando el segundo 1 por defecto.
        const portadaSegundoRaw = (form.get("portadaSegundo") || "").toString().trim();
        let portadaSegundo = null;
        if (portadaSegundoRaw !== "") {
          const num = Number(portadaSegundoRaw);
          if (Number.isFinite(num) && num >= 0) portadaSegundo = num;
        }
        // Punto de foco espacial del fotograma de portada del vídeo (qué
        // parte de la imagen no se debe recortar nunca), mismo formato
        // "50% 50%" que ya usan las fotos de contenido. Opcional: si no
        // se manda, se sigue centrando como hasta ahora.
        const portadaFoco = normalizarFocoOpcional((form.get("portadaFoco") || "").toString());
        // Visibilidad elegida por quien sube el contenido: "publico" (por
        // defecto, aparece en las galerías del sitio) o "privado" (queda
        // solo en la mediateca del panel, nunca se expone en ningún
        // endpoint público). Cualquier valor que no sea "privado" exacto
        // se trata como público, para no dejar nada oculto por error.
        const visibilidadRaw = (form.get("visibilidad") || "").toString().trim().toLowerCase();
        const visibilidad = visibilidadRaw === "privado" ? "privado" : "publico";

        if (!file || typeof file === "string") return json({ error: "Falta el archivo" }, 400);
        if (!titulo) return json({ error: "Falta el título" }, 400);
        if (titulo.length > 200) return json({ error: "El título es demasiado largo (máximo 200 caracteres)" }, 400);
        if (descripcion.length > 2000) return json({ error: "La descripción es demasiado larga (máximo 2000 caracteres)" }, 400);
        if (file.size === 0) return json({ error: "El archivo está vacío" }, 400);

        // Si se ha pedido vincular a un partido, se comprueba que existe
        // ANTES de subir nada a Cloudinary: así, si el id es inválido, se
        // avisa al momento en vez de subir el archivo para nada.
        let resultadoGaleria = null;
        if (resultId) {
          if (!Number.isInteger(resultId)) return json({ error: "El partido elegido no es válido" }, 400);
          resultadoGaleria = await env.DB.prepare(
            "SELECT id, equipo_local, equipo_visitante, fecha_partido, slug FROM results WHERE id = ?"
          ).bind(resultId).first();
          if (!resultadoGaleria) return json({ error: "El partido elegido ya no existe" }, 404);
        }

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
          // Cloudinary rechaza ESTE archivo (demasiado pesado, demasiados
          // megapíxeles, formato dañado...): es un problema del archivo, no
          // un fallo del servidor. Antes se devolvía como 502, y el 5xx
          // disparaba el failover a Railway, que respondía "No autorizado"
          // y tapaba la causa real (solo fallaban algunas fotos).
          if (err.cloudinaryStatus === 400 || err.cloudinaryStatus === 413) {
            return json({
              error: `Cloudinary ha rechazado este archivo: ${err.cloudinaryMensaje || "no lo acepta"}`,
              detail: err.message,
            }, 400);
          }
          return json({ error: "No se pudo subir el archivo a Cloudinary. Comprueba tu conexión e inténtalo de nuevo.", detail: err.message }, 502);
        }
        // Cloudinary analiza el archivo de verdad (no solo el nombre o el
        // MIME que mande el navegador) y devuelve resourceType ("image" o
        // "video"): es la fuente más fiable de qué es en realidad el
        // archivo, así que se usa como base. Antes se recalculaba "a mano"
        // a partir de file.type/extensión, lo que podía guardar "foto"
        // para un vídeo si el navegador mandaba un MIME vacío o genérico
        // (típico en algunos móviles con .mov/.mkv). El cálculo manual se
        // deja solo como último recurso, por si Cloudinary devolviera algo
        // inesperado.
        const esFoto = subida.resourceType
          ? subida.resourceType === "image"
          : (esImagenPermitida(file.type) || ((!file.type || file.type === "application/octet-stream") && extensionImagenPermitida(file.name)));

        // hash_archivo es una columna añadida por una migración manual
        // que hay que ejecutar aparte: si no se ha aplicado en esta base
        // de datos, la columna no existe y el INSERT de más abajo fallaba
        // siempre (con el archivo YA subido a Cloudinary, lo peor
        // posible). Se intenta primero con hash_archivo y, si falla
        // específicamente porque la columna no existe (mensaje de
        // SQLite o de PostgreSQL, según cuál esté detrás de env.DB aquí),
        // se reintenta sin ella.
        let mediaInsertado;
        try {
          mediaInsertado = await env.DB.prepare(
            `INSERT INTO media (cloudinary_public_id, cloudinary_resource_type, cloudinary_url, titulo, descripcion, tipo, nombre_archivo, content_type, tamano_bytes, autor_id, autor_nombre, club, hash_archivo, portada_segundo, portada_foco, visibilidad)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            subida.publicId, subida.resourceType, subida.url,
            titulo, descripcion || null, esFoto ? "foto" : "video",
            file.name, file.type, file.size, payload.uid, payload.nombre, club || null, hashArchivo,
            esFoto ? null : portadaSegundo, portadaFoco, visibilidad
          ).run();
        } catch (err) {
          // visibilidad es una columna añadida por una migración manual
          // (migracion_media_visibilidad.sql): si no se ha ejecutado
          // todavía en esta base de datos, se reintenta sin ella (el
          // contenido queda con el valor por defecto de la columna,
          // "publico", hasta que se aplique la migración).
          const esColumnaVisibilidadFaltante = /no such column|no column named|column .* does not exist/i.test(err.message || "") && /visibilidad/i.test(err.message || "");
          const esColumnaPortadaFocoFaltante = /no such column|no column named|column .* does not exist/i.test(err.message || "") && /portada_foco/i.test(err.message || "");
          const esColumnaPortadaFaltante = /no such column|no column named|column .* does not exist/i.test(err.message || "") && /portada_segundo/i.test(err.message || "");
          const esColumnaFaltante = /no such column|no column named|column .* does not exist/i.test(err.message || "") && /hash_archivo/i.test(err.message || "");
          if (esColumnaVisibilidadFaltante) {
            try {
              mediaInsertado = await env.DB.prepare(
                `INSERT INTO media (cloudinary_public_id, cloudinary_resource_type, cloudinary_url, titulo, descripcion, tipo, nombre_archivo, content_type, tamano_bytes, autor_id, autor_nombre, club, hash_archivo, portada_segundo, portada_foco)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                subida.publicId, subida.resourceType, subida.url,
                titulo, descripcion || null, esFoto ? "foto" : "video",
                file.name, file.type, file.size, payload.uid, payload.nombre, club || null, hashArchivo,
                esFoto ? null : portadaSegundo, portadaFoco
              ).run();
            } catch (err2) {
              ctx.waitUntil(borrarDeCloudinary(env, subida.publicId, subida.resourceType, subida.cloudName));
              return json({ error: "No se pudo guardar el archivo. Inténtalo de nuevo.", detail: err2.message }, 500);
            }
          } else if (esColumnaPortadaFocoFaltante) {
            try {
              mediaInsertado = await env.DB.prepare(
                `INSERT INTO media (cloudinary_public_id, cloudinary_resource_type, cloudinary_url, titulo, descripcion, tipo, nombre_archivo, content_type, tamano_bytes, autor_id, autor_nombre, club, hash_archivo, portada_segundo)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                subida.publicId, subida.resourceType, subida.url,
                titulo, descripcion || null, esFoto ? "foto" : "video",
                file.name, file.type, file.size, payload.uid, payload.nombre, club || null, hashArchivo,
                esFoto ? null : portadaSegundo
              ).run();
            } catch (err2) {
              ctx.waitUntil(borrarDeCloudinary(env, subida.publicId, subida.resourceType, subida.cloudName));
              return json({ error: "No se pudo guardar el archivo. Inténtalo de nuevo.", detail: err2.message }, 500);
            }
          } else if (esColumnaPortadaFaltante) {
            try {
              mediaInsertado = await env.DB.prepare(
                `INSERT INTO media (cloudinary_public_id, cloudinary_resource_type, cloudinary_url, titulo, descripcion, tipo, nombre_archivo, content_type, tamano_bytes, autor_id, autor_nombre, club, hash_archivo)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                subida.publicId, subida.resourceType, subida.url,
                titulo, descripcion || null, esFoto ? "foto" : "video",
                file.name, file.type, file.size, payload.uid, payload.nombre, club || null, hashArchivo
              ).run();
            } catch (err2) {
              ctx.waitUntil(borrarDeCloudinary(env, subida.publicId, subida.resourceType, subida.cloudName));
              return json({ error: "No se pudo guardar el archivo. Inténtalo de nuevo.", detail: err2.message }, 500);
            }
          } else if (esColumnaFaltante) {
            try {
              mediaInsertado = await env.DB.prepare(
                `INSERT INTO media (cloudinary_public_id, cloudinary_resource_type, cloudinary_url, titulo, descripcion, tipo, nombre_archivo, content_type, tamano_bytes, autor_id, autor_nombre, club)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                subida.publicId, subida.resourceType, subida.url,
                titulo, descripcion || null, esFoto ? "foto" : "video",
                file.name, file.type, file.size, payload.uid, payload.nombre, club || null
              ).run();
            } catch (err2) {
              ctx.waitUntil(borrarDeCloudinary(env, subida.publicId, subida.resourceType, subida.cloudName));
              return json({ error: "No se pudo guardar el archivo. Inténtalo de nuevo.", detail: err2.message }, 500);
            }
          } else {
          // Red de seguridad final por si dos subidas del mismo archivo
          // llegan casi a la vez (condición de carrera): el índice único
          // de la base de datos rechaza la segunda, y aquí deshacemos lo
          // ya subido a Cloudinary para no dejar un archivo huérfano.
          const esDuplicadoBD = /unique/i.test(err.message || "");
          ctx.waitUntil(borrarDeCloudinary(env, subida.publicId, subida.resourceType, subida.cloudName));
          if (esDuplicadoBD) {
            return json({ error: "Este archivo ya se ha subido (se ha detectado justo ahora, puede que alguien lo subiera al mismo tiempo).", duplicado: true }, 409);
          }
          return json({ error: "No se pudo guardar el archivo. Inténtalo de nuevo.", detail: err.message }, 500);
          }
        }

        // Vinculación automática a la galería del partido elegido: se
        // intenta como un paso "extra" que no debe tirar abajo la subida
        // si algo falla (el archivo y su fila en "media" ya están
        // guardados de todas formas; el redactor siempre puede vincularlo
        // luego a mano desde "Galería de partido").
        let galeriaPartidoSlug = null;
        if (resultadoGaleria && mediaInsertado?.meta?.last_row_id) {
          try {
            const maxOrdenFila = await env.DB.prepare(
              "SELECT COALESCE(MAX(orden), -1) AS max_orden FROM match_gallery WHERE result_id = ?"
            ).bind(resultadoGaleria.id).first();
            const siguienteOrden = (maxOrdenFila?.max_orden ?? -1) + 1;
            await env.DB.prepare(
              `INSERT INTO match_gallery (result_id, media_id, orden, vinculado_por_id, equipo) VALUES (?, ?, ?, ?, ?)`
            ).bind(resultadoGaleria.id, mediaInsertado.meta.last_row_id, siguienteOrden, payload.uid, equipoGaleria).run();
            galeriaPartidoSlug = await slugPartidoUnico(env, resultadoGaleria);
          } catch (err) {
            console.error("No se pudo vincular automáticamente la foto a la galería del partido:", err.message);
          }
        }

        if (!avisoEnLote) {
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
        }

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "subir_media", entidad: "media", entidad_id: subida.publicId,
          descripcion: `Ha subido ${esFoto ? "una foto" : "un vídeo"}: "${titulo}"`,
        }));

        return json({ ok: true, galeriaPartidoSlug });
      }

      // ---------- SUBIR IMAGEN SUELTA (foto de perfil, fotos de una noticia...) ----------
      // A diferencia de /api/media (que además guarda un registro en la
      // mediateca para poder descargarlo más tarde), este endpoint solo
      // sube la imagen a Cloudinary y devuelve su URL, para pegarla
      // directamente en el campo de foto de perfil o en las fotos de una
      // noticia/crónica sin pasar por ningún listado.
      if (path === "/api/subir-imagen" && method === "POST") {
        const payload = await requireAuthSubida(request, env);
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

      // ---------- AVISO POR CORREO DE UNA TANDA DE SUBIDAS ----------
      // Cuando se suben varios archivos a la vez, el panel marca cada subida
      // con avisoLote=1 (ver POST /api/media: en ese caso NO manda correo por
      // archivo) y, al terminar la tanda, llama aquí UNA sola vez con el
      // resumen. Así 80 fotos = 1 correo de Resend, no 80. Los datos del
      // resumen los manda el panel (quien llama ya está autenticado como
      // colaborador): se limitan y se escapan al pintar el correo.
      if (path === "/api/media/aviso-lote" && method === "POST") {
        const payload = await requireAuthSubida(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);

        let datos;
        try { datos = await request.json(); } catch { return json({ error: "Cuerpo inválido" }, 400); }
        const aEntero = (v) => Math.max(0, Math.min(1000, parseInt(v, 10) || 0));
        const fotos = aEntero(datos?.fotos);
        const videos = aEntero(datos?.videos);
        if (fotos + videos === 0) return json({ ok: true, enviado: false });
        const tituloLote = String(datos?.titulo || "").trim().slice(0, 150);
        const clubLote = String(datos?.club || "").trim().slice(0, 100);
        const descripcionLote = String(datos?.descripcion || "").trim().slice(0, 300);

        const partes = [];
        if (fotos) partes.push(`${fotos} ${fotos === 1 ? "foto" : "fotos"}`);
        if (videos) partes.push(`${videos} ${videos === 1 ? "vídeo" : "vídeos"}`);
        const resumen = partes.join(" y ");

        ctx.waitUntil(enviarEmailNotificacion(env, {
          asunto: `Nuevas subidas: ${resumen}${tituloLote ? ` (${tituloLote})` : ""}`,
          texto: `${payload.nombre} ha subido ${resumen} a ELOTROFÚTBOLTV.${tituloLote ? `\nTítulo: ${tituloLote}` : ""}${clubLote ? `\nClub: ${clubLote}` : ""}${descripcionLote ? `\nDescripción: ${descripcionLote}` : ""}\n\nEntra en el panel de administración para verlos y descargarlos.`,
          html: plantillaEmail({
            etiqueta: "Nuevas subidas",
            titulo: `${resumen} subidas`,
            parrafo: descripcionLote || null,
            filas: [
              { etiqueta: "Subido por", valor: payload.nombre },
              { etiqueta: "Título", valor: tituloLote },
              { etiqueta: "Club", valor: clubLote },
            ],
            boton: { texto: "Ver en el panel", url: `${SITIO_URL}/admin/panel.html` },
          }),
        }));
        return json({ ok: true, enviado: true });
      }

      const mediaMatch = path.match(/^\/api\/media\/(\d+)$/);

      // ---------- MEDIA: listado ----------
      // Los administradores ven todo lo subido por el equipo; un redactor
      // normal solo ve (y por tanto solo puede editar) lo que ha subido él.
      if (path === "/api/media" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const base = "SELECT m.id, m.cloudinary_url, m.titulo, m.descripcion, m.tipo, m.nombre_archivo, m.content_type, m.tamano_bytes, m.autor_id, COALESCE(u.nombre, m.autor_nombre) AS autor_nombre, m.club, m.created_at, m.portada_segundo, m.portada_foco, m.visibilidad FROM media m LEFT JOIN users u ON u.id = m.autor_id";
        const baseSinFoco = "SELECT m.id, m.cloudinary_url, m.titulo, m.descripcion, m.tipo, m.nombre_archivo, m.content_type, m.tamano_bytes, m.autor_id, COALESCE(u.nombre, m.autor_nombre) AS autor_nombre, m.club, m.created_at, m.portada_segundo FROM media m LEFT JOIN users u ON u.id = m.autor_id";
        const baseSinPortada = "SELECT m.id, m.cloudinary_url, m.titulo, m.descripcion, m.tipo, m.nombre_archivo, m.content_type, m.tamano_bytes, m.autor_id, COALESCE(u.nombre, m.autor_nombre) AS autor_nombre, m.club, m.created_at FROM media m LEFT JOIN users u ON u.id = m.autor_id";
        let resultadoMedia;
        try {
          resultadoMedia = payload.rol === "admin"
            ? await env.DB.prepare(`${base} ORDER BY m.created_at DESC`).all()
            : await env.DB.prepare(`${base} WHERE m.autor_id = ? ORDER BY m.created_at DESC`).bind(payload.uid).all();
        } catch (err) {
          // portada_segundo / portada_foco son columnas añadidas por
          // migraciones manuales: si aún no se han ejecutado en esta base
          // de datos, se reintenta sin ellas en vez de romper el listado.
          try {
            resultadoMedia = payload.rol === "admin"
              ? await env.DB.prepare(`${baseSinFoco} ORDER BY m.created_at DESC`).all()
              : await env.DB.prepare(`${baseSinFoco} WHERE m.autor_id = ? ORDER BY m.created_at DESC`).bind(payload.uid).all();
          } catch (err2) {
            resultadoMedia = payload.rol === "admin"
              ? await env.DB.prepare(`${baseSinPortada} ORDER BY m.created_at DESC`).all()
              : await env.DB.prepare(`${baseSinPortada} WHERE m.autor_id = ? ORDER BY m.created_at DESC`).bind(payload.uid).all();
          }
        }
        const filas = resultadoMedia.results;
        // Se añade a cada foto/vídeo, si tiene, el partido al que está
        // vinculada en match_gallery (result_id + nombres de equipos +
        // de cuál de los dos es), para que el modal "Editar contenido"
        // pueda mostrar y permitir cambiar ese vínculo en vez de solo el
        // campo "club" de texto libre. Se hace con una sola consulta
        // aparte (en vez de un JOIN en la de arriba) para no complicar
        // los reintentos por columnas que puedan faltar.
        if (filas.length) {
          try {
            // Por lotes: la mediateca puede tener cientos de archivos y D1
            // rechaza consultas con más de 100 variables (?).
            const enlaces = await selectPorLotesDeIds(
              env,
              filas.map((f) => f.id),
              (marcadores) =>
                `SELECT mg.id AS enlace_id, mg.media_id, mg.equipo, mg.result_id,
                        r.equipo_local, r.equipo_visitante, r.slug
                 FROM match_gallery mg
                 JOIN results r ON r.id = mg.result_id
                 WHERE mg.media_id IN (${marcadores})`
            );
            const porMediaId = new Map(enlaces.map((e) => [e.media_id, e]));
            // El slug de un partido se genera "bajo demanda" (puede que un
            // partido con galería todavía no lo tenga si nadie ha abierto
            // aún su enlace público): se calcula aquí una sola vez por
            // partido distinto, para que el botón "Compartir" de la
            // mediateca tenga siempre una URL válida.
            const resultadosSinSlug = new Map();
            for (const e of enlaces) {
              if (!e.slug && !resultadosSinSlug.has(e.result_id)) resultadosSinSlug.set(e.result_id, e);
            }
            for (const e of resultadosSinSlug.values()) {
              const slugGenerado = await slugPartidoUnico(env, { id: e.result_id, equipo_local: e.equipo_local, equipo_visitante: e.equipo_visitante, fecha_partido: null, slug: null });
              for (const otro of enlaces) if (otro.result_id === e.result_id) otro.slug = slugGenerado;
            }
            for (const f of filas) {
              const e = porMediaId.get(f.id);
              if (e) {
                f.match_gallery_id = e.enlace_id;
                f.resultado_id = e.result_id;
                f.equipo_galeria = e.equipo || null;
                f.resultado_equipo_local = e.equipo_local;
                f.resultado_equipo_visitante = e.equipo_visitante;
                f.resultado_slug = e.slug || null;
                f.galeria_url = e.slug ? `${SITIO_URL}/galeria/${e.slug}` : null;
              }
            }
          } catch (err) {
            console.error("No se pudo cargar el partido vinculado de cada media (se continúa sin ese dato):", err.message);
          }
        }
        return json({ media: filas });
      }

      // ---------- MEDIA: editar título/club/descripción ----------
      // Puede editar un archivo la persona que lo subió (comparando
      // autor_id con el usuario autenticado), o un admin sobre
      // cualquier archivo aunque sea de otra persona; no se puede
      // sustituir el archivo en sí, solo sus datos.
      if (mediaMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(mediaMatch[1]);
        const registro = await env.DB.prepare("SELECT autor_id, tipo FROM media WHERE id = ?").bind(id).first();
        if (!registro) return json({ error: "No encontrado" }, 404);
        if (payload.rol !== "admin" && registro.autor_id !== payload.uid) {
          return json({ error: "Solo la persona que subió este contenido puede editarlo" }, 403);
        }
        const body = await request.json();
        const titulo = (body.titulo || "").toString().trim();
        if (!titulo) return json({ error: "Falta el título" }, 400);
        const descripcion = (body.descripcion || "").toString().trim();
        // "club" (texto libre) y el vínculo a un partido (match_gallery)
        // son mutuamente excluyentes: si se manda resultId, el club se
        // ignora aquí (igual que al subir, ver /api/media POST), porque
        // el equipo ya se deduce del propio partido vinculado.
        const club = (body.club || "").toString().trim();
        const resultIdRaw = body.resultId === undefined || body.resultId === null ? "" : body.resultId.toString().trim();
        const resultId = resultIdRaw ? parseInt(resultIdRaw) : null;
        let equipoGaleria = (body.equipo || "").toString().trim().toLowerCase();
        if (equipoGaleria !== "local" && equipoGaleria !== "visitante") equipoGaleria = null;
        if (resultId !== null && !Number.isInteger(resultId)) {
          return json({ error: "El partido elegido no es válido" }, 400);
        }
        // portadaSegundo: el instante (en segundos) del vídeo que se usa
        // como fotograma de portada en la galería de contenido subido.
        // Solo tiene sentido para vídeos; en fotos se ignora.
        let portadaSegundo = null;
        if (registro.tipo === "video" && body.portadaSegundo !== undefined && body.portadaSegundo !== null && body.portadaSegundo !== "") {
          const num = Number(body.portadaSegundo);
          if (Number.isFinite(num) && num >= 0) portadaSegundo = num;
        }
        // portadaFoco: qué punto de la miniatura no se debe recortar nunca
        // (mismo formato "50% 50%" que el resto de fotos del sitio). Para
        // vídeos es el punto del fotograma de portada; para fotos, el
        // punto de la propia imagen. Se guarda en la misma columna en
        // ambos casos: el campo llega como "portadaFoco" o "imagenFoco"
        // según el tipo, pero es el mismo dato.
        const focoRaw = registro.tipo === "video" ? body.portadaFoco : body.imagenFoco;
        const portadaFoco = normalizarFocoOpcional(focoRaw);
        // Si se vincula a un partido, el club de texto libre se anula (el
        // equipo ya se deduce del partido), igual que al subir.
        const clubGuardado = resultId ? null : (club || null);
        // Visibilidad: igual criterio que al subir (ver POST /api/media),
        // cualquier valor que no sea "privado" exacto se guarda como
        // "publico".
        const visibilidadRaw = (body.visibilidad || "").toString().trim().toLowerCase();
        const visibilidad = visibilidadRaw === "privado" ? "privado" : "publico";
        try {
          await env.DB.prepare(
            "UPDATE media SET titulo = ?, descripcion = ?, club = ?, portada_segundo = ?, portada_foco = ?, visibilidad = ? WHERE id = ?"
          ).bind(titulo, descripcion || null, clubGuardado, portadaSegundo, portadaFoco, visibilidad, id).run();
        } catch (err) {
          const esColumnaVisibilidadFaltante = /no such column|no column named|column .* does not exist/i.test(err.message || "") && /visibilidad/i.test(err.message || "");
          const esColumnaFocoFaltante = /no such column|no column named|column .* does not exist/i.test(err.message || "") && /portada_foco/i.test(err.message || "");
          const esColumnaFaltante = /no such column|no column named|column .* does not exist/i.test(err.message || "") && /portada_segundo/i.test(err.message || "");
          if (esColumnaVisibilidadFaltante) {
            try {
              await env.DB.prepare(
                "UPDATE media SET titulo = ?, descripcion = ?, club = ?, portada_segundo = ?, portada_foco = ? WHERE id = ?"
              ).bind(titulo, descripcion || null, clubGuardado, portadaSegundo, portadaFoco, id).run();
              console.error("No se pudo guardar visibilidad (falta migración migracion_media_visibilidad.sql):", err.message);
            } catch (err2) {
              throw err2;
            }
          } else if (esColumnaFocoFaltante) {
            try {
              await env.DB.prepare(
                "UPDATE media SET titulo = ?, descripcion = ?, club = ?, portada_segundo = ? WHERE id = ?"
              ).bind(titulo, descripcion || null, clubGuardado, portadaSegundo, id).run();
              console.error("No se pudo guardar portada_foco (falta migración migracion_media_portada_foco.sql):", err.message);
            } catch (err2) {
              throw err2;
            }
          } else if (esColumnaFaltante) {
            // Columna aún no migrada en esta base de datos: se guarda el
            // resto de campos igualmente y se avisa del detalle solo por log.
            await env.DB.prepare(
              "UPDATE media SET titulo = ?, descripcion = ?, club = ? WHERE id = ?"
            ).bind(titulo, descripcion || null, clubGuardado, id).run();
            console.error("No se pudo guardar portada_segundo/portada_foco (falta migración migracion_media_portada.sql):", err.message);
          } else {
            throw err;
          }
        }

        // ---------- Vínculo con la galería de partido (match_gallery) ----------
        // Se gestiona aparte del UPDATE de arriba porque no es una simple
        // columna de "media": es una fila (o ausencia de fila) en otra
        // tabla. Tres casos posibles:
        //  1) Se elige un partido y antes no había ninguno vinculado ->
        //     se crea el enlace.
        //  2) Se elige un partido y ya había uno vinculado (al mismo
        //     partido o a otro distinto) -> se actualiza el enlace
        //     existente (result_id + equipo) en vez de duplicar filas.
        //  3) Se quita el partido (resultId vacío) habiendo uno antes ->
        //     se borra el enlace.
        // Al ser "extra" (igual que en /api/media POST), un fallo aquí no
        // debe tirar abajo el resto de cambios ya guardados en "media".
        try {
          const enlaceExistente = await env.DB.prepare(
            "SELECT id, result_id FROM match_gallery WHERE media_id = ?"
          ).bind(id).first();

          if (resultId) {
            const resultadoDestino = await env.DB.prepare(
              "SELECT id FROM results WHERE id = ?"
            ).bind(resultId).first();
            if (!resultadoDestino) return json({ error: "El partido elegido ya no existe" }, 404);

            if (enlaceExistente) {
              await env.DB.prepare(
                "UPDATE match_gallery SET result_id = ?, equipo = ? WHERE id = ?"
              ).bind(resultId, equipoGaleria, enlaceExistente.id).run();
            } else {
              const maxOrdenFila = await env.DB.prepare(
                "SELECT COALESCE(MAX(orden), -1) AS max_orden FROM match_gallery WHERE result_id = ?"
              ).bind(resultId).first();
              const siguienteOrden = (maxOrdenFila?.max_orden ?? -1) + 1;
              await env.DB.prepare(
                `INSERT INTO match_gallery (result_id, media_id, orden, vinculado_por_id, equipo) VALUES (?, ?, ?, ?, ?)`
              ).bind(resultId, id, siguienteOrden, payload.uid, equipoGaleria).run();
            }
          } else if (enlaceExistente) {
            await env.DB.prepare("DELETE FROM match_gallery WHERE id = ?").bind(enlaceExistente.id).run();
          }
        } catch (err) {
          console.error("No se pudo actualizar el vínculo con la galería del partido al editar media:", err.message);
        }

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
        return cors(new Response(objeto.body, { headers }), ORIGEN_PETICION_ACTUAL);
      }

      // ---------- MEDIA: eliminar (solo admins) ----------
      if (mediaMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(mediaMatch[1]);
        const registro = await env.DB.prepare("SELECT cloudinary_public_id, cloudinary_resource_type, cloudinary_url, autor_id FROM media WHERE id = ?").bind(id).first();
        if (!registro) return json({ error: "No encontrado" }, 404);
        if (payload.rol !== "admin" && registro.autor_id !== payload.uid) {
          return json({ error: "Solo puedes eliminar contenido que hayas subido tú" }, 403);
        }
        await borrarDeCloudinary(env, registro.cloudinary_public_id, registro.cloudinary_resource_type, cloudNameDeUrlCloudinary(registro.cloudinary_url));
        await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(id).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "eliminar_media", entidad: "media", entidad_id: id,
          descripcion: `Ha eliminado un contenido multimedia (id ${id})`,
        }));
        return json({ ok: true });
      }

      // ---------- GALERÍA DE PARTIDO (match_gallery) ----------
      // Vincula imágenes ya existentes en "media" con un partido de
      // "results" (Bloque B, Fase 10 del plan de colaboradores). No
      // sube ningún archivo nuevo (eso lo sigue haciendo /api/media,
      // igual que hasta ahora): esto solo crea/borra/reordena el
      // enlace entre una imagen ya subida y un partido.
      //
      // Permisos (ver puedeGestionarGaleria en el bloque de roles):
      //  - Consultar la galería de un partido: admin, fotógrafo o
      //    redactor (el redactor no sube, pero sí necesita poder verla
      //    para elegir imágenes al escribir una noticia, Fase 12).
      //  - Vincular/reordenar/desvincular: admin o fotógrafo, sobre
      //    CUALQUIER partido (no solo "los suyos"): la autoría de cada
      //    imagen ya queda registrada en media.autor_id para el
      //    crédito de foto (Fase 14), así que restringir además la
      //    galería por partido no aporta nada y solo estorbaría si
      //    varios fotógrafos cubren el mismo encuentro.
      //  - Desvincular una imagen en concreto: además de lo anterior,
      //    el propio fotógrafo que la vinculó siempre puede quitarla
      //    (igual que en /api/media, aunque aquí ya no hace falta ser
      //    admin para quitar SU PROPIO enlace).
      const galeriaPartidoMatch = path.match(/^\/api\/results\/(\d+)\/galeria$/);

      if (galeriaPartidoMatch && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarGaleria(payload) && !esRedactor(payload)) {
          return json({ error: "No tienes acceso a la galería de partidos" }, 403);
        }
        const resultId = parseInt(galeriaPartidoMatch[1]);
        const resultado = await env.DB.prepare(
          "SELECT id, equipo_local, equipo_visitante, fecha_partido, slug FROM results WHERE id = ?"
        ).bind(resultId).first();
        if (!resultado) return json({ error: "Partido no encontrado" }, 404);
        const { results } = await env.DB.prepare(
          `SELECT mg.id, mg.orden, mg.created_at, mg.equipo,
                  m.id AS media_id, m.cloudinary_url, m.titulo, m.descripcion,
                  m.tipo, m.autor_id, COALESCE(u.nombre, m.autor_nombre) AS autor_nombre
           FROM match_gallery mg
           JOIN media m ON m.id = mg.media_id
           LEFT JOIN users u ON u.id = m.autor_id
           WHERE mg.result_id = ?
           ORDER BY mg.orden ASC, mg.created_at ASC`
        ).bind(resultId).all();
        // El link público solo tiene sentido si ya hay al menos una foto
        // vinculada; no se genera un slug "en vacío" para un partido sin
        // galería todavía.
        const slug = results.length ? await slugPartidoUnico(env, resultado) : (resultado.slug || null);
        return json({
          galeria: results,
          equipoLocal: resultado.equipo_local,
          equipoVisitante: resultado.equipo_visitante,
          slug,
          urlPublica: slug ? `${SITIO_URL}/galeria/${slug}` : null,
        });
      }

      if (galeriaPartidoMatch && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarGaleria(payload)) {
          return json({ error: "Un redactor no puede gestionar la galería de un partido, solo consultarla" }, 403);
        }
        const resultId = parseInt(galeriaPartidoMatch[1]);
        const resultado = await env.DB.prepare("SELECT id FROM results WHERE id = ?").bind(resultId).first();
        if (!resultado) return json({ error: "Partido no encontrado" }, 404);

        const body = await request.json().catch(() => ({}));
        // Admite vincular una imagen sola (mediaId) o varias de golpe
        // (mediaIds), para no obligar al frontend a hacer una llamada
        // por cada foto al subir una tanda entera desde el panel del
        // fotógrafo.
        const mediaIds = Array.isArray(body.mediaIds)
          ? body.mediaIds.map((x) => parseInt(x)).filter((x) => Number.isInteger(x))
          : (Number.isInteger(parseInt(body.mediaId)) ? [parseInt(body.mediaId)] : []);
        if (!mediaIds.length) return json({ error: "Falta mediaId o mediaIds" }, 400);
        // De qué equipo son estas fotos ('local', 'visitante' o vacío
        // para foto general), igual criterio que en POST /api/media.
        let equipoGaleria = (body.equipo || "").toString().trim().toLowerCase();
        if (equipoGaleria !== "local" && equipoGaleria !== "visitante") equipoGaleria = null;

        // Siguiente número de orden libre, para que las imágenes nuevas
        // se añadan al final de la galería en vez de mezclarse con las
        // que ya estuvieran (el fotógrafo puede reordenar después con
        // el PUT de más abajo).
        const maxOrdenFila = await env.DB.prepare(
          "SELECT COALESCE(MAX(orden), -1) AS max_orden FROM match_gallery WHERE result_id = ?"
        ).bind(resultId).first();
        let siguienteOrden = (maxOrdenFila?.max_orden ?? -1) + 1;

        const vinculadas = [];
        const errores = [];
        for (const mediaId of mediaIds) {
          const media = await env.DB.prepare("SELECT id FROM media WHERE id = ?").bind(mediaId).first();
          if (!media) {
            errores.push({ mediaId, error: "No encontrado en la mediateca" });
            continue;
          }
          try {
            await env.DB.prepare(
              `INSERT INTO match_gallery (result_id, media_id, orden, vinculado_por_id, equipo) VALUES (?, ?, ?, ?, ?)`
            ).bind(resultId, mediaId, siguienteOrden, payload.uid, equipoGaleria).run();
            vinculadas.push(mediaId);
            siguienteOrden++;
          } catch (err) {
            // El índice único (result_id, media_id) rechaza vincular
            // dos veces la misma imagen al mismo partido: no es un
            // error real, simplemente ya estaba.
            if (/unique/i.test(err.message || "")) {
              errores.push({ mediaId, error: "Ya estaba en la galería de este partido" });
            } else {
              errores.push({ mediaId, error: err.message });
            }
          }
        }

        if (vinculadas.length) {
          ctx.waitUntil(registrarActividad(env, request, payload, {
            accion: "vincular_galeria_partido", entidad: "resultado", entidad_id: resultId,
            descripcion: `Ha añadido ${vinculadas.length} imagen${vinculadas.length === 1 ? "" : "es"} a la galería del partido #${resultId}.`,
            detalle: { media_ids: vinculadas },
          }));
        }

        return json({ ok: true, vinculadas, errores });
      }

      // ---------- GALERÍA DE PARTIDO: reordenar ----------
      // Recibe el orden completo deseado como lista de ids de
      // match_gallery (no de media), más simple que mandar deltas.
      if (galeriaPartidoMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarGaleria(payload)) {
          return json({ error: "Un redactor no puede reordenar la galería de un partido" }, 403);
        }
        const resultId = parseInt(galeriaPartidoMatch[1]);
        const body = await request.json().catch(() => ({}));
        const orden = Array.isArray(body.orden) ? body.orden.map((x) => parseInt(x)).filter((x) => Number.isInteger(x)) : [];
        if (!orden.length) return json({ error: "Falta el nuevo orden (lista de ids)" }, 400);

        // Solo se tocan filas que de verdad pertenezcan a este partido,
        // para que no se pueda colar el id de una fila de otra galería
        // desde el body.
        for (let i = 0; i < orden.length; i++) {
          await env.DB.prepare(
            "UPDATE match_gallery SET orden = ? WHERE id = ? AND result_id = ?"
          ).bind(i, orden[i], resultId).run();
        }
        return json({ ok: true });
      }

      // ---------- GALERÍA DE PARTIDO: desvincular una imagen ----------
      // Borra solo el enlace en match_gallery; la imagen sigue
      // existiendo en "media" (para borrarla del todo se usa
      // DELETE /api/media/:id, ya existente, solo accesible a admin).
      const galeriaItemMatch = path.match(/^\/api\/match-gallery\/(\d+)$/);

      // ---------- GALERÍA DE PARTIDO: cambiar el equipo de una foto ----------
      // Permite corregir a posteriori de qué equipo es una foto ya
      // vinculada (p. ej. si se subió sin elegir equipo, o se eligió mal),
      // sin tener que desvincularla y volver a subirla.
      if (galeriaItemMatch && method === "PATCH") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarGaleria(payload)) {
          return json({ error: "Un redactor no puede editar la galería de un partido" }, 403);
        }
        const id = parseInt(galeriaItemMatch[1]);
        const enlace = await env.DB.prepare("SELECT id FROM match_gallery WHERE id = ?").bind(id).first();
        if (!enlace) return json({ error: "No encontrado" }, 404);
        const body = await request.json().catch(() => ({}));
        let equipoGaleria = (body.equipo || "").toString().trim().toLowerCase();
        if (equipoGaleria !== "local" && equipoGaleria !== "visitante") equipoGaleria = null;
        await env.DB.prepare("UPDATE match_gallery SET equipo = ? WHERE id = ?").bind(equipoGaleria, id).run();
        return json({ ok: true });
      }

      if (galeriaItemMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const id = parseInt(galeriaItemMatch[1]);
        const enlace = await env.DB.prepare("SELECT result_id, vinculado_por_id FROM match_gallery WHERE id = ?").bind(id).first();
        if (!enlace) return json({ error: "No encontrado" }, 404);
        const puedeQuitar = esAdmin(payload) || enlace.vinculado_por_id === payload.uid;
        if (!puedeQuitar) {
          return json({ error: "Solo un administrador o quien vinculó esta imagen puede quitarla de la galería" }, 403);
        }
        await env.DB.prepare("DELETE FROM match_gallery WHERE id = ?").bind(id).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "desvincular_galeria_partido", entidad: "resultado", entidad_id: enlace.result_id,
          descripcion: `Ha quitado una imagen de la galería del partido #${enlace.result_id}.`,
        }));
        return json({ ok: true });
      }

      // ---------- GALERÍA DE PARTIDO: vista pública (Fase 2 galería) ----------
      // Sin autenticación, a diferencia de GET /api/results/:id/galeria de
      // arriba (que es la vista de gestión del panel). Se consulta por
      // slug (no por id) porque es el formato de la URL pública
      // compartible (/galeria/:slug, ver public/_worker.js). Devuelve las
      // fotos ya agrupadas por equipo para que el frontend público solo
      // tenga que pintar las pestañas, sin repetir esa lógica en JS.
      const galeriaPublicaMatch = path.match(/^\/api\/results\/galeria\/([^/]+)$/);
      if (galeriaPublicaMatch && method === "GET") {
        const slug = decodeURIComponent(galeriaPublicaMatch[1]);
        const resultado = await env.DB.prepare(
          "SELECT id, equipo_local, equipo_visitante, escudo_local_url, escudo_visitante_url, goles_local, goles_visitante, penaltis_local, penaltis_visitante, fecha_partido, estado, competicion, jornada, slug FROM results WHERE slug = ?"
        ).bind(slug).first();
        if (!resultado) return json({ error: "Galería no encontrada" }, 404);
        // Vista pública, sin autenticar: solo se devuelve lo marcado como
        // "publico". Lo marcado como "privado" existe igualmente en
        // match_gallery (para que el equipo de redacción lo siga viendo
        // y gestionando desde el panel), pero nunca sale por aquí.
        // Se prueba de la consulta más completa (visibilidad + foco) a la más
        // básica: "visibilidad" y "portada_foco" son columnas añadidas por
        // migraciones manuales y puede que aún no existan en esta BD (sin
        // "visibilidad" todo se trata como público, como antes de la función).
        const consultaGaleria = (conVisibilidad, conFoco) => `SELECT mg.equipo, m.id AS media_id, m.cloudinary_url, m.titulo, m.descripcion,
                    m.tipo, COALESCE(u.nombre, m.autor_nombre) AS autor_nombre${conFoco ? ", m.portada_foco" : ""}
             FROM match_gallery mg
             JOIN media m ON m.id = mg.media_id
             LEFT JOIN users u ON u.id = m.autor_id
             WHERE mg.result_id = ?${conVisibilidad ? " AND m.visibilidad = 'publico'" : ""}
             ORDER BY mg.orden ASC, mg.created_at ASC`;
        const { results: filasBrutas } = await consultaConAlternativas(env, [
          consultaGaleria(true, true), consultaGaleria(true, false),
          consultaGaleria(false, true), consultaGaleria(false, false),
        ], [resultado.id]);
        const filas = filasBrutas.map((f) => ({ ...f, portada_foco: normalizarFocoOpcional(f.portada_foco) }));
        // Agrupado en servidor: "local"/"visitante" con su nombre de
        // equipo ya resuelto, y "general" para fotos sin equipo asignado
        // (p.ej. del estadio o del ambiente, no de un equipo en concreto).
        // Un grupo con cero fotos no se incluye, así el frontend puede
        // usar directamente Object.keys(grupos) para decidir qué
        // pestañas mostrar.
        const grupos = {};
        const agregarAGrupo = (clave, nombre) => {
          const deEseGrupo = filas.filter((f) => (f.equipo || null) === clave);
          if (deEseGrupo.length) grupos[clave || "general"] = { nombre, fotos: deEseGrupo };
        };
        agregarAGrupo("local", resultado.equipo_local);
        agregarAGrupo("visitante", resultado.equipo_visitante);
        agregarAGrupo(null, "General");
        return json({
          partido: resultado,
          totalFotos: filas.length,
          grupos,
        });
      }

      // ---------- GALERÍA GENERAL DEL SITIO: vista pública ----------
      // Sin autenticación, a diferencia de GET /api/media (panel), que
      // exige login y además solo enseña a cada redactor/fotógrafo lo
      // suyo (o todo, si es admin). Aquí, al revés: se enseña TODO lo
      // marcado como "publico" (igual criterio que la galería de un
      // partido en concreto, ver galeriaPublicaMatch más arriba), sin
      // importar quién lo subió ni a qué partido esté vinculado -es la
      // "portada" de toda la mediateca, no la de un partido. Paginado
      // con LIMIT+1 (se piden 25 pero se comprueba si llegó la 25) para
      // saber si hay más sin tener que lanzar un COUNT(*) aparte.
      if (path === "/api/media/publica" && method === "GET") {
        const TAM_PAGINA = 24;
        const pagina = Math.max(1, parseInt(url.searchParams.get("pagina"), 10) || 1);
        const tipoFiltro = url.searchParams.get("tipo"); // "foto" | "video" | null (todo)
        const offset = (pagina - 1) * TAM_PAGINA;

        const condicionTipo = tipoFiltro === "foto" || tipoFiltro === "video" ? "AND m.tipo = ?" : "";
        const bindsBase = tipoFiltro === "foto" || tipoFiltro === "video" ? [tipoFiltro] : [];

        // Misma estrategia que la galería de partido: de la consulta más
        // completa (visibilidad + foco) a la más básica.
        const consultaMediaPublica = (conVisibilidad, conFoco) => `SELECT m.id, m.cloudinary_url, m.titulo, m.descripcion, m.tipo, m.club, m.created_at,
                    COALESCE(u.nombre, m.autor_nombre) AS autor_nombre${conFoco ? ", m.portada_foco" : ""}
             FROM media m
             LEFT JOIN users u ON u.id = m.autor_id
             WHERE ${conVisibilidad ? "m.visibilidad = 'publico'" : "1=1"} ${condicionTipo}
             ORDER BY m.created_at DESC LIMIT ? OFFSET ?`;
        const { results: filasBrutas } = await consultaConAlternativas(env, [
          consultaMediaPublica(true, true), consultaMediaPublica(true, false),
          consultaMediaPublica(false, true), consultaMediaPublica(false, false),
        ], [...bindsBase, TAM_PAGINA + 1, offset]);
        const filas = filasBrutas.map((f) => ({ ...f, portada_foco: normalizarFocoOpcional(f.portada_foco) }));

        const hayMas = filas.length > TAM_PAGINA;
        if (hayMas) filas.length = TAM_PAGINA;

        // A cada foto/vídeo se le adjunta, si lo tiene, el partido al
        // que está vinculado en match_gallery (equipos + slug), para
        // poder ofrecer un "Ver partido" desde la galería general sin
        // que el frontend tenga que hacer una consulta aparte por foto.
        if (filas.length) {
          try {
            const { results: enlaces } = await env.DB.prepare(
              `SELECT mg.media_id, r.equipo_local, r.equipo_visitante, r.slug
               FROM match_gallery mg
               JOIN results r ON r.id = mg.result_id
               WHERE mg.media_id IN (${filas.map(() => "?").join(",")})`
            ).bind(...filas.map((f) => f.id)).all();
            const porMediaId = new Map(enlaces.map((e) => [e.media_id, e]));
            for (const f of filas) {
              const e = porMediaId.get(f.id);
              if (e && e.slug) {
                f.partido = { equipo_local: e.equipo_local, equipo_visitante: e.equipo_visitante, slug: e.slug };
              }
            }
          } catch (err) {
            console.error("No se pudo cargar el partido vinculado de la galería general (se continúa sin ese dato):", err.message);
          }
        }

        return json({ media: filas, pagina, hayMas });
      }

      // ---------- GALERÍA/IMÁGENES DE UNA NOTICIA (article_media, Fase 12) ----------
      // Consulta lo que ya se vinculó a una noticia (para pintarlo en el
      // editor, Fase 13, o en la noticia pública, Fase 14). No hace falta
      // endpoint aparte para vincular: se manda junto con el resto del
      // formulario en POST/PUT /api/articles (ver sincronizarArticleMedia).
      const articuloMediaMatch = path.match(/^\/api\/articles\/(\d+)\/media$/);
      if (articuloMediaMatch && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const articleId = parseInt(articuloMediaMatch[1]);
        let results;
        try {
          ({ results } = await env.DB.prepare(
            `SELECT am.id, am.orden, m.id AS media_id, m.cloudinary_url, m.titulo, m.descripcion,
                    m.tipo, m.autor_id, COALESCE(u.nombre, m.autor_nombre) AS autor_nombre, m.portada_segundo, m.portada_foco
             FROM article_media am
             JOIN media m ON m.id = am.media_id
             LEFT JOIN users u ON u.id = m.autor_id
             WHERE am.article_id = ?
             ORDER BY am.orden ASC`
          ).bind(articleId).all());
        } catch (err) {
          // portada_segundo / portada_foco son columnas añadidas por
          // migraciones manuales: si aún no se han ejecutado en esta base
          // de datos, se reintenta sin ellas en vez de romper la consulta.
          ({ results } = await env.DB.prepare(
            `SELECT am.id, am.orden, m.id AS media_id, m.cloudinary_url, m.titulo, m.descripcion,
                    m.tipo, m.autor_id, COALESCE(u.nombre, m.autor_nombre) AS autor_nombre
             FROM article_media am
             JOIN media m ON m.id = am.media_id
             LEFT JOIN users u ON u.id = m.autor_id
             WHERE am.article_id = ?
             ORDER BY am.orden ASC`
          ).bind(articleId).all());
        }
        return json({ media: results });
      }

      // ---------- ARTICLES: lista pública / creación ----------
      // ---------- Banner flotante de "última hora" (público) ----------
      // Lo consulta layout.js desde CUALQUIER página del sitio (es la
      // única llamada que hace falta para saber si hay que pintar el
      // banner). Se resuelve con el propio WHERE de la consulta: en
      // cuanto pasen las 2h de banner_urgente_hasta, deja de devolver
      // nada sin que haga falta ningún cron ni tarea aparte que la
      // desactive. Solo puede haber una noticia con banner activo a la
      // vez desde el panel (ver PUT/POST más abajo, que no fuerzan esto
      // a nivel de base de datos, pero si hubiera más de una por lo que
      // sea, se devuelve solo la más reciente).
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
      // Desactivar el banner sin tener que reenviar todo el formulario
      // de edición de la noticia (pensado para el botón "Quitar" del
      // listado del panel, ver Fase 2). Mismo criterio de permisos que
      // activarlo desde el PUT normal: admin o redactor Nivel 2+, y
      // además tiene que poder editar esa noticia en concreto.
      const desactivarBannerMatch = path.match(/^\/api\/articles\/(\d+)\/banner-urgente$/);
      if (desactivarBannerMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede gestionar el banner de última hora" }, 403);
        }
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
          // Un fotógrafo tampoco tiene acceso a este listado editorial
          // (no gestiona noticias/crónicas/artículos), así que para él
          // también se degrada a la vista pública.
          const payload = await requireAuth(request, env);
          // Si se envió credencial pero no es válida (sesión no replicada,
          // JWT_SECRET distinto, caducada...) se responde 401 en vez de
          // degradar EN SILENCIO a la vista pública: antes el panel mostraba
          // la lista sin borradores ni noticias en revisión, sin ningún error.
          if (!payload && (request.headers.get("Authorization") || "").startsWith("Bearer ")) {
            return json({ error: "No autorizado" }, 401);
          }
          if (!payload || !puedeGestionarContenidoEditorial(payload)) admin = false;
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
        let query = `SELECT id, slug, titulo, subtitulo, contenido, tipo, categoria, categorias_adicionales, club, imagen_url, imagenes,
            resultado_id, autor_id, autor_nombre, coautor_id, coautor_nombre, destacado, publicado,
            estado_borrador, programado_para, fecha_preferencia_desde, fecha_preferencia_hasta, slug_congelado, fecha_publicacion, created_at, updated_at,
            titulo_eu, LENGTH(contenido_eu) AS contenido_eu_len,
            titulo_ca, LENGTH(contenido_ca) AS contenido_ca_len,
            titulo_gl, LENGTH(contenido_gl) AS contenido_gl_len,
            titulo_en, LENGTH(contenido_en) AS contenido_en_len,
            ficha_tecnica, fuera_calendario, banner_urgente, banner_urgente_hasta,
            ${admin
              ? `CASE WHEN publicado = 1 AND tipo IN ('previa', 'cronica') AND resultado_id IS NOT NULL
                   THEN (SELECT COUNT(*) FROM articles b WHERE b.resultado_id = articles.resultado_id AND b.tipo = articles.tipo AND b.publicado = 1)
                   ELSE 0 END`
              : "0"} AS fusion_total,
            ${admin
              ? `CASE WHEN publicado = 1 AND tipo IN ('previa', 'cronica') AND resultado_id IS NOT NULL
                   THEN (SELECT b.slug FROM articles b WHERE b.resultado_id = articles.resultado_id AND b.tipo = articles.tipo AND b.publicado = 1 ORDER BY b.id ASC LIMIT 1)
                   ELSE NULL END`
              : "NULL"} AS fusion_slug,
            ${admin
              ? `CASE WHEN publicado = 1 AND tipo IN ('previa', 'cronica') AND resultado_id IS NOT NULL
                   THEN (SELECT b.categoria FROM articles b WHERE b.resultado_id = articles.resultado_id AND b.tipo = articles.tipo AND b.publicado = 1 ORDER BY b.id ASC LIMIT 1)
                   ELSE NULL END`
              : "NULL"} AS fusion_categoria
          FROM articles WHERE 1=1`;
        const binds = [];
        if (!admin) {
          query += " AND publicado = 1";
          if (!slugExacto) query += SQL_OCULTAR_SEGUNDO_DE_FUSION;
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

        const { results: resultadosBD } = await env.DB.prepare(query).bind(...binds).all();
        // Vista admin: se reevalúa el horario al leer (ver aplicarFueraCalendarioEnLectura).
        const results = admin ? await aplicarFueraCalendarioEnLectura(env, resultadosBD) : resultadosBD;
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
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede crear noticias, crónicas ni artículos" }, 403);
        }
        const body = await request.json();
        if (typeof body.contenido === "string") body.contenido = sanearHtmlArticulo(body.contenido);
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

        // Preferencia de publicación del REDACTOR: rango de fechas (día,
        // sin hora) puramente orientativo que puede acompañar al borrador
        // cuando se marca como "terminado", para que quien lo revise
        // sepa en qué días conviene publicarlo. Solo aplica junto a un
        // borrador "terminado" (si no se guarda como terminado, o si se
        // publica/programa directamente, no tiene sentido conservarla).
        const preferenciaFechas = normalizarPreferenciaFechas(estadoBorrador === "terminado" ? body : null);
        // Un redactor de Nivel 1 está obligado a indicar fecha de preferencia
        // al mandar una noticia a revisión (borrador "terminado"): así quien
        // la revisa sabe cuándo conviene publicarla. Nivel 2+ y admin: opcional.
        if (payload.rol !== "admin" && estadoBorrador === "terminado" && (nivelUsuario ?? 1) < 2 && !preferenciaFechas.desde) {
          return json({ error: "Como redactor de nivel 1 debes indicar una fecha de preferencia para que la revisen" }, 400);
        }

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

        // Club(es) (y, para previa/crónica, categoría) del artículo: para
        // previa/crónica ambos se derivan siempre del resultado vinculado
        // (los dos equipos y la competición del partido), no de los
        // selectores del panel (ver resolverClubArticulo). Para el resto
        // de tipos no cambia nada.
        const { error: errorClub, club: clubFinal, categoria: categoriaAutomatica } = await resolverClubArticulo(env, body.tipo, resultadoId, body.club);
        if (errorClub) return json({ error: errorClub }, 400);

        // Autor de la noticia: por defecto quien la está subiendo, pero se
        // puede elegir a otra persona (p. ej. cuando quien sube la noticia
        // no es quien la ha redactado). Se busca siempre en la tabla de
        // usuarios (y no en el JWT) para firmar con el nombre actual y
        // para no poder "firmar" con un nombre inventado.
        const idAutorElegido = body.autor_id ? parseInt(body.autor_id, 10) : payload.uid;
        const autorElegido = await env.DB.prepare("SELECT id, nombre, categorias_fijas FROM users WHERE id = ? AND activo = 1")
          .bind(idAutorElegido).first();
        const autorId = autorElegido ? autorElegido.id : payload.uid;
        const autorNombre = autorElegido ? autorElegido.nombre : payload.nombre;

        // Si el autor final tiene categoría(s) fija(s), la categoría de la
        // noticia debe respetarlas (se valida/fuerza aquí, se aplica al
        // hacer el INSERT más abajo con "categoriaFinal").
        const categoriasFijasAutor = parsearCategoriasFijas(autorElegido ? autorElegido.categorias_fijas : null);
        // Para previa/crónica la categoría ya viene resuelta desde el
        // resultado vinculado (categoriaAutomatica, ver
        // resolverClubArticulo): se usa esa en vez de la que mande el
        // body, pero sigue pasando por validarCategoriaSegunAutor para
        // que, si el autor tiene categoría(s) fija(s), se siga
        // respetando esa restricción.
        const { error: errorCategoriaAutor, categoria: categoriaFinal } = validarCategoriaSegunAutor(
          categoriasFijasAutor, categoriaAutomatica !== undefined ? categoriaAutomatica : body.categoria
        );
        if (errorCategoriaAutor) return json({ error: errorCategoriaAutor }, 400);

        // Categoría(s) adicional(es): simples etiquetas informativas
        // aparte de la principal (que es la única que forma el link y la
        // única que filtra en categoria.html). Ver validarCategoriasAdicionales.
        const { error: errorCategoriasAdicionales, categoriasAdicionales } = validarCategoriasAdicionales(
          body.categorias_adicionales, categoriaFinal, categoriasFijasAutor
        );
        if (errorCategoriasAdicionales) return json({ error: errorCategoriasAdicionales }, 400);

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

        // Banner urgente: solo puede activarlo (a mano, al crear la
        // noticia) un admin o un redactor de Nivel 2+ -- igual de
        // criterio que programar publicación, más arriba -- para que un
        // redactor recién llegado no pueda ponerse a sí mismo en el
        // banner de toda la web. body.banner_urgente = true lo activa;
        // cualquier otro valor (incluido no mandar el campo) lo deja
        // desactivado. La fecha de caducidad la calcula el propio SQL
        // con datetime('now', '+2 hours'), nunca un valor del cliente.
        // nivelUsuario puede seguir sin calcular aquí (solo se resuelve
        // más arriba si body.publicado !== false), así que se completa
        // bajo demanda antes de decidir el permiso del banner.
        if (nivelUsuario === null) nivelUsuario = await obtenerNivelUsuario(env, payload.uid);
        const puedeActivarBanner = payload.rol === "admin" || nivelUsuario >= 2;
        const activarBanner = puedeActivarBanner && body.banner_urgente === true;

        const filaArticuloCreado = await env.DB.prepare(
          `INSERT INTO articles (slug, titulo, subtitulo, contenido, tipo, categoria, categorias_adicionales, club, imagen_url, imagenes, resultado_id, autor_id, autor_nombre, coautor_id, coautor_nombre, destacado, publicado, estado_borrador, programado_para, fecha_preferencia_desde, fecha_preferencia_hasta, slug_congelado, fecha_publicacion, updated_at,
            titulo_eu, subtitulo_eu, contenido_eu, titulo_ca, subtitulo_ca, contenido_ca, titulo_gl, subtitulo_gl, contenido_gl, titulo_en, subtitulo_en, contenido_en, origin_write_id, ficha_tecnica, banner_urgente, banner_urgente_hasta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${calcularBannerUrgenteHasta(activarBanner)}) RETURNING id`
        ).bind(
          slug, body.titulo, body.subtitulo || null, body.contenido,
          body.tipo || "noticia", categoriaFinal, categoriasAdicionales.length ? JSON.stringify(categoriasAdicionales) : null, clubFinal,
          imagenPortada, imagenes.length ? JSON.stringify(imagenes) : null, resultadoId,
          autorId, autorNombre, coautorId, coautorNombre,
          body.destacado ? 1 : 0, body.publicado === false ? 0 : 1, estadoBorrador, programadoPara, preferenciaFechas.desde, preferenciaFechas.hasta, slugCongelado,
          programadoPara || body.fecha_publicacion || new Date().toISOString(),
          traducciones.titulo_eu, traducciones.subtitulo_eu, traducciones.contenido_eu,
          traducciones.titulo_ca, traducciones.subtitulo_ca, traducciones.contenido_ca,
          traducciones.titulo_gl, traducciones.subtitulo_gl, traducciones.contenido_gl,
          traducciones.titulo_en, traducciones.subtitulo_en, traducciones.contenido_en,
          origenWriteId, fichaTecnica, activarBanner ? 1 : 0
        ).first();

        // Fase 12: galería/imágenes sueltas vinculadas a la noticia (aparte
        // de "imagenes", que van dentro del propio texto). Solo se guarda
        // algo si el redactor mandó media_ids y/o galeria_resultado_id.
        await sincronizarArticleMedia(env, filaArticuloCreado.id, body);

        // Horario de publicación: si se publica ahora (no borrador ni
        // programada) se comprueba si el día y el tipo están permitidos.
        let fueraCalendario = false;
        if (body.publicado !== false && !programadoPara) {
          fueraCalendario = await marcarFueraDeCalendario(env, filaArticuloCreado.id, { tipo: body.tipo, resultado_id: resultadoId });
        } else if (programadoPara) {
          // Programada: se avisa ya si su día/hora cae fuera del horario, para no
          // ofrecer "Compartir". La marca definitiva la guarda el cron al publicarse.
          try { fueraCalendario = await estaFueraDeCalendario(env, { tipo: body.tipo, resultado_id: resultadoId, fecha: fechaSqlADate(programadoPara) || undefined }); } catch (err) { console.error("horario_publicacion:", err); }
        }

        const publicado = body.publicado !== false;
        const tipoLabel = { noticia: "Noticia", previa: "Previa", cronica: "Crónica", analisis: "Análisis", opinion: "Opinión", entrevista: "Entrevista" }[body.tipo] || "Artículo";
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
                { etiqueta: "Categoría", valor: clubArticuloLegible(clubFinal) || body.categoria },
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
          const textoPreferenciaFechas = formatearPreferenciaFechasEmail(preferenciaFechas);
          ctx.waitUntil(enviarEmailNotificacion(env, {
            asunto: `Nuevo borrador terminado: ${body.titulo}`,
            texto: `${payload.nombre} ha guardado el borrador "${body.titulo}" (${tipoLabel}) en ELOTROFÚTBOLTV, firmado por ${firmaAutores}, marcándolo como terminado. Todavía no está publicado.${textoPreferenciaFechas ? ` Preferencia de fecha del redactor: ${textoPreferenciaFechas}.` : ""}`,
            html: plantillaEmail({
              etiqueta: "Borrador terminado",
              titulo: body.titulo,
              parrafo: body.subtitulo || null,
              filas: [
                { etiqueta: "Autor", valor: firmaAutores },
                { etiqueta: "Guardado por", valor: payload.nombre },
                { etiqueta: "Categoría", valor: clubArticuloLegible(clubFinal) || body.categoria },
                ...(textoPreferenciaFechas ? [{ etiqueta: "Preferencia de fecha", valor: textoPreferenciaFechas }] : []),
              ],
            }),
          }));
        }

        if (publicado && !programadoPara) {
          ctx.waitUntil(notificarPushArticulo(env, { titulo: body.titulo, subtitulo: body.subtitulo, slug, categoria: categoriaFinal, imagen_url: body.imagen_url }));
          // Aviso a los buscadores (IndexNow) en el mismo momento de publicar.
          ctx.waitUntil(notificarIndexNow(env, [urlNoticia(categoriaFinal, slug)]));
        }

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: programadoPara ? "programar_articulo" : (publicado ? "crear_articulo" : "guardar_borrador"), entidad: "articulo", entidad_id: slug,
          descripcion: programadoPara
            ? `Ha programado "${tipoLabel.toLowerCase()}": "${body.titulo}" para publicarse el ${programadoPara}`
            : `Ha ${publicado ? "publicado" : "guardado el borrador de"} "${tipoLabel.toLowerCase()}": "${body.titulo}"${estadoBorrador ? ` (${estadoBorrador === "terminado" ? "terminado" : "en proceso"})` : ""}${esUltimaHora ? " (Última hora)" : ""}`,
        }));

        return json({ ok: true, slug, publicado, fuera_calendario: fueraCalendario, estado_borrador: estadoBorrador, programado_para: programadoPara, fecha_preferencia_desde: preferenciaFechas.desde, fecha_preferencia_hasta: preferenciaFechas.hasta, avisos_traduccion: avisosTraduccion });
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

        // Fusión de dos previas / dos crónicas del mismo partido (ver
        // SQL_OCULTAR_SEGUNDO_DE_FUSION). Solo en lectura pública por
        // slug (el panel pide por id y ve cada artículo por separado).
        let idsFusion = null;
        if (isNaN(key) && article.publicado) {
          const grupoFusion = await buscarGrupoFusionPartido(env, article);
          if (grupoFusion && grupoFusion.rol === "otro") {
            return json({ redirect: grupoFusion.primero.slug, categoria: grupoFusion.primero.categoria || null });
          }
          if (grupoFusion && grupoFusion.rol === "primero") {
            const idsOtros = grupoFusion.grupo.filter((r) => r.id !== article.id).map((r) => r.id);
            const { results: otrosFusion } = await env.DB.prepare(
              `SELECT * FROM articles WHERE id IN (${idsOtros.map(() => "?").join(",")}) ORDER BY id ASC`
            ).bind(...idsOtros).all();
            const partido = otrosFusion && otrosFusion.length
              ? await env.DB.prepare("SELECT equipo_local, equipo_visitante FROM results WHERE id = ?").bind(article.resultado_id).first()
              : null;
            if (partido) {
              const nombresFusion = { local: partido.equipo_local, visitante: partido.equipo_visitante };
              await cargarPistasFusion(env, article.resultado_id, [article, ...otrosFusion], nombresFusion);
              fusionarGrupoDePartido(article, otrosFusion, nombresFusion);
              idsFusion = [article.id, ...otrosFusion.map((o) => o.id)];
            }
          }
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

        // ficha_tecnica se guarda en la columna como texto JSON (ver
        // /api/articles POST/PUT más arriba), pero el frontend
        // (fichaTecnicaArticuloHTML, public/js/config.js) espera un
        // objeto: sin este parseo llegaba como string y la función la
        // descartaba silenciosamente (typeof ficha !== "object"), por lo
        // que la ficha técnica nunca se veía en ninguna crónica.
        try {
          article.ficha_tecnica = (article.tipo === "cronica" && article.ficha_tecnica) ? JSON.parse(article.ficha_tecnica) : null;
        } catch {
          article.ficha_tecnica = null;
        }

        // Si la noticia/crónica está vinculada a un partido, se adjunta
        // aquí su marcador para que la web lo pueda mostrar.
        //
        // CACHÉ EN KV: este endpoint es público y se llama en CADA visita
        // a una crónica/previa (sin autenticación, sin límite de tráfico
        // propio), y antes hacía 3 consultas D1 (results, match_events,
        // alineaciones) por cada una de esas visitas. En las métricas de
        // D1 de sep-2026 esto sumaba decenas de miles de lecturas/día solo
        // por tráfico público normal. El TTL se adapta al estado del
        // partido en vez de ser fijo: "en_juego" cambia de verdad segundo
        // a segundo (goles, tarjetas, minuto), así que ahí se mantiene
        // corto para que el marcador se vea al día; el resto de estados
        // (programado, retrasado, finalizado, anulado) prácticamente no
        // cambian una vez fijados, así que un TTL mucho más largo no
        // pierde nada en la práctica y evita repetir la consulta (y la
        // escritura en KV) en cada visita/recarga dentro de esa ventana.
        // Antes el TTL era fijo en 30s también para partidos ya
        // terminados/por jugar, lo que en tráfico alto disparaba muchas
        // más escrituras a KV de las necesarias (KV cobra por escritura,
        // no solo por lectura). Se cachea por resultado_id, no por
        // artículo, para que varias crónicas del mismo partido compartan
        // la misma entrada.
        if (article.resultado_id) {
          const cacheKeyPartido = `articulo-partido:${article.resultado_id}`;
          let datosPartido = null;
          if (env.ELOTROFUTBOL_KV) {
            try {
              datosPartido = await env.ELOTROFUTBOL_KV.get(cacheKeyPartido, "json");
            } catch (err) {
              console.error("[cache-articulo-partido] fallo al leer KV, se consulta D1:", err);
            }
          }
          if (!datosPartido) {
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
            const alineaciones = await obtenerAlineaciones(env, "result_id", article.resultado_id);
            datosPartido = { resultado: resultado || null, alineaciones };
            if (env.ELOTROFUTBOL_KV) {
              try {
                const ttlPartido = resultado && resultado.estado === "en_juego" ? 30 : 3600;
                await env.ELOTROFUTBOL_KV.put(cacheKeyPartido, JSON.stringify(datosPartido), { expirationTtl: ttlPartido });
              } catch (err) {
                console.error("[cache-articulo-partido] fallo al guardar (no crítico):", err);
              }
            }
          }
          article.resultado = datosPartido.resultado;
          article.alineaciones = datosPartido.alineaciones;
          // Enlace a la galería pública del partido: a diferencia del
          // modal de "Resultados" (GET /api/results/:id, más abajo), en
          // la crónica SIEMPRE se quiere invitar a la galería aunque
          // todavía no tenga fotos subidas, para animar a fotógrafos y
          // aficionados a visitarla/rellenarla. Por eso aquí ya no se
          // condiciona url_galeria a que exista al menos una foto: se
          // genera (y persiste) el slug del partido de todas formas.
          // galeria_disponible sí distingue si ya hay fotos reales, para
          // que el frontend pueda variar el texto/aspecto de la llamada
          // a la acción ("Ver galería" vs "Sé el primero en verla"/"aún
          // sin fotos"). foto_portada_galeria (primera foto por orden)
          // permite pintar una miniatura real en vez de un icono
          // genérico cuando ya hay contenido. No se guarda nada de esto
          // dentro de "datosPartido" (que sí se cachea en KV) porque la
          // galería puede recibir fotos nuevas en cualquier momento y no
          // queremos servir un estado desactualizado durante todo el TTL
          // del resto del marcador.
          if (article.resultado) {
            const portada = await env.DB.prepare(
              `SELECT m.cloudinary_url AS cloudinary_url
               FROM match_gallery mg JOIN media m ON m.id = mg.media_id
               WHERE mg.result_id = ? AND m.tipo = 'foto'
               ORDER BY mg.orden ASC, mg.created_at ASC LIMIT 1`
            ).bind(article.resultado_id).first();
            article.resultado.url_galeria = `${SITIO_URL}/galeria/${await slugPartidoUnico(env, article.resultado)}`;
            article.resultado.galeria_disponible = !!portada;
            article.resultado.foto_portada_galeria = portada ? portada.cloudinary_url : null;
          }
        } else {
          article.resultado = null;
          // Sin partido vinculado, las alineaciones (si las hay) son
          // propias de la noticia (article_id), no compartidas -no tiene
          // sentido cachearlas aquí: no sufren el mismo problema de
          // volumen que las ligadas a un partido con tráfico público alto.
          article.alineaciones = await obtenerAlineaciones(env, "article_id", article.id);
        }

        // Fase 14: galería de fotos del fotógrafo vinculada a esta noticia
        // (tabla puente article_media, ver Fase 12/13). Se adjunta aquí,
        // en el mismo endpoint público que ya sirve la noticia, para no
        // añadir una segunda petición en cada carga -es tráfico público,
        // igual que el resto de este endpoint. El crédito se construye
        // con el autor real de la foto (autor_nombre de la tabla media,
        // normalmente el fotógrafo que la subió), no con el autor de la
        // noticia, para que quede bien atribuida.
        if (article.id) {
          const idsMedia = idsFusion || [article.id];
          const { results: mediaArticulo } = await env.DB.prepare(
            `SELECT am.orden, m.id AS media_id, m.cloudinary_url, m.descripcion,
                    m.tipo, m.autor_id, COALESCE(u.nombre, m.autor_nombre) AS autor_nombre
             FROM article_media am
             JOIN media m ON m.id = am.media_id
             LEFT JOIN users u ON u.id = m.autor_id
             WHERE am.article_id IN (${idsMedia.map(() => "?").join(",")})
             ORDER BY am.orden ASC`
          ).bind(...idsMedia).all();
          // En una página fusionada, además, no se repite en la galería ninguna
          // foto que ya salga en la portada o dentro del cuerpo (las fotos de
          // cada sección ya llegan deduplicadas por fusionarGrupoDePartido).
          const yaMostradas = new Set();
          if (idsFusion) {
            if (article.imagen_url) yaMostradas.add(claveImagenFusion(article.imagen_url));
            const cuerpoImgs = Array.isArray(article.imagenes) ? article.imagenes : parseImagenesFusion(article.imagenes);
            for (const f of cuerpoImgs) if (f && f.tipo !== "tweet") yaMostradas.add(claveImagenFusion(f.url));
          }
          article.galeria_fotografo = (mediaArticulo || [])
            .filter((m) => {
              if (m.tipo === "video") return false;
              const clave = claveImagenFusion(m.cloudinary_url);
              if (!clave) return true;
              if (yaMostradas.has(clave)) return false;
              yaMostradas.add(clave);
              return true;
            })
            .map((m) => ({
              url: m.cloudinary_url,
              foco: "50% 50%",
              credito: m.autor_nombre || null,
              autor_id: m.autor_id || null,
              descripcion: m.descripcion || null,
            }));
        } else {
          article.galeria_fotografo = [];
        }

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

        // Bots/crawlers/herramientas SEO que ejecutan JS: no cuentan como
        // vista real. Se responde 204 sin insertar nada -- así el propio
        // bot no reintenta pensando que ha fallado, pero el panel de
        // analíticas nunca ve esta petición. Ver esUserAgentBot() arriba
        // para el porqué (era la causa principal de "vistas en exceso").
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
        // Idioma en el que se está leyendo la noticia (lo manda el
        // cliente según el selector de idioma de noticia.html; "es" si
        // no se especifica). Se valida contra una lista cerrada para que
        // esta columna nunca reciba texto arbitrario.
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
      // Mismo criterio que /api/track/view, para poder sacar "partidos
      // más seguidos" en el panel de analíticas (ver
      // calcularPartidosMasSeguidosAnaliticas más abajo). Una fila por
      // carga de la página pública de un partido (minuto-a-minuto.html).
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
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede editar noticias, crónicas ni artículos" }, 403);
        }
        const id = parseInt(articleMatch[1]);

        // Solo el autor (o coautor, o un admin, o alguien con una
        // solicitud de edición aprobada y vigente para esta noticia)
        // puede editarla.
        const articuloParaPermiso = await env.DB.prepare("SELECT slug, autor_id, coautor_id, publicado, estado_borrador, fecha_publicacion, slug_congelado, resultado_id, tipo, categoria, categorias_adicionales, club, ficha_tecnica, banner_urgente, fuera_calendario FROM articles WHERE id = ?").bind(id).first();
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
        if (typeof body.contenido === "string") body.contenido = sanearHtmlArticulo(body.contenido);

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

        // Preferencia de publicación del redactor (ver mismo criterio al
        // crear, más arriba).
        const preferenciaFechas = normalizarPreferenciaFechas(estadoBorrador === "terminado" ? body : null);
        // Un redactor de Nivel 1 está obligado a indicar fecha de preferencia
        // al mandar una noticia a revisión (borrador "terminado"): así quien
        // la revisa sabe cuándo conviene publicarla. Nivel 2+ y admin: opcional.
        if (payload.rol !== "admin" && estadoBorrador === "terminado" && (nivelUsuario ?? 1) < 2 && !preferenciaFechas.desde) {
          return json({ error: "Como redactor de nivel 1 debes indicar una fecha de preferencia para que la revisen" }, 400);
        }

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
        const autorElegido = await env.DB.prepare("SELECT id, nombre, categorias_fijas FROM users WHERE id = ? AND activo = 1")
          .bind(idAutorElegido).first();
        const autorId = autorElegido ? autorElegido.id : (articuloActual ? articuloActual.autor_id : payload.uid);
        const autorNombre = autorElegido ? autorElegido.nombre : (articuloActual ? articuloActual.autor_nombre : payload.nombre);

        // Club (y, para previa/crónica, categoría): para previa/crónica
        // ambos se derivan siempre del resultado vinculado (ver
        // resolverClubArticulo), usando el tipo y el resultado_id finales
        // de esta edición (el nuevo si se manda, o el que ya tenía la
        // noticia si no se toca ese campo). Para el resto de tipos, el
        // club se toma del body si se manda ese campo; si no se manda en
        // absoluto (undefined), se conserva el que ya tenía la noticia,
        // para que una edición que no toca el club (p. ej. solo corregir
        // el título) no lo borre. Se calcula ANTES que la categoría
        // porque, para previa/crónica, la categoría depende de este
        // mismo resultado.
        const tipoFinal = body.tipo !== undefined ? body.tipo : articuloParaPermiso.tipo;
        const resultadoIdFinal = body.resultado_id !== undefined ? resultadoId : articuloParaPermiso.resultado_id;
        const { error: errorClub, club: clubFinal, categoria: categoriaAutomatica } = await resolverClubArticulo(
          env, tipoFinal, resultadoIdFinal,
          body.club !== undefined ? body.club : articuloParaPermiso.club
        );
        if (errorClub) return json({ error: errorClub }, 400);

        // Igual que al crear: si el autor final tiene categoría(s) fija(s),
        // la categoría de la noticia debe respetarlas. Para previa/crónica
        // se usa la categoriaAutomatica ya resuelta arriba (del resultado
        // vinculado); para el resto de tipos, la que venga en el body, o
        // si no llega, la que ya tuviera la noticia (para no reventar
        // ediciones que no tocan la categoría).
        const categoriasFijasAutor = parsearCategoriasFijas(autorElegido ? autorElegido.categorias_fijas : null);
        const { error: errorCategoriaAutor, categoria: categoriaFinal } = validarCategoriaSegunAutor(
          categoriasFijasAutor,
          categoriaAutomatica !== undefined
            ? categoriaAutomatica
            : (body.categoria !== undefined ? body.categoria : articuloParaPermiso.categoria)
        );
        if (errorCategoriaAutor) return json({ error: errorCategoriaAutor }, 400);

        // Categoría(s) adicional(es): igual que la categoría principal, se
        // usan las que vengan en el body si se manda ese campo; si no se
        // manda en absoluto, se conservan las que ya tuviera la noticia
        // (para que una edición que no las toca no las borre). Se
        // revalidan siempre contra la categoría principal final (puede
        // haber cambiado en esta misma edición) y contra las categorías
        // fijas del autor.
        const { error: errorCategoriasAdicionales, categoriasAdicionales } = validarCategoriasAdicionales(
          body.categorias_adicionales !== undefined
            ? body.categorias_adicionales
            : parsearCategoriasAdicionales(articuloParaPermiso.categorias_adicionales),
          categoriaFinal, categoriasFijasAutor
        );
        if (errorCategoriasAdicionales) return json({ error: errorCategoriasAdicionales }, 400);

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
        // borrar la ficha técnica ya rellenada). Reutiliza "tipoFinal",
        // ya calculado más arriba para resolver el club (ver
        // resolverClubArticulo); antes se recalculaba aquí por segunda
        // vez con el mismo criterio salvo el caso body.tipo === "" (que
        // aquí caía a "noticia" y arriba se respetaba tal cual), un
        // matiz sin efecto práctico porque el frontend nunca manda "tipo"
        // vacío.
        let fichaTecnica = articuloParaPermiso.ficha_tecnica || null;
        if (Object.prototype.hasOwnProperty.call(body, "ficha_tecnica")) {
          fichaTecnica = (tipoFinal === "cronica" && body.ficha_tecnica && Object.keys(body.ficha_tecnica).length)
            ? JSON.stringify(body.ficha_tecnica)
            : null;
        } else if (tipoFinal !== "cronica") {
          fichaTecnica = null;
        }

        // Banner urgente al editar: mismo permiso que al crear (admin o
        // Nivel 2+). Si el campo no se manda en absoluto, se conserva
        // el estado que ya tuviera la noticia (para que una edición que
        // no toca el banner -p.ej. corregir una errata- no lo apague
        // sin querer). Si se manda explícitamente true/false, manda eso:
        //   - true  -> (re)activa y reinicia el plazo a 2h desde ahora.
        //   - false -> lo desactiva ya (ver también el endpoint aparte
        //     más abajo, pensado para desactivarlo sin tener que volver
        //     a mandar todo el formulario de la noticia).
        let bannerUrgenteFinal = articuloParaPermiso.banner_urgente ? 1 : 0;
        let bannerUrgenteHastaSQL = null; // null = no tocar esta columna
        if (Object.prototype.hasOwnProperty.call(body, "banner_urgente")) {
          // nivelUsuario puede seguir sin calcular aquí (solo se resuelve
          // más arriba en ciertos casos, ver "programar publicación"), así
          // que se completa bajo demanda antes de decidir el permiso.
          if (nivelUsuario === null) nivelUsuario = await obtenerNivelUsuario(env, payload.uid);
          const puedeActivarBanner = payload.rol === "admin" || nivelUsuario >= 2;
          const activarBanner = puedeActivarBanner && body.banner_urgente === true;
          bannerUrgenteFinal = activarBanner ? 1 : 0;
          bannerUrgenteHastaSQL = calcularBannerUrgenteHasta(activarBanner);
        }

        await env.DB.prepare(
          `UPDATE articles SET slug=?, titulo=?, subtitulo=?, contenido=?, tipo=?, categoria=?, categorias_adicionales=?, club=?, imagen_url=?, imagenes=?, resultado_id=?, autor_id=?, autor_nombre=?, coautor_id=?, coautor_nombre=?, destacado=?, publicado=?, estado_borrador=?, programado_para=?, fecha_preferencia_desde=?, fecha_preferencia_hasta=?, slug_congelado=?, fecha_publicacion=?, updated_at=datetime('now'),
            titulo_eu=?, subtitulo_eu=?, contenido_eu=?, titulo_ca=?, subtitulo_ca=?, contenido_ca=?, titulo_gl=?, subtitulo_gl=?, contenido_gl=?, titulo_en=?, subtitulo_en=?, contenido_en=?, ficha_tecnica=?, banner_urgente=?${bannerUrgenteHastaSQL !== null ? `, banner_urgente_hasta=${bannerUrgenteHastaSQL}` : ""}
           WHERE id=?`
        ).bind(
          slug, body.titulo, body.subtitulo || null, body.contenido, body.tipo || "noticia",
          categoriaFinal, categoriasAdicionales.length ? JSON.stringify(categoriasAdicionales) : null, clubFinal || null, imagenPortada,
          imagenes.length ? JSON.stringify(imagenes) : null, resultadoId,
          autorId, autorNombre, coautorId, coautorNombre,
          body.destacado ? 1 : 0, body.publicado === false ? 0 : 1, estadoBorrador, programadoPara, preferenciaFechas.desde, preferenciaFechas.hasta, slugCongeladoFinal,
          fechaPublicacionFinal,
          traducciones.titulo_eu, traducciones.subtitulo_eu, traducciones.contenido_eu,
          traducciones.titulo_ca, traducciones.subtitulo_ca, traducciones.contenido_ca,
          traducciones.titulo_gl, traducciones.subtitulo_gl, traducciones.contenido_gl,
          traducciones.titulo_en, traducciones.subtitulo_en, traducciones.contenido_en,
          fichaTecnica, bannerUrgenteFinal, id
        ).run();
        await registrarRedirectSiCambia(env, id, articuloParaPermiso.slug, slug);

        // Fase 12: igual que al crear, sincroniza la galería/imágenes
        // sueltas vinculadas a la noticia si el redactor mandó media_ids
        // y/o galeria_resultado_id; si no manda ninguno de los dos, deja
        // la que ya hubiera guardada tal cual.
        await sincronizarArticleMedia(env, id, body);

        // Horario de publicación: solo se evalúa cuando esta edición
        // publica por primera vez un borrador. Si ya estaba publicada, se
        // conserva la marca que tuviera (editar una errata otro día no
        // debe cambiarla).
        let fueraCalendario = !!articuloParaPermiso.fuera_calendario;
        if (!articuloParaPermiso.publicado && vaAPublicarseAhora) {
          fueraCalendario = await marcarFueraDeCalendario(env, id, { tipo: tipoFinal, resultado_id: resultadoId });
        }

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
                await env.DB.prepare("UPDATE alineaciones SET article_id = NULL, result_id = ?, updated_at = datetime('now') WHERE id = ?").bind(resultadoId, a.id).run();
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
          const tipoLabel = { noticia: "Noticia", previa: "Previa", cronica: "Crónica", analisis: "Análisis", opinion: "Opinión", entrevista: "Entrevista" }[body.tipo] || "Artículo";
          const firmaAutores = coautorNombre ? `${autorNombre} y ${coautorNombre}` : autorNombre;
          const textoPreferenciaFechas = formatearPreferenciaFechasEmail(preferenciaFechas);
          ctx.waitUntil(enviarEmailNotificacion(env, {
            asunto: `Borrador terminado: ${body.titulo}`,
            texto: `${payload.nombre} ha editado y marcado como terminado el borrador "${body.titulo}" (${tipoLabel}) en ELOTROFÚTBOLTV, firmado por ${firmaAutores}. Todavía no está publicado.${textoPreferenciaFechas ? ` Preferencia de fecha del redactor: ${textoPreferenciaFechas}.` : ""}`,
            html: plantillaEmail({
              etiqueta: "Borrador terminado",
              titulo: body.titulo,
              parrafo: body.subtitulo || null,
              filas: [
                { etiqueta: "Autor", valor: firmaAutores },
                { etiqueta: "Guardado por", valor: payload.nombre },
                { etiqueta: "Categoría", valor: clubArticuloLegible(clubFinal) || body.categoria },
                ...(textoPreferenciaFechas ? [{ etiqueta: "Preferencia de fecha", valor: textoPreferenciaFechas }] : []),
              ],
            }),
          }));
        }

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_articulo", entidad: "articulo", entidad_id: id,
          descripcion: `Ha editado la noticia/crónica "${body.titulo}"${estadoBorrador ? ` (${estadoBorrador === "terminado" ? "borrador terminado" : "borrador en proceso"})` : ""}${esEdicionAjenaPorNivel4 ? " (revisión de contenido ajeno, Nivel 4)" : ""}`,
        }));
        // Si el articulo estaba en borrador y se publica ahora, aviso push.
        // (typeof: por si esta variable no estuviera a la vista en este punto.)
        if (body.publicado !== false && !programadoPara && typeof articuloParaPermiso !== "undefined" && articuloParaPermiso && !articuloParaPermiso.publicado) {
          ctx.waitUntil(notificarPushArticulo(env, { titulo: body.titulo, subtitulo: body.subtitulo, slug, categoria: categoriaFinal, imagen_url: body.imagen_url }));
          // Aviso a los buscadores (IndexNow) en el mismo momento de publicar.
          ctx.waitUntil(notificarIndexNow(env, [urlNoticia(categoriaFinal, slug)]));
        }
        return json({ ok: true, slug, publicado: body.publicado === false ? 0 : 1, fuera_calendario: fueraCalendario, estado_borrador: estadoBorrador, programado_para: programadoPara, fecha_preferencia_desde: preferenciaFechas.desde, fecha_preferencia_hasta: preferenciaFechas.hasta, avisos_traduccion: avisosTraduccion });
      }

      if (articleMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede borrar noticias, crónicas ni artículos" }, 403);
        }
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
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no gestiona solicitudes de edición de contenido" }, 403);
        }
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
        // más RAM/CPU consume en D1: cada prepare().bind().first() es su
        // propio round-trip. Se sustituye por un puñado de consultas por
        // LOTES con "IN (...)", una única vez para todas las filas, y
        // luego se cruzan en memoria con Maps (barato, ya en el Worker).
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
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede solicitar edición de contenido editorial" }, 403);
        }
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

      // ---------- VOTACIONES INTERNAS DEL EQUIPO ----------
      // Un admin crea votaciones tipo test; admin, redactores y fotógrafos
      // votan desde la pestaña "Votaciones" del panel. Esquema y significado
      // de cada columna en worker/migracion_votaciones_internas.sql y
      // worker/migracion_votaciones_privadas.sql.
      //
      // PRIVACIDAD (dos modos, ver migracion_votaciones_privadas.sql):
      //   - NOMINAL (anonima = 0): el nombre de cada votante es visible para
      //     quien pueda ver los resultados. Se puede cambiar el voto.
      //     Los votos viven en votaciones_internas_votos (usuario -> opción).
      //   - SECRETA (anonima = 1): la papeleta se guarda en
      //     votaciones_internas_urna SIN usuario, SIN fecha y con un token
      //     aleatorio; quién ha participado se guarda aparte en
      //     votaciones_internas_participacion SIN opción. No existe ningún
      //     vínculo persona -> opción en la base de datos, ni siquiera para
      //     un admin. Consecuencias deliberadas: el voto secreto es
      //     DEFINITIVO (no se puede cambiar, porque no se puede localizar la
      //     papeleta) y los resultados solo se ven al cerrar (si no, el
      //     contador delataría a quien acaba de votar).

      const VOTINT_VISIBILIDADES = ["siempre", "tras_votar", "al_cerrar"];
      const VOTINT_MAX_OPCIONES = 10;

      // Cualquier colaborador (no lectores) puede votar; el JWT de los
      // lectores no pasa por aquí, pero se comprueba el rol igualmente.
      async function requireColaboradorVotaciones(request, env) {
        const payload = await requireAuthTienda(request, env);
        if (!payload) return { error: json({ error: "No autorizado" }, 401) };
        if (!ROLES_VALIDOS.includes(payload.rol)) return { error: json({ error: "No autorizado" }, 403) };
        return { payload };
      }

      // 'YYYY-MM-DD HH:MM:SS' (UTC, como datetime('now')) -> Date
      function votintFecha(texto) {
        if (!texto) return null;
        const d = new Date(String(texto).replace(" ", "T") + "Z");
        return isNaN(d.getTime()) ? null : d;
      }

      function votintEstaCerrada(v) {
        if (v.estado === "cerrada") return true;
        const limite = votintFecha(v.cierra_en);
        return !!(limite && limite.getTime() <= Date.now());
      }

      // Una votación secreta siempre enseña resultados solo al cerrar,
      // aunque en la fila antigua pusiera otra cosa.
      function votintVisibilidadEfectiva(v) {
        return v.anonima === 1 ? "al_cerrar" : v.resultados_visibles;
      }

      // Lista completa para el panel: cada votación con sus opciones, mi
      // voto y -solo si me toca verlos- los resultados y los nombres.
      if (path === "/api/votaciones" && method === "GET") {
        const auth = await requireColaboradorVotaciones(request, env);
        if (auth.error) return auth.error;
        const payload = auth.payload;

        const { results: votaciones } = await env.DB.prepare(
          `SELECT id, titulo, descripcion, multiple, anonima, obligatoria, resultados_visibles, cierra_en, estado,
                  creado_por, creado_por_nombre, created_at, cerrada_en
           FROM votaciones_internas ORDER BY (estado = 'abierta') DESC, obligatoria DESC, created_at DESC, id DESC`
        ).all();
        const { results: opciones } = await env.DB.prepare(
          `SELECT id, votacion_id, texto, orden FROM votaciones_internas_opciones ORDER BY orden ASC, id ASC`
        ).all();
        // Votos con nombre: solo se usan en votaciones NO anónimas (más
        // abajo se ignoran los de las anónimas aunque quedara alguno).
        const { results: votosNominales } = await env.DB.prepare(
          `SELECT v.votacion_id, v.opcion_id, v.usuario_id, u.nombre
           FROM votaciones_internas_votos v LEFT JOIN users u ON u.id = v.usuario_id`
        ).all();
        // Papeletas secretas: solo recuentos por opción, nunca quién.
        const { results: urna } = await env.DB.prepare(
          `SELECT votacion_id, opcion_id, COUNT(*) AS n FROM votaciones_internas_urna GROUP BY votacion_id, opcion_id`
        ).all();
        // Participación: cuántos han votado y si yo he votado (sin opción).
        const { results: participacion } = await env.DB.prepare(
          `SELECT votacion_id, COUNT(*) AS n, SUM(CASE WHEN usuario_id = ? THEN 1 ELSE 0 END) AS yo
           FROM votaciones_internas_participacion GROUP BY votacion_id`
        ).bind(payload.uid).all();
        const fila = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM users WHERE activo = 1 AND rol IN ('admin','redactor','fotografo')`
        ).first();
        const equipoTotal = Number(fila && fila.n) || 0;

        const esAdminPeticion = payload.rol === "admin";
        const salida = votaciones.map((v) => {
          const cerrada = votintEstaCerrada(v);
          const secreta = v.anonima === 1;
          const visibilidad = votintVisibilidadEfectiva(v);
          const susOpciones = opciones.filter((o) => o.votacion_id === v.id);
          const part = participacion.find((p) => p.votacion_id === v.id);
          const totalVotantes = part ? Number(part.n) || 0 : 0;

          // Solo en votaciones nominales existe "mi voto" guardado.
          const susVotos = secreta ? [] : votosNominales.filter((x) => x.votacion_id === v.id);
          const misOpciones = susVotos.filter((x) => x.usuario_id === payload.uid).map((x) => x.opcion_id);
          const heVotado = (part && Number(part.yo) > 0) || misOpciones.length > 0;

          // Quién ve los resultados: el admin, salvo en "al_cerrar" (la
          // urna se abre para todos a la vez); el resto según la
          // visibilidad elegida al crear la votación.
          const verResultados = (esAdminPeticion && visibilidad !== "al_cerrar")
            || visibilidad === "siempre"
            || (visibilidad === "tras_votar" && (heVotado || cerrada))
            || (visibilidad === "al_cerrar" && cerrada);

          return {
            id: v.id,
            titulo: v.titulo,
            descripcion: v.descripcion,
            multiple: v.multiple === 1,
            anonima: secreta,
            // Obligatoria: mientras esté abierta y yo no haya votado, el
            // panel me muestra una pantalla que bloquea todo lo demás.
            obligatoria: v.obligatoria === 1,
            privacidad: secreta ? "secreta" : "nominal",
            voto_modificable: !secreta,
            resultados_visibles: visibilidad,
            cierra_en: v.cierra_en ? votintFecha(v.cierra_en).toISOString() : null,
            cerrada,
            cerrada_a_mano: v.estado === "cerrada",
            creado_por_nombre: v.creado_por_nombre,
            created_at: v.created_at,
            he_votado: heVotado,
            mis_opciones: misOpciones,
            ver_resultados: verResultados,
            // Cuánta gente ha participado se muestra siempre: no revela
            // qué se ha votado ni quién ha votado qué.
            total_votantes: totalVotantes,
            equipo_total: equipoTotal,
            opciones: susOpciones.map((o) => {
              let votosOpcion = null;
              if (verResultados) {
                votosOpcion = secreta
                  ? Number((urna.find((u) => u.votacion_id === v.id && u.opcion_id === o.id) || {}).n) || 0
                  : susVotos.filter((x) => x.opcion_id === o.id).length;
              }
              return {
                id: o.id,
                texto: o.texto,
                votos: votosOpcion,
                // Los nombres solo en votaciones nominales, y solo a
                // quien ya puede ver los resultados.
                votantes: verResultados && !secreta
                  ? susVotos.filter((x) => x.opcion_id === o.id).map((x) => x.nombre).filter(Boolean)
                  : null,
              };
            }),
          };
        });
        return json({ votaciones: salida, puede_crear: esAdminPeticion });
      }

      // Crear una votación (solo admin).
      if (path === "/api/votaciones" && method === "POST") {
        const auth = await requireColaboradorVotaciones(request, env);
        if (auth.error) return auth.error;
        const payload = auth.payload;
        if (!esAdmin(payload)) return json({ error: "Solo un administrador puede crear votaciones" }, 403);

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") return json({ error: "Petición no válida" }, 400);
        const titulo = normalizarTexto(body.titulo);
        if (!titulo) return json({ error: "Falta la pregunta de la votación" }, 400);
        if (titulo.length > 200) return json({ error: "La pregunta es demasiado larga (máximo 200 caracteres)" }, 400);
        const descripcion = normalizarTexto(body.descripcion);
        if (descripcion && descripcion.length > 1000) return json({ error: "La descripción es demasiado larga (máximo 1000 caracteres)" }, 400);

        const textos = (Array.isArray(body.opciones) ? body.opciones : [])
          .map((t) => normalizarTexto(t))
          .filter(Boolean);
        if (new Set(textos.map((t) => t.toLowerCase())).size !== textos.length) {
          return json({ error: "Hay opciones repetidas" }, 400);
        }
        if (textos.length < 2) return json({ error: "Hace falta al menos 2 opciones" }, 400);
        if (textos.length > VOTINT_MAX_OPCIONES) return json({ error: `Máximo ${VOTINT_MAX_OPCIONES} opciones` }, 400);
        if (textos.some((t) => t.length > 150)) return json({ error: "Alguna opción es demasiado larga (máximo 150 caracteres)" }, 400);

        const secreta = body.anonima ? 1 : 0;
        // Voto secreto => resultados solo al cerrar (ver cabecera del bloque).
        const visibilidad = secreta
          ? "al_cerrar"
          : (VOTINT_VISIBILIDADES.includes(body.resultados_visibles) ? body.resultados_visibles : "tras_votar");
        let cierraEn = null;
        if (body.cierra_en) {
          const d = new Date(body.cierra_en);
          if (isNaN(d.getTime())) return json({ error: "La fecha de cierre no es válida" }, 400);
          if (d.getTime() <= Date.now()) return json({ error: "La fecha de cierre tiene que ser futura" }, 400);
          cierraEn = d.toISOString().slice(0, 19).replace("T", " ");
        }

        const { meta } = await env.DB.prepare(
          `INSERT INTO votaciones_internas
             (titulo, descripcion, multiple, anonima, obligatoria, resultados_visibles, cierra_en, creado_por, creado_por_nombre)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(titulo, descripcion, body.multiple ? 1 : 0, secreta, body.obligatoria ? 1 : 0, visibilidad, cierraEn, payload.uid, payload.nombre || null).run();
        const votacionId = meta.last_row_id;
        await env.DB.batch(textos.map((texto, i) =>
          env.DB.prepare("INSERT INTO votaciones_internas_opciones (votacion_id, texto, orden) VALUES (?, ?, ?)")
            .bind(votacionId, texto, i)
        ));

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_votacion_interna", entidad: "votacion_interna", entidad_id: votacionId,
          descripcion: `${payload.nombre} ha creado la votación interna ${body.obligatoria ? "obligatoria " : ""}"${titulo}"`,
        }));
        return json({ ok: true, id: votacionId });
      }

      // Votar (o cambiar el voto mientras siga abierta, solo en nominales).
      if (path.match(/^\/api\/votaciones\/\d+\/votar$/) && method === "POST") {
        const auth = await requireColaboradorVotaciones(request, env);
        if (auth.error) return auth.error;
        const payload = auth.payload;
        const votacionId = parseInt(path.split("/")[3], 10);
        const v = await env.DB.prepare("SELECT * FROM votaciones_internas WHERE id = ?").bind(votacionId).first();
        if (!v) return json({ error: "Votación no encontrada" }, 404);
        if (votintEstaCerrada(v)) return json({ error: "Esta votación ya está cerrada" }, 409);

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") return json({ error: "Petición no válida" }, 400);
        const elegidas = [...new Set((Array.isArray(body.opciones) ? body.opciones : []).map((n) => parseInt(n, 10)).filter(Boolean))];
        if (elegidas.length === 0) return json({ error: "Elige al menos una opción" }, 400);
        if (v.multiple !== 1 && elegidas.length > 1) return json({ error: "En esta votación solo se puede elegir una opción" }, 400);

        const { results: validas } = await env.DB.prepare(
          "SELECT id FROM votaciones_internas_opciones WHERE votacion_id = ?"
        ).bind(votacionId).all();
        const idsValidos = new Set(validas.map((o) => o.id));
        if (!elegidas.every((id) => idsValidos.has(id))) return json({ error: "Opción no válida" }, 400);

        if (v.anonima === 1) {
          // VOTO SECRETO: definitivo. Se anota la participación (sin
          // opción) y las papeletas (sin usuario) en la MISMA transacción,
          // y no se guarda ningún dato que las una. Si la persona ya había
          // participado, la clave primaria de participación hace fallar el
          // lote entero y no se cuela ninguna papeleta de más.
          const yaVoto = await env.DB.prepare(
            "SELECT 1 AS x FROM votaciones_internas_participacion WHERE votacion_id = ? AND usuario_id = ?"
          ).bind(votacionId, payload.uid).first();
          if (yaVoto) return json({ error: "Ya has votado. En una votación secreta el voto no se puede cambiar." }, 409);
          try {
            await env.DB.batch([
              env.DB.prepare("INSERT INTO votaciones_internas_participacion (votacion_id, usuario_id) VALUES (?, ?)")
                .bind(votacionId, payload.uid),
              ...elegidas.map((opcionId) =>
                env.DB.prepare("INSERT INTO votaciones_internas_urna (token, votacion_id, opcion_id) VALUES (?, ?, ?)")
                  .bind(crypto.randomUUID(), votacionId, opcionId)),
            ]);
          } catch (err) {
            return json({ error: "Ya has votado. En una votación secreta el voto no se puede cambiar." }, 409);
          }
          // Solo consta que ha participado: ni la opción, ni la IP.
          ctx.waitUntil(registrarActividad(env, null, payload, {
            accion: "votar_votacion_interna", entidad: "votacion_interna", entidad_id: votacionId,
            descripcion: `${payload.nombre} ha participado en la votación secreta "${v.titulo}"`,
          }));
          return json({ ok: true, definitivo: true });
        }

        // VOTO NOMINAL: se puede cambiar mientras siga abierta.
        await env.DB.batch([
          env.DB.prepare("DELETE FROM votaciones_internas_votos WHERE votacion_id = ? AND usuario_id = ?").bind(votacionId, payload.uid),
          ...elegidas.map((opcionId) =>
            env.DB.prepare("INSERT INTO votaciones_internas_votos (votacion_id, opcion_id, usuario_id) VALUES (?, ?, ?)")
              .bind(votacionId, opcionId, payload.uid)),
          env.DB.prepare("INSERT OR IGNORE INTO votaciones_internas_participacion (votacion_id, usuario_id) VALUES (?, ?)")
            .bind(votacionId, payload.uid),
        ]);
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "votar_votacion_interna", entidad: "votacion_interna", entidad_id: votacionId,
          descripcion: `${payload.nombre} ha votado en "${v.titulo}"`,
        }));
        return json({ ok: true, definitivo: false });
      }

      // Cerrar / reabrir a mano (solo admin). Reabrir limpia el cierre
      // manual; si además hay fecha límite ya pasada, seguirá cerrada.
      if (path.match(/^\/api\/votaciones\/\d+\/(cerrar|reabrir)$/) && method === "POST") {
        const auth = await requireColaboradorVotaciones(request, env);
        if (auth.error) return auth.error;
        const payload = auth.payload;
        if (!esAdmin(payload)) return json({ error: "Solo un administrador puede cerrar o reabrir votaciones" }, 403);
        const partes = path.split("/");
        const votacionId = parseInt(partes[3], 10);
        const cerrar = partes[4] === "cerrar";
        const resultado = await env.DB.prepare(
          cerrar
            ? "UPDATE votaciones_internas SET estado = 'cerrada', cerrada_en = datetime('now') WHERE id = ?"
            : "UPDATE votaciones_internas SET estado = 'abierta', cerrada_en = NULL WHERE id = ?"
        ).bind(votacionId).run();
        if (!resultado.meta.changes) return json({ error: "Votación no encontrada" }, 404);
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: cerrar ? "cerrar_votacion_interna" : "reabrir_votacion_interna", entidad: "votacion_interna", entidad_id: votacionId,
          descripcion: `${payload.nombre} ha ${cerrar ? "cerrado" : "reabierto"} la votación interna #${votacionId}`,
        }));
        return json({ ok: true });
      }

      // Borrar una votación con sus opciones, votos y urna (solo admin).
      if (path.match(/^\/api\/votaciones\/\d+$/) && method === "DELETE") {
        const auth = await requireColaboradorVotaciones(request, env);
        if (auth.error) return auth.error;
        const payload = auth.payload;
        if (!esAdmin(payload)) return json({ error: "Solo un administrador puede borrar votaciones" }, 403);
        const votacionId = parseInt(path.split("/").pop(), 10);
        const v = await env.DB.prepare("SELECT titulo FROM votaciones_internas WHERE id = ?").bind(votacionId).first();
        if (!v) return json({ error: "Votación no encontrada" }, 404);
        // No se confía en ON DELETE CASCADE: D1 solo lo aplica con
        // foreign_keys activado, así que se borra en orden explícito.
        await env.DB.batch([
          env.DB.prepare("DELETE FROM votaciones_internas_urna WHERE votacion_id = ?").bind(votacionId),
          env.DB.prepare("DELETE FROM votaciones_internas_participacion WHERE votacion_id = ?").bind(votacionId),
          env.DB.prepare("DELETE FROM votaciones_internas_votos WHERE votacion_id = ?").bind(votacionId),
          env.DB.prepare("DELETE FROM votaciones_internas_opciones WHERE votacion_id = ?").bind(votacionId),
          env.DB.prepare("DELETE FROM votaciones_internas WHERE id = ?").bind(votacionId),
        ]);
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "borrar_votacion_interna", entidad: "votacion_interna", entidad_id: votacionId,
          descripcion: `${payload.nombre} ha borrado la votación interna "${v.titulo}"`,
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

      // Datos de un producto tal como los consume el panel: variantes e
      // imágenes extra ya parseadas y las unidades que quedan. "stock" es
      // el total de unidades (NULL = sin límite) y "disponibles" = stock
      // menos las unidades ya pedidas sin cancelar. Se calcula sobre los
      // pedidos en vez de descontar a mano del stock: así cancelar o
      // borrar un pedido devuelve la unidad sin tocar nada más.
      const SQL_UNIDADES_PEDIDAS = `(SELECT COUNT(*) FROM tienda_pedidos tp WHERE tp.producto_id = p.id AND tp.estado != 'cancelado')`;
      function parsearListaJsonTienda(texto) {
        try {
          const v = JSON.parse(texto);
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      }
      function prepararProductoTienda(p, { gestion = false } = {}) {
        const stock = p.stock === null || p.stock === undefined ? null : Number(p.stock);
        const pedidas = Number(p.pedidas) || 0;
        const salida = {
          ...p,
          variantes: p.variantes ? parsearListaJsonTienda(p.variantes) : [],
          imagenes: p.imagenes ? parsearListaJsonTienda(p.imagenes) : [],
          stock,
          pedidas,
          disponibles: stock === null ? null : Math.max(0, stock - pedidas),
        };
        if (!gestion) {
          delete salida.stock;
          delete salida.pedidas;
        }
        return salida;
      }

      // Catálogo de productos activos, visible para cualquier persona
      // logueada en el panel (no hace falta ser admin para ver la tienda).
      if (path === "/api/tienda/productos" && method === "GET") {
        const payload = await requireAuthTienda(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        const { results: productos } = await env.DB.prepare(
          `SELECT p.id, p.nombre, p.descripcion, p.precio_centimos, p.imagen_url, p.imagenes, p.variantes, p.stock,
                  ${SQL_UNIDADES_PEDIDAS} AS pedidas
           FROM tienda_productos p WHERE p.activo = 1 ORDER BY p.orden ASC, p.id ASC`
        ).all();
        return json({ productos: productos.map((p) => prepararProductoTienda(p)) });
      }

      // ---------- Gestión del catálogo (crear/editar/activar productos) ----------
      // Todo lo de aquí abajo solo para quien puede gestionar la tienda
      // (admin o redactor con el permiso concedido).

      // Listado completo, incluidos los productos desactivados, para la
      // subtab "Productos" del panel de gestión.
      if (path === "/api/tienda/productos/todos" && method === "GET") {
        const payload = await requireAuthTienda(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!(await puedeGestionarTienda(env, payload))) {
          return json({ error: "No tienes permiso para gestionar la tienda" }, 403);
        }
        const { results: productos } = await env.DB.prepare(
          `SELECT p.id, p.nombre, p.descripcion, p.precio_centimos, p.imagen_url, p.imagenes, p.variantes, p.stock,
                  p.activo, p.orden, ${SQL_UNIDADES_PEDIDAS} AS pedidas
           FROM tienda_productos p ORDER BY p.orden ASC, p.id ASC`
        ).all();
        return json({ productos: productos.map((p) => prepararProductoTienda(p, { gestion: true })) });
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
        // Stock total: vacío/null = sin límite. Si se indica, entero >= 0.
        let stock = null;
        if (body.stock !== undefined && body.stock !== null && String(body.stock).trim() !== "") {
          const s = Number(body.stock);
          if (!Number.isInteger(s) || s < 0) {
            throw new Error("El stock debe ser un número entero de 0 o más (déjalo vacío para no limitarlo)");
          }
          stock = s;
        }
        // Imágenes adicionales (galería de la ficha), máximo 8, solo
        // URLs http(s); la imagen principal sigue siendo imagen_url.
        let imagenes = [];
        if (Array.isArray(body.imagenes)) {
          imagenes = body.imagenes
            .map((u) => (typeof u === "string" ? u.trim() : ""))
            .filter((u) => /^https?:\/\//i.test(u))
            .slice(0, 8);
        }
        return {
          nombre,
          descripcion: normalizarTexto(body.descripcion),
          precio_centimos: precio,
          imagen_url: normalizarTexto(body.imagen_url),
          imagenes: JSON.stringify(imagenes),
          stock,
          variantes: JSON.stringify(variantes),
          orden: Number.isInteger(Number(body.orden)) ? Number(body.orden) : 0,
        };
      }

      // Crea un producto nuevo en el catálogo.
      if (path === "/api/tienda/productos" && method === "POST") {
        const payload = await requireAuthTienda(request, env);
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
          `INSERT INTO tienda_productos (nombre, descripcion, precio_centimos, imagen_url, imagenes, stock, variantes, orden)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(campos.nombre, campos.descripcion, campos.precio_centimos, campos.imagen_url, campos.imagenes, campos.stock, campos.variantes, campos.orden).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_producto_tienda", entidad: "producto_tienda", entidad_id: meta.last_row_id,
          descripcion: `${payload.nombre} ha creado el producto "${campos.nombre}" en la tienda`,
        }));

        return json({ ok: true, id: meta.last_row_id });
      }

      // Borra un producto del catálogo. Si ya tiene pedidos (aunque estén
      // cancelados) NO se borra: tienda_pedidos.producto_id apunta a esta
      // tabla y se perdería el historial. En ese caso se pide ocultarlo.
      if (path.match(/^\/api\/tienda\/productos\/\d+$/) && method === "DELETE") {
        const payload = await requireAuthTienda(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!(await puedeGestionarTienda(env, payload))) {
          return json({ error: "No tienes permiso para gestionar la tienda" }, 403);
        }
        const productoId = parseInt(path.split("/").pop(), 10);
        const producto = await env.DB.prepare(
          "SELECT id, nombre FROM tienda_productos WHERE id = ?"
        ).bind(productoId).first();
        if (!producto) return json({ error: "Producto no encontrado" }, 404);
        const pedidos = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM tienda_pedidos WHERE producto_id = ?"
        ).bind(productoId).first();
        if (pedidos && Number(pedidos.n) > 0) {
          return json({ error: `Este producto tiene ${pedidos.n} pedido(s) y no se puede borrar sin perder el historial. Ocúltalo en su lugar.` }, 409);
        }
        await env.DB.prepare("DELETE FROM tienda_productos WHERE id = ?").bind(productoId).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "borrar_producto_tienda", entidad: "producto_tienda", entidad_id: productoId,
          descripcion: `${payload.nombre} ha borrado el producto "${producto.nombre}" de la tienda`,
        }));
        return json({ ok: true });
      }

      // Duplica un producto: crea una copia oculta con "(copia)" en el nombre.
      if (path.match(/^\/api\/tienda\/productos\/\d+\/duplicar$/) && method === "POST") {
        const payload = await requireAuthTienda(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!(await puedeGestionarTienda(env, payload))) {
          return json({ error: "No tienes permiso para gestionar la tienda" }, 403);
        }
        const productoId = parseInt(path.split("/")[4], 10);
        const orig = await env.DB.prepare(
          "SELECT nombre, descripcion, precio_centimos, imagen_url, imagenes, stock, variantes, orden FROM tienda_productos WHERE id = ?"
        ).bind(productoId).first();
        if (!orig) return json({ error: "Producto no encontrado" }, 404);
        const nombreCopia = `${orig.nombre} (copia)`;
        const { meta } = await env.DB.prepare(
          `INSERT INTO tienda_productos (nombre, descripcion, precio_centimos, imagen_url, imagenes, stock, variantes, orden, activo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
        ).bind(nombreCopia, orig.descripcion, orig.precio_centimos, orig.imagen_url, orig.imagenes, orig.stock, orig.variantes, orig.orden).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_producto_tienda", entidad: "producto_tienda", entidad_id: meta.last_row_id,
          descripcion: `${payload.nombre} ha duplicado el producto "${orig.nombre}" en la tienda`,
        }));
        return json({ ok: true, id: meta.last_row_id });
      }

      // Edita un producto existente (datos, o solo activo/inactivo si el
      // body trae únicamente ese campo).
      if (path.match(/^\/api\/tienda\/productos\/\d+$/) && method === "PUT") {
        const payload = await requireAuthTienda(request, env);
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
           SET nombre = ?, descripcion = ?, precio_centimos = ?, imagen_url = ?, imagenes = ?, stock = ?, variantes = ?, orden = ?,
               activo = ${activo === undefined ? "activo" : "?"}
           WHERE id = ?`
        ).bind(...(activo === undefined
          ? [campos.nombre, campos.descripcion, campos.precio_centimos, campos.imagen_url, campos.imagenes, campos.stock, campos.variantes, campos.orden, productoId]
          : [campos.nombre, campos.descripcion, campos.precio_centimos, campos.imagen_url, campos.imagenes, campos.stock, campos.variantes, campos.orden, activo, productoId]
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
        const payload = await requireAuthTienda(request, env);
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

        // Cantidad: cada unidad es una fila de tienda_pedidos (ver
        // migracion_tienda.sql), así que pedir 3 crea 3 pedidos que se
        // gestionan por separado. Máximo 10 por pedido para evitar
        // errores de dedo.
        const cantidad = body.cantidad === undefined || body.cantidad === null ? 1 : Number(body.cantidad);
        if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 10) {
          return json({ error: "La cantidad debe ser un número entre 1 y 10" }, 400);
        }

        // Stock: si el producto lo limita, se comprueba contra las
        // unidades ya pedidas (sin contar las canceladas).
        if (producto.stock !== null && producto.stock !== undefined) {
          const fila = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM tienda_pedidos WHERE producto_id = ? AND estado != 'cancelado'"
          ).bind(producto.id).first();
          const quedan = Math.max(0, Number(producto.stock) - (Number(fila?.n) || 0));
          if (quedan <= 0) return json({ error: "Este producto está agotado" }, 409);
          if (cantidad > quedan) {
            return json({ error: `Solo quedan ${quedan} unidad${quedan === 1 ? "" : "es"} de este producto` }, 409);
          }
        }

        const pedidosIds = [];
        for (let i = 0; i < cantidad; i++) {
          const { meta } = await env.DB.prepare(
            `INSERT INTO tienda_pedidos
               (usuario_id, producto_id, producto_nombre, variante, precio_centimos, referencia_pago)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(payload.uid, producto.id, producto.nombre, variantesDisponibles.length ? variante : null,
                 producto.precio_centimos, referenciaPago).run();
          pedidosIds.push(meta.last_row_id);
        }

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_pedido_tienda", entidad: "pedido_tienda", entidad_id: pedidosIds[0],
          descripcion: `${payload.nombre} ha pedido ${cantidad > 1 ? cantidad + " x " : ""}"${producto.nombre}"${variante ? " (" + variante + ")" : ""} en la tienda`,
        }));

        return json({ ok: true, pedido_id: pedidosIds[0], pedidos_ids: pedidosIds, cantidad });
      }

      // Pedidos del propio redactor (para ver en qué estado está lo que
      // ha pedido: pendiente de pago, pagado, enviado...).
      if (path === "/api/tienda/mis-pedidos" && method === "GET") {
        const payload = await requireAuthTienda(request, env);
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
        const payload = await requireAuthTienda(request, env);
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
        const payload = await requireAuthTienda(request, env);
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
        const payload = await requireAuthTienda(request, env);
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
        const payload = await requireAuthTienda(request, env);
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
        const payload = await requireAuthTienda(request, env);
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
        // Si es una previa/crónica fusionada con otras del mismo partido,
        // se leen los comentarios de todas juntas.
        const idsComentarios = await idsGrupoFusion(env, articleId);
        const { results: comentarios } = await env.DB.prepare(
          `SELECT id, nombre, texto, created_at, likes, dislikes, reader_id
           FROM comments
           WHERE article_id IN (${idsComentarios.map(() => "?").join(",")}) AND estado = 'aprobado' AND oculto_por_denuncia = 0
           ORDER BY created_at ASC`
        ).bind(...idsComentarios).all();
        return json({ comentarios });
      }

      if (comentariosArticuloMatch && method === "POST") {
        const articleId = parseInt(comentariosArticuloMatch[1]);
        const articulo = await env.DB.prepare("SELECT id FROM articles WHERE id = ? AND publicado = 1").bind(articleId).first();
        if (!articulo) return json({ error: "Noticia no encontrada" }, 404);

        if (await limiteExcedido(request, env, "comentario", 10, 600)) {
          return json({ error: "Estás comentando demasiado rápido. Espera unos minutos." }, 429);
        }
        const body = await request.json().catch(() => ({}));

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
        if (nombre.length > 80) return json({ error: "El nombre es demasiado largo (máximo 80 caracteres)" }, 400);
        if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "El email no es válido" }, 400);
        if (!texto) return json({ error: "El comentario no puede estar vacío" }, 400);
        if (texto.length > 2000) return json({ error: "El comentario es demasiado largo (máximo 2000 caracteres)" }, 400);

        const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || null;
        await env.DB.prepare(
          `INSERT INTO comments (article_id, nombre, email, texto, ip, reader_id) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(articleId, nombre, email, texto, ip, readerId).run();

        return json({ ok: true, mensaje: "Comentario enviado. Se publicará en cuanto lo revise la redacción." });
      }

      // ---------- Encuestas ----------
      // Votar es libre: cualquier lector puede votar SIN cuenta y SIN
      // iniciar sesión. Para no contar dos veces a la misma persona se usa
      // un hash no reversible de IP + User-Agent (+ id de encuesta + secreto
      // del servidor), igual que ya se hace en analíticas (ver
      // hashVisitante): no se guarda ni la IP ni nada que identifique a
      // nadie, y no hace falta ninguna cookie ni localStorage. Una
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

      // Arma el objeto de encuesta con recuento de votos por opción y qué
      // opción votó quien consulta (mi_voto, o null si no ha votado). A
      // quien consulta se le reconoce por el hash anónimo de IP +
      // User-Agent (ver hashVotanteEncuesta) y, solo si además trae una
      // sesión de lector válida (readerId), por un voto antiguo de cuando
      // votar exigía cuenta. Los recuentos siempre se devuelven.
      async function obtenerEncuestaConResultados(env, poll, request, readerId) {
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
        const voterHash = await hashVotanteEncuesta(request, env, poll.id);
        if (voterHash) {
          const voto = await env.DB.prepare(
            "SELECT option_id FROM poll_votes WHERE poll_id = ? AND voter_hash = ?"
          ).bind(poll.id, voterHash).first();
          if (voto) miVoto = voto.option_id;
        }
        if (miVoto === null && readerId) {
          const votoAntiguo = await env.DB.prepare(
            "SELECT option_id FROM poll_votes WHERE poll_id = ? AND reader_id = ?"
          ).bind(poll.id, readerId).first();
          if (votoAntiguo) miVoto = votoAntiguo.option_id;
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

      // Hash no reversible que identifica a quien vota SOLO dentro de una
      // encuesta: IP + User-Agent + id de la encuesta + secreto del
      // servidor. Lleva el id de la encuesta a propósito para que no se
      // pueda enlazar a la misma persona entre encuestas distintas. NO
      // lleva el día (a diferencia de hashVisitante): un voto debe contar
      // una sola vez por encuesta, no una vez al día. Devuelve null si no
      // se puede determinar la IP: mejor rechazar el voto que juntar a
      // todo el mundo bajo la misma IP "vacía" y falsear los resultados.
      async function hashVotanteEncuesta(request, env, pollId) {
        const ip =
          request.headers.get("CF-Connecting-IP") ||
          (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
          request.headers.get("X-Real-IP") ||
          "";
        if (!ip) return null;
        const ua = request.headers.get("User-Agent") || "";
        return sha1Hex(`encuesta|${pollId}|${ip}|${ua}|${env.JWT_SECRET || ""}`);
      }

      // Id del lector si la petición trae una sesión de lector válida y
      // cuenta activa; null en cualquier otro caso. NO se exige: votar ya
      // no requiere cuenta. Solo sirve para reconocer votos hechos cuando
      // sí se exigía (filas con reader_id), y que quien votó entonces no
      // pueda volver a votar y contar doble ni vea el formulario otra vez.
      async function lectorOpcionalEncuestas(request, env) {
        try {
          const payloadLector = await requireReaderAuth(request, env);
          if (!payloadLector) return null;
          const lector = await env.DB.prepare(
            "SELECT id FROM readers WHERE id = ? AND activo = 1"
          ).bind(payloadLector.rid).first();
          return lector ? lector.id : null;
        } catch {
          return null;
        }
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

        const readerId = await lectorOpcionalEncuestas(request, env);
        const conResultados = await Promise.all(
          encuestas.map((p) => obtenerEncuestaConResultados(env, p, request, readerId))
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

        const readerId = await lectorOpcionalEncuestas(request, env);
        const conResultados = await obtenerEncuestaConResultados(env, poll, request, readerId);
        return json({ encuesta: conResultados });
      }

      // Público: votar. Libre, sin cuenta ni sesión. Un solo voto por
      // persona y encuesta (identificada por hashVotanteEncuesta): si ya
      // había votado, esto cambia su voto a la nueva opción en vez de
      // sumar uno nuevo.
      const votoEncuestaMatch = path.match(/^\/api\/polls\/(\d+)\/vote$/);
      if (votoEncuestaMatch && method === "POST") {
        const pollId = parseInt(votoEncuestaMatch[1]);

        const poll = await env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(pollId).first();
        if (!poll) return json({ error: "Encuesta no encontrada" }, 404);
        if (poll.estado !== "abierta" || (poll.cierra_en && poll.cierra_en <= new Date().toISOString().slice(0, 19).replace("T", " "))) {
          if (poll.estado === "abierta") {
            await env.DB.prepare("UPDATE polls SET estado = 'cerrada', updated_at = datetime('now') WHERE id = ?").bind(poll.id).run();
          }
          return json({ error: "Esta encuesta ya está cerrada" }, 409);
        }

        const body = await request.json().catch(() => ({}));
        const optionId = parseInt(body.option_id);
        if (!optionId) return json({ error: "Falta la opción elegida" }, 400);
        const opcion = await env.DB.prepare(
          "SELECT id FROM poll_options WHERE id = ? AND poll_id = ?"
        ).bind(optionId, pollId).first();
        if (!opcion) return json({ error: "Opción no válida para esta encuesta" }, 400);

        const voterHash = await hashVotanteEncuesta(request, env, pollId);
        if (!voterHash) {
          return json({ error: "No se ha podido registrar tu voto en este momento. Inténtalo de nuevo más tarde." }, 503);
        }

        // Voto antiguo, de cuando votar exigía cuenta: si quien vota trae
        // una sesión de lector y ya tenía un voto así en esta encuesta, se
        // actualiza ESE voto (no se crea otro, o contaría doble).
        const readerId = await lectorOpcionalEncuestas(request, env);
        const votoAntiguo = readerId
          ? await env.DB.prepare(
              "SELECT id FROM poll_votes WHERE poll_id = ? AND reader_id = ?"
            ).bind(pollId, readerId).first()
          : null;

        if (votoAntiguo) {
          await env.DB.prepare(
            "UPDATE poll_votes SET option_id = ?, created_at = datetime('now') WHERE id = ?"
          ).bind(optionId, votoAntiguo.id).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO poll_votes (poll_id, option_id, voter_hash) VALUES (?, ?, ?)
             ON CONFLICT(poll_id, voter_hash) DO UPDATE SET option_id = excluded.option_id, created_at = datetime('now')`
          ).bind(pollId, optionId, voterHash).run();
        }

        const conResultados = await obtenerEncuestaConResultados(env, poll, request, readerId);
        return json({ ok: true, encuesta: conResultados });
      }

      // ---------- Noticias rápidas (foto + titular + subtitular) ----------
      // Público: últimas noticias rápidas, de más nueva a más antigua.
      if (path === "/api/noticias-rapidas" && method === "GET") {
        const limite = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 50);
        const consultaNr = (conFoco) => `SELECT nr.id, nr.titulo, nr.subtitulo, nr.imagen_url, nr.imagen_foco, nr.created_at,
                  u.nombre AS autor_nombre, u.avatar_url AS autor_avatar_url${conFoco ? ", u.avatar_foco AS autor_avatar_foco" : ""}
           FROM noticias_rapidas nr
           LEFT JOIN users u ON u.id = nr.autor_id
           ORDER BY nr.created_at DESC, nr.id DESC
           LIMIT ?`;
        const { results } = await consultaConAlternativas(env, [consultaNr(true), consultaNr(false)], [limite]);
        return json({
          noticias_rapidas: results.map((n) => ({
            ...n,
            imagen_foco: normalizarFoco(n.imagen_foco),
            autor_avatar_foco: normalizarFocoOpcional(n.autor_avatar_foco),
          })),
        });
      }

      // Panel: listado completo (cualquier redactor/admin ve todas, pero
      // solo puede editar/borrar las suyas; el admin, todas).
      if (path === "/api/admin/noticias-rapidas" && method === "GET") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede gestionar noticias rápidas" }, 403);
        }
        const consultaNrPanel = (conFoco) => `SELECT nr.*, u.nombre AS autor_nombre, u.avatar_url AS autor_avatar_url${conFoco ? ", u.avatar_foco AS autor_avatar_foco" : ""}
           FROM noticias_rapidas nr
           LEFT JOIN users u ON u.id = nr.autor_id
           ORDER BY nr.created_at DESC, nr.id DESC
           LIMIT 200`;
        const { results } = await consultaConAlternativas(env, [consultaNrPanel(true), consultaNrPanel(false)], []);
        return json({ noticias_rapidas: results });
      }

      if (path === "/api/admin/noticias-rapidas" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede crear noticias rápidas" }, 403);
        }
        const v = validarNoticiaRapida(await request.json());
        if (v.error) return json({ error: v.error }, 400);

        const { meta } = await env.DB.prepare(
          "INSERT INTO noticias_rapidas (titulo, subtitulo, imagen_url, imagen_foco, autor_id) VALUES (?, ?, ?, ?, ?)"
        ).bind(v.titulo, v.subtitulo, v.imagenUrl, v.imagenFoco, payload.uid).run();
        const nuevoId = meta.last_row_id;

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_noticia_rapida", entidad: "noticia_rapida", entidad_id: nuevoId,
          descripcion: `Ha publicado la noticia rápida "${v.titulo}"`,
        }));
        const creada = await env.DB.prepare("SELECT * FROM noticias_rapidas WHERE id = ?").bind(nuevoId).first();
        return json({ ok: true, noticia_rapida: creada });
      }

      const noticiaRapidaMatch = path.match(/^\/api\/admin\/noticias-rapidas\/(\d+)$/);
      if (noticiaRapidaMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede editar noticias rápidas" }, 403);
        }
        const id = parseInt(noticiaRapidaMatch[1], 10);
        const actual = await env.DB.prepare("SELECT * FROM noticias_rapidas WHERE id = ?").bind(id).first();
        if (!actual) return json({ error: "Noticia rápida no encontrada" }, 404);
        if (!(await puedeEditarEntidad(env, payload, "noticia_rapida", actual.autor_id))) {
          return json({ error: "Solo puedes editar tus propias noticias rápidas" }, 403);
        }
        const v = validarNoticiaRapida(await request.json());
        if (v.error) return json({ error: v.error }, 400);

        await env.DB.prepare(
          "UPDATE noticias_rapidas SET titulo = ?, subtitulo = ?, imagen_url = ?, imagen_foco = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(v.titulo, v.subtitulo, v.imagenUrl, v.imagenFoco, id).run();

        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "editar_noticia_rapida", entidad: "noticia_rapida", entidad_id: id,
          descripcion: `Ha editado la noticia rápida "${v.titulo}"`,
        }));
        const editada = await env.DB.prepare("SELECT * FROM noticias_rapidas WHERE id = ?").bind(id).first();
        return json({ ok: true, noticia_rapida: editada });
      }

      if (noticiaRapidaMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede borrar noticias rápidas" }, 403);
        }
        const id = parseInt(noticiaRapidaMatch[1], 10);
        const actual = await env.DB.prepare("SELECT * FROM noticias_rapidas WHERE id = ?").bind(id).first();
        if (!actual) return json({ error: "Noticia rápida no encontrada" }, 404);
        if (!(await puedeEditarEntidad(env, payload, "noticia_rapida", actual.autor_id))) {
          return json({ error: "Solo puedes borrar tus propias noticias rápidas" }, 403);
        }
        await env.DB.prepare("DELETE FROM noticias_rapidas WHERE id = ?").bind(id).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "borrar_noticia_rapida", entidad: "noticia_rapida", entidad_id: id,
          descripcion: `Ha borrado la noticia rápida "${actual.titulo}"`,
        }));
        return json({ ok: true });
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
        // listado, y se reparte en memoria con un Map por poll_id.
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
        if (!votanteId || votanteId.length > 64) return json({ error: "Falta identificador de votante" }, 400);
        if (await limiteExcedido(request, env, "voto-comentario", 120, 3600)) {
          return json({ error: RESPUESTA_DEMASIADOS_INTENTOS }, 429);
        }
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
        // Ruta separada de las anteriores porque NO lee D1/article_views:
        // pide datos directamente a la API de Google Search Console con
        // una cuenta de servicio. Antes esta ruta no existía en el
        // Worker (el frontend la llamaba pero siempre recibía 404, que
        // el panel mostraba como "Error de conexión" en la tarjeta de
        // Search Console) -- ver calcularGscAnaliticas más abajo.
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
        // No se cachea con conCacheKV/TTL de 10 min como el resto: es una
        // serie temporal en vivo (el propio gráfico se llama "últimas 24h")
        // y con TTL largo mostraría datos ya desfasados en cuanto pasa
        // más de un cubo horario. Se cachea aparte, 60s, para que un
        // autorefresco del panel no golpee D1 en cada recarga.
        if (path === "/api/admin/analiticas/ultimas-24h") {
          const { datos } = await conCacheKV(env, `analiticas-cache:${path}`, 60, () =>
            calcularUltimas24hAnaliticas(env)
          );
          return json(datos);
        }

        // ---------- Buscador de noticia por titular ----------
        // Sin caché: es una búsqueda interactiva con un término variable
        // (`q`), así que cachear por `q` no ahorraría casi nunca (cada
        // tecleo cambia la clave) y solo complicaría la invalidación.
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
      // Ruta separada del bloque GET de arriba porque es DELETE, no
      // acepta ?dias= con el mismo capado a RANGO_ANALITICAS_MAX_DIAS
      // (el modal del panel deja borrar "todo el histórico" a propósito)
      // y no debe cachearse nunca en KV. Sigue exigiendo admin igual que
      // el resto de /api/admin/analiticas/*, y sigue contando para el
      // cortacircuitos de rutas pesadas de más arriba (proterRutaPesada
      // se aplica por prefijo de path, no por método).
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
      // (90 clubes), temporada 2026/27. MISMA lista que
      // TODOS_LOS_CLUBES_SEGUNDA_FEDERACION en public/js/clubs.js -- si
      // se actualiza una hay que actualizar la otra (no se puede
      // compartir el archivo tal cual porque este worker es backend y
      // clubs.js es del frontend). Cada verano, cuando la RFEF redefine
      // los grupos, hay que revisar y actualizar ambas listas.
      //
      // OJO: este cálculo automático es solo un VALOR POR DEFECTO. Si
      // el panel de admin manda explícitamente un body.grupo (porque el
      // redactor lo ha escrito o corregido a mano), esa elección manual
      // SIEMPRE prevalece y nunca se pisa aquí -- así, un equipo nuevo,
      // un alias de nombre no reconocido, o un cambio de última hora de
      // la RFEF no dejan el partido sin grupo (ver grupoAGuardar /
      // grupoAGuardarEdicion, donde se aplica esta prioridad).
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
        "Utebo FC": "Grupo 2",
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
        // Un partido "finalizado" automáticamente por el cron sin que
        // ningún redactor lo haya cubierto (finalizado_no_cubierto = 1,
        // ver más arriba) no debe verse en ningún sitio de la web
        // pública -resultados, calendario, portada, ficha de equipo,
        // porras...- hasta que un redactor lo cubra de verdad (lo que
        // limpia ese flag a 0, ver PUT /api/results/:id). Debe seguir
        // siendo visible para el panel de admin, que es precisamente
        // donde el redactor tiene que verlo para poder cubrirlo. Este
        // mismo endpoint GET /api/results lo usan tanto la web pública
        // (sin token) como el panel (con token de sesión de
        // redactor/admin), así que basta con distinguir por eso: si no
        // hay una sesión de staff válida, se ocultan.
        const esStaff = !!(await requireAuth(request, env, url));
        // Lista pública (sin sesión de staff): 8 s de caché por isolate.
        const claveListaPublica = esStaff ? null : `lista:${url.search}`;
        if (claveListaPublica) {
          const enCache = CACHE_CORTA.get(claveListaPublica);
          if (enCache && enCache.exp > Date.now()) return json({ results: enCache.valor });
        }
        const competicion = url.searchParams.get("competicion");
        const estado = url.searchParams.get("estado");
        const grupo = url.searchParams.get("grupo");
        // Filtro por equipo (para la página de equipo y el desplegable de
        // Resultados): un partido "pertenece" a un club tanto si juega en
        // casa como fuera, así que se compara contra las dos columnas.
        const club = url.searchParams.get("club");
        // Filtro opcional por fecha mínima del partido ("YYYY-MM-DD"),
        // pensado para pedir "solo la temporada en curso" sin depender de
        // un LIMIT fijo. Antes, /clasificacion.html pedía siempre
        // "?limit=500" y confiaba en que esos 500 partidos más recientes
        // (por fecha_partido) fueran suficientes para cubrir toda la
        // temporada actual del grupo/competición elegido. Como en la base
        // de datos se acumulan TODAS las temporadas jugadas de cada grupo
        // (no hay ningún campo "temporada", ver schema.sql), en cuanto un
        // grupo llevaba ya varias temporadas acumuladas y su total de
        // partidos superaba los 500, el LIMIT recortaba los más antiguos
        // -- y si ese corte caía dentro de la temporada actual (p.ej. las
        // primeras jornadas), esos partidos desaparecían de la
        // clasificación calculada en el cliente, dándola incompleta. El
        // fallo era intermitente porque depende de cuántos partidos
        // históricos tenga acumulados cada grupo en cada momento, no de
        // nada que cambie en el código. Con "desde_fecha" el frontend
        // puede acotar por fecha de inicio de temporada en vez de por
        // "cuenta los últimos N", así el resultado no depende del volumen
        // histórico acumulado. Se incluyen también los partidos con
        // fecha_partido NULL (normalmente recién creados/sin programar
        // todavía, casi siempre de la temporada en curso) para no
        // perderlos por no tener fecha con la que compararlos.
        const desdeFecha = url.searchParams.get("desde_fecha");
        // El límite era fijo (100) e ignoraba el "?limit=" que ya mandaba
        // el frontend (el panel de admin pide 200 para no dejarse partidos
        // fuera). Si un resultado quedaba fuera de esos 100 primeros, el
        // panel de Minuto a Minuto dejaba de encontrarlo al refrescar tras
        // "Iniciar partido" y se quedaba con los datos previos en memoria
        // (sin inicio_cronometro_at), así que el cronómetro no arrancaba
        // nunca aunque el backend sí lo hubiera guardado bien.
        const limitParam = parseInt(url.searchParams.get("limit"), 10);
        // Bajado de 2000 a 500: un límite tan alto sin filtros (competición,
        // estado, fecha) provocaba escaneos de cientos de filas por llamada
        // -ver métricas de D1 de sep-2026, "SELECT * FROM results" era la
        // consulta más cara de toda la cuota diaria-. 500 partidos ya cubre
        // sobradamente cualquier vista razonable del panel; si algún caso
        // real necesita más, mejor paginar con desde_fecha que subir esto.
        const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 500 ? limitParam : 100;
        let query = "SELECT * FROM results WHERE 1=1";
        const binds = [];
        if (!esStaff) { query += " AND finalizado_no_cubierto = 0"; }
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
        // Orden opcional "?orden=cercania" (lo usa el panel de admin):
        //  1) EN JUEGO primero, 2) POR JUGAR (programado/retrasado) y
        //  3) TERMINADOS (finalizado/anulado) y cualquier otro estado.
        // Dentro de cada bloque, por cercanía a la hora actual de Madrid
        // (fecha_partido se guarda en hora de Madrid, sin zona), y a
        // igual distancia primero el que aún no ha empezado. Los que no
        // tienen fecha (o no parseable) van al final de su bloque. Al
        // ordenar en SQL, el LIMIT recorta lo MÁS LEJANO a la hora
        // actual en vez de lo más antiguo, así los programados próximos
        // nunca quedan fuera aunque haya más de 500 partidos. Sin el
        // parámetro se mantiene el orden de siempre (fecha DESC), que es
        // el que espera la web pública (clasificación, calendario...).
        // [SECUNDARIO] Diferencia INTENCIONADA respecto a worker/src/index.js:
        // allí el orden por cercanía se hace en SQL con julianday(), que NO
        // existe en PostgreSQL; aquí se trae por fecha_partido DESC y se
        // ordena en JS con el mismo criterio. Mantener ambos en sync a mano.
        const ordenCercania = url.searchParams.get("orden") === "cercania";
        query += ` ORDER BY fecha_partido DESC LIMIT ${limit}`;
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        if (ordenCercania) {
          const pm = new Intl.DateTimeFormat("en-US", {
            timeZone: "Europe/Madrid", hourCycle: "h23",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
          }).formatToParts(new Date()).reduce((acc, x) => (acc[x.type] = x.value, acc), {});
          const ahora = Date.UTC(pm.year, pm.month - 1, pm.day, pm.hour, pm.minute, pm.second);
          const ts = (r) => {
            const m = String(r.fecha_partido || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
            return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : NaN;
          };
          const prio = (e) => e === "en_juego" ? 0 : (e === "programado" || e === "retrasado") ? 1 : 2;
          const orden = results.map((r, i) => ({ r, i, t: ts(r) })).sort((a, b) => {
            const pa = prio(a.r.estado), pb = prio(b.r.estado);
            if (pa !== pb) return pa - pb;
            const na = isNaN(a.t), nb = isNaN(b.t);
            if (na || nb) return na && nb ? a.i - b.i : (na ? 1 : -1);
            const da = Math.abs(a.t - ahora), db = Math.abs(b.t - ahora);
            if (da !== db) return da - db;
            const fa = a.t >= ahora, fb = b.t >= ahora;
            if (fa !== fb) return fa ? -1 : 1;
            return a.i - b.i;
          }).map(x => x.r);
          results.splice(0, results.length, ...orden);
        }
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
            `SELECT resultado_id, MAX(created_at) AS ultimo_evento_at,
                    MAX(CASE WHEN tipo = 'fin_descanso' THEN 1 ELSE 0 END) AS segunda_parte_iniciada
             FROM match_events
             WHERE resultado_id IN (${placeholders}) GROUP BY resultado_id`
          ).bind(...idsEnJuego).all();
          const mapaUltimoEvento = {};
          // segunda_parte_iniciada (1/0): ya existe el evento "fin_descanso",
          // es decir, el partido va por la 2ª parte y un reloj corriendo
          // entre el min. 55 y el 100 es normal (ver avisoPartidoDesatendido
          // en admin.js y evaluarSituacionDesatendida).
          const mapaSegundaParte = {};
          ultimosEventos.forEach(e => {
            mapaUltimoEvento[e.resultado_id] = e.ultimo_evento_at;
            mapaSegundaParte[e.resultado_id] = Number(e.segunda_parte_iniciada) === 1 ? 1 : 0;
          });
          results.forEach(r => {
            r.ultimo_evento_at = mapaUltimoEvento[r.id] || null;
            r.segunda_parte_iniciada = mapaSegundaParte[r.id] || 0;
          });
        }
        if (claveListaPublica) CACHE_CORTA.set(claveListaPublica, { exp: Date.now() + 8000, valor: results });
        return json({ results });
      }

      // ---------- Detección de partidos duplicados ----------
      // Antes solo se avisaba cuando el partido nuevo era EXACTAMENTE
      // igual a uno existente: misma competición, misma fecha Y HORA al
      // minuto, y mismo marcador. Bastaba un minuto de diferencia en la
      // hora, un acento distinto en el nombre del equipo o un marcador
      // todavía sin rellenar para que el duplicado pasara sin aviso, que
      // es justo como se cuelan en la práctica (misma jornada tecleada
      // dos veces, o importada y luego metida a mano).
      //
      // Ahora se comparan los equipos NORMALIZADOS y se contemplan
      // cuatro casos, en orden de gravedad. El primero bloquea; los
      // otros tres solo avisan y se pueden confirmar con
      // "confirmar_duplicado: true", igual que antes.
      function normalizarEquipoDuplicado(nombre) {
        let n = String(nombre || "")
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // quita acentos
          .toLowerCase()
          .replace(/[.\-_'"`]/g, " ")                          // puntuación como separador
          .replace(/\s+/g, " ")
          .trim();
        // Prefijos/sufijos societarios que unos redactores escriben y
        // otros no ("CD Lugo" vs "Lugo", "Real Zaragoza SAD"). OJO: no
        // se toca la "B" ni la "C" final, que SÍ distinguen equipos
        // reales (Castellón y Castellón B son dos equipos distintos).
        const societarios = ["cf", "cd", "ud", "sd", "ad", "ue", "ce", "rc", "rcd", "fc", "sad", "club", "cp", "ca"];
        let partes = n.split(" ");
        // Iniciales sueltas al principio ("R.C. Deportivo" -> "r c
        // deportivo") : se quitan igual que los prefijos societarios.
        // Solo al PRINCIPIO: una letra suelta al final sí significa algo
        // ("Real Madrid C" es el filial, no el primer equipo).
        while (partes.length > 1 && (societarios.includes(partes[0]) || partes[0].length === 1)) partes.shift();
        while (partes.length > 1 && societarios.includes(partes[partes.length - 1])) partes.pop();
        return partes.join(" ");
      }

      // Día (sin hora) de una fecha "YYYY-MM-DDTHH:MM" o "YYYY-MM-DD".
      function diaDeFecha(fecha) {
        return fecha ? String(fecha).slice(0, 10) : null;
      }
      function sumarDias(dia, n) {
        const d = new Date(`${dia}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      }

      // Devuelve null si no hay conflicto, o { bloqueante, motivo,
      // mensaje, partido } con el partido ya existente que choca.
      // "excluirId" evita que un partido se detecte a sí mismo al editar.
      async function detectarPartidoDuplicado(env, datos, excluirId = null) {
        const localNorm = normalizarEquipoDuplicado(datos.equipo_local);
        const visitanteNorm = normalizarEquipoDuplicado(datos.equipo_visitante);
        if (!localNorm || !visitanteNorm || !datos.competicion) return null;
        const dia = diaDeFecha(datos.fecha_partido);
        const jornada = (datos.jornada === undefined || datos.jornada === null || datos.jornada === "")
          ? null : parseInt(datos.jornada, 10);

        // Candidatos: mismos equipos posibles dentro de la misma
        // competición, acotado a la misma jornada o a una ventana de
        // +-3 días alrededor de la fecha. Es un filtro amplio a
        // propósito: el criterio fino se aplica luego en JS, donde sí se
        // pueden comparar nombres normalizados.
        const condiciones = [];
        const binds = [datos.competicion];
        if (jornada !== null && Number.isInteger(jornada)) { condiciones.push("jornada = ?"); binds.push(jornada); }
        if (dia) {
          condiciones.push("substr(fecha_partido, 1, 10) BETWEEN ? AND ?");
          binds.push(sumarDias(dia, -3), sumarDias(dia, 3));
        }
        if (!condiciones.length) return null;
        let query = `SELECT id, competicion, grupo, jornada, equipo_local, equipo_visitante,
                            goles_local, goles_visitante, fecha_partido, estado
                     FROM results
                     WHERE competicion = ? AND (${condiciones.join(" OR ")})`;
        if (excluirId) { query += " AND id != ?"; binds.push(excluirId); }
        query += " LIMIT 400";
        const { results: candidatos } = await env.DB.prepare(query).bind(...binds).all();
        if (!candidatos || !candidatos.length) return null;

        const mismosEquipos = (c) => {
          const cl = normalizarEquipoDuplicado(c.equipo_local);
          const cv = normalizarEquipoDuplicado(c.equipo_visitante);
          // En cualquier orden: si alguien metió local y visitante al
          // revés sigue siendo el mismo partido duplicado.
          return (cl === localNorm && cv === visitanteNorm) || (cl === visitanteNorm && cv === localNorm);
        };
        const descripcion = (c) =>
          `${c.equipo_local} vs ${c.equipo_visitante} (J${c.jornada ?? "-"}${c.fecha_partido ? `, ${c.fecha_partido.replace("T", " ")}` : ""})`;

        // 1) BLOQUEANTE: el mismo enfrentamiento ya existe en la MISMA
        // jornada de la misma competición y grupo. En liga eso no puede
        // pasar nunca: dos equipos se enfrentan una sola vez por
        // jornada. No se deja confirmar, porque no hay ningún caso real
        // en el que crearlo sea correcto (si la fecha u hora cambió, lo
        // que toca es editar el partido existente, no crear otro).
        // Los amistosos quedan fuera: no tienen jornada de verdad.
        if (datos.competicion !== "amistoso" && jornada !== null && Number.isInteger(jornada)) {
          const mismoGrupo = (c) => !datos.grupo || !c.grupo || c.grupo === datos.grupo;
          const choque = candidatos.find((c) => c.jornada === jornada && mismosEquipos(c) && mismoGrupo(c));
          if (choque) {
            return {
              bloqueante: true,
              motivo: "duplicado_jornada",
              mensaje: `Este partido ya existe en la jornada ${jornada}: ${descripcion(choque)}. Edita el partido existente (#${choque.id}) en vez de crear otro.`,
              partido: choque,
            };
          }
        }

        // 2) AVISO: mismos equipos el MISMO DÍA, aunque cambie la hora,
        // la jornada o el marcador. Es el caso típico de "lo metí a mano
        // y además lo importé".
        if (dia) {
          const mismoDia = candidatos.find((c) => diaDeFecha(c.fecha_partido) === dia && mismosEquipos(c));
          if (mismoDia) {
            return {
              bloqueante: false,
              motivo: "mismo_dia",
              mensaje: `Ya hay un partido de estos mismos equipos ese día: ${descripcion(mismoDia)}.`,
              partido: mismoDia,
            };
          }
        }

        // 3) AVISO: uno de los dos equipos ya tiene OTRO partido a la
        // misma fecha y hora exactas. Un equipo no puede jugar dos
        // partidos a la vez, así que casi siempre significa que uno de
        // los dos está mal tecleado.
        if (datos.fecha_partido) {
          const solapado = candidatos.find((c) => {
            if (c.fecha_partido !== datos.fecha_partido) return false;
            const cl = normalizarEquipoDuplicado(c.equipo_local);
            const cv = normalizarEquipoDuplicado(c.equipo_visitante);
            return [cl, cv].includes(localNorm) || [cl, cv].includes(visitanteNorm);
          });
          if (solapado) {
            return {
              bloqueante: false,
              motivo: "equipo_ocupado",
              mensaje: `A esa misma hora ya hay otro partido con uno de estos equipos: ${descripcion(solapado)}. Un equipo no puede jugar dos partidos a la vez.`,
              partido: solapado,
            };
          }
        }

        // 4) AVISO: mismos equipos en la misma competición dentro de
        // +-3 días. Puede ser legítimo (partido aplazado recolocado),
        // por eso solo avisa.
        if (dia) {
          const cercano = candidatos.find((c) => mismosEquipos(c) && c.fecha_partido);
          if (cercano) {
            return {
              bloqueante: false,
              motivo: "fechas_cercanas",
              mensaje: `Hay un partido muy parecido a menos de 3 días: ${descripcion(cercano)}. ¿Es un aplazamiento del mismo partido?`,
              partido: cercano,
            };
          }
        }
        return null;
      }

      if (path === "/api/results" && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede crear resultados" }, 403);
        }
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
        // No se deja crear un resultado de una jornada que ya ha terminado.
        // Se considera "pasada" cuando el calendario de jornadas
        // (tabla jornadas_calendario) tiene registrada esa jornada para la
        // competición/grupo y su fecha_fin es anterior al día de hoy
        // (hora de Madrid; la fecha_fin es inclusiva, así que durante el
        // último día de la jornada todavía se puede crear). Si el
        // calendario no conoce esa jornada, o la competición no usa
        // jornadas (amistoso), no hay forma de saber si está pasada y se
        // deja crear como siempre. Solo aplica al crear (POST), no al editar.
        {
          if (body.competicion !== "amistoso") {
            const jornadaNum = parseInt(body.jornada, 10);
            if (Number.isInteger(jornadaNum)) {
              const grupoJornada = body.competicion === "segunda_federacion"
                ? (body.grupo || grupoAutomaticoSegundaFederacion(body.competicion, body.equipo_local, body.equipo_visitante))
                : (body.grupo || null);
              const filaJornada = await env.DB.prepare(
                `SELECT MAX(fecha_fin) AS fecha_fin FROM jornadas_calendario
                 WHERE competicion = ? AND (grupo IS ? OR grupo = ?) AND jornada = ?`
              ).bind(body.competicion, grupoJornada, grupoJornada, jornadaNum).first();
              if (filaJornada && filaJornada.fecha_fin) {
                // "en-CA" formatea directamente como YYYY-MM-DD.
                const hoyMadrid = new Intl.DateTimeFormat("en-CA", {
                  timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
                }).format(new Date());
                if (String(filaJornada.fecha_fin) < hoyMadrid) {
                  return json({
                    error: `La jornada ${jornadaNum} ya ha pasado (terminó el ${filaJornada.fecha_fin}). No se pueden crear resultados de una jornada pasada.`,
                    jornada_pasada: true,
                    jornada: jornadaNum,
                    fecha_fin_jornada: filaJornada.fecha_fin,
                  }, 400);
                }
              }
            }
          }
        }
        // Comprobación de duplicados (ver detectarPartidoDuplicado).
        // El caso bloqueante (mismo enfrentamiento en la misma jornada)
        // NO se puede saltar con "confirmar_duplicado": ese flag solo
        // vale para los avisos, que sí pueden corresponder a un caso
        // real (un aplazamiento recolocado, por ejemplo).
        const duplicado = await detectarPartidoDuplicado(env, body);
        if (duplicado && (duplicado.bloqueante || !body.confirmar_duplicado)) {
          return json({
            error: duplicado.mensaje,
            posible_duplicado: !duplicado.bloqueante,
            duplicado_bloqueante: duplicado.bloqueante,
            motivo: duplicado.motivo,
            mensaje: duplicado.mensaje,
            partido_existente: duplicado.partido,
          }, 409);
        }
        const flashscoreUrl = flashscoreUrlValido(body.competicion, body.estado, body.flashscore_url);
        // El grupo de Segunda Federación se rellena automáticamente (ver
        // grupoAutomaticoSegundaFederacion arriba) SOLO cuando el panel
        // no manda ya un grupo explícito: si el redactor lo ha escrito o
        // corregido a mano, esa elección manual prevalece siempre. Antes
        // se pisaba con el cálculo automático incondicionalmente, y como
        // ese cálculo solo reconocía unos pocos equipos, cualquier
        // partido de un grupo no cubierto (p.ej. Grupo 1 o Grupo 3) se
        // quedaba con grupo=null aunque el panel lo hubiera guardado
        // bien -- de ahí el bug de "el grupo no se guarda". En el resto
        // de competiciones se sigue respetando siempre lo que mande el
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
        // ?ligero=1: lo usa el refresco automático de la web pública (cada
        // 15 s por lector y partido en vivo). Devuelve solo la fila del
        // partido, sin alineaciones, noticias vinculadas ni galería (que no
        // cambian en directo y cuestan 3 consultas más), y la comparte
        // 3 s entre todas las peticiones del isolate.
        const ligero = url.searchParams.get("ligero") === "1";
        const resultado = ligero
          ? await memoCorta(`res:${id}`, 3000, () => env.DB.prepare("SELECT * FROM results WHERE id = ?").bind(id).first())
          : await env.DB.prepare("SELECT * FROM results WHERE id = ?").bind(id).first();
        if (!resultado) return json({ error: "Resultado no encontrado" }, 404);
        // Mismo criterio que en la lista (GET /api/results): un partido
        // finalizado automáticamente sin cubrir no debe poder consultarse
        // desde la web pública ni siquiera pidiendo su id directamente,
        // solo el panel (staff autenticado) puede verlo.
        if (resultado.finalizado_no_cubierto && !(await requireAuth(request, env, url))) {
          return json({ error: "Resultado no encontrado" }, 404);
        }
        if (ligero) return json({ resultado });
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
           WHERE resultado_id = ? AND publicado = 1${SQL_OCULTAR_SEGUNDO_DE_FUSION}
           ORDER BY fecha_publicacion DESC LIMIT 5`
        ).bind(id).all();
        resultado.noticias_vinculadas = noticiasVinculadas || [];
        // Enlace a la galería pública del partido (Fase 2 galería), solo
        // si ya tiene al menos una foto vinculada: igual criterio que en
        // GET /api/results/:id/galeria (panel), no se genera un slug "en
        // vacío" para un partido sin galería todavía, ni se ofrece un
        // enlace que llevaría a una página sin fotos.
        const hayGaleria = await env.DB.prepare(
          "SELECT 1 FROM match_gallery WHERE result_id = ? LIMIT 1"
        ).bind(id).first();
        resultado.url_galeria = hayGaleria
          ? `${SITIO_URL}/galeria/${await slugPartidoUnico(env, resultado)}`
          : null;
        return json({ resultado });
      }
      if (resultMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede editar resultados" }, 403);
        }
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
        // La edición también pasa por el detector de duplicados: hasta
        // ahora solo se comprobaba al crear, así que se podía convertir
        // un partido en copia exacta de otro simplemente cambiándole la
        // jornada o los equipos al editarlo. Se excluye el propio id
        // para que no se detecte a sí mismo.
        const duplicadoEdicion = await detectarPartidoDuplicado(env, body, id);
        if (duplicadoEdicion && (duplicadoEdicion.bloqueante || !body.confirmar_duplicado)) {
          return json({
            error: duplicadoEdicion.mensaje,
            posible_duplicado: !duplicadoEdicion.bloqueante,
            duplicado_bloqueante: duplicadoEdicion.bloqueante,
            motivo: duplicadoEdicion.motivo,
            mensaje: duplicadoEdicion.mensaje,
            partido_existente: duplicadoEdicion.partido,
          }, 409);
        }
        const flashscoreUrl = flashscoreUrlValido(body.competicion, body.estado, body.flashscore_url);
        // Si viene "retrasado" y se manda una nueva hora, se conserva la
        // fecha_partido original y se guarda la nueva en un campo aparte
        // (fecha_partido_retrasado); si no es "retrasado", ese campo se
        // limpia siempre (evita que quede "colgado" de un retraso previo
        // si luego el partido se reprograma o se juega con normalidad).
        const fechaRetrasado = body.estado === "retrasado" ? (body.fecha_partido_retrasado || null) : null;
        // Mismo cálculo automático del grupo que en la creación (POST),
        // y con la misma prioridad: si el panel manda body.grupo (el
        // redactor lo ha puesto o corregido a mano), se respeta siempre;
        // el cálculo automático solo actúa como valor por defecto cuando
        // no viene nada. Ver el comentario extenso en el POST de arriba.
        const grupoCalculadoEdicion = grupoAutomaticoSegundaFederacion(body.competicion, body.equipo_local, body.equipo_visitante);
        const grupoAGuardarEdicion = body.competicion === "segunda_federacion"
          ? (body.grupo || grupoCalculadoEdicion)
          : (body.grupo || null);
        await env.DB.prepare(
          // finalizado_no_cubierto se limpia a 0 en cualquier guardado
          // manual desde este formulario: si un redactor está editando
          // el partido (aunque sea para dejarlo igual), ya lo está
          // "cubriendo" -- el aviso solo tiene sentido mientras nadie ha
          // vuelto a tocar el partido desde que lo cerró el cron.
          `UPDATE results SET competicion=?, grupo=?, jornada=?, equipo_local=?, equipo_visitante=?, goles_local=?, goles_visitante=?, penaltis_local=?, penaltis_visitante=?, fecha_partido=?, estado=?, ubicacion=?, flashscore_url=?, escudo_local_url=?, escudo_visitante_url=?, fecha_partido_retrasado=?, finalizado_no_cubierto=0, fuente='redaccion' WHERE id=?`
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
        ctx.waitUntil(invalidarCacheArticuloPartido(env, id));
        return json({ ok: true });
      }

      if (resultMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede eliminar resultados" }, 403);
        }
        const id = parseInt(resultMatch[1]);
        const resultadoBorrado = await env.DB.prepare("SELECT autor_id FROM results WHERE id = ?").bind(id).first();
        if (!resultadoBorrado) return json({ error: "Resultado no encontrado" }, 404);
        if (!(await puedeEditar(env, payload, "resultado", id, resultadoBorrado.autor_id))) {
          return json({ error: "No puedes eliminar este resultado porque no es tuyo. Solicita permiso al autor o a un administrador." }, 403);
        }
        try {
          await env.DB.prepare("DELETE FROM results WHERE id = ?").bind(id).run();
        } catch (err) {
          // Antes de la migración migracion_fk_resultado_id_set_null.sql,
          // articles.resultado_id no tenía ON DELETE CASCADE/SET NULL:
          // si el partido tenía una noticia/crónica vinculada, D1
          // rechazaba el DELETE con SQLITE_CONSTRAINT_FOREIGNKEY. Ese
          // error se devolvía sin capturar como un 500 genérico, que
          // apiFetch (public/js/config.js) interpreta como "servidor
          // caído" y reintenta en la secundaria -- que falla igual por
          // la misma restricción -- y cuyo error, mal propagado, acababa
          // forzando un logout() en el panel aunque la sesión fuera
          // válida. Se detecta aquí explícitamente y se devuelve un 409
          // con un mensaje claro, tanto si la migración aún no se ha
          // aplicado como salvaguarda genérica ante cualquier otra FK
          // futura que apunte a "results".
          if (err.code === "23503" || /FOREIGN KEY constraint failed|foreign key constraint/i.test(err.message || "")) {
            return json({
              error: "No se puede eliminar: hay una noticia o crónica vinculada a este partido. Quita el enlace al partido desde esa noticia (o bórrala) y vuelve a intentarlo.",
            }, 409);
          }
          throw err;
        }
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
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede marcar el MVP de un partido" }, 403);
        }
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
        ctx.waitUntil(invalidarCacheArticuloPartido(env, id));
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
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede gestionar alineaciones" }, 403);
        }
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
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede gestionar alineaciones" }, 403);
        }
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
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede gestionar el cronómetro del minuto a minuto" }, 403);
        }
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

      // ---------- PORRAS (predicciones de lectores) ----------
      // Baremo de puntos. Constantes (no en BD) para poder ajustar el
      // criterio sin migración; ver migracion_porras.sql para más
      // contexto de por qué el resultado ya calculado SÍ se congela por
      // fila aunque el baremo cambie más adelante.
      const PUNTOS_ACIERTO_EXACTO = 3;
      const PUNTOS_ACIERTO_SIGNO = 1;

      // Sentido de un marcador: 'local' | 'empate' | 'visitante'.
      function signoResultado(golesLocal, golesVisitante) {
        if (golesLocal > golesVisitante) return "local";
        if (golesLocal < golesVisitante) return "visitante";
        return "empate";
      }

      // Resuelve (calcula puntos + tipo de acierto) todas las porras
      // "pendiente" cuyo partido ya está "finalizado", entre las que se
      // acaban de pedir. Se llama desde dentro de GET /api/porras, no
      // desde un cron aparte: así no hace falta engancharse a los 3
      // sitios del código donde un partido puede terminar en
      // "finalizado" (panel normal, Minuto a Minuto, cierre automático
      // al minuto 90) para no olvidar ninguno. El primer GET que pase
      // por una porra ya jugada la deja resuelta para siempre; los
      // siguientes GET la encuentran ya con puntos y no hacen nada.
      async function resolverPorrasPendientes(env, porrasConPartido) {
        const pendientesDeResolver = porrasConPartido.filter(
          (p) => p.resultado_acierto === "pendiente" && p.estado === "finalizado" &&
                 p.goles_local !== null && p.goles_local !== undefined &&
                 p.goles_visitante !== null && p.goles_visitante !== undefined
        );
        if (!pendientesDeResolver.length) return;
        for (const p of pendientesDeResolver) {
          const signoReal = signoResultado(p.goles_local, p.goles_visitante);
          const signoPredicho = signoResultado(p.goles_local_predicho, p.goles_visitante_predicho);
          let puntos = 0;
          let tipo = "fallo";
          if (p.goles_local_predicho === p.goles_local && p.goles_visitante_predicho === p.goles_visitante) {
            puntos = PUNTOS_ACIERTO_EXACTO;
            tipo = "exacto";
          } else if (signoPredicho === signoReal) {
            puntos = PUNTOS_ACIERTO_SIGNO;
            tipo = "acierto";
          }
          await env.DB.prepare(
            `UPDATE porras SET puntos_obtenidos = ?, resultado_acierto = ?, updated_at = datetime('now') WHERE id = ?`
          ).bind(puntos, tipo, p.id).run();
          // Se refleja también en el objeto en memoria para que la
          // respuesta de ESTE mismo GET ya salga resuelta, sin obligar
          // a quien llama a repetir la petición para ver sus puntos.
          p.puntos_obtenidos = puntos;
          p.resultado_acierto = tipo;
        }
      }

      // Resuelve las porras pendientes de TODOS los lectores para una
      // jornada concreta, no solo las del lector que consulta. Hace
      // falta para el ranking: antes, una porra solo se resolvía cuando
      // su propio autor abría /api/porras, así que quien no volvía a
      // entrar después del partido se quedaba en 'pendiente' para
      // siempre y DESAPARECÍA del ranking (o aparecía con menos puntos
      // de los suyos). El ranking llama a esto antes de agregar, de
      // modo que la tabla siempre sale completa y con todo el mundo.
      async function resolverPorrasDeJornada(env, { competicion, grupo, jornada }) {
        let query = `
          SELECT po.id, po.goles_local_predicho, po.goles_visitante_predicho,
                 po.resultado_acierto, r.estado, r.goles_local, r.goles_visitante
          FROM porras po
          JOIN results r ON r.id = po.resultado_id
          WHERE po.resultado_acierto = 'pendiente' AND r.estado = 'finalizado'
            AND r.jornada = ?`;
        const binds = [jornada];
        if (competicion) { query += " AND r.competicion = ?"; binds.push(competicion); }
        if (grupo) { query += " AND r.grupo = ?"; binds.push(grupo); }
        const { results: pendientes } = await env.DB.prepare(query).bind(...binds).all();
        if (pendientes && pendientes.length) {
          await resolverPorrasPendientes(env, pendientes);
        }
      }

      // GET /api/porras?competicion=&grupo=&jornada= — porras del lector
      // autenticado para los partidos de esa categoría/grupo/jornada.
      // "grupo" es opcional (competiciones sin grupos, como Hypermotion).
      if (path === "/api/porras" && method === "GET") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "Inicia sesión para ver tu porra" }, 401);
        const competicion = url.searchParams.get("competicion");
        const grupo = url.searchParams.get("grupo");
        const jornada = url.searchParams.get("jornada");
        if (!competicion || !jornada) {
          return json({ error: "Faltan competicion y jornada" }, 400);
        }
        let query = `
          SELECT po.id, po.resultado_id, po.goles_local_predicho, po.goles_visitante_predicho,
                 po.puntos_obtenidos, po.resultado_acierto, po.updated_at,
                 r.estado, r.goles_local, r.goles_visitante
          FROM porras po
          JOIN results r ON r.id = po.resultado_id
          WHERE po.reader_id = ? AND r.competicion = ? AND r.jornada = ?`;
        const binds = [payload.rid, competicion, jornada];
        if (grupo) { query += " AND r.grupo = ?"; binds.push(grupo); }
        const { results: porrasConPartido } = await env.DB.prepare(query).bind(...binds).all();
        await resolverPorrasPendientes(env, porrasConPartido);
        // Se devuelve ya sin los campos de "results" que solo hacían
        // falta para resolver (el frontend ya tiene esos datos por su
        // lado, vía /api/results): así la forma de la respuesta es
        // estable y no depende de detalles internos de resolución.
        const porras = porrasConPartido.map((p) => ({
          id: p.id,
          resultado_id: p.resultado_id,
          goles_local_predicho: p.goles_local_predicho,
          goles_visitante_predicho: p.goles_visitante_predicho,
          puntos_obtenidos: p.puntos_obtenidos,
          resultado_acierto: p.resultado_acierto,
          updated_at: p.updated_at,
        }));
        return json({ porras });
      }

      // POST /api/porras — crea o actualiza (upsert) la predicción del
      // lector autenticado para UN partido. Body: { resultado_id,
      // goles_local_predicho, goles_visitante_predicho }.
      if (path === "/api/porras" && method === "POST") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "Inicia sesión para guardar tu porra" }, 401);
        const body = await request.json();
        const resultadoId = parseInt(body.resultado_id, 10);
        const golesLocal = parseInt(body.goles_local_predicho, 10);
        const golesVisitante = parseInt(body.goles_visitante_predicho, 10);
        if (!Number.isInteger(resultadoId)) {
          return json({ error: "Falta el partido" }, 400);
        }
        if (!Number.isInteger(golesLocal) || !Number.isInteger(golesVisitante) || golesLocal < 0 || golesVisitante < 0) {
          return json({ error: "El resultado predicho debe ser un marcador válido (0 o más goles por equipo)" }, 400);
        }
        // Tope razonable: evita marcadores absurdos metidos a mano contra
        // la API directamente (10 goles ya es un resultado extremo real
        // en fútbol amateur; 999 no aporta nada y solo ensucia datos).
        if (golesLocal > 20 || golesVisitante > 20) {
          return json({ error: "El resultado predicho no es válido" }, 400);
        }
        const partido = await env.DB.prepare(
          "SELECT id, estado, fecha_partido FROM results WHERE id = ?"
        ).bind(resultadoId).first();
        if (!partido) return json({ error: "El partido no existe" }, 404);
        // Bloqueo server-side: solo se puede predecir (o corregir la
        // predicción) mientras el partido sigue "programado". En cuanto
        // pasa a en_juego/finalizado/retrasado/anulado, ya no se acepta
        // ni la primera porra ni una edición de la existente. Se repite
        // aquí aunque el frontend ya oculte el input, porque el frontend
        // nunca es la última línea de defensa.
        if (partido.estado !== "programado") {
          return json({ error: "Este partido ya no admite predicciones" }, 409);
        }
        const existente = await env.DB.prepare(
          "SELECT id FROM porras WHERE reader_id = ? AND resultado_id = ?"
        ).bind(payload.rid, resultadoId).first();
        if (existente) {
          await env.DB.prepare(
            `UPDATE porras SET goles_local_predicho = ?, goles_visitante_predicho = ?, updated_at = datetime('now')
             WHERE id = ?`
          ).bind(golesLocal, golesVisitante, existente.id).run();
          return json({ ok: true, id: existente.id });
        }
        const insertado = await env.DB.prepare(
          `INSERT INTO porras (reader_id, resultado_id, goles_local_predicho, goles_visitante_predicho)
           VALUES (?, ?, ?, ?)`
        ).bind(payload.rid, resultadoId, golesLocal, golesVisitante).run();
        return json({ ok: true, id: insertado.meta.last_row_id });
      }

      // GET /api/porras/resumen?competicion= — puntuación TOTAL del lector
      // autenticado en toda la temporada en curso (no solo la jornada
      // abierta), para pintar un marcador estable de "cómo llevas la
      // temporada" en la cabecera de la página. "competicion" es
      // opcional: sin ella, se suma across TODAS las competiciones en
      // las que el lector haya jugado (para el resumen general).
      if (path === "/api/porras/resumen" && method === "GET") {
        const payload = await requireReaderAuth(request, env);
        if (!payload) return json({ error: "Inicia sesión para ver tu resumen" }, 401);
        const competicion = url.searchParams.get("competicion");
        // "Temporada en curso": mismo criterio de fecha que ya usa el
        // frontend para clasificación/porras (desde el 1 de julio del
        // año en que empezó la temporada actual), calculado aquí en el
        // servidor porque el resumen puede pedirse independientemente
        // de qué jornada tenga abierta el frontend en ese momento.
        const ahora = new Date();
        const mes = ahora.getUTCMonth();
        const anioInicio = mes >= 6 ? ahora.getUTCFullYear() : ahora.getUTCFullYear() - 1;
        const desdeFecha = `${anioInicio}-07-01`;
        let query = `
          SELECT
            COUNT(*) AS total_porras,
            COALESCE(SUM(po.puntos_obtenidos), 0) AS puntos_totales,
            SUM(CASE WHEN po.resultado_acierto = 'exacto' THEN 1 ELSE 0 END) AS exactos,
            SUM(CASE WHEN po.resultado_acierto = 'acierto' THEN 1 ELSE 0 END) AS aciertos,
            SUM(CASE WHEN po.resultado_acierto = 'fallo' THEN 1 ELSE 0 END) AS fallos
          FROM porras po
          JOIN results r ON r.id = po.resultado_id
          WHERE po.reader_id = ? AND po.resultado_acierto != 'pendiente'
            AND (r.fecha_partido >= ? OR r.fecha_partido IS NULL)`;
        const binds = [payload.rid, desdeFecha];
        if (competicion) { query += " AND r.competicion = ?"; binds.push(competicion); }
        const resumen = await env.DB.prepare(query).bind(...binds).first();
        return json({
          puntos_totales: resumen.puntos_totales || 0,
          porras_resueltas: resumen.total_porras || 0,
          exactos: resumen.exactos || 0,
          aciertos: resumen.aciertos || 0,
          fallos: resumen.fallos || 0,
        });
      }

      // GET /api/porras/ranking?competicion=&jornada=&limit= — top
      // lectores de UNA JORNADA CONCRETA YA TERMINADA (no acumulado de
      // toda la temporada: cada jornada tiene su propio ranking, para
      // que "quién acertó más esta jornada" sea una pregunta con
      // sentido incluso para alguien que se acaba de registrar).
      // "jornada" es obligatorio -- sin él no hay ranking que calcular.
      // Público (no requiere sesión: es información agregada, sin datos
      // personales más allá del nombre que el propio lector eligió al
      // registrarse), pensado para el gancho social de "quiero ver que
      // gano yo". Se identifica también la posición del lector actual
      // si hay sesión, aunque no esté entre los primeros puestos.
      if (path === "/api/porras/ranking" && method === "GET") {
        const competicion = url.searchParams.get("competicion");
        // "grupo" es parte de la identidad de una jornada en Primera y
        // Segunda Federación: la jornada 5 del Grupo 1 y la del Grupo 2
        // son partidos distintos. Sin filtrar por grupo, el ranking
        // mezclaba a gente que había jugado partidos diferentes (unos
        // con 10 partidos posibles y otros con 9), que era el motivo
        // principal de que la clasificación "no cuadrase".
        const grupo = url.searchParams.get("grupo");
        const jornadaParam = parseInt(url.searchParams.get("jornada"), 10);
        if (!Number.isInteger(jornadaParam)) {
          return json({ error: "Falta la jornada" }, 400);
        }
        const limitParam = parseInt(url.searchParams.get("limit"), 10);
        // Sin "limit" se devuelven TODOS los participantes de la jornada
        // (tope de seguridad en 500): el ranking de una porra tiene
        // sentido completo, no recortado al top 20.
        const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 500 ? limitParam : 500;

        // Estado de la jornada. "Terminada" = todos sus partidos
        // finalizados o anulados. Si NO lo está, ya no se devuelve una
        // tabla vacía: se devuelve igualmente la lista de quienes YA han
        // participado, con sus puntos provisionales (0 mientras no haya
        // partidos resueltos). El frontend marca la tabla como
        // provisional. Nunca se exponen los marcadores predichos de
        // nadie, solo nombres y contadores, así que ver quién ha jugado
        // antes de tiempo no da ninguna ventaja.
        let queryPartidosJornada = "SELECT estado FROM results WHERE jornada = ?";
        const bindsPartidosJornada = [jornadaParam];
        if (competicion) { queryPartidosJornada += " AND competicion = ?"; bindsPartidosJornada.push(competicion); }
        if (grupo) { queryPartidosJornada += " AND grupo = ?"; bindsPartidosJornada.push(grupo); }
        const { results: partidosDeJornada } = await env.DB.prepare(queryPartidosJornada).bind(...bindsPartidosJornada).all();
        const jornadaTerminada = partidosDeJornada.length > 0
          && partidosDeJornada.every((p) => p.estado === "finalizado" || p.estado === "anulado");
        // Partidos de la jornada que ya cuentan puntos, para que el
        // frontend pueda decir "van 3 de 10 partidos resueltos".
        const partidosResueltos = partidosDeJornada.filter((p) => p.estado === "finalizado" || p.estado === "anulado").length;

        // Antes de agregar: resolver las porras de esa jornada que
        // siguiesen "pendiente" por no haberlas abierto su autor. Sin
        // esto faltaban participantes enteros en la tabla. Con la
        // jornada a medias resuelve solo las de partidos ya terminados
        // (la propia función filtra por estado = 'finalizado'), que es
        // justo lo que hace falta para el marcador provisional.
        await resolverPorrasDeJornada(env, { competicion, grupo, jornada: jornadaParam });

        // Ojo al WHERE: NO se filtra por resultado_acierto. Se cuenta a
        // todo el que hizo porra en la jornada, aunque acabase con 0
        // puntos o con algún partido anulado sin resolver; los que
        // fallaron también son participantes y tienen que salir.
        let queryBase = `
          FROM porras po
          JOIN results r ON r.id = po.resultado_id
          JOIN readers rd ON rd.id = po.reader_id
          WHERE rd.activo = 1 AND r.jornada = ?`;
        const bindsBase = [jornadaParam];
        if (competicion) { queryBase += " AND r.competicion = ?"; bindsBase.push(competicion); }
        if (grupo) { queryBase += " AND r.grupo = ?"; bindsBase.push(grupo); }

        // Se calcula la tabla COMPLETA (sin LIMIT) y se recorta después
        // en memoria. Así la posición propia y la tabla visible salen
        // siempre del mismo orden: antes se usaban dos consultas con
        // ORDER BY distintos y podían contradecirse en los empates.
        const { results: tablaCompleta } = await env.DB.prepare(`
          SELECT rd.id AS reader_id, rd.nombre,
                 COALESCE(SUM(po.puntos_obtenidos), 0) AS puntos_totales,
                 SUM(CASE WHEN po.resultado_acierto = 'exacto' THEN 1 ELSE 0 END) AS exactos,
                 SUM(CASE WHEN po.resultado_acierto = 'acierto' THEN 1 ELSE 0 END) AS aciertos,
                 SUM(CASE WHEN po.resultado_acierto = 'fallo' THEN 1 ELSE 0 END) AS fallos,
                 SUM(CASE WHEN po.resultado_acierto != 'pendiente' THEN 1 ELSE 0 END) AS porras_resueltas,
                 SUM(CASE WHEN po.resultado_acierto = 'pendiente' THEN 1 ELSE 0 END) AS porras_pendientes,
                 COUNT(*) AS porras_jugadas
          ${queryBase}
          GROUP BY rd.id, rd.nombre
          ORDER BY puntos_totales DESC, exactos DESC, aciertos DESC, fallos ASC, porras_jugadas DESC, rd.nombre ASC
        `).bind(...bindsBase).all();

        // Posición con empates compartidos: dos personas con los mismos
        // puntos, exactos, aciertos y fallos comparten puesto (1, 1, 3...)
        // en vez de repartirse un 1 y un 2 arbitrarios por orden alfabético.
        const claveEmpate = (f) => `${f.puntos_totales}|${f.exactos}|${f.aciertos}|${f.fallos}`;
        let posicionActual = 0;
        let claveAnterior = null;
        const conPosicion = tablaCompleta.map((f, i) => {
          const clave = claveEmpate(f);
          if (clave !== claveAnterior) { posicionActual = i + 1; claveAnterior = clave; }
          return { ...f, posicion: posicionActual };
        });

        const tabla = conPosicion.slice(0, limit);

        // Posición y estadísticas del lector autenticado (si lo hay),
        // aunque quede fuera del recorte de arriba.
        let miPosicion = null;
        const payload = await requireReaderAuth(request, env);
        if (payload) {
          const mia = conPosicion.find((f) => f.reader_id === payload.rid);
          if (mia) {
            miPosicion = {
              posicion: mia.posicion,
              puntos_totales: mia.puntos_totales,
              exactos: mia.exactos,
              aciertos: mia.aciertos,
              fallos: mia.fallos,
              porras_jugadas: mia.porras_jugadas,
              porras_pendientes: mia.porras_pendientes,
            };
          }
        }

        return json({
          ranking: tabla,
          mi_posicion: miPosicion,
          jornada_terminada: jornadaTerminada,
          total_participantes: conPosicion.length,
          partidos_totales: partidosDeJornada.length,
          partidos_resueltos: partidosResueltos,
        });
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

      // Datos extra de la "Revisión VAR" (tipo "var"): sobre qué jugada
      // se revisa (var_motivo) y en qué punto está la revisión
      // (var_decision). Ambos son opcionales en el backend (un cliente
      // antiguo que no los mande no rompe nada) pero, si llegan, deben
      // ser valores conocidos. Para cualquier otro tipo de evento se
      // guardan siempre a NULL. Deben coincidir con los desplegables
      // del panel de Minuto a Minuto (MAM_VAR_MOTIVOS/MAM_VAR_DECISIONES)
      // y con las etiquetas públicas de config.js.
      const VAR_MOTIVOS_VALIDOS = ["gol", "penalti", "roja", "amarilla", "falta", "fuera_juego", "mano", "otra"];
      const VAR_DECISIONES_VALIDAS = ["revisando", "mantiene", "cambia"];
      const normalizarDatosVar = (body) => {
        if (body.tipo !== "var") return { motivo: null, decision: null };
        const motivo = body.var_motivo || null;
        const decision = body.var_decision || null;
        if (motivo && !VAR_MOTIVOS_VALIDOS.includes(motivo)) return { error: "Motivo de la revisión VAR no válido" };
        if (decision && !VAR_DECISIONES_VALIDAS.includes(decision)) return { error: "Decisión de la revisión VAR no válida" };
        return { motivo, decision };
      };

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
          `SELECT id, tipo, equipo, jugador, jugador_sale, jugador_asistencia, minuto, minuto_extra, orden, bajar_gol, var_motivo, var_decision
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
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede editar los eventos de un partido" }, 403);
        }
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
        const datosVar = normalizarDatosVar(body);
        if (datosVar.error) return json({ error: datosVar.error }, 400);
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
          `INSERT INTO match_events (resultado_id, tipo, equipo, jugador, jugador_sale, jugador_asistencia, minuto, minuto_extra, orden, bajar_gol, var_motivo, var_decision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          resultadoId, body.tipo, equipoRequerido ? body.equipo : "ninguno",
          body.jugador || null, body.jugador_sale || null,
          body.tipo === "gol" ? (body.jugador_asistencia || null) : null,
          parseInt(body.minuto, 10), body.minuto_extra ? parseInt(body.minuto_extra, 10) : null,
          body.orden ? parseInt(body.orden, 10) : 0,
          body.tipo === "gol_var" && body.bajar_gol ? 1 : 0,
          datosVar.motivo, datosVar.decision
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
        if (body.tipo === "gol" || body.tipo === "gol_pp") ctx.waitUntil(notificarPushPartido(env, resultadoId, body.tipo, body));
        if (body.tipo === "penalti_marcado" || body.tipo === "penalti_fallado_tanda") await recalcularPenaltisDesdeEventos(env, resultadoId);
        if (body.tipo === "fin_partido") {
          // Se limpia también aquí aviso_desatendido_mitad: si este mismo
          // partido se reabre más adelante por otra vía que no pase por
          // iniciarCronometroPartido(), no debe arrastrar avisos de una
          // "vida" anterior del partido. finalizado_no_cubierto se pone
          // explícitamente a 0: este es el cierre MANUAL (el redactor ha
          // pulsado "Fin del partido" de verdad), a diferencia del cierre
          // automático de crearFinPartidoAutomaticoAlMinuto90 que sí lo
          // marca a 1 -- así, si el cron ya había cerrado el partido solo
          // y luego se reabre y se vuelve a cerrar a mano, el aviso
          // "FINALIZADO NO CUBIERTO" desaparece del panel.
          await env.DB.prepare("UPDATE results SET estado = 'finalizado', aviso_desatendido_mitad = NULL, finalizado_no_cubierto = 0 WHERE id = ?").bind(resultadoId).run();
          ctx.waitUntil(notificarPushPartido(env, resultadoId, "fin_partido", body));
        }
        if (body.tipo === "partido_retrasado") {
          await env.DB.prepare("UPDATE results SET estado = 'retrasado' WHERE id = ?").bind(resultadoId).run();
        }
        if (body.tipo === "partido_anulado") {
          await env.DB.prepare("UPDATE results SET estado = 'anulado', cronometro_pausado_en = COALESCE(cronometro_pausado_en, ?) WHERE id = ?")
            .bind(parseInt(body.minuto, 10) || 0, resultadoId).run();
        }
        // Cualquier evento nuevo que se añada a mano es, por definición,
        // el redactor cubriendo el partido: si venía de un cierre
        // automático (finalizado_no_cubierto = 1), deja de tener sentido
        // el aviso "FINALIZADO NO CUBIERTO" en el panel -- alguien ya se
        // ha puesto a revisarlo/completarlo. No se restringe a
        // "fin_partido" (ver ese caso más arriba, que además cambia el
        // estado): cualquier tipo de evento cuenta como "ya lo estoy
        // mirando".
        await env.DB.prepare("UPDATE results SET finalizado_no_cubierto = 0 WHERE id = ?").bind(resultadoId).run();
        ctx.waitUntil(registrarActividad(env, request, payload, {
          accion: "crear_evento_partido", entidad: "resultado", entidad_id: resultadoId,
          descripcion: `Ha añadido un evento (${body.tipo}) al partido con id ${resultadoId}`,
        }));
        ctx.waitUntil(invalidarCacheArticuloPartido(env, resultadoId));
        return json({ ok: true, id: meta.last_row_id });
      }

      const eventoMatch = path.match(/^\/api\/results\/(\d+)\/eventos\/(\d+)$/);
      if (eventoMatch && method === "PUT") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede editar los eventos de un partido" }, 403);
        }
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
        const datosVar = normalizarDatosVar(body);
        if (datosVar.error) return json({ error: datosVar.error }, 400);
        await env.DB.prepare(
          `UPDATE match_events SET tipo=?, equipo=?, jugador=?, jugador_sale=?, jugador_asistencia=?, minuto=?, minuto_extra=?, orden=?, bajar_gol=?, var_motivo=?, var_decision=?
           WHERE id=? AND resultado_id=?`
        ).bind(
          body.tipo, equipoRequerido ? body.equipo : "ninguno", body.jugador || null, body.jugador_sale || null,
          body.tipo === "gol" ? (body.jugador_asistencia || null) : null,
          parseInt(body.minuto, 10), body.minuto_extra ? parseInt(body.minuto_extra, 10) : null,
          body.orden ? parseInt(body.orden, 10) : 0,
          body.tipo === "gol_var" && body.bajar_gol ? 1 : 0,
          datosVar.motivo, datosVar.decision,
          eventoId, resultadoId
        ).run();
        await recalcularMarcadorDesdeEventos(env, resultadoId);
        await recalcularPenaltisDesdeEventos(env, resultadoId);
        // Editar un evento existente también cuenta como "ya lo estoy
        // cubriendo" (ver mismo razonamiento en el POST de arriba).
        await env.DB.prepare("UPDATE results SET finalizado_no_cubierto = 0 WHERE id = ?").bind(resultadoId).run();
        ctx.waitUntil(invalidarCacheArticuloPartido(env, resultadoId));
        return json({ ok: true });
      }

      if (eventoMatch && method === "DELETE") {
        const payload = await requireAuth(request, env);
        if (!payload) return json({ error: "No autorizado" }, 401);
        if (!puedeGestionarContenidoEditorial(payload)) {
          return json({ error: "Un fotógrafo no puede eliminar los eventos de un partido" }, 403);
        }
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
        // Borrar un evento (p.ej. corrigiendo un dato mal metido) también
        // cuenta como "ya lo estoy cubriendo" (ver mismo razonamiento en
        // el POST de arriba).
        await env.DB.prepare("UPDATE results SET finalizado_no_cubierto = 0 WHERE id = ?").bind(resultadoId).run();
        ctx.waitUntil(invalidarCacheArticuloPartido(env, resultadoId));
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
          `SELECT id, competicion, grupo, fecha_partido, jornada FROM results WHERE fuente LIKE 'auto%'`
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

      // ---------- Widgets embebibles para lectores (iframe en webs externas) ----------
      // Cada ruta /widgets/* devuelve una página HTML completa y autocontenida
      // (sin dependencias externas, sin cookies/sesión) pensada para insertarse
      // con <iframe src="https://elotrofutbol.media/widgets/..."> en cualquier
      // web ajena. No se usa cors()/json() aquí: es HTML servido directamente,
      // así que no hace falta whitelist de orígenes (el iframe simplemente
      // carga la URL como cualquier navegación normal) ni autenticación (todo
      // lo que muestran estos widgets ya es público en el propio sitio). Todas
      // comparten estilos base y el script de auto-resize (widgetBaseHtml).
      if (path.startsWith("/widgets/")) {
        return widgetsRouter(path, url, env);
      }

      return json({ error: "Ruta no encontrada" }, 404);
    } catch (err) {
      return json({ error: "Error del servidor", detail: err.message }, 500);
    }
}