'use strict';

const assert = require('assert');
const path = require('path');
const PadelCartCore = require(path.join(__dirname, '..', 'lib', 'padel-cart.js'));

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

const PALA_SIN_TALLE = {
  id: 'pala-sin-talle',
  nombre: 'Pala Sin Talle',
  marca: 'Royal Padel',
  tipoProducto: 'Paleta',
  precio: 100000,
  precioConsultar: false,
};

const REMERA_CON_TALLE = {
  id: 'remera-negra',
  nombre: 'Remera Mallorca Negra',
  marca: 'Royal Padel',
  tipoProducto: 'Ropa Mujer',
  precio: 25000,
  precioConsultar: false,
  talles: ['S', 'M', 'L', 'XL'],
};

const PALA_CONSULTAR = {
  id: 'pala-consultar',
  nombre: 'Pala A Consultar',
  marca: 'Bullpadel',
  tipoProducto: 'Paleta',
  precio: null,
  precioConsultar: true,
};

const PALA_BARATA = { id: 'pala-barata', nombre: 'Pala Barata', marca: 'Siux', tipoProducto: 'Paleta', precio: 50000, precioConsultar: false };
const PALA_CARA = { id: 'pala-cara', nombre: 'Pala Cara', marca: 'Bullpadel', tipoProducto: 'Paleta', precio: 500000, precioConsultar: false };

const CATALOGO = [PALA_SIN_TALLE, REMERA_CON_TALLE, PALA_CONSULTAR, PALA_BARATA, PALA_CARA];

function getProduct(id) {
  return CATALOGO.find(function (p) { return p.id === id; }) || null;
}

// --- buildLine: agregar producto valido ---

test('buildLine: producto sin talle, cantidad por defecto', function () {
  const r = PadelCartCore.buildLine(PALA_SIN_TALLE, undefined, undefined);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.line.productId, 'pala-sin-talle');
  assert.strictEqual(r.line.talle, null);
  assert.strictEqual(r.line.cantidad, 1);
});

test('buildLine: producto con talle valido', function () {
  const r = PadelCartCore.buildLine(REMERA_CON_TALLE, 'M', 2);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.line.talle, 'M');
  assert.strictEqual(r.line.cantidad, 2);
});

test('buildLine: producto inexistente (null) se rechaza', function () {
  const r = PadelCartCore.buildLine(null, undefined, 1);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'producto_invalido');
});

test('buildLine: producto con talle obligatorio sin talle se rechaza', function () {
  const r = PadelCartCore.buildLine(REMERA_CON_TALLE, undefined, 1);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'talle_requerido');
  assert.deepStrictEqual(r.tallesDisponibles, ['S', 'M', 'L', 'XL']);
});

test('buildLine: talle invalido para ese producto se rechaza', function () {
  const r = PadelCartCore.buildLine(REMERA_CON_TALLE, 'XXL', 1);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'talle_invalido');
});

test('buildLine: talle enviado para un producto sin talles se rechaza', function () {
  const r = PadelCartCore.buildLine(PALA_SIN_TALLE, 'M', 1);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'talle_no_aplica');
});

test('buildLine: producto a consultar nunca se puede agregar', function () {
  const r = PadelCartCore.buildLine(PALA_CONSULTAR, undefined, 1);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'precio_consultar');
});

test('buildLine: cantidad valida dentro de rango', function () {
  const r = PadelCartCore.buildLine(PALA_SIN_TALLE, undefined, 5);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.line.cantidad, 5);
});

test('buildLine: cantidad invalida (cero) se rechaza', function () {
  const r = PadelCartCore.buildLine(PALA_SIN_TALLE, undefined, 0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'cantidad_invalida');
});

test('buildLine: cantidad invalida (negativa) se rechaza', function () {
  const r = PadelCartCore.buildLine(PALA_SIN_TALLE, undefined, -3);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'cantidad_invalida');
});

test('buildLine: cantidad invalida (no entera) se rechaza', function () {
  const r = PadelCartCore.buildLine(PALA_SIN_TALLE, undefined, 1.5);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'cantidad_invalida');
});

test('buildLine: cantidad invalida (mayor al maximo) se rechaza', function () {
  const r = PadelCartCore.buildLine(PALA_SIN_TALLE, undefined, 21);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'cantidad_invalida');
});

// --- findLineIndex ---

test('findLineIndex: encuentra linea por productId + talle', function () {
  const lines = [{ productId: 'remera-negra', talle: 'M', cantidad: 1 }, { productId: 'pala-sin-talle', talle: null, cantidad: 1 }];
  assert.strictEqual(PadelCartCore.findLineIndex(lines, 'remera-negra', 'M'), 0);
  assert.strictEqual(PadelCartCore.findLineIndex(lines, 'pala-sin-talle', null), 1);
  assert.strictEqual(PadelCartCore.findLineIndex(lines, 'remera-negra', 'L'), -1);
});

// --- buildCartSummary: quitar producto / consultar carrito / calcular total ---

