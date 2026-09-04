'use strict';

/**
 * Pruebas de api/pedidos.js (Fase 3, Etapa 2: formulario de comprador y
 * datos de envio).
 *
 * Estas pruebas NO se conectan a Supabase: usan un `crearPedido` de prueba
 * inyectado (ver createPedidosHandler en api/pedidos.js), igual que
 * tests/padel-orders-store.test.js usa un cliente Supabase fake. El
 * catalogo si es el real (lib/padel-catalog.js + products.json), igual que
 * ya hace tests/mercadopago-preference.test.js, porque resolver productos
 * reales es justamente lo que este endpoint tiene que hacer siempre del
 * lado servidor.
 */

const assert = require('assert');
const { createPedidosHandler, GENERIC_ERROR_MESSAGE, MAX_ITEMS } = require('../api/pedidos');
const { PedidoStoreError } = require('../lib/padel-orders-store');
const { getProductById } = require('../lib/padel-catalog');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

// --- Productos reales usados en las pruebas ---------------------------
// (elegidos porque uno exige talle y el otro no; ver lib/padel-catalog.js)
const PRODUCT_SIN_TALLE = 'royal-padel-aniversario-36';
const PRODUCT_CON_TALLE = 'royal-padel-pollera-mallorca-negra';
const TALLE_VALIDO = 'M';

function assertProductosDePruebaExisten() {
  assert.ok(getProductById(PRODUCT_SIN_TALLE), `${PRODUCT_SIN_TALLE} debe existir en el catalogo real`);
  const conTalle = getProductById(PRODUCT_CON_TALLE);
  assert.ok(conTalle, `${PRODUCT_CON_TALLE} debe existir en el catalogo real`);
  assert.ok(Array.isArray(conTalle.talles) && conTalle.talles.indexOf(TALLE_VALIDO) !== -1);
}
assertProductosDePruebaExisten();

function compradorValido() {
  return { nombre: 'Juana', apellido: 'Perez' };
}
function contactoValido() {
  return { email: 'juana@example.com', telefono: '3411234567' };
}
function direccionValida() {
  return {
    provincia: 'Santa Fe',
    localidad: 'Rosario',
    codigoPostal: '2000',
    calle: 'San Martin',
    numero: '1234',
  };
}
function itemsValidos() {
  return [{ productId: PRODUCT_SIN_TALLE, cantidad: 1 }];
}
// Genera una idempotencyKey valida y distinta en cada llamada (formato:
// 16-100 caracteres [A-Za-z0-9_-], igual que
// lib/padel-orders-store.js#esIdempotencyKeyValida).
function idempotencyKeyValida() {
  return 'test-idem-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function bodyValido(overrides) {
  return Object.assign(
    {
      comprador: compradorValido(),
      contacto: contactoValido(),
      direccionEnvio: direccionValida(),
      items: itemsValidos(),
      idempotencyKey: idempotencyKeyValida(),
    },
    overrides || {}
  );
}

function createMockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function createMockReq({ method, contentType, body }) {
  return {
    method: method === undefined ? 'POST' : method,
    headers: { 'content-type': contentType === undefined ? 'application/json' : contentType },
    body: body,
  };
}

// crearPedido de prueba: registra cada llamada (spy) y, salvo que se
// configure lo contrario, devuelve un pedido "creado" con un numero fijo.
function createFakeCrearPedido(options) {
  const opts = options || {};
  const llamadas = [];
  async function fakeCrearPedido(input) {
    llamadas.push(input);
    if (opts.throwError) throw opts.throwError;
    return {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      numero: opts.numero || 'P10-000123',
      access_token: 'token-de-prueba-para-consulta-de-estado',
      payment_retry_token:
        opts.paymentRetryToken === undefined
          ? 'a'.repeat(64) // formato realista: 64 chars hex-like, ver lib/payment-retry-token.js
          : opts.paymentRetryToken,
    };
  }
  fakeCrearPedido.llamadas = llamadas;
  return fakeCrearPedido;
}

// crearPreferenciaParaPedido de prueba: por defecto simula un exito
// (como si Mercado Pago hubiera devuelto una preferencia sandbox valida),
// para que los tests existentes que no les importa la preferencia sigan
// viendo una respuesta realista. options.ok = false simula el caso en el
// que el pedido se crea pero la preferencia falla (ver seccion FALLOS del
// diseno: el pedido nunca se borra ni se marca como pagado).
function createFakeCrearPreferenciaParaPedido(options) {
  const opts = options || {};
  const llamadas = [];
  async function fakeCrearPreferenciaParaPedido(input) {
    llamadas.push(input);
    if (opts.throwError) throw opts.throwError;
    if (opts.ok === false) {
      return { ok: false, motivo: opts.motivo || 'mercado_pago' };
    }
    return { ok: true, checkoutUrl: opts.checkoutUrl || 'https://sandbox.mercadopago.com.ar/checkout/test-pref' };
  }
  fakeCrearPreferenciaParaPedido.llamadas = llamadas;
  return fakeCrearPreferenciaParaPedido;
}

