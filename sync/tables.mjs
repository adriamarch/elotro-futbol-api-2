// Configuración de sincronización por tabla.
//
// "order": orden seguro de migración/sincronización respetando FKs
//   (ver FASE4.md sección 5). Coincide con la propuesta del documento;
//   se ha revisado contra worker/schema.sql y no hace falta cambiarlo:
//   users no depende de nadie; articles depende de users+results
//   (resultado_id) por eso se hace después de results, etc.
//
// "changeStrategy":
//   - "immutable"   -> solo se INSERTa una vez, nunca se modifica tras
//                       crearse (article_slug_redirects, match_events,
//                       activity_log, nivel_historial, custom_clubs).
//                       created_at basta para saber qué es nuevo.
//   - "updated_at"  -> tiene updated_at que SÍ se toca en cada cambio.
//                       Filtrar por "updated_at > cursor" detecta altas Y
//                       modificaciones con una sola columna.
//
// Todas las tablas con "updated_at" ya sea nativo (articles, alineaciones,
// club_info, settings) o añadido en esta fase mediante trigger
// (worker/migracion_fase4_sync_tracking.sql: users, results, sessions,
// edit_requests, comments, club_info_solicitudes) usan changeStrategy
// "updated_at". Las que son de solo-inserción usan "immutable" con
// created_at como cursor -no necesitan trigger ni columna nueva-.
//
// "deleteDetection": si D1 permite borrar filas de esta tabla, hay que
// comparar el conjunto de IDs D1 vs PostgreSQL en cada pasada para poder
// aplicar el DELETE también en PostgreSQL (D1 no tiene una tabla de
// tombstones genérica). Se activa para las tablas donde el Worker
// principal ejecuta DELETE (revisado en worker/src/index.js).

