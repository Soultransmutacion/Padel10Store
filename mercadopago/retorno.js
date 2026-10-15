(function () {
  'use strict';

  // Paginas de retorno de Mercado Pago (success/pending/failure): muestra
  // el numero de pedido guardado por widget/padel-checkout.js antes de ir
  // a pagar, arma el boton de WhatsApp con ese numero y, solo en
  // success.html con el pago aprobado, avisa a la medicion
  // (widget/padel-analytics.js) que la compra se confirmo.
  //
  // Nada de esto confirma el pago por si mismo: la confirmacion real la
  // hace el webhook del servidor (api/mercadopago-webhook.js).

  var KEY = 'padel10store:pedidoEnPago';
  var pedido = null;
  try {
    var raw = window.sessionStorage.getItem(KEY);
    pedido = raw ? JSON.parse(raw) : null;
  } catch (e) {
    pedido = null;
  }
  var numero = pedido && /^P10-[0-9]{6,}$/.test(pedido.numero) ? pedido.numero : null;

  var params;
  try { params = new URLSearchParams(window.location.search); } catch (e) { params = null; }
  function param(k) { return params ? params.get(k) : null; }

  function aplicar() {
    var box = document.getElementById('pedidoNumeroBox');
    var el = document.getElementById('pedidoNumero');
    if (numero && box && el) {
      el.textContent = numero;
      box.hidden = false;
    }
    var wa = document.getElementById('retornoWhatsapp');
    if (wa) {
      var pagina = document.body.getAttribute('data-retorno') || '';
      var texto = 'Hola Padel10Store, ' +
        (pagina === 'failure' ? 'el pago de mi pedido no se completó' : 'quiero consultar por mi pedido') +
        (numero ? ' ' + numero : '') + '.';
      wa.href = 'https://wa.me/5493413637355?text=' + encodeURIComponent(texto);
    }

    var pagoAprobado = document.body.getAttribute('data-retorno') === 'success' &&
      (param('status') === 'approved' || param('collection_status') === 'approved');
    if (pagoAprobado) {
      var transactionId = numero || param('payment_id') || param('collection_id');
      if (transactionId) {
        try {
          document.dispatchEvent(new CustomEvent('padel10:evento', {
            detail: {
              tipo: 'compra_confirmada',
              datos: {
                transactionId: transactionId,
                total: pedido && typeof pedido.total === 'number' ? pedido.total : undefined,
                envio: pedido ? pedido.envio : 0,
                items: pedido && Array.isArray(pedido.items) ? pedido.items : [],
              },
            },
          }));
        } catch (e) {}
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', aplicar);
  } else {
    aplicar();
  }
})();
