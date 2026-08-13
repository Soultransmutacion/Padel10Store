'use strict';

// Fase 2 - Etapa 3: comparador visual PRO (frontend).
//
// tests/padel-comparison-card.test.js (Etapa 2) ya prueba que el backend
// arma "comparison" con datos reales del catalogo, sin inventar nada. Este
// archivo prueba la parte NUEVA de esta etapa: que widget/padel-advisor.js
// PINTE esa estructura como un componente visual real (renderComparison),
// que "Ver producto" y "Agregar al carrito" reutilicen exactamente las
// mismas integraciones que ya usa renderCard (findStoreCard + window.openModal,
// window.PadelCart), y que las referencias conversacionales posteriores a una
// comparacion ("la primera"/"la segunda") sigan resolviendo correctamente
// porque el cliente reenvia "ofrecidos" tal cual el servidor lo devuelve.
//
// Se usa jsdom para tener un DOM real (no se puede probar innerHTML/eventos
// de click sin uno). Los datos de comparacion se generan SIEMPRE contra el
// catalogo real via tools.executeTool('comparar_productos', ...) (la misma
// funcion que ya prueba Etapa 2): este archivo nunca inventa productos,
// precios ni atributos. Las unicas 2 integraciones externas del widget
// (window.openModal de la tienda y window.PadelCart del carrito) se
// reemplazan por dobles de prueba controlables, porque su comportamiento
// interno YA esta probado en profundidad en otros archivos (index.html en
// vivo para openModal, lib/padel-cart.js + tests/padel-cart.test.js para
// PadelCart) - aca solo se prueba que el widget las llame correctamente.
//
// La confirmacion visual real (pixeles, responsive de verdad) se hace por
// separado con un navegador real (ver scripts/verify-comparator-browser.js e
// informe final de esta etapa): jsdom no tiene motor de layout/CSS, por lo
// que las pruebas 16/17 de este archivo son estructurales (el componente se
// arma igual sin importar el ancho de ventana, ya que no depende de JS para
// su layout responsive, solo de CSS) mas una verificacion de que el CSS
// dedicado (widget/padel-comparison.css) define el breakpoint esperado.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const catalog = require('../lib/padel-catalog');
const tools = require('../lib/padel-advisor-tools');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS - ' + name);
  } catch (err) {
    failed += 1;
    console.log('FAIL - ' + name);
    console.log('  ' + (err && err.message ? err.message : err));
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('PASS - ' + name);
  } catch (err) {
    failed += 1;
    console.log('FAIL - ' + name);
    console.log('  ' + (err && err.message ? err.message : err));
  }
}

const WIDGET_JS_PATH = path.join(__dirname, '..', 'widget', 'padel-advisor.js');
const WIDGET_CSS_PATH = path.join(__dirname, '..', 'widget', 'padel-comparison.css');
const WIDGET_SRC = fs.readFileSync(WIDGET_JS_PATH, 'utf8');
const WIDGET_CSS = fs.readFileSync(WIDGET_CSS_PATH, 'utf8');

// --- Fixtures reales del catalogo (mismo par que ya usa Etapa 2 para forma/
// materialCaras/materialMarco/nucleo/espesor confirmados/no confirmados) ---

const BARATA_ID = 'royal-padel-cross-black-26'; // sin talles, $206.000
const CARA_ID = 'royal-padel-aniversario-36'; // sin talles, $256.500, con materialMarco/espesor confirmados
const POLLERA_ID = 'royal-padel-pollera-mallorca-negra'; // CON talles S/M/L/XL

const barataProduct = catalog.getProductById(BARATA_ID);
const caraProduct = catalog.getProductById(CARA_ID);
const polleraProduct = catalog.getProductById(POLLERA_ID);

assert.ok(barataProduct && caraProduct && polleraProduct, 'los productos de fixture deben existir de verdad en el catalogo');
assert.ok(!Array.isArray(barataProduct.talles) || !barataProduct.talles.length, 'fixture invalido: BARATA_ID no deberia requerir talle');
assert.ok(Array.isArray(polleraProduct.talles) && polleraProduct.talles.length > 0, 'fixture invalido: POLLERA_ID debe requerir talle');

const COMPARISON_2 = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] }).comparison;
const COMPARISON_TALLE = tools.executeTool('comparar_productos', { ids: [BARATA_ID, POLLERA_ID] }).comparison;

