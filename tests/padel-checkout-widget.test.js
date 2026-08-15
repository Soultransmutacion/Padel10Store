'use strict';

/**
 * Pruebas de integracion de widget/padel-checkout.js (Fase 3, Etapa 2:
 * formulario de comprador y datos de envio), con un DOM real via jsdom
 * (igual criterio que tests/padel-comparison-render.test.js: no se puede
 * probar innerHTML/eventos de click sin un DOM real).
 *
 * Se cargan los archivos REALES tal cual se sirven en produccion
 * (lib/padel-cart.js, lib/padel-checkout-fields.js, widget/padel-cart.js,
 * widget/padel-checkout.js) contra un fragmento de HTML con la misma
 * estructura que index.html (drawer del carrito + sus dos footers). El
 * unico punto externo que se reemplaza es window.fetch: una vez para
 * "products.json" (se responde con el catalogo REAL, nunca inventado) y
 * otra para "/api/pedidos" (se controla la respuesta por test, sin red).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const productsJson = require('../products.json');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

const CART_CORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'padel-cart.js'), 'utf8');
const CHECKOUT_FIELDS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'padel-checkout-fields.js'), 'utf8');
const CART_WIDGET_SRC = fs.readFileSync(path.join(__dirname, '..', 'widget', 'padel-cart.js'), 'utf8');
const CHECKOUT_WIDGET_SRC = fs.readFileSync(path.join(__dirname, '..', 'widget', 'padel-checkout.js'), 'utf8');

const PRODUCT_SIN_TALLE = 'royal-padel-aniversario-36';
const PRODUCT_CON_TALLE = 'royal-padel-pollera-mallorca-negra';
const TALLE_VALIDO = 'M';

function drawerHtml() {
  return (
    '<!doctype html><html><body>' +
    '<button class="cart-btn" id="cartBtn">Carrito <span class="cart-badge" id="cartBadge">0</span></button>' +
    '<div class="drw-ov" id="cartDrawerOverlay">' +
    '<div class="drw" id="cartDrawer" role="dialog" aria-modal="true">' +
    '<div class="drw-h"><span class="drw-title" id="cartDrawerTitle">Carrito</span>' +
    '<button class="drw-close" id="cartDrawerClose" aria-label="Cerrar">x</button></div>' +
    '<div class="drw-body" id="cartDrawerBody"><div class="empty" id="cartDrawerEmpty"></div></div>' +
    '<div class="drw-f" id="cartDrawerFooterCart">' +
    '<div class="total-row"><span class="total-lbl">Total</span><span class="total-v" id="cartDrawerTotal">$0</span></div>' +
    '<button class="chk-btn" id="cartDrawerContinueBtn">Continuar con mis datos</button>' +
    '<button class="chk-btn" id="cartDrawerCheckoutBtn">Consultar por WhatsApp</button>' +
    '</div>' +
    '<div class="drw-f" id="cartDrawerFooterCheckout" hidden>' +
    '<button class="chk-btn" id="cartDrawerBackBtn">Volver</button>' +
    '<button class="chk-btn" id="cartDrawerNextBtn">Continuar</button>' +
    '</div>' +
    '</div></div>' +
    '</body></html>'
  );
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
async function flushAll(times) {
  for (let i = 0; i < (times || 8); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
}

// Crea una instancia aislada (documento + scripts nuevos) por test, para que
// el estado interno de cada widget nunca se filtre entre pruebas.
function createHarness(options) {
  const opts = options || {};
  const dom = new JSDOM(drawerHtml(), { url: 'https://padel10store.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  const document = window.document;

  const fetchCalls = [];
  const apiPedidosResponses = (opts.apiPedidosResponses || []).slice();
  const windowOpenCalls = [];
  window.open = function (url) {
    windowOpenCalls.push(url);
  };

  window.fetch = function (url) {
    fetchCalls.push(url);
    if (String(url).indexOf('products.json') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(productsJson) });
    }
    if (String(url).indexOf('/api/pedidos') !== -1) {
      const next = apiPedidosResponses.length ? apiPedidosResponses.shift() : { ok: true, status: 201, body: { numero: 'P10-000001' } };
      return Promise.resolve({
        ok: next.ok,
        status: next.status,
        json: () => Promise.resolve(next.body),
      });
    }
    return Promise.reject(new Error('fetch no mockeado para ' + url));
  };

  window.eval(CART_CORE_SRC);
  window.eval(CHECKOUT_FIELDS_SRC);
  window.eval(CART_WIDGET_SRC);
  window.eval(CHECKOUT_WIDGET_SRC);

  function field(key) {
    return document.querySelector('[data-field="' + key + '"]');
  }

  function setField(key, value) {
    const el = field(key);
    if (!el) throw new Error('no existe el campo ' + key);
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  function click(el) {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  function llenarFormularioValido() {
    setField('nombre', 'Juana');
    setField('apellido', 'Perez');
    setField('email', 'juana@example.com');
    setField('telefono', '3411234567');
    setField('provincia', 'Santa Fe');
    setField('localidad', 'Rosario');
    setField('codigoPostal', '2000');
    setField('calle', 'San Martin');
    setField('numero', '1234');
  }

  return {
    dom, window, document,
    fetchCalls, windowOpenCalls,
    field, setField, click,
    llenarFormularioValido,
    view: () => window.PadelCheckoutWidgetInternal.getView(),
    body: () => document.getElementById('cartDrawerBody').innerHTML,
    backBtn: () => document.getElementById('cartDrawerBackBtn'),
    nextBtn: () => document.getElementById('cartDrawerNextBtn'),
    continueBtn: () => document.getElementById('cartDrawerContinueBtn'),
    checkoutBtn: () => document.getElementById('cartDrawerCheckoutBtn'),
  };
}

async function withReadyCart(h, seedLines) {
  await flushAll();
  (seedLines || []).forEach((line) => h.window.PadelCart.addItem(line.productId, line.talle, line.cantidad));
}

function testAsync(name, fn) {
  test(name, fn);
}

// --- flujo feliz completo: carrito -> formulario -> revision -> confirmacion --

testAsync('flujo completo: agrega productos, completa datos, confirma, y el carrito queda vacio', async () => {
  const h = createHarness({ apiPedidosResponses: [{ ok: true, status: 201, body: { numero: 'P10-000555' } }] });
  await withReadyCart(h, [
    { productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 2 },
    { productId: PRODUCT_CON_TALLE, talle: TALLE_VALIDO, cantidad: 1 },
  ]);

  assert.strictEqual(h.view(), 'carrito');
  h.click(h.continueBtn());
  assert.strictEqual(h.view(), 'formulario');

  h.llenarFormularioValido();
  h.click(h.nextBtn());
  assert.strictEqual(h.view(), 'revision');
  assert.ok(h.body().indexOf('Juana Perez') !== -1);
  assert.ok(h.body().indexOf('Rosario') !== -1);

  h.click(h.nextBtn()); // "Confirmar y crear pedido"
  await flushAll();

  assert.strictEqual(h.view(), 'confirmacion');
  assert.ok(h.body().indexOf('P10-000555') !== -1, 'debe mostrar el numero de pedido');
  assert.ok(/no se realiz.*cobro/i.test(h.body()), 'debe aclarar que no se cobro nada');

  // El carrito se vacio SOLO despues de la confirmacion real del servidor.
  assert.strictEqual(h.window.PadelCart.getSummary().lineas.length, 0);

  const pedidosCall = h.fetchCalls.find((u) => String(u).indexOf('/api/pedidos') !== -1);
  assert.ok(pedidosCall, 'debe haber llamado a /api/pedidos');
});

testAsync('el body enviado a /api/pedidos manda solo productId/talle/cantidad por linea (nunca precio ni nombre)', async () => {
  let bodyEnviado = null;
  const h = createHarness();
  h.window.fetch = function (url, init) {
    if (String(url).indexOf('products.json') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(productsJson) });
    }
    if (String(url).indexOf('/api/pedidos') !== -1) {
      bodyEnviado = JSON.parse(init.body);
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ numero: 'P10-000002' }) });
    }
    return Promise.reject(new Error('no mockeado'));
  };
  h.window.eval(CART_CORE_SRC);
  h.window.eval(CHECKOUT_FIELDS_SRC);
  h.window.eval(CART_WIDGET_SRC);
  h.window.eval(CHECKOUT_WIDGET_SRC);
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  h.click(h.continueBtn());
  h.llenarFormularioValido();
  h.click(h.nextBtn());
  h.click(h.nextBtn());
  await flushAll();

  assert.ok(bodyEnviado, 'debe haberse enviado un body a /api/pedidos');
  assert.deepStrictEqual(Object.keys(bodyEnviado).sort(), ['comprador', 'contacto', 'direccionEnvio', 'items']);
  assert.strictEqual(bodyEnviado.items.length, 1);
  assert.deepStrictEqual(Object.keys(bodyEnviado.items[0]).sort(), ['cantidad', 'productId', 'talle']);
  assert.strictEqual('precio' in bodyEnviado.items[0], false);
  assert.strictEqual('nombre' in bodyEnviado.items[0], false);
  assert.strictEqual('pais' in bodyEnviado.direccionEnvio, false);
});

// --- fallo del servidor: el carrito NO se vacia -----------------------

testAsync('si /api/pedidos responde con error, el carrito NO se vacia y se muestra un error', async () => {
  const h = createHarness({ apiPedidosResponses: [{ ok: false, status: 500, body: { error: 'algo salio mal' } }] });
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  h.click(h.continueBtn());
  h.llenarFormularioValido();
  h.click(h.nextBtn());
  h.click(h.nextBtn());
  await flushAll();

  // Se queda en la vista de revision (no avanza a confirmacion) y el
  // carrito conserva la linea que ya tenia.
  assert.strictEqual(h.view(), 'revision');
  assert.strictEqual(h.window.PadelCart.getRawLines().length, 1);
  assert.ok(h.body().indexOf(PRODUCT_SIN_TALLE) === -1); // no se filtra ningun detalle tecnico
});

testAsync('si fetch falla por red, el carrito tampoco se vacia', async () => {
  const h = createHarness();
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);
  h.window.fetch = function (url) {
    if (String(url).indexOf('products.json') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(productsJson) });
    }
    return Promise.reject(new Error('network error'));
  };

  h.click(h.continueBtn());
  h.llenarFormularioValido();
  h.click(h.nextBtn());
  h.click(h.nextBtn());
  await flushAll();

  assert.strictEqual(h.view(), 'revision');
  assert.strictEqual(h.window.PadelCart.getRawLines().length, 1);
});

// --- validacion bloquea el avance sin llegar a red ----------------------

testAsync('campos vacios bloquean el avance de formulario a revision (sin llamar a /api/pedidos)', async () => {
  const h = createHarness();
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  h.click(h.continueBtn());
  assert.strictEqual(h.view(), 'formulario');
  // No se completa nada: el email queda vacio.
  h.click(h.nextBtn());

  assert.strictEqual(h.view(), 'formulario');
  assert.ok(!h.fetchCalls.some((u) => String(u).indexOf('/api/pedidos') !== -1));
});

testAsync('email invalido bloquea el avance y muestra el error junto al campo', async () => {
  const h = createHarness();
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);
  h.click(h.continueBtn());
  h.llenarFormularioValido();
  h.setField('email', 'no-es-un-email');
  h.click(h.nextBtn());
  assert.strictEqual(h.view(), 'formulario');
  assert.ok(/email/i.test(h.body()));
});

// --- boton "Continuar con mis datos" deshabilitado con carrito vacio -----

testAsync('"Continuar con mis datos" esta deshabilitado si el carrito esta vacio', async () => {
  const h = createHarness();
  await withReadyCart(h, []);
  assert.strictEqual(h.continueBtn().disabled, true);
});

testAsync('"Continuar con mis datos" se habilita al agregar un producto', async () => {
  const h = createHarness();
  await withReadyCart(h, []);
  assert.strictEqual(h.continueBtn().disabled, true);
  h.window.PadelCart.addItem(PRODUCT_SIN_TALLE, null, 1);
  assert.strictEqual(h.continueBtn().disabled, false);
});

// --- "Consultar por WhatsApp" sigue funcionando igual que antes ---------

testAsync('"Consultar por WhatsApp" sigue abriendo wa.me con el resumen (no se rompio)', async () => {
  const h = createHarness();
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);
  h.click(h.checkoutBtn());
  assert.strictEqual(h.windowOpenCalls.length, 1);
  assert.ok(h.windowOpenCalls[0].indexOf('wa.me') !== -1);
});

// --- volver atras conserva/descarta segun corresponde ---------------------

testAsync('"Volver al carrito" desde el formulario vuelve a mostrar el carrito', async () => {
  const h = createHarness();
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);
  h.click(h.continueBtn());
  assert.strictEqual(h.view(), 'formulario');
  h.click(h.backBtn());
  assert.strictEqual(h.view(), 'carrito');
  // El producto sigue en el carrito: volver atras no lo vacia.
  assert.strictEqual(h.window.PadelCart.getRawLines().length, 1);
});

testAsync('"Volver a editar mis datos" desde revision vuelve al formulario con los datos conservados', async () => {
  const h = createHarness();
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);
  h.click(h.continueBtn());
  h.llenarFormularioValido();
  h.click(h.nextBtn());
  assert.strictEqual(h.view(), 'revision');
  h.click(h.backBtn());
  assert.strictEqual(h.view(), 'formulario');
  assert.strictEqual(h.field('nombre').value, 'Juana');
});

// --- Runner --------------------------------------------------------------

async function run() {
  const resultados = [];
  for (const { name, fn } of results) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      resultados.push({ name, pass: true });
    } catch (error) {
      resultados.push({ name, pass: false, error: (error && error.stack) || error });
    }
  }

  const failed = resultados.filter((r) => !r.pass);
  resultados.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
  });
  console.log('');
  console.log('Pruebas de widget/padel-checkout.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
