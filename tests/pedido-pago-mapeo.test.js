'use strict';

/**
 * Pruebas de lib/pedido-pago-mapeo.js (Fase 3, Etapa 4: mapeo de estados de
 * pago de Mercado Pago + transiciones validas + validacion de monto/moneda).
 *
 * Modulo puro: estas pruebas son sincronas, sin I/O ni mocks de red/DB.
 */

const assert = require('assert');
const {
  MP_STATUS_A_ESTADO_PAGO,
  mapearEstadoPago,
  esTransicionEstadoPagoValida,
  debeAvanzarAPreparar,
  montoYMonedaCoinciden,
} = require('../lib/pedido-pago-mapeo');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
  }
}

// --- mapearEstadoPago -------------------------------------------------

test('mapearEstadoPago: approved -> aprobado', () => {
  assert.strictEqual(mapearEstadoPago('approved'), 'aprobado');
});

test('mapearEstadoPago: pending -> pendiente', () => {
  assert.strictEqual(mapearEstadoPago('pending'), 'pendiente');
});

test('mapearEstadoPago: in_process -> pendiente', () => {
  assert.strictEqual(mapearEstadoPago('in_process'), 'pendiente');
});

test('mapearEstadoPago: authorized -> pendiente', () => {
  assert.strictEqual(mapearEstadoPago('authorized'), 'pendiente');
});

test('mapearEstadoPago: rejected -> rechazado', () => {
  assert.strictEqual(mapearEstadoPago('rejected'), 'rechazado');
});

test('mapearEstadoPago: cancelled -> cancelado', () => {
  assert.strictEqual(mapearEstadoPago('cancelled'), 'cancelado');
});

test('mapearEstadoPago: refunded -> reembolsado', () => {
  assert.strictEqual(mapearEstadoPago('refunded'), 'reembolsado');
});

test('mapearEstadoPago: charged_back -> reembolsado', () => {
  assert.strictEqual(mapearEstadoPago('charged_back'), 'reembolsado');
});

test('mapearEstadoPago: status desconocido -> null (nunca un default silencioso)', () => {
  assert.strictEqual(mapearEstadoPago('in_mediation'), null);
  assert.strictEqual(mapearEstadoPago('algo-inventado'), null);
});

test('mapearEstadoPago: acepta mayusculas/espacios y normaliza', () => {
  assert.strictEqual(mapearEstadoPago(' Approved '), 'aprobado');
  assert.strictEqual(mapearEstadoPago('REJECTED'), 'rechazado');
});

test('mapearEstadoPago: entradas no-string -> null', () => {
  assert.strictEqual(mapearEstadoPago(null), null);
  assert.strictEqual(mapearEstadoPago(undefined), null);
  assert.strictEqual(mapearEstadoPago(123), null);
});

test('MP_STATUS_A_ESTADO_PAGO cubre exactamente los status documentados', () => {
  assert.deepStrictEqual(Object.keys(MP_STATUS_A_ESTADO_PAGO).sort(), [
    'approved',
    'authorized',
    'cancelled',
    'charged_back',
    'in_process',
    'pending',
    'refunded',
    'rejected',
  ]);
});

// --- esTransicionEstadoPagoValida --------------------------------------

test('transicion valida: pendiente -> aprobado', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('pendiente', 'aprobado'), true);
});

test('transicion valida: pendiente -> rechazado', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('pendiente', 'rechazado'), true);
});

test('transicion valida: pendiente -> cancelado', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('pendiente', 'cancelado'), true);
});

test('transicion valida: rechazado -> aprobado (reintento exitoso)', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('rechazado', 'aprobado'), true);
});

test('transicion valida: rechazado -> pendiente (nuevo intento en curso)', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('rechazado', 'pendiente'), true);
});

test('transicion valida: aprobado -> reembolsado', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('aprobado', 'reembolsado'), true);
});

test('transicion valida (no-op): mismo estado siempre se admite', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('pendiente', 'pendiente'), true);
  assert.strictEqual(esTransicionEstadoPagoValida('aprobado', 'aprobado'), true);
  assert.strictEqual(esTransicionEstadoPagoValida('cancelado', 'cancelado'), true);
  assert.strictEqual(esTransicionEstadoPagoValida('reembolsado', 'reembolsado'), true);
});

test('transicion INVALIDA: aprobado nunca retrocede a pendiente/rechazado/cancelado', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('aprobado', 'pendiente'), false);
  assert.strictEqual(esTransicionEstadoPagoValida('aprobado', 'rechazado'), false);
  assert.strictEqual(esTransicionEstadoPagoValida('aprobado', 'cancelado'), false);
});

