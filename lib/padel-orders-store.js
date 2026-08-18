'use strict';

/**
 * Capa de acceso a datos para pedidos reales de Padel10Store
 * (Fase 3, Etapa 1: base de datos + modelo de pedidos).
 *
 * Todo el SQL/DB de pedidos vive unicamente en este archivo y en
 * supabase/migrations/. Los futuros endpoints (carrito, formulario,
 * Mercado Pago, webhook, /admin) deben usar estas funciones y nunca
 * escribir SQL propio ni consultar Supabase directamente.
 *
 * Seguridad:
 * - Este modulo usa exclusivamente la "secret key" (o, en proyectos que
 *   todavia no migraron, la service_role key legada) de Supabase, que
 *   SOLO debe existir del lado servidor. Nunca debe importarse desde
 *   codigo que corra en el navegador (widget/, index.html).
 * - Las 4 tablas de pedidos tienen Row Level Security habilitada sin
 *   ninguna policy (deny by default): ni siquiera un token
 *   anon/authenticated puede leerlas o escribirlas. Solo la secret key
 *   (que bypassa RLS por diseno de Supabase) puede operar sobre ellas.
 * - Esta capa nunca loguea ni devuelve la secret key en ningun mensaje de
 *   error ni valor de retorno.
 *
 * Este archivo todavia NO se expone mediante ningun endpoint publico.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const ESTADOS_PAGO = Object.freeze([
  'pendiente',
  'aprobado',
  'rechazado',
  'cancelado',
  'reembolsado',
]);

const ESTADOS_PEDIDO = Object.freeze([
  'pendiente_pago',
  'a_preparar',
  'enviado',
  'entregado',
  'cancelado',
  'expirado',
]);

const MONEDAS_VALIDAS = Object.freeze(['ARS']);

const TIPOS_EVENTO = Object.freeze([
  'creacion',
  'cambio_estado_pago',
  'cambio_estado_pedido',
  'asociacion_preference',
  'asociacion_payment',
  'nota_admin',
  'otro',
]);

const DIRECCION_CLAVES_REQUERIDAS = Object.freeze([
  'calle',
  'ciudad',
  'provincia',
  'codigo_postal',
  'pais',
]);

const LIMITES = Object.freeze({
  compradorNombre: 200,
  compradorDocumento: 50,
  compradorEmail: 320,
  compradorTelefono: 50,
  notasAdmin: 2000,
  productId: 200,
  nombreItem: 300,
  talle: 50,
  cantidadMaxima: 100,
  mpPreferenceId: 100,
  mpPaymentId: 100,
  mpStatusDetail: 200,
  metadataBytes: 4000,
});

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN_BYTES = 32;

class PedidoStoreError extends Error {
  constructor(code, message, options) {
    super(message);
    this.name = 'PedidoStoreError';
    this.code = code;
    if (options && options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

let cachedClient = null;

// Solo para tests: fuerza a que la proxima llamada a getSupabaseAdminClient()
// vuelva a leer process.env y a crear un cliente nuevo.
function resetSupabaseAdminClientForTests() {
  cachedClient = null;
}

function getSupabaseAdminClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  // SUPABASE_SECRET_KEY es la nomenclatura vigente (2026) de Supabase.
  // SUPABASE_SERVICE_ROLE_KEY se acepta como alias legado para proyectos
  // que todavia no migraron a las claves publishable/secret nuevas.
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !secretKey) {
    throw new PedidoStoreError(
      'CONFIGURACION',
      'Faltan variables de entorno de Supabase del lado servidor (SUPABASE_URL y SUPABASE_SECRET_KEY).'
    );
  }

  cachedClient = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
  return cachedClient;
}

function esUuidValido(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

// Genera un access token publico, aleatorio y criptograficamente seguro.
// Nunca se deriva del UUID interno ni del numero de pedido: son 32 bytes
// de randomness propios, codificados en hex (64 caracteres), generados con
// crypto.randomBytes (CSPRNG del sistema operativo).
function generarAccessTokenSeguro() {
  return crypto.randomBytes(ACCESS_TOKEN_BYTES).toString('hex');
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function mapSupabaseError(error, operacion) {
  return new PedidoStoreError(
    'DB_ERROR',
    `Error de base de datos en ${operacion}: ${(error && error.message) || 'desconocido'}`,
    { cause: error }
  );
}

function esViolacionUnicidad(error) {
  return Boolean(error) && error.code === '23505';
}

function validarItem(item, idx) {
  if (!item || typeof item !== 'object') {
    throw new PedidoStoreError('VALIDACION', `items[${idx}] invalido`);
  }
  if (
    typeof item.productId !== 'string' ||
    !item.productId.trim() ||
    item.productId.length > LIMITES.productId
  ) {
    throw new PedidoStoreError('VALIDACION', `items[${idx}].productId invalido`);
  }
  if (
    typeof item.nombre !== 'string' ||
    !item.nombre.trim() ||
    item.nombre.length > LIMITES.nombreItem
  ) {
    throw new PedidoStoreError('VALIDACION', `items[${idx}].nombre invalido`);
  }
  if (item.talle !== undefined && item.talle !== null) {
    if (typeof item.talle !== 'string' || item.talle.length > LIMITES.talle) {
      throw new PedidoStoreError('VALIDACION', `items[${idx}].talle invalido`);
    }
  }
  if (!Number.isInteger(item.cantidad) || item.cantidad < 1 || item.cantidad > LIMITES.cantidadMaxima) {
    throw new PedidoStoreError(
      'VALIDACION',
      `items[${idx}].cantidad invalida (debe ser un entero entre 1 y ${LIMITES.cantidadMaxima})`
    );
  }
  if (
    typeof item.precioUnitario !== 'number' ||
    !Number.isFinite(item.precioUnitario) ||
    item.precioUnitario < 0
  ) {
    throw new PedidoStoreError('VALIDACION', `items[${idx}].precioUnitario invalido`);
  }
}

function normalizarItem(item) {
  const precioUnitario = round2(item.precioUnitario);
  const cantidad = item.cantidad;
  return {
    product_id: item.productId,
    nombre: item.nombre,
    talle: item.talle === undefined ? null : item.talle,
    cantidad,
    precio_unitario: precioUnitario,
    subtotal_linea: round2(precioUnitario * cantidad),
  };
}

function validarInputCrearPedido(input) {
  if (!input || typeof input !== 'object') {
    throw new PedidoStoreError('VALIDACION', 'input de crearPedido invalido');
  }

  const comprador = input.comprador;
  if (!comprador || typeof comprador.nombre !== 'string' || !comprador.nombre.trim()) {
    throw new PedidoStoreError('VALIDACION', 'comprador.nombre es obligatorio');
  }
  if (comprador.nombre.length > LIMITES.compradorNombre) {
    throw new PedidoStoreError(
      'VALIDACION',
      `comprador.nombre supera ${LIMITES.compradorNombre} caracteres`
    );
  }
  if (comprador.documento !== undefined && comprador.documento !== null) {
    if (typeof comprador.documento !== 'string' || comprador.documento.length > LIMITES.compradorDocumento) {
      throw new PedidoStoreError('VALIDACION', 'comprador.documento invalido');
    }
  }

  const contacto = input.contacto;
  if (!contacto || typeof contacto.email !== 'string' || !EMAIL_REGEX.test(contacto.email)) {
    throw new PedidoStoreError('VALIDACION', 'contacto.email es obligatorio y debe ser valido');
  }
  if (contacto.email.length > LIMITES.compradorEmail) {
    throw new PedidoStoreError(
      'VALIDACION',
      `contacto.email supera ${LIMITES.compradorEmail} caracteres`
    );
  }
  if (contacto.telefono !== undefined && contacto.telefono !== null) {
    if (typeof contacto.telefono !== 'string' || contacto.telefono.length > LIMITES.compradorTelefono) {
      throw new PedidoStoreError('VALIDACION', 'contacto.telefono invalido');
    }
  }

  const direccion = input.direccionEnvio;
  if (!direccion || typeof direccion !== 'object' || Array.isArray(direccion)) {
    throw new PedidoStoreError('VALIDACION', 'direccionEnvio es obligatoria');
  }
  DIRECCION_CLAVES_REQUERIDAS.forEach((clave) => {
    if (!direccion[clave] || typeof direccion[clave] !== 'string' || !direccion[clave].trim()) {
      throw new PedidoStoreError('VALIDACION', `direccionEnvio.${clave} es obligatoria`);
    }
  });

  if (input.moneda !== undefined && !MONEDAS_VALIDAS.includes(input.moneda)) {
    throw new PedidoStoreError('VALIDACION', `moneda invalida: ${input.moneda}`);
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new PedidoStoreError('VALIDACION', 'se requiere al menos un item');
  }
  input.items.forEach(validarItem);

  if (input.total !== undefined) {
    if (typeof input.total !== 'number' || !Number.isFinite(input.total) || input.total < 0) {
      throw new PedidoStoreError('VALIDACION', 'total invalido');
    }
  }
}

/**
 * Crea un pedido junto con sus items y el evento de auditoria inicial, de
 * forma atomica (usa la funcion RPC padel_crear_pedido, que corre todo en
 * una unica transaccion de Postgres).
 *
 * input:
 *   - comprador: { nombre, documento? }
 *   - contacto: { email, telefono? }
 *   - direccionEnvio: { calle, ciudad, provincia, codigo_postal, pais, ... }
 *   - items: [{ productId, nombre, talle?, cantidad, precioUnitario }]
 *   - moneda?: 'ARS' (default)
 *   - total?: si no se pasa, se usa la suma de los items (subtotal)
 */
