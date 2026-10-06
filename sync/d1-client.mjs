// Cliente D1 compartido por todo el sincronizador (migración inicial,
// incremental y comparador). Todos pasan por aquí para que solo haya un
// sitio que sepa invocar Wrangler.
//
// D1 no expone una API HTTP directa sencilla para este proyecto, así que
// -igual que hacía worker-secondary/migrar-d1.cjs en su versión original-
// usamos `wrangler d1 execute --remote --json`. Se mantiene ese mismo
// mecanismo para no introducir una segunda vía de acceso a D1 con
// comportamiento distinto.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DB_NAME = process.env.D1_DATABASE_NAME || "elotrofutbol";

// En Windows, npx es en realidad "npx.cmd" (un script de shell), no un
// ejecutable directo. execFile() sin shell puede además lanzar
// "spawn EINVAL" al intentar invocar un .cmd directamente en algunas
// versiones de Node en Windows (problema conocido de Node en Windows con
// archivos .cmd/.bat: necesitan pasar por cmd.exe). La solución fiable en
// Windows es usar shell:true -pero eso reintroduce el problema de
// escapado que queríamos evitar (Node antepondría comillas dobles “a lo
// tonto” a cada argumento, y un SQL con comillas simples/dobres podría
// romper el parseo de cmd.exe)-. Por eso en Windows citamos manualmente
// cada argumento al estilo cmd.exe (doblando comillas dobres internas y
// envolviendo el argumento entero entre comillas) antes de unirlos en un
// único string y pasar shell:true; en el resto de plataformas seguimos
// usando execFile con el array de argumentos tal cual, sin shell.
const ES_WINDOWS = process.platform === "win32";
const NPX_CMD = ES_WINDOWS ? "npx.cmd" : "npx";
const D1_TIMEOUT_MS = Number(process.env.D1_TIMEOUT_MS || 120000);
// 200MB pensado originalmente para traer tablas enteras de golpe
// (SELECT * FROM tabla sin LIMIT). Con la lectura paginada
// (ejecutarD1Paginado) cada llamada trae como mucho una página, así que
// 20MB es de sobra incluso para filas con contenido de texto largo
// (articles.contenido, etc.) y deja mucho menos margen de pico de
// memoria si algo se descontrola.
const D1_MAX_BUFFER = Number(process.env.D1_MAX_BUFFER_BYTES || 20 * 1024 * 1024);

function citarArgumentoWindows(arg) {
  // Escapa comillas dobres duplicándolas (regla de cmd.exe) y envuelve el
  // argumento completo entre comillas dobres para que espacios, comillas
  // simples y saltos de línea del SQL no rompan el parseo del shell.
  return `"${String(arg).replace(/"/g, '""')}"`;
}

/**
 * Ejecuta una sentencia SQL de solo lectura contra D1 remoto.
 * Usa --command; para SELECT con parámetros dinámicos, este helper
 * construye el SQL ya interpolado de forma segura con escaparValorD1.
 */
export async function ejecutarD1(sql) {
  const args = [
    "wrangler",
    "d1",
    "execute",
    DB_NAME,
    "--remote",
    "--command",
    sql,
    "--json",
  ];

  try {
    let stdout;
    if (ES_WINDOWS) {
      // shell:true + un único string ya citado a mano (ver nota arriba).
      const comando = [NPX_CMD, ...args.map(citarArgumentoWindows)].join(" ");
      ({ stdout } = await execFileAsync(comando, {
        shell: true,
        maxBuffer: D1_MAX_BUFFER,
        windowsHide: true,
          timeout: D1_TIMEOUT_MS,
        }));
    } else {
      // execFile con array de argumentos, sin shell: evita problemas de
      // escapado en Linux/Mac (el SQL entero viaja como un único argumento).
      ({ stdout } = await execFileAsync(NPX_CMD, args, {
        maxBuffer: D1_MAX_BUFFER,
        windowsHide: true,
          timeout: D1_TIMEOUT_MS,
        }));
    }

    const data = JSON.parse(stdout);

    if (!Array.isArray(data) || !data[0] || !Array.isArray(data[0].results)) {
      throw new Error("Respuesta inesperada de Wrangler:\n" + stdout);
    }

    return data[0].results;
  } catch (error) {
    const stderr = error.stderr || "";
    const stdout = error.stdout || "";
    throw new Error(
      `Wrangler no pudo consultar D1: ${error.message}\n${stderr}\n${stdout}`
    );
  }
}

/**
 * Escapa un valor literal para incluirlo en SQL de D1 (SQLite).
 * Se usa solo para construir sentencias de solo lectura (SELECT ... WHERE
 * columna > 'valor'); no se usa para escribir en D1 (Fase 4 no escribe
 * nunca en D1 — D1 sigue siendo la única fuente de verdad).
 */
