'use strict';

/**
 * Guardas de regresion para la Etapa de correccion responsive/mobile
 * (rama asesor-ia-padel10store): menu hamburguesa del nav, buscador
 * flexible y footer apilado en pantallas angostas.
 *
 * Como el resto de la suite, estas son pruebas ESTRUCTURALES: usan jsdom
 * para parsear el DOM real y el CSSOM real de index.html (cssRules), sin
 * levantar un navegador. jsdom no tiene motor de layout, por lo que NO
 * puede medir overflow horizontal en pixeles: esa verificacion (scrollWidth
 * vs clientWidth en 1366x768, 1024x768, 768x1024, 430x932, 390x844 y
 * 360x800) se hizo a mano con un navegador real durante esta etapa, igual
 * que documenta scripts/verify-comparator-browser.js para el comparador.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

const ROOT = process.cwd();

function leerArchivo(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

const html = leerArchivo('index.html');
const dom = new JSDOM(html);
const doc = dom.window.document;

function allRules() {
  const out = [];
  function walk(rules) {
    for (const r of Array.from(rules)) {
      if (r.type === 4 /* CSSMediaRule */ && r.cssRules) {
        walk(r.cssRules);
      } else {
        out.push(r);
      }
    }
  }
  for (const sheet of Array.from(doc.styleSheets)) {
    walk(sheet.cssRules);
  }
  return out;
}

function findMediaRule(maxWidthNeedle) {
  for (const sheet of Array.from(doc.styleSheets)) {
    for (const r of Array.from(sheet.cssRules)) {
      if (r.type === 4 && r.conditionText && r.conditionText.replace(/\s+/g, '').includes(maxWidthNeedle.replace(/\s+/g, ''))) {
        return r;
      }
    }
  }
  return null;
}

function rulesOf(mediaRule, selector) {
  if (!mediaRule) return [];
  return Array.from(mediaRule.cssRules).filter((r) => r.selectorText === selector);
}

// --- 1. boton hamburguesa presente y conectado por aria-controls ---

test('el boton #navToggle existe con aria-controls apuntando a #navLinks', () => {
  const toggle = doc.getElementById('navToggle');
  assert.ok(toggle, 'debe existir un elemento con id="navToggle"');
  assert.strictEqual(toggle.tagName, 'BUTTON', '#navToggle debe ser un <button>');
  assert.strictEqual(toggle.getAttribute('aria-controls'), 'navLinks', 'aria-controls debe apuntar a "navLinks"');
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false', 'aria-expanded debe arrancar en "false"');

  const links = doc.getElementById('navLinks');
  assert.ok(links, 'debe existir el contenedor de links con id="navLinks"');
  assert.ok(links.classList.contains('nav-links'), '#navLinks debe conservar la clase .nav-links');
});

// --- 2. el menu mobile colapsa via CSS con un breakpoint <=900px, sin overflow-x:hidden ---

test('existe un breakpoint mobile que oculta .nav-links/.nav-search y los muestra con nav.nav-open', () => {
  const navMedia = findMediaRule('max-width:860px');
  assert.ok(navMedia, 'debe existir un @media (max-width:860px) para colapsar el nav en mobile');

  const maxWidthNum = parseInt((navMedia.conditionText.match(/(\d+)/) || [])[1], 10);
  assert.ok(maxWidthNum >= 700 && maxWidthNum <= 1024, `el breakpoint del nav (${maxWidthNum}px) deberia estar entre 700 y 1024px (768/1024 sin overflow, colapsa en 768 e inferiores)`);

  const toggleShown = rulesOf(navMedia, '.nav-toggle').some((r) => /display:\s*flex/.test(r.style.cssText));
  assert.ok(toggleShown, 'en mobile, .nav-toggle debe volverse visible (display:flex)');

  const linksHiddenByDefault = rulesOf(navMedia, '.nav-links').some((r) => /display:\s*none/.test(r.style.cssText));
  assert.ok(linksHiddenByDefault, 'en mobile, .nav-links debe estar oculto por defecto (display:none)');

  const linksShownWhenOpen = rulesOf(navMedia, 'nav.nav-open .nav-links').some((r) => /display:\s*flex/.test(r.style.cssText));
  assert.ok(linksShownWhenOpen, 'nav.nav-open .nav-links debe volver a mostrarse (display:flex) cuando el menu esta abierto');

  const searchHiddenByDefault = rulesOf(navMedia, '.nav-search').some((r) => /display:\s*none/.test(r.style.cssText));
  assert.ok(searchHiddenByDefault, 'en mobile, .nav-search tambien debe formar parte del menu colapsable (display:none por defecto)');

  const searchShownWhenOpen = rulesOf(navMedia, 'nav.nav-open .nav-search').some((r) => /display:\s*flex/.test(r.style.cssText));
  assert.ok(searchShownWhenOpen, 'nav.nav-open .nav-search debe volver a mostrarse cuando el menu esta abierto');
});

