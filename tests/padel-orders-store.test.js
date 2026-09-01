'use strict';

/**
 * Pruebas de lib/padel-orders-store.js (Fase 3, Etapa 1: base de datos +
 * modelo de pedidos).
 *
 * Estas pruebas NO se conectan a ningun Supabase real: usan un cliente
 * "fake" inyectable que reproduce, en memoria, el subconjunto de la API de
 * @supabase/supabase-js que usa lib/padel-orders-store.js (from().select()/
 * insert()/update()/eq()/order()/single()/maybeSingle() y rpc()), incluyendo
 * la logica de la funcion RPC padel_crear_pedido y las constraints UNIQUE
 * mas relevantes (access_token, mp_payment_id, proveedor+evento_id).
 *
 * El comportamiento transaccional real, la secuencia de Postgres para
 * "numero" y las demas constraints (CHECK, RLS) se verifican de forma
 * estatica en tests/padel-orders-schema.test.js (leyendo las migraciones
 * SQL) y, opcionalmente, contra un proyecto Supabase de Preview/Test real
 * en tests/padel-orders-store.integration.test.js (npm run test:integration).
 */

const assert = require('assert');
const crypto = require('crypto');

const store = require('../lib/padel-orders-store');

const {
  PedidoStoreError,
  ESTADOS_PAGO,
  ESTADOS_PEDIDO,
  crearPedido,
  obtenerPedidoPorId,
  obtenerPedidoPorAccessToken,
  obtenerItemsPorPedido,
  asociarPreferenceId,
  asociarPaymentId,
  actualizarEstadoPago,
  actualizarEstadoPedido,
  registrarEvento,
  obtenerEventosPorPedido,
  estaEventoWebhookProcesado,
  marcarEventoWebhookProcesado,
  generarAccessTokenSeguro,
  esUuidValido,
  getSupabaseAdminClient,
  resetSupabaseAdminClientForTests,
} = store;

const results = [];