async function crearPedido(input, client) {
  validarInputCrearPedido(input);
  const c = client || getSupabaseAdminClient();

  const items = input.items.map(normalizarItem);
  const subtotal = round2(items.reduce((acc, it) => acc + it.subtotal_linea, 0));
  const total = input.total === undefined ? subtotal : round2(input.total);

  const accessToken = generarAccessTokenSeguro();

  const { data, error } = await c.rpc('padel_crear_pedido', {
    p_comprador_nombre: input.comprador.nombre,
    p_comprador_email: input.contacto.email,
    p_comprador_telefono: input.contacto.telefono === undefined ? null : input.contacto.telefono,
    p_comprador_documento: input.comprador.documento === undefined ? null : input.comprador.documento,
    p_envio_direccion: input.direccionEnvio,
    p_moneda: input.moneda || 'ARS',
    p_subtotal: subtotal,
    p_total: total,
    p_access_token: accessToken,
    p_items: items,
  });

  if (error) throw mapSupabaseError(error, 'crearPedido');
  return data;
}

async function obtenerPedidoPorId(id, client) {
  if (!esUuidValido(id)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  const c = client || getSupabaseAdminClient();
  const { data, error } = await c.from('pedidos').select('*').eq('id', id).maybeSingle();
  if (error) throw mapSupabaseError(error, 'obtenerPedidoPorId');
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');
  return data;
}

async function obtenerPedidoPorAccessToken(accessToken, client) {
  if (typeof accessToken !== 'string' || accessToken.length < 20) {
    throw new PedidoStoreError('VALIDACION', 'access token invalido');
  }
  const c = client || getSupabaseAdminClient();
  const { data, error } = await c
    .from('pedidos')
    .select('*')
    .eq('access_token', accessToken)
    .maybeSingle();
  if (error) throw mapSupabaseError(error, 'obtenerPedidoPorAccessToken');
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');
  return data;
}

async function obtenerItemsPorPedido(pedidoId, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  const c = client || getSupabaseAdminClient();
  const { data, error } = await c
    .from('pedido_items')
    .select('*')
    .eq('pedido_id', pedidoId)
    .order('created_at', { ascending: true });
  if (error) throw mapSupabaseError(error, 'obtenerItemsPorPedido');
  return data || [];
}

async function registrarEvento(input, client) {
  if (!esUuidValido(input.pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  if (!TIPOS_EVENTO.includes(input.tipo)) {
    throw new PedidoStoreError('VALIDACION', `tipo de evento invalido: ${input.tipo}`);
  }
  const metadata = input.metadata || {};
  const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  if (metadataBytes > LIMITES.metadataBytes) {
    throw new PedidoStoreError(
      'VALIDACION',
      'metadata de evento demasiado grande: nunca se debe guardar el payload completo'
    );
  }
  const c = client || getSupabaseAdminClient();

  const row = {
    pedido_id: input.pedidoId,
    tipo: input.tipo,
    estado_pago_anterior: input.estadoPagoAnterior === undefined ? null : input.estadoPagoAnterior,
    estado_pago_nuevo: input.estadoPagoNuevo === undefined ? null : input.estadoPagoNuevo,
    estado_pedido_anterior: input.estadoPedidoAnterior === undefined ? null : input.estadoPedidoAnterior,
    estado_pedido_nuevo: input.estadoPedidoNuevo === undefined ? null : input.estadoPedidoNuevo,
    metadata,
  };

  const { data, error } = await c.from('pedido_eventos').insert(row).select().single();
  if (error) throw mapSupabaseError(error, 'registrarEvento');
  return data;
}

async function obtenerEventosPorPedido(pedidoId, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  const c = client || getSupabaseAdminClient();
  const { data, error } = await c
    .from('pedido_eventos')
    .select('*')
    .eq('pedido_id', pedidoId)
    .order('created_at', { ascending: true });
  if (error) throw mapSupabaseError(error, 'obtenerEventosPorPedido');
  return data || [];
}

async function asociarPreferenceId(pedidoId, mpPreferenceId, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  if (
    typeof mpPreferenceId !== 'string' ||
    !mpPreferenceId.trim() ||
    mpPreferenceId.length > LIMITES.mpPreferenceId
  ) {
    throw new PedidoStoreError('VALIDACION', 'mp_preference_id invalido');
  }
  const c = client || getSupabaseAdminClient();

  const { data, error } = await c
    .from('pedidos')
    .update({ mp_preference_id: mpPreferenceId })
    .eq('id', pedidoId)
    .select()
    .single();
  if (error) throw mapSupabaseError(error, 'asociarPreferenceId');
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');

  await registrarEvento(
    { pedidoId, tipo: 'asociacion_preference', metadata: { mp_preference_id: mpPreferenceId } },
    c
  );

  return data;
}

async function asociarPaymentId(pedidoId, mpPaymentId, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  if (
    typeof mpPaymentId !== 'string' ||
    !mpPaymentId.trim() ||
    mpPaymentId.length > LIMITES.mpPaymentId
  ) {
    throw new PedidoStoreError('VALIDACION', 'mp_payment_id invalido');
  }
  const c = client || getSupabaseAdminClient();

  const { data, error } = await c
    .from('pedidos')
    .update({ mp_payment_id: mpPaymentId })
    .eq('id', pedidoId)
    .select()
    .single();

  if (error) {
    if (esViolacionUnicidad(error)) {
      throw new PedidoStoreError(
        'CONFLICTO',
        'mp_payment_id ya esta asociado a otro pedido',
        { cause: error }
      );
    }
    throw mapSupabaseError(error, 'asociarPaymentId');
  }
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');

  await registrarEvento(
    { pedidoId, tipo: 'asociacion_payment', metadata: { mp_payment_id: mpPaymentId } },
    c
  );

  return data;
}

async function actualizarEstadoPago(pedidoId, nuevoEstado, opts, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  if (!ESTADOS_PAGO.includes(nuevoEstado)) {
    throw new PedidoStoreError('VALIDACION', `estado_pago invalido: ${nuevoEstado}`);
  }
  const c = client || getSupabaseAdminClient();
  const opciones = opts || {};

  const pedidoActual = await obtenerPedidoPorId(pedidoId, c);

  const patch = { estado_pago: nuevoEstado };
  if (opciones.mpStatusDetail !== undefined) {
    if (opciones.mpStatusDetail !== null && String(opciones.mpStatusDetail).length > LIMITES.mpStatusDetail) {
      throw new PedidoStoreError('VALIDACION', 'mp_status_detail demasiado largo');
    }
    patch.mp_status_detail = opciones.mpStatusDetail;
  }
  if (nuevoEstado === 'aprobado' && !pedidoActual.pagado_at) {
    patch.pagado_at = new Date().toISOString();
  }
  if (nuevoEstado === 'cancelado' && !pedidoActual.cancelado_at) {
    patch.cancelado_at = new Date().toISOString();
  }

  const { data, error } = await c.from('pedidos').update(patch).eq('id', pedidoId).select().single();
  if (error) throw mapSupabaseError(error, 'actualizarEstadoPago');
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');

  await registrarEvento(
    {
      pedidoId,
      tipo: 'cambio_estado_pago',
      estadoPagoAnterior: pedidoActual.estado_pago,
      estadoPagoNuevo: nuevoEstado,
      metadata: opciones.mpStatusDetail ? { mp_status_detail: opciones.mpStatusDetail } : {},
    },
    c
  );

  return data;
}

async function actualizarEstadoPedido(pedidoId, nuevoEstado, opts, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  if (!ESTADOS_PEDIDO.includes(nuevoEstado)) {
    throw new PedidoStoreError('VALIDACION', `estado_pedido invalido: ${nuevoEstado}`);
  }
  const c = client || getSupabaseAdminClient();
  const opciones = opts || {};

  const pedidoActual = await obtenerPedidoPorId(pedidoId, c);

  const patch = { estado_pedido: nuevoEstado };
  if (nuevoEstado === 'cancelado' && !pedidoActual.cancelado_at) {
    patch.cancelado_at = new Date().toISOString();
  }

  const { data, error } = await c.from('pedidos').update(patch).eq('id', pedidoId).select().single();
  if (error) throw mapSupabaseError(error, 'actualizarEstadoPedido');
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');

  await registrarEvento(
    {
      pedidoId,
      tipo: 'cambio_estado_pedido',
      estadoPedidoAnterior: pedidoActual.estado_pedido,
      estadoPedidoNuevo: nuevoEstado,
      metadata: opciones.motivo ? { motivo: String(opciones.motivo).slice(0, 200) } : {},
    },
    c
  );

  return data;
}

function validarProveedorEventoId(proveedor, eventoId) {
  if (proveedor !== 'mercadopago') {
    throw new PedidoStoreError('VALIDACION', `proveedor de webhook invalido: ${proveedor}`);
  }
  if (typeof eventoId !== 'string' || !eventoId.trim() || eventoId.length > 200) {
    throw new PedidoStoreError('VALIDACION', 'evento_id de webhook invalido');
  }
}

async function estaEventoWebhookProcesado(proveedor, eventoId, client) {
  validarProveedorEventoId(proveedor, eventoId);
  const c = client || getSupabaseAdminClient();

  const { data, error } = await c
    .from('webhook_eventos_procesados')
    .select('id')
    .eq('proveedor', proveedor)
    .eq('evento_id', eventoId)
    .maybeSingle();
  if (error) throw mapSupabaseError(error, 'estaEventoWebhookProcesado');
  return Boolean(data);
}

async function marcarEventoWebhookProcesado(input, client) {
  validarProveedorEventoId(input.proveedor, input.eventoId);

  if (input.pedidoId !== undefined && input.pedidoId !== null && !esUuidValido(input.pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'pedidoId invalido');
  }
  if (input.tipo !== undefined && input.tipo !== null) {
    if (typeof input.tipo !== 'string' || input.tipo.length > 100) {
      throw new PedidoStoreError('VALIDACION', 'tipo de evento de webhook invalido');
    }
  }

  const metadata = input.metadata || {};
  const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  if (metadataBytes > LIMITES.metadataBytes) {
    throw new PedidoStoreError(
      'VALIDACION',
      'metadata de webhook demasiado grande: nunca se debe guardar el payload completo'
    );
  }
  const c = client || getSupabaseAdminClient();

  const row = {
    proveedor: input.proveedor,
    evento_id: input.eventoId,
    tipo: input.tipo === undefined ? null : input.tipo,
    pedido_id: input.pedidoId === undefined ? null : input.pedidoId,
    metadata,
  };

  const { data, error } = await c.from('webhook_eventos_procesados').insert(row).select().single();
  if (error) {
    if (esViolacionUnicidad(error)) {
      throw new PedidoStoreError(
        'CONFLICTO',
        'Este evento de webhook ya fue procesado (idempotencia)',
        { cause: error }
      );
    }
    throw mapSupabaseError(error, 'marcarEventoWebhookProcesado');
  }
  return data;
}

module.exports = {
  ESTADOS_PAGO,
  ESTADOS_PEDIDO,
  MONEDAS_VALIDAS,
  TIPOS_EVENTO,
  DIRECCION_CLAVES_REQUERIDAS,
  LIMITES,
  PedidoStoreError,

  getSupabaseAdminClient,
  resetSupabaseAdminClientForTests,
  generarAccessTokenSeguro,
  esUuidValido,

  crearPedido,
  obtenerPedidoPorId,
  obtenerPedidoPorAccessToken,
  obtenerItemsPorPedido,
  asociarPreferenceId,
  asociarPaymentId,
  actualizarEstadoPago,
  actualizarEstadoPedido,
  registrarEvento,
  obtenerEventosPorPedido,
  estaEventoWebhookProcesado,
  marcarEventoWebhookProcesado,
};
