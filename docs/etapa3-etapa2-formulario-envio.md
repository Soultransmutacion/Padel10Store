# Fase 3, Etapa 2 — Formulario de comprador y datos de envío

Rama: `asesor-ia-padel10store`. No toca `main`. No crea infraestructura
nueva: reutiliza el proyecto Supabase real (`supabase-indigo-bell`) y la
capa de datos migrada y verificada en la Etapa 1
(`lib/padel-orders-store.js` + la RPC `padel_crear_pedido`).

Esta etapa permite que un comprador real cargue sus datos desde el carrito
y que eso cree una fila real en `pedidos` (con sus `pedido_items` y el
evento de auditoría `creacion`). **Todavía no integra Mercado Pago**: el
pedido se crea con `estado_pago = 'pendiente'` y sin ningún
`mp_preference_id`. No se cobra nada en esta etapa.

## Datos que se piden

**Comprador** (Etapa 2, sin documento — se agregará en una etapa futura si
la logística lo exige): nombre, apellido (ambos obligatorios).

**Contacto**: email, teléfono (ambos obligatorios).

**Dirección de envío**: provincia (select con las 24 provincias
argentinas), localidad, código postal, calle, número (todos obligatorios),
piso/departamento y aclaraciones de entrega (ambos opcionales). No hay
campo "país" editable: Padel10Store solo envía dentro de Argentina por
ahora, así que el país se fija siempre del lado servidor
(`lib/padel-checkout-fields.js#PAIS_FIJO`). Si el cliente llegara a mandar
un campo `pais`, el endpoint lo rechaza (no forma parte del contrato).

## Regla de mapeo comprador → esquema real

El esquema de la Etapa 1 (`supabase/migrations/20260814120100_create_pedidos.sql`)
tiene una única columna `comprador_nombre`, sin apellido separado. En vez
de migrar el esquema, `lib/padel-checkout-fields.js#construirNombreCompleto`
concatena nombre + apellido en un solo string (`"Juana Perez"`) antes de
llamar a `crearPedido()`. Es el único lugar del proyecto que decide este
mapeo. De la misma forma, `construirDireccionParaPedido` mapea
`localidad` (como lo ve el comprador) a la clave `ciudad` que exige la
constraint del esquema, y agrega `numero`/`piso_depto`/`aclaraciones` como
claves extra del `jsonb` (la constraint solo exige que existan
`calle/ciudad/provincia/codigo_postal/pais`, no prohíbe claves de más) — no
hizo falta ninguna migración nueva.

## Validación compartida: `lib/padel-checkout-fields.js`

Mismo patrón UMD que `lib/padel-cart.js` (carga con `require()` en Node y
con `<script>` en el navegador, sin `fs` ni variables de entorno de
servidor). El formulario del navegador (`widget/padel-checkout.js`) usa
estas mismas funciones solo para UX (mostrar el error antes de mandar
nada); `api/pedidos.js` vuelve a correr exactamente las mismas funciones
del lado servidor antes de crear un pedido, nunca confía en que el
formulario ya validó.

Los límites numéricos (largo de email, teléfono, nombre completo) están
duplicados como constantes propias de este archivo — no se pudo importarlos
directamente de `lib/padel-orders-store.js` porque ese módulo depende de
`@supabase/supabase-js` y no se puede cargar en el navegador. Para que
nunca diverjan en silencio, `tests/padel-checkout-fields.test.js` incluye
pruebas cruzadas que comparan ambos módulos y fallan si algún número deja
de coincidir.

## Flujo (dentro del drawer del carrito ya existente)

`CARRITO → Continuar con mis datos → FORMULARIO → Revisar pedido → REVISIÓN
→ Confirmar y crear pedido → CONFIRMACIÓN`.

No se creó ninguna página nueva: `widget/padel-checkout.js` reutiliza el
mismo drawer (`#cartDrawer`/`#cartDrawerBody`) que ya usaba
`widget/padel-cart.js`, alternando su contenido según la vista actual. Para
volver a mostrar la vista de carrito (línea de items, cantidades, total) se
reutiliza el render existente vía un nuevo método público
`window.PadelCart.renderDrawer()` — un cambio mínimo y aditivo en
`widget/padel-cart.js`, sin tocar ninguna lógica de negocio del carrito.

`Consultar por WhatsApp` se mantuvo intacto como alternativa independiente,
sin ningún cambio en su comportamiento.

Los datos ingresados en el formulario viven solo en memoria (nunca en
`localStorage`, por ser datos personales del comprador): si el drawer se
cierra a mitad del formulario y se vuelve a abrir, se reinicia en la vista
de carrito.

## Carrito: atomicidad y precios siempre recalculados server-side

El navegador manda a `POST /api/pedidos` exclusivamente
`{productId, talle, cantidad}` por línea (`window.PadelCart.getRawLines()`,
sin cambios). El servidor reconstruye nombre/precio/subtotal/total con
`PadelCartCore.buildCartSummary` (`lib/padel-cart.js`) contra el catálogo
real — la misma función que ya usa el navegador para mostrar el carrito.

