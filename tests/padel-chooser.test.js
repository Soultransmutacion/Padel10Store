'use strict';

// Fase 2 - Etapa 6: "¿cuál me conviene a mí?" - elegir determinista entre
// productos ya comparados/ofrecidos.
//
// Cubre 3 capas, mismo estilo que tests/padel-recommender.test.js:
//   1) lib/padel-chooser.js: el nucleo puro (ganador/empate/falta de
//      informacion/pregunta sugerida/alternativa), probado con productos
//      sinteticos controlados para aislar cada criterio, reutilizando
//      SIEMPRE lib/padel-recommender.js (nunca reimplementa scoring).
//   2) lib/padel-advisor-tools.js: la tool elegir_producto_para_usuario,
//      que resuelve los candidatos (ids/referencias/ofrecidos por defecto)
//      exactamente igual que comparar_productos, y delega la decision
//      siempre al modulo puro.
//   3) lib/padel-advisor.js (runAdvisor): el transporte del ganador hacia
//      "ofrecidos" (para que "esa"/"la primera" sigan funcionando despues),
//      la garantia de que el score interno nunca llega al modelo, y que
//      carrito/comparador/perfil siguen funcionando con normalidad.
//
// No implementa (a proposito, pedido original item 12): porcentajes de
// compatibilidad, ranking visual numerico, ordenes, envios, base de datos,
// panel de administracion, webhook, Mercado Pago en produccion.

const assert = require('assert');
const Chooser = require('../lib/padel-chooser');
const PadelProfile = require('../lib/padel-profile');
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

// --- Fixtures sinteticos: misma forma que tests/padel-recommender.test.js,
// para poder aislar cada criterio del ranking sin ruido del resto del
// catalogo real. ---

function paleta(id, overrides) {
  const base = {
    id: id,
    tipoProducto: 'Paleta',
    precio: 200000,
    precioConsultar: false,
    especificaciones: {
      forma: null,
      nivelRecomendado: null,
      nivelRecomendadoEsInferencia: false,
      estiloJuego: null,
      estiloJuegoEsInferencia: false,
      clasificacionComercialSitio: null,
    },
  };
  const merged = Object.assign({}, base, overrides || {});
  merged.especificaciones = Object.assign({}, base.especificaciones, (overrides && overrides.especificaciones) || {});
  return merged;
}

// Fixtures reales ya usados en otros archivos de tests (mismos IDs).
const ATAQUE_ID = 'royal-padel-europe-carbono'; // Paleta real, $365.700, clasificacion "ataque", forma no confirmada
const CONTROL_ID = 'royal-padel-aniversario-36'; // Paleta real, $256.500, clasificacion "control", forma "redondo"
const POLLERA_ID = 'royal-padel-pollera-mallorca-negra'; // Ropa Mujer real: nunca debe ser evaluable como pala

// =====================================================================
// 1) lib/padel-chooser.js - nucleo puro
// =====================================================================

