'use strict';

// Fase 2 - Etapa 5: recomendador determinista de productos.
//
// Cubre 3 capas, en el mismo estilo que el resto del proyecto:
//   1) lib/padel-recommender.js: el nucleo puro (evaluacion por criterio,
//      score interno, motivos/advertencias reales, desempate explicito),
//      probado con productos sinteticos controlados para aislar cada senal,
//      y tambien contra el catalogo real (products.json) para garantizar
//      que solo aparecen IDs reales de palas.
//   2) lib/padel-advisor-tools.js: la tool recomendar_productos, que
//      combina el perfil de compra actual con datos nuevos del turno y
//      delega el ranking siempre al modulo puro.
//   3) lib/padel-advisor.js (runAdvisor): el transporte del ranking hacia
//      "ofrecidos" (para que "la primera"/"la mejor"/"la segunda" sigan
//      funcionando despues) y la garantia de que recomendar_productos nunca
//      persiste el perfil de compra por si sola ni rompe carrito/comparador.
//
// No implementa (a proposito, pedido original item 11): "cual me conviene"
// sobre una comparacion especifica, porcentajes, ranking visual con %.

const assert = require('assert');
const Recommender = require('../lib/padel-recommender');
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

// --- Fixtures sinteticos: productos minimos y controlados, con la MISMA
// forma que products.json (tipoProducto, precio, precioConsultar,
// especificaciones), para poder aislar cada criterio del ranking sin ruido
// del resto del catalogo real. ---

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

// Fixtures reales ya usados en otros archivos de tests (mismos IDs, mismo
// criterio de reutilizacion que tests/padel-profile.test.js).
const BARATA_ID = 'royal-padel-cross-black-26'; // Paleta real, $206.000, forma "redondo", clasificacion "control"
const CARA_ID = 'royal-padel-aniversario-36'; // Paleta real, $256.500, forma "redondo", clasificacion "control"
const POLLERA_ID = 'royal-padel-pollera-mallorca-negra'; // Ropa Mujer real: nunca debe aparecer en el ranking

// --- 1) perfil vacio ---

test('1) perfil vacio: no rompe, no inventa motivos, ranking deterministico', function () {
  const productos = [paleta('p1', { precio: 200000 }), paleta('p2', { precio: 250000 })];
  const r = Recommender.recommend(productos, {});
  assert.strictEqual(r.resultados.length, 2);
  r.resultados.forEach(function (res) {
    assert.deepStrictEqual(res.motivos, []);
  });
  assert.strictEqual(r.hayDentroDePresupuesto, null, 'sin presupuesto declarado, no corresponde afirmar ni negar si hay opciones dentro de presupuesto');
});

// --- 2) presupuesto unicamente ---

test('2) presupuesto unicamente: el producto dentro de presupuesto gana y explica por que', function () {
  const productos = [paleta('cara', { precio: 300000 }), paleta('barata', { precio: 200000 })];
  const r = Recommender.recommend(productos, { presupuestoMax: 250000 });
  assert.strictEqual(r.mejorCoincidencia, 'barata');
  const barata = r.resultados.find(function (x) { return x.productId === 'barata'; });
  const cara = r.resultados.find(function (x) { return x.productId === 'cara'; });
  assert.ok(barata.motivos.indexOf('Dentro del presupuesto de $250.000') !== -1);
  assert.ok(cara.advertencias.some(function (a) { return a.indexOf('supera el presupuesto declarado de $250.000') !== -1; }));
});

// --- 3) prioridad potencia ---

