/**
 * Orquesta la creacion (o reutilizacion idempotente) de una preferencia de
 * Mercado Pago para un PEDIDO YA CREADO en la base de datos.
 *
 * La usan dos endpoints:
 * - api/pedidos.js: intenta crear la preferencia en el mismo request en el
 *   que se crea el pedido.
 * - api/pedidos-preferencia.js: reintenta crear la preferencia si el
 *   intento anterior fallo, sin crear un pedido nuevo.
 *
 * Reglas que este modulo garantiza:
 * - Nunca cambia estado_pago ni estado_pedido: crear una preferencia no
 *   significa que se cobro nada.
 * - Nunca crea una preferencia nueva si el pedido ya tiene una
 *   (mp_preference_id): relee la existente en Mercado Pago para obtener
 *   su sandbox_init_point actualizado.
 * - Nunca devuelve un init_point de produccion: mientras
 *   MERCADOPAGO_ENV no sea exactamente 'sandbox', esta funcion se niega
 *   a devolver una URL de checkout (falla "cerrado", no "abierto").
 * - Los items, precios y moneda salen SIEMPRE del snapshot ya persistido
 *   (pedido + pedido_items), nunca de un valor que mande el llamador.
 */

const {
  crearPreferenciaEnMercadoPago,
  obtenerPreferenciaDeMercadoPago,
} = require('./mercadopago-client');
const {
  getMercadoPagoEnv,
  buildNotificationUrl,
  buildOrderPreferencePayload,
  getTrustedBaseUrl,
  buildBackUrls,
} = require('./mercadopago-preference');
const { asociarPreferenceId, registrarEvento } = require('./padel-orders-store');

// Estados de pedido/pago que todavia admiten intentar (o reintentar) el
// pago. Un pedido deja de admitir pago apenas: ya se aprobo el cobro
// (estado_pago = 'aprobado' - reintentar crearia un cobro duplicado);
// se cancelo o expiro (estado_pedido = 'cancelado'/'expirado'); o ya
// avanzo en el circuito de fulfillment (a_preparar/enviado/entregado -
// en ese punto el pago ya se resolvio de algun modo). 'rechazado' SI
// admite reintento: significa que un intento anterior de pago fue
// rechazado por Mercado Pago, y el comprador debe poder intentar de
// nuevo sin que se le cree un pedido nuevo.
const ESTADOS_PAGO_QUE_ADMITEN_PAGO = Object.freeze(['pendiente', 'rechazado']);
const ESTADOS_PEDIDO_QUE_ADMITEN_PAGO = Object.freeze(['pendiente_pago']);

function pedidoAdmitePago(pedido) {
  if (!pedido || typeof pedido !== 'object') return false;
  return (
    ESTADOS_PAGO_QUE_ADMITEN_PAGO.indexOf(pedido.estado_pago) !== -1 &&
    ESTADOS_PEDIDO_QUE_ADMITEN_PAGO.indexOf(pedido.estado_pedido) !== -1
  );
}

function elegirCheckoutUrl(mpEnv, resultado) {
  // En esta etapa NUNCA se habilita produccion, sin importar que diga
  // MERCADOPAGO_ENV: solo se devuelve sandbox_init_point.
  if (mpEnv !== 'sandbox') return null;
  return (resultado && resultado.sandboxInitPoint) || null;
}

async function registrarFalloSilencioso(pedidoId, evento, client) {
  try {
    await registrarEvento({ pedidoId, tipo: 'otro', metadata: { evento } }, client);
  } catch (err) {
    // No dejamos que un fallo al registrar el evento oculte el error real
    // ni interrumpa la respuesta al frontend.
  }
}

/**
 * pedido: fila real de la tabla pedidos (ya creada, con id/mp_preference_id).
 * items: filas reales de pedido_items (snapshot ya persistido).
 * client: cliente de Supabase inyectable para tests (ver padel-orders-store.js).
 *
 * Devuelve { ok: true, checkoutUrl } o { ok: false, motivo }. Nunca lanza
 * excepciones por errores de Mercado Pago o de configuracion: los
 * llamadores no necesitan try/catch para el camino feliz.
 */
async function crearOReutilizarPreferenciaParaPedido({ pedido, items, client }) {
  if (!pedido || !pedido.id) {
    return { ok: false, motivo: 'pedido_invalido' };
  }

  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken || typeof accessToken !== 'string') {
    return { ok: false, motivo: 'sin_credencial' };
  }

  const mpEnv = getMercadoPagoEnv();
  if (mpEnv !== 'sandbox') {
    // Produccion no se habilita en esta etapa, ni por accidente.
    return { ok: false, motivo: 'entorno_no_habilitado' };
  }

  // Idempotencia: si el pedido ya tiene una preferencia, no creamos otra:
  // releemos la existente en Mercado Pago para obtener su sandbox_init_point.
  if (pedido.mp_preference_id) {
    const existente = await obtenerPreferenciaDeMercadoPago({
      preferenceId: pedido.mp_preference_id,
      accessToken,
    });
    if (existente.ok) {
      const checkoutUrl = elegirCheckoutUrl(mpEnv, existente);
      if (checkoutUrl) {
        return { ok: true, checkoutUrl };
      }
    }
    // Si no se pudo releer, seguimos abajo e intentamos crear una
    // preferencia nueva (Mercado Pago no permite "editar" una existente).
  }

  const trustedBaseUrl = getTrustedBaseUrl();
  if (!trustedBaseUrl) {
    return { ok: false, motivo: 'sin_base_url_confiable' };
  }
  const backUrls = buildBackUrls(trustedBaseUrl);
  const notificationUrl = buildNotificationUrl(trustedBaseUrl);

  const payload = buildOrderPreferencePayload({ pedido, items, backUrls, notificationUrl });
  const resultado = await crearPreferenciaEnMercadoPago({ payload, accessToken });

  if (!resultado.ok || !resultado.preferenceId) {
    await registrarFalloSilencioso(pedido.id, 'preferencia_mp_fallida', client);
    return { ok: false, motivo: 'mercado_pago' };
  }

  await asociarPreferenceId(pedido.id, resultado.preferenceId, client);

  const checkoutUrl = elegirCheckoutUrl(mpEnv, resultado);
  if (!checkoutUrl) {
    return { ok: false, motivo: 'sin_sandbox_init_point' };
  }

  return { ok: true, checkoutUrl };
}

module.exports = {
  crearOReutilizarPreferenciaParaPedido,
  pedidoAdmitePago,
  ESTADOS_PAGO_QUE_ADMITEN_PAGO,
  ESTADOS_PEDIDO_QUE_ADMITEN_PAGO,
};
