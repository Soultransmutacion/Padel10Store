'use strict';

/**
 * Pruebas ESTATICAS del esquema de base de datos de pedidos (Fase 3,
 * Etapa 1). No requieren ninguna conexion a Supabase: leen directamente
 * los archivos de migracion SQL, package.json, .env.example y el resto
 * del repo para verificar propiedades estructurales y de seguridad que
 * no dependen de tener una base real levantada.
 *
 * Esto permite que CI se mantenga reproducible sin secretos productivos
 * (ver README de la migracion y npm run test:integration para las pruebas
 * que si requieren un proyecto Supabase de Preview/Test real).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

function quitarComentariosSql(sql) {
  // Quita comentarios de linea ("-- ...") para que las busquedas de
  // anti-patrones no matcheen texto explicativo que menciona ese
  // anti-patron justamente para decir que no debe usarse.
  return sql
    .split('\n')
    .map((linea) => linea.replace(/--.*$/, ''))
    .join('\n');
}

function leerMigraciones() {
  const archivos = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const contenidos = archivos.map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  return {
    archivos,
    contenidos,
    todo: contenidos.join('\n\n'),
    todoSinComentarios: quitarComentariosSql(contenidos.join('\n\n')),
  };
}

function leerArchivo(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function listarArchivosRecursivo(dir) {
  const salida = [];
  if (!fs.existsSync(dir)) return salida;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) salida.push(...listarArchivosRecursivo(full));
    else salida.push(full);
  }
  return salida;
}

// --- Migraciones presentes y ordenadas -------------------------------------

test('existen las 6 migraciones esperadas para la Etapa 1, con timestamps ordenados', () => {
  const { archivos } = leerMigraciones();
  assert.ok(archivos.length >= 6, `se esperaban al menos 6 migraciones, hay ${archivos.length}`);
  archivos.forEach((f) => assert.match(f, /^\d{14}_[a-z0-9_]+\.sql$/));
  const ordenados = [...archivos].sort();
  assert.deepStrictEqual(archivos, ordenados, 'los archivos deben poder aplicarse en orden alfabetico/cronologico');
});

test('las 4 tablas de la auditoria estan definidas: pedidos, pedido_items, pedido_eventos, webhook_eventos_procesados', () => {
  const { todo } = leerMigraciones();
  ['pedidos', 'pedido_items', 'pedido_eventos', 'webhook_eventos_procesados'].forEach((tabla) => {
    assert.match(
      todo,
      new RegExp(`create table if not exists public\\.${tabla}`, 'i'),
      `falta CREATE TABLE para ${tabla}`
    );
  });
});

test('todavia NO se crea admin_usuarios (se implementara junto con Supabase Auth)', () => {
  const { todo } = leerMigraciones();
  assert.ok(!/admin_usuarios/i.test(todo), 'admin_usuarios no debe existir todavia en esta etapa');
});

// --- Numero de pedido: secuencia de Postgres, nunca MAX()+1 en JS ---------

test('el numero de pedido se genera con una secuencia/identity de Postgres, no con MAX(numero)+1', () => {
  const { todo, todoSinComentarios } = leerMigraciones();
  assert.match(todo, /create sequence if not exists public\.pedidos_numero_seq/i);
  assert.match(todo, /nextval\(\s*'public\.pedidos_numero_seq'\s*\)/i);
  assert.ok(
    !/max\s*\(\s*numero\s*\)/i.test(todoSinComentarios),
    'no debe usarse MAX(numero) como codigo SQL real (fuera de comentarios explicativos)'
  );

  const storeSrc = leerArchivo('lib/padel-orders-store.js');
  assert.ok(!/max\s*\(\s*numero\s*\)/i.test(storeSrc), 'no debe calcularse MAX(numero)+1 desde JavaScript');
  // El numero nunca se pasa como parametro RPC desde JS: se genera 100% en Postgres.
  assert.ok(!/p_numero/i.test(storeSrc), 'el numero de pedido no debe generarse ni pasarse desde JS');
});

test('el numero de pedido tiene el formato P10-XXXXXX validado por constraint', () => {
  const { todo } = leerMigraciones();
  assert.match(todo, /chk_pedidos_numero_formato[\s\S]{0,80}numero\s*~\s*'\^P10-\[0-9\]\{6,\}\$'/i);
});

// --- Access token: aleatorio, seguro, no derivado de id/numero -------------

test('el access_token se genera con pgcrypto (gen_random_bytes), nunca a partir de id o numero', () => {
  const { todo } = leerMigraciones();
  assert.match(todo, /create extension if not exists pgcrypto/i);

  const columnaMatch = todo.match(/access_token text not null unique\s*\n?\s*default ([^,\n]+)/i);
  assert.ok(columnaMatch, 'no se encontro el DEFAULT de access_token');
  const defaultExpr = columnaMatch[1];
  assert.match(defaultExpr, /gen_random_bytes/i);
  assert.ok(!/\bid\b/i.test(defaultExpr), 'el DEFAULT de access_token no debe referenciar la columna id');
  assert.ok(!/\bnumero\b/i.test(defaultExpr), 'el DEFAULT de access_token no debe referenciar la columna numero');

  const storeSrc = leerArchivo('lib/padel-orders-store.js');
  assert.match(storeSrc, /crypto\.randomBytes\(ACCESS_TOKEN_BYTES\)/);
});

test('access_token tiene una longitud minima exigida por constraint (no adivinable)', () => {
  const { todo } = leerMigraciones();
  assert.match(todo, /chk_pedidos_access_token_longitud[\s\S]{0,80}char_length\(access_token\)\s*>=\s*40/i);
});

// --- Estados: CHECK constraints cerrados, sin strings arbitrarios ----------

test('estado_pago tiene una CHECK constraint con exactamente los 5 valores acordados', () => {
  const { todo } = leerMigraciones();
  const match = todo.match(/chk_pedidos_estado_pago_valido check \(\s*estado_pago in \(([^)]+)\)/i);
  assert.ok(match, 'no se encontro la constraint de estado_pago');
  const valores = match[1].split(',').map((v) => v.trim().replace(/'/g, ''));
  assert.deepStrictEqual(valores, ['pendiente', 'aprobado', 'rechazado', 'cancelado', 'reembolsado']);
});

test('estado_pedido tiene una CHECK constraint con exactamente los 6 valores acordados', () => {
  const { todo } = leerMigraciones();
  const match = todo.match(/chk_pedidos_estado_pedido_valido check \(\s*estado_pedido in \(([^)]+)\)/i);
  assert.ok(match, 'no se encontro la constraint de estado_pedido');
  const valores = match[1].split(',').map((v) => v.trim().replace(/'/g, ''));
  assert.deepStrictEqual(valores, [
    'pendiente_pago', 'a_preparar', 'enviado', 'entregado', 'cancelado', 'expirado',
  ]);
});

test('las constantes ESTADOS_PAGO/ESTADOS_PEDIDO de la capa de datos coinciden con las constraints SQL', () => {
  const { todo } = leerMigraciones();
  const store = require('../lib/padel-orders-store');

  const pagoSql = todo
    .match(/chk_pedidos_estado_pago_valido check \(\s*estado_pago in \(([^)]+)\)/i)[1]
    .split(',')
    .map((v) => v.trim().replace(/'/g, ''));
  const pedidoSql = todo
    .match(/chk_pedidos_estado_pedido_valido check \(\s*estado_pedido in \(([^)]+)\)/i)[1]
    .split(',')
    .map((v) => v.trim().replace(/'/g, ''));

  assert.deepStrictEqual(store.ESTADOS_PAGO, pagoSql);
  assert.deepStrictEqual(store.ESTADOS_PEDIDO, pedidoSql);
});

// --- pedido_items: relaciones, snapshot, cantidades ------------------------

test('pedido_items referencia a pedidos con ON DELETE CASCADE y valida cantidad > 0', () => {
  const { todo } = leerMigraciones();
  assert.match(todo, /pedido_id uuid not null references public\.pedidos \(id\) on delete cascade/i);
  assert.match(todo, /chk_pedido_items_cantidad_valida[\s\S]{0,80}cantidad > 0 and cantidad <= 100/i);
});

test('pedido_items exige que subtotal_linea coincida con precio_unitario * cantidad', () => {
  const { todo } = leerMigraciones();
  assert.match(
    todo,
    /chk_pedido_items_subtotal_coincide[\s\S]{0,100}subtotal_linea = round\(precio_unitario \* cantidad, 2\)/i
  );
});

test('pedido_items permite talle nulo (variante opcional)', () => {
  const { todo } = leerMigraciones();
  assert.match(todo, /talle text,/);
  assert.ok(!/talle text not null/i.test(todo), 'talle no debe ser NOT NULL');
});

// --- webhook_eventos_procesados: idempotencia ------------------------------

test('webhook_eventos_procesados tiene una UNIQUE constraint sobre (proveedor, evento_id)', () => {
  const { todo } = leerMigraciones();
  assert.match(
    todo,
    /uq_webhook_eventos_proveedor_evento unique \(\s*proveedor\s*,\s*evento_id\s*\)/i
  );
});

// --- pedido_eventos: metadata acotada, nunca payloads completos -----------

test('pedido_eventos y webhook_eventos_procesados acotan el tamano de metadata (nunca payloads completos)', () => {
  const { todo } = leerMigraciones();
  const ocurrencias = todo.match(/pg_column_size\(metadata\)\s*<=\s*4000/gi) || [];
  assert.ok(ocurrencias.length >= 2, 'se espera la constraint de tamano de metadata en ambas tablas');
});

// --- Seguridad: RLS deny-by-default, sin policies, revocado de grants -----

test('las 4 tablas de pedidos tienen RLS habilitada (ENABLE + FORCE ROW LEVEL SECURITY)', () => {
  const { todo } = leerMigraciones();
  ['pedidos', 'pedido_items', 'pedido_eventos', 'webhook_eventos_procesados'].forEach((tabla) => {
    assert.match(todo, new RegExp(`alter table public\\.${tabla} enable row level security`, 'i'));
    assert.match(todo, new RegExp(`alter table public\\.${tabla} force row level security`, 'i'));
  });
});

test('deny by default: ninguna migracion define policies, y se revocan los grants a anon/authenticated', () => {
  const { todo } = leerMigraciones();
  assert.ok(!/create policy/i.test(todo), 'no debe existir ninguna policy: el acceso publico va por endpoint + access_token, no por RLS todavia');
  ['pedidos', 'pedido_items', 'pedido_eventos', 'webhook_eventos_procesados'].forEach((tabla) => {
    assert.match(
      todo,
      new RegExp(`revoke all on public\\.${tabla} from anon, authenticated`, 'i')
    );
  });
});

test('la funcion RPC de creacion de pedidos revoca EXECUTE de public/anon/authenticated', () => {
  const { todo } = leerMigraciones();
  assert.match(
    todo,
    /revoke all on function public\.padel_crear_pedido[\s\S]{0,300}from public, anon, authenticated/i
  );
});

test('la RPC de creacion valida atomicamente que el subtotal coincida con la suma de los items', () => {
  const { todo } = leerMigraciones();
  assert.match(todo, /v_suma_items <> p_subtotal/i);
});

// --- Dependencias y variables de entorno -----------------------------------

test('@supabase/supabase-js esta pinneado a una version exacta (sin ^ ni ~), igual que jsdom', () => {
  const pkg = JSON.parse(leerArchivo('package.json'));
  const version = pkg.dependencies['@supabase/supabase-js'];
  assert.ok(version, 'falta la dependencia @supabase/supabase-js');
  assert.ok(!/^[\^~]/.test(version), `la version deberia estar pinneada exacta, se encontro "${version}"`);
});

test('.env.example documenta SUPABASE_URL y SUPABASE_SECRET_KEY sin valores reales', () => {
  const env = leerArchivo('.env.example');
  assert.match(env, /^SUPABASE_URL=\s*$/m);
  assert.match(env, /^SUPABASE_SECRET_KEY=\s*$/m);
  // Ninguna linea de .env.example debe tener un valor no vacio despues del "=".
  env.split('\n').forEach((linea) => {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) return;
    const match = limpia.match(/^[A-Z0-9_]+=(.*)$/);
    if (match) {
      assert.strictEqual(match[1].trim(), '', `.env.example no debe tener valores reales: "${linea}"`);
    }
  });
});

// --- La capa de datos nunca se expone al frontend / endpoints todavia -----

test('ningun archivo de widget/ ni index.html referencia la capa de datos de pedidos ni sus variables de entorno', () => {
  const archivosCliente = [
    ...listarArchivosRecursivo(path.join(ROOT, 'widget')),
    path.join(ROOT, 'index.html'),
  ].filter((f) => fs.existsSync(f));

  const patronesProhibidos = [
    'padel-orders-store',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'padel_crear_pedido',
  ];

  archivosCliente.forEach((archivo) => {
    const contenido = fs.readFileSync(archivo, 'utf8');
    patronesProhibidos.forEach((patron) => {
      assert.ok(
        !contenido.includes(patron),
        `${path.relative(ROOT, archivo)} no deberia referenciar "${patron}" todavia`
      );
    });
  });
});

// Nota (Fase 3, Etapa 2): esta prueba originalmente tambien exigia que NO
// existiera ningun endpoint de pedidos ("api/pedidos.js"), porque la Etapa
// 1 todavia no lo exponia a proposito. La Etapa 2 (formulario de comprador
// y datos de envio, aprobada explicitamente por el usuario) agrega ese
// endpoint como parte de su alcance -ver docs/etapa3-etapa2-formulario-envio.md
// y tests/api-pedidos.test.js-, asi que esa parte de la prueba quedo
// obsoleta y se actualizo. El webhook de Mercado Pago SIGUE fuera de
// alcance (no se toca Mercado Pago en la Etapa 2), asi que esa parte se
// mantiene igual.
test('el webhook de Mercado Pago todavia no existe (fuera de alcance de esta etapa)', () => {
  const archivosApi = fs.existsSync(path.join(ROOT, 'api'))
    ? fs.readdirSync(path.join(ROOT, 'api'))
    : [];
  archivosApi.forEach((f) => {
    assert.ok(!/webhook/i.test(f), `el webhook no se implementa todavia: api/${f}`);
  });
});

test('no hay carpeta admin/ ni referencias a Supabase Auth todavia', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'admin')), 'el panel /admin no se implementa en esta etapa');
  const pkg = JSON.parse(leerArchivo('package.json'));
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  assert.ok(!deps['@supabase/auth-helpers-nextjs'] && !deps['@supabase/auth-ui-react'], 'Supabase Auth no se agrega en esta etapa');
});

// --- Mantener los 378 tests previos + no romper npm test -------------------

test('package.json sigue registrando todos los archivos de test previos en el script "test"', () => {
  const pkg = JSON.parse(leerArchivo('package.json'));
  const testScript = pkg.scripts.test;
  [
    'padel-cart.test.js',
    'padel-cart-integration.test.js',
    'padel-advisor.test.js',
    'padel-advisor-cart.test.js',
    'padel-comparator.test.js',
    'padel-comparison-card.test.js',
    'padel-comparison-render.test.js',
    'padel-profile.test.js',
    'padel-recommender.test.js',
    'padel-chooser.test.js',
    'mercadopago-preference.test.js',
    'padel-orders-store.test.js',
    'padel-orders-schema.test.js',
  ].forEach((archivo) => {
    assert.ok(testScript.includes(archivo), `falta tests/${archivo} en npm run test`);
  });
  assert.ok(
    !testScript.includes('padel-orders-store.integration.test.js'),
    'el test de integracion con DB real no debe formar parte de npm test (CI no debe depender de secretos productivos)'
  );
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
  console.log('Pruebas estaticas del esquema de pedidos: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
