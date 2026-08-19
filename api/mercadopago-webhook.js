'use strict';

/**
 * POST /api/mercadopago-webhook
 *
 * Fase 3, Etapa 4: webhook server-side de Mercado Pago. Es la UNICA fuente
 * de verdad que puede marcar un pedido como pagado (estado_pago =
 * 'aprobado'): hasta esta etapa, ningun otro camino del sistema hacia esa
 * transicion.
 *
 * Reglas de seguridad, en el orden en que las aplica este handler:
 *
 * 1) Solo POST.
 * 2) Se valida la FIRMA OFICIAL de Mercado Pago (header x-signature, mas
 *    x-request-id y data.id de la query string) contra
 *    MERCADOPAGO_WEBHOOK_SECRET, usando lib/mercadopago-webhook.js. Esto
 *    se hace ANTES de mirar el topico o el body: una firma invalida (o
 *    headers/datos faltantes) siempre se rechaza con 401, sin excepcion.
 * 3) Solo se procesa el topico 'payment'. Cualquier otro topico (Mercado
 *    Pago manda varios a la misma URL) se reconoce con 200 pero no se
 *    procesa: no es un error, es trafico fuera de alcance.
 * 4) Idempotencia: el id de notificacion (campo `id` del body, NUNCA
 *    data.id que es el id del pago) se busca/marca en
 *    webhook_eventos_procesados (lib/padel-orders-store.js). Una
 *    notificacion ya procesada devuelve 200 de inmediato sin repetir
 *    ningun efecto.
 * 5) NUNCA se confia en ningun campo del body de la notificacion para
 *    decidir el estado de un pago: una vez identificado el payment id
 *    (data.id, ya autenticado por la firma), se consulta el pago REAL via
 *    la API oficial de Mercado Pago (lib/mercadopago-webhook.js
 *    #consultarPagoEnMercadoPago). status, status_detail,
 *    transaction_amount, currency_id y external_reference SIEMPRE salen
 *    de esa consulta.
 * 6) El pedido se busca por external_reference (fijado al id interno del
 *    pedido en lib/mercadopago-preference.js#buildOrderPreferencePayload).
 *    Si no existe, se registra la anomalia (sin poder asociarla a ningun
 *    pedido) y se responde 200 (no es un caso que un reintento vaya a
 *    resolver).
 * 7) El monto y la moneda del pago se validan contra el snapshot ya
 *    persistido del pedido (pedido.total / pedido.moneda). Si no
 *    coinciden, el pedido NUNCA se marca como aprobado, sin importar lo
 *    que diga Mercado Pago: se registra la anomalia y se responde 200.
 * 8) El status mapeado (lib/pedido-pago-mapeo.js) debe ser una transicion
 *    valida desde el estado_pago actual del pedido. Una transicion
 *    invalida (por ejemplo, un pago ya aprobado "retrocediendo") se
 *    registra como anomalia y NUNCA se aplica.
 * 9) Si todo lo anterior es valido: se asocia mp_payment_id (si cambio),
 *    se actualiza estado_pago, y si corresponde (pago aprobado +
 *    pendiente_pago) se avanza estado_pedido a 'a_preparar'.
 *
 * Eventos: solo se registra metadata tecnica minima (ids, status,
 * motivo de anomalia) en pedido_eventos / webhook_eventos_procesados.
 * Nunca se guarda el payload completo de la notificacion, el access
 * token, el webhook secret, el payment_retry_token ni datos de tarjeta.
 *
 * Respuesta HTTP: siempre un body minimo (nunca datos del pedido, nunca
 * un secreto). El status code es lo unico que le importa a Mercado Pago:
 * - 401: firma invalida/faltante -> Mercado Pago puede reintentar, pero
 *   sin la firma correcta nunca se va a procesar.
 * - 200: notificacion reconocida y manejada (incluye casos de negocio que
 *   nunca se van a resolver con un reintento: topico fuera de alcance,
 *   duplicado, payment inexistente, external_reference inexistente,
 *   monto/moneda no coinciden, transicion invalida).
 * - 502/500: error tecnico/transitorio (red, Mercado Pago caido, error de
 *   base de datos): se responde para que Mercado Pago reintente mas
 *   tarde. A proposito NO se marca el evento como procesado en estos
 *   casos, para no perder el reintento.
 */

