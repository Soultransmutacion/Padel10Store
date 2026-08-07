'use strict';

const fs = require('fs');
const path = require('path');

const WHATSAPP_NUMBER = '5493413637355';

const TECH_FIELD_LABELS = {
  forma: 'Forma',
  balance: 'Balance',
  peso: 'Peso',
  materialCaras: 'Material de caras',
  materialMarco: 'Material de marco',
  nucleo: 'Nucleo',
  espesor: 'Espesor',
  dureza: 'Dureza',
  material: 'Material',
};

const TECH_FIELD_KEYS = Object.keys(TECH_FIELD_LABELS);

let catalogCache = null;

function loadCatalog() {
  if (catalogCache) return catalogCache;
  const filePath = path.join(process.cwd(), 'products.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  catalogCache = Array.isArray(data.productos) ? data.productos : [];
  return catalogCache;
}

// Normalizacion robusta para busqueda: minusculas, sin tildes, sin apostrofes
// (rectos o tipograficos) ni signos de puntuacion, con espacios colapsados.
// Ejemplo: "Cross Black '26" y "Cross Black 26" normalizan igual: "cross black 26".
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

function isPrecioConsultar(product) {
  return !!product.precioConsultar || typeof product.precio !== 'number';
}

function getConfirmedTechFields(product) {
  const spec = product.especificaciones || {};
  return TECH_FIELD_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(spec, key))
    .map((key) => ({ key, label: TECH_FIELD_LABELS[key], value: spec[key] }))
    .filter((f) => f.value !== null && f.value !== undefined && f.value !== '');
}

function hasFuenteOficial(product) {
  return Array.isArray(product.fuentes) && product.fuentes.length > 0;
}

function getConfidenceLevel(product) {
  const confirmed = getConfirmedTechFields(product).length;
  const hasFuente = hasFuenteOficial(product);
  if (hasFuente && confirmed >= 4) return 'alta';
  if (hasFuente && confirmed >= 1) return 'media';
  return 'limitada';
}

function formatPrice(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return '$' + value.toLocaleString('es-AR');
}

function resolveImageUrl(product) {
  if (!product.tieneImagen || !product.imagen) return null;
  // Nunca se antepone un dominio fijo (ni Vercel ni GitHub Pages): se
  // devuelve la ruta tal cual viene de products.json (relativa) o la URL
  // externa ya absoluta de un producto legado. La resolucion final a una URL
  // absoluta la hace el navegador (widget/padel-advisor.js) contra
  // document.baseURI, que se adapta solo al entorno real donde se sirve el
  // sitio (raiz en Vercel, subcarpeta en GitHub Pages).
  return product.imagen;
}

function buildWhatsappMessage(product) {
  const nombre = product.nombre;
  if (isPrecioConsultar(product)) {
    return 'Hola! Estuve usando el asesor de Padel10Store y quiero consultar el precio y stock de ' + nombre + '.';
  }
  const precioTexto = formatPrice(product.precio);
  return 'Hola! Estuve usando el asesor de Padel10Store y quiero consultar por ' + nombre + '. Vi el precio publicado de ' + precioTexto + '. ¿Podrían confirmarme stock y condiciones de compra?';
}

function buildWhatsappLink(product) {
  const mensaje = buildWhatsappMessage(product);
  return 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(mensaje);
}

function toSummary(product) {
  const consultar = isPrecioConsultar(product);
  return {
    id: product.id,
    nombre: product.nombre,
    marca: product.marca,
    tipoProducto: product.tipoProducto,
    seccion: product.seccion,
    precio: consultar ? null : product.precio,
    precioFormateado: consultar ? null : formatPrice(product.precio),
    precioConsultar: consultar,
    precioTransferencia: consultar ? null : (typeof product.precioTransferencia === 'number' ? product.precioTransferencia : null),
    confianza: getConfidenceLevel(product),
  };
}

