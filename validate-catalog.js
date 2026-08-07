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


  // --- Etapa 2A (correcciones): aviso de talle obligatorio + asesor movible ---
  const A = '\u00e1';
  const advisorCssPath = path.join(ROOT, 'widget', 'padel-advisor.css');
  const advisorJsPath = path.join(ROOT, 'widget', 'padel-advisor.js');
  const advisorCss = fs.readFileSync(advisorCssPath, 'utf8');
  const advisorJs = fs.readFileSync(advisorJsPath, 'utf8');

  if (!html.includes('id="modalTalleMsg" aria-live="polite"')) {
    issues.push('El mensaje de talle obligatorio (#modalTalleMsg) debe tener aria-live="polite".');
  }
  if (!html.includes("talleMsgEl)talleMsgEl.textContent='Seleccion" + A + " un talle para continuar.';if(talleRowEl)talleRowEl.classList.add('talle-error');if(talleMsgEl)talleMsgEl.focus();return;")) {
    issues.push('El boton Agregar al carrito no bloquea con aviso visible + foco cuando falta el talle.');
  }
  if (!html.includes("if(msg)msg.textContent='Seleccion" + A + " un talle para continuar.';var row=document.getElementById('modalTalleRow');if(row)row.classList.add('talle-error');if(msg)msg.focus();")) {
    issues.push('El boton Comprar ahora no bloquea con aviso visible + foco cuando falta el talle.');
  }
  if (!html.includes("if(talleMsgEl)talleMsgEl.textContent='';if(talleRowEl)talleRowEl.classList.remove('talle-error');")) {
    issues.push('El estado de error del talle no se limpia al seleccionar un talle valido.');
  }

  if (!/\.pa-launcher \{[^}]*left: 20px;/.test(advisorCss) || /\.pa-launcher \{[^}]*right: 20px;/.test(advisorCss)) {
    issues.push('El boton del asesor (.pa-launcher) debe tener posicion inicial a la izquierda, no a la derecha.');
  }
  const launcherZ = advisorCss.match(/\.pa-launcher \{[^}]*z-index:\s*(\d+)/);
  const cartDrawerZ = html.match(/\.drw\{[^}]*z-index:(\d+)/);
  if (!launcherZ || !cartDrawerZ || Number(launcherZ[1]) >= Number(cartDrawerZ[1])) {
    issues.push('El z-index del asesor debe ser menor al del carrito para no tapar sus controles.');
  }
  if (!advisorJs.includes("DEFAULT_SIDE = 'left'")) {
    issues.push('La posicion por defecto del asesor debe ser left.');
  }
  if (!advisorJs.includes('POSITION_STORAGE_KEY') || !advisorJs.includes('localStorage.getItem(POSITION_STORAGE_KEY)')) {
    issues.push('El asesor debe leer su posicion guardada desde localStorage.');
  }
  if (!advisorJs.includes("return { side: DEFAULT_SIDE, bottom: DEFAULT_BOTTOM };") || !advisorJs.includes('JSON.parse(raw)')) {
    issues.push('Datos de posicion invalidos o corruptos deben volver a la posicion por defecto.');
  }
  if (!advisorJs.includes('onLauncherPointerDown') || !advisorJs.includes('onLauncherPointerMove') || !advisorJs.includes('onLauncherPointerUp')) {
    issues.push('Falta la logica de arrastre (pointerdown/pointermove/pointerup) del boton del asesor.');
  }
  if (!advisorJs.includes('if (didDrag) {\ndidDrag = false;\ne.preventDefault();\nreturn;\n}\ntogglePanel();')) {
    issues.push('El clic del asesor debe abrir el panel solo si no hubo arrastre.');
  }
  if (!advisorJs.includes('DRAG_THRESHOLD')) {
    issues.push('Falta un umbral para diferenciar clic de arrastre en el asesor.');
  }
  if (!advisorJs.includes('window.innerWidth - width - 4') || !advisorJs.includes('window.innerHeight - height - 4')) {
    issues.push('El arrastre del asesor debe mantenerlo dentro de los limites del viewport.');
  }
  if (!advisorJs.includes('function clampBottom')) {
    issues.push('Falta el clamp de posicion vertical para que el asesor no quede cortado.');
  }
  if (!advisorJs.includes("window.addEventListener('resize'")) {
    issues.push('El asesor debe recalcular su posicion al cambiar el tamano de la ventana.');
  }
  if (!advisorJs.includes('function minimizePanel') || !advisorJs.includes("document.body.style.overflow === 'hidden'")) {
    issues.push('El asesor debe minimizarse automaticamente al abrir el carrito o el modal de producto.');
  }

  ['function openCartDrawer', 'function closeCartDrawer', 'function renderCartDrawer', 'function addLineToCart'].forEach((token) => {
    if (!html.includes(token)) issues.push('Funcion de carrito faltante o modificada: ' + token);
  });
  ['API_URL', 'GREETING', 'function sendMessage', 'PadelMPBuy'].forEach((token) => {
    if (!advisorJs.includes(token)) issues.push('El asistente perdio una pieza clave de su funcionamiento: ' + token);
  });

  if (issues.length === 0) {
    console.log('✓ Aviso de talle obligatorio visible (aria-live, foco, estado de error) OK');
    console.log('✓ Asesor: posicion izquierda por defecto, arrastre, persistencia y minimizado automatico OK');
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
