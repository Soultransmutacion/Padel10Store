'use strict';

// Fase 3, Etapa 2: reglas de validacion del formulario de comprador y
// datos de envio, compartidas entre el navegador (widget/padel-checkout.js)
// y el servidor (api/pedidos.js).
//
// Mismo patron que lib/padel-cart.js: este archivo es intencionalmente
// independiente del entorno (sin `fs`, sin `require` de Node-only, sin
// variables de entorno de servidor) para poder cargarse tanto con
// `require('./padel-checkout-fields')` en Node como con
// `<script src="lib/padel-checkout-fields.js">` en el navegador. La
// validacion del navegador es solo para UX (mostrar el error antes de
// enviar nada): el servidor (api/pedidos.js) SIEMPRE vuelve a correr estas
// mismas funciones antes de crear un pedido, nunca confia en que el
// formulario ya valido del lado del cliente.
//
// Por que no vive esto en lib/padel-orders-store.js: ese archivo importa el
// SDK de Supabase (paquete "@supabase/supabase-js") y lee variables de
// entorno de servidor, asi que no se puede cargar en el navegador. Los limites
// numericos de aca (email, telefono, nombre completo) estan pensados para
// coincidir exactamente con los de padel-orders-store.js#LIMITES; un test
// cruzado (tests/padel-checkout-fields.test.js) falla si alguna vez
// divergen, para que nunca quede el formulario aceptando algo que el
// servidor despues rechaza silenciosamente distinto.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PadelCheckoutFields = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // Deben coincidir con lib/padel-orders-store.js#LIMITES (compradorEmail,
  // compradorTelefono, compradorNombre). Ver tests/padel-checkout-fields.test.js.
  var LIMITES = {
    nombre: 100,
    apellido: 100,
    compradorNombreCompletoMax: 200,
    email: 320,
    telefono: 50,
    provincia: 100,
    localidad: 100,
    codigoPostal: 12,
    calle: 200,
    numero: 20,
    pisoDepto: 50,
    aclaraciones: 300,
  };

  var EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  // Codigo postal argentino: formato clasico de 4 digitos (ej. "2000") o
  // CPA de 8 caracteres (ej. "C1425DJP"). Se acepta cualquiera de los dos,
  // sin exigir uno en particular.
  var CODIGO_POSTAL_REGEX = /^[0-9]{4}$|^[A-Za-z][0-9]{4}[A-Za-z]{3}$/;

  // Padel10Store solo envia dentro de Argentina por ahora: no hay campo
  // "pais" editable en el formulario, se fija siempre aca.
  var PAIS_FIJO = 'Argentina';

  // Claves que exige el esquema real (constraint chk_pedidos_envio_direccion_claves
  // en supabase/migrations/20260814120100_create_pedidos.sql). "localidad"
  // (como lo ve el comprador) se guarda en "ciudad" (como lo llama el
  // esquema).
  var DIRECCION_CLAVES_ESQUEMA = Object.freeze(['calle', 'ciudad', 'provincia', 'codigo_postal', 'pais']);

  function isPlainString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function campoTexto(value, max) {
    return isPlainString(value) && value.trim().length <= max;
  }

  function campoOpcional(value, max) {
    if (value === undefined || value === null || value === '') return { presente: false, ok: true };
    if (typeof value !== 'string' || value.length > max) return { presente: true, ok: false };
    return { presente: true, ok: true };
  }

  // Cada validador devuelve {ok:true} o {ok:false, campo, error}: "campo"
  // identifica que input del formulario mostrar en rojo, "error" es un
  // codigo estable (no un mensaje ya redactado) para que cliente y
  // servidor puedan decidir su propio texto sin acoplarse a un string.

  function validarComprador(comprador) {
    var c = comprador || {};
    if (!campoTexto(c.nombre, LIMITES.nombre)) {
      return { ok: false, campo: 'nombre', error: 'nombre_invalido' };
    }
    if (!campoTexto(c.apellido, LIMITES.apellido)) {
      return { ok: false, campo: 'apellido', error: 'apellido_invalido' };
    }
    var nombreCompleto = (c.nombre.trim() + ' ' + c.apellido.trim()).trim();
    if (nombreCompleto.length > LIMITES.compradorNombreCompletoMax) {
      return { ok: false, campo: 'apellido', error: 'nombre_completo_demasiado_largo' };
    }
    return { ok: true };
  }

  function validarContacto(contacto) {
    var c = contacto || {};
    if (
      !isPlainString(c.email) ||
      c.email.trim().length > LIMITES.email ||
      !EMAIL_REGEX.test(c.email.trim())
    ) {
      return { ok: false, campo: 'email', error: 'email_invalido' };
    }
    if (!campoTexto(c.telefono, LIMITES.telefono)) {
      return { ok: false, campo: 'telefono', error: 'telefono_invalido' };
    }
    return { ok: true };
  }

  function validarDireccion(direccion) {
    var d = direccion || {};
    if (!campoTexto(d.provincia, LIMITES.provincia)) {
      return { ok: false, campo: 'provincia', error: 'provincia_invalida' };
    }
    if (!campoTexto(d.localidad, LIMITES.localidad)) {
      return { ok: false, campo: 'localidad', error: 'localidad_invalida' };
    }
    if (
      !isPlainString(d.codigoPostal) ||
      d.codigoPostal.trim().length > LIMITES.codigoPostal ||
      !CODIGO_POSTAL_REGEX.test(d.codigoPostal.trim())
    ) {
      return { ok: false, campo: 'codigoPostal', error: 'codigo_postal_invalido' };
    }
    if (!campoTexto(d.calle, LIMITES.calle)) {
      return { ok: false, campo: 'calle', error: 'calle_invalida' };
    }
    if (!campoTexto(d.numero, LIMITES.numero)) {
      return { ok: false, campo: 'numero', error: 'numero_invalido' };
    }
    var pisoDepto = campoOpcional(d.pisoDepto, LIMITES.pisoDepto);
    if (!pisoDepto.ok) {
      return { ok: false, campo: 'pisoDepto', error: 'piso_depto_invalido' };
    }
    var aclaraciones = campoOpcional(d.aclaraciones, LIMITES.aclaraciones);
    if (!aclaraciones.ok) {
      return { ok: false, campo: 'aclaraciones', error: 'aclaraciones_invalidas' };
    }
    return { ok: true };
  }

  // Valida el formulario completo. Devuelve el primer error encontrado, en
  // el mismo orden en que se muestran los campos (comprador -> contacto ->
  // direccion), o {ok:true}.
  function validarFormularioCheckout(input) {
    var i = input || {};
    var rComprador = validarComprador(i.comprador);
    if (!rComprador.ok) return rComprador;
    var rContacto = validarContacto(i.contacto);
    if (!rContacto.ok) return rContacto;
    var rDireccion = validarDireccion(i.direccionEnvio);
    if (!rDireccion.ok) return rDireccion;
    return { ok: true };
  }

  // Arma el "comprador.nombre" combinado que espera lib/padel-orders-store.js
  // (una unica columna comprador_nombre, sin apellido separado en el
  // esquema de la Etapa 1). Unico lugar donde se decide como se concatenan
  // nombre y apellido: nunca se repite este criterio en otro archivo.
  function construirNombreCompleto(comprador) {
    var c = comprador || {};
    return (String(c.nombre || '').trim() + ' ' + String(c.apellido || '').trim()).trim();
  }

  // Arma el objeto envio_direccion tal cual lo exige el esquema real. "pais"
  // nunca se toma de `direccion`, aunque el llamador lo haya incluido por
  // error: siempre se fuerza a PAIS_FIJO, este es el unico lugar del
  // proyecto que decide el pais de un pedido.
  function construirDireccionParaPedido(direccion) {
    var d = direccion || {};
    var out = {
      calle: String(d.calle || '').trim(),
      numero: String(d.numero || '').trim(),
      ciudad: String(d.localidad || '').trim(),
      provincia: String(d.provincia || '').trim(),
      codigo_postal: String(d.codigoPostal || '').trim(),
      pais: PAIS_FIJO,
    };
    if (isPlainString(d.pisoDepto)) out.piso_depto = d.pisoDepto.trim();
    if (isPlainString(d.aclaraciones)) out.aclaraciones = d.aclaraciones.trim();
    return out;
  }

  return {
    LIMITES: LIMITES,
    EMAIL_REGEX: EMAIL_REGEX,
    CODIGO_POSTAL_REGEX: CODIGO_POSTAL_REGEX,
    PAIS_FIJO: PAIS_FIJO,
    DIRECCION_CLAVES_ESQUEMA: DIRECCION_CLAVES_ESQUEMA,

    validarComprador: validarComprador,
    validarContacto: validarContacto,
    validarDireccion: validarDireccion,
    validarFormularioCheckout: validarFormularioCheckout,

    construirNombreCompleto: construirNombreCompleto,
    construirDireccionParaPedido: construirDireccionParaPedido,
  };
});
