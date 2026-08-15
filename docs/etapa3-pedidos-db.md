# Fase 3, Etapa 1 — Base de datos + modelo de pedidos

Rama: `asesor-ia-padel10store`. Base aprobada para esta etapa: `0790513`.

Esta etapa crea la infraestructura de persistencia para pedidos reales
(Supabase/Postgres), pero **todavia no conecta** el carrito, el formulario
de compra ni Mercado Pago, y **todavia no expone** ningun endpoint publico
nuevo. Ver "Fuera de alcance" al final.

## Por que Supabase/Postgres

Se eligio Supabase (Postgres administrado) principalmente porque mas
adelante se va a usar **Supabase Auth** para proteger `/admin`, y compartir
el mismo proveedor evita duplicar infraestructura. Postgres ademas da
constraints reales (CHECK, UNIQUE, foreign keys, secuencias atomicas), que
es exactamente lo que este modelo de datos necesita.

## Integracion con Vercel (mecanismo oficial vigente, 2026)

Se investigo la integracion oficial de Supabase con Vercel antes de
diseñar esto:

- **Vercel Marketplace → Supabase** (https://vercel.com/marketplace/supabase)
  es el mecanismo recomendado: crea o vincula un proyecto Supabase como
  recurso de Vercel y sincroniza variables de entorno automaticamente en
  Production/Preview/Development.
- Variables que esa integracion agrega automaticamente:
  `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (mas
  variantes `POSTGRES_*` para conexion directa y variantes `NEXT_PUBLIC_*`
  que este proyecto no usa por no ser Next.js).
- Supabase esta migrando su sistema de API keys: las claves legadas
  `anon` / `service_role` (JWT) siguen funcionando pero se anuncio su
  deprecacion para fines de 2026, a favor de las claves nuevas
  **publishable** (`sb_publishable_...`, segura para el navegador) y
  **secret** (`sb_secret_...`, servidor unicamente, bypassa RLS).
- Por eso esta etapa usa **`SUPABASE_URL` + `SUPABASE_SECRET_KEY`** como
  variables primarias, con **`SUPABASE_SERVICE_ROLE_KEY`** como alias
  legado opcional (fallback) para proyectos que todavia no migraron.
- Decision de conexion: se usa `@supabase/supabase-js` (HTTP/PostgREST)
  en vez de una conexion Postgres directa (`pg`, `postgres.js`). Es lo que
  Supabase recomienda para entornos serverless como las funciones de
  Vercel, porque evita agotar el pool de conexiones con cada invocacion
  fria, y ya viene resuelto con RLS/roles/keys sin manejar `pgbouncer`
  manualmente.

Fuentes consultadas: [Supabase for Vercel](https://vercel.com/marketplace/supabase),
[Vercel Marketplace | Supabase Docs](https://supabase.com/docs/guides/integrations/vercel-marketplace),
[Understanding API keys | Supabase Docs](https://supabase.com/docs/guides/getting-started/api-keys),
[Declarative database schemas | Supabase Docs](https://supabase.com/docs/guides/local-development/declarative-database-schemas),
[Local development workflow | Supabase Docs](https://supabase.com/docs/guides/local-development/cli-workflows).

## Modelo de datos

### `pedidos`

| Columna | Notas |
|---|---|
| `id` | UUID interno, no enumerable (`gen_random_uuid()`). |
| `numero` | `P10-000001`, ... Generado por una **secuencia de Postgres** (`pedidos_numero_seq` + `generar_numero_pedido()`), nunca `MAX(numero)+1` en JS. |
| `access_token` | Token publico opaco, 32 bytes de `pgcrypto.gen_random_bytes` en hex (64 caracteres). Independiente del `id` y del `numero`. |
| `created_at` / `updated_at` | `updated_at` se mantiene con un trigger. |
| `comprador_nombre`, `comprador_documento` | Comprador. |
| `comprador_email`, `comprador_telefono` | Contacto. |
| `envio_direccion` | `jsonb`, exige las claves `calle, ciudad, provincia, codigo_postal, pais`. |
| `subtotal`, `total`, `moneda` | `moneda` restringida a `ARS` por ahora. |
| `estado_pago` | `pendiente \| aprobado \| rechazado \| cancelado \| reembolsado`. |
| `estado_pedido` | `pendiente_pago \| a_preparar \| enviado \| entregado \| cancelado \| expirado`. |
| `mp_preference_id`, `mp_payment_id` (UNIQUE), `mp_status_detail` | Integracion con Mercado Pago (todavia sin webhook). |
| `pagado_at`, `cancelado_at` | Se setean una sola vez, al entrar en el estado correspondiente. |
| `notas_admin` | Opcional, uso interno futuro de `/admin`. |

`estado_pedido = 'expirado'` se agrego porque un pedido `pendiente_pago`
cuya preferencia de Mercado Pago vence sin pagarse necesita un estado
distinto de `cancelado` (que implica una decision explicita) para que un
futuro proceso de limpieza/liberacion de stock lo pueda distinguir.

### `pedido_items`

Snapshot historico por linea: `product_id`, `nombre`, `talle` (nullable),
`cantidad`, `precio_unitario`, `subtotal_linea` (constraint: debe coincidir
con `precio_unitario * cantidad`). El catalogo (`products.json` /
`lib/padel-catalog.js`) sigue siendo la fuente de verdad **al crear** el
pedido; una vez creado, este snapshot queda congelado.

### `pedido_eventos`

Auditoria de: creacion, cambios de estado (con anterior/nuevo), asociacion
de `mp_preference_id`/`mp_payment_id`, notas admin. El campo `metadata`
(jsonb) esta acotado a 4000 bytes por constraint — a proposito **nunca**
guarda el payload completo de Mercado Pago ni datos sensibles, solo IDs,
codigos de estado y motivos breves.

### `webhook_eventos_procesados`

Deja lista la idempotencia futura del webhook: `UNIQUE (proveedor,
evento_id)`. El webhook en si **no se implementa en esta etapa**.

`admin_usuarios` **no se crea todavia**: se hara junto con Supabase Auth.

## Seguridad y RLS

- Las 4 tablas tienen `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL
  SECURITY`, **sin ninguna policy**. Deny by default: sin policies, RLS
  bloquea toda fila para `anon`/`authenticated`, tengan o no algun grant.
  Ademas se revocan explicitamente los grants de tabla a esos roles
  (`REVOKE ALL ... FROM anon, authenticated`), como defensa adicional.
- Solo la `secret key` / `service_role key` (que Postgres/Supabase
  marcan con `bypassrls`) puede leer o escribir estas tablas. Esa key
  **solo existe en variables de entorno de servidor** (Vercel) y nunca se
  importa desde `widget/` ni `index.html` (verificado con un test
  estatico que escanea esos archivos).
- La funcion RPC `padel_crear_pedido` revoca `EXECUTE` de
  `public/anon/authenticated` explicitamente (Postgres otorga `EXECUTE` a
  `PUBLIC` por defecto al crear una funcion).
- La futura consulta publica del comprador (para ver el estado de su
  pedido) se hara mediante un **endpoint server-side** que reciba el
  `access_token` opaco y use la secret key para buscar el pedido — nunca
  acceso directo del navegador a la tabla. Ese endpoint no se implementa
  en esta etapa.

## Capa de acceso a datos: `lib/padel-orders-store.js`

Unico punto donde vive SQL/Supabase para pedidos. Funciones expuestas:
`crearPedido`, `obtenerPedidoPorId`, `obtenerPedidoPorAccessToken`,
`asociarPreferenceId`, `asociarPaymentId`, `actualizarEstadoPago`,
`actualizarEstadoPedido`, `registrarEvento`, `obtenerEventosPorPedido`,
`estaEventoWebhookProcesado`, `marcarEventoWebhookProcesado`, ademas de
`ESTADOS_PAGO`/`ESTADOS_PEDIDO`/`PedidoStoreError`/`generarAccessTokenSeguro`.

- `crearPedido` valida el input en JS y llama a la funcion RPC
  `padel_crear_pedido`, que inserta el pedido + los items + el evento de
  auditoria inicial **en una unica transaccion** de Postgres (necesario
  porque PostgREST no soporta transacciones multi-request desde HTTP).
- El `access_token` se genera en Node con `crypto.randomBytes` (no
  `Math.random`) y se pasa explicito al RPC; el `DEFAULT` de la columna en
  SQL queda como respaldo solo para inserts manuales.
- El `numero` de pedido **nunca** se genera ni se pasa desde JS: siempre
  lo resuelve el `DEFAULT` de la columna via la secuencia de Postgres.
- Todas las funciones aceptan un cliente Supabase inyectable como ultimo
  parametro opcional (si no se pasa, usan un singleton lazy creado con las
  variables de entorno). Esto es lo que permite testear la capa entera sin
  tocar una base real.
- Errores tipados con `PedidoStoreError` y `.code` en
  `VALIDACION | NO_ENCONTRADO | CONFLICTO | CONFIGURACION | DB_ERROR`, para
  que futuros endpoints puedan mapear a HTTP sin depender de la forma
  interna de los errores de Supabase.

Todavia **no se expone** ninguna de estas funciones mediante un endpoint
publico.

## Migraciones (mecanismo oficial: Supabase CLI)

```
supabase/
  config.toml                 # sin secretos, seguro de versionar
  .gitignore                  # ignora estado local del CLI (.branches, .temp)
  migrations/
    20260814120000_extensions_and_helpers.sql
    20260814120100_create_pedidos.sql
    20260814120200_create_pedido_items.sql
    20260814120300_create_pedido_eventos.sql
    20260814120400_create_webhook_eventos_procesados.sql
    20260814120500_create_rpc_crear_pedido.sql
```

El esquema se puede recrear desde el repo, en orden, contra cualquier
proyecto Supabase nuevo. No se creo nada por clicks manuales en el
dashboard.

## Variables de entorno (ver `.env.example`)

```
SUPABASE_URL=
SUPABASE_SECRET_KEY=
#SUPABASE_SERVICE_ROLE_KEY=      # alias legado opcional

SUPABASE_TEST_URL=               # solo para npm run test:integration
SUPABASE_TEST_SECRET_KEY=        # debe apuntar a un proyecto de Preview/Test, nunca productivo
```

## Estrategia de tests

1. **`tests/padel-orders-store.test.js`** (unitario, parte de `npm test`):
   ejercita toda la capa de datos contra un cliente Supabase *fake* en
   memoria (mismo patron de mocking que ya usa el repo con `global.fetch`
   en `tests/mercadopago-preference.test.js`, pero inyectando el cliente
   en vez de mockear una llamada global). Cubre validaciones, estados,
   items/snapshot, relaciones, asociacion de IDs, unicidad de
   `mp_payment_id`, eventos e idempotencia de webhook, y que la secret key
   nunca aparece en logs/errores.
2. **`tests/padel-orders-schema.test.js`** (estatico, parte de `npm test`):
   lee las migraciones SQL y el resto del repo del disco (sin conexion a
   ninguna base) para verificar RLS deny-by-default, ausencia de
   policies, revocacion de grants, secuencia para `numero` (nunca
   `MAX()+1`), formato/longitud de `access_token`, constraints de estados,
   idempotencia del webhook, y los limites de esta etapa (sin
   `admin_usuarios`, sin endpoints nuevos, sin referencias desde
   `widget/`/`index.html`).
3. **`tests/padel-orders-store.integration.test.js`** (opcional, **no**
   forma parte de `npm test`; se corre con `npm run test:integration`):
   contra un Supabase real. Se salta automaticamente (exit 0) si no estan
   definidas `SUPABASE_TEST_URL`/`SUPABASE_TEST_SECRET_KEY`, para que CI
   nunca dependa de una base productiva ni de secretos. En GitHub Actions
   hay un job opcional (`test-integration-db` en
   `.github/workflows/ci-mercadopago.yml`) que solo corre si existe el
   secret `SUPABASE_TEST_URL` — hoy no existe, asi que ese job queda
   inerte hasta que se decida provisionar un proyecto de Preview/Test y
   cargar esos secrets en GitHub. **No se agrego ningun secreto real.**

`npm test` sigue corriendo los 378 tests previos sin cambios, mas 37
pruebas nuevas de `padel-orders-store.test.js` y 25 de
`padel-orders-schema.test.js`.

## Que falta para tener una base real (accion manual pendiente)

Estos pasos requieren decisiones/credenciales que no se pueden simular
desde el repo:

1. Crear el proyecto Supabase: opcion A, desde Vercel → *Storage* → *Create
   Database* → *Supabase* (integracion de Marketplace); opcion B, crear el
   proyecto directo en supabase.com y despues conectarlo a Vercel desde la
   misma integracion. En ambos casos Vercel sincroniza `SUPABASE_URL` /
   `SUPABASE_SECRET_KEY` (y las demas) automaticamente en Production y
   Preview.
2. Instalar el Supabase CLI localmente (`npm i -g supabase` o el metodo
   que prefieras) y correr `supabase login`.
3. Vincular el proyecto: `supabase link --project-ref <tu-project-ref>`.
4. Aplicar las migraciones: `supabase db push` (aplica en orden los 6
   archivos de `supabase/migrations/`).
5. Verificar en el dashboard de Supabase que las 4 tablas existen, que
   RLS figura habilitada y sin policies, y que `select * from pedidos`
   como usuario `anon` (SQL editor con "Run as" o la API con la
   publishable key) no devuelve filas.
6. (Opcional, para `npm run test:integration`) Crear un segundo proyecto
   Supabase de Preview/Test, aplicarle las mismas migraciones, y cargar
   `SUPABASE_TEST_URL` / `SUPABASE_TEST_SECRET_KEY` como GitHub Secrets del
   repo (nunca committearlos).

Avisame cuando quieras hacer esto y te guio paso a paso en el momento; no
se avanzo simulando que la base ya existe.

## Fuera de alcance de esta etapa (a proposito)

Formulario de comprador, endpoint publico `/api/pedidos`, Mercado Pago por
carrito, webhook, paginas de estado, `/admin`, Supabase Auth, emails,
envios/logistica. No se toca `main`.
