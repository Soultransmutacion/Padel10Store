'use strict';

// Nucleo determinista y compartido del carrito de Padel10Store.
//
// Este archivo es intencionalmente independiente del entorno: no usa `fs`,
// `require` de Node ni el DOM del navegador. Se carga tanto del lado del
// servidor (via `require('./padel-cart')` desde lib/padel-advisor-tools.js,
// para validar lo que la IA puede hacer) como del lado del navegador (via
// `<script src="lib/padel-cart.js">` en index.html, para que
// widget/padel-cart.js construya el carrito real de la tienda). Ambos
// entornos comparten exactamente las mismas reglas: nunca hay una version
// "para el asistente" y otra "para la tienda".
//
// Ninguna funcion de este archivo confia en un precio, nombre o talle
// recibido desde afuera (navegador, localStorage o el modelo de IA): todo
// se recalcula siempre contra el producto real que el llamador obtiene del
// catalogo (`getProduct(id)`), nunca contra datos ya guardados en una linea
// de carrito.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PadelCartCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  var MIN_QUANTITY = 1;
  var MAX_QUANTITY = 20;

  function isPlainString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  // Normalizacion de texto identica en criterio a la de lib/padel-catalog.js
  // (minusculas, sin tildes, sin puntuacion). Se duplica aqui deliberadamente
  // -es una funcion pura de ~6 lineas sin dependencias- para que este archivo
  // pueda cargarse en el navegador sin pasar por Node/`fs`, que es lo que
  // exige padel-catalog.js.
  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function tokenize(normalized) {
    return normalized ? normalized.split(' ').filter(Boolean) : [];
  }

  // Clamp tolerante: se usa solo para RESTAURAR lineas ya existentes (por
  // ejemplo desde localStorage), donde preferimos corregir un valor
  // sospechoso antes que descartar la linea entera.
  function sanitizeQuantity(rawValue) {
    var n = typeof rawValue === 'number' ? rawValue : parseInt(rawValue, 10);
    if (!isFinite(n) || isNaN(n)) return MIN_QUANTITY;
    n = Math.floor(n);
    if (n < MIN_QUANTITY) return MIN_QUANTITY;
    if (n > MAX_QUANTITY) return MAX_QUANTITY;
    return n;
  }

  // Validacion estricta: se usa cuando se esta agregando una linea nueva
  // (desde la tienda o desde el asistente). Un valor invalido se rechaza en
  // vez de corregirse en silencio.
  function validateQuantity(rawValue) {
    if (rawValue === undefined || rawValue === null) {
      return { ok: true, cantidad: MIN_QUANTITY };
    }
    var n = typeof rawValue === 'number' ? rawValue : NaN;
    if (!isFinite(n) || isNaN(n) || Math.floor(n) !== n || n < MIN_QUANTITY || n > MAX_QUANTITY) {
      return { ok: false, error: 'cantidad_invalida' };
    }
    return { ok: true, cantidad: n };
  }

  function requiresTalle(product) {
    return !!product && Array.isArray(product.talles) && product.talles.length > 0;
  }

  function isPrecioConsultar(product) {
    return !!(product && (product.precioConsultar === true || typeof product.precio !== 'number'));
  }

  // Valida un talle contra el producto REAL (ya resuelto por el llamador
  // contra el catalogo, nunca inventado). Nunca acepta un talle que no
  // figure literalmente en product.talles.
  function validateTalle(product, rawTalle) {
    var necesitaTalle = requiresTalle(product);
    if (necesitaTalle) {
      if (!isPlainString(rawTalle)) {
        return { ok: false, error: 'talle_requerido', tallesDisponibles: product.talles.slice() };
      }
      var trimmed = rawTalle.trim();
      if (product.talles.indexOf(trimmed) === -1) {
        return { ok: false, error: 'talle_invalido', tallesDisponibles: product.talles.slice() };
      }
      return { ok: true, talle: trimmed };
    }
    if (isPlainString(rawTalle)) {
      return { ok: false, error: 'talle_no_aplica' };
    }
    return { ok: true, talle: null };
  }

  // Construye una linea de carrito nueva y valida a partir de un producto
  // REAL. No modifica ningun estado: el llamador decide que hacer con el
  // resultado (agregarla a la lista de lineas que corresponda).
  function buildLine(product, rawTalle, rawCantidad) {
    if (!product || typeof product.id !== 'string') {
      return { ok: false, error: 'producto_invalido' };
    }
    if (isPrecioConsultar(product)) {
      return { ok: false, error: 'precio_consultar' };
    }
    var talleResult = validateTalle(product, rawTalle);
    if (!talleResult.ok) return talleResult;
    var cantidadResult = validateQuantity(rawCantidad);
    if (!cantidadResult.ok) return cantidadResult;
    return {
      ok: true,
      line: { productId: product.id, talle: talleResult.talle, cantidad: cantidadResult.cantidad },
    };
  }

  function findLineIndex(lines, productId, talle) {
    var normTalle = talle || null;
    for (var i = 0; i < (lines || []).length; i++) {
      if (lines[i].productId === productId && (lines[i].talle || null) === normTalle) return i;
    }
    return -1;
  }

  function lineImage(product) {
    return (Array.isArray(product.imagenes) && product.imagenes[0]) || product.imagen || null;
  }

  function formatPrice(value) {
    if (typeof value !== 'number' || isNaN(value)) return null;
    return '$' + value.toLocaleString('es-AR');
  }

  // Recalcula cada linea contra el catalogo real via getProduct(id) (sincrona,
  // debe devolver el producto o null/undefined). Nunca confia en precio,
  // nombre o disponibilidad de talle guardados en la linea: los vuelve a
  // obtener siempre del producto real. Cualquier linea cuyo producto ya no
  // exista, cuyo talle ya no sea valido o cuyo precio ya no sea numerico
  // (por ejemplo si paso a "a consultar") se descarta sin lanzar error,
  // junto con el motivo, para que el llamador pueda avisar si quiere.
  function buildCartSummary(lines, getProduct) {
    var validas = [];
    var descartadas = [];
    (lines || []).forEach(function (rawLine) {
      var productId = rawLine && rawLine.productId;
      if (!isPlainString(productId)) {
        descartadas.push({ productId: productId || null, talle: (rawLine && rawLine.talle) || null, motivo: 'producto_invalido' });
        return;
      }
      var product = getProduct(productId);
      if (!product) {
        descartadas.push({ productId: productId, talle: (rawLine && rawLine.talle) || null, motivo: 'no_encontrado' });
        return;
      }
      if (isPrecioConsultar(product)) {
        descartadas.push({ productId: productId, talle: (rawLine && rawLine.talle) || null, motivo: 'precio_consultar' });
        return;
      }
      var talleResult = validateTalle(product, rawLine && rawLine.talle);
      if (!talleResult.ok) {
        descartadas.push({ productId: productId, talle: (rawLine && rawLine.talle) || null, motivo: talleResult.error });
        return;
      }
      var cantidad = sanitizeQuantity(rawLine && rawLine.cantidad);
      validas.push({
        productId: product.id,
        nombre: product.nombre,
        marca: product.marca || null,
        tipoProducto: product.tipoProducto || null,
        talle: talleResult.talle,
        cantidad: cantidad,
        precio: product.precio,
        precioFormateado: formatPrice(product.precio),
        imagen: lineImage(product),
        subtotal: product.precio * cantidad,
      });
    });
    var total = validas.reduce(function (sum, l) { return sum + l.subtotal; }, 0);
    var cantidadTotal = validas.reduce(function (sum, l) { return sum + l.cantidad; }, 0);
    return { lineas: validas, descartadas: descartadas, total: total, totalFormateado: formatPrice(total), cantidadTotal: cantidadTotal };
  }

  // Palabras que nunca ayudan a identificar UN producto puntual dentro del
  // carrito (verbos, articulos, muletillas). Mismo criterio que la busqueda
  // del catalogo (lib/padel-catalog.js), acotado al vocabulario de "sacar
  // algo del carrito".
  var DESC_STOPWORDS = [
    'saca', 'sacame', 'quita', 'quitame', 'elimina', 'eliminame', 'borra',
    'borrame', 'saco', 'quiero', 'sacar', 'quitar', 'eliminar', 'del', 'de',
    'la', 'el', 'los', 'las', 'mi', 'carrito', 'por', 'favor', 'porfa', 'un', 'una',
  ];

  // Sinonimos coloquiales que el cliente usa en lenguaje natural pero que no
  // coinciden textualmente con el catalogo (tipoProducto "Paleta"). Se
  // normalizan ambos lados (la descripcion del cliente y el texto del
  // producto) antes de comparar, para que "sacame la pala" encuentre un
  // producto cuyo tipo real es "Paleta".
  var SYNONYM_MAP = { pala: 'paleta', palas: 'paleta' };

  function applySynonyms(tokens) {
    return tokens.map(function (t) { return SYNONYM_MAP[t] || t; });
  }

  function extractDescTokens(texto) {
    var normalized = normalizeText(texto);
    var tokens = tokenize(normalized).filter(function (t) {
      return t.length > 1 && DESC_STOPWORDS.indexOf(t) === -1;
    });
    return applySynonyms(tokens);
  }

  // Busca, dentro de las lineas YA VALIDADAS de un carrito (salida de
  // buildCartSummary().lineas), cuales coinciden con una descripcion libre
  // en texto (por ejemplo "la pala" o "las medias negras"). Exige que TODAS
  // las palabras senal de la descripcion esten presentes en el nombre, la
  // marca, el tipo de producto o el talle de la linea. Puede devolver 0, 1 o
  // varias coincidencias: el llamador decide que hacer en cada caso (nunca
  // elige arbitrariamente entre varias).
  function matchCartLinesByText(cartSummaryLines, texto) {
    var tokens = extractDescTokens(texto);
    if (tokens.length === 0) return [];
    return (cartSummaryLines || []).filter(function (line) {
      var haystack = normalizeText([line.nombre, line.marca, line.tipoProducto, line.talle].filter(Boolean).join(' '));
      var haystackTokens = tokenize(haystack);
      return tokens.every(function (t) { return haystackTokens.indexOf(t) !== -1; });
    });
  }

  var POSICION_A_INDICE = { primera: 0, segunda: 1, tercera: 2 };

  // Resuelve una referencia conversacional ("la segunda", "esa", "la mas
  // barata") contra una lista ORDENADA y real de productos ofrecidos en la
  // conversacion (nunca inventada por el modelo: la arma siempre el
  // servidor a partir de resultados reales de herramientas). El modelo solo
  // puede elegir uno de estos tres campos cerrados (productId directo,
  // referenciaPosicion o referenciaCriterio); nunca puede escribir un ID a
  // mano en este camino y que se acepte sin mas: si usa referenciaPosicion o
  // referenciaCriterio, el ID final siempre sale de `offeredProducts`.
  function resolveOfferedReference(params, offeredProducts, getProduct) {
    var lista = Array.isArray(offeredProducts) ? offeredProducts : [];
    var p = params || {};
    if (isPlainString(p.productId)) {
      return { ok: true, productId: p.productId.trim() };
    }
    if (isPlainString(p.referenciaPosicion)) {
      var idx = POSICION_A_INDICE[p.referenciaPosicion];
      if (idx === undefined) return { ok: false, error: 'referencia_invalida' };
      if (!lista[idx]) return { ok: false, error: 'posicion_no_disponible' };
      return { ok: true, productId: lista[idx].id };
    }
    if (isPlainString(p.referenciaCriterio)) {
      if (p.referenciaCriterio === 'esa') {
        if (lista.length === 1) return { ok: true, productId: lista[0].id };
        if (lista.length === 0) return { ok: false, error: 'sin_contexto' };
        return { ok: false, error: 'ambiguo', opciones: lista.map(function (item) { return item.id; }) };
      }
      if (p.referenciaCriterio === 'mas_barata' || p.referenciaCriterio === 'mas_cara') {
        var conPrecio = lista
          .map(function (item) { return { id: item.id, producto: getProduct(item.id) }; })
          .filter(function (entry) {
            return entry.producto && typeof entry.producto.precio === 'number' && entry.producto.precioConsultar !== true;
          });
        if (conPrecio.length === 0) return { ok: false, error: 'sin_contexto' };
        conPrecio.sort(function (a, b) {
          return p.referenciaCriterio === 'mas_barata'
            ? a.producto.precio - b.producto.precio
            : b.producto.precio - a.producto.precio;
        });
        return { ok: true, productId: conPrecio[0].id };
      }
      return { ok: false, error: 'referencia_invalida' };
    }
    return { ok: false, error: 'sin_referencia' };
  }

  return {
    MIN_QUANTITY: MIN_QUANTITY,
    MAX_QUANTITY: MAX_QUANTITY,
    normalizeText: normalizeText,
    sanitizeQuantity: sanitizeQuantity,
    validateQuantity: validateQuantity,
    requiresTalle: requiresTalle,
    isPrecioConsultar: isPrecioConsultar,
    validateTalle: validateTalle,
    buildLine: buildLine,
    findLineIndex: findLineIndex,
    buildCartSummary: buildCartSummary,
    matchCartLinesByText: matchCartLinesByText,
    resolveOfferedReference: resolveOfferedReference,
    formatPrice: formatPrice,
  };
});
