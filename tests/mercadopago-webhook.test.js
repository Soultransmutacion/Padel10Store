'use strict';

/**
 * Pruebas de lib/mercadopago-webhook.js (Fase 3, Etapa 4): validacion de
 * firma oficial de Mercado Pago y consulta del pago real.
 *
 * Igual que tests/mercadopago-preference.test.js, estas pruebas no hacen
 * ninguna llamada de red real: cuando hace falta (consultarPagoEnMercadoPago)
 * se reemplaza global.fetch por una version de prueba controlada por este
 * archivo.
 */

const assert = require('assert');
const crypto = require('crypto');
const {
  TOPICO_PAGOS,
  esTopicoDePago,
  parsearXSignature,
  construirManifiesto,
  compararHexEnTiempoConstante,
  validarFirmaWebhook,
  consultarPagoEnMercadoPago,
} = require('../lib/mercadopago-webhook');

const results = [];
function test(name, fn) {
  results.push({ name, fn, async: false });
}
function testAsync(name, fn) {
  results.push({ name, fn, async: true });
}

const SECRET = 'super-secreto-de-prueba';

function firmarNotificacion({ secret, dataId, xRequestId, ts }) {
  const manifest = construirManifiesto({ dataId, xRequestId, ts });
  const v1 = crypto.createHmac('sha256', secret || SECRET).update(manifest).digest('hex');
  return { header: `ts=${ts},v1=${v1}`, v1, ts };
}

// --- esTopicoDePago / TOPICO_PAGOS ----------------------------------------

test('TOPICO_PAGOS es "payment"', () => {
  assert.strictEqual(TOPICO_PAGOS, 'payment');
});

test('esTopicoDePago: true solo para "payment" (insensible a mayusculas/espacios)', () => {
  assert.strictEqual(esTopicoDePago('payment'), true);
  assert.strictEqual(esTopicoDePago(' Payment '), true);
  assert.strictEqual(esTopicoDePago('PAYMENT'), true);
});

test('esTopicoDePago: false para otros topicos o entradas invalidas', () => {
  assert.strictEqual(esTopicoDePago('merchant_order'), false);
  assert.strictEqual(esTopicoDePago('point_integration_wh'), false);
  assert.strictEqual(esTopicoDePago(''), false);
  assert.strictEqual(esTopicoDePago(null), false);
  assert.strictEqual(esTopicoDePago(undefined), false);
});

// --- parsearXSignature ------------------------------------------------

test('parsearXSignature: parsea ts y v1 en el orden documentado', () => {
  const parsed = parsearXSignature('ts=1704908010,v1=618c85345248dd820d5fd7c5f2b8a2f0257a0e836a67d59ac6cc9b6a86c4f7d1');
  assert.deepStrictEqual(parsed, {
    ts: '1704908010',
    v1: '618c85345248dd820d5fd7c5f2b8a2f0257a0e836a67d59ac6cc9b6a86c4f7d1',
  });
});

test('parsearXSignature: tolera espacios y orden invertido de las partes', () => {
  const parsed = parsearXSignature(' v1=abc123 , ts=999 ');
  assert.deepStrictEqual(parsed, { ts: '999', v1: 'abc123' });
});

test('parsearXSignature: null ante header vacio/ausente/malformado', () => {
  assert.strictEqual(parsearXSignature(undefined), null);
  assert.strictEqual(parsearXSignature(''), null);
  assert.strictEqual(parsearXSignature('esto-no-tiene-el-formato-esperado'), null);
  assert.strictEqual(parsearXSignature('ts=123'), null); // falta v1
  assert.strictEqual(parsearXSignature('v1=abc'), null); // falta ts
});

// --- construirManifiesto ------------------------------------------------

test('construirManifiesto: arma el string canonico documentado por Mercado Pago', () => {
  assert.strictEqual(
    construirManifiesto({ dataId: '123456789', xRequestId: 'req-1', ts: '1700000000' }),
    'id:123456789;request-id:req-1;ts:1700000000;'
  );
});

test('construirManifiesto: normaliza data.id a minusculas', () => {
  assert.strictEqual(
    construirManifiesto({ dataId: 'ABC123', xRequestId: 'req-1', ts: '1' }),
    'id:abc123;request-id:req-1;ts:1;'
  );
});

