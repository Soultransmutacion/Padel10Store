'use strict';

/**
 * POST /api/pedidos
 *
 * Fase 3, Etapa 2: crea un pedido real (comprador + datos de envio +
 * carrito) usando la infraestructura ya migrada y verificada en la Etapa 1
 * (lib/padel-orders-store.js + la RPC padel_crear_pedido de Supabase).
 *
 * Esta etapa TODAVIA NO integra Mercado Pago: el pedido se crea con
 * estado_pago = 'pendiente' (el default del esquema) y sin ningun
 * mp_preference_id asociado. No se cobra nada en este endpoint.
 *
 * Reglas de seguridad (mismo criterio que api/create-payment-preference.js):
 * - Metodo estricto (solo POST), Content-Type estricto (application/json),
 *   limite de tamano de body.
 * - Allow-list estricta de campos en cada nivel del body: cualquier campo
 *   inesperado (por ejemplo comprador.documento, direccionEnvio.pais, o
 *   precio/nombre/subtotal/total dentro de un item) se rechaza ANTES de
 *   tocar el catalogo o la base de datos.
 * - El navegador solo puede mandar {productId, talle, cantidad} por linea
 *   de carrito. El precio, el nombre y el total SIEMPRE se recalculan del
 *   lado servidor contra el catalogo real, usando
 *   PadelCartCore.buildCartSummary (lib/padel-cart.js) -la misma funcion
 *   que ya usa el navegador para mostrar el carrito-, nunca un valor que
 *   haya mandado el cliente.
 * - Si UNA sola linea del carrito no se puede validar (producto inexistente,
 *   talle invalido, cantidad invalida, producto "a consultar"), no se crea
 *   nada: el pedido es atomico, o se crea completo o no se crea. Ademas, la
 *   RPC padel_crear_pedido corre en una unica transaccion de Postgres, asi
 *   que tampoco puede quedar un pedido a medias del lado de la base.
 * - "pais" nunca se acepta desde el cliente: Padel10Store solo envia dentro
 *   de Argentina por ahora (ver lib/padel-checkout-fields.js#PAIS_FIJO).
 * - La respuesta de exito nunca incluye el id interno (UUID) del pedido,
 *   solo el numero publico (`P10-000001`).
 * - Nunca se loguea el body de la request ni el resultado de Supabase.
 */

const {
  crearPedido: crearPedidoReal,
  obtenerItemsPorPedido: obtenerItemsPorPedidoReal,
  PedidoStoreError,
} = require('../lib/padel-orders-store');
const { getProductById } = require('../lib/padel-catalog');
const PadelCartCore = require('../lib/padel-cart');
const checkoutFields = require('../lib/padel-checkout-fields');
const {
  crearOReutilizarPreferenciaParaPedido,
} = require('../lib/pedido-preferencia');

const GENERIC_ERROR_MESSAGE = 'No pudimos registrar tu pedido. Intentá nuevamente en unos minutos.';
const MAX_BODY_LENGTH = 8000;
const MAX_ITEMS = 50;

const CAMPOS_RAIZ = ['comprador', 'contacto', 'direccionEnvio', 'items'];
const CAMPOS_COMPRADOR = ['nombre', 'apellido'];
const CAMPOS_CONTACTO = ['email', 'telefono'];
const CAMPOS_DIRECCION = ['provincia', 'localidad', 'codigoPostal', 'calle', 'numero', 'pisoDepto', 'aclaraciones'];
const CAMPOS_ITEM = ['productId', 'talle', 'cantidad'];

