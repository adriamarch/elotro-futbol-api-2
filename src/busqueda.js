// Búsqueda de artículos: FTS5 (D1, worker principal) y tsvector (PostgreSQL,
// worker secundario / failover) detrás de la misma interfaz.
//
// IMPORTANTE: este archivo es IDÉNTICO en worker/src/ y worker-secondary/src/.
// El motor se elige en tiempo de ejecución con esRailway(env). La paridad se
// comprueba en CI (.github/workflows/paridad-workers.yml: diff de ambos).
//
// Piezas:
//  - Índice D1: tabla virtual articles_fts (migracion_busqueda_fts5.sql) que
//    mantiene indexarArticuloBusqueda() desde las rutas de escritura, con
//    reconciliarIndiceBusqueda() como red de seguridad desde el cron.
//  - Índice PG: columna articles.busqueda_tsv + trigger
//    (db/migrations/053_busqueda_postgres.sql). No requiere código aquí.
//  - Tolerancia a erratas: FTS5 y tsvector no la tienen, así que se corrige
//    contra un vocabulario (títulos, clubes, autores) con distancia de
//    Damerau-Levenshtein. Solo se aplica si la consulta original no da
//    resultados, para no "corregir" palabras válidas.

const KV_VOCAB = "busqueda:vocab:v2"; // v2: ya sin palabras de borradores
const MARCA_INI = "\u27E6"; // ⟦  (resaltado: se sustituye por <mark> tras escapar)
const MARCA_FIN = "\u27E7"; // ⟧
const FLAG_BACKFILL = "busqueda_backfill_completo";

const STOPWORDS = new Set([
  "de", "del", "la", "las", "el", "los", "lo", "y", "e", "o", "u", "en", "un", "una",
  "unos", "unas", "a", "al", "que", "con", "por", "para", "se", "su", "sus", "es",
  "vs", "contra",
]);

export function esRailway(env) {
  const v = env?.RUNNING_IN_RAILWAY;
  return v === true || v === "true" || v === 1 || v === "1";
}

// ---------- Normalización y términos ----------

// Caracteres que el tokenizador de FTS5 (y NFD) NO descomponen: sin esto,
// "Ødegaard", "Łukasz", "Çalhanoğlu" (ı sin punto) o "Großkreutz" no se
// encuentran escribiéndolos sin esos signos. Se aplica igual al indexar y al
// consultar para que ambos lados coincidan. ª y º (2ª RFEF, 1º) se descartan.
const PLEGADO_ESPECIAL = { "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i", "ħ": "h", "ª": "", "º": "" };
export function plegarEspeciales(s) {
  return String(s ?? "").replace(/[ßæœøłđðþıħªºÆŒØŁĐÐÞĦ]/g, (c) => {
    const l = c.toLowerCase();
    const r = PLEGADO_ESPECIAL[l] ?? c;
    return c === l ? r : r.charAt(0).toUpperCase() + r.slice(1);
  });
}