export function escaparValorD1(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

export async function contarD1(table) {
  const rows = await ejecutarD1(`SELECT COUNT(*) AS total FROM ${table};`);
  return Number(rows[0]?.total || 0);
}

/**
 * Lee SOLO una columna (normalmente la(s) del PK) de una tabla D1 completa,
 * página a página por cursor de esa misma columna, en vez de un único
 * "SELECT pk FROM tabla;" que trae todos los IDs de golpe.
 *
 * Se usa para la detección de borrados (comparar IDs D1 vs IDs Postgres):
 * ahí no hacen falta las filas completas, solo la(s) columna(s) de PK, así
 * que además de paginar, esto evita traer columnas de contenido (texto
 * largo, etc.) que "SELECT pk" ya no traería, pero cuyo coste por fila en
 * memoria de Node/JSON.parse seguía sumando en tablas con muchas filas.
 *
 * onPagina recibe un array de PKs (string u objeto, según pkColumns.length)
 * de esa página; se llama antes de pedir la siguiente, así que en memoria
 * solo hay como mucho una página de PKs.
 */
export async function ejecutarD1PaginadoSoloIds(table, pkColumns, onPagina, { tamanoPagina = 2000 } = {}) {
  const cols = Array.isArray(pkColumns) ? pkColumns : [pkColumns];
  const colOrden = cols[0]; // orden estable por la primera columna del PK
  let ultimoValor = null;
  let totalFilas = 0;
  for (;;) {
    const where = ultimoValor === null ? "" : `WHERE ${colOrden} > ${escaparValorD1(ultimoValor)} `;
    const sql = `SELECT ${cols.join(", ")} FROM ${table} ${where}ORDER BY ${colOrden} ASC LIMIT ${tamanoPagina};`;
    const pagina = await ejecutarD1(sql);
    if (pagina.length === 0) break;

    await onPagina(pagina);
    totalFilas += pagina.length;
    ultimoValor = pagina[pagina.length - 1][colOrden];

    if (pagina.length < tamanoPagina) break; // última página
  }
  return totalFilas;
}

/**
 * Lee una tabla D1 completa página a página por cursor de PK, en vez de
 * un único "SELECT * FROM tabla;" que trae toda la tabla de golpe.
 *
 * Por qué por cursor de PK y no LIMIT/OFFSET: con OFFSET, si una fila se
 * borra o se inserta entre dos páginas (la sincronización tarda varios
 * segundos/minutos en tablas grandes y el sitio sigue recibiendo tráfico
 * mientras tanto), el desplazamiento de todas las filas posteriores hace
 * que OFFSET salte o repita filas. Comparando siempre "pk > último visto"
 * ese problema no existe: cada fila se ve como mucho una vez, sin
 * importar qué cambie por delante o detrás del cursor mientras se pagina.
 * Solo requiere que el PK sea comparable con ">" y estable (todas las
 * tablas "authoritative" de tables.mjs usan id numérico autoincremental o
 * una clave natural estable, así que se cumple).
 *
 * Cada página se entrega a `onPagina` en cuanto llega (no se acumula un
 * array con la tabla entera en memoria); onPagina normalmente hace el
 * upsert de esa página contra Postgres antes de pedir la siguiente.
 *
 * Acepta PK de una columna (string) o compuesta (array de columnas). Con PK
 * compuesta se pagina por "valores de fila" de SQLite, p. ej.
 * "WHERE (votacion_id, usuario_id) > (2, 7) ORDER BY votacion_id,
 * usuario_id": paginar solo por la primera columna saltaría filas que
 * comparten su valor (todas las de una misma votación). Hace falta para
 * votaciones_internas_participacion (tables.mjs).
 */
export async function ejecutarD1Paginado(table, pkColumn, onPagina, { tamanoPagina = 500 } = {}) {
  const cols = Array.isArray(pkColumn) ? pkColumn : [pkColumn];
  const listaCols = cols.join(", ");
  let ultimaFila = null;
  let totalFilas = 0;
  for (;;) {
    let where = "";
    if (ultimaFila !== null) {
      where = cols.length === 1
        ? `WHERE ${cols[0]} > ${escaparValorD1(ultimaFila[cols[0]])} `
        : `WHERE (${listaCols}) > (${cols.map((c) => escaparValorD1(ultimaFila[c])).join(", ")}) `;
    }
    const sql = `SELECT * FROM ${table} ${where}ORDER BY ${listaCols} ASC LIMIT ${tamanoPagina};`;
    const pagina = await ejecutarD1(sql);
    if (pagina.length === 0) break;

    await onPagina(pagina);
    totalFilas += pagina.length;
    ultimaFila = pagina[pagina.length - 1];

    if (pagina.length < tamanoPagina) break; // última página
  }
  return totalFilas;
}