const {
  obtenerPedidoPorId: obtenerPedidoPorIdReal,
  asociarPaymentId: asociarPaymentIdReal,
  actualizarEstadoPago: actualizarEstadoPagoReal,
  actualizarEstadoPedido: actualizarEstadoPedidoReal,
  registrarEvento: registrarEventoReal,
  estaEventoWebhookProcesado: estaEventoWebhookProcesadoReal,
  marcarEventoWebhookProcesado: marcarEventoWebhookProcesadoReal,
  esUuidValido,
  PedidoStoreError,
} = require('../lib/padel-orders-store');
const {
  esTopicoDePago,
  validarFirmaWebhook: validarFirmaWebhookReal,
  consultarPagoEnMercadoPago: consultarPagoEnMercadoPagoReal,
} = require('../lib/mercadopago-webhook');
const {
  mapearEstadoPago,
  esTransicionEstadoPagoValida,
  debeAvanzarAPreparar,
  montoYMonedaCoinciden,
} = require('../lib/pedido-pago-mapeo');

const PROVEEDOR = 'mercadopago';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ack(res, status) {
  // Body minimo y siempre igual en su forma: el codigo de estado es la
  // unica senal que le importa a Mercado Pago. Nunca se devuelve
  // informacion del pedido, del pago ni de configuracion.
  return res.status(status).json({});
}

function parseBody(rawBody) {
  if (isPlainObject(rawBody)) return rawBody;
  if (typeof rawBody === 'string') {
    try {
      const parsed = JSON.parse(rawBody);
      return isPlainObject(parsed) ? parsed : {};
    } catch (err) {
      return {};
    }
  }
  return {};
}

function getQueryParam(query, key) {
  if (!query || typeof query !== 'object') return undefined;
  const value = query[key];
  // Vercel puede entregar arrays si una clave de query se repite; en ese
  // caso usamos el primer valor (nunca concatenamos ni confiamos en mas
  // de uno).
  if (Array.isArray(value)) return value[0];
  return value;
}

function mapPedidoStoreErrorToStatus(error) {
  if (!(error instanceof PedidoStoreError)) return 500;
  switch (error.code) {
    case 'VALIDACION':
      return 400;
    case 'NO_ENCONTRADO':
      return 404;
    case 'CONFLICTO':
      return 409;
    case 'CONFIGURACION':
    case 'DB_ERROR':
    default:
      return 500;
  }
}

/**
 * Factory: permite inyectar dependencias en los tests (misma convencion
 * que api/pedidos.js y api/pedidos-preferencia.js). El export por default
 * usa las dependencias reales.
 */