// --- compararHexEnTiempoConstante ----------------------------------------

test('compararHexEnTiempoConstante: true para strings hex identicos', () => {
  assert.strictEqual(compararHexEnTiempoConstante('abc123', 'abc123'), true);
});

test('compararHexEnTiempoConstante: false ante longitudes distintas o contenido distinto', () => {
  assert.strictEqual(compararHexEnTiempoConstante('abc123', 'abc1234'), false);
  assert.strictEqual(compararHexEnTiempoConstante('abc123', 'def456'), false);
});

test('compararHexEnTiempoConstante: false (nunca excepcion) ante entradas no-hex', () => {
  assert.strictEqual(compararHexEnTiempoConstante('no-es-hex', 'tampoco'), false);
  assert.strictEqual(compararHexEnTiempoConstante(null, 'abc123'), false);
  assert.strictEqual(compararHexEnTiempoConstante('abc123', undefined), false);
});

// --- validarFirmaWebhook --------------------------------------------------

test('validarFirmaWebhook: true con una firma calculada correctamente', () => {
  const dataId = '123456789';
  const xRequestId = 'req-abc';
  const ts = '1700000000';
  const { header } = firmarNotificacion({ dataId, xRequestId, ts });
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId, dataId, secret: SECRET }),
    true
  );
});

test('validarFirmaWebhook: false si el secreto no coincide', () => {
  const dataId = '123456789';
  const xRequestId = 'req-abc';
  const ts = '1700000000';
  const { header } = firmarNotificacion({ dataId, xRequestId, ts, secret: 'otro-secreto' });
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId, dataId, secret: SECRET }),
    false
  );
});

test('validarFirmaWebhook: false si se altera data.id respecto de lo firmado', () => {
  const xRequestId = 'req-abc';
  const ts = '1700000000';
  const { header } = firmarNotificacion({ dataId: '111', xRequestId, ts });
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId, dataId: '222', secret: SECRET }),
    false
  );
});

test('validarFirmaWebhook: false si se altera x-request-id respecto de lo firmado', () => {
  const dataId = '123456789';
  const ts = '1700000000';
  const { header } = firmarNotificacion({ dataId, xRequestId: 'req-original', ts });
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId: 'req-suplantado', dataId, secret: SECRET }),
    false
  );
});

test('validarFirmaWebhook: false si se altera ts respecto de lo firmado', () => {
  const dataId = '123456789';
  const xRequestId = 'req-abc';
  const { header, v1 } = firmarNotificacion({ dataId, xRequestId, ts: '1700000000' });
  const headerConTsAlterado = `ts=1799999999,v1=${v1}`;
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: headerConTsAlterado, xRequestId, dataId, secret: SECRET }),
    false
  );
});

test('validarFirmaWebhook: false ante header x-signature ausente/malformado', () => {
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: undefined, xRequestId: 'req', dataId: '1', secret: SECRET }),
    false
  );
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: 'formato-invalido', xRequestId: 'req', dataId: '1', secret: SECRET }),
    false
  );
});

test('validarFirmaWebhook: false ante x-request-id ausente', () => {
  const { header } = firmarNotificacion({ dataId: '1', xRequestId: 'req', ts: '1700000000' });
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId: undefined, dataId: '1', secret: SECRET }),
    false
  );
});

test('validarFirmaWebhook: false ante data.id ausente', () => {
  const { header } = firmarNotificacion({ dataId: '1', xRequestId: 'req', ts: '1700000000' });
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId: 'req', dataId: undefined, secret: SECRET }),
    false
  );
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId: 'req', dataId: '', secret: SECRET }),
    false
  );
});

test('validarFirmaWebhook: false ante secreto no configurado (nunca "abre" por defecto)', () => {
  const { header } = firmarNotificacion({ dataId: '1', xRequestId: 'req', ts: '1700000000' });
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId: 'req', dataId: '1', secret: undefined }),
    false
  );
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId: 'req', dataId: '1', secret: '' }),
    false
  );
});

