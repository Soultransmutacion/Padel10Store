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

// Regla oficial de Mercado Pago: "If any of the values (data.id,
// x-request-id) are not present in the received notification, you must
// remove them from the manifest before computing the HMAC". Se omite el
// segmento COMPLETO ("id:...;" o "request-id:...;"), nunca se incluye con
// un valor vacio.

test('construirManifiesto: omite "request-id:" por completo si x-request-id no esta presente', () => {
  assert.strictEqual(
    construirManifiesto({ dataId: '123456789', xRequestId: undefined, ts: '1700000000' }),
    'id:123456789;ts:1700000000;'
  );
  assert.strictEqual(
    construirManifiesto({ dataId: '123456789', xRequestId: '', ts: '1700000000' }),
    'id:123456789;ts:1700000000;'
  );
});

test('construirManifiesto: omite "id:" por completo si data.id no esta presente', () => {
  assert.strictEqual(
    construirManifiesto({ dataId: undefined, xRequestId: 'req-1', ts: '1700000000' }),
    'request-id:req-1;ts:1700000000;'
  );
  assert.strictEqual(
    construirManifiesto({ dataId: null, xRequestId: 'req-1', ts: '1700000000' }),
    'request-id:req-1;ts:1700000000;'
  );
});

test('construirManifiesto: omite ambos segmentos si data.id y x-request-id no estan presentes (solo ts)', () => {
  assert.strictEqual(
    construirManifiesto({ dataId: undefined, xRequestId: undefined, ts: '1700000000' }),
    'ts:1700000000;'
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

test('validarFirmaWebhook: false si falta "ts" dentro de x-signature (solo v1)', () => {
  const dataId = '123456789';
  const xRequestId = 'req-abc';
  const manifestCompleto = construirManifiesto({ dataId, xRequestId, ts: '1700000000' });
  const v1 = crypto.createHmac('sha256', SECRET).update(manifestCompleto).digest('hex');
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: `v1=${v1}`, xRequestId, dataId, secret: SECRET }),
    false
  );
});

test('validarFirmaWebhook: false si falta "v1" dentro de x-signature (solo ts)', () => {
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: 'ts=1700000000', xRequestId: 'req', dataId: '1', secret: SECRET }),
    false
  );
});

// Regla oficial de Mercado Pago: data.id y x-request-id ausentes se omiten
// del manifest (nunca causan por si solos que la firma se considere
// invalida). Distinto de "ts"/"v1", que son intrinsecos al header
// x-signature y siempre son obligatorios.

test('validarFirmaWebhook: true si falta x-request-id pero la firma es valida sobre el manifest reducido', () => {
  const dataId = '123456789';
  const ts = '1700000000';
  // Firmado (por Mercado Pago) SIN x-request-id: el manifest real que
  // Mercado Pago firmo omite el segmento "request-id:...;".
  const { header } = firmarNotificacion({ dataId, xRequestId: undefined, ts });
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId: undefined, dataId, secret: SECRET }),
    true
  );
});

test('validarFirmaWebhook: true si falta data.id pero la firma es valida sobre el manifest reducido (solo validacion criptografica)', () => {
  const xRequestId = 'req-abc';
  const ts = '1700000000';
  // Firmado (por Mercado Pago) SIN data.id: el manifest real que Mercado
  // Pago firmo omite el segmento "id:...;". Esto SOLO prueba el origen
  // criptografico de la notificacion; si el procesamiento de negocio puede
  // continuar sin un data.id utilizable es decision de
  // api/mercadopago-webhook.js, no de esta funcion (ver tests de ese
  // archivo: "falta data.id pero firma valida").
  const { header } = firmarNotificacion({ dataId: undefined, xRequestId, ts });
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId, dataId: undefined, secret: SECRET }),
    true
  );
});

test('validarFirmaWebhook: false si un manifest reducido (sin x-request-id) se valida como si fuera completo, o viceversa', () => {
  const dataId = '123456789';
  const ts = '1700000000';
  // Firmado SIN x-request-id (manifest reducido)...
  const { header } = firmarNotificacion({ dataId, xRequestId: undefined, ts });
  // ...pero se intenta validar como si x-request-id SI hubiera estado
  // presente: el manifest usado para validar ya no coincide con el que se
  // firmo, el HMAC no puede coincidir.
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId: 'req-que-no-se-firmo', dataId, secret: SECRET }),
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
