'use strict';

/**
 * Fase 3, Etapa 4: validacion de origen y consulta del pago REAL para el
 * webhook de Mercado Pago (api/mercadopago-webhook.js).
 *
 * Este modulo concentra dos responsabilidades de seguridad, separadas del
 * endpoint HTTP para poder testearlas de forma aislada:
 *
 * 1) validarFirmaWebhook: confirma que una notificacion realmente vino de
 *    Mercado Pago, verificando la firma oficial (header x-signature) segun
 *    el algoritmo documentado por Mercado Pago (HMAC-SHA256 sobre un
 *    "manifest" armado con data.id + x-request-id + ts, usando el secreto
 *    de webhooks como clave). NUNCA se confia en el body de la notificacion
 *    para decidir nada de seguridad ni de negocio: el body puede ser
 *    reenviado o adulterado por cualquiera que conozca la URL publica del
 *    webhook, la firma es lo unico que prueba el origen.
 *
 * 2) consultarPagoEnMercadoPago: una vez validada la firma, es la UNICA
 *    fuente de verdad sobre el estado real de un pago. Usa data.id
 *    (el id del recurso, tomado de la notificacion ya autenticada) para
 *    pedirle a la API oficial de Mercado Pago el pago completo. El status,
 *    status_detail, transaction_amount, currency_id y external_reference
 *    que use el resto del sistema SIEMPRE salen de esta consulta, nunca
 *    de ningun campo del body de la notificacion entrante.
 *
 * Reglas de seguridad que este modulo garantiza:
 * - Nunca registra en logs el secreto de webhooks, el access token, ni el
 *   payload completo de la notificacion o de la respuesta de Mercado Pago.
 * - La comparacion de firmas usa crypto.timingSafeEqual (nunca ===) para
 *   no filtrar informacion por tiempo de respuesta.
 * - Si falta cualquier ingrediente necesario para validar la firma
 *   (header, data.id, secreto configurado), se considera invalida: esta
 *   funcion nunca "asume" que una notificacion es valida por defecto.
 */

const crypto = require('crypto');
const { withTimeout, DEFAULT_REQUEST_TIMEOUT_MS } = require('./mercadopago-client');

const MERCADOPAGO_PAYMENTS_URL = 'https://api.mercadopago.com/v1/payments';

// Unico topico que este webhook procesa. Mercado Pago manda notificaciones
// de otros topicos (merchant_order, point_integration_wh, etc.) a la misma
// URL; cualquier topico distinto de 'payment' se reconoce (200) pero no se
// procesa (ver api/mercadopago-webhook.js).
const TOPICO_PAGOS = 'payment';

function normalizarTopico(valor) {
  if (typeof valor !== 'string') return null;
  const trimmed = valor.trim().toLowerCase();
  return trimmed || null;
}

function esTopicoDePago(valor) {
  return normalizarTopico(valor) === TOPICO_PAGOS;
}

/**
 * Parsea el header x-signature, con formato "ts=<epoch>,v1=<hmac_hex>"
 * (el orden de ts/v1 no esta garantizado por Mercado Pago, por eso se
 * parsea por clave y no por posicion). Devuelve null si el header falta o
 * no tiene la forma esperada (no revienta con excepcion: un header
 * malformado se trata igual que una firma invalida).
 */
function parsearXSignature(header) {
  if (typeof header !== 'string' || !header.trim()) return null;

  let ts = null;
  let v1 = null;
  header.split(',').forEach((parte) => {
    const idx = parte.indexOf('=');
    if (idx === -1) return;
    const clave = parte.slice(0, idx).trim();
    const valor = parte.slice(idx + 1).trim();
    if (clave === 'ts') ts = valor;
    else if (clave === 'v1') v1 = valor;
  });

  if (!ts || !v1) return null;
  return { ts, v1 };
}

/**
 * Arma el "manifest" (string canonico) que Mercado Pago firma. Segun la
 * documentacion oficial: "id:{data.id};request-id:{x-request-id};ts:{ts};",
 * donde data.id se pasa a minusculas si tiene letras (los ids de pago son
 * numericos, por lo que esto no cambia nada en la practica, pero se aplica
 * siempre por si el formato cambiara).
 */
function construirManifiesto({ dataId, xRequestId, ts }) {
  const dataIdNormalizado = String(dataId).trim().toLowerCase();
  return `id:${dataIdNormalizado};request-id:${xRequestId};ts:${ts};`;
}

/**
 * Compara dos strings hexadecimales en tiempo constante. Devuelve false
 * (nunca lanza) ante cualquier entrada invalida o de longitud distinta.
 */
