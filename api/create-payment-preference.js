'use strict';

/**
 * POST /api/create-payment-preference — DESHABILITADO.
 *
 * Este endpoint fue una prueba de PRUEBA (SANDBOX) para Mercado Pago
 * Checkout Pro: solo funcionaba en despliegues Preview, y solo servia
 * para validar la integracion tecnica con Mercado Pago. Nunca creaba una
 * fila real en la tabla `pedidos` (no pasaba por lib/padel-orders-store.js)
 * y la preferencia que armaba no llevaba `external_reference` ni
 * `notification_url`: Mercado Pago no tenia forma de avisarnos el
 * resultado del pago para ESE flujo, ni de correlacionarlo con un pedido.
 *
 * El flujo real de compra (POST /api/pedidos + POST /api/pedidos-preferencia,
 * via lib/pedido-preferencia.js#crearOReutilizarPreferenciaParaPedido) ya
 * cubre exactamente ese caso: crea el pedido primero, y la preferencia que
 * arma SIEMPRE lleva external_reference (el id del pedido) y
 * notification_url (ver lib/mercadopago-preference.js#buildOrderPreferencePayload).
 * El boton "Comprar ahora" (widget/mercadopago-buy.js) ya no llama a este
 * endpoint: usa ese flujo real a traves de
 * window.PadelCheckoutWidget.startBuyNow (widget/padel-checkout.js).
 *
 * Este archivo NO se borra para no arriesgar romper una referencia externa
 * o un cache de cliente que todavia apunte a esta URL (por ejemplo, un
 * despliegue Preview ya servido a un navegador antes de este cambio): en
 * vez de eso, se deja sin ningun consumidor activo en el codigo y su
 * handler responde siempre con el mismo error generico, para cualquier
 * metodo, entorno o body, sin tocar el catalogo, Supabase ni Mercado Pago.
 */

const GENERIC_ERROR_MESSAGE =
    'No pudimos iniciar el pago. Intentá nuevamente en unos minutos.';

module.exports = async function handler(req, res) {
    // Deshabilitado a proposito: nunca ejecuta ninguna logica de negocio,
    // sin importar metodo, headers, body ni variables de entorno.
    return res.status(410).json({ error: GENERIC_ERROR_MESSAGE });
};

module.exports.GENERIC_ERROR_MESSAGE = GENERIC_ERROR_MESSAGE;
