-- Fase 3, Etapa 5 (Etapa 1 de la solucion de idempotencia): columnas +
-- RPC nueva para poder crear un pedido de forma ATOMICAMENTE idempotente
-- por "intencion de checkout".
--
-- Contexto (diagnostico previo, sin cambios de codigo): se detectaron
-- pedidos duplicados (P10-000008/P10-000009, P10-000011/P10-000012) en el
-- flujo "Comprar ahora". La causa raiz es que POST /api/pedidos no tiene
-- ninguna nocion de "este es el mismo intento de compra que el anterior":
-- cada POST valido crea una fila nueva via la RPC padel_crear_pedido, sin
-- ninguna clave de idempotencia ni constraint que pueda detectar (y mucho
-- menos resolver de forma atomica) dos intentos concurrentes o repetidos
-- del mismo checkout (doble click, reintento por error de red, recarga o
-- restauracion de pestaña, dos requests simultaneos).
--
-- Esta migracion es SOLO la Etapa 1 de la solucion: prepara el esquema y
-- una RPC NUEVA (con nombre distinto) que ya resuelve el problema de raiz
-- a nivel de base de datos. A proposito:
--   - NO modifica ni reemplaza la RPC padel_crear_pedido existente (el
--     deployment vigente de api/pedidos.js sigue funcionando exactamente
--     igual que hoy, sin ningun cambio de comportamiento).
--   - NO se conecta todavia desde ningun archivo de aplicacion
--     (api/pedidos.js, lib/padel-orders-store.js, widget/padel-checkout.js
--     siguen sin tocarse: ver tests/idempotencia-checkout-schema.test.js,
--     que verifica exactamente esto).
--   - Es puramente ADITIVA: agrega columnas nullable + una funcion nueva,
--     no altera ninguna fila ni columna existente.
--
-- IMPORTANTE: esta migracion queda commiteada en el repo pero TODAVIA NO
-- fue aplicada contra ningun proyecto Supabase real (ni de test/preview ni
-- productivo). Aplicarla requiere autorizacion explicita aparte, igual que
-- las migraciones anteriores de esta fase.

-- ---------------------------------------------------------------------
-- 1) + 3) Columnas nuevas (nullable): idempotency_key y
--    checkout_fingerprint.
-- ---------------------------------------------------------------------
--
-- idempotency_key: clave OPACA generada por quien inicia el checkout (en
-- la futura Etapa 2, el navegador via crypto.randomUUID()) que identifica
-- una UNICA intencion de compra. Se manda igual en el intento original y
-- en cualquier reintento (doble click que se escapo de la proteccion en
-- memoria, reintento manual tras un error/timeout, o el mismo intento
-- repetido despues de recargar/restaurar la pestaña). Nullable porque los
-- pedidos ya existentes -y cualquier fila creada por la RPC vieja,
-- padel_crear_pedido, que sigue intacta- nunca la tienen.
--
-- checkout_fingerprint: digest SHA-256 (hex, 64 caracteres) del CONTENIDO
-- YA VALIDADO del checkout (comprador+contacto+direccion+items, el mismo
-- input que hoy arma api/pedidos.js antes de llamar a crearPedido -nunca
-- del body crudo del navegador sin validar). Sirve para distinguir "esto
-- es un reintento legitimo del mismo intento" de "esta idempotency_key se
-- esta reutilizando con un contenido de checkout distinto", que la RPC
-- nueva (mas abajo) rechaza explicitamente en vez de devolver en silencio
-- un pedido que ya no corresponde a lo que se esta pidiendo crear.

alter table public.pedidos
  add column if not exists idempotency_key text;

alter table public.pedidos
  add column if not exists checkout_fingerprint text;