function createFakeObtenerItemsPorPedido(options) {
  const opts = options || {};
  const llamadas = [];
  async function fakeObtenerItemsPorPedido(pedidoId) {
    llamadas.push(pedidoId);
    if (opts.throwError) throw opts.throwError;
    return opts.items || [
      { product_id: 'x', nombre: 'Producto de prueba', talle: null, cantidad: 1, precio_unitario: 100 },
    ];
  }
  fakeObtenerItemsPorPedido.llamadas = llamadas;
  return fakeObtenerItemsPorPedido;
}

function crearHandlerDePrueba(crearPedidoOverrides, extra) {
  const fakeCrearPedido = createFakeCrearPedido(crearPedidoOverrides);
  const ex = extra || {};
  const fakeCrearPreferenciaParaPedido = createFakeCrearPreferenciaParaPedido(ex.preferencia);
  const fakeObtenerItemsPorPedido = createFakeObtenerItemsPorPedido(ex.items);
  const handler = createPedidosHandler({
    crearPedido: fakeCrearPedido,
    getProductById,
    crearPreferenciaParaPedido: fakeCrearPreferenciaParaPedido,
    obtenerItemsPorPedido: fakeObtenerItemsPorPedido,
  });
  return { handler, fakeCrearPedido, fakeCrearPreferenciaParaPedido, fakeObtenerItemsPorPedido };
}

async function ejecutar(handler, reqOverrides) {
  const req = createMockReq(reqOverrides || {});
  const res = createMockRes();
  await handler(req, res);
  return res;
}

function testAsync(name, fn) {
  test(name, fn);
}

// --- metodo / content-type / tamano de body -----------------------------

testAsync('rechaza metodos distintos de POST', async () => {
  const { handler } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { method: 'GET', body: bodyValido() });
  assert.strictEqual(res.statusCode, 405);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

testAsync('rechaza Content-Type distinto de application/json', async () => {
  const { handler } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { contentType: 'text/plain', body: bodyValido() });
  assert.strictEqual(res.statusCode, 415);
});

testAsync('rechaza un body excesivamente grande', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ direccionEnvio: Object.assign(direccionValida(), { aclaraciones: 'x'.repeat(20000) }) });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 413);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

// --- allow-list: campos inesperados ------------------------------------

testAsync('rechaza campos inesperados en la raiz del body', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido({ notasAdmin: 'intento de manipulacion' }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza comprador.documento (no forma parte del contrato de esta etapa)', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ comprador: Object.assign(compradorValido(), { documento: '30111222' }) });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza direccionEnvio.pais enviado por el cliente', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ direccionEnvio: Object.assign(direccionValida(), { pais: 'Uruguay' }) });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza un item con precioUnitario manipulado por el cliente', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ items: [{ productId: PRODUCT_SIN_TALLE, cantidad: 1, precioUnitario: 1 }] });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza un item con nombre enviado por el cliente', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ items: [{ productId: PRODUCT_SIN_TALLE, cantidad: 1, nombre: 'Otro nombre' }] });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza un item con subtotal enviado por el cliente', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ items: [{ productId: PRODUCT_SIN_TALLE, cantidad: 1, subtotal: 1 }] });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza un "total" enviado manualmente por el cliente en la raiz del body', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido({ total: 1 }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza un "moneda" enviado manualmente por el cliente en la raiz del body', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido({ moneda: 'USD' }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

// --- idempotencyKey: obligatoria, formato estricto, se pasa a crearPedido --

testAsync('rechaza un body sin idempotencyKey', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido();
  delete body.idempotencyKey;
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza una idempotencyKey con formato invalido (demasiado corta)', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido({ idempotencyKey: 'corta' }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza una idempotencyKey con caracteres fuera del alfabeto permitido', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido({ idempotencyKey: 'clave con espacios!! invalidos aca' }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza una idempotencyKey que no sea string', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido({ idempotencyKey: 123456789012345678 }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('la idempotencyKey del body llega intacta al input de crearPedido', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const key = idempotencyKeyValida();
  const res = await ejecutar(handler, { body: bodyValido({ idempotencyKey: key }) });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(fakeCrearPedido.llamadas[0].idempotencyKey, key);
});

testAsync('un conflicto de idempotencia (CONFLICTO) responde 409, igual que cualquier otro PedidoStoreError CONFLICTO', async () => {
  const { handler } = crearHandlerDePrueba({
    throwError: new PedidoStoreError('CONFLICTO', 'idempotencyKey ya utilizada con otro contenido'),
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

// --- validacion de comprador/contacto/direccion (mismas reglas que el form) --

testAsync('rechaza nombre vacio', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ comprador: { nombre: '', apellido: 'Perez' } });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza apellido vacio', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ comprador: { nombre: 'Juana', apellido: '' } });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza email faltante (obligatorio)', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ contacto: { email: '', telefono: '3411234567' } });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza email invalido', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ contacto: { email: 'no-es-un-email', telefono: '3411234567' } });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza telefono faltante (obligatorio)', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ contacto: { email: 'juana@example.com', telefono: '' } });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza provincia vacia', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ direccionEnvio: Object.assign(direccionValida(), { provincia: '' }) });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza localidad vacia', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ direccionEnvio: Object.assign(direccionValida(), { localidad: '' }) });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza codigo postal vacio/invalido', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ direccionEnvio: Object.assign(direccionValida(), { codigoPostal: 'no-valido' }) });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza calle vacia', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ direccionEnvio: Object.assign(direccionValida(), { calle: '' }) });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza numero vacio', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ direccionEnvio: Object.assign(direccionValida(), { numero: '' }) });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('acepta piso/depto ausente (opcional)', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 1);
});

