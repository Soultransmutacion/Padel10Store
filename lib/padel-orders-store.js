'use strict';

/**
 * Capa de acceso a datos para pedidos reales de Padel10Store
 * (Fase 3, Etapa 1: base de datos + modelo de pedidos).
 *
 * Todo el SQL/DB de pedidos vive unicamente en este archivo y en
 * supabase/migrations/. Los futuros endpoints (carrito, formulario,
 * Mercado Pago, webhook, /admin) deben usar estas funciones y nunca
 * escribir SQL propio ni consultar Supabase directamente.
 *
 * Seguridad:
 * - Este modulo usa exclusivamente la "secret key" (o, en proyectos que
 *   todavia no migraron, la service_role key legada) de Supabase, que
 *   SOLO debe existir del lado servidor. Nunca debe importarse desde
 *   codigo que corra en el navegador (widget/, index.html).
 * - Las 4 tablas de pedidos tienen Row Level Security habilitada sin
 *   ninguna policy (deny by default): ni siquiera un token
 *   anon/authenticated puede leerlas o escribirlas. Solo la secret key
 *   (que bypassa RLS por diseno de Supabase) puede operar sobre ellas.
 * - Esta capa nunca loguea ni devuelve la secret key en ningun mensaje de
 *   error ni valor de retorno.
 *
 * Este archivo todavia NO se expone mediante ningun endpoint publico.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  generarPaymentRetryToken,
  hashPaymentRetryToken,
} = require('./payment-retry-token');

const ESTADOS_PAGO = Object.freeze([
  'pendiente',
  'aprobado',
  'rechazado',
  'cancelado',
  'reembolsado',
]);

const ESTADOS_PEDIDO = Object.freeze([
  'pendiente_pago',
  'a_preparar',
  'enviado',
  'entregado',
  'cancelado',
  'expirado',
]);

const MONEDAS_VALIDAS = Object.freeze(['ARS']);

const TIPOS_EVENTO = Object.freeze([
  'creacion',
  'cambio_estado_pago',
  'cambio_estado_pedido',
  'asociacion_preference',
  'asociacion_payment',
  'nota_admin',
  'otro',
]);

const DIRECCION_CLAVES_REQUERIDAS = Object.freeze([
  'calle',
  'ciudad',
  'provincia',
  'codigo_postal',
  'pais',
]);

const LIMITES = Object.freeze({
  compradorNombre: 200,
  compradorDocumento: 50,
  compradorEmail: 320,
  compradorTelefono: 50,
  notasAdmin: 2000,
  productId: 200,
  nombreItem: 300,
  talle: 50,
  cantidadMaxima: 100,
  mpPreferenceId: 100,
  mpPaymentId: 100,
  mpStatusDetail: 200,
  metadataBytes: 4000,
});

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN_BYTES = 32;

// Mismo alfabeto/longitud que la constraint chk_pedidos_idempotency_key_formato
// (supabase/migrations/20260901120000_add_idempotencia_checkout.sql): opaca,
// generada por quien inicia el checkout (en el navegador, crypto.randomUUID()
// con fallback), entre 16 y 100 caracteres.
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{16,100}$/;
// Digest SHA-256 en hex minuscula, mismo criterio que
// chk_pedidos_checkout_fingerprint_formato.
const CHECKOUT_FINGERPRINT_REGEX = /^[0-9a-f]{64}$/;

class PedidoStoreError extends Error {
  constructor(code, message, options) {
    super(message);
    this.name = 'PedidoStoreError';
    this.code = code;
    if (options && options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

let cachedClient = null;

// Solo para tests: fuerza a que la proxima llamada a getSupabaseAdminClient()
// vuelva a leer process.env y a crear un cliente nuevo.
function resetSupabaseAdminClientForTests() {
  cachedClient = null;
}

function getSupabaseAdminClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  // SUPABASE_SECRET_KEY es la nomenclatura vigente (2026) de Supabase.
  // SUPABASE_SERVICE_ROLE_KEY se acepta como alias legado para proyectos
  // que todavia no migraron a las claves publishable/secret nuevas.
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !secretKey) {
    throw new PedidoStoreError(
      'CONFIGURACION',
      'Faltan variables de entorno de Supabase del lado servidor (SUPABASE_URL y SUPABASE_SECRET_KEY).'
    );
  }

  cachedClient = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
  return cachedClient;
}

function esUuidValido(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

// Valida el formato de una idempotency_key recibida del cliente. Nunca
// valida su contenido semantico (eso lo resuelve la RPC atomicamente contra
// el indice unico de Postgres): solo descarta valores triviales/con formato
// invalido antes de gastar un roundtrip a la base de datos.
function esIdempotencyKeyValida(value) {
  return typeof value === 'string' && IDEMPOTENCY_KEY_REGEX.test(value);
}

// Ordena las claves de un objeto (recursivamente, incluyendo dentro de
// arrays) para poder serializar un JSON canonico: el mismo contenido debe
// producir siempre el mismo string sin importar el orden en que se hayan
// construido las propiedades en JS.
function ordenarClavesProfundo(value) {
  if (Array.isArray(value)) return value.map(ordenarClavesProfundo);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = ordenarClavesProfundo(value[key]);
        return acc;
      }, {});
  }
  return value;
}

// Digest SHA-256 (hex) del contenido YA VALIDADO Y NORMALIZADO del checkout.
// Se calcula exclusivamente del lado del servidor, a partir de los mismos
// datos que efectivamente se van a persistir (nunca de un fingerprint que
// mande el navegador): eso es lo que le da valor a esta comparacion para
// distinguir "reintento legitimo del mismo intento" de "idempotency_key
// reutilizada con otro contenido".
function calcularFingerprintCheckout(contenido) {
  const canonico = JSON.stringify(ordenarClavesProfundo(contenido));
  return crypto.createHash('sha256').update(canonico, 'utf8').digest('hex');
}

// Genera un access token publico, aleatorio y criptograficamente seguro.
// Nunca se deriva del UUID interno ni del numero de pedido: son 32 bytes
// de randomness propios, codificados en hex (64 caracteres), generados con
// crypto.randomBytes (CSPRNG del sistema operativo).
function generarAccessTokenSeguro() {
  return crypto.randomBytes(ACCESS_TOKEN_BYTES).toString('hex');
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function mapSupabaseError(error, operacion) {
  return new PedidoStoreError(
    'DB_ERROR',
    `Error de base de datos en ${operacion}: ${(error && error.message) || 'desconocido'}`,
    { cause: error }
  );
}

function esViolacionUnicidad(error) {
  return Boolean(error) && error.code === '23505';
}

// --- Logging estructurado y sanitizado + reintento estrecho de la RPC de
// creacion de pedido ante un 401 de gateway transitorio ---------------------
//
// Investigacion (evidencia: dos POST concurrentes identicos a
// padel_crear_pedido_idempotente; la RPC ganadora responde 200; la
// perdedora responde 401 a los 63ms, con latencia 0 -es decir, rechazada
// ANTES de llegar a Postgres/PostgREST-; la base termina con un unico
// pedido, un item y dos eventos -correcto-, pero api/pedidos.js devolvia
// 500 porque el 401 se trataba como cualquier otro error de base de
// datos):
//
// 1) Cliente Supabase: getSupabaseAdminClient() cachea una UNICA instancia
//    de @supabase/supabase-js por proceso (ver arriba). Esa instancia no
//    tiene ningun estado de autenticacion mutable: se crea con
//    { auth: { persistSession: false, autoRefreshToken: false } }, y sus
//    headers (apikey/Authorization con la secret key) se arman UNA vez al
//    construir el cliente y se copian tal cual en cada request. Dos
//    llamadas concurrentes reusan el mismo cliente pero no comparten
//    ningun estado mutable entre si: no hay una carrera de autenticacion
//    de nuestro lado. El 401 observado es, por descarte, un fallo
//    transitorio del lado de Supabase (gateway/proxy delante de PostgREST)
//    ante dos conexiones casi simultaneas con la misma credencial, no un
//    bug de este modulo.
// 2) @supabase/supabase-js 2.108.0 (@supabase/postgrest-js por debajo): el
//    objeto de error que devuelve `await client.rpc(...)` (PostgrestError)
//    SOLO expone `message`, `details`, `hint` y `code` -nunca `status` ni
//    `statusCode`-. El status HTTP real (`res.status`) viaja en un campo
//    HERMANO al `error` dentro del mismo objeto resuelto por la promesa
//    ({ data, error, status, statusText, ... }), no dentro del error. El
//    codigo anterior solo desestructuraba `{ data, error }`, descartando
//    ese `status`: por eso un 401 de gateway (que ademas puede traer un
//    body sin la forma de error de PostgREST, sin `code` reconocible) caia
//    siempre en el branch generico -> PedidoStoreError('DB_ERROR') -> 500.
// 3) Por lo anterior, el 401 SI se puede identificar de forma fiable y
//    estructural: comparando el `status` HTTP (numero, viene del propio
//    Response, nunca de texto libre) contra 401. Nunca se intenta adivinar
//    un 401 a partir de `error.message` (fragil: el body de un 401 de
//    gateway no tiene por que tener la forma de un error de Postgres/
//    PostgREST, y Supabase Logs, segun la evidencia, ni siquiera conserva
//    ese body/SQLSTATE/message/detail para poder inspeccionarlo despues).
function esStatusHttp401(status) {
  return status === 401;
}

// Hash NO reversible de la idempotencyKey, truncado a un prefijo corto: se
// usa UNICAMENTE para poder correlacionar, en los logs, dos intentos que
// corresponden a la misma intencion de checkout (por ejemplo, el intento
// original y su reintento por 401), sin loguear la clave real ni nada que
// permita reconstruirla.
function calcularCorrelacionIdempotencyKey(idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) return null;
  return crypto.createHash('sha256').update(idempotencyKey, 'utf8').digest('hex').slice(0, 12);
}

// Unica funcion de este modulo que escribe a consola: centraliza el
// logging para que sea facil auditar (y verificar con pruebas estaticas)
// que nunca se loguea la secret key, ningun token, headers, la idempotency
// key completa, el checkout_fingerprint completo ni datos del comprador.
// Solo metadata operativa: operacion, code/status de la RPC, categoria y,
// como mucho, el prefijo de correlacion no reversible de arriba.
function logSeguro(categoria, detalle) {
  try {
    console.log(JSON.stringify(Object.assign({ modulo: 'padel-orders-store', categoria }, detalle || {})));
  } catch (err) {
    // No-op: nunca se deja que un problema de logging tumbe el flujo real.
  }
}

// Espera corta antes del unico reintento permitido (ver mas abajo). No
// pretende ser un backoff exponencial: es solo un respiro breve para no
// repetir la llamada en la misma ventana exacta de contencion que produjo
// el 401 original.
const REINTENTO_401_DELAY_MS = 150;
function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Invoca padel_crear_pedido_idempotente y, si (y solo si) la respuesta es
// un 401 HTTP real, hace EXACTAMENTE UN reintento con los mismos
// parametros (misma idempotency_key y checkout_fingerprint: nunca se
// regenera nada). Esto es seguro precisamente porque la RPC es
// atomicamente idempotente (ver la migracion): si el intento original en
// realidad nunca llego a Postgres -como evidencia un 401 con latencia casi
// nula-, el reintento es, a efectos de la base, el primer intento real; si
// mientras tanto otra llamada concurrente con la MISMA clave ya inserto la
// fila, "on conflict (idempotency_key) do nothing" hace que el reintento
// recupere ese pedido ya creado sin duplicar nada.
//
// Nunca se reintenta: un conflicto de fingerprint (P0002, es un rechazo
// legitimo, no un fallo transitorio), una validacion (P0001), ni ningun
// otro error sin clasificar (errores tecnicos genuinos de base de datos,
// por ejemplo) - unicamente el caso puntual de un status HTTP 401.
async function invocarCrearPedidoIdempotenteConReintento(c, params) {
  const correlacion = calcularCorrelacionIdempotencyKey(params.p_idempotency_key);
  const primero = await c.rpc('padel_crear_pedido_idempotente', params);

  if (!primero.error) {
    return primero;
  }

  logSeguro('rpc_crear_pedido_error', {
    operacion: 'padel_crear_pedido_idempotente',
    code: primero.error.code || null,
    status: primero.status === undefined ? null : primero.status,
    correlacion,
  });

  if (!esStatusHttp401(primero.status)) {
    return primero;
  }

  logSeguro('rpc_crear_pedido_401_reintentando', {
    operacion: 'padel_crear_pedido_idempotente',
    correlacion,
  });

  await esperar(REINTENTO_401_DELAY_MS);
  const segundo = await c.rpc('padel_crear_pedido_idempotente', params);

  if (!segundo.error) {
    logSeguro('rpc_crear_pedido_401_reintento_recuperado', {
      operacion: 'padel_crear_pedido_idempotente',
      correlacion,
    });
    return segundo;
  }

  logSeguro('rpc_crear_pedido_401_reintento_fallido', {
    operacion: 'padel_crear_pedido_idempotente',
    code: segundo.error.code || null,
    status: segundo.status === undefined ? null : segundo.status,
    correlacion,
  });
  return segundo;
}

function validarItem(item, idx) {
  if (!item || typeof item !== 'object') {
    throw new PedidoStoreError('VALIDACION', `items[${idx}] invalido`);
  }
  if (
    typeof item.productId !== 'string' ||
    !item.productId.trim() ||
    item.productId.length > LIMITES.productId
  ) {
    throw new PedidoStoreError('VALIDACION', `items[${idx}].productId invalido`);
  }
  if (
    typeof item.nombre !== 'string' ||
    !item.nombre.trim() ||
    item.nombre.length > LIMITES.nombreItem
  ) {
    throw new PedidoStoreError('VALIDACION', `items[${idx}].nombre invalido`);
  }
  if (item.talle !== undefined && item.talle !== null) {
    if (typeof item.talle !== 'string' || item.talle.length > LIMITES.talle) {
      throw new PedidoStoreError('VALIDACION', `items[${idx}].talle invalido`);
    }
  }
  if (!Number.isInteger(item.cantidad) || item.cantidad < 1 || item.cantidad > LIMITES.cantidadMaxima) {
    throw new PedidoStoreError(
      'VALIDACION',
      `items[${idx}].cantidad invalida (debe ser un entero entre 1 y ${LIMITES.cantidadMaxima})`
    );
  }
  if (
    typeof item.precioUnitario !== 'number' ||
    !Number.isFinite(item.precioUnitario) ||
    item.precioUnitario < 0
  ) {
    throw new PedidoStoreError('VALIDACION', `items[${idx}].precioUnitario invalido`);
  }
}

function normalizarItem(item) {
  const precioUnitario = round2(item.precioUnitario);
  const cantidad = item.cantidad;
  return {
    product_id: item.productId,
    nombre: item.nombre,
    talle: item.talle === undefined ? null : item.talle,
    cantidad,
    precio_unitario: precioUnitario,
    subtotal_linea: round2(precioUnitario * cantidad),
  };
}

function validarInputCrearPedido(input) {
  if (!input || typeof input !== 'object') {
    throw new PedidoStoreError('VALIDACION', 'input de crearPedido invalido');
  }

  const comprador = input.comprador;
  if (!comprador || typeof comprador.nombre !== 'string' || !comprador.nombre.trim()) {
    throw new PedidoStoreError('VALIDACION', 'comprador.nombre es obligatorio');
  }
  if (comprador.nombre.length > LIMITES.compradorNombre) {
    throw new PedidoStoreError(
      'VALIDACION',
      `comprador.nombre supera ${LIMITES.compradorNombre} caracteres`
    );
  }
  if (comprador.documento !== undefined && comprador.documento !== null) {
    if (typeof comprador.documento !== 'string' || comprador.documento.length > LIMITES.compradorDocumento) {
      throw new PedidoStoreError('VALIDACION', 'comprador.documento invalido');
    }
  }

  const contacto = input.contacto;
  if (!contacto || typeof contacto.email !== 'string' || !EMAIL_REGEX.test(contacto.email)) {
    throw new PedidoStoreError('VALIDACION', 'contacto.email es obligatorio y debe ser valido');
  }
  if (contacto.email.length > LIMITES.compradorEmail) {
    throw new PedidoStoreError(
      'VALIDACION',
      `contacto.email supera ${LIMITES.compradorEmail} caracteres`
    );
  }
  if (contacto.telefono !== undefined && contacto.telefono !== null) {
    if (typeof contacto.telefono !== 'string' || contacto.telefono.length > LIMITES.compradorTelefono) {
      throw new PedidoStoreError('VALIDACION', 'contacto.telefono invalido');
    }
  }

  const direccion = input.direccionEnvio;
  if (!direccion || typeof direccion !== 'object' || Array.isArray(direccion)) {
    throw new PedidoStoreError('VALIDACION', 'direccionEnvio es obligatoria');
  }
  DIRECCION_CLAVES_REQUERIDAS.forEach((clave) => {
    if (!direccion[clave] || typeof direccion[clave] !== 'string' || !direccion[clave].trim()) {
      throw new PedidoStoreError('VALIDACION', `direccionEnvio.${clave} es obligatoria`);
    }
  });

  if (input.moneda !== undefined && !MONEDAS_VALIDAS.includes(input.moneda)) {
    throw new PedidoStoreError('VALIDACION', `moneda invalida: ${input.moneda}`);
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new PedidoStoreError('VALIDACION', 'se requiere al menos un item');
  }
  input.items.forEach(validarItem);

  if (input.total !== undefined) {
    if (typeof input.total !== 'number' || !Number.isFinite(input.total) || input.total < 0) {
      throw new PedidoStoreError('VALIDACION', 'total invalido');
    }
  }

  if (!esIdempotencyKeyValida(input.idempotencyKey)) {
    throw new PedidoStoreError(
      'VALIDACION',
      'idempotencyKey es obligatoria y debe tener entre 16 y 100 caracteres ([A-Za-z0-9_-])'
    );
  }
}

/**
 * Crea un pedido junto con sus items y el evento de auditoria inicial, de
 * forma atomica e IDEMPOTENTE por "intencion de checkout" (usa la funcion
 * RPC padel_crear_pedido_idempotente, que corre todo en una unica
 * transaccion de Postgres y resuelve reintentos/concurrencia a nivel del
 * indice unico de uq_pedidos_idempotency_key: ver
 * supabase/migrations/20260901120000_add_idempotencia_checkout.sql).
 *
 * input:
 *   - comprador: { nombre, documento? }
 *   - contacto: { email, telefono? }
 *   - direccionEnvio: { calle, ciudad, provincia, codigo_postal, pais, ... }
 *   - items: [{ productId, nombre, talle?, cantidad, precioUnitario }]
 *   - moneda?: 'ARS' (default)
 *   - total?: si no se pasa, se usa la suma de los items (subtotal)
 *   - idempotencyKey: clave opaca (16-100 caracteres) generada por quien
 *     inicia el checkout, obligatoria. Dos llamadas con la misma clave y el
 *     mismo contenido devuelven el MISMO pedido, sin duplicar items ni
 *     eventos. La misma clave con contenido distinto se rechaza (ver
 *     PedidoStoreError code 'CONFLICTO' mas abajo).
 *
 * El checkout_fingerprint (SHA-256) que distingue "reintento legitimo" de
 * "clave reutilizada con otro contenido" se calcula ACA, del lado del
 * servidor, a partir del contenido ya validado y normalizado (nunca de un
 * valor mandado por el navegador).
 */
