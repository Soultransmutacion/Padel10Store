'use strict';

/**
 * Pruebas de api/mercadopago-webhook.js (Fase 3, Etapa 4: webhook server-side
 * de Mercado Pago).
 *
 * Igual que tests/api-pedidos.test.js y tests/api-pedidos-preferencia.test.js,
 * estas pruebas NO se conectan a Supabase ni a Mercado Pago: usan
 * dependencias de prueba inyectadas via createMercadoPagoWebhookHandler
 * (incluida la validacion de firma y la consulta del pago, para poder
 * simular deterministicamente cada escenario sin red real).
 */

const assert = require('assert');
const crypto = require('crypto');
const {
  createMercadoPagoWebhookHandler,
} = require('../api/mercadopago-webhook');
const { PedidoStoreError } = require('../lib/padel-orders-store');
const { construirManifiesto } = require('../lib/mercadopago-webhook');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}
function testAsync(name, fn) {
  test(name, fn);
}

const SECRET = 'webhook-secret-de-prueba';
const ACCESS_TOKEN = 'TEST-ACCESS-TOKEN';

function firmar({ dataId, xRequestId, ts, secret }) {
  const manifest = construirManifiesto({ dataId, xRequestId, ts });
  return crypto.createHmac('sha256', secret || SECRET).update(manifest).digest('hex');
}

