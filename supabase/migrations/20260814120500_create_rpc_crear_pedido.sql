-- Fase 3, Etapa 1: funcion RPC "padel_crear_pedido".
--
-- Crea un pedido junto con sus items y el evento de auditoria inicial en
-- una unica transaccion (el cuerpo de la funcion corre atomicamente): si
-- algo falla a mitad de camino, no queda un pedido sin items ni un pedido
-- con totales inconsistentes. Esto evita tener que coordinar varios
-- inserts sueltos desde JavaScript (PostgREST no soporta transacciones
-- multi-request).
--
-- El numero de pedido lo sigue generando el DEFAULT de la columna
-- (secuencia de Postgres), nunca un parametro de esta funcion. El
-- access_token lo genera la capa de datos en Node (crypto.randomBytes) y
-- se pasa como parametro; el DEFAULT de la columna queda como respaldo
-- solo para inserts manuales que no pasen por esta funcion.

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
  p_items jsonb
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
    envio_direccion, moneda, subtotal, total, access_token
  ) values (
    p_comprador_nombre, p_comprador_email, p_comprador_telefono, p_comprador_documento,
    p_envio_direccion, p_moneda, p_subtotal, p_total, p_access_token
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
  text, text, text, text, jsonb, text, numeric, numeric, text, jsonb
) is
  'Crea un pedido + sus items + el evento de auditoria inicial en una '
  'unica transaccion. Uso exclusivo desde codigo de servidor '
  '(lib/padel-orders-store.js) via la secret key de Supabase.';

-- Postgres otorga EXECUTE a PUBLIC por defecto al crear una funcion: hay
-- que revocarlo explicitamente para mantener el criterio deny by default.
-- Solo la secret key / service_role key (que bypassa estos grants) puede
-- invocar esta funcion.
revoke all on function public.padel_crear_pedido(
  text, text, text, text, jsonb, text, numeric, numeric, text, jsonb
) from public, anon, authenticated;