test('transicion INVALIDA: cancelado es terminal', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('cancelado', 'pendiente'), false);
  assert.strictEqual(esTransicionEstadoPagoValida('cancelado', 'aprobado'), false);
  assert.strictEqual(esTransicionEstadoPagoValida('cancelado', 'rechazado'), false);
  assert.strictEqual(esTransicionEstadoPagoValida('cancelado', 'reembolsado'), false);
});

test('transicion INVALIDA: reembolsado es terminal', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('reembolsado', 'pendiente'), false);
  assert.strictEqual(esTransicionEstadoPagoValida('reembolsado', 'aprobado'), false);
});

test('transicion INVALIDA: estado actual desconocido nunca se admite', () => {
  assert.strictEqual(esTransicionEstadoPagoValida('estado-inventado', 'aprobado'), false);
  assert.strictEqual(esTransicionEstadoPagoValida(undefined, 'aprobado'), false);
});

// --- debeAvanzarAPreparar ------------------------------------------------

test('debeAvanzarAPreparar: true solo si aprobado + pendiente_pago', () => {
  assert.strictEqual(
    debeAvanzarAPreparar({ estadoPagoNuevo: 'aprobado', estadoPedidoActual: 'pendiente_pago' }),
    true
  );
});

test('debeAvanzarAPreparar: false si el pago no es aprobado', () => {
  assert.strictEqual(
    debeAvanzarAPreparar({ estadoPagoNuevo: 'pendiente', estadoPedidoActual: 'pendiente_pago' }),
    false
  );
  assert.strictEqual(
    debeAvanzarAPreparar({ estadoPagoNuevo: 'rechazado', estadoPedidoActual: 'pendiente_pago' }),
    false
  );
});

test('debeAvanzarAPreparar: false si estado_pedido ya avanzo (nunca retrocede/reescribe)', () => {
  assert.strictEqual(
    debeAvanzarAPreparar({ estadoPagoNuevo: 'aprobado', estadoPedidoActual: 'a_preparar' }),
    false
  );
  assert.strictEqual(
    debeAvanzarAPreparar({ estadoPagoNuevo: 'aprobado', estadoPedidoActual: 'enviado' }),
    false
  );
  assert.strictEqual(
    debeAvanzarAPreparar({ estadoPagoNuevo: 'aprobado', estadoPedidoActual: 'cancelado' }),
    false
  );
});

// --- montoYMonedaCoinciden -----------------------------------------------

test('montoYMonedaCoinciden: true cuando monto y moneda coinciden exacto', () => {
  const pedido = { total: 206000, moneda: 'ARS' };
  const payment = { transactionAmount: 206000, currencyId: 'ARS' };
  assert.strictEqual(montoYMonedaCoinciden({ pedido, payment }), true);
});

test('montoYMonedaCoinciden: true con diferencias de redondeo de centavos irrelevantes', () => {
  const pedido = { total: 206000.001, moneda: 'ARS' };
  const payment = { transactionAmount: 206000.004, currencyId: 'ARS' };
  assert.strictEqual(montoYMonedaCoinciden({ pedido, payment }), true);
});

test('montoYMonedaCoinciden: false si el monto no coincide', () => {
  const pedido = { total: 206000, moneda: 'ARS' };
  const payment = { transactionAmount: 1, currencyId: 'ARS' };
  assert.strictEqual(montoYMonedaCoinciden({ pedido, payment }), false);
});

test('montoYMonedaCoinciden: false si la moneda no coincide', () => {
  const pedido = { total: 206000, moneda: 'ARS' };
  const payment = { transactionAmount: 206000, currencyId: 'USD' };
  assert.strictEqual(montoYMonedaCoinciden({ pedido, payment }), false);
});

test('montoYMonedaCoinciden: false ante datos faltantes/invalidos', () => {
  assert.strictEqual(montoYMonedaCoinciden({ pedido: null, payment: { transactionAmount: 1, currencyId: 'ARS' } }), false);
  assert.strictEqual(montoYMonedaCoinciden({ pedido: { total: 1, moneda: 'ARS' }, payment: null }), false);
  assert.strictEqual(
    montoYMonedaCoinciden({ pedido: { total: 1, moneda: 'ARS' }, payment: { transactionAmount: 'x', currencyId: 'ARS' } }),
    false
  );
  assert.strictEqual(
    montoYMonedaCoinciden({ pedido: { total: 1, moneda: 'ARS' }, payment: { transactionAmount: 1, currencyId: null } }),
    false
  );
});

// --- Runner ---------------------------------------------------------------

const failed = results.filter((r) => !r.pass);
results.forEach((r) => {
  console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
});
console.log('');
console.log('Pruebas de lib/pedido-pago-mapeo.js: ' + (results.length - failed.length) + '/' + results.length + ' OK');
process.exit(failed.length > 0 ? 1 : 0);
