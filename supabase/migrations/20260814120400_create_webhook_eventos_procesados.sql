-- Fase 3, Etapa 1: tabla "webhook_eventos_procesados".
--
-- Prepara la estructura necesaria para la idempotencia futura del webhook
-- de Mercado Pago. El webhook en si NO se implementa todavia en esta
-- etapa: esta tabla solo deja lista la base para que, cuando se implemente,
-- cada notificacion externa se procese una unica vez.

create table if not exists public.webhook_eventos_procesados (
  id uuid primary key default gen_random_uuid(),

  proveedor text not null default 'mercadopago',
  -- Identificador del evento/notificacion segun el proveedor externo
  -- (ej. id de notificacion de Mercado Pago). Junto con "proveedor" forma
  -- la clave de idempotencia.
  evento_id text not null,
  tipo text,

  pedido_id uuid references public.pedidos (id) on delete set null,

  -- Metadata tecnica minima, nunca el payload completo (mismo criterio que
  -- pedido_eventos).
  metadata jsonb not null default '{}'::jsonb,

  procesado_at timestamptz not null default now(),

  constraint chk_webhook_eventos_proveedor_valido check (proveedor in ('mercadopago')),
  constraint chk_webhook_eventos_evento_id_longitud
    check (char_length(evento_id) between 1 and 200),
  constraint chk_webhook_eventos_tipo_longitud
    check (tipo is null or char_length(tipo) <= 100),
  constraint chk_webhook_eventos_metadata_acotada
    check (pg_column_size(metadata) <= 4000),

  -- Clave de idempotencia: un mismo evento del mismo proveedor solo puede
  -- procesarse (insertarse) una vez.
  constraint uq_webhook_eventos_proveedor_evento unique (proveedor, evento_id)
);

create index if not exists ix_webhook_eventos_pedido_id
  on public.webhook_eventos_procesados (pedido_id);

alter table public.webhook_eventos_procesados enable row level security;
alter table public.webhook_eventos_procesados force row level security;
revoke all on public.webhook_eventos_procesados from anon, authenticated;
-- Deny by default: sin policies. Ver comentario equivalente en
-- 20260814120100_create_pedidos.sql.
