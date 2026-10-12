// Aviso de "previa/crónica del mismo partido ya subida a redes".
// Ejecuta el handler REAL (src/index.js) contra una base SQLite en memoria que imita D1. Uso:
//   node --test tests/compartir-redes.test.mjs
//   WORKER_ENTRY=../worker-secondary/src/index.js node --test tests/compartir-redes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const entrada = process.env.WORKER_ENTRY
  ? new URL(process.env.WORKER_ENTRY, import.meta.url).href
  : new URL("../src/index.js", import.meta.url).href;
const worker = (await import(entrada)).default;

const JWT_SECRET = "secreto-de-pruebas-0123456789abcdef";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, salt TEXT, nombre TEXT, rol TEXT DEFAULT 'redactor', activo INTEGER DEFAULT 1, email TEXT, avatar_url TEXT, avatar_foco TEXT, categorias_fijas TEXT, nivel INTEGER DEFAULT 1,
  totp_secret TEXT, totp_activo INTEGER NOT NULL DEFAULT 0, totp_ultimo_paso INTEGER, totp_recovery TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, user_agent TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')), last_seen_at TEXT DEFAULT (datetime('now')), revoked_at TEXT);
CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER, usuario_nombre TEXT, usuario_rol TEXT, accion TEXT, entidad TEXT, entidad_id TEXT, descripcion TEXT, detalle TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE articles (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, titulo TEXT, tipo TEXT, resultado_id INTEGER);
`);
const limpiar = (a) => a.map((v) => (v === undefined ? null : v));
const DB = {
  prepare(sql) {
    const st = sqlite.prepare(sql);
    const mk = (args) => ({
      first: async () => st.get(...limpiar(args)) ?? null,
      all: async () => ({ results: st.all(...limpiar(args)) }),
      run: async () => { const r = st.run(...limpiar(args)); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    });
    return { ...mk([]), bind: (...args) => mk(args) };
  },
};
const env = { DB, JWT_SECRET };
const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}) };

async function api(ruta, { method = "GET", body, token } = {}) {
  const req = new Request("https://api.test" + ruta, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, ctx);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function pbkdf2(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256));
  return [...bits].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const PW = "una-clave-larga-1";
async function tokenDe(username, rol) {
  const salt = "00112233445566778899aabbccddeeff";
  sqlite.prepare("INSERT INTO users (username, password_hash, salt, nombre, rol, email) VALUES (?,?,?,?,?,?)")
    .run(username, await pbkdf2(PW, salt), salt, "Nombre " + username, rol, username + "@x.es");
  const l = await api("/api/login", { method: "POST", body: { username, password: PW } });
  assert.ok(l.data.token, "el redactor entra solo con contraseña");
  return l.data.token;
}
const art = (slug, titulo, tipo, resultado_id) =>
  Number(sqlite.prepare("INSERT INTO articles (slug, titulo, tipo, resultado_id) VALUES (?,?,?,?)").run(slug, titulo, tipo, resultado_id).lastInsertRowid);
const filasLog = (id) => sqlite.prepare("SELECT * FROM activity_log WHERE accion = 'compartir_redes' AND entidad_id = ?").all(String(id)).length;

const e = {};
test("hace falta sesión", async () => {
  assert.equal((await api("/api/compartir-redes/estado?id=1")).status, 401);
  assert.equal((await api("/api/compartir-redes/registrar", { method: "POST", body: { id: 1 } })).status, 401);
});

test("sin nada subido todavía: no hay aviso", async () => {
  e.token = await tokenDe("redac", "redactor");
  e.previaA = art("previa-a", "Previa A", "previa", 7);
  e.previaB = art("previa-b", "Previa B", "previa", 7);
  e.cronica7 = art("cronica-7", "Crónica 7", "cronica", 7);
  e.previa8 = art("previa-8", "Previa otro partido", "previa", 8);
  e.noticia = art("noticia-x", "Una noticia", "noticia", 7);
  const r = await api(`/api/compartir-redes/estado?id=${e.previaB}`, { token: e.token });
  assert.deepEqual({ aplica: r.data.aplica, ya_subida: r.data.ya_subida }, { aplica: true, ya_subida: false });
});

test("al subir la previa A se anota una sola vez (sin filas repetidas)", async () => {
  const r1 = await api("/api/compartir-redes/registrar", { method: "POST", body: { id: e.previaA }, token: e.token });
  assert.deepEqual({ ok: r1.data.ok, registrado: r1.data.registrado }, { ok: true, registrado: true });
  const r2 = await api("/api/compartir-redes/registrar", { method: "POST", body: { id: e.previaA }, token: e.token });
  assert.equal(r2.data.registrado, false);
  assert.equal(filasLog(e.previaA), 1);
});

test("otra previa del MISMO partido avisa de que ya no hace falta", async () => {
  const r = await api(`/api/compartir-redes/estado?id=${e.previaB}`, { token: e.token });
  assert.equal(r.data.ya_subida, true);
  assert.equal(r.data.propia, false);
  assert.equal(r.data.titulo, "Previa A");
  assert.equal(r.data.articulo_id, e.previaA);
  assert.equal(r.data.por, "Nombre redac");
  assert.ok(r.data.subida_at);
});

test("la propia previa ya subida también avisa, marcada como propia", async () => {
  const r = await api(`/api/compartir-redes/estado?id=${e.previaA}`, { token: e.token });
  assert.equal(r.data.ya_subida, true);
  assert.equal(r.data.propia, true);
});

test("no avisa para otro tipo (crónica) ni para otro partido", async () => {
  const c = await api(`/api/compartir-redes/estado?id=${e.cronica7}`, { token: e.token });
  assert.equal(c.data.ya_subida, false);
  const o = await api(`/api/compartir-redes/estado?id=${e.previa8}`, { token: e.token });
  assert.equal(o.data.ya_subida, false);
});

test("una noticia normal no aplica y no se registra", async () => {
  const s = await api(`/api/compartir-redes/estado?id=${e.noticia}`, { token: e.token });
  assert.equal(s.data.aplica, false);
  const r = await api("/api/compartir-redes/registrar", { method: "POST", body: { id: e.noticia }, token: e.token });
  assert.equal(r.data.registrado, false);
  assert.equal(filasLog(e.noticia), 0);
});

test("funciona también por slug (justo tras publicar la API solo da el slug)", async () => {
  const cron = art("cronica-9a", "Crónica 9a", "cronica", 9);
  const cron2 = art("cronica-9b", "Crónica 9b", "cronica", 9);
  const r = await api("/api/compartir-redes/registrar", { method: "POST", body: { slug: "cronica-9a" }, token: e.token });
  assert.equal(r.data.registrado, true);
  const s = await api("/api/compartir-redes/estado?slug=cronica-9b", { token: e.token });
  assert.equal(s.data.ya_subida, true);
  assert.equal(s.data.titulo, "Crónica 9a");
  assert.equal(filasLog(cron), 1);
  assert.equal(filasLog(cron2), 0);
});

test("artículo inexistente: sin aviso y sin error", async () => {
  const r = await api("/api/compartir-redes/estado?id=99999", { token: e.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.ya_subida, false);
});