function headersValidos({ dataId, xRequestId, ts, secret }) {
  const v1 = firmar({ dataId, xRequestId, ts, secret });
  return {
    'x-signature': `ts=${ts},v1=${v1}`,
    'x-request-id': xRequestId,
  };
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

function notificacionValida(overrides) {
  const base = {
    method: 'POST',
    dataId: '555000111',
    xRequestId: 'req-' + Math.random().toString(36).slice(2),
    ts: '1700000000',
    tipo: 'payment',
    notificacionId: 1000 + Math.floor(Math.random() * 100000),
  };
  return Object.assign(base, overrides || {});
}

function buildReq(notif) {
  // omitirDataId / omitirXRequestId simulan una notificacion LEGITIMA de
  // Mercado Pago que, segun la regla oficial, llega sin data.id y/o sin
  // x-request-id: en ese caso el manifest firmado por Mercado Pago omite
  // ese segmento por completo, y por eso la firma tambien se calcula aca
  // (dataIdParaFirma / xRequestIdParaFirma) sobre el manifest reducido, no
  // sobre el valor completo de notif.dataId / notif.xRequestId.
  const dataIdParaFirma = notif.omitirDataId ? undefined : notif.dataId;
  const xRequestIdParaFirma = notif.omitirXRequestId ? undefined : notif.xRequestId;

  const headers = notif.sinHeaders
    ? {}
    : headersValidos({
        dataId: dataIdParaFirma,
        xRequestId: xRequestIdParaFirma,
        ts: notif.ts,
        secret: notif.secretParaFirmar,
      });
  const query = notif.sinQuery
    ? {}
    : Object.assign(
        notif.omitirDataId ? { type: notif.tipo } : { 'data.id': notif.dataId, type: notif.tipo },
        notif.queryExtra || {}
      );
  return {
    method: notif.method === undefined ? 'POST' : notif.method,
    headers,
    query,
    body: notif.sinBody
      ? undefined
      : Object.assign({ id: notif.notificacionId, type: notif.tipo, data: { id: notif.dataId } }, notif.bodyExtra || {}),
  };
}

// --- Pedido "real" de prueba ------------------------------------------

function pedidoValido(overrides) {
  return Object.assign(
    {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      numero: 'P10-000123',
      estado_pago: 'pendiente',
      estado_pedido: 'pendiente_pago',
      mp_payment_id: null,
      total: 206000,
      moneda: 'ARS',
    },
    overrides || {}
  );
}

function pagoValido(overrides) {
  return Object.assign(
    {
      id: '555000111',
      externalReference: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      status: 'approved',
      statusDetail: 'accredited',
      transactionAmount: 206000,
      currencyId: 'ARS',
    },
    overrides || {}
  );
}

/**
 * Crea un handler con un "mundo" en memoria: un pedido y un mapa de
 * eventos de webhook ya procesados, mas espias de cada operacion de
 * escritura para poder verificar cuantas veces (y con que argumentos) se
 * llamo cada una.
 */
function crearHandlerDePrueba(opts) {
  const o = opts || {};
  const pedidoInicial = o.pedido === undefined ? pedidoValido() : o.pedido;
  const estado = { pedido: pedidoInicial ? Object.assign({}, pedidoInicial) : null };
  const webhookEventosProcesados = new Set(o.eventosYaProcesados || []);
  const pagos = o.paymentsById || {};

  const llamadas = {
    obtenerPedidoPorId: [],
    asociarPaymentId: [],
    actualizarEstadoPago: [],
    actualizarEstadoPedido: [],
    registrarEvento: [],
    estaEventoWebhookProcesado: [],
    marcarEventoWebhookProcesado: [],
    consultarPagoEnMercadoPago: [],
  };

  const deps = {
    getWebhookSecret: () => (o.secret === undefined ? SECRET : o.secret),
    getAccessToken: () => (o.accessToken === undefined ? ACCESS_TOKEN : o.accessToken),

    obtenerPedidoPorId: async (id) => {
      llamadas.obtenerPedidoPorId.push(id);
      if (o.throwOnObtenerPedido) throw o.throwOnObtenerPedido;
      if (!estado.pedido || estado.pedido.id !== id) {
        throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');
      }
      return Object.assign({}, estado.pedido);
    },

    asociarPaymentId: async (pedidoId, mpPaymentId) => {
      llamadas.asociarPaymentId.push({ pedidoId, mpPaymentId });
      if (o.throwOnAsociarPaymentId) throw o.throwOnAsociarPaymentId;
      estado.pedido.mp_payment_id = mpPaymentId;
    },

    actualizarEstadoPago: async (pedidoId, nuevoEstado, opciones) => {
      llamadas.actualizarEstadoPago.push({ pedidoId, nuevoEstado, opciones });
      estado.pedido.estado_pago = nuevoEstado;
      if (nuevoEstado === 'aprobado') estado.pedido.pagado_at = 'ahora';
    },

    actualizarEstadoPedido: async (pedidoId, nuevoEstado, opciones) => {
      llamadas.actualizarEstadoPedido.push({ pedidoId, nuevoEstado, opciones });
      estado.pedido.estado_pedido = nuevoEstado;
    },

    registrarEvento: async (input) => {
      llamadas.registrarEvento.push(input);
      return {};
    },

    estaEventoWebhookProcesado: async (proveedor, eventoId) => {
      llamadas.estaEventoWebhookProcesado.push({ proveedor, eventoId });
      return webhookEventosProcesados.has(eventoId);
    },

    marcarEventoWebhookProcesado: async (input) => {
      llamadas.marcarEventoWebhookProcesado.push(input);
      if (o.conflictoEnMarcarProcesado) {
        throw new PedidoStoreError('CONFLICTO', 'Este evento de webhook ya fue procesado (idempotencia)');
      }
      if (webhookEventosProcesados.has(input.eventoId)) {
        throw new PedidoStoreError('CONFLICTO', 'Este evento de webhook ya fue procesado (idempotencia)');
      }
      webhookEventosProcesados.add(input.eventoId);
      return {};
    },

    consultarPagoEnMercadoPago: async ({ paymentId, accessToken }) => {
      llamadas.consultarPagoEnMercadoPago.push({ paymentId, accessToken });
      if (o.throwOnConsultarPago) throw o.throwOnConsultarPago;
      if (o.resultadoConsultarPago) return o.resultadoConsultarPago;
      const pago = pagos[paymentId] || pagoValido({ id: paymentId });
      return { ok: true, payment: pago };
    },
  };

  const handler = createMercadoPagoWebhookHandler(deps);
  return { handler, estado, llamadas, webhookEventosProcesados };
}

async function ejecutar(handler, notif) {
  const req = buildReq(notif);
  const res = createMockRes();
  await handler(req, res);
  return res;
}

// === Metodo / headers / firma =============================================

testAsync('rechaza metodos distintos de POST', async () => {
  const { handler } = crearHandlerDePrueba();
  const res = await ejecutar(handler, notificacionValida({ method: 'GET' }));
  assert.strictEqual(res.statusCode, 405);
});

testAsync('firma valida: se procesa normalmente (200)', async () => {
  const { handler, llamadas } = crearHandlerDePrueba();
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(llamadas.consultarPagoEnMercadoPago.length, 1);
});

testAsync('firma invalida: 401, nunca llega a consultar el pago', async () => {
  const { handler, llamadas } = crearHandlerDePrueba();
  const notif = notificacionValida({ secretParaFirmar: 'secreto-equivocado' });
  const res = await ejecutar(handler, notif);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(llamadas.consultarPagoEnMercadoPago.length, 0);
  assert.strictEqual(llamadas.marcarEventoWebhookProcesado.length, 0);
});

testAsync('falta de headers (x-signature/x-request-id): 401', async () => {
  const { handler, llamadas } = crearHandlerDePrueba();
  const res = await ejecutar(handler, notificacionValida({ sinHeaders: true }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(llamadas.consultarPagoEnMercadoPago.length, 0);
});

testAsync('falta data.id en la query: 401 (no se puede validar la firma)', async () => {
  const { handler } = crearHandlerDePrueba();
  const res = await ejecutar(handler, notificacionValida({ sinQuery: true }));
  assert.strictEqual(res.statusCode, 401);
});

testAsync('sin MERCADOPAGO_WEBHOOK_SECRET configurado: 401 (fail closed, nunca abre por defecto), tampoco toca la base ni Mercado Pago', async () => {
  const { handler, llamadas } = crearHandlerDePrueba({ secret: '' });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(llamadas.consultarPagoEnMercadoPago.length, 0);
  assert.strictEqual(llamadas.obtenerPedidoPorId.length, 0);
  assert.strictEqual(llamadas.estaEventoWebhookProcesado.length, 0);
});

testAsync('firma invalida (en cualquiera de sus variantes): nunca consulta Mercado Pago ni toca la base de datos', async () => {
  const escenarios = [
    () => notificacionValida({ secretParaFirmar: 'secreto-equivocado' }), // firma no coincide
    () => notificacionValida({ sinHeaders: true }), // x-signature/x-request-id ausentes por completo
    () => notificacionValida({ sinQuery: true }), // data.id ausente EN LA QUERY, pero firmado como si estuviera presente: el manifest no coincide
  ];
  for (const construir of escenarios) {
    const { handler, llamadas } = crearHandlerDePrueba();
    // eslint-disable-next-line no-await-in-loop
    const res = await ejecutar(handler, construir());
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(llamadas.obtenerPedidoPorId.length, 0);
    assert.strictEqual(llamadas.consultarPagoEnMercadoPago.length, 0);
    assert.strictEqual(llamadas.asociarPaymentId.length, 0);
    assert.strictEqual(llamadas.actualizarEstadoPago.length, 0);
    assert.strictEqual(llamadas.actualizarEstadoPedido.length, 0);
    assert.strictEqual(llamadas.registrarEvento.length, 0);
    assert.strictEqual(llamadas.estaEventoWebhookProcesado.length, 0);
    assert.strictEqual(llamadas.marcarEventoWebhookProcesado.length, 0);
  }
});

// === Regla oficial de Mercado Pago: data.id / x-request-id ausentes se ===
// === omiten del manifest, no invalidan la firma por si solos ==============
//
// Distincion clave (pedida explicitamente): la validacion CRIPTOGRAFICA de
// la firma sigue la regla oficial de omitir del manifest lo que no este
// presente; que el PROCESAMIENTO DE NEGOCIO pueda continuar sin un data.id
// utilizable para consultar /v1/payments/{id} es una decision aparte, que
// nunca debe hacer que la firma en si se considere invalida.

testAsync('falta x-request-id (firmado por Mercado Pago sobre el manifest reducido): firma valida, se procesa normalmente', async () => {
  const { handler, llamadas } = crearHandlerDePrueba();
  const notif = notificacionValida({ omitirXRequestId: true });
  const res = await ejecutar(handler, notif);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(llamadas.consultarPagoEnMercadoPago.length, 1);
  assert.strictEqual(llamadas.consultarPagoEnMercadoPago[0].paymentId, notif.dataId);
});

testAsync('falta data.id (firmado por Mercado Pago sobre el manifest reducido): la firma es valida (nunca 401); el procesamiento se detiene de forma segura sin tocar el pedido', async () => {
  const { handler, llamadas } = crearHandlerDePrueba({
    // Simula lo que devuelve la consulta REAL a Mercado Pago cuando no hay
    // payment id utilizable (ver
    // lib/mercadopago-webhook.js#consultarPagoEnMercadoPago, motivo
    // "payment_id_invalido"): esto aisla deliberadamente "la firma es
    // valida" de "el pago se pudo consultar", que son dos cosas distintas.
    resultadoConsultarPago: { ok: false, motivo: 'payment_id_invalido' },
  });
  const notif = notificacionValida({ omitirDataId: true });
  const res = await ejecutar(handler, notif);
  // NUNCA 401: la firma es criptograficamente valida sobre el manifest que
  // Mercado Pago realmente firmo (sin el segmento "id:").
  assert.notStrictEqual(res.statusCode, 401);
  assert.strictEqual(res.statusCode, 502); // se detiene de forma segura (reintentable), nunca aprueba
  assert.strictEqual(llamadas.obtenerPedidoPorId.length, 0);
  assert.strictEqual(llamadas.asociarPaymentId.length, 0);
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 0);
  assert.strictEqual(llamadas.actualizarEstadoPedido.length, 0);
  assert.strictEqual(llamadas.marcarEventoWebhookProcesado.length, 0);
});

// === No se confia en el body / topico =====================================

testAsync('topico distinto de "payment" se reconoce (200) pero no se procesa', async () => {
  const { handler, llamadas } = crearHandlerDePrueba();
  const res = await ejecutar(handler, notificacionValida({ tipo: 'merchant_order' }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(llamadas.consultarPagoEnMercadoPago.length, 0);
});

testAsync('no se confia en el status que venga en el body: solo se usa el de la API real', async () => {
  const { handler, estado } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'approved' }) },
  });
  // El body trae un campo "status"/"data.status" falso simulando un
  // intento de manipulacion desde el navegador; el handler ni siquiera
  // deberia leerlo.
  const res = await ejecutar(
    handler,
    notificacionValida({ bodyExtra: { status: 'rejected', data: { id: '555000111', status: 'rejected' } } })
  );
  assert.strictEqual(res.statusCode, 200);
  // El resultado real vino de resultadoConsultarPago (approved), no del body.
  assert.strictEqual(estado.pedido.estado_pago, 'aprobado');
});