function test(name, fn) {
  results.push({ name, fn });
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// --- Cliente Supabase "fake" (en memoria) ----------------------------------

function crearFakeSupabaseClient() {
  const db = {
    pedidos: [],
    pedido_items: [],
    pedido_eventos: [],
    webhook_eventos_procesados: [],
  };
  let numeroSeq = 0;

  function nextNumero() {
    numeroSeq += 1;
    return 'P10-' + String(numeroSeq).padStart(6, '0');
  }

  function crearFilaPedido(params, extra) {
    const pedido = Object.assign(
      {
        id: uuid(),
        numero: nextNumero(),
        access_token: params.p_access_token,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        comprador_nombre: params.p_comprador_nombre,
        comprador_email: params.p_comprador_email,
        comprador_telefono: params.p_comprador_telefono,
        comprador_documento: params.p_comprador_documento,
        envio_direccion: params.p_envio_direccion,
        subtotal: params.p_subtotal,
        total: params.p_total,
        moneda: params.p_moneda,
        estado_pago: 'pendiente',
        estado_pedido: 'pendiente_pago',
        mp_preference_id: null,
        mp_payment_id: null,
        mp_status_detail: null,
        payment_retry_token_hash:
          params.p_payment_retry_token_hash === undefined ? null : params.p_payment_retry_token_hash,
        idempotency_key: null,
        checkout_fingerprint: null,
        pagado_at: null,
        cancelado_at: null,
        notas_admin: null,
      },
      extra
    );

    db.pedidos.push(pedido);

    params.p_items.forEach((it) => {
      db.pedido_items.push(
        Object.assign({ id: uuid(), pedido_id: pedido.id, created_at: new Date().toISOString() }, it)
      );
    });

    db.pedido_eventos.push({
      id: uuid(),
      pedido_id: pedido.id,
      tipo: 'creacion',
      estado_pago_anterior: null,
      estado_pago_nuevo: pedido.estado_pago,
      estado_pedido_anterior: null,
      estado_pedido_nuevo: pedido.estado_pedido,
      metadata: { items_count: params.p_items.length },
      created_at: new Date().toISOString(),
    });

    return pedido;
  }

  async function rpc(fnName, params) {
    if (fnName !== 'padel_crear_pedido' && fnName !== 'padel_crear_pedido_idempotente') {
      return { data: null, error: { message: `rpc desconocida en fake: ${fnName}` } };
    }
    const idempotente = fnName === 'padel_crear_pedido_idempotente';

    const items = params.p_items;
    const sumaItems = items.reduce((acc, it) => acc + it.subtotal_linea, 0);
    if (Math.round(sumaItems * 100) !== Math.round(params.p_subtotal * 100)) {
      return {
        data: null,
        error: { code: 'P0001', message: 'el subtotal no coincide con la suma de los items' },
      };
    }

    if (idempotente) {
      if (typeof params.p_idempotency_key !== 'string' || !params.p_idempotency_key) {
        return { data: null, error: { code: 'P0001', message: 'se requiere idempotency_key' } };
      }
      if (typeof params.p_checkout_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(params.p_checkout_fingerprint)) {
        return { data: null, error: { code: 'P0001', message: 'checkout_fingerprint invalido' } };
      }

      // Emula "insert ... on conflict (idempotency_key) do nothing": si ya
      // existe una fila con esta clave, NO se crea nada nuevo (nunca se
      // duplican items/eventos); se devuelve la fila existente tal cual, o
      // se rechaza si el fingerprint no coincide.
      const existente = db.pedidos.find((p) => p.idempotency_key === params.p_idempotency_key);
      if (existente) {
        if (existente.checkout_fingerprint !== params.p_checkout_fingerprint) {
          return {
            data: null,
            error: {
              code: 'P0002',
              message: 'idempotency_key ya utilizada con un contenido de checkout distinto',
            },
          };
        }
        return { data: Object.assign({}, existente), error: null };
      }
    }

    if (db.pedidos.some((p) => p.access_token === params.p_access_token)) {
      return {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      };
    }

    const pedido = crearFilaPedido(
      params,
      idempotente
        ? { idempotency_key: params.p_idempotency_key, checkout_fingerprint: params.p_checkout_fingerprint }
        : {}
    );

    return { data: Object.assign({}, pedido), error: null };
  }

  function makeBuilder(table, mode, payload) {
    const filters = [];
    let orderSpec = null;
    let wantSingle = false;
    let wantMaybeSingle = false;

    const builder = {
      eq(col, val) {
        filters.push([col, val]);
        return builder;
      },
      is(col, val) {
        filters.push([col, val]);
        return builder;
      },
      order(col, opts) {
        orderSpec = { col, ascending: !opts || opts.ascending !== false };
        return builder;
      },
      select() {
        return builder;
      },
      single() {
        wantSingle = true;
        return builder;
      },
      maybeSingle() {
        wantMaybeSingle = true;
        return builder;
      },
      then(resolve, reject) {
        return execute().then(resolve, reject);
      },
    };

    async function execute() {
      try {
        if (mode === 'insert') {
          const row = Object.assign({ id: uuid(), created_at: new Date().toISOString() }, payload);
          if (table === 'webhook_eventos_procesados') {
            const dup = db.webhook_eventos_procesados.some(
              (r) => r.proveedor === row.proveedor && r.evento_id === row.evento_id
            );
            if (dup) {
              return {
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
              };
            }
          }
          db[table].push(row);
          return { data: wantSingle || wantMaybeSingle ? row : [row], error: null };
        }

        if (mode === 'update') {
          let target = db[table];
          filters.forEach(([col, val]) => {
            target = target.filter((r) => r[col] === val);
          });
          if (target.length === 0) {
            return { data: wantSingle || wantMaybeSingle ? null : [], error: null };
          }
          if (table === 'pedidos' && payload.mp_payment_id) {
            const dup = db.pedidos.some(
              (p) => !target.includes(p) && p.mp_payment_id === payload.mp_payment_id
            );
            if (dup) {
              return {
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
              };
            }
          }
          target.forEach((r) => Object.assign(r, payload, { updated_at: new Date().toISOString() }));
          return { data: wantSingle ? target[0] : target, error: null };
        }

        // select
        let result = db[table];
        filters.forEach(([col, val]) => {
          result = result.filter((r) => r[col] === val);
        });
        if (orderSpec) {
          result = result.slice().sort((a, b) => {
            if (a[orderSpec.col] < b[orderSpec.col]) return orderSpec.ascending ? -1 : 1;
            if (a[orderSpec.col] > b[orderSpec.col]) return orderSpec.ascending ? 1 : -1;
            return 0;
          });
        }
        if (wantSingle) return { data: result[0] || null, error: null };
        if (wantMaybeSingle) return { data: result[0] || null, error: null };
        return { data: result, error: null };
      } catch (err) {
        return { data: null, error: err };
      }
    }

    return builder;
  }

  return {
    _db: db,
    rpc,
    from(table) {
      return {
        select() {
          return makeBuilder(table, 'select');
        },
        insert(row) {
          return makeBuilder(table, 'insert', row);
        },
        update(patch) {
          return makeBuilder(table, 'update', patch);
        },
      };
    },
  };
}

// --- Helpers de prueba -------------------------------------------------

function direccionValida(extra) {
  return Object.assign(
    { calle: 'Av. Siempre Viva 742', ciudad: 'Rosario', provincia: 'Santa Fe', codigo_postal: 'S2000', pais: 'Argentina' },
    extra
  );
}

// Genera una idempotencyKey fresca y aleatoria en cada llamada: asegura que
// cada crearPedidoDePrueba()/pedidoInputValido() por defecto represente una
// intencion de compra DISTINTA (nunca un reintento de la anterior), que es
// lo que la inmensa mayoria de las pruebas de este archivo necesitan (por
// ejemplo, las que esperan varios pedidos/numeros distintos). Las pruebas
// que especificamente quieren ejercitar la idempotencia pasan su propia
// idempotencyKey (la misma en mas de un llamado) via el parametro extra.
function idempotencyKeyDePrueba() {
  return 'idem-' + crypto.randomBytes(16).toString('hex');
}

function pedidoInputValido(extra) {
  return Object.assign(
    {
      comprador: { nombre: 'Juana Perez' },
      contacto: { email: 'juana@example.com' },
      direccionEnvio: direccionValida(),
      items: [{ productId: 'royal-padel-cross-black-26', nombre: 'Royal Padel Cross Black 26', talle: 'M', cantidad: 2, precioUnitario: 1000 }],
      idempotencyKey: idempotencyKeyDePrueba(),
    },
    extra
  );
}

async function crearPedidoDePrueba(client, extra) {
  return crearPedido(pedidoInputValido(extra), client);
}

async function withEnv(vars, fn) {
  const previous = {};
  Object.keys(vars).forEach((key) => {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  });
  resetSupabaseAdminClientForTests();
  try {
    await fn();
  } finally {
    Object.keys(previous).forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
    resetSupabaseAdminClientForTests();
  }
}

async function assertRejectsConCodigo(promiseFactory, code) {
  let capturado = null;
  try {
    await promiseFactory();
  } catch (err) {
    capturado = err;
  }
  assert.ok(capturado instanceof PedidoStoreError, 'se esperaba un PedidoStoreError');
  assert.strictEqual(capturado.code, code);
}

// --- Modelo valido / UUID / access token ---------------------------------

test('crea un pedido valido con un id UUID no enumerable y numero legible P10-000001', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);
  assert.ok(esUuidValido(pedido.id));
  assert.strictEqual(pedido.numero, 'P10-000001');
  assert.match(pedido.numero, /^P10-[0-9]{6,}$/);
});

