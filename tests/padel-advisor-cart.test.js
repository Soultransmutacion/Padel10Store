'use strict';

// Cobertura de las herramientas de carrito del asesor de IA (Fase 1, etapa
// 3/5): agregar_al_carrito, ver_carrito, quitar_del_carrito y
// modificar_cantidad_carrito, mas la resolucion de referencias
// conversacionales ("la segunda", "esa", etc.) tal como las usa el servidor.
//
// Producto sin talle usado en las pruebas: royal-padel-cross-black-26.
// Producto con talle usado en las pruebas: royal-padel-pollera-mallorca-negra
// (talles reales: S, M, L, XL).

const assert = require('assert');
const catalog = require('../lib/padel-catalog');
const tools = require('../lib/padel-advisor-tools');
const advisor = require('../lib/padel-advisor');

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    results.push({ name: name, pass: true });
  } catch (err) {
    failed += 1;
    results.push({ name: name, pass: false, error: err && err.message ? err.message : String(err) });
  }
}

function testAsync(name, fn) {
  return fn()
    .then(function () {
      passed += 1;
      results.push({ name: name, pass: true });
    })
    .catch(function (err) {
      failed += 1;
      results.push({ name: name, pass: false, error: err && err.message ? err.message : String(err) });
    });
}

const PALA_ID = 'royal-padel-cross-black-26'; // sin talles
const POLLERA_ID = 'royal-padel-pollera-mallorca-negra'; // talles S/M/L/XL
const pala = catalog.getProductById(PALA_ID);
const pollera = catalog.getProductById(POLLERA_ID);
const productoConsultar = catalog.loadCatalog().find((p) => p.precioConsultar === true);

// --- agregar_al_carrito: productId directo ---

test('agregar_al_carrito: producto sin talle, productId directo', function () {
  const out = tools.executeTool('agregar_al_carrito', { productId: PALA_ID });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.accion, { tipo: 'agregar_al_carrito', productId: PALA_ID, talle: null, cantidad: 1 });
  assert.strictEqual(out.producto.id, PALA_ID);
  assert.strictEqual(out.productoParaModelo.contactoWhatsappDisponible, true);
  assert.strictEqual(out.productoParaModelo.link, undefined, 'la vista para el modelo nunca debe incluir el link de WhatsApp');
});

test('agregar_al_carrito: producto con talle valido y cantidad explicita', function () {
  const out = tools.executeTool('agregar_al_carrito', { productId: POLLERA_ID, talle: 'M', cantidad: 2 });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.accion, { tipo: 'agregar_al_carrito', productId: POLLERA_ID, talle: 'M', cantidad: 2 });
});

test('agregar_al_carrito: producto con talle obligatorio sin talle informado no agrega nada', function () {
  const out = tools.executeTool('agregar_al_carrito', { productId: POLLERA_ID });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'talle_requerido');
  assert.deepStrictEqual(out.tallesDisponibles, ['S', 'M', 'L', 'XL']);
  assert.strictEqual(out.accion, undefined, 'sin talle nunca debe generar una accion ejecutable');
});

test('agregar_al_carrito: talle que no existe para ese producto se rechaza', function () {
  const out = tools.executeTool('agregar_al_carrito', { productId: POLLERA_ID, talle: 'XXXL' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'talle_invalido');
});

test('agregar_al_carrito: producto a consultar nunca se puede agregar', function () {
  const out = tools.executeTool('agregar_al_carrito', { productId: productoConsultar.id });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'precio_consultar');
});

test('agregar_al_carrito: cantidad invalida se rechaza', function () {
  const out = tools.executeTool('agregar_al_carrito', { productId: PALA_ID, cantidad: 0 });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'cantidad_invalida');
});

test('agregar_al_carrito: un productId inventado por el modelo nunca resuelve una accion', function () {
  const out = tools.executeTool('agregar_al_carrito', { productId: 'id-inventado-por-el-modelo-999' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'producto_no_encontrado');
});

// --- agregar_al_carrito: referencias conversacionales ---

const OFRECIDOS = [{ id: PALA_ID }, { id: POLLERA_ID }];

test('agregar_al_carrito: "la segunda" resuelve contra la lista real ofrecida', function () {
  const out = tools.executeTool('agregar_al_carrito', { referenciaPosicion: 'segunda', talle: 'S' }, { offeredProducts: OFRECIDOS });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.accion.productId, POLLERA_ID);
  assert.strictEqual(out.accion.talle, 'S');
});

test('agregar_al_carrito: "esa" con un solo producto ofrecido resuelve sin ambiguedad', function () {
  const out = tools.executeTool('agregar_al_carrito', { referenciaCriterio: 'esa' }, { offeredProducts: [{ id: PALA_ID }] });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.accion.productId, PALA_ID);
});

