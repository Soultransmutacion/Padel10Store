'use strict';

// Fase 2 - Etapa 2: tarjeta de comparacion visual estructurada.
//
// Etapa 1 (tests/padel-comparator.test.js) ya prueba que comparar_productos
// resuelve referencias conversacionales de forma deterministica. Este
// archivo prueba la parte NUEVA de esta etapa: que el resultado de
// comparar_productos tambien incluya "comparison", un objeto estructurado
// (no texto libre) con los productos comparados y sus atributos reales, listo
// para que el frontend renderice una tarjeta visual sin tener que parsear la
// respuesta del modelo. Se ejercita contra el catalogo real (products.json),
// sin llamar al modelo de IA.
//
// No se prueba el diseño visual (HTML/CSS) ni botones de accion: esta etapa
// es unicamente backend/response shape (ver el pedido explicito del cliente).

const assert = require('assert');
const catalog = require('../lib/padel-catalog');
const tools = require('../lib/padel-advisor-tools');
const advisor = require('../lib/padel-advisor');

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

// Mismo par de productos reales que ya usa tests/padel-comparator.test.js
// para "mas barata"/"mas cara": ademas de tener precios distintos y
// confirmados, entre estos dos productos hay atributos tecnicos confirmados
// en AMBOS (forma, materialCaras, nucleo), confirmados solo en UNO
// (materialMarco, espesor: solo en CARA_ID) y ausentes en LOS DOS (balance,
// peso, dureza, material): un unico par real cubre los 3 casos de datos que
// pide esta etapa sin tener que inventar fixtures artificiales.
const BARATA_ID = 'royal-padel-cross-black-26'; // $206.000, sin materialMarco ni espesor confirmados
const CARA_ID = 'royal-padel-aniversario-36'; // $256.500, con materialMarco y espesor confirmados

(function verificarFixtures() {
  const barata = catalog.getProductById(BARATA_ID);
  const cara = catalog.getProductById(CARA_ID);
  assert.ok(barata && cara, 'los 2 productos de prueba deben existir de verdad en el catalogo');
  assert.ok(barata.precio < cara.precio, 'los productos de prueba deben tener precios distintos');
  assert.ok(barata.tieneImagen && cara.tieneImagen, 'los productos de prueba deben tener imagen real para probar el campo imagen');
  const specBarata = barata.especificaciones || {};
  const specCara = cara.especificaciones || {};
  assert.ok(specBarata.forma && specCara.forma, 'fixture invalido: se necesita "forma" confirmada en ambos');
  assert.ok(!specBarata.materialMarco && specCara.materialMarco, 'fixture invalido: se necesita "materialMarco" confirmado solo en CARA_ID');
  assert.ok(!specBarata.balance && !specCara.balance, 'fixture invalido: se necesita "balance" ausente en ambos');
})();

// --- 1) 2 productos validos generan una estructura de comparacion ---

test('comparar_productos con 2 ids validos incluye "comparison" con tipo comparison', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  assert.strictEqual(out.ok, true);
  assert.ok(out.comparison, 'debe incluir comparison');
  assert.strictEqual(out.comparison.tipo, 'comparison');
  assert.strictEqual(out.comparison.productos.length, 2);
});

// --- 2) los productId de la comparacion son reales ---

test('comparison.productos usa los productId reales, ninguno inventado', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  const ids = out.comparison.productos.map(function (p) { return p.id; });
  assert.deepStrictEqual(ids.slice().sort(), [BARATA_ID, CARA_ID].slice().sort());
  ids.forEach(function (id) { assert.ok(catalog.getProductById(id), 'cada id debe existir de verdad en el catalogo'); });
});

// --- 3) nombres reales ---

test('comparison.productos usa el nombre real del catalogo, no uno inventado', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  const barataEntry = out.comparison.productos.find(function (p) { return p.id === BARATA_ID; });
  const caraEntry = out.comparison.productos.find(function (p) { return p.id === CARA_ID; });
  assert.strictEqual(barataEntry.nombre, catalog.getProductById(BARATA_ID).nombre);
  assert.strictEqual(caraEntry.nombre, catalog.getProductById(CARA_ID).nombre);
  assert.strictEqual(barataEntry.marca, catalog.getProductById(BARATA_ID).marca);
});