test('el numero de pedido es unico y se incrementa por cada pedido creado (nunca MAX+1 en JS)', async () => {
  const client = crearFakeSupabaseClient();
  const p1 = await crearPedidoDePrueba(client);
  const p2 = await crearPedidoDePrueba(client);
  const p3 = await crearPedidoDePrueba(client);
  assert.strictEqual(p1.numero, 'P10-000001');
  assert.strictEqual(p2.numero, 'P10-000002');
  assert.strictEqual(p3.numero, 'P10-000003');
  const numeros = new Set([p1.numero, p2.numero, p3.numero]);
  assert.strictEqual(numeros.size, 3);
});

test('genera access tokens seguros: largos, hexadecimales, unicos y no derivados del id/numero', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);

  assert.strictEqual(pedido.access_token.length, 64);
  assert.match(pedido.access_token, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(pedido.access_token, pedido.id);
  assert.notStrictEqual(pedido.access_token, pedido.numero);
  assert.ok(!pedido.access_token.includes(pedido.id.replace(/-/g, '')));

  const tokens = new Set();
  for (let i = 0; i < 200; i += 1) {
    tokens.add(generarAccessTokenSeguro());
  }
  assert.strictEqual(tokens.size, 200, 'los tokens generados deben ser unicos');
});

test('access token generado usa crypto.randomBytes (CSPRNG), no Math.random', () => {
  const original = crypto.randomBytes;
  let llamado = false;
  crypto.randomBytes = function fake(n) {
    llamado = true;
    return original(n);
  };
  try {
    generarAccessTokenSeguro();
  } finally {
    crypto.randomBytes = original;
  }
  assert.strictEqual(llamado, true);
});

