'use strict';

/**
 * POST /api/pedidos-preferencia
 *
 * Fase 3, Etapa 3: reintenta iniciar el pago (Mercado Pago Checkout Pro)
 * de un pedido YA CREADO, sin crear un pedido nuevo. Existe para el caso
 * en que api/pedidos.js no pudo devolver un redirectUrl en el mismo
 * request en el que se creo el pedido (por ejemplo, un error transitorio
 * de red contra Mercado Pago): el pedido ya quedo guardado, y este
 * endpoint permite retomar el flujo de pago sin duplicar nada.
 *
 * El cliente SOLO envia el payment_retry_token que recibio de
 * api/pedidos.js. Este token es un mecanismo independiente de
 * access_token (que queda reservado para la futura consulta segura del
 * estado del pedido): unicamente autoriza el intento de iniciar/reanudar
 * el pago de ESE pedido puntual. Ver lib/payment-retry-token.js.
 *
 * Pasos del servidor (en este orden):
 * 1) Valida el formato del token recibido.
 * 2) Encuentra el pedido correspondiente por el HASH del token (nunca se
 *    guarda ni se busca por el token en claro).
 * 3) Verifica que el pedido siga en un estado que permite pagar
 *    (lib/pedido-preferencia.js#pedidoAdmitePago). Si no, se rechaza sin
 *    tocar Mercado Pago.
 * 4) Si el pedido ya tiene una mp_preference_id valida y reutilizable,
 *    NO crea una preferencia nueva: crearOReutilizarPreferenciaParaPedido
 *    ya implementa esa idempotencia (relee la preferencia existente en
 *    Mercado Pago en vez de crear otra).
 * 5) Si no existe todavia, o la existente ya no se puede reutilizar
 *    (Mercado Pago no permite "editar" una preferencia: en ese caso se
 *    crea una nueva), crea la preferencia con la misma logica que usa
 *    api/pedidos.js.
 * 6) La preferencia sigue vinculada al pedido real via external_reference
 *    (fijado dentro de buildOrderPreferencePayload a pedido.id).
 * 7) Devuelve UNICAMENTE { redirectUrl }.
 *
 * Reutilizable vs. crear una preferencia nueva (documentado tambien en
 * lib/pedido-preferencia.js): una preferencia existente se considera
 * reutilizable cuando Mercado Pago todavia la devuelve al consultarla por
 * ID (GET /checkout/preferences/:id) y expone un sandbox_init_point
 * valido. Si esa lectura falla (por ejemplo, la preferencia ya no existe
 * del lado de Mercado Pago), se crea una preferencia nueva y se
 * actualiza mp_preference_id: esto es seguro porque external_reference
 * sigue apuntando al mismo pedido y los items/precios salen del mismo
 * snapshot ya persistido, nunca se duplica el pedido ni se alteran
 * precios o productos.
 *
 * Nunca devuelve: el UUID interno del pedido; access_token;
 * payment_retry_token (ni su hash); datos personales del comprador;
 * credenciales de Mercado Pago; detalles internos de Supabase. Los
 * errores son siempre un mensaje generico: nunca se loguea el body de la
 * request ni el resultado de Supabase/Mercado Pago.
 */

const {
  obtenerPedidoPorPaymentRetryTokenHash: obtenerPedidoPorPaymentRetryTokenHashReal,
  obtenerItemsPorPedido: obtenerItemsPorPedidoReal,
  PedidoStoreError,
} = require('../lib/padel-orders-store');
const {
  esPaymentRetryTokenValido,
  hashPaymentRetryToken,
} = require('../lib/payment-retry-token');
const {
  crearOReutilizarPreferenciaParaPedido,
  pedidoAdmitePago,
} = require('../lib/pedido-preferencia');

const GENERIC_ERROR_MESSAGE = 'No pudimos reiniciar el pago. Intentá nuevamente en unos minutos.';
const MAX_BODY_LENGTH = 500;
const CAMPOS_RAIZ = ['paymentRetryToken'];

