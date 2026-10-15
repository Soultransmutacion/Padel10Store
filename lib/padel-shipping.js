'use strict';

// Costo de envio del checkout, compartido entre el navegador
// (widget/padel-checkout.js, para mostrarlo ANTES de confirmar) y el
// servidor (api/pedidos.js, que es quien realmente lo suma al total del
// pedido y a la preferencia de Mercado Pago).
//
// Mismo patron que lib/padel-checkout-fields.js: sin dependencias de Node
// ni variables de entorno, para poder cargarse con require() y con
// <script src="lib/padel-shipping.js">.
//
// ---------------------------------------------------------------------
// DONDE SE CONFIGURA EL ENVIO
// ---------------------------------------------------------------------
// Todavia NO hay tarifas, zonas ni plazos de envio confirmados para
// Padel10Store. Mientras CONFIG_ENVIO.modo sea 'a_confirmar':
//   - el checkout muestra "Envío: a confirmar" y aclara que el total
//     todavia no incluye el envio;
//   - el pedido se registra SIN iniciar el pago (nunca se le cobra al
//     comprador un importe que no incluye el envio);
//   - el vendedor confirma costo de envio y disponibilidad y recien
//     despues se coordina el pago.
//
// Cuando haya tarifas confirmadas, cambiar a:
//   modo: 'tarifas',
//   tarifasPorProvincia: { 'Santa Fe': 0000, 'Buenos Aires': 0000, ... },
//   tarifaResto: 0000 | null,   // provincias que no esten en la tabla
//                               // (null = esas provincias quedan "a confirmar")
//   plazoTexto: 'texto confirmado' | null,
// Los nombres de provincia deben ser exactamente los de la lista del
// formulario (widget/padel-checkout.js#PROVINCIAS). Los importes son en
// pesos argentinos, sin centavos. No completar con valores estimados.
var CONFIG_ENVIO = {
  modo: 'a_confirmar',
  tarifasPorProvincia: {},
  tarifaResto: null,
  plazoTexto: null,
};

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(CONFIG_ENVIO);
  } else {
    root.PadelShipping = factory(CONFIG_ENVIO);
  }
})(typeof self !== 'undefined' ? self : this, function (configPorDefecto) {
  var ESTADO_CONFIRMADO = 'confirmado';
  var ESTADO_A_CONFIRMAR = 'a_confirmar';

  function esImporteValido(valor) {
    return typeof valor === 'number' && isFinite(valor) && valor >= 0 && Math.round(valor) === valor;
  }

  // Devuelve { estado: 'confirmado', costo, plazoTexto } cuando hay una
  // tarifa confirmada para esa provincia, o { estado: 'a_confirmar',
  // costo: null } en cualquier otro caso (modo desconocido, provincia sin
  // tarifa, importe mal cargado). Falla "cerrado": ante cualquier duda, el
  // envio queda a confirmar y el pago no se inicia.
  function cotizarEnvio(direccion, config) {
    var cfg = config || configPorDefecto;
    var aConfirmar = { estado: ESTADO_A_CONFIRMAR, costo: null, plazoTexto: null };
    if (!cfg || cfg.modo !== 'tarifas') return aConfirmar;
    var provincia = direccion && typeof direccion.provincia === 'string' ? direccion.provincia.trim() : '';
    if (!provincia) return aConfirmar;
    var tabla = cfg.tarifasPorProvincia || {};
    var costo = Object.prototype.hasOwnProperty.call(tabla, provincia) ? tabla[provincia] : cfg.tarifaResto;
    if (!esImporteValido(costo)) return aConfirmar;
    return {
      estado: ESTADO_CONFIRMADO,
      costo: costo,
      plazoTexto: typeof cfg.plazoTexto === 'string' && cfg.plazoTexto.trim() ? cfg.plazoTexto.trim() : null,
    };
  }

  function envioConfigurado(config) {
    var cfg = config || configPorDefecto;
    return Boolean(cfg) && cfg.modo === 'tarifas';
  }

  return {
    CONFIG_ENVIO: configPorDefecto,
    ESTADO_CONFIRMADO: ESTADO_CONFIRMADO,
    ESTADO_A_CONFIRMAR: ESTADO_A_CONFIRMAR,
    cotizarEnvio: cotizarEnvio,
    envioConfigurado: envioConfigurado,
  };
});
