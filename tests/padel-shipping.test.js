'use strict';

/**
 * Pruebas de lib/padel-shipping.js (cotizacion de envio) y de la linea de
 * envio que se agrega a la preferencia de Mercado Pago
 * (lib/mercadopago-preference.js#buildShippingItem).
 */

const assert = require('assert');
const Shipping = require('../lib/padel-shipping');
const { buildShippingItem, buildOrderPreferencePayload } = require('../lib/mercadopago-preference');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
  }
}

test('la configuracion publicada no inventa tarifas: el envio queda a confirmar', () => {
  assert.strictEqual(Shipping.CONFIG_ENVIO.modo, 'a_confirmar');
  assert.strictEqual(Shipping.envioConfigurado(), false);
  const cot = Shipping.cotizarEnvio({ provincia: 'Santa Fe' });
  assert.deepStrictEqual(cot, { estado: 'a_confirmar', costo: null, plazoTexto: null });
});

const CONFIG = { modo: 'tarifas', tarifasPorProvincia: { 'Santa Fe': 5000 }, tarifaResto: null, plazoTexto: ' 3 a 5 días hábiles ' };

test('con tarifas cargadas, usa la tarifa de la provincia', () => {
  const cot = Shipping.cotizarEnvio({ provincia: 'Santa Fe' }, CONFIG);
  assert.deepStrictEqual(cot, { estado: 'confirmado', costo: 5000, plazoTexto: '3 a 5 días hábiles' });
});

test('provincia sin tarifa y sin tarifaResto: queda a confirmar', () => {
  assert.strictEqual(Shipping.cotizarEnvio({ provincia: 'Salta' }, CONFIG).estado, 'a_confirmar');
});

test('tarifaResto cubre provincias que no estan en la tabla', () => {
  const cfg = Object.assign({}, CONFIG, { tarifaResto: 9000 });
  assert.strictEqual(Shipping.cotizarEnvio({ provincia: 'Salta' }, cfg).costo, 9000);
});

test('importes invalidos (negativos, decimales, texto) dejan el envio a confirmar', () => {
  [-1, 10.5, '5000', NaN, Infinity, null].forEach((valor) => {
    const cfg = { modo: 'tarifas', tarifasPorProvincia: { 'Santa Fe': valor }, tarifaResto: null };
    assert.strictEqual(Shipping.cotizarEnvio({ provincia: 'Santa Fe' }, cfg).estado, 'a_confirmar', String(valor));
  });
});

test('sin provincia o modo desconocido: a confirmar', () => {
  assert.strictEqual(Shipping.cotizarEnvio({}, CONFIG).estado, 'a_confirmar');
  assert.strictEqual(Shipping.cotizarEnvio({ provincia: 'Santa Fe' }, { modo: 'otro' }).estado, 'a_confirmar');
});

test('Mercado Pago: agrega la linea de envio cuando total > subtotal', () => {
  assert.deepStrictEqual(buildShippingItem({ total: 105000, subtotal: 100000 }), {
    id: 'envio', title: 'Envío', quantity: 1, currency_id: 'ARS', unit_price: 5000,
  });
});

test('Mercado Pago: sin envio (total == subtotal) no agrega ninguna linea', () => {
  assert.strictEqual(buildShippingItem({ total: 100000, subtotal: 100000 }), null);
  assert.strictEqual(buildShippingItem({ total: '100000.00', subtotal: '100000.00' }), null);
});

test('Mercado Pago: la suma de las lineas coincide con pedido.total', () => {
  const pedido = { id: 'p1', total: '262500.00', subtotal: '256500.00' };
  const items = [{ product_id: 'x', nombre: 'Pala', talle: null, cantidad: 1, precio_unitario: '256500.00' }];
  const payload = buildOrderPreferencePayload({ pedido, items, backUrls: {}, notificationUrl: null });
  const suma = payload.items.reduce((acc, it) => acc + it.unit_price * it.quantity, 0);
  assert.strictEqual(suma, 262500);
});

const failed = results.filter((r) => !r.pass);
results.forEach((r) => console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : '')));
console.log('');
console.log('Pruebas de lib/padel-shipping.js: ' + (results.length - failed.length) + '/' + results.length + ' OK');
process.exit(failed.length > 0 ? 1 : 0);