testAsync('falta el id de notificacion en el body: 400', async () => {
  const { handler } = crearHandlerDePrueba();
  const notif = notificacionValida();
  const req = buildReq(notif);
  delete req.body.id;
  const res = createMockRes();
  const { handler: h } = crearHandlerDePrueba();
  await h(req, res);
  assert.strictEqual(res.statusCode, 400);
});

// === Idempotencia / notificacion duplicada ================================

testAsync('notificacion duplicada (mismo evento_id): segunda llamada no repite efectos', async () => {
  const { handler, llamadas } = crearHandlerDePrueba();
  const notif = notificacionValida();

  const res1 = await ejecutar(handler, notif);
  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 1);
  assert.strictEqual(llamadas.asociarPaymentId.length, 1);

  const res2 = await ejecutar(handler, notif); // mismo notif => mismo id/dataId/ts
  assert.strictEqual(res2.statusCode, 200);
  // No se repite ningun efecto de escritura.
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 1);
  assert.strictEqual(llamadas.asociarPaymentId.length, 1);
  assert.strictEqual(llamadas.consultarPagoEnMercadoPago.length, 1);
});

testAsync('transicion idempotente: segunda notificacion DISTINTA que resuelve al mismo estado no reescribe', async () => {
  const pedido = pedidoValido({ estado_pago: 'aprobado', estado_pedido: 'a_preparar', mp_payment_id: '555000111' });
  const { handler, llamadas } = crearHandlerDePrueba({ pedido });

  // Notificacion nueva (evento_id distinto) para el MISMO pago, ya aprobado.
  const res = await ejecutar(handler, notificacionValida({ notificacionId: 999999 }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 0); // ya estaba aprobado: no-op
  assert.strictEqual(llamadas.actualizarEstadoPedido.length, 0); // ya estaba a_preparar: no-op
  assert.strictEqual(llamadas.asociarPaymentId.length, 0); // mismo mp_payment_id: no-op
});

testAsync('condicion de carrera: marcarEventoWebhookProcesado en conflicto se trata como exito silencioso', async () => {
  const { handler } = crearHandlerDePrueba({ conflictoEnMarcarProcesado: true });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
});

// === Payment inexistente ====================================================

testAsync('payment inexistente en Mercado Pago (404): 200, se registra anomalia, no se toca el pedido', async () => {
  const { handler, estado, llamadas } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: false, motivo: 'no_encontrado', status: 404 },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pago, 'pendiente'); // sin cambios
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 0);
  assert.strictEqual(llamadas.marcarEventoWebhookProcesado.length, 1);
  assert.strictEqual(llamadas.marcarEventoWebhookProcesado[0].pedidoId, null);
});

