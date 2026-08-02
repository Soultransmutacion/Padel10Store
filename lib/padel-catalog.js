'use strict';

const fs = require('fs');
const path = require('path');

const SITE_BASE_URL = 'https://soultransmutacion.github.io/Padel10Store/';
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

function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
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
    if (/^https?:\/\//i.test(product.imagen)) return product.imagen;
    return SITE_BASE_URL + product.imagen;
}

function buildWhatsappMessage(product) {
    const nombre = product.nombre;
    if (product.precioConsultar || typeof product.precio !== 'number') {
          return 'Hola! Estuve usando el asesor de Padel10Store y quiero consultar el precio y stock de ' + nombre + '.';
    }
    const precioTexto = formatPrice(product.precio);
    return 'Hola! Estuve usando el asesor de Padel10Store y quiero consultar por ' + nombre + '. Vi el precio publicado de ' + precioTexto + '. ¿Podrian confirmarme stock y condiciones de compra?';
}

function buildWhatsappLink(product) {
    const mensaje = buildWhatsappMessage(product);
    return 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(mensaje);
}

function toSummary(product) {
    return {
          id: product.id,
          nombre: product.nombre,
          marca: product.marca,
          tipoProducto: product.tipoProducto,
          seccion: product.seccion,
          precio: typeof product.precio === 'number' ? product.precio : null,
          precioFormateado: formatPrice(product.precio),
          precioConsultar: !!product.precioConsultar,
          precioTransferencia: typeof product.precioTransferencia === 'number' ? product.precioTransferencia : null,
          confianza: getConfidenceLevel(product),
    };
}

function toCard(product) {
    const confirmedFields = getConfirmedTechFields(product).slice(0, 4);
    return {
          id: product.id,
          nombre: product.nombre,
          marca: product.marca,
          tipoProducto: product.tipoProducto,
          imagen: resolveImageUrl(product),
          precio: typeof product.precio === 'number' ? product.precio : null,
          precioFormateado: formatPrice(product.precio),
          precioTransferencia: typeof product.precioTransferencia === 'number' ? product.precioTransferencia : null,
          precioTransferenciaFormateado: formatPrice(product.precioTransferencia),
          precioConsultar: !!product.precioConsultar,
          cuotasTexto: product.cuotasTexto || null,
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
          precio: typeof product.precio === 'number' ? product.precio : null,
          precioFormateado: formatPrice(product.precio),
          precioConsultar: !!product.precioConsultar,
          confianza: getConfidenceLevel(product),
          campos: campos,
    };
}

function searchCatalog(args) {
    args = args || {};
    const catalog = loadCatalog();
    const texto = args.texto ? normalizeText(args.texto) : null;
    const marcaNorm = args.marca ? normalizeText(args.marca) : null;
    const tipoNorm = args.tipo ? normalizeText(args.tipo) : null;
    return catalog
      .filter((p) => {
              if (texto) {
                        const haystack = normalizeText(p.nombre + ' ' + p.marca + ' ' + p.tipoProducto + ' ' + p.seccion);
                        if (haystack.indexOf(texto) === -1) return false;
              }
              if (marcaNorm && normalizeText(p.marca) !== marcaNorm) return false;
              if (tipoNorm && normalizeText(p.tipoProducto) !== tipoNorm) return false;
              if (typeof args.precioMin === 'number' && (typeof p.precio !== 'number' || p.precio < args.precioMin)) return false;
              if (typeof args.precioMax === 'number' && (typeof p.precio !== 'number' || p.precio > args.precioMax)) return false;
              return true;
      })
      .slice(0, 12)
      .map(toSummary);
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
    SITE_BASE_URL,
    WHATSAPP_NUMBER,
    loadCatalog,
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
