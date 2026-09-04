-- Fase 3, Etapa 1: tabla "pedido_items".
--
-- Snapshot historico de cada linea comprada. El catalogo (products.json /
-- lib/padel-catalog.js) sigue siendo la fuente de verdad al CREAR el
-- pedido, pero una vez creado, estos datos quedan congelados aca: si el
-- catalogo cambia despues (precio, nombre), el pedido ya facturado no debe
-- verse afectado.

create table if not exists public.pedido_items (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,

  product_id text not null,
  nombre text not null,
  -- Talle/variante: nullable a proposito (no todos los productos tienen
  -- talles, ej. accesorios).
  talle text,

  cantidad integer not null,
  precio_unitario numeric(12,2) not null,
  subtotal_linea numeric(12,2) not null,

  created_at timestamptz not null default now(),

  constraint chk_pedido_items_product_id_longitud
    check (char_length(product_id) between 1 and 200),
  constraint chk_pedido_items_nombre_longitud
    check (char_length(nombre) between 1 and 300),
  constraint chk_pedido_items_talle_longitud
    check (talle is null or char_length(talle) <= 50),

  constraint chk_pedido_items_cantidad_valida
    check (cantidad > 0 and cantidad <= 100),
  constraint chk_pedido_items_precio_no_negativo
    check (precio_unitario >= 0),
  constraint chk_pedido_items_subtotal_no_negativo
    check (subtotal_linea >= 0),

  -- Integridad del snapshot: el subtotal de linea siempre debe coincidir
  -- con precio_unitario * cantidad (redondeado a 2 decimales).
  constraint chk_pedido_items_subtotal_coincide
    check (subtotal_linea = round(precio_unitario * cantidad, 2))
);

create index if not exists ix_pedido_items_pedido_id on public.pedido_items (pedido_id);

alter table public.pedido_items enable row level security;
alter table public.pedido_items force row level security;
revoke all on public.pedido_items from anon, authenticated;
-- Deny by default: sin policies. Ver comentario equivalente en
-- 20260814120100_create_pedidos.sql.
