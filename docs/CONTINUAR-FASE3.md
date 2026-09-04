# CONTINUAR — Fase 3, Etapa 3: Mercado Pago Checkout Pro ligado a pedido real

> Punto de reanudación completo. Escrito para que otra sesión de Claude (o un humano)
> pueda retomar este trabajo sin haber visto la conversación previa.
> Actualizado: después de resolver la decisión de arquitectura del mecanismo de
> reintento de pago (`payment_retry_token`, independiente de `access_token`),
> implementar `POST /api/pedidos-preferencia`, conectar el frontend, y dejar
> `npm test` en verde de punta a punta.

## 1. Rama y commits

- Rama de trabajo: `asesor-ia-padel10store` (única rama tocada; `main` no fue tocado).
- Toda esta actualización existe como cambios locales listos para commitear. Ver la
  sección 11 para el estado exacto del commit/push de este checkpoint.

## 2. Objetivo exacto de la Fase 3 – Etapa 3

Autorización original del usuario (resumen fiel): una vez que `/api/pedidos` crea
correctamente un pedido real (Etapa 2, cerrada), el backend debe crear además una
preferencia de Mercado Pago inequívocamente asociada a ese pedido, siguiendo el flujo:

```
carrito + datos -> servidor valida -> crea pedido -> crea preferencia Mercado Pago
-> guarda mp_preference_id -> devuelve URL de checkout -> navegador redirige a Mercado Pago
```

Si la preferencia inicial no se pudo crear (o el navegador nunca llegó a redirigir),
el pedido queda igual registrado y debe poder **reintentarse el inicio del pago** sin
crear un pedido nuevo ni duplicar la preferencia — este es el objeto de esta
actualización (ver sección 3).

Reglas críticas del diseño (no negociables sin decisión explícita del usuario):

- El pedido debe existir antes que la preferencia.
- `external_reference` de la preferencia = `pedido.id`.
- El navegador nunca decide precio/total/nombre/moneda: todo sale del pedido ya
  persistido (snapshot real).
- Se guarda `mp_preference_id` en `pedidos`.
- Crear una preferencia NUNCA marca el pedido como pagado. `estado_pago` sigue
  `pendiente` y `estado_pedido` sigue `pendiente_pago` (salvo que ya viniera de un
  intento previo, ver `pedidoAdmitePago` en la sección 3).
- Variable explícita `MERCADOPAGO_ENV=sandbox|production` (no usar `VERCEL_ENV` como
  única señal). Sólo `sandbox` está habilitado en esta etapa; producción debe fallar
  cerrado (fail-closed) si `MERCADOPAGO_ENV` no es literalmente `sandbox`.
- Si falla la creación de la preferencia, el pedido NO se borra, queda en
  `pendiente_pago`, y debe poder reintentarse la creación de preferencia sin duplicar
  el pedido (idempotencia) — ver sección 3.
- La respuesta al frontend nunca debe exponer: access token de Mercado Pago, el
  `access_token` propio del pedido, secrets, UUIDs internos, datos personales.
- Mantener todos los tests existentes en verde (ver sección 6).

## 3. Decisión de arquitectura resuelta: `payment_retry_token`

En el checkpoint anterior quedaba pendiente decidir cómo se identifica/autoriza un
reintento de creación de preferencia para un pedido ya creado, sin reusar
`access_token`. El usuario tomó la decisión explícitamente:

### 3.1 `access_token` vs `payment_retry_token`: dos mecanismos independientes

- **`access_token`** (columna `pedidos.access_token`, existente desde la Etapa 1) queda
  **reservado exclusivamente** para una futura funcionalidad de consulta segura del
  estado/seguimiento del pedido. Nunca se usa para reintentar un pago. Sigue sin
  exponerse en ninguna respuesta HTTP pública.
- **`payment_retry_token`** (nuevo, `lib/payment-retry-token.js`) es un mecanismo
  independiente y de **propósito único**: solo autoriza el intento de
  iniciar/reanudar el flujo de pago de UN pedido puntual. No sirve para consultar
  datos personales ni como token de seguimiento. Nunca reemplaza ni modifica
  `access_token`.

