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
 *
 * Interruptor de seguridad del checkout (widget/checkout-availability.js):
 * antes de disparar startBuyNow, siempre se consulta
 * window.PadelCheckoutAvailability.isEnabled(). Mientras el checkout este
 * deshabilitado (o su consulta a /api/checkout-config todavia no
 * resolvio: arranca en false, fail closed), este boton NUNCA inicia un
 * pedido: si el click vino de la tarjeta del catalogo, abre la ficha del
 * producto (que ya muestra el mensaje comercial y el boton "Consultar por
 * WhatsApp", ver index.html#actualizarBotonComprarAhora) en vez de
 * comprar. Si el click viniera del boton de la propia ficha, ese boton ya
 * deberia estar oculto en este estado -este chequeo es una segunda capa
 * de defensa, nunca la unica-.
 */

function checkoutEstaHabilitado() {
  return window.PadelCheckoutAvailability ? window.PadelCheckoutAvailability.isEnabled() : false;
}

function handleBuyClick(button) {
  var productId = button.dataset.productId;
  if (!productId) return;

  if (!checkoutEstaHabilitado()) {
    var card = button.closest ? button.closest('.card') : null;
    if (card && typeof window.openModal === 'function') {
      window.openModal(card);
    }
    return;
  }

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
