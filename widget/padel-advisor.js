(function () {
'use strict';

var API_URL = '/api/padel-assistant';
var WHATSAPP_NUMBER = '5493413637355';
var MAX_MESSAGE_LENGTH = 700;
var MAX_HISTORY_MESSAGES = 8;
var GREETING = 'Hola! Soy el asesor de Padel10Store. Te ayudo a encontrar una pala que encaje con tu juego y presupuesto. Que nivel o categoria jugas actualmente?';

// Prueba controlada de Mercado Pago Checkout Pro (SANDBOX): unicamente
// este producto muestra el boton "Comprar ahora" en las recomendaciones
// del asesor. No cambia el comportamiento de ningun otro producto.
var MP_PURCHASABLE_PRODUCT_ID = 'royal-padel-cross-black-26';

var root = document.getElementById('padel-advisor-root');
if (!root) return;

var history = [];
var shownProductIds = {};
var panelOpened = false;
var sending = false;

// Ultima lista ORDENADA de productos mostrados (IDs) que el servidor
// devolvio en la respuesta anterior: se reenvia tal cual en el siguiente
// mensaje para que el servidor pueda resolver "la segunda"/"esa" contra lo
// que el cliente realmente vio (ver lib/padel-advisor.js#createOfferedContext).
// El cliente nunca decide el significado de la referencia, solo transporta
// la lista.
var lastOfrecidos = [];

// Perfil de compra TEMPORAL de esta conversacion (Fase 2 - Etapa 4): igual
// que lastOfrecidos, el cliente solo lo TRANSPORTA de un mensaje al
// siguiente tal cual lo devolvio el servidor la ultima vez; nunca lo arma,
// lo interpreta ni lo valida el mismo. No es memoria permanente: vive solo
// en esta variable de JS, asi que desaparece si se recarga la pagina o se
// cierra la pestaña (nunca se guarda en localStorage).
var lastPerfilCompra = {};

function getCarritoActual() {
  if (window.PadelCart && typeof window.PadelCart.getRawLines === 'function') {
    return window.PadelCart.getRawLines();
  }
  return [];
}

// Ejecuta una accion de carrito ya validada por el servidor (ver
// lib/padel-advisor-tools.js: agregar_al_carrito/quitar_del_carrito/
// modificar_cantidad_carrito) contra la UNICA fuente de verdad del carrito.
// Este widget nunca decide por si mismo si una accion es valida: solo la
// ejecuta contra window.PadelCart, que vuelve a validar todo contra el
// catalogo real antes de aplicarla.
function applyAccionCarrito(accion) {
  if (!accion || !accion.tipo || !window.PadelCart) return;
  if (accion.tipo === 'agregar_al_carrito') {
    window.PadelCart.addItem(accion.productId, accion.talle, accion.cantidad);
  } else if (accion.tipo === 'quitar_del_carrito') {
    window.PadelCart.removeItem(accion.productId, accion.talle);
  } else if (accion.tipo === 'modificar_cantidad_carrito' && typeof window.PadelCart.setQuantity === 'function') {
    window.PadelCart.setQuantity(accion.productId, accion.talle, accion.cantidad);
  }
}

function escapeHtml(value) {
return String(value == null ? '' : value)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');
}

function normalizeText(value) {
return String(value || '')
.toLowerCase()
.normalize('NFD')
.replace(/[\u0300-\u036f]/g, '');
}

function resolveCardImageUrl(rawPath) {
if (typeof rawPath !== 'string') return null;
var trimmed = rawPath.trim();
if (!trimmed) return null;
if (/^(javascript|data|vbscript|file):/i.test(trimmed)) return null;
try {
var resolved = new URL(trimmed, document.baseURI).href;
var parsed = new URL(resolved);
if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
return resolved;
} catch (err) {
return null;
}
}

function buildWhatsappUrl(message) {
return 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(message);
}

root.innerHTML =
'<button type="button" class="pa-launcher" id="paLauncher" aria-haspopup="dialog" aria-expanded="false">' +
'<span class="pa-launcher-icon" aria-hidden="true">&#127934;</span>' +
'<span class="pa-launcher-text">Asesor de Palas</span>' +
'</button>' +
'<section class="pa-panel" id="paPanel" role="dialog" aria-modal="false" aria-label="Asesor de Palas con IA de Padel10Store" hidden>' +
'<header class="pa-header">' +
'<div class="pa-header-title">Asesor de Palas<span class="pa-header-sub">Padel10Store</span></div>' +
'<button type="button" class="pa-close" id="paClose" aria-label="Cerrar asesor">&#10005;</button>' +
'</header>' +
'<div class="pa-messages" id="paMessages" aria-live="polite"></div>' +
'<div class="pa-typing" id="paTyping" hidden aria-hidden="true"><span></span><span></span><span></span></div>' +
'<div class="pa-fallback" id="paFallback" hidden>' +
'<p id="paFallbackText">El asesor no esta disponible en este momento.</p>' +
'<a id="paFallbackWhatsapp" href="#" target="_blank" rel="noopener">Consultar por WhatsApp</a>' +
'</div>' +
'<form class="pa-input-row" id="paForm">' +
'<input id="paInput" type="text" maxlength="700" placeholder="Escribi tu consulta..." aria-label="Mensaje para el asesor" autocomplete="off" />' +
'<button type="submit" id="paSend" aria-label="Enviar mensaje">&#10148;</button>' +
'</form>' +
'</section>';

var launcher = document.getElementById('paLauncher');
var panel = document.getElementById('paPanel');
var closeBtn = document.getElementById('paClose');
var messagesEl = document.getElementById('paMessages');
var typingEl = document.getElementById('paTyping');
var fallbackEl = document.getElementById('paFallback');
var fallbackTextEl = document.getElementById('paFallbackText');
var fallbackWhatsappEl = document.getElementById('paFallbackWhatsapp');
var formEl = document.getElementById('paForm');
var inputEl = document.getElementById('paInput');
var sendBtn = document.getElementById('paSend');

fallbackWhatsappEl.href = buildWhatsappUrl('Hola! Quiero recibir asesoramiento para elegir una pala de padel.');

var POSITION_STORAGE_KEY = 'padelAdvisorPosition';
var DEFAULT_SIDE = 'left';
var DEFAULT_BOTTOM = 20;
var DRAG_THRESHOLD = 6;
var currentPosition = { side: DEFAULT_SIDE, bottom: DEFAULT_BOTTOM };
var dragState = null;
var didDrag = false;

function getInset() {
return window.innerWidth <= 480 ? 12 : 20;
}

function loadPosition() {
try {
var raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
if (!raw) return { side: DEFAULT_SIDE, bottom: DEFAULT_BOTTOM };
var parsed = JSON.parse(raw);
if (!parsed || (parsed.side !== 'left' && parsed.side !== 'right') || typeof parsed.bottom !== 'number' || !isFinite(parsed.bottom)) {
return { side: DEFAULT_SIDE, bottom: DEFAULT_BOTTOM };
}
return { side: parsed.side, bottom: parsed.bottom };
} catch (err) {
return { side: DEFAULT_SIDE, bottom: DEFAULT_BOTTOM };
}
}

function savePosition(pos) {
try {
window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(pos));
} catch (err) {
/* localStorage no disponible: se ignora, se mantiene la posicion en memoria */
}
}

function clampBottom(bottom) {
var height = launcher.offsetHeight || 48;
var max = Math.max(12, window.innerHeight - height - 12);
if (bottom < 12) return 12;
if (bottom > max) return max;
return bottom;
}

function positionPanel() {
var inset = getInset();
var launcherHeight = launcher.offsetHeight || 48;
panel.style.top = 'auto';
panel.style.bottom = (currentPosition.bottom + launcherHeight + 10) + 'px';
if (window.innerWidth <= 480) {
panel.style.left = '8px';
panel.style.right = '8px';
} else if (currentPosition.side === 'right') {
panel.style.right = inset + 'px';
panel.style.left = 'auto';
} else {
panel.style.left = inset + 'px';
panel.style.right = 'auto';
}
}

function applyPosition(pos) {
var inset = getInset();
currentPosition = { side: pos.side === 'right' ? 'right' : 'left', bottom: clampBottom(pos.bottom) };
launcher.style.top = 'auto';
launcher.style.bottom = currentPosition.bottom + 'px';
if (currentPosition.side === 'right') {
launcher.style.right = inset + 'px';
launcher.style.left = 'auto';
} else {
launcher.style.left = inset + 'px';
launcher.style.right = 'auto';
}
positionPanel();
}

function persistCurrentPosition() {
savePosition({ side: currentPosition.side, bottom: currentPosition.bottom });
}

function minimizePanel() {
if (panel.hidden) return;
panel.hidden = true;
launcher.setAttribute('aria-expanded', 'false');
}

function onLauncherPointerDown(e) {
if (e.button !== undefined && e.button !== 0) return;
var rect = launcher.getBoundingClientRect();
dragState = { startX: e.clientX, startY: e.clientY, originLeft: rect.left, originTop: rect.top, pointerId: e.pointerId };
didDrag = false;
try { launcher.setPointerCapture(e.pointerId); } catch (err) {}
}

function onLauncherPointerMove(e) {
if (!dragState || dragState.pointerId !== e.pointerId) return;
var dx = e.clientX - dragState.startX;
var dy = e.clientY - dragState.startY;
if (!didDrag && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
didDrag = true;
launcher.classList.add('pa-dragging');
var width = launcher.offsetWidth;
var height = launcher.offsetHeight;
var left = dragState.originLeft + dx;
var top = dragState.originTop + dy;
left = Math.min(Math.max(left, 4), window.innerWidth - width - 4);
top = Math.min(Math.max(top, 4), window.innerHeight - height - 4);
launcher.style.left = left + 'px';
launcher.style.top = top + 'px';
launcher.style.right = 'auto';
launcher.style.bottom = 'auto';
}

function onLauncherPointerUp(e) {
if (!dragState || dragState.pointerId !== e.pointerId) return;
try { launcher.releasePointerCapture(e.pointerId); } catch (err) {}
if (didDrag) {
var rect = launcher.getBoundingClientRect();
var centerX = rect.left + rect.width / 2;
var side = centerX < window.innerWidth / 2 ? 'left' : 'right';
var bottom = window.innerHeight - rect.bottom;
launcher.classList.remove('pa-dragging');
applyPosition({ side: side, bottom: bottom });
persistCurrentPosition();
}
dragState = null;
}

launcher.addEventListener('pointerdown', onLauncherPointerDown);
launcher.addEventListener('pointermove', onLauncherPointerMove);
launcher.addEventListener('pointerup', onLauncherPointerUp);
launcher.addEventListener('pointercancel', onLauncherPointerUp);

window.addEventListener('resize', function () {
applyPosition(currentPosition);
});

applyPosition(loadPosition());

var bodyOverflowObserver = new MutationObserver(function () {
if (document.body.style.overflow === 'hidden' && !panel.hidden) {
minimizePanel();
}
});
bodyOverflowObserver.observe(document.body, { attributes: true, attributeFilter: ['style'] });

function scrollToBottom() {
messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addBubble(role, text) {
var div = document.createElement('div');
div.className = 'pa-msg pa-msg-' + role;
div.textContent = text;
messagesEl.appendChild(div);
scrollToBottom();
}

function findStoreCard(nombre) {
var target = normalizeText(nombre);
if (!target) return null;
var names = document.querySelectorAll('.card-name');
for (var i = 0; i < names.length; i++) {
if (normalizeText(names[i].textContent) === target) {
return names[i].closest ? names[i].closest('.card') : null;
}
}
return null;
}

function renderCard(card) {
if (!card || !card.id || shownProductIds[card.id]) return;
shownProductIds[card.id] = true;

var wrap = document.createElement('div');
wrap.className = 'pa-card';

var safeImgUrl = resolveCardImageUrl(card.imagen);
var imgHtml = safeImgUrl
? '<img class="pa-card-photo" src="' + escapeHtml(safeImgUrl) + '" alt="' + escapeHtml(card.nombre) + '" loading="lazy" />'
: '';

var priceHtml = '';
if (card.precioConsultar || card.precio == null) {
priceHtml = '<div class="pa-card-price">Precio a consultar</div>';
} else {
priceHtml = '<div class="pa-card-price">' + escapeHtml(card.precioFormateado) + '</div>';
if (card.precioTransferenciaFormateado) {
priceHtml += '<div class="pa-card-transfer">Transferencia: ' + escapeHtml(card.precioTransferenciaFormateado) + '</div>';
}
}

var featuresHtml = '';
if (card.caracteristicasConfirmadas && card.caracteristicasConfirmadas.length) {
featuresHtml = '<ul class="pa-card-features">' +
card.caracteristicasConfirmadas.slice(0, 4).map(function (f) {
return '<li>' + escapeHtml(f.label) + ': ' + escapeHtml(f.value) + '</li>';
}).join('') +
'</ul>';
}

var waLink = card.whatsapp && card.whatsapp.link ? card.whatsapp.link : buildWhatsappUrl('Hola! Quiero consultar por ' + card.nombre + '.');

var buyNowHtml = '';
if (card.id === MP_PURCHASABLE_PRODUCT_ID) {
buyNowHtml = '<button type="button" class="pa-card-btn pa-card-btn-buy" data-mp-buy-button data-product-id="' + escapeHtml(card.id) + '">Comprar ahora</button>';
}

var tieneTalles = Array.isArray(card.talles) && card.talles.length > 0;
var accionTexto = tieneTalles ? 'Elegir talle' : 'Ver producto';

wrap.innerHTML =
'<div class="pa-card-img">' + imgHtml + '</div>' +
'<div class="pa-card-body">' +
'<div class="pa-card-brand">' + escapeHtml(card.marca) + '</div>' +
'<div class="pa-card-name">' + escapeHtml(card.nombre) + '</div>' +
priceHtml +
featuresHtml +
'<div class="pa-card-actions">' +
'<button type="button" class="pa-card-btn pa-card-btn-primary" data-action="ver">' + escapeHtml(accionTexto) + '</button>' +
'<a class="pa-card-btn pa-card-btn-secondary" href="' + escapeHtml(waLink) + '" target="_blank" rel="noopener">Consultar por WhatsApp</a>' +
buyNowHtml +
'</div>' +
'</div>';

var imgEl = wrap.querySelector('.pa-card-photo');
if (imgEl) {
imgEl.addEventListener('error', function () {
imgEl.remove();
var imgBox = wrap.querySelector('.pa-card-img');
if (imgBox) imgBox.classList.add('pa-card-img-empty');
});
}

function openProductModal() {
var storeCard = findStoreCard(card.nombre);
if (storeCard && typeof window.openModal === 'function') {
window.openModal(storeCard);
} else {
window.open(waLink, '_blank');
}
}

wrap.classList.add('pa-card-clickable');
wrap.addEventListener('click', function (e) {
if (e.target.closest('[data-mp-buy-button]')) return;
if (e.target.closest('.pa-card-btn-secondary')) return;
openProductModal();
});

messagesEl.appendChild(wrap);
if (window.PadelMPBuy && typeof window.PadelMPBuy.init === 'function') {
window.PadelMPBuy.init(wrap);
}
scrollToBottom();
}

// --- Fase 2 - Etapa 3: comparador visual PRO ---
//
// Renderiza "comparison" (lib/padel-catalog.js#buildComparisonCard, Etapa 2)
// como una tarjeta de comparacion real: nunca inventa productos, precios,
// imagenes ni atributos, solo pinta lo que el servidor ya armo y valido
// contra el catalogo. No toca renderCard ni su logica (es un componente
// nuevo e independiente): reutiliza las mismas integraciones ya probadas
// que usa renderCard para "Ver producto" (findStoreCard + window.openModal)
// y la unica fuente de verdad del carrito (window.PadelCart) para "Agregar
// al carrito", sin reimplementar ninguna de las dos.

// Abre la ficha real del producto en la tienda (el mismo modal que ya usa
// renderCard), o cae al link de WhatsApp si la tarjeta no se encuentra en el
// DOM de la tienda. findStoreCard ya es una funcion compartida: no se
// duplica su logica de busqueda.
function openStoreProductModal(nombre, waLink) {
var storeCard = findStoreCard(nombre);
if (storeCard && typeof window.openModal === 'function') {
window.openModal(storeCard);
} else {
window.open(waLink, '_blank');
}
}

// Boton "Agregar al carrito" del comparador: llama SIEMPRE a
// window.PadelCart.addItem, la unica fuente de verdad del carrito (igual
// que applyAccionCarrito mas arriba). Nunca decide por si mismo si un talle
// es necesario ni inventa uno: si PadelCart devuelve talle_requerido (el
// mismo error que ya usa el flujo de la ficha de producto, ver
// lib/padel-cart.js#buildLine), no agrega nada y abre esa misma ficha para
// que el cliente elija un talle real, en vez de duplicar la logica de
// seleccion de talle que ya existe en index.html.
function handleComparisonAgregar(button, productId, nombre, waLink) {
if (!window.PadelCart || typeof window.PadelCart.addItem !== 'function') return;
var res = window.PadelCart.addItem(productId, null, 1);
if (res && res.ok) {
var originalText = button.textContent;
button.textContent = 'Agregado!';
button.classList.add('pa-cmp-added');
button.disabled = true;
setTimeout(function () {
button.textContent = originalText;
button.classList.remove('pa-cmp-added');
button.disabled = false;
}, 2500);
return;
}
if (res && res.error === 'talle_requerido') {
openStoreProductModal(nombre, waLink);
}
}

function renderComparison(comparison) {
if (!comparison || !Array.isArray(comparison.productos) || comparison.productos.length < 2) return;

var productos = comparison.productos;
var filas = Array.isArray(comparison.filas) ? comparison.filas : [];
var count = productos.length;

var wrap = document.createElement('div');
wrap.className = 'pa-cmp';

var headerHtml = productos.map(function (p) {
var safeImgUrl = resolveCardImageUrl(p.imagen);
var imgHtml = safeImgUrl
? '<img class="pa-cmp-photo" src="' + escapeHtml(safeImgUrl) + '" alt="' + escapeHtml(p.nombre) + '" loading="lazy" />'
: '';
var priceHtml = (p.precioConsultar || p.precio == null)
? '<div class="pa-cmp-price">Precio a consultar</div>'
: '<div class="pa-cmp-price">' + escapeHtml(p.precioFormateado) + '</div>';
var waLink = buildWhatsappUrl('Hola! Quiero consultar por ' + p.nombre + '.');
return (
'<div class="pa-cmp-product" data-product-id="' + escapeHtml(p.id) + '">' +
'<div class="pa-cmp-img">' + imgHtml + '</div>' +
'<div class="pa-cmp-brand">' + escapeHtml(p.marca) + '</div>' +
'<div class="pa-cmp-name">' + escapeHtml(p.nombre) + '</div>' +
priceHtml +
'<div class="pa-cmp-actions">' +
'<button type="button" class="pa-card-btn pa-card-btn-primary" data-cmp-action="ver" data-product-id="' + escapeHtml(p.id) + '" data-nombre="' + escapeHtml(p.nombre) + '" data-wa="' + escapeHtml(waLink) + '">Ver producto</button>' +
'<button type="button" class="pa-card-btn pa-card-btn-secondary pa-cmp-add-btn" data-cmp-action="agregar" data-product-id="' + escapeHtml(p.id) + '" data-nombre="' + escapeHtml(p.nombre) + '" data-wa="' + escapeHtml(waLink) + '">Agregar al carrito</button>' +
'</div>' +
'</div>'
);
}).join('');

var rowsHtml = filas.map(function (fila) {
var valores = Array.isArray(fila.valores) ? fila.valores : [];
var valuesHtml = valores.map(function (v) {
var esConfirmado = v !== 'No confirmado';
return '<div class="pa-cmp-value' + (esConfirmado ? '' : ' pa-cmp-value-unconfirmed') + '">' + escapeHtml(v) + '</div>';
}).join('');
return (
'<div class="pa-cmp-row">' +
'<div class="pa-cmp-row-label">' + escapeHtml(fila.label) + '</div>' +
'<div class="pa-cmp-row-values" style="grid-template-columns: repeat(' + count + ', 1fr);">' + valuesHtml + '</div>' +
'</div>'
);
}).join('');

wrap.innerHTML =
'<div class="pa-cmp-header" style="grid-template-columns: repeat(' + count + ', 1fr);">' + headerHtml + '</div>' +
'<div class="pa-cmp-rows">' + rowsHtml + '</div>';

var imgEls = wrap.querySelectorAll('.pa-cmp-photo');
Array.prototype.forEach.call(imgEls, function (imgEl) {
imgEl.addEventListener('error', function () {
imgEl.remove();
var imgBox = imgEl.closest('.pa-cmp-img');
if (imgBox) imgBox.classList.add('pa-cmp-img-empty');
});
});

wrap.addEventListener('click', function (e) {
var btn = e.target.closest ? e.target.closest('button[data-cmp-action]') : null;
if (!btn) return;
var productId = btn.dataset.productId;
var nombre = btn.dataset.nombre;
var waLink = btn.dataset.wa;
if (btn.dataset.cmpAction === 'ver') {
openStoreProductModal(nombre, waLink);
} else if (btn.dataset.cmpAction === 'agregar') {
handleComparisonAgregar(btn, productId, nombre, waLink);
}
});

messagesEl.appendChild(wrap);
scrollToBottom();
}

function setSending(isSending) {
sending = isSending;
sendBtn.disabled = isSending;
inputEl.disabled = isSending;
typingEl.hidden = !isSending;
if (isSending) scrollToBottom();
}

function showFallback(message) {
fallbackTextEl.textContent = message || 'El asesor no esta disponible en este momento.';
fallbackEl.hidden = false;
}

function pushHistory(role, content) {
history.push({ role: role, content: content });
if (history.length > MAX_HISTORY_MESSAGES) {
history = history.slice(history.length - MAX_HISTORY_MESSAGES);
}
}

function handleErrorResponse(status, body) {
var message = (body && body.message) || 'Ocurrio un error inesperado. Proba de nuevo o consultanos por WhatsApp.';
addBubble('system', message);
if (status === 429 || status === 503 || status === 502 || status === 500) {
showFallback(message);
}
}

function sendMessage(text) {
if (sending) return;
var trimmed = (text || '').trim();
if (!trimmed) return;
if (trimmed.length > MAX_MESSAGE_LENGTH) {
addBubble('system', 'Tu mensaje es muy largo. Escribilo en menos de 700 caracteres.');
return;
}

addBubble('user', trimmed);
var historyForRequest = history.slice();
pushHistory('user', trimmed);
inputEl.value = '';
setSending(true);

fetch(API_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ message: trimmed, history: historyForRequest, ofrecidos: lastOfrecidos, carritoActual: getCarritoActual(), perfilCompra: lastPerfilCompra }),
})
.then(function (response) {
return response
.json()
.catch(function () { return {}; })
.then(function (body) {
return { status: response.status, ok: response.ok, body: body };
});
})
.then(function (result) {
setSending(false);
if (!result.ok) {
handleErrorResponse(result.status, result.body);
return;
}
var reply = result.body && result.body.reply ? result.body.reply : 'No pude generar una respuesta. Proba de nuevo.';
addBubble('assistant', reply);
pushHistory('assistant', reply);
var cards = (result.body && result.body.cards) || [];
cards.forEach(renderCard);
if (result.body && result.body.comparison) renderComparison(result.body.comparison);
if (result.body && Array.isArray(result.body.ofrecidos)) lastOfrecidos = result.body.ofrecidos;
if (result.body && result.body.perfilCompra && typeof result.body.perfilCompra === 'object') lastPerfilCompra = result.body.perfilCompra;
var acciones = (result.body && result.body.acciones) || [];
acciones.forEach(applyAccionCarrito);
})
.catch(function () {
setSending(false);
addBubble('system', 'No pudimos conectar con el asesor. Revisa tu conexion o consultanos por WhatsApp.');
showFallback('No pudimos conectar con el asesor.');
});
}

function openPanel() {
positionPanel();
panel.hidden = false;
launcher.setAttribute('aria-expanded', 'true');
if (!panelOpened) {
panelOpened = true;
addBubble('assistant', GREETING);
}
inputEl.focus();
}

function closePanel() {
panel.hidden = true;
launcher.setAttribute('aria-expanded', 'false');
launcher.focus();
}

function togglePanel() {
if (panel.hidden) {
openPanel();
} else {
closePanel();
}
}

launcher.addEventListener('click', function (e) {
if (didDrag) {
didDrag = false;
e.preventDefault();
return;
}
togglePanel();
});
closeBtn.addEventListener('click', closePanel);

document.addEventListener('keydown', function (e) {
if (e.key === 'Escape' && !panel.hidden) {
closePanel();
}
});

formEl.addEventListener('submit', function (e) {
e.preventDefault();
sendMessage(inputEl.value);
});
})();
