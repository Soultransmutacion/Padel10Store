'use strict';

/**
 * POST /api/mercadopago-webhook
 *
 * Fase 3, Etapa 4 (+ soporte de merchant_order): webhook server-side de
 * Mercado Pago. Es la UNICA fuente de verdad que puede marcar un pedido
 * como pagado (estado_pago = 'aprobado'): ningun otro camino del sistema
 * hace esa transicion.
 *
 * Mercado Pago manda a esta MISMA URL dos formas de notificacion muy
 * distintas, que este handler soporta con dos caminos separados:
 *
 * A) 'payment' (webhooks v2, firmados): trae header x-signature valido.
 *    Flujo SIN CAMBIOS respecto de la version anterior de este archivo
 *    (ver "Camino A" mas abajo).
 *
 * B) 'merchant_order' ("MercadoPago Feed v2.0", legado): en la practica,
 *    Mercado Pago sigue enviando estas notificaciones, pero NUNCA traen
 *    una firma HMAC valida (evidencia real: 4/4 notificaciones recibidas
 *    con topic=merchant_order respondieron 401 por falta de firma antes
 *    de este cambio). Exigirles la misma firma que a 'payment' las
 *    dejaria sin procesar para siempre. En cambio, este
 *    camino trata el id recibido UNICAMENTE como un puntero (nunca como
 *    dato de verdad): vuelve a consultar TODO del lado servidor
 *    (/merchant_orders/{id}, y despues cada payment asociado via
 *    /v1/payments/{id}, la MISMA consulta ya autenticada que usa el
 *    camino A) con el access token propio, y antes de tocar Supabase
 *    cruza external_reference, preference_id y monto/moneda contra el
 *    pedido real. Ver "Camino B" mas abajo para el detalle completo.
 *
 * Reglas de seguridad comunes a AMBOS caminos:
 *
 * - NUNCA se confia en ningun campo del body de la notificacion (ni el
 *   status, ni el monto, ni el external_reference) para decidir el estado
 *   de un pago: todo dato de negocio sale SIEMPRE de una consulta
 *   autenticada (con el access token propio) a la API oficial de Mercado
 *   Pago. El body/la query de la notificacion entrante solo se usan para
 *   decidir QUE recurso volver a consultar (el "puntero").
 * - Idempotencia: ninguna transicion se aplica dos veces ante una
 *   notificacion repetida (webhook_eventos_procesados, lib/padel-orders-store.js).
 * - El pedido se busca por external_reference (fijado al id interno del
 *   pedido en lib/mercadopago-preference.js#buildOrderPreferencePayload).
 *   Si no existe, o si el monto/moneda no coincide con el snapshot ya
 *   persistido del pedido, el pedido NUNCA se marca como aprobado.
 * - El status mapeado (lib/pedido-pago-mapeo.js) debe ser una transicion
 *   valida desde el estado_pago actual del pedido.
 * - Eventos: solo se registra metadata tecnica minima (ids, status, motivo
 *   de anomalia) en pedido_eventos / webhook_eventos_procesados. Nunca se
 *   guarda el payload completo de la notificacion, el access token, el
 *   webhook secret, el payment_retry_token ni datos de tarjeta.
 * - Logs (console.log, ademas de los eventos de auditoria en base): SIEMPRE
 *   sanitizados. Nunca incluyen el webhook secret, el access token, ni
 *   ningun dato personal del comprador (nombre/email/telefono/direccion).
 *   Solo ids tecnicos (evento, merchant_order, payment, pedido), topico y
 *   motivo. Sirven para poder distinguir, mirando los logs: firma
 *   faltante, topico no soportado, merchant_order inexistente,
 *   discrepancia de pedido y procesamiento correcto (ver logSeguro).
 *
 * Respuesta HTTP: siempre un body minimo (nunca datos del pedido, nunca un
 * secreto). El status code es lo unico que le importa a Mercado Pago:
 * - 401: firma invalida/faltante en el camino 'payment' -> Mercado Pago
 *   puede reintentar, pero sin la firma correcta nunca se va a procesar.
 * - 400: notificacion sin forma reconocible (falta el id de evento en
 *   'payment', o el puntero de merchant_order no tiene formato valido):
 *   un reintento identico tampoco lo va a resolver.
 * - 200: notificacion reconocida y manejada (incluye casos de negocio que
 *   nunca se van a resolver con un reintento: topico fuera de alcance,
 *   duplicado, recurso inexistente, external_reference/preference_id/
 *   monto/moneda que no coinciden, transicion invalida).
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
  esTopicoDeMerchantOrder,
  esMerchantOrderIdValido,
  validarFirmaWebhook: validarFirmaWebhookReal,
  consultarPagoEnMercadoPago: consultarPagoEnMercadoPagoReal,
  consultarMerchantOrderEnMercadoPago: consultarMerchantOrderEnMercadoPagoReal,
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

// Notificaciones legadas de merchant_order ("Feed v2.0") suelen llegar
// como ?topic=merchant_order&id={id}, sin el data.id de las webhooks v2.
// Se acepta, en este orden de preferencia, cualquiera de las tres formas
// en que Mercado Pago lo manda: query "id" (formato clasico), query
// "data.id"/"data_id" (por si llegara en el formato mas nuevo), o el
// sufijo numerico de body.resource (".../merchant_orders/123"). En los
// tres casos el valor se trata EXCLUSIVAMENTE como un puntero crudo, sin
// validar todavia: la validacion estricta de formato la hace
// esMerchantOrderIdValido, siempre antes de usarlo para nada.
function extraerMerchantOrderIdDesdeResource(resource) {
  if (typeof resource !== 'string') return null;
  const match = resource.match(/\/merchant_orders\/([0-9]+)(?:[/?].*)?$/);
  return match ? match[1] : null;
}

function obtenerMerchantOrderIdCrudo({ query, body }) {
  const desdeQueryId = getQueryParam(query, 'id');
  if (desdeQueryId) return desdeQueryId;
  const desdeDataId = getQueryParam(query, 'data.id') || getQueryParam(query, 'data_id');
  if (desdeDataId) return desdeDataId;
  return extraerMerchantOrderIdDesdeResource(body && body.resource);
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

// Log sanitizado (ademas de, nunca en lugar de, los eventos de auditoria
// que ya se guardan en base): unicamente ids tecnicos, topico y motivo.
// Nunca el webhook secret, el access token, ni ningun dato personal del
// comprador. Un fallo al loguear nunca debe interrumpir el procesamiento.
function logSeguro(categoria, detalle) {
  try {
    console.log(JSON.stringify(Object.assign({ webhook: 'mercadopago', categoria }, detalle || {})));
  } catch (err) {
    // No-op: nunca se deja que un problema de logging tumbe la respuesta.
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
  const consultarMerchantOrderEnMercadoPago =
    d.consultarMerchantOrderEnMercadoPago || consultarMerchantOrderEnMercadoPagoReal;
  const getWebhookSecret = d.getWebhookSecret || (() => process.env.MERCADOPAGO_WEBHOOK_SECRET);
  const getAccessToken = d.getAccessToken || (() => process.env.MERCADOPAGO_ACCESS_TOKEN);

  // Registra la anomalia como evento tecnico minimo. Nunca deja que un
  // fallo al dejar constancia interrumpa la respuesta HTTP: el llamador
  // siempre decide el status code, esta funcion solo intenta dejar rastro.
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

  // Busca el pedido por external_reference, con las mismas reglas de
  // siempre: nunca acepta un valor que no tenga forma de UUID, y
  // distingue "el pedido no existe" (caso de negocio, nunca se resuelve
  // con un reintento) de un error tecnico real (Supabase caido, timeout),
  // que si amerita un status que haga reintentar a Mercado Pago mas tarde
  // en vez de perder la notificacion silenciosamente. Usada por AMBOS
  // caminos (payment directo, y merchant_order tanto para el chequeo de
  // preference_id como, indirectamente via procesarPagoAutenticado, para
  // cada payment asociado).
  async function resolverPedidoPorExternalReference(externalReference) {
    if (!externalReference || !esUuidValido(externalReference)) {
      return { ok: true, pedido: null };
    }
    try {
      const pedido = await obtenerPedidoPorId(externalReference);
      return { ok: true, pedido };
    } catch (err) {
      if (err instanceof PedidoStoreError && err.code === 'NO_ENCONTRADO') {
        return { ok: true, pedido: null };
      }
      const status = mapPedidoStoreErrorToStatus(err);
      return { ok: false, statusCode: status >= 500 ? 502 : status };
    }
  }

  // Nucleo de negocio COMPARTIDO por los dos caminos: dado un `payment` YA
  // AUTENTICADO (siempre via consultarPagoEnMercadoPago, nunca del body de
  // ninguna notificacion) y un `eventoId` para idempotencia, resuelve el
  // pedido por external_reference, valida monto/moneda/transicion, y
  // aplica los efectos (asociar payment id, actualizar estado_pago,
  // avanzar estado_pedido si corresponde). Es EXACTAMENTE la misma logica
  // que ya tenia este archivo para 'payment' antes de agregar soporte de
  // merchant_order: se extrajo a una funcion para poder reutilizarla,
  // sin duplicarla, una vez por cada payment asociado a un merchant_order.
  async function procesarPagoAutenticado({ payment, eventoId, topico }) {
    const resolucion = await resolverPedidoPorExternalReference(payment.externalReference);
    if (!resolucion.ok) return { statusCode: resolucion.statusCode };
    const pedido = resolucion.pedido;

    if (!pedido) {
      logSeguro('discrepancia_pedido', { motivo: 'external_reference_no_encontrado', eventoId, topico });
      await intentarMarcarProcesado({
        eventoId,
        tipo: topico,
        pedidoId: null,
        metadata: { anomalia: 'external_reference_no_encontrado' },
      });
      return { statusCode: 200 };
    }

    // Monto y moneda deben coincidir con el snapshot ya persistido. Si no
    // coinciden, el pedido NUNCA se marca como aprobado, sin importar el
    // status que reporte Mercado Pago.
    if (!montoYMonedaCoinciden({ pedido, payment })) {
      logSeguro('discrepancia_pedido', { motivo: 'monto_moneda_no_coincide', eventoId, topico, pedidoId: pedido.id });
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
      return { statusCode: 200 };
    }

    // Mapear el status a estado_pago. Un status no reconocido nunca se
    // aplica: se registra como anomalia.
    const estadoPagoNuevo = mapearEstadoPago(payment.status);
    if (!estadoPagoNuevo) {
      logSeguro('discrepancia_pedido', { motivo: 'status_no_reconocido', eventoId, topico, pedidoId: pedido.id });
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
      return { statusCode: 200 };
    }

    // La transicion debe ser valida desde el estado_pago actual. Nunca se
    // permite una transicion invalida hacia atras (por ejemplo, un pedido
    // ya aprobado "retrocediendo" a pendiente).
    if (!esTransicionEstadoPagoValida(pedido.estado_pago, estadoPagoNuevo)) {
      logSeguro('discrepancia_pedido', { motivo: 'transicion_invalida', eventoId, topico, pedidoId: pedido.id });
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
      return { statusCode: 200 };
    }

    // Aplicar los efectos. Cada paso es un no-op si el pedido ya esta en
    // el valor destino (idempotencia ante una notificacion repetida cuyo
    // evento_id, por algun motivo, no se detecto antes).
    if (payment.id && pedido.mp_payment_id !== payment.id) {
      try {
        await asociarPaymentId(pedido.id, payment.id);
      } catch (err) {
        // Un mismo payment id ya asociado a OTRO pedido es un conflicto
        // grave (constraint UNIQUE de la base): se registra como anomalia
        // y NUNCA se sobreescribe.
        logSeguro('discrepancia_pedido', { motivo: 'payment_id_en_conflicto', eventoId, topico, pedidoId: pedido.id });
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
        return { statusCode: 200 };
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

    logSeguro('procesamiento_correcto', { eventoId, topico, pedidoId: pedido.id, mpStatus: payment.status });

    // Marcar la notificacion como procesada: garantia final de
    // idempotencia (constraint UNIQUE de proveedor+evento_id).
    await intentarMarcarProcesado({
      eventoId,
      tipo: topico,
      pedidoId: pedido.id,
      metadata: { mp_status: payment.status },
    });

    return { statusCode: 200 };
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
      const body = parseBody(req.body);

      // Topico: se lee (query primero, body como respaldo) ANTES de
      // decidir si hace falta firma, porque la respuesta a esa pregunta
      // depende del topico (ver "Camino A" vs "Camino B" mas abajo). Esto
      // es UNICAMENTE una decision de ENRUTAMIENTO: en ningun camino se
      // usa el topico (ni ningun otro campo del body) como fuente de
      // verdad de negocio, eso siempre sale de una consulta autenticada.
      const topico = getQueryParam(query, 'type') || getQueryParam(query, 'topic') || body.type;

      // ======================================================================
      // Camino B: 'merchant_order' (legado, "Feed v2.0", nunca firmado)
      // ======================================================================
      if (esTopicoDeMerchantOrder(topico)) {
        logSeguro('firma_ausente_merchant_order', { topico });

        const merchantOrderIdCrudo = obtenerMerchantOrderIdCrudo({ query, body });
        if (!esMerchantOrderIdValido(merchantOrderIdCrudo)) {
          logSeguro('merchant_order_id_invalido', {});
          return ack(res, 400);
        }
        const merchantOrderId = String(merchantOrderIdCrudo).trim();

        const accessToken = getAccessToken();
        const resultadoMerchantOrder = await consultarMerchantOrderEnMercadoPago({ merchantOrderId, accessToken });
        if (!resultadoMerchantOrder.ok) {
          if (resultadoMerchantOrder.motivo === 'no_encontrado') {
            logSeguro('merchant_order_inexistente', { merchantOrderId });
            return ack(res, 200);
          }
          // Error tecnico/transitorio (red, Mercado Pago caido, credencial
          // mal configurada): no se marca nada, se responde para que
          // Mercado Pago reintente mas tarde.
          return ack(res, 502);
        }

        const merchantOrder = resultadoMerchantOrder.merchantOrder;

        // Verificacion 1 de 2 (a nivel merchant_order): external_reference
        // debe corresponder a un pedido existente.
        const resolucionPedido = await resolverPedidoPorExternalReference(merchantOrder.externalReference);
        if (!resolucionPedido.ok) return ack(res, resolucionPedido.statusCode);
        const pedido = resolucionPedido.pedido;
        if (!pedido) {
          logSeguro('discrepancia_pedido', {
            motivo: 'external_reference_no_encontrado',
            merchantOrderId,
          });
          return ack(res, 200);
        }

        // Verificacion 2 de 2 (a nivel merchant_order): preference_id debe
        // coincidir con pedidos.mp_preference_id. Un merchant_order sin
        // preference_id, o con uno distinto del que ya tiene el pedido, se
        // rechaza sin tocar Supabase: nunca se "asume" que coincide.
        if (!merchantOrder.preferenceId || merchantOrder.preferenceId !== pedido.mp_preference_id) {
          logSeguro('discrepancia_pedido', {
            motivo: 'preference_id_no_coincide',
            merchantOrderId,
            pedidoId: pedido.id,
          });
          await registrarAnomaliaSilenciosa({
            pedidoId: pedido.id,
            motivo: 'preference_id_no_coincide',
            metadataExtra: { merchant_order_id: merchantOrderId },
          });
          return ack(res, 200);
        }

        if (merchantOrder.paymentIds.length === 0) {
          // Merchant_order valido y ya cruzado contra el pedido, pero sin
          // ningun payment asociado todavia (por ejemplo, orden abierta sin
          // intento de pago aun): no hay nada que aplicar, no es una
          // anomalia.
          logSeguro('procesamiento_correcto', {
            motivo: 'merchant_order_sin_pagos',
            merchantOrderId,
            pedidoId: pedido.id,
          });
          return ack(res, 200);
        }

        // Cada payment asociado se consulta y procesa por separado, con la
        // MISMA funcion (consultarPagoEnMercadoPago) y el MISMO nucleo de
        // negocio (procesarPagoAutenticado) que ya usa el camino 'payment':
        // nunca se confia en los campos de pago embebidos en la respuesta
        // de /merchant_orders/{id}, solo en su id como puntero.
        // eslint-disable-next-line no-restricted-syntax
        for (const paymentId of merchantOrder.paymentIds) {
          const subEventoId = `merchant_order_payment:${paymentId}`;

          // Idempotencia por payment (no por notificacion): un
          // merchant_order puede volver a notificarse con un id de
          // notificacion distinto (o sin ninguno, en este formato legado)
          // referenciando el mismo payment ya aplicado. Chequear por el id
          // real del payment, en vez de por un id de notificacion que
          // podria no venir, es lo que garantiza que la transicion nunca
          // se aplique dos veces.
          let yaProcesado;
          try {
            // eslint-disable-next-line no-await-in-loop
            yaProcesado = await estaEventoWebhookProcesado(PROVEEDOR, subEventoId);
          } catch (err) {
            return ack(res, 500);
          }
          if (yaProcesado) {
            logSeguro('procesamiento_correcto', { motivo: 'evento_duplicado', merchantOrderId, paymentId });
            continue;
          }

          // eslint-disable-next-line no-await-in-loop
          const resultadoPago = await consultarPagoEnMercadoPago({ paymentId, accessToken });
          if (!resultadoPago.ok) {
            if (resultadoPago.motivo === 'no_encontrado') {
              logSeguro('discrepancia_pedido', { motivo: 'payment_no_encontrado', merchantOrderId, paymentId });
              // eslint-disable-next-line no-await-in-loop
              await intentarMarcarProcesado({
                eventoId: subEventoId,
                tipo: topico,
                pedidoId: null,
                metadata: { anomalia: 'payment_no_encontrado' },
              });
              continue;
            }
            // Error tecnico: se aborta toda la notificacion para que
            // Mercado Pago reintente. Los payments de este mismo
            // merchant_order que ya se hubieran aplicado en este request
            // quedan a salvo (la idempotencia por payment id evita
            // repetirlos en el reintento).
            return ack(res, 502);
          }

          const payment = resultadoPago.payment;

          // Defensa en profundidad: el payment consultado debe apuntar al
          // MISMO pedido que ya se valido a nivel merchant_order (mismo
          // external_reference). Si no coincide, es sospechoso: se
          // rechaza sin tocar Supabase.
          if (payment.externalReference !== pedido.id) {
            logSeguro('discrepancia_pedido', {
              motivo: 'payment_external_reference_no_coincide',
              merchantOrderId,
              paymentId,
              pedidoId: pedido.id,
            });
            // eslint-disable-next-line no-await-in-loop
            await registrarAnomaliaSilenciosa({
              pedidoId: pedido.id,
              motivo: 'payment_external_reference_no_coincide',
              metadataExtra: { mp_payment_id: payment.id || null },
            });
            // eslint-disable-next-line no-await-in-loop
            await intentarMarcarProcesado({
              eventoId: subEventoId,
              tipo: topico,
              pedidoId: pedido.id,
              metadata: { anomalia: 'payment_external_reference_no_coincide' },
            });
            continue;
          }

          // eslint-disable-next-line no-await-in-loop
          const resultado = await procesarPagoAutenticado({ payment, eventoId: subEventoId, topico });
          if (resultado.statusCode !== 200) {
            return ack(res, resultado.statusCode);
          }
        }

        return ack(res, 200);
      }

      // ======================================================================
      // Camino A: 'payment' (webhooks v2, firmados) y cualquier otro topico
      // no reconocido explicitamente. Comportamiento SIN CAMBIOS respecto
      // de la version anterior de este archivo: la firma oficial de
      // Mercado Pago sigue siendo obligatoria, SIEMPRE primero, antes de
      // mirar el topico o el body.
      // ======================================================================

      const firmaValida = validarFirmaWebhook({
        xSignatureHeader,
        xRequestId,
        dataId,
        secret,
      });
      if (!firmaValida) {
        logSeguro('firma_faltante', { topico: topico || null });
        return ack(res, 401);
      }

      // Solo se procesa el topico 'payment'. Cualquier otro topico
      // (point_integration_wh, etc.) se reconoce con 200 pero no se
      // procesa: no es un error, es trafico fuera de alcance.
      if (!esTopicoDePago(topico)) {
        logSeguro('topico_no_soportado', { topico: topico || null });
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

      // Idempotencia (chequeo temprano). La garantia fuerte contra
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
        logSeguro('procesamiento_correcto', { motivo: 'evento_duplicado', eventoId });
        return ack(res, 200);
      }

      // Consultar el pago REAL. Nunca se confia en el status (ni ningun
      // otro campo) que pudiera venir en el body de la notificacion:
      // unicamente se usa data.id, ya autenticado por la firma, para
      // pedirle el pago completo a la API oficial.
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

      const resultado = await procesarPagoAutenticado({ payment: resultadoPago.payment, eventoId, topico });
      return ack(res, resultado.statusCode);
    } catch (err) {
      return ack(res, 500);
    }
  };
}

module.exports = createMercadoPagoWebhookHandler();
module.exports.createMercadoPagoWebhookHandler = createMercadoPagoWebhookHandler;
module.exports.mapPedidoStoreErrorToStatus = mapPedidoStoreErrorToStatus;
