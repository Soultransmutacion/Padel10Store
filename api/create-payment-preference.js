'use strict';

/**
 * POST /api/create-payment-preference
 *
 * Endpoint de PRUEBA (SANDBOX) para Mercado Pago Checkout Pro.
 *
 * Reglas de seguridad:
 * - Solo funciona cuando process.env.VERCEL_ENV === 'preview'.
 * - El navegador solo puede enviar { productId }. Nunca precio, cantidad
 *   ni nombre: esos datos siempre se obtienen del catalogo del servidor.
 * - La cantidad queda fija en 1.
 * - Solo se puede comprar el producto de prueba habilitado
 *   (royal-padel-cross-black-26). Cualquier otro producto responde con el
 *   mismo error generico, sin revelar si existe o no en el catalogo.
 * - La credencial se lee exclusivamente de process.env.MERCADOPAGO_ACCESS_TOKEN
 *   y nunca se envia al frontend ni se escribe en logs.
 * - Las back_urls se construyen con VERCEL_URL (variable de servidor),
 *   nunca con un origen enviado por el navegador.
 * - Solo se acepta y se devuelve sandbox_init_point (nunca init_point).
 * - No se registran en logs ni la credencial ni la respuesta completa de
 *   Mercado Pago.
 */

const {
    GENERIC_ERROR_MESSAGE,
    validateRequestBody,
    getPurchasableProduct,
    isValidSandboxInitPoint,
    getTrustedBaseUrl,
    buildBackUrls,
    buildPreferencePayload,
} = require('../lib/mercadopago-preference');

const { crearPreferenciaEnMercadoPago } = require('../lib/mercadopago-client');

const MAX_BODY_LENGTH = 2000;

function sendGenericError(res, status) {
    res.status(status).json({ error: GENERIC_ERROR_MESSAGE });
}

function getBodyAsString(rawBody) {
    if (typeof rawBody === 'string') return rawBody;
    try {
          return JSON.stringify(rawBody || {});
    } catch (err) {
          return '';
    }
}

module.exports = async function handler(req, res) {
    try {
          // 1) Esta prueba solo puede ejecutarse en despliegues Preview.
      if (process.env.VERCEL_ENV !== 'preview') {
              return sendGenericError(res, 403);
      }

      // 2) Solo se acepta POST.
      if (req.method !== 'POST') {
              return sendGenericError(res, 405);
      }

      // 3) Content-Type estricto.
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
          if (!contentType.includes('application/json')) {
                  return sendGenericError(res, 415);
          }

      // 4) Tamano de body acotado (el body esperado es minusculo: un solo campo).
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

      // 5) Validacion estricta: solo productId, sin campos inesperados
      // (rechaza intentos de enviar price, quantity, name, etc.).
      const validation = validateRequestBody(parsedBody);
          if (!validation.ok) {
                  return sendGenericError(res, 400);
          }

      // 6) El producto, su nombre y su precio salen exclusivamente del
      // catalogo del servidor. Solo el producto de prueba habilitado puede
      // comprarse en esta etapa.
      const productResult = getPurchasableProduct(validation.productId, validation.talle);
          if (!productResult.ok) {
                  return sendGenericError(res, 400);
          }

      // 7) Credencial exclusivamente desde variables de entorno del servidor.
      const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
          if (!accessToken || typeof accessToken !== 'string') {
                  return sendGenericError(res, 500);
          }

      // 8) back_urls con base confiable del servidor (VERCEL_URL), nunca con
      // un origen enviado por el navegador.
      const trustedBaseUrl = getTrustedBaseUrl();
          if (!trustedBaseUrl) {
                  return sendGenericError(res, 500);
          }
          const backUrls = buildBackUrls(trustedBaseUrl);

      const preferencePayload = buildPreferencePayload({
              product: productResult.product,
              backUrls,
            talle: productResult.talle,
      });

      const mpResult = await crearPreferenciaEnMercadoPago({ payload: preferencePayload, accessToken });
      // No se registran detalles tecnicos ni la respuesta de Mercado Pago.
      if (!mpResult.ok) {
        return sendGenericError(res, 502);
      }

      const sandboxInitPoint = mpResult.sandboxInitPoint;

      // 9) Nunca se redirige a un dominio, protocolo o punto de inicio que
      // no sea el sandbox oficial de Mercado Pago.
      if (!isValidSandboxInitPoint(sandboxInitPoint)) {
              return sendGenericError(res, 502);
      }

      return res.status(200).json({ sandboxInitPoint });
    } catch (err) {
          return sendGenericError(res, 500);
    }
};
