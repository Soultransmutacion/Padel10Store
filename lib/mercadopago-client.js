/**
 * Cliente HTTP minimo para la API de preferencias de Mercado Pago.
 *
 * Este modulo concentra la UNICA llamada de red real a Mercado Pago que
 * hace este proyecto, para que api/create-payment-preference.js (prueba de
 * un solo producto) y el flujo de pedidos reales (api/pedidos.js) usen
 * exactamente el mismo codigo en vez de dos implementaciones paralelas.
 *
 * Reglas de seguridad:
 * - Nunca registra en logs la credencial, el payload ni la respuesta
 *   completa de Mercado Pago.
 * - No decide precios, cantidades ni moneda: solo transporta el payload
 *   que le pasa el llamador.
 * - El timeout evita que una llamada colgada bloquee el endpoint.
 */

const MERCADOPAGO_PREFERENCES_URL = 'https://api.mercadopago.com/checkout/preferences';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error('mp_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * Crea una preferencia de pago en Mercado Pago.
 *
 * No lanza excepciones por errores de red/formato: siempre devuelve un
 * objeto { ok, ... } para que el llamador decida como responder (esto
 * evita acoplar este modulo a un objeto `res` de un endpoint especifico).
 */
async function crearPreferenciaEnMercadoPago({ payload, accessToken, timeoutMs } = {}) {
  if (!accessToken || typeof accessToken !== 'string') {
    return { ok: false, motivo: 'sin_credencial' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, motivo: 'payload_invalido' };
  }

  let mpResponse;
  try {
    mpResponse = await withTimeout(
      fetch(MERCADOPAGO_PREFERENCES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      }),
      timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
    );
  } catch (err) {
    // No se registran detalles tecnicos ni la respuesta de Mercado Pago.
    return { ok: false, motivo: 'red' };
  }

  if (!mpResponse.ok) {
    return { ok: false, motivo: 'respuesta_no_ok', status: mpResponse.status };
  }

  let mpData;
  try {
    mpData = await mpResponse.json();
  } catch (err) {
    return { ok: false, motivo: 'json_invalido' };
  }

  return {
    ok: true,
    preferenceId: mpData && typeof mpData.id === 'string' && mpData.id ? mpData.id : null,
    sandboxInitPoint: mpData && typeof mpData.sandbox_init_point === 'string' ? mpData.sandbox_init_point : null,
    initPoint: mpData && typeof mpData.init_point === 'string' ? mpData.init_point : null,
  };
}

/**
 * Recupera una preferencia ya creada (usado para reintentos idempotentes:
 * si el pedido ya tiene mp_preference_id, no creamos una preferencia
 * nueva, releemos la existente para obtener su sandbox_init_point).
 */
async function obtenerPreferenciaDeMercadoPago({ preferenceId, accessToken, timeoutMs } = {}) {
  if (!accessToken || typeof accessToken !== 'string') {
    return { ok: false, motivo: 'sin_credencial' };
  }
  if (!preferenceId || typeof preferenceId !== 'string') {
    return { ok: false, motivo: 'preference_id_invalido' };
  }

  let mpResponse;
  try {
    mpResponse = await withTimeout(
      fetch(`${MERCADOPAGO_PREFERENCES_URL}/${encodeURIComponent(preferenceId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
      timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
    );
  } catch (err) {
    return { ok: false, motivo: 'red' };
  }

  if (!mpResponse.ok) {
    return { ok: false, motivo: 'respuesta_no_ok', status: mpResponse.status };
  }

  let mpData;
  try {
    mpData = await mpResponse.json();
  } catch (err) {
    return { ok: false, motivo: 'json_invalido' };
  }

  return {
    ok: true,
    preferenceId: mpData && typeof mpData.id === 'string' && mpData.id ? mpData.id : null,
    sandboxInitPoint: mpData && typeof mpData.sandbox_init_point === 'string' ? mpData.sandbox_init_point : null,
    initPoint: mpData && typeof mpData.init_point === 'string' ? mpData.init_point : null,
  };
}

module.exports = {
  MERCADOPAGO_PREFERENCES_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  withTimeout,
  crearPreferenciaEnMercadoPago,
  obtenerPreferenciaDeMercadoPago,
};