-- ---------------------------------------------------------------------
-- 4) Formato y longitud de las columnas nuevas.
-- ---------------------------------------------------------------------
--
-- idempotency_key: opaca, generada por el cliente (no necesariamente un
-- UUID: se acepta cualquier token seguro de largo razonable, mismo
-- criterio que access_token/payment_retry_token_hash en cuanto a "nunca
-- aceptar cualquier string arbitrario"). Se permite el alfabeto de un
-- UUID de crypto.randomUUID() (incluye guiones) y de tokens hex/base64url
-- genericos, con un piso de 16 caracteres (para descartar valores
-- triviales/adivinables) y un techo de 100 (mismo techo que
-- mp_preference_id/mp_payment_id en esta misma tabla).
alter table public.pedidos
  add constraint chk_pedidos_idempotency_key_formato
  check (
    idempotency_key is null
    or (
      char_length(idempotency_key) between 16 and 100
      and idempotency_key ~ '^[A-Za-z0-9_-]+$'
    )
  );

-- checkout_fingerprint: SIEMPRE un digest SHA-256 en hex minuscula cuando
-- esta presente (64 caracteres exactos), mismo criterio que
-- payment_retry_token_hash en esta tabla.
alter table public.pedidos
  add constraint chk_pedidos_checkout_fingerprint_formato
  check (
    checkout_fingerprint is null
    or checkout_fingerprint ~ '^[0-9a-f]{64}$'
  );

-- ---------------------------------------------------------------------
-- 2) Restriccion UNICA sobre idempotency_key.
-- ---------------------------------------------------------------------
--
-- Postgres permite multiples NULL en una columna UNIQUE (mismo criterio
-- ya usado en uq_pedidos_mp_payment_id, arriba en 20260814120100): esto
-- nunca bloquea los pedidos creados por la RPC vieja (que jamas setea
-- idempotency_key) ni ningun otro insert que no la use. Es esta
-- constraint la que le permite a Postgres resolver ATOMICAMENTE, a nivel
-- de indice, la carrera entre dos INSERT concurrentes con la misma clave
-- (ver "insert ... on conflict (idempotency_key)" en la RPC nueva mas
-- abajo): sin esta constraint, "on conflict" no tendria sobre que
-- indice actuar.
alter table public.pedidos
  add constraint uq_pedidos_idempotency_key unique (idempotency_key);

-- ---------------------------------------------------------------------
-- 5) + 6) RPC nueva: padel_crear_pedido_idempotente.
-- ---------------------------------------------------------------------
--
-- Mismo contrato de entrada que la RPC actual (padel_crear_pedido, que
-- queda 100% intacta: no se la toca ni se la reemplaza en esta
-- migracion), mas p_idempotency_key y p_checkout_fingerprint, ambos
-- obligatorios (sin default: esta funcion nueva ES el mecanismo
-- idempotente, no tiene sentido invocarla sin esos dos datos).
--
-- Estrategia de idempotencia atomica: "insert ... on conflict
-- (idempotency_key) do nothing returning *". Cuando dos requests
-- concurrentes llaman a esta funcion con la MISMA idempotency_key,
-- Postgres serializa ambos INSERT a nivel del indice unico subyacente a
-- uq_pedidos_idempotency_key: exactamente uno de los dos efectivamente
-- inserta la fila (y de ahi en mas crea items + evento, UNA sola vez);
-- el otro ve el conflicto, no inserta nada, y en cambio hace un SELECT
-- que -para el momento en que corre, porque tuvo que esperar a que la
-- transaccion ganadora terminara- ya encuentra la fila recien
-- confirmada, y la devuelve tal cual (sin duplicar items ni eventos).
-- Esto es lo que "resuelve atomicamente dos llamadas simultaneas": la
-- garantia la da el indice unico de Postgres, no ninguna logica de
-- aplicacion en JavaScript (que siempre tiene ventanas de carrera).
--
-- Si la idempotency_key ya existe pero con un checkout_fingerprint
-- DISTINTO del recibido, se rechaza explicitamente (excepcion, nunca se
-- devuelve en silencio el pedido viejo): esto es lo que distingue "es un
-- reintento legitimo del mismo intento" de "se esta reutilizando esta
-- clave para un contenido de checkout distinto" (bug de integracion o
-- intento de manipulacion). Usa un errcode propio (P0002, distinto del
-- P0001 generico que ya usan las validaciones de padel_crear_pedido) para
-- que un futuro llamador (fuera de alcance de esta migracion) pueda
-- distinguir este caso puntual si le hiciera falta.
--
-- Misma atomicidad transaccional que la RPC actual: toda la funcion corre
-- como una unica transaccion implicita (la llamada RPC es un unico
-- statement de nivel superior); si algo falla a mitad de camino (por
-- ejemplo, un item malformado dentro del loop), TODO se revierte,
-- incluida la fila de pedidos recien insertada. Nunca puede quedar un
-- pedido sin items, ni un pedido con items duplicados.