// --- Items, snapshot de precios, cantidades, talle nullable ---------------

test('un pedido con multiples items guarda el snapshot de nombre/precio y las relaciones pedido_id', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedido(
    pedidoInputValido({
      items: [
        { productId: 'a', nombre: 'Pala A', talle: '38', cantidad: 2, precioUnitario: 1500.5 },
        { productId: 'b', nombre: 'Pala B', cantidad: 1, precioUnitario: 999.99 },
      ],
    }),
    client
  );

  const items = client._db.pedido_items.filter((it) => it.pedido_id === pedido.id);
  assert.strictEqual(items.length, 2);
  items.forEach((it) => assert.strictEqual(it.pedido_id, pedido.id));

  const itemA = items.find((it) => it.product_id === 'a');
  assert.strictEqual(itemA.nombre, 'Pala A');
  assert.strictEqual(itemA.talle, '38');
  assert.strictEqual(itemA.cantidad, 2);
  assert.strictEqual(itemA.precio_unitario, 1500.5);
  assert.strictEqual(itemA.subtotal_linea, 3001);

  const itemB = items.find((it) => it.product_id === 'b');
  assert.strictEqual(itemB.talle, null, 'talle debe ser nullable cuando el producto no tiene variante');
});

test('el subtotal del pedido es la suma exacta del snapshot de items', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedido(
    pedidoInputValido({
      items: [
        { productId: 'a', nombre: 'Pala A', cantidad: 2, precioUnitario: 100 },
        { productId: 'b', nombre: 'Pala B', cantidad: 3, precioUnitario: 50 },
      ],
    }),
    client
  );
  assert.strictEqual(pedido.subtotal, 350);
  assert.strictEqual(pedido.total, 350);
});

test('total explicito distinto del subtotal (ej. con envio) se respeta', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client, { total: 2500 });
  assert.strictEqual(pedido.subtotal, 2000);
  assert.strictEqual(pedido.total, 2500);
});

test('rechaza cantidad invalida (cero, negativa, no entera o excesiva)', async () => {
  const client = crearFakeSupabaseClient();
  for (const cantidad of [0, -1, 1.5, 101]) {
    await assertRejectsConCodigo(
      () => crearPedido(pedidoInputValido({ items: [{ productId: 'a', nombre: 'Pala', cantidad, precioUnitario: 10 }] }), client),
      'VALIDACION'
    );
  }
});

test('rechaza precioUnitario invalido (negativo o no numerico)', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ items: [{ productId: 'a', nombre: 'Pala', cantidad: 1, precioUnitario: -5 }] }), client),
    'VALIDACION'
  );
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ items: [{ productId: 'a', nombre: 'Pala', cantidad: 1, precioUnitario: 'gratis' }] }), client),
    'VALIDACION'
  );
});

// --- Campos obligatorios / datos demasiado largos o invalidos -------------

test('rechaza pedidos sin items', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(() => crearPedido(pedidoInputValido({ items: [] }), client), 'VALIDACION');
});

test('rechaza comprador.nombre faltante o vacio', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ comprador: { nombre: '' } }), client),
    'VALIDACION'
  );
});

test('rechaza comprador.nombre demasiado largo', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ comprador: { nombre: 'x'.repeat(201) } }), client),
    'VALIDACION'
  );
});

test('rechaza contacto.email invalido o demasiado largo', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ contacto: { email: 'no-es-un-email' } }), client),
    'VALIDACION'
  );
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ contacto: { email: `${'x'.repeat(315)}@a.com` } }), client),
    'VALIDACION'
  );
});