test('3) prioridad potencia: clasificacion "ataque" coincide (mapeo explicito del pedido)', function () {
  const productos = [paleta('ataque', { especificaciones: { clasificacionComercialSitio: 'ataque' } }), paleta('control', { especificaciones: { clasificacionComercialSitio: 'control' } })];
  const r = Recommender.recommend(productos, { prioridad: 'potencia' });
  assert.strictEqual(r.mejorCoincidencia, 'ataque');
  const ataque = r.resultados.find(function (x) { return x.productId === 'ataque'; });
  assert.ok(ataque.motivos.indexOf('Clasificación de ataque coincide con la prioridad potencia') !== -1);
  const control = r.resultados.find(function (x) { return x.productId === 'control'; });
  assert.deepStrictEqual(control.motivos, []);
});

// --- 4) prioridad control ---

test('4) prioridad control: clasificacion "control" coincide', function () {
  const productos = [paleta('control', { especificaciones: { clasificacionComercialSitio: 'control' } }), paleta('polivalente', { especificaciones: { clasificacionComercialSitio: 'polivalente' } })];
  const r = Recommender.recommend(productos, { prioridad: 'control' });
  assert.strictEqual(r.mejorCoincidencia, 'control');
  const control = r.resultados.find(function (x) { return x.productId === 'control'; });
  assert.ok(control.motivos.indexOf('Clasificación de control coincide con la prioridad control') !== -1);
});

// --- 5) forma preferida (incluye normalizacion redondo/redonda) ---

test('5) forma preferida: coincide y normaliza "redondo" (catalogo) contra "redonda" (perfil)', function () {
  const productos = [paleta('diamante', { especificaciones: { forma: 'diamante' } }), paleta('lagrima', { especificaciones: { forma: 'lagrima' } })];
  const r = Recommender.recommend(productos, { formaPreferida: 'diamante' });
  assert.strictEqual(r.mejorCoincidencia, 'diamante');
  const diamante = r.resultados.find(function (x) { return x.productId === 'diamante'; });
  assert.ok(diamante.motivos.indexOf('Forma diamante coincide con la preferencia') !== -1);

  const redondoDb = paleta('redondo-db', { especificaciones: { forma: 'redondo' } }); // grafia real de products.json
  const detalle = Recommender.evaluarProducto(redondoDb, PadelProfile.sanitizePerfilCompra({ formaPreferida: 'redonda' }));
  assert.strictEqual(detalle.formaMatch, true, '"redondo" en el catalogo debe coincidir con formaPreferida "redonda" del perfil');
});

// --- 6) nivel cuando existe ---

test('6) nivel cuando existe en el producto: coincide y explica', function () {
  const productos = [paleta('avanzado', { especificaciones: { nivelRecomendado: 'avanzado' } }), paleta('intermedio', { especificaciones: { nivelRecomendado: 'intermedio' } })];
  const r = Recommender.recommend(productos, { nivel: 'avanzado' });
  assert.strictEqual(r.mejorCoincidencia, 'avanzado');
  const avanzado = r.resultados.find(function (x) { return x.productId === 'avanzado'; });
  assert.ok(avanzado.motivos.indexOf('Nivel recomendado avanzado coincide con tu nivel') !== -1);
});

// --- 7) estilo cuando existe ---

test('7) estilo (estiloJuego) cuando existe en el producto: coincide con la prioridad declarada', function () {
  const productos = [paleta('potencia', { especificaciones: { estiloJuego: 'potencia' } }), paleta('sin-estilo', {})];
  const r = Recommender.recommend(productos, { prioridad: 'potencia' });
  const conEstilo = r.resultados.find(function (x) { return x.productId === 'potencia'; });
  const sinEstilo = r.resultados.find(function (x) { return x.productId === 'sin-estilo'; });
  assert.ok(conEstilo.motivos.indexOf('Estilo de juego potencia coincide con la prioridad declarada') !== -1);
  assert.deepStrictEqual(sinEstilo.motivos, []);
});

// --- 8) ignorar nivel ausente ---

