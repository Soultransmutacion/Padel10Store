# CONTINUAR — Fase 3, Etapa 3: Mercado Pago Checkout Pro ligado a pedido real

> Punto de reanudación completo. Escrito para que otra sesión de Claude (o un humano)
> pueda retomar este trabajo sin haber visto la conversación previa.
> Actualizado: después de resolver la decisión de arquitectura accessToken/redirectUrl,
> completar los tests de `pedido-preferencia` y dejar `npm test` en verde de punta a punta.

## 1. Rama y commits

- Rama de trabajo: `asesor-ia-padel10store` (única rama tocada; `main` no fue tocado).
- Toda la Etapa 3 (incluida esta actualización) existe como cambios locales listos para
  commitear. Ver la sección 11 para el estado exacto del commit/push de este checkpoint.

## 2. Objetivo exacto de la Fase 3 – Etapa 3

Autorización original del usuario (resumen fiel): una vez que `/api/pedidos` crea
correctamente un pedido real (Etapa 2, cerrada), el backend debe crear además una
preferencia de Mercado Pago inequívocamente asociada a ese pedido, siguiendo el flujo:

```
carrito + datos -> servidor valida -> crea pedido -> crea preferencia Mercado Pago
-> guarda mp_preference_id -> devuelve URL de checkout -> navegador redirige a Mercado Pago
```

Reglas críticas del diseño (no negociables sin decisión explícita del usuario):

- El pedido debe existir antes que la preferencia.
- `external_reference` de la preferencia = `pedido.id`.
- El navegador nunca decide precio/total/nombre/moneda: todo sale del pedido ya
  persistido (snapshot real).
- Se guarda `mp_preference_id` en `pedidos`.
- Crear una preferencia NUNCA marca el pedido como pagado. `estado_pago` sigue
  `pendiente` y `estado_pedido` sigue `pendiente_pago`.
- Variable explícita `MERCADOPAGO_ENV=sandbox|production` (no usar `VERCEL_ENV` como
  única señal). Sólo `sandbox` está habilitado en esta etapa; producción debe fallar
  cerrado (fail-closed) si `MERCADOPAGO_ENV` no es literalmente `sandbox`.
- Si falla la creación de la preferencia, el pedido NO se borra, queda en
  `pendiente_pago`, se loguea un error mínimo, y debe poder reintentarse la creación
  de preferencia sin duplicar el pedido (idempotencia).
- La respuesta al frontend nunca debe exponer: access token de Mercado Pago, el
  `access_token` propio del pedido, secrets, UUIDs internos innecesarios, datos
  personales.
- Mantener todos los tests existentes en verde. **Esto SÍ se cumple hoy** (ver
  sección 6).

## 3. Decisión de arquitectura resuelta (accessToken vs redirectUrl)

