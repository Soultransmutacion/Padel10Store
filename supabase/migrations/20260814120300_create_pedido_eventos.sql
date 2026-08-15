-- Fase 3, Etapa 1: tabla "pedido_eventos".
--
-- Auditoria de cambios relevantes de un pedido (creacion, cambios de
-- estado, asociacion de IDs de Mercado Pago, notas administrativas). A
-- proposito NO guarda payloads completos de proveedores externos ni datos
-- sensibles del comprador: solo metadata tecnica minima (IDs, codigos de
-- estado, motivo breve) necesaria para diagnostico. El tamano de esa
-- metadata esta acotado por una constraint como defensa adicional.

create table if not exists public.pedido_eventos (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,

  tipo text not null,

  estado_pago_anterior text,
  estado_pago_nuevo text,
  estado_pedido_anterior text,
  estado_pedido_nuevo text,

  -- Metadata tecnica minima. Nunca el payload completo de Mercado Pago ni
  -- datos sensibles del comprador (ver constraint de tamano abajo).
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  constraint chk_pedido_eventos_tipo_valido check (
    tipo in (
      'creacion',
      'cambio_estado_pago',
      'cambio_estado_pedido',
      'asociacion_preference',
      'asociacion_payment',
      'nota_admin',
      'otro'
    )
  ),
  constraint chk_pedido_eventos_estado_pago_anterior_valido check (
    estado_pago_anterior is null or estado_pago_anterior in (
      'pendiente', 'aprobado', 'rechazado', 'cancelado', 'reembolsado'
    )
  ),
  constraint chk_pedido_eventos_estado_pago_nuevo_valido check (
    estado_pago_nuevo is null or estado_pago_nuevo in (
      'pendiente', 'aprobado', 'rechazado', 'cancelado', 'reembolsado'
    )
  ),
  constraint chk_pedido_eventos_estado_pedido_anterior_valido check (
    estado_pedido_anterior is null or estado_pedido_anterior in (
      'pendiente_pago', 'a_preparar', 'enviado', 'entregado', 'cancelado', 'expirado'
    )
  ),
  constraint chk_pedido_eventos_estado_pedido_nuevo_valido check (
    estado_pedido_nuevo is null or estado_pedido_nuevo in (
      'pendiente_pago', 'a_preparar', 'enviado', 'entregado', 'cancelado', 'expirado'
    )
  ),

  -- No almacenar indiscriminadamente payloads completos: se limita el
  -- tamano serializado de metadata (defensa en profundidad; la capa de
  -- datos tambien lo valida antes de insertar).
  constraint chk_pedido_eventos_metadata_acotada
    check (pg_column_size(metadata) <= 4000)
);

create index if not exists ix_pedido_eventos_pedido_id on public.pedido_eventos (pedido_id);
create index if not exists ix_pedido_eventos_created_at on public.pedido_eventos (created_at desc);

alter table public.pedido_eventos enable row level security;
alter table public.pedido_eventos force row level security;
revoke all on public.pedido_eventos from anon, authenticated;
-- Deny by default: sin policies. Ver comentario equivalente en
-- 20260814120100_create_pedidos.sql.