// Minúsculas, sin tildes (ñ -> n, ç -> c) y solo [a-z0-9]: lo mismo que hace
// el tokenizador de FTS5 (remove_diacritics 2) y la configuración es_unaccent
// de Postgres, y a la vez lo que garantiza que el término es seguro dentro de
// una expresión MATCH / tsquery (no hay comillas ni operadores posibles).
export function normalizarTexto(s) {
  return plegarEspeciales(String(s ?? "").toLowerCase())
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// "Valladolid vs. Lugo", "valladolid-lugo", "Real Madrid contra Barça"
// -> términos sueltos, sin stopwords, únicos, máximo 6.
export function terminosConsulta(q) {
  const vistos = new Set();
  const out = [];
  for (const t of normalizarTexto(String(q ?? "").slice(0, 120)).split(" ")) {
    if (t.length < 2 || STOPWORDS.has(t) || vistos.has(t)) continue;
    vistos.add(t);
    out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

// Sintaxis admitida además de las palabras sueltas:
//   "real madrid"   frase exacta (palabras seguidas y en orden)
//   -fichaje        excluye los artículos que contienen esa palabra
//   2-1, 0-0, 20:30 marcadores y horas: se buscan como frase ("2 1")
// Devuelve { terminos, frases, excluidos, vacio }.
export function analizarConsulta(q) {
  let resto = String(q ?? "").slice(0, 160);
  const frases = [];
  const excluidos = [];
  resto = resto.replace(/["“”«»]([^"“”«»]{2,100})["“”«»]/g, (_, f) => {
    const toks = normalizarTexto(f).split(" ").filter(Boolean);
    if (toks.length >= 2) { if (frases.length < 3) frases.push(toks.slice(0, 8)); return " "; }
    return ` ${f} `;
  });
  resto = resto.replace(/(^|\s)[-\u2212\u2013]([^\s"“”«»\-\u2212\u2013][^\s]*)/g, (_, pre, palabra) => {
    const t = normalizarTexto(palabra).split(" ")[0] || "";
    if (t.length >= 2 && !STOPWORDS.has(t) && excluidos.length < 3 && !excluidos.includes(t)) excluidos.push(t);
    return pre;
  });
  resto = resto.replace(/(^|[^\d])(\d{1,2})\s*[-\u2013\u2014:]\s*(\d{1,2})(?!\d)/g, (_, pre, a, b) => {
    if (frases.length < 3) frases.push([a, b]);
    return `${pre} `;
  });
  let terminos = terminosConsulta(resto);
  if (!terminos.length && !frases.length) {
    // Solo palabras vacías ("el", "de la"): mejor buscarlas tal cual que no dar nada.
    const vistos = new Set();
    terminos = normalizarTexto(resto).split(" ").filter((t) => t.length >= 2 && !vistos.has(t) && vistos.add(t)).slice(0, 3);
  }
  return { terminos, frases, excluidos, vacio: !terminos.length && !frases.length };
}

export function textoPlanoDeHtml(html) {
  const sinNada = String(html ?? "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " ";
    })
    .replace(/&amp;/gi, "&");
  return sinNada.replace(/\s+/g, " ").trim().slice(0, 100000);
}

// "club" puede ser un nombre o un array JSON de dos clubes (previa/crónica).
function clubComoTexto(club) {
  const s = String(club ?? "").trim();
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string").join(" ");
    } catch { /* texto plano */ }
  }
  return s;
}

// ---------- Erratas ----------

// Distancia de edición con transposiciones (optimal string alignment), con
// salida temprana cuando supera "max". Devuelve max + 1 si la rebasa.
export function distanciaDL(a, b, max) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = new Array(lb + 1).fill(0);
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    let minFila = cur[0];
    for (let j = 1; j <= lb; j++) {
      const coste = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + coste);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < minFila) minFila = v;
    }
    if (minFila > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb];
}

function esPrefijoDeAlguno(vocab, t) {
  for (const term of vocab.keys()) if (term.startsWith(t)) return true;
  return false;
}

// vocab: Map(término normalizado -> frecuencia). Solo corrige términos de 4+
// letras que no existan en el vocabulario ni sean prefijo de uno (lo que se
// está escribiendo a medias no es una errata). Tolerancia: 1 edición hasta 5
// letras, 2 a partir de 6. Entre candidatos a igual distancia gana el más
// frecuente. La palabra original se conserva como alternativa (OR).
export function corregirTerminos(terminos, vocab) {
  const items = [];
  const sug = [];
  let cambiado = false;
  for (const t of terminos) {
    const it = { t, alts: [] };
    let mostrado = t;
    if (t.length >= 4 && !vocab.has(t) && !esPrefijoDeAlguno(vocab, t)) {
      const max = t.length <= 5 ? 1 : 2;
      let mejor = max + 1;
      let cands = [];
      for (const [term, n] of vocab) {
        const d = distanciaDL(t, term, max);
        if (d > max) continue;
        if (d < mejor) { mejor = d; cands = [[term, n]]; }
        else if (d === mejor) cands.push([term, n]);
      }
      if (cands.length) {
        cands.sort((x, y) => y[1] - x[1]);
        it.alts = cands.slice(0, 2).map((c) => c[0]);
        mostrado = it.alts[0];
        cambiado = true;
      }
    }
    items.push(it);
    sug.push(mostrado);
  }
  return { items, cambiado, sugerencia: cambiado ? sug.join(" ") : null };
}