function sendGenericError(res, status) {
  res.status(status).json({ error: GENERIC_ERROR_MESSAGE });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Rechaza cualquier clave que no este explicitamente permitida. Nunca
// "sanea" quitando lo inesperado: si el cliente mando algo que no deberia,
// se rechaza la request entera (nunca se ignora en silencio un precio o un
// pais manipulados).
function tieneSoloClaves(obj, clavesPermitidas) {
  return Object.keys(obj).every((k) => clavesPermitidas.indexOf(k) !== -1);
}

function getBodyAsString(rawBody) {
  if (typeof rawBody === 'string') return rawBody;
  try {
    return JSON.stringify(rawBody || {});
  } catch (err) {
    return '';
  }
}

// Valida la FORMA del body (allow-list + tipos basicos), sin validar
// todavia el contenido de cada campo (eso lo hace
// checkoutFields.validarFormularioCheckout, que se comparte con el
// navegador). Devuelve {ok:true, body} o {ok:false}.
function validarFormaDelBody(parsedBody) {
  if (!isPlainObject(parsedBody)) return { ok: false };
  if (!tieneSoloClaves(parsedBody, CAMPOS_RAIZ)) return { ok: false };

  const { comprador, contacto, direccionEnvio, items } = parsedBody;

  if (!isPlainObject(comprador) || !tieneSoloClaves(comprador, CAMPOS_COMPRADOR)) return { ok: false };
  if (!isPlainObject(contacto) || !tieneSoloClaves(contacto, CAMPOS_CONTACTO)) return { ok: false };
  if (!isPlainObject(direccionEnvio) || !tieneSoloClaves(direccionEnvio, CAMPOS_DIRECCION)) return { ok: false };

  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) return { ok: false };
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!isPlainObject(item) || !tieneSoloClaves(item, CAMPOS_ITEM)) return { ok: false };
    if (typeof item.productId !== 'string' || !item.productId.trim()) return { ok: false };
    if (item.talle !== undefined && item.talle !== null && typeof item.talle !== 'string') return { ok: false };
    if (typeof item.cantidad !== 'number') return { ok: false };
  }

  return { ok: true, body: parsedBody };
}

// PadelCartCore.buildCartSummary usa sanitizeQuantity (un clamp TOLERANTE
// pensado para restaurar un carrito ya guardado en localStorage, ver el
// comentario de esa funcion en lib/padel-cart.js): una cantidad invalida
// ahi se CORRIGE en silencio en vez de descartar la linea. Este endpoint
// necesita lo contrario -rechazar la request entera si alguna cantidad no
// es valida, nunca corregirla en silencio-, asi que cada item se valida
// primero con la version estricta (validateQuantity, la misma que usa el
// carrito para agregar una linea nueva) antes de reconstruir el resumen.
function todasLasCantidadesSonValidas(items) {
  return items.every((it) => PadelCartCore.validateQuantity(it.cantidad).ok);
}

// Reconstruye el carrito del lado servidor contra el catalogo REAL: nunca
// confia en productId/talle/cantidad mas alla de resolverlos contra un
// producto real, y nunca usa ningun precio/nombre que haya mandado el
// cliente (no existen esos campos en el contrato, ver CAMPOS_ITEM arriba).
function reconstruirCarritoReal(items, getProduct) {
  const lineasCrudas = items.map((it) => ({
    productId: it.productId,
    talle: it.talle === undefined ? null : it.talle,
    cantidad: it.cantidad,
  }));
  return PadelCartCore.buildCartSummary(lineasCrudas, getProduct);
}

function mapPedidoStoreErrorToStatus(error) {
  if (!(error instanceof PedidoStoreError)) return 500;
  switch (error.code) {
    case 'VALIDACION':
      return 400;
    case 'CONFLICTO':
      return 409;
    case 'NO_ENCONTRADO':
      return 404;
    case 'CONFIGURACION':
    case 'DB_ERROR':
    default:
      return 500;
  }
}

/**
 * Factory: permite inyectar dependencias en los tests (un crearPedido/
 * getProductById de prueba, sin tocar Supabase ni el catalogo real desde
 * disco). El export por default de este archivo usa las dependencias
 * reales.
 */
