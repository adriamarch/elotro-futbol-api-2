#!/usr/bin/env node
// Compara principal y secundaria con TU token de admin/redactor.
// 1) Abre el panel con sesión iniciada, F12 > Consola:  localStorage.getItem("eof_token")
// 2) node scripts/diagnostico-failover.mjs <TOKEN>
const token = process.argv[2];
if (!token) { console.error("Uso: node scripts/diagnostico-failover.mjs <TOKEN>"); process.exit(2); }
const BASES = {
  PRINCIPAL: "https://api.elotrofutbol.media",
  SECUNDARIA: process.env.SECONDARY_API || "https://elotro-futbol-api-production.up.railway.app",
};
const h = { Authorization: "Bearer " + token, Accept: "application/json" };
async function pedir(base, ruta) {
  try {
    const r = await fetch(base + ruta, { headers: h, signal: AbortSignal.timeout(15000) });
    const ct = r.headers.get("content-type") || "";
    const cuerpo = ct.includes("json") ? await r.json().catch(() => null) : await r.text().catch(() => "");
    return { status: r.status, cuerpo };
  } catch (e) { return { status: "ERROR", cuerpo: String(e.message || e) }; }
}
for (const [nombre, base] of Object.entries(BASES)) {
  console.log("\n===== " + nombre + " (" + base + ") =====");
  const me = await pedir(base, "/api/me");
  console.log("/api/me ->", me.status, me.status === 200 ? "OK (token aceptado)" : "TOKEN RECHAZADO O ERROR: " + JSON.stringify(me.cuerpo).slice(0, 160));
  const lista = await pedir(base, "/api/articles?admin=1&limit=2000");
  const arts = lista.cuerpo && lista.cuerpo.articles;
  if (Array.isArray(arts)) {
    const rev = arts.filter((a) => !a.publicado && !a.programado_para && a.estado_borrador === "terminado");
    const pref = arts.filter((a) => a.fecha_preferencia_desde);
    console.log("/api/articles?admin=1 ->", lista.status, "total=" + arts.length, "sin publicar=" + arts.filter((a) => !a.publicado).length, "en revisión=" + rev.length, "con fecha preferencia=" + pref.length);
    const pub = arts.find((a) => a.publicado);
    if (pub) {
      const d = await pedir(base, "/api/articles/" + encodeURIComponent(pub.slug));
      console.log("/api/articles/" + pub.slug.slice(0, 40) + " ->", d.status, d.status === 200 ? "OK" : JSON.stringify(d.cuerpo).slice(0, 200));
    }
  } else {
    console.log("/api/articles?admin=1 ->", lista.status, JSON.stringify(lista.cuerpo).slice(0, 200));
  }
}
console.log("\nSi en SECUNDARIA /api/me no da 200 pero en PRINCIPAL sí, el JWT_SECRET de Railway no coincide con el del Worker.");
