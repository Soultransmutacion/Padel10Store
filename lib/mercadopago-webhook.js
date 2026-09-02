'use strict';

/**
 * Fase 3, Etapa 4: validacion de origen y consulta del pago REAL para el
 * webhook de Mercado Pago (api/mercadopago-webhook.js).
 *
 * Este modulo concentra las responsabilidades de seguridad del webhook,
 * separadas del endpoint HTTP para poder testearlas de forma aislada:
 *
 * 1) validarFirmaWebhook: confirma que una notificacion realmente vino de
 *    Mercado Pago, verificando la firma oficial (header x-signature) segun
 *    el algoritmo documentado por Mercado Pago (HMAC-SHA256 sobre un
 *    "manifest" armado con data.id + x-request-id + ts, usando el secreto
 *    de webhooks como clave). NUNCA se confia en el body de la notificacion
 *    para decidir nada de seguridad ni de negocio: el body puede ser
 *    reenviado o adulterado por cualquiera que conozca la URL publica del
 *    webhook, la firma es lo unico que prueba el origen. Se usa para el
 *    topico moderno y firmado 'payment'. Delega en diagnosticarFirmaWebhook
 *    (mismo calculo exacto, nunca duplicado) y solo expone el booleano.
 *
 * 1.1) diagnosticarFirmaWebhook: mismo calculo que validarFirmaWebhook,
 *    pero devuelve ademas un motivo categorizado (secreto_no_configurado /
 *    header_ausente_o_incompleto / hmac_no_coincide / valida) y presencia
 *    de cada pieza (header, x-request-id, data.id, ts, v1), mas un hash NO
 *    reversible del header para correlacionar en logs. Pensada UNICAMENTE
 *    para logging de rechazos (ver api/mercadopago-webhook.js#logSeguro):
 *    nunca decide nada de seguridad por si sola mas alla de lo que ya
 *    decide validarFirmaWebhook, y nunca incluye el secreto, el manifest
 *    completo ni el valor real de la firma.
 *
 * 2) consultarPagoEnMercadoPago: una vez validada la firma (o, para
 *    'merchant_order', una vez validado el resto de la cadena de
 *    verificacion, ver mas abajo), es la UNICA fuente de verdad sobre el
 *    estado real de un pago. Usa un payment id (el id del recurso) para
 *    pedirle a la API oficial de Mercado Pago el pago completo. El status,
 *    status_detail, transaction_amount, currency_id y external_reference
 *    que use el resto del sistema SIEMPRE salen de esta consulta, nunca
 *    de ningun campo del body de la notificacion entrante.
 *
 * 3) consultarMerchantOrderEnMercadoPago: soporte para el topico legado
 *    'merchant_order' ("MercadoPago Feed v2.0"), que Mercado Pago sigue
 *    enviando en la practica pero que NUNCA trae una firma HMAC valida (no
 *    es un notification-v2 firmado como 'payment'). Exigirle la misma
 *    firma que a 'payment' dejaria estas notificaciones sin procesar para
 *    siempre. En cambio: el id recibido en la notificacion se trata
 *    UNICAMENTE como un puntero (nunca como dato de verdad) para volver a
 *    consultar /merchant_orders/{id} del lado servidor, con el access
 *    token propio. api/mercadopago-webhook.js es quien, a partir de esa
 *    respuesta YA AUTENTICADA (nunca del body de la notificacion), cruza
 *    external_reference, preference_id, monto y moneda contra el pedido
 *    real antes de tocar Supabase, y despues consulta cada payment
 *    asociado con la MISMA consultarPagoEnMercadoPago que ya usa el
 *    topico 'payment' (nunca confia en los campos de pago que trae
 *    embebidos la respuesta de /merchant_orders).
 *
 * Reglas de seguridad que este modulo garantiza:
 * - Nunca registra en logs el secreto de webhooks, el access token, ni el
 *   payload completo de la notificacion o de la respuesta de Mercado Pago.
 * - La comparacion de firmas usa crypto.timingSafeEqual (nunca ===) para
 *   no filtrar informacion por tiempo de respuesta.
 * - Si falta el header x-signature (o no trae ts/v1), o si el secreto no
 *   esta configurado, la firma se considera invalida: esta funcion nunca
 *   "asume" que una notificacion es valida por defecto.
 * - data.id y x-request-id siguen la regla oficial de Mercado Pago: si
 *   alguno de los dos no esta presente en la notificacion, se omite por
 *   completo ese segmento del manifest (nunca se incluye con un valor
 *   vacio) antes de calcular el HMAC. Esta es una decision puramente
 *   CRIPTOGRAFICA (asi lo define Mercado Pago). Que el procesamiento de
 *   negocio pueda seguir sin un data.id utilizable para consultar el pago
 *   real es una decision completamente aparte, tomada rio abajo por
 *   api/mercadopago-webhook.js, nunca por esta funcion.
 */

