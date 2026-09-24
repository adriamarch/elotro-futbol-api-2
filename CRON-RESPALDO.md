# Cron de la secundaria (sincronización continua, independiente del primario)

## Por qué existe

El Worker principal de Cloudflare (`worker/wrangler.toml`) tiene un cron
trigger (`* * * * *`, cada minuto) que:

- publica noticias programadas (`programado_para`),
- arranca automáticamente partidos programados (esto es lo que hace que
  la clasificación y el minuto a minuto se vean "en directo"),
- avisa por email de partidos "desatendidos" (nadie ha pulsado
  Descanso/Fin del partido),
- envía el boletín semanal si toca.

Ese cron trigger nativo de Cloudflare **solo existe en el Worker
principal**: Railway no tiene un mecanismo equivalente integrado en el
propio proceso, así que estas tareas necesitan un disparador aparte.

Antes, este documento describía un cron de **respaldo pasivo**: solo
actuaba si detectaba que el primario estaba caído. Eso creaba justo la
dependencia que se quería evitar -- si estabas sirviendo tráfico desde
la secundaria por cualquier motivo (no necesariamente una caída total,
p.ej. el circuit breaker de `public/js/config.js` abierto por unos
502 intermitentes) pero el primario seguía respondiendo a
`/api/health`, este cron no hacía nada y lo "en vivo" se quedaba
congelado en la secundaria -- que es exactamente el bug que motivó este
cambio.

Ahora el cron de Railway se ejecuta **siempre**, sin comprobar el
estado del primario. Ambos backends corren estas tareas de forma
independiente, cada uno sobre su propia base de datos (D1 en el
principal, PostgreSQL en la secundaria), así que ninguno depende del
otro para que la clasificación, el minuto a minuto o los avisos
automáticos funcionen. Ejecutar la misma tarea dos veces (una en cada
lado) es seguro porque cada una es idempotente: por ejemplo,
`iniciarPartidosProgramadosCuyaHoraHaLlegado` solo actúa sobre partidos
que siguen en estado `programado`, así que una segunda ejecución sobre
un partido ya arrancado no hace nada.

## Piezas

1. **`POST /api/internal/cron-respaldo`** en `src/server-railway.js`:
   protegido por un secreto compartido (cabecera
   `X-Internal-Cron-Secret`). Ejecuta, en secuencia y contra
   PostgreSQL, las mismas cuatro tareas que el `scheduled` del Worker
   principal:
   - `publicarArticulosProgramados`
   - `iniciarPartidosProgramadosCuyaHoraHaLlegado`
   - `revisarPartidosDesatendidos`
   - `enviarBoletinSemanalSiToca`

   Cada tarea se envuelve en su propio try/catch: si una falla, las
   demás igualmente se ejecutan (mismo criterio que los `ctx.waitUntil`
   independientes del Worker principal). La respuesta indica el
   resultado de cada tarea (`"ok"` o `"error"`, con el mensaje) y
   devuelve `200` si todas fueron bien o `207` si alguna falló.

2. **`scripts/cron-respaldo.mjs`**: un script de una sola ejecución
   (arranca, llama al endpoint anterior, termina) pensado para un
   **servicio Cron nativo de Railway** (no un `setInterval` corriendo
   sin parar — Railway cobra por tiempo activo, y sus Cron Jobs están
   pensados para arrancar, ejecutar y apagarse solos).

3. **`sync/scheduler.mjs`** (ya existente, FASE 4): sigue corriendo
   aparte, cada minuto por defecto, trayendo a PostgreSQL cualquier
   cambio hecho en D1. Es la pieza que mantiene los DATOS
   (artículos, resultados, comentarios...) idénticos en ambos lados.
   El cron de este documento y ese scheduler son complementarios: uno
   sincroniza datos, el otro dispara la lógica de negocio periódica
   directamente sobre Postgres.

## Pasos para desplegarlo

### 1. Variables de entorno en el servicio `server-railway.js` (el que ya tienes)

Añade en Railway → tu proyecto → servicio de la API secundaria → Variables:

```
INTERNAL_CRON_SECRET=<una cadena larga y aleatoria, la que quieras>
```

Vuelve a desplegar ese servicio para que recoja la variable nueva.

### 2. Crear el servicio Cron en Railway