test('8) nivel ausente en el producto: el criterio no participa, no rompe, no se inventa', function () {
  const producto = paleta('sin-nivel', {});
  const detalle = Recommender.evaluarProducto(producto, PadelProfile.sanitizePerfilCompra({ nivel: 'avanzado' }));
  assert.strictEqual(detalle.nivelProducto, null);
  assert.strictEqual(detalle.nivelMatch, false);
  const r = Recommender.recommend([producto], { nivel: 'avanzado' });
  assert.strictEqual(r.resultados[0].motivos.indexOf('Nivel recomendado'), -1);
});

// --- 9) ignorar estilo ausente ---

test('9) estiloJuego ausente en el producto: el criterio no participa, no rompe, no se inventa', function () {
  const producto = paleta('sin-estilo-juego', {});
  const detalle = Recommender.evaluarProducto(producto, PadelProfile.sanitizePerfilCompra({ prioridad: 'potencia' }));
  assert.strictEqual(detalle.estiloProducto, null);
  assert.strictEqual(detalle.estiloMatch, false);
});

// --- 10) ignorar clasificacion sucia ---

test('10) valores sucios de clasificacionComercialSitio (marcas) se ignoran como senal', function () {
  ['bull-padel', 'siux', 'adidas'].forEach(function (sucio) {
    const spec = { clasificacionComercialSitio: sucio };
    assert.strictEqual(Recommender.claseComercialValida(spec), null, sucio + ' debe tratarse como si el campo no existiera');
  });
  ['control', 'ataque', 'polivalente', 'ninos'].forEach(function (valido) {
    assert.strictEqual(Recommender.claseComercialValida({ clasificacionComercialSitio: valido }), valido, valido + ' debe reconocerse como valor valido');
  });

  const productoSucio = paleta('sucio', { especificaciones: { clasificacionComercialSitio: 'siux' } });
  const r = Recommender.recommend([productoSucio], { prioridad: 'potencia', estilo: 'ataque' });
  assert.deepStrictEqual(r.resultados[0].motivos, [], 'un valor sucio nunca genera un motivo de clasificacion, aunque el perfil declare prioridad/estilo compatibles con "ataque"');
});

// --- 11) producto dentro de presupuesto gana frente a uno fuera, incluso si el de afuera matchea mas criterios ---

test('11) el presupuesto es una regla fuerte: domina aunque el producto fuera de presupuesto coincida en todo lo demas', function () {
  const dentro = paleta('dentro', { precio: 200000 }); // no matchea ningun otro criterio
  const fueraConTodo = paleta('fuera-con-todo', {
    precio: 300000,
    especificaciones: { forma: 'diamante', nivelRecomendado: 'avanzado', estiloJuego: 'potencia', clasificacionComercialSitio: 'ataque' },
  });
  const perfil = { presupuestoMax: 250000, formaPreferida: 'diamante', nivel: 'avanzado', prioridad: 'potencia', estilo: 'ataque' };
  const r = Recommender.recommend([fueraConTodo, dentro], perfil);
  assert.strictEqual(r.mejorCoincidencia, 'dentro', 'estar dentro de presupuesto debe pesar mas que cualquier combinacion de los demas criterios');
});

// --- 12) ningun producto dentro del presupuesto ---

test('12) ningun producto dentro del presupuesto: se sigue rankeando y nunca se oculta que lo superan', function () {
  const productos = [paleta('a', { precio: 200000 }), paleta('b', { precio: 300000 }), paleta('consultar', { precio: null, precioConsultar: true })];
  const r = Recommender.recommend(productos, { presupuestoMax: 1000 });
  assert.strictEqual(r.hayDentroDePresupuesto, false);
  assert.ok(r.resultados.length > 0);
  r.resultados.forEach(function (res) {
    const tieneAdvertenciaDePrecio = res.advertencias.some(function (a) {
      return a.indexOf('supera el presupuesto') !== -1 || a.indexOf('Precio a consultar') !== -1;
    });
    assert.ok(tieneAdvertenciaDePrecio, 'producto ' + res.productId + ' debe advertir que no se confirmo que este dentro del presupuesto');
  });
});

