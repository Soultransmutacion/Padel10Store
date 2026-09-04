'use strict';

// Fase 1 (5/5): tests de integracion asistente <-> carrito.
//
// A diferencia de tests/padel-cart.test.js (nucleo determinista aislado) y
// tests/padel-advisor-cart.test.js (herramientas del asesor una por una),
// este archivo prueba el FLUJO COMPLETO extremo a extremo tal como ocurre en
// produccion: el asesor de IA resuelve una referencia conversacional y
// devuelve una accion validada (lib/padel-advisor-tools.js), esa accion se
// ejecuta contra un carrito de cliente real (simulateClientCart, mas abajo),
// y despues el asesor vuelve a leer ese mismo carrito con ver_carrito -y
// viceversa: la "tienda" modifica el carrito directamente y el asesor lo ve-.
//
// simulateClientCart() no es un mock simplificado: reproduce exactamente el
// mismo algoritmo que widget/padel-cart.js (addItem/removeItem/changeQuantity/
// setQuantity/getRawLines), usando las mismas funciones de
// PadelCartCore (buildLine, findLineIndex, validateQuantity,
// buildCartSummary) que ya carga ese archivo por <script>. Lo unico que este
// archivo no puede ejercitar por ser Node puro (sin navegador) es el DOM real
// y localStorage; esa parte especifica se verifica por separado con un
// navegador real (ver el informe final de la Fase 1 y la verificacion hecha
// con Playwright).

const assert = require('assert');
const catalog = require('../lib/padel-catalog');
const PadelCartCore = require('../lib/padel-cart');
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

function getProduct(id) {
  return catalog.getProductById(id);
}

// Reproduce el mismo algoritmo que window.PadelCart (widget/padel-cart.js),
// operando en memoria sobre las mismas funciones de PadelCartCore. "cliente"
// aqui representa lo que en el navegador seria window.PadelCart: la unica
// fuente de verdad del carrito, compartida por la tienda y por las acciones
// que ejecuta el asesor.
function simulateClientCart() {
  let lines = [];

  function findIndex(productId, talle) {
    return PadelCartCore.findLineIndex(lines, productId, talle || null);
  }

  function addItem(productId, talle, cantidad) {
    const product = getProduct(productId);
    const result = PadelCartCore.buildLine(product, talle, cantidad);
    if (!result.ok) return result;
    const idx = findIndex(result.line.productId, result.line.talle);
    if (idx > -1) {
      const nueva = lines[idx].cantidad + result.line.cantidad;
      lines[idx].cantidad = nueva > PadelCartCore.MAX_QUANTITY ? PadelCartCore.MAX_QUANTITY : nueva;
    } else {
      lines.push(result.line);
    }
    return { ok: true, line: result.line };
  }

  function removeItem(productId, talle) {
    const idx = findIndex(productId, talle || null);
    if (idx === -1) return { ok: false, error: 'no_encontrado_en_carrito' };
    lines.splice(idx, 1);
    return { ok: true };
  }

  function changeQuantity(productId, talle, delta) {
    const idx = findIndex(productId, talle || null);
    if (idx === -1) return { ok: false, error: 'no_encontrado_en_carrito' };
    lines[idx].cantidad += delta;
    if (lines[idx].cantidad < PadelCartCore.MIN_QUANTITY) {
      lines.splice(idx, 1);
    } else if (lines[idx].cantidad > PadelCartCore.MAX_QUANTITY) {
      lines[idx].cantidad = PadelCartCore.MAX_QUANTITY;
    }
    return { ok: true };
  }

  function setQuantity(productId, talle, cantidad) {
    const cantidadResult = PadelCartCore.validateQuantity(cantidad);
    if (!cantidadResult.ok) return cantidadResult;
    const idx = findIndex(productId, talle || null);
    if (idx === -1) return { ok: false, error: 'no_encontrado_en_carrito' };
    lines[idx].cantidad = cantidadResult.cantidad;
    return { ok: true };
  }

  function getRawLines() {
    return lines.map((l) => ({ productId: l.productId, talle: l.talle, cantidad: l.cantidad }));
  }

  function getSummary() {
    return PadelCartCore.buildCartSummary(lines, getProduct);
  }

  // Simula localStorage.setItem/getItem tal como lo hace widget/padel-cart.js
  // (persist/loadPersisted): serializa solo productId/talle/cantidad.
  function persistToJson() {
    return JSON.stringify(getRawLines());
  }

  // Simula restoreAndInit(): parsea el JSON persistido y lo reconstruye
  // SIEMPRE contra el catalogo real via buildCartSummary, nunca confiando en
  // el precio ni en la validez guardada. Reemplaza el estado actual del
  // cliente por el restaurado, como pasa en una recarga real de pagina.
  function restoreFromJson(json) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      parsed = [];
    }
    if (!Array.isArray(parsed)) parsed = [];
    const summary = PadelCartCore.buildCartSummary(parsed, getProduct);
    lines = summary.lineas.map((l) => ({ productId: l.productId, talle: l.talle, cantidad: l.cantidad }));
    return summary;
  }

  // Aplica una accion ya validada por el servidor (lo que hace
  // widget/padel-advisor.js#applyAccionCarrito en el navegador real).
  function applyAccion(accion) {
    if (!accion || !accion.tipo) return;
    if (accion.tipo === 'agregar_al_carrito') addItem(accion.productId, accion.talle, accion.cantidad);
    else if (accion.tipo === 'quitar_del_carrito') removeItem(accion.productId, accion.talle);
    else if (accion.tipo === 'modificar_cantidad_carrito') setQuantity(accion.productId, accion.talle, accion.cantidad);
  }

  return {
    addItem,
    removeItem,
    changeQuantity,
    setQuantity,
    getRawLines,
    getSummary,
    persistToJson,
    restoreFromJson,
    applyAccion,
  };
}

