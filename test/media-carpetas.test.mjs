// Carpetas del contenido privado (Fase 1): crear/listar carpetas y guardarlas al subir.
// Ejecuta el handler REAL (src/index.js) contra una base SQLite en memoria que imita D1. Uso:
//   node --test tests/media-carpetas.test.mjs
//   WORKER_ENTRY=../worker-secondary/src/index.js node --test tests/media-carpetas.test.mjs
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
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, nombre TEXT, rol TEXT DEFAULT 'redactor', activo INTEGER DEFAULT 1, email TEXT, avatar_url TEXT, nivel INTEGER DEFAULT 1);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, user_agent TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')), last_seen_at TEXT DEFAULT (datetime('now')), revoked_at TEXT);
CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER, usuario_nombre TEXT, usuario_rol TEXT, accion TEXT, entidad TEXT, entidad_id TEXT, descripcion TEXT, detalle TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE media (id INTEGER PRIMARY KEY AUTOINCREMENT, cloudinary_public_id TEXT UNIQUE NOT NULL, cloudinary_resource_type TEXT NOT NULL, cloudinary_url TEXT NOT NULL, titulo TEXT NOT NULL, descripcion TEXT, tipo TEXT NOT NULL, nombre_archivo TEXT NOT NULL, content_type TEXT NOT NULL, tamano_bytes INTEGER NOT NULL, autor_id INTEGER, autor_nombre TEXT, club TEXT, hash_archivo TEXT, portada_segundo REAL, portada_foco TEXT, visibilidad TEXT NOT NULL DEFAULT 'publico', created_at TEXT NOT NULL DEFAULT (datetime('now')));
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