testAsync('error tecnico/transitorio consultando el pago: 502, NO se marca procesado (permite reintento)', async () => {
  const { handler, llamadas } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: false, motivo: 'red' },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(llamadas.marcarEventoWebhookProcesado.length, 0);
});

// === external_reference inexistente ========================================

testAsync('external_reference inexistente (no matchea ningun pedido): 200, anomalia sin pedido asociado', async () => {
  const { handler, llamadas } = crearHandlerDePrueba({
    pedido: null,
    resultadoConsultarPago: {
      ok: true,
      payment: pagoValido({ externalReference: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
    },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 0);
  assert.strictEqual(llamadas.marcarEventoWebhookProcesado[0].pedidoId, null);
  assert.strictEqual(llamadas.marcarEventoWebhookProcesado[0].metadata.anomalia, 'external_reference_no_encontrado');
});

testAsync('external_reference con formato invalido (no UUID): se trata igual que inexistente', async () => {
  const { handler, llamadas } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ externalReference: 'no-es-un-uuid' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(llamadas.obtenerPedidoPorId.length, 0); // ni se llega a consultar
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 0);
});

testAsync('error tecnico buscando el pedido (no NO_ENCONTRADO): no se confunde con external_reference inexistente', async () => {
  const { handler, llamadas } = crearHandlerDePrueba({
    throwOnObtenerPedido: new PedidoStoreError('DB_ERROR', 'boom'),
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.ok(res.statusCode >= 500);
  assert.strictEqual(llamadas.marcarEventoWebhookProcesado.length, 0); // no se da por procesado
});

// === Monto / moneda incorrectos =============================================

testAsync('monto incorrecto: NUNCA se marca aprobado, se registra anomalia', async () => {
  const { handler, estado, llamadas } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ transactionAmount: 1 }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pago, 'pendiente');
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 0);
  assert.strictEqual(llamadas.asociarPaymentId.length, 0);
  assert.strictEqual(
    llamadas.registrarEvento.some((e) => e.metadata && e.metadata.anomalia === 'monto_moneda_no_coincide'),
    true
  );
});

testAsync('moneda incorrecta: NUNCA se marca aprobado, se registra anomalia', async () => {
  const { handler, estado, llamadas } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ currencyId: 'USD' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pago, 'pendiente');
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 0);
});

