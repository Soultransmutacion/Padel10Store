'use strict';

/**
 * Pruebas de integracion del boton "Comprar ahora" (widget/mercadopago-buy.js
 * + widget/padel-checkout.js#startBuyNow), con un DOM real via jsdom (mismo
 * criterio que tests/padel-checkout-widget.test.js).
 *
 * Cubren el fix de esta etapa: "Comprar ahora" para
 * royal-padel-cross-black-26 (unico producto piloto) ya NO llama al
 * endpoint de prueba /api/create-payment-preference (que no creaba pedido
 * real ni external_reference/notification_url). En cambio, dispara el
 * flujo real (POST /api/pedidos, y despues POST /api/pedidos-preferencia
 * si hiciera falta reintentar) para UN SOLO producto, sin tocar el
 * carrito persistente y sin obligar a abrir el drawer manualmente.
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
const CHECKOUT_AVAILABILITY_SRC = fs.readFileSync(path.join(__dirname, '..', 'widget', 'checkout-availability.js'), 'utf8');
const CHECKOUT_WIDGET_SRC = fs.readFileSync(path.join(__dirname, '..', 'widget', 'padel-checkout.js'), 'utf8');
const MERCADOPAGO_BUY_SRC = fs.readFileSync(path.join(__dirname, '..', 'widget', 'mercadopago-buy.js'), 'utf8');

const BUY_NOW_PRODUCT_ID = 'royal-padel-cross-black-26';
const OTRO_PRODUCTO = 'royal-padel-aniversario-36';

function drawerHtml() {
  return (
    '<!doctype html><html><body>' +
    '<button class="cart-btn" id="cartBtn">Carrito <span class="cart-badge" id="cartBadge">0</span></button>' +
    '<div class="card"><button type="button" id="modalBuyNowBtn" data-mp-buy-button data-product-id="' + BUY_NOW_PRODUCT_ID + '">Comprar ahora</button></div>' +
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

function createHarness(options) {
  const opts = options || {};
  // Por defecto, checkout HABILITADO: es lo que asumen todas las pruebas
  // existentes de este archivo (no es lo que estan probando). La seccion
  // dedicada al interruptor de seguridad, mas abajo, pasa
  // `checkoutEnabled: false` explicitamente.
  const checkoutEnabled = opts.checkoutEnabled !== false;
  const dom = new JSDOM(drawerHtml(), { url: 'https://padel10store.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  const document = window.document;

  const fetchCalls = [];
  const apiPedidosResponses = (opts.apiPedidosResponses || []).slice();
  const openModalCalls = [];
  window.openModal = function (card) {
    openModalCalls.push(card);
  };

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
      const next = apiPedidosResponses.length ? apiPedidosResponses.shift() : { ok: true, status: 201, body: { numero: 'P10-000900' } };
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
  window.eval(CHECKOUT_AVAILABILITY_SRC);
  window.eval(CHECKOUT_WIDGET_SRC);
  window.eval(MERCADOPAGO_BUY_SRC);

  // widget/mercadopago-buy.js solo escanea el DOM en el evento
  // 'DOMContentLoaded'; en este harness el documento ya esta completamente
  // parseado antes de evaluar los scripts (igual que jsdom hace notar en
  // tests/padel-checkout-widget.test.js para widget/padel-checkout.js), asi
  // que se dispara manualmente el mismo escaneo que produccion hace solo
  // (window.PadelMPBuy.init), sin reimplementar ninguna logica propia.
  window.PadelMPBuy.init(document);

  function buyNowBtn() {
    return document.getElementById('modalBuyNowBtn');
  }

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
    setField('nombre', 'Marco');
    setField('apellido', 'Diaz');
    setField('email', 'marco@example.com');
    setField('telefono', '3411112222');
    setField('provincia', 'Santa Fe');
    setField('localidad', 'Rosario');
    setField('codigoPostal', '2000');
    setField('calle', 'Cordoba');
    setField('numero', '500');
  }

  return {
    dom, window, document,
    fetchCalls,
    openModalCalls,
    field, setField, click, llenarFormularioValido,
    buyNowBtn,
    view: () => window.PadelCheckoutWidgetInternal.getView(),
    mode: () => window.PadelCheckoutWidgetInternal.getMode(),
    body: () => document.getElementById('cartDrawerBody').innerHTML,
    drawerOpen: () => document.getElementById('cartDrawer').classList.contains('open'),
    nextBtn: () => document.getElementById('cartDrawerNextBtn'),
    backBtn: () => document.getElementById('cartDrawerBackBtn'),
    continueBtn: () => document.getElementById('cartDrawerContinueBtn'),
  };
}

async function withReadyCatalog(h) {
  await flushAll();
}

function testAsync(name, fn) {
  test(name, fn);
}

// --- "Comprar ahora" ya no llama al endpoint fantasma --------------------

testAsync('"Comprar ahora" nunca llama a /api/create-payment-preference', async () => {
  const h = createHarness();
  await withReadyCatalog(h);
  h.click(h.buyNowBtn());
  await flushAll();
  assert.ok(!h.fetchCalls.some((u) => u.indexOf('create-payment-preference') !== -1), 'no deberia haber llamado al endpoint fantasma');
});

// --- abre directo el paso de datos, sin pasar por el carrito -------------

testAsync('"Comprar ahora" abre el drawer directo en "Tus datos", sin pasar por la vista de carrito', async () => {
  const h = createHarness();
  await withReadyCatalog(h);
  assert.strictEqual(h.view(), 'carrito');
  assert.strictEqual(h.drawerOpen(), false);

  h.click(h.buyNowBtn());

  assert.strictEqual(h.drawerOpen(), true, 'el drawer debe quedar abierto solo');
  assert.strictEqual(h.view(), 'formulario');
  assert.strictEqual(h.mode(), 'buyNow');
});

// --- es un checkout de UN SOLO producto: nunca mezcla con el carrito -----

testAsync('"Comprar ahora" nunca mezcla su producto con lo que ya hubiera en el carrito persistente', async () => {
  const h = createHarness();
  await withReadyCatalog(h);
  h.window.PadelCart.addItem(OTRO_PRODUCTO, null, 3);
  assert.strictEqual(h.window.PadelCart.getRawLines().length, 1);

  h.click(h.buyNowBtn());
  assert.strictEqual(h.view(), 'formulario');
  h.llenarFormularioValido();
  h.click(h.nextBtn()); // -> revision

  assert.strictEqual(h.view(), 'revision');
  assert.ok(h.body().indexOf(OTRO_PRODUCTO) === -1, 'la revision no deberia mostrar el otro producto del carrito');
  assert.ok(h.body().indexOf("Cross Black") !== -1, 'la revision debe mostrar el producto piloto');

  h.click(h.nextBtn()); // -> confirmar y crear pedido
  await flushAll();

  assert.strictEqual(h.view(), 'confirmacion');
  // El carrito persistente (el otro producto) sigue intacto: "Comprar
  // ahora" nunca lo toco ni lo vacio.
  assert.strictEqual(h.window.PadelCart.getRawLines().length, 1);
  assert.strictEqual(h.window.PadelCart.getRawLines()[0].productId, OTRO_PRODUCTO);
});

// --- el body enviado a /api/pedidos es exactamente 1 linea, cantidad 1 ---

testAsync('el body enviado a /api/pedidos tiene exactamente 1 linea (el producto piloto, cantidad 1)', async () => {
  let bodyEnviado = null;
  const h = createHarness();
  h.window.fetch = function (url, init) {
    if (String(url).indexOf('products.json') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(productsJson) });
    }
    if (String(url).indexOf('/api/pedidos') !== -1) {
      bodyEnviado = JSON.parse(init.body);
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ numero: 'P10-000901' }) });
    }
    return Promise.reject(new Error('no mockeado'));
  };
  h.window.eval(CART_CORE_SRC);
  h.window.eval(CHECKOUT_FIELDS_SRC);
  h.window.eval(CART_WIDGET_SRC);
  h.window.eval(CHECKOUT_WIDGET_SRC);
  h.window.eval(MERCADOPAGO_BUY_SRC);
  h.window.PadelMPBuy.init(h.document);
  await withReadyCatalog(h);
  h.window.PadelCart.addItem(OTRO_PRODUCTO, null, 5); // ruido: no deberia aparecer en el body

  h.click(h.buyNowBtn());
  h.llenarFormularioValido();
  h.click(h.nextBtn());
  h.click(h.nextBtn());
  await flushAll();

  assert.ok(bodyEnviado, 'debe haberse enviado un body a /api/pedidos');
  assert.strictEqual(bodyEnviado.items.length, 1);
  assert.strictEqual(bodyEnviado.items[0].productId, BUY_NOW_PRODUCT_ID);
  assert.strictEqual(bodyEnviado.items[0].cantidad, 1);
  assert.strictEqual('precio' in bodyEnviado.items[0], false);
  assert.strictEqual('nombre' in bodyEnviado.items[0], false);
});

// --- error: mensaje claro, reintento posible, sin pedidos duplicados -----

testAsync('si /api/pedidos falla, se muestra un error claro y se puede reintentar sin duplicar el pedido', async () => {
  const h = createHarness({ apiPedidosResponses: [{ ok: false, status: 500, body: { error: 'algo salio mal' } }] });
  await withReadyCatalog(h);

  h.click(h.buyNowBtn());
  h.llenarFormularioValido();
  h.click(h.nextBtn());
  h.click(h.nextBtn()); // primer intento: falla
  await flushAll();

  assert.strictEqual(h.view(), 'revision', 'debe quedarse en revision, nunca avanzar a confirmacion con un error');
  assert.ok(/no pudimos registrar tu pedido/i.test(h.body()), 'debe mostrar un mensaje de error legible, sin detalles tecnicos');
  assert.ok(h.body().indexOf('algo salio mal') === -1, 'nunca debe filtrar el detalle tecnico del error');
  const primerosLlamadosAPedidos = h.fetchCalls.filter((u) => u.indexOf('/api/pedidos') !== -1 && u.indexOf('preferencia') === -1).length;
  assert.strictEqual(primerosLlamadosAPedidos, 1);

  // Reintento: como el primer intento NUNCA llego a crear un pedido (el
  // servidor respondio error antes), reintentar crea el pedido real recien
  // ahora -no es un duplicado, es el primer pedido que se crea con exito.
  h.click(h.nextBtn());
  await flushAll();

  assert.strictEqual(h.view(), 'confirmacion');
  const segundosLlamadosAPedidos = h.fetchCalls.filter((u) => u.indexOf('/api/pedidos') !== -1 && u.indexOf('preferencia') === -1).length;
  assert.strictEqual(segundosLlamadosAPedidos, 2, 'un unico pedido nuevo por click en Confirmar (el primero fallo antes de crear nada)');
});

// --- "Volver al carrito" descarta la compra directa sin crear nada -------

testAsync('"Volver al carrito" desde "Comprar ahora" descarta la compra directa (nunca crea un pedido)', async () => {
  const h = createHarness();
  await withReadyCatalog(h);
  h.click(h.buyNowBtn());
  assert.strictEqual(h.mode(), 'buyNow');

  h.click(h.backBtn());

  assert.strictEqual(h.view(), 'carrito');
  assert.strictEqual(h.mode(), 'cart');
  assert.ok(!h.fetchCalls.some((u) => u.indexOf('/api/pedidos') !== -1 && u.indexOf('preferencia') === -1));
});

// --- unico producto piloto: cualquier otro productId se ignora -----------

testAsync('startBuyNow ignora cualquier producto que no sea el piloto (defensa en profundidad)', async () => {
  const h = createHarness();
  await withReadyCatalog(h);
  h.window.PadelCheckoutWidget.startBuyNow(OTRO_PRODUCTO, null);
  assert.strictEqual(h.view(), 'carrito', 'no deberia haber iniciado ningun checkout directo');
  assert.strictEqual(h.mode(), 'cart');
});

// --- Validacion de host del redirectUrl (defensa en profundidad, mismo
// allow-list que valida el backend en lib/mercadopago-preference.js) -----
//
// Estas pruebas verifican el comportamiento observable: si el widget NO
// redirige (window.location.href no cambia en jsdom, ver mas abajo), la
// unica senal fiable disponible es que el flujo nunca llega a
// goto('confirmacion') (el codigo hace `return` antes de esa linea, ver
// widget/padel-checkout.js). Cuando SI redirige, la vista se queda tal
// cual estaba (todavia 'revision'), porque el codigo tambien vuelve antes
// de llegar a goto('confirmacion') - la diferencia real (efectivamente
// navegar) no es observable en jsdom (loguea "Not implemented:
// navigation" y no lanza), asi que estas pruebas se apoyan en que el host
// invalido es el UNICO camino que efectivamente muestra la vista de
// confirmacion sin redirigir.

function crearHarnessConRedirect(redirectUrl) {
  return createHarness({
    apiPedidosResponses: [
      { ok: true, status: 201, body: { numero: 'P10-000950', redirectUrl: redirectUrl } },
    ],
  });
}

async function completarCompraDirecta(h) {
  await withReadyCatalog(h);
  h.click(h.buyNowBtn());
  h.llenarFormularioValido();
  h.click(h.nextBtn()); // -> revision
  h.click(h.nextBtn()); // -> confirmar y crear pedido
  await flushAll();
}

testAsync('redirectUrl con host sandbox oficial: el flujo intenta redirigir (nunca muestra la vista de confirmacion)', async () => {
  const h = crearHarnessConRedirect('https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=1');
  await completarCompraDirecta(h);
  assert.strictEqual(h.view(), 'revision', 'un host sandbox oficial debe disparar la redireccion, no la vista de confirmacion');
});

testAsync('redirectUrl con host de produccion oficial: el flujo intenta redirigir (nunca muestra la vista de confirmacion)', async () => {
  const h = crearHarnessConRedirect('https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1');
  await completarCompraDirecta(h);
  assert.strictEqual(h.view(), 'revision', 'un host de produccion oficial debe disparar la redireccion, no la vista de confirmacion');
});

testAsync('redirectUrl con host que solo imita al sandbox oficial (typosquatting): nunca redirige, muestra confirmacion', async () => {
  const h = crearHarnessConRedirect('https://sandbox.mercadopago.com.ar.evil.com/checkout/v1/redirect?pref_id=1');
  await completarCompraDirecta(h);
  assert.strictEqual(h.view(), 'confirmacion', 'un host que no matchea el allow-list nunca debe disparar una redireccion');
});

testAsync('redirectUrl con host que solo imita al de produccion (typosquatting): nunca redirige, muestra confirmacion', async () => {
  const h = crearHarnessConRedirect('https://www.mercadopago.com.ar.evil.com/checkout/v1/redirect?pref_id=1');
  await completarCompraDirecta(h);
  assert.strictEqual(h.view(), 'confirmacion');
});

testAsync('redirectUrl con protocolo http (no https) sobre un host valido: nunca redirige, muestra confirmacion', async () => {
  const h = crearHarnessConRedirect('http://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1');
  await completarCompraDirecta(h);
  assert.strictEqual(h.view(), 'confirmacion');
});

testAsync('redirectUrl con un dominio totalmente ajeno a Mercado Pago: nunca redirige, muestra confirmacion', async () => {
  const h = crearHarnessConRedirect('https://sitio-cualquiera.com/checkout');
  await completarCompraDirecta(h);
  assert.strictEqual(h.view(), 'confirmacion');
});

// ===========================================================================
// Interruptor de seguridad del checkout (widget/checkout-availability.js):
// con /api/checkout-config respondiendo {enabled:false} (o fallando: ver
// tests/checkout-availability.test.js para esos casos, ya cubiertos a
// nivel del propio widget), "Comprar ahora" nunca debe iniciar un pedido.
// ===========================================================================

testAsync('checkout deshabilitado: "Comprar ahora" nunca abre el formulario ni llama a /api/pedidos', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withReadyCatalog(h);

  h.click(h.buyNowBtn());
  await flushAll();

  assert.strictEqual(h.view(), 'carrito', 'nunca debe avanzar al formulario de compra directa');
  assert.strictEqual(h.mode(), 'cart');
  assert.ok(
    !h.fetchCalls.some((u) => u.indexOf('/api/pedidos') !== -1 && u.indexOf('preferencia') === -1),
    'nunca debe haber llamado a POST /api/pedidos'
  );
});

testAsync('checkout deshabilitado: "Comprar ahora" abre la ficha del producto (para mostrar el mensaje y WhatsApp) en vez de comprar', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withReadyCatalog(h);

  h.click(h.buyNowBtn());
  await flushAll();

  assert.strictEqual(h.openModalCalls.length, 1, 'debe haber abierto la ficha del producto exactamente una vez');
});

testAsync('checkout habilitado explicitamente (default de esta suite): "Comprar ahora" sigue funcionando igual, sin abrir la ficha', async () => {
  const h = createHarness({ checkoutEnabled: true });
  await withReadyCatalog(h);

  h.click(h.buyNowBtn());

  assert.strictEqual(h.view(), 'formulario');
  assert.strictEqual(h.mode(), 'buyNow');
  assert.strictEqual(h.openModalCalls.length, 0, 'con el checkout habilitado, nunca debe abrir la ficha en vez de comprar');
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
  console.log('Pruebas de "Comprar ahora" (widget/mercadopago-buy.js): ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
