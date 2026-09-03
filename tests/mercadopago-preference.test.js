'use strict';

/**
 * Cubre lib/mercadopago-preference.js (funciones puras, reutilizadas por el
 * flujo real de compra en lib/pedido-preferencia.js) y api/create-payment-preference.js
 * (el endpoint de PRUEBA, hoy DESHABILITADO: ver el comentario al inicio de
 * ese archivo).
 *
 * Estas pruebas se ejecutan con Node (no dependen del navegador) y no
 * realizan ninguna llamada real a Mercado Pago: cuando es necesario, se
 * reemplaza global.fetch por una version de prueba controlada por este
 * archivo.
 */

const assert = require('assert');
const {
  GENERIC_ERROR_MESSAGE,
  PURCHASABLE_PRODUCT_IDS,
  validateRequestBody,
  getPurchasableProduct,
  isValidSandboxInitPoint,
  isValidProductionInitPoint,
  resolverEntornoMercadoPago,
  getTrustedBaseUrl,
  buildBackUrls,
  buildNotificationUrl,
  buildPreferencePayload,
} = require('../lib/mercadopago-preference');
const { getProductById } = require('../lib/padel-catalog');

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
  }
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

async function withEnv(vars, fn) {
  const previous = {};
  Object.keys(vars).forEach((key) => {
    previous[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  });
  try {
    await fn();
  } finally {
    Object.keys(previous).forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
  }
}

function loadHandler() {
  delete require.cache[require.resolve('../api/create-payment-preference')];
  return require('../api/create-payment-preference');
}

const catalogo = require('../products.json').productos;
const PURCHASABLE_ID = PURCHASABLE_PRODUCT_IDS[0];
const purchasableProduct = getProductById(PURCHASABLE_ID);

// ---------------------------------------------------------------------
// lib/mercadopago-preference.js
// ---------------------------------------------------------------------

test('el producto de prueba habilitado existe en el catalogo real', () => {
  assert.ok(purchasableProduct, 'el producto ' + PURCHASABLE_ID + ' debe existir en products.json');
});

test('validateRequestBody rechaza body sin productId', () => {
  assert.strictEqual(validateRequestBody({}).ok, false);
});

test('validateRequestBody rechaza intento de precio manipulado (campo price inesperado)', () => {
  assert.strictEqual(validateRequestBody({ productId: PURCHASABLE_ID, price: 1 }).ok, false);
});

test('validateRequestBody rechaza intento de cantidad manipulada (campo quantity inesperado)', () => {
  assert.strictEqual(validateRequestBody({ productId: PURCHASABLE_ID, quantity: 5 }).ok, false);
});

test('validateRequestBody rechaza intento de nombre manipulado (campo name inesperado)', () => {
  assert.strictEqual(validateRequestBody({ productId: PURCHASABLE_ID, name: 'Otro nombre' }).ok, false);
});

test('validateRequestBody acepta unicamente productId valido', () => {
  const result = validateRequestBody({ productId: PURCHASABLE_ID });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.productId, PURCHASABLE_ID);
});

test('getPurchasableProduct rechaza un productId inexistente', () => {
  const result = getPurchasableProduct('producto-que-no-existe-123');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_found');
});

test('getPurchasableProduct rechaza un producto marcado como "a consultar"', () => {
  const consultarProduct = catalogo.find((p) => p.precioConsultar === true);
  assert.ok(consultarProduct, 'el catalogo debe tener al menos un producto a consultar');
  const result = getPurchasableProduct(consultarProduct.id);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'precio_consultar');
});

test('getPurchasableProduct rechaza un producto sin precio numerico valido', () => {
  const sinPrecio = catalogo.find((p) => p.precioConsultar !== true && typeof p.precio !== 'number');
  if (sinPrecio) {
    const result = getPurchasableProduct(sinPrecio.id);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'invalid_price');
  }
});

test('getPurchasableProduct rechaza un producto valido pero no habilitado para esta prueba', () => {
  const otro = catalogo.find(
    (p) => p.precioConsultar !== true && typeof p.precio === 'number' && p.precio > 0 && p.id !== PURCHASABLE_ID
  );
  assert.ok(otro, 'debe existir otro producto valido distinto del habilitado');
  const result = getPurchasableProduct(otro.id);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_enabled');
});