test('rechaza direccionEnvio con claves faltantes', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ direccionEnvio: direccionValida({ calle: '' }) }), client),
    'VALIDACION'
  );
  await assertRejectsConCodigo(() => {
    const input = pedidoInputValido();
    delete input.direccionEnvio.pais;
    return crearPedido(input, client);
  }, 'VALIDACION');
});

test('rechaza moneda fuera de la lista permitida (no se aceptan strings arbitrarios)', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(() => crearPedido(pedidoInputValido({ moneda: 'USD' }), client), 'VALIDACION');
});

test('rechaza item.productId o item.nombre vacios / demasiado largos', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ items: [{ productId: '', nombre: 'Pala', cantidad: 1, precioUnitario: 10 }] }), client),
    'VALIDACION'
  );
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ items: [{ productId: 'a', nombre: 'x'.repeat(301), cantidad: 1, precioUnitario: 10 }] }), client),
    'VALIDACION'
  );
});

// --- Estados validos / invalidos -------------------------------------------

test('ESTADOS_PAGO y ESTADOS_PEDIDO exponen exactamente los valores acordados', () => {
  assert.deepStrictEqual(ESTADOS_PAGO, ['pendiente', 'aprobado', 'rechazado', 'cancelado', 'reembolsado']);
  assert.deepStrictEqual(ESTADOS_PEDIDO, [
    'pendiente_pago', 'a_preparar', 'enviado', 'entregado', 'cancelado', 'expirado',
  ]);
});

test('actualizarEstadoPago acepta un estado valido y setea pagado_at solo al aprobar', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);
  assert.strictEqual(pedido.pagado_at, null);

  const actualizado = await actualizarEstadoPago(pedido.id, 'aprobado', {}, client);
  assert.strictEqual(actualizado.estado_pago, 'aprobado');
  assert.ok(actualizado.pagado_at);

  const segundaVez = await actualizarEstadoPago(pedido.id, 'aprobado', {}, client);
  assert.strictEqual(segundaVez.pagado_at, actualizado.pagado_at, 'pagado_at no debe reescribirse');
});

test('actualizarEstadoPago rechaza un estado que no existe', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);
  await assertRejectsConCodigo(() => actualizarEstadoPago(pedido.id, 'pagado_con_bitcoin', {}, client), 'VALIDACION');
});

test('actualizarEstadoPedido acepta un estado valido y setea cancelado_at solo al cancelar', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);

  const enPreparacion = await actualizarEstadoPedido(pedido.id, 'a_preparar', {}, client);
  assert.strictEqual(enPreparacion.estado_pedido, 'a_preparar');
  assert.strictEqual(enPreparacion.cancelado_at, null);

  const cancelado = await actualizarEstadoPedido(pedido.id, 'cancelado', { motivo: 'stock agotado' }, client);
  assert.strictEqual(cancelado.estado_pedido, 'cancelado');
  assert.ok(cancelado.cancelado_at);
});

test('actualizarEstadoPedido rechaza un estado que no existe', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);
  await assertRejectsConCodigo(() => actualizarEstadoPedido(pedido.id, 'perdido_en_el_correo', {}, client), 'VALIDACION');
});

// --- Asociacion de preference / payment id ----------------------------------

test('asociarPreferenceId guarda el mp_preference_id y registra un evento', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);
  const actualizado = await asociarPreferenceId(pedido.id, 'pref-123', client);
  assert.strictEqual(actualizado.mp_preference_id, 'pref-123');

  const eventos = await obtenerEventosPorPedido(pedido.id, client);
  assert.ok(eventos.some((e) => e.tipo === 'asociacion_preference'));
});

test('asociarPaymentId guarda el mp_payment_id y registra un evento', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);
  const actualizado = await asociarPaymentId(pedido.id, 'pay-999', client);
  assert.strictEqual(actualizado.mp_payment_id, 'pay-999');

  const eventos = await obtenerEventosPorPedido(pedido.id, client);
  assert.ok(eventos.some((e) => e.tipo === 'asociacion_payment'));
});

