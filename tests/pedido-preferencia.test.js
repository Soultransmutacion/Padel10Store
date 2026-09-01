'use strict';

/**
 * Pruebas para lib/pedido-preferencia.js (crearOReutilizarPreferenciaParaPedido):
 * la funcion que crea (o reutiliza) la preferencia de Mercado Pago Checkout
 * Pro para un PEDIDO REAL ya creado en Supabase.
 *
 * Estas pruebas NO hacen ninguna llamada de red real a Mercado Pago ni
 * tocan Supabase: mockean lib/mercadopago-client.js
 * (crearPreferenciaEnMercadoPago, obtenerPreferenciaDeMercadoPago) y
 * lib/padel-orders-store.js (asociarPreferenceId, registrarEvento)
 * reemplazando temporalmente sus exports antes de cada require fresco de
 * lib/pedido-preferencia.js, con el mismo patron de require.cache que ya
 * usa tests/mercadopago-preference.test.js.
 *
 * Reglas de negocio cubiertas (ver lib/pedido-preferencia.js):
 * - Nunca cambia estado_pago ni estado_pedido: crear una preferencia no
 *   significa que se cobro nada (esta funcion no toca esas columnas).
 * - Nunca crea una preferencia nueva si el pedido ya tiene mp_preference_id:
 *   relee la existente en Mercado Pago primero (idempotencia).
 * - Nunca devuelve un checkoutUrl de produccion: solo sandbox_init_point,
 *   y solo si MERCADOPAGO_ENV === 'sandbox'.
 * - Los items, precios y moneda salen siempre del snapshot ya persistido
 *   (pedido + items), nunca de un valor inventado por el test.
 */

const assert = require('assert');