// ---------- Expresiones de consulta ----------

// Grupos de palabras equivalentes (en ambos sentidos): apodos de clubes y la
// doble forma "RFEF" / "Federación" de las categorías. Se amplían a mano.
const GRUPOS_SINONIMOS = [
  ["barca", "barcelona"],
  ["atleti", "atletico"],
  ["depor", "deportivo"],
  ["rfef", "federacion"],
];
const SINONIMOS = new Map();
for (const g of GRUPOS_SINONIMOS) for (const w of g) SINONIMOS.set(w, g.filter((x) => x !== w));

function conSinonimos(items) {
  return items.map((it) => {
    const alts = [];
    for (const w of [it.t, ...it.alts]) {
      if (!alts.includes(w) && w !== it.t) alts.push(w);
      for (const sin of SINONIMOS.get(w) || []) if (sin !== it.t && !alts.includes(sin)) alts.push(sin);
    }
    return { t: it.t, alts };
  });
}

function excluidosConSinonimos(excluidos) {
  const out = [];
  for (const w of excluidos || []) for (const x of [w, ...(SINONIMOS.get(w) || [])]) if (!out.includes(x)) out.push(x);
  return out;
}

// Singular probable de un plural español (solo FTS5, que no tiene stemmer;
// Postgres ya lo hace con su configuración española): goles -> gol,
// jugadores -> jugador, equipos -> equipo, jueces -> juez. Como las formas
// largas se buscan por prefijo, "jugador"* ya cubre jugador y jugadores.
function singularProbable(t) {
  let s = null;
  if (t.length >= 6 && t.endsWith("ces")) s = t.slice(0, -3) + "z";
  else if (t.length >= 5 && t.endsWith("es") && !/[aeiou]/.test(t[t.length - 3])) s = t.slice(0, -2);
  else if (t.length >= 4 && t.endsWith("s") && !t.endsWith("ss")) s = t.slice(0, -1);
  return s && s.length >= 3 && s !== t ? s : null;
}

// FTS5: (\"valladolid\"* OR \"valadolid\"*) AND \"lugo\"* AND \"2 1\" NOT (\"fichaje\").
// Los términos ya son [a-z0-9], así que las comillas son seguras. Prefijo solo
// con 3+ letras (y las raíces de 3 letras, exactas, para que \"goles\" encuentre
// \"gol\" sin traer \"golpe\").
export function construirMatchSqlite(items, modo, extra = {}) {
  const frag = (it) => {
    const partes = [it.t, ...it.alts].map((a) => `"${a}"${a.length >= 3 ? "*" : ""}`);
    for (const w of [it.t, ...it.alts]) {
      const sing = singularProbable(w);
      if (sing) partes.push(`"${sing}"${sing.length >= 4 ? "*" : ""}`);
    }
    const unicas = [...new Set(partes)];
    return unicas.length > 1 ? `(${unicas.join(" OR ")})` : unicas[0];
  };
  const fraseFts = (toks) => {
    const ult = toks[toks.length - 1];
    return `"${toks.join(" ")}"${ult.length >= 3 ? "*" : ""}`;
  };
  const piezas = [...items.map(frag), ...(extra.frases || []).map(fraseFts)];
  if (!piezas.length) return "";
  let expr = piezas.join(modo === "or" ? " OR " : " AND ");
  const ex = excluidosConSinonimos(extra.excluidos);
  if (ex.length) expr = `(${expr}) NOT (${ex.map((x) => `"${x}"`).join(" OR ")})`;
  return expr;
}