test('mp_payment_id es unico: no se puede asociar el mismo pago a dos pedidos', async () => {
  const client = crearFakeSupabaseClient();
  const pedidoA = await crearPedidoDePrueba(client);
  const pedidoB = await crearPedidoDePrueba(client);

  await asociarPaymentId(pedidoA.id, 'pay-duplicado', client);
  await assertRejectsConCodigo(() => asociarPaymentId(pedidoB.id, 'pay-duplicado', client), 'CONFLICTO');
});

test('asociarPaymentId/asociarPreferenceId rechazan un pedidoId con formato invalido', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(() => asociarPaymentId('no-es-un-uuid', 'pay-1', client), 'VALIDACION');
  await assertRejectsConCodigo(() => asociarPreferenceId('no-es-un-uuid', 'pref-1', client), 'VALIDACION');
});

// --- Lecturas: por id, por access token, no encontrado ----------------------

test('obtenerPedidoPorId y obtenerPedidoPorAccessToken devuelven el mismo pedido', async () => {
  const client = crearFakeSupabaseClient();
  const creado = await crearPedidoDePrueba(client);
  const porId = await obtenerPedidoPorId(creado.id, client);
  const porToken = await obtenerPedidoPorAccessToken(creado.access_token, client);
  assert.strictEqual(porId.id, creado.id);
  assert.strictEqual(porToken.id, creado.id);
});

test('obtenerPedidoPorId lanza NO_ENCONTRADO para un uuid que no existe', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(() => obtenerPedidoPorId(uuid(), client), 'NO_ENCONTRADO');
});

test('obtenerPedidoPorAccessToken lanza NO_ENCONTRADO para un token que no existe', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(() => obtenerPedidoPorAccessToken('a'.repeat(64), client), 'NO_ENCONTRADO');
});

// --- Eventos -----------------------------------------------------------

test('registrarEvento valida el tipo y guarda la transicion de estados', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);
  const evento = await registrarEvento(
    { pedidoId: pedido.id, tipo: 'nota_admin', metadata: { nota: 'reintentar envio' } },
    client
  );
  assert.strictEqual(evento.tipo, 'nota_admin');

  await assertRejectsConCodigo(
    () => registrarEvento({ pedidoId: pedido.id, tipo: 'tipo_inventado' }, client),
    'VALIDACION'
  );
});

test('registrarEvento rechaza metadata demasiado grande (nunca payloads completos)', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);
  const metadataEnorme = { payload: 'x'.repeat(5000) };
  await assertRejectsConCodigo(
    () => registrarEvento({ pedidoId: pedido.id, tipo: 'otro', metadata: metadataEnorme }, client),
    'VALIDACION'
  );
});

test('obtenerEventosPorPedido devuelve los eventos ordenados cronologicamente', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);
  await actualizarEstadoPago(pedido.id, 'aprobado', {}, client);
  await actualizarEstadoPedido(pedido.id, 'a_preparar', {}, client);

  const eventos = await obtenerEventosPorPedido(pedido.id, client);
  assert.strictEqual(eventos.length, 3); // creacion + cambio_estado_pago + cambio_estado_pedido
  assert.strictEqual(eventos[0].tipo, 'creacion');
  const tipos = eventos.map((e) => e.tipo);
  assert.deepStrictEqual(tipos, ['creacion', 'cambio_estado_pago', 'cambio_estado_pedido']);
});

// --- Idempotencia futura del webhook ----------------------------------

test('estaEventoWebhookProcesado devuelve false hasta que se marca como procesado', async () => {
  const client = crearFakeSupabaseClient();
  const yaProcesado = await estaEventoWebhookProcesado('mercadopago', 'evt-1', client);
  assert.strictEqual(yaProcesado, false);

  await marcarEventoWebhookProcesado({ proveedor: 'mercadopago', eventoId: 'evt-1' }, client);
  const ahoraSi = await estaEventoWebhookProcesado('mercadopago', 'evt-1', client);
  assert.strictEqual(ahoraSi, true);
});

test('marcarEventoWebhookProcesado es idempotente: el mismo evento_id no se puede procesar dos veces', async () => {
  const client = crearFakeSupabaseClient();
  await marcarEventoWebhookProcesado({ proveedor: 'mercadopago', eventoId: 'evt-dup' }, client);
  await assertRejectsConCodigo(
    () => marcarEventoWebhookProcesado({ proveedor: 'mercadopago', eventoId: 'evt-dup' }, client),
    'CONFLICTO'
  );
});

