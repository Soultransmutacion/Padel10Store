'use strict';

/**
 * Pruebas de INTEGRACION de lib/padel-orders-store.js contra un proyecto
 * Supabase real.
 *
 * Estas pruebas son OPCIONALES a proposito y NO forman parte de
 * `npm test` / del gate obligatorio de CI: requieren un proyecto Supabase
 * de Preview/Test dedicado (nunca el productivo) y credenciales reales,
 * que este repo no incluye ni inventa.
 *
 * Como correrlas:
 *   1. Crear (o reutilizar) un proyecto Supabase de Preview/Test.
 *   2. Aplicar las migraciones de supabase/migrations/ contra ese
 *      proyecto (`supabase link --project-ref <ref>` + `supabase db push`).
 *   3. Definir SUPABASE_TEST_URL y SUPABASE_TEST_SECRET_KEY (ver
 *      .env.example) apuntando a ESE proyecto de test, nunca al
 *      productivo.
 *   4. Correr `npm run test:integration`.
 *
 * Sin esas dos variables de entorno, este archivo se salta por completo
 * (exit code 0) para no romper CI ni bloquear a nadie que no tenga un
 * proyecto Supabase provisionado todavia.
 *
 * IMPORTANTE: estas pruebas no fueron ejecutadas contra un Supabase real
 * como parte de esta entrega (no existe todavia un proyecto provisionado).
 * Quedan listas para correr en cuanto exista uno; revisarlas con cuidado
 * la primera vez que se ejecuten de verdad.
 */

const assert = require('assert');

const SUPABASE_TEST_URL = process.env.SUPABASE_TEST_URL;
const SUPABASE_TEST_SECRET_KEY = process.env.SUPABASE_TEST_SECRET_KEY;

if (!SUPABASE_TEST_URL || !SUPABASE_TEST_SECRET_KEY) {
  console.log(
    'SKIP - tests/padel-orders-store.integration.test.js: faltan SUPABASE_TEST_URL / ' +
      'SUPABASE_TEST_SECRET_KEY. Estas pruebas requieren un proyecto Supabase de ' +
      'Preview/Test dedicado y son opcionales (no forman parte de npm test). ' +
      'Ver el encabezado de este archivo para instrucciones.'
  );
  process.exit(0);
}

process.env.SUPABASE_URL = SUPABASE_TEST_URL;
process.env.SUPABASE_SECRET_KEY = SUPABASE_TEST_SECRET_KEY;

const store = require('../lib/padel-orders-store');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

const pedidosCreadosParaLimpiar = [];

function direccionValida() {
  return {
    calle: 'Av. Siempre Viva 742',
    ciudad: 'Rosario',
    provincia: 'Santa Fe',
    codigo_postal: 'S2000',
    pais: 'Argentina',
  };
}

function inputPedidoDePrueba() {
  return {
    comprador: { nombre: 'Test Integracion Padel10Store' },
    contacto: { email: 'integracion-test@example.com' },
    direccionEnvio: direccionValida(),
    items: [
      { productId: 'test-integracion-item', nombre: 'Item de prueba de integracion', cantidad: 1, precioUnitario: 1 },
    ],
  };
}

test('crearPedido persiste un pedido real con numero P10-XXXXXX generado por Postgres', async () => {
  const pedido = await store.crearPedido(inputPedidoDePrueba());
  pedidosCreadosParaLimpiar.push(pedido.id);
  assert.match(pedido.numero, /^P10-[0-9]{6,}$/);
  assert.ok(store.esUuidValido(pedido.id));
  assert.strictEqual(pedido.access_token.length, 64);
});

test('dos pedidos creados en secuencia obtienen numeros distintos y crecientes', async () => {
  const p1 = await store.crearPedido(inputPedidoDePrueba());
  const p2 = await store.crearPedido(inputPedidoDePrueba());
  pedidosCreadosParaLimpiar.push(p1.id, p2.id);
  const n1 = parseInt(p1.numero.replace('P10-', ''), 10);
  const n2 = parseInt(p2.numero.replace('P10-', ''), 10);
  assert.ok(n2 > n1);
});

test('obtenerPedidoPorId y obtenerPedidoPorAccessToken leen desde la base real', async () => {
  const creado = await store.crearPedido(inputPedidoDePrueba());
  pedidosCreadosParaLimpiar.push(creado.id);
  const porId = await store.obtenerPedidoPorId(creado.id);
  const porToken = await store.obtenerPedidoPorAccessToken(creado.access_token);
  assert.strictEqual(porId.id, creado.id);
  assert.strictEqual(porToken.id, creado.id);
});

test('asociarPaymentId respeta la constraint UNIQUE real de la base ante un duplicado', async () => {
  const a = await store.crearPedido(inputPedidoDePrueba());
  const b = await store.crearPedido(inputPedidoDePrueba());
  pedidosCreadosParaLimpiar.push(a.id, b.id);

  const paymentId = `test-integracion-pay-${Date.now()}`;
  await store.asociarPaymentId(a.id, paymentId);

  let error = null;
  try {
    await store.asociarPaymentId(b.id, paymentId);
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof store.PedidoStoreError);
  assert.strictEqual(error.code, 'CONFLICTO');
});

test('actualizarEstadoPago / actualizarEstadoPedido persisten transiciones reales', async () => {
  const pedido = await store.crearPedido(inputPedidoDePrueba());
  pedidosCreadosParaLimpiar.push(pedido.id);

  const aprobado = await store.actualizarEstadoPago(pedido.id, 'aprobado');
  assert.strictEqual(aprobado.estado_pago, 'aprobado');
  assert.ok(aprobado.pagado_at);

  const enPreparacion = await store.actualizarEstadoPedido(pedido.id, 'a_preparar');
  assert.strictEqual(enPreparacion.estado_pedido, 'a_preparar');

  const eventos = await store.obtenerEventosPorPedido(pedido.id);
  assert.ok(eventos.length >= 3);
});

test('idempotencia real de webhooks: el segundo marcado del mismo evento_id falla por UNIQUE', async () => {
  const eventoId = `test-integracion-evt-${Date.now()}`;
  await store.marcarEventoWebhookProcesado({ proveedor: 'mercadopago', eventoId });

  let error = null;
  try {
    await store.marcarEventoWebhookProcesado({ proveedor: 'mercadopago', eventoId });
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof store.PedidoStoreError);
  assert.strictEqual(error.code, 'CONFLICTO');

  const yaProcesado = await store.estaEventoWebhookProcesado('mercadopago', eventoId);
  assert.strictEqual(yaProcesado, true);
});

async function limpiar() {
  if (pedidosCreadosParaLimpiar.length === 0) return;
  try {
    const client = store.getSupabaseAdminClient();
    for (const id of pedidosCreadosParaLimpiar) {
      // eslint-disable-next-line no-await-in-loop
      await client.from('pedidos').delete().eq('id', id);
    }
  } catch (err) {
    console.log('AVISO: no se pudieron limpiar todos los pedidos de prueba: ' + err.message);
  }
}

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

  await limpiar();

  const failed = resultados.filter((r) => !r.pass);
  resultados.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
  });
  console.log('');
  console.log(
    'Pruebas de integracion (Supabase real): ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK'
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