Dentro del **mismo proyecto** de Railway:

1. "New" → "Empty Service" (o duplica el servicio existente y cambia su
   comando de arranque).
2. Conéctalo al mismo repositorio/carpeta `worker-secondary/`.
3. En Settings de ese nuevo servicio:
   - **Start Command**: `npm run cron:respaldo`
   - **Cron Schedule**: `*/5 * * * *` (cada 5 minutos — es el mínimo que
     permite Railway; no puede ser cada minuto como en Cloudflare).
4. Variables de entorno de este servicio Cron (no las confundas con las
   del servicio principal de Railway, aunque puede que Railway te deje
   compartirlas si usas "Shared Variables"):

```
CRON_RESPALDO_URL=https://TU-SERVICIO.up.railway.app/api/internal/cron-respaldo
INTERNAL_CRON_SECRET=<el MISMO valor que pusiste en el paso 1>
```

`CRON_RESPALDO_URL` es la URL pública de tu servicio
`server-railway.js` (la misma que ya usa `SECONDARY_API` en
`public/js/config.js`) + `/api/internal/cron-respaldo`.

### 3. Verificar

Fuerza una ejecución manual del servicio Cron desde el dashboard de
Railway (ambos backends vivos o no, da igual: ya no comprueba el
primario). La respuesta esperada:

```json
{
  "ok": true,
  "ejecutado_en": "2026-08-22T...",
  "tareas": {
    "publicarArticulosProgramados": "ok",
    "iniciarPartidosProgramadosCuyaHoraHaLlegado": "ok",
    "revisarPartidosDesatendidos": "ok",
    "enviarBoletinSemanalSiToca": "ok"
  }
}
```

Si alguna tarea falla, aparecerá `"error"` en su entrada y el detalle
del mensaje en `errores`, con código HTTP `207`.

## Limitación conocida: intervalo de 5 minutos, no 1

El cron del Worker principal corre cada minuto; el de Railway, como
mínimo cada 5 (límite de la plataforma). Un partido programado a las
20:00 podría arrancar su cronómetro en la secundaria hasta ~5 minutos
tarde si en ese momento el tráfico se está sirviendo desde ahí. Es una
degradación aceptada, no un fallo — sigue siendo mucho mejor que un
desfase indefinido hasta que alguien note que el primario está caído.

## Avisos de partidos desatendidos: resumen en lote

Resend (plan gratuito) limita a 100 emails al día. Por eso
`revisarPartidosDesatendidos` **ya no manda un correo por partido**:
cada partido desatendido (una vez por mitad) se apunta en la tabla
`avisos_desatendidos_cola` y se envía **un único email resumen** al
admin cuando la cola llega a `AVISOS_DESATENDIDOS_LOTE` (20) partidos o
cuando el aviso más antiguo lleva `AVISOS_DESATENDIDOS_ESPERA_MAX_MIN`
(30) minutos esperando. Ambas constantes están en `src/index.js`.

- Cada backend (D1 y Postgres) tiene **su propia cola**. La tabla **no
  debe añadirse a `sync/tables.mjs`**: el sincronizador la vaciaría.
- Migraciones: `worker/migracion_avisos_desatendidos_cola.sql` (D1) y
  `db/migrations/026_avisos_desatendidos_cola.sql` (Postgres).
- Si Resend falla al enviar, el lote se descarta (no se reintenta cada
  minuto, para no agotar el cupo).
- El aviso 🚨 de partido colgado (`marcarPartidosColgados`) sigue siendo
  individual e inmediato.

## Nota sobre el envío duplicado de emails

`revisarPartidosDesatendidos` (resumen en lote) y `enviarBoletinSemanalSiToca`
envían correos (Resend). Si algún día ambos crons (principal cada minuto,
secundario cada 5 minutos) llegaran a ejecutarse sobre la MISMA fila
de negocio antes de que la sincronización de datos (FASE 4) propague
el cambio de un lado a otro, existe una ventana teórica de doble aviso.
En la práctica es poco probable (la ventana es de minutos, no hay
solape típico), pero si se observan avisos duplicados, revisar primero
`sync/scheduler.mjs` (¿está corriendo con normalidad, o el retraso de
sincronización es mayor de lo esperado?) antes de tocar la lógica de
estas tareas.