const clientPath = require.resolve('../lib/mercadopago-client');
const storePath = require.resolve('../lib/padel-orders-store');
const prefPath = require.resolve('../lib/pedido-preferencia');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}
function testAsync(name, fn) {
  test(name, fn);
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

/**
 * Carga una instancia fresca de crearOReutilizarPreferenciaParaPedido con
 * lib/mercadopago-client.js y/o lib/padel-orders-store.js mockeados.
 *
 * lib/pedido-preferencia.js hace `const { fn } = require('./x')` en el
 * top level del modulo, asi que el mock tiene que estar puesto ANTES del
 * require fresco (borrando require.cache de pedido-preferencia.js para
 * forzar que se vuelva a ejecutar y a desestructurar los mocks). Una vez
 * que termino de requerir, restauramos los modulos originales: la
 * referencia que quedo capturada adentro de pedido-preferencia.js no se ve
 * afectada porque ya es una copia local de la funcion.
 */
function cargarConMocks(mocks) {
  const clientModule = require(clientPath);
  const storeModule = require(storePath);

  const originalClient = Object.assign({}, clientModule);
  const originalStore = Object.assign({}, storeModule);

  if (mocks.crearPreferenciaEnMercadoPago) {
    clientModule.crearPreferenciaEnMercadoPago = mocks.crearPreferenciaEnMercadoPago;
  }
  if (mocks.obtenerPreferenciaDeMercadoPago) {
    clientModule.obtenerPreferenciaDeMercadoPago = mocks.obtenerPreferenciaDeMercadoPago;
  }
  if (mocks.asociarPreferenceId) {
    storeModule.asociarPreferenceId = mocks.asociarPreferenceId;
  }
  if (mocks.registrarEvento) {
    storeModule.registrarEvento = mocks.registrarEvento;
  }

  delete require.cache[prefPath];
  const fresh = require(prefPath);

  Object.assign(clientModule, originalClient);
  Object.assign(storeModule, originalStore);
  delete require.cache[prefPath];

  return fresh.crearOReutilizarPreferenciaParaPedido;
}

function fakeCrearPreferencia(respuesta) {
  const llamadas = [];
  const fn = async (args) => {
    llamadas.push(args);
    return respuesta;
  };
  fn.llamadas = llamadas;
  return fn;
}

function fakeObtenerPreferencia(respuesta) {
  const llamadas = [];
  const fn = async (args) => {
    llamadas.push(args);
    return respuesta;
  };
  fn.llamadas = llamadas;
  return fn;
}

// Simula lib/padel-orders-store.js#asociarPreferenceId: por defecto, "gana
// la carrera" (devuelve el pedido con el mp_preference_id que se le acaba
// de pasar, igual que la implementacion real cuando no hay ninguna otra
// llamada concurrente). Pasando opts.mpPreferenceIdGanador se simula el
// caso en que OTRA llamada ya gano la carrera antes: el fake devuelve el
// pedido con esa preferencia (distinta de la que se le pidio asociar),
// igual que hace la implementacion real via el update condicional
// ".is('mp_preference_id', null)".
function fakeAsociar(opts) {
  const options = opts || {};
  const llamadas = [];
  const fn = async (pedidoId, preferenceId, client) => {
    llamadas.push([pedidoId, preferenceId, client]);
    const mpPreferenceIdFinal =
      options.mpPreferenceIdGanador !== undefined ? options.mpPreferenceIdGanador : preferenceId;
    return { id: pedidoId, mp_preference_id: mpPreferenceIdFinal };
  };
  fn.llamadas = llamadas;
  return fn;
}

function fakeRegistrar() {
  const llamadas = [];
  const fn = async (args, client) => {
    llamadas.push(args);
  };
  fn.llamadas = llamadas;
  return fn;
}

const ENV_SANDBOX_OK = {
  MERCADOPAGO_ACCESS_TOKEN: 'token-de-prueba-no-real',
  MERCADOPAGO_ENV: 'sandbox',
  VERCEL_URL: 'padel10store-test.vercel.app',
};

function pedidoValido(overrides) {
  return Object.assign(
    {
      id: 'pedido-uuid-123',
      numero: 'P10-000900',
      mp_preference_id: null,
    },
    overrides || {}
  );
}

function itemsValidos() {
  return [
    { product_id: 'PAL-001', nombre: 'Pala Test', talle: null, cantidad: 1, precio_unitario: 1000 },
  ];
}

// --- Validaciones previas a cualquier llamada a Mercado Pago -------------

testAsync('pedido invalido (sin id) devuelve pedido_invalido y no llama a Mercado Pago', async () => {
  await withEnv(ENV_SANDBOX_OK, async () => {
    const crearPreferencia = fakeCrearPreferencia({ ok: true, preferenceId: 'x', sandboxInitPoint: 'https://x', initPoint: null });
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({ crearPreferenciaEnMercadoPago: crearPreferencia });
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido: { id: null }, items: itemsValidos() });
    assert.deepStrictEqual(resultado, { ok: false, motivo: 'pedido_invalido' });
    assert.strictEqual(crearPreferencia.llamadas.length, 0);
  });
});

testAsync('pedido null/undefined devuelve pedido_invalido', async () => {
  await withEnv(ENV_SANDBOX_OK, async () => {
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({});
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido: null, items: itemsValidos() });
    assert.deepStrictEqual(resultado, { ok: false, motivo: 'pedido_invalido' });
  });
});

testAsync('sin MERCADOPAGO_ACCESS_TOKEN devuelve sin_credencial', async () => {
  await withEnv(Object.assign({}, ENV_SANDBOX_OK, { MERCADOPAGO_ACCESS_TOKEN: undefined }), async () => {
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({});
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido: pedidoValido(), items: itemsValidos() });
    assert.deepStrictEqual(resultado, { ok: false, motivo: 'sin_credencial' });
  });
});

testAsync('MERCADOPAGO_ENV distinto de sandbox (o ausente) devuelve entorno_no_habilitado', async () => {
  await withEnv(Object.assign({}, ENV_SANDBOX_OK, { MERCADOPAGO_ENV: 'production' }), async () => {
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({});
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido: pedidoValido(), items: itemsValidos() });
    assert.deepStrictEqual(resultado, { ok: false, motivo: 'entorno_no_habilitado' });
  });
});

