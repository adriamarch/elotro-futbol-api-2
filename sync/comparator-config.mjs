// Campos deliberadamente volátiles que pueden cambiar durante una comparación.
// Se siguen sincronizando desde D1 a PostgreSQL; únicamente se excluyen del
// veredicto del comparador para evitar falsos positivos por cambios en vuelo.
export const CAMPOS_VOLATILES_COMPARADOR = Object.freeze({
  sessions: Object.freeze(new Set(["last_seen_at"])),
});

// Tablas del voto secreto de las votaciones internas (ver tables.mjs y
// worker/migracion_votaciones_privadas.sql). El comparador las contrasta
// igual que al resto (recuentos, conjunto de claves, valores), pero NO
// imprime sus claves ni ejemplos de filas diferentes: quien lea un informe
// de comparación pegado en un ticket o en un log no debe poder reconstruir
// quién ha votado (participacion) ni qué papeletas existen (urna). Además
// el comparador comprueba que su orden físico en PostgreSQL es el de la PK
// (ver reordenarTablaPorClave en pg-writer.mjs).
export const TABLAS_PRIVADAS_COMPARADOR = Object.freeze(
  new Set(["votaciones_internas_participacion", "votaciones_internas_urna"])
);