### 3.2 Formato y almacenamiento

- Generado del lado servidor con `crypto.randomBytes(32)` → 64 caracteres hex (mismo
  formato/entropía que `access_token`, pero un valor completamente independiente:
  nunca se derivan uno del otro, ni del UUID del pedido, ni del número `P10-...`).
- **En base de datos SOLO se guarda su hash SHA-256** (`pedidos.payment_retry_token_hash`,
  columna nueva — ver migración en 3.5), nunca el valor en claro. Se decidió hash (no
  texto plano) porque es razonable con la arquitectura actual: el token ya tiene 256
  bits de entropía criptográfica propia (no es una contraseña elegida por una
  persona), así que SHA-256 simple alcanza sin necesitar salt/pepper adicional por
  token, y evita que una fuga de la tabla `pedidos` alcance para reconstruir tokens
  válidos.
- El valor en claro **solo existe transitoriamente en memoria del proceso Node**
  durante el request que lo genera (`crearPedido()`, como propiedad NO persistida
  `payment_retry_token` en el objeto devuelto) o que lo recibe del cliente para
  validarlo (`api/pedidos-preferencia.js`). Nunca se persiste en claro, nunca se
  loguea completo (`truncarParaLog`), y nunca se envía al modelo de IA.

### 3.3 Cuándo se expone al cliente

- `payment_retry_token` se genera **siempre** en `crearPedido()` (para poder ofrecer
  un reintento en cualquier momento futuro), pero `POST /api/pedidos` **solo lo
  incluye en la respuesta cuando hace falta**: es decir, únicamente cuando
  `redirectUrl` es `null` (la preferencia inicial no se pudo crear en el mismo
  request). Si el camino feliz ya devuelve `redirectUrl`, el cliente no necesita
  ningún token todavía y la respuesta no lo incluye — se evita exponerlo quando no
  hace falta, tal como pidió el usuario.
- Respuesta de éxito de `POST /api/pedidos`, ahora con 3 shapes posibles:
  ```json
  { "numero": "P10-000123", "redirectUrl": "https://sandbox.mercadopago.com.ar/checkout/..." }
  ```
  ```json
  { "numero": "P10-000123", "redirectUrl": null, "paymentRetryToken": "64-hex-chars..." }
  ```
  Nunca ambos (`redirectUrl` y `paymentRetryToken`) a la vez, y nunca `accessToken`/
  `access_token`/UUID interno en ninguno de los dos casos.

### 3.4 `POST /api/pedidos-preferencia` (nuevo endpoint)

`api/pedidos-preferencia.js` implementa el reintento. El cliente manda ÚNICAMENTE
`{ "paymentRetryToken": "..." }`. Pasos del servidor, en orden:

1. Valida forma del body (única clave permitida: `paymentRetryToken`) y formato del
   token (64 hex minúsculas) — si no matchea, `400` genérico, nunca toca la base.
2. Calcula el hash SHA-256 del token recibido y busca el pedido por
   `payment_retry_token_hash` (`obtenerPedidoPorPaymentRetryTokenHash`, nuevo en
   `lib/padel-orders-store.js`). Un token que no matchea ningún pedido devuelve el
   mismo error genérico que cualquier otro caso (nunca revela si "no existe" vs.
   "expiró").
3. Verifica que el pedido siga en un estado que permite pagar
   (`pedidoAdmitePago(pedido)`, nuevo en `lib/pedido-preferencia.js` — ver 3.4.1). Si
   no, `409` genérico, sin tocar Mercado Pago.
4. Delega en la MISMA función que ya usa `api/pedidos.js`
   (`crearOReutilizarPreferenciaParaPedido`): si el pedido ya tiene un
   `mp_preference_id` reutilizable, NO crea una preferencia nueva (relee la existente
   en Mercado Pago); si no existe o ya no se puede reutilizar, crea una nueva. Ver
   3.4.2 para la regla exacta de "reutilizable vs. crear otra".