// === Mapeo de estados: aprobado / pendiente / rechazado / cancelado / reembolsado ===

testAsync('aprobado: estado_pago=aprobado, mp_payment_id asociado, evento marcado procesado', async () => {
  const { handler, estado, llamadas } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'approved' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pago, 'aprobado');
  assert.strictEqual(estado.pedido.mp_payment_id, '555000111');
  assert.strictEqual(llamadas.marcarEventoWebhookProcesado.length, 1);
});

testAsync('pedido aprobado pasa de pendiente_pago a a_preparar', async () => {
  const { handler, estado, llamadas } = crearHandlerDePrueba({
    pedido: pedidoValido({ estado_pago: 'pendiente', estado_pedido: 'pendiente_pago' }),
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'approved' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pedido, 'a_preparar');
  assert.strictEqual(llamadas.actualizarEstadoPedido.length, 1);
  assert.strictEqual(llamadas.actualizarEstadoPedido[0].nuevoEstado, 'a_preparar');
});

testAsync('pendiente: estado_pago=pendiente, estado_pedido NO avanza', async () => {
  const { handler, estado, llamadas } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'pending' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pago, 'pendiente');
  assert.strictEqual(llamadas.actualizarEstadoPedido.length, 0);
});

testAsync('rechazado: estado_pago=rechazado', async () => {
  const { handler, estado } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'rejected' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pago, 'rechazado');
});

testAsync('cancelado: estado_pago=cancelado', async () => {
  const { handler, estado } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'cancelled' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pago, 'cancelado');
});