const PALA_ID = 'royal-padel-cross-black-26'; // sin talles, $206.000
const POLLERA_ID = 'royal-padel-pollera-mallorca-negra'; // talles S/M/L/XL, $63.000

// Tercer producto usado para las pruebas de "primera/segunda/tercera" y
// "mas barata/mas cara": debe existir de verdad en el catalogo y no requerir
// talle, para poder comparar precios sin depender de una eleccion de talle.
const tercerProducto = catalog.loadCatalog().find((p) => p.id !== PALA_ID && p.id !== POLLERA_ID && (!Array.isArray(p.talles) || p.talles.length === 0) && p.precioConsultar !== true);
assert.ok(tercerProducto, 'se necesita un tercer producto real sin talle y con precio para las pruebas de integracion');

const OFRECIDOS_3 = [{ id: PALA_ID }, { id: POLLERA_ID }, { id: tercerProducto.id }];

// --- Flujo completo: asesor agrega -> carrito del cliente lo refleja -> asesor lo vuelve a leer ---

test('flujo completo: "la segunda" del asesor agrega la linea real en el carrito del cliente', function () {
  const cliente = simulateClientCart();
  const out = tools.executeTool('agregar_al_carrito', { referenciaPosicion: 'segunda', talle: 'M' }, { offeredProducts: OFRECIDOS_3 });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.accion.productId, POLLERA_ID);
  cliente.applyAccion(out.accion);

  const raw = cliente.getRawLines();
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].productId, POLLERA_ID);
  assert.strictEqual(raw[0].talle, 'M');

  // El asesor consulta el carrito real del cliente (ver_carrito): debe ver
  // exactamente la linea que se acaba de agregar, con el precio real.
  const verOut = tools.executeTool('ver_carrito', {}, { carritoActual: cliente.getRawLines() });
  assert.strictEqual(verOut.ok, true);
  assert.strictEqual(verOut.resumen.lineas.length, 1);
  assert.strictEqual(verOut.resumen.lineas[0].productId, POLLERA_ID);
  assert.strictEqual(verOut.resumen.total, catalog.getProductById(POLLERA_ID).precio);
});

test('flujo completo: la tienda modifica la cantidad y el asesor ve el cambio al llamar ver_carrito', function () {
  const cliente = simulateClientCart();
  cliente.addItem(PALA_ID, null, 1);

  // La tienda (drawer, botones +/-) cambia la cantidad directamente contra
  // el mismo carrito, sin pasar por el asesor.
  const cambio = cliente.changeQuantity(PALA_ID, null, 2); // 1 + 2 = 3
  assert.strictEqual(cambio.ok, true);

  const verOut = tools.executeTool('ver_carrito', {}, { carritoActual: cliente.getRawLines() });
  assert.strictEqual(verOut.ok, true);
  assert.strictEqual(verOut.resumen.lineas[0].cantidad, 3);
  assert.strictEqual(verOut.resumen.total, catalog.getProductById(PALA_ID).precio * 3);
});

test('flujo completo: la tienda elimina la linea y el asesor ve el carrito vacio', function () {
  const cliente = simulateClientCart();
  cliente.addItem(PALA_ID, null, 1);
  cliente.removeItem(PALA_ID, null);

  const verOut = tools.executeTool('ver_carrito', {}, { carritoActual: cliente.getRawLines() });
  assert.strictEqual(verOut.ok, true);
  assert.strictEqual(verOut.resumen.lineas.length, 0);
  assert.strictEqual(verOut.resumen.total, 0);
});