5. `external_reference` sigue fijado a `pedido.id` (sin cambios).
6. Responde **únicamente** `{ "redirectUrl": "..." }` en éxito. Nunca UUID interno,
   nunca `access_token`, nunca datos personales, nunca credenciales de Mercado Pago
   ni detalles de Supabase. En cualquier error, mensaje genérico + status HTTP
   (`400`/`404`/`409`/`500`/`502` según el caso, nunca detalle interno).

#### 3.4.1 Qué estados admiten reintentar el pago

`lib/pedido-preferencia.js#pedidoAdmitePago(pedido)` — documentado explícitamente,
como pidió el usuario:

- `estado_pago` debe ser `'pendiente'` o `'rechazado'` (un pago ya `'aprobado'` NUNCA
  admite reintento — evita un cobro duplicado; `'cancelado'`/`'reembolsado'` tampoco).
- `estado_pedido` debe ser `'pendiente_pago'` (si ya está `'cancelado'`, `'expirado'`,
  o avanzó en el fulfillment — `'a_preparar'`/`'enviado'`/`'entregado'` — no admite
  reintento).
- Ambas condiciones deben cumplirse a la vez.

#### 3.4.2 Cuándo una preferencia es reutilizable vs. cuándo crear una nueva

Esta regla vive en `lib/pedido-preferencia.js#crearOReutilizarPreferenciaParaPedido`
(sin cambios en esta actualización, reutilizada tal cual por el nuevo endpoint) y
queda documentada explícitamente aquí también:

- Si `pedido.mp_preference_id` existe, se hace un GET a Mercado Pago
  (`obtenerPreferenciaDeMercadoPago`) para releerla. **Se considera reutilizable**
  cuando esa lectura responde OK y expone un `sandbox_init_point` válido: en ese caso
  se devuelve ese `checkoutUrl` sin llamar a POST /checkout/preferences de nuevo (0
  preferencias nuevas creadas).
  - Mercado Pago no permite "editar" una preferencia existente in situ y expira las
    preferencias luego de un tiempo: si esa relectura falla (ya no existe, o no trae
    `sandbox_init_point`), **se considera no reutilizable** y se cae al paso
    siguiente: se crea una preferencia nueva y se actualiza `mp_preference_id` con el
    nuevo id (`asociarPreferenceId`). Esto es seguro porque `external_reference`
    sigue apuntando al mismo pedido y los items/precios salen del mismo snapshot ya
    persistido: nunca se duplica el pedido, nunca se altera un precio ni un producto.
- Si `pedido.mp_preference_id` es `null` (pedido nunca tuvo una preferencia, o el
  intento inicial en `POST /api/pedidos` falló antes de llegar a crear una), se crea
  una preferencia nueva directamente.

### 3.5 Migración de base de datos (commiteada, TODAVÍA NO aplicada)

`supabase/migrations/20260818120000_add_payment_retry_token.sql`:

- Agrega `pedidos.payment_retry_token_hash text` (nullable — un pedido cuyo intento
  inicial de pago ya tuvo éxito puede no tener ningún token de reintento asociado).
- `chk_pedidos_payment_retry_token_hash_formato`: exige formato hex de 64 caracteres
  cuando no es `null`.
- `uq_pedidos_payment_retry_token_hash`: índice único parcial (`where ... is not
  null`) — dos pedidos nunca comparten el mismo hash.
- `padel_crear_pedido` gana un 11er parámetro opcional
  `p_payment_retry_token_hash text default null`. Como Postgres identifica una
  función por nombre + tipos de argumento, la migración hace `drop function if
  exists ...(firma vieja de 10 parámetros)` antes de recrearla con 11, para no dejar
  un overload accidental.

**IMPORTANTE — esta migración NO fue aplicada contra ningún proyecto Supabase real**
(ni test/preview ni productivo) en este checkpoint. Aplicarla requiere autorización
explícita aparte. Hasta que se aplique, el código de `lib/padel-orders-store.js` que
pasa `p_payment_retry_token_hash` a la RPC fallará contra una base real que todavía
tenga la función vieja de 10 parámetros — esto es esperado y no debe "arreglarse"
improvisando; hay que aplicar la migración primero, con autorización.

