'use strict';

/**
 * Pruebas de integracion del CTA "Comprar ahora" tal cual vive en el
 * index.html REAL (rama asesor-ia-padel10store): la tarjeta de la grilla
 * de Cross Black '26 y el boton reordenado dentro de la ficha (modal) de
 * producto. A diferencia de tests/mercadopago-buy-widget.test.js (que usa
 * un fragmento HTML sintetico para el drawer), este archivo carga el
 * index.html completo con jsdom (mismo criterio de "DOM real" que
 * tests/padel-checkout-widget.test.js) porque openModal/closeModal y el
 * gating de "Comprar ahora" viven en el <script> inline de index.html, no
 * en un archivo aparte.
 *
 * Se usa runScripts:'outside-only' + window.eval manual, en el MISMO
 * orden en que index.html los carga (el <script> inline de openModal
 * primero -no es deferred-, despues los <script defer> de
 * lib/padel-cart.js, lib/padel-checkout-fields.js, widget/padel-cart.js,
 * widget/padel-checkout.js y widget/mercadopago-buy.js), y despues se
 * dispara un unico evento 'DOMContentLoaded' -igual que hace el navegador-
 * para que ambos handlers (el inline y el de mercadopago-buy.js) se
 * registren y disparen en el mismo orden real, sin reimplementar nada de
 * esa logica a mano.
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

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CART_CORE_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'padel-cart.js'), 'utf8');
const CHECKOUT_FIELDS_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'padel-checkout-fields.js'), 'utf8');
const CART_WIDGET_SRC = fs.readFileSync(path.join(ROOT, 'widget', 'padel-cart.js'), 'utf8');
const CHECKOUT_AVAILABILITY_SRC = fs.readFileSync(path.join(ROOT, 'widget', 'checkout-availability.js'), 'utf8');
const CHECKOUT_WIDGET_SRC = fs.readFileSync(path.join(ROOT, 'widget', 'padel-checkout.js'), 'utf8');
const MERCADOPAGO_BUY_SRC = fs.readFileSync(path.join(ROOT, 'widget', 'mercadopago-buy.js'), 'utf8');

const BUY_NOW_PRODUCT_ID = 'royal-padel-cross-black-26';
const OTRO_PRODUCTO = 'royal-padel-aniversario-36';

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
async function flushAll(times) {
  for (let i = 0; i < (times || 8); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
}

function createHarness(options) {
  const opts = options || {};
  // Por defecto, checkout HABILITADO: es lo que asumen todas las pruebas
  // existentes de este archivo (el interruptor de seguridad tiene su
  // propia seccion dedicada, mas abajo).
  const checkoutEnabled = opts.checkoutEnabled !== false;
  const dom = new JSDOM(INDEX_HTML, { url: 'https://padel10store.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  const document = window.document;

  const fetchCalls = [];
  const apiPedidosResponses = (opts.apiPedidosResponses || []).slice();

  window.fetch = function (url) {
    fetchCalls.push(String(url));
    if (String(url).indexOf('products.json') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(productsJson) });
    }
    if (String(url).indexOf('/api/checkout-config') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: checkoutEnabled }) });
    }
    if (String(url).indexOf('/api/pedidos-preferencia') !== -1) {
      return Promise.reject(new Error('no mockeado en este harness'));
    }
    if (String(url).indexOf('/api/pedidos') !== -1) {
      const next = apiPedidosResponses.length ? apiPedidosResponses.shift() : { ok: true, status: 201, body: { numero: 'P10-000950' } };
      return Promise.resolve({ ok: next.ok, status: next.status, json: () => Promise.resolve(next.body) });
    }
    return Promise.reject(new Error('fetch no mockeado para ' + url));
  };
  // jsdom no implementa canvas 2D (getContext) sin el paquete opcional
  // "canvas". El fondo animado (particulas en <canvas id="hCanvas">) vive
  // en el MISMO <script> inline que openModal (no es un bloque separado),
  // asi que al evaluar ese script tambien corre; se le da un contexto
  // 2D "fake" con no-ops para que no rompa el harness, sin tocar ni una
  // linea del codigo de produccion.
  const canvasEl = document.getElementById('hCanvas');
  const fake2dContext = {
    clearRect: function () {},
    beginPath: function () {},
    arc: function () {},
    fill: function () {},
    moveTo: function () {},
    lineTo: function () {},
    stroke: function () {},
  };
  if (canvasEl) canvasEl.getContext = function () { return fake2dContext; };

  // El <script> inline que define openModal/closeModal/PURCHASABLE_PRODUCT_IDS
  // no tiene src (es inline) y es identificable porque es el unico que
  // define "function openModal". Se extrae tal cual esta en el archivo
  // real, sin reescribir ni una linea.
  const inlineScript = Array.from(document.querySelectorAll('script')).find(
    (s) => !s.src && s.textContent.indexOf('function openModal') !== -1
  );
  if (!inlineScript) throw new Error('no se encontro el <script> inline con openModal en index.html');

  // Mismo orden que index.html: el inline (no deferred) primero, despues
  // los <script defer> en el orden en que aparecen al final del documento.
  window.eval(inlineScript.textContent);
  window.eval(CART_CORE_SRC);
  window.eval(CHECKOUT_FIELDS_SRC);
  window.eval(CART_WIDGET_SRC);
  window.eval(CHECKOUT_AVAILABILITY_SRC);
  window.eval(CHECKOUT_WIDGET_SRC);
  window.eval(MERCADOPAGO_BUY_SRC);

  // Un unico evento 'DOMContentLoaded', igual que el navegador: dispara,
  // en orden de registro, el handler inline (setup de card clicks, qty,
  // buyBtn/closeBtn/overlay/buyNowBtn->closeModal) y despues el de
  // widget/mercadopago-buy.js (scanAndInit). No se llama a mano a ningun
  // "init" interno: es el mismo mecanismo que produccion.
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

  function crossBlackCardEl() {
    return document.querySelector('.card[data-product-id="' + BUY_NOW_PRODUCT_ID + '"]');
  }
  function crossBlackCardBtn() {
    return crossBlackCardEl().querySelector('[data-mp-buy-button]');
  }
  function modalOpen() {
    return document.getElementById('productModal').classList.contains('open');
  }
  function drawerOpen() {
    return document.getElementById('cartDrawer').classList.contains('open');
  }
  function click(el) {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  return {
    dom, window, document,
    fetchCalls,
    crossBlackCardEl, crossBlackCardBtn, click, modalOpen, drawerOpen,
    view: () => window.PadelCheckoutWidgetInternal.getView(),
    mode: () => window.PadelCheckoutWidgetInternal.getMode(),
    modalBuyNowBtn: () => document.getElementById('modalBuyNowBtn'),
    modalCheckoutPausedMsg: () => document.getElementById('modalCheckoutPausedMsg'),
  };
}

async function withCatalogReady(h) {
  await flushAll();
}

function testAsync(name, fn) {
  test(name, fn);
}

// --- CTA visible en la tarjeta del producto piloto ------------------------

testAsync('la tarjeta de Cross Black 26 muestra "Comprar ahora" como CTA principal, listo para usarse', async () => {
  const h = createHarness();
  await withCatalogReady(h);
  const btn = h.crossBlackCardBtn();
  assert.ok(btn, 'debe existir un boton [data-mp-buy-button] en la tarjeta de Cross Black 26');
  assert.strictEqual(btn.textContent.trim(), 'Comprar ahora');
  assert.strictEqual(btn.hasAttribute('hidden'), false, 'el CTA de la tarjeta debe estar visible, no oculto');
  assert.strictEqual(btn.dataset.productId, BUY_NOW_PRODUCT_ID);
});

// --- inicio directo del checkout, sin abrir la ficha ni el carrito -------

testAsync('clickear "Comprar ahora" en la tarjeta inicia el checkout directo, sin abrir la ficha ni el carrito manualmente', async () => {
  const h = createHarness();
  await withCatalogReady(h);
  assert.strictEqual(h.modalOpen(), false);
  assert.strictEqual(h.drawerOpen(), false);
  assert.strictEqual(h.view(), 'carrito');

  h.click(h.crossBlackCardBtn());

  assert.strictEqual(h.modalOpen(), false, 'la ficha nunca debio abrirse');
  assert.strictEqual(h.drawerOpen(), true, 'el drawer debe quedar abierto solo, sin que el usuario lo abra a mano');
  assert.strictEqual(h.view(), 'formulario', 'debe abrir directo "Tus datos"');
  assert.strictEqual(h.mode(), 'buyNow');
});

// --- cierre automatico del modal al comprar desde la ficha ----------------

testAsync('"Comprar ahora" dentro de la ficha cierra el modal automaticamente antes de mostrar "Tus datos"', async () => {
  const h = createHarness();
  await withCatalogReady(h);
  h.window.openModal(h.crossBlackCardEl());
  assert.strictEqual(h.modalOpen(), true, 'la ficha debe estar abierta antes del click (precondicion del test)');
  assert.strictEqual(h.modalBuyNowBtn().hidden, false, 'el boton "Comprar ahora" de la ficha debe estar visible para el producto piloto');

  h.click(h.modalBuyNowBtn());

  assert.strictEqual(h.modalOpen(), false, 'la ficha debe cerrarse automaticamente');
  assert.strictEqual(h.view(), 'formulario');
  assert.strictEqual(h.mode(), 'buyNow');
});

// --- jerarquia de botones dentro de la ficha -------------------------------

testAsync('dentro de la ficha, "Comprar ahora" aparece primero (dorado/principal) y antes que "Agregar al carrito" y "Consultar por WhatsApp"', async () => {
  const h = createHarness();
  await withCatalogReady(h);
  h.window.openModal(h.crossBlackCardEl());

  const buyNowBtn = h.document.getElementById('modalBuyNowBtn');
  const addToCartBtn = h.document.getElementById('modalBuyBtn');
  const wpBtn = h.document.getElementById('modalWpBtn');
  const posicion = (el) => Array.prototype.indexOf.call(el.parentElement.children, el);

  assert.ok(posicion(buyNowBtn) < posicion(addToCartBtn), '"Comprar ahora" debe ir antes que "Agregar al carrito"');
  assert.ok(posicion(addToCartBtn) < posicion(wpBtn), '"Agregar al carrito" debe ir antes que "Consultar por WhatsApp"');

  const estiloBuyNow = h.window.getComputedStyle(buyNowBtn);
  const estiloAddToCart = h.window.getComputedStyle(addToCartBtn);
  assert.strictEqual(estiloBuyNow.backgroundColor, 'rgb(201, 162, 39)', '"Comprar ahora" debe ser el CTA dorado solido (principal)');
  assert.notStrictEqual(estiloAddToCart.backgroundColor, 'rgb(201, 162, 39)', '"Agregar al carrito" ya no debe ser el CTA dorado solido');
});

// --- el carrito persistente nunca se modifica ------------------------------

testAsync('carrito sin modificaciones: "Comprar ahora" desde la tarjeta nunca toca lo que ya habia en el carrito', async () => {
  const h = createHarness();
  await withCatalogReady(h);
  h.window.PadelCart.addItem(OTRO_PRODUCTO, null, 2);
  const antes = h.window.PadelCart.getRawLines();

  h.click(h.crossBlackCardBtn());

  assert.deepStrictEqual(h.window.PadelCart.getRawLines(), antes);
});

testAsync('carrito sin modificaciones: "Comprar ahora" desde la ficha (con cierre automatico) tampoco toca el carrito', async () => {
  const h = createHarness();
  await withCatalogReady(h);
  h.window.PadelCart.addItem(OTRO_PRODUCTO, null, 1);
  const antes = h.window.PadelCart.getRawLines();

  h.window.openModal(h.crossBlackCardEl());
  h.click(h.modalBuyNowBtn());

  assert.deepStrictEqual(h.window.PadelCart.getRawLines(), antes);
});

// --- ninguna llamada a APIs de pedidos antes de que el usuario confirme sus datos ----
//
// /api/checkout-config SI se consulta al arrancar (el interruptor de
// seguridad, ver widget/checkout-availability.js): eso es esperado y no
// es lo que estas pruebas verifican. Lo que nunca debe pasar es que se
// llame a /api/pedidos (ni al endpoint retirado) antes de que el usuario
// confirme sus datos.

testAsync('no se llama a ninguna API de pedidos (ni /api/pedidos ni el endpoint retirado) hasta que el usuario confirme sus datos', async () => {
  const h = createHarness();
  await withCatalogReady(h);
  const llamadasIniciales = h.fetchCalls.length; // products.json + /api/checkout-config, al arrancar

  h.click(h.crossBlackCardBtn()); // abre "Tus datos" directo
  await flushAll();

  const llamadasDePedidos = h.fetchCalls.filter((u) => u.indexOf('/api/') !== -1 && u.indexOf('/api/checkout-config') === -1);
  assert.strictEqual(llamadasDePedidos.length, 0, 'no debe haber ninguna llamada a una API de pedidos con solo abrir "Tus datos"');
  assert.strictEqual(h.fetchCalls.length, llamadasIniciales, 'no debe haber fetches nuevos mas alla del catalogo/checkout-config inicial');
});

testAsync('lo mismo abriendo "Comprar ahora" desde la ficha: sin llamadas a APIs de pedidos hasta confirmar', async () => {
  const h = createHarness();
  await withCatalogReady(h);
  h.window.openModal(h.crossBlackCardEl());

  h.click(h.modalBuyNowBtn());
  await flushAll();

  const llamadasDePedidos = h.fetchCalls.filter((u) => u.indexOf('/api/') !== -1 && u.indexOf('/api/checkout-config') === -1);
  assert.strictEqual(llamadasDePedidos.length, 0);
});

// ===========================================================================
// Interruptor de seguridad del checkout, contra el index.html REAL: con
// /api/checkout-config respondiendo {enabled:false}, "Comprar ahora"
// (tarjeta y ficha) nunca debe iniciar un pedido; el mensaje comercial
// debe verse en la ficha; el catalogo, el carrito y "Consultar por
// WhatsApp" deben seguir funcionando igual.
// ===========================================================================

testAsync('checkout deshabilitado: clickear "Comprar ahora" en la tarjeta nunca abre "Tus datos" ni llama a /api/pedidos', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withCatalogReady(h);

  h.click(h.crossBlackCardBtn());
  await flushAll();

  assert.strictEqual(h.view(), 'carrito', 'nunca debe avanzar al formulario de compra directa');
  assert.strictEqual(h.drawerOpen(), false);
  assert.ok(!h.fetchCalls.some((u) => u.indexOf('/api/pedidos') !== -1));
});

testAsync('checkout deshabilitado: clickear "Comprar ahora" en la tarjeta abre la ficha (con el mensaje y WhatsApp) en vez de comprar', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withCatalogReady(h);

  h.click(h.crossBlackCardBtn());
  await flushAll();

  assert.strictEqual(h.modalOpen(), true, 'debe abrir la ficha del producto en vez de comprar directo');
  assert.strictEqual(h.modalBuyNowBtn().hidden, true, 'el boton "Comprar ahora" de la ficha debe quedar oculto');
  assert.strictEqual(h.modalCheckoutPausedMsg().hidden, false, 'debe mostrar el mensaje comercial');
  assert.ok(/temporalmente pausada/i.test(h.modalCheckoutPausedMsg().textContent));
});

testAsync('checkout deshabilitado: dentro de la ficha, "Consultar por WhatsApp" sigue disponible y visible', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withCatalogReady(h);
  h.window.openModal(h.crossBlackCardEl());

  const wpBtn = h.document.getElementById('modalWpBtn');
  assert.strictEqual(wpBtn.hidden, false);
  assert.strictEqual(typeof wpBtn.onclick, 'function');
});

testAsync('checkout deshabilitado: "Agregar al carrito" sigue funcionando en la ficha de cualquier producto', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withCatalogReady(h);
  h.window.openModal(h.crossBlackCardEl());

  h.click(h.document.getElementById('modalBuyBtn'));

  assert.strictEqual(h.window.PadelCart.getRawLines().length, 1);
  assert.strictEqual(h.window.PadelCart.getRawLines()[0].productId, BUY_NOW_PRODUCT_ID);
});

testAsync('checkout deshabilitado: el catalogo sigue publico y las tarjetas siguen siendo clickeables', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withCatalogReady(h);

  assert.ok(h.document.querySelectorAll('.card').length > 0, 'el catalogo debe seguir renderizado');
  h.window.openModal(h.crossBlackCardEl());
  assert.strictEqual(h.modalOpen(), true, 'las fichas de producto deben seguir pudiendo abrirse');
});

testAsync('checkout habilitado explicitamente (default de esta suite): "Comprar ahora" sigue funcionando igual, la ficha nunca se abre', async () => {
  const h = createHarness({ checkoutEnabled: true });
  await withCatalogReady(h);

  h.click(h.crossBlackCardBtn());

  assert.strictEqual(h.view(), 'formulario');
  assert.strictEqual(h.mode(), 'buyNow');
  assert.strictEqual(h.modalOpen(), false);
});

testAsync('no hay un instante en el que "Comprar ahora" pueda iniciar un pedido antes de que /api/checkout-config resuelva', async () => {
  // Igual que produccion: mientras la consulta esta en curso, el estado
  // por default de PadelCheckoutAvailability es false (fail closed) - un
  // click INMEDIATO, antes de que el fetch mockeado siquiera resuelva su
  // primer microtask, nunca debe alcanzar a iniciar el checkout directo.
  const h = createHarness({ checkoutEnabled: true });
  // Sobreescribe el fetch DESPUES de crear el harness (el harness ya
  // registro window.fetch, pero el primer eval de checkout-availability.js
  // ya disparo la consulta con el fetch original antes de que podamos
  // interceptarla desde aca): en cambio, se verifica directamente que el
  // estado arranca en false antes de cualquier flush.
  assert.strictEqual(h.window.PadelCheckoutAvailability.isEnabled(), false, 'debe arrancar en false, incluso cuando terminara habilitado');

  h.click(h.crossBlackCardBtn());

  // Como el click ocurrio ANTES de que el fetch mockeado (una promesa ya
  // resuelta, pero que igual necesita al menos una vuelta de microtask)
  // tuviera chance de resolver, el boton debe haber tratado esto como
  // deshabilitado: nunca debe haber abierto "Tus datos".
  assert.notStrictEqual(h.view(), 'formulario');
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
  console.log('Pruebas de "Comprar ahora" en index.html (Cross Black 26): ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
