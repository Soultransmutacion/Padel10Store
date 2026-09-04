'use strict';

// Fase 2 - Etapa 1: referencias conversacionales deterministicas en el
// comparador (comparar_productos).
//
// Estas pruebas ejercitan exclusivamente lib/padel-advisor-tools.js contra el
// catalogo real (products.json), sin llamar al modelo de IA. El objetivo es
// verificar que "comparame la primera con la segunda", "comparame esa con la
// segunda" y "comparame la mas barata con la mas cara" resuelven siempre
// contra la lista de productos realmente ofrecida (offeredProducts), con el
// MISMO mecanismo ya probado en Fase 1 para el carrito
// (PadelCartCore.resolveOfferedReference, via resolveReferencedProductId):
// nunca se inventa un producto, nunca se elige arbitrariamente entre varias
// coincidencias, y todo productId (explicito o resuelto) se valida contra el
// catalogo real antes de compararse.
//
// El camino existente por "ids" explicitos (Etapa previa a esta) no se
// modifica: se prueba aca de nuevo para dejar constancia de que sigue
// funcionando igual despues de este cambio.

const assert = require('assert');
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

// Tres palas reales del catalogo, con precio numerico confirmado y precios
// distintos entre si (necesario para probar "mas_barata"/"mas_cara" sin
// ambiguedad de precio empatado).
const BARATA_ID = 'royal-padel-cross-black-26'; // $206.000
const MEDIA_ID = 'royal-padel-europe-fiber-26'; // $244.800
const CARA_ID = 'royal-padel-aniversario-36'; // $256.500

(function verificarFixtures() {
  const barata = catalog.getProductById(BARATA_ID);
  const media = catalog.getProductById(MEDIA_ID);
  const cara = catalog.getProductById(CARA_ID);
  assert.ok(barata && media && cara, 'los 3 productos de prueba deben existir de verdad en el catalogo');
  assert.ok(barata.precio < media.precio && media.precio < cara.precio, 'los 3 productos de prueba deben tener precios distintos y ordenados');
})();

const OFRECIDOS_3 = [{ id: BARATA_ID }, { id: MEDIA_ID }, { id: CARA_ID }];

// --- 1) El camino existente por IDs explicitos sigue funcionando igual ---

test('comparar_productos con ids explicitos sigue funcionando igual que antes', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, MEDIA_ID] });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.productos.length, 2);
  assert.strictEqual(out.noEncontrados.length, 0);
  const ids = out.productos.map(function (p) { return p.id; });
  assert.ok(ids.indexOf(BARATA_ID) !== -1 && ids.indexOf(MEDIA_ID) !== -1);
});

// --- 2) "la primera con la segunda" ---

test('comparar_productos con referencias: "la primera" + "la segunda" resuelve a los productos reales en esas posiciones', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaPosicion: 'primera' }, { referenciaPosicion: 'segunda' }] },
    { offeredProducts: OFRECIDOS_3 }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.productos.length, 2);
  assert.strictEqual(out.noEncontrados.length, 0);
  const ids = out.productos.map(function (p) { return p.id; });
  assert.ok(ids.indexOf(BARATA_ID) !== -1 && ids.indexOf(MEDIA_ID) !== -1);
});

// --- 3) "la primera con la tercera" ---

test('comparar_productos con referencias: "la primera" + "la tercera" resuelve a los productos reales en esas posiciones', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaPosicion: 'primera' }, { referenciaPosicion: 'tercera' }] },
    { offeredProducts: OFRECIDOS_3 }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.productos.length, 2);
  const ids = out.productos.map(function (p) { return p.id; });
  assert.ok(ids.indexOf(BARATA_ID) !== -1 && ids.indexOf(CARA_ID) !== -1);
});

// --- 4) "esa" con un unico producto ofrecido (combinada con un ID explicito para el segundo) ---

test('comparar_productos con referencias: "esa" con un unico producto ofrecido resuelve sin ambiguedad', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaCriterio: 'esa' }, { productId: MEDIA_ID }] },
    { offeredProducts: [{ id: BARATA_ID }] }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.productos.length, 2);
  const ids = out.productos.map(function (p) { return p.id; });
  assert.ok(ids.indexOf(BARATA_ID) !== -1 && ids.indexOf(MEDIA_ID) !== -1);
});

// --- 5) "esa" con varios productos ofrecidos: ambiguo, nunca elige arbitrariamente ---

