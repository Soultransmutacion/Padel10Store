'use strict';

// Fase 2 - Etapa 6: "¿cuál me conviene a mí?" - elegir determinista entre
// productos ya comparados/ofrecidos.
//
// Que hace: dado un conjunto REAL de 2 o 3 productos (ya resueltos contra el
// catalogo por el llamador, nunca inventados) y el perfil de compra temporal
// del cliente (ver lib/padel-profile.js), decide cual conviene mas para ESE
// perfil. No reimplementa el scoring: reutiliza exactamente
// lib/padel-recommender.js#recommend, restringido al conjunto de candidatos
// que el cliente esta comparando (ver pedido original, item 3). El modelo de
// IA nunca decide el ganador: solo redacta la explicacion final usando los
// motivos/advertencias reales que devuelve este modulo.
//
// Principios del pedido original (Etapa 6):
// - "Mejor para vos" nunca es lo mismo que "mejor producto": este modulo
//   nunca afirma que un producto es objetivamente mejor, solo que encaja mas
//   con el perfil declarado.
// - Si el perfil no tiene NINGUNA senal declarada, no se elige un ganador
//   arbitrario (ver faltaInformacion): no hay ninguna base real para preferir
//   un producto sobre otro.
// - Si el recomendador devuelve un empate real o una diferencia que no esta
//   respaldada por ningun criterio de perfil (ver UMBRAL_EMPATE), tampoco se
//   fuerza un ganador: se expone el empate de forma explicita.
// - La pregunta de aclaracion sugerida (cuando corresponde) es siempre UNA
//   sola, y solo se sugiere sobre un dato que el cliente todavia no declaro Y
//   que ademas diferencia de verdad a los candidatos comparados (nunca se
//   pregunta por un dato que no vaya a cambiar nada).

var PadelProfile = require('./padel-profile');
var PadelRecommender = require('./padel-recommender');

// UMBRAL_EMPATE = el peso mas chico de un criterio "de perfil" real
// (W_ESTILO en lib/padel-recommender.js). La suma maxima posible de los
// unicos criterios que NO dependen del perfil (precio relativo 0-50 +
// cantidad de criterios confirmados 0-40 = 90) siempre queda por debajo de
// este umbral: por diseno, cualquier diferencia de scoreInterno menor a 100
// nunca puede deberse a un criterio que de verdad refleje el perfil del
// cliente, asi que nunca alcanza para declarar un ganador "para vos".
var UMBRAL_EMPATE = 100;

function isPlainObject(value) {
  return value != null && typeof value === 'object';
}

function tienePerfilSenal(perfil) {
  return perfil.nivel != null || perfil.estilo != null || perfil.prioridad != null || perfil.presupuestoMax != null || perfil.formaPreferida != null;
}

// Sugiere, como maximo, UNA pregunta de aclaracion concreta: recorre los
// mismos criterios y en el mismo orden de prioridad que usa el recomendador
// (presupuesto > prioridad/estilo > forma > nivel) y devuelve la primera
// pregunta cuyo campo el cliente todavia no declaro Y que ademas distingue
// de verdad a los candidatos comparados (si todos los candidatos comparten
// el mismo valor real en un campo, preguntar por ese campo no cambiaria
// nada, asi que se descarta). Nunca devuelve mas de una pregunta.
function sugerirPregunta(perfil, detalles, productos) {
  if (perfil.presupuestoMax == null) {
    var precios = productos
      .map(function (p) { return typeof p.precio === 'number' && !p.precioConsultar ? p.precio : null; })
      .filter(function (v) { return v !== null; });
    var precioDistinto = precios.length >= 2 && Math.min.apply(null, precios) !== Math.max.apply(null, precios);
    if (precioDistinto) return '¿Tenés un presupuesto máximo en mente?';
  }
  if (perfil.prioridad == null) {
    var clasificaciones = detalles.map(function (d) { return d.clasificacionUsada; }).filter(Boolean);
    if (new Set(clasificaciones).size > 1) return '¿Priorizás más potencia o control?';
  }
  if (perfil.formaPreferida == null) {
    var formas = detalles.map(function (d) { return d.formaProducto; }).filter(Boolean);
    if (new Set(formas).size > 1) return '¿Tenés preferencia de forma: redonda, diamante o lágrima?';
  }
  if (perfil.nivel == null) {
    var niveles = detalles.map(function (d) { return d.nivelProducto; }).filter(Boolean);
    if (new Set(niveles).size > 1) return '¿Cuál es tu nivel de juego?';
  }
  return null;
}

