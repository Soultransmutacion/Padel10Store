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
const CHECKOUT_AVAILABILITY_SRC = fs.readFileSync(path.join(__dirname, '..', 'widget', 'checkout-availability.js'), 'utf8');
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
    '<div class="checkout-paused-msg" id="cartCheckoutPausedMsg" hidden>La compra online está temporalmente pausada. Consultanos por WhatsApp para confirmar precio y disponibilidad.</div>' +
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
  // Por defecto, checkout HABILITADO: es lo que asumen todas las pruebas
  // existentes de este archivo (el interruptor de seguridad tiene su
  // propia seccion dedicada, mas abajo). Pasar `checkoutEnabled: false`
  // simula el interruptor apagado sin tocar ninguna variable de entorno.
  const checkoutEnabled = opts.checkoutEnabled !== false;
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
    if (String(url).indexOf('/api/checkout-config') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: checkoutEnabled }) });
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
  window.eval(CHECKOUT_AVAILABILITY_SRC);
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
    checkoutPausedMsg: () => document.getElementById('cartCheckoutPausedMsg'),
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
  assert.deepStrictEqual(
    Object.keys(bodyEnviado).sort(),
    ['comprador', 'contacto', 'direccionEnvio', 'idempotencyKey', 'items']
  );
  assert.strictEqual(typeof bodyEnviado.idempotencyKey, 'string');
  assert.match(bodyEnviado.idempotencyKey, /^[A-Za-z0-9_-]{16,100}$/);
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

// --- Idempotencia de checkout (Fase 3, Etapa 2) ---------------------------
//
// fetch "controlado": cada llamada a /api/pedidos se resuelve con la
// respuesta que indique la cola `respuestas`, salvo que sea 'colgar', en
// cuyo caso la promesa NUNCA se resuelve por si sola -solo se rechaza si
// se aborta la request (init.signal), imitando el comportamiento real de
// fetch() ante un AbortController-.
function fetchControlado(respuestas) {
  const cola = respuestas.slice();
  const llamadas = [];
  const fn = function (url, init) {
    if (String(url).indexOf('products.json') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(productsJson) });
    }
    if (String(url).indexOf('/api/pedidos') !== -1) {
      const cuerpo = init && init.body ? JSON.parse(init.body) : null;
      llamadas.push(cuerpo);
      const siguiente = cola.length ? cola.shift() : { ok: true, status: 201, body: { numero: 'P10-000001' } };
      if (siguiente === 'colgar') {
        return new Promise((resolve, reject) => {
          if (init && init.signal) {
            if (init.signal.aborted) {
              reject(new Error('AbortError'));
              return;
            }
            init.signal.addEventListener('abort', function () {
              reject(new Error('AbortError'));
            });
          }
        });
      }
      return Promise.resolve({
        ok: siguiente.ok,
        status: siguiente.status,
        json: () => Promise.resolve(siguiente.body),
      });
    }
    return Promise.reject(new Error('fetch no mockeado para ' + url));
  };
  fn.llamadas = llamadas;
  return fn;
}

// IMPORTANTE: nunca re-evaluar los scripts sobre un harness ya creado (eso
// duplicaria los listeners de evento y el estado interno del widget, como
// ya hace tests/padel-checkout-widget.test.js#'el body enviado...' de forma
// deliberada solo porque a ese test no le importa el conteo de llamadas).
// Estos tests SI dependen del conteo exacto de llamadas/estado interno, asi
// que solo se reasigna window.fetch DESPUES de crear el harness (fetch se
// resuelve dinamicamente en cada llamada, nunca se "captura" al eval-ear).
function crearHarnessControlado(respuestas) {
  const h = createHarness();
  const fetchFn = fetchControlado(respuestas);
  h.window.fetch = fetchFn;
  h.pedidosLlamadas = fetchFn.llamadas;
  return h;
}

