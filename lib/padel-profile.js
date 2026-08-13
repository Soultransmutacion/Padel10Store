'use strict';

// Nucleo determinista y compartido del perfil de compra TEMPORAL del asesor
// (Fase 2 - Etapa 4).
//
// Que es: contexto comercial de UNA sola conversacion (nivel de juego,
// estilo, prioridad, presupuesto maximo y forma preferida de pala), armado
// unicamente con lo que el cliente declaro el mismo. Nunca es memoria
// permanente del cliente ni datos personales: este modulo no conoce ni
// acepta nombre, direccion, telefono, email ni datos de envio (eso queda
// fuera de esta etapa por completo, ver Etapa 4 del pedido original).
//
// Mismo criterio que lib/padel-cart.js: ninguna funcion de este archivo
// confia en un valor recibido desde afuera (el navegador o el modelo de IA)
// sin pasarlo antes por estas reglas cerradas (enums fijos + numero saneado
// dentro de un rango razonable). El servidor es la unica fuente de verdad
// sobre que perfil es valido; un perfil manipulado a mano nunca se
// convierte en un perfil valido con solo reenviarlo.
//
// A diferencia de lib/padel-cart.js, este modulo es exclusivamente de
// servidor (no se carga con un <script> en el navegador): el cliente solo
// transporta el objeto perfilCompra de un turno al siguiente tal cual se lo
// devolvio el servidor (mismo patron conceptual que ya usa "ofrecidos" en
// lib/padel-advisor.js), nunca lo interpreta ni lo valida el mismo.

var NIVEL_ENUM = ['principiante', 'intermedio', 'avanzado', 'profesional'];
var ESTILO_ENUM = ['ataque', 'control', 'polivalente'];
var PRIORIDAD_ENUM = ['potencia', 'control', 'manejabilidad', 'equilibrio'];
var FORMA_PREFERIDA_ENUM = ['redonda', 'diamante', 'lagrima'];

// Limites de saneamiento para presupuestoMax: solo exige que el numero sea
// finito, positivo y este dentro de un rango razonable de pesos argentinos
// para una pala de padel. No se compara contra el catalogo real (eso
// pertenece a una etapa posterior, el recomendador): esta es unicamente la
// validacion de "numero razonable" que pide la Etapa 4.
var PRESUPUESTO_MIN = 1000;
var PRESUPUESTO_MAX = 5000000;

function emptyPerfilCompra() {
  return {
    nivel: null,
    estilo: null,
    prioridad: null,
    presupuestoMax: null,
    formaPreferida: null,
  };
}

function isValidPresupuesto(value) {
  return typeof value === 'number' && isFinite(value) && !isNaN(value) && value >= PRESUPUESTO_MIN && value <= PRESUPUESTO_MAX;
}

// Sanea un perfil COMPLETO tal como puede llegar del cliente en cada
// request (por ejemplo, un request armado o manipulado a mano). Cualquier
// campo ausente, de tipo incorrecto, fuera de su enum cerrado, o un
// presupuesto fuera de rango/no numerico, se descarta y vuelve a null.
// Nunca lanza una excepcion y nunca confia en el shape recibido: campos
// desconocidos (por ejemplo un intento de inyectar otras claves) se
// descartan en silencio porque el resultado siempre se arma campo por
// campo, nunca copiando el objeto de entrada.
function sanitizePerfilCompra(raw) {
  var perfil = emptyPerfilCompra();
  if (!raw || typeof raw !== 'object') return perfil;
  if (NIVEL_ENUM.indexOf(raw.nivel) !== -1) perfil.nivel = raw.nivel;
  if (ESTILO_ENUM.indexOf(raw.estilo) !== -1) perfil.estilo = raw.estilo;
  if (PRIORIDAD_ENUM.indexOf(raw.prioridad) !== -1) perfil.prioridad = raw.prioridad;
  if (isValidPresupuesto(raw.presupuestoMax)) perfil.presupuestoMax = raw.presupuestoMax;
  if (FORMA_PREFERIDA_ENUM.indexOf(raw.formaPreferida) !== -1) perfil.formaPreferida = raw.formaPreferida;
  return perfil;
}

// Aplica una actualizacion PARCIAL (la llamada de la tool
// actualizar_perfil_compra, ver lib/padel-advisor-tools.js) sobre un perfil
// ya saneado. Solo los campos presentes Y validos en `updates` se
// sobreescriben; cualquier campo ausente o invalido en `updates` deja el
// valor previo tal cual estaba, nunca lo resetea a null. Esto es lo que
// garantiza el requisito central de la Etapa 4: declarar un solo campo
// nuevo (por ejemplo "prefiero control" despues de haber dicho "quiero
// potencia") reemplaza SOLO ese campo, nunca borra el resto del perfil ya
// guardado. Devuelve siempre un perfil completo y saneado (nunca undefined
// ni con claves extra).
function applyPerfilUpdate(currentPerfil, updates) {
  var perfil = sanitizePerfilCompra(currentPerfil);
  var u = updates && typeof updates === 'object' ? updates : {};
  if (NIVEL_ENUM.indexOf(u.nivel) !== -1) perfil.nivel = u.nivel;
  if (ESTILO_ENUM.indexOf(u.estilo) !== -1) perfil.estilo = u.estilo;
  if (PRIORIDAD_ENUM.indexOf(u.prioridad) !== -1) perfil.prioridad = u.prioridad;
  if (isValidPresupuesto(u.presupuestoMax)) perfil.presupuestoMax = u.presupuestoMax;
  if (FORMA_PREFERIDA_ENUM.indexOf(u.formaPreferida) !== -1) perfil.formaPreferida = u.formaPreferida;
  return perfil;
}

module.exports = {
  NIVEL_ENUM: NIVEL_ENUM,
  ESTILO_ENUM: ESTILO_ENUM,
  PRIORIDAD_ENUM: PRIORIDAD_ENUM,
  FORMA_PREFERIDA_ENUM: FORMA_PREFERIDA_ENUM,
  PRESUPUESTO_MIN: PRESUPUESTO_MIN,
  PRESUPUESTO_MAX: PRESUPUESTO_MAX,
  emptyPerfilCompra: emptyPerfilCompra,
  isValidPresupuesto: isValidPresupuesto,
  sanitizePerfilCompra: sanitizePerfilCompra,
  applyPerfilUpdate: applyPerfilUpdate,
};