test('agregar_al_carrito: "esa" con varios productos ofrecidos es ambigua y no elige ninguno', function () {
  const out = tools.executeTool('agregar_al_carrito', { referenciaCriterio: 'esa' }, { offeredProducts: OFRECIDOS });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'ambiguo');
  assert.strictEqual(out.opciones.length, 2);
});

test('agregar_al_carrito: "la mas barata" elige por precio real del catalogo, no por orden de la lista', function () {
  const out = tools.executeTool('agregar_al_carrito', { referenciaCriterio: 'mas_barata', talle: 'S' }, { offeredProducts: OFRECIDOS });
  assert.strictEqual(out.ok, true);
  const masBarata = pala.precio < pollera.precio ? PALA_ID : POLLERA_ID;
  assert.strictEqual(masBarata, POLLERA_ID, 'la pollera ($63.000) es mas barata que la pala ($206.000) en este catalogo');
  assert.strictEqual(out.accion.productId, masBarata);
});

test('agregar_al_carrito: referenciaPosicion sin lista ofrecida no inventa nada', function () {
  const out = tools.executeTool('agregar_al_carrito', { referenciaPosicion: 'primera' }, { offeredProducts: [] });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'posicion_no_disponible');
});

test('agregar_al_carrito: sin productId ni referencia alguna no inventa nada', function () {
  const out = tools.executeTool('agregar_al_carrito', {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'sin_referencia');
});

// --- ver_carrito ---

test('ver_carrito: carrito vacio da total 0', function () {
  const out = tools.executeTool('ver_carrito', {}, { carritoActual: [] });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.resumen.lineas.length, 0);
  assert.strictEqual(out.resumen.total, 0);
});

test('ver_carrito: recalcula precio real y descarta manipulaciones de localStorage', function () {
  const carritoActual = [
    { productId: PALA_ID, talle: null, cantidad: 2, precio: 1 }, // precio manipulado: se ignora
    { productId: POLLERA_ID, talle: 'M', cantidad: 1 },
    { productId: 'producto-fantasma', talle: null, cantidad: 1 }, // ya no existe: se descarta
  ];
  const out = tools.executeTool('ver_carrito', {}, { carritoActual: carritoActual });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.resumen.lineas.length, 2);
  assert.strictEqual(out.resumen.total, pala.precio * 2 + pollera.precio * 1);
  assert.strictEqual(out.resumen.descartadas.length, 1);
  assert.strictEqual(out.resumen.descartadas[0].motivo, 'no_encontrado');
});

// --- quitar_del_carrito ---

test('quitar_del_carrito: carrito vacio', function () {
  const out = tools.executeTool('quitar_del_carrito', { productId: PALA_ID }, { carritoActual: [] });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'carrito_vacio');
});

test('quitar_del_carrito: por productId exacto', function () {
  const carritoActual = [{ productId: PALA_ID, talle: null, cantidad: 1 }];
  const out = tools.executeTool('quitar_del_carrito', { productId: PALA_ID }, { carritoActual: carritoActual });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.accion, { tipo: 'quitar_del_carrito', productId: PALA_ID, talle: null });
});

test('quitar_del_carrito: por descripcion libre ("la pala") cuando es inequivoco', function () {
  const carritoActual = [
    { productId: PALA_ID, talle: null, cantidad: 1 },
    { productId: POLLERA_ID, talle: 'M', cantidad: 1 },
  ];
  const out = tools.executeTool('quitar_del_carrito', { descripcion: 'sacame la pala' }, { carritoActual: carritoActual });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.accion.productId, PALA_ID);
});

test('quitar_del_carrito: mismo producto en dos talles sin desambiguar es ambiguo_talle', function () {
  const carritoActual = [
    { productId: POLLERA_ID, talle: 'S', cantidad: 1 },
    { productId: POLLERA_ID, talle: 'M', cantidad: 1 },
  ];
  const out = tools.executeTool('quitar_del_carrito', { productId: POLLERA_ID }, { carritoActual: carritoActual });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'ambiguo_talle');
  assert.strictEqual(out.opciones.length, 2);
});

test('quitar_del_carrito: mismo producto en dos talles se resuelve al pasar el talle', function () {
  const carritoActual = [
    { productId: POLLERA_ID, talle: 'S', cantidad: 1 },
    { productId: POLLERA_ID, talle: 'M', cantidad: 1 },
  ];
  const out = tools.executeTool('quitar_del_carrito', { productId: POLLERA_ID, talle: 'M' }, { carritoActual: carritoActual });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.accion.talle, 'M');
});

test('quitar_del_carrito: producto que no esta en el carrito', function () {
  const carritoActual = [{ productId: PALA_ID, talle: null, cantidad: 1 }];
  const out = tools.executeTool('quitar_del_carrito', { productId: POLLERA_ID }, { carritoActual: carritoActual });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'no_encontrado_en_carrito');
});