async function crearPedido(input, client) {
  validarInputCrearPedido(input);
  const c = client || getSupabaseAdminClient();

  const items = input.items.map(normalizarItem);
  const subtotal = round2(items.reduce((acc, it) => acc + it.subtotal_linea, 0));
  const total = input.total === undefined ? subtotal : round2(input.total);

  const compradorDocumento = input.comprador.documento === undefined ? null : input.comprador.documento;
  const contactoTelefono = input.contacto.telefono === undefined ? null : input.contacto.telefono;
  const moneda = input.moneda || 'ARS';

  const checkoutFingerprint = calcularFingerprintCheckout({
    comprador: { nombre: input.comprador.nombre, documento: compradorDocumento },
    contacto: { email: input.contacto.email, telefono: contactoTelefono },
    direccionEnvio: input.direccionEnvio,
    moneda,
    total,
    items,
  });

  const accessToken = generarAccessTokenSeguro();

  // payment_retry_token: mecanismo independiente de access_token, de uso
  // unico (autorizar un intento de pago para ESTE pedido). Se genera
  // siempre en la creacion para poder ofrecer un reintento seguro si la
  // preferencia inicial de Mercado Pago falla; en base de datos solo se
  // guarda su hash (ver lib/payment-retry-token.js). El valor en claro
  // nunca se persiste: solo viaja, transitoriamente, en la respuesta de
  // esta funcion (propiedad payment_retry_token, ver mas abajo) y SOLO
  // cuando esta llamada fue la que efectivamente creo el pedido (ver
  // esInsercionNueva mas abajo): un reintento idempotente que recupera un
  // pedido ya existente no tiene forma de saber cual fue el token en claro
  // original (solo se guardo su hash), asi que jamas debe inventar uno.
  const paymentRetryToken = generarPaymentRetryToken();
  const paymentRetryTokenHash = hashPaymentRetryToken(paymentRetryToken);

  const { data, error } = await invocarCrearPedidoIdempotenteConReintento(c, {
    p_comprador_nombre: input.comprador.nombre,
    p_comprador_email: input.contacto.email,
    p_comprador_telefono: contactoTelefono,
    p_comprador_documento: compradorDocumento,
    p_envio_direccion: input.direccionEnvio,
    p_moneda: moneda,
    p_subtotal: subtotal,
    p_total: total,
    p_access_token: accessToken,
    p_items: items,
    p_payment_retry_token_hash: paymentRetryTokenHash,
    p_idempotency_key: input.idempotencyKey,
    p_checkout_fingerprint: checkoutFingerprint,
  });

  if (error) {
    // errcode P0002 (ver la RPC en la migracion): la idempotencyKey ya fue
    // usada antes con un checkout_fingerprint distinto. Se distingue con un
    // code propio para que el llamador (api/pedidos.js) pueda responder un
    // 409 en vez de un 500/502 generico.
    if (error.code === 'P0002') {
      throw new PedidoStoreError(
        'CONFLICTO',
        'idempotencyKey ya fue utilizada para un checkout con contenido distinto',
        { cause: error }
      );
    }
    throw mapSupabaseError(error, 'crearPedido');
  }

  // Si el hash coincide con el que se acaba de generar en ESTA llamada,
  // significa que fue esta invocacion la que efectivamente inserto la fila
  // (insercion nueva, ver "on conflict ... do nothing" en la RPC): recien
  // ahi corresponde devolver el payment_retry_token en claro. Si no
  // coincide, la fila ya existia de antes (reintento idempotente resuelto
  // por la RPC sin duplicar nada): se omite el campo en vez de devolver un
  // token que no corresponde a ningun hash real guardado.
  const esInsercionNueva = Boolean(data) && data.payment_retry_token_hash === paymentRetryTokenHash;

  return esInsercionNueva
    ? Object.assign({}, data, { payment_retry_token: paymentRetryToken })
    : Object.assign({}, data);
}

