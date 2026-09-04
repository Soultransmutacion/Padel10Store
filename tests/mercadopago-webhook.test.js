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
  TOPICO_MERCHANT_ORDER,
  esTopicoDePago,
  esTopicoDeMerchantOrder,
  esMerchantOrderIdValido,
  parsearXSignature,
  construirManifiesto,
  compararHexEnTiempoConstante,
  calcularCorrelacionFirma,
  diagnosticarFirmaWebhook,
  validarFirmaWebhook,
  consultarPagoEnMercadoPago,
  consultarMerchantOrderEnMercadoPago,
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

// --- esTopicoDeMerchantOrder / TOPICO_MERCHANT_ORDER ----------------------

test('TOPICO_MERCHANT_ORDER es "merchant_order"', () => {
  assert.strictEqual(TOPICO_MERCHANT_ORDER, 'merchant_order');
});

test('esTopicoDeMerchantOrder: true solo para "merchant_order" (insensible a mayusculas/espacios)', () => {
  assert.strictEqual(esTopicoDeMerchantOrder('merchant_order'), true);
  assert.strictEqual(esTopicoDeMerchantOrder(' Merchant_Order '), true);
  assert.strictEqual(esTopicoDeMerchantOrder('MERCHANT_ORDER'), true);
});

test('esTopicoDeMerchantOrder: false para otros topicos o entradas invalidas', () => {
  assert.strictEqual(esTopicoDeMerchantOrder('payment'), false);
  assert.strictEqual(esTopicoDeMerchantOrder('point_integration_wh'), false);
  assert.strictEqual(esTopicoDeMerchantOrder(''), false);
  assert.strictEqual(esTopicoDeMerchantOrder(null), false);
  assert.strictEqual(esTopicoDeMerchantOrder(undefined), false);
});

// --- esMerchantOrderIdValido: validacion ESTRICTA (solo digitos) ---------

test('esMerchantOrderIdValido: true para ids numericos (string o number), con o sin espacios', () => {
  assert.strictEqual(esMerchantOrderIdValido('99887766'), true);
  assert.strictEqual(esMerchantOrderIdValido(' 99887766 '), true);
  assert.strictEqual(esMerchantOrderIdValido(99887766), true);
  assert.strictEqual(esMerchantOrderIdValido('1'), true);
});

