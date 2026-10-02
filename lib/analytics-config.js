'use strict';

// Identificadores de medicion publicitaria. Son publicos (aparecen en el
// codigo de cualquier sitio que los use), pero NO se deben inventar ni
// completar con valores de ejemplo: mientras sean null, ninguna etiqueta
// se carga y el sitio no envia datos a Google ni a Meta.
//
// ga4MeasurementId: "ID de medicion" de Google Analytics 4, formato
//   G-XXXXXXXXXX. Se obtiene en analytics.google.com -> Administrar ->
//   Flujos de datos -> (flujo web del sitio) -> ID de medicion.
// metaPixelId: ID del conjunto de datos / pixel de Meta, solo numeros.
//   Se obtiene en business.facebook.com -> Administrador de eventos ->
//   Origenes de datos -> (pixel) -> Configuracion -> ID.
//
// widget/padel-analytics.js valida el formato y, si no coincide, no carga
// la etiqueta correspondiente.
var PADEL_ANALYTICS_CONFIG = {
  ga4MeasurementId: null,
  metaPixelId: null,
};

if (typeof module === 'object' && module.exports) {
  module.exports = PADEL_ANALYTICS_CONFIG;
} else if (typeof self !== 'undefined') {
  self.PadelAnalyticsConfig = PADEL_ANALYTICS_CONFIG;
}
