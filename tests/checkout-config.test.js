'use strict';

/**
 * Pruebas del interruptor de seguridad del checkout real de Padel10Store:
 * - lib/checkout-config.js#esCheckoutHabilitado (la unica fuente de verdad
 *   del lado servidor).
 * - api/checkout-config.js (GET /api/checkout-config, el endpoint publico
 *   y sin secretos que expone esa misma decision al frontend).
 *
 * La proteccion real de POST /api/pedidos y POST /api/pedidos-preferencia
 * se cubre en tests/api-pedidos.test.js y tests/api-pedidos-preferencia.test.js
 * (seccion "Interruptor de seguridad del checkout" de cada archivo), no
 * aca: este archivo cubre unicamente la fuente de verdad compartida y el
 * endpoint de solo lectura.
 */

const assert = require('assert');
const { esCheckoutHabilitado, CHECKOUT_DISABLED_MESSAGE, CHECKOUT_DISABLED_STATUS } = require('../lib/checkout-config');
const checkoutConfigHandler = require('../api/checkout-config');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}
function testAsync(name, fn) {
  test(name, fn);
}

function withEnv(vars, fn) {
  const previous = {};
  const keys = Object.keys(vars);
  keys.forEach((key) => {
    previous[key] = process.env[key];
  });
  try {
    keys.forEach((key) => {
      const value = vars[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    fn();
  } finally {
    keys.forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
}

// ===========================================================================
// lib/checkout-config.js#esCheckoutHabilitado — fail closed
// ===========================================================================

test('CHECKOUT_ENABLED="true" (exacto): habilita', () => {
  withEnv({ CHECKOUT_ENABLED: 'true' }, () => {
    assert.strictEqual(esCheckoutHabilitado(), true);
  });
});

const VALORES_QUE_DESHABILITAN = [
  undefined, // ausente
  '', // vacio
  'false',
  'TRUE', // mayusculas: nunca se normaliza, comparacion exacta
  'True',
  ' true', // espacio inicial
  'true ', // espacio final
  '1',
  '0',
  'yes',
  'on',
  'enabled',
  'null',
  'undefined',
  'verdadero',
];

VALORES_QUE_DESHABILITAN.forEach((valor) => {
  test('CHECKOUT_ENABLED=' + JSON.stringify(valor) + ': deshabilita (fail closed)', () => {
    withEnv({ CHECKOUT_ENABLED: valor }, () => {
      assert.strictEqual(esCheckoutHabilitado(), false);
    });
  });
});

test('constantes exportadas: mensaje comercial y status HTTP', () => {
  assert.strictEqual(
    CHECKOUT_DISABLED_MESSAGE,
    'La compra online está temporalmente pausada. Consultanos por WhatsApp para confirmar precio y disponibilidad.'
  );
  assert.strictEqual(CHECKOUT_DISABLED_STATUS, 503);
});

// ===========================================================================
// api/checkout-config.js — endpoint publico, sin secretos
// ===========================================================================

function createMockRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
  };
  return res;
}

testAsync('GET responde {enabled:true} cuando CHECKOUT_ENABLED="true"', async () => {
  await new Promise((resolve, reject) => {
    withEnv({ CHECKOUT_ENABLED: 'true' }, () => {
      const res = createMockRes();
      checkoutConfigHandler({ method: 'GET' }, res).then(() => {
        try {
          assert.strictEqual(res.statusCode, 200);
          assert.deepStrictEqual(res.body, { enabled: true });
          resolve();
        } catch (err) {
          reject(err);
        }
      }, reject);
    });
  });
});

testAsync('GET responde {enabled:false} cuando CHECKOUT_ENABLED esta ausente', async () => {
  await new Promise((resolve, reject) => {
    withEnv({ CHECKOUT_ENABLED: undefined }, () => {
      const res = createMockRes();
      checkoutConfigHandler({ method: 'GET' }, res).then(() => {
        try {
          assert.strictEqual(res.statusCode, 200);
          assert.deepStrictEqual(res.body, { enabled: false });
          resolve();
        } catch (err) {
          reject(err);
        }
      }, reject);
    });
  });
});

testAsync('GET responde {enabled:false} ante cualquier otro valor (ej. "1")', async () => {
  await new Promise((resolve, reject) => {
    withEnv({ CHECKOUT_ENABLED: '1' }, () => {
      const res = createMockRes();
      checkoutConfigHandler({ method: 'GET' }, res).then(() => {
        try {
          assert.deepStrictEqual(res.body, { enabled: false });
          resolve();
        } catch (err) {
          reject(err);
        }
      }, reject);
    });
  });
});

testAsync('la respuesta NUNCA incluye nada mas alla de "enabled" (sin secretos, sin detalles internos)', async () => {
  await new Promise((resolve, reject) => {
    withEnv({ CHECKOUT_ENABLED: 'true' }, () => {
      const res = createMockRes();
      checkoutConfigHandler({ method: 'GET' }, res).then(() => {
        try {
          assert.deepStrictEqual(Object.keys(res.body), ['enabled']);
          resolve();
        } catch (err) {
          reject(err);
        }
      }, reject);
    });
  });
});

testAsync('siempre setea Cache-Control: no-store', async () => {
  await new Promise((resolve, reject) => {
    withEnv({ CHECKOUT_ENABLED: 'true' }, () => {
      const res = createMockRes();
      checkoutConfigHandler({ method: 'GET' }, res).then(() => {
        try {
          assert.strictEqual(res.headers['Cache-Control'], 'no-store');
          resolve();
        } catch (err) {
          reject(err);
        }
      }, reject);
    });
  });
});

testAsync('un metodo distinto de GET responde 405 con enabled:false (fail closed, nunca asume habilitado)', async () => {
  const res = createMockRes();
  await checkoutConfigHandler({ method: 'POST' }, res);
  assert.strictEqual(res.statusCode, 405);
  assert.deepStrictEqual(res.body, { enabled: false });
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
      resultados.push({ name, pass: false, error: error.message });
    }
  }

  const failed = resultados.filter((r) => !r.pass);
  resultados.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
  });
  console.log('');
  console.log('Pruebas del interruptor de seguridad del checkout: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