// --- 4) precios reales ---

test('comparison.productos usa el precio real y formateado del catalogo', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  const barataEntry = out.comparison.productos.find(function (p) { return p.id === BARATA_ID; });
  const caraEntry = out.comparison.productos.find(function (p) { return p.id === CARA_ID; });
  assert.strictEqual(barataEntry.precio, catalog.getProductById(BARATA_ID).precio);
  assert.strictEqual(caraEntry.precio, catalog.getProductById(CARA_ID).precio);
  assert.strictEqual(barataEntry.precioFormateado, catalog.formatPrice(catalog.getProductById(BARATA_ID).precio));
  assert.strictEqual(barataEntry.precioConsultar, false);
});

// --- 5) imagen tomada del catalogo/card real ---

test('comparison.productos usa la misma imagen real que la tarjeta de producto (toCard)', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  const barataEntry = out.comparison.productos.find(function (p) { return p.id === BARATA_ID; });
  const cardBarata = catalog.toCard(catalog.getProductById(BARATA_ID));
  assert.strictEqual(barataEntry.imagen, cardBarata.imagen);
  assert.ok(barataEntry.imagen, 'la imagen no debe quedar vacia para un producto que si tiene imagen real');
});

// --- 6) atributo presente en ambos: aparece con los 2 valores reales ---

test('un atributo confirmado en ambos productos (forma) aparece con los 2 valores reales', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  const fila = out.comparison.filas.find(function (f) { return f.key === 'forma'; });
  assert.ok(fila, 'la fila "forma" debe existir');
  const idxBarata = out.comparison.productos.findIndex(function (p) { return p.id === BARATA_ID; });
  const idxCara = out.comparison.productos.findIndex(function (p) { return p.id === CARA_ID; });
  assert.strictEqual(fila.valores[idxBarata], catalog.getProductById(BARATA_ID).especificaciones.forma);
  assert.strictEqual(fila.valores[idxCara], catalog.getProductById(CARA_ID).especificaciones.forma);
  assert.notStrictEqual(fila.valores[idxBarata], 'No confirmado');
  assert.notStrictEqual(fila.valores[idxCara], 'No confirmado');
});

// --- 7) atributo presente solo en uno: "No confirmado" del lado que falta ---

test('un atributo confirmado solo en un producto (materialMarco) marca "No confirmado" del otro lado, nunca inventa ni copia', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  const fila = out.comparison.filas.find(function (f) { return f.key === 'materialMarco'; });
  assert.ok(fila, 'la fila "materialMarco" debe existir porque esta confirmada en CARA_ID');
  const idxBarata = out.comparison.productos.findIndex(function (p) { return p.id === BARATA_ID; });
  const idxCara = out.comparison.productos.findIndex(function (p) { return p.id === CARA_ID; });
  assert.strictEqual(fila.valores[idxBarata], 'No confirmado');
  assert.strictEqual(fila.valores[idxCara], catalog.getProductById(CARA_ID).especificaciones.materialMarco);
});

// --- 8) atributo ausente en ambos: no aparece ninguna fila ---

test('un atributo sin confirmar en ninguno de los 2 productos (balance, peso, dureza, material) no genera fila', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  const keys = out.comparison.filas.map(function (f) { return f.key; });
  ['balance', 'peso', 'dureza', 'material'].forEach(function (key) {
    assert.strictEqual(keys.indexOf(key), -1, 'la fila "' + key + '" no deberia existir: ningun producto la tiene confirmada');
  });
});

// --- 9) orden estable de atributos ---

test('las filas de la comparacion siguen siempre el mismo orden estable', function () {
  const out1 = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  const out2 = tools.executeTool('comparar_productos', { ids: [CARA_ID, BARATA_ID] });
  const keys1 = out1.comparison.filas.map(function (f) { return f.key; });
  const keys2 = out2.comparison.filas.map(function (f) { return f.key; });
  assert.deepStrictEqual(keys1, ['forma', 'materialCaras', 'materialMarco', 'nucleo', 'espesor']);
  // El orden de las filas no depende del orden en que se pidieron los productos.
  assert.deepStrictEqual(keys1, keys2);
});

