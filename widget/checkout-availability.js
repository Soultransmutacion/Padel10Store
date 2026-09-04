(function () {
  'use strict';

  /**
   * Interruptor de seguridad del checkout real, del lado del navegador.
   *
   * Consulta GET /api/checkout-config (api/checkout-config.js, que a su
   * vez lee UNICAMENTE lib/checkout-config.js#esCheckoutHabilitado del
   * lado servidor: la misma condicion que protege POST /api/pedidos y
   * POST /api/pedidos-preferencia) y expone window.PadelCheckoutAvailability,
   * la UNICA fuente de verdad que deben consultar widget/mercadopago-buy.js
   * y widget/padel-checkout.js antes de permitir "Comprar ahora",
   * "Continuar con mis datos" o "Pagar ahora". Ninguno de esos widgets
   * debe leer /api/checkout-config por su cuenta.
   *
   * Fail closed en cada paso, sin ninguna excepcion:
   * - Arranca en `false` desde el primer instante (antes de que exista
   *   cualquier respuesta del servidor): nunca hay un momento en el que
   *   isEnabled() devuelva true por default.
   * - Mientras la consulta esta en curso, sigue en `false`.
   * - Si la consulta falla -sin red, status distinto de 200, JSON
   *   invalido, o el campo `enabled` no es exactamente `true`- se
   *   mantiene/vuelve a `false`. Nunca se asume habilitado ante un error.
   * - Solo pasa a `true` cuando /api/checkout-config responde,
   *   efectivamente, { enabled: true }.
   *
   * Esto es proteccion de UX, no de seguridad: la proteccion real (que
   * nadie pueda crear un pedido ni una preferencia con el checkout
   * apagado) la hace el servidor en api/pedidos.js y
   * api/pedidos-preferencia.js, sin importar lo que diga este archivo.
   */

  var enabled = false;
  var listeners = [];

  function notify() {
    listeners.forEach(function (cb) {
      try {
        cb(enabled);
      } catch (err) {
        // Un listener roto nunca debe tumbar a los demas ni a esta
        // consulta.
      }
    });
  }

  function isEnabled() {
    return enabled === true;
  }

  // cb se llama INMEDIATAMENTE con el estado actual (para que un widget
  // que se suscribe despues de que la consulta ya resolvio nunca se quede
  // con un boton en un estado desactualizado), y de nuevo cada vez que el
  // estado cambie. Devuelve una funcion para desuscribirse.
  function subscribe(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    try {
      cb(enabled);
    } catch (err) {
      // no-op
    }
    return function unsubscribe() {
      var idx = listeners.indexOf(cb);
      if (idx > -1) listeners.splice(idx, 1);
    };
  }

  function aplicarResultado(nuevoValor) {
    var siguiente = nuevoValor === true;
    if (siguiente === enabled) return;
    enabled = siguiente;
    notify();
  }

  function cargarConfiguracion(fetchImpl) {
    var f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) return; // sin fetch disponible: se queda en false (fail closed).
    f('/api/checkout-config', { cache: 'no-store', credentials: 'omit' })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('checkout-config no-ok');
        return res.json();
      })
      .then(function (data) {
        aplicarResultado(Boolean(data && data.enabled === true));
      })
      .catch(function () {
        aplicarResultado(false);
      });
  }

  window.PadelCheckoutAvailability = {
    isEnabled: isEnabled,
    subscribe: subscribe,
  };

  cargarConfiguracion();
})();