async function obtenerPedidoPorId(id, client) {
  if (!esUuidValido(id)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  const c = client || getSupabaseAdminClient();
  const { data, error } = await c.from('pedidos').select('*').eq('id', id).maybeSingle();
  if (error) throw mapSupabaseError(error, 'obtenerPedidoPorId');
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');
  return data;
}

async function obtenerPedidoPorAccessToken(accessToken, client) {
  if (typeof accessToken !== 'string' || accessToken.length < 20) {
    throw new PedidoStoreError('VALIDACION', 'access token invalido');
  }
  const c = client || getSupabaseAdminClient();
  const { data, error } = await c
    .from('pedidos')
    .select('*')
    .eq('access_token', accessToken)
    .maybeSingle();
  if (error) throw mapSupabaseError(error, 'obtenerPedidoPorAccessToken');
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');
  return data;
}

// Busca un pedido por el HASH de su payment_retry_token (nunca por el
// token en claro: este modulo no guarda el valor en claro en ningun
// lado). El llamador (api/pedidos-preferencia.js) es responsable de
// validar el formato del token recibido y calcular su hash con
// lib/payment-retry-token.js#hashPaymentRetryToken antes de invocar esta
// funcion.
async function obtenerPedidoPorPaymentRetryTokenHash(hash, client) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new PedidoStoreError('VALIDACION', 'hash de payment retry token invalido');
  }
  const c = client || getSupabaseAdminClient();
  const { data, error } = await c
    .from('pedidos')
    .select('*')
    .eq('payment_retry_token_hash', hash)
    .maybeSingle();
  if (error) throw mapSupabaseError(error, 'obtenerPedidoPorPaymentRetryTokenHash');
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');
  return data;
}