testAsync('reembolsado: un pedido ya aprobado puede pasar a reembolsado', async () => {
  const { handler, estado } = crearHandlerDePrueba({
    pedido: pedidoValido({ estado_pago: 'aprobado', estado_pedido: 'a_preparar', mp_payment_id: '555000111' }),
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'refunded' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pago, 'reembolsado');
});

testAsync('transicion invalida (aprobado -> pendiente): nunca se aplica, se registra anomalia', async () => {
  const { handler, estado, llamadas } = crearHandlerDePrueba({
    pedido: pedidoValido({ estado_pago: 'aprobado', estado_pedido: 'a_preparar', mp_payment_id: '555000111' }),
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'pending' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pago, 'aprobado'); // sin cambios
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 0);
  assert.strictEqual(
    llamadas.registrarEvento.some((e) => e.metadata && e.metadata.anomalia === 'transicion_invalida'),
    true
  );
});

testAsync('status de Mercado Pago no reconocido: se registra anomalia, no se aplica ningun estado', async () => {
  const { handler, estado, llamadas } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'in_mediation' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.estado_pago, 'pendiente');
  assert.strictEqual(llamadas.actualizarEstadoPago.length, 0);
});

// === mp_payment_id asociado correctamente ==================================

testAsync('mp_payment_id se asocia correctamente al pedido', async () => {
  const { handler, estado, llamadas } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ id: '777888999', status: 'approved' }) },
  });
  const res = await ejecutar(handler, notificacionValida({ dataId: '777888999' }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.mp_payment_id, '777888999');
  assert.strictEqual(llamadas.asociarPaymentId.length, 1);
  assert.strictEqual(llamadas.asociarPaymentId[0].mpPaymentId, '777888999');
});

testAsync('mp_payment_id ya asociado a otro pedido (conflicto de unicidad): se registra anomalia, nunca se sobreescribe', async () => {
  const { handler, estado, llamadas } = crearHandlerDePrueba({
    throwOnAsociarPaymentId: new PedidoStoreError('CONFLICTO', 'mp_payment_id ya esta asociado a otro pedido'),
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'approved' }) },
  });
  const res = await ejecutar(handler, notificacionValida());
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(estado.pedido.mp_payment_id, null);
  assert.strictEqual(estado.pedido.estado_pago, 'pendiente'); // no se aprueba si el payment id quedo en conflicto
  assert.strictEqual(
    llamadas.registrarEvento.some((e) => e.metadata && e.metadata.anomalia === 'payment_id_en_conflicto'),
    true
  );
});

// === No exposicion de secrets ================================================

test('ninguna respuesta de esta suite expone el webhook secret ni el access token', async () => {
  const escenarios = [
    () => crearHandlerDePrueba(),
    () => crearHandlerDePrueba({ resultadoConsultarPago: { ok: false, motivo: 'no_encontrado', status: 404 } }),
    () => crearHandlerDePrueba({ pedido: null }),
    () => crearHandlerDePrueba({ resultadoConsultarPago: { ok: true, payment: pagoValido({ transactionAmount: 1 }) } }),
    () => crearHandlerDePrueba({ throwOnObtenerPedido: new Error('boom') }),
  ];
  return (async () => {
    for (const crear of escenarios) {
      const { handler } = crear();
      // eslint-disable-next-line no-await-in-loop
      const res = await ejecutar(handler, notificacionValida());
      const serializado = JSON.stringify(res.body || {});
      assert.strictEqual(serializado.includes(SECRET), false);
      assert.strictEqual(serializado.includes(ACCESS_TOKEN), false);
    }
    // Y tambien ante firma invalida / sin headers.
    const { handler: h1 } = crearHandlerDePrueba();
    const res1 = await ejecutar(h1, notificacionValida({ secretParaFirmar: 'otro' }));
    assert.strictEqual(JSON.stringify(res1.body || {}).includes(SECRET), false);
  })();
});

test('ninguna respuesta de esta suite expone datos del pedido (uuid, numero, comprador)', async () => {
  const { handler } = crearHandlerDePrueba({
    resultadoConsultarPago: { ok: true, payment: pagoValido({ status: 'approved' }) },
  });
  return (async () => {
    const res = await ejecutar(handler, notificacionValida());
    assert.deepStrictEqual(res.body, {});
  })();
});

// === Se mantienen los tests anteriores del proyecto (verificado por npm test) ===
// (no aplica reescribir aca: npm test sigue corriendo todos los archivos
// existentes ademas de este; ver package.json).

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
  console.log('Pruebas de api/mercadopago-webhook.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
