'use strict';

/**
 * Pruebas de api/pedidos-preferencia.js (Fase 3, Etapa 3: reintento de
 * pago via payment_retry_token).
 *
 * Igual que tests/api-pedidos.test.js, estas pruebas NO se conectan a
 * Supabase ni a Mercado Pago: usan dependencias de prueba inyectadas via
 * createPedidosPreferenciaHandler.
 */

const assert = require('assert');
const {
  createPedidosPreferenciaHandler,
  GENERIC_ERROR_MESSAGE,
  MAX_BODY_LENGTH,
} = require('../api/pedidos-preferencia');
const { PedidoStoreError } = require('../lib/padel-orders-store');
const { generarPaymentRetryToken, hashPaymentRetryToken } = require('../lib/payment-retry-token');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}
function testAsync(name, fn) {
  test(name, fn);
}

function createMockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function createMockReq({ method, contentType, body }) {
  return {
    method: method === undefined ? 'POST' : method,
    headers: { 'content-type': contentType === undefined ? 'application/json' : contentType },
    body: body,
  };
}

async function ejecutar(handler, reqOverrides) {
  const req = createMockReq(reqOverrides || {});
  const res = createMockRes();
  await handler(req, res);
  return res;
}

// --- Pedido "real" de prueba, en un estado que admite pago -----------------
function pedidoValido(overrides) {
  return Object.assign(
    {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      numero: 'P10-000123',
      access_token: 'token-de-consulta-de-estado-no-debe-viajar-nunca',
      payment_retry_token_hash: 'x'.repeat(64),
      estado_pago: 'pendiente',
      estado_pedido: 'pendiente_pago',
      mp_preference_id: null,
    },
    overrides || {}
  );
}

function createFakeObtenerPedido(options) {
  const opts = options || {};
  const llamadas = [];
  async function fake(hash) {
    llamadas.push(hash);
    if (opts.throwError) throw opts.throwError;
    return opts.pedido || pedidoValido();
  }
  fake.llamadas = llamadas;
  return fake;
}

function createFakeObtenerItems(options) {
  const opts = options || {};
  const llamadas = [];
  async function fake(pedidoId) {
    llamadas.push(pedidoId);
    if (opts.throwError) throw opts.throwError;
    return opts.items || [
      { product_id: 'x', nombre: 'Producto de prueba', talle: null, cantidad: 1, precio_unitario: 100 },
    ];
  }
  fake.llamadas = llamadas;
  return fake;
}

function createFakeCrearPreferencia(options) {
  const opts = options || {};
  const llamadas = [];
  async function fake(input) {
    llamadas.push(input);
    if (opts.throwError) throw opts.throwError;
    if (opts.ok === false) return { ok: false, motivo: opts.motivo || 'mercado_pago' };
    return { ok: true, checkoutUrl: opts.checkoutUrl || 'https://sandbox.mercadopago.com.ar/checkout/retry-pref' };
  }
  fake.llamadas = llamadas;
  return fake;
}

// Por defecto, checkout HABILITADO (no es lo que prueba la mayoria de
// estos casos; ver la seccion dedicada al interruptor de seguridad, mas
// abajo, para el caso contrario). Pasar `checkoutHabilitado: false` (o
// `esCheckoutHabilitado` directamente) simula el interruptor apagado sin
// tocar ninguna variable de entorno real.
function crearHandlerDePrueba({
  pedidoOverrides,
  obtenerPedidoOptions,
  itemsOptions,
  preferenciaOptions,
  checkoutHabilitado,
  esCheckoutHabilitado,
} = {}) {
  const fakeObtenerPedido = createFakeObtenerPedido(
    obtenerPedidoOptions || { pedido: pedidoValido(pedidoOverrides) }
  );
  const fakeObtenerItems = createFakeObtenerItems(itemsOptions);
  const fakeCrearPreferencia = createFakeCrearPreferencia(preferenciaOptions);
  const handler = createPedidosPreferenciaHandler({
    obtenerPedidoPorPaymentRetryTokenHash: fakeObtenerPedido,
    obtenerItemsPorPedido: fakeObtenerItems,
    crearPreferenciaParaPedido: fakeCrearPreferencia,
    esCheckoutHabilitado: esCheckoutHabilitado || (() => checkoutHabilitado !== false),
  });
  return { handler, fakeObtenerPedido, fakeObtenerItems, fakeCrearPreferencia };
}

