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
 * - El entorno efectivo (sandbox o production) lo decide SIEMPRE
 *   resolverEntornoMercadoPago() (lib/mercadopago-preference.js), que
 *   cruza MERCADOPAGO_ENV con VERCEL_ENV: production solo queda
 *   habilitado cuando MERCADOPAGO_ENV='production' Y ademas
 *   VERCEL_ENV='production' (el deployment de Production real de
 *   Vercel). Cualquier otra combinacion (Preview, development, o
 *   VERCEL_ENV ausente/desconocido) nunca habilita production, sin
 *   importar que diga MERCADOPAGO_ENV (falla "cerrado", no "abierto").
 * - En sandbox, la URL de checkout sale UNICAMENTE de sandbox_init_point,
 *   validado contra hosts oficiales sandbox de Mercado Pago
 *   (isValidSandboxInitPoint). En production, sale UNICAMENTE de
 *   init_point, validado contra hosts oficiales de Mercado Pago
 *   Argentina (isValidProductionInitPoint). Nunca se usa el campo del
 *   entorno contrario, y nunca se confia en una URL cuyo host no matchee
 *   EXACTAMENTE el allow-list correspondiente.
 * - Los items, precios y moneda salen SIEMPRE del snapshot ya persistido
 *   (pedido + pedido_items), nunca de un valor que mande el llamador.
 */

const {
  crearPreferenciaEnMercadoPago,
  obtenerPreferenciaDeMercadoPago,
} = require('./mercadopago-client');
const {
  resolverEntornoMercadoPago,
  isValidSandboxInitPoint,
  isValidProductionInitPoint,
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

// resolucion: el resultado de resolverEntornoMercadoPago() para ESTE
// intento (nunca se vuelve a llamar aca: el llamador lo resuelve una
// unica vez por request, ver crearOReutilizarPreferenciaParaPedido).
// Nunca mezcla campos: en sandbox solo mira sandboxInitPoint, en
// production solo mira initPoint, y siempre valida el host contra el
// allow-list exacto del entorno correspondiente antes de confiar en el.
function elegirCheckoutUrl(resolucion, resultado) {
  if (!resolucion || !resolucion.habilitado) return null;
  if (resolucion.entorno === 'production') {
    const url = resultado && resultado.initPoint;
    return isValidProductionInitPoint(url) ? url : null;
  }
  const url = resultado && resultado.sandboxInitPoint;
  return isValidSandboxInitPoint(url) ? url : null;
}

// Nombre de motivo distinto por entorno (en vez de uno generico) para que
// un log o una respuesta de error siga siendo diagnosticable: deja claro
// si lo que faltaba era un sandbox_init_point valido o un init_point
// valido, sin exponer nunca la URL real ni el motivo tecnico de Mercado
// Pago.
function motivoSinInitPoint(entorno) {
  return entorno === 'production' ? 'sin_production_init_point' : 'sin_sandbox_init_point';
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

  // Resuelto UNA sola vez por request: cruza MERCADOPAGO_ENV con
  // VERCEL_ENV (ver resolverEntornoMercadoPago en
  // lib/mercadopago-preference.js). Si no queda habilitado (por ejemplo,
  // MERCADOPAGO_ENV=production en un deployment que no es el Production
  // real de Vercel), se falla cerrado: nunca se devuelve ninguna URL de
  // checkout, ni siquiera de sandbox.
  const resolucionEntorno = resolverEntornoMercadoPago();
  if (!resolucionEntorno.habilitado) {
    return { ok: false, motivo: 'entorno_no_habilitado' };
  }

  // Idempotencia: si el pedido ya tiene una preferencia, no creamos otra:
  // releemos la existente en Mercado Pago para obtener su
  // sandbox_init_point/init_point segun corresponda.
  if (pedido.mp_preference_id) {
    const existente = await obtenerPreferenciaDeMercadoPago({
      preferenceId: pedido.mp_preference_id,
      accessToken,
    });
    if (existente.ok) {
      const checkoutUrl = elegirCheckoutUrl(resolucionEntorno, existente);
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
  const backUrls = buildBackUrls(trustedBaseUrl, resolucionEntorno.entorno);
  const notificationUrl = buildNotificationUrl(trustedBaseUrl);

  const payload = buildOrderPreferencePayload({ pedido, items, backUrls, notificationUrl });
  const resultado = await crearPreferenciaEnMercadoPago({ payload, accessToken });

  if (!resultado.ok || !resultado.preferenceId) {
    await registrarFalloSilencioso(pedido.id, 'preferencia_mp_fallida', client);
    return { ok: false, motivo: 'mercado_pago' };
  }

  const pedidoActualizado = await asociarPreferenceId(pedido.id, resultado.preferenceId, client);

  if (pedidoActualizado.mp_preference_id !== resultado.preferenceId) {
    // Perdimos la carrera: otra llamada concurrente (por ejemplo, un
    // reintento del mismo checkout con la misma idempotencyKey) ya asocio
    // una preferencia distinta a este pedido antes que nosotros
    // (asociarPreferenceId resuelve esto atomicamente con un update
    // condicional, ver lib/padel-orders-store.js). La preferencia que
    // acabamos de crear en Mercado Pago queda huerfana en el lado de
    // Mercado Pago -nunca queda referenciada desde ningun pedido, no
    // representa ningun riesgo financiero ni de seguridad, solo una
    // llamada de API no aprovechada-: se descarta y se devuelve la URL de
    // la preferencia GANADORA en su lugar, para que el pedido termine
    // siempre con una unica preferencia efectivamente en uso.
    const ganadora = await obtenerPreferenciaDeMercadoPago({
      preferenceId: pedidoActualizado.mp_preference_id,
      accessToken,
    });
    if (ganadora.ok) {
      const checkoutUrlGanadora = elegirCheckoutUrl(resolucionEntorno, ganadora);
      if (checkoutUrlGanadora) {
        return { ok: true, checkoutUrl: checkoutUrlGanadora };
      }
    }
    return { ok: false, motivo: motivoSinInitPoint(resolucionEntorno.entorno) };
  }

  const checkoutUrl = elegirCheckoutUrl(resolucionEntorno, resultado);
  if (!checkoutUrl) {
    return { ok: false, motivo: motivoSinInitPoint(resolucionEntorno.entorno) };
  }

  return { ok: true, checkoutUrl };
}

module.exports = {
  crearOReutilizarPreferenciaParaPedido,
  pedidoAdmitePago,
  ESTADOS_PAGO_QUE_ADMITEN_PAGO,
  ESTADOS_PEDIDO_QUE_ADMITEN_PAGO,
};