test('buildCartSummary: calcula total y cantidadTotal correctamente', function () {
  const lines = [
    { productId: 'pala-sin-talle', talle: null, cantidad: 2 },
    { productId: 'remera-negra', talle: 'M', cantidad: 1 },
  ];
  const summary = PadelCartCore.buildCartSummary(lines, getProduct);
  assert.strictEqual(summary.lineas.length, 2);
  assert.strictEqual(summary.total, 100000 * 2 + 25000 * 1);
  assert.strictEqual(summary.cantidadTotal, 3);
  assert.strictEqual(summary.descartadas.length, 0);
});

test('buildCartSummary: descarta producto que ya no existe en el catalogo', function () {
  const lines = [{ productId: 'producto-fantasma', talle: null, cantidad: 1 }];
  const summary = PadelCartCore.buildCartSummary(lines, getProduct);
  assert.strictEqual(summary.lineas.length, 0);
  assert.strictEqual(summary.descartadas.length, 1);
  assert.strictEqual(summary.descartadas[0].motivo, 'no_encontrado');
});

test('buildCartSummary: descarta linea con talle que ya no es valido', function () {
  const lines = [{ productId: 'remera-negra', talle: 'XXL', cantidad: 1 }];
  const summary = PadelCartCore.buildCartSummary(lines, getProduct);
  assert.strictEqual(summary.lineas.length, 0);
  assert.strictEqual(summary.descartadas[0].motivo, 'talle_invalido');
});

test('buildCartSummary: descarta producto que paso a "a consultar"', function () {
  const lines = [{ productId: 'pala-consultar', talle: null, cantidad: 1 }];
  const summary = PadelCartCore.buildCartSummary(lines, getProduct);
  assert.strictEqual(summary.lineas.length, 0);
  assert.strictEqual(summary.descartadas[0].motivo, 'precio_consultar');
});

test('buildCartSummary: NUNCA usa el precio guardado en la linea, siempre el del catalogo', function () {
  // El precio "manipulado" en la linea (1) se ignora por completo: el
  // resumen recalcula el precio real del catalogo (100000).
  const lines = [{ productId: 'pala-sin-talle', talle: null, cantidad: 1, precio: 1 }];
  const summary = PadelCartCore.buildCartSummary(lines, getProduct);
  assert.strictEqual(summary.lineas[0].precio, 100000);
  assert.strictEqual(summary.total, 100000);
});

test('buildCartSummary: carrito vacio da total 0 sin lineas', function () {
  const summary = PadelCartCore.buildCartSummary([], getProduct);
  assert.strictEqual(summary.lineas.length, 0);
  assert.strictEqual(summary.total, 0);
  assert.strictEqual(summary.cantidadTotal, 0);
});

// --- restaurar carrito desde persistencia (localStorage) ---

test('restaurar: linea valida persistida se mantiene', function () {
  const persisted = [{ productId: 'pala-sin-talle', talle: null, cantidad: 3 }];
  const summary = PadelCartCore.buildCartSummary(persisted, getProduct);
  assert.strictEqual(summary.lineas.length, 1);
  assert.strictEqual(summary.lineas[0].cantidad, 3);
});

test('restaurar: precio falso manipulado en localStorage se descarta y se recalcula del catalogo', function () {
  const persisted = [{ productId: 'remera-negra', talle: 'M', cantidad: 1, precio: 1 }];
  const summary = PadelCartCore.buildCartSummary(persisted, getProduct);
  assert.strictEqual(summary.lineas[0].precio, 25000);
});

test('restaurar: product ID inexistente en persistencia se descarta', function () {
  const persisted = [{ productId: 'no-existe-mas', talle: null, cantidad: 1 }];
  const summary = PadelCartCore.buildCartSummary(persisted, getProduct);
  assert.strictEqual(summary.lineas.length, 0);
  assert.strictEqual(summary.descartadas[0].motivo, 'no_encontrado');
});

test('restaurar: talle invalido en persistencia se descarta', function () {
  const persisted = [{ productId: 'remera-negra', talle: 'ZZZ', cantidad: 1 }];
  const summary = PadelCartCore.buildCartSummary(persisted, getProduct);
  assert.strictEqual(summary.lineas.length, 0);
  assert.strictEqual(summary.descartadas[0].motivo, 'talle_invalido');
});

test('restaurar: cantidad corrupta se corrige en vez de descartar la linea entera', function () {
  const persisted = [{ productId: 'pala-sin-talle', talle: null, cantidad: -50 }];
  const summary = PadelCartCore.buildCartSummary(persisted, getProduct);
  assert.strictEqual(summary.lineas.length, 1);
  assert.strictEqual(summary.lineas[0].cantidad, 1);
});

test('restaurar: mezcla de lineas validas e invalidas conserva solo las validas', function () {
  const persisted = [
    { productId: 'pala-sin-talle', talle: null, cantidad: 1 },
    { productId: 'fantasma', talle: null, cantidad: 1 },
    { productId: 'remera-negra', talle: 'S', cantidad: 1 },
  ];
  const summary = PadelCartCore.buildCartSummary(persisted, getProduct);
  assert.strictEqual(summary.lineas.length, 2);
  assert.strictEqual(summary.descartadas.length, 1);
});

// --- matchCartLinesByText: "sacame la pala" ---