async function obtenerItemsPorPedido(pedidoId, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  const c = client || getSupabaseAdminClient();
  const { data, error } = await c
    .from('pedido_items')
    .select('*')
    .eq('pedido_id', pedidoId)
    .order('created_at', { ascending: true });
  if (error) throw mapSupabaseError(error, 'obtenerItemsPorPedido');
  return data || [];
}

async function registrarEvento(input, client) {
  if (!esUuidValido(input.pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  if (!TIPOS_EVENTO.includes(input.tipo)) {
    throw new PedidoStoreError('VALIDACION', `tipo de evento invalido: ${input.tipo}`);
  }
  const metadata = input.metadata || {};
  const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  if (metadataBytes > LIMITES.metadataBytes) {
    throw new PedidoStoreError(
      'VALIDACION',
      'metadata de evento demasiado grande: nunca se debe guardar el payload completo'
    );
  }
  const c = client || getSupabaseAdminClient();

  const row = {
    pedido_id: input.pedidoId,
    tipo: input.tipo,
    estado_pago_anterior: input.estadoPagoAnterior === undefined ? null : input.estadoPagoAnterior,
    estado_pago_nuevo: input.estadoPagoNuevo === undefined ? null : input.estadoPagoNuevo,
    estado_pedido_anterior: input.estadoPedidoAnterior === undefined ? null : input.estadoPedidoAnterior,
    estado_pedido_nuevo: input.estadoPedidoNuevo === undefined ? null : input.estadoPedidoNuevo,
    metadata,
  };

  const { data, error } = await c.from('pedido_eventos').insert(row).select().single();
  if (error) throw mapSupabaseError(error, 'registrarEvento');
  return data;
}

async function obtenerEventosPorPedido(pedidoId, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  const c = client || getSupabaseAdminClient();
  const { data, error } = await c
    .from('pedido_eventos')
    .select('*')
    .eq('pedido_id', pedidoId)
    .order('created_at', { ascending: true });
  if (error) throw mapSupabaseError(error, 'obtenerEventosPorPedido');
  return data || [];
}

function esErrorFilaNoEncontrada(error) {
  // PGRST116: codigo que devuelve PostgREST cuando .single() no matchea
  // ninguna fila (0 resultados). Es el caso esperado, no un error real, asi
  // que asociarPreferenceId lo interpreta como "no se pudo actualizar" en
  // vez de propagarlo.
  return Boolean(error) && error.code === 'PGRST116';
}

// Asocia una preferencia de Mercado Pago a un pedido, pero SOLO si el
// pedido todavia no tenia ninguna asociada (update condicional via
// ".is('mp_preference_id', null)"). Esto existe para que dos llamadas
// concurrentes para el mismo pedido (por ejemplo, dos reintentos del mismo
// checkout que perdieron la respuesta original) nunca puedan pisarse la
// preferencia asociada entre si: Postgres serializa los UPDATE concurrentes
// sobre la misma fila a nivel de bloqueo de fila, asi que como mucho UNA de
// las dos llamadas puede matchear la condicion "todavia es null" y
// efectivamente escribir. La otra pierde la carrera: en vez de fallar, esta
// funcion relee el pedido y devuelve su estado actual (con la preferencia
// que SI gano), para que el llamador (lib/pedido-preferencia.js) pueda
// detectar que perdio y reusar la preferencia ganadora en vez de crear una
// segunda.
async function asociarPreferenceId(pedidoId, mpPreferenceId, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  if (
    typeof mpPreferenceId !== 'string' ||
    !mpPreferenceId.trim() ||
    mpPreferenceId.length > LIMITES.mpPreferenceId
  ) {
    throw new PedidoStoreError('VALIDACION', 'mp_preference_id invalido');
  }
  const c = client || getSupabaseAdminClient();

  const { data, error } = await c
    .from('pedidos')
    .update({ mp_preference_id: mpPreferenceId })
    .eq('id', pedidoId)
    .is('mp_preference_id', null)
    .select()
    .single();

  if (error && !esErrorFilaNoEncontrada(error)) {
    throw mapSupabaseError(error, 'asociarPreferenceId');
  }

  if (!error && data) {
    // Esta llamada gano la carrera (o no habia carrera): recien ahi
    // corresponde registrar el evento de auditoria.
    await registrarEvento(
      { pedidoId, tipo: 'asociacion_preference', metadata: { mp_preference_id: mpPreferenceId } },
      c
    );
    return data;
  }

  // No se actualizo ninguna fila: o el pedido no existe (lanza
  // NO_ENCONTRADO, igual que antes), o ya tenia un mp_preference_id
  // distinto de null asociado por otra llamada (perdio la carrera). En
  // ambos casos se relee el estado actual en vez de asumir cual fue: nunca
  // se sobreescribe ni se pierde silenciosamente el valor ganador.
  return obtenerPedidoPorId(pedidoId, c);
}

async function asociarPaymentId(pedidoId, mpPaymentId, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  if (
    typeof mpPaymentId !== 'string' ||
    !mpPaymentId.trim() ||
    mpPaymentId.length > LIMITES.mpPaymentId
  ) {
    throw new PedidoStoreError('VALIDACION', 'mp_payment_id invalido');
  }
  const c = client || getSupabaseAdminClient();

  const { data, error } = await c
    .from('pedidos')
    .update({ mp_payment_id: mpPaymentId })
    .eq('id', pedidoId)
    .select()
    .single();

  if (error) {
    if (esViolacionUnicidad(error)) {
      throw new PedidoStoreError(
        'CONFLICTO',
        'mp_payment_id ya esta asociado a otro pedido',
        { cause: error }
      );
    }
    throw mapSupabaseError(error, 'asociarPaymentId');
  }
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');

  await registrarEvento(
    { pedidoId, tipo: 'asociacion_payment', metadata: { mp_payment_id: mpPaymentId } },
    c
  );

  return data;
}

async function actualizarEstadoPago(pedidoId, nuevoEstado, opts, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  if (!ESTADOS_PAGO.includes(nuevoEstado)) {
    throw new PedidoStoreError('VALIDACION', `estado_pago invalido: ${nuevoEstado}`);
  }
  const c = client || getSupabaseAdminClient();
  const opciones = opts || {};

  const pedidoActual = await obtenerPedidoPorId(pedidoId, c);

  const patch = { estado_pago: nuevoEstado };
  if (opciones.mpStatusDetail !== undefined) {
    if (opciones.mpStatusDetail !== null && String(opciones.mpStatusDetail).length > LIMITES.mpStatusDetail) {
      throw new PedidoStoreError('VALIDACION', 'mp_status_detail demasiado largo');
    }
    patch.mp_status_detail = opciones.mpStatusDetail;
  }
  if (nuevoEstado === 'aprobado' && !pedidoActual.pagado_at) {
    patch.pagado_at = new Date().toISOString();
  }
  if (nuevoEstado === 'cancelado' && !pedidoActual.cancelado_at) {
    patch.cancelado_at = new Date().toISOString();
  }

  const { data, error } = await c.from('pedidos').update(patch).eq('id', pedidoId).select().single();
  if (error) throw mapSupabaseError(error, 'actualizarEstadoPago');
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');

  await registrarEvento(
    {
      pedidoId,
      tipo: 'cambio_estado_pago',
      estadoPagoAnterior: pedidoActual.estado_pago,
      estadoPagoNuevo: nuevoEstado,
      metadata: opciones.mpStatusDetail ? { mp_status_detail: opciones.mpStatusDetail } : {},
    },
    c
  );

  return data;
}

async function actualizarEstadoPedido(pedidoId, nuevoEstado, opts, client) {
  if (!esUuidValido(pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'id de pedido invalido');
  }
  if (!ESTADOS_PEDIDO.includes(nuevoEstado)) {
    throw new PedidoStoreError('VALIDACION', `estado_pedido invalido: ${nuevoEstado}`);
  }
  const c = client || getSupabaseAdminClient();
  const opciones = opts || {};

  const pedidoActual = await obtenerPedidoPorId(pedidoId, c);

  const patch = { estado_pedido: nuevoEstado };
  if (nuevoEstado === 'cancelado' && !pedidoActual.cancelado_at) {
    patch.cancelado_at = new Date().toISOString();
  }

  const { data, error } = await c.from('pedidos').update(patch).eq('id', pedidoId).select().single();
  if (error) throw mapSupabaseError(error, 'actualizarEstadoPedido');
  if (!data) throw new PedidoStoreError('NO_ENCONTRADO', 'Pedido no encontrado');

  await registrarEvento(
    {
      pedidoId,
      tipo: 'cambio_estado_pedido',
      estadoPedidoAnterior: pedidoActual.estado_pedido,
      estadoPedidoNuevo: nuevoEstado,
      metadata: opciones.motivo ? { motivo: String(opciones.motivo).slice(0, 200) } : {},
    },
    c
  );

  return data;
}

function validarProveedorEventoId(proveedor, eventoId) {
  if (proveedor !== 'mercadopago') {
    throw new PedidoStoreError('VALIDACION', `proveedor de webhook invalido: ${proveedor}`);
  }
  if (typeof eventoId !== 'string' || !eventoId.trim() || eventoId.length > 200) {
    throw new PedidoStoreError('VALIDACION', 'evento_id de webhook invalido');
  }
}

async function estaEventoWebhookProcesado(proveedor, eventoId, client) {
  validarProveedorEventoId(proveedor, eventoId);
  const c = client || getSupabaseAdminClient();

  const { data, error } = await c
    .from('webhook_eventos_procesados')
    .select('id')
    .eq('proveedor', proveedor)
    .eq('evento_id', eventoId)
    .maybeSingle();
  if (error) throw mapSupabaseError(error, 'estaEventoWebhookProcesado');
  return Boolean(data);
}

async function marcarEventoWebhookProcesado(input, client) {
  validarProveedorEventoId(input.proveedor, input.eventoId);

  if (input.pedidoId !== undefined && input.pedidoId !== null && !esUuidValido(input.pedidoId)) {
    throw new PedidoStoreError('VALIDACION', 'pedidoId invalido');
  }
  if (input.tipo !== undefined && input.tipo !== null) {
    if (typeof input.tipo !== 'string' || input.tipo.length > 100) {
      throw new PedidoStoreError('VALIDACION', 'tipo de evento de webhook invalido');
    }
  }

  const metadata = input.metadata || {};
  const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  if (metadataBytes > LIMITES.metadataBytes) {
    throw new PedidoStoreError(
      'VALIDACION',
      'metadata de webhook demasiado grande: nunca se debe guardar el payload completo'
    );
  }
  const c = client || getSupabaseAdminClient();

  const row = {
    proveedor: input.proveedor,
    evento_id: input.eventoId,
    tipo: input.tipo === undefined ? null : input.tipo,
    pedido_id: input.pedidoId === undefined ? null : input.pedidoId,
    metadata,
  };

  const { data, error } = await c.from('webhook_eventos_procesados').insert(row).select().single();
  if (error) {
    if (esViolacionUnicidad(error)) {
      throw new PedidoStoreError(
        'CONFLICTO',
        'Este evento de webhook ya fue procesado (idempotencia)',
        { cause: error }
      );
    }
    throw mapSupabaseError(error, 'marcarEventoWebhookProcesado');
  }
  return data;
}

module.exports = {
  ESTADOS_PAGO,
  ESTADOS_PEDIDO,
  MONEDAS_VALIDAS,
  TIPOS_EVENTO,
  DIRECCION_CLAVES_REQUERIDAS,
  LIMITES,
  PedidoStoreError,

  getSupabaseAdminClient,
  resetSupabaseAdminClientForTests,
  generarAccessTokenSeguro,
  esUuidValido,
  esIdempotencyKeyValida,

  crearPedido,
  obtenerPedidoPorId,
  obtenerPedidoPorAccessToken,
  obtenerPedidoPorPaymentRetryTokenHash,
  obtenerItemsPorPedido,
  asociarPreferenceId,
  asociarPaymentId,
  actualizarEstadoPago,
  actualizarEstadoPedido,
  registrarEvento,
  obtenerEventosPorPedido,
  estaEventoWebhookProcesado,
  marcarEventoWebhookProcesado,
};
