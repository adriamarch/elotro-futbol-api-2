#!/usr/bin/env node
import pg from "pg";
const { Client } = pg;
const expected = {
 users:["id","username","password_hash","salt","nombre","rol","activo","email","bio","experiencia","avatar_url","redes_sociales","equipo","notif_visto_at","reset_token","reset_token_expira","created_at","nivel","nivel_nota"],
 articles:["id","slug","titulo","subtitulo","contenido","tipo","categoria","club","imagen_url","imagenes","resultado_id","autor_id","autor_nombre","coautor_id","coautor_nombre","destacado","publicado","estado_borrador","programado_para","slug_congelado","fecha_publicacion","created_at","updated_at","titulo_eu","subtitulo_eu","contenido_eu","titulo_ca","subtitulo_ca","contenido_ca","titulo_gl","subtitulo_gl","contenido_gl","titulo_en","subtitulo_en","contenido_en","imagen_post_url"],
 results:["id","competicion","grupo","jornada","equipo_local","equipo_visitante","goles_local","goles_visitante","fecha_partido","estado","ubicacion","flashscore_url","escudo_local_url","escudo_visitante_url","autor_id","autor_nombre","created_at","inicio_cronometro_at","cronometro_pausado_en","ajuste_cronometro_minutos","fecha_partido_retrasado","penaltis_local","penaltis_visitante","aviso_desatendido_mitad","mvp_jugador","mvp_equipo","aviso_desatendido_enviado"],
 match_events:["id","resultado_id","tipo","equipo","jugador","jugador_sale","jugador_asistencia","minuto","minuto_extra","orden","bajar_gol","var_motivo","var_decision","created_at"],
 settings:["key","value","updated_at"], media:["id","cloudinary_public_id","cloudinary_resource_type","cloudinary_url","titulo","descripcion","tipo","nombre_archivo","content_type","tamano_bytes","autor_id","autor_nombre","club","created_at"],
 sessions:["id","user_id","user_agent","ip","created_at","last_seen_at","revoked_at"], custom_clubs:["id","nombre","categoria","escudo_url","autor_id","autor_nombre","created_at"],
 edit_requests:["id","tipo_entidad","entidad_id","solicitante_id","autor_id","motivo","estado","resuelta_por_id","resuelta_at","permiso_expira_at","created_at"], article_slug_redirects:["slug_antiguo","article_id","created_at"],
 alineaciones:["id","article_id","result_id","equipo","escudo_url","formacion","jugadores","autor_id","autor_nombre","created_at","updated_at"],
 comments:["id","article_id","nombre","email","texto","estado","ip","created_at","moderado_por_id","moderado_at"], club_info:["club","entrenador","estadio","fundacion","ciudad","autor_id","autor_nombre","created_at","updated_at"],
 club_info_solicitudes:["id","club","entrenador","estadio","fundacion","ciudad","solicitante_id","solicitante_nombre","estado","resuelta_por_id","resuelta_por_nombre","resuelta_at","created_at"],
 activity_log:["id","usuario_id","usuario_nombre","usuario_rol","accion","entidad","entidad_id","descripcion","detalle","ip","created_at"], nivel_historial:["id","usuario_id","usuario_nombre","nivel_anterior","nivel_nuevo","motivo","cambiado_por_id","cambiado_por_nombre","created_at"],
newsletter_suscriptores:["id","email","baja_token","activo","created_at","baja_at"], newsletter_envios:["id","ultimo_envio_at"],
 // Fase 1 (paridad con el worker principal)
 votaciones_internas:["id","titulo","descripcion","multiple","anonima","obligatoria","resultados_visibles","cierra_en","estado","creado_por","creado_por_nombre","created_at","cerrada_en"],
 votaciones_internas_opciones:["id","votacion_id","texto","orden"],
 votaciones_internas_votos:["id","votacion_id","opcion_id","usuario_id","created_at"],
 votaciones_internas_participacion:["votacion_id","usuario_id"],
 votaciones_internas_urna:["token","votacion_id","opcion_id"],
 push_subscriptions:["id","endpoint","p256dh","auth","noticias","partidos","user_agent","created_at","updated_at"],
 match_gallery:["id","result_id","media_id","orden","vinculado_por_id","equipo","created_at"],
 recordatorios_inactividad:["user_id","ref_actividad","avisos_enviados","ultimo_aviso_at","admins_avisados_at","updated_at"]
};
const client = new Client({connectionString: process.env.DATABASE_URL});
await client.connect();
try {
 const r=await client.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`);
 const actual={}; for(const x of r.rows)(actual[x.table_name]??=[]).push(x.column_name);
 const errors=[]; for(const [t,cols] of Object.entries(expected)){ if(!actual[t]) errors.push(`Missing table: ${t}`); else for(const c of cols) if(!actual[t].includes(c)) errors.push(`Missing column: ${t}.${c}`); }
 if(errors.length){console.error(errors.join("\n"));process.exit(1);} console.log("PostgreSQL API contract schema: OK");
} finally { await client.end(); }
