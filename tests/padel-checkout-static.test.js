'use strict';

/**
 * Pruebas ESTATICAS de la Fase 3, Etapa 2 (formulario de comprador y datos
 * de envio): leen el repo del disco, sin tocar ninguna base de datos ni
 * red, para verificar limites de seguridad que no se pueden expresar como
 * un test funcional comun.
 *
 * Complementa tests/padel-orders-schema.test.js (que ya verifica, desde la
 * Etapa 1, que widget/ e index.html nunca referencian la capa de datos de
 * pedidos ni sus variables de entorno de servidor). Este archivo agrega las
 * verificaciones nuevas que introduce esta etapa: que ningun dato del
 * comprador llegue al asistente de IA, que el access_token nunca aparezca
 * en el frontend, y que api/pedidos.js nunca loguee nada.
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

// Quita comentarios de linea ("// ...") para que las busquedas de
// anti-patrones no matcheen texto explicativo que menciona ese anti-patron
// justamente para decir por que no se usa (mismo criterio que
// quitarComentariosSql en tests/padel-orders-schema.test.js).
function quitarComentariosDeLinea(codigo) {
  return codigo
    .split('\n')
    .map((linea) => linea.replace(/\/\/.*$/, ''))
    .join('\n');
}

function listarArchivosRecursivo(dir) {
  const salida = [];
  if (!fs.existsSync(dir)) return salida;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) salida.push(...listarArchivosRecursivo(full));
    else salida.push(full);
  }
  return salida;
}

// --- ningun dato del comprador se envia al asistente de IA -----------------

test('el asistente de IA (widget/padel-advisor.js) no referencia el endpoint de pedidos ni sus campos', () => {
  const contenido = leerArchivo(path.join('widget', 'padel-advisor.js'));
  const patronesProhibidos = ['/api/pedidos', 'padel-checkout', 'direccionEnvio', 'comprador.nombre', 'accessToken'];
  patronesProhibidos.forEach((patron) => {
    assert.ok(!contenido.includes(patron), `widget/padel-advisor.js no deberia referenciar "${patron}"`);
  });
});

test('las herramientas del asistente (lib/padel-advisor-tools.js) no referencian el endpoint de pedidos ni sus campos', () => {
  const contenido = leerArchivo(path.join('lib', 'padel-advisor-tools.js'));
  const patronesProhibidos = ['/api/pedidos', 'padel-checkout-fields', 'padel-orders-store', 'direccionEnvio', 'comprador.nombre'];
  patronesProhibidos.forEach((patron) => {
    assert.ok(!contenido.includes(patron), `lib/padel-advisor-tools.js no deberia referenciar "${patron}"`);
  });
});

test('el system prompt del asistente (lib/padel-advisor-system-prompt.js) no menciona el formulario de pedidos', () => {
  const contenido = leerArchivo(path.join('lib', 'padel-advisor-system-prompt.js'));
  ['comprador', 'direccionEnvio', '/api/pedidos', 'accessToken'].forEach((patron) => {
    assert.ok(!contenido.toLowerCase().includes(patron.toLowerCase()), `no deberia mencionar "${patron}"`);
  });
});

// --- access_token: nunca en el frontend -------------------------------

test('ningun archivo de widget/ ni index.html menciona accessToken/access_token', () => {
  const archivos = [...listarArchivosRecursivo(path.join(ROOT, 'widget')), path.join(ROOT, 'index.html')];
  archivos.forEach((archivo) => {
    const contenido = fs.readFileSync(archivo, 'utf8');
    assert.ok(!/access_?token/i.test(contenido), `${archivo} no deberia mencionar el access token`);
  });
});

test('la respuesta documentada de POST /api/pedidos (api/pedidos.js) nunca arma un objeto con access_token', () => {
  const contenido = leerArchivo(path.join('api', 'pedidos.js'));
  assert.ok(!/res\.status\(201\)\.json\(\{[^}]*access/i.test(contenido));
});

// --- api/pedidos.js nunca loguea nada (mismo criterio que api/create-payment-preference.js) --

test('api/pedidos.js nunca usa console.log/console.error/console.warn', () => {
  const contenido = leerArchivo(path.join('api', 'pedidos.js'));
  assert.ok(!/console\.(log|error|warn|info|debug)/.test(contenido));
});

test('lib/padel-checkout-fields.js nunca usa console.* ni depende de @supabase/supabase-js (debe poder cargarse en el navegador)', () => {
  const contenidoCrudo = leerArchivo(path.join('lib', 'padel-checkout-fields.js'));
  const contenido = quitarComentariosDeLinea(contenidoCrudo);
  assert.ok(!/console\.(log|error|warn|info|debug)/.test(contenido));
  assert.ok(!contenido.includes('process.env'));
  // Fuera de comentarios explicativos, este archivo no debe hacer ningun
  // require() real de Node (tiene que poder cargarse tal cual como
  // <script> en el navegador, igual que lib/padel-cart.js).
  assert.ok(!/\brequire\(/.test(contenido), 'no deberia usar require() de Node (debe cargar como <script> tambien)');
});

test('widget/padel-checkout.js nunca referencia @supabase/supabase-js ni variables de entorno de servidor', () => {
  const contenido = leerArchivo(path.join('widget', 'padel-checkout.js'));
  ['@supabase/supabase-js', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'process.env'].forEach((patron) => {
    assert.ok(!contenido.includes(patron), `no deberia referenciar "${patron}"`);
  });
});

// --- allow-list: el endpoint nunca acepta "pais" como campo de entrada ----

test('api/pedidos.js no incluye "pais" en la allow-list de direccionEnvio', () => {
  const contenido = leerArchivo(path.join('api', 'pedidos.js'));
  const match = contenido.match(/CAMPOS_DIRECCION\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, 'deberia existir CAMPOS_DIRECCION');
  assert.ok(!/'pais'/.test(match[1]) && !/"pais"/.test(match[1]), 'CAMPOS_DIRECCION no deberia incluir "pais"');
});

// --- el formulario nunca pide documento en esta etapa ----------------------

test('lib/padel-checkout-fields.js no valida ni pide "documento" (fuera de alcance de esta etapa)', () => {
  const contenido = leerArchivo(path.join('lib', 'padel-checkout-fields.js'));
  assert.ok(!/\bdocumento\b/i.test(contenido));
});

// --- "Comprar ahora" ya no llama al endpoint fantasma /api/create-payment-preference --

test('widget/mercadopago-buy.js ya no llama a fetch ni referencia /api/create-payment-preference como URL activa', () => {
  const contenido = leerArchivo(path.join('widget', 'mercadopago-buy.js'));
  assert.ok(!/\bfetch\s*\(/.test(contenido), 'no deberia hacer ninguna llamada de red por si mismo');
  assert.ok(!/['"]\/api\/create-payment-preference['"]/.test(contenido), 'no deberia quedar ninguna URL activa hacia el endpoint retirado');
  assert.ok(contenido.includes('window.PadelCheckoutWidget') && contenido.includes('startBuyNow'), 'debe delegar en el checkout real (startBuyNow)');
});

test('widget/padel-advisor.js no referencia /api/create-payment-preference', () => {
  const contenido = leerArchivo(path.join('widget', 'padel-advisor.js'));
  assert.ok(!/['"]\/api\/create-payment-preference['"]/.test(contenido));
});

test('index.html no referencia /api/create-payment-preference', () => {
  const contenido = leerArchivo('index.html');
  assert.ok(!/['"]\/api\/create-payment-preference['"]/.test(contenido));
});

test('api/create-payment-preference.js quedo deshabilitado: nunca importa el catalogo ni el cliente de Mercado Pago', () => {
  const contenido = leerArchivo(path.join('api', 'create-payment-preference.js'));
  assert.ok(!contenido.includes("require('./mercadopago-preference')") && !contenido.includes("require('../lib/mercadopago-preference')"));
  assert.ok(!contenido.includes("require('./mercadopago-client')") && !contenido.includes("require('../lib/mercadopago-client')"));
  assert.ok(!/console\.(log|error|warn|info|debug)/.test(contenido));
});

// --- "Comprar ahora" es UN SOLO producto: nunca reutiliza el carrito persistente ---

test('widget/padel-checkout.js#startBuyNow nunca usa window.PadelCart.getRawLines() para armar el body de la compra directa', () => {
  const contenido = leerArchivo(path.join('widget', 'padel-checkout.js'));
  const inicio = contenido.indexOf('function startBuyNow');
  assert.ok(inicio > -1, 'debe existir startBuyNow');
  const fin = contenido.indexOf('\n  }', inicio);
  const cuerpo = contenido.slice(inicio, fin > -1 ? fin : undefined);
  assert.ok(!cuerpo.includes('getRawLines'), 'startBuyNow no deberia leer el carrito persistente');
});

test('widget/padel-checkout.js nunca vacia el carrito persistente en modo "buyNow" (Comprar ahora nunca lo toca)', () => {
  const contenido = leerArchivo(path.join('widget', 'padel-checkout.js'));
  assert.ok(/if\s*\(\s*mode\s*!==\s*['"]buyNow['"]\s*\)\s*\{\s*window\.PadelCart\.clear\(\)/.test(contenido));
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
  console.log('Pruebas estaticas de checkout (Etapa 2): ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