test('quitar_del_carrito: sin productId, referencia ni descripcion no inventa nada', function () {
  const carritoActual = [{ productId: PALA_ID, talle: null, cantidad: 1 }];
  const out = tools.executeTool('quitar_del_carrito', {}, { carritoActual: carritoActual });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'sin_referencia');
});

// --- modificar_cantidad_carrito ---

test('modificar_cantidad_carrito: cambia a una cantidad valida', function () {
  const carritoActual = [{ productId: PALA_ID, talle: null, cantidad: 1 }];
  const out = tools.executeTool('modificar_cantidad_carrito', { productId: PALA_ID, nuevaCantidad: 5 }, { carritoActual: carritoActual });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.accion, { tipo: 'modificar_cantidad_carrito', productId: PALA_ID, talle: null, cantidad: 5 });
  assert.strictEqual(out.lineaAfectada.cantidadAnterior, 1);
  assert.strictEqual(out.lineaAfectada.cantidadNueva, 5);
});

test('modificar_cantidad_carrito: cantidad fuera de rango se rechaza', function () {
  const carritoActual = [{ productId: PALA_ID, talle: null, cantidad: 1 }];
  const out = tools.executeTool('modificar_cantidad_carrito', { productId: PALA_ID, nuevaCantidad: 999 }, { carritoActual: carritoActual });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'cantidad_invalida');
});

test('modificar_cantidad_carrito: nuevaCantidad ausente se rechaza en vez de asumir un valor', function () {
  const carritoActual = [{ productId: PALA_ID, talle: null, cantidad: 1 }];
  const out = tools.executeTool('modificar_cantidad_carrito', { productId: PALA_ID }, { carritoActual: carritoActual });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'cantidad_invalida');
});

// --- collectCards / updateOfferedProducts / collectActions (lib/padel-advisor.js) ---

test('collectCards: agregar_al_carrito exitoso adjunta su tarjeta', function () {
  const cardsById = new Map();
  const out = tools.executeTool('agregar_al_carrito', { productId: PALA_ID });
  advisor.collectCards('agregar_al_carrito', out, cardsById, advisor.createCardContext());
  assert.strictEqual(cardsById.size, 1);
  assert.strictEqual(cardsById.get(PALA_ID).id, PALA_ID);
});

test('collectCards: agregar_al_carrito fallido no adjunta tarjeta', function () {
  const cardsById = new Map();
  const out = tools.executeTool('agregar_al_carrito', { productId: POLLERA_ID }); // sin talle -> falla
  advisor.collectCards('agregar_al_carrito', out, cardsById, advisor.createCardContext());
  assert.strictEqual(cardsById.size, 0);
});

test('updateOfferedProducts: buscar_catalogo reemplaza la lista ofrecida por los resultados reales, en orden', function () {
  const ctx = advisor.createOfferedContext(['algo-viejo']);
  const out = tools.executeTool('buscar_catalogo', { texto: 'Royal Padel' });
  advisor.updateOfferedProducts('buscar_catalogo', out, ctx);
  assert.deepStrictEqual(ctx.ids, out.resultados.map((r) => r.id));
  assert.ok(ctx.ids.indexOf('algo-viejo') === -1, 'la lista vieja no debe sobrevivir a una busqueda nueva');
});

test('updateOfferedProducts: ver_producto deja una lista de un solo elemento', function () {
  const ctx = advisor.createOfferedContext([PALA_ID, POLLERA_ID]);
  const out = tools.executeTool('ver_producto', { id: POLLERA_ID });
  advisor.updateOfferedProducts('ver_producto', out, ctx);
  assert.deepStrictEqual(ctx.ids, [POLLERA_ID]);
});

test('updateOfferedProducts: una herramienta sin resultados no borra la lista anterior', function () {
  const ctx = advisor.createOfferedContext([PALA_ID]);
  const out = tools.executeTool('ver_carrito', {}, { carritoActual: [] });
  advisor.updateOfferedProducts('ver_carrito', out, ctx);
  assert.deepStrictEqual(ctx.ids, [PALA_ID]);
});

test('collectActions: solo junta acciones de resultados ok:true con accion', function () {
  const acciones = [];
  advisor.collectActions('agregar_al_carrito', tools.executeTool('agregar_al_carrito', { productId: PALA_ID }), acciones);
  advisor.collectActions('agregar_al_carrito', tools.executeTool('agregar_al_carrito', { productId: POLLERA_ID }), acciones); // falla (sin talle)
  advisor.collectActions('buscar_catalogo', tools.executeTool('buscar_catalogo', { texto: 'Royal Padel' }), acciones); // ok pero sin accion
  assert.strictEqual(acciones.length, 1);
  assert.strictEqual(acciones[0].productId, PALA_ID);
});

