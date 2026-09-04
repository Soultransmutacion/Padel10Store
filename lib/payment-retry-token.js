'use strict';

/**
 * Payment retry token (Fase 3, Etapa 3).
 *
 * Mecanismo INDEPENDIENTE de access_token, de proposito unico: autorizar
 * unicamente el intento de iniciar/reanudar el flujo de pago (Mercado
 * Pago) de UN pedido puntual. No reemplaza ni modifica access_token, que
 * queda reservado exclusivamente para la futura consulta segura del
 * estado/seguimiento del pedido.
 *
 * Garantias de diseno:
 * - Generado del lado servidor con crypto.randomBytes (CSPRNG del SO):
 *   32 bytes (256 bits) de randomness propia, codificados en hex (64
 *   caracteres). Mismo formato/entropia que access_token, pero es un
 *   valor completamente independiente (nunca se derivan uno del otro).
 * - NUNCA se deriva del UUID interno del pedido ni del numero publico
 *   (P10-...): ambos son identificadores predecibles/enumerables (el
 *   numero es correlativo) y derivar el token de ellos lo haria
 *   adivinable.
 * - No sirve para consultar datos personales del pedido ni como token de
 *   seguimiento: solo se usa para localizar el pedido y autorizar UNA
 *   accion puntual (crear o reutilizar una preferencia de pago).
 * - En base de datos SOLO se guarda un hash (SHA-256) del token, nunca el
 *   valor en claro: un acceso de lectura a la tabla pedidos (por ejemplo,
 *   un dump o una fuga) no alcanza para reconstruir tokens validos,
 *   exactamente igual que con una contrasena. El propio token ya tiene
 *   256 bits de entropia criptografica (generado con un CSPRNG), asi que
 *   no hace falta un salt/pepper adicional por token: a diferencia de una
 *   contrasena elegida por una persona, este valor nunca se reutiliza ni
 *   es adivinable por fuerza bruta con un hash rapido como SHA-256.
 * - El valor en claro solo existe transitoriamente en memoria del proceso
 *   Node durante el request que lo genera (o que lo recibe del cliente
 *   para validarlo). Nunca se persiste en claro, nunca se loguea completo
 *   (ver truncarParaLog) y nunca se envia al modelo de IA.
 */

const crypto = require('crypto');

const PAYMENT_RETRY_TOKEN_BYTES = 32;
// Formato esperado del token en claro: 64 caracteres hexadecimales
// (32 bytes). Cualquier otra cosa se rechaza antes de tocar la base de
// datos (evita, por ejemplo, mandar el hash como si fuera el token, o
// strings de otro origen).
const PAYMENT_RETRY_TOKEN_REGEX = /^[0-9a-f]{64}$/;
const LOG_PREFIX_LENGTH = 8;

/**
 * Genera un payment_retry_token nuevo, aleatorio y criptograficamente
 * seguro. Nunca se deriva del id ni del numero del pedido: son 32 bytes
 * de randomness propios, codificados en hex.
 */
function generarPaymentRetryToken() {
  return crypto.randomBytes(PAYMENT_RETRY_TOKEN_BYTES).toString('hex');
}

function esPaymentRetryTokenValido(token) {
  return typeof token === 'string' && PAYMENT_RETRY_TOKEN_REGEX.test(token);
}

/**
 * Calcula el hash (SHA-256, hex) que se guarda en base de datos en lugar
 * del token en claro. Determinista: el mismo token en claro siempre
 * produce el mismo hash, lo que permite buscarlo por igualdad exacta
 * (`eq`) sin tener que traer filas de mas para compararlas en JS.
 */
function hashPaymentRetryToken(token) {
  if (!esPaymentRetryTokenValido(token)) {
    throw new TypeError('hashPaymentRetryToken: token con formato invalido');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Nunca se debe loguear un payment_retry_token completo. Esta funcion
 * existe para los pocos lugares (mensajes de error internos, auditoria)
 * donde puede ser util dejar constancia de "algo se recibio" sin exponer
 * el valor utilizable.
 */
function truncarParaLog(token) {
  if (typeof token !== 'string' || !token) return '(vacio)';
  return `${token.slice(0, LOG_PREFIX_LENGTH)}... (${token.length} chars)`;
}

module.exports = {
  PAYMENT_RETRY_TOKEN_BYTES,
  PAYMENT_RETRY_TOKEN_REGEX,
  generarPaymentRetryToken,
  esPaymentRetryTokenValido,
  hashPaymentRetryToken,
  truncarParaLog,
};
