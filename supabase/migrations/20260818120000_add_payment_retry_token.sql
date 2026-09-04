-- Fase 3, Etapa 3: payment_retry_token para reintentar el pago de un
-- pedido ya creado, sin reutilizar access_token.
--
-- access_token queda reservado exclusivamente para la futura consulta
-- segura del estado/seguimiento del pedido. Este mecanismo es
-- independiente y de proposito unico: solo autoriza el intento de
-- iniciar/reanudar el flujo de pago de UN pedido puntual.
--
-- Igual que con access_token, el valor en claro del token NUNCA se
-- persiste: se genera en Node (crypto.randomBytes) y solo se guarda en
-- esta tabla su hash SHA-256 (payment_retry_token_hash). Un dump o una
-- fuga de la tabla pedidos no alcanza para reconstruir tokens validos.
--
-- IMPORTANTE: esta migracion queda commiteada en el repo pero TODAVIA NO
-- fue aplicada contra ningun proyecto Supabase real (ni de test/preview
-- ni productivo). Aplicarla requiere autorizacion explicita aparte (ver
-- docs/CONTINUAR-FASE3.md).

alter table public.pedidos
  add column if not exists payment_retry_token_hash text;

-- El hash es un digest SHA-256 en hex: siempre 64 caracteres exactos
-- cuando esta presente. No es unique-not-null: un pedido cuyo intento de
-- pago inicial ya tuvo exito (se devolvio redirectUrl en el mismo
-- request) puede no tener ningun payment_retry_token asociado, ya que
-- este token solo se genera/expone cuando hace falta permitir un
-- reintento seguro desde el cliente.
alter table public.pedidos
  add constraint chk_pedidos_payment_retry_token_hash_formato
  check (
    payment_retry_token_hash is null
    or payment_retry_token_hash ~ '^[0-9a-f]{64}$'
  );

-- Un hash de token de reintento nunca deberia repetirse entre pedidos
-- distintos (colision practicamente imposible con SHA-256 sobre 256 bits
-- de entropia, pero el constraint deja la garantia explicita en el
-- esquema y evita que un bug futuro reutilice el mismo hash a proposito).
create unique index if not exists uq_pedidos_payment_retry_token_hash
  on public.pedidos (payment_retry_token_hash)
  where payment_retry_token_hash is not null;

-- padel_crear_pedido gana un 11er parametro opcional
-- (p_payment_retry_token_hash) para poder guardar el hash del token de
-- reintento en la misma transaccion atomica en la que se crea el pedido.
-- Postgres identifica una funcion por nombre + lista de tipos de
-- argumentos: como se agrega un parametro nuevo, hay que eliminar
-- primero la version anterior (10 parametros) para no dejar dos
-- funciones (overload) coexistiendo por accidente.
drop function if exists public.padel_crear_pedido(
  text, text, text, text, jsonb, text, numeric, numeric, text, jsonb
);

create or replace function public.padel_crear_pedido(
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
  p_payment_retry_token_hash text default null
)
returns public.pedidos
language plpgsql
set search_path = public, extensions
as $$
declare
  v_pedido public.pedidos;
  v_item jsonb;
  v_suma_items numeric(12,2);
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'padel_crear_pedido: se requiere al menos un item' using errcode = 'P0001';
  end if;

  select coalesce(sum((item->>'subtotal_linea')::numeric(12,2)), 0)
    into v_suma_items
    from jsonb_array_elements(p_items) as item;

  if v_suma_items <> p_subtotal then
    raise exception
      'padel_crear_pedido: el subtotal no coincide con la suma de los items (esperado %, recibido %)',
      v_suma_items, p_subtotal
      using errcode = 'P0001';
  end if;

  insert into public.pedidos (
    comprador_nombre, comprador_email, comprador_telefono, comprador_documento,
    envio_direccion, moneda, subtotal, total, access_token, payment_retry_token_hash
  ) values (
    p_comprador_nombre, p_comprador_email, p_comprador_telefono, p_comprador_documento,
    p_envio_direccion, p_moneda, p_subtotal, p_total, p_access_token, p_payment_retry_token_hash
  )
  returning * into v_pedido;

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
end;
$$;

comment on function public.padel_crear_pedido(
  text, text, text, text, jsonb, text, numeric, numeric, text, jsonb, text
) is
  'Crea un pedido + sus items + el evento de auditoria inicial en una '
  'unica transaccion. Uso exclusivo desde codigo de servidor '
  '(lib/padel-orders-store.js) via la secret key de Supabase.';

-- Postgres otorga EXECUTE a PUBLIC por defecto al crear una funcion: hay
-- que revocarlo explicitamente para mantener el criterio deny by default.
-- Solo la secret key / service_role key (que bypassa estos grants) puede
-- invocar esta funcion.
revoke all on function public.padel_crear_pedido(
  text, text, text, text, jsonb, text, numeric, numeric, text, jsonb, text
) from public, anon, authenticated;
