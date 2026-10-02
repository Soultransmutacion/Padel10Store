# Preparación para el lanzamiento público

Este documento indica qué falta para empezar a vender y en qué lugar exacto se completa cada dato. Ningún dato de esta lista se debe inventar ni completar con un valor de ejemplo.

## 1. Datos que se completan en el código

| Dato | Archivo | Campo |
| --- | --- | --- |
| Titular o razón social, CUIT, condición frente al IVA, domicilio, email, Instagram, horario | `lib/store-info.js` | `razonSocial`, `cuit`, `condicionIva`, `domicilio`, `email`, `instagramUrl`, `horarioAtencion` |
| Tarifas de envío por provincia y plazo | `lib/padel-shipping.js` | `CONFIG_ENVIO` (cambiar `modo` a `'tarifas'`) |
| ID de medición de Google Analytics 4 (`G-…`) | `lib/analytics-config.js` | `ga4MeasurementId` |
| ID del píxel de Meta (solo números) | `lib/analytics-config.js` | `metaPixelId` |
| Políticas propias de cambios, garantía del fabricante, envíos y plazo de conservación de datos | `legal/*.html` (recuadros "Pendiente") | texto |

Mientras un dato del vendedor esté en `null`, el sitio muestra "Pendiente de completar" en amarillo, así se ve que falta.

## 2. Envío y cobro

- Con `CONFIG_ENVIO.modo = 'a_confirmar'` (estado actual), el checkout muestra "Envío: a confirmar" y el total **sin envío**, y el pedido se registra **sin iniciar el pago**. El vendedor confirma el envío y la disponibilidad, y después coordina el pago.
- Con `modo = 'tarifas'`, el servidor (`api/pedidos.js`) suma el envío al total del pedido. Mercado Pago cobra productos y envío juntos (`lib/mercadopago-preference.js#buildShippingItem`), y el webhook verifica ese mismo total.
- La disponibilidad (stock) no se confirma automáticamente: ningún producto tiene `stockConfirmado: true` en `products.json`.

## 3. Variables de producción (Vercel → Project Settings → Environment Variables)

Los nombres de las variables están documentados en `.env.example`. Sus valores no se pegan en el chat ni se guardan en el repositorio.

- `CHECKOUT_ENABLED`: `true` habilita la compra online. Cualquier otro valor la deja pausada.
- `MERCADOPAGO_ACCESS_TOKEN`: en producción, el access token de la cuenta **real**. Se obtiene en Mercado Pago Developers → Tus integraciones → (aplicación) → Credenciales de producción.
- `MERCADOPAGO_ENV`: `production` para cobrar de verdad. Solo funciona en el deployment de Production de Vercel.
- `MERCADOPAGO_WEBHOOK_SECRET`: está en Mercado Pago Developers → (aplicación) → Webhooks → "Clave secreta". La URL de notificación es `https://<dominio>/api/mercadopago-webhook`, con el evento "Pagos".
- `SUPABASE_URL` y `SUPABASE_SECRET_KEY`: los datos del proyecto de Supabase donde se guardan los pedidos.

## 4. Medición

- **GA4**: analytics.google.com → Administrar → Flujos de datos → flujo web → "ID de medición".
- **Meta**: business.facebook.com → Administrador de eventos → Orígenes de datos → píxel → Configuración → ID.
- Eventos que se envían: `view_item`/`ViewContent` (ficha), `add_to_cart`/`AddToCart`, `begin_checkout`/`InitiateCheckout`, `purchase`/`Purchase` (al volver de Mercado Pago con el pago aprobado) y `pedido_registrado` (solo GA4, para pedidos con envío a confirmar).
- Los parámetros `utm_*`, `gclid` y `fbclid` se conservan durante toda la visita, también al ir y volver de Mercado Pago.
- Para los anuncios, usar enlaces como `https://<dominio>/?utm_source=instagram&utm_medium=paid&utm_campaign=<nombre>`.

## 5. Antes de publicar

- Hacer que un profesional revise los textos de `legal/`.
- Dar de alta el formulario "Data Fiscal" de ARCA, si corresponde, y agregar su código QR al pie de página.
- Confirmar que el enlace "Defensa de las y los Consumidores" sigue apuntando al formulario oficial vigente.
- Hacer una compra de prueba en sandbox desde el deployment de Preview antes de cambiar a production.