function sendGenericError(res, status) {
  res.status(status).json({ error: GENERIC_ERROR_MESSAGE });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tieneSoloClaves(obj, clavesPermitidas) {
  return Object.keys(obj).every((k) => clavesPermitidas.indexOf(k) !== -1);
}

function getBodyAsString(rawBody) {
  if (typeof rawBody === 'string') return rawBody;
  try {
    return JSON.stringify(rawBody || {});
  } catch (err) {
    return '';
  }
}

// Valida la forma del body: unicamente {paymentRetryToken: string}. Nada
// mas (ni el numero de pedido, ni el UUID, ni ningun otro campo) se
// acepta desde el cliente para localizar el pedido.
function validarFormaDelBody(parsedBody) {
  if (!isPlainObject(parsedBody)) return { ok: false };
  if (!tieneSoloClaves(parsedBody, CAMPOS_RAIZ)) return { ok: false };
  const { paymentRetryToken } = parsedBody;
  if (!esPaymentRetryTokenValido(paymentRetryToken)) return { ok: false };
  return { ok: true, paymentRetryToken };
}

function mapPedidoStoreErrorToStatus(error) {
  if (!(error instanceof PedidoStoreError)) return 500;
  switch (error.code) {
    case 'VALIDACION':
      return 400;
    case 'NO_ENCONTRADO':
      return 404;
    case 'CONFIGURACION':
    case 'DB_ERROR':
    default:
      return 500;
  }
}

/**
 * Factory: permite inyectar dependencias en los tests, igual que
 * api/pedidos.js. El export por default usa las dependencias reales.
 */
function createPedidosPreferenciaHandler(deps) {
  const obtenerPedidoPorPaymentRetryTokenHash =
    (deps && deps.obtenerPedidoPorPaymentRetryTokenHash) || obtenerPedidoPorPaymentRetryTokenHashReal;
  const obtenerItemsPorPedido = (deps && deps.obtenerItemsPorPedido) || obtenerItemsPorPedidoReal;
  const crearPreferenciaParaPedido =
    (deps && deps.crearPreferenciaParaPedido) || crearOReutilizarPreferenciaParaPedido;

  return async function handler(req, res) {
    try {
      // 1) Solo POST.
      if (req.method !== 'POST') {
        return sendGenericError(res, 405);
      }

      // 2) Content-Type estricto.
      const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        return sendGenericError(res, 415);
      }

      // 3) Tamano de body acotado (el body esperado es minusculo: un
      // solo token de 64 caracteres).
      const rawBody = req.body;
      const bodyString = getBodyAsString(rawBody);
      if (bodyString.length > MAX_BODY_LENGTH) {
        return sendGenericError(res, 413);
      }

      let parsedBody = rawBody;
      if (typeof rawBody === 'string') {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch (err) {
          return sendGenericError(res, 400);
        }
      }

      // 4) Forma del body + formato del token. Cualquier otro campo, o un
      // token con formato invalido, se rechaza aca (nunca se llega a
      // tocar la base de datos con un valor que no cumple el formato
      // esperado).
      const forma = validarFormaDelBody(parsedBody);
      if (!forma.ok) {
        return sendGenericError(res, 400);
      }

      // 5) Encuentra el pedido por el HASH del token (nunca se guarda ni
      // se busca por el valor en claro).
      const hash = hashPaymentRetryToken(forma.paymentRetryToken);
      let pedido;
      try {
        pedido = await obtenerPedidoPorPaymentRetryTokenHash(hash);
      } catch (err) {
        // Un token que no matchea ningun pedido se trata igual que
        // cualquier otro error de validacion: mensaje generico, nunca se
        // revela si el token "existio pero expiro" vs. "nunca existio".
        return sendGenericError(res, mapPedidoStoreErrorToStatus(err));
      }

      // 6) El pedido debe seguir en un estado que permita pagar. Si ya
      // se aprobo el pago, o el pedido esta cancelado/expirado/en otro
      // punto del fulfillment, se rechaza sin tocar Mercado Pago.
      if (!pedidoAdmitePago(pedido)) {
        return sendGenericError(res, 409);
      }

      // 7) Crea (o reutiliza) la preferencia con la misma logica que usa
      // api/pedidos.js: nunca crea una segunda preferencia si ya existe
      // una reutilizable, y los items/precios salen siempre del snapshot
      // ya persistido (pedido_items), nunca de un valor mandado por el
      // cliente.
      let items;
      try {
        items = await obtenerItemsPorPedido(pedido.id);
      } catch (err) {
        return sendGenericError(res, 500);
      }

      const resultado = await crearPreferenciaParaPedido({ pedido, items });
      if (!resultado || !resultado.ok || !resultado.checkoutUrl) {
        return sendGenericError(res, 502);
      }

      // 8) Respuesta minima: SOLO redirectUrl. Nunca el UUID interno,
      // nunca access_token ni el payment_retry_token/su hash, nunca
      // datos personales ni detalles de Mercado Pago/Supabase.
      return res.status(200).json({ redirectUrl: resultado.checkoutUrl });
    } catch (err) {
      return sendGenericError(res, 500);
    }
  };
}

module.exports = createPedidosPreferenciaHandler();
module.exports.createPedidosPreferenciaHandler = createPedidosPreferenciaHandler;
module.exports.GENERIC_ERROR_MESSAGE = GENERIC_ERROR_MESSAGE;
module.exports.MAX_BODY_LENGTH = MAX_BODY_LENGTH;