function createMercadoPagoWebhookHandler(deps) {
  const d = deps || {};
  const obtenerPedidoPorId = d.obtenerPedidoPorId || obtenerPedidoPorIdReal;
  const asociarPaymentId = d.asociarPaymentId || asociarPaymentIdReal;
  const actualizarEstadoPago = d.actualizarEstadoPago || actualizarEstadoPagoReal;
  const actualizarEstadoPedido = d.actualizarEstadoPedido || actualizarEstadoPedidoReal;
  const registrarEvento = d.registrarEvento || registrarEventoReal;
  const estaEventoWebhookProcesado = d.estaEventoWebhookProcesado || estaEventoWebhookProcesadoReal;
  const marcarEventoWebhookProcesado = d.marcarEventoWebhookProcesado || marcarEventoWebhookProcesadoReal;
  const validarFirmaWebhook = d.validarFirmaWebhook || validarFirmaWebhookReal;
  const consultarPagoEnMercadoPago = d.consultarPagoEnMercadoPago || consultarPagoEnMercadoPagoReal;
  const getWebhookSecret = d.getWebhookSecret || (() => process.env.MERCADOPAGO_WEBHOOK_SECRET);
  const getAccessToken = d.getAccessToken || (() => process.env.MERCADOPAGO_ACCESS_TOKEN);

  // Registra la anomalia como evento tecnico minimo y, si corresponde,
  // marca la notificacion como procesada. Nunca deja que un fallo al
  // dejar constancia interrumpa la respuesta HTTP: el llamador siempre
  // decide el status code, esta funcion solo intenta dejar rastro.
  async function registrarAnomaliaSilenciosa({ pedidoId, motivo, metadataExtra }) {
    if (pedidoId) {
      try {
        await registrarEvento({
          pedidoId,
          tipo: 'otro',
          metadata: Object.assign({ anomalia: motivo }, metadataExtra || {}),
        });
      } catch (err) {
        // No se interrumpe el flujo por un fallo al auditar.
      }
    }
  }

  // Intenta marcar el evento de webhook como procesado. Si ya fue
  // procesado por una notificacion concurrente (violacion de unicidad =
  // PedidoStoreError con code CONFLICTO), se trata como exito silencioso:
  // la garantia real de "una sola vez" la da la constraint UNIQUE de
  // (proveedor, evento_id) en la base, no esta funcion.
  async function intentarMarcarProcesado({ eventoId, tipo, pedidoId, metadata }) {
    try {
      await marcarEventoWebhookProcesado({
        proveedor: PROVEEDOR,
        eventoId,
        tipo: tipo || null,
        pedidoId: pedidoId || null,
        metadata: metadata || {},
      });
    } catch (err) {
      if (err instanceof PedidoStoreError && err.code === 'CONFLICTO') {
        return; // Ya quedo marcado por una notificacion concurrente: ok.
      }
      // No se interrumpe la respuesta por un fallo al dejar constancia de
      // idempotencia: el peor caso es que una notificacion futura
      // idéntica se vuelva a procesar (ver documentacion de limites de
      // concurrencia en el modulo).
    }
  }

  return async function handler(req, res) {
    try {
      // 1) Solo POST.
      if (req.method !== 'POST') {
        return ack(res, 405);
      }

      const headers = req.headers || {};
      const xSignatureHeader = headers['x-signature'];
      const xRequestId = headers['x-request-id'];
      const query = req.query || {};
      const dataId = getQueryParam(query, 'data.id') || getQueryParam(query, 'data_id');

      const secret = getWebhookSecret();

      // 2) Firma oficial, SIEMPRE primero: sin ella no se procesa nada,
      // sin importar el topico ni el contenido del body. Headers/datos
      // faltantes se tratan igual que una firma invalida.
      const firmaValida = validarFirmaWebhook({
        xSignatureHeader,
        xRequestId,
        dataId,
        secret,
      });
      if (!firmaValida) {
        return ack(res, 401);
      }

      const body = parseBody(req.body);

      // 3) Topico: solo se procesa 'payment'. Se acepta tanto en la query
      // (?type=payment, formato habitual de Mercado Pago) como en el
      // body, pero nunca se usa el body para decidir NADA que no sea
      // "que topico es": el estado del pago nunca sale de aca.
      const topico = getQueryParam(query, 'type') || getQueryParam(query, 'topic') || body.type;
      if (!esTopicoDePago(topico)) {
        return ack(res, 200);
      }

      // Id de la notificacion (para idempotencia). Es el campo `id` de
      // nivel superior del body de Mercado Pago (numero de notificacion),
      // DISTINTO de data.id (que es el id del pago). Si falta, no hay
      // forma segura de deduplicar: se rechaza.
      const eventoId =
        body.id !== undefined && body.id !== null && String(body.id).trim() !== ''
          ? String(body.id).trim()
          : null;
      if (!eventoId) {
        return ack(res, 400);
      }

      // 4) Idempotencia (chequeo temprano). La garantia fuerte contra
      // condiciones de carrera la da la constraint UNIQUE de la base,
      // aplicada en intentarMarcarProcesado al final de este flujo; este
      // chequeo evita trabajo innecesario en el caso comun (reintentos
      // secuenciales de Mercado Pago tras no recibir 200 a tiempo).
      let yaProcesado;
      try {
        yaProcesado = await estaEventoWebhookProcesado(PROVEEDOR, eventoId);
      } catch (err) {
        return ack(res, 500);
      }
      if (yaProcesado) {
        return ack(res, 200);
      }

      // 5) Consultar el pago REAL. Nunca se confia en el status (ni
      // ningun otro campo) que pudiera venir en el body de la
      // notificacion: unicamente se usa data.id, ya autenticado por la
      // firma, para pedirle el pago completo a la API oficial.
      const accessToken = getAccessToken();
      const resultadoPago = await consultarPagoEnMercadoPago({ paymentId: dataId, accessToken });

      if (!resultadoPago.ok) {
        if (resultadoPago.motivo === 'no_encontrado') {
          await intentarMarcarProcesado({
            eventoId,
            tipo: topico,
            pedidoId: null,
            metadata: { anomalia: 'payment_no_encontrado' },
          });
          return ack(res, 200);
        }
        // Error tecnico/transitorio (red, Mercado Pago caido, credencial
        // mal configurada): no se marca procesado, se responde para que
        // Mercado Pago reintente mas tarde.
        return ack(res, 502);
      }

      const payment = resultadoPago.payment;

      // 6) Buscar el pedido por external_reference. Nunca se acepta un
      // external_reference que no tenga forma de UUID (evita una consulta
      // innecesaria a la base con un valor que nunca va a matchear).
      let pedido = null;
      if (payment.externalReference && esUuidValido(payment.externalReference)) {
        try {
          pedido = await obtenerPedidoPorId(payment.externalReference);
        } catch (err) {
          // Distinguimos "el pedido no existe" (caso de negocio: nunca se
          // va a resolver con un reintento) de un error tecnico real
          // (Supabase caido, timeout, etc.), que SI merece un status que
          // haga que Mercado Pago reintente mas tarde en vez de perder la
          // notificacion silenciosamente.
          if (err instanceof PedidoStoreError && err.code === 'NO_ENCONTRADO') {
            pedido = null;
          } else {
            return ack(res, mapPedidoStoreErrorToStatus(err) >= 500 ? 502 : mapPedidoStoreErrorToStatus(err));
          }
        }
      }
      if (!pedido) {
        await intentarMarcarProcesado({
          eventoId,
          tipo: topico,
          pedidoId: null,
          metadata: { anomalia: 'external_reference_no_encontrado' },
        });
        return ack(res, 200);
      }

      // 7) Monto y moneda deben coincidir con el snapshot ya persistido.
      // Si no coinciden, el pedido NUNCA se marca como aprobado, sin
      // importar el status que reporte Mercado Pago.
      if (!montoYMonedaCoinciden({ pedido, payment })) {
        await registrarAnomaliaSilenciosa({
          pedidoId: pedido.id,
          motivo: 'monto_moneda_no_coincide',
          metadataExtra: { mp_status: payment.status },
        });
        await intentarMarcarProcesado({
          eventoId,
          tipo: topico,
          pedidoId: pedido.id,
          metadata: { anomalia: 'monto_moneda_no_coincide' },
        });
        return ack(res, 200);
      }

      // 8) Mapear el status a estado_pago. Un status no reconocido nunca
      // se aplica: se registra como anomalia.
      const estadoPagoNuevo = mapearEstadoPago(payment.status);
      if (!estadoPagoNuevo) {
        await registrarAnomaliaSilenciosa({
          pedidoId: pedido.id,
          motivo: 'status_mp_no_reconocido',
          metadataExtra: { mp_status: payment.status },
        });
        await intentarMarcarProcesado({
          eventoId,
          tipo: topico,
          pedidoId: pedido.id,
          metadata: { anomalia: 'status_no_reconocido' },
        });
        return ack(res, 200);
      }

      // 9) La transicion debe ser valida desde el estado_pago actual.
      // Nunca se permite una transicion invalida hacia atras (por
      // ejemplo, un pedido ya aprobado "retrocediendo" a pendiente).
      if (!esTransicionEstadoPagoValida(pedido.estado_pago, estadoPagoNuevo)) {
        await registrarAnomaliaSilenciosa({
          pedidoId: pedido.id,
          motivo: 'transicion_invalida',
          metadataExtra: {
            estado_pago_actual: pedido.estado_pago,
            estado_pago_intentado: estadoPagoNuevo,
          },
        });
        await intentarMarcarProcesado({
          eventoId,
          tipo: topico,
          pedidoId: pedido.id,
          metadata: { anomalia: 'transicion_invalida' },
        });
        return ack(res, 200);
      }

      // 10) Aplicar los efectos. Cada paso es un no-op si el pedido ya
      // esta en el valor destino (idempotencia ante una notificacion
      // repetida cuyo evento_id, por algun motivo, no se detecto en el
      // paso 4 — por ejemplo, dos notificaciones DISTINTAS de Mercado
      // Pago para el mismo pago).
      if (payment.id && pedido.mp_payment_id !== payment.id) {
        try {
          await asociarPaymentId(pedido.id, payment.id);
        } catch (err) {
          // Un mismo payment id ya asociado a OTRO pedido es un conflicto
          // grave (constraint UNIQUE de la base): se registra como
          // anomalia y NUNCA se sobreescribe.
          await registrarAnomaliaSilenciosa({
            pedidoId: pedido.id,
            motivo: 'payment_id_en_conflicto',
            metadataExtra: {},
          });
          await intentarMarcarProcesado({
            eventoId,
            tipo: topico,
            pedidoId: pedido.id,
            metadata: { anomalia: 'payment_id_en_conflicto' },
          });
          return ack(res, 200);
        }
      }

      if (pedido.estado_pago !== estadoPagoNuevo) {
        await actualizarEstadoPago(pedido.id, estadoPagoNuevo, {
          mpStatusDetail: payment.statusDetail,
        });
      }

      if (debeAvanzarAPreparar({ estadoPagoNuevo, estadoPedidoActual: pedido.estado_pedido })) {
        await actualizarEstadoPedido(pedido.id, 'a_preparar', { motivo: 'pago_aprobado_webhook' });
      }

      // 11) Marcar la notificacion como procesada: garantia final de
      // idempotencia (constraint UNIQUE de proveedor+evento_id).
      await intentarMarcarProcesado({
        eventoId,
        tipo: topico,
        pedidoId: pedido.id,
        metadata: { mp_status: payment.status },
      });

      return ack(res, 200);
    } catch (err) {
      return ack(res, 500);
    }
  };
}

module.exports = createMercadoPagoWebhookHandler();
module.exports.createMercadoPagoWebhookHandler = createMercadoPagoWebhookHandler;
module.exports.mapPedidoStoreErrorToStatus = mapPedidoStoreErrorToStatus;