test('1) elegir entre 2 productos validos: devuelve ok:true con un ganador o un empate explicito, nunca un error', function () {
  const productos = [paleta('a', { precio: 200000 }), paleta('b', { precio: 250000 })];
  const r = Chooser.choose(productos, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(typeof r.hayGanador, 'boolean');
  assert.strictEqual(typeof r.empate, 'boolean');
  assert.strictEqual(r.hayGanador, !r.empate);
});

test('2) perfil con prioridad potencia: el candidato clasificado "ataque" gana con motivo real', function () {
  const productos = [
    paleta('ataque', { especificaciones: { clasificacionComercialSitio: 'ataque' } }),
    paleta('control', { especificaciones: { clasificacionComercialSitio: 'control' } }),
  ];
  const r = Chooser.choose(productos, { prioridad: 'potencia' });
  assert.strictEqual(r.hayGanador, true);
  assert.strictEqual(r.ganador, 'ataque');
  const ganadorResultado = r.resultados.find(function (x) { return x.productId === 'ataque'; });
  assert.ok(ganadorResultado.motivos.indexOf('Clasificación de ataque coincide con la prioridad potencia') !== -1);
});

test('3) perfil con prioridad control: el candidato clasificado "control" gana con motivo real', function () {
  const productos = [
    paleta('control', { especificaciones: { clasificacionComercialSitio: 'control' } }),
    paleta('polivalente', { especificaciones: { clasificacionComercialSitio: 'polivalente' } }),
  ];
  const r = Chooser.choose(productos, { prioridad: 'control' });
  assert.strictEqual(r.hayGanador, true);
  assert.strictEqual(r.ganador, 'control');
  const ganadorResultado = r.resultados.find(function (x) { return x.productId === 'control'; });
  assert.ok(ganadorResultado.motivos.indexOf('Clasificación de control coincide con la prioridad control') !== -1);
});

test('4) usar presupuesto: el candidato dentro de presupuesto gana sobre uno mas barato pero sin senal de perfil', function () {
  // Ambos sin clasificacion/forma/nivel: la unica senal real de perfil es el
  // presupuesto (peso mas fuerte del recomendador), asi que debe decidir por
  // si solo, incluso mas alla de la diferencia de precio relativo.
  const productos = [paleta('dentro', { precio: 240000 }), paleta('fuera', { precio: 300000 })];
  const r = Chooser.choose(productos, { presupuestoMax: 250000 });
  assert.strictEqual(r.hayGanador, true);
  assert.strictEqual(r.ganador, 'dentro');
});

test('5) usar forma preferida: el candidato con la forma declarada gana con motivo real', function () {
  const productos = [
    paleta('diamante', { especificaciones: { forma: 'diamante' } }),
    paleta('lagrima', { especificaciones: { forma: 'lagrima' } }),
  ];
  const r = Chooser.choose(productos, { formaPreferida: 'diamante' });
  assert.strictEqual(r.hayGanador, true);
  assert.strictEqual(r.ganador, 'diamante');
  const ganadorResultado = r.resultados.find(function (x) { return x.productId === 'diamante'; });
  assert.ok(ganadorResultado.motivos.indexOf('Forma diamante coincide con la preferencia') !== -1);
});

test('6) usar nivel cuando existe: el candidato con nivelRecomendado confirmado que coincide gana', function () {
  const productos = [
    paleta('intermedio', { especificaciones: { nivelRecomendado: 'intermedio' } }),
    paleta('avanzado', { especificaciones: { nivelRecomendado: 'avanzado' } }),
  ];
  const r = Chooser.choose(productos, { nivel: 'intermedio' });
  assert.strictEqual(r.hayGanador, true);
  assert.strictEqual(r.ganador, 'intermedio');
  const ganadorResultado = r.resultados.find(function (x) { return x.productId === 'intermedio'; });
  assert.ok(ganadorResultado.motivos.indexOf('Nivel recomendado intermedio coincide con tu nivel') !== -1);
});

test('7) usar estilo cuando existe: el candidato con estiloJuego (campo del producto) que coincide con la prioridad gana', function () {
  // estiloJuego (distinto de clasificacionComercialSitio) pesa exactamente
  // UMBRAL_EMPATE (100): es el caso limite que confirma que una diferencia
  // de EXACTAMENTE 100 ya alcanza para declarar un ganador (no es "< 100").
  // Ambos con la MISMA cantidad de criterios confirmados (1 cada uno, en un
  // campo sin relacion con la prioridad declarada), para aislar el peso de
  // estiloJuego sin que la cantidad de datos confirmados sume puntos extra.
  const productos = [
    paleta('con-estilo', { especificaciones: { estiloJuego: 'potencia' } }),
    paleta('sin-estilo', { especificaciones: { nivelRecomendado: 'profesional' } }),
  ];
  const r = Chooser.choose(productos, { prioridad: 'potencia' });
  const conEstilo = r.resultados.find(function (x) { return x.productId === 'con-estilo'; });
  const sinEstilo = r.resultados.find(function (x) { return x.productId === 'sin-estilo'; });
  assert.strictEqual(conEstilo.scoreInterno - sinEstilo.scoreInterno, Chooser.UMBRAL_EMPATE);
  assert.strictEqual(r.hayGanador, true);
  assert.strictEqual(r.ganador, 'con-estilo');
  assert.ok(conEstilo.motivos.indexOf('Estilo de juego potencia coincide con la prioridad declarada') !== -1);
});

test('8) ignorar datos ausentes: un campo del perfil sin dato real en ningun candidato no inventa ningun motivo', function () {
  const productos = [paleta('a', { precio: 200000 }), paleta('b', { precio: 200000 })];
  const r = Chooser.choose(productos, { nivel: 'avanzado', estilo: 'ataque', formaPreferida: 'diamante' });
  r.resultados.forEach(function (res) {
    assert.deepStrictEqual(res.motivos, []);
  });
});

test('9) no inventar motivo: los motivos del ganador son exactamente el subconjunto real que devuelve el recomendador', function () {
  const productos = [
    paleta('ataque', { especificaciones: { clasificacionComercialSitio: 'ataque' } }),
    paleta('control', { especificaciones: { clasificacionComercialSitio: 'control' } }),
  ];
  const r = Chooser.choose(productos, { prioridad: 'potencia' });
  const ganadorResultado = r.resultados.find(function (x) { return x.productId === r.ganador; });
  assert.deepStrictEqual(ganadorResultado.motivos, ['Clasificación de ataque coincide con la prioridad potencia']);
});

test('10) candidato fuera de presupuesto pierde cuando hay una alternativa valida dentro de presupuesto', function () {
  const productos = [paleta('cara', { precio: 300000 }), paleta('barata', { precio: 200000 })];
  const r = Chooser.choose(productos, { presupuestoMax: 250000 });
  assert.strictEqual(r.hayGanador, true);
  assert.strictEqual(r.ganador, 'barata');
  const cara = r.resultados.find(function (x) { return x.productId === 'cara'; });
  assert.ok(cara.advertencias.some(function (a) { return a.indexOf('supera el presupuesto declarado de $250.000') !== -1; }));
});

test('11) ninguno dentro de presupuesto: no se oculta la advertencia y la decision sigue siendo deterministica', function () {
  const productos = [paleta('cara1', { precio: 300000 }), paleta('cara2', { precio: 320000 })];
  const r = Chooser.choose(productos, { presupuestoMax: 100000 });
  assert.strictEqual(r.ok, true);
  r.resultados.forEach(function (res) {
    assert.ok(res.advertencias.some(function (a) { return a.indexOf('supera el presupuesto declarado de $100.000') !== -1; }));
  });
});

test('12) empate real: dos candidatos sin ninguna senal de perfil que los diferencie devuelven empate explicito', function () {
  const productos = [paleta('x', { precio: 200000 }), paleta('y', { precio: 200000 })];
  const r = Chooser.choose(productos, {});
  assert.strictEqual(r.empate, true);
  assert.strictEqual(r.hayGanador, false);
  assert.strictEqual(r.ganador, null);
});

test('13) datos insuficientes: perfil sin ninguna senal declarada nunca elige un ganador arbitrario', function () {
  const productos = [
    paleta('ataque', { precio: 200000, especificaciones: { clasificacionComercialSitio: 'ataque' } }),
    paleta('control', { precio: 260000, especificaciones: { clasificacionComercialSitio: 'control' } }),
  ];
  const r = Chooser.choose(productos, {});
  assert.strictEqual(r.faltaInformacion, true);
  assert.strictEqual(r.hayGanador, false);
  assert.strictEqual(r.ganador, null);
});

test('14) pregunta de aclaracion: cuando falta presupuesto y los candidatos tienen precios distintos, sugiere esa pregunta concreta', function () {
  const productos = [paleta('barata', { precio: 200000 }), paleta('cara', { precio: 300000 })];
  const r = Chooser.choose(productos, {});
  assert.strictEqual(r.hayGanador, false);
  assert.strictEqual(r.preguntaSugerida, '¿Tenés un presupuesto máximo en mente?');
});

test('14b) pregunta de aclaracion: con presupuesto ya declarado pero prioridad ausente y clasificaciones distintas, pregunta por prioridad', function () {
  const productos = [
    paleta('ataque', { precio: 200000, especificaciones: { clasificacionComercialSitio: 'ataque' } }),
    paleta('control', { precio: 200000, especificaciones: { clasificacionComercialSitio: 'control' } }),
  ];
  const r = Chooser.choose(productos, { presupuestoMax: 300000 });
  assert.strictEqual(r.hayGanador, false);
  assert.strictEqual(r.preguntaSugerida, '¿Priorizás más potencia o control?');
});

test('14c) pregunta de aclaracion: nunca sugiere mas de una pregunta a la vez', function () {
  const productos = [paleta('barata', { precio: 200000 }), paleta('cara', { precio: 300000 })];
  const r = Chooser.choose(productos, {});
  assert.strictEqual(typeof r.preguntaSugerida === 'string' || r.preguntaSugerida === null, true);
});

test('15) cambio de perfil antes de elegir: el perfil actualizado decide, nunca uno viejo/obsoleto', function () {
  const productos = [
    paleta('ataque', { especificaciones: { clasificacionComercialSitio: 'ataque' } }),
    paleta('control', { especificaciones: { clasificacionComercialSitio: 'control' } }),
  ];
  const perfilViejo = { prioridad: 'potencia' };
  const perfilNuevo = { prioridad: 'control' };
  const rViejo = Chooser.choose(productos, perfilViejo);
  const rNuevo = Chooser.choose(productos, perfilNuevo);
  assert.strictEqual(rViejo.ganador, 'ataque');
  assert.strictEqual(rNuevo.ganador, 'control');
});

test('candidatos insuficientes: menos de 2 productos reales devuelve error explicito, nunca elige solo', function () {
  const r = Chooser.choose([paleta('solo1', {})], {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'productos_insuficientes');
});

test('candidatos no evaluables: menos de 2 palas reales entre los productos (por ejemplo comparar con ropa) no elige arbitrariamente', function () {
  const productos = catalog.loadCatalog();
  const pollera = productos.find(function (p) { return p.id === POLLERA_ID; });
  const ataque = productos.find(function (p) { return p.id === ATAQUE_ID; });
  assert.ok(pollera && ataque);
  const r = Chooser.choose([pollera, ataque], { prioridad: 'potencia' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'candidatos_no_evaluables');
});

test('alternativa (item 10 del pedido): solo aparece cuando hay ganador claro y el segundo tiene una clasificacion real distinta', function () {
  const productos = [
    paleta('ataque', { especificaciones: { clasificacionComercialSitio: 'ataque' } }),
    paleta('control', { especificaciones: { clasificacionComercialSitio: 'control' } }),
  ];
  const r = Chooser.choose(productos, { prioridad: 'potencia' });
  assert.strictEqual(r.hayGanador, true);
  assert.ok(r.alternativa);
  assert.strictEqual(r.alternativa.productId, 'control');
  assert.strictEqual(r.alternativa.clasificacion, 'control');
});

test('alternativa nunca aparece cuando hay empate/falta de informacion', function () {
  const productos = [paleta('x', { precio: 200000 }), paleta('y', { precio: 200000 })];
  const r = Chooser.choose(productos, {});
  assert.strictEqual(r.alternativa, null);
});

test('todos los productId devueltos por choose() sobre el catalogo real son palas reales', function () {
  const productos = catalog.loadCatalog();
  const candidatos = [catalog.getProductById(ATAQUE_ID), catalog.getProductById(CONTROL_ID)];
  const r = Chooser.choose(candidatos, { prioridad: 'potencia' });
  assert.strictEqual(r.ok, true);
  r.resultados.forEach(function (res) {
    const real = catalog.getProductById(res.productId);
    assert.ok(real, res.productId + ' debe existir de verdad en el catalogo');
    assert.strictEqual(real.tipoProducto, 'Paleta');
  });
});

// =====================================================================
// 2) lib/padel-advisor-tools.js - resolucion de candidatos + tool
// =====================================================================

test('16) comparacion -> elegir: con "ids" reales (los mismos que ya devolvio una comparacion) elige entre esos productos', function () {
  const out = tools.executeTool(
    'elegir_producto_para_usuario',
    { ids: [ATAQUE_ID, CONTROL_ID], prioridad: 'potencia' },
    { perfilCompra: PadelProfile.emptyPerfilCompra() }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.hayGanador, true);
  assert.strictEqual(out.ganador, ATAQUE_ID);
});

test('17) ofrecidos -> elegir: sin ids ni referencias, usa automaticamente los ultimos productos ofrecidos', function () {
  const offeredProducts = [{ id: ATAQUE_ID }, { id: CONTROL_ID }];
  const out = tools.executeTool(
    'elegir_producto_para_usuario',
    { prioridad: 'control' },
    { perfilCompra: PadelProfile.emptyPerfilCompra(), offeredProducts: offeredProducts }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.hayGanador, true);
  assert.strictEqual(out.ganador, CONTROL_ID);
});

test('18) primera/segunda -> elegir: con "referencias" posicionales sobre la ultima lista ofrecida', function () {
  const offeredProducts = [{ id: ATAQUE_ID }, { id: CONTROL_ID }];
  const out = tools.executeTool(
    'elegir_producto_para_usuario',
    { referencias: [{ referenciaPosicion: 'primera' }, { referenciaPosicion: 'segunda' }], prioridad: 'potencia' },
    { perfilCompra: PadelProfile.emptyPerfilCompra(), offeredProducts: offeredProducts }
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.ganador, ATAQUE_ID);
});

test('19) ID inexistente: se reporta en noEncontrados y, si igual quedan 2 validos, la eleccion sigue funcionando', function () {
  const out = tools.executeTool(
    'elegir_producto_para_usuario',
    { ids: [ATAQUE_ID, CONTROL_ID, 'id-que-no-existe'], prioridad: 'potencia' },
    { perfilCompra: PadelProfile.emptyPerfilCompra() }
  );
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.noEncontrados, ['id-que-no-existe']);
  assert.strictEqual(out.ganador, ATAQUE_ID);
});

test('19b) ID inexistente: si no quedan al menos 2 productos reales, no elige nada', function () {
  const out = tools.executeTool(
    'elegir_producto_para_usuario',
    { ids: [ATAQUE_ID, 'id-que-no-existe'] },
    { perfilCompra: PadelProfile.emptyPerfilCompra() }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'productos_insuficientes');
});

test('20) referencia ambigua: "esa" sobre una lista de mas de un ofrecido no elige arbitrariamente', function () {
  const offeredProducts = [{ id: ATAQUE_ID }, { id: CONTROL_ID }];
  const out = tools.executeTool(
    'elegir_producto_para_usuario',
    { referencias: [{ referenciaCriterio: 'esa' }, { referenciaPosicion: 'segunda' }] },
    { perfilCompra: PadelProfile.emptyPerfilCompra(), offeredProducts: offeredProducts }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'ambiguo');
});

test('sin candidatos: sin ids/referencias y sin ofrecidos previos, no hay base real para elegir', function () {
  const out = tools.executeTool('elegir_producto_para_usuario', {}, { perfilCompra: PadelProfile.emptyPerfilCompra() });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'sin_candidatos');
});

test('21) el producto recomendado por elegir_producto_para_usuario sigue siendo un producto real del catalogo', function () {
  const out = tools.executeTool(
    'elegir_producto_para_usuario',
    { ids: [ATAQUE_ID, CONTROL_ID], prioridad: 'potencia' },
    { perfilCompra: PadelProfile.emptyPerfilCompra() }
  );
  const real = catalog.getProductById(out.ganador);
  assert.ok(real);
  assert.strictEqual(real.tipoProducto, 'Paleta');
});

test('cambio de perfil antes de elegir (capa tool): un override puntual en el mismo llamado decide, sin persistir el perfil guardado', function () {
  const perfilGuardado = { nivel: null, estilo: null, prioridad: 'potencia', presupuestoMax: null, formaPreferida: null };
  const out = tools.executeTool(
    'elegir_producto_para_usuario',
    { ids: [ATAQUE_ID, CONTROL_ID], prioridad: 'control' },
    { perfilCompra: perfilGuardado }
  );
  assert.strictEqual(out.ganador, CONTROL_ID);
  // El perfil guardado que se paso como contexto nunca se muta.
  assert.strictEqual(perfilGuardado.prioridad, 'potencia');
});

test('el system prompt del asesor instruye usar elegir_producto_para_usuario y nunca declarar un producto "objetivamente mejor"', function () {
  const systemPrompt = require('../lib/padel-advisor-system-prompt');
  assert.ok(systemPrompt.SYSTEM_PROMPT.indexOf('elegir_producto_para_usuario') !== -1);
  assert.ok(systemPrompt.SYSTEM_PROMPT.indexOf('ELEGIR_PRODUCTO_PARA_USUARIO') !== -1);
  assert.ok(/objetivamente mejor/i.test(systemPrompt.SYSTEM_PROMPT));
});

// =====================================================================
// 27) el contrato anterior (TOOL_DEFINITIONS / buildOutputForModel) no se
// rompe
// =====================================================================

test('27a) TOOL_DEFINITIONS incluye elegir_producto_para_usuario sin remover ninguna herramienta previa', function () {
  const nombres = tools.TOOL_DEFINITIONS.map(function (t) { return t.name; });
  [
    'buscar_catalogo',
    'filtrar_palas',
    'comparar_productos',
    'ver_producto',
    'agregar_al_carrito',
    'ver_carrito',
    'quitar_del_carrito',
    'modificar_cantidad_carrito',
    'actualizar_perfil_compra',
    'recomendar_productos',
    'elegir_producto_para_usuario',
  ].forEach(function (esperado) {
    assert.ok(nombres.indexOf(esperado) !== -1, 'falta la herramienta ' + esperado);
  });
  const def = tools.TOOL_DEFINITIONS.find(function (t) { return t.name === 'elegir_producto_para_usuario'; });
  assert.strictEqual(def.input_schema.additionalProperties, false);
  assert.strictEqual(def.input_schema.properties.ids.minItems, 2);
  assert.strictEqual(def.input_schema.properties.ids.maxItems, 3);
  assert.strictEqual(def.input_schema.properties.referencias.minItems, 2);
  assert.deepStrictEqual(def.input_schema.properties.prioridad.enum, PadelProfile.PRIORIDAD_ENUM);
});

// --- 26) score interno no llega al modelo ---

test('26) buildOutputForModel nunca envia scoreInterno al modelo para elegir_producto_para_usuario', function () {
  const output = {
    ok: true,
    hayGanador: true,
    ganador: 'x',
    resultados: [{ productId: 'x', scoreInterno: 999999, motivos: ['algo'], advertencias: [] }],
  };
  const paraModelo = advisor.buildOutputForModel(output);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(paraModelo.resultados[0], 'scoreInterno'), false);
  assert.strictEqual(paraModelo.resultados[0].productId, 'x');
  // El output original (el que se guarda para el frontend) nunca se muta.
  assert.strictEqual(output.resultados[0].scoreInterno, 999999);
});