const crypto = require('crypto');
const { withTimeout, DEFAULT_REQUEST_TIMEOUT_MS } = require('./mercadopago-client');

const MERCADOPAGO_PAYMENTS_URL = 'https://api.mercadopago.com/v1/payments';
const MERCADOPAGO_MERCHANT_ORDERS_URL = 'https://api.mercadopago.com/merchant_orders';

// Topicos que este webhook procesa. Mercado Pago manda notificaciones de
// otros topicos (point_integration_wh, etc.) a la misma URL; cualquier
// topico distinto de estos dos se reconoce (200) pero no se procesa (ver
// api/mercadopago-webhook.js).
const TOPICO_PAGOS = 'payment';
const TOPICO_MERCHANT_ORDER = 'merchant_order';

function normalizarTopico(valor) {
  if (typeof valor !== 'string') return null;
  const trimmed = valor.trim().toLowerCase();
  return trimmed || null;
}

function esTopicoDePago(valor) {
  return normalizarTopico(valor) === TOPICO_PAGOS;
}

function esTopicoDeMerchantOrder(valor) {
  return normalizarTopico(valor) === TOPICO_MERCHANT_ORDER;
}

// Los id de merchant_order de Mercado Pago son siempre numericos. Se valida
// ESTRICTAMENTE el formato (solo digitos, largo acotado) antes de usarlo
// para absolutamente nada: ni siquiera para armar la URL de consulta. Un
// valor que no matchea se trata como invalido, nunca se "sanea" ni se
// intenta interpretar de otra forma.
const MERCHANT_ORDER_ID_REGEX = /^[0-9]{1,20}$/;
function esMerchantOrderIdValido(value) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return MERCHANT_ORDER_ID_REGEX.test(String(value).trim());
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
 * true si un valor "esta presente" segun el criterio de esta notificacion
 * (ni undefined/null, ni string vacio tras trim). Se usa para decidir que
 * segmentos del manifest se incluyen.
 */
function tienePresencia(valor) {
  if (valor === undefined || valor === null) return false;
  return String(valor).trim() !== '';
}

/**
 * Arma el "manifest" (string canonico) que Mercado Pago firma. Segun la
 * documentacion oficial: "id:{data.id};request-id:{x-request-id};ts:{ts};",
 * donde data.id se pasa a minusculas si tiene letras (los ids de pago son
 * numericos, por lo que esto no cambia nada en la practica, pero se aplica
 * siempre por si el formato cambiara).
 *
 * Regla oficial de campos ausentes: "If any of the values (data.id,
 * x-request-id) are not present in the received notification, you must
 * remove them from the manifest before computing the HMAC". Por eso, si
 * dataId o xRequestId no estan presentes, el segmento correspondiente
 * ("id:...;" o "request-id:...;") se omite COMPLETO del manifest, nunca se
 * incluye con un valor vacio. ts, en cambio, siempre esta presente en este
 * punto: proviene de un x-signature ya parseado por parsearXSignature, que
 * exige ts y v1 (sin eso no hay firma que validar en absoluto).
 */