test('getPurchasableProduct acepta el producto habilitado con el precio exacto del catalogo', () => {
  const result = getPurchasableProduct(PURCHASABLE_ID);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.product.id, PURCHASABLE_ID);
  assert.strictEqual(result.product.precio, purchasableProduct.precio);
});

test('isValidSandboxInitPoint acepta sandbox_init_point https de Mercado Pago', () => {
  assert.strictEqual(isValidSandboxInitPoint('https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=123'), true);
  assert.strictEqual(isValidSandboxInitPoint('https://sandbox.mercadopago.com/checkout/v1/redirect?pref_id=123'), true);
});

test('isValidSandboxInitPoint rechaza el init_point productivo', () => {
  assert.strictEqual(isValidSandboxInitPoint('https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123'), false);
});

test('isValidSandboxInitPoint rechaza http (exige https)', () => {
  assert.strictEqual(isValidSandboxInitPoint('http://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=123'), false);
});

test('isValidSandboxInitPoint rechaza dominios que solo imitan a Mercado Pago', () => {
  assert.strictEqual(isValidSandboxInitPoint('https://sandbox.mercadopago.com.ar.evil.com/x'), false);
});

test('isValidSandboxInitPoint rechaza valores vacios, nulos o invalidos', () => {
  assert.strictEqual(isValidSandboxInitPoint(''), false);
  assert.strictEqual(isValidSandboxInitPoint(null), false);
  assert.strictEqual(isValidSandboxInitPoint(undefined), false);
  assert.strictEqual(isValidSandboxInitPoint(123), false);
});

test('buildPreferencePayload usa cantidad fija 1 y el precio/nombre del catalogo', () => {
  const backUrls = buildBackUrls('https://ejemplo-preview.vercel.app');
  const payload = buildPreferencePayload({ product: purchasableProduct, backUrls });
  assert.strictEqual(payload.items.length, 1);
  assert.strictEqual(payload.items[0].quantity, 1);
  assert.strictEqual(payload.items[0].unit_price, purchasableProduct.precio);
  assert.strictEqual(payload.items[0].title, purchasableProduct.nombre);
  assert.strictEqual(payload.items[0].currency_id, 'ARS');
});

// ---------------------------------------------------------------------
// getTrustedBaseUrl: preferir VERCEL_BRANCH_URL (URL estable de la rama)
// por sobre VERCEL_URL (URL unica por deployment/commit). Fase 3, fix
// post-prueba end-to-end: Mercado Pago no pudo entregar el webhook de
// P10-000006 porque notification_url usaba VERCEL_URL, que no coincide
// con la URL registrada a mano en el dashboard de Webhooks.
// ---------------------------------------------------------------------

