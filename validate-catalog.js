#!/usr/bin/env node
/**
 * validate-catalog.js
 *
 * Compara products.json contra las tarjetas de producto reales de index.html
 * para detectar diferencias entre el catalogo estructurado y lo publicado en el sitio.
 *
 * Uso:
 *   node validate-catalog.js
 *
 * Sale con codigo 1 y detalla cada diferencia si encuentra alguna.
 * Sale con codigo 0 si el catalogo esta sincronizado.
 *
 * No usa dependencias externas (solo modulos nativos de Node).
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const productsPath = path.join(ROOT, 'products.json');
const htmlPath = path.join(ROOT, 'index.html');

function decodeEntities(str) {
  const map = {
    '&amp;': '&', '&middot;': '·', '&#39;': "'", '&quot;': '"',
    '&#10004;': '✔', '&#43;': '+', '&#8722;': '-', '&#9825;': '♡', '&#x2715;': '✕',
    '&oacute;': 'ó', '&iacute;': 'í', '&ntilde;': 'ñ', '&aacute;': 'á',
    '&eacute;': 'é', '&uacute;': 'ú', '&Ntilde;': 'Ñ'
  };
  return str.replace(/&(?:amp|middot|#39|quot|#10004|#43|#8722|#9825|#x2715|oacute|iacute|ntilde|aacute|eacute|uacute|Ntilde);/g,
    (m) => (map[m] !== undefined ? map[m] : m));
}

function extractField(chunk, regex) {
  const m = chunk.match(regex);
  return m ? decodeEntities(m[1].trim()) : null;
}

function parsePriceNum(s) {
  if (!s) return null;
  if (/consultar/i.test(s)) return 'CONSULTAR';
  const n = parseInt(s.replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

function parseCards(html) {
  const CARD_MARK = '<div class="card"';
  const parts = html.split(CARD_MARK);
  const cardChunks = parts.slice(1);
  return cardChunks.map((chunk) => ({
    img: extractField(chunk, /<img src="([^"]*)"/),
    productId: extractField(chunk, /data-product-id="([^"]*)"/),
    btnText: extractField(chunk, /class="add-btn"[^>]*>([^<]*)</),
    cat: extractField(chunk, /class="card-cat">([^<]*)</),
    name: extractField(chunk, /class="card-name">([^<]*)</),
    price: extractField(chunk, /class="card-price">([^<]*)</),
    transferencia: (() => {
      const m = chunk.match(/<div[^>]*>([^<]*Transferencia[^<]*)<\/div>/);
      return m ? decodeEntities(m[1].trim()) : null;
    })()
  }));
}

function validate() {
  const issues = [];
  const productsRaw = fs.readFileSync(productsPath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');

  let data;
  try {
    data = JSON.parse(productsRaw);
  } catch (e) {
    console.error('✗ products.json no es JSON valido: ' + e.message);
    process.exit(1);
  }
  const productos = data.productos || [];
  console.log('✓ products.json es JSON valido (' + productos.length + ' productos)');

  const cards = parseCards(html);
  console.log('✓ index.html parseado (' + cards.length + ' tarjetas encontradas)');

  if (cards.length !== productos.length) {
    issues.push('Cantidad total distinta: HTML tiene ' + cards.length + ', JSON tiene ' + productos.length);
  }

  const ids = productos.map((p) => p.id);
  const idCounts = {};
  ids.forEach((id) => { idCounts[id] = (idCounts[id] || 0) + 1; });
  const dupIds = Object.entries(idCounts).filter(([, c]) => c > 1);
  if (dupIds.length) issues.push('IDs duplicados: ' + JSON.stringify(dupIds));

  for (let i = 0; i < Math.max(cards.length, productos.length); i += 1) {
    const c = cards[i];
    const p = productos[i];
    if (!c) { issues.push('Producto JSON sin tarjeta en HTML (id=' + (p && p.id) + ')'); continue; }
    if (!p) { issues.push('Tarjeta HTML sin producto en JSON (nombre=' + c.name + ')'); continue; }

    if (c.name !== p.nombre) {
      issues.push('Nombre distinto en indice ' + i + ': HTML="' + c.name + '" JSON="' + p.nombre + '"');
    }
    const marcaFromCard = c.cat ? c.cat.split('·').pop().trim() : null;
    if (marcaFromCard && marcaFromCard !== p.marca) {
      issues.push('Marca distinta en "' + p.nombre + '": HTML="' + marcaFromCard + '" JSON="' + p.marca + '"');
    }
    const cardPriceNum = parsePriceNum(c.price);
    if (p.precioConsultar) {
      if (cardPriceNum !== 'CONSULTAR') {
        issues.push('Producto "' + p.nombre + '" tiene precioConsultar=true en JSON pero el HTML no muestra "Consultar" (valor: "' + c.price + '")');
      }
      if (p.precio !== null) {
        issues.push('Producto "' + p.nombre + '" tiene precioConsultar=true pero precio no es null en JSON (valor: ' + p.precio + ')');
      }
    } else if (cardPriceNum !== p.precio) {
      issues.push('Precio distinto en "' + p.nombre + '": HTML=' + cardPriceNum + ' JSON=' + p.precio);
    }
    const transferNum = c.transferencia ? parseInt(c.transferencia.replace(/[^0-9]/g, ''), 10) : null;
    if ((transferNum || null) !== (p.precioTransferencia || null)) {
      issues.push('Precio transferencia distinto en "' + p.nombre + '": HTML=' + transferNum + ' JSON=' + p.precioTransferencia);
    }
    if (p.tieneImagen && !c.img) issues.push('Imagen faltante en HTML para "' + p.nombre + '"');
    if (c.img && p.imagen && decodeURIComponent(c.img) !== decodeURIComponent(p.imagen)) {
      issues.push('Ruta de imagen distinta en "' + p.nombre + '": HTML="' + c.img + '" JSON="' + p.imagen + '"');
    }
  }

  const cardIds = cards.map((c) => c.productId);
  const missingIds = cardIds.filter((id) => !id).length;
  if (missingIds > 0) issues.push('Tarjetas sin data-product-id: ' + missingIds);
  const cardIdCounts = {};
  cardIds.forEach((id) => { if (id) cardIdCounts[id] = (cardIdCounts[id] || 0) + 1; });
  const dupCardIds = Object.entries(cardIdCounts).filter(([, c]) => c > 1);
  if (dupCardIds.length) issues.push('data-product-id duplicados en index.html: ' + JSON.stringify(dupCardIds));
  const catalogIdSet = new Set(ids);
  cardIds.forEach((id, i) => {
    if (!id) return;
    if (!catalogIdSet.has(id)) issues.push('data-product-id "' + id + '" (tarjeta ' + i + ') no existe en products.json');
    const expected = productos[i] ? productos[i].id : undefined;
    if (expected && id !== expected) issues.push('data-product-id distinto en la posicion ' + i + ': HTML="' + id + '" JSON="' + expected + '"');
  });
  if (missingIds === 0 && dupCardIds.length === 0) {
    console.log('✓ Las 92 tarjetas tienen data-product-id unico y coincide con products.json');
  }

  const talleProductIds = productos.filter((p) => Array.isArray(p.talles) && p.talles.length > 0).map((p) => p.id);
  cards.forEach((c, i) => {
    const expectedId = productos[i] ? productos[i].id : undefined;
    const isTalleCard = expectedId && talleProductIds.indexOf(expectedId) > -1;
    if (isTalleCard && c.btnText !== 'ELEGIR TALLE') {
      issues.push('Tarjeta con talles "' + expectedId + '" deberia tener el boton ELEGIR TALLE, tiene: "' + c.btnText + '"');
    }
    if (!isTalleCard && c.btnText === 'ELEGIR TALLE') {
      issues.push('Tarjeta "' + expectedId + '" tiene el boton ELEGIR TALLE sin declarar talles en products.json');
    }
  });
  const crossBlackCard = cards.find((c) => c.productId === 'royal-padel-cross-black-26');
  if (!crossBlackCard || crossBlackCard.btnText !== 'Consultar') {
    issues.push('Cross Black 26 deberia conservar el boton Consultar en su tarjeta (comportamiento previo sin cambios)');
  }
  if (talleProductIds.length !== 12) {
    issues.push('Se esperaban 12 productos con talles en products.json, se encontraron ' + talleProductIds.length);
  }
  if (missingIds === 0 && dupCardIds.length === 0 && issues.length === 0) {
    console.log('✓ Los 12 productos con talles muestran ELEGIR TALLE y Cross Black 26 conserva Consultar');
  }

  if (issues.length === 0) {
    console.log('✓ Sincronizacion OK: products.json y index.html coinciden en los ' + productos.length + ' productos.');
    process.exit(0);
  } else {
    console.error('✗ Se encontraron ' + issues.length + ' diferencia(s):');
    issues.forEach((msg) => console.error('  - ' + msg));
    process.exit(1);
  }
}

validate();