function toCard(product) {
  const consultar = isPrecioConsultar(product);
  const confirmedFields = getConfirmedTechFields(product).slice(0, 4);
  return {
    id: product.id,
    nombre: product.nombre,
    marca: product.marca,
    tipoProducto: product.tipoProducto,
    imagen: resolveImageUrl(product),
    precio: consultar ? null : product.precio,
    precioFormateado: consultar ? null : formatPrice(product.precio),
    precioTransferencia: consultar ? null : (typeof product.precioTransferencia === 'number' ? product.precioTransferencia : null),
    precioTransferenciaFormateado: consultar ? null : formatPrice(product.precioTransferencia),
    precioConsultar: consultar,
    // Si el precio esta a consultar, nunca se informan cuotas: evita afirmar
    // condiciones de pago sobre un producto sin precio confirmado.
    cuotasTexto: consultar ? null : (product.cuotasTexto || null),
    caracteristicasConfirmadas: confirmedFields.map((f) => ({ label: f.label, value: f.value })),
    confianza: getConfidenceLevel(product),
    whatsapp: {
      numero: '+54 9 341 363-7355',
      mensaje: buildWhatsappMessage(product),
      link: buildWhatsappLink(product),
    },
  };
}

function toComparisonEntry(product) {
  const consultar = isPrecioConsultar(product);
  const spec = product.especificaciones || {};
  const campos = {};
  TECH_FIELD_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(spec, key)) {
      const value = spec[key];
      campos[TECH_FIELD_LABELS[key]] = (value === null || value === undefined || value === '') ? 'No confirmado' : value;
    }
  });
  return {
    id: product.id,
    nombre: product.nombre,
    marca: product.marca,
    precio: consultar ? null : product.precio,
    precioFormateado: consultar ? null : formatPrice(product.precio),
    precioConsultar: consultar,
    confianza: getConfidenceLevel(product),
    campos: campos,
  };
}

function buildHaystack(product) {
  return normalizeText([product.nombre, product.marca, product.tipoProducto, product.seccion].join(' '));
}

function searchCatalog(args) {
  args = args || {};
  const catalog = loadCatalog();
  const textoNorm = args.texto ? normalizeText(args.texto) : null;
  const marcaNorm = args.marca ? normalizeText(args.marca) : null;
  const tipoNorm = args.tipo ? normalizeText(args.tipo) : null;

  const candidates = catalog.filter((p) => {
    if (marcaNorm && normalizeText(p.marca) !== marcaNorm) return false;
    if (tipoNorm && normalizeText(p.tipoProducto) !== tipoNorm) return false;
    if (typeof args.precioMin === 'number' && (typeof p.precio !== 'number' || p.precio < args.precioMin)) return false;
    if (typeof args.precioMax === 'number' && (typeof p.precio !== 'number' || p.precio > args.precioMax)) return false;
    return true;
  });

  if (!textoNorm) {
    return candidates.slice(0, 12).map(toSummary);
  }

  // Prioridad 1: coincidencia exacta de ID normalizado.
  const exactId = candidates.find((p) => normalizeText(p.id) === textoNorm);
  if (exactId) return [toSummary(exactId)];

  // Prioridad 2: coincidencia exacta de nombre normalizado.
  const exactName = candidates.find((p) => normalizeText(p.nombre) === textoNorm);
  if (exactName) return [toSummary(exactName)];

  // Prioridad 3: coincidencia por tokens (sin depender del orden de las palabras
  // ni de una coincidencia literal de la frase completa). Requiere que al menos
  // el 60% de los tokens de la consulta esten presentes para evitar resultados
  // demasiado amplios o irrelevantes.
  const queryTokens = tokenize(textoNorm);
  if (queryTokens.length === 0) return [];

  const scored = candidates
    .map((p) => {
      const haystackTokens = new Set(tokenize(buildHaystack(p)));
      const matched = queryTokens.filter((t) => haystackTokens.has(t));
      return { p: p, matched: matched.length, ratio: matched.length / queryTokens.length };
    })
    .filter((entry) => entry.ratio >= 0.6)
    .sort((a, b) => b.ratio - a.ratio || b.matched - a.matched);

  return scored.slice(0, 12).map((entry) => toSummary(entry.p));
}