function withEnv(vars, fn) {
  const previous = {};
  const keys = Object.keys(vars);
  keys.forEach((key) => {
    previous[key] = process.env[key];
  });
  try {
    keys.forEach((key) => {
      const value = vars[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    fn();
  } finally {
    keys.forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
}

test('getTrustedBaseUrl usa VERCEL_BRANCH_URL cuando esta definida (Preview: URL estable de la rama)', () => {
  withEnv(
    {
      VERCEL_BRANCH_URL: 'padel10-store-git-asesor-ia-bcc3b9-soultransmutacions-projects.vercel.app',
      VERCEL_URL: 'padel10-store-lx9dir1aa-soultransmutacions-projects.vercel.app',
    },
    () => {
      assert.strictEqual(
        getTrustedBaseUrl(),
        'https://padel10-store-git-asesor-ia-bcc3b9-soultransmutacions-projects.vercel.app'
      );
    }
  );
});

test('getTrustedBaseUrl hace fallback a VERCEL_URL cuando VERCEL_BRANCH_URL no esta definida', () => {
  withEnv(
    { VERCEL_BRANCH_URL: undefined, VERCEL_URL: 'mi-preview-123.vercel.app' },
    () => {
      assert.strictEqual(getTrustedBaseUrl(), 'https://mi-preview-123.vercel.app');
    }
  );
});

test('getTrustedBaseUrl hace fallback a VERCEL_URL cuando VERCEL_BRANCH_URL esta vacia o son solo espacios', () => {
  withEnv(
    { VERCEL_BRANCH_URL: '   ', VERCEL_URL: 'mi-preview-123.vercel.app' },
    () => {
      assert.strictEqual(getTrustedBaseUrl(), 'https://mi-preview-123.vercel.app');
    }
  );
});

test('getTrustedBaseUrl devuelve null si ni VERCEL_BRANCH_URL ni VERCEL_URL estan definidas', () => {
  withEnv({ VERCEL_BRANCH_URL: undefined, VERCEL_URL: undefined }, () => {
    assert.strictEqual(getTrustedBaseUrl(), null);
  });
});

test('getTrustedBaseUrl siempre devuelve una URL https valida cuando hay variable disponible', () => {
  withEnv(
    { VERCEL_BRANCH_URL: 'padel10-store-git-asesor-ia-bcc3b9-soultransmutacions-projects.vercel.app' },
    () => {
      const base = getTrustedBaseUrl();
      assert.ok(base.startsWith('https://'), 'la base debe empezar con https://');
      const parsed = new URL(base);
      assert.strictEqual(parsed.protocol, 'https:');
    }
  );
});

test('notification_url construida desde VERCEL_BRANCH_URL es exacta y coincide con la registrada en el dashboard de Mercado Pago', () => {
  withEnv(
    {
      VERCEL_BRANCH_URL: 'padel10-store-git-asesor-ia-bcc3b9-soultransmutacions-projects.vercel.app',
      VERCEL_URL: 'padel10-store-lx9dir1aa-soultransmutacions-projects.vercel.app',
    },
    () => {
      const base = getTrustedBaseUrl();
      const notificationUrl = buildNotificationUrl(base);
      assert.strictEqual(
        notificationUrl,
        'https://padel10-store-git-asesor-ia-bcc3b9-soultransmutacions-projects.vercel.app/api/mercadopago-webhook'
      );
    }
  );
});

test('notification_url es estable entre deployments: no cambia aunque VERCEL_URL (hash por commit) cambie, mientras la rama sea la misma', () => {
  const branchUrl = 'padel10-store-git-asesor-ia-bcc3b9-soultransmutacions-projects.vercel.app';
  let primerDeploy;
  let segundoDeploy;
  withEnv({ VERCEL_BRANCH_URL: branchUrl, VERCEL_URL: 'padel10-store-lx9dir1aa-soultransmutacions-projects.vercel.app' }, () => {
    primerDeploy = buildNotificationUrl(getTrustedBaseUrl());
  });
  withEnv({ VERCEL_BRANCH_URL: branchUrl, VERCEL_URL: 'padel10-store-otrohash99-soultransmutacions-projects.vercel.app' }, () => {
    segundoDeploy = buildNotificationUrl(getTrustedBaseUrl());
  });
  assert.strictEqual(primerDeploy, segundoDeploy);
});

// ---------------------------------------------------------------------
// api/create-payment-preference.js (con req/res simulados, sin red real)
// ---------------------------------------------------------------------

test('PURCHASABLE_PRODUCT_IDS incluye Cross Black 26 y los productos con talles del catalogo', () => {
  const talleIds = catalogo.filter((p) => Array.isArray(p.talles) && p.talles.length > 0).map((p) => p.id);
  assert.ok(talleIds.length > 0, 'debe existir al menos un producto con talles en el catalogo');
  assert.ok(PURCHASABLE_PRODUCT_IDS.includes('royal-padel-cross-black-26'));
  talleIds.forEach((id) => assert.ok(PURCHASABLE_PRODUCT_IDS.includes(id), 'falta ' + id + ' en PURCHASABLE_PRODUCT_IDS'));
});

test('validateRequestBody acepta productId y talle juntos', () => {
  const result = validateRequestBody({ productId: 'x', talle: 'M' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.productId, 'x');
  assert.strictEqual(result.talle, 'M');
});

test('validateRequestBody rechaza talle vacio o no string', () => {
  assert.strictEqual(validateRequestBody({ productId: 'x', talle: '' }).ok, false);
  assert.strictEqual(validateRequestBody({ productId: 'x', talle: '   ' }).ok, false);
  assert.strictEqual(validateRequestBody({ productId: 'x', talle: 5 }).ok, false);
  assert.strictEqual(validateRequestBody({ productId: 'x', talle: null }).ok, false);
});

test('validateRequestBody rechaza combinaciones de campos distintas a productId o productId+talle', () => {
  assert.strictEqual(validateRequestBody({ talle: 'M' }).ok, false);
  assert.strictEqual(validateRequestBody({ productId: 'x', talle: 'M', price: 100 }).ok, false);
  assert.strictEqual(validateRequestBody({ productId: 'x', quantity: 2 }).ok, false);
});

test('getPurchasableProduct exige talle para un producto con talles', () => {
  const conTalles = catalogo.find((p) => Array.isArray(p.talles) && p.talles.length > 0);
  assert.ok(conTalles, 'debe existir un producto con talles en el catalogo');
  const result = getPurchasableProduct(conTalles.id, null);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'talle_required');
});

test('getPurchasableProduct rechaza un talle que no existe para ese producto', () => {
  const conTalles = catalogo.find((p) => Array.isArray(p.talles) && p.talles.length > 0);
  const result = getPurchasableProduct(conTalles.id, 'TALLE-INEXISTENTE-XL9');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'talle_invalid');
});

test('getPurchasableProduct acepta un talle valido del producto', () => {
  const conTalles = catalogo.find((p) => Array.isArray(p.talles) && p.talles.length > 0);
  const talleValido = conTalles.talles[0];
  const result = getPurchasableProduct(conTalles.id, talleValido);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.talle, talleValido);
  assert.strictEqual(result.product.id, conTalles.id);
});

test('getPurchasableProduct rechaza un talle enviado para un producto sin talles', () => {
  const result = getPurchasableProduct(PURCHASABLE_ID, 'M');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'talle_not_applicable');
});

test('getPurchasableProduct sigue aceptando Cross Black 26 sin talle (compatibilidad hacia atras)', () => {
  const result = getPurchasableProduct(PURCHASABLE_ID, null);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.talle, null);
});

