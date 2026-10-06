export function translateSql(sql, params = []) {
  let n = 0;
  let out = sql
    .replace(/date\('now'\)/gi, "CURRENT_DATE")
    .replace(/datetime\('now',\s*\?\)/gi, "(CURRENT_TIMESTAMP + ?::interval)")
    .replace(/datetime\('now',\s*'([+-])([^']+) minutes'\)/gi, "(CURRENT_TIMESTAMP + INTERVAL '$1$2 minutes')")
    // "datetime('now', '-28 days')" / "'+3 days'": usado por el panel de
    // analíticas para acotar el rango (ver /api/admin/analiticas/* en
    // index.js). Mismo patrón que la traducción de "minutes" de arriba,
    // pero con "days" y sin límite en el número de dígitos.
    .replace(/datetime\('now',\s*'([+-])([^']+) days'\)/gi, "(CURRENT_TIMESTAMP + INTERVAL '$1$2 days')")
    .replace(/datetime\('now'\)/gi, "CURRENT_TIMESTAMP")
    // "date(columna)" (SQLite) -> "columna::date" (Postgres), usado para
    // agrupar la evolución diaria de vistas por día en vez de por
    // timestamp exacto.
    .replace(/\bdate\(([a-zA-Z_][\w.]*)\)/gi, "$1::date");
  out = out.replace(/programado_para\s*(<=|>)\s*CURRENT_TIMESTAMP/gi, "programado_para::timestamptz $1 CURRENT_TIMESTAMP");
  // Las columnas "created_at"/"updated_at"/"cierra_en" están declaradas
  // como TEXT en el esquema de Postgres (para mantener paridad con
  // SQLite/D1, donde no hay un tipo timestamp real), pero las expresiones
  // de arriba ya se han traducido a CURRENT_TIMESTAMP / (CURRENT_TIMESTAMP
  // + INTERVAL '...'), que en Postgres son "timestamp with time zone".
  // Comparar "columna_text >= timestamptz" no tiene operador válido en
  // Postgres (error 42883: "operator does not exist: text >= timestamp
  // with time zone"), lo que hacía fallar cualquier consulta que filtrase
  // por rango de fechas (analíticas, activity_log, encuestas cerradas por
  // fecha, etc.) en cuanto el failover pasaba a Railway/Postgres.
  //
  // Se castea explícitamente la columna del lado izquierdo a timestamptz
  // SOLO cuando aparece en una comparación (=, >, <, >=, <=) contra una
  // expresión de fecha, nunca en una asignación "SET columna = ..." /
  // "ON CONFLICT ... DO UPDATE SET columna = ...", donde castear la
  // columna no tiene efecto (o es inválido) y lo correcto es dejar que
  // Postgres guarde el timestamp tal cual en la columna TEXT. Se captura
  // también el carácter que precede a la columna (o "," / "SET" si es una
  // asignación) para decidir en un único paso, evitando el doble-paso
  // (frágil) de detectar y luego re-machear la misma expresión.
  out = out.replace(
    /(,\s*|\bSET\s+)?\b((?:created_at|updated_at|cierra_en|banner_urgente_hasta))(?!::date)\s*(>=|<=|>|<|=)\s*(CURRENT_TIMESTAMP\b|\(CURRENT_TIMESTAMP\s*\+\s*(?:\?::interval|INTERVAL\s*'[^']+')\))/gi,
    (match, assignPrefix, col, op, rhs) => {
      const isAssignment = op === "=" && !!assignPrefix;
      if (isAssignment) return match; // "SET columna = ..." / ", columna = ...": no castear
      const prefix = assignPrefix || "";
      return `${prefix}${col}::timestamptz ${op} ${rhs}`;
    }
  );
  // "columna IS ?" es válido en SQLite (comparación tolerante a NULL, se
  // comporta como "=" salvo que alguno de los dos lados sea NULL), pero en
  // PostgreSQL "IS" solo admite los literales NULL/TRUE/FALSE a su derecha
  // -- nunca un parámetro bindeado ($1, $2...). Con un parámetro ahí,
  // Postgres lanza un error de sintaxis en tiempo de ejecución (no al
  // arrancar, así que pasa desapercibido hasta la primera vez que se
  // ejecuta esa consulta en producción). El equivalente exacto en Postgres
  // es "IS NOT DISTINCT FROM", que si compara con NULL se comporta igual
  // que "IS NULL", y si compara con un valor no nulo se comporta como "=".
  // Se traduce ANTES de convertir "?" en "$n" para no interferir con esa
  // conversión (que ya cuenta cuántos "?" hay en la cadena).
  out = out.replace(/\bIS\s+\?/gi, "IS NOT DISTINCT FROM ?");
  // "<columna> COLLATE NOCASE" (típicamente en ORDER BY, para que la a-z
  // ignore mayúsculas/minúsculas) es una collation de SQLite que no existe
  // en PostgreSQL de serie -- "collation \"nocase\" for encoding \"UTF8\"
  // does not exist". El equivalente sin depender de tener esa collation
  // instalada en el servidor de Postgres es envolver la columna en
  // LOWER(...): mismo efecto práctico (orden alfabético insensible a
  // mayúsculas), sin requerir configuración adicional en la base de datos.
  // Se captura la palabra/columna inmediatamente anterior a "COLLATE
  // NOCASE" (nombres de columna válidos: letras, dígitos, guión bajo).
  out = out.replace(/(\w+)\s+COLLATE\s+NOCASE/gi, "LOWER($1)");
  // "INSERT OR IGNORE INTO t ..." (SQLite) -> "INSERT INTO t ... ON CONFLICT
  // DO NOTHING" (Postgres). Sin esto Postgres lanza un error de sintaxis.
  // Si la sentencia ya lleva RETURNING (lo añade maybeAddReturning), la
  // cláusula ON CONFLICT debe ir ANTES de RETURNING.
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(out)) {
    out = out.replace(/^(\s*)INSERT\s+OR\s+IGNORE\s+INTO\b/i, "$1INSERT INTO");
    out = /\bON\s+CONFLICT\b/i.test(out)
      ? out
      : /\bRETURNING\b/i.test(out)
        ? out.replace(/\s+RETURNING\b/i, " ON CONFLICT DO NOTHING RETURNING")
        : `${out.replace(/;\s*$/, "")} ON CONFLICT DO NOTHING`;
  }
  out = out.replace(/\?(\d+)/g, (_, index) => { n = Math.max(n, Number(index)); return `$${index}`; });
  out = out.replace(/\?/g, () => `$${++n}`);
  return { sql: out, params };
}