function matchesVersion(product, version) {
  if (!version) return true;
  const haystack = normalizeText(product.nombre + ' ' + product.seccion + ' ' + product.filtro);
  const spec = product.especificaciones || {};
  if (version === 'liviana') return haystack.indexOf('light') !== -1 || haystack.indexOf('lite') !== -1;
  if (version === 'femenina') return haystack.indexOf('woman') !== -1 || haystack.indexOf('dama') !== -1 || haystack.indexOf('mujer') !== -1 || spec.genero === 'femenino';
  if (version === 'junior') return haystack.indexOf('junior') !== -1;
  if (version === 'infantil') return haystack.indexOf('kids') !== -1 || haystack.indexOf('ninos') !== -1 || haystack.indexOf('nino') !== -1;
  return true;
}

function filterPalas(args) {
  args = args || {};
  const catalog = loadCatalog().filter((p) => normalizeText(p.tipoProducto) === 'paleta');
  const marcaNorm = args.marca ? normalizeText(args.marca) : null;
  const formaNorm = args.forma ? normalizeText(args.forma) : null;
  const balanceNorm = args.balance ? normalizeText(args.balance) : null;
  const pesoNorm = args.peso ? normalizeText(args.peso) : null;
  const materialNorm = args.material ? normalizeText(args.material) : null;
  const nivelNorm = args.nivel ? normalizeText(args.nivel) : null;
  const estiloNorm = args.estilo ? normalizeText(args.estilo) : null;
  const clasifNorm = args.clasificacionComercial ? normalizeText(args.clasificacionComercial) : null;

  const results = catalog.filter((p) => {
    const spec = p.especificaciones || {};
    if (typeof args.presupuestoMin === 'number' && (typeof p.precio !== 'number' || p.precio < args.presupuestoMin)) return false;
    if (typeof args.presupuestoMax === 'number' && (typeof p.precio !== 'number' || p.precio > args.presupuestoMax)) return false;
    if (marcaNorm && normalizeText(p.marca) !== marcaNorm) return false;
    if (formaNorm && normalizeText(spec.forma) !== formaNorm) return false;
    if (balanceNorm && normalizeText(spec.balance).indexOf(balanceNorm) === -1) return false;
    if (pesoNorm && normalizeText(spec.peso).indexOf(pesoNorm) === -1) return false;
    if (materialNorm) {
      const materiales = normalizeText((spec.materialCaras || '') + ' ' + (spec.materialMarco || '') + ' ' + (spec.material || ''));
      if (materiales.indexOf(materialNorm) === -1) return false;
    }
    if (nivelNorm && normalizeText(spec.nivelRecomendado).indexOf(nivelNorm) === -1) return false;
    if (estiloNorm && normalizeText(spec.estiloJuego).indexOf(estiloNorm) === -1) return false;
    if (clasifNorm && normalizeText(spec.clasificacionComercialSitio) !== clasifNorm) return false;
    if (!matchesVersion(p, args.version)) return false;
    return true;
  });

  const order = { alta: 0, media: 1, limitada: 2 };
  results.sort((a, b) => order[getConfidenceLevel(a)] - order[getConfidenceLevel(b)]);

  return results.slice(0, 12).map(toSummary);
}

function getProductById(id) {
  return loadCatalog().find((p) => p.id === id) || null;
}

function compareProducts(ids) {
  const unique = Array.from(new Set(ids));
  const found = [];
  const noEncontrados = [];
  unique.forEach((id) => {
    const p = getProductById(id);
    if (p) found.push(p);
    else noEncontrados.push(id);
  });
  return {
    productos: found.map(toComparisonEntry),
    noEncontrados: noEncontrados,
  };
}

function verProducto(id) {
  const p = getProductById(id);
  if (!p) return null;
  return toCard(p);
}

module.exports = {
  WHATSAPP_NUMBER,
  loadCatalog,
  normalizeText,
  getConfidenceLevel,
  formatPrice,
  resolveImageUrl,
  buildWhatsappMessage,
  buildWhatsappLink,
  toSummary,
  toCard,
  toComparisonEntry,
  searchCatalog,
  filterPalas,
  getProductById,
  compareProducts,
  verProducto,
};