test('matchCartLinesByText: identifica una sola pala inequivoca en el carrito', function () {
  const summary = PadelCartCore.buildCartSummary(
    [{ productId: 'pala-sin-talle', talle: null, cantidad: 1 }, { productId: 'remera-negra', talle: 'M', cantidad: 1 }],
    getProduct
  );
  const matches = PadelCartCore.matchCartLinesByText(summary.lineas, 'sacame la pala');
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].productId, 'pala-sin-talle');
});

test('matchCartLinesByText: varias palas en el carrito son ambiguas (no elige ninguna)', function () {
  const summary = PadelCartCore.buildCartSummary(
    [{ productId: 'pala-sin-talle', talle: null, cantidad: 1 }, { productId: 'pala-barata', talle: null, cantidad: 1 }],
    getProduct
  );
  const matches = PadelCartCore.matchCartLinesByText(summary.lineas, 'sacame la pala');
  assert.strictEqual(matches.length, 2);
});

test('matchCartLinesByText: descripcion sin coincidencias devuelve vacio', function () {
  const summary = PadelCartCore.buildCartSummary([{ productId: 'pala-sin-talle', talle: null, cantidad: 1 }], getProduct);
  const matches = PadelCartCore.matchCartLinesByText(summary.lineas, 'sacame las medias');
  assert.strictEqual(matches.length, 0);
});

// --- resolveOfferedReference: "la primera", "la segunda", "esa", "la mas barata" ---

const OFRECIDOS_3 = [{ posicion: 1, id: 'pala-barata' }, { posicion: 2, id: 'pala-cara' }, { posicion: 3, id: 'remera-negra' }];

test('resolveOfferedReference: productId directo se respeta tal cual', function () {
  const r = PadelCartCore.resolveOfferedReference({ productId: 'pala-sin-talle' }, OFRECIDOS_3, getProduct);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.productId, 'pala-sin-talle');
});

test('resolveOfferedReference: "la primera" resuelve a la posicion 1 real', function () {
  const r = PadelCartCore.resolveOfferedReference({ referenciaPosicion: 'primera' }, OFRECIDOS_3, getProduct);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.productId, 'pala-barata');
});

test('resolveOfferedReference: "la segunda" resuelve a la posicion 2 real', function () {
  const r = PadelCartCore.resolveOfferedReference({ referenciaPosicion: 'segunda' }, OFRECIDOS_3, getProduct);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.productId, 'pala-cara');
});

test('resolveOfferedReference: "la tercera" resuelve a la posicion 3 real', function () {
  const r = PadelCartCore.resolveOfferedReference({ referenciaPosicion: 'tercera' }, OFRECIDOS_3, getProduct);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.productId, 'remera-negra');
});

test('resolveOfferedReference: posicion fuera de rango no inventa nada', function () {
  const r = PadelCartCore.resolveOfferedReference({ referenciaPosicion: 'tercera' }, [OFRECIDOS_3[0]], getProduct);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'posicion_no_disponible');
});

test('resolveOfferedReference: "esa" con un solo producto ofrecido resuelve sin ambiguedad', function () {
  const r = PadelCartCore.resolveOfferedReference({ referenciaCriterio: 'esa' }, [OFRECIDOS_3[0]], getProduct);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.productId, 'pala-barata');
});

test('resolveOfferedReference: "esa" con varios productos ofrecidos es ambigua', function () {
  const r = PadelCartCore.resolveOfferedReference({ referenciaCriterio: 'esa' }, OFRECIDOS_3, getProduct);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'ambiguo');
  assert.strictEqual(r.opciones.length, 3);
});

test('resolveOfferedReference: "esa" sin contexto previo no adivina', function () {
  const r = PadelCartCore.resolveOfferedReference({ referenciaCriterio: 'esa' }, [], getProduct);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'sin_contexto');
});

test('resolveOfferedReference: "la mas barata" elige por precio real del catalogo', function () {
  // Entre pala-barata (50000), pala-cara (500000) y remera-negra (25000),
  // remera-negra es realmente la mas barata de las tres.
  const r = PadelCartCore.resolveOfferedReference({ referenciaCriterio: 'mas_barata' }, OFRECIDOS_3, getProduct);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.productId, 'remera-negra');
});

test('resolveOfferedReference: "la mas cara" elige por precio real del catalogo', function () {
  const r = PadelCartCore.resolveOfferedReference({ referenciaCriterio: 'mas_cara' }, OFRECIDOS_3, getProduct);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.productId, 'pala-cara');
});

test('resolveOfferedReference: referencia ambigua/desconocida no elige nada', function () {
  const r = PadelCartCore.resolveOfferedReference({}, OFRECIDOS_3, getProduct);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'sin_referencia');
});

test('resolveOfferedReference: intento de referenciaPosicion invalida no inventa nada', function () {
  const r = PadelCartCore.resolveOfferedReference({ referenciaPosicion: 'cuarta' }, OFRECIDOS_3, getProduct);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'referencia_invalida');
});

console.log('');
console.log('Pruebas de lib/padel-cart.js: ' + passed + '/' + (passed + failed) + ' OK');
if (failed > 0) process.exit(1);
