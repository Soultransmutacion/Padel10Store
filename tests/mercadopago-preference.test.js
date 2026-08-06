'use strict';

/**
 * Pruebas para la prueba controlada de Mercado Pago Checkout Pro (SANDBOX).
 * Cubre lib/mercadopago-preference.js y api/create-payment-preference.js.
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
  getTrustedBaseUrl,
  buildBackUrls,
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

test('getTrustedBaseUrl solo lee VERCEL_URL (nunca una URL enviada por el navegador)', () => {
  const previous = process.env.VERCEL_URL;
  try {
    process.env.VERCEL_URL = 'mi-preview-123.vercel.app';
    assert.strictEqual(getTrustedBaseUrl(), 'https://mi-preview-123.vercel.app');
  } finally {
    if (previous === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = previous;
  }
});

test('getTrustedBaseUrl devuelve null si VERCEL_URL no esta definida', () => {
  const previous = process.env.VERCEL_URL;
  try {
    delete process.env.VERCEL_URL;
    assert.strictEqual(getTrustedBaseUrl(), null);
  } finally {
    if (previous !== undefined) process.env.VERCEL_URL = previous;
  }
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


async function runAsyncTests() {
  await testAsync('bloquea el endpoint fuera de Preview (VERCEL_ENV distinto de preview)', async () => {
    await withEnv({ VERCEL_ENV: 'production', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const handler = loadHandler();
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.error, GENERIC_ERROR_MESSAGE);
    });
  });

  await testAsync('rechaza metodos distintos de POST', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const handler = loadHandler();
      const req = { method: 'GET', headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 405);
      assert.strictEqual(res.body.error, GENERIC_ERROR_MESSAGE);
    });
  });

  await testAsync('rechaza Content-Type distinto de application/json', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const handler = loadHandler();
      const req = { method: 'POST', headers: { 'content-type': 'text/plain' }, body: { productId: PURCHASABLE_ID } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 415);
    });
  });

  await testAsync('rechaza un body excesivamente grande', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const handler = loadHandler();
      const req = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { productId: 'x'.repeat(5000) },
      };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 413);
    });
  });

  await testAsync('rechaza campos inesperados en el body (precio manipulado desde el navegador)', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const handler = loadHandler();
      const req = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { productId: PURCHASABLE_ID, price: 1 },
      };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  await testAsync('rechaza un productId inexistente', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const handler = loadHandler();
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: 'no-existe' } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error, GENERIC_ERROR_MESSAGE);
    });
  });

  await testAsync('rechaza un producto marcado como "a consultar"', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const consultarProduct = catalogo.find((p) => p.precioConsultar === true);
      const handler = loadHandler();
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: consultarProduct.id } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  await testAsync('rechaza un producto valido pero todavia no habilitado para compra', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const otro = catalogo.find(
        (p) => p.precioConsultar !== true && typeof p.precio === 'number' && p.precio > 0 && p.id !== PURCHASABLE_ID
      );
      const handler = loadHandler();
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: otro.id } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  await testAsync('devuelve error generico si falta MERCADOPAGO_ACCESS_TOKEN', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: undefined }, async () => {
      const handler = loadHandler();
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
      const res = createMockRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(res.body.error, GENERIC_ERROR_MESSAGE);
    });
  });

  await testAsync('responde con error seguro si falla la conexion con Mercado Pago (sin exponer detalles tecnicos)', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        throw new Error('network down');
      };
      try {
        const handler = loadHandler();
        const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
        const res = createMockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 502);
        assert.strictEqual(res.body.error, GENERIC_ERROR_MESSAGE);
        assert.strictEqual(JSON.stringify(res.body).includes('network down'), false);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  await testAsync('rechaza si Mercado Pago devuelve un init_point productivo en lugar de sandbox', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-token' }, async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1' }),
      });
      try {
        const handler = loadHandler();
        const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
        const res = createMockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 502);
        assert.strictEqual(res.body.error, GENERIC_ERROR_MESSAGE);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  await testAsync('caso exitoso: responde solo con sandboxInitPoint y el monto coincide con el catalogo; el token nunca llega al frontend', async () => {
    await withEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'mi-preview-123.vercel.app', MERCADOPAGO_ACCESS_TOKEN: 'TEST-SECRET-TOKEN' }, async () => {
      const originalFetch = global.fetch;
      let capturedRequest = null;
      global.fetch = async (url, options) => {
        capturedRequest = { url, options };
        return {
          ok: true,
          json: async () => ({
            sandbox_init_point: 'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=abc',
          }),
        };
      };
      try {
        const handler = loadHandler();
        const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: { productId: PURCHASABLE_ID } };
        const res = createMockRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.sandboxInitPoint, 'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=abc');
        assert.strictEqual(JSON.stringify(res.body).includes('TEST-SECRET-TOKEN'), false);
        const sentBody = JSON.parse(capturedRequest.options.body);
        assert.strictEqual(sentBody.items[0].unit_price, purchasableProduct.precio);
        assert.strictEqual(sentBody.items[0].quantity, 1);
        assert.strictEqual(sentBody.back_urls.success, 'https://mi-preview-123.vercel.app/mercadopago/success.html');
        assert.ok(capturedRequest.options.headers.Authorization.includes('TEST-SECRET-TOKEN'));
      } finally {
        global.fetch = originalFetch;
      }
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