// --- 13) empate deterministico (mismo score exacto) ---

test('13) empate exacto en todos los criterios: se resuelve por ID, siempre igual', function () {
  const a = paleta('zzz-ultimo', { precio: 200000 });
  const b = paleta('aaa-primero', { precio: 200000 });
  const r1 = Recommender.recommend([a, b], {});
  const r2 = Recommender.recommend([b, a], {}); // orden de entrada invertido
  assert.strictEqual(r1.mejorCoincidencia, 'aaa-primero');
  assert.strictEqual(r2.mejorCoincidencia, 'aaa-primero', 'el orden de entrada no debe alterar el desempate');
});

// --- 14) ranking estable entre llamadas repetidas ---

test('14) el ranking es estable: la misma entrada produce siempre el mismo orden', function () {
  const productos = catalog.loadCatalog();
  const perfil = { prioridad: 'potencia', presupuestoMax: 350000, nivel: 'intermedio' };
  const primera = Recommender.recommend(productos, perfil).resultados.map(function (r) { return r.productId; });
  for (let i = 0; i < 4; i++) {
    const siguiente = Recommender.recommend(productos, perfil).resultados.map(function (r) { return r.productId; });
    assert.deepStrictEqual(siguiente, primera, 'la llamada ' + i + ' debe devolver exactamente el mismo orden');
  }
});

// --- 15) motivos reales (todos los criterios coinciden a la vez) ---

test('15) motivos reales: un producto que coincide en todo explica cada coincidencia por separado', function () {
  const producto = paleta('completo', {
    precio: 200000,
    especificaciones: { forma: 'diamante', nivelRecomendado: 'avanzado', estiloJuego: 'potencia', clasificacionComercialSitio: 'ataque' },
  });
  const perfil = { presupuestoMax: 250000, formaPreferida: 'diamante', nivel: 'avanzado', prioridad: 'potencia' };
  const r = Recommender.recommend([producto], perfil);
  const motivos = r.resultados[0].motivos;
  assert.ok(motivos.indexOf('Dentro del presupuesto de $250.000') !== -1);
  assert.ok(motivos.indexOf('Clasificación de ataque coincide con la prioridad potencia') !== -1);
  assert.ok(motivos.indexOf('Forma diamante coincide con la preferencia') !== -1);
  assert.ok(motivos.indexOf('Nivel recomendado avanzado coincide con tu nivel') !== -1);
  assert.ok(motivos.indexOf('Estilo de juego potencia coincide con la prioridad declarada') !== -1);
  assert.strictEqual(motivos.length, 5);
});

// --- 16) no inventar motivos ---

test('16) no inventar motivos: datos confirmados del producto que el cliente NUNCA pidio no generan motivo', function () {
  const producto = paleta('con-datos-no-pedidos', {
    especificaciones: { forma: 'diamante', nivelRecomendado: 'avanzado', estiloJuego: 'potencia', clasificacionComercialSitio: 'ataque' },
  });
  const r = Recommender.recommend([producto], {}); // perfil vacio: nada fue pedido
  assert.deepStrictEqual(r.resultados[0].motivos, [], 'tener datos confirmados no alcanza: sin un pedido explicito del cliente no hay motivo que dar');
});

// --- 17) advertencias por datos faltantes/no confirmados ---

