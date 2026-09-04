'use strict';

/**
 * Pruebas de lib/payment-retry-token.js (Fase 3, Etapa 3).
 */

const assert = require('assert');
const {
  PAYMENT_RETRY_TOKEN_BYTES,
  generarPaymentRetryToken,
  esPaymentRetryTokenValido,
  hashPaymentRetryToken,
  truncarParaLog,
} = require('../lib/payment-retry-token');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

test('genera un token de 32 bytes (64 caracteres hex)', () => {
  assert.strictEqual(PAYMENT_RETRY_TOKEN_BYTES, 32);
  const token = generarPaymentRetryToken();
  assert.strictEqual(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);
});

test('dos tokens generados consecutivamente nunca son iguales', () => {
  const a = generarPaymentRetryToken();
  const b = generarPaymentRetryToken();
  assert.notStrictEqual(a, b);
});

test('el token nunca se deriva de un uuid ni de un numero de pedido (es randomness propia)', () => {
  const pedidoId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const numero = 'P10-000123';
  const token = generarPaymentRetryToken();
  assert.ok(!token.includes(pedidoId.replace(/-/g, '')));
  assert.ok(!token.toUpperCase().includes(numero.replace('P10-', '')));
});

test('esPaymentRetryTokenValido acepta solo el formato exacto: 64 hex minusculas', () => {
  assert.strictEqual(esPaymentRetryTokenValido(generarPaymentRetryToken()), true);
  assert.strictEqual(esPaymentRetryTokenValido('a'.repeat(64)), true);
  assert.strictEqual(esPaymentRetryTokenValido('A'.repeat(64)), false, 'mayusculas no son validas');
  assert.strictEqual(esPaymentRetryTokenValido('a'.repeat(63)), false, 'demasiado corto');
  assert.strictEqual(esPaymentRetryTokenValido('a'.repeat(65)), false, 'demasiado largo');
  assert.strictEqual(esPaymentRetryTokenValido('g'.repeat(64)), false, 'caracteres no hex');
  assert.strictEqual(esPaymentRetryTokenValido(''), false);
  assert.strictEqual(esPaymentRetryTokenValido(null), false);
  assert.strictEqual(esPaymentRetryTokenValido(undefined), false);
  assert.strictEqual(esPaymentRetryTokenValido(123), false);
  assert.strictEqual(esPaymentRetryTokenValido({}), false);
});

test('hashPaymentRetryToken es determinista: el mismo token siempre produce el mismo hash', () => {
  const token = generarPaymentRetryToken();
  const h1 = hashPaymentRetryToken(token);
  const h2 = hashPaymentRetryToken(token);
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1.length, 64);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('hashPaymentRetryToken produce un hash distinto para tokens distintos', () => {
  const h1 = hashPaymentRetryToken(generarPaymentRetryToken());
  const h2 = hashPaymentRetryToken(generarPaymentRetryToken());
  assert.notStrictEqual(h1, h2);
});

test('hashPaymentRetryToken nunca devuelve el token en claro', () => {
  const token = generarPaymentRetryToken();
  const hash = hashPaymentRetryToken(token);
  assert.notStrictEqual(hash, token);
});

test('hashPaymentRetryToken rechaza valores con formato invalido (nunca hashea silenciosamente basura)', () => {
  assert.throws(() => hashPaymentRetryToken('no-es-un-token-valido'), TypeError);
  assert.throws(() => hashPaymentRetryToken(''), TypeError);
  assert.throws(() => hashPaymentRetryToken(null), TypeError);
  assert.throws(() => hashPaymentRetryToken(undefined), TypeError);
});

test('truncarParaLog nunca expone el token completo', () => {
  const token = generarPaymentRetryToken();
  const truncado = truncarParaLog(token);
  assert.ok(!truncado.includes(token), 'el log truncado no debe contener el token completo');
  assert.ok(truncado.startsWith(token.slice(0, 8)));
});

test('truncarParaLog maneja valores vacios/invalidos sin lanzar', () => {
  assert.strictEqual(truncarParaLog(''), '(vacio)');
  assert.strictEqual(truncarParaLog(null), '(vacio)');
  assert.strictEqual(truncarParaLog(undefined), '(vacio)');
});

test('el token de reintento de pago es independiente del formato de access_token (mismo formato, distinto proposito)', () => {
  // Documenta la decision de diseno: mismo formato/entropia que
  // access_token (32 bytes hex), pero generado y usado de forma
  // completamente independiente (nunca se derivan uno del otro).
  const { generarAccessTokenSeguro } = require('../lib/padel-orders-store');
  const accessToken = generarAccessTokenSeguro();
  const paymentRetryToken = generarPaymentRetryToken();
  assert.strictEqual(accessToken.length, paymentRetryToken.length);
  assert.notStrictEqual(accessToken, paymentRetryToken);
});

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
  console.log('Pruebas de lib/payment-retry-token.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