// tsquery: (valladolid:* | valadolid:*) & lugo:* & (real <-> madrid) & !(fichaje)
export function construirTsquery(items, modo, extra = {}) {
  const frag = (it) => {
    const partes = [it.t, ...it.alts].map((a) => `${a}${a.length >= 3 ? ":*" : ""}`);
    return partes.length > 1 ? `(${partes.join(" | ")})` : partes[0];
  };
  const fraseTs = (toks) => {
    const ult = toks[toks.length - 1];
    const cola = `${ult}${ult.length >= 3 ? ":*" : ""}`;
    return `(${[...toks.slice(0, -1), cola].join(" <-> ")})`;
  };
  const piezas = [...items.map(frag), ...(extra.frases || []).map(fraseTs)];
  if (!piezas.length) return "";
  let expr = piezas.join(modo === "or" ? " | " : " & ");
  const ex = excluidosConSinonimos(extra.excluidos);
  if (ex.length) expr = `(${expr}) & !(${ex.join(" | ")})`;
  return expr;
}

function construirExpresion(env, plan, items, modo) {
  const extra = { frases: plan.frases || [], excluidos: plan.excluidos || [] };
  const conSin = conSinonimos(items);
  return esRailway(env) ? construirTsquery(conSin, modo, extra) : construirMatchSqlite(conSin, modo, extra);
}

// ---------- Disponibilidad ----------

const MEMO = new Map();
async function memo(clave, ttlMs, cargar) {
  const e = MEMO.get(clave);
  if (e && e.exp > Date.now()) return e.valor;
  const valor = await cargar();
  MEMO.set(clave, { exp: Date.now() + ttlMs, valor });
  return valor;
}

async function leerFlagBackfill(env) {
  const f = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(FLAG_BACKFILL).first();
  return f?.value === "1";
}

// true solo si el índice existe Y está completo. Mientras no lo esté (migración
// sin aplicar, o backfill a medias) la ruta usa el LIKE de siempre, de modo que
// se puede desplegar el código antes que la migración sin perder resultados.
export async function busquedaFtsDisponible(env) {
  try {
    return await memo(esRailway(env) ? "disp:pg" : "disp:d1", 60000, async () => {
      if (esRailway(env)) {
        const r = await env.DB.prepare(
          "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'articles' AND column_name = 'busqueda_tsv'"
        ).first();
        return !!r;
      }
      const t = await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'articles_fts'").first();
      if (!t) return false;
      return await leerFlagBackfill(env);
    });
  } catch (err) {
    console.error("[busqueda] no se pudo comprobar el índice:", err?.message);
    return false;
  }
}

// ---------- Vocabulario ----------

async function leerVocabularioBD(env) {
  if (esRailway(env)) {
    const { results } = await env.DB.prepare(
      `SELECT word AS term, ndoc AS n FROM ts_stat($$SELECT to_tsvector('simple', unaccent(coalesce(titulo,'') || ' ' || coalesce(subtitulo,'') || ' ' || coalesce(club,'') || ' ' || coalesce(autor_nombre,''))) FROM articles WHERE publicado = 1$$) WHERE length(word) >= 3 ORDER BY ndoc DESC LIMIT 30000`
    ).all();
    return (results || []).map((r) => [r.term, Number(r.n)]);
  }
  const { results } = await env.DB.prepare("SELECT term, n FROM busqueda_vocab ORDER BY n DESC LIMIT 30000").all();
  return (results || []).map((r) => [r.term, Number(r.n)]);
}

// Memoria del isolate (10 min) -> KV (6 h) -> BD. Pensado para no gastar
// lecturas de D1: el vocabulario completo se lee unas pocas veces al día.
async function cargarVocabulario(env) {
  return memo("vocab", 10 * 60 * 1000, async () => {
    let pares = null;
    const kv = !esRailway(env) ? env.ELOTROFUTBOL_KV : null;
    if (kv) {
      try { const raw = await kv.get(KV_VOCAB, "json"); if (Array.isArray(raw)) pares = raw; } catch { /* sin KV */ }
    }
    if (!pares) {
      pares = await leerVocabularioBD(env);
      if (kv && pares.length) {
        try { await kv.put(KV_VOCAB, JSON.stringify(pares), { expirationTtl: 6 * 3600 }); } catch { /* no crítico */ }
      }
    }
    return new Map(pares);
  });
}