export const TABLES = [
  {
    name: "users",
    pk: ["id"],
    order: 1,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true, // el panel de Usuarios permite eliminar usuarios
    syncMode: "authoritative", // D1 debe dejar PostgreSQL exactamente igual
  },
  {
    name: "settings",
    pk: ["key"],
    order: 2,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true, // D1 es la autoridad; eliminar sobrantes en PG
    syncMode: "authoritative",
  },
  {
    name: "results",
    pk: ["id"],
    order: 3,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true,
    syncMode: "authoritative", // D1 es la autoridad; evita depender de updated_at en D1 remoto
  },
  {
    name: "articles",
    pk: ["id"],
    order: 4,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true,
  },
  {
    name: "media",
    pk: ["id"],
    order: 5,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: true, // se puede borrar media desde el panel
  },
  {
    // Galería de partido: vincula "media" con "results" (Bloque B,
    // Fase 9 del plan de colaboradores/fotógrafo). Es puramente
    // "insert-only" desde el punto de vista de sus propias columnas
    // (no tiene updated_at ni se edita una fila existente, solo se
    // crea o se borra el enlace), así que changeStrategy "immutable"
    // con created_at como cursor, igual que "media". Puede perder
    // filas por ON DELETE CASCADE desde DOS padres distintos (results
    // o media), no solo uno, así que deleteDetection (comparación de
    // IDs) en vez de cascadeDeleteFrom -mismo caso que "porras" más
    // abajo-. Requiere la tabla creada en Postgres por la migración
    // db/migrations/027_match_gallery.sql.
    name: "match_gallery",
    pk: ["id"],
    order: 5.5,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: true,
  },
  {
    name: "custom_clubs",
    pk: ["id"],
    order: 6,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: false,
  },
  {
    name: "article_slug_redirects",
    pk: ["slug_antiguo"],
    order: 7,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: false, // en cascada al borrar el articulo (FK ON DELETE CASCADE)
    cascadeDeleteFrom: "articles",
  },
  {
    name: "match_events",
    pk: ["id"],
    order: 8,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: true, // se pueden borrar/corregir eventos desde Minuto a Minuto
  },
  {
    name: "alineaciones",
    pk: ["id"],
    order: 9,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true,
  },
  {
    name: "comments",
    pk: ["id"],
    order: 10,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true,
    syncMode: "authoritative", // D1 es la autoridad; evita depender de updated_at en D1 remoto
  },
  {
    // Cuentas de lectores (login/registro público, distinto de "users").
    // No tiene updated_at en D1: solo se modifica en sitios acotados
    // (verificación de email, reset de contraseña, activo), así que se
    // trata como authoritative igual que comments/club_info_solicitudes
    // en vez de intentar un cursor con created_at, que no detectaría
    // esos cambios.
    name: "readers",
    pk: ["id"],
    order: 10.1,
    changeStrategy: "updated_at",
    cursorColumn: "created_at",
    deleteDetection: true,
    syncMode: "authoritative",
  },
  {
    // Sesiones de lectores (mismo patrón que "sessions" para redactores).
    name: "reader_sessions",
    pk: ["id"],
    order: 10.2,
    changeStrategy: "updated_at",
    cursorColumn: "last_seen_at",
    deleteDetection: true,
    syncMode: "authoritative",
  },
  {
    // Votos (like/dislike) de comentarios. Solo-inserción en D1 (un voto
    // se borra y reinserta, nunca se actualiza in place, según
    // worker/src/index.js), así que "immutable" con created_at basta.
    name: "comment_votes",
    pk: ["id"],
    order: 10.3,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: true,
  },
  {
    // Denuncias de comentarios. Igual que comment_votes salvo por
    // "revisado", que sí se actualiza tras la creación -> authoritative
    // para no perder esos cambios con un cursor de solo-inserción.
    name: "comment_reports",
    pk: ["id"],
    order: 10.4,
    changeStrategy: "updated_at",
    cursorColumn: "created_at",
    deleteDetection: true,
    syncMode: "authoritative",
  },
  {
    // Predicciones de lectores (porras) por partido. Tiene updated_at
    // real (se toca al resolver puntos_obtenidos/resultado_acierto
    // cuando el partido finaliza, ver resolverPorrasPendientes() en
    // worker/src/index.js) -> changeStrategy "updated_at". Puede perder
    // filas por ON DELETE CASCADE desde DOS padres distintos (readers o
    // results), no solo uno, así que deleteDetection (comparación de
    // IDs) en vez de cascadeDeleteFrom (pensado para un único padre,
    // ver article_slug_redirects más abajo). Requiere la tabla creada
    // en Postgres por la migración 021 (db/migrations/021_porras_y_categorias_fijas.sql).
    name: "porras",
    pk: ["id"],
    order: 10.5,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true,
  },
  {
    name: "club_info",
    pk: ["club"],
    order: 11,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: false,
  },
  {
    name: "club_info_solicitudes",
    pk: ["id"],
    order: 12,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true,
    syncMode: "authoritative", // D1 es la autoridad; tabla pequeña
  },
  {
    name: "edit_requests",
    pk: ["id"],
    order: 13,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true,
    syncMode: "authoritative", // D1 es la autoridad; tabla pequeña
  },
  {
    name: "activity_log",
    pk: ["id"],
    order: 14,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: false, // registro de auditoría, no se borra
  },
  {
    name: "nivel_historial",
    pk: ["id"],
    order: 15,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: false,
  },
  {
    name: "newsletter_suscriptores",
    pk: ["id"],
    order: 16,
    // No tiene updated_at. Con syncMode "authoritative" (igual que users,
    // settings, results, comments, club_info_solicitudes, edit_requests y
    // sessions) cada pasada relee toda la tabla de D1 y reconcilia PG por
    // PK -altas, cambios (p.ej. activo/baja_at por una baja pública) y
    // borrados (el botón "Eliminar" del panel, ver worker/src/index.js)
    // quedan cubiertos sin depender de un cursor incremental real.
    // changeStrategy/cursorColumn solo se usan aquí para registrar el
    // cursor informativo tras cada pasada (ver sync/incremental.mjs); con
    // created_at basta al no tener updated_at.
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: true, // el panel de Newsletter permite eliminar suscriptores
    syncMode: "authoritative", // D1 es la autoridad; el panel de admin vive en el primario
  },
  {
    name: "sessions",
    pk: ["id"],
    order: 17,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true, // sesiones antiguas se podrían limpiar en el futuro
    syncMode: "authoritative", // D1 es la autoridad también para sesiones
  },
  {
    name: "polls",
    pk: ["id"],
    order: 18,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true, // el panel permite eliminar encuestas
    syncMode: "authoritative", // D1 es la autoridad; tabla pequeña
  },
  {
    name: "poll_options",
    pk: ["id"],
    order: 19,
    // No tiene updated_at; las opciones de una encuesta no se editan tras
    // crearse desde el panel, solo se crean junto con la propia encuesta.
    changeStrategy: "immutable",
    cursorColumn: "id",
    deleteDetection: true, // se borran en cascada junto a la encuesta
    syncMode: "authoritative", // D1 es la autoridad; tabla pequeña, depende de polls
  },
  {
    name: "poll_votes",
    pk: ["id"],
    order: 20,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: false, // los votos no se borran individualmente
  },
  {
    name: "tienda_productos",
    pk: ["id"],
    order: 21,
    // Catálogo fijo, se edita a mano por INSERT/UPDATE directo (ver
    // worker/migracion_tienda.sql); no tiene updated_at, así que se
    // reconcilia entero cada pasada.
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: true, // un producto se puede desactivar/borrar a mano
    syncMode: "authoritative", // D1 es la autoridad; catálogo pequeño
  },
  {
    name: "tienda_pedidos",
    pk: ["id"],
    order: 22,
    // Un pedido cambia de estado (pendiente_pago -> pagado -> enviado /
    // cancelado) pero no tiene updated_at, solo created_at + gestionado_en.
    // syncMode "authoritative" reconcilia también esos cambios de estado
    // sin depender de un cursor incremental real.
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: false, // los pedidos no se borran, se marcan "cancelado"
    syncMode: "authoritative",
  },
  {
    name: "noticias_rapidas",
    pk: ["id"],
    order: 23,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true, // el panel permite borrar noticias rápidas
    syncMode: "authoritative", // D1 es la autoridad; tabla pequeña
  },
];