## 4. Qué se implementó hasta ahora

### Archivos NUEVOS

- **`lib/payment-retry-token.js`** — generación (`generarPaymentRetryToken`,
  crypto.randomBytes(32) hex), validación de formato
  (`esPaymentRetryTokenValido`), hash determinista (`hashPaymentRetryToken`, SHA-256)
  y truncado seguro para logs (`truncarParaLog`, nunca expone el valor completo).
  **`tests/payment-retry-token.test.js` (11/11 OK).**
- **`api/pedidos-preferencia.js`** — el endpoint de reintento descrito en 3.4, con
  inyección de dependencias (`createPedidosPreferenciaHandler`) igual criterio que
  `api/pedidos.js`. **`tests/api-pedidos-preferencia.test.js`** cubre: allow-list y
  formato del token, que la búsqueda usa el hash y nunca el token en claro,
  autorización (token inexistente, pedido en cada estado que no admite pago,
  pedido `rechazado` que SÍ admite reintento), idempotencia (dos requests con el
  mismo token no rompen nada; delega la deduplicación real en
  `crearOReutilizarPreferenciaParaPedido`), respuesta mínima (únicamente
  `redirectUrl`), y que ningún mensaje de error revela detalles internos.
- **`supabase/migrations/20260818120000_add_payment_retry_token.sql`** — ver 3.5.
  Commiteada, NO aplicada contra Supabase real todavía.

### Archivos MODIFICADOS

- **`lib/padel-orders-store.js`** — `crearPedido()` ahora también genera un
  `payment_retry_token` (vía `lib/payment-retry-token.js`), lo pasa hasheado a la RPC
  (`p_payment_retry_token_hash`), y devuelve el valor en claro como propiedad NO
  persistida (`payment_retry_token`) en el objeto resultante — nunca se guarda ese
  valor en claro en ningún lado. Se agregó
  `obtenerPedidoPorPaymentRetryTokenHash(hash, client)` (busca por el HASH,
  nunca por el token en claro) y se exportó.
- **`lib/pedido-preferencia.js`** — se agregó `pedidoAdmitePago(pedido)` (ver 3.4.1) y
  las constantes `ESTADOS_PAGO_QUE_ADMITEN_PAGO`/`ESTADOS_PEDIDO_QUE_ADMITEN_PAGO`,
  exportadas. `crearOReutilizarPreferenciaParaPedido` **no cambió** (se reutiliza tal
  cual desde el nuevo endpoint).
- **`api/pedidos.js`** — la respuesta 201 ahora arma un objeto `respuesta` con
  `numero`/`redirectUrl` y agrega `paymentRetryToken` condicionalmente (ver 3.3).
  Nunca arma un literal `{...access...}` (el test estático que lo prohíbe sigue
  vigente sin modificar).
- **`widget/padel-checkout.js`** — ahora, al confirmar un pedido:
  - Si la respuesta trae un `redirectUrl` válido (mismo criterio de allow-list de
    hosts sandbox que `widget/mercadopago-buy.js`:
    `sandbox.mercadopago.com(.ar)` + `https:`), navega directo
    (`window.location.href`) al checkout de Mercado Pago. El carrito ya se vació
    antes (el pedido ya está registrado, se pueda o no continuar con el pago).
  - Si no hay `redirectUrl` pero sí `paymentRetryToken`, muestra la vista de
    confirmación de siempre + un botón nuevo "Pagar ahora" que llama a
    `POST /api/pedidos-preferencia` con el token guardado SOLO en memoria (nunca
    localStorage, nunca se loguea) y navega al `redirectUrl` que devuelva.
  - Si no hay ninguno de los dos, se comporta exactamente igual que antes (solo
    confirmación, sin botón de pago).
  - El token se descarta de memoria al volver a "Seguir comprando" o al cerrar el
    drawer a mitad del flujo de formulario/revisión.
- **`.env.example`** — se documentaron (solo nombres, sin valores)
  `MERCADOPAGO_ACCESS_TOKEN` y `MERCADOPAGO_ENV` (antes solo existían las variables de
  Supabase).