function compararHexEnTiempoConstante(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  // Longitud de caracteres PAR obligatoria: Buffer.from(str, 'hex') de Node
  // ignora en silencio un ultimo digito hex "suelto" (longitud impar) en
  // vez de fallar, lo que podria hacer que dos strings de distinta
  // longitud terminen decodificando al mismo Buffer. Se rechaza ese caso
  // aca, antes de llegar a Buffer.from.
  if (!/^([0-9a-f]{2})+$/i.test(hexA) || !/^([0-9a-f]{2})+$/i.test(hexB)) return false;
  if (hexA.length !== hexB.length) return false;

  let bufA;
  let bufB;
  try {
    bufA = Buffer.from(hexA, 'hex');
    bufB = Buffer.from(hexB, 'hex');
  } catch (err) {
    return false;
  }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Valida el origen de una notificacion de Mercado Pago.
 *
 * Nunca lanza excepciones: cualquier entrada faltante o malformada hace
 * que devuelva false (rechazo seguro por defecto). El llamador (endpoint)
 * es responsable de responder 401 cuando esto devuelve false.
 */
function validarFirmaWebhook({ xSignatureHeader, xRequestId, dataId, secret } = {}) {
  if (typeof secret !== 'string' || !secret) return false;
  if (typeof xRequestId !== 'string' || !xRequestId.trim()) return false;
  if (dataId === undefined || dataId === null || String(dataId).trim() === '') return false;

  const parsed = parsearXSignature(xSignatureHeader);
  if (!parsed) return false;

  const manifiesto = construirManifiesto({ dataId, xRequestId, ts: parsed.ts });
  const firmaEsperada = crypto.createHmac('sha256', secret).update(manifiesto).digest('hex');

  return compararHexEnTiempoConstante(firmaEsperada, parsed.v1);
}

/**
 * Consulta el pago REAL en la API oficial de Mercado Pago a partir de un
 * payment id ya autenticado (la firma debe validarse ANTES de llamar a
 * esta funcion). Nunca lanza excepciones por errores de red/formato:
 * siempre devuelve { ok, ... } para que el llamador decida como responder.
 *
 * El objeto `payment` devuelto es la UNICA fuente de verdad que el resto
 * del sistema debe usar (status, status_detail, transaction_amount,
 * currency_id, external_reference, id): nunca los campos equivalentes que
 * pueda traer el body de la notificacion entrante.
 */
async function consultarPagoEnMercadoPago({ paymentId, accessToken, timeoutMs } = {}) {
  if (!accessToken || typeof accessToken !== 'string') {
    return { ok: false, motivo: 'sin_credencial' };
  }
  if (
    paymentId === undefined ||
    paymentId === null ||
    (typeof paymentId !== 'string' && typeof paymentId !== 'number') ||
    String(paymentId).trim() === ''
  ) {
    return { ok: false, motivo: 'payment_id_invalido' };
  }

  let mpResponse;
  try {
    mpResponse = await withTimeout(
      fetch(`${MERCADOPAGO_PAYMENTS_URL}/${encodeURIComponent(String(paymentId).trim())}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
      timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
    );
  } catch (err) {
    // No se registran detalles tecnicos ni la respuesta de Mercado Pago.
    return { ok: false, motivo: 'red' };
  }

  if (mpResponse.status === 404) {
    // El pago no existe del lado de Mercado Pago. Es un caso de negocio
    // (la notificacion referencia un id que ya no es valido), no un error
    // tecnico: reintentar no lo va a resolver.
    return { ok: false, motivo: 'no_encontrado', status: 404 };
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

  if (!mpData || typeof mpData !== 'object') {
    return { ok: false, motivo: 'json_invalido' };
  }

  return {
    ok: true,
    payment: {
      id: mpData.id !== undefined && mpData.id !== null ? String(mpData.id) : null,
      externalReference:
        typeof mpData.external_reference === 'string' ? mpData.external_reference : null,
      status: typeof mpData.status === 'string' ? mpData.status : null,
      statusDetail: typeof mpData.status_detail === 'string' ? mpData.status_detail : null,
      transactionAmount:
        typeof mpData.transaction_amount === 'number' && Number.isFinite(mpData.transaction_amount)
          ? mpData.transaction_amount
          : null,
      currencyId: typeof mpData.currency_id === 'string' ? mpData.currency_id : null,
    },
  };
}

module.exports = {
  MERCADOPAGO_PAYMENTS_URL,
  TOPICO_PAGOS,
  normalizarTopico,
  esTopicoDePago,
  parsearXSignature,
  construirManifiesto,
  compararHexEnTiempoConstante,
  validarFirmaWebhook,
  consultarPagoEnMercadoPago,
};