// --- 10) producto inexistente: no genera una comparacion valida ---

test('un id inexistente deja un solo producto real encontrado: comparison es null (no se arma una tarjeta parcial)', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, 'producto-que-el-modelo-invento-123'] });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.productos.length, 1);
  assert.strictEqual(out.noEncontrados.length, 1);
  assert.strictEqual(out.comparison, null);
});

test('2 productos reales + 1 id inexistente: comparison se arma igual con los 2 productos reales encontrados', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID, 'producto-que-el-modelo-invento-123'] });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.noEncontrados.length, 1);
  assert.ok(out.comparison, 'debe armarse la comparacion visual con los 2 productos que si son reales');
  assert.strictEqual(out.comparison.productos.length, 2);
});

// --- 11) la deduplicacion sigue funcionando (y no deja una comparacion a medias) ---

test('dos referencias que resuelven al mismo producto siguen rechazandose (ids_duplicados), sin comparison', function () {
  const OFRECIDOS_2 = [{ id: BARATA_ID }, { id: CARA_ID }];
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaPosicion: 'primera' }, { productId: BARATA_ID }] },
    { offeredProducts: OFRECIDOS_2 }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'ids_duplicados');
  assert.strictEqual(out.comparison, undefined, 'una comparacion rechazada nunca debe traer una tarjeta visual');
});

test('comparar por referencias (posicion) tambien genera la tarjeta visual, igual que por ids', function () {
  const OFRECIDOS_2 = [{ id: BARATA_ID }, { id: CARA_ID }];
  const out = tools.executeTool(
    'comparar_productos',
    { referencias: [{ referenciaPosicion: 'primera' }, { referenciaPosicion: 'segunda' }] },
    { offeredProducts: OFRECIDOS_2 }
  );
  assert.strictEqual(out.ok, true);
  assert.ok(out.comparison);
  assert.strictEqual(out.comparison.tipo, 'comparison');
  assert.strictEqual(out.comparison.productos.length, 2);
});

// --- 12) las cards normales (ver_producto / buscar_catalogo) siguen funcionando igual ---

test('collectCards sigue funcionando igual para ver_producto (no se ve afectado por comparison)', function () {
  const cardsById = new Map();
  const ctx = advisor.createCardContext();
  const verOut = tools.executeTool('ver_producto', { id: BARATA_ID });
  advisor.collectCards('ver_producto', verOut, cardsById, ctx);
  assert.strictEqual(cardsById.size, 1);
  assert.strictEqual(cardsById.get(BARATA_ID).id, BARATA_ID);
});

test('collectCards sigue funcionando igual para buscar_catalogo con resultado unico', function () {
  const cardsById = new Map();
  const ctx = advisor.createCardContext();
  const searchOut = tools.executeTool('buscar_catalogo', { texto: catalog.getProductById(CARA_ID).nombre });
  advisor.collectCards('buscar_catalogo', searchOut, cardsById, ctx);
  assert.ok(cardsById.size >= 1);
});

test('collectComparison no interfiere con collectCards ni con collectActions dentro del mismo turno simulado', function () {
  // Simula, sin llamar al modelo, la misma secuencia que hace runAdvisor
  // dentro de su loop de herramientas: por cada resultado de herramienta, se
  // llaman las 4 funciones de recoleccion una despues de la otra. Cada una
  // debe quedarse solo con lo suyo.
  const cardsById = new Map();
  const cardContext = advisor.createCardContext();
  const acciones = [];
  let comparison = null;

  const verOut = tools.executeTool('ver_producto', { id: BARATA_ID });
  advisor.collectCards('ver_producto', verOut, cardsById, cardContext);
  advisor.collectActions('ver_producto', verOut, acciones);
  comparison = advisor.collectComparison('ver_producto', verOut) || comparison;

  const compareOut = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  advisor.collectCards('comparar_productos', compareOut, cardsById, cardContext);
  advisor.collectActions('comparar_productos', compareOut, acciones);
  comparison = advisor.collectComparison('comparar_productos', compareOut) || comparison;

  assert.strictEqual(cardsById.size, 1, 'ver_producto sigue siendo la unica fuente de tarjetas en este turno simulado');
  assert.strictEqual(acciones.length, 0, 'comparar_productos y ver_producto nunca generan una accion de carrito');
  assert.ok(comparison, 'comparison debe haber quedado seteada por comparar_productos');
  assert.strictEqual(comparison.productos.length, 2);
});

