'use strict';

/**
 * Pruebas de lib/padel-checkout-fields.js (Fase 3, Etapa 2: formulario de
 * comprador y datos de envio).
 *
 * Estas pruebas no tocan Supabase ni ninguna red: solo ejercitan las
 * funciones puras de validacion/armado de datos que despues comparten
 * widget/padel-checkout.js (navegador) y api/pedidos.js (servidor).
 */

const assert = require('assert');
const fields = require('../lib/padel-checkout-fields');
const ordersStore = require('../lib/padel-orders-store');

const {
  LIMITES,
  validarComprador,
  validarContacto,
  validarDireccion,
  validarFormularioCheckout,
  construirNombreCompleto,
  construirDireccionParaPedido,
  PAIS_FIJO,
} = fields;

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

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

// --- comprador: nombre / apellido ------------------------------------------

test('comprador valido pasa la validacion', () => {
  assert.strictEqual(validarComprador(compradorValido()).ok, true);
});

test('nombre vacio se rechaza', () => {
  const r = validarComprador({ nombre: '', apellido: 'Perez' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'nombre');
});

test('nombre solo espacios se rechaza', () => {
  const r = validarComprador({ nombre: '   ', apellido: 'Perez' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'nombre');
});

test('nombre faltante (undefined) se rechaza', () => {
  const r = validarComprador({ apellido: 'Perez' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'nombre');
});

test('apellido vacio se rechaza', () => {
  const r = validarComprador({ nombre: 'Juana', apellido: '' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'apellido');
});

test('apellido faltante (undefined) se rechaza', () => {
  const r = validarComprador({ nombre: 'Juana' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'apellido');
});

test('nombre demasiado largo se rechaza', () => {
  const r = validarComprador({ nombre: 'a'.repeat(LIMITES.nombre + 1), apellido: 'Perez' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'nombre');
});

test('nombre + apellido combinados que superan el maximo del pedido se rechazan', () => {
  const r = validarComprador({ nombre: 'a'.repeat(LIMITES.nombre), apellido: 'b'.repeat(LIMITES.apellido) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'nombre_completo_demasiado_largo');
});

// --- contacto: email / telefono ---------------------------------------------

test('contacto valido pasa la validacion', () => {
  assert.strictEqual(validarContacto(contactoValido()).ok, true);
});

test('email faltante (obligatorio) se rechaza', () => {
  const r = validarContacto({ telefono: '3411234567' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'email');
});

test('email vacio se rechaza', () => {
  const r = validarContacto({ email: '', telefono: '3411234567' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'email');
});

test('email sin arroba se rechaza', () => {
  const r = validarContacto({ email: 'juana-arroba-example.com', telefono: '3411234567' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'email');
});

test('email sin dominio se rechaza', () => {
  const r = validarContacto({ email: 'juana@', telefono: '3411234567' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'email');
});

test('email con espacios se rechaza', () => {
  const r = validarContacto({ email: 'juana perez@example.com', telefono: '3411234567' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'email');
});

test('telefono faltante (obligatorio) se rechaza', () => {
  const r = validarContacto({ email: 'juana@example.com' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'telefono');
});

test('telefono vacio se rechaza', () => {
  const r = validarContacto({ email: 'juana@example.com', telefono: '' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'telefono');
});

// --- direccion: provincia / localidad / CP / calle / numero / opcionales ---

test('direccion valida pasa la validacion', () => {
  assert.strictEqual(validarDireccion(direccionValida()).ok, true);
});

test('provincia vacia se rechaza', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { provincia: '' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'provincia');
});

test('localidad vacia se rechaza', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { localidad: '' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'localidad');
});

test('codigo postal vacio se rechaza', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { codigoPostal: '' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'codigoPostal');
});

test('codigo postal con formato invalido se rechaza', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { codigoPostal: 'abc' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'codigoPostal');
});

test('codigo postal clasico de 4 digitos es valido', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { codigoPostal: '2000' }));
  assert.strictEqual(r.ok, true);
});

test('codigo postal formato CPA de 8 caracteres es valido', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { codigoPostal: 'C1425DJP' }));
  assert.strictEqual(r.ok, true);
});

test('calle vacia se rechaza', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { calle: '' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'calle');
});

test('numero vacio se rechaza', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { numero: '' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'numero');
});

test('numero faltante (undefined) se rechaza', () => {
  const d = direccionValida();
  delete d.numero;
  const r = validarDireccion(d);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'numero');
});

test('piso/depto ausente es valido (opcional)', () => {
  const r = validarDireccion(direccionValida());
  assert.strictEqual(r.ok, true);
});

test('piso/depto presente y valido es aceptado', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { pisoDepto: '4to B' }));
  assert.strictEqual(r.ok, true);
});

test('piso/depto demasiado largo se rechaza', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { pisoDepto: 'x'.repeat(LIMITES.pisoDepto + 1) }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'pisoDepto');
});

test('aclaraciones ausentes es valido (opcional)', () => {
  const r = validarDireccion(direccionValida());
  assert.strictEqual(r.ok, true);
});

test('aclaraciones presentes y validas son aceptadas', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { aclaraciones: 'Tocar timbre 2 veces' }));
  assert.strictEqual(r.ok, true);
});