test('buildPreferencePayload incluye el talle en el titulo cuando corresponde, y no lo agrega si no hay talle', () => {
  const conTalles = catalogo.find((p) => Array.isArray(p.talles) && p.talles.length > 0);
  const backUrls = { success: 'https://x/s', pending: 'https://x/p', failure: 'https://x/f' };
  const conTalle = buildPreferencePayload({ product: conTalles, backUrls, talle: conTalles.talles[0] });
  assert.ok(conTalle.items[0].title.includes('Talle ' + conTalles.talles[0]));
  const sinTalle = buildPreferencePayload({ product: conTalles, backUrls, talle: null });
  assert.strictEqual(sinTalle.items[0].title, conTalles.nombre);
});

// ===========================================================================
// resolverEntornoMercadoPago: matriz completa VERCEL_ENV x MERCADOPAGO_ENV
// (preparacion tecnica para Production, ver lib/mercadopago-preference.js).
// ===========================================================================

test('resolverEntornoMercadoPago: Preview + sandbox -> permitido, en sandbox', () => {
  withEnv({ VERCEL_ENV: 'preview', MERCADOPAGO_ENV: 'sandbox' }, () => {
    assert.deepStrictEqual(resolverEntornoMercadoPago(), { entorno: 'sandbox', habilitado: true });
  });
});

test('resolverEntornoMercadoPago: Preview + production -> RECHAZADO (nunca se habilita production en Preview)', () => {
  withEnv({ VERCEL_ENV: 'preview', MERCADOPAGO_ENV: 'production' }, () => {
    const resultado = resolverEntornoMercadoPago();
    assert.strictEqual(resultado.entorno, 'production');
    assert.strictEqual(resultado.habilitado, false);
  });
});

test('resolverEntornoMercadoPago: Production (Vercel) + production (Mercado Pago) -> permitido, en production', () => {
  withEnv({ VERCEL_ENV: 'production', MERCADOPAGO_ENV: 'production' }, () => {
    assert.deepStrictEqual(resolverEntornoMercadoPago(), { entorno: 'production', habilitado: true });
  });
});

test('resolverEntornoMercadoPago: Production (Vercel) + sandbox (Mercado Pago) -> definido explicitamente: permitido, en sandbox', () => {
  withEnv({ VERCEL_ENV: 'production', MERCADOPAGO_ENV: 'sandbox' }, () => {
    assert.deepStrictEqual(resolverEntornoMercadoPago(), { entorno: 'sandbox', habilitado: true });
  });
});

test('resolverEntornoMercadoPago: VERCEL_ENV ausente + production -> RECHAZADO (fail closed, no solo Preview)', () => {
  withEnv({ VERCEL_ENV: undefined, MERCADOPAGO_ENV: 'production' }, () => {
    assert.strictEqual(resolverEntornoMercadoPago().habilitado, false);
  });
});