assert.ok(COMPARISON_2 && COMPARISON_2.productos.length === 2, 'fixture COMPARISON_2 invalido');
assert.ok(COMPARISON_TALLE && COMPARISON_TALLE.productos.length === 2, 'fixture COMPARISON_TALLE invalido');

function flush() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

async function flushAll() {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
}

// Arma un DOM con la raiz del asistente (#padel-advisor-root) y, si se
// piden, tarjetas falsas de "la tienda" (.card/.card-name) con el nombre
// REAL del producto: es lo unico que findStoreCard necesita para encontrar
// la ficha real (misma logica que ya usa renderCard, no se duplica).
function buildStoreHtml(storeProducts) {
  const cardsHtml = (storeProducts || [])
    .map(function (p) {
      return '<div class="card" data-testid="store-card-' + p.id + '"><span class="card-name">' + p.nombre + '</span></div>';
    })
    .join('');
  return '<!doctype html><html><body>' + cardsHtml + '<div id="padel-advisor-root"></div></body></html>';
}

// Crea una instancia aislada del widget (cada test parte de cero: shownProductIds/
// lastOfrecidos/history son estado interno del modulo, por eso cada harness es un
// documento y una carga de script nuevos). window.openModal y window.PadelCart son
// los 2 puntos de integracion externos que el widget NUNCA debe reimplementar: se
// reemplazan por dobles controlables; window.fetch se reemplaza para dirigir
// exactamente que responde el servidor en cada llamada, sin red real.
function createHarness(options) {
  const opts = options || {};
  const dom = new JSDOM(buildStoreHtml(opts.storeProducts), {
    url: 'https://padel10store.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const document = window.document;

  const openModalCalls = [];
  window.openModal = function (storeCard) {
    openModalCalls.push(storeCard);
  };

  const cartAddItemCalls = [];
  const cartAddItemImpl = opts.cartAddItem || function () {
    return { ok: true, line: {} };
  };
  window.PadelCart = {
    addItem: function (productId, talle, cantidad) {
      const res = cartAddItemImpl(productId, talle, cantidad);
      cartAddItemCalls.push({ productId: productId, talle: talle, cantidad: cantidad, result: res });
      return res;
    },
    removeItem: function () {},
    setQuantity: function () {},
    getRawLines: function () {
      return opts.rawLines || [];
    },
  };

  const fetchCalls = [];
  const responses = (opts.responses || []).slice();
  const defaultResponse = { reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: null };
  window.fetch = function (url, init) {
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(init.body);
    } catch (err) {
      parsedBody = null;
    }
    fetchCalls.push({ url: url, body: parsedBody });
    const next = responses.length ? responses.shift() : defaultResponse;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve(next);
      },
    });
  };

  window.eval(WIDGET_SRC);

  const formEl = document.getElementById('paForm');
  const inputEl = document.getElementById('paInput');
  const messagesEl = document.getElementById('paMessages');

  function submitMessage(text) {
    inputEl.value = text;
    formEl.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  }

  function click(el) {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  return {
    dom: dom,
    window: window,
    document: document,
    messagesEl: messagesEl,
    submitMessage: submitMessage,
    click: click,
    fetchCalls: fetchCalls,
    openModalCalls: openModalCalls,
    cartAddItemCalls: cartAddItemCalls,
  };
}

function cmpAddButton(document, productId) {
  return document.querySelector('.pa-cmp-actions button[data-cmp-action="agregar"][data-product-id="' + productId + '"]');
}

function cmpVerButton(document, productId) {
  return document.querySelector('.pa-cmp-actions button[data-cmp-action="ver"][data-product-id="' + productId + '"]');
}