testAsync('sin VERCEL_URL (sin base confiable) devuelve sin_base_url_confiable', async () => {
  await withEnv(Object.assign({}, ENV_SANDBOX_OK, { VERCEL_URL: undefined }), async () => {
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({});
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido: pedidoValido(), items: itemsValidos() });
    assert.deepStrictEqual(resultado, { ok: false, motivo: 'sin_base_url_confiable' });
  });
});

// --- Camino feliz: preferencia nueva --------------------------------------

testAsync('camino feliz: crea una preferencia nueva y la asocia al pedido', async () => {
  await withEnv(ENV_SANDBOX_OK, async () => {
    const crearPreferencia = fakeCrearPreferencia({
      ok: true,
      preferenceId: 'pref-nueva-1',
      sandboxInitPoint: 'https://sandbox.mercadopago.com.ar/checkout/pref-nueva-1',
      initPoint: 'https://mercadopago.com.ar/checkout/pref-nueva-1',
    });
    const asociar = fakeAsociar();
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({
      crearPreferenciaEnMercadoPago: crearPreferencia,
      asociarPreferenceId: asociar,
    });
    const pedido = pedidoValido();
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido, items: itemsValidos() });

    // El checkoutUrl SIEMPRE sale de sandboxInitPoint, nunca de initPoint
    // (initPoint es el de produccion y esta etapa nunca lo expone).
    assert.deepStrictEqual(resultado, { ok: true, checkoutUrl: 'https://sandbox.mercadopago.com.ar/checkout/pref-nueva-1' });
    assert.strictEqual(crearPreferencia.llamadas.length, 1);
    assert.strictEqual(asociar.llamadas.length, 1);
    assert.strictEqual(asociar.llamadas[0][0], pedido.id);
    assert.strictEqual(asociar.llamadas[0][1], 'pref-nueva-1');
  });
});

testAsync('el payload enviado a Mercado Pago usa external_reference = pedido.id y los items reales, no datos inventados', async () => {
  await withEnv(ENV_SANDBOX_OK, async () => {
    const crearPreferencia = fakeCrearPreferencia({
      ok: true,
      preferenceId: 'pref-2',
      sandboxInitPoint: 'https://sandbox.mercadopago.com.ar/checkout/pref-2',
      initPoint: null,
    });
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({
      crearPreferenciaEnMercadoPago: crearPreferencia,
      asociarPreferenceId: fakeAsociar(),
    });
    const pedido = pedidoValido({ id: 'pedido-real-777' });
    const items = itemsValidos();
    await crearOReutilizarPreferenciaParaPedido({ pedido, items });

    assert.strictEqual(crearPreferencia.llamadas.length, 1);
    const payload = crearPreferencia.llamadas[0].payload;
    assert.strictEqual(payload.external_reference, 'pedido-real-777');
    assert.strictEqual(payload.items.length, 1);
    assert.strictEqual(payload.items[0].id, items[0].product_id);
    assert.strictEqual(payload.items[0].quantity, items[0].cantidad);
    assert.strictEqual(payload.items[0].unit_price, items[0].precio_unitario);
  });
});

// --- Fallas de Mercado Pago al crear ---------------------------------------

testAsync('si Mercado Pago rechaza la creacion, registra el fallo y NO asocia preference_id', async () => {
  await withEnv(ENV_SANDBOX_OK, async () => {
    const crearPreferencia = fakeCrearPreferencia({ ok: false, motivo: 'respuesta_no_ok' });
    const asociar = fakeAsociar();
    const registrar = fakeRegistrar();
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({
      crearPreferenciaEnMercadoPago: crearPreferencia,
      asociarPreferenceId: asociar,
      registrarEvento: registrar,
    });
    const pedido = pedidoValido();
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido, items: itemsValidos() });

    assert.deepStrictEqual(resultado, { ok: false, motivo: 'mercado_pago' });
    assert.strictEqual(asociar.llamadas.length, 0);
    assert.strictEqual(registrar.llamadas.length, 1);
    assert.strictEqual(registrar.llamadas[0].pedidoId, pedido.id);
  });
});