async function api(ruta, { method = "GET", body, token, form } = {}) {
  const req = new Request("https://api.test" + ruta, {
    method,
    headers: { ...(form ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const res = await worker.fetch(req, env, ctx);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function jwt(payload) {
  const data = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ ...payload, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return data + "." + Buffer.from(new TextEncoder().encode(String.fromCharCode(...firma))).toString("base64url");
}
// Los admins exigen 2FA en el login: se firma el token directamente (tfa: true).
async function tokenDe(username, rol) {
  const r = sqlite.prepare("INSERT INTO users (username, nombre, rol, email) VALUES (?,?,?,?)")
    .run(username, "Nombre " + username, rol, username + "@x.es");
  return jwt({ uid: Number(r.lastInsertRowid), rol, nombre: "Nombre " + username, tfa: true });
}
const subirEnlace = (token, enlace, extra = {}) => {
  const f = new FormData();
  f.set("enlaceExterno", enlace);
  f.set("enlaceTipo", "video");
  f.set("enlaceTamano", "1000");
  f.set("titulo", "Vídeo pesado");
  f.set("avisoLote", "1");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return api("/api/media", { method: "POST", token, form: f });
};

const e = {};

test("sin sesión no se listan ni se crean carpetas", async () => {
  assert.equal((await api("/api/media/carpetas")).status, 401);
  assert.equal((await api("/api/media/carpetas", { method: "POST", body: { nombre: "X" } })).status, 401);
});

test("sin la migración aplicada: la lista llega vacía y crear avisa", async () => {
  e.admin = await tokenDe("admin1", "admin");
  e.redac = await tokenDe("redac1", "redactor");
  const l = await api("/api/media/carpetas", { token: e.admin });
  assert.equal(l.status, 200);
  assert.deepEqual(l.data.carpetas, []);
  assert.equal(l.data.migracion_pendiente, true);
  const c = await api("/api/media/carpetas", { method: "POST", token: e.admin, body: { nombre: "Entrevistas" } });
  assert.equal(c.status, 409, "409 y no 5xx: un 5xx dispararía el failover a Railway");
  assert.match(c.data.error, /migracion_media_carpetas/);
  // Y subir con carpeta tampoco rompe sin migración: se avisa antes de subir nada.
  const s = await subirEnlace(e.admin, "https://www.mediafire.com/file/abc/v.mp4", { carpeta_id: "1" });
  assert.equal(s.status, 409);
});

test("con la migración: crear, repetir (sin distinguir mayúsculas) y validar nombre", async () => {
  sqlite.exec(`
    CREATE TABLE media_carpetas (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, creada_por_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE UNIQUE INDEX idx_media_carpetas_nombre ON media_carpetas(LOWER(nombre));
    ALTER TABLE media ADD COLUMN carpeta_id INTEGER REFERENCES media_carpetas(id) ON DELETE SET NULL;
  `);
  const a = await api("/api/media/carpetas", { method: "POST", token: e.redac, body: { nombre: "  Entrevistas   pretemporada " } });
  assert.equal(a.status, 201);
  assert.equal(a.data.carpeta.nombre, "Entrevistas pretemporada", "se compactan los espacios");
  assert.equal(a.data.existente, false);
  e.carpetaA = a.data.carpeta.id;
  const b = await api("/api/media/carpetas", { method: "POST", token: e.admin, body: { nombre: "ENTREVISTAS PRETEMPORADA" } });
  assert.equal(b.status, 200);
  assert.equal(b.data.existente, true);
  assert.equal(b.data.carpeta.id, e.carpetaA, "devuelve la misma, no crea otra");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM media_carpetas").get().n, 1);
  assert.equal((await api("/api/media/carpetas", { method: "POST", token: e.admin, body: { nombre: "   " } })).status, 400);
  assert.equal((await api("/api/media/carpetas", { method: "POST", token: e.admin, body: { nombre: "x".repeat(61) } })).status, 400);
  const log = sqlite.prepare("SELECT COUNT(*) n FROM activity_log WHERE accion = 'crear_carpeta_media'").get().n;
  assert.equal(log, 1, "solo se anota la creación real");
});

test("el enlace externo (siempre privado) guarda la carpeta; una carpeta inexistente se rechaza", async () => {
  const ok = await subirEnlace(e.redac, "https://www.mediafire.com/file/aaa/v1.mp4", { carpeta_id: String(e.carpetaA) });
  assert.equal(ok.status, 200);
  const sin = await subirEnlace(e.redac, "https://www.mediafire.com/file/bbb/v2.mp4");
  assert.equal(sin.status, 200);
  const mala = await subirEnlace(e.redac, "https://www.mediafire.com/file/ccc/v3.mp4", { carpeta_id: "999" });
  assert.equal(mala.status, 400);
  assert.match(mala.data.error, /ya no existe/);
  const basura = await subirEnlace(e.redac, "https://www.mediafire.com/file/ddd/v4.mp4", { carpeta_id: "abc" });
  assert.equal(basura.status, 400);
  const filas = sqlite.prepare("SELECT cloudinary_url u, carpeta_id c, visibilidad v FROM media ORDER BY id").all();
  assert.equal(filas.length, 2, "lo rechazado no se guarda");
  assert.equal(filas[0].c, e.carpetaA);
  assert.equal(filas[0].v, "privado");
  assert.equal(filas[1].c, null);
});

test("subida de archivo público: la carpeta se ignora (no valida ni guarda)", async () => {
  // Un archivo vacío falla DESPUÉS de leer visibilidad y carpeta: si la carpeta
  // inexistente se validara en público, daría 400 "ya no existe" en vez de "vacío".
  const f = new FormData();
  f.set("archivo", new File([], "a.jpg", { type: "image/jpeg" }));
  f.set("titulo", "Foto"); f.set("visibilidad", "publico"); f.set("carpeta_id", "999");
  const r = await api("/api/media", { method: "POST", token: e.redac, form: f });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /vacío/);
});

test("listado: cada archivo trae su carpeta_id; el contador de carpetas respeta quién mira", async () => {
  const lista = await api("/api/media", { token: e.admin });
  assert.equal(lista.status, 200);
  const conCarpeta = lista.data.media.find((m) => m.carpeta_id === e.carpetaA);
  assert.ok(conCarpeta, "el archivo de la carpeta sale con carpeta_id");
  assert.equal(conCarpeta.visibilidad, "privado", "la consulta principal sigue trayendo visibilidad");
  assert.equal(lista.data.media.find((m) => m.carpeta_id === null).visibilidad, "privado");

  const admin = await api("/api/media/carpetas", { token: e.admin });
  assert.equal(admin.data.carpetas.find((c) => c.id === e.carpetaA).total, 1);
  const otra = await tokenDe("redac2", "redactor");
  const ajeno = await api("/api/media/carpetas", { token: otra });
  assert.equal(ajeno.data.carpetas.find((c) => c.id === e.carpetaA).total, 0, "no cuenta lo que subió otra persona");
  const mia = await api("/api/media/carpetas", { token: e.redac });
  assert.equal(mia.data.carpetas.find((c) => c.id === e.carpetaA).total, 1);
});

// ---------------- Fase 2: gestionar carpetas y mover archivos ----------------
sqlite.exec(`
CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY, equipo_local TEXT, equipo_visitante TEXT, slug TEXT);
CREATE TABLE IF NOT EXISTS match_gallery (id INTEGER PRIMARY KEY AUTOINCREMENT, result_id INTEGER, media_id INTEGER, orden INTEGER, vinculado_por_id INTEGER, equipo TEXT);
`);
const nuevoMedia = (autorId, { visibilidad = "privado", carpeta = null, titulo = "Archivo" } = {}) => {
  const n = sqlite.prepare("SELECT COALESCE(MAX(id),0)+1 n FROM media").get().n;
  const r = sqlite.prepare(
    "INSERT INTO media (cloudinary_public_id, cloudinary_resource_type, cloudinary_url, titulo, tipo, nombre_archivo, content_type, tamano_bytes, autor_id, visibilidad, carpeta_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run(`pid-${n}`, "image", `https://res.cloudinary.com/x/image/upload/v1/pid-${n}.jpg`, titulo, "foto", `f${n}.jpg`, "image/jpeg", 10, autorId, visibilidad, carpeta);
  return Number(r.lastInsertRowid);
};
const carpetaDe = (id) => sqlite.prepare("SELECT carpeta_id c FROM media WHERE id = ?").get(id).c;
const uidDe = (nombreUsuario) => sqlite.prepare("SELECT id FROM users WHERE username = ?").get(nombreUsuario).id;

test("renombrar carpeta: solo admins, sin duplicados y se puede cambiar solo mayúsculas", async () => {
  const c = await api("/api/media/carpetas", { method: "POST", token: e.admin, body: { nombre: "Galas" } });
  e.carpetaB = c.data.carpeta.id;
  const ruta = (id) => `/api/media/carpetas/${id}`;
  assert.equal((await api(ruta(e.carpetaB), { method: "PUT", token: e.redac, body: { nombre: "Otra" } })).status, 403);
  assert.equal((await api(ruta(e.carpetaB), { method: "PUT", body: { nombre: "Otra" } })).status, 401);
  assert.equal((await api(ruta(e.carpetaB), { method: "PUT", token: e.admin, body: { nombre: "  " } })).status, 400);
  assert.equal((await api(ruta(e.carpetaB), { method: "PUT", token: e.admin, body: { nombre: "x".repeat(61) } })).status, 400);
  assert.equal((await api(ruta(99999), { method: "PUT", token: e.admin, body: { nombre: "Otra" } })).status, 404);
  const dup = await api(ruta(e.carpetaB), { method: "PUT", token: e.admin, body: { nombre: "entrevistas PRETEMPORADA" } });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /Ya existe/);
  const mayus = await api(ruta(e.carpetaB), { method: "PUT", token: e.admin, body: { nombre: "GALAS" } });
  assert.equal(mayus.status, 200, "cambiar solo mayúsculas de la misma carpeta no es un duplicado");
  const ok = await api(ruta(e.carpetaB), { method: "PUT", token: e.admin, body: { nombre: "  Galas   2026 " } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.carpeta.nombre, "Galas 2026");
  assert.equal(sqlite.prepare("SELECT nombre FROM media_carpetas WHERE id = ?").get(e.carpetaB).nombre, "Galas 2026");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM activity_log WHERE accion = 'renombrar_carpeta_media'").get().n, 2);
});

test("mover varios: un redactor solo mueve lo suyo y privado; un admin mueve todo lo privado", async () => {
  const redacId = uidDe("redac1");
  const otroId = uidDe("redac2");
  e.mioA = nuevoMedia(redacId);
  e.mioB = nuevoMedia(redacId);
  e.mioPublico = nuevoMedia(redacId, { visibilidad: "publico" });
  e.ajeno = nuevoMedia(otroId);
  const mover = (token, ids, carpeta_id) => api("/api/media/mover", { method: "POST", token, body: { ids, carpeta_id } });

  assert.equal((await mover(undefined, [e.mioA], e.carpetaB)).status, 401);
  assert.equal((await mover(e.redac, [], e.carpetaB)).status, 400);
  assert.equal((await mover(e.redac, [e.mioA], 99999)).status, 400, "carpeta inexistente");
  assert.equal(carpetaDe(e.mioA), null, "lo rechazado no mueve nada");

  const r = await mover(e.redac, [e.mioA, e.mioB, e.mioPublico, e.ajeno], e.carpetaB);
  assert.equal(r.status, 200);
  assert.equal(r.data.movidos, 2);
  assert.equal(r.data.omitidos, 2, "el público y el ajeno se omiten");
  assert.equal(carpetaDe(e.mioA), e.carpetaB);
  assert.equal(carpetaDe(e.mioB), e.carpetaB);
  assert.equal(carpetaDe(e.mioPublico), null, "el público nunca tiene carpeta");
  assert.equal(carpetaDe(e.ajeno), null, "no puede mover lo de otra persona");

  const admin = await mover(e.admin, [e.ajeno, e.mioPublico], e.carpetaB);
  assert.equal(admin.data.movidos, 1, "el admin mueve lo ajeno pero tampoco lo público");
  assert.equal(carpetaDe(e.ajeno), e.carpetaB);

  const fuera = await mover(e.redac, [e.mioA], "");
  assert.equal(fuera.data.movidos, 1, "vacío = Sin carpeta");
  assert.equal(carpetaDe(e.mioA), null);
});

test("editar contenido: carpeta solo en privado; pasar a público la desvincula", async () => {
  const editar = (token, id, extra) => api(`/api/media/${id}`, { method: "PUT", token, body: { titulo: "T", ...extra } });
  // Privado + carpeta: se guarda.
  assert.equal((await editar(e.redac, e.mioA, { visibilidad: "privado", carpeta_id: String(e.carpetaB) })).status, 200);
  assert.equal(carpetaDe(e.mioA), e.carpetaB);
  // Privado sin mandar carpeta_id: se conserva la que tenía.
  assert.equal((await editar(e.redac, e.mioA, { visibilidad: "privado" })).status, 200);
  assert.equal(carpetaDe(e.mioA), e.carpetaB);
  // Carpeta inexistente: 400 y no se guarda NADA de la edición.
  const mala = await editar(e.redac, e.mioA, { visibilidad: "privado", titulo: "Cambiado", carpeta_id: "99999" });
  assert.equal(mala.status, 400);
  assert.equal(sqlite.prepare("SELECT titulo t FROM media WHERE id = ?").get(e.mioA).t, "T");
  assert.equal(carpetaDe(e.mioA), e.carpetaB);
  // Privado -> público: se desvincula, aunque llegue una carpeta.
  assert.equal((await editar(e.redac, e.mioA, { visibilidad: "publico", carpeta_id: String(e.carpetaB) })).status, 200);
  assert.equal(carpetaDe(e.mioA), null, "público ignora la carpeta");
  assert.equal(sqlite.prepare("SELECT visibilidad v FROM media WHERE id = ?").get(e.mioA).v, "publico");
  // Público -> privado eligiendo carpeta.
  assert.equal((await editar(e.redac, e.mioA, { visibilidad: "privado", carpeta_id: String(e.carpetaA) })).status, 200);
  assert.equal(carpetaDe(e.mioA), e.carpetaA);
  // Quitar carpeta explícitamente.
  assert.equal((await editar(e.redac, e.mioA, { visibilidad: "privado", carpeta_id: "" })).status, 200);
  assert.equal(carpetaDe(e.mioA), null);
});

test("eliminar carpeta: solo admins; los archivos NO se borran, pasan a Sin carpeta", async () => {
  const c = await api("/api/media/carpetas", { method: "POST", token: e.admin, body: { nombre: "Temporal" } });
  const id = c.data.carpeta.id;
  const redacId = uidDe("redac1");
  const a = nuevoMedia(redacId, { carpeta: id });
  const b = nuevoMedia(redacId, { carpeta: id });
  const antes = sqlite.prepare("SELECT COUNT(*) n FROM media").get().n;

  assert.equal((await api(`/api/media/carpetas/${id}`, { method: "DELETE", token: e.redac })).status, 403);
  assert.equal((await api(`/api/media/carpetas/${id}`, { method: "DELETE" })).status, 401);
  assert.equal((await api("/api/media/carpetas/99999", { method: "DELETE", token: e.admin })).status, 404);

  const r = await api(`/api/media/carpetas/${id}`, { method: "DELETE", token: e.admin });
  assert.equal(r.status, 200);
  assert.equal(r.data.archivos_liberados, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM media_carpetas WHERE id = ?").get(id).n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM media").get().n, antes, "no se borra ningún archivo");
  assert.equal(carpetaDe(a), null);
  assert.equal(carpetaDe(b), null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM activity_log WHERE accion = 'eliminar_carpeta_media'").get().n, 1);
  // Y el nombre vuelve a estar libre.
  assert.equal((await api("/api/media/carpetas", { method: "POST", token: e.admin, body: { nombre: "temporal" } })).status, 201);
});