testAsync(
  'timeout: no borra la idempotencyKey guardada, muestra un mensaje de resultado incierto, y un reintento con el mismo contenido reutiliza la misma clave',
  async () => {
    const h = crearHarnessControlado(['colgar', { ok: true, status: 201, body: { numero: 'P10-000042' } }]);
    await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

    h.click(h.continueBtn());
    h.llenarFormularioValido();
    h.click(h.nextBtn()); // -> revision
    h.click(h.nextBtn()); // -> primer intento (se cuelga)
    await flushAll();

    const almacenadaTrasColgarse = h.window.PadelCheckoutWidgetInternal.getIdempotenciaAlmacenada();
    assert.ok(almacenadaTrasColgarse, 'la idempotencyKey debe seguir guardada mientras el resultado es incierto');

    // Se simula que se cumplio el timeout (sin esperar 20s reales).
    h.window.PadelCheckoutWidgetInternal.simularTimeoutParaPruebas();
    await flushAll();

    assert.strictEqual(h.view(), 'revision', 'se queda en revision para poder reintentar');
    assert.ok(/no pudimos confirmar/i.test(h.body()), 'debe mostrar un mensaje de resultado incierto, no el generico');
    const almacenadaTrasTimeout = h.window.PadelCheckoutWidgetInternal.getIdempotenciaAlmacenada();
    assert.ok(almacenadaTrasTimeout, 'la clave NUNCA se borra ante un resultado incierto');
    assert.strictEqual(almacenadaTrasTimeout.key, almacenadaTrasColgarse.key);

    // Reintento: mismo contenido -> debe reusar la MISMA idempotencyKey.
    h.click(h.nextBtn());
    await flushAll();

    assert.strictEqual(h.pedidosLlamadas.length, 2);
    assert.strictEqual(h.pedidosLlamadas[1].idempotencyKey, h.pedidosLlamadas[0].idempotencyKey);
    assert.strictEqual(h.view(), 'confirmacion');
    assert.ok(h.body().indexOf('P10-000042') !== -1);
    // Confirmacion real del servidor: recien aca se borra la clave.
    assert.strictEqual(h.window.PadelCheckoutWidgetInternal.getIdempotenciaAlmacenada(), null);
  }
);

testAsync(
  'abortar por navegacion (cerrar el drawer) durante el envio: no muestra error ni toca el carrito, y un reintento posterior reutiliza la misma clave',
  async () => {
    const h = crearHarnessControlado(['colgar', { ok: true, status: 201, body: { numero: 'P10-000043' } }]);
    await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

    h.click(h.continueBtn());
    h.llenarFormularioValido();
    h.click(h.nextBtn());
    h.click(h.nextBtn()); // primer intento, se cuelga
    await flushAll();

    const claveGuardada = h.window.PadelCheckoutWidgetInternal.getIdempotenciaAlmacenada().key;

    // El comprador cierra el drawer en medio del envio: la respuesta tardia
    // (si llegara) nunca debe volver a mostrar nada ni tocar el carrito.
    h.window.document.getElementById('cartDrawerClose').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flushAll();

    assert.strictEqual(h.view(), 'carrito');
    assert.strictEqual(h.window.PadelCart.getRawLines().length, 1, 'el carrito no se vacia ante un abort');
    assert.strictEqual(h.window.PadelCheckoutWidgetInternal.getSubmitError(), null);

    // La clave sigue guardada (nunca se borra ante un abort del usuario).
    const trasAbort = h.window.PadelCheckoutWidgetInternal.getIdempotenciaAlmacenada();
    assert.ok(trasAbort);
    assert.strictEqual(trasAbort.key, claveGuardada);

    // Reintento: vuelve a completar el mismo checkout (mismo producto,
    // mismos datos) y confirma con exito, reusando la misma clave.
    h.click(h.continueBtn());
    h.llenarFormularioValido();
    h.click(h.nextBtn());
    h.click(h.nextBtn());
    await flushAll();

    assert.strictEqual(h.pedidosLlamadas.length, 2);
    assert.strictEqual(h.pedidosLlamadas[1].idempotencyKey, claveGuardada);
    assert.strictEqual(h.view(), 'confirmacion');
  }
);

testAsync('mismo contenido exacto reutiliza la idempotencyKey ya guardada (protege ante recarga/restauracion de pestaña)', async () => {
  const h = crearHarnessControlado(['colgar']);
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  h.click(h.continueBtn());
  h.llenarFormularioValido();
  h.click(h.nextBtn());
  h.click(h.nextBtn());
  await flushAll();

  const primeraKey = h.pedidosLlamadas[0].idempotencyKey;

  // Simula "recargar/restaurar la pestaña": el registro { key, firma } ya
  // quedo persistido en sessionStorage (que sobrevive a una recarga real
  // en un navegador). Se vuelve a intentar el MISMO checkout (volviendo a
  // "revision" sin cambiar ningun dato): debe generar exactamente la misma
  // clave, sin necesidad de que el servidor haya respondido nada todavia.
  h.click(h.backBtn());
  h.click(h.nextBtn());
  h.click(h.nextBtn());
  await flushAll();

  assert.strictEqual(h.pedidosLlamadas.length, 2);
  assert.strictEqual(h.pedidosLlamadas[1].idempotencyKey, primeraKey);
});