// ---------- Plan de búsqueda ----------
//
// Intentos, en orden, hasta que uno devuelva filas:
//   0  términos tal cual, todos obligatorios (AND)
//   1  con correcciones de erratas, AND           (solo si hay algo que corregir)
//   2  cualquier término (OR), ordenado por relevancia (solo con 2+ términos)
// Las frases entre comillas y las exclusiones (-palabra) valen en los tres.
export function planificarBusqueda(q, { corregir = true } = {}) {
  const { terminos, frases, excluidos, vacio } = analizarConsulta(q);
  return { terminos, frases, excluidos, vacio, corregir, items: terminos.map((t) => ({ t, alts: [] })), _corr: null };
}

export async function expresionParaIntento(env, plan, intento) {
  if (plan.vacio) return null;
  if (intento === 0) {
    return { intento: 0, modo: "and", expr: construirExpresion(env, plan, plan.items, "and"), corregido: null };
  }
  let items = plan.items;
  let sugerencia = null;
  if (plan.corregir && plan.terminos.length) {
    if (!plan._corr) {
      try { plan._corr = corregirTerminos(plan.terminos, await cargarVocabulario(env)); }
      catch (err) { console.error("[busqueda] vocabulario no disponible:", err?.message); plan._corr = { items: plan.items, cambiado: false, sugerencia: null }; }
    }
    items = plan._corr.items;
    sugerencia = plan._corr.sugerencia;
  }
  const hayCorreccion = !!sugerencia;
  if (intento === 1) {
    if (!hayCorreccion) return null; // nada que corregir: se salta al siguiente
    return { intento: 1, modo: "and", expr: construirExpresion(env, plan, items, "and"), corregido: sugerencia };
  }
  if (intento === 2) {
    if (plan.terminos.length + plan.frases.length < 2) return null;
    return { intento: 2, modo: "or", expr: construirExpresion(env, plan, items, "or"), corregido: sugerencia };
  }
  return null;
}

// ---------- Fragmentos SQL por motor ----------

// Devuelve el JOIN (subconsulta con id y puntuación), su bind y el ORDER BY
// por relevancia. Se inserta en la consulta de listado de GET /api/articles
// sustituyendo "FROM articles WHERE 1=1", así se reutilizan todos sus filtros,
// columnas y paginación. La puntuación pesa título/club sobre el cuerpo y la
// multiplica por un factor de frescura entre 1 (hoy) y 0,5 (muy antiguo, vida
// media ~4 meses): el texto manda y la recencia desempata, sin hundir del todo
// una coincidencia exacta en el título solo por ser vieja.
export function fragmentosRanking(env, expr) {
  if (esRailway(env)) {
    return {
      join: `JOIN (SELECT a.id AS fid, ts_rank_cd(a.busqueda_tsv, tq, 32) AS r FROM articles a, to_tsquery('es_unaccent', ?) AS tq WHERE a.busqueda_tsv @@ tq) AS f ON f.fid = articles.id`,
      binds: [expr],
      order: `f.r * (0.5 + 0.5 / (1.0 + GREATEST(0, current_date - (CASE WHEN articles.fecha_publicacion ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])' THEN substring(articles.fecha_publicacion from 1 for 10)::date ELSE current_date END)) / 120.0)) DESC, articles.id DESC`,
    };
  }
  return {
    join: `JOIN (SELECT rowid AS fid, bm25(articles_fts, 10.0, 4.0, 6.0, 3.0, 2.0, 1.0, 0.0) AS r FROM articles_fts WHERE articles_fts MATCH ?) AS f ON f.fid = articles.id`,
    binds: [expr],
    order: `f.r * (0.5 + 0.5 / (1.0 + MAX(0.0, COALESCE(julianday('now') - julianday(articles.fecha_publicacion), 0.0)) / 120.0)) ASC, articles.id DESC`,
  };
}

function escaparHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function extractoSeguro(s) {
  if (!s) return "";
  return escaparHtml(s).split(MARCA_INI).join("<mark>").split(MARCA_FIN).join("</mark>");
}