test('marcarEventoWebhookProcesado rechaza un proveedor que no sea mercadopago', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(
    () => marcarEventoWebhookProcesado({ proveedor: 'stripe', eventoId: 'evt-1' }, client),
    'VALIDACION'
  );
});

// --- Configuracion / credenciales nunca expuestas -----------------------

test('getSupabaseAdminClient lanza CONFIGURACION si faltan las variables de entorno', async () => {
  await withEnv({ SUPABASE_URL: undefined, SUPABASE_SECRET_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    await assertRejectsConCodigo(async () => getSupabaseAdminClient(), 'CONFIGURACION');
  });
});

test('getSupabaseAdminClient acepta SUPABASE_SERVICE_ROLE_KEY como alias legado de SUPABASE_SECRET_KEY', async () => {
  await withEnv(
    { SUPABASE_URL: 'https://ejemplo.supabase.co', SUPABASE_SECRET_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: 'clave-legada-de-prueba' },
    async () => {
      const client = getSupabaseAdminClient();
      assert.ok(client);
    }
  );
});

test('ninguna credencial sensible (secret key) aparece en errores, logs ni valores devueltos', async () => {
  const secretoDePrueba = 'sb_secret_super_ultra_confidencial_12345';
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));

  try {
    await withEnv({ SUPABASE_URL: 'https://ejemplo.supabase.co', SUPABASE_SECRET_KEY: secretoDePrueba }, async () => {
      const client = getSupabaseAdminClient();
      assert.ok(client);
      // El cliente no debe traer la key en ninguna propiedad enumerable superficial.
      const serializado = JSON.stringify(Object.keys(client));
      assert.ok(!serializado.includes(secretoDePrueba));
    });

    // Tambien se ejercitan rutas de error tipicas para confirmar que el
    // mensaje nunca incluye la key.
    let errorCapturado = null;
    try {
      await obtenerPedidoPorId('no-es-un-uuid');
    } catch (err) {
      errorCapturado = err;
    }
    assert.ok(errorCapturado);
    assert.ok(!String(errorCapturado.message).includes(secretoDePrueba));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  const salidaCompleta = logs.join('\n');
  assert.ok(!salidaCompleta.includes(secretoDePrueba), 'la secret key nunca debe aparecer en logs');
});

// --- Idempotencia de checkout (Fase 3, Etapa 2) --------------------------

test('esIdempotencyKeyValida acepta solo el formato esperado (16-100 caracteres, [A-Za-z0-9_-])', async () => {
  assert.strictEqual(store.esIdempotencyKeyValida('a'.repeat(16)), true);
  assert.strictEqual(store.esIdempotencyKeyValida('a'.repeat(100)), true);
  assert.strictEqual(store.esIdempotencyKeyValida('0123456789abcdef-_ABC'), true);
  assert.strictEqual(store.esIdempotencyKeyValida('a'.repeat(15)), false);
  assert.strictEqual(store.esIdempotencyKeyValida('a'.repeat(101)), false);
  assert.strictEqual(store.esIdempotencyKeyValida('clave con espacios inv'), false);
  assert.strictEqual(store.esIdempotencyKeyValida(''), false);
  assert.strictEqual(store.esIdempotencyKeyValida(null), false);
  assert.strictEqual(store.esIdempotencyKeyValida(undefined), false);
  assert.strictEqual(store.esIdempotencyKeyValida(12345), false);
});

test('crearPedido rechaza una idempotencyKey faltante o con formato invalido', async () => {
  const client = crearFakeSupabaseClient();
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ idempotencyKey: undefined }), client),
    'VALIDACION'
  );
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ idempotencyKey: 'demasiado-corta' }), client),
    'VALIDACION'
  );
  await assertRejectsConCodigo(
    () => crearPedido(pedidoInputValido({ idempotencyKey: 'clave con espacios invalidos!!' }), client),
    'VALIDACION'
  );
});