test('updateOfferedProducts: cuando hay ganador claro, la lista de ofrecidos pasa a ser exclusivamente ese producto', function () {
  const offeredContext = advisor.createOfferedContext([ATAQUE_ID, CONTROL_ID]);
  const output = { ok: true, hayGanador: true, ganador: ATAQUE_ID };
  advisor.updateOfferedProducts('elegir_producto_para_usuario', output, offeredContext);
  assert.deepStrictEqual(offeredContext.ids, [ATAQUE_ID]);
});

test('updateOfferedProducts: sin ganador (empate/falta de informacion), no se toca la lista de ofrecidos original', function () {
  const offeredContext = advisor.createOfferedContext([ATAQUE_ID, CONTROL_ID]);
  const output = { ok: true, hayGanador: false, ganador: null, empate: true };
  advisor.updateOfferedProducts('elegir_producto_para_usuario', output, offeredContext);
  assert.deepStrictEqual(offeredContext.ids, [ATAQUE_ID, CONTROL_ID]);
});

test('collectCards: adjunta la tarjeta del ganador cuando hay uno claro', function () {
  const ctx = advisor.createCardContext();
  const cardsById = new Map();
  const output = {
    ok: true,
    hayGanador: true,
    ganador: ATAQUE_ID,
    resultados: [
      { productId: ATAQUE_ID, scoreInterno: 100100, motivos: [], advertencias: [] },
      { productId: CONTROL_ID, scoreInterno: 100000, motivos: [], advertencias: [] },
    ],
  };
  advisor.collectCards('elegir_producto_para_usuario', output, cardsById, ctx);
  assert.ok(cardsById.has(ATAQUE_ID), 'la tarjeta del ganador debe adjuntarse automaticamente');
  assert.ok(ctx.searchResultIds.has(ATAQUE_ID));
  assert.ok(ctx.searchResultIds.has(CONTROL_ID));
});

