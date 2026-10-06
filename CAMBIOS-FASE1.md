# Sincronización completa de workers — FASE 1 (código y esquema)

Objetivo: que `worker-secondary` (Railway + PostgreSQL) ofrezca lo mismo que
`worker` (Cloudflare + D1). La Fase 2 (datos y validación real) está al final.

## Cómo se hizo
El secundario llevaba ~4.200 líneas de retraso respecto al principal (47
funciones y 10 rutas ausentes, más cambios de comportamiento en media,
categorías fijas, VAR, partidazo, galería pública, etc.). Portar bloque a
bloque era frágil, así que `src/index.js` del secundario se reconstruyó
**partiendo del `index.js` del principal** y reaplicando encima lo que el
secundario tenía de propio y de intencionado. El resultado difiere del
principal en solo 63 líneas (3 bloques, marcados con `[SECUNDARIO]`):

1. **Salida temprana en Railway** (`env.RUNNING_IN_RAILWAY`): atiende la
   petición directamente y devuelve su respuesta real, en vez de que
   `fetchRailway()` la tape con un 503 `FAILOVER_UNAVAILABLE`.
2. **Orden `?orden=cercania` en JS** (`/api/results`): `julianday()` no existe
   en PostgreSQL.
3. **Error de clave foránea de PostgreSQL** (`23503`) al borrar un resultado
   con noticia vinculada → 409 con mensaje claro.

Se conserva una copia del archivo anterior fuera del repo; no hay otra pérdida.

## Archivos
| Archivo | Cambio |
|---|---|
| `src/index.js` | Reconstruido (ver arriba). Ahora tiene las 10 rutas que faltaban y las 47 funciones. |
| `db/migrations/039_votaciones_internas.sql` | 5 tablas de votaciones internas (esquema final de D1). |
| `db/migrations/040_match_gallery_equipo.sql` | Columna `match_gallery.equipo`. |
| `db/migrations/041_recordatorios_inactividad.sql` | Tabla por-backend (NO se sincroniza). |
| `src/sql-compat.js` | Traduce `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`. |
| `src/postgres-db.js` | `RETURNING id` para `votaciones_internas`, `votaciones_internas_opciones`, `push_subscriptions`. |
| `src/server-railway.js` | `PATCH` en CORS (lo usa el principal) y 5 variables nuevas. |
| `test/route-parity.py` | Ahora compara rutas literales, rutas regex y funciones. |
| `test/postgres-db.test.mjs` | Tests de `INSERT OR IGNORE`. |
| `verify-postgres-schema.mjs` | Espera las tablas/columnas nuevas. |
| `../.github/workflows/paridad-workers.yml` | CI: paridad + traducción SQL en cada PR. |

## Antes de desplegar (orden)
1. En Railway, añadir variables: `VAPID_PRIVATE_JWK`, `VAPID_SUBJECT`,
   `X_CLIENT_ID`, `X_CLIENT_SECRET`, `INDEXNOW_KEY` (mismos valores que en
   `worker/wrangler.toml`/secretos de Cloudflare). Sin ellas, push y login con
   X no funcionan durante un failover (responden 503/500, no rompen el resto).
2. `npm run db:migrate` (aplica 039, 040, 041).
3. `node verify-postgres-schema.mjs`.
4. Desplegar el servicio.

## Resultados verificados (en este entorno)
- `node --check` de `index.js` y `server-railway.js`: OK.
- `python3 test/route-parity.py`: OK (105/105 rutas literales, 17/17 regex,
  257/257 funciones).
- `node test/postgres-db.test.mjs`: OK.
- Prueba de humo con BD simulada: las 10 rutas probadas responden igual que el
  principal, salvo `/api/readers/x/iniciar` (500 vs 503: es la diferencia
  intencionada nº 1).

**No verificado:** nada de esto se ha ejecutado contra PostgreSQL/Railway reales
(sin `DATABASE_URL` en este entorno). Las migraciones están escritas pero no
aplicadas.

## Hallazgos que requieren decisión
1. **Cortacircuito por ruta del failover.** Las 5 funciones `circuito*` solo
   existen en el secundario, pero solo tienen sentido en el Worker de
   Cloudflare (dentro de Railway nunca se ejecutan). El principal conserva
   restos (`CIRCUITO_ABIERTO`, `contadorFailoverPorCircuito`) sin la lógica que
   los activa. Posible regresión en el principal; no se ha tocado `worker/`.
   `route-parity.py` lo tiene en lista de excepciones hasta decidirlo.
2. **`npm test`: 9 fallos que ya existían** (idénticos con el `index.js`
   original). Son de `test/api-failover.test.mjs`, que prueba
   `public/js/config.js` (cliente), no el worker.
3. **`src/index.backup.js`** (4.056 líneas, 4-sep) está obsoleto; se puede borrar.
4. **`recordatorios_inactividad`**: creada en PostgreSQL por paridad. Las
   tareas programadas siguen ejecutándose solo desde Cloudflare.

## Fase 2 (pendiente): datos
Añadir a `sync/tables.mjs` y `sync/comparator-config.mjs`: `push_subscriptions` y
las 5 `votaciones_internas*` (orden por claves foráneas); decidir si replicar
`votaciones_internas_urna`/`participacion` (voto anónimo); ejecutar
`sync:initial`, `db:sync-sequences`, `sync:compare` y comparar las APIs.
