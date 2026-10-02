'use strict';

/**
 * Pruebas de la preparacion para el lanzamiento publico:
 * - enlaces sin destino (#), categorias vacias ocultas, busqueda real;
 * - datos del vendedor (lib/store-info.js) y paginas legales;
 * - envio "a confirmar" en el checkout (widget/padel-checkout.js +
 *   lib/padel-shipping.js);
 * - medicion GA4 / Meta (widget/padel-analytics.js) y parametros UTM;
 * - paginas de retorno de Mercado Pago (mercadopago/retorno.js).
 *
 * Usa jsdom con los mismos archivos reales que carga el navegador, en el
 * mismo orden que index.html.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const leer = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const INDEX_HTML = leer('index.html');
const productsJson = JSON.parse(leer('products.json'));

const SCRIPTS_DEFER = [
  'lib/store-info.js',
  'lib/padel-cart.js',
  'lib/padel-checkout-fields.js',
  'lib/padel-shipping.js',
  'widget/padel-cart.js',
  'widget/checkout-availability.js',
  'widget/padel-checkout.js',
  'widget/mercadopago-buy.js',
  'lib/analytics-config.js',
  'widget/padel-analytics.js',
];

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

function flushAll() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function crearIndex(opts) {
  const o = opts || {};
  const dom = new JSDOM(INDEX_HTML, {
    url: 'https://padel10store.test/' + (o.query || ''),
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;
  const pedidosResponses = (o.pedidosResponses || []).slice();
  w.fetch = function (url) {
    const u = String(url);
    if (u.indexOf('products.json') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve(productsJson) });
    if (u.indexOf('/api/checkout-config') !== -1) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ enabled: o.checkoutEnabled !== false }) });
    }
    if (u.indexOf('/api/pedidos') !== -1) {
      const next = pedidosResponses.shift() || { ok: true, status: 201, body: { numero: 'P10-000777', redirectUrl: null, envioAConfirmar: true } };
      return Promise.resolve({ ok: next.ok, status: next.status, json: () => Promise.resolve(next.body) });
    }
    return Promise.reject(new Error('fetch no mockeado: ' + u));
  };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const canvas = d.getElementById('hCanvas');
  if (canvas) canvas.getContext = () => new Proxy({}, { get: () => () => {} });
  w.open = function (url) { (w.__abiertas = w.__abiertas || []).push(url); return null; };
  if (o.analyticsConfig) w.PadelAnalyticsConfig = o.analyticsConfig;

  const inline = Array.from(d.querySelectorAll('script')).find((s) => !s.src && s.textContent.indexOf('function openModal') !== -1);
  w.eval(inline.textContent);
  SCRIPTS_DEFER.forEach((rel) => {
    if (rel === 'lib/analytics-config.js' && o.analyticsConfig) return; // la prueba fija sus propios IDs
    w.eval(leer(rel));
  });
  // Si jsdom todavia no termino de parsear, se espera su propio
  // DOMContentLoaded (igual que el navegador); si ya paso, se dispara uno
  // solo a mano. Nunca los dos: inicializaria los widgets dos veces.
  if (d.readyState === 'loading') {
    await new Promise((resolve) => d.addEventListener('DOMContentLoaded', resolve));
  } else {
    d.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  }
  return { dom, w, d };
}

function visibles(d) {
  return Array.from(d.querySelectorAll('.main-wrap .card')).filter((c) => c.style.display !== 'none');
}

// --- enlaces y categorias -------------------------------------------------

test('index.html y las paginas legales no tienen enlaces vacios (href="#")', () => {
  const archivos = ['index.html'].concat(fs.readdirSync(path.join(ROOT, 'legal')).filter((f) => f.endsWith('.html')).map((f) => 'legal/' + f));
  archivos.forEach((rel) => {
    assert.ok(!/href="#"/.test(leer(rel)), rel + ' tiene un href="#"');
    assert.ok(!/href=""/.test(leer(rel)), rel + ' tiene un href vacio');
  });
});

test('las paginas legales enlazadas desde el pie existen', () => {
  const hrefs = Array.from(INDEX_HTML.matchAll(/href="(legal\/[^"]+)"/g)).map((m) => m[1]);
  assert.ok(hrefs.length >= 6);
  hrefs.forEach((h) => assert.ok(fs.existsSync(path.join(ROOT, h)), 'falta ' + h));
});

test('Calzado y Ofertas (sin productos) quedan ocultas; el resto de las categorias sigue visible', async () => {
  const { d } = await crearIndex();
  await flushAll();
  const nav = (f) => d.querySelector('.nav-cat[data-filter="' + f + '"]');
  assert.strictEqual(nav('calzado').hidden, true, 'calzado');
  assert.strictEqual(nav('ofertas').hidden, true, 'ofertas');
  ['paletas', 'ropa', 'Accesorios'].forEach((f) => assert.strictEqual(nav(f).hidden, false, 'nav ' + f));
  Array.from(d.querySelectorAll('.cats .cat')).forEach((c) => assert.strictEqual(c.hidden, false, c.dataset.cat));
  assert.strictEqual(d.getElementById('modalCat').hidden, false, 'la etiqueta de categoria de la ficha no es un filtro');
});

test('la busqueda filtra el catalogo por nombre (sin importar tildes ni mayusculas)', async () => {
  const { w, d } = await crearIndex();
  await flushAll();
  const input = d.getElementById('heroSearchInput');
  input.value = 'calavera';
  d.getElementById('heroSearchForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  const vis = visibles(d);
  assert.ok(vis.length > 0);
  vis.forEach((c) => assert.ok(/calavera/i.test(c.querySelector('.card-name').textContent)));
  assert.strictEqual(d.getElementById('catalogEmptyState').hidden, true);

  input.value = 'zzzz-no-existe';
  d.getElementById('heroSearchForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.strictEqual(visibles(d).length, 0);
  assert.strictEqual(d.getElementById('catalogEmptyState').hidden, false);
  assert.ok(/zzzz-no-existe/.test(d.getElementById('catalogEmptyTitle').textContent));

  d.querySelector('.cat[data-cat="all"]').click();
  assert.strictEqual(visibles(d).length, 81);
});

test('los enlaces de productos del pie filtran el catalogo', async () => {
  const { d } = await crearIndex();
  await flushAll();
  d.querySelector('[data-footer-filter="Accesorios"]').click();
  const vis = visibles(d);
  assert.ok(vis.length > 0);
  vis.forEach((c) => assert.strictEqual(c.dataset.cat, 'Accesorios'));
});

// --- datos del vendedor ---------------------------------------------------

test('datos del vendedor: los faltantes se muestran como pendientes y no se inventan', async () => {
  const { d } = await crearIndex();
  await flushAll();
  ['razonSocial', 'cuit', 'domicilio', 'email'].forEach((campo) => {
    const el = d.querySelector('.footer-seller [data-store="' + campo + '"]');
    assert.strictEqual(el.textContent, 'Pendiente de completar', campo);
    assert.ok(el.classList.contains('store-pending'));
  });
  assert.strictEqual(d.querySelector('[data-store="nombreComercial"]').textContent, 'Padel10Store');
  assert.strictEqual(d.querySelector('[data-store-href="email"]').hidden, true);
  assert.strictEqual(d.querySelector('[data-store-href="instagram"]').hidden, true);
  assert.ok(/^https:\/\/wa\.me\/5493413637355/.test(d.querySelector('.footer-col [data-store-href="whatsapp"]').href));
  assert.ok(d.querySelector('a[href="legal/arrepentimiento.html"]'), 'el boton de arrepentimiento debe estar en la pagina de inicio');
});

test('lib/store-info.js: ningun dato legal tiene un valor inventado', () => {
  const info = require('../lib/store-info').INFO;
  ['razonSocial', 'cuit', 'condicionIva', 'domicilio', 'email', 'instagramUrl', 'horarioAtencion'].forEach((k) => {
    assert.strictEqual(info[k], null, k + ' debe seguir en null hasta que el vendedor lo confirme');
  });
});

// --- envio en el checkout -------------------------------------------------

async function irARevision(w, d) {
  w.PadelCart.addItem('royal-padel-aniversario-36', null, 1);
  await flushAll();
  d.getElementById('cartDrawerContinueBtn').click();
  const valores = {
    nombre: 'Juana', apellido: 'Perez', email: 'juana@example.com', telefono: '3411234567',
    provincia: 'Santa Fe', localidad: 'Rosario', codigoPostal: '2000', calle: 'San Martin', numero: '1234',
  };
  Object.keys(valores).forEach((k) => {
    const el = d.querySelector('[data-field="' + k + '"]');
    el.value = valores[k];
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  d.getElementById('cartDrawerNextBtn').click();
}

test('checkout con envio sin tarifa: muestra "A confirmar", total sin envio y no promete un cobro', async () => {
  const { w, d } = await crearIndex();
  await flushAll();
  assert.ok(/no está incluido/i.test(d.getElementById('cartShippingNote').textContent));
  await irARevision(w, d);
  const body = d.getElementById('cartDrawerBody');
  assert.ok(/A confirmar/.test(body.querySelector('[data-checkout-line="envio"]').textContent));
  assert.ok(/Total sin envío/.test(body.querySelector('[data-checkout-line="total"]').textContent));
  assert.ok(/\$256\.500/.test(body.querySelector('[data-checkout-line="total"]').textContent));
  assert.ok(body.querySelector('.checkout-shipping-note'));
  assert.strictEqual(d.getElementById('cartDrawerNextBtn').textContent, 'Registrar pedido sin pagar');
});

test('checkout con envio a confirmar: la confirmacion explica el proximo paso y ofrece WhatsApp con el numero', async () => {
  const { w, d } = await crearIndex();
  await flushAll();
  await irARevision(w, d);
  d.getElementById('cartDrawerNextBtn').click();
  await flushAll();
  const body = d.getElementById('cartDrawerBody');
  assert.ok(/P10-000777/.test(body.textContent));
  assert.ok(/no se realizó ningún cobro/i.test(body.textContent));
  assert.ok(/costo de envío y disponibilidad/i.test(body.textContent));
  const wa = body.querySelector('a[href^="https://wa.me/5493413637355"]');
  assert.ok(wa && /P10-000777/.test(decodeURIComponent(wa.href)));
  assert.ok(!body.querySelector('[data-action="retry-payment"]'), 'sin envio confirmado no hay boton de pago');
});

// --- medicion -------------------------------------------------------------

test('sin IDs configurados no se carga ninguna etiqueta de Google ni de Meta', async () => {
  const { w, d } = await crearIndex();
  await flushAll();
  assert.strictEqual(w.PadelAnalytics.activo, false);
  assert.strictEqual(typeof w.gtag, 'undefined');
  assert.strictEqual(typeof w.fbq, 'undefined');
  const externos = Array.from(d.querySelectorAll('script[src]')).map((s) => s.src).filter((s) => /googletagmanager|facebook/.test(s));
  assert.deepStrictEqual(externos, []);
});

test('la configuracion publicada no trae IDs inventados', () => {
  assert.deepStrictEqual(require('../lib/analytics-config'), { ga4MeasurementId: null, metaPixelId: null });
});

test('IDs con formato invalido no activan las etiquetas', async () => {
  const { w } = await crearIndex({ analyticsConfig: { ga4MeasurementId: 'UA-123', metaPixelId: 'abc' } });
  await flushAll();
  assert.strictEqual(w.PadelAnalytics.activo, false);
});

test('UTM de la URL de llegada se conservan durante la visita', async () => {
  const { w } = await crearIndex({ query: '?utm_source=instagram&utm_medium=paid&utm_campaign=lanzamiento&fbclid=abc' });
  await flushAll();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(w.PadelAnalytics.getAtribucion())), {
    utm_source: 'instagram', utm_medium: 'paid', utm_campaign: 'lanzamiento', fbclid: 'abc',
  });
  const guardado = JSON.parse(w.sessionStorage.getItem('padel10store:atribucion'));
  assert.strictEqual(guardado.params.utm_campaign, 'lanzamiento');
});

test('con IDs validos: ver producto, agregar al carrito e iniciar compra se envian a GA4 y Meta', async () => {
  const { w, d } = await crearIndex({
    analyticsConfig: { ga4MeasurementId: 'G-TEST12345', metaPixelId: '1234567890' },
    query: '?utm_source=meta&utm_campaign=prueba',
  });
  await flushAll();
  assert.strictEqual(w.PadelAnalytics.ga4Activo, true);
  assert.strictEqual(w.PadelAnalytics.metaActivo, true);
  const ga = () => w.dataLayer.filter((a) => a[0] === 'event').map((a) => a[1]);
  const meta = () => w.fbq.queue.filter((a) => a[0] === 'track').map((a) => a[1]);

  w.openModal(d.querySelector('.card[data-product-id="royal-padel-aniversario-36"]'));
  assert.ok(ga().includes('view_item'));
  assert.ok(meta().includes('ViewContent'));
  const viewItem = w.dataLayer.find((a) => a[0] === 'event' && a[1] === 'view_item')[2];
  assert.strictEqual(viewItem.currency, 'ARS');
  assert.strictEqual(viewItem.items[0].item_id, 'royal-padel-aniversario-36');

  d.getElementById('modalBuyBtn').click();
  assert.ok(ga().includes('add_to_cart'));
  assert.ok(meta().includes('AddToCart'));

  d.getElementById('cartDrawerContinueBtn').click();
  assert.ok(ga().includes('begin_checkout'));
  assert.ok(meta().includes('InitiateCheckout'));
  const begin = w.dataLayer.find((a) => a[0] === 'event' && a[1] === 'begin_checkout')[2];
  assert.strictEqual(begin.utm_campaign, 'prueba');
});

test('nunca se envian datos personales del comprador a las plataformas de medicion', async () => {
  const { w, d } = await crearIndex({ analyticsConfig: { ga4MeasurementId: 'G-TEST12345', metaPixelId: '1234567890' } });
  await flushAll();
  await irARevision(w, d);
  d.getElementById('cartDrawerNextBtn').click();
  await flushAll();
  const enviado = JSON.stringify(w.dataLayer) + JSON.stringify(w.fbq.queue);
  ['juana@example.com', '3411234567', 'San Martin', 'Perez'].forEach((dato) => {
    assert.ok(enviado.indexOf(dato) === -1, 'se filtro un dato personal: ' + dato);
  });
});

// --- paginas de retorno de Mercado Pago ------------------------------------

async function crearRetorno(nombre, query, pedido, analyticsConfig) {
  const dom = new JSDOM(leer('mercadopago/' + nombre + '.html'), {
    url: 'https://padel10store.test/mercadopago/' + nombre + '.html' + (query || ''),
    runScripts: 'outside-only',
  });
  const w = dom.window;
  if (pedido) w.sessionStorage.setItem('padel10store:pedidoEnPago', JSON.stringify(pedido));
  w.PadelAnalyticsConfig = analyticsConfig || { ga4MeasurementId: null, metaPixelId: null };
  w.eval(leer('widget/padel-analytics.js'));
  w.eval(leer('mercadopago/retorno.js'));
  if (w.document.readyState === 'loading') {
    await new Promise((resolve) => w.document.addEventListener('DOMContentLoaded', resolve));
  }
  return w;
}

const PEDIDO = { numero: 'P10-000321', subtotal: 256500, envio: 0, total: 256500, items: [{ productId: 'royal-padel-aniversario-36', nombre: 'Aniversario 36', cantidad: 1, precio: 256500 }] };

test('retorno: muestra el numero de pedido y arma WhatsApp con ese numero', async () => {
  const w = await crearRetorno('failure', '?status=rejected', PEDIDO);
  const d = w.document;
  assert.strictEqual(d.getElementById('pedidoNumeroBox').hidden, false);
  assert.strictEqual(d.getElementById('pedidoNumero').textContent, 'P10-000321');
  assert.ok(/P10-000321/.test(decodeURIComponent(d.getElementById('retornoWhatsapp').href)));
});

test('retorno: la compra confirmada se mide una sola vez y solo con pago aprobado', async () => {
  const cfg = { ga4MeasurementId: 'G-TEST12345', metaPixelId: '1234567890' };
  const w = await crearRetorno('success', '?status=approved&payment_id=999', PEDIDO, cfg);
  const compras = w.dataLayer.filter((a) => a[0] === 'event' && a[1] === 'purchase');
  assert.strictEqual(compras.length, 1);
  assert.strictEqual(compras[0][2].transaction_id, 'P10-000321');
  assert.strictEqual(compras[0][2].value, 256500);
  assert.ok(w.fbq.queue.some((a) => a[0] === 'track' && a[1] === 'Purchase'));
  // recargar la pagina no vuelve a medir la misma compra
  w.PadelAnalytics.track('compra_confirmada', { transactionId: 'P10-000321', total: 256500, items: [] });
  assert.strictEqual(w.dataLayer.filter((a) => a[0] === 'event' && a[1] === 'purchase').length, 1);

  const w2 = await crearRetorno('pending', '?status=pending', PEDIDO, cfg);
  assert.strictEqual(w2.dataLayer.filter((a) => a[0] === 'event' && a[1] === 'purchase').length, 0);
});

// --- arrepentimiento ------------------------------------------------------

test('boton de arrepentimiento: valida el numero de pedido y abre WhatsApp con la solicitud', () => {
  const dom = new JSDOM(leer('legal/arrepentimiento.html'), { url: 'https://padel10store.test/legal/arrepentimiento.html', runScripts: 'outside-only' });
  const w = dom.window;
  const d = w.document;
  const abiertas = [];
  w.open = (u) => { abiertas.push(u); return null; };
  w.eval(leer('lib/store-info.js'));
  Array.from(d.querySelectorAll('script')).filter((s) => !s.src).forEach((s) => w.eval(s.textContent));
  const form = d.getElementById('arrepentimientoForm');
  const campo = (id) => d.getElementById(id);
  campo('arrNumero').value = '123';
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.strictEqual(abiertas.length, 0);
  assert.ok(/P10-000123/.test(d.getElementById('arrError').textContent));
  campo('arrNumero').value = 'p10-000123';
  campo('arrNombre').value = 'Juana Perez';
  campo('arrContacto').value = '3411234567';
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.strictEqual(abiertas.length, 1);
  const texto = decodeURIComponent(abiertas[0]);
  assert.ok(texto.indexOf('https://wa.me/5493413637355') === 0);
  assert.ok(/ARREPENTIMIENTO/.test(texto) && /P10-000123/.test(texto));
});

// --- promesas no confirmadas ------------------------------------------------

test('el sitio no promete envio gratis, stock disponible ni entregas en 24 horas', () => {
  const textos = [INDEX_HTML].concat(fs.readdirSync(path.join(ROOT, 'legal')).filter((f) => f.endsWith('.html')).map((f) => leer('legal/' + f)));
  textos.forEach((html) => {
    // Solo el texto visible: los mensajes de WhatsApp que el comprador
    // envia ("quiero confirmar stock disponible") son preguntas, no promesas.
    const plano = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').toLowerCase();
    ['envío gratis', 'envio gratis', 'stock disponible', 'en stock', 'entrega en 24', '24 horas hábiles'].forEach((frase) => {
      assert.ok(plano.indexOf(frase) === -1, 'promesa no confirmada: "' + frase + '"');
    });
  });
});

// --- Runner ---------------------------------------------------------------

(async () => {
  const salida = [];
  for (const { name, fn } of results) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      salida.push({ name, pass: true });
    } catch (error) {
      salida.push({ name, pass: false, error: error.message });
    }
  }
  const failed = salida.filter((r) => !r.pass);
  salida.forEach((r) => console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : '')));
  console.log('');
  console.log('Pruebas de lanzamiento publico: ' + (salida.length - failed.length) + '/' + salida.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
})();