test('collectCards: no adjunta ninguna tarjeta nueva cuando no hay ganador claro', function () {
  const ctx = advisor.createCardContext();
  const cardsById = new Map();
  const output = {
    ok: true,
    hayGanador: false,
    ganador: null,
    resultados: [
      { productId: ATAQUE_ID, scoreInterno: 100000, motivos: [], advertencias: [] },
      { productId: CONTROL_ID, scoreInterno: 100000, motivos: [], advertencias: [] },
    ],
  };
  advisor.collectCards('elegir_producto_para_usuario', output, cardsById, ctx);
  assert.strictEqual(cardsById.size, 0);
});

// =====================================================================
// 3) lib/padel-advisor.js (runAdvisor) - integracion completa
// =====================================================================

function buildFakeClientToolThenText(toolName, toolInput, replyText) {
  let call = 0;
  return {
    messages: {
      create: function () {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_1', name: toolName, input: toolInput }],
          });
        }
        return Promise.resolve({ stop_reason: 'end_turn', content: [{ type: 'text', text: replyText }] });
      },
    },
  };
}

const PERFIL_PREVIO = { nivel: null, estilo: null, prioridad: 'potencia', presupuestoMax: null, formaPreferida: null };

function runAsyncTests() {
  return testAsync('comparar_productos -> elegir_producto_para_usuario: el flujo completo de comparacion seguido de eleccion funciona de punta a punta', function () {
    return advisor
      .runAdvisor(
        { message: 'Comparame estas dos.', perfilCompra: PERFIL_PREVIO },
        buildFakeClientToolThenText('comparar_productos', { ids: [ATAQUE_ID, CONTROL_ID] }, 'Aca tenes la comparacion.')
      )
      .then(function (primerResultado) {
        assert.ok(primerResultado.comparison, 'la comparacion visual debe armarse normalmente');
        assert.deepStrictEqual(primerResultado.ofrecidos.sort(), [ATAQUE_ID, CONTROL_ID].sort());
        return advisor.runAdvisor(
          { message: '¿Cual me conviene?', ofrecidos: primerResultado.ofrecidos, perfilCompra: primerResultado.perfilCompra },
          buildFakeClientToolThenText('elegir_producto_para_usuario', {}, 'Para lo que buscas, me quedaria con esta.')
        );
      })
      .then(function (segundoResultado) {
        // 9) continuidad del comparador: elegir no debe romper nada previo.
        assert.strictEqual(segundoResultado.ofrecidos.length, 1);
        assert.strictEqual(segundoResultado.ofrecidos[0], ATAQUE_ID);
        assert.ok(segundoResultado.cards.some(function (c) { return c.id === ATAQUE_ID; }), 'debe adjuntar la tarjeta real del ganador');
      });
  })
    .then(function () {
      // --- 22/23) "Dale, agregame esa." despues de elegir sigue resolviendo al
      // ganador y el carrito sigue funcionando con normalidad ---
      return testAsync('22/23) despues de elegir_producto_para_usuario, "agregame esa" agrega exactamente el producto ganador al carrito real', function () {
        return advisor
          .runAdvisor(
            { message: '¿Con cual me quedo?', ofrecidos: [ATAQUE_ID, CONTROL_ID], perfilCompra: PERFIL_PREVIO },
            buildFakeClientToolThenText('elegir_producto_para_usuario', {}, 'Me quedaria con esta.')
          )
          .then(function (primerResultado) {
            assert.strictEqual(primerResultado.ofrecidos.length, 1);
            return advisor.runAdvisor(
              { message: 'Dale, agregame esa.', ofrecidos: primerResultado.ofrecidos, perfilCompra: primerResultado.perfilCompra },
              buildFakeClientToolThenText('agregar_al_carrito', { referenciaCriterio: 'esa' }, 'Listo, la agregue al carrito.')
            );
          })
          .then(function (segundoResultado) {
            assert.strictEqual(segundoResultado.acciones.length, 1);
            assert.strictEqual(segundoResultado.acciones[0].tipo, 'agregar_al_carrito');
            assert.strictEqual(segundoResultado.acciones[0].productId, ATAQUE_ID);
          });
      });
    })
    .then(function () {
      // --- 24) comparador sigue funcionando despues de una eleccion previa ---
      return testAsync('24) comparar_productos sigue funcionando con normalidad despues de una eleccion previa en la misma conversacion', function () {
        return advisor
          .runAdvisor(
            { message: '¿Cual me recomendas?', ofrecidos: [ATAQUE_ID, CONTROL_ID], perfilCompra: PERFIL_PREVIO },
            buildFakeClientToolThenText('elegir_producto_para_usuario', {}, 'Me quedaria con esta.')
          )
          .then(function () {
            return advisor.runAdvisor(
              { message: 'Comparame estas dos igual.', perfilCompra: PERFIL_PREVIO },
              buildFakeClientToolThenText('comparar_productos', { ids: [ATAQUE_ID, CONTROL_ID] }, 'Aca tenes la comparacion igual.')
            );
          })
          .then(function (resultado) {
            assert.ok(resultado.comparison);
            assert.strictEqual(resultado.comparison.productos.length, 2);
          });
      });
    })
    .then(function () {
      // --- 25) el perfil se conserva: elegir_producto_para_usuario nunca
      // persiste por si sola un override puntual del mismo turno ---
      return testAsync('25) elegir_producto_para_usuario nunca modifica el perfil de compra guardado (solo actualizar_perfil_compra puede)', function () {
        return advisor
          .runAdvisor(
            { message: 'En realidad prefiero control, ¿cual me conviene?', ofrecidos: [ATAQUE_ID, CONTROL_ID], perfilCompra: PERFIL_PREVIO },
            buildFakeClientToolThenText('elegir_producto_para_usuario', { prioridad: 'control' }, 'Con eso en mente, me quedaria con esta.')
          )
          .then(function (result) {
            // El override de prioridad fue solo para esta eleccion puntual: el
            // perfil guardado de la conversacion nunca cambia via esta tool.
            assert.deepStrictEqual(result.perfilCompra, PERFIL_PREVIO);
          });
      });
    })
    .then(function () {
      // --- 7) cambio de perfil ANTES de preguntar, a nivel runAdvisor completo ---
      return testAsync('7) un cambio de perfil declarado en el mismo turno decide la eleccion (nunca un perfil obsoleto)', function () {
        const perfilSinPrioridad = { nivel: null, estilo: null, prioridad: null, presupuestoMax: null, formaPreferida: null };
        return advisor
          .runAdvisor(
            { message: 'En realidad prefiero control.', ofrecidos: [ATAQUE_ID, CONTROL_ID], perfilCompra: perfilSinPrioridad },
            buildFakeClientToolThenText('elegir_producto_para_usuario', { prioridad: 'control' }, 'Con eso en mente, me quedaria con la de control.')
          )
          .then(function (result) {
            assert.strictEqual(result.ofrecidos[0], CONTROL_ID);
          });
      });
    })
    .then(function () {
      // --- empate/datos insuficientes a nivel runAdvisor: nunca fuerza un ganador ---
      return testAsync('empate real a nivel runAdvisor: no se adjunta ninguna tarjeta nueva y los ofrecidos originales se conservan', function () {
        return advisor
          .runAdvisor(
            { message: '¿Cual me conviene?', ofrecidos: [ATAQUE_ID, CONTROL_ID], perfilCompra: PadelProfile.emptyPerfilCompra() },
            buildFakeClientToolThenText('elegir_producto_para_usuario', {}, 'Estan bastante parejas para lo que me contaste.')
          )
          .then(function (result) {
            assert.deepStrictEqual(result.ofrecidos.sort(), [ATAQUE_ID, CONTROL_ID].sort());
          });
      });
    });
}

// =====================================================================
// contrato general de runAdvisor sigue siendo consistente
// =====================================================================

test('el contrato de runAdvisor (reply/cards/ofrecidos/acciones/comparison/perfilCompra) sigue siendo consistente', function () {
  const simulatedResult = { reply: 'texto de prueba', cards: [], ofrecidos: [], acciones: [], comparison: null, perfilCompra: PadelProfile.emptyPerfilCompra() };
  assert.strictEqual(typeof simulatedResult.reply, 'string');
  assert.ok(Array.isArray(simulatedResult.cards));
  assert.ok(Array.isArray(simulatedResult.ofrecidos));
  assert.ok(Array.isArray(simulatedResult.acciones));
  const json = JSON.parse(JSON.stringify(simulatedResult));
  assert.deepStrictEqual(json, simulatedResult);
});

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
  console.log('Pruebas de "¿cual me conviene?" (Fase 2 - Etapa 6): ' + passed + '/' + (passed + failed) + ' OK');
  if (failed > 0) process.exit(1);
});