testAsync('acepta piso/depto y aclaraciones presentes (opcionales)', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({
    direccionEnvio: Object.assign(direccionValida(), { pisoDepto: '4to B', aclaraciones: 'Tocar timbre' }),
  });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 201);
  const inputRecibido = fakeCrearPedido.llamadas[0];
  assert.strictEqual(inputRecibido.direccionEnvio.piso_depto, '4to B');
  assert.strictEqual(inputRecibido.direccionEnvio.aclaraciones, 'Tocar timbre');
});

// --- carrito: productId inexistente / talle invalido / cantidad invalida ---

testAsync('rechaza productId inexistente y no crea el pedido', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ items: [{ productId: 'producto-que-no-existe', cantidad: 1 }] });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza talle invalido y no crea el pedido', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ items: [{ productId: PRODUCT_CON_TALLE, talle: 'XXXXL-no-existe', cantidad: 1 }] });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza un producto que exige talle si no se manda talle', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ items: [{ productId: PRODUCT_CON_TALLE, cantidad: 1 }] });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza cantidad invalida: cero', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ items: [{ productId: PRODUCT_SIN_TALLE, cantidad: 0 }] });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza cantidad invalida: negativa', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ items: [{ productId: PRODUCT_SIN_TALLE, cantidad: -3 }] });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza cantidad invalida: no entera', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ items: [{ productId: PRODUCT_SIN_TALLE, cantidad: 1.5 }] });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza cantidad invalida: excesiva (mayor al maximo por linea)', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({ items: [{ productId: PRODUCT_SIN_TALLE, cantidad: 999 }] });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza un carrito vacio', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido({ items: [] }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

testAsync('rechaza mas lineas de carrito que el maximo permitido', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const items = [];
  for (let i = 0; i < MAX_ITEMS + 1; i += 1) items.push({ productId: PRODUCT_SIN_TALLE, cantidad: 1 });
  const res = await ejecutar(handler, { body: bodyValido({ items }) });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

// --- atomicidad: una linea invalida entre varias validas ------------------

testAsync('una linea invalida dentro de un carrito con otras validas rechaza el pedido COMPLETO', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const body = bodyValido({
    items: [
      { productId: PRODUCT_SIN_TALLE, cantidad: 1 },
      { productId: 'producto-que-no-existe', cantidad: 1 },
    ],
  });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 400);
  // Ninguna linea se crea: crearPedido nunca se llega a invocar.
  assert.strictEqual(fakeCrearPedido.llamadas.length, 0);
});

// --- caso exitoso: multiples productos, precios recalculados server-side --

