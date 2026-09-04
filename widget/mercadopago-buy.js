(function () {
'use strict';

/**
 * Boton "Comprar ahora" (unico producto piloto: royal-padel-cross-black-26).
 *
 * Dispara el checkout REAL de Padel10Store (widget/padel-checkout.js:
 * POST /api/pedidos y, despues, POST /api/pedidos-preferencia) para UN
 * SOLO producto, sin pasar por el carrito persistente ni obligar a abrir
 * el drawer manualmente: window.PadelCheckoutWidget.startBuyNow abre el
 * drawer directo en el paso "Tus datos".
 *
 * Este archivo NO hace ninguna llamada de red por si mismo: solo resuelve
 * que boton se clickeo (productId + talle) y delega en
 * window.PadelCheckoutWidget.startBuyNow. Toda la logica de red, de
 * validacion y de manejo de errores (incluido evitar pedidos duplicados
 * ante un reintento) vive en widget/padel-checkout.js, la misma que ya
 * usa el flujo de carrito -no se duplica aca ninguna parte de ella.
 *
 * Historia: hasta esta etapa este boton llamaba a un endpoint de PRUEBA
 * (/api/create-payment-preference) que nunca creaba un pedido real: no
 * insertaba una fila en `pedidos` ni mandaba external_reference ni
 * notification_url a Mercado Pago. Ese endpoint quedo retirado de todo
 * consumidor (ver api/create-payment-preference.js para el detalle de por
 * que se deshabilito en lugar de borrarse).
 */

function handleBuyClick(button) {
  var productId = button.dataset.productId;
  if (!productId) return;
  var talle = button.dataset.talle || null;
  if (!window.PadelCheckoutWidget || typeof window.PadelCheckoutWidget.startBuyNow !== 'function') return;
  window.PadelCheckoutWidget.startBuyNow(productId, talle);
}

function initButton(button) {
  if (button.dataset.mpInit === '1') return;
  button.dataset.mpInit = '1';
  button.addEventListener('click', function () {
    handleBuyClick(button);
  });
}

function scanAndInit(root) {
  var scope = root || document;
  var buttons = scope.querySelectorAll ? scope.querySelectorAll('[data-mp-buy-button]') : [];
  Array.prototype.forEach.call(buttons, initButton);
}

document.addEventListener('DOMContentLoaded', function () {
  scanAndInit(document);
});

window.PadelMPBuy = { init: scanAndInit };
})();