(async function run() {
  // --- 1) una comparacion valida renderiza el componente ---

  await asyncTest('una comparacion valida renderiza el comparador (.pa-cmp)', async function () {
    const h = createHarness({ responses: [{ reply: 'Te dejo la comparacion.', cards: [], ofrecidos: [BARATA_ID, CARA_ID], acciones: [], comparison: COMPARISON_2 }] });
    h.submitMessage('Compara estas dos palas');
    await flushAll();
    assert.strictEqual(h.document.querySelectorAll('.pa-cmp').length, 1);
  });

  // --- 2) muestra ambos productos ---

  await asyncTest('el comparador muestra los 2 productos comparados', async function () {
    const h = createHarness({ responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }] });
    h.submitMessage('compara');
    await flushAll();
    const productos = h.document.querySelectorAll('.pa-cmp-product');
    assert.strictEqual(productos.length, 2);
    const ids = Array.prototype.map.call(productos, function (el) { return el.getAttribute('data-product-id'); }).sort();
    assert.deepStrictEqual(ids, [BARATA_ID, CARA_ID].sort());
  });

  // --- 3) imagenes correctas ---

  await asyncTest('el comparador usa las imagenes reales de cada producto', async function () {
    const h = createHarness({ responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }] });
    h.submitMessage('compara');
    await flushAll();
    COMPARISON_2.productos.forEach(function (p) {
      const img = h.document.querySelector('.pa-cmp-product[data-product-id="' + p.id + '"] .pa-cmp-photo');
      assert.ok(img, 'debe haber imagen para ' + p.id);
      const expected = new h.window.URL(p.imagen, 'https://padel10store.test/').href;
      assert.strictEqual(img.getAttribute('src'), expected);
    });
  });

  // --- 4) nombres correctos ---

  await asyncTest('el comparador usa el nombre real de cada producto', async function () {
    const h = createHarness({ responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }] });
    h.submitMessage('compara');
    await flushAll();
    COMPARISON_2.productos.forEach(function (p) {
      const nameEl = h.document.querySelector('.pa-cmp-product[data-product-id="' + p.id + '"] .pa-cmp-name');
      assert.strictEqual(nameEl.textContent, p.nombre);
    });
  });

  // --- 5) precios correctos ---

  await asyncTest('el comparador usa el precio formateado real de cada producto', async function () {
    const h = createHarness({ responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }] });
    h.submitMessage('compara');
    await flushAll();
    COMPARISON_2.productos.forEach(function (p) {
      const priceEl = h.document.querySelector('.pa-cmp-product[data-product-id="' + p.id + '"] .pa-cmp-price');
      assert.strictEqual(priceEl.textContent, p.precioConsultar ? 'Precio a consultar' : p.precioFormateado);
    });
  });

  // --- 6) filas comparativas correctas ---

  await asyncTest('el comparador muestra las filas comparativas con los valores reales, en orden', function () {
    return (async () => {
      const h = createHarness({ responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }] });
      h.submitMessage('compara');
      await flushAll();
      const rows = h.document.querySelectorAll('.pa-cmp-row');
      assert.strictEqual(rows.length, COMPARISON_2.filas.length);
      COMPARISON_2.filas.forEach(function (fila, idx) {
        const row = rows[idx];
        const label = row.querySelector('.pa-cmp-row-label');
        assert.strictEqual(label.textContent, fila.label);
        const values = row.querySelectorAll('.pa-cmp-value');
        assert.strictEqual(values.length, fila.valores.length);
        fila.valores.forEach(function (v, vIdx) {
          assert.strictEqual(values[vIdx].textContent, v);
        });
      });
    })();
  });

  // --- 7) "No confirmado" visible donde corresponde ---

  await asyncTest('un valor "No confirmado" se muestra visible y distinguido (materialMarco del lado sin confirmar)', async function () {
    const h = createHarness({ responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }] });
    h.submitMessage('compara');
    await flushAll();
    const filaMaterialMarco = COMPARISON_2.filas.find(function (f) { return f.key === 'materialMarco'; });
    assert.ok(filaMaterialMarco, 'fixture debe tener fila materialMarco');
    const idxNoConfirmado = filaMaterialMarco.valores.indexOf('No confirmado');
    assert.ok(idxNoConfirmado > -1, 'fixture debe tener un lado sin confirmar en materialMarco');
    const rows = h.document.querySelectorAll('.pa-cmp-row');
    const rowIdx = COMPARISON_2.filas.indexOf(filaMaterialMarco);
    const values = rows[rowIdx].querySelectorAll('.pa-cmp-value');
    assert.strictEqual(values[idxNoConfirmado].textContent, 'No confirmado');
    assert.ok(values[idxNoConfirmado].classList.contains('pa-cmp-value-unconfirmed'));
  });

  // --- 8) no renderiza filas inexistentes ---

  await asyncTest('el comparador no crea filas para atributos ausentes en ambos productos', async function () {
    const h = createHarness({ responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }] });
    h.submitMessage('compara');
    await flushAll();
    const labels = Array.prototype.map.call(h.document.querySelectorAll('.pa-cmp-row-label'), function (el) { return el.textContent; });
    ['Balance', 'Peso', 'Dureza', 'Material'].forEach(function (label) {
      assert.strictEqual(labels.indexOf(label), -1, 'no deberia existir la fila "' + label + '"');
    });
    assert.strictEqual(labels.length, COMPARISON_2.filas.length);
  });

  // --- 9) "Ver producto" del producto A ---

  await asyncTest('"Ver producto" del producto A abre la ficha real via window.openModal (findStoreCard)', async function () {
    const h = createHarness({
      storeProducts: [barataProduct, caraProduct],
      responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }],
    });
    h.submitMessage('compara');
    await flushAll();
    const btn = cmpVerButton(h.document, BARATA_ID);
    assert.ok(btn, 'debe existir el boton Ver producto de A');
    assert.strictEqual(btn.textContent, 'Ver producto');
    h.click(btn);
    assert.strictEqual(h.openModalCalls.length, 1);
    const storeCard = h.openModalCalls[0];
    assert.strictEqual(storeCard.querySelector('.card-name').textContent, barataProduct.nombre);
  });

  // --- 10) "Ver producto" del producto B ---

  await asyncTest('"Ver producto" del producto B abre la ficha real via window.openModal (findStoreCard)', async function () {
    const h = createHarness({
      storeProducts: [barataProduct, caraProduct],
      responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }],
    });
    h.submitMessage('compara');
    await flushAll();
    const btn = cmpVerButton(h.document, CARA_ID);
    assert.ok(btn, 'debe existir el boton Ver producto de B');
    h.click(btn);
    assert.strictEqual(h.openModalCalls.length, 1);
    const storeCard = h.openModalCalls[0];
    assert.strictEqual(storeCard.querySelector('.card-name').textContent, caraProduct.nombre);
  });

  // --- 11) agregar al carrito un producto sin talle requerido ---

  await asyncTest('"Agregar al carrito" de un producto sin talle requerido lo agrega directo via window.PadelCart', async function () {
    const h = createHarness({
      responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }],
      cartAddItem: function () { return { ok: true, line: {} }; },
    });
    h.submitMessage('compara');
    await flushAll();
    const btn = cmpAddButton(h.document, BARATA_ID);
    assert.ok(btn);
    h.click(btn);
    assert.strictEqual(h.cartAddItemCalls.length, 1);
    assert.deepStrictEqual(
      { productId: h.cartAddItemCalls[0].productId, talle: h.cartAddItemCalls[0].talle, cantidad: h.cartAddItemCalls[0].cantidad },
      { productId: BARATA_ID, talle: null, cantidad: 1 }
    );
    assert.strictEqual(btn.textContent, 'Agregado!');
    assert.ok(btn.classList.contains('pa-cmp-added'));
    assert.strictEqual(btn.disabled, true);
    assert.strictEqual(h.openModalCalls.length, 0, 'no debe abrir ninguna ficha cuando el agregado fue directo');
  });

  // --- 12) producto con talle requerido NO se agrega solo ---

  await asyncTest('"Agregar al carrito" de un producto CON talle requerido y sin talle definido no lo agrega: abre la ficha real', async function () {
    const h = createHarness({
      storeProducts: [barataProduct, polleraProduct],
      responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_TALLE }],
      // Reproduce el mismo error que devuelve lib/padel-cart.js#buildLine para
      // un producto que requiere talle sin uno definido (ver
      // tests/padel-cart.test.js): el widget nunca decide esto por su cuenta,
      // solo reacciona a lo que el carrito real responda.
      cartAddItem: function (productId) {
        if (productId === POLLERA_ID) {
          return { ok: false, error: 'talle_requerido', tallesDisponibles: polleraProduct.talles.slice() };
        }
        return { ok: true, line: {} };
      },
    });
    h.submitMessage('compara');
    await flushAll();
    const btn = cmpAddButton(h.document, POLLERA_ID);
    assert.ok(btn);
    const originalText = btn.textContent;
    h.click(btn);
    assert.strictEqual(h.cartAddItemCalls.length, 1);
    assert.strictEqual(h.cartAddItemCalls[0].result.ok, false);
    assert.strictEqual(h.cartAddItemCalls[0].result.error, 'talle_requerido');
    // No se agrego: el boton no cambia a "Agregado!" ni se deshabilita.
    assert.strictEqual(btn.textContent, originalText);
    assert.strictEqual(btn.disabled, false);
    assert.ok(!btn.classList.contains('pa-cmp-added'));
    // En cambio, se abre la ficha real del producto para que el cliente elija el talle
    // (mismo flujo existente de seleccion de talle, no uno nuevo).
    assert.strictEqual(h.openModalCalls.length, 1);
    assert.strictEqual(h.openModalCalls[0].querySelector('.card-name').textContent, polleraProduct.nombre);
  });

  // --- 13) el contexto de "productos ofrecidos" queda intacto despues de comparar ---

  await asyncTest('despues de mostrar el comparador, "ofrecidos" se reenvia igual a los 2 productos comparados en el siguiente mensaje', async function () {
    const h = createHarness({
      responses: [
        { reply: 'Te dejo la comparacion.', cards: [], ofrecidos: [BARATA_ID, CARA_ID], acciones: [], comparison: COMPARISON_2 },
        { reply: 'Listo, la agregue.', cards: [], ofrecidos: [BARATA_ID, CARA_ID], acciones: [{ tipo: 'agregar_al_carrito', productId: BARATA_ID, talle: null, cantidad: 1 }], comparison: null },
      ],
    });
    h.submitMessage('Compara estas dos palas');
    await flushAll();
    assert.strictEqual(h.fetchCalls.length, 1);
    assert.deepStrictEqual(h.fetchCalls[0].body.ofrecidos, []);

    h.submitMessage('Dale, tirame otra opcion');
    await flushAll();
    assert.strictEqual(h.fetchCalls.length, 2);
    assert.deepStrictEqual(h.fetchCalls[1].body.ofrecidos, [BARATA_ID, CARA_ID], 'el segundo mensaje debe reenviar los ids reales que se compararon, en el mismo orden');
  });

  // --- 14) "agregame la primera" despues de comparar ---

  await asyncTest('"agregame la primera" despues de comparar envia el mensaje real y conserva "ofrecidos" de la comparacion', async function () {
    const h = createHarness({
      responses: [
        { reply: 'Te dejo la comparacion.', cards: [], ofrecidos: [BARATA_ID, CARA_ID], acciones: [], comparison: COMPARISON_2 },
        { reply: 'Agregue la primera.', cards: [], ofrecidos: [BARATA_ID, CARA_ID], acciones: [{ tipo: 'agregar_al_carrito', productId: BARATA_ID, talle: null, cantidad: 1 }], comparison: null },
      ],
    });
    h.submitMessage('Compara estas dos palas');
    await flushAll();
    h.submitMessage('Agregame la primera.');
    await flushAll();
    assert.strictEqual(h.fetchCalls.length, 2);
    assert.strictEqual(h.fetchCalls[1].body.message, 'Agregame la primera.');
    assert.deepStrictEqual(h.fetchCalls[1].body.ofrecidos, [BARATA_ID, CARA_ID]);
    // La accion que devuelve el servidor para esa referencia se ejecuta igual
    // que en Fase 1 (applyAccionCarrito -> window.PadelCart.addItem).
    assert.strictEqual(h.cartAddItemCalls.length, 1);
    assert.strictEqual(h.cartAddItemCalls[0].productId, BARATA_ID);
  });

  // --- 15) "quiero la segunda" despues de comparar ---

  await asyncTest('"quiero la segunda" despues de comparar envia el mensaje real y conserva "ofrecidos" de la comparacion', async function () {
    const h = createHarness({
      responses: [
        { reply: 'Te dejo la comparacion.', cards: [], ofrecidos: [BARATA_ID, CARA_ID], acciones: [], comparison: COMPARISON_2 },
        { reply: 'Agregue la segunda.', cards: [], ofrecidos: [BARATA_ID, CARA_ID], acciones: [{ tipo: 'agregar_al_carrito', productId: CARA_ID, talle: null, cantidad: 1 }], comparison: null },
      ],
    });
    h.submitMessage('Compara estas dos palas');
    await flushAll();
    h.submitMessage('Quiero la segunda.');
    await flushAll();
    assert.strictEqual(h.fetchCalls.length, 2);
    assert.strictEqual(h.fetchCalls[1].body.message, 'Quiero la segunda.');
    assert.deepStrictEqual(h.fetchCalls[1].body.ofrecidos, [BARATA_ID, CARA_ID]);
    assert.strictEqual(h.cartAddItemCalls.length, 1);
    assert.strictEqual(h.cartAddItemCalls[0].productId, CARA_ID);
  });

  // --- 16) responsive mobile (estructural; confirmacion visual real via Playwright) ---

  await asyncTest('el comparador se arma igual en un viewport mobile (375px) y el CSS dedicado define el breakpoint mobile', async function () {
    const h = createHarness({ responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }] });
    h.window.innerWidth = 375;
    h.window.innerHeight = 812;
    h.submitMessage('compara');
    await flushAll();
    assert.strictEqual(h.document.querySelectorAll('.pa-cmp').length, 1);
    assert.strictEqual(h.document.querySelectorAll('.pa-cmp-product').length, 2);
    const header = h.document.querySelector('.pa-cmp-header');
    assert.strictEqual(header.style.gridTemplateColumns, 'repeat(2, 1fr)');
    assert.ok(WIDGET_CSS.indexOf('@media (max-width: 480px)') > -1, 'el CSS del comparador debe definir un breakpoint mobile');
  });

  // --- 17) responsive desktop (estructural; confirmacion visual real via Playwright) ---

  await asyncTest('el comparador se arma igual en un viewport desktop (1280px)', async function () {
    const h = createHarness({ responses: [{ reply: 'ok', cards: [], ofrecidos: [], acciones: [], comparison: COMPARISON_2 }] });
    h.window.innerWidth = 1280;
    h.window.innerHeight = 800;
    h.submitMessage('compara');
    await flushAll();
    assert.strictEqual(h.document.querySelectorAll('.pa-cmp').length, 1);
    assert.strictEqual(h.document.querySelectorAll('.pa-cmp-product').length, 2);
    const header = h.document.querySelector('.pa-cmp-header');
    assert.strictEqual(header.style.gridTemplateColumns, 'repeat(2, 1fr)');
  });

  // --- 18) sin comparacion no rompe el chat normal ---

  await asyncTest('una respuesta sin "comparison" no rompe el chat normal (no crea .pa-cmp)', async function () {
    const h = createHarness({ responses: [{ reply: 'Hola, en que te ayudo?', cards: [], ofrecidos: [], acciones: [], comparison: null }] });
    h.submitMessage('Hola');
    await flushAll();
    assert.strictEqual(h.document.querySelectorAll('.pa-cmp').length, 0);
    const bubbles = h.document.querySelectorAll('.pa-msg-assistant');
    assert.strictEqual(bubbles[bubbles.length - 1].textContent, 'Hola, en que te ayudo?');
  });

  // --- 19) las tarjetas normales siguen funcionando (regresion de renderCard) ---

  await asyncTest('las tarjetas normales (renderCard) siguen funcionando igual, sin verse afectadas por el comparador', async function () {
    const card = catalog.toCard(caraProduct);
    const h = createHarness({
      storeProducts: [caraProduct],
      responses: [{ reply: 'Te recomiendo esta.', cards: [card], ofrecidos: [CARA_ID], acciones: [], comparison: null }],
    });
    h.submitMessage('recomendame una pala');
    await flushAll();
    assert.strictEqual(h.document.querySelectorAll('.pa-card').length, 1);
    assert.strictEqual(h.document.querySelectorAll('.pa-cmp').length, 0);
    const nameEl = h.document.querySelector('.pa-card-name');
    assert.strictEqual(nameEl.textContent, caraProduct.nombre);
    const wrap = h.document.querySelector('.pa-card');
    h.click(wrap);
    assert.strictEqual(h.openModalCalls.length, 1);
    assert.strictEqual(h.openModalCalls[0].querySelector('.card-name').textContent, caraProduct.nombre);
  });

  // --- 20) el carrito de Fase 1 (acciones del asesor) sigue funcionando ---

  await asyncTest('las acciones de carrito de Fase 1 (applyAccionCarrito) siguen funcionando igual, sin verse afectadas por el comparador', async function () {
    const h = createHarness({
      responses: [{ reply: 'Listo, agregue 2.', cards: [], ofrecidos: [], acciones: [{ tipo: 'agregar_al_carrito', productId: BARATA_ID, talle: null, cantidad: 2 }], comparison: null }],
    });
    h.submitMessage('agregame 2');
    await flushAll();
    assert.strictEqual(h.cartAddItemCalls.length, 1);
    assert.deepStrictEqual(
      { productId: h.cartAddItemCalls[0].productId, talle: h.cartAddItemCalls[0].talle, cantidad: h.cartAddItemCalls[0].cantidad },
      { productId: BARATA_ID, talle: null, cantidad: 2 }
    );
  });

  console.log('');
  console.log('Pruebas del comparador visual PRO (Fase 2 - Etapa 3): ' + passed + '/' + (passed + failed) + ' OK');
  if (failed > 0) process.exit(1);
})();
