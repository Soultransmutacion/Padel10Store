'use strict';

/**
 * Pruebas ESTATICAS de la Etapa 1 de la solucion de idempotencia de
 * checkout (migracion 20260901120000_add_idempotencia_checkout.sql).
 *
 * Mismo criterio que tests/padel-orders-schema.test.js: no requieren
 * ninguna conexion a Supabase, leen directamente los archivos de
 * migracion SQL y el resto del repo. Esta etapa es SOLO esquema: verifica
 * tanto lo que la migracion agrega (columnas, constraints, RPC nueva)
 * como, explicitamente, que la RPC/columnas actuales sigan intactas y que
 * ningun archivo de aplicacion (api/pedidos.js, lib/padel-orders-store.js,
 * widget/padel-checkout.js) las use todavia.
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
const MIGRATION_FILE = '20260901120000_add_idempotencia_checkout.sql';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, MIGRATION_FILE);

function leerArchivo(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function quitarComentariosSql(sql) {
  return sql
    .split('\n')
    .map((linea) => linea.replace(/--.*$/, ''))
    .join('\n');
}

function leerTodasLasMigraciones() {
  const archivos = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const contenidos = archivos.map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  return { archivos, todo: contenidos.join('\n\n') };
}

// --- El archivo existe, esta bien nombrado y ordenado despues de los previos ---

test('la migracion de idempotencia existe con formato de nombre valido y ordena despues de las previas', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), `falta ${MIGRATION_FILE}`);
  assert.match(MIGRATION_FILE, /^\d{14}_[a-z0-9_]+\.sql$/);
  const { archivos } = leerTodasLasMigraciones();
  const idx = archivos.indexOf(MIGRATION_FILE);
  assert.ok(idx > -1);
  assert.ok(idx === archivos.length - 1, 'debe ser la migracion mas reciente (ultima en orden alfabetico/cronologico)');
});

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const sqlSinComentarios = quitarComentariosSql(sql);

// --- 1) + 3) Columnas nuevas, nullable ------------------------------------

test('agrega idempotency_key y checkout_fingerprint como columnas nullable (sin "not null")', () => {
  assert.match(sql, /alter table public\.pedidos\s+add column if not exists idempotency_key text;/i);
  assert.match(sql, /alter table public\.pedidos\s+add column if not exists checkout_fingerprint text;/i);
  // Ninguna de las dos se agrega como NOT NULL (deben ser nullable: los
  // pedidos existentes y los creados por la RPC vieja nunca las tienen).
  assert.ok(!/add column if not exists idempotency_key text not null/i.test(sql));
  assert.ok(!/add column if not exists checkout_fingerprint text not null/i.test(sql));
});

// --- 4) Formato y longitud -------------------------------------------------

test('idempotency_key tiene una constraint de formato/longitud (16-100, alfanumerico + guiones)', () => {
  assert.match(sql, /constraint chk_pedidos_idempotency_key_formato/i);
  assert.match(sqlSinComentarios, /char_length\(idempotency_key\) between 16 and 100/i);
  assert.match(sqlSinComentarios, /idempotency_key ~ '\^\[A-Za-z0-9_-\]\+\$'/);
});

test('checkout_fingerprint tiene una constraint de formato: exactamente un SHA-256 en hex (64 caracteres)', () => {
  assert.match(sql, /constraint chk_pedidos_checkout_fingerprint_formato/i);
  assert.match(sqlSinComentarios, /checkout_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test('ambas constraints de formato permiten NULL explicitamente (columnas opcionales)', () => {
  assert.match(sqlSinComentarios, /check\s*\(\s*idempotency_key is null/i);
  assert.match(sqlSinComentarios, /check\s*\(\s*checkout_fingerprint is null/i);
});

// --- 2) Restriccion unica ---------------------------------------------------

test('agrega una restriccion UNIQUE real sobre idempotency_key', () => {
  assert.match(sql, /constraint uq_pedidos_idempotency_key unique \(idempotency_key\)/i);
});

// --- 5) + 6) RPC nueva, con nombre distinto ---------------------------------

test('crea una RPC nueva "padel_crear_pedido_idempotente" (nombre distinto de la actual)', () => {
  assert.match(sql, /create or replace function public\.padel_crear_pedido_idempotente\s*\(/i);
});

test('la RPC nueva recibe idempotency_key y checkout_fingerprint ademas del contrato actual (13 parametros)', () => {
  const match = sql.match(/create or replace function public\.padel_crear_pedido_idempotente\s*\(([\s\S]*?)\)\s*\n\s*returns/i);
  assert.ok(match, 'no se encontro la lista de parametros de la RPC nueva');
  const parametros = match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'));
  // 11 parametros del contrato actual (incluido p_payment_retry_token_hash)
  // + p_idempotency_key + p_checkout_fingerprint = 13.
  assert.strictEqual(parametros.length, 13, `se esperaban 13 parametros, se encontraron ${parametros.length}`);
  assert.ok(parametros.some((l) => l.startsWith('p_idempotency_key')));
  assert.ok(parametros.some((l) => l.startsWith('p_checkout_fingerprint')));
  assert.ok(parametros.some((l) => l.startsWith('p_payment_retry_token_hash')));
});

test('resuelve la carrera de dos llamadas simultaneas con "insert ... on conflict (idempotency_key) do nothing"', () => {
  assert.match(sqlSinComentarios, /on conflict \(idempotency_key\) do nothing/i);
  assert.match(sqlSinComentarios, /returning \* into v_pedido/i);
});

test('en un reintento legitimo (mismo fingerprint) devuelve el pedido existente, sin duplicar items ni eventos', () => {
  // El insert de pedido_items y pedido_eventos debe estar DENTRO del
  // branch "v_pedido.id is not null" (solo cuando la insercion fue
  // nueva), nunca fuera de ese if.
  const cuerpoFuncion = sqlSinComentarios.match(
    /create or replace function public\.padel_crear_pedido_idempotente[\s\S]*?\$\$;/i
  );
  assert.ok(cuerpoFuncion, 'no se encontro el cuerpo de la funcion');
  const cuerpo = cuerpoFuncion[0];
  const idxIf = cuerpo.indexOf('if v_pedido.id is not null then');
  const idxInsertItems = cuerpo.indexOf('insert into public.pedido_items');
  const idxInsertEvento = cuerpo.indexOf('insert into public.pedido_eventos');
  const idxSelectExistente = cuerpo.indexOf('select * into v_existente');
  assert.ok(idxIf > -1, 'debe existir el chequeo "if v_pedido.id is not null"');
  assert.ok(idxInsertItems > idxIf, 'el insert de items debe estar despues del chequeo de insercion nueva');
  assert.ok(idxInsertEvento > idxIf, 'el insert de evento debe estar despues del chequeo de insercion nueva');
  assert.ok(idxSelectExistente > idxInsertEvento, 'la recuperacion del pedido existente debe ocurrir solo cuando NO hubo insercion nueva');
  assert.match(cuerpo, /return v_existente;/);
});

test('rechaza explicitamente (excepcion) si la misma clave llega con un fingerprint distinto, con un errcode propio', () => {
  assert.match(sqlSinComentarios, /checkout_fingerprint is distinct from p_checkout_fingerprint/i);
  assert.match(sqlSinComentarios, /idempotency_key ya utilizada con un contenido de checkout distinto/i);
  assert.match(sqlSinComentarios, /using errcode = 'P0002'/i);
});

test('exige idempotency_key y checkout_fingerprint (nunca los trata como opcionales dentro de la funcion)', () => {
  assert.match(sqlSinComentarios, /if p_idempotency_key is null or char_length\(p_idempotency_key\) = 0 then/i);
  assert.match(sqlSinComentarios, /if p_checkout_fingerprint is null or p_checkout_fingerprint !~ '\^\[0-9a-f\]\{64\}\$' then/i);
});

test('la RPC nueva valida el subtotal contra la suma de items, igual que la actual', () => {
  assert.match(sqlSinComentarios, /v_suma_items <> p_subtotal/i);
});

test('la funcion nueva usa search_path = public, extensions, igual que la actual', () => {
  const bloque = sql.match(/create or replace function public\.padel_crear_pedido_idempotente[\s\S]{0,700}/i);
  assert.ok(bloque);
  assert.match(bloque[0], /set search_path = public, extensions/i);
});

// --- 7) Mismos permisos que la RPC actual -----------------------------------

test('revoca EXECUTE de public/anon/authenticated para la RPC nueva', () => {
  assert.match(
    sqlSinComentarios,
    /revoke all on function public\.padel_crear_pedido_idempotente[\s\S]{0,400}from public, anon, authenticated/i
  );
});

// --- La RPC/columnas actuales quedan 100% intactas --------------------------

test('esta migracion NUNCA toca (drop/replace/alter) la RPC padel_crear_pedido actual', () => {
  assert.ok(
    !/create or replace function public\.padel_crear_pedido\s*\(/i.test(sql),
    'no debe recrear/reemplazar padel_crear_pedido'
  );
  assert.ok(!/drop function[\s\S]{0,50}padel_crear_pedido\s*\(/i.test(sql), 'no debe borrar padel_crear_pedido');
});

test('el conjunto completo de migraciones sigue teniendo exactamente una definicion de padel_crear_pedido vigente (la actual, de 11 parametros) ademas de la nueva', () => {
  const { todo } = leerTodasLasMigraciones();
  // "create or replace function public.padel_crear_pedido(" (sin el
  // sufijo "_idempotente") debe aparecer exactamente 2 veces en TODO el
  // historial (la version original de 10 parametros y la de 11 que la
  // reemplazo): esta migracion nueva no debe sumar una tercera.
  const matches = todo.match(/create or replace function public\.padel_crear_pedido\s*\(/gi) || [];
  assert.strictEqual(matches.length, 2, 'no debe haber una nueva definicion de padel_crear_pedido (sin _idempotente) en el historial');
});

test('no se define ninguna policy nueva ni se tocan los grants de las tablas (deny-by-default sigue intacto)', () => {
  assert.ok(!/create policy/i.test(sql));
  assert.ok(!/grant /i.test(sqlSinComentarios), 'esta migracion no deberia otorgar ningun permiso nuevo');
});

// --- Ningun archivo de aplicacion usa todavia lo nuevo ----------------------

test('api/pedidos.js, lib/padel-orders-store.js y widget/padel-checkout.js todavia NO referencian la RPC ni las columnas nuevas', () => {
  const archivos = ['api/pedidos.js', 'lib/padel-orders-store.js', 'widget/padel-checkout.js'];
  const patronesProhibidos = [
    'padel_crear_pedido_idempotente',
    'idempotency_key',
    'idempotencyKey',
    'checkout_fingerprint',
    'checkoutFingerprint',
  ];
  archivos.forEach((relPath) => {
    const contenido = leerArchivo(relPath);
    patronesProhibidos.forEach((patron) => {
      assert.ok(!contenido.includes(patron), `${relPath} no deberia referenciar "${patron}" todavia (Etapa 1 es solo esquema)`);
    });
  });
});

test('api/pedidos.js sigue usando exclusivamente crearPedido (la RPC actual), sin cambios de comportamiento', () => {
  const contenido = leerArchivo('api/pedidos.js');
  assert.match(contenido, /crearPedido: crearPedidoReal/);
});

// --- 8) Verificacion post-migracion documentada -----------------------------

test('incluye consultas de verificacion post-migracion, documentadas como no ejecutables', () => {
  assert.match(sql, /8\) Verificacion manual POST-aplicacion/);
  // Estas consultas viven a proposito DENTRO de comentarios SQL (para que
  // nunca se ejecuten como parte de la migracion): se buscan en el texto
  // crudo, no en sqlSinComentarios (que las quitaria a todas).
  assert.match(sql, /information_schema\.columns/);
  assert.match(sql, /pg_constraint/);
  assert.match(sql, /pg_get_function_identity_arguments/);
  assert.match(sql, /information_schema\.routine_privileges/);
});

// --- 9) Estrategia de rollback documentada, no ejecutada --------------------

test('incluye una estrategia de rollback documentada, comentada (nunca ejecutada por esta migracion)', () => {
  assert.match(sql, /9\) Estrategia de rollback/);
  // Las sentencias de rollback deben estar comentadas (prefijadas con --
  // dentro del propio texto), nunca como SQL activo.
  assert.match(sql, /-- -- drop function if exists public\.padel_crear_pedido_idempotente/);
  assert.match(sql, /-- -- alter table public\.pedidos drop constraint if exists uq_pedidos_idempotency_key;/);
  assert.match(sql, /-- -- alter table public\.pedidos drop column if exists idempotency_key;/);
  // Ninguna sentencia DROP activa (sin comentar) en todo el archivo.
  const lineasActivas = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'));
  const contenidoActivo = lineasActivas.join('\n');
  assert.ok(!/drop (function|column|constraint|table)/i.test(contenidoActivo), 'no debe haber ningun DROP activo (sin comentar) en la migracion');
});

// --- Advertencia explicita de "todavia no aplicada" -------------------------

test('el encabezado de la migracion advierte explicitamente que todavia no fue aplicada contra Supabase real', () => {
  assert.match(sql, /TODAVIA NO\s*\n?-- fue aplicada contra ningun proyecto Supabase real/i);
});

// --- package.json registra este archivo de test -----------------------------

test('package.json registra tests/idempotencia-checkout-schema.test.js en el script "test"', () => {
  const pkg = JSON.parse(leerArchivo('package.json'));
  assert.ok(pkg.scripts.test.includes('idempotencia-checkout-schema.test.js'));
});

// --- Runner --------------------------------------------------------------

function run() {
  const resultados = results.map(({ name, fn }) => {
    try {
      fn();
      return { name, pass: true };
    } catch (error) {
      return { name, pass: false, error: error.message };
    }
  });

  const failed = resultados.filter((r) => !r.pass);
  resultados.forEach((r) => {
    console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.error ? ' :: ' + r.error : ''));
  });
  console.log('');
  console.log('Pruebas estaticas de idempotencia de checkout (Etapa 1): ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