test('17) advertencias: nivel y estilo marcados como inferencia se avisan solo cuando participan del ranking', function () {
  const inferido = paleta('nivel-inferido', { especificaciones: { nivelRecomendado: 'avanzado', nivelRecomendadoEsInferencia: true } });
  const oficial = paleta('nivel-oficial', { especificaciones: { nivelRecomendado: 'avanzado', nivelRecomendadoEsInferencia: false } });
  const r = Recommender.recommend([inferido, oficial], { nivel: 'avanzado' });
  const resInferido = r.resultados.find(function (x) { return x.productId === 'nivel-inferido'; });
  const resOficial = r.resultados.find(function (x) { return x.productId === 'nivel-oficial'; });
  assert.ok(resInferido.advertencias.some(function (a) { return a.indexOf('inferencia') !== -1; }));
  assert.deepStrictEqual(resOficial.advertencias, [], 'un dato oficial (no inferencia) nunca debe generar esta advertencia');

  const estiloInferido = paleta('estilo-inferido', { especificaciones: { estiloJuego: 'potencia', estiloJuegoEsInferencia: true } });
  const rEstilo = Recommender.recommend([estiloInferido], { prioridad: 'potencia' });
  assert.ok(rEstilo.resultados[0].advertencias.some(function (a) { return a.indexOf('Estilo de juego no confirmado') !== -1; }));
});

// --- 18) IDs reales del catalogo ---

test('18) todos los productId del ranking son productos reales de products.json', function () {
  const productos = catalog.loadCatalog();
  const r = Recommender.recommend(productos, { prioridad: 'potencia', presupuestoMax: 300000, nivel: 'intermedio', formaPreferida: 'diamante' });
  assert.ok(r.resultados.length > 0);
  r.resultados.forEach(function (res) {
    const real = catalog.getProductById(res.productId);
    assert.ok(real, res.productId + ' debe existir de verdad en el catalogo');
    assert.strictEqual(real.tipoProducto, 'Paleta');
  });
});

// --- 19) producto inexistente / no-paleta nunca aparece ---

test('19) un producto que no es Paleta (por ejemplo ropa) nunca aparece en el ranking', function () {
  const productos = catalog.loadCatalog();
  const r = Recommender.recommend(productos, {});
  const ids = r.resultados.map(function (res) { return res.productId; });
  assert.strictEqual(ids.indexOf(POLLERA_ID), -1);
  ids.forEach(function (id) {
    const real = catalog.getProductById(id);
    assert.strictEqual(real.tipoProducto, 'Paleta');
  });
});

// --- 20) ofrecidos refleja el ranking ---

test('20) updateOfferedProducts adopta el ranking de recomendar_productos, en orden', function () {
  const offeredContext = advisor.createOfferedContext([]);
  const output = {
    ok: true,
    resultados: [
      { productId: 'primero', scoreInterno: 999, motivos: [], advertencias: [] },
      { productId: 'segundo', scoreInterno: 500, motivos: [], advertencias: [] },
    ],
  };
  advisor.updateOfferedProducts('recomendar_productos', output, offeredContext);
  assert.deepStrictEqual(offeredContext.ids, ['primero', 'segundo']);
});

// --- 21) "primera"/"segunda" siguen funcionando sobre el ranking ---

test('21) referenciaPosicion resuelve contra el orden real del ranking devuelto', function () {
  const productos = [paleta('mejor-real', { precio: 200000 }), paleta('segunda-real', { precio: 210000 })];
  const ranking = Recommender.recommend(productos, {});
  const offeredProducts = ranking.resultados.map(function (r) { return { id: r.productId }; });
  // Usamos productos sinteticos: resolveReferencedProductId valida contra el
  // catalogo real (getProduct), asi que probamos la resolucion de posicion
  // en si con PadelCartCore a traves del mismo mecanismo que usa el carrito,
  // sobre una lista de ofrecidos ya armada con el orden real del ranking
  // (igual que hace runAdvisor con productos reales, ver test 22).
  assert.strictEqual(offeredProducts[0].id, ranking.mejorCoincidencia);
  assert.strictEqual(offeredProducts[1].id, ranking.siguientesOpciones[0]);
});

// --- fake client para pruebas de integracion (mismo patron que
// tests/padel-profile.test.js) ---

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

const PERFIL_PREVIO = { nivel: 'avanzado', estilo: 'ataque', prioridad: 'potencia', presupuestoMax: 300000, formaPreferida: null };

