(function () {
'use strict';

/**
 * Boton "Comprar ahora" - Prueba controlada de Mercado Pago Checkout Pro
 * (SANDBOX) para Padel10Store.
 *
 * Este script NO conoce precios ni cantidades: unicamente envia un
 * productId al endpoint del servidor y, si la respuesta es valida,
 * redirige al comprador al entorno de pruebas (sandbox) de Mercado Pago.
 *
 * Reglas que este script respeta:
 * - Nunca envia price, quantity ni name: solo productId.
 * - Antes de redirigir, valida que la URL recibida sea https y pertenezca
 *   a un dominio oficial de sandbox de Mercado Pago. Si no cumple, se
 *   trata como error y se muestra unicamente el mensaje generico.
 * - Evita solicitudes duplicadas por doble clic (se desactiva el boton
 *   mientras hay una solicitud en curso).
 * - Nunca muestra JSON, codigos, stack traces ni URLs tecnicas: solo el
 *   mensaje generico definido en GENERIC_ERROR_MESSAGE.
 */

var ENDPOINT = '/api/create-payment-preference';
var PREPARING_TEXT = 'Preparando pago…';
var GENERIC_ERROR_MESSAGE = 'No pudimos iniciar el pago. Intentá nuevamente en unos minutos.';
var ALLOWED_SANDBOX_HOSTS = ['sandbox.mercadopago.com.ar', 'sandbox.mercadopago.com'];

function isValidSandboxUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  var parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return ALLOWED_SANDBOX_HOSTS.indexOf(parsed.hostname) !== -1;
}

function getErrorEl(button) {
  var next = button.nextElementSibling;
  if (next && next.classList && next.classList.contains('mp-buy-error')) {
    return next;
  }
  var span = document.createElement('div');
  span.className = 'mp-buy-error';
  span.setAttribute('role', 'alert');
  button.insertAdjacentElement('afterend', span);
  return span;
}

function clearError(button) {
  var next = button.nextElementSibling;
  if (next && next.classList && next.classList.contains('mp-buy-error')) {
    next.textContent = '';
  }
}

function showError(button, originalText) {
  var errEl = getErrorEl(button);
  errEl.textContent = GENERIC_ERROR_MESSAGE;
  button.textContent = originalText;
  button.disabled = false;
  button.dataset.mpBusy = '';
}

function handleBuyClick(button) {
  if (button.dataset.mpBusy === '1') return;
  var productId = button.dataset.productId;
  if (!productId) return;
  var talle = button.dataset.talle || '';

  var originalText = button.textContent;
  clearError(button);
  button.dataset.mpBusy = '1';
  button.disabled = true;
  button.textContent = PREPARING_TEXT;

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(talle ? { productId: productId, talle: talle } : { productId: productId }),
  })
    .then(function (response) {
      return response
        .json()
        .catch(function () { return {}; })
        .then(function (body) {
          return { ok: response.ok, body: body };
        });
    })
    .then(function (result) {
      var sandboxInitPoint = result.ok && result.body ? result.body.sandboxInitPoint : null;
      if (!result.ok || !isValidSandboxUrl(sandboxInitPoint)) {
        showError(button, originalText);
        return;
      }
      window.location.href = sandboxInitPoint;
    })
    .catch(function () {
      showError(button, originalText);
    });
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