function construirManifiesto({ dataId, xRequestId, ts }) {
  let manifiesto = '';
  if (tienePresencia(dataId)) {
    manifiesto += `id:${String(dataId).trim().toLowerCase()};`;
  }
  if (tienePresencia(xRequestId)) {
    manifiesto += `request-id:${xRequestId};`;
  }
  manifiesto += `ts:${ts};`;
  return manifiesto;
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

// Hash NO reversible del header x-signature completo, truncado a un
// prefijo corto (misma convencion que lib/padel-orders-store.js#
// calcularCorrelacionIdempotencyKey): permite correlacionar en los logs,
// entre reintentos o entre esta notificacion y una investigacion manual
// posterior, SIN loguear la firma real, el secreto ni nada que permita
// reconstruirlos.
function calcularCorrelacionFirma(xSignatureHeader) {
  if (typeof xSignatureHeader !== 'string' || !xSignatureHeader.trim()) return null;
  return crypto.createHash('sha256').update(xSignatureHeader, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Nucleo compartido de validarFirmaWebhook (decision) y
 * diagnosticarFirmaWebhook (motivo categorizado para logging), para que
 * ambas SIEMPRE evaluen exactamente los mismos pasos, en el mismo orden,
 * sin ningun riesgo de que la logica de diagnostico se desincronice de la
 * logica de seguridad real.
 *
 * Nunca lanza excepciones: cualquier entrada faltante o malformada resulta
 * en { valida: false, ... } (rechazo seguro por defecto).
 *
 * Importante: esto valida UNICAMENTE la firma criptografica, segun el
 * algoritmo oficial de Mercado Pago (que permite que data.id y/o
 * x-request-id esten ausentes, omitiendolos del manifest). Que despues el
 * procesamiento de negocio pueda o no continuar sin un data.id utilizable
 * (por ejemplo, para consultar /v1/payments/{id}) es una decision
 * completamente distinta, que le corresponde a api/mercadopago-webhook.js,
 * nunca a esta funcion: una firma valida sobre un manifest sin data.id
 * sigue siendo una firma valida.
 */
function diagnosticarFirmaWebhook({ xSignatureHeader, xRequestId, dataId, secret } = {}) {
  const xSignaturePresente = typeof xSignatureHeader === 'string' && xSignatureHeader.trim() !== '';
  const xRequestIdPresente = tienePresencia(xRequestId);
  const dataIdPresente = tienePresencia(dataId);
  const correlacion = calcularCorrelacionFirma(xSignatureHeader);

  // Sin secreto configurado no hay forma de calcular ni comparar ningun
  // HMAC. Esto no es parte del algoritmo de Mercado Pago: es un requisito
  // operativo propio (fail closed por diseno, ver .env.example).
  if (typeof secret !== 'string' || !secret) {
    return {
      valida: false,
      motivo: 'secreto_no_configurado',
      xSignaturePresente,
      xRequestIdPresente,
      dataIdPresente,
      tsPresente: false,
      v1Presente: false,
      correlacion,
    };
  }

  // ts y v1 son intrinsecos al propio header x-signature: sin ellos no hay
  // firma que validar en absoluto. A diferencia de data.id/x-request-id,
  // la documentacion oficial no contempla que ts o v1 puedan faltar: si
  // faltan, el header esta incompleto/malformado y se rechaza.
  const parsed = parsearXSignature(xSignatureHeader);
  const tsPresente = Boolean(parsed && parsed.ts);
  const v1Presente = Boolean(parsed && parsed.v1);
  if (!parsed) {
    return {
      valida: false,
      motivo: 'header_ausente_o_incompleto',
      xSignaturePresente,
      xRequestIdPresente,
      dataIdPresente,
      tsPresente,
      v1Presente,
      correlacion,
    };
  }

  const manifiesto = construirManifiesto({ dataId, xRequestId, ts: parsed.ts });
  const firmaEsperada = crypto.createHmac('sha256', secret).update(manifiesto).digest('hex');
  const coincide = compararHexEnTiempoConstante(firmaEsperada, parsed.v1);

  return {
    valida: coincide,
    motivo: coincide ? 'valida' : 'hmac_no_coincide',
    xSignaturePresente,
    xRequestIdPresente,
    dataIdPresente,
    tsPresente,
    v1Presente,
    correlacion,
  };
}

/**
 * Valida el origen de una notificacion de Mercado Pago. Nunca lanza
 * excepciones: cualquier entrada faltante o malformada hace que devuelva
 * false (rechazo seguro por defecto). El llamador (endpoint) es
 * responsable de responder 401 cuando esto devuelve false.
 *
 * Delega TODO el calculo en diagnosticarFirmaWebhook (mismos pasos, mismo
 * orden): esta funcion es un envoltorio fino que solo expone el booleano,
 * para no romper el contrato existente de quienes ya la usan.
 */
function validarFirmaWebhook(args) {
  return diagnosticarFirmaWebhook(args).valida;
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

/**
 * Consulta un merchant_order REAL en la API oficial de Mercado Pago a
 * partir de un id que se trata UNICAMENTE como puntero (nunca autenticado
 * por firma: ver el comentario del modulo). Nunca lanza excepciones por
 * errores de red/formato: siempre devuelve { ok, ... }.
 *
 * El objeto `merchantOrder` devuelto SOLO expone: id, externalReference,
 * preferenceId y paymentIds (la lista de ids de los payments asociados,
 * nunca sus datos: cada uno se debe volver a consultar con
 * consultarPagoEnMercadoPago antes de confiar en su status/monto/moneda,
 * exactamente igual que el topico 'payment'). api/mercadopago-webhook.js
 * es responsable de cruzar externalReference/preferenceId contra el
 * pedido real ANTES de usar ningun paymentId.
 */
async function consultarMerchantOrderEnMercadoPago({ merchantOrderId, accessToken, timeoutMs } = {}) {
  if (!accessToken || typeof accessToken !== 'string') {
    return { ok: false, motivo: 'sin_credencial' };
  }
  if (!esMerchantOrderIdValido(merchantOrderId)) {
    return { ok: false, motivo: 'merchant_order_id_invalido' };
  }

  let mpResponse;
  try {
    mpResponse = await withTimeout(
      fetch(`${MERCADOPAGO_MERCHANT_ORDERS_URL}/${encodeURIComponent(String(merchantOrderId).trim())}`, {
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
    // El merchant_order no existe del lado de Mercado Pago: caso de
    // negocio (id inexistente o notificacion espuria), no un error
    // tecnico. Reintentar no lo va a resolver.
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

  // Los payments embebidos en la respuesta de merchant_orders NUNCA se
  // usan como fuente de status/monto/moneda: solo se extrae su id, como
  // puntero, para volver a consultar cada uno por separado via
  // consultarPagoEnMercadoPago (misma regla que el topico 'payment').
  const paymentsRaw = Array.isArray(mpData.payments) ? mpData.payments : [];
  const paymentIds = [];
  const vistos = new Set();
  paymentsRaw.forEach((p) => {
    if (!p || (typeof p.id !== 'string' && typeof p.id !== 'number')) return;
    const id = String(p.id).trim();
    if (!id || vistos.has(id)) return;
    vistos.add(id);
    paymentIds.push(id);
  });

  return {
    ok: true,
    merchantOrder: {
      id: mpData.id !== undefined && mpData.id !== null ? String(mpData.id) : null,
      externalReference:
        typeof mpData.external_reference === 'string' ? mpData.external_reference : null,
      preferenceId: typeof mpData.preference_id === 'string' ? mpData.preference_id : null,
      paymentIds,
    },
  };
}

module.exports = {
  MERCADOPAGO_PAYMENTS_URL,
  MERCADOPAGO_MERCHANT_ORDERS_URL,
  TOPICO_PAGOS,
  TOPICO_MERCHANT_ORDER,
  normalizarTopico,
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
};