testAsync('pedido valido con multiples productos: 201 y numero de pedido', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba({ numero: 'P10-000777' });
  const body = bodyValido({
    items: [
      { productId: PRODUCT_SIN_TALLE, cantidad: 2 },
      { productId: PRODUCT_CON_TALLE, talle: TALLE_VALIDO, cantidad: 1 },
    ],
  });
  const res = await ejecutar(handler, { body });
  assert.strictEqual(res.statusCode, 201);
  assert.deepStrictEqual(res.body, {
    numero: 'P10-000777',
    redirectUrl: 'https://sandbox.mercadopago.com.ar/checkout/test-pref',
  });
  assert.strictEqual(fakeCrearPedido.llamadas.length, 1);
});

testAsync('el precio/nombre que llega a crearPedido siempre sale del catalogo real, nunca del body', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  const productoReal = getProductById(PRODUCT_SIN_TALLE);
  const body = bodyValido({ items: [{ productId: PRODUCT_SIN_TALLE, cantidad: 3 }] });
  await ejecutar(handler, { body });
  const inputRecibido = fakeCrearPedido.llamadas[0];
  assert.strictEqual(inputRecibido.items.length, 1);
  assert.strictEqual(inputRecibido.items[0].nombre, productoReal.nombre);
  assert.strictEqual(inputRecibido.items[0].precioUnitario, productoReal.precio);
  assert.strictEqual(inputRecibido.items[0].cantidad, 3);
});

testAsync('el comprador.nombre que llega a crearPedido combina nombre + apellido', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  await ejecutar(handler, { body: bodyValido({ comprador: { nombre: 'Juana', apellido: 'Perez' } }) });
  assert.strictEqual(fakeCrearPedido.llamadas[0].comprador.nombre, 'Juana Perez');
});

testAsync('la direccionEnvio que llega a crearPedido siempre tiene pais = Argentina', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba();
  await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(fakeCrearPedido.llamadas[0].direccionEnvio.pais, 'Argentina');
});

// --- respuesta: nunca expone el id interno ni el access_token -------------

testAsync('la respuesta de exito no contiene el id (uuid) interno del pedido', async () => {
  const { handler } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual('id' in res.body, false);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['numero', 'redirectUrl']);
});

testAsync('la respuesta de exito NUNCA incluye access_token ni accessToken (reservado para una futura consulta segura del estado del pedido, no viaja en la respuesta publica)', async () => {
  const { handler } = crearHandlerDePrueba();
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual('accessToken' in res.body, false);
  assert.strictEqual('access_token' in res.body, false);
});

// --- integracion con la creacion de la preferencia de Mercado Pago -------