// Fragmento con las palabras buscadas resaltadas, solo para los ids de la página.
// Devuelve Map(id -> html seguro).
export async function extractosBusqueda(env, ids, expr) {
  const out = new Map();
  if (!ids.length || !expr) return out;
  const ph = ids.map(() => "?").join(",");
  try {
    let filas;
    if (esRailway(env)) {
      ({ results: filas } = await env.DB.prepare(
        `SELECT id, ts_headline('es_unaccent', regexp_replace(contenido, '<[^>]*>', ' ', 'g'), to_tsquery('es_unaccent', ?), 'StartSel=${MARCA_INI}, StopSel=${MARCA_FIN}, MaxWords=26, MinWords=12, ShortWord=2, MaxFragments=1') AS s FROM articles WHERE id IN (${ph})`
      ).bind(expr, ...ids).all());
    } else {
      ({ results: filas } = await env.DB.prepare(
        `SELECT rowid AS id, snippet(articles_fts, 5, '${MARCA_INI}', '${MARCA_FIN}', '…', 26) AS s FROM articles_fts WHERE articles_fts MATCH ? AND rowid IN (${ph})`
      ).bind(expr, ...ids).all());
    }
    for (const f of filas || []) out.set(Number(f.id), extractoSeguro(f.s));
  } catch (err) {
    console.error("[busqueda] extractos no disponibles:", err?.message);
  }
  return out;
}

// Recuento de coincidencias por categoría y tipo, para los filtros de la
// página de resultados. Cuenta todas las coincidencias publicadas, con
// independencia de los demás filtros activos.
export async function facetasBusqueda(env, expr, { admin = false, fusionSql = "" } = {}) {
  if (!expr) return { categorias: {}, tipos: {} };
  const pub = admin ? "" : ` AND articles.publicado = 1${fusionSql}`;
  const sub = esRailway(env)
    ? `(SELECT a.id AS fid FROM articles a, to_tsquery('es_unaccent', ?) AS tq WHERE a.busqueda_tsv @@ tq)`
    : `(SELECT rowid AS fid FROM articles_fts WHERE articles_fts MATCH ?)`;
  const { results } = await env.DB.prepare(
    `SELECT articles.categoria AS categoria, articles.tipo AS tipo, COUNT(*) AS n FROM articles JOIN ${sub} AS f ON f.fid = articles.id WHERE 1=1${pub} GROUP BY articles.categoria, articles.tipo`
  ).bind(expr).all();
  const categorias = {}, tipos = {};
  for (const r of results || []) {
    const n = Number(r.n);
    categorias[r.categoria] = (categorias[r.categoria] || 0) + n;
    tipos[r.tipo] = (tipos[r.tipo] || 0) + n;
  }
  return { categorias, tipos };
}

// ---------- Indexación (solo D1; en PG lo hace el trigger) ----------

function tokensVocabulario(textos) {
  const set = new Set();
  for (const t of normalizarTexto(textos.join(" ")).split(" ")) {
    if (t.length >= 3 && !STOPWORDS.has(t)) set.add(t);
    if (set.size >= 80) break;
  }
  return [...set];
}