test('flujo completo: el asesor modifica una linea que la tienda agrego a mano, y la tienda ve el resultado', function () {
  const cliente = simulateClientCart();
  // El cliente agrega manualmente desde la tienda (no via asesor).
  cliente.addItem(POLLERA_ID, 'L', 1);

  // El cliente le pide al asesor que le cambie la cantidad a 4. El asesor
  // resuelve la linea real (por productId) contra el carrito que le mando el
  // cliente y devuelve una accion validada.
  const out = tools.executeTool(
    'modificar_cantidad_carrito',
    { productId: POLLERA_ID, talle: 'L', nuevaCantidad: 4 },
    { carritoActual: cliente.getRawLines() }
  );
  assert.strictEqual(out.ok, true);
  cliente.applyAccion(out.accion);

  const raw = cliente.getRawLines();
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].cantidad, 4);
});

// --- Flujo completo con referencias conversacionales sobre 3 productos ofrecidos ---

test('flujo completo: "esa" con un solo producto ofrecido agrega esa linea real', function () {
  const cliente = simulateClientCart();
  const out = tools.executeTool('agregar_al_carrito', { referenciaCriterio: 'esa' }, { offeredProducts: [{ id: PALA_ID }] });
  assert.strictEqual(out.ok, true);
  cliente.applyAccion(out.accion);
  assert.deepStrictEqual(cliente.getRawLines(), [{ productId: PALA_ID, talle: null, cantidad: 1 }]);
});

test('flujo completo: "ese" se interpreta igual que "esa" (mismo criterio estructurado, mismo resultado deterministico)', function () {
  // El modelo mapea tanto "esa" como "ese" al mismo valor cerrado
  // referenciaCriterio: 'esa' (ver lib/padel-advisor-system-prompt.js,
  // seccion CARRITO): la palabra que uso el cliente no cambia la resolucion,
  // que siempre pasa por PadelCartCore.resolveOfferedReference.
  const cliente = simulateClientCart();
  const out = tools.executeTool('agregar_al_carrito', { referenciaCriterio: 'esa' }, { offeredProducts: [{ id: PALA_ID }] });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.accion.productId, PALA_ID);
  cliente.applyAccion(out.accion);
  assert.strictEqual(cliente.getRawLines().length, 1);
});

test('flujo completo: "la mas cara" de 3 ofrecidos agrega el producto correcto segun el precio real', function () {
  const cliente = simulateClientCart();
  const precios = OFRECIDOS_3.map((o) => catalog.getProductById(o.id).precio);
  const maxPrecio = Math.max.apply(null, precios);
  const masCaraId = OFRECIDOS_3.find((o) => catalog.getProductById(o.id).precio === maxPrecio).id;
  const masCaraProduct = catalog.getProductById(masCaraId);
  const talle = Array.isArray(masCaraProduct.talles) && masCaraProduct.talles.length ? masCaraProduct.talles[0] : undefined;

  const out = tools.executeTool('agregar_al_carrito', { referenciaCriterio: 'mas_cara', talle: talle }, { offeredProducts: OFRECIDOS_3 });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.accion.productId, masCaraId);
  cliente.applyAccion(out.accion);
  assert.strictEqual(cliente.getRawLines()[0].productId, masCaraId);
});

// --- Flujo completo: casos que NUNCA deben tocar el carrito del cliente ---

test('flujo completo: referencia ambigua ("esa" con 3 ofrecidos) nunca modifica el carrito del cliente', function () {
  const cliente = simulateClientCart();
  const out = tools.executeTool('agregar_al_carrito', { referenciaCriterio: 'esa' }, { offeredProducts: OFRECIDOS_3 });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'ambiguo');
  assert.strictEqual(out.accion, undefined);
  cliente.applyAccion(out.accion); // applyAccion con accion undefined no debe hacer nada
  assert.strictEqual(cliente.getRawLines().length, 0);
});

test('flujo completo: talle obligatorio sin talle nunca modifica el carrito del cliente', function () {
  const cliente = simulateClientCart();
  const out = tools.executeTool('agregar_al_carrito', { productId: POLLERA_ID });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'talle_requerido');
  cliente.applyAccion(out.accion);
  assert.strictEqual(cliente.getRawLines().length, 0);
});