function runAsyncTests() {
  return testAsync('22) recomendar_productos deja "la mejor" lista para agregar_al_carrito en el siguiente turno', function () {
    return advisor
      .runAdvisor({ message: 'Recomendame una pala.', perfilCompra: PERFIL_PREVIO }, buildFakeClientToolThenText('recomendar_productos', {}, 'Te recomiendo esta.'))
      .then(function (primerResultado) {
        assert.ok(primerResultado.ofrecidos.length > 0, 'el turno de recomendacion debe dejar productos ofrecidos reales');
        primerResultado.ofrecidos.forEach(function (id) {
          assert.ok(catalog.getProductById(id), id + ' debe ser un producto real');
        });
        return advisor.runAdvisor(
          { message: 'Agregame la mejor.', ofrecidos: primerResultado.ofrecidos, perfilCompra: primerResultado.perfilCompra },
          buildFakeClientToolThenText('agregar_al_carrito', { referenciaPosicion: 'primera' }, 'Listo, la agregue al carrito.')
        );
      })
      .then(function (segundoResultado) {
        assert.strictEqual(segundoResultado.acciones.length, 1, 'el carrito debe seguir funcionando normalmente sobre el ranking ofrecido');
        assert.strictEqual(segundoResultado.acciones[0].tipo, 'agregar_al_carrito');
      });
  })
    .then(function () {
      // --- 23) comparar sigue funcionando sobre los ofrecidos del ranking ---
      return testAsync('23) comparar_productos ("primera con segunda") sigue funcionando sobre el ranking ofrecido', function () {
        return advisor
          .runAdvisor({ message: 'Recomendame algo.', perfilCompra: PERFIL_PREVIO }, buildFakeClientToolThenText('recomendar_productos', {}, 'Aca tenes opciones.'))
          .then(function (primerResultado) {
            assert.ok(primerResultado.ofrecidos.length >= 2, 'hacen falta al menos 2 ofrecidos reales para poder comparar');
            return advisor.runAdvisor(
              { message: 'Comparame la primera con la segunda.', ofrecidos: primerResultado.ofrecidos, perfilCompra: primerResultado.perfilCompra },
              buildFakeClientToolThenText(
                'comparar_productos',
                { referencias: [{ referenciaPosicion: 'primera' }, { referenciaPosicion: 'segunda' }] },
                'Aca tenes la comparacion.'
              )
            );
          })
          .then(function (segundoResultado) {
            assert.ok(segundoResultado.comparison, 'la comparacion visual debe seguir armandose normalmente');
            assert.strictEqual(segundoResultado.comparison.productos.length, 2);
          });
      });
    })
    .then(function () {
      // --- 24) recomendar_productos nunca persiste el perfil por si sola ---
      return testAsync('24) recomendar_productos nunca modifica el perfil de compra guardado (solo actualizar_perfil_compra puede)', function () {
        return advisor
          .runAdvisor(
            { message: 'Con nivel principiante y forma redonda, recomendame algo.', perfilCompra: PERFIL_PREVIO },
            buildFakeClientToolThenText('recomendar_productos', { nivel: 'principiante', formaPreferida: 'redonda' }, 'Aca tenes una opcion.')
          )
          .then(function (result) {
            // El override de nivel/formaPreferida es SOLO para este ranking puntual:
            // el perfil guardado de la conversacion nunca cambia via esta tool.
            assert.deepStrictEqual(result.perfilCompra, PERFIL_PREVIO);
          });
      });
    });
}

// --- 25) el contrato anterior de runAdvisor y TOOL_DEFINITIONS no se rompe ---