testAsync('el pedido creado y sus items reales se le pasan a crearPreferenciaParaPedido', async () => {
  const items = [
    { product_id: PRODUCT_SIN_TALLE, nombre: 'Producto X', talle: null, cantidad: 2, precio_unitario: 50 },
  ];
  const { handler, fakeCrearPreferenciaParaPedido, fakeObtenerItemsPorPedido } = crearHandlerDePrueba(
    { numero: 'P10-000900' },
    { items: { items } }
  );
  await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(fakeObtenerItemsPorPedido.llamadas[0], 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.strictEqual(fakeCrearPreferenciaParaPedido.llamadas.length, 1);
  assert.strictEqual(fakeCrearPreferenciaParaPedido.llamadas[0].pedido.numero, 'P10-000900');
  assert.deepStrictEqual(fakeCrearPreferenciaParaPedido.llamadas[0].items, items);
});

testAsync('cuando la preferencia se crea bien, la respuesta incluye el checkoutUrl real', async () => {
  const { handler } = crearHandlerDePrueba(undefined, {
    preferencia: { ok: true, checkoutUrl: 'https://sandbox.mercadopago.com.ar/checkout/abc123' },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.redirectUrl, 'https://sandbox.mercadopago.com.ar/checkout/abc123');
});

testAsync('si Mercado Pago falla, el pedido igual se confirma (201) con checkoutUrl null y sin duplicarse', async () => {
  const { handler, fakeCrearPedido } = crearHandlerDePrueba(undefined, {
    preferencia: { ok: false, motivo: 'mercado_pago' },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(typeof res.body.numero, 'string');
  assert.strictEqual(res.body.redirectUrl, null);
  // El pedido se creo una unica vez: crearPreferenciaParaPedido fallando
  // no debe haber disparado un segundo intento de crearPedido.
  assert.strictEqual(fakeCrearPedido.llamadas.length, 1);
});

testAsync('si crearPreferenciaParaPedido tira una excepcion, la respuesta igual confirma el pedido', async () => {
  const { handler } = crearHandlerDePrueba(undefined, {
    preferencia: { throwError: new Error('mp_timeout') },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(typeof res.body.numero, 'string');
  assert.strictEqual(res.body.redirectUrl, null);
});

testAsync('si obtenerItemsPorPedido tira una excepcion, la respuesta igual confirma el pedido', async () => {
  const { handler } = crearHandlerDePrueba(undefined, {
    items: { throwError: new Error('db_down') },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(typeof res.body.numero, 'string');
  assert.strictEqual(res.body.redirectUrl, null);
});

// --- paymentRetryToken: solo se expone cuando hace falta (Etapa 3) --------

testAsync('si la preferencia inicial falla, la respuesta incluye paymentRetryToken para permitir un reintento', async () => {
  const { handler } = crearHandlerDePrueba(
    { paymentRetryToken: 'b'.repeat(64) },
    { preferencia: { ok: false, motivo: 'mercado_pago' } }
  );
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.redirectUrl, null);
  assert.strictEqual(res.body.paymentRetryToken, 'b'.repeat(64));
});

testAsync('cuando la preferencia inicial se crea bien, la respuesta NUNCA incluye paymentRetryToken (no hace falta reintentar)', async () => {
  const { handler } = crearHandlerDePrueba(undefined, {
    preferencia: { ok: true, checkoutUrl: 'https://sandbox.mercadopago.com.ar/checkout/abc123' },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.redirectUrl, 'https://sandbox.mercadopago.com.ar/checkout/abc123');
  assert.strictEqual('paymentRetryToken' in res.body, false);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['numero', 'redirectUrl']);
});

testAsync('la respuesta de exito nunca incluye el payment_retry_token en formato snake_case', async () => {
  const { handler } = crearHandlerDePrueba(undefined, {
    preferencia: { ok: false, motivo: 'mercado_pago' },
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual('payment_retry_token' in res.body, false);
});

// --- mapeo de errores de PedidoStoreError a HTTP genericos -----------------

testAsync('PedidoStoreError VALIDACION mapea a 400 generico', async () => {
  const { handler } = crearHandlerDePrueba({ throwError: new PedidoStoreError('VALIDACION', 'detalle interno sensible') });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

testAsync('PedidoStoreError CONFLICTO mapea a 409 generico', async () => {
  const { handler } = crearHandlerDePrueba({ throwError: new PedidoStoreError('CONFLICTO', 'detalle interno sensible') });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

testAsync('PedidoStoreError CONFIGURACION mapea a 500 generico', async () => {
  const { handler } = crearHandlerDePrueba({ throwError: new PedidoStoreError('CONFIGURACION', 'faltan variables de entorno SUPABASE_SECRET_KEY=xyz') });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(JSON.stringify(res.body).includes('SUPABASE_SECRET_KEY'), false);
});

testAsync('PedidoStoreError DB_ERROR mapea a 500 generico sin exponer la causa', async () => {
  const causaSensible = new Error('conexion rechazada por el servidor de Supabase en 10.0.0.5');
  const { handler } = crearHandlerDePrueba({
    throwError: new PedidoStoreError('DB_ERROR', 'error de base de datos', { cause: causaSensible }),
  });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(JSON.stringify(res.body).includes('10.0.0.5'), false);
});

testAsync('un error inesperado (no PedidoStoreError) tambien mapea a 500 generico', async () => {
  const { handler } = crearHandlerDePrueba({ throwError: new Error('boom inesperado') });
  const res = await ejecutar(handler, { body: bodyValido() });
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
});

// --- nada sensible en ningun mensaje de error -----------------------------

testAsync('ningun mensaje de error de esta suite revela detalles internos', async () => {
  const escenarios = [
    { method: 'GET' },
    { contentType: 'text/plain' },
    { body: bodyValido({ comprador: { nombre: '', apellido: '' } }) },
    { body: bodyValido({ items: [{ productId: 'no-existe', cantidad: 1 }] }) },
  ];
  const { handler } = crearHandlerDePrueba();
  for (const escenario of escenarios) {
    // eslint-disable-next-line no-await-in-loop
    const res = await ejecutar(handler, escenario);
    assert.deepStrictEqual(res.body, { error: GENERIC_ERROR_MESSAGE });
  }
});

// --- Runner --------------------------------------------------------------

async function run() {
  const resultados = [];
  for (const { name, fn } of results) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      resultados.push({ name, pass: true });
    } catch (error) {
      resultados.push({ name, pass: false, error: error.message });
    }
  }

  const failed = resultados.filter((r) => !r.pass);
  resultados.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
  });
  console.log('');
  console.log('Pruebas de api/pedidos.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