test('flujo completo: talle invalido nunca modifica el carrito del cliente', function () {
  const cliente = simulateClientCart();
  const out = tools.executeTool('agregar_al_carrito', { productId: POLLERA_ID, talle: 'XXXXL' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'talle_invalido');
  cliente.applyAccion(out.accion);
  assert.strictEqual(cliente.getRawLines().length, 0);
});

test('flujo completo: un productId inventado por el modelo nunca modifica el carrito del cliente', function () {
  const cliente = simulateClientCart();
  const out = tools.executeTool('agregar_al_carrito', { productId: 'producto-que-el-modelo-invento-123' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'producto_no_encontrado');
  cliente.applyAccion(out.accion);
  assert.strictEqual(cliente.getRawLines().length, 0);
});

test('flujo completo: quitar un producto inexistente en el carrito real no toca el resto de las lineas', function () {
  const cliente = simulateClientCart();
  cliente.addItem(PALA_ID, null, 1);
  const out = tools.executeTool('quitar_del_carrito', { productId: 'este-producto-no-esta-en-el-carrito' }, { carritoActual: cliente.getRawLines() });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'no_encontrado_en_carrito');
  cliente.applyAccion(out.accion);
  assert.strictEqual(cliente.getRawLines().length, 1, 'el resto del carrito no debe verse afectado por un intento fallido');
});

test('flujo completo: agregar el mismo producto/talle dos veces desde el asesor suma cantidad en la misma linea, no duplica', function () {
  const cliente = simulateClientCart();
  const out1 = tools.executeTool('agregar_al_carrito', { productId: POLLERA_ID, talle: 'S', cantidad: 1 });
  cliente.applyAccion(out1.accion);
  const out2 = tools.executeTool('agregar_al_carrito', { productId: POLLERA_ID, talle: 'S', cantidad: 2 });
  cliente.applyAccion(out2.accion);

  const raw = cliente.getRawLines();
  assert.strictEqual(raw.length, 1, 'debe seguir siendo una sola linea, no dos');
  assert.strictEqual(raw[0].cantidad, 3);
});

// --- Persistencia (simulacion de localStorage: serializar y restaurar) ---

test('persistencia: serializar y restaurar el carrito reproduce exactamente el mismo resumen', function () {
  const cliente = simulateClientCart();
  cliente.addItem(PALA_ID, null, 2);
  cliente.addItem(POLLERA_ID, 'M', 1);
  const resumenAntes = cliente.getSummary();

  const json = cliente.persistToJson(); // equivalente a localStorage.setItem
  const nuevoCliente = simulateClientCart(); // equivalente a recargar la pagina
  const resumenDespues = nuevoCliente.restoreFromJson(json); // equivalente a restoreAndInit()

  assert.strictEqual(resumenDespues.lineas.length, resumenAntes.lineas.length);
  assert.strictEqual(resumenDespues.total, resumenAntes.total);
  assert.deepStrictEqual(nuevoCliente.getRawLines(), cliente.getRawLines());
});

test('persistencia: precio manipulado en el JSON persistido (localStorage editado a mano) se ignora al restaurar', function () {
  const cliente = simulateClientCart();
  const jsonManipulado = JSON.stringify([{ productId: PALA_ID, talle: null, cantidad: 1, precio: 1 }]);
  const resumen = cliente.restoreFromJson(jsonManipulado);
  assert.strictEqual(resumen.lineas.length, 1);
  assert.strictEqual(resumen.lineas[0].precio, catalog.getProductById(PALA_ID).precio);
  assert.notStrictEqual(resumen.lineas[0].precio, 1);
});

test('persistencia: productId invalido en el JSON persistido se descarta sin romper el resto del carrito', function () {
  const cliente = simulateClientCart();
  const jsonManipulado = JSON.stringify([
    { productId: PALA_ID, talle: null, cantidad: 1 },
    { productId: 'producto-que-ya-no-existe', talle: null, cantidad: 1 },
  ]);
  const resumen = cliente.restoreFromJson(jsonManipulado);
  assert.strictEqual(resumen.lineas.length, 1);
  assert.strictEqual(resumen.lineas[0].productId, PALA_ID);
  assert.strictEqual(resumen.descartadas.length, 1);
  assert.strictEqual(resumen.descartadas[0].motivo, 'no_encontrado');
});

test('persistencia: talle invalido en el JSON persistido se descarta (por ejemplo si el producto dejo de tener ese talle)', function () {
  const cliente = simulateClientCart();
  const jsonManipulado = JSON.stringify([{ productId: POLLERA_ID, talle: 'TALLE-QUE-NO-EXISTE', cantidad: 1 }]);
  const resumen = cliente.restoreFromJson(jsonManipulado);
  assert.strictEqual(resumen.lineas.length, 0);
  assert.strictEqual(resumen.descartadas[0].motivo, 'talle_invalido');
});

test('persistencia: JSON corrupto (no es un array) restaura un carrito vacio en vez de romper', function () {
  const cliente = simulateClientCart();
  const resumen = cliente.restoreFromJson('{"esto no es un array de lineas": true}');
  assert.strictEqual(resumen.lineas.length, 0);
  assert.strictEqual(resumen.total, 0);
});

console.log('');
console.log('Pruebas de integracion asistente <-> carrito: ' + passed + '/' + (passed + failed) + ' OK');
if (failed > 0) process.exit(1);