export function getTable(name) {
  const t = TABLES.find((t) => t.name === name);
  if (!t) throw new Error(`Tabla no reconocida en config de sync: ${name}`);
  return t;
}

export const TABLES_IN_ORDER = [...TABLES].sort((a, b) => a.order - b.order);

// Dependencias de FK relevantes para la sincronización: si la tabla padre
// falla al leer/reconciliar D1 en una pasada, la tabla hija NO debe
// intentarse en esa misma pasada, porque podría insertar filas que
// referencian IDs que Postgres todavía no tiene (viola la FK) — es lo que
// causó los errores de "match_events_resultado_id_fkey" cuando "results"
// falló por un problema de autenticación de Wrangler/D1 y el bucle
// principal siguió adelante igualmente.
// Formato: nombre de tabla hija -> lista de tablas padre de las que depende.
export const DEPENDENCIAS_FK = {
  articles: ["users", "results"],
  match_events: ["results"],
  alineaciones: ["results"],
  article_slug_redirects: ["articles"],
  comments: ["articles", "users", "readers"],
  reader_sessions: ["readers"],
  comment_votes: ["comments"],
  comment_reports: ["comments"],
  polls: ["articles", "users"],
  noticias_rapidas: ["users"],
  poll_options: ["polls"],
  poll_votes: ["polls", "poll_options", "readers"],
  tienda_pedidos: ["users", "tienda_productos"],
};