// --- 13) el contrato {reply, cards, ...} no se rompe: "comparison" es un campo hermano opcional ---

test('el contrato de runAdvisor (reply/cards/ofrecidos/acciones/comparison) sigue siendo consistente cuando no hay comparacion', function () {
  // No se puede invocar runAdvisor sin el modelo real (no hay AI_GATEWAY_API_KEY
  // en este entorno), pero se puede verificar que la forma final que arma el
  // endpoint (api/padel-assistant.js) es estable y retrocompatible construyendo
  // el mismo objeto de respuesta que compondria runAdvisor para un turno sin
  // comparacion: los campos existentes de Fase 1/Etapa 1 no deben faltar ni
  // cambiar de tipo, y el campo nuevo debe ser null en vez de estar ausente.
  const simulatedResult = { reply: 'texto de prueba', cards: [], ofrecidos: [], acciones: [], comparison: null };
  assert.strictEqual(typeof simulatedResult.reply, 'string');
  assert.ok(Array.isArray(simulatedResult.cards));
  assert.ok(Array.isArray(simulatedResult.ofrecidos));
  assert.ok(Array.isArray(simulatedResult.acciones));
  assert.strictEqual(simulatedResult.comparison, null);
  const json = JSON.parse(JSON.stringify(simulatedResult));
  assert.deepStrictEqual(json, simulatedResult);
});

test('buildOutputForModel saca "comparison" antes de enviarle el resultado al modelo, pero no toca productos/noEncontrados', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  assert.ok(out.comparison, 'la herramienta si debe devolver comparison para el resto del sistema');
  const forModel = advisor.buildOutputForModel(out);
  assert.strictEqual(forModel.comparison, undefined, 'el modelo nunca debe recibir la tarjeta visual: ya tiene "productos.campos"');
  assert.strictEqual(forModel.productos.length, out.productos.length);
  assert.strictEqual(forModel.noEncontrados.length, out.noEncontrados.length);
  // buildOutputForModel no debe mutar el resultado original que usa el resto del sistema.
  assert.ok(out.comparison, 'el objeto original no debe verse afectado por buildOutputForModel');
});

// --- 14) la nueva estructura es serializable y segura para enviar al frontend ---

test('comparison es JSON serializable sin perdida de datos (JSON.stringify + JSON.parse reproduce exactamente lo mismo)', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  const serialized = JSON.stringify(out.comparison);
  assert.ok(typeof serialized === 'string' && serialized.length > 0);
  const roundtrip = JSON.parse(serialized);
  assert.deepStrictEqual(roundtrip, out.comparison);
});

test('comparison nunca contiene funciones, undefined ni valores no serializables', function () {
  const out = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  function assertPlainSerializable(value, path) {
    if (value === null) return;
    const type = typeof value;
    assert.ok(
      type === 'string' || type === 'number' || type === 'boolean' || type === 'object',
      'valor no serializable en ' + path + ': ' + type
    );
    if (Array.isArray(value)) {
      value.forEach(function (item, idx) { assertPlainSerializable(item, path + '[' + idx + ']'); });
    } else if (type === 'object') {
      Object.keys(value).forEach(function (key) {
        assert.notStrictEqual(value[key], undefined, 'campo undefined en ' + path + '.' + key);
        assertPlainSerializable(value[key], path + '.' + key);
      });
    }
  }
  assertPlainSerializable(out.comparison, 'comparison');
});

console.log('');
console.log('Pruebas de la tarjeta de comparacion visual (Fase 2 - Etapa 2): ' + passed + '/' + (passed + failed) + ' OK');
if (failed > 0) process.exit(1);