testAsync('si el contenido cambia (por ejemplo el email) respecto al intento guardado, se genera una idempotencyKey NUEVA', async () => {
  const h = crearHarnessControlado(['colgar', { ok: true, status: 201, body: { numero: 'P10-000044' } }]);
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  h.click(h.continueBtn());
  h.llenarFormularioValido();
  h.click(h.nextBtn());
  h.click(h.nextBtn());
  await flushAll();
  const primeraKey = h.pedidosLlamadas[0].idempotencyKey;

  h.window.PadelCheckoutWidgetInternal.cancelarSolicitudPendiente();
  h.click(h.backBtn()); // volver a editar
  h.setField('email', 'otro-email-distinto@example.com');
  h.click(h.nextBtn()); // -> revision de nuevo
  h.click(h.nextBtn()); // segundo intento, con datos distintos

  await flushAll();

  assert.strictEqual(h.pedidosLlamadas.length, 2);
  assert.notStrictEqual(h.pedidosLlamadas[1].idempotencyKey, primeraKey);
});

testAsync('un 409 (conflicto de idempotencia) descarta la clave guardada: el proximo intento usa una nueva', async () => {
  const h = crearHarnessControlado([
    { ok: false, status: 409, body: { error: 'conflicto' } },
    { ok: true, status: 201, body: { numero: 'P10-000045' } },
  ]);
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  h.click(h.continueBtn());
  h.llenarFormularioValido();
  h.click(h.nextBtn());
  h.click(h.nextBtn());
  await flushAll();

  assert.strictEqual(h.view(), 'revision');
  assert.ok(/datos cambiaron/i.test(h.body()), 'debe mostrar un mensaje especifico de conflicto');
  assert.strictEqual(h.window.PadelCheckoutWidgetInternal.getIdempotenciaAlmacenada(), null, 'la clave conflictiva se descarta');

  const primeraKey = h.pedidosLlamadas[0].idempotencyKey;
  h.click(h.nextBtn()); // reintento
  await flushAll();

  assert.strictEqual(h.pedidosLlamadas.length, 2);
  assert.notStrictEqual(h.pedidosLlamadas[1].idempotencyKey, primeraKey);
  assert.strictEqual(h.view(), 'confirmacion');
});

testAsync('sesion restaurada: si ya habia una idempotencyKey guardada al iniciar el widget, se muestra un aviso', async () => {
  const dom = new JSDOM(drawerHtml(), { url: 'https://padel10store.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = function (url) {
    if (String(url).indexOf('products.json') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(productsJson) });
    }
    if (String(url).indexOf('/api/checkout-config') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: true }) });
    }
    return Promise.reject(new Error('no mockeado'));
  };
  // Simula que, ANTES de que el widget se inicialice, ya habia quedado una
  // idempotencyKey guardada de un intento anterior sin confirmar (por
  // ejemplo, la pestaña se restauro despues de cerrarse en medio del pago).
  w.sessionStorage.setItem(
    'padel10store:checkoutIdempotencia',
    JSON.stringify({ key: 'a'.repeat(20), firma: 'firma-de-prueba' })
  );

  w.eval(CART_CORE_SRC);
  w.eval(CHECKOUT_FIELDS_SRC);
  w.eval(CART_WIDGET_SRC);
  w.eval(CHECKOUT_AVAILABILITY_SRC);
  w.eval(CHECKOUT_WIDGET_SRC);
  await flushAll();

  assert.strictEqual(w.PadelCheckoutWidgetInternal.tieneSesionPreviaSinConfirmar(), true);

  w.document.getElementById('cartDrawerContinueBtn').disabled = false; // por si el carrito esta vacio en este DOM aislado
  w.PadelCart.addItem(PRODUCT_SIN_TALLE, null, 1);
  await flushAll();
  w.document.getElementById('cartDrawerContinueBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  assert.ok(
    /intento de compra anterior/i.test(w.document.getElementById('cartDrawerBody').innerHTML),
    'debe mostrar el aviso de sesion restaurada en la vista de formulario'
  );
});

