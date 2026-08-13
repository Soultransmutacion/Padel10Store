'use strict';

// Fase 2 - Etapa 5: recomendador determinista de productos.
//
// Que hace: ordena PALAS reales del catalogo (products.json, via el objeto
// que ya devuelve catalog.loadCatalog()) segun que tan bien encajan con el
// perfil de compra temporal del cliente (ver lib/padel-profile.js) mas los
// filtros puntuales que declare en este turno. El modelo de IA decide
// CUANDO llamar a la tool recomendar_productos (ver
// lib/padel-advisor-tools.js), pero el orden final del ranking lo calcula
// siempre este modulo: determinista, explicable y testeable, nunca
// arbitrario ni decidido por el modelo.
//
// Principios del pedido original (Etapa 5):
// - El presupuesto declarado es una regla fuerte: mientras exista al menos
//   un producto dentro de presupuesto, ninguno fuera de presupuesto puede
//   quedar por delante en el ranking. Si no existe ninguna opcion dentro de
//   presupuesto, se sigue rankeando por el resto de los criterios, pero
//   nunca se oculta que un producto supera el presupuesto declarado.
// - Nunca se inventa una senal a partir de un campo ausente: si un producto
//   no tiene nivelRecomendado, estiloJuego, forma o clasificacionComercial
//   confirmados, ese criterio simplemente no participa para ESE producto.
// - clasificacionComercialSitio tiene valores sucios ya detectados en la
//   auditoria (nombres de marca colados en ese campo, ver
//   CLASIFICACION_IGNORADA): CLASIFICACION_VALIDA define explicitamente los
//   unicos valores que se usan como senal de recomendacion.
// - El score interno (scoreInterno) existe unicamente para ordenar y para
//   poder explicar/testear el ranking de forma reproducible: nunca se
//   expone al cliente como porcentaje, estrellas ni ningun otro indicador
//   visual (eso queda fuera de esta etapa).

var PadelProfile = require('./padel-profile');

// Unicos valores de clasificacionComercialSitio que se usan como senal de
// recomendacion (auditoria de products.json, Fase 2 - Etapa 5). "ninos" es
// una clasificacion real (publico infantil) pero no tiene equivalente en el
// perfil de compra de un cliente adulto: nunca genera una coincidencia de
// estilo/prioridad por si sola, solo cuenta como dato confirmado del
// producto.
var CLASIFICACION_VALIDA = ['control', 'ataque', 'polivalente', 'ninos'];

// Valores detectados en la auditoria dentro de clasificacionComercialSitio
// que en realidad son nombres de marca (bull-padel, siux, adidas), no
// clasificaciones comerciales reales. Se documentan aca de forma explicita
// para dejar constancia de que fueron detectados y descartados a proposito
// como senal de recomendacion, nunca por omision.
var CLASIFICACION_IGNORADA = ['bull-padel', 'siux', 'adidas'];

// Subconjunto de CLASIFICACION_VALIDA que representa un estilo de juego real
// (excluye "ninos", que es una audiencia, no un estilo).
var CLASIFICACION_ESTILO = ['control', 'ataque', 'polivalente'];

// Mapeo explicito entre lo que el cliente prioriza en una pala y la
// clasificacion comercial del sitio que mejor encaja con esa prioridad.
// Ejemplo explicito del pedido original: clasificacionComercialSitio
// "ataque" coincide con prioridad "potencia".
var PRIORIDAD_A_CLASIFICACION = {
  potencia: 'ataque',
  control: 'control',
  manejabilidad: 'polivalente',
  equilibrio: 'polivalente',
};

// El catalogo real tiene una inconsistencia de datos ya detectada (forma
// "redondo" en products.json en vez de "redonda"): se normalizan ambas
// grafias a la misma forma canonica antes de comparar contra
// perfilCompra.formaPreferida (que solo usa "redonda").
var FORMA_CANONICA = {
  redondo: 'redonda',
  redonda: 'redonda',
  diamante: 'diamante',
  lagrima: 'lagrima',
};