test('comparar_productos con referencias: "esa" con varios productos ofrecidos devuelve ambiguo (no elige ninguno)', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaCriterio: 'esa' }, { referenciaPosicion: 'segunda' }] },
    { offeredProducts: OFRECIDOS_3 }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'ambiguo');
  assert.ok(Array.isArray(out.opciones) && out.opciones.length === OFRECIDOS_3.length, 'debe devolver las opciones reales para que el asistente pregunte');
  assert.strictEqual(out.productos, undefined, 'una referencia ambigua no debe devolver ninguna comparacion parcial');
});

// --- 6) "la mas barata con la mas cara" ---

test('comparar_productos con referencias: "la mas barata" + "la mas cara" resuelve segun el precio real', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaCriterio: 'mas_barata' }, { referenciaCriterio: 'mas_cara' }] },
    { offeredProducts: OFRECIDOS_3 }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.productos.length, 2);
  const ids = out.productos.map(function (p) { return p.id; });
  assert.ok(ids.indexOf(BARATA_ID) !== -1 && ids.indexOf(CARA_ID) !== -1);
  assert.strictEqual(ids.indexOf(MEDIA_ID), -1, 'la pala de precio intermedio no debe entrar en "mas barata"/"mas cara"');
});

// --- 7) Referencia sin contexto: no hay productos ofrecidos, nunca se inventa ---

test('comparar_productos con referencias: sin productos ofrecidos, "esa" devuelve sin_contexto (nunca inventa)', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaCriterio: 'esa' }, { referenciaPosicion: 'segunda' }] },
    { offeredProducts: [] }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'sin_contexto');
});

// --- 8) Referencia invalida ---

test('comparar_productos con referencias: una referenciaPosicion fuera del enum valido devuelve referencia_invalida', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaPosicion: 'cuarta' }, { referenciaPosicion: 'segunda' }] },
    { offeredProducts: OFRECIDOS_3 }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'referencia_invalida');
});

test('comparar_productos con referencias: un elemento sin productId/posicion/criterio devuelve sin_referencia', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{}, { referenciaPosicion: 'segunda' }] },
    { offeredProducts: OFRECIDOS_3 }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'sin_referencia');
});

// --- 9) Dos referencias que resuelven al mismo producto: se deduplica, y sin 2 productos distintos no hay comparacion ---

test('comparar_productos con referencias: "la primera" y su mismo ID explicito resuelven al mismo producto y se rechaza la comparacion', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaPosicion: 'primera' }, { productId: BARATA_ID }] },
    { offeredProducts: OFRECIDOS_3 }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'ids_duplicados');
});

test('comparar_productos con referencias: "la mas barata" con un solo producto ofrecido, comparada consigo misma por posicion, se rechaza (no hay 2 productos distintos)', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaCriterio: 'mas_barata' }, { referenciaPosicion: 'primera' }] },
    { offeredProducts: [{ id: BARATA_ID }] }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'ids_duplicados');
});

// --- 10) Producto inexistente (ID explicito invalido dentro de una referencia) ---

test('comparar_productos con referencias: un productId inventado por el modelo nunca se compara, se rechaza toda la comparacion', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ productId: 'producto-que-el-modelo-invento-123' }, { referenciaPosicion: 'primera' }] },
    { offeredProducts: OFRECIDOS_3 }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'producto_no_encontrado');
});

// --- Casos adicionales de robustez ---

test('comparar_productos con referencias: menos de 2 referencias falla sin tocar el catalogo', function () {
  const out = tools.executeTool('comparar_productos', { referencias: [{ referenciaPosicion: 'primera' }] }, { offeredProducts: OFRECIDOS_3 });
  assert.strictEqual(out.ok, false);
});

test('comparar_productos sin ids ni referencias falla con un error claro', function () {
  const out = tools.executeTool('comparar_productos', {}, { offeredProducts: OFRECIDOS_3 });
  assert.strictEqual(out.ok, false);
});

test('comparar_productos con referencias: se puede mezclar un ID explicito con una posicion en la misma comparacion', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ productId: CARA_ID }, { referenciaPosicion: 'primera' }] },
    { offeredProducts: OFRECIDOS_3 }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.productos.length, 2);
  const ids = out.productos.map(function (p) { return p.id; });
  assert.ok(ids.indexOf(CARA_ID) !== -1 && ids.indexOf(BARATA_ID) !== -1);
});

test('comparar_productos con referencias: sin contexto (offeredProducts vacio) para referenciaPosicion devuelve posicion_no_disponible, nunca inventa', function () {
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaPosicion: 'primera' }, { referenciaPosicion: 'segunda' }] },
    { offeredProducts: [] }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'posicion_no_disponible');
});

console.log('');
console.log('Pruebas de referencias conversacionales del comparador (Fase 2 - Etapa 1): ' + passed + '/' + (passed + failed) + ' OK');
if (failed > 0) process.exit(1);