export async function indexarArticuloBusqueda(env, id) {
  if (esRailway(env)) return { omitido: true };
  try {
    const a = await env.DB.prepare(
      `SELECT id, titulo, subtitulo, contenido, club, autor_nombre, coautor_nombre, updated_at, publicado,
              titulo_eu, subtitulo_eu, titulo_ca, subtitulo_ca, titulo_gl, subtitulo_gl, titulo_en, subtitulo_en
       FROM articles WHERE id = ?`
    ).bind(id).first();
    if (!a) { await eliminarArticuloBusqueda(env, id); return { eliminado: true }; }

    const club = clubComoTexto(a.club);
    const autor = [a.autor_nombre, a.coautor_nombre].filter(Boolean).join(" ");
    const extra = [a.titulo_eu, a.subtitulo_eu, a.titulo_ca, a.subtitulo_ca, a.titulo_gl, a.subtitulo_gl, a.titulo_en, a.subtitulo_en]
      .filter(Boolean).join(" ");
    const cuerpo = textoPlanoDeHtml(a.contenido);
    const pl = plegarEspeciales;

    const stmts = [
      env.DB.prepare("DELETE FROM articles_fts WHERE rowid = ?").bind(a.id),
      env.DB.prepare(
        "INSERT INTO articles_fts (rowid, titulo, subtitulo, club, autor, extra, cuerpo, actualizado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(a.id, pl(a.titulo || ""), pl(a.subtitulo || ""), pl(club), pl(autor), pl(extra), pl(cuerpo), a.updated_at ?? null),
    ];
    // El vocabulario de erratas solo sale de artículos publicados: si no, una
    // palabra de un borrador podría asomar como "Mostrando resultados para…".
    for (const t of a.publicado ? tokensVocabulario([a.titulo, a.subtitulo, club, autor]) : []) {
      stmts.push(env.DB.prepare(
        "INSERT INTO busqueda_vocab (term, n) VALUES (?, 1) ON CONFLICT(term) DO UPDATE SET n = MIN(n + 1, 1000)"
      ).bind(t));
    }
    await env.DB.batch(stmts);
    return { ok: true };
  } catch (err) {
    // Nunca debe romper la escritura del artículo: el cron lo reconcilia.
    console.error("[busqueda] no se pudo indexar el artículo", id, err?.message);
    return { ok: false, error: err?.message };
  }
}

export async function eliminarArticuloBusqueda(env, id) {
  if (esRailway(env)) return;
  try { await env.DB.prepare("DELETE FROM articles_fts WHERE rowid = ?").bind(id).run(); }
  catch (err) { console.error("[busqueda] no se pudo quitar del índice", id, err?.message); }
}

// Indexa lo que falta o está desfasado. Mientras el backfill inicial no haya
// terminado revisa TODA la tabla (y al acabar marca el flag, con lo que la
// búsqueda pasa a FTS); después solo mira lo tocado en los últimos 3 días, y
// solo en el tick horario (soloBackfill = false), para no gastar lecturas de D1.
// "limite" por defecto 20: cada artículo cuesta 2 subrequests a D1 y un Worker
// del plan gratuito tiene un tope de 50 por invocación.
export async function reconciliarIndiceBusqueda(env, { limite = 20, forzarCompleto = false, soloBackfill = false } = {}) {
  if (esRailway(env)) return { omitido: true };
  try {
    const existe = await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'articles_fts'").first();
    if (!existe) return { omitido: true, motivo: "migración sin aplicar" };
    const hecho = await leerFlagBackfill(env);
    if (hecho && soloBackfill && !forzarCompleto) return { omitido: true, motivo: "índice completo" };
    const completo = forzarCompleto || !hecho;
    const lote = Math.max(1, Math.min(Number(limite) || 20, 40));
    const { results } = await env.DB.prepare(
      `SELECT a.id AS id FROM articles a LEFT JOIN articles_fts f ON f.rowid = a.id
       WHERE (f.rowid IS NULL OR f.actualizado IS NOT a.updated_at)
         ${completo ? "" : "AND a.updated_at >= datetime('now', '-3 days')"}
       ORDER BY a.id DESC LIMIT ?`
    ).bind(lote).all();
    const pendientes = results || [];
    for (const r of pendientes) await indexarArticuloBusqueda(env, r.id);
    let listo = false;
    if (completo && pendientes.length < lote) {
      // Se ha vaciado la cola con este lote: el índice está completo.
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, '1', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')"
      ).bind(FLAG_BACKFILL).run();
      MEMO.delete("disp:d1");
      listo = true;
    }
    return { procesados: pendientes.length, completo, listo };
  } catch (err) {
    console.error("[busqueda] reconciliación fallida:", err?.message);
    return { ok: false, error: err?.message };
  }
}

// Vacía el índice y vuelve a empezar (la búsqueda usa el LIKE hasta que
// termine el backfill). Para reconstruir tras un `wrangler d1 export`/import.
export async function reiniciarIndiceBusqueda(env) {
  if (esRailway(env)) return { omitido: true };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM articles_fts"),
    env.DB.prepare("DELETE FROM busqueda_vocab"),
    env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, '0', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = datetime('now')"
    ).bind(FLAG_BACKFILL),
  ]);
  MEMO.clear();
  return { ok: true };
}
