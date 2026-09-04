'use strict';

/**
 * Pruebas de widget/checkout-availability.js: la unica fuente de verdad
 * del lado navegador para decidir si "Comprar ahora", "Continuar con mis
 * datos" y "Pagar ahora" pueden iniciar un pedido/pago real.
 *
 * Usa un DOM real via jsdom (mismo criterio que
 * tests/mercadopago-buy-widget.test.js) para poder controlar el timing de
 * fetch('/api/checkout-config') y verificar el estado ANTES de que
 * resuelva (debe ser false), y despues de que resuelve con cada
 * resultado posible.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'widget', 'checkout-availability.js'), 'utf8');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}
function testAsync(name, fn) {
  test(name, fn);
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
async function flushAll(times) {
  for (let i = 0; i < (times || 5); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
}

// Crea un jsdom nuevo, evalua el script (que dispara la consulta a
// /api/checkout-config apenas se carga, igual que en produccion), y
// devuelve tanto el window como control manual sobre cuando "resuelve" el
// fetch mockeado.
function createHarness(fetchImpl) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://padel10store.test/',
    runScripts: 'outside-only',
  });
  const window = dom.window;
  window.fetch = fetchImpl;
  window.eval(SRC);
  return window;
}

// --- Estado inicial: SIEMPRE false, incluso antes de que fetch resuelva ---

testAsync('arranca en false (deshabilitado) desde el primer instante, antes de que fetch resuelva', async () => {
  let resolverFetch;
  const pendiente = new Promise((resolve) => {
    resolverFetch = resolve;
  });
  const window = createHarness(() => pendiente);

  // Sin esperar nada: el fetch todavia esta pendiente.
  assert.strictEqual(window.PadelCheckoutAvailability.isEnabled(), false);

  resolverFetch({ ok: true, json: () => Promise.resolve({ enabled: true }) });
  await flushAll();
});

testAsync('sigue en false mientras el fetch esta en curso, y pasa a true recien cuando resuelve con enabled:true', async () => {
  let resolverFetch;
  const pendiente = new Promise((resolve) => {
    resolverFetch = resolve;
  });
  const window = createHarness(() => pendiente);

  await flushAll(2);
  assert.strictEqual(window.PadelCheckoutAvailability.isEnabled(), false, 'todavia pendiente: debe seguir en false');

  resolverFetch({ ok: true, json: () => Promise.resolve({ enabled: true }) });
  await flushAll();

  assert.strictEqual(window.PadelCheckoutAvailability.isEnabled(), true);
});

// --- Resultado explicito false, o cualquier otro valor de "enabled" -------

testAsync('respuesta {enabled:false}: se mantiene deshabilitado', async () => {
  const window = createHarness(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: false }) }));
  await flushAll();
  assert.strictEqual(window.PadelCheckoutAvailability.isEnabled(), false);
});

testAsync('respuesta con "enabled" en un valor que no es exactamente true (ej. "true" string, 1): se mantiene deshabilitado', async () => {
  const window = createHarness(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: 'true' }) }));
  await flushAll();
  assert.strictEqual(window.PadelCheckoutAvailability.isEnabled(), false);
});

testAsync('respuesta sin el campo "enabled": se mantiene deshabilitado', async () => {
  const window = createHarness(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  await flushAll();
  assert.strictEqual(window.PadelCheckoutAvailability.isEnabled(), false);
});

// --- Errores de red / respuesta invalida: SIEMPRE mantienen deshabilitado -

testAsync('error de red (fetch rechaza la promesa): mantiene el checkout apagado', async () => {
  const window = createHarness(() => Promise.reject(new Error('network down')));
  await flushAll();
  assert.strictEqual(window.PadelCheckoutAvailability.isEnabled(), false);
});

testAsync('respuesta HTTP no-OK (por ejemplo 500): mantiene el checkout apagado', async () => {
  const window = createHarness(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ enabled: true }) }));
  await flushAll();
  assert.strictEqual(window.PadelCheckoutAvailability.isEnabled(), false);
});

testAsync('JSON invalido en la respuesta: mantiene el checkout apagado', async () => {
  const window = createHarness(() =>
    Promise.resolve({ ok: true, json: () => Promise.reject(new Error('invalid json')) })
  );
  await flushAll();
  assert.strictEqual(window.PadelCheckoutAvailability.isEnabled(), false);
});

testAsync('sin fetch disponible en absoluto: mantiene el checkout apagado, sin lanzar excepciones', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://padel10store.test/',
    runScripts: 'outside-only',
  });
  const window = dom.window;
  delete window.fetch;
  assert.doesNotThrow(() => window.eval(SRC));
  assert.strictEqual(window.PadelCheckoutAvailability.isEnabled(), false);
});

// --- subscribe(): llamada inmediata + notificacion ante cambios -----------

testAsync('subscribe llama inmediatamente con el estado actual (false, mientras esta pendiente)', async () => {
  const pendiente = new Promise(() => {}); // nunca resuelve en esta prueba
  const window = createHarness(() => pendiente);
  var recibido = null;
  window.PadelCheckoutAvailability.subscribe(function (valor) {
    recibido = valor;
  });
  assert.strictEqual(recibido, false);
});

testAsync('subscribe notifica de nuevo cuando el estado cambia de false a true', async () => {
  let resolverFetch;
  const pendiente = new Promise((resolve) => {
    resolverFetch = resolve;
  });
  const window = createHarness(() => pendiente);
  var llamadas = [];
  window.PadelCheckoutAvailability.subscribe(function (valor) {
    llamadas.push(valor);
  });
  assert.deepStrictEqual(llamadas, [false]);

  resolverFetch({ ok: true, json: () => Promise.resolve({ enabled: true }) });
  await flushAll();

  assert.deepStrictEqual(llamadas, [false, true]);
});

testAsync('subscribe suscripto DESPUES de que ya resolvio recibe el estado ya actualizado, no el inicial', async () => {
  const window = createHarness(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: true }) }));
  await flushAll();

  var recibido = null;
  window.PadelCheckoutAvailability.subscribe(function (valor) {
    recibido = valor;
  });
  assert.strictEqual(recibido, true);
});

testAsync('un listener que tira una excepcion nunca rompe la notificacion de los demas', async () => {
  let resolverFetch;
  const pendiente = new Promise((resolve) => {
    resolverFetch = resolve;
  });
  const window = createHarness(() => pendiente);
  var segundoLlamado = false;
  window.PadelCheckoutAvailability.subscribe(function () {
    throw new Error('listener roto');
  });
  window.PadelCheckoutAvailability.subscribe(function () {
    segundoLlamado = true;
  });

  resolverFetch({ ok: true, json: () => Promise.resolve({ enabled: true }) });
  await flushAll();

  assert.strictEqual(segundoLlamado, true);
});

// --- Detalle de la llamada a fetch -----------------------------------------

testAsync('consulta exactamente /api/checkout-config con cache:no-store', async () => {
  var llamadas = [];
  const window = createHarness((url, init) => {
    llamadas.push({ url, init });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: true }) });
  });
  await flushAll();
  assert.strictEqual(llamadas.length, 1);
  assert.strictEqual(llamadas[0].url, '/api/checkout-config');
  assert.strictEqual(llamadas[0].init.cache, 'no-store');
});

// --- Runner ------------------------------------------------------------

async function run() {
  const resultados = [];
  for (const { name, fn } of results) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      resultados.push({ name, pass: true });
    } catch (error) {
      resultados.push({ name, pass: false, error: (error && error.stack) || error });
    }
  }

  const failed = resultados.filter((r) => !r.pass);
  resultados.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
  });
  console.log('');
  console.log('Pruebas de widget/checkout-availability.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