Un detalle importante encontrado durante la implementación:
`buildCartSummary` usa `sanitizeQuantity`, un *clamp* tolerante pensado
para restaurar un carrito guardado en `localStorage` (corrige una cantidad
inválida en vez de descartar la línea). Para el endpoint eso es
exactamente lo que no se quiere: una cantidad manipulada (0, negativa, no
entera, o mayor al máximo) debe **rechazar la request entera**, nunca
"corregirse" en silencio. Por eso `api/pedidos.js` valida primero cada
cantidad con la versión estricta (`PadelCartCore.validateQuantity`, la
misma que usa el carrito para agregar una línea nueva) antes de reconstruir
el resumen. Esto lo cubre
`tests/api-pedidos.test.js` ("rechaza cantidad inválida: cero/negativa/no
entera/excesiva").

Si **cualquier** línea no se puede validar (producto inexistente, talle
inválido, cantidad inválida, producto "a consultar"), no se crea nada: el
pedido es atómico. Esto se refuerza dos veces: el endpoint rechaza la
request completa antes de llamar a `crearPedido()`, y la RPC
`padel_crear_pedido` además corre en una única transacción de Postgres, así
que tampoco puede quedar un pedido a medias del lado de la base.

## Endpoint: `POST /api/pedidos`

Mismo esqueleto defensivo que `api/create-payment-preference.js`: método
estricto (solo POST), `Content-Type` estricto, límite de tamaño de body
(8000 bytes), allow-list estricta de campos en cada nivel del body
(raíz, comprador, contacto, direcciónEnvío, cada item), mensajes de error
siempre genéricos, nada sensible en logs (de hecho, `api/pedidos.js` no usa
`console.*` en absoluto — verificado con un test estático).

La respuesta de éxito es únicamente `{ numero: "P10-000123" }`. Se decidió
**no** devolver el `access_token` en esta etapa (a pesar de que
`crearPedido()` ya lo genera): la futura página de seguimiento de pedido
todavía no existe, así que agregarlo ahora no simplifica nada concreto y sí
agrega superficie de exposición innecesaria. Cuando se construya esa
página (Etapa 3 o posterior) es un cambio de una línea agregarlo a la
respuesta.

## Seguridad (checklist)

- La Secret Key de Supabase sigue existiendo solo del lado servidor
  (`lib/padel-orders-store.js`, sin cambios). Ningún archivo de `widget/`
  ni `index.html` la referencia — test estático heredado de la Etapa 1
  (`tests/padel-orders-schema.test.js`) más los nuevos de esta etapa.
- RLS deny-by-default sin cambios (no se tocó ninguna migración).
- Ningún dato del comprador se envía al asistente de IA:
  `widget/padel-advisor.js`, `lib/padel-advisor-tools.js` y el system
  prompt del asistente no referencian el endpoint de pedidos ni sus campos
  — verificado con test estático nuevo
  (`tests/padel-checkout-static.test.js`).
- Todo el texto que ingresa el comprador (nombre, dirección, aclaraciones,
  etc.) se escapea antes de insertarse en el DOM (`escapeHtml`, mismo
  patrón que ya usaba `widget/padel-cart.js`).
- Ningún precio se confía nunca desde el navegador: ver la sección de
  arriba.

## Tests

Se agregaron 4 archivos nuevos a `npm test` (además de los ya existentes,
sin modificar ninguno):

- `tests/padel-checkout-fields.test.js` (47 casos): validación pura de
  comprador/contacto/dirección, mapeo a la forma que exige el esquema, y
  las pruebas cruzadas de límites contra `lib/padel-orders-store.js`.
- `tests/api-pedidos.test.js` (45 casos): el endpoint completo con un
  `crearPedido` de prueba inyectado (nunca toca Supabase real) — allow-list
  en cada nivel, atomicidad, recálculo de precios server-side, mapeo de
  errores a HTTP genérico, respuesta sin UUID ni access_token.
- `tests/padel-checkout-widget.test.js` (11 casos, con jsdom): el flujo
  completo carrito → formulario → revisión → confirmación contra los
  archivos reales del navegador, incluyendo que el carrito **no** se vacía
  si falla la creación del pedido y se vacía únicamente después de una
  confirmación real del servidor.
- `tests/padel-checkout-static.test.js` (10 casos): los chequeos estáticos
  de seguridad descriptos arriba.

`npm run test:integration` sigue sin cambios: se salta automáticamente sin
`SUPABASE_TEST_URL`/`SUPABASE_TEST_SECRET_KEY`, que siguen sin existir (se
decidió no crear un proyecto Supabase de test dedicado por ahora).

## Fuera de alcance de esta etapa (a propósito)

Mercado Pago para el carrito completo, webhook, página pública de
seguimiento de pedido (`/pedido/:accessToken`), `/admin`, Supabase Auth,
emails de confirmación, cálculo de envío/logística, cupones/descuentos,
documento/DNI del comprador, proyecto Supabase de test dedicado. No se
tocó `main`.

## Prueba manual pendiente (requiere autorización explícita)

Todavía no se hizo ninguna prueba manual contra Supabase real desde un
deploy de Preview. Como no hay un proyecto Supabase de test separado,
cualquier pedido de prueba en Preview inserta una fila real en la tabla
`pedidos`. Antes de hacer esa prueba (como máximo una, con datos
obviamente ficticios) hay que pedir autorización explícita — ver el
informe de cierre de esta etapa.