// --- 3. el buscador tiene ancho fijo en desktop pero flexible en mobile ---

test('.nav-search input mantiene width:150px en desktop y se vuelve flexible en mobile', () => {
  const desktopInputRules = allRules().filter((r) => r.selectorText === '.nav-search input' && !r.parentRule);
  assert.ok(
    desktopInputRules.some((r) => /width:\s*150px/.test(r.style.cssText)),
    'la regla base (desktop) de .nav-search input debe conservar width:150px'
  );

  const navMedia = findMediaRule('max-width:860px');
  const mobileInputRules = rulesOf(navMedia, '.nav-search input');
  assert.ok(
    mobileInputRules.some((r) => /width:\s*100%/.test(r.style.cssText)),
    'en mobile, .nav-search input debe adaptarse al ancho disponible (width:100%) en vez de quedar fijo en 150px'
  );
});

// --- 4. el footer se apila a una sola columna en mobile, sin perder el grid de desktop ---

test('.footer-top usa grid de 3 columnas en desktop y colapsa a 1 columna en mobile', () => {
  const desktopFooterRules = allRules().filter((r) => r.selectorText === '.footer-top');
  assert.ok(
    desktopFooterRules.some((r) => /grid-template-columns:\s*2fr 1fr 1fr/.test(r.style.cssText)),
    'la regla base (desktop) de .footer-top debe conservar grid-template-columns:2fr 1fr 1fr'
  );

  let mobileFooterMedia = null;
  for (const sheet of Array.from(doc.styleSheets)) {
    for (const r of Array.from(sheet.cssRules)) {
      if (r.type === 4 && r.conditionText) {
        const hit = Array.from(r.cssRules).some((rr) => rr.selectorText === '.footer-top');
        if (hit) mobileFooterMedia = r;
      }
    }
  }
  assert.ok(mobileFooterMedia, 'debe existir un @media que redefina .footer-top para pantallas angostas');
  const mobileFooterRules = rulesOf(mobileFooterMedia, '.footer-top');
  assert.ok(
    mobileFooterRules.some((r) => /grid-template-columns:\s*1fr\s*(;|$)/.test(r.style.cssText + ';')),
    'en mobile, .footer-top debe colapsar a una sola columna (grid-template-columns:1fr)'
  );
});

// --- 5. no se uso overflow-x:hidden como parche sobre html/body/nav/footer ---

test('no se usa overflow-x:hidden (ni overflow:hidden) como parche en html, body, nav o footer', () => {
  const forbidden = ['html', 'body', 'nav', 'footer', '.nav-links', '.footer-top'];
  for (const r of allRules()) {
    if (!r.selectorText) continue;
    const selectors = r.selectorText.split(',').map((s) => s.trim());
    const touchesForbidden = selectors.some((s) => forbidden.includes(s));
    if (!touchesForbidden) continue;
    const cssText = r.style.cssText || '';
    assert.ok(
      !/overflow(-x)?:\s*hidden/.test(cssText),
      `la regla "${r.selectorText}" no deberia usar overflow(-x):hidden para tapar el overflow (se pidio corregir la causa real, no esconderla)`
    );
  }
});

// --- 6. el JS del toggle esta presente y conectado ---

test('el script del menu mobile conecta click en #navToggle con la clase nav-open', () => {
  assert.ok(html.includes("getElementById('navToggle')"), 'el script debe buscar #navToggle por id');
  assert.ok(html.includes("classList.add('nav-open')"), 'el script debe agregar la clase nav-open al abrir');
  assert.ok(html.includes("classList.remove('nav-open')"), 'el script debe quitar la clase nav-open al cerrar');
  assert.ok(html.includes("addEventListener('click'"), 'el toggle debe reaccionar a un evento click');
});

// --- Runner --------------------------------------------------------------

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
  console.log('Guardas responsive: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