create or replace function public.padel_crear_pedido_idempotente(
  p_comprador_nombre text,
  p_comprador_email text,
  p_comprador_telefono text,
  p_comprador_documento text,
  p_envio_direccion jsonb,
  p_moneda text,
  p_subtotal numeric,
  p_total numeric,
  p_access_token text,
  p_items jsonb,
  p_payment_retry_token_hash text,
  p_idempotency_key text,
  p_checkout_fingerprint text
)
returns public.pedidos
language plpgsql
set search_path = public, extensions
as $$
declare
  v_pedido public.pedidos;
  v_existente public.pedidos;
  v_item jsonb;
  v_suma_items numeric(12,2);
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) = 0 then
    raise exception 'padel_crear_pedido_idempotente: se requiere idempotency_key' using errcode = 'P0001';
  end if;

  if p_checkout_fingerprint is null or p_checkout_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'padel_crear_pedido_idempotente: checkout_fingerprint invalido (se espera un digest SHA-256 en hex)' using errcode = 'P0001';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'padel_crear_pedido_idempotente: se requiere al menos un item' using errcode = 'P0001';
  end if;

  select coalesce(sum((item->>'subtotal_linea')::numeric(12,2)), 0)
    into v_suma_items
    from jsonb_array_elements(p_items) as item;

  if v_suma_items <> p_subtotal then
    raise exception
      'padel_crear_pedido_idempotente: el subtotal no coincide con la suma de los items (esperado %, recibido %)',
      v_suma_items, p_subtotal
      using errcode = 'P0001';
  end if;

  insert into public.pedidos (
    comprador_nombre, comprador_email, comprador_telefono, comprador_documento,
    envio_direccion, moneda, subtotal, total, access_token, payment_retry_token_hash,
    idempotency_key, checkout_fingerprint
  ) values (
    p_comprador_nombre, p_comprador_email, p_comprador_telefono, p_comprador_documento,
    p_envio_direccion, p_moneda, p_subtotal, p_total, p_access_token, p_payment_retry_token_hash,
    p_idempotency_key, p_checkout_fingerprint
  )
  on conflict (idempotency_key) do nothing
  returning * into v_pedido;

  if v_pedido.id is not null then
    -- Insercion NUEVA en este llamado: recien aca se crean items + evento,
    -- una unica vez.
    for v_item in select * from jsonb_array_elements(p_items)
    loop
      insert into public.pedido_items (
        pedido_id, product_id, nombre, talle, cantidad, precio_unitario, subtotal_linea
      ) values (
        v_pedido.id,
        v_item->>'product_id',
        v_item->>'nombre',
        v_item->>'talle',
        (v_item->>'cantidad')::integer,
        (v_item->>'precio_unitario')::numeric(12,2),
        (v_item->>'subtotal_linea')::numeric(12,2)
      );
    end loop;

    insert into public.pedido_eventos (
      pedido_id, tipo, estado_pago_nuevo, estado_pedido_nuevo, metadata
    ) values (
      v_pedido.id,
      'creacion',
      v_pedido.estado_pago,
      v_pedido.estado_pedido,
      jsonb_build_object('items_count', jsonb_array_length(p_items))
    );

    return v_pedido;
  end if;

  -- No se inserto nada: ya existia un pedido con esta idempotency_key
  -- (conflicto resuelto por Postgres a nivel del indice unico). Se
  -- recupera esa fila para decidir si es un reintento legitimo o una
  -- reutilizacion indebida de la clave.
  select * into v_existente
    from public.pedidos
    where idempotency_key = p_idempotency_key;

  if v_existente.id is null then
    -- No deberia poder pasar (el conflicto implica que la fila existe),
    -- pero se cubre explicitamente en vez de asumirlo.
    raise exception 'padel_crear_pedido_idempotente: conflicto de idempotencia sin fila existente' using errcode = 'P0001';
  end if;

  if v_existente.checkout_fingerprint is distinct from p_checkout_fingerprint then
    raise exception
      'padel_crear_pedido_idempotente: idempotency_key ya utilizada con un contenido de checkout distinto'
      using errcode = 'P0002';
  end if;

  -- Reintento legitimo del mismo intento: se devuelve el pedido ya
  -- creado, sin duplicar items ni eventos.
  return v_existente;