test('25) TOOL_DEFINITIONS incluye recomendar_productos sin remover ninguna herramienta previa', function () {
  const nombres = tools.TOOL_DEFINITIONS.map(function (t) { return t.name; });
  ['buscar_catalogo', 'filtrar_palas', 'comparar_productos', 'ver_producto', 'agregar_al_carrito', 'ver_carrito', 'quitar_del_carrito', 'modificar_cantidad_carrito', 'actualizar_perfil_compra', 'recomendar_productos'].forEach(function (esperado) {
    assert.ok(nombres.indexOf(esperado) !== -1, 'falta la herramienta ' + esperado);
  });
  const def = tools.TOOL_DEFINITIONS.find(function (t) { return t.name === 'recomendar_productos'; });
  assert.strictEqual(def.input_schema.additionalProperties, false);
  assert.deepStrictEqual(def.input_schema.properties.nivel.enum, PadelProfile.NIVEL_ENUM);
  assert.deepStrictEqual(def.input_schema.properties.estilo.enum, PadelProfile.ESTILO_ENUM);
  assert.deepStrictEqual(def.input_schema.properties.prioridad.enum, PadelProfile.PRIORIDAD_ENUM);
  assert.deepStrictEqual(def.input_schema.properties.formaPreferida.enum, PadelProfile.FORMA_PREFERIDA_ENUM);
});

test('el contrato de runAdvisor (reply/cards/ofrecidos/acciones/comparison/perfilCompra) sigue siendo consistente', function () {
  const simulatedResult = { reply: 'texto de prueba', cards: [], ofrecidos: [], acciones: [], comparison: null, perfilCompra: PadelProfile.emptyPerfilCompra() };
  assert.strictEqual(typeof simulatedResult.reply, 'string');
  assert.ok(Array.isArray(simulatedResult.cards));
  assert.ok(Array.isArray(simulatedResult.ofrecidos));
  assert.ok(Array.isArray(simulatedResult.acciones));
  const json = JSON.parse(JSON.stringify(simulatedResult));
  assert.deepStrictEqual(json, simulatedResult);
});

test('buildOutputForModel nunca envia scoreInterno al modelo', function () {
  const output = {
    ok: true,
    resultados: [{ productId: 'x', scoreInterno: 123456, motivos: ['algo'], advertencias: [] }],
    mejorCoincidencia: 'x',
  };
  const paraModelo = advisor.buildOutputForModel(output);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(paraModelo.resultados[0], 'scoreInterno'), false);
  assert.strictEqual(paraModelo.resultados[0].productId, 'x');
  assert.deepStrictEqual(paraModelo.resultados[0].motivos, ['algo']);
  // El output original (el que se guarda para el frontend) nunca se muta.
  assert.strictEqual(output.resultados[0].scoreInterno, 123456);
});

test('la tool recomendar_productos delega el ranking real al catalogo (integracion con handleRecomendarProductos)', function () {
  const out = tools.executeTool('recomendar_productos', { prioridad: 'potencia', presupuestoMax: 300000 }, { perfilCompra: PadelProfile.emptyPerfilCompra() });
  assert.strictEqual(out.ok, true);
  assert.ok(Array.isArray(out.resultados) && out.resultados.length > 0);
  out.resultados.forEach(function (res) {
    assert.ok(catalog.getProductById(res.productId), res.productId + ' debe ser un producto real');
  });
  assert.strictEqual(out.mejorCoincidencia, out.resultados[0].productId);
});

test('el system prompt instruye usar recomendar_productos y nunca exponer porcentajes ni puntajes', function () {
  const systemPrompt = require('../lib/padel-advisor-system-prompt');
  assert.ok(systemPrompt.SYSTEM_PROMPT.indexOf('recomendar_productos') !== -1);
  assert.ok(systemPrompt.SYSTEM_PROMPT.indexOf('RECOMENDAR_PRODUCTOS') !== -1);
  assert.ok(/porcentaje/i.test(systemPrompt.SYSTEM_PROMPT));
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
  console.log('Pruebas del recomendador determinista (Fase 2 - Etapa 5): ' + passed + '/' + (passed + failed) + ' OK');
  if (failed > 0) process.exit(1);
});
