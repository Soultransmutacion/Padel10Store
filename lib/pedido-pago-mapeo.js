'use strict';

/**
 * Fase 3, Etapa 4: mapeo de estados de pago de Mercado Pago al modelo de
 * estados propio del proyecto (ver supabase/migrations/20260814120100_
 * create_pedidos.sql y lib/padel-orders-store.js), mas las reglas de
 * transicion validas y la validacion de monto/moneda contra el snapshot
 * ya persistido del pedido.
 *
 * Este modulo es puro (sin I/O ni acceso a Supabase/Mercado Pago): solo
 * toma decisiones a partir de los datos que le pasa el llamador
 * (api/mercadopago-webhook.js), para poder testearlo de forma aislada.
 */

// Mapeo de status de pago de Mercado Pago -> estado_pago del proyecto.
// Cualquier status de Mercado Pago que NO este en este mapa se considera
// no reconocido (ver mapearEstadoPago): el llamador debe tratarlo como
// anomalia, nunca como un estado por defecto.
const MP_STATUS_A_ESTADO_PAGO = Object.freeze({
  approved: 'aprobado',
  pending: 'pendiente',
  in_process: 'pendiente',
  authorized: 'pendiente',
  rejected: 'rechazado',
  cancelled: 'cancelado',
  refunded: 'reembolsado',
  charged_back: 'reembolsado',
});

function mapearEstadoPago(mpStatus) {
  if (typeof mpStatus !== 'string') return null;
  const clave = mpStatus.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MP_STATUS_A_ESTADO_PAGO, clave)
    ? MP_STATUS_A_ESTADO_PAGO[clave]
    : null;
}

// Transiciones validas de estado_pago, "desde" -> lista de "hasta"
// permitidos (incluye siempre el propio estado, para poder tratar una
// notificacion repetida con el mismo status como un no-op valido en vez
// de una anomalia).
//
// - pendiente: primer estado de todo pedido. Puede resolverse en
//   cualquier direccion (aprobado/rechazado/cancelado).
// - rechazado: SI admite volver a pendiente o llegar a aprobado, porque
//   el mecanismo de payment_retry_token (Etapa 3) permite reintentar el
//   pago de un pedido rechazado con un pago NUEVO (nuevo mp_payment_id).
//   Ver lib/pedido-preferencia.js#ESTADOS_PAGO_QUE_ADMITEN_PAGO.
// - aprobado: es casi terminal. Un pago aprobado nunca puede "volver" a
//   pendiente/rechazado/cancelado (eso seria una transicion invalida:
//   Mercado Pago no hace eso, y si una notificacion lo sugiriera seria
//   sospechoso). Solo se admite avanzar a reembolsado (devolucion o
//   contracargo posterior a la aprobacion).
// - cancelado y reembolsado son terminales: lib/pedido-preferencia.js ya
//   no permite reintentar el pago de un pedido en estos estados
//   (ESTADOS_PAGO_QUE_ADMITEN_PAGO = ['pendiente', 'rechazado']), asi que
//   el webhook tampoco debe admitir que salgan de ahi.
const TRANSICIONES_ESTADO_PAGO_VALIDAS = Object.freeze({
  pendiente: Object.freeze(['pendiente', 'aprobado', 'rechazado', 'cancelado']),
  rechazado: Object.freeze(['rechazado', 'pendiente', 'aprobado', 'cancelado']),
  aprobado: Object.freeze(['aprobado', 'reembolsado']),
  cancelado: Object.freeze(['cancelado']),
  reembolsado: Object.freeze(['reembolsado']),
});

/**
 * Devuelve true si el pedido puede pasar de `estadoPagoActual` a
 * `estadoPagoNuevo`. Un estado actual no reconocido (dato corrupto/nuevo
 * valor no contemplado) se trata como invalido por defecto: nunca se
 * "asume" que una transicion desde un estado desconocido es segura.
 */
function esTransicionEstadoPagoValida(estadoPagoActual, estadoPagoNuevo) {
  const permitidos = TRANSICIONES_ESTADO_PAGO_VALIDAS[estadoPagoActual];
  if (!permitidos) return false;
  return permitidos.indexOf(estadoPagoNuevo) !== -1;
}

/**
 * Unica transicion de estado_pedido que este webhook aplica: cuando el
 * pago se aprueba y el pedido todavia esta en pendiente_pago, pasa a
 * a_preparar. Cualquier otro estado_pedido (a_preparar, enviado,
 * entregado, cancelado, expirado) queda fuera de alcance de esta etapa
 * (son responsabilidad de un futuro panel /admin) y este webhook nunca
 * los toca.
 */
function debeAvanzarAPreparar({ estadoPagoNuevo, estadoPedidoActual }) {
  return estadoPagoNuevo === 'aprobado' && estadoPedidoActual === 'pendiente_pago';
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Compara el monto y la moneda del pago REAL (ya consultado en la API
 * oficial de Mercado Pago) contra el snapshot ya persistido del pedido
 * (pedido.total / pedido.moneda, fijados en el momento de la creacion:
 * ver lib/padel-orders-store.js#crearPedido). Si no coinciden, el
 * llamador NUNCA debe marcar el pago como aprobado, sin importar lo que
 * diga payment.status.
 */
function montoYMonedaCoinciden({ pedido, payment }) {
  if (!pedido || typeof pedido !== 'object') return false;
  if (!payment || typeof payment !== 'object') return false;

  if (typeof payment.transactionAmount !== 'number' || !Number.isFinite(payment.transactionAmount)) {
    return false;
  }
  if (typeof payment.currencyId !== 'string' || !payment.currencyId) return false;

  const totalPedido = round2(pedido.total);
  const montoPago = round2(payment.transactionAmount);

  return totalPedido === montoPago && pedido.moneda === payment.currencyId;
}

module.exports = {
  MP_STATUS_A_ESTADO_PAGO,
  TRANSICIONES_ESTADO_PAGO_VALIDAS,
  mapearEstadoPago,
  esTransicionEstadoPagoValida,
  debeAvanzarAPreparar,
  montoYMonedaCoinciden,
};