// Punto de entrada principal. `productsCrudos` deben ser productos REALES
// (objetos completos del catalogo, ya resueltos por el llamador contra
// products.json - ver lib/padel-advisor-tools.js#resolveCandidateProducts):
// este modulo nunca busca ni valida IDs por si solo. `perfilCompraCrudo` se
// sanea siempre de nuevo aca (mismo criterio defensivo que
// lib/padel-recommender.js: nunca se confia en que ya venga saneado).
function choose(productsCrudos, perfilCompraCrudo) {
  var perfil = PadelProfile.sanitizePerfilCompra(perfilCompraCrudo);
  var productos = Array.isArray(productsCrudos)
    ? productsCrudos.filter(function (p) { return isPlainObject(p) && typeof p.id === 'string'; })
    : [];

  if (productos.length < 2) {
    return { ok: false, error: 'productos_insuficientes' };
  }

  // Reutiliza exactamente el motor de scoring de lib/padel-recommender.js,
  // restringido a estos candidatos puntuales (limit = todos, para poder
  // comparar el primero contra el segundo sin que el recorte a
  // MAX_RESULTADOS afecte la decision).
  var ranking = PadelRecommender.recommend(productos, perfil, { limit: productos.length });

  // El recomendador solo evalua PALAS (ver esPaleta en
  // lib/padel-recommender.js): si menos de 2 de los productos comparados son
  // palas (por ejemplo, comparar una pala con una mochila), no hay una base
  // real para elegir "para vos" entre ellos.
  if (ranking.resultados.length < 2) {
    return { ok: false, error: 'candidatos_no_evaluables' };
  }

  var detallesPorId = {};
  productos.forEach(function (p) {
    detallesPorId[p.id] = PadelRecommender.evaluarProducto(p, perfil);
  });

  var top = ranking.resultados[0];
  var segundo = ranking.resultados[1];
  var diferencia = top.scoreInterno - segundo.scoreInterno;
  var empate = diferencia < UMBRAL_EMPATE;
  var hayGanador = !empate;
  var faltaInformacion = !tienePerfilSenal(perfil);

  var preguntaSugerida = null;
  if (!hayGanador) {
    var detallesEvaluados = ranking.resultados.map(function (r) { return detallesPorId[r.productId]; });
    preguntaSugerida = sugerirPregunta(perfil, detallesEvaluados, productos);
  }

  // Alternativa (pedido original, item 10): solo cuando HAY un ganador claro
  // y el segundo candidato tiene una clasificacion comercial real,
  // confirmada y distinta de la del ganador (nunca "ninos", que es una
  // audiencia y no un estilo). Es un dato real ya calculado por
  // evaluarProducto, nunca una inferencia nueva de este modulo.
  var alternativa = null;
  if (hayGanador) {
    var clasifGanador = detallesPorId[top.productId].clasificacionUsada;
    var clasifSegundo = detallesPorId[segundo.productId].clasificacionUsada;
    var esEstiloReal = function (c) { return c && c !== 'ninos'; };
    if (esEstiloReal(clasifSegundo) && clasifSegundo !== clasifGanador) {
      alternativa = { productId: segundo.productId, clasificacion: clasifSegundo };
    }
  }

  return {
    ok: true,
    hayGanador: hayGanador,
    ganador: hayGanador ? top.productId : null,
    empate: empate,
    faltaInformacion: faltaInformacion,
    preguntaSugerida: preguntaSugerida,
    alternativa: alternativa,
    resultados: ranking.resultados,
    perfilUsado: perfil,
  };
}

module.exports = {
  UMBRAL_EMPATE: UMBRAL_EMPATE,
  choose: choose,
  sugerirPregunta: sugerirPregunta,
};