// --- sanitizeOfrecidos / sanitizeCarritoActual (lib/padel-advisor.js) ---

test('sanitizeOfrecidos: descarta valores invalidos y recorta al maximo', function () {
  const raw = [PALA_ID, 42, null, '', '  ', POLLERA_ID].concat(new Array(20).fill('x'));
  const out = advisor.sanitizeOfrecidos(raw);
  assert.ok(out.length <= advisor.MAX_OFRECIDOS);
  assert.strictEqual(out[0], PALA_ID);
  assert.strictEqual(out[1], POLLERA_ID);
});

test('sanitizeOfrecidos: entrada no-array da lista vacia', function () {
  assert.deepStrictEqual(advisor.sanitizeOfrecidos('no-es-un-array'), []);
  assert.deepStrictEqual(advisor.sanitizeOfrecidos(null), []);
});

test('sanitizeCarritoActual: descarta lineas sin productId string y normaliza talle vacio a null', function () {
  const raw = [
    { productId: PALA_ID, talle: '', cantidad: 1 },
    { productId: 123, talle: 'M', cantidad: 1 },
    null,
    'no-es-un-objeto',
    { talle: 'M', cantidad: 1 }, // sin productId
  ];
  const out = advisor.sanitizeCarritoActual(raw);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].productId, PALA_ID);
  assert.strictEqual(out[0].talle, null);
});

test('sanitizeCarritoActual: recorta al maximo de lineas', function () {
  const raw = new Array(50).fill(0).map(function (_, i) { return { productId: PALA_ID, talle: null, cantidad: 1 }; });
  const out = advisor.sanitizeCarritoActual(raw);
  assert.strictEqual(out.length, advisor.MAX_CARRITO_LINEAS);
});

// --- runAdvisor: flujo completo con fake client (mockeando Anthropic) ---

function buildFakeClientAgregarPorPosicion() {
  let call = 0;
  return {
    messages: {
      create: function () {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'agregar_al_carrito', input: { referenciaPosicion: 'segunda', talle: 'M' } }],
          });
        }
        return Promise.resolve({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Listo, agregue la Pollera deportiva Mallorca con short a tu carrito.' }],
        });
      },
    },
  };
}

function buildFakeClientVerCarrito() {
  let call = 0;
  return {
    messages: {
      create: function () {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'ver_carrito', input: {} }],
          });
        }
        return Promise.resolve({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Tenes 1 Cross Black 26 en tu carrito.' }],
        });
      },
    },
  };
}

function runAsyncTests() {
  return testAsync(
    'runAdvisor: "agregame la segunda" resuelve contra los ofrecidos del turno anterior y devuelve la accion validada',
    function () {
      return advisor
        .runAdvisor(
          { message: 'Agregame la segunda, talle M.', ofrecidos: [PALA_ID, POLLERA_ID] },
          buildFakeClientAgregarPorPosicion()
        )
        .then(function (result) {
          assert.strictEqual(result.acciones.length, 1);
          assert.strictEqual(result.acciones[0].tipo, 'agregar_al_carrito');
          assert.strictEqual(result.acciones[0].productId, POLLERA_ID);
        });
    }
  )
    .then(function () {
      return testAsync('runAdvisor: ver_carrito usa el carrito real enviado por el cliente, no inventa un total', function () {
        return advisor
          .runAdvisor(
            { message: 'Que tengo en el carrito?', carritoActual: [{ productId: PALA_ID, talle: null, cantidad: 1 }] },
            buildFakeClientVerCarrito()
          )
          .then(function (result) {
            assert.strictEqual(result.acciones.length, 0, 'ver_carrito nunca genera una accion mutable');
            assert.ok(Array.isArray(result.ofrecidos));
          });
      });
    })
    .then(function () {
      return testAsync('runAdvisor: sin ofrecidos ni carrito previos, todo funciona con listas vacias (no revienta)', function () {
        return advisor.runAdvisor({ message: 'Hola' }, buildFakeClientVerCarritoVacio()).then(function (result) {
          assert.ok(Array.isArray(result.ofrecidos));
          assert.ok(Array.isArray(result.acciones));
        });
      });
    });
}

function buildFakeClientVerCarritoVacio() {
  return {
    messages: {
      create: function () {
        return Promise.resolve({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hola! En que te puedo ayudar?' }] });
      },
    },
  };
}

runAsyncTests().then(function () {
  console.log('');
  results.forEach(function (r) {
    if (r.pass) {
      console.log('PASS - ' + r.name);
    } else {
      console.log('FAIL - ' + r.name);
      console.log('  ' + r.error);
    }
  });
  console.log('');
  console.log('Pruebas de herramientas de carrito del asesor: ' + passed + '/' + (passed + failed) + ' OK');
  if (failed > 0) process.exit(1);
});