function bodyValido(overrides) {
  return Object.assign({ paymentRetryToken: generarPaymentRetryToken() }, overrides || {});
}

// --- metodo / content-type / tamano de body --------------------------------

testAsync('rechaza metodos distintos de POST', async () => {
  const { handler } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { method: 'GET', body: bodyValido() });
  assert.strictEqual(res.statusCode, 405);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

testAsync('rechaza Content-Type distinto de application/json', async () => {
  const { handler } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { contentType: 'text/plain', body: bodyValido() });
  assert.strictEqual(res.statusCode, 415);
});

testAsync('rechaza un body excesivamente grande', async () => {
  const { handler, fakeObtenerPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: { paymentRetryToken: 'a'.repeat(MAX_BODY_LENGTH + 50) } });
  assert.strictEqual(res.statusCode, 413);
  assert.strictEqual(fakeObtenerPedido.llamadas.length, 0);
});

// --- allow-list / formato del token: seguridad ------------------------------

testAsync('rechaza un body con campos inesperados ademas de paymentRetryToken', async () => {
  const { handler, fakeObtenerPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, {
    body: { paymentRetryToken: generarPaymentRetryToken(), pedidoId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeObtenerPedido.llamadas.length, 0);
});

testAsync('rechaza si el cliente intenta mandar el id interno del pedido en vez del token', async () => {
  const { handler, fakeObtenerPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: { pedidoId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeObtenerPedido.llamadas.length, 0);
});

testAsync('rechaza un token con formato invalido (corto, mayusculas, no-hex) sin tocar la base de datos', async () => {
  const { handler, fakeObtenerPedido } = crearHandlerDePrueba();
  const casos = ['', 'abc', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null, 123, {}];
  for (const token of casos) {
    // eslint-disable-next-line no-await-in-loop
    const res = await ejecutar(handler, { body: { paymentRetryToken: token } });
    assert.strictEqual(res.statusCode, 400, `deberia rechazar token ${JSON.stringify(token)}`);
  }
  assert.strictEqual(fakeObtenerPedido.llamadas.length, 0);
});

testAsync('nunca busca el pedido por el token en claro: la capa de datos solo recibe el hash', async () => {
  const token = generarPaymentRetryToken();
  const { handler, fakeObtenerPedido } = crearHandlerDePrueba();
  await ejecutar(handler, { body: { paymentRetryToken: token } });
  assert.strictEqual(fakeObtenerPedido.llamadas.length, 1);
  assert.strictEqual(fakeObtenerPedido.llamadas[0], hashPaymentRetryToken(token));
  assert.notStrictEqual(fakeObtenerPedido.llamadas[0], token);
});

// --- autorizacion: token invalido / inexistente -----------------------------

testAsync('un token que no matchea ningun pedido devuelve un error generico (nunca revela si "no existe" vs "expiro")', async () => {
  const { handler } = crearHandlerDePrueba({
    obtenerPedidoOptions: { throwError: new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado') },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

testAsync('un error inesperado de la base de datos mapea a 500 generico sin exponer la causa', async () => {
  const { handler } = crearHandlerDePrueba({
    obtenerPedidoOptions: { throwError: new PedidoStoreError('DB_ERROR', 'detalle interno con la secret key') },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

// --- autorizacion: estado del pedido ----------------------------------------

testAsync('rechaza reintentar el pago de un pedido ya aprobado (evita un cobro duplicado)', async () => {
  const { handler, fakeCrearPreferencia } = crearHandlerDePrueba({
    pedidoOverrides: { estado_pago: 'aprobado' },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(fakeCrearPreferencia.llamadas.length, 0, 'nunca debe tocar Mercado Pago si el pedido ya esta pagado');
});

testAsync('rechaza reintentar el pago de un pedido cancelado', async () => {
  const { handler, fakeCrearPreferencia } = crearHandlerDePrueba({
    pedidoOverrides: { estado_pedido: 'cancelado' },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(fakeCrearPreferencia.llamadas.length, 0);
});

testAsync('rechaza reintentar el pago de un pedido expirado', async () => {
  const { handler, fakeCrearPreferencia } = crearHandlerDePrueba({
    pedidoOverrides: { estado_pedido: 'expirado' },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(fakeCrearPreferencia.llamadas.length, 0);
});

testAsync('rechaza reintentar el pago de un pedido que ya avanzo en el fulfillment (a_preparar)', async () => {
  const { handler, fakeCrearPreferencia } = crearHandlerDePrueba({
    pedidoOverrides: { estado_pedido: 'a_preparar' },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(fakeCrearPreferencia.llamadas.length, 0);
});

testAsync('permite reintentar el pago de un pedido cuyo pago anterior fue rechazado', async () => {
  const { handler } = crearHandlerDePrueba({ pedidoOverrides: { estado_pago: 'rechazado' } });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(typeof res.body.redirectUrl, 'string');
});

// --- caso exitoso: crea/reutiliza la preferencia y responde solo redirectUrl --

testAsync('con un pedido pendiente de pago, crea la preferencia y devuelve redirectUrl', async () => {
  const { handler, fakeObtenerItems, fakeCrearPreferencia } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.redirectUrl, 'https://sandbox.mercadopago.com.ar/checkout/retry-pref');
  assert.strictEqual(fakeObtenerItems.llamadas.length, 1);
  assert.strictEqual(fakeCrearPreferencia.llamadas.length, 1);
});

testAsync('la respuesta de exito contiene UNICAMENTE redirectUrl (nunca uuid, access_token, ni el token de reintento)', async () => {
  const { handler } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['redirectUrl']);
  assert.strictEqual('id' in res.body, false);
  assert.strictEqual('numero' in res.body, false);
  assert.strictEqual('access_token' in res.body, false);
  assert.strictEqual('accessToken' in res.body, false);
  assert.strictEqual('paymentRetryToken' in res.body, false);
  assert.strictEqual('payment_retry_token' in res.body, false);
  assert.strictEqual('payment_retry_token_hash' in res.body, false);
});

testAsync('el pedido pasado a crearPreferenciaParaPedido es el pedido real encontrado por el token (idempotencia via external_reference)', async () => {
  const pedido = pedidoValido({ numero: 'P10-000900' });
  const { handler, fakeCrearPreferencia } = crearHandlerDePrueba({ obtenerPedidoOptions: { pedido } });
  await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(fakeCrearPreferencia.llamadas[0].pedido.numero, 'P10-000900');
  assert.strictEqual(fakeCrearPreferencia.llamadas[0].pedido.id, pedido.id);
});

// --- idempotencia: no crea una segunda preferencia si ya hay una reutilizable --

testAsync(
  'si el pedido ya tiene mp_preference_id, la logica reutilizada (crearOReutilizarPreferenciaParaPedido) es la responsable de no duplicarla: este endpoint solo la delega',
  async () => {
    const pedidoConPreferencia = pedidoValido({ mp_preference_id: 'ya-existe-una-preferencia' });
    const { handler, fakeCrearPreferencia } = crearHandlerDePrueba({
      obtenerPedidoOptions: { pedido: pedidoConPreferencia },
    });
    const res = await ejecutar(handler, { body: bodyValido() });
    assert.strictEqual(res.statusCode, 200);
    // Se llama una unica vez: la idempotencia de "no crear una preferencia
    // nueva si ya existe una reutilizable" vive en
    // lib/pedido-preferencia.js#crearOReutilizarPreferenciaParaPedido (ver
    // tests/pedido-preferencia.test.js), que es la MISMA funcion que usa
    // api/pedidos.js. Este endpoint nunca implementa su propia logica de
    // deduplicacion en paralelo.
    assert.strictEqual(fakeCrearPreferencia.llamadas.length, 1);
    assert.strictEqual(fakeCrearPreferencia.llamadas[0].pedido.mp_preference_id, 'ya-existe-una-preferencia');
  }
);

testAsync('llamar dos veces con el mismo token valido no crea dos preferencias distintas de forma inconsistente (cada request delega en la misma logica idempotente)', async () => {
  const pedido = pedidoValido();
  const { handler, fakeCrearPreferencia } = crearHandlerDePrueba({ obtenerPedidoOptions: { pedido } });
  const token = generarPaymentRetryToken();
  const res1 = await ejecutar(handler, { body: { paymentRetryToken: token } });
  const res2 = await ejecutar(handler, { body: { paymentRetryToken: token } });
  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(res1.body.redirectUrl, res2.body.redirectUrl);
  assert.strictEqual(fakeCrearPreferencia.llamadas.length, 2);
});

// --- fallos de Mercado Pago: nunca se revela el motivo interno -------------

testAsync('si Mercado Pago falla al crear la preferencia, devuelve un error generico (502) sin detalles', async () => {
  const { handler } = crearHandlerDePrueba({ preferenciaOptions: { ok: false, motivo: 'mercado_pago' } });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 502);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

testAsync('si crearPreferenciaParaPedido tira una excepcion, devuelve un error generico (500)', async () => {
  const { handler } = crearHandlerDePrueba({ preferenciaOptions: { throwError: new Error('mp_timeout') } });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

testAsync('si obtenerItemsPorPedido tira una excepcion, devuelve un error generico (500)', async () => {
  const { handler } = crearHandlerDePrueba({ itemsOptions: { throwError: new Error('db_down') } });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

// --- ningun mensaje de error revela detalles internos -----------------------

test('ningun mensaje de error de esta suite revela detalles internos (uuid, secret key, sql, stack)', async () => {
  const escenarios = [
    { method: 'GET', body: bodyValido() },
    { contentType: 'text/plain', body: bodyValido() },
    { body: { paymentRetryToken: 'formato-invalido' } },
  ];
  for (const escenario of escenarios) {
    const { handler } = crearHandlerDePrueba();
    // eslint-disable-next-line no-await-in-loop
    const res = await ejecutar(handler, escenario);
    assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
  }
});

// ===========================================================================
// Interruptor de seguridad del checkout (lib/checkout-config.js): con el
// checkout deshabilitado, POST /api/pedidos-preferencia nunca debe crear
// ni reutilizar ninguna preferencia, sin importar el resto del body.
// ===========================================================================

testAsync('checkout deshabilitado: responde 503 con el mensaje comercial, nunca el mensaje generico tecnico', async () => {
  const { handler } = crearHandlerDePrueba({ checkoutHabilitado: false });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 503);
  assert.deepStrictEqual(res.body, {
    error: 'La compra online está temporalmente pausada. Consultanos por WhatsApp para confirmar precio y disponibilidad.',
  });
});

testAsync('checkout deshabilitado: nunca llama a obtenerPedidoPorPaymentRetryTokenHash, obtenerItemsPorPedido ni crearPreferenciaParaPedido', async () => {
  const { handler, fakeObtenerPedido, fakeObtenerItems, fakeCrearPreferencia } = crearHandlerDePrueba({
    checkoutHabilitado: false,
  });
  await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(fakeObtenerPedido.llamadas.length, 0);
  assert.strictEqual(fakeObtenerItems.llamadas.length, 0);
  assert.strictEqual(fakeCrearPreferencia.llamadas.length, 0);
});

testAsync('checkout deshabilitado: se corta ANTES de validar el formato del token (un body invalido igual responde 503, no 400)', async () => {
  const { handler, fakeObtenerPedido } = crearHandlerDePrueba({ checkoutHabilitado: false });
  const res = await ejecutar(handler, { body: { paymentRetryToken: 'no-tiene-el-formato-correcto' } });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(fakeObtenerPedido.llamadas.length, 0);
});

testAsync('checkout deshabilitado: se corta ANTES de validar el Content-Type', async () => {
  const { handler } = crearHandlerDePrueba({ checkoutHabilitado: false });
  const res = await ejecutar(handler, { contentType: 'text/plain', body: bodyValido() });
  assert.strictEqual(res.statusCode, 503);
});

testAsync('checkout deshabilitado: un metodo distinto de POST sigue respondiendo 405 (el metodo se valida primero)', async () => {
  const { handler } = crearHandlerDePrueba({ checkoutHabilitado: false });
  const res = await ejecutar(handler, { method: 'GET', body: bodyValido() });
  assert.strictEqual(res.statusCode, 405);
});

testAsync('checkout habilitado explicitamente (default de esta suite): el camino feliz sigue funcionando igual', async () => {
  const { handler } = crearHandlerDePrueba({ checkoutHabilitado: true });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(typeof res.body.redirectUrl, 'string');
});

// --- Runner --------------------------------------------------------------

async function run() {
  const resultados = [];
  for (const { name, fn } of results) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      resultados.push({ name, pass: true });
    } catch (error) {
      resultados.push({ name, pass: false, error: error.message });
    }
  }

  const failed = resultados.filter((r) => !r.pass);
  resultados.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
  });
  console.log('');
  console.log('Pruebas de api/pedidos-preferencia.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