testAsync('si Mercado Pago responde ok pero sin preferenceId, tambien mapea a motivo mercado_pago', async () => {
  await withEnv(ENV_SANDBOX_OK, async () => {
    const crearPreferencia = fakeCrearPreferencia({ ok: true, preferenceId: null, sandboxInitPoint: null, initPoint: null });
    const asociar = fakeAsociar();
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({
      crearPreferenciaEnMercadoPago: crearPreferencia,
      asociarPreferenceId: asociar,
      registrarEvento: fakeRegistrar(),
    });
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido: pedidoValido(), items: itemsValidos() });
    assert.deepStrictEqual(resultado, { ok: false, motivo: 'mercado_pago' });
    assert.strictEqual(asociar.llamadas.length, 0);
  });
});

testAsync('preferencia creada sin sandbox_init_point: asocia el preference_id igual pero responde sin_sandbox_init_point', async () => {
  await withEnv(ENV_SANDBOX_OK, async () => {
    const crearPreferencia = fakeCrearPreferencia({
      ok: true,
      preferenceId: 'pref-3',
      sandboxInitPoint: null,
      initPoint: 'https://mercadopago.com.ar/checkout/pref-3',
    });
    const asociar = fakeAsociar();
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({
      crearPreferenciaEnMercadoPago: crearPreferencia,
      asociarPreferenceId: asociar,
    });
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido: pedidoValido(), items: itemsValidos() });

    assert.deepStrictEqual(resultado, { ok: false, motivo: 'sin_sandbox_init_point' });
    // El pedido ya quedo con la preferencia asociada: el proximo reintento
    // puede releerla en vez de crear una preferencia duplicada.
    assert.strictEqual(asociar.llamadas.length, 1);
  });
});

// --- Idempotencia: pedido que ya tiene mp_preference_id ---------------------

testAsync('idempotencia: si el pedido ya tiene mp_preference_id, relee la existente y no crea otra', async () => {
  await withEnv(ENV_SANDBOX_OK, async () => {
    const obtener = fakeObtenerPreferencia({
      ok: true,
      preferenceId: 'pref-existente',
      sandboxInitPoint: 'https://sandbox.mercadopago.com.ar/checkout/pref-existente',
      initPoint: null,
    });
    const crearPreferencia = fakeCrearPreferencia({
      ok: true,
      preferenceId: 'no-deberia-usarse',
      sandboxInitPoint: 'https://sandbox.mercadopago.com.ar/checkout/no-deberia-usarse',
      initPoint: null,
    });
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({
      obtenerPreferenciaDeMercadoPago: obtener,
      crearPreferenciaEnMercadoPago: crearPreferencia,
    });
    const pedido = pedidoValido({ mp_preference_id: 'pref-existente' });
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido, items: itemsValidos() });

    assert.deepStrictEqual(resultado, { ok: true, checkoutUrl: 'https://sandbox.mercadopago.com.ar/checkout/pref-existente' });
    assert.strictEqual(obtener.llamadas.length, 1);
    assert.strictEqual(crearPreferencia.llamadas.length, 0);
  });
});

testAsync('idempotencia: si la relectura de la preferencia existente falla, crea una preferencia nueva (sin duplicar el pedido)', async () => {
  await withEnv(ENV_SANDBOX_OK, async () => {
    const obtener = fakeObtenerPreferencia({ ok: false, motivo: 'respuesta_no_ok' });
    const crearPreferencia = fakeCrearPreferencia({
      ok: true,
      preferenceId: 'pref-nueva-reintento',
      sandboxInitPoint: 'https://sandbox.mercadopago.com.ar/checkout/pref-nueva-reintento',
      initPoint: null,
    });
    const asociar = fakeAsociar();
    const crearOReutilizarPreferenciaParaPedido = cargarConMocks({
      obtenerPreferenciaDeMercadoPago: obtener,
      crearPreferenciaEnMercadoPago: crearPreferencia,
      asociarPreferenceId: asociar,
    });
    const pedido = pedidoValido({ mp_preference_id: 'pref-vieja-rota' });
    const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido, items: itemsValidos() });

    assert.deepStrictEqual(resultado, { ok: true, checkoutUrl: 'https://sandbox.mercadopago.com.ar/checkout/pref-nueva-reintento' });
    assert.strictEqual(obtener.llamadas.length, 1);
    assert.strictEqual(crearPreferencia.llamadas.length, 1);
    assert.strictEqual(asociar.llamadas.length, 1);
  });
});