test('esMerchantOrderIdValido: false ante cualquier valor no puramente numerico (nunca lo "sanea")', () => {
  assert.strictEqual(esMerchantOrderIdValido('abc'), false);
  assert.strictEqual(esMerchantOrderIdValido('123abc'), false);
  assert.strictEqual(esMerchantOrderIdValido('12.3'), false);
  assert.strictEqual(esMerchantOrderIdValido('-123'), false);
  assert.strictEqual(esMerchantOrderIdValido('1;DROP TABLE pedidos'), false);
  assert.strictEqual(esMerchantOrderIdValido('123456789012345678901'), false); // > 20 digitos
  assert.strictEqual(esMerchantOrderIdValido(''), false);
  assert.strictEqual(esMerchantOrderIdValido('   '), false);
  assert.strictEqual(esMerchantOrderIdValido(null), false);
  assert.strictEqual(esMerchantOrderIdValido(undefined), false);
  assert.strictEqual(esMerchantOrderIdValido({}), false);
  assert.strictEqual(esMerchantOrderIdValido(['99887766']), false);
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

// Mercado Pago envia data.id como string en la practica (query param HTTP,
// y tambien como string dentro de data.id en el body), pero
// construirManifiesto/tienePresencia normalizan con String(...), asi que
// un data.id que llegara como number (por ejemplo, si algun llamador lo
// parseara con Number() antes de pasarlo) debe firmar/validar exactamente
// igual que su equivalente string.
test('validarFirmaWebhook: data.id como number valida igual que su equivalente string', () => {
  const xRequestId = 'req-abc';
  const ts = '1700000000';
  const { header } = firmarNotificacion({ dataId: 123456789, xRequestId, ts });
  assert.strictEqual(
    validarFirmaWebhook({ xSignatureHeader: header, xRequestId, dataId: 123456789, secret: SECRET }),
    true
  );
  // Y la firma calculada para el number coincide exactamente con la del
  // string equivalente (mismo manifest, misma firma).
  const { header: headerString } = firmarNotificacion({ dataId: '123456789', xRequestId, ts });
  assert.strictEqual(header, headerString);
});

test('construirManifiesto: data.id number y string equivalente producen el mismo manifest', () => {
  assert.strictEqual(
    construirManifiesto({ dataId: 123456789, xRequestId: 'req-1', ts: '1' }),
    construirManifiesto({ dataId: '123456789', xRequestId: 'req-1', ts: '1' })
  );
});

// --- calcularCorrelacionFirma ---------------------------------------------

test('calcularCorrelacionFirma: null ante header ausente/vacio', () => {
  assert.strictEqual(calcularCorrelacionFirma(undefined), null);
  assert.strictEqual(calcularCorrelacionFirma(null), null);
  assert.strictEqual(calcularCorrelacionFirma(''), null);
  assert.strictEqual(calcularCorrelacionFirma('   '), null);
});

test('calcularCorrelacionFirma: hash hex de 12 caracteres, estable para el mismo header', () => {
  const header = 'ts=1700000000,v1=abc123def456';
  const correlacion = calcularCorrelacionFirma(header);
  assert.strictEqual(typeof correlacion, 'string');
  assert.strictEqual(correlacion.length, 12);
  assert.ok(/^[0-9a-f]{12}$/.test(correlacion));
  assert.strictEqual(calcularCorrelacionFirma(header), correlacion); // determinista
});

test('calcularCorrelacionFirma: headers distintos producen hashes distintos, y nunca contiene el header original', () => {
  const c1 = calcularCorrelacionFirma('ts=1700000000,v1=abc123');
  const c2 = calcularCorrelacionFirma('ts=1700000001,v1=def456');
  assert.notStrictEqual(c1, c2);
  assert.strictEqual(c1.includes('abc123'), false);
});

// --- diagnosticarFirmaWebhook ----------------------------------------------
//
// Nucleo compartido con validarFirmaWebhook (misma logica exacta, ver
// comentario en lib/mercadopago-webhook.js): estas pruebas confirman que
// el campo "valida" siempre coincide con validarFirmaWebhook para el mismo
// input, que el "motivo" categoriza correctamente cada caso, y que la
// salida NUNCA expone el secreto, el manifest ni la firma real (v1).

test('diagnosticarFirmaWebhook: motivo "secreto_no_configurado" si falta el secreto', () => {
  const { header } = firmarNotificacion({ dataId: '1', xRequestId: 'req', ts: '1700000000' });
  const resultado = diagnosticarFirmaWebhook({ xSignatureHeader: header, xRequestId: 'req', dataId: '1', secret: undefined });
  assert.strictEqual(resultado.valida, false);
  assert.strictEqual(resultado.motivo, 'secreto_no_configurado');
  assert.strictEqual(resultado.xSignaturePresente, true);
});

test('diagnosticarFirmaWebhook: motivo "header_ausente_o_incompleto" si falta x-signature o le falta ts/v1', () => {
  const casos = [
    { xSignatureHeader: undefined, xSignaturePresenteEsperado: false },
    { xSignatureHeader: '', xSignaturePresenteEsperado: false },
    { xSignatureHeader: 'formato-invalido', xSignaturePresenteEsperado: true },
    { xSignatureHeader: 'ts=1700000000', xSignaturePresenteEsperado: true }, // falta v1
    { xSignatureHeader: 'v1=abc', xSignaturePresenteEsperado: true }, // falta ts
  ];
  casos.forEach(({ xSignatureHeader, xSignaturePresenteEsperado }) => {
    const resultado = diagnosticarFirmaWebhook({ xSignatureHeader, xRequestId: 'req', dataId: '1', secret: SECRET });
    assert.strictEqual(resultado.valida, false);
    assert.strictEqual(resultado.motivo, 'header_ausente_o_incompleto');
    assert.strictEqual(resultado.xSignaturePresente, xSignaturePresenteEsperado);
  });
});

test('diagnosticarFirmaWebhook: motivo "hmac_no_coincide" si todo esta presente pero la firma no matchea', () => {
  const dataId = '123456789';
  const xRequestId = 'req-abc';
  const ts = '1700000000';
  const { header } = firmarNotificacion({ dataId, xRequestId, ts, secret: 'otro-secreto' });
  const resultado = diagnosticarFirmaWebhook({ xSignatureHeader: header, xRequestId, dataId, secret: SECRET });
  assert.strictEqual(resultado.valida, false);
  assert.strictEqual(resultado.motivo, 'hmac_no_coincide');
  assert.strictEqual(resultado.xSignaturePresente, true);
  assert.strictEqual(resultado.xRequestIdPresente, true);
  assert.strictEqual(resultado.dataIdPresente, true);
  assert.strictEqual(resultado.tsPresente, true);
  assert.strictEqual(resultado.v1Presente, true);
});

test('diagnosticarFirmaWebhook: motivo "valida" con presencia correcta de cada pieza cuando todo coincide', () => {
  const dataId = '123456789';
  const xRequestId = 'req-abc';
  const ts = '1700000000';
  const { header } = firmarNotificacion({ dataId, xRequestId, ts });
  const resultado = diagnosticarFirmaWebhook({ xSignatureHeader: header, xRequestId, dataId, secret: SECRET });
  assert.strictEqual(resultado.valida, true);
  assert.strictEqual(resultado.motivo, 'valida');
  assert.strictEqual(resultado.xSignaturePresente, true);
  assert.strictEqual(resultado.xRequestIdPresente, true);
  assert.strictEqual(resultado.dataIdPresente, true);
  assert.strictEqual(resultado.tsPresente, true);
  assert.strictEqual(resultado.v1Presente, true);
  assert.strictEqual(resultado.correlacion, calcularCorrelacionFirma(header));
});

test('diagnosticarFirmaWebhook: dataIdPresente/xRequestIdPresente reflejan ausencia real (manifest reducido)', () => {
  const ts = '1700000000';
  const { header } = firmarNotificacion({ dataId: undefined, xRequestId: undefined, ts });
  const resultado = diagnosticarFirmaWebhook({ xSignatureHeader: header, xRequestId: undefined, dataId: undefined, secret: SECRET });
  assert.strictEqual(resultado.valida, true); // manifest reducido, pero criptograficamente valido
  assert.strictEqual(resultado.dataIdPresente, false);
  assert.strictEqual(resultado.xRequestIdPresente, false);
});

test('diagnosticarFirmaWebhook: "valida" siempre coincide con validarFirmaWebhook para el mismo input (fuzz simple)', () => {
  const escenarios = [
    { xSignatureHeader: undefined, xRequestId: 'req', dataId: '1', secret: SECRET },
    { xSignatureHeader: 'formato-invalido', xRequestId: 'req', dataId: '1', secret: SECRET },
    { xSignatureHeader: firmarNotificacion({ dataId: '1', xRequestId: 'req', ts: '1' }).header, xRequestId: 'req', dataId: '1', secret: '' },
    { xSignatureHeader: firmarNotificacion({ dataId: '1', xRequestId: 'req', ts: '1' }).header, xRequestId: 'req', dataId: '1', secret: SECRET },
    { xSignatureHeader: firmarNotificacion({ dataId: '1', xRequestId: 'req', ts: '1' }).header, xRequestId: 'req', dataId: '2', secret: SECRET },
  ];
  escenarios.forEach((args) => {
    assert.strictEqual(diagnosticarFirmaWebhook(args).valida, validarFirmaWebhook(args));
  });
});

test('diagnosticarFirmaWebhook: nunca expone el secreto, el manifest ni la firma real (v1) en su salida', () => {
  const dataId = '123456789';
  const xRequestId = 'req-abc';
  const ts = '1700000000';
  const { header, v1 } = firmarNotificacion({ dataId, xRequestId, ts });
  const resultado = diagnosticarFirmaWebhook({ xSignatureHeader: header, xRequestId, dataId, secret: SECRET });
  const serializado = JSON.stringify(resultado);
  assert.strictEqual(serializado.includes(SECRET), false);
  assert.strictEqual(serializado.includes(v1), false);
  // Las unicas claves permitidas: nada de "manifest", "firma", "secret" ni
  // el header original completo.
  assert.deepStrictEqual(
    Object.keys(resultado).sort(),
    ['correlacion', 'dataIdPresente', 'motivo', 'tsPresente', 'v1Presente', 'valida', 'xRequestIdPresente', 'xSignaturePresente'].sort()
  );
});

test('diagnosticarFirmaWebhook: nunca lanza excepcion ante entradas completamente vacias', () => {
  assert.doesNotThrow(() => diagnosticarFirmaWebhook());
  assert.doesNotThrow(() => diagnosticarFirmaWebhook({}));
  assert.strictEqual(diagnosticarFirmaWebhook().valida, false);
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

testAsync('consultarPagoEnMercadoPago: acepta paymentId como number, igual que su equivalente string', async () => {
  await withMockFetch(
    async (url) => {
      assert.strictEqual(url, 'https://api.mercadopago.com/v1/payments/123456789');
      return { ok: true, status: 200, json: async () => ({ id: 123456789, status: 'approved' }) };
    },
    async () => {
      const resultado = await consultarPagoEnMercadoPago({ paymentId: 123456789, accessToken: 'TEST-TOKEN' });
      assert.strictEqual(resultado.ok, true);
      assert.strictEqual(resultado.payment.id, '123456789');
    }
  );
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

// --- consultarMerchantOrderEnMercadoPago (mockea global.fetch) -----------

testAsync('consultarMerchantOrderEnMercadoPago: normaliza la respuesta real de Mercado Pago (solo ids de payments, nunca sus datos)', async () => {
  await withMockFetch(
    async (url, options) => {
      assert.strictEqual(url, 'https://api.mercadopago.com/merchant_orders/99887766');
      assert.strictEqual(options.method, 'GET');
      assert.ok(options.headers.Authorization.includes('Bearer'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 99887766,
          external_reference: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          preference_id: 'PREF-123456789',
          payments: [
            { id: 555000111, status: 'approved', transaction_amount: 206000, currency_id: 'ARS' },
            { id: 555000111, status: 'approved', transaction_amount: 206000, currency_id: 'ARS' }, // duplicado
            { id: 555000222, status: 'rejected', transaction_amount: 1, currency_id: 'ARS' },
          ],
        }),
      };
    },
    async () => {
      const resultado = await consultarMerchantOrderEnMercadoPago({ merchantOrderId: '99887766', accessToken: 'TEST-TOKEN' });
      assert.strictEqual(resultado.ok, true);
      assert.deepStrictEqual(resultado.merchantOrder, {
        id: '99887766',
        externalReference: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        preferenceId: 'PREF-123456789',
        paymentIds: ['555000111', '555000222'], // deduplicado, solo ids
      });
      // Nunca expone status/monto/moneda de los payments embebidos: eso
      // se debe volver a consultar con consultarPagoEnMercadoPago.
      assert.strictEqual(JSON.stringify(resultado.merchantOrder).includes('approved'), false);
      assert.strictEqual(JSON.stringify(resultado.merchantOrder).includes('206000'), false);
    }
  );
});

testAsync('consultarMerchantOrderEnMercadoPago: sin payments, paymentIds vacio', async () => {
  await withMockFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ id: 1, payments: [] }) }),
    async () => {
      const resultado = await consultarMerchantOrderEnMercadoPago({ merchantOrderId: '1', accessToken: 'TEST-TOKEN' });
      assert.deepStrictEqual(resultado.merchantOrder.paymentIds, []);
    }
  );
});

