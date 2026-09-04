'use strict';

/**
 * Pruebas de las 3 paginas ESTATICAS de retorno de Mercado Pago
 * (mercadopago/success.html, pending.html, failure.html), reescritas como
 * parte de la preparacion tecnica para Production.
 *
 * Cubren:
 * - Que ninguna de las 3 siga afirmando algo que ya es falso (que no hay
 *   pedido real, que el webhook no valida el pago, que la confirmacion
 *   "queda para una etapa posterior"): eso describia una etapa anterior,
 *   antes de que api/mercadopago-webhook.js existiera. Hoy el webhook SI
 *   valida el pago y el pedido SI se registra desde api/pedidos.js.
 * - Que las 3 muestren "Gracias por elegir Padel10Store".
 * - Que el badge "Entorno de prueba" nunca aparezca fijo: existe oculto en
 *   el HTML estatico (estas paginas no tienen backend propio, Vercel las
 *   sirve tal cual) y solo se muestra cuando el propio back_url que arma
 *   el servidor (lib/mercadopago-preference.js#buildBackUrls) le agrego
 *   ?mp_env=sandbox - nunca con mp_env=production, nunca sin el parametro,
 *   nunca con un valor arbitrario.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

const PAGES = {
  success: path.join('mercadopago', 'success.html'),
  pending: path.join('mercadopago', 'pending.html'),
  failure: path.join('mercadopago', 'failure.html'),
};

function leerPagina(nombre) {
  return fs.readFileSync(path.join(process.cwd(), PAGES[nombre]), 'utf8');
}

// runScripts: 'dangerously' es seguro aca: el HTML es el propio del repo
// (nunca contenido de un tercero), y es lo que permite que el script
// inline que decide mostrar/ocultar el badge corra de verdad, igual que
// en un navegador real.
function cargarPagina(nombre, query) {
  const html = leerPagina(nombre);
  const url = 'https://padel10store.test/mercadopago/' + nombre + '.html' + (query ? '?' + query : '');
  return new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
}

// --- Textos obsoletos: ver el comentario del archivo ----------------------

const FRASES_OBSOLETAS = [
  'no constituye una compra confirmada',
  'no se validó el pago mediante webhook',
  'no se valido el pago mediante webhook',
  'no descontó stock',
  'no desconto stock',
  'no se registró un pedido real',
  'no se registro un pedido real',
  'no hay ninguna compra confirmada',
  'no hay ningun pedido real registrado',
  'queda pendiente para una etapa posterior',
  'no se realizó ningún cobro real',
  'no se realizo ningun cobro real',
  'pago de prueba aprobado',
  'pago de prueba pendiente',
  'pago de prueba rechazado',
];

Object.keys(PAGES).forEach((nombre) => {
  test(nombre + '.html: no contiene ninguna frase obsoleta sobre "sin pedido real" / "sin webhook"', () => {
    const htmlLower = leerPagina(nombre).toLowerCase();
    FRASES_OBSOLETAS.forEach((frase) => {
      assert.ok(!htmlLower.includes(frase), nombre + '.html no deberia contener "' + frase + '"');
    });
  });

  test(nombre + '.html: muestra "Gracias por elegir Padel10Store"', () => {
    assert.ok(leerPagina(nombre).includes('Gracias por elegir Padel10Store'));
  });

  test(nombre + '.html: el badge de "Entorno de prueba" existe pero esta oculto por defecto en el HTML estatico', () => {
    const html = leerPagina(nombre);
    const match = html.match(/<div class="badge" id="envBadge"([^>]*)>/);
    assert.ok(match, 'debe existir el elemento #envBadge');
    assert.ok(/\bhidden\b/.test(match[1]), 'el badge debe estar hidden en el markup estatico (nunca fijo)');
    assert.ok(html.includes('Entorno de prueba'));
  });

  test(nombre + '.html: SIN ?mp_env en la URL, el badge de sandbox se mantiene oculto', () => {
    const dom = cargarPagina(nombre, null);
    const badge = dom.window.document.getElementById('envBadge');
    assert.ok(badge, 'debe existir el elemento #envBadge en el DOM');
    assert.strictEqual(badge.hidden, true);
  });

  test(nombre + '.html: con ?mp_env=production, el badge de sandbox se mantiene oculto (nunca se muestra en produccion)', () => {
    const dom = cargarPagina(nombre, 'mp_env=production');
    const badge = dom.window.document.getElementById('envBadge');
    assert.strictEqual(badge.hidden, true);
  });

  test(nombre + '.html: con ?mp_env=sandbox, el badge de "Entorno de prueba" se muestra', () => {
    const dom = cargarPagina(nombre, 'mp_env=sandbox');
    const badge = dom.window.document.getElementById('envBadge');
    assert.strictEqual(badge.hidden, false);
  });

  test(nombre + '.html: con un valor arbitrario de mp_env (ni sandbox ni production), el badge se mantiene oculto', () => {
    const dom = cargarPagina(nombre, 'mp_env=algo-inventado');
    const badge = dom.window.document.getElementById('envBadge');
    assert.strictEqual(badge.hidden, true);
  });
});

// --- Contenido especifico de cada pagina -----------------------------------

test('success.html: explica que Mercado Pago informo la aprobacion y que la confirmacion es mediante validacion segura', () => {
  const html = leerPagina('success').toLowerCase();
  assert.ok(html.includes('aprobado'));
  assert.ok(html.includes('validación segura') || html.includes('validacion segura'));
  assert.ok(html.includes('registr'), 'debe mencionar que el pedido ya quedo registrado');
});

test('pending.html: explica que el pedido esta registrado y espera acreditacion', () => {
  const html = leerPagina('pending').toLowerCase();
  assert.ok(html.includes('pendiente'));
  assert.ok(html.includes('acreditación') || html.includes('acreditacion'));
  assert.ok(html.includes('registr'), 'debe mencionar que el pedido ya quedo registrado');
});

test('failure.html: explica que el pago no se completo, invita a reintentar, y NUNCA asegura que el pedido fue cancelado', () => {
  const htmlLower = leerPagina('failure').toLowerCase();
  assert.ok(htmlLower.includes('no se completó') || htmlLower.includes('no se completo'));
  assert.ok(htmlLower.includes('volver a intentar'));
  // Nunca debe presentar como un HECHO ASEGURADO que el pedido interno
  // quedo cancelado o que no hubo ningun cobro: solo puede describir lo
  // que Mercado Pago informo sobre el intento de pago.
  assert.ok(!htmlLower.includes('no hay ninguna compra confirmada'));
  assert.ok(!htmlLower.includes('pedido fue cancelado'));
  assert.ok(!htmlLower.includes('se cancelo tu pedido'));
  assert.ok(!htmlLower.includes('se canceló tu pedido'));
  assert.ok(htmlLower.includes('no podemos asegurar'));
});

// --- Runner ------------------------------------------------------------

function run() {
  const resultados = results.map(({ name, fn }) => {
    try {
      fn();
      return { name, pass: true };
    } catch (error) {
      return { name, pass: false, error: error.message };
    }
  });

  const failed = resultados.filter((r) => !r.pass);
  resultados.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
  });
  console.log('');
  console.log('Pruebas de las paginas de retorno de Mercado Pago: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
