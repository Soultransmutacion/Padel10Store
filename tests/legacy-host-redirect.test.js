'use strict';

/**
 * Pruebas de lib/legacy-host-redirect.js: la redireccion permanente del
 * hosting antiguo (GitHub Pages, https://soultransmutacion.github.io/Padel10Store)
 * hacia el sitio real (https://padel10-store.vercel.app).
 *
 * calcularRedireccionHostingAntiguo es una funcion PURA (nunca toca
 * `location` ni hace ningun efecto real): estas pruebas corren con Node
 * puro, sin jsdom ni necesidad de simular una navegacion real. El efecto
 * (location.replace) vive en index.html y no se prueba aca (no hay forma
 * fiable de observar una navegacion real en jsdom, y no hace falta: toda
 * la decision -si redirige y a donde- esta en esta funcion).
 */

const assert = require('assert');
const {
  calcularRedireccionHostingAntiguo,
  HOST_ANTIGUO,
  PREFIJO_RUTA,
  DESTINO_ORIGIN,
} = require('../lib/legacy-host-redirect');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

// --- Hostname EXACTO: el unico que debe redirigir -------------------------

test('hostname exacto del hosting antiguo, con la ruta del proyecto: redirige', () => {
  const destino = calcularRedireccionHostingAntiguo(HOST_ANTIGUO, PREFIJO_RUTA, '', '');
  assert.strictEqual(destino, DESTINO_ORIGIN + '/');
});

test('constantes: HOST_ANTIGUO y PREFIJO_RUTA son las esperadas', () => {
  assert.strictEqual(HOST_ANTIGUO, 'soultransmutacion.github.io');
  assert.strictEqual(PREFIJO_RUTA, '/Padel10Store');
  assert.strictEqual(DESTINO_ORIGIN, 'https://padel10-store.vercel.app');
});

// --- Dominios parecidos / maliciosos: NUNCA deben redirigir ---------------

const HOSTS_PARECIDOS_MALICIOSOS = [
  'soultransmutacion.github.io.evil.com',
  'evil-soultransmutacion.github.io',
  'notsoultransmutacion.github.io',
  'xsoultransmutacion.github.io',
  'soultransmutacion.github.io.co',
  'soultransmutacion.github.io ',
  ' soultransmutacion.github.io',
  'soultransmutacion.github.iox',
  'SOULTRANSMUTACION.GITHUB.IO',
  'soultransmutacion.githubusercontent.io',
  'attacker.com',
  '',
];

HOSTS_PARECIDOS_MALICIOSOS.forEach((hostFalso) => {
  test('hostname parecido/malicioso "' + hostFalso + '": NUNCA redirige', () => {
    const destino = calcularRedireccionHostingAntiguo(hostFalso, PREFIJO_RUTA, '', '');
    assert.strictEqual(destino, null);
  });
});

// --- Otros hosts legitimos donde NUNCA debe redirigir ---------------------

const HOSTS_LEGITIMOS_SIN_REDIRECCION = [
  'localhost',
  '127.0.0.1',
  'padel10-store.vercel.app', // el propio destino: redirigir aca seria un loop infinito
  'padel10-store-git-asesor-ia-padel10store-soultransmutacions-projects.vercel.app', // Preview
  'padel10-store-abc123hash-soultransmutacions-projects.vercel.app', // deployment unico
  'vercel.app',
  'example.com',
];

HOSTS_LEGITIMOS_SIN_REDIRECCION.forEach((host) => {
  test('hostname "' + host + '" (localhost/Preview/Vercel/otro): nunca redirige', () => {
    const destino = calcularRedireccionHostingAntiguo(host, PREFIJO_RUTA, '', '');
    assert.strictEqual(destino, null);
  });
});

// --- Rutas: exacta, subruta, prefijo parcial (nunca matchea) --------------

test('ruta exacta "/Padel10Store" (sin barra final): redirige a la raiz del destino', () => {
  assert.strictEqual(
    calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/Padel10Store', '', ''),
    'https://padel10-store.vercel.app/'
  );
});

test('ruta con barra final "/Padel10Store/": redirige a la raiz del destino', () => {
  assert.strictEqual(
    calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/Padel10Store/', '', ''),
    'https://padel10-store.vercel.app/'
  );
});

test('subruta "/Padel10Store/productos/pala-x": preserva la ruta interna util', () => {
  assert.strictEqual(
    calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/Padel10Store/productos/pala-x', '', ''),
    'https://padel10-store.vercel.app/productos/pala-x'
  );
});

test('prefijo parcial "/Padel10Store-otro" NUNCA matchea (no es un limite de ruta real)', () => {
  assert.strictEqual(calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/Padel10Store-otro', '', ''), null);
});

test('prefijo parcial "/Padel10StoreClon" NUNCA matchea', () => {
  assert.strictEqual(calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/Padel10StoreClon', '', ''), null);
});

test('ruta con capitalizacion distinta "/padel10store" NUNCA matchea (comparacion exacta, case-sensitive)', () => {
  assert.strictEqual(calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/padel10store', '', ''), null);
});

test('ruta totalmente distinta "/otra-cosa" NUNCA matchea', () => {
  assert.strictEqual(calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/otra-cosa', '', ''), null);
});

test('ruta raiz "/" (sin el prefijo del proyecto) NUNCA matchea', () => {
  assert.strictEqual(calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/', '', ''), null);
});

// --- Query y hash: se preservan tal cual, junto o por separado ------------

test('preserva el query string tal cual', () => {
  assert.strictEqual(
    calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/Padel10Store/productos', '?talle=42&color=negro', ''),
    'https://padel10-store.vercel.app/productos?talle=42&color=negro'
  );
});

test('preserva el hash tal cual', () => {
  assert.strictEqual(
    calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/Padel10Store', '', '#seccion-destacados'),
    'https://padel10-store.vercel.app/#seccion-destacados'
  );
});

test('preserva query y hash juntos, en el orden correcto (query antes que hash)', () => {
  assert.strictEqual(
    calcularRedireccionHostingAntiguo(
      HOST_ANTIGUO,
      '/Padel10Store/productos/pala-x',
      '?ref=instagram',
      '#detalle'
    ),
    'https://padel10-store.vercel.app/productos/pala-x?ref=instagram#detalle'
  );
});

test('query y hash ausentes (undefined) no rompen nada: se tratan como string vacio', () => {
  assert.strictEqual(
    calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/Padel10Store/x', undefined, undefined),
    'https://padel10-store.vercel.app/x'
  );
});

// --- Defensa contra open-redirect via manipulacion de la ruta -------------

test('una ruta manipulada con "//" al inicio del resto nunca cambia de host (nunca se resuelve como protocol-relative)', () => {
  const destino = calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/Padel10Store//evil.com/x', '', '');
  assert.strictEqual(destino, 'https://padel10-store.vercel.app/evil.com/x');
  assert.ok(
    destino.indexOf('https://padel10-store.vercel.app/') === 0,
    'el destino SIEMPRE debe empezar con el origin real, nunca con otro host: ' + destino
  );
});

test('una ruta manipulada con muchas "/" al inicio del resto se colapsa a una sola (nunca cambia de host)', () => {
  const destino = calcularRedireccionHostingAntiguo(HOST_ANTIGUO, '/Padel10Store/////evil.com', '', '');
  assert.strictEqual(destino, 'https://padel10-store.vercel.app/evil.com');
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
  console.log('Pruebas de lib/legacy-host-redirect.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