// --- Idempotencia de la preferencia ante una carrera concurrente ----------

testAsync(
  'si otra llamada concurrente ya asocio una preferencia distinta (se pierde la carrera), se relee y devuelve la URL de la GANADORA, no la propia',
  async () => {
    await withEnv(ENV_SANDBOX_OK, async () => {
      const crearPreferencia = fakeCrearPreferencia({
        ok: true,
        preferenceId: 'pref-propia-perdedora',
        sandboxInitPoint: 'https://sandbox.mercadopago.com.ar/checkout/pref-propia-perdedora',
        initPoint: null,
      });
      // asociarPreferenceId devuelve el pedido con OTRA preferencia (la que
      // gano la carrera), distinta de la que esta llamada intento asociar.
      const asociar = fakeAsociar({ mpPreferenceIdGanador: 'pref-ganadora' });
      const obtenerGanadora = fakeObtenerPreferencia({
        ok: true,
        preferenceId: 'pref-ganadora',
        sandboxInitPoint: 'https://sandbox.mercadopago.com.ar/checkout/pref-ganadora',
        initPoint: null,
      });
      const crearOReutilizarPreferenciaParaPedido = cargarConMocks({
        crearPreferenciaEnMercadoPago: crearPreferencia,
        asociarPreferenceId: asociar,
        obtenerPreferenciaDeMercadoPago: obtenerGanadora,
      });
      const pedido = pedidoValido();
      const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido, items: itemsValidos() });

      // Se crea la preferencia propia en Mercado Pago (no se puede saber de
      // antemano que se va a perder la carrera), pero la URL devuelta al
      // comprador es la de la preferencia GANADORA, nunca la propia.
      assert.strictEqual(crearPreferencia.llamadas.length, 1);
      assert.strictEqual(asociar.llamadas.length, 1);
      assert.strictEqual(asociar.llamadas[0][1], 'pref-propia-perdedora');
      assert.strictEqual(obtenerGanadora.llamadas.length, 1);
      assert.strictEqual(obtenerGanadora.llamadas[0].preferenceId, 'pref-ganadora');
      assert.deepStrictEqual(resultado, {
        ok: true,
        checkoutUrl: 'https://sandbox.mercadopago.com.ar/checkout/pref-ganadora',
      });
    });
  }
);

testAsync(
  'si se pierde la carrera y ademas releer la preferencia ganadora falla, responde sin_sandbox_init_point (nunca expone la propia)',
  async () => {
    await withEnv(ENV_SANDBOX_OK, async () => {
      const crearPreferencia = fakeCrearPreferencia({
        ok: true,
        preferenceId: 'pref-propia-perdedora-2',
        sandboxInitPoint: 'https://sandbox.mercadopago.com.ar/checkout/pref-propia-perdedora-2',
        initPoint: null,
      });
      const asociar = fakeAsociar({ mpPreferenceIdGanador: 'pref-ganadora-2' });
      const obtenerGanadora = fakeObtenerPreferencia({ ok: false, motivo: 'respuesta_no_ok' });
      const crearOReutilizarPreferenciaParaPedido = cargarConMocks({
        crearPreferenciaEnMercadoPago: crearPreferencia,
        asociarPreferenceId: asociar,
        obtenerPreferenciaDeMercadoPago: obtenerGanadora,
      });
      const resultado = await crearOReutilizarPreferenciaParaPedido({ pedido: pedidoValido(), items: itemsValidos() });

      assert.deepStrictEqual(resultado, { ok: false, motivo: 'sin_sandbox_init_point' });
    });
  }
);

// --- Runner ------------------------------------------------------------

async function run() {
  const resultados = [];
  for (const { name, fn } of results) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      resultados.push({ name, pass: true });
    } catch (error) {
      resultados.push({ name, pass: false, error: error.message });
    }
  }

  const failed = resultados.filter((r) => !r.pass);
  resultados.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
  });
  console.log('');
  console.log('Pruebas de lib/pedido-preferencia.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
