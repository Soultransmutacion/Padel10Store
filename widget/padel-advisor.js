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

var imgHtml = card.imagen
? '<img src="' + escapeHtml(card.imagen) + '" alt="' + escapeHtml(card.nombre) + '" loading="lazy" />'
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

wrap.innerHTML =
'<div class="pa-card-img">' + imgHtml + '</div>' +
'<div class="pa-card-body">' +
'<div class="pa-card-brand">' + escapeHtml(card.marca) + '</div>' +
'<div class="pa-card-name">' + escapeHtml(card.nombre) + '</div>' +
priceHtml +
featuresHtml +
'<div class="pa-card-actions">' +
'<button type="button" class="pa-card-btn pa-card-btn-primary" data-action="ver">Ver producto</button>' +
'<a class="pa-card-btn pa-card-btn-secondary" href="' + escapeHtml(waLink) + '" target="_blank" rel="noopener">Consultar por WhatsApp</a>' +
buyNowHtml +
'</div>' +
'</div>';

var verBtn = wrap.querySelector('[data-action="ver"]');
verBtn.addEventListener('click', function () {
var storeCard = findStoreCard(card.nombre);
if (storeCard && typeof window.openModal === 'function') {
window.openModal(storeCard);
} else {
window.open(waLink, '_blank');
}
});

messagesEl.appendChild(wrap);
if (window.PadelMPBuy && typeof window.PadelMPBuy.init === 'function') {
window.PadelMPBuy.init(wrap);
}
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
body: JSON.stringify({ message: trimmed, history: historyForRequest }),
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
})
.catch(function () {
setSending(false);
addBubble('system', 'No pudimos conectar con el asesor. Revisa tu conexion o consultanos por WhatsApp.');
showFallback('No pudimos conectar con el asesor.');
});
}

function openPanel() {
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

launcher.addEventListener('click', togglePanel);
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