test('crearPedido: la misma idempotencyKey con el mismo contenido devuelve el MISMO pedido, sin duplicar items ni eventos', async () => {
  const client = crearFakeSupabaseClient();
  const key = idempotencyKeyDePrueba();

  const primero = await crearPedidoDePrueba(client, { idempotencyKey: key });
  const segundo = await crearPedidoDePrueba(client, { idempotencyKey: key });

  assert.strictEqual(segundo.id, primero.id);
  assert.strictEqual(segundo.numero, primero.numero);
  assert.strictEqual(client._db.pedidos.length, 1, 'no debe crear un segundo pedido');

  const items = await obtenerItemsPorPedido(primero.id, client);
  assert.strictEqual(items.length, 1, 'no debe duplicar items (1 linea por defecto en pedidoInputValido)');

  const eventos = await obtenerEventosPorPedido(primero.id, client);
  assert.strictEqual(
    eventos.filter((e) => e.tipo === 'creacion').length,
    1,
    'no debe duplicar el evento de creacion'
  );
});

test('crearPedido: el payment_retry_token en claro solo se devuelve en la insercion NUEVA, nunca en un reintento idempotente', async () => {
  const client = crearFakeSupabaseClient();
  const key = idempotencyKeyDePrueba();

  const primero = await crearPedidoDePrueba(client, { idempotencyKey: key });
  assert.strictEqual(typeof primero.payment_retry_token, 'string');
  assert.match(primero.payment_retry_token, /^[0-9a-f]{64}$/);

  const segundo = await crearPedidoDePrueba(client, { idempotencyKey: key });
  assert.strictEqual(segundo.payment_retry_token, undefined);
});

test('crearPedido: la misma idempotencyKey con contenido distinto se rechaza (CONFLICTO), sin tocar el pedido existente', async () => {
  const client = crearFakeSupabaseClient();
  const key = idempotencyKeyDePrueba();

  const primero = await crearPedidoDePrueba(client, { idempotencyKey: key });

  await assertRejectsConCodigo(
    () =>
      crearPedido(
        pedidoInputValido({
          idempotencyKey: key,
          comprador: { nombre: 'Otra Persona Completamente Distinta' },
        }),
        client
      ),
    'CONFLICTO'
  );

  // El pedido original sigue exactamente igual: no se creo un segundo
  // pedido ni se modifico el existente.
  assert.strictEqual(client._db.pedidos.length, 1);
  const releido = await obtenerPedidoPorId(primero.id, client);
  assert.strictEqual(releido.comprador_nombre, 'Juana Perez');
});

test('crearPedido: dos llamadas con la misma clave (simulando concurrencia) resuelven al mismo pedido via el indice unico simulado', async () => {
  const client = crearFakeSupabaseClient();
  const key = idempotencyKeyDePrueba();

  const [a, b] = await Promise.all([
    crearPedidoDePrueba(client, { idempotencyKey: key }),
    crearPedidoDePrueba(client, { idempotencyKey: key }),
  ]);

  assert.strictEqual(a.id, b.id);
  assert.strictEqual(client._db.pedidos.length, 1);
});

test('asociarPreferenceId: dos llamadas para el mismo pedido con preferencias distintas nunca se pisan entre si (la primera gana)', async () => {
  const client = crearFakeSupabaseClient();
  const pedido = await crearPedidoDePrueba(client);

  const primeraAsociacion = await asociarPreferenceId(pedido.id, 'pref-primera', client);
  assert.strictEqual(primeraAsociacion.mp_preference_id, 'pref-primera');

  // La "segunda llamada" (por ejemplo, un reintento concurrente que ya
  // habia creado su propia preferencia en Mercado Pago antes de enterarse
  // de que ya existia una) nunca sobreescribe la ganadora: relee el estado
  // actual y lo devuelve tal cual.
  const segundaAsociacion = await asociarPreferenceId(pedido.id, 'pref-segunda', client);
  assert.strictEqual(segundaAsociacion.mp_preference_id, 'pref-primera');

  const releido = await obtenerPedidoPorId(pedido.id, client);
  assert.strictEqual(releido.mp_preference_id, 'pref-primera');

  // Solo se registro UN evento de asociacion de preferencia (el de la
  // llamada que efectivamente escribio).
  const eventos = await obtenerEventosPorPedido(pedido.id, client);
  assert.strictEqual(eventos.filter((e) => e.tipo === 'asociacion_preference').length, 1);
});

// --- Runner ------------------------------------------------------------

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
  console.log('Pruebas de lib/padel-orders-store.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
