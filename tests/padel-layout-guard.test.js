'use strict';

/**
 * Guardas de regresion para el layout global de index.html, agregadas tras
 * reparar la regresion de la rama asesor-ia-padel10store (bug "hh" que
 * rompia .nav-links, </div> sobrante antes de <footer>, boton flotante de
 * WhatsApp ausente). Son pruebas ESTATICAS: leen index.html del disco, sin
 * levantar navegador ni tocar red/DB.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

const ROOT = process.cwd();

function leerArchivo(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// --- 1. .nav-links no debe quedar precedido por basura de selector (bug "hh") ---

test('.nav-links{display:flex;gap:24px} existe y no esta precedido por texto suelto', () => {
  const html = leerArchivo('index.html');
  assert.ok(
    html.includes('.nav-links{display:flex;gap:24px}'),
    'la regla .nav-links debe declarar display:flex;gap:24px sin corrupcion'
  );
  const idx = html.indexOf('.nav-links{');
  assert.ok(idx !== -1, 'debe existir el selector .nav-links{...}');
  let i = idx - 1;
  while (i >= 0 && /\s/.test(html[i])) i--;
  assert.ok(i >= 0, 'no se encontro contenido antes de .nav-links{');
  assert.strictEqual(
    html[i],
    '}',
    '.nav-links{ deberia estar precedido (salvo espacios) por el "}" de la regla anterior; ' +
      `se encontro "${html[i]}" - posible texto suelto tipo "hh" pegado al selector`
  );
});

// --- 2. no debe existir un </div> sobrante inmediatamente antes de <footer> ---
// Estructuralmente, justo antes de <footer> deben cerrarse exactamente 3
// contenedores anidados y legitimos (la card del ultimo producto, el grid
// de la seccion y el .main-wrap). El bug de la regresion agregaba un
// </div> extra (4 en vez de 3).

test('antes de <footer> se cierran exactamente los 3 </div> legitimos (card, grid, main-wrap), sin uno sobrante', () => {
  const html = leerArchivo('index.html');
  const footerIdx = html.indexOf('<footer>');
  assert.ok(footerIdx !== -1, 'debe existir <footer>');
  const before = html.slice(0, footerIdx);
  const runMatch = before.match(/(?:<\/div>\s*)+$/);
  assert.ok(runMatch, 'debe haber al menos un </div> inmediatamente antes de <footer>');
  const divCloseCount = (runMatch[0].match(/<\/div>/g) || []).length;
  assert.strictEqual(
    divCloseCount,
    3,
    'se esperaban exactamente 3 </div> consecutivos antes de <footer> (cierre de card, grid y main-wrap); ' +
      `se encontraron ${divCloseCount}`
  );
});

// --- 3. el boton flotante global de WhatsApp esta presente y no duplica logica ---

test('el boton flotante global de WhatsApp (#waFloatBtn) esta presente y es unico', () => {
  const html = leerArchivo('index.html');
  const idMatches = html.match(/id="waFloatBtn"/g) || [];
  assert.strictEqual(idMatches.length, 1, 'debe existir exactamente un elemento con id="waFloatBtn"');

  const hrefMatch = html.match(/id="waFloatBtn"[^>]*href="(https:\/\/wa\.me\/\d+[^"]*)"/);
  assert.ok(hrefMatch, 'el boton #waFloatBtn debe tener un href valido de wa.me');

  assert.ok(
    /\.wa-float\{[^}]*position:fixed/.test(html),
    'debe existir el estilo .wa-float con position:fixed para el boton flotante'
  );

  const totalWaLinks = (html.match(/wa\.me\//g) || []).length;
  assert.ok(
    totalWaLinks >= 2,
    'debe haber al menos 2 referencias a wa.me (boton flotante nuevo + logica existente del modal/asesor)'
  );
});

// --- 4. las secciones posteriores a "Palas Polivalentes" siguen dentro de .main-wrap ---

test('"Palas Niños y Recreativas" (seccion siguiente a Polivalentes) sigue dentro del mismo .main-wrap', () => {
  const html = leerArchivo('index.html');

  const polIdx = html.indexOf('Palas Polivalentes');
  assert.ok(polIdx !== -1, 'debe existir la seccion "Palas Polivalentes"');

  const ninosIdx = html.indexOf('Palas Niños y Recreativas');
  assert.ok(ninosIdx !== -1, 'debe existir la seccion "Palas Niños y Recreativas"');
  assert.ok(ninosIdx > polIdx, '"Palas Niños y Recreativas" debe aparecer despues de "Palas Polivalentes" en el documento');

  const wrapOpenRe = /<div class="main-wrap"[^>]*>/g;
  let match;
  let wrapStart = -1;
  while ((match = wrapOpenRe.exec(html)) !== null) {
    if (match.index > polIdx) break;
    wrapStart = match.index;
  }
  assert.ok(wrapStart !== -1, 'no se encontro el .main-wrap que contiene a "Palas Polivalentes"');

  const tagRe = /<div\b[^>]*>|<\/div>/gi;
  tagRe.lastIndex = wrapStart;
  let depth = 0;
  let closeIdx = -1;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].toLowerCase().startsWith('<div')) depth++;
    else depth--;
    if (depth === 0) {
      closeIdx = m.index;
      break;
    }
  }
  assert.ok(closeIdx !== -1, 'no se pudo encontrar el cierre balanceado del .main-wrap (estructura de <div> rota)');
  assert.ok(
    ninosIdx < closeIdx,
    '"Palas Niños y Recreativas" debe quedar dentro del mismo .main-wrap que "Palas Polivalentes", no fuera del contenedor'
  );
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
  console.log('Guardas de layout: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