// ===========================================================================
// Interruptor de seguridad del checkout (widget/checkout-availability.js):
// con /api/checkout-config respondiendo {enabled:false}, "Continuar con
// mis datos" nunca debe iniciar un pedido, pero el carrito (agregar/quitar
// lineas, ver el total) y "Consultar por WhatsApp" deben seguir
// funcionando exactamente igual.
// ===========================================================================

testAsync('checkout deshabilitado: "Continuar con mis datos" queda deshabilitado aunque el carrito tenga productos', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  assert.strictEqual(h.continueBtn().disabled, true);
});

testAsync('checkout deshabilitado: muestra el mensaje comercial junto a "Continuar con mis datos" cuando hay productos', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  assert.strictEqual(h.checkoutPausedMsg().hidden, false);
  assert.ok(/temporalmente pausada/i.test(h.checkoutPausedMsg().textContent));
});

testAsync('checkout deshabilitado y carrito vacio: no hace falta el mensaje (el boton ya esta deshabilitado por eso)', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withReadyCart(h, []);

  assert.strictEqual(h.continueBtn().disabled, true);
  assert.strictEqual(h.checkoutPausedMsg().hidden, true);
});

testAsync('checkout deshabilitado: clickear "Continuar con mis datos" (por ejemplo, saltandose el atributo disabled) nunca avanza al formulario ni llama a /api/pedidos', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  h.continueBtn().disabled = false; // simula saltear la primera capa de defensa
  h.click(h.continueBtn());

  assert.strictEqual(h.view(), 'carrito');
  assert.ok(!h.fetchCalls.some((u) => String(u).indexOf('/api/pedidos') !== -1));
});

testAsync('checkout deshabilitado: el carrito sigue funcionando (agregar, ver total) sin ninguna restriccion', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withReadyCart(h);

  h.window.PadelCart.addItem(PRODUCT_SIN_TALLE, null, 2);
  await flushAll();

  assert.strictEqual(h.window.PadelCart.getSummary().lineas.length, 1);
  assert.strictEqual(h.window.PadelCart.getSummary().lineas[0].cantidad, 2);
});

testAsync('checkout deshabilitado: "Consultar por WhatsApp" sigue funcionando exactamente igual', async () => {
  const h = createHarness({ checkoutEnabled: false });
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  h.click(h.checkoutBtn());

  assert.strictEqual(h.windowOpenCalls.length, 1);
  assert.ok(h.windowOpenCalls[0].indexOf('wa.me') !== -1);
});

testAsync('checkout habilitado explicitamente (default de esta suite): "Continuar con mis datos" sigue funcionando igual, sin mensaje', async () => {
  const h = createHarness({ checkoutEnabled: true });
  await withReadyCart(h, [{ productId: PRODUCT_SIN_TALLE, talle: null, cantidad: 1 }]);

  assert.strictEqual(h.continueBtn().disabled, false);
  assert.strictEqual(h.checkoutPausedMsg().hidden, true);
  h.click(h.continueBtn());
  assert.strictEqual(h.view(), 'formulario');
});

testAsync('el interruptor puede resolver DESPUES del primer render del drawer: el boton se re-habilita solo, sin recargar', async () => {
  let resolverConfig;
  const dom = new JSDOM(drawerHtml(), { url: 'https://padel10store.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = function (url) {
    if (String(url).indexOf('products.json') !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(productsJson) });
    }
    if (String(url).indexOf('/api/checkout-config') !== -1) {
      return new Promise((resolve) => {
        resolverConfig = resolve;
      });
    }
    return Promise.reject(new Error('no mockeado'));
  };
  w.eval(CART_CORE_SRC);
  w.eval(CHECKOUT_FIELDS_SRC);
  w.eval(CART_WIDGET_SRC);
  w.eval(CHECKOUT_AVAILABILITY_SRC);
  w.eval(CHECKOUT_WIDGET_SRC);
  await flushAll();
  w.PadelCart.addItem(PRODUCT_SIN_TALLE, null, 1);
  await flushAll();

  // La consulta a /api/checkout-config todavia esta pendiente: el boton
  // debe seguir deshabilitado, sin importar que el carrito tenga productos.
  assert.strictEqual(w.document.getElementById('cartDrawerContinueBtn').disabled, true);

  resolverConfig({ ok: true, json: () => Promise.resolve({ enabled: true }) });
  await flushAll();

  assert.strictEqual(w.document.getElementById('cartDrawerContinueBtn').disabled, false);
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