- **`tests/api-pedidos.test.js`** — el fake `crearPedido` ahora también devuelve
  `payment_retry_token`; se agregaron 3 tests nuevos (paymentRetryToken presente
  solo cuando `redirectUrl` es `null`; nunca presente cuando la preferencia inicial
  tuvo éxito; nunca se expone en formato `snake_case`).
- **`package.json`** — se agregaron `tests/payment-retry-token.test.js` (después de
  `mercadopago-preference.test.js`) y `tests/api-pedidos-preferencia.test.js`
  (después de `api-pedidos.test.js`) a la cadena `&&` del script `test`.

## 5. Qué todavía NO existe / NO fue tocado en esta etapa

- **La migración `20260818120000_add_payment_retry_token.sql` NO fue aplicada** contra
  ningún proyecto Supabase real (test/preview ni productivo). Requiere autorización
  explícita aparte antes de aplicarse.
- **El webhook (`api/webhook-mercadopago`) NO existe y no se implementa en esta
  etapa**, por instrucción explícita del usuario.
- **Ninguna preferencia real fue creada en Mercado Pago sandbox** en este checkpoint.
  No se hizo (ni se intentó) ninguna prueba manual contra Mercado Pago real, ni contra
  el nuevo endpoint con Supabase real — el usuario pidió explícitamente detenerse y
  pedir autorización antes de cualquier prueba manual sandbox.
- El flujo completo pedido→preferencia→reintento nunca corrió de punta a punta contra
  Mercado Pago real ni contra Supabase real en este checkpoint — sólo está probado a
  nivel de unidad/integración con fakes/mocks.
- No se implementó ninguna expiración/TTL explícita para `payment_retry_token`: hoy
  vive mientras el pedido admita pago (`pedidoAdmitePago`); si en el futuro se
  requiere que el token deje de ser válido después de X tiempo aunque el pedido siga
  `pendiente_pago`, es una decisión de diseño nueva, fuera de este checkpoint.

## 6. Estado de los tests (este checkpoint)

```
node --check lib/payment-retry-token.js lib/padel-orders-store.js
  lib/pedido-preferencia.js api/pedidos.js api/pedidos-preferencia.js
  widget/padel-checkout.js tests/payment-retry-token.test.js
  tests/api-pedidos.test.js tests/api-pedidos-preferencia.test.js
  -> ALL_SYNTAX_OK

node validate-catalog.js
  -> OK (92 productos, todo sincronizado y verde)

node tests/payment-retry-token.test.js
  -> Pruebas de lib/payment-retry-token.js: 11/11 OK

node tests/api-pedidos.test.js
  -> Pruebas de api/pedidos.js: 53/53 OK

node tests/api-pedidos-preferencia.test.js
  -> Pruebas de api/pedidos-preferencia.js: 23/23 OK

node tests/padel-orders-schema.test.js
  -> Pruebas estaticas del esquema de pedidos: 25/25 OK

npm test  (cadena completa, 22 archivos con &&)
  -> EXITCODE=0
  -> 533 líneas PASS, 0 líneas FAIL. Verde de punta a punta.
```

## 7. Qué falta implementar (fuera del alcance de este checkpoint)

1. Autorización explícita para aplicar
   `supabase/migrations/20260818120000_add_payment_retry_token.sql` contra un
   proyecto Supabase real (empezar por Preview/Test, nunca productivo directamente).
2. Autorización explícita para una prueba manual end-to-end contra Mercado Pago
   sandbox real (crear pedido → `paymentRetryToken`/`redirectUrl` real → reintentar
   si corresponde → verificar en el dashboard de Mercado Pago sandbox).
3. Implementar el webhook (`api/webhook-mercadopago`) — etapa futura, requiere
   autorización explícita nueva. Sin webhook, `estado_pago` nunca pasa de
   `'pendiente'` a `'aprobado'`/`'rechazado'` automáticamente todavía.
4. Decidir (si hace falta más adelante) una expiración explícita para
   `payment_retry_token` independiente del estado del pedido.

## 8. Variables de entorno necesarias (SOLO NOMBRES — nunca valores)