// Pesos de cada nivel de prioridad del pedido original (item 2: presupuesto,
// clasificacion comercial valida, forma preferida, nivel, estilo). Cada
// nivel pesa muchas veces mas que la suma maxima posible de todos los
// niveles inferiores juntos (ver headroom documentado junto a
// precioRelativoScore/contarCriteriosConfirmados), de forma que scoreInterno
// sea una unica cifra que respeta ese orden de prioridad de punta a punta,
// sin depender de un comparador aparte para los primeros 5 criterios.
var W_PRESUPUESTO = 1000000; // 1) presupuesto
var W_CLASIFICACION = 100000; // 2) clasificacion comercial valida
var W_FORMA = 10000; // 3) forma preferida
var W_NIVEL = 1000; // 4) nivel (si existe en el producto)
var W_ESTILO = 100; // 5) estilo de juego del producto (si existe)
// 6) precio relativo (0-50) y 7) otros criterios justificables (0-40) viven
// siempre por debajo de 100 (W_ESTILO): su suma maxima (90) nunca puede
// alcanzar ni alterar el peso de un criterio de mayor prioridad.

var MAX_RESULTADOS = 8;

function isPlainObject(value) {
  return value != null && typeof value === 'object';
}

function normalizeSimple(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Misma regla que catalog.isPrecioConsultar (lib/padel-catalog.js), duplicada
// aca a proposito: este modulo, igual que lib/padel-profile.js, no depende
// del catalogo ni de ningun otro modulo de datos, solo recibe productos ya
// cargados como parametro (ver recommend()).
function isPrecioConsultar(product) {
  return !!product.precioConsultar || typeof product.precio !== 'number';
}

function esPaleta(product) {
  return normalizeSimple(product.tipoProducto) === 'paleta';
}

// Devuelve el valor de clasificacionComercialSitio solo si es uno de los
// valores validos y confiables (CLASIFICACION_VALIDA). Un valor sucio (una
// marca colada en el campo, ver CLASIFICACION_IGNORADA) o cualquier otro
// valor no reconocido se trata exactamente igual que un campo ausente.
function claseComercialValida(spec) {
  var raw = normalizeSimple(spec.clasificacionComercialSitio);
  if (!raw) return null;
  if (CLASIFICACION_VALIDA.indexOf(raw) === -1) return null;
  return raw;
}

function formaCanonica(value) {
  var raw = normalizeSimple(value);
  return FORMA_CANONICA[raw] || null;
}

function formatPrice(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return '$' + value.toLocaleString('es-AR');
}

// Cuenta cuantos de los 4 campos que usa el recomendador (forma, nivel
// recomendado, estilo de juego, clasificacion comercial valida) estan
// realmente confirmados en la ficha del producto, sin importar si coinciden
// o no con el perfil del cliente. Es el criterio 7 del pedido original
// ("otros criterios justificables": tener mas datos reales confirmados es
// una razon legitima para preferir un producto en un empate) y tambien
// forma parte del desempate explicito (ver compararRanking).
function contarCriteriosConfirmados(spec) {
  var count = 0;
  if (formaCanonica(spec.forma)) count += 1;
  if (typeof spec.nivelRecomendado === 'string' && spec.nivelRecomendado.trim()) count += 1;
  if (typeof spec.estiloJuego === 'string' && spec.estiloJuego.trim()) count += 1;
  if (claseComercialValida(spec)) count += 1;
  return count;
}

// Evalua un unico producto contra el perfil ya saneado. Devuelve el detalle
// completo de cada senal por separado (nunca solo un numero final), para que
// buildMotivos/buildAdvertencias y los tests puedan verificar cada criterio
// de forma independiente.
function evaluarProducto(product, perfil) {
  var spec = isPlainObject(product.especificaciones) ? product.especificaciones : {};
  var precio = typeof product.precio === 'number' ? product.precio : null;
  var consultarPrecio = isPrecioConsultar(product);

  var detalle = {
    precio: precio,
    consultarPrecio: consultarPrecio,
    dentroDePresupuesto: false,
    clasificacionUsada: claseComercialValida(spec),
    clasificacionMatchEstilo: false,
    clasificacionMatchPrioridad: false,
    formaProducto: formaCanonica(spec.forma),
    formaMatch: false,
    nivelProducto: typeof spec.nivelRecomendado === 'string' && spec.nivelRecomendado.trim() ? normalizeSimple(spec.nivelRecomendado) : null,
    nivelEsInferencia: !!spec.nivelRecomendadoEsInferencia,
    nivelMatch: false,
    estiloProducto: typeof spec.estiloJuego === 'string' && spec.estiloJuego.trim() ? normalizeSimple(spec.estiloJuego) : null,
    estiloEsInferencia: !!spec.estiloJuegoEsInferencia,
    estiloMatch: false,
    criteriosConfirmados: contarCriteriosConfirmados(spec),
  };

  // 1) presupuesto: regla fuerte. Un producto con precio a consultar nunca
  // cuenta como "dentro de presupuesto" (no hay dato confirmado para
  // afirmarlo), aunque tampoco se presenta como que lo supera (ver
  // buildAdvertencias): simplemente es un precio no confirmado.
  if (perfil.presupuestoMax != null) {
    detalle.dentroDePresupuesto = precio !== null && !consultarPrecio && precio <= perfil.presupuestoMax;
  }

  // 2) clasificacion comercial valida: dos senales independientes posibles,
  // cada una con su propio motivo explicable.
  if (detalle.clasificacionUsada) {
    if (perfil.estilo && detalle.clasificacionUsada === perfil.estilo) {
      detalle.clasificacionMatchEstilo = true;
    }
    if (perfil.prioridad && PRIORIDAD_A_CLASIFICACION[perfil.prioridad] === detalle.clasificacionUsada) {
      detalle.clasificacionMatchPrioridad = true;
    }
  }

  // 3) forma preferida
  if (perfil.formaPreferida && detalle.formaProducto && detalle.formaProducto === perfil.formaPreferida) {
    detalle.formaMatch = true;
  }

  // 4) nivel recomendado (solo si el producto lo tiene confirmado)
  if (perfil.nivel && detalle.nivelProducto && detalle.nivelProducto === perfil.nivel) {
    detalle.nivelMatch = true;
  }

  // 5) estilo de juego del producto (campo estiloJuego, distinto de
  // clasificacionComercialSitio): se compara contra la prioridad declarada
  // por el cliente, el mismo concepto de juego expresado en dos campos
  // distintos del catalogo y del perfil.
  if (perfil.prioridad && detalle.estiloProducto && detalle.estiloProducto === perfil.prioridad) {
    detalle.estiloMatch = true;
  }

  return detalle;
}

// 6) precio relativo: posicion del precio de este producto dentro del rango
// de precios confirmados de todo el conjunto evaluado en esta llamada
// (mas barato = mas puntos). Un producto sin precio numerico confirmado
// nunca recibe puntaje por este criterio (no hay dato para premiarlo ni
// para penalizarlo mas alla de 0).
function precioRelativoScore(detalle, precioRange) {
  if (detalle.precio === null || detalle.consultarPrecio) return 0;
  if (!precioRange || precioRange.min === precioRange.max) return 25;
  var ratio = (precioRange.max - detalle.precio) / (precioRange.max - precioRange.min);
  return Math.round(ratio * 50);
}

function calcularScore(detalle, precioRange) {
  var score = 0;
  if (detalle.dentroDePresupuesto) score += W_PRESUPUESTO;
  if (detalle.clasificacionMatchEstilo || detalle.clasificacionMatchPrioridad) score += W_CLASIFICACION;
  if (detalle.formaMatch) score += W_FORMA;
  if (detalle.nivelMatch) score += W_NIVEL;
  if (detalle.estiloMatch) score += W_ESTILO;
  score += precioRelativoScore(detalle, precioRange);
  score += detalle.criteriosConfirmados * 10;
  return score;
}

// Que tan cerca esta el precio de este producto del techo de presupuesto
// declarado (0 o negativo mas cercano a 0 = mejor ajuste). Devuelve 0 cuando
// no hay presupuesto declarado (criterio neutro, no participa del
// desempate) y el peor valor posible cuando no hay precio confirmado para
// comparar.
function ajustePresupuesto(perfil, detalle) {
  if (perfil.presupuestoMax == null) return 0;
  if (detalle.precio === null || detalle.consultarPrecio) return -Infinity;
  return -Math.abs(perfil.presupuestoMax - detalle.precio);
}

// Politica de desempate explicita y testeable (pedido original, item 6):
// 1) scoreInterno (ya refleja los 7 criterios de prioridad),
// 2) mejor ajuste a presupuesto (precio mas cercano al techo declarado),
// 3) mayor cantidad de criterios confirmados,
// 4) precio mas bajo,
// 5) orden estable por ID (siempre determinista, nunca hay empate real).
function compararRanking(a, b) {
  if (b.scoreInterno !== a.scoreInterno) return b.scoreInterno - a.scoreInterno;
  if (b.ajuste !== a.ajuste) return b.ajuste - a.ajuste;
  if (b.detalle.criteriosConfirmados !== a.detalle.criteriosConfirmados) return b.detalle.criteriosConfirmados - a.detalle.criteriosConfirmados;
  var precioA = a.detalle.precio === null ? Infinity : a.detalle.precio;
  var precioB = b.detalle.precio === null ? Infinity : b.detalle.precio;
  if (precioA !== precioB) return precioA - precioB;
  if (a.product.id < b.product.id) return -1;
  if (a.product.id > b.product.id) return 1;
  return 0;
}

// Motivos: unicamente afirmaciones reales sobre coincidencias que de verdad
// ocurrieron (nunca se agrega un motivo por un criterio que no participo o
// no coincidio). El orden de los motivos sigue siempre el mismo orden de
// prioridad de los criterios.
function buildMotivos(detalle, perfil) {
  var motivos = [];
  if (detalle.dentroDePresupuesto) {
    motivos.push('Dentro del presupuesto de ' + formatPrice(perfil.presupuestoMax));
  }
  if (detalle.clasificacionMatchEstilo) {
    motivos.push('Clasificación de ' + detalle.clasificacionUsada + ' coincide con el estilo declarado');
  }
  if (detalle.clasificacionMatchPrioridad) {
    motivos.push('Clasificación de ' + detalle.clasificacionUsada + ' coincide con la prioridad ' + perfil.prioridad);
  }
  if (detalle.formaMatch) {
    motivos.push('Forma ' + detalle.formaProducto + ' coincide con la preferencia');
  }
  if (detalle.nivelMatch) {
    motivos.push('Nivel recomendado ' + detalle.nivelProducto + ' coincide con tu nivel');
  }
  if (detalle.estiloMatch) {
    motivos.push('Estilo de juego ' + detalle.estiloProducto + ' coincide con la prioridad declarada');
  }
  return motivos;
}

// Advertencias: unicamente datos faltantes o inciertos que sean relevantes
// para ESTA recomendacion (nunca se oculta un precio fuera de presupuesto ni
// un dato de nivel/estilo que sea inferencia y no confirmacion oficial).
function buildAdvertencias(detalle, perfil) {
  var advertencias = [];
  if (perfil.presupuestoMax != null) {
    if (detalle.consultarPrecio) {
      advertencias.push('Precio a consultar: no se pudo confirmar si está dentro del presupuesto declarado.');
    } else if (detalle.precio !== null && detalle.precio > perfil.presupuestoMax) {
      advertencias.push('Este producto supera el presupuesto declarado de ' + formatPrice(perfil.presupuestoMax) + '.');
    }
  }
  if (detalle.nivelMatch && detalle.nivelEsInferencia) {
    advertencias.push('Nivel recomendado no confirmado por el fabricante (es una inferencia razonada).');
  }
  if (detalle.estiloMatch && detalle.estiloEsInferencia) {
    advertencias.push('Estilo de juego no confirmado por el fabricante (es una inferencia razonada).');
  }
  return advertencias;
}

// Punto de entrada principal. Recibe productos reales tal como los devuelve
// catalog.loadCatalog() (nunca objetos armados a mano por el modelo o el
// navegador) y un perfilCompra crudo (se sanea siempre de nuevo aca mismo,
// nunca se confia en que ya venga saneado: mismo criterio defensivo que el
// resto del proyecto). Devuelve un ranking estructurado, nunca un ganador
// arbitrario ni un porcentaje de compatibilidad.
function recommend(products, perfilCompraCrudo, options) {
  var opts = isPlainObject(options) ? options : {};
  var perfil = PadelProfile.sanitizePerfilCompra(perfilCompraCrudo);
  var limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.min(Math.floor(opts.limit), MAX_RESULTADOS)
    : MAX_RESULTADOS;

  // El recomendador solo ordena PALAS reales (tipoProducto "Paleta"): es el
  // unico tipo de producto para el que el perfil de compra (nivel, estilo,
  // prioridad, forma preferida) tiene sentido; accesorios, ropa, mochilas y
  // bolsos quedan fuera de esta etapa.
  var candidatos = Array.isArray(products)
    ? products.filter(function (p) { return isPlainObject(p) && typeof p.id === 'string' && esPaleta(p); })
    : [];

  var preciosConfirmados = candidatos
    .map(function (p) { return typeof p.precio === 'number' && !isPrecioConsultar(p) ? p.precio : null; })
    .filter(function (v) { return v !== null; });
  var precioRange = preciosConfirmados.length > 0
    ? { min: Math.min.apply(null, preciosConfirmados), max: Math.max.apply(null, preciosConfirmados) }
    : null;

  var evaluados = candidatos.map(function (product) {
    var detalle = evaluarProducto(product, perfil);
    var scoreInterno = calcularScore(detalle, precioRange);
    var ajuste = ajustePresupuesto(perfil, detalle);
    return { product: product, detalle: detalle, scoreInterno: scoreInterno, ajuste: ajuste };
  });

  evaluados.sort(compararRanking);

  var limitados = evaluados.slice(0, limit);

  var resultados = limitados.map(function (entry) {
    return {
      productId: entry.product.id,
      scoreInterno: entry.scoreInterno,
      motivos: buildMotivos(entry.detalle, perfil),
      advertencias: buildAdvertencias(entry.detalle, perfil),
    };
  });

  var hayDentroDePresupuesto = perfil.presupuestoMax != null
    ? evaluados.some(function (e) { return e.detalle.dentroDePresupuesto; })
    : null;

  var mejorCoincidencia = resultados.length > 0 ? resultados[0].productId : null;
  var siguientesOpciones = resultados.slice(1).map(function (r) { return r.productId; });

  // Alternativa mas economica: el producto con precio numerico confirmado
  // mas bajo entre los resultados ya rankeados, solo cuando existe de verdad
  // y es distinto y mas barato que la mejor coincidencia (si no hay una
  // segunda opcion mas barata que comparar, no tiene sentido ofrecer una
  // "alternativa").
  var alternativaEconomica = null;
  if (limitados.length > 1) {
    var mejor = limitados[0];
    var masBarata = null;
    for (var i = 1; i < limitados.length; i++) {
      var candidata = limitados[i];
      if (candidata.detalle.precio === null || candidata.detalle.consultarPrecio) continue;
      if (masBarata === null || candidata.detalle.precio < masBarata.detalle.precio) masBarata = candidata;
    }
    if (masBarata && (mejor.detalle.precio === null || mejor.detalle.consultarPrecio || masBarata.detalle.precio < mejor.detalle.precio)) {
      alternativaEconomica = masBarata.product.id;
    }
  }

  return {
    perfilUsado: perfil,
    presupuestoDeclarado: perfil.presupuestoMax,
    hayDentroDePresupuesto: hayDentroDePresupuesto,
    resultados: resultados,
    mejorCoincidencia: mejorCoincidencia,
    siguientesOpciones: siguientesOpciones,
    alternativaEconomica: alternativaEconomica,
  };
}

module.exports = {
  CLASIFICACION_VALIDA: CLASIFICACION_VALIDA,
  CLASIFICACION_IGNORADA: CLASIFICACION_IGNORADA,
  PRIORIDAD_A_CLASIFICACION: PRIORIDAD_A_CLASIFICACION,
  FORMA_CANONICA: FORMA_CANONICA,
  MAX_RESULTADOS: MAX_RESULTADOS,
  recommend: recommend,
  evaluarProducto: evaluarProducto,
  claseComercialValida: claseComercialValida,
  formaCanonica: formaCanonica,
};