testAsync('consultarMerchantOrderEnMercadoPago: motivo "no_encontrado" ante 404', async () => {
  await withMockFetch(
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    async () => {
      const resultado = await consultarMerchantOrderEnMercadoPago({ merchantOrderId: '999', accessToken: 'TEST-TOKEN' });
      assert.strictEqual(resultado.ok, false);
      assert.strictEqual(resultado.motivo, 'no_encontrado');
    }
  );
});

testAsync('consultarMerchantOrderEnMercadoPago: motivo "respuesta_no_ok" ante otros status de error', async () => {
  await withMockFetch(
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => {
      const resultado = await consultarMerchantOrderEnMercadoPago({ merchantOrderId: '999', accessToken: 'TEST-TOKEN' });
      assert.strictEqual(resultado.ok, false);
      assert.strictEqual(resultado.motivo, 'respuesta_no_ok');
    }
  );
});

testAsync('consultarMerchantOrderEnMercadoPago: motivo "red" ante fallo de fetch', async () => {
  await withMockFetch(
    async () => {
      throw new Error('network down');
    },
    async () => {
      const resultado = await consultarMerchantOrderEnMercadoPago({ merchantOrderId: '999', accessToken: 'TEST-TOKEN' });
      assert.strictEqual(resultado.ok, false);
      assert.strictEqual(resultado.motivo, 'red');
    }
  );
});

