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
// "ordenFisicaPorClave": (solo tablas de voto secreto) tras cada pasada con
//   cambios, PostgreSQL reordena físicamente la tabla por su PK (CLUSTER)
//   para que el orden del montón no revele el orden de llegada de los votos.
//   D1 lo evita con WITHOUT ROWID; PostgreSQL no tiene equivalente.
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
    syncMode: "authoritative", // se editan filas ya creadas: un cursor por created_at no las detecta
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
    syncMode: "authoritative", // se editan filas ya creadas: un cursor por created_at no las detecta
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
    syncMode: "authoritative", // se editan filas ya creadas: un cursor por created_at no las detecta
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
    order: 9.5, // antes de "comments" (10): comments.reader_id -> readers(id) (FK real, comments_reader_id_fkey)
    changeStrategy: "updated_at",
    cursorColumn: "created_at",
    deleteDetection: true,
    syncMode: "authoritative",
  },
  {
    // Sesiones de lectores (mismo patrón que "sessions" para redactores).
    name: "reader_sessions",
    pk: ["id"],
    order: 9.6, // depende de readers
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
  {
    // ---------------------------------------------------------------
    // FASE 2 (paridad de datos del failover): push_subscriptions y las 5
    // tablas de votaciones internas. Esquema en db/migrations/036 y 039.
    // ---------------------------------------------------------------
    //
    // Suscripciones Web Push (una fila por navegador). D1 las toca con
    // INSERT ... ON CONFLICT(endpoint) DO UPDATE (que sí refresca
    // updated_at) y las borra con DELETE (baja del usuario o 404/410 del
    // servicio push), así que cursor por updated_at + deleteDetection.
    // Tabla potencialmente grande (una fila por lector suscrito): NO es
    // authoritative para no releerla entera cada pasada (cuota de lecturas
    // de D1). Un lector que se da de baja y se vuelve a suscribir recibe un
    // id nuevo con el MISMO endpoint: ese choque UNIQUE se resuelve en
    // incremental.mjs (UNICOS_RESOLUBLES.push_subscriptions).
    name: "push_subscriptions",
    pk: ["id"],
    order: 24,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true,
  },
  {
    // Votaciones internas del panel (cabecera). No tiene updated_at pero
    // cambia tras crearse (estado/cerrada_en al cerrar o reabrir), y D1 la
    // borra junto a sus hijas -> authoritative. Tabla diminuta.
    name: "votaciones_internas",
    pk: ["id"],
    order: 25,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: true,
    syncMode: "authoritative",
  },
  {
    name: "votaciones_internas_opciones",
    pk: ["id"],
    order: 26,
    changeStrategy: "immutable",
    cursorColumn: "id", // sin created_at; mismo criterio que poll_options
    deleteDetection: true,
    syncMode: "authoritative",
  },
  {
    // Votos NOMINALES (con usuario). En las votaciones anónimas esta tabla
    // no se usa (D1 las guarda en participacion + urna). Cambiar el voto =
    // DELETE + INSERT con id nuevo, así que authoritative (y ver
    // UNICOS_RESOLUBLES: UNIQUE(opcion_id, usuario_id) puede chocar con la
    // fila vieja de PG dentro de la misma pasada).
    name: "votaciones_internas_votos",
    pk: ["id"],
    order: 27,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: true,
    syncMode: "authoritative",
  },
  {
    // PRIVACIDAD (voto secreto). QUIÉN ha votado, sin opción ni fecha. En
    // D1 es WITHOUT ROWID: no hay orden de inserción recuperable. PK
    // compuesta (votacion_id, usuario_id).
    //  - authoritative y SIN cursor temporal: no hay created_at y no se
    //    debe introducir ninguna marca de tiempo aquí.
    //  - "ordenFisicaPorClave": en PostgreSQL (tabla de montón normal) el
    //    orden físico delataría el orden de llegada; tras cada cambio se
    //    reordena con CLUSTER por la PK, que es el equivalente a WITHOUT
    //    ROWID (ver reordenarTablaPorClave en pg-writer.mjs).
    //  - el comparador no lista sus claves (TABLAS_PRIVADAS_COMPARADOR en
    //    comparator-config.mjs) y verifica ese orden físico.
    name: "votaciones_internas_participacion",
    pk: ["votacion_id", "usuario_id"],
    order: 28,
    changeStrategy: "immutable",
    cursorColumn: "votacion_id", // solo informativo (cursor de authoritative); nunca una fecha
    deleteDetection: true,
    syncMode: "authoritative",
    ordenFisicaPorClave: true,
  },
  {
    // PRIVACIDAD (voto secreto). QUÉ se ha votado, sin usuario ni fecha;
    // la clave es un token aleatorio. Misma política que participacion. NO
    // debe unirse nunca con participacion (ni aquí, ni en el comparador, ni
    // en logs): son tablas separadas a propósito.
    name: "votaciones_internas_urna",
    pk: ["token"],
    order: 29,
    changeStrategy: "immutable",
    cursorColumn: "votacion_id", // solo informativo; nunca una fecha
    deleteDetection: true,
    syncMode: "authoritative",
    ordenFisicaPorClave: true,
  },
  {
    name: "jornadas_calendario",
    pk: ["id"],
    order: 3.1,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true,
    syncMode: "authoritative", // se edita/borra desde el panel y los UPDATE no tocan updated_at
  },
  {
    name: "equipo_alias_externo",
    pk: ["id"],
    order: 3.2,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: true,
    syncMode: "authoritative",
  },
  {
    name: "newsletter_envios",
    pk: ["id"],
    order: 3.3,
    changeStrategy: "updated_at",
    cursorColumn: "ultimo_envio_at",
    deleteDetection: false, // fila única (id = 1)
    syncMode: "authoritative",
  },
  {
    name: "sync_partidos_auto",
    pk: ["id"],
    order: 3.4,
    changeStrategy: "updated_at",
    cursorColumn: "ultimo_sync_at",
    deleteDetection: false, // fila única (id = 1)
    syncMode: "authoritative",
  },
  {
    name: "recordatorios_inactividad",
    pk: ["user_id"],
    order: 3.6,
    changeStrategy: "updated_at",
    cursorColumn: "updated_at",
    deleteDetection: true,
    syncMode: "authoritative",
  },
  {
    name: "article_media",
    pk: ["id"],
    order: 5.7,
    changeStrategy: "immutable",
    cursorColumn: "created_at",
    deleteDetection: true, // se reemplaza entera por noticia (DELETE + INSERT)
    syncMode: "authoritative",
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
  article_media: ["articles", "media"],
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
  votaciones_internas: ["users"],
  votaciones_internas_opciones: ["votaciones_internas"],
  votaciones_internas_votos: ["votaciones_internas", "votaciones_internas_opciones", "users"],
  votaciones_internas_participacion: ["votaciones_internas", "users"],
  votaciones_internas_urna: ["votaciones_internas", "votaciones_internas_opciones"],
};