function createPedidosHandler(deps) {
  const crearPedido = (deps && deps.crearPedido) || crearPedidoReal;
  const getProduct = (deps && deps.getProductById) || getProductById;
  const obtenerItemsPorPedido = (deps && deps.obtenerItemsPorPedido) || obtenerItemsPorPedidoReal;
  const crearPreferenciaParaPedido =
    (deps && deps.crearPreferenciaParaPedido) || crearOReutilizarPreferenciaParaPedido;

  return async function handler(req, res) {
    try {
      // 1) Solo POST.
      if (req.method !== 'POST') {
        return sendGenericError(res, 405);
      }

      // 2) Content-Type estricto.
      const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        return sendGenericError(res, 415);
      }

      // 3) Tamano de body acotado.
      const rawBody = req.body;
      const bodyString = getBodyAsString(rawBody);
      if (bodyString.length > MAX_BODY_LENGTH) {
        return sendGenericError(res, 413);
      }

      let parsedBody = rawBody;
      if (typeof rawBody === 'string') {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch (err) {
          return sendGenericError(res, 400);
        }
      }

      // 4) Forma del body: allow-list estricta en cada nivel. Cualquier
      // campo inesperado (documento, pais, precioUnitario, total, etc.) se
      // rechaza aca, antes de tocar el catalogo o crearPedido.
      const forma = validarFormaDelBody(parsedBody);
      if (!forma.ok) {
        return sendGenericError(res, 400);
      }
      const { comprador, contacto, direccionEnvio, items } = forma.body;

      // 5) Contenido de comprador/contacto/direccion: mismas reglas que ya
      // corrio (solo a modo de UX) el formulario del navegador.
      const validacionFormulario = checkoutFields.validarFormularioCheckout({
        comprador,
        contacto,
        direccionEnvio,
      });
      if (!validacionFormulario.ok) {
        return sendGenericError(res, 400);
      }

      // 6) Carrito: se reconstruye entero contra el catalogo real. Si CUALQUIER
      // linea no es valida, se rechaza la request completa: nunca se crea un
      // pedido parcial. La cantidad se valida en forma ESTRICTA (nunca se
      // "corrige" en silencio una cantidad invalida, a diferencia de lo que
      // hace buildCartSummary al restaurar un carrito guardado).
      if (!todasLasCantidadesSonValidas(items)) {
        return sendGenericError(res, 400);
      }
      const resumenCarrito = reconstruirCarritoReal(items, getProduct);
      if (resumenCarrito.descartadas.length > 0 || resumenCarrito.lineas.length === 0) {
        return sendGenericError(res, 400);
      }

      // 7) Arma el input real de crearPedido(): precios/nombres salen
      // exclusivamente de resumenCarrito.lineas (catalogo real), nunca del
      // body original.
      const input = {
        comprador: { nombre: checkoutFields.construirNombreCompleto(comprador) },
        contacto: {
          email: contacto.email.trim(),
          telefono: contacto.telefono.trim(),
        },
        direccionEnvio: checkoutFields.construirDireccionParaPedido(direccionEnvio),
        moneda: 'ARS',
        items: resumenCarrito.lineas.map((l) => ({
          productId: l.productId,
          nombre: l.nombre,
          talle: l.talle,
          cantidad: l.cantidad,
          precioUnitario: l.precio,
        })),
      };

      let pedido;
      try {
        pedido = await crearPedido(input);
      } catch (err) {
        // Nunca se loguea el error (podria contener datos del comprador o
        // detalles internos de Supabase).
        return sendGenericError(res, mapPedidoStoreErrorToStatus(err));
      }

    // 8) El pedido YA EXISTE en este punto. Intentamos crear (o reutilizar)
    // la preferencia de Mercado Pago en el mismo request. Un fallo aca
    // NUNCA borra ni modifica el pedido: queda pendiente_pago. El pedido
    // ya quedo registrado; informar esto al comprador es responsabilidad
    // del frontend (redirectUrl en null = "registrado, pago no iniciado").
    // El mecanismo de reintento de pago es DISEÑO PENDIENTE: no se
    // improvisa reutilizando access_token (ver docs/CONTINUAR-FASE3.md).
    let redirectUrl = null;
    try {
      const items = await obtenerItemsPorPedido(pedido.id);
      const resultado = await crearPreferenciaParaPedido({ pedido, items });
      if (resultado && resultado.ok) {
        redirectUrl = resultado.checkoutUrl;
      }
    } catch (err) {
      // Un error aca no debe impedir devolver el numero del pedido: ya
      // esta creado y se puede reintentar la preferencia despues.
      redirectUrl = null;
    }

    // 9) Respuesta minima: nunca el id interno (UUID) del pedido, nunca
    // el access_token de seguimiento (reservado para la futura consulta
    // segura del estado del pedido, no para reintentos de Mercado Pago),
    // nunca secrets ni datos de Mercado Pago. Solo lo estrictamente
    // necesario para que el frontend continue el flujo.
    return res.status(201).json({
      numero: pedido.numero,
      redirectUrl,
    });
    } catch (err) {
      return sendGenericError(res, 500);
    }
  };
}

module.exports = createPedidosHandler();
module.exports.createPedidosHandler = createPedidosHandler;
module.exports.GENERIC_ERROR_MESSAGE = GENERIC_ERROR_MESSAGE;
module.exports.MAX_BODY_LENGTH = MAX_BODY_LENGTH;
module.exports.MAX_ITEMS = MAX_ITEMS;