testAsync('consultarMerchantOrderEnMercadoPago: motivo "sin_credencial" si no hay accessToken', async () => {
  const resultado = await consultarMerchantOrderEnMercadoPago({ merchantOrderId: '999', accessToken: undefined });
  assert.strictEqual(resultado.ok, false);
  assert.strictEqual(resultado.motivo, 'sin_credencial');
});

testAsync('consultarMerchantOrderEnMercadoPago: motivo "merchant_order_id_invalido" ante un id con formato invalido (nunca llega a llamar a fetch)', async () => {
  const originalFetch = global.fetch;
  let fetchLlamado = false;
  global.fetch = async () => {
    fetchLlamado = true;
    throw new Error('no deberia llamarse');
  };
  try {
    const resultado = await consultarMerchantOrderEnMercadoPago({ merchantOrderId: 'abc-no-numerico', accessToken: 'TEST-TOKEN' });
    assert.strictEqual(resultado.ok, false);
    assert.strictEqual(resultado.motivo, 'merchant_order_id_invalido');
    assert.strictEqual(fetchLlamado, false);
  } finally {
    global.fetch = originalFetch;
  }
});

testAsync('consultarMerchantOrderEnMercadoPago: nunca revela el accessToken en el resultado', async () => {
  await withMockFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 1, payments: [] }),
    }),
    async () => {
      const resultado = await consultarMerchantOrderEnMercadoPago({ merchantOrderId: '1', accessToken: 'TEST-SECRET-TOKEN' });
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
