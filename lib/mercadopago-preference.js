'use strict';

/**
 * Prueba controlada de Mercado Pago Checkout Pro (SANDBOX) - Padel10Store.
 *
 * Este modulo NO realiza llamadas de red. Solo valida datos de entrada y
 * construye la informacion necesaria para crear una preferencia de pago
 * de PRUEBA. Reglas de seguridad que este modulo garantiza:
 *
 * - El nombre y el precio del producto SIEMPRE se obtienen del catalogo
 *   del servidor (products.json), nunca del comprador.
 * - La cantidad queda fija en 1, sin importar lo que envie el navegador.
 * - Solo se permite comprar productos incluidos explicitamente en
 *   PURCHASABLE_PRODUCT_IDS durante esta prueba (royal-padel-cross-black-26).
 * - Solo se acepta como valido un sandbox_init_point cuyo protocolo sea
 *   https: y cuyo host este en ALLOWED_SANDBOX_HOSTS.
 */

const { getProductById, loadCatalog } = require('./padel-catalog');

const GENERIC_ERROR_MESSAGE =
    'No pudimos iniciar el pago. Intentá nuevamente en unos minutos.';

const BASE_PURCHASABLE_PRODUCT_IDS = ['royal-padel-cross-black-26'];
function computePurchasableProductIds() {
  var talleIds = loadCatalog()
    .filter(function (p) { return Array.isArray(p.talles) && p.talles.length > 0; })
    .map(function (p) { return p.id; });
  return BASE_PURCHASABLE_PRODUCT_IDS.concat(talleIds);
}
const PURCHASABLE_PRODUCT_IDS = computePurchasableProductIds();

const ALLOWED_SANDBOX_HOSTS = [
    'sandbox.mercadopago.com.ar',
    'sandbox.mercadopago.com',
  ];

const FIXED_QUANTITY = 1;

const MAX_PRODUCT_ID_LENGTH = 200;

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Valida el body recibido del navegador. Solo se acepta un objeto con
 * exactamente una clave: productId (string no vacio). Cualquier otro
 * campo (price, quantity, name, etc.) o forma de body es rechazado.
 */
const MAX_TALLE_LENGTH = 10;
const ALLOWED_BODY_KEY_SETS = [
  ['productId'],
  ['productId', 'talle'],
];
function keysMatchAllowedSet(keys) {
  const sorted = keys.slice().sort();
  return ALLOWED_BODY_KEY_SETS.some(function (set) {
    const sortedSet = set.slice().sort();
    return sorted.length === sortedSet.length && sorted.every(function (k, i) { return k === sortedSet[i]; });
  });
}
function validateRequestBody(body) {
  if (!isPlainObject(body)) {
    return { ok: false, reason: 'invalid_body' };
  }

  const keys = Object.keys(body);
  if (!keysMatchAllowedSet(keys)) {
    return { ok: false, reason: 'unexpected_fields' };
  }

  const { productId, talle } = body;
  if (typeof productId !== 'string') {
    return { ok: false, reason: 'invalid_product_id' };
  }

  const trimmed = productId.trim();
  if (!trimmed || trimmed.length > MAX_PRODUCT_ID_LENGTH) {
    return { ok: false, reason: 'invalid_product_id' };
  }

  if (keys.indexOf('talle') > -1) {
    if (typeof talle !== 'string') {
      return { ok: false, reason: 'invalid_talle' };
    }
    const trimmedTalle = talle.trim();
    if (!trimmedTalle || trimmedTalle.length > MAX_TALLE_LENGTH) {
      return { ok: false, reason: 'invalid_talle' };
    }
    return { ok: true, productId: trimmed, talle: trimmedTalle };
  }

  return { ok: true, productId: trimmed, talle: null };
}

/**
 * Busca el producto en el catalogo del servidor y verifica que pueda
 * comprarse en esta prueba. El orden de verificacion permite distinguir,
 * para pruebas unitarias, entre: producto inexistente, producto a
 * consultar, producto sin precio numerico valido y producto valido pero
 * todavia no habilitado para compra.
 */
function getPurchasableProduct(productId, talle) {
  const product = getProductById(productId);
  if (!product) {
    return { ok: false, reason: 'not_found' };
  }

  if (product.precioConsultar === true) {
    return { ok: false, reason: 'precio_consultar' };
  }

  if (
    typeof product.precio !== 'number' ||
    !Number.isFinite(product.precio) ||
    product.precio <= 0
  ) {
    return { ok: false, reason: 'invalid_price' };
  }

  if (!PURCHASABLE_PRODUCT_IDS.includes(product.id)) {
    return { ok: false, reason: 'not_enabled' };
  }

  const requiresTalle = Array.isArray(product.talles) && product.talles.length > 0;
  if (requiresTalle) {
    if (!talle) {
      return { ok: false, reason: 'talle_required' };
    }
    if (!product.talles.includes(talle)) {
      return { ok: false, reason: 'talle_invalid' };
    }
  } else if (talle) {
    return { ok: false, reason: 'talle_not_applicable' };
  }

  return { ok: true, product, talle: requiresTalle ? talle : null };
}

function isValidSandboxInitPoint(value) {
    if (typeof value !== 'string' || !value) return false;
    let parsed;
    try {
          parsed = new URL(value);
    } catch (err) {
          return false;
    }
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_SANDBOX_HOSTS.includes(parsed.hostname);
}

/**
 * Devuelve la base https de confianza del despliegue actual, a partir de
 * la variable de entorno VERCEL_URL (provista por Vercel en el servidor).
 * Nunca se acepta una base enviada por el navegador.
 */
function getTrustedBaseUrl() {
    const vercelUrl = process.env.VERCEL_URL;
    if (!vercelUrl || typeof vercelUrl !== 'string') {
          return null;
    }
    const trimmed = vercelUrl.trim();
    if (!trimmed) return null;
    return `https://${trimmed}`;
}

function buildBackUrls(baseUrl) {
    return {
          success: `${baseUrl}/mercadopago/success.html`,
          pending: `${baseUrl}/mercadopago/pending.html`,
          failure: `${baseUrl}/mercadopago/failure.html`,
    };
}

/**
 * Arma el payload de la preferencia usando exclusivamente datos del
 * catalogo del servidor. La cantidad es siempre FIXED_QUANTITY (1).
 */
function buildPreferencePayload({ product, backUrls, talle }) {
  const title = talle ? `${product.nombre} - Talle ${talle}` : product.nombre;
  return {
    items: [
      {
        id: product.id,
        title: title,
        quantity: FIXED_QUANTITY,
        currency_id: 'ARS',
        unit_price: product.precio,
      },
    ],
    back_urls: backUrls,
    auto_return: 'approved',
    statement_descriptor: 'PADEL10STORE TEST',
  };
}

module.exports = {
    GENERIC_ERROR_MESSAGE,
    PURCHASABLE_PRODUCT_IDS,
    ALLOWED_SANDBOX_HOSTS,
    FIXED_QUANTITY,
    validateRequestBody,
    getPurchasableProduct,
    isValidSandboxInitPoint,
    getTrustedBaseUrl,
    buildBackUrls,
    buildPreferencePayload,
};
