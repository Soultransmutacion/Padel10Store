-- Fase 3, Etapa 1: tabla "pedidos".
--
-- Guarda un pedido real. Los items van en "pedido_items" (snapshot
-- historico) y la auditoria de cambios en "pedido_eventos".
--
-- Seguridad: RLS habilitada sin ninguna policy (deny by default). Ni
-- siquiera un token anon/authenticated puede leer o escribir esta tabla.
-- Solo la secret key / service_role key de Supabase (que se usa
-- exclusivamente en codigo de servidor) puede operar sobre ella, porque
-- esa key bypassa RLS por diseno de Supabase. La futura consulta publica
-- del comprador se hara mediante un endpoint server-side que valide el
-- access_token, nunca por acceso directo a esta tabla desde el navegador.

create table if not exists public.pedidos (
  -- Identidad interna, no enumerable (UUID v4 aleatorio, no secuencial).
  id uuid primary key default gen_random_uuid(),

  -- Numero legible unico (P10-000001, ...). Generado por Postgres via
  -- secuencia (ver 20260814120000_extensions_and_helpers.sql). Nunca se
  -- calcula en JavaScript.
  numero text not null unique default public.generar_numero_pedido(),

  -- Token de acceso publico opaco. Aleatorio y criptograficamente seguro
  -- (32 bytes de pgcrypto codificados en hex = 64 caracteres). NUNCA se
  -- deriva del id ni del numero: son generados de forma independiente.
  access_token text not null unique
    default encode(extensions.gen_random_bytes(32), 'hex'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Comprador y contacto.
  comprador_nombre text not null,
  comprador_documento text,
  comprador_email text not null,
  comprador_telefono text,

  -- Direccion de envio. Se valida como JSON estructurado (no texto libre)
  -- para que la capa de datos y futuros procesos de logistica puedan
  -- confiar en su forma. Claves minimas requeridas via constraint abajo.
  envio_direccion jsonb not null,

  subtotal numeric(12,2) not null,
  total numeric(12,2) not null,
  moneda text not null default 'ARS',

  estado_pago text not null default 'pendiente',
  estado_pedido text not null default 'pendiente_pago',

  mp_preference_id text,
  mp_payment_id text,
  mp_status_detail text,

  pagado_at timestamptz,
  cancelado_at timestamptz,

  -- Notas administrativas opcionales (uso interno, futuro /admin).
  notas_admin text,

  constraint chk_pedidos_numero_formato
    check (numero ~ '^P10-[0-9]{6,}$'),
  constraint chk_pedidos_access_token_longitud
    check (char_length(access_token) >= 40),

  constraint chk_pedidos_comprador_nombre_longitud
    check (char_length(comprador_nombre) between 1 and 200),
  constraint chk_pedidos_comprador_documento_longitud
    check (comprador_documento is null or char_length(comprador_documento) <= 50),
  constraint chk_pedidos_comprador_email_formato
    check (
      comprador_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      and char_length(comprador_email) <= 320
    ),
  constraint chk_pedidos_comprador_telefono_longitud
    check (comprador_telefono is null or char_length(comprador_telefono) <= 50),

  constraint chk_pedidos_envio_direccion_claves
    check (
      envio_direccion ?& array['calle', 'ciudad', 'provincia', 'codigo_postal', 'pais']
    ),

  constraint chk_pedidos_subtotal_no_negativo check (subtotal >= 0),
  constraint chk_pedidos_total_no_negativo check (total >= 0),
  constraint chk_pedidos_moneda_valida check (moneda in ('ARS')),

  -- Estados cerrados: nunca se permiten strings arbitrarios.
  constraint chk_pedidos_estado_pago_valido check (
    estado_pago in ('pendiente', 'aprobado', 'rechazado', 'cancelado', 'reembolsado')
  ),
  constraint chk_pedidos_estado_pedido_valido check (
    estado_pedido in (
      'pendiente_pago', 'a_preparar', 'enviado', 'entregado', 'cancelado', 'expirado'
    )
  ),

  constraint chk_pedidos_mp_preference_id_longitud
    check (mp_preference_id is null or char_length(mp_preference_id) <= 100),
  constraint chk_pedidos_mp_payment_id_longitud
    check (mp_payment_id is null or char_length(mp_payment_id) <= 100),
  constraint chk_pedidos_mp_status_detail_longitud
    check (mp_status_detail is null or char_length(mp_status_detail) <= 200),
  constraint chk_pedidos_notas_admin_longitud
    check (notas_admin is null or char_length(notas_admin) <= 2000),

  -- Un mismo pago de Mercado Pago no puede quedar asociado a mas de un
  -- pedido. Postgres permite multiples NULL en una columna UNIQUE, asi que
  -- esto no bloquea pedidos que todavia no tienen mp_payment_id.
  constraint uq_pedidos_mp_payment_id unique (mp_payment_id)
);

create index if not exists ix_pedidos_estado_pago on public.pedidos (estado_pago);
create index if not exists ix_pedidos_estado_pedido on public.pedidos (estado_pedido);
create index if not exists ix_pedidos_created_at on public.pedidos (created_at desc);

drop trigger if exists trg_pedidos_set_updated_at on public.pedidos;
create trigger trg_pedidos_set_updated_at
  before update on public.pedidos
  for each row
  execute function public.set_updated_at();

alter table public.pedidos enable row level security;
alter table public.pedidos force row level security;
revoke all on public.pedidos from anon, authenticated;
-- Deny by default a proposito: no se define ninguna policy. Sin policies,
-- RLS bloquea toda fila para anon/authenticated aunque tuvieran algun
-- grant. Solo la secret key / service_role key (uso exclusivo de
-- servidor) puede leer o escribir esta tabla.