end;
$$;

comment on function public.padel_crear_pedido_idempotente(
  text, text, text, text, jsonb, text, numeric, numeric, text, jsonb, text, text, text
) is
  'Version idempotente de padel_crear_pedido: dado un idempotency_key + '
  'checkout_fingerprint (SHA-256 del contenido validado del checkout), '
  'crea el pedido + items + evento de auditoria una unica vez, incluso '
  'ante llamadas concurrentes con la misma clave (resuelto atomicamente '
  'via "insert ... on conflict (idempotency_key)"). Un reintento legitimo '
  '(misma clave, mismo fingerprint) devuelve el pedido ya existente sin '
  'duplicar nada; la misma clave con un fingerprint distinto se rechaza '
  '(errcode P0002). Etapa 1 de la solucion de idempotencia: todavia NO '
  'esta conectada desde ningun endpoint (ver api/pedidos.js, sin '
  'cambios). Uso exclusivo desde codigo de servidor via la secret key de '
  'Supabase, igual que padel_crear_pedido.';

-- ---------------------------------------------------------------------
-- 7) Mismos permisos que la RPC actual: deny by default. Postgres otorga
--    EXECUTE a PUBLIC por defecto al crear una funcion; se revoca
--    explicitamente, igual que padel_crear_pedido. Solo la secret key /
--    service_role key (que bypassa estos grants) puede invocarla.
-- ---------------------------------------------------------------------
revoke all on function public.padel_crear_pedido_idempotente(
  text, text, text, text, jsonb, text, numeric, numeric, text, jsonb, text, text, text
) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8) Verificacion manual POST-aplicacion.
-- ---------------------------------------------------------------------
--
-- Las siguientes consultas son de solo lectura y NO se ejecutan como
-- parte de esta migracion (quedan documentadas aca para correrlas a mano,
-- una por una, en el SQL editor de Supabase, despues de aplicar esta
-- migracion contra un proyecto real -Preview/Test primero, nunca
-- productivo sin autorizacion explicita-):
--
-- -- 8.1) Las dos columnas nuevas existen, son nullable, y tienen el tipo
-- --      esperado:
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'pedidos'
--     and column_name in ('idempotency_key', 'checkout_fingerprint')
--   order by column_name;
--
-- -- 8.2) Las 3 constraints nuevas existen:
-- select conname, contype
--   from pg_constraint
--   where conrelid = 'public.pedidos'::regclass
--     and conname in (
--       'chk_pedidos_idempotency_key_formato',
--       'chk_pedidos_checkout_fingerprint_formato',
--       'uq_pedidos_idempotency_key'
--     );
--
-- -- 8.3) La RPC nueva existe con la firma de 13 parametros, y la RPC
-- --      vieja (10 y 11 parametros historicos) sigue intacta:
-- select p.proname, pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname like 'padel_crear_pedido%'
--   order by p.proname, args;
--
-- -- 8.4) EXECUTE sigue revocado de public/anon/authenticated para la RPC
-- --      nueva (no debe devolver ninguna fila: si devuelve alguna, hay
-- --      un grant indebido):
-- select grantee, privilege_type
--   from information_schema.routine_privileges
--   where routine_schema = 'public'
--     and routine_name = 'padel_crear_pedido_idempotente'
--     and grantee in ('PUBLIC', 'anon', 'authenticated');
--
-- -- 8.5) Prueba funcional minima (opcional, en una transaccion que se
-- --      revierte sola con ROLLBACK: no deja datos de prueba):
-- -- begin;
-- --   select (public.padel_crear_pedido_idempotente(
-- --     'Test Idempotencia', 'test-idempotencia@example.com', null, null,
-- --     '{"calle":"Test","ciudad":"Test","provincia":"Test","codigo_postal":"0000","pais":"Argentina"}'::jsonb,
-- --     'ARS', 100.00, 100.00, encode(extensions.gen_random_bytes(32), 'hex'),
-- --     '[{"product_id":"x","nombre":"Test","talle":null,"cantidad":1,"precio_unitario":100.00,"subtotal_linea":100.00}]'::jsonb,
-- --     null, 'clave-de-prueba-manual-001', repeat('a', 64)
-- --   )).numero;
-- --   -- Repetir la MISMA llamada de nuevo en esta transaccion: debe
-- --   -- devolver el MISMO numero (no uno nuevo).
-- --   select (public.padel_crear_pedido_idempotente(
-- --     'Test Idempotencia', 'test-idempotencia@example.com', null, null,
-- --     '{"calle":"Test","ciudad":"Test","provincia":"Test","codigo_postal":"0000","pais":"Argentina"}'::jsonb,
-- --     'ARS', 100.00, 100.00, encode(extensions.gen_random_bytes(32), 'hex'),
-- --     '[{"product_id":"x","nombre":"Test","talle":null,"cantidad":1,"precio_unitario":100.00,"subtotal_linea":100.00}]'::jsonb,
-- --     null, 'clave-de-prueba-manual-001', repeat('a', 64)
-- --   )).numero;
-- -- rollback;

