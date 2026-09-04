-- Fase 3, Etapa 1: extensiones y funciones auxiliares para pedidos reales.
--
-- Esta migracion NO crea todavia ninguna tabla de negocio. Solo prepara:
--   1) la extension pgcrypto (para generar access tokens criptograficamente
--      seguros), instalada en el schema "extensions" (recomendacion oficial
--      de Supabase, para no mezclar objetos de extensiones con "public");
--   2) una funcion generica para mantener "updated_at" al dia;
--   3) la secuencia y funcion que generan el numero legible de pedido
--      (P10-000001, P10-000002, ...) de forma atomica del lado de Postgres.
--
-- IMPORTANTE: el numero de pedido NUNCA se calcula como MAX(numero)+1 desde
-- JavaScript (eso no es seguro con escrituras concurrentes). Se usa una
-- sequence nativa de Postgres, que garantiza valores unicos e incrementales
-- incluso con multiples pedidos creandose al mismo tiempo.

create extension if not exists pgcrypto with schema extensions;

-- Trigger generico: setea updated_at = now() en cada UPDATE de una fila.
-- Se usa en "pedidos" (Etapa 1) y podra reutilizarse en tablas futuras.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger generico: setea updated_at = now() en cada UPDATE.';

-- Secuencia dedicada exclusivamente al numero legible de pedido.
create sequence if not exists public.pedidos_numero_seq
  as bigint
  start with 1
  increment by 1
  no cycle;

-- Genera "P10-" + el siguiente valor de la secuencia, con padding a 6
-- digitos (P10-000001). Si la secuencia supera 999999, el numero crece a
-- mas digitos en lugar de truncarse o repetirse.
create or replace function public.generar_numero_pedido()
returns text
language sql
set search_path = public
as $$
  select 'P10-' || lpad(nextval('public.pedidos_numero_seq')::text, 6, '0');
$$;

comment on function public.generar_numero_pedido() is
  'Genera el numero legible unico de pedido (P10-000001, ...) a partir de '
  'public.pedidos_numero_seq de forma atomica. El numero nunca debe '
  'calcularse tomando el maximo existente mas uno desde JavaScript.';