- `MERCADOPAGO_ACCESS_TOKEN` (ya usado por el endpoint legacy; el flujo de pedidos y
  el de reintento lo reutilizan; no se debe imprimir ni loguear jamás). Documentada en
  `.env.example`.
- `MERCADOPAGO_ENV` (valores válidos `sandbox` | `production`; default seguro
  `sandbox` si no está seteada o tiene un valor inesperado). Documentada en
  `.env.example`.
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (o el alias legacy
  `SUPABASE_SERVICE_ROLE_KEY`) — ya existentes, usados por
  `getSupabaseAdminClient()`.
- `VERCEL_URL` — usado por `getTrustedBaseUrl()` para construir `back_urls` y
  `notification_url`.
- `VERCEL_ENV` — sigue gateando el endpoint legacy `api/create-payment-preference.js`
  a `'preview'`; NO se usa como señal de sandbox/producción para el flujo nuevo.

## 9. Estado de Supabase relevante

- El pedido de prueba **`P10-000001`** (Cross Black '26, $206.000), creado en un
  checkpoint anterior, **se mantiene sin tocar.** No borrar.
- La migración nueva de esta actualización (`payment_retry_token_hash` + RPC de 11
  parámetros) **todavía no se aplicó** contra ningún proyecto Supabase real (ver
  sección 5). Hasta que se aplique con autorización explícita, el código nuevo que
  depende de esa columna/función solo está verificado con fakes/mocks, nunca contra
  una base real.
- RLS deny-by-default sigue confirmado en todas las tablas relevantes (sin cambios).
- No se hizo ninguna consulta ni escritura nueva a Supabase real en este checkpoint
  (sólo lectura de archivos locales y ejecución de tests que usan fakes/mocks).

## 10. Restricciones de seguridad (vigentes, sin excepción)

- NO tocar `main`.
- NO habilitar `MERCADOPAGO_ENV=production` ni ningún otro mecanismo que apunte a
  producción.
- NO realizar pagos reales.
- NO implementar el webhook todavía (ni el endpoint `api/webhook-mercadopago`, ni
  lógica de confirmación de pago).
- NO borrar el pedido de prueba `P10-000001`.
- NO aplicar la migración `20260818120000_add_payment_retry_token.sql` contra ningún
  proyecto Supabase real sin autorización explícita nueva.
- NO inventar valores de secrets ni variables de entorno.
- NO exponer valores de variables de entorno en logs, docs ni respuestas HTTP.
- NO exponer `access_token`/`accessToken` del pedido, el UUID interno, ni el
  `payment_retry_token`/su hash fuera de los casos exactos descritos en la sección 3,
  en ninguna respuesta HTTP pública.
- NO avanzar a una etapa posterior (webhook, confirmación de pago, cambio automático
  a `a_preparar`, panel admin, emails, logística) sin autorización explícita nueva.
- Antes de cualquier prueba manual que cree una preferencia real en Mercado Pago
  sandbox (inicial o de reintento), hay que detenerse y pedir autorización explícita
  — no se hizo ninguna en este checkpoint.

## 11. Estado del commit/push de este checkpoint

- **Pendiente de commit/push** al momento de escribir esta versión del documento —
  ver el historial de commits de la rama `asesor-ia-padel10store` para el hash y el
  resultado de CI una vez commiteado y pusheado (el checkpoint anterior, commit
  `f0e0cbf`, es el HEAD previo a esta actualización).
- Antes de commitear: `npm test`, `node validate-catalog.js` y `node --check` en todos
  los archivos tocados deben estar en verde localmente (ver sección 6), y el commit
  debe pushearse ÚNICAMENTE a `origin/asesor-ia-padel10store`, nunca a `main`.
- Este checkpoint queda cerrado aquí por instrucción explícita del usuario: no se
  aplica la migración nueva contra Supabase real, no se implementa el webhook, no se
  habilita producción, no se realizan pagos reales, no se hace ninguna prueba manual
  contra Mercado Pago sandbox, y no se avanza a una etapa posterior sin nueva
  autorización explícita.