test('aclaraciones demasiado largas se rechazan', () => {
  const r = validarDireccion(Object.assign(direccionValida(), { aclaraciones: 'x'.repeat(LIMITES.aclaraciones + 1) }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'aclaraciones');
});

// --- formulario completo: orden de validacion --------------------------

test('validarFormularioCheckout OK con los 3 bloques validos', () => {
  const r = validarFormularioCheckout({
    comprador: compradorValido(),
    contacto: contactoValido(),
    direccionEnvio: direccionValida(),
  });
  assert.strictEqual(r.ok, true);
});

test('validarFormularioCheckout devuelve el primer error (comprador antes que contacto)', () => {
  const r = validarFormularioCheckout({
    comprador: { nombre: '', apellido: 'Perez' },
    contacto: { email: '', telefono: '' },
    direccionEnvio: direccionValida(),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'nombre');
});

test('validarFormularioCheckout devuelve el primer error (contacto antes que direccion)', () => {
  const r = validarFormularioCheckout({
    comprador: compradorValido(),
    contacto: { email: '', telefono: '' },
    direccionEnvio: {},
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campo, 'email');
});

// --- construccion del payload real para crearPedido() -------------------

test('construirNombreCompleto concatena nombre y apellido con un solo espacio', () => {
  assert.strictEqual(construirNombreCompleto({ nombre: 'Juana', apellido: 'Perez' }), 'Juana Perez');
});

test('construirNombreCompleto recorta espacios de mas en los extremos', () => {
  assert.strictEqual(construirNombreCompleto({ nombre: '  Juana  ', apellido: '  Perez  ' }), 'Juana Perez');
});

test('construirDireccionParaPedido mapea localidad -> ciudad y codigoPostal -> codigo_postal', () => {
  const out = construirDireccionParaPedido(direccionValida());
  assert.strictEqual(out.ciudad, 'Rosario');
  assert.strictEqual(out.codigo_postal, '2000');
  assert.strictEqual(out.calle, 'San Martin');
  assert.strictEqual(out.numero, '1234');
  assert.strictEqual(out.provincia, 'Santa Fe');
});

test('construirDireccionParaPedido siempre fija pais = Argentina', () => {
  const out = construirDireccionParaPedido(direccionValida());
  assert.strictEqual(out.pais, PAIS_FIJO);
  assert.strictEqual(out.pais, 'Argentina');
});

test('construirDireccionParaPedido ignora y sobreescribe un "pais" recibido por error', () => {
  const conPaisManipulado = Object.assign({}, direccionValida(), { pais: 'Uruguay' });
  const out = construirDireccionParaPedido(conPaisManipulado);
  assert.strictEqual(out.pais, 'Argentina');
});

test('construirDireccionParaPedido incluye piso_depto y aclaraciones solo si vienen presentes', () => {
  const sinOpcionales = construirDireccionParaPedido(direccionValida());
  assert.strictEqual('piso_depto' in sinOpcionales, false);
  assert.strictEqual('aclaraciones' in sinOpcionales, false);

  const conOpcionales = construirDireccionParaPedido(
    Object.assign({}, direccionValida(), { pisoDepto: '4to B', aclaraciones: 'Tocar timbre' })
  );
  assert.strictEqual(conOpcionales.piso_depto, '4to B');
  assert.strictEqual(conOpcionales.aclaraciones, 'Tocar timbre');
});

test('construirDireccionParaPedido produce las 5 claves que exige el esquema real', () => {
  const out = construirDireccionParaPedido(direccionValida());
  fields.DIRECCION_CLAVES_ESQUEMA.forEach((clave) => {
    assert.ok(out[clave] && String(out[clave]).length > 0, `falta la clave ${clave}`);
  });
});

// --- cross-check con lib/padel-orders-store.js: nunca deben divergir ----

test('LIMITES.email coincide con lib/padel-orders-store.js#LIMITES.compradorEmail', () => {
  assert.strictEqual(LIMITES.email, ordersStore.LIMITES.compradorEmail);
});

test('LIMITES.telefono coincide con lib/padel-orders-store.js#LIMITES.compradorTelefono', () => {
  assert.strictEqual(LIMITES.telefono, ordersStore.LIMITES.compradorTelefono);
});

test('LIMITES.compradorNombreCompletoMax coincide con lib/padel-orders-store.js#LIMITES.compradorNombre', () => {
  assert.strictEqual(LIMITES.compradorNombreCompletoMax, ordersStore.LIMITES.compradorNombre);
});

test('DIRECCION_CLAVES_ESQUEMA coincide con lib/padel-orders-store.js#DIRECCION_CLAVES_REQUERIDAS', () => {
  assert.deepStrictEqual(
    Array.from(fields.DIRECCION_CLAVES_ESQUEMA).slice().sort(),
    Array.from(ordersStore.DIRECCION_CLAVES_REQUERIDAS).slice().sort()
  );
});

test('un nombre completo que pasa validarComprador nunca supera LIMITES.compradorNombre de padel-orders-store.js', () => {
  const nombre = 'a'.repeat(LIMITES.nombre);
  const apellido = 'b'.repeat(LIMITES.apellido - 1); // combinado justo en el limite
  const r = validarComprador({ nombre, apellido });
  if (r.ok) {
    const completo = construirNombreCompleto({ nombre, apellido });
    assert.ok(completo.length <= ordersStore.LIMITES.compradorNombre);
  }
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
  console.log('Pruebas de lib/padel-checkout-fields.js: ' + (resultados.length - failed.length) + '/' + resultados.length + ' OK');
  process.exit(failed.length > 0 ? 1 : 0);
}

run();
