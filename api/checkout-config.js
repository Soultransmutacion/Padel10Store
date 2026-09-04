'use strict';

/**
 * GET /api/checkout-config
 *
 * Endpoint PUBLICO y SIN secretos: informa al frontend si el checkout
 * real (crear pedidos y preferencias de Mercado Pago) esta habilitado en
 * este momento. Nunca expone nada mas alla de ese unico booleano -ni
 * variables de entorno, ni configuracion interna, ni ningun detalle
 * tecnico-.
 *
 * La decision sale exclusivamente de lib/checkout-config.js#esCheckoutHabilitado,
 * la MISMA funcion que usan api/pedidos.js y api/pedidos-preferencia.js
 * para decidir si efectivamente pueden crear un pedido o una preferencia:
 * este endpoint nunca puede quedar desincronizado de la proteccion real,
 * porque no reimplementa la condicion, solo la expone.
 *
 * Cache-Control: no-store, para que ni el navegador ni ningun proxy
 * intermedio devuelva una respuesta vieja despues de que se cambie
 * CHECKOUT_ENABLED en Vercel: cada carga del frontend debe reflejar el
 * estado real y actual.
 */

const { esCheckoutHabilitado } = require('../lib/checkout-config');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    // Fail closed tambien ante un metodo inesperado: nunca se asume
    // habilitado por default.
    return res.status(405).json({ enabled: false });
  }

  return res.status(200).json({ enabled: esCheckoutHabilitado() });
};
