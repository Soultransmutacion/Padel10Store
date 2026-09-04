'use strict';

/**
 * Interruptor de seguridad (kill switch) del checkout real de Padel10Store.
 *
 * Una unica variable de entorno de servidor, CHECKOUT_ENABLED, decide si
 * se puede crear un pedido real o una preferencia real de Mercado Pago.
 * NUNCA afecta el catalogo, las fichas de producto ni el carrito: esas
 * partes de la tienda siguen publicas y funcionando siempre, con o sin
 * checkout habilitado (el carrito solo arma un resumen en memoria/
 * localStorage, no toca Supabase ni Mercado Pago).
 *
 * Fail closed por diseno: el checkout se considera habilitado UNICAMENTE
 * cuando CHECKOUT_ENABLED es, exactamente, el string 'true'. Cualquier
 * otro caso -ausente, vacio, 'false', 'TRUE' (mayusculas), '1', un typo,
 * o cualquier otro valor- lo deja deshabilitado. Nunca al reves: no existe
 * ningun "default habilitado" ni ninguna forma de que un valor inesperado
 * termine habilitando cobros reales por accidente.
 *
 * Usan esta funcion, y SOLO esta funcion (nunca leen CHECKOUT_ENABLED por
 * su cuenta), los dos lugares donde el servidor puede crear/modificar un
 * pedido real o una preferencia real de Mercado Pago:
 * - api/pedidos.js (POST /api/pedidos)
 * - api/pedidos-preferencia.js (POST /api/pedidos-preferencia)
 * Y tambien el endpoint publico de solo lectura que el frontend consulta
 * para decidir si mostrar el checkout: api/checkout-config.js
 * (GET /api/checkout-config). Los tres deben responder siempre lo mismo,
 * ante los mismos valores de la variable: por eso comparten esta unica
 * fuente de verdad en vez de reimplementar la condicion cada uno por su
 * lado.
 */

function esCheckoutHabilitado() {
  return process.env.CHECKOUT_ENABLED === 'true';
}

// Mensaje comercial, sin ningun detalle tecnico, que ve el comprador
// cuando el checkout esta deshabilitado (tanto si intenta forzar una
// llamada directa a la API como en el frontend, ver widget/padel-checkout.js
// y widget/mercadopago-buy.js). Deliberadamente el mismo texto en los dos
// lados para que el mensaje sea consistente sin importar por donde llegue
// el comprador.
const CHECKOUT_DISABLED_MESSAGE =
  'La compra online está temporalmente pausada. Consultanos por WhatsApp para confirmar precio y disponibilidad.';

// 503 (Service Unavailable): describe con precision la situacion real -el
// servicio de checkout esta deliberadamente apagado, de forma temporal,
// nunca un error del comprador ni un error tecnico inesperado- y es el
// codigo que un cliente HTTP bien comportado interpreta como "reintentar
// mas tarde", nunca como "esta URL no existe" (404) ni "tu pedido es
// invalido" (400/409).
const CHECKOUT_DISABLED_STATUS = 503;

module.exports = {
  esCheckoutHabilitado,
  CHECKOUT_DISABLED_MESSAGE,
  CHECKOUT_DISABLED_STATUS,
};