-- ---------------------------------------------------------------------
-- 9) Estrategia de rollback (documentada, NO ejecutada aca).
-- ---------------------------------------------------------------------
--
-- Esta migracion es puramente aditiva (columnas nullable + una funcion
-- nueva): revertirla es de bajo riesgo porque nada de lo agregado aca es
-- consumido todavia por ningun endpoint. Si hiciera falta deshacerla
-- despues de aplicarla contra un proyecto real, este seria el orden
-- correcto (inverso al de creacion, cada paso es independiente):
--
-- -- 9.1) Quitar la RPC nueva (nunca toca padel_crear_pedido, la vieja):
-- -- revoke all on function public.padel_crear_pedido_idempotente(
-- --   text, text, text, text, jsonb, text, numeric, numeric, text, jsonb, text, text, text
-- -- ) from public, anon, authenticated;
-- -- drop function if exists public.padel_crear_pedido_idempotente(
-- --   text, text, text, text, jsonb, text, numeric, numeric, text, jsonb, text, text, text
-- -- );
--
-- -- 9.2) Quitar la restriccion unica y las de formato:
-- -- alter table public.pedidos drop constraint if exists uq_pedidos_idempotency_key;
-- -- alter table public.pedidos drop constraint if exists chk_pedidos_checkout_fingerprint_formato;
-- -- alter table public.pedidos drop constraint if exists chk_pedidos_idempotency_key_formato;
--
-- -- 9.3) Quitar las columnas. ADVERTENCIA: esto borra permanentemente
-- --      cualquier valor ya guardado en esas columnas para pedidos reales
-- --      creados en el intervalo en que hubieran estado en uso (en esta
-- --      Etapa 1 no deberia haber ninguno, porque nada las escribe
-- --      todavia) - por eso este paso solo tiene sentido ejecutarlo ANTES
-- --      de que una Etapa futura conecte la RPC nueva a produccion, o
-- --      coordinado explicitamente si ya estuviera en uso:
-- -- alter table public.pedidos drop column if exists checkout_fingerprint;
-- -- alter table public.pedidos drop column if exists idempotency_key;
--
-- Ninguna de estas sentencias de rollback se ejecuta como parte de esta
-- migracion: quedan aca unicamente como referencia para una decision
-- futura explicita.