test('resolverEntornoMercadoPago: VERCEL_ENV=development + production -> RECHAZADO', () => {
  withEnv({ VERCEL_ENV: 'development', MERCADOPAGO_ENV: 'production' }, () => {
    assert.strictEqual(resolverEntornoMercadoPago().habilitado, false);
  });
});

test('resolverEntornoMercadoPago: sin MERCADOPAGO_ENV (default sandbox) en cualquier VERCEL_ENV -> permitido, en sandbox', () => {
  withEnv({ VERCEL_ENV: 'production', MERCADOPAGO_ENV: undefined }, () => {
    assert.deepStrictEqual(resolverEntornoMercadoPago(), { entorno: 'sandbox', habilitado: true });
  });
  withEnv({ VERCEL_ENV: undefined, MERCADOPAGO_ENV: undefined }, () => {
    assert.deepStrictEqual(resolverEntornoMercadoPago(), { entorno: 'sandbox', habilitado: true });
  });
});

// ===========================================================================
// isValidProductionInitPoint: mismo criterio que isValidSandboxInitPoint
// (https + hostname EXACTO), pero contra el allow-list de PRODUCCION.
// ===========================================================================

test('isValidProductionInitPoint acepta el init_point oficial de Mercado Pago Argentina', () => {
  assert.strictEqual(
    isValidProductionInitPoint('https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123'),
    true
  );
});

test('isValidProductionInitPoint rechaza el sandbox_init_point: los dos campos nunca se cruzan', () => {
  assert.strictEqual(
    isValidProductionInitPoint('https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=123'),
    false
  );
});

test('isValidSandboxInitPoint rechaza el init_point de produccion: los dos campos nunca se cruzan (inverso)', () => {
  assert.strictEqual(
    isValidSandboxInitPoint('https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123'),
    false
  );
});

test('isValidProductionInitPoint rechaza http (exige https)', () => {
  assert.strictEqual(
    isValidProductionInitPoint('http://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123'),
    false
  );
});

test('isValidProductionInitPoint rechaza subdominios, sufijos y dominios que solo imitan al oficial', () => {
  assert.strictEqual(isValidProductionInitPoint('https://www.mercadopago.com.ar.evil.com/x'), false);
  assert.strictEqual(isValidProductionInitPoint('https://evil.com/www.mercadopago.com.ar'), false);
  assert.strictEqual(isValidProductionInitPoint('https://malicioso-www.mercadopago.com.ar/x'), false);
  assert.strictEqual(isValidProductionInitPoint('https://www.mercadopago.com.ar.co/x'), false);
  assert.strictEqual(isValidProductionInitPoint('https://www.mercadopago.com.ar@evil.com/x'), false);
});

test('isValidProductionInitPoint rechaza otros dominios de Mercado Pago no incluidos explicitamente (sin coincidencia parcial)', () => {
  assert.strictEqual(isValidProductionInitPoint('https://www.mercadopago.com/checkout/v1/redirect?pref_id=123'), false);
  assert.strictEqual(isValidProductionInitPoint('https://mercadopago.com.ar/checkout/v1/redirect?pref_id=123'), false);
});

test('isValidProductionInitPoint rechaza valores vacios, nulos o invalidos', () => {
  assert.strictEqual(isValidProductionInitPoint(''), false);
  assert.strictEqual(isValidProductionInitPoint(null), false);
  assert.strictEqual(isValidProductionInitPoint(undefined), false);
  assert.strictEqual(isValidProductionInitPoint(123), false);
});

// ===========================================================================
// buildBackUrls: query param mp_env (badge "Entorno de prueba" en las
// paginas de retorno, ver mercadopago/success.html / pending.html /
// failure.html).
// ===========================================================================

test('buildBackUrls sin entorno mantiene el comportamiento previo (sin query param)', () => {
  const backUrls = buildBackUrls('https://ejemplo.vercel.app');
  assert.strictEqual(backUrls.success, 'https://ejemplo.vercel.app/mercadopago/success.html');
  assert.strictEqual(backUrls.pending, 'https://ejemplo.vercel.app/mercadopago/pending.html');
  assert.strictEqual(backUrls.failure, 'https://ejemplo.vercel.app/mercadopago/failure.html');
});