test('validarFirmaWebhook: nunca lanza excepcion ante entradas completamente vacias', () => {
  assert.strictEqual(validarFirmaWebhook(), false);
  assert.strictEqual(validarFirmaWebhook({}), false);
});

// --- consultarPagoEnMercadoPago (mockea global.fetch) --------------------

function withMockFetch(mockFn, run) {
  const originalFetch = global.fetch;
  global.fetch = mockFn;
  return run().finally(() => {
    global.fetch = originalFetch;
  });
}

testAsync('consultarPagoEnMercadoPago: normaliza la respuesta real de Mercado Pago', async () => {
  await withMockFetch(
    async (url, options) => {
      assert.strictEqual(url, 'https://api.mercadopago.com/v1/payments/123456789');
      assert.strictEqual(options.method, 'GET');
      assert.ok(options.headers.Authorization.includes('Bearer'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 123456789,
          external_reference: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          status: 'approved',
          status_detail: 'accredited',
          transaction_amount: 206000,
          currency_id: 'ARS',
        }),
      };
    },
    async () => {
      const resultado = await consultarPagoEnMercadoPago({ paymentId: '123456789', accessToken: 'TEST-TOKEN' });
      assert.strictEqual(resultado.ok, true);
      assert.deepStrictEqual(resultado.payment, {
        id: '123456789',
        externalReference: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        status: 'approved',
        statusDetail: 'accredited',
        transactionAmount: 206000,
        currencyId: 'ARS',
      });
    }
  );
});

testAsync('consultarPagoEnMercadoPago: motivo "no_encontrado" ante 404', async () => {
  await withMockFetch(
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    async () => {
      const resultado = await consultarPagoEnMercadoPago({ paymentId: '999', accessToken: 'TEST-TOKEN' });
      assert.strictEqual(resultado.ok, false);
      assert.strictEqual(resultado.motivo, 'no_encontrado');
    }
  );
});

testAsync('consultarPagoEnMercadoPago: motivo "respuesta_no_ok" ante otros status de error', async () => {
  await withMockFetch(
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => {
      const resultado = await consultarPagoEnMercadoPago({ paymentId: '999', accessToken: 'TEST-TOKEN' });
      assert.strictEqual(resultado.ok, false);
      assert.strictEqual(resultado.motivo, 'respuesta_no_ok');
    }
  );
});

testAsync('consultarPagoEnMercadoPago: motivo "red" ante fallo de fetch', async () => {
  await withMockFetch(
    async () => {
      throw new Error('network down');
    },
    async () => {
      const resultado = await consultarPagoEnMercadoPago({ paymentId: '999', accessToken: 'TEST-TOKEN' });
      assert.strictEqual(resultado.ok, false);
      assert.strictEqual(resultado.motivo, 'red');
    }
  );
});

testAsync('consultarPagoEnMercadoPago: motivo "sin_credencial" si no hay accessToken', async () => {
  const resultado = await consultarPagoEnMercadoPago({ paymentId: '999', accessToken: undefined });
  assert.strictEqual(resultado.ok, false);
  assert.strictEqual(resultado.motivo, 'sin_credencial');
});

testAsync('consultarPagoEnMercadoPago: motivo "payment_id_invalido" ante id vacio', async () => {
  const resultado = await consultarPagoEnMercadoPago({ paymentId: '', accessToken: 'TEST-TOKEN' });
  assert.strictEqual(resultado.ok, false);
  assert.strictEqual(resultado.motivo, 'payment_id_invalido');
});

testAsync('consultarPagoEnMercadoPago: nunca revela el accessToken en el resultado', async () => {
  await withMockFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 1, status: 'approved' }),
    }),
    async () => {
      const resultado = await consultarPagoEnMercadoPago({ paymentId: '1', accessToken: 'TEST-SECRET-TOKEN' });
      assert.strictEqual(JSON.stringify(resultado).includes('TEST-SECRET-TOKEN'), false);
    }
  );
});

// --- Runner ----------------------------------------------------------------

async function run() {
  const resultados = [];
  for (const { name, fn, async: isAsync } of results) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (isAsync) await fn();
      else fn();
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
  console.log('Pruebas de lib/mercadopago-webhook.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
