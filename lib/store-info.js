'use strict';

// Datos del vendedor que se muestran en el pie de pagina y en las paginas
// legales (legal/*.html). UNICO lugar donde se cargan: cada elemento con
// data-store="<campo>" toma su valor de aca (ver aplicar() mas abajo).
//
// null = dato NO confirmado todavia. En ese caso la pagina muestra
// "Pendiente de completar" (bien visible, para que no se publique por
// error) y los enlaces que dependen de ese dato se ocultan. No completar
// con datos inventados o de ejemplo.
var STORE_INFO = {
  // Confirmado: es la marca que usa todo el sitio.
  nombreComercial: 'Padel10Store',
  // Pendientes: nombre legal (persona o empresa titular), CUIT, condicion
  // frente al IVA y domicilio legal/comercial.
  razonSocial: null,
  cuit: null,
  condicionIva: null,
  domicilio: null,
  // Pendiente: correo de contacto para consultas, reclamos y
  // arrepentimiento.
  email: null,
  // Confirmado: es el numero que ya usan todos los botones de WhatsApp.
  whatsappNumero: '5493413637355',
  whatsappVisible: '+54 9 341 363-7355',
  // Pendientes.
  instagramUrl: null,
  horarioAtencion: null,
};

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(STORE_INFO);
  } else {
    root.PadelStoreInfo = factory(STORE_INFO);
  }
})(typeof self !== 'undefined' ? self : this, function (info) {
  var PENDIENTE = 'Pendiente de completar';

  function valor(campo) {
    var v = info[campo];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  function whatsappUrl(texto) {
    return 'https://wa.me/' + info.whatsappNumero + (texto ? '?text=' + encodeURIComponent(texto) : '');
  }

  // Completa el DOM: data-store="campo" (texto), data-store-href="email|
  // instagram|whatsapp" (enlace; se oculta si falta el dato) y
  // data-store-requires="campo" (se oculta si falta el dato).
  function aplicar(doc) {
    if (!doc || !doc.querySelectorAll) return;
    Array.prototype.forEach.call(doc.querySelectorAll('[data-store]'), function (el) {
      var v = valor(el.getAttribute('data-store'));
      el.textContent = v || PENDIENTE;
      el.classList.toggle('store-pending', !v);
    });
    Array.prototype.forEach.call(doc.querySelectorAll('[data-store-href]'), function (el) {
      var tipo = el.getAttribute('data-store-href');
      var href = null;
      if (tipo === 'email' && valor('email')) href = 'mailto:' + valor('email');
      if (tipo === 'instagram' && valor('instagramUrl')) href = valor('instagramUrl');
      if (tipo === 'whatsapp') href = whatsappUrl(el.getAttribute('data-wa-text') || '');
      if (href) {
        el.setAttribute('href', href);
        el.hidden = false;
      } else {
        el.removeAttribute('href');
        el.hidden = true;
      }
    });
    Array.prototype.forEach.call(doc.querySelectorAll('[data-store-requires]'), function (el) {
      el.hidden = !valor(el.getAttribute('data-store-requires'));
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { aplicar(document); });
    } else {
      aplicar(document);
    }
  }

  return {
    INFO: info,
    PENDIENTE: PENDIENTE,
    valor: valor,
    whatsappUrl: whatsappUrl,
    aplicar: aplicar,
  };
});