test('buildBackUrls con entorno sandbox agrega ?mp_env=sandbox a las 3 URLs', () => {
  const backUrls = buildBackUrls('https://ejemplo.vercel.app', 'sandbox');
  assert.strictEqual(backUrls.success, 'https://ejemplo.vercel.app/mercadopago/success.html?mp_env=sandbox');
  assert.strictEqual(backUrls.pending, 'https://ejemplo.vercel.app/mercadopago/pending.html?mp_env=sandbox');
  assert.strictEqual(backUrls.failure, 'https://ejemplo.vercel.app/mercadopago/failure.html?mp_env=sandbox');
});

test('buildBackUrls con entorno production agrega ?mp_env=production a las 3 URLs', () => {
  const backUrls = buildBackUrls('https://ejemplo.vercel.app', 'production');
  assert.strictEqual(backUrls.success, 'https://ejemplo.vercel.app/mercadopago/success.html?mp_env=production');
  assert.strictEqual(backUrls.pending, 'https://ejemplo.vercel.app/mercadopago/pending.html?mp_env=production');
  assert.strictEqual(backUrls.failure, 'https://ejemplo.vercel.app/mercadopago/failure.html?mp_env=production');
});

test('buildBackUrls ignora un valor de entorno invalido (nunca agrega un query param con basura)', () => {
  const backUrls = buildBackUrls('https://ejemplo.vercel.app', 'otra-cosa');
  assert.strictEqual(backUrls.success, 'https://ejemplo.vercel.app/mercadopago/success.html');
});


// api/create-payment-preference.js quedo DESHABILITADO (ver el comentario
// al inicio de ese archivo): el flujo real de compra pasa por
// POST /api/pedidos + POST /api/pedidos-preferencia, que si crean un
// pedido real con external_reference y notification_url (cubierto en
// tests/api-pedidos.test.js, tests/api-pedidos-preferencia.test.js y
// tests/pedido-preferencia.test.js). Estas pruebas verifican unicamente
// que el endpoint fantasma quedo inerte: nunca ejecuta ninguna logica de
// negocio, sin importar metodo, entorno, credenciales o body.
async function runAsyncTests() {
  await testAsync('esta deshabilitado sin importar VERCEL_ENV (incluido "preview", su unico entorno original)', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const handler = loadHandler();
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 410);
      assert.strictEqual(res.body.error, GENERIC_ERROR_MESSAGE);
    });
  });

  await testAsync('esta deshabilitado tambien fuera de Preview (production)', async () => {
    await withEnv({ VERCEL_ENV: 'production', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const handler = loadHandler();
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 410);
      assert.strictEqual(res.body.error, GENERIC_ERROR_MESSAGE);
    });
  });

  await testAsync('responde igual (410, error generico) sin importar el metodo HTTP', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const handler = loadHandler();
      const req = { method, headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
      const res = createMockRes();
      // eslint-disable-next-line no-await-in-loop
      await handler(req, res);
      assert.strictEqual(res.statusCode, 410, `metodo ${method} deberia responder 410`);
      assert.strictEqual(res.body.error, GENERIC_ERROR_MESSAGE);
    }
  });

  await testAsync('responde igual sin importar el body recibido (incluido un intento de precio manipulado)', async () => {
    const handler = loadHandler();
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { productId: PURCHASABLE_ID, price: 1, quantity: 999 },
    };
    const res = createMockRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 410);
    assert.strictEqual(res.body.error, GENERIC_ERROR_MESSAGE);
  });

  await testAsync('nunca llama a Mercado Pago (no hace ninguna llamada de red)', async () => {
    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      throw new Error('api/create-payment-preference.js no deberia llamar a fetch');
    };
    try {
      const handler = loadHandler();
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(fetchCalled, false, 'no deberia haber llamado a fetch');
      assert.strictEqual(res.statusCode, 410);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await testAsync('nunca requiere ni expone MERCADOPAGO_ACCESS_TOKEN (responde igual si falta)', async () => {
    await withEnv({ MERCADOPAGO_ACCESS_TOKEN: undefined }, async () => {
      const handler = loadHandler();
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 410);
      assert.strictEqual(JSON.stringify(res.body).includes('TOKEN'), false);
    });
  });
}

runAsyncTests().then(() => {
  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
  });
  console.log('');
  console.log((results.length - failed.length) + '/' + results.length + ' pruebas OK');
  process.exit(failed.length > 0 ? 1 : 0);
});