En un checkpoint anterior había una decisión pendiente: `api/pedidos.js` devolvía
`accessToken: pedido.access_token` en el `201`, lo cual rompía la regla de seguridad
de la Etapa 2 (`tests/padel-checkout-static.test.js`, "la respuesta nunca arma un
objeto con `access`"). El usuario resolvió esto explícitamente con las siguientes
decisiones, ya implementadas:

- **NO se expone `accessToken` en la respuesta pública de `POST /api/pedidos`.** Se
  quitó por completo del `res.status(201).json(...)`.
- El `access_token` persistente del pedido (columna `pedidos.access_token`, generado
  en la Etapa 2) **sigue existiendo en el modelo de datos y en Supabase sin cambios**.
  Está reservado para una futura funcionalidad de consulta segura del estado del
  pedido (page de seguimiento), no para esta etapa.
- **El mecanismo de reintento de creación de preferencia de Mercado Pago NO reutiliza
  `access_token`.** Queda explícitamente como diseño pendiente (no se improvisó nada).
  `api/pedidos-preferencia.js` (el endpoint de reintento) todavía no existe y su
  mecanismo de identificación/autorización del reintento debe diseñarse aparte,
  cuando el usuario autorice esa etapa.
- La respuesta exitosa de `POST /api/pedidos` es ahora, y únicamente:
  ```json
  { "numero": "P10-000123", "redirectUrl": "https://sandbox.mercadopago.com.ar/checkout/..." }
  ```
  `redirectUrl` es la URL de checkout de Mercado Pago (`sandboxInitPoint`) cuando la
  preferencia se creó bien, o `null` si no se pudo crear (el pedido igual queda
  registrado, nunca se borra, nunca se reintenta automáticamente ni se crea un
  segundo pedido).
- Nunca se expone el UUID interno del pedido.
- El test estático `tests/padel-checkout-static.test.js:90` (que prohíbe `access` en
  la respuesta) sigue vigente sin modificar, y ahora pasa honestamente porque el
  código ya no viola la regla — no hizo falta debilitar ni reescribir ese test.

## 4. Qué se implementó hasta ahora

### Archivos NUEVOS (sin commitear al momento de escribir esto)

- **`lib/mercadopago-client.js`** — módulo único con las llamadas de red reales a
  Mercado Pago (`fetch` con timeout de 15s), compartido entre el flujo legacy
  (`api/create-payment-preference.js`) y el flujo nuevo. Expone
  `crearPreferenciaEnMercadoPago({payload, accessToken, timeoutMs})` (POST) y
  `obtenerPreferenciaDeMercadoPago({preferenceId, accessToken, timeoutMs})` (GET).
  Nunca lanza excepción: devuelve `{ok:false, motivo}` ante cualquier fallo, o
  `{ok:true, preferenceId, sandboxInitPoint, initPoint}` (los tres campos son
  independientemente nullable) en éxito.
- **`lib/pedido-preferencia.js`** — capa de orquestación. Exporta
  `crearOReutilizarPreferenciaParaPedido({pedido, items, client})`:
  - Falla cerrado si falta `MERCADOPAGO_ACCESS_TOKEN` o si `MERCADOPAGO_ENV !==
    'sandbox'` (`motivo: 'sin_credencial'` / `'entorno_no_habilitado'`).
  - Valida el pedido antes de llamar a Mercado Pago (`motivo: 'pedido_invalido'`) y
    valida que haya una base URL confiable (`motivo: 'sin_base_url_confiable'`).
  - Si el pedido ya tiene `mp_preference_id`, intenta reusarlo re-consultando a
    Mercado Pago (GET) antes de crear uno nuevo (idempotencia sin duplicar el
    pedido ni la preferencia).
  - Si crea una preferencia nueva, llama a `asociarPreferenceId` (ya existía en
    `padel-orders-store.js`) para persistir `mp_preference_id`.
  - Si Mercado Pago falla o tira excepción, registra un evento silencioso
    (`registrarFalloSilencioso`, `motivo: 'mercado_pago'`) y NUNCA toca la fila de
    `pedidos` (no la borra, no cambia estados).
  - Sólo devuelve `checkoutUrl` cuando el entorno es `sandbox` y hay
    `sandboxInitPoint` (nunca usa `initPoint`/producción en esta etapa); si falta
    `sandboxInitPoint` reporta `motivo: 'sin_sandbox_init_point'` mientras igual
    asocia el `preferenceId` obtenido.
- **`tests/pedido-preferencia.test.js`** (401 líneas, **12/12 tests OK**) — cubre,
  contra mocks de `lib/mercadopago-client.js` y `lib/padel-orders-store.js` (patrón
  `require.cache`, igual que `tests/mercadopago-preference.test.js`):
  - Validaciones previas a cualquier llamada a Mercado Pago: pedido inválido/sin id,
    pedido `null`, sin credencial, entorno distinto de `sandbox`, sin base URL
    confiable.
  - Camino feliz: crea y asocia la preferencia; el payload usa el
    `external_reference` e items reales del pedido.
  - Fallos de Mercado Pago: rechazo registra el fallo silencioso y no asocia nada;
    éxito sin `preferenceId` también mapea a `motivo: 'mercado_pago'`; éxito sin
    `sandboxInitPoint` igual asocia el `preferenceId` pero reporta
    `sin_sandbox_init_point`.
  - Idempotencia: una relectura exitosa de una preferencia ya asociada evita
    crear una nueva; una relectura fallida cae correctamente a crear una preferencia
    nueva sin duplicar el pedido.

### Archivos MODIFICADOS (sin commitear al momento de escribir esto)

- **`lib/padel-orders-store.js`** (+15 líneas) — se agregó
  `obtenerItemsPorPedido(pedidoId, client)`: lee `pedido_items` filtrando por
  `pedido_id`, ordenado por `created_at asc`. Valida UUID, usa el mismo patrón de
  cliente inyectable que el resto del archivo.
- **`lib/mercadopago-preference.js`** (+72 líneas) — sigue sin hacer llamadas de red
  (invariante documentada del archivo se mantiene). Se agregaron funciones puras:
  - `getMercadoPagoEnv()`: lee `process.env.MERCADOPAGO_ENV`, sólo acepta
    `'sandbox'`/`'production'` literal, default seguro `'sandbox'`.
  - `buildNotificationUrl(trustedBaseUrl)`: arma `${base}/api/webhook-mercadopago`
    (el endpoint del webhook TODAVÍA NO EXISTE — no se implementa en esta etapa).
  - `buildOrderItems(items)`: mapea filas de `pedido_items` a items de Mercado Pago
    (título incluye talle si corresponde, `currency_id: 'ARS'`, precio desde
    `precio_unitario` real de la fila, nunca desde el cliente).
  - `buildOrderPreferencePayload({pedido, items, backUrls, notificationUrl})`: arma
    el payload completo con `external_reference: pedido.id`.
- **`api/create-payment-preference.js`** (+45/-varias) — refactorizado para delegar
  la llamada de red a `lib/mercadopago-client.js` en vez de tener su propio
  `fetch`/timeout inline. Comportamiento externo verificado idéntico. Sigue siendo
  el endpoint legacy de un solo producto fijo, gateado a `VERCEL_ENV === 'preview'`;
  NO fue eliminado ni reemplazado.
- **`api/pedidos.js`** (+38/-varias) — después de crear el pedido exitosamente,
  ahora también: lee los items reales del pedido recién creado
  (`obtenerItemsPorPedido`), llama a `crearOReutilizarPreferenciaParaPedido`, y
  cambia la respuesta 201 de `{ numero }` a `{ numero, redirectUrl }` (ver sección 3
  para el detalle completo de la decisión). Si falla la creación de la preferencia
  (excepción o `resultado.ok === false`), el `catch`/rama negativa deja
  `redirectUrl: null` y NUNCA interrumpe la respuesta ni borra/modifica el pedido.
- **`tests/api-pedidos.test.js`** (actualizado) — adaptado al nuevo shape de
  respuesta `{ numero, redirectUrl }`; se agregó un test negativo explícito
  ("la respuesta de éxito NUNCA incluye `access_token` ni `accessToken`") en
  reemplazo del test anterior que exigía lo contrario. **Pasa 50/50.**
- **`package.json`** — se agregó `node tests/pedido-preferencia.test.js` a la cadena
  `&&` del script `test`, entre `api-pedidos.test.js` y `padel-checkout-widget.test.js`.

## 5. Qué todavía NO existe / NO fue tocado en esta etapa

- **`api/pedidos-preferencia.js`** — NO existe. Sería el endpoint de reintento de
  creación de preferencia para un pedido ya creado cuya preferencia falló. Su
  mecanismo de identificación/autorización queda **explícitamente como diseño
  pendiente**: NO debe reusar `access_token` sin una decisión de diseño dedicada
  (ver sección 3). No implementar sin autorización explícita del usuario.
- **`tests/api-pedidos-preferencia.test.js`** — no existe (test del endpoint
  anterior, depende de que ese endpoint se diseñe primero).
- **`widget/padel-checkout.js`** — NO fue tocado. Hoy, al confirmar un pedido, sólo
  hace `window.PadelCart.clear()` y navega a `confirmacion`. NO lee `redirectUrl` de
  la respuesta ni redirige a Mercado Pago. Falta: redirigir si hay `redirectUrl` (con
  la misma validación de host sandbox que usa `widget/mercadopago-buy.js`), y avisar
  al usuario si `redirectUrl` es `null` (pedido registrado, pago no iniciado).
- **El webhook (`api/webhook-mercadopago`) NO existe y no se implementa en esta
  etapa**, por instrucción explícita del usuario.
- **Ninguna preferencia real fue creada en Mercado Pago sandbox** en este checkpoint.
  No se hizo (ni se intentó) ninguna prueba manual contra Mercado Pago real — el
  usuario pidió explícitamente que no se hiciera sin autorización previa adicional.
- El flujo completo pedido→preferencia nunca corrió de punta a punta contra Mercado
  Pago real ni contra Supabase real en este checkpoint — sólo está probado a nivel
  de unidad/integración con fakes/mocks.

## 6. Estado de los tests (este checkpoint)

```
node --check api/pedidos.js tests/api-pedidos.test.js tests/pedido-preferencia.test.js
  -> ALL_SYNTAX_OK

node validate-catalog.js
  -> OK (92 productos, todo sincronizado y verde)

node tests/api-pedidos.test.js
  -> Pruebas de api/pedidos.js: 50/50 OK

node tests/pedido-preferencia.test.js
  -> Pruebas de lib/pedido-preferencia.js: 12/12 OK

npm test  (cadena completa, actualmente ~20 archivos con &&)
  -> EXITCODE=0
  -> 496 líneas PASS, 0 líneas FAIL
  -> Verde de punta a punta, incluyendo el nuevo tests/pedido-preferencia.test.js
     y el tests/api-pedidos.test.js actualizado.
```

El hallazgo crítico de un checkpoint anterior (conflicto entre
`tests/padel-checkout-static.test.js:90` y la respuesta de `api/pedidos.js`) **está
resuelto**: la respuesta ya no incluye nada con "access", así que ese test pasa sin
haber sido modificado ni debilitado.

## 7. Qué falta implementar (fuera del alcance de este checkpoint)

1. Diseñar (con autorización explícita del usuario) el mecanismo de reintento de
   creación de preferencia — decidir cómo se identifica/autoriza el reintento sin
   reusar `access_token` tal cual, y sin exponer el UUID interno del pedido.
2. Crear `api/pedidos-preferencia.js` + `tests/api-pedidos-preferencia.test.js` según
   ese diseño.
3. Agregar test unitario dedicado para `obtenerItemsPorPedido` (hoy sólo está
   cubierto indirectamente; `padel-orders-store.test.js` sigue en verde sin romperse).
4. Modificar `widget/padel-checkout.js` (redirigir a `redirectUrl` / avisar si es
   `null`).
5. Documentar en `.env.example` (sólo nombres, sin valores): `MERCADOPAGO_ACCESS_TOKEN`,
   `MERCADOPAGO_ENV` (si todavía no están documentadas ahí).
6. Implementar el webhook (`api/webhook-mercadopago`) — etapa futura, requiere
   autorización explícita nueva.
7. Antes de cualquier prueba manual contra Mercado Pago sandbox real: pedir
   autorización explícita del usuario (no se hizo en este checkpoint).

## 8. Variables de entorno necesarias (SOLO NOMBRES — nunca valores)

- `MERCADOPAGO_ACCESS_TOKEN` (ya usado por el endpoint legacy; el flujo nuevo lo
  reutiliza; no se debe imprimir ni loguear jamás).
- `MERCADOPAGO_ENV` (nuevo; valores válidos `sandbox` | `production`; default
  seguro `sandbox` si no está seteada o tiene un valor inesperado).
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (o el alias legacy
  `SUPABASE_SERVICE_ROLE_KEY`) — ya existentes, usados por
  `getSupabaseAdminClient()`.
- `VERCEL_URL` — usado por `getTrustedBaseUrl()` para construir `back_urls` y
  `notification_url`.
- `VERCEL_ENV` — sigue gateando el endpoint legacy `api/create-payment-preference.js`
  a `'preview'`; NO se usa como señal de sandbox/producción para el flujo nuevo
  (por diseño explícito de esta etapa).

## 9. Estado de Supabase relevante

- El pedido de prueba **`P10-000001`** (Cross Black '26, $206.000) fue creado
  correctamente durante la prueba manual de la Etapa 3 – Etapa 2 (contra Supabase
  real vía el deploy de Preview), verificado con 22 chequeos SQL independientes, y
  **se decidió conservar esa fila sin borrarla.** No tocar, no borrar.
- Las columnas `mp_preference_id` / `mp_payment_id` ya existían en `pedidos` desde
  antes de esta etapa (migraciones previas); esta etapa no agrega ninguna migración
  nueva de esquema.
- `pedido_items.created_at` confirmado existente (usado por
  `obtenerItemsPorPedido` para el `order by`).
- RLS deny-by-default sigue confirmado en todas las tablas relevantes.
- No se hizo ninguna consulta ni escritura nueva a Supabase en este checkpoint (sólo
  lectura de archivos locales y ejecución de tests que usan fakes/mocks, no la base
  real).

## 10. Restricciones de seguridad (vigentes, sin excepción)

- NO tocar `main`.
- NO habilitar `MERCADOPAGO_ENV=production` ni ningún otro mecanismo que apunte a
  producción.
- NO realizar pagos reales.
- NO implementar el webhook todavía (ni el endpoint `api/webhook-mercadopago`, ni
  lógica de confirmación de pago).
- NO borrar el pedido de prueba `P10-000001`.
- NO inventar valores de secrets ni variables de entorno.
- NO exponer valores de variables de entorno en logs, docs ni respuestas HTTP.
- NO exponer `access_token`/`accessToken` del pedido, ni el UUID interno, en
  respuestas HTTP públicas.
- NO improvisar el mecanismo de reintento de preferencia reutilizando `access_token`
  sin diseño y autorización explícita nueva.
- NO avanzar a una etapa posterior (webhook, confirmación de pago, cambio automático
  a `a_preparar`, panel admin, emails, logística) sin autorización explícita nueva.
- Antes de cualquier prueba manual que cree una preferencia real en Mercado Pago
  sandbox, hay que detenerse y pedir autorización explícita — no se hizo ninguna en
  este checkpoint.

## 11. Estado del commit/push de este checkpoint

Ver el mensaje de cierre de la sesión que generó esta actualización para el hash de
commit exacto, el estado de CI y el resultado final. Si por algún motivo esta sección
no fue actualizada después de un commit, asumir que el checkpoint anterior a la
sección 6 sigue reflejando el estado real del working tree (todo listo, tests verdes,
pendiente de commit/push).
