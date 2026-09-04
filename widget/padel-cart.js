(function () {
  'use strict';

  // Carrito real y unico de Padel10Store (fase 1: solo carrito, sin pedidos
  // ni pagos). Esta es la UNICA fuente de verdad del carrito: tanto los
  // botones manuales de la tienda (mas abajo, en index.html) como el
  // asistente de IA (widget/padel-advisor.js) pasan siempre por
  // window.PadelCart. Ninguno de los dos mantiene su propia copia del
  // carrito.
  //
  // Las reglas de que es una linea valida (producto real, talle real,
  // cantidad real, precio recalculado del catalogo) viven en
  // lib/padel-cart.js (PadelCartCore), que este archivo carga como
  // <script> antes que este. El servidor usa el mismo archivo para validar
  // lo que el asistente de IA puede hacer: nunca hay dos implementaciones
  // de "que es un carrito valido".

  var Core = window.PadelCartCore;
  if (!Core) {
    // Si lib/padel-cart.js no cargo por algun motivo (por ejemplo, un CDN
    // caido), el carrito queda deshabilitado en vez de romper el resto del
    // sitio con un error de script.
    window.PadelCart = {
      addItem: function () { return { ok: false, error: 'no_disponible' }; },
      removeItem: function () { return { ok: false, error: 'no_disponible' }; },
      changeQuantity: function () { return { ok: false, error: 'no_disponible' }; },
      setQuantity: function () { return { ok: false, error: 'no_disponible' }; },
      getSummary: function () { return { lineas: [], descartadas: [], total: 0, totalFormateado: '$0', cantidadTotal: 0 }; },
      getRawLines: function () { return []; },
      clear: function () {},
      onChange: function () {},
      whenReady: function (fn) { if (typeof fn === 'function') fn(); },
      open: function () {},
      close: function () {},
      renderDrawer: function () {},
    };
    return;
  }

  var STORAGE_KEY = 'padel10store.cart.v1';
  var WHATSAPP_NUMBER = '5493413637355';

  var lines = []; // {productId, talle, cantidad} -- SIEMPRE lineas ya validadas
  var ready = false;
  var readyCallbacks = [];
  var listeners = [];

  function getProduct(id) {
    return (window.CATALOG && window.CATALOG[id]) || null;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function loadPersisted() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function persist() {
    try {
      var toSave = lines.map(function (l) {
        return { productId: l.productId, talle: l.talle, cantidad: l.cantidad };
      });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch (err) {
      // localStorage no disponible (modo privado, cuota agotada, etc.): el
      // carrito sigue funcionando en memoria durante esta visita, solo que
      // no persiste entre recargas.
    }
  }

  function getSnapshotSummary() {
    return Core.buildCartSummary(lines, getProduct);
  }

  function notify() {
    persist();
    var summary = getSnapshotSummary();
    listeners.forEach(function (fn) {
      try {
        fn(summary);
      } catch (err) {
        /* un listener roto no debe tumbar el carrito de los demas */
      }
    });
  }

  function findIndex(productId, talle) {
    return Core.findLineIndex(lines, productId, talle || null);
  }

  // API real del carrito. Tanto la tienda como el asistente llaman siempre
  // a estas mismas funciones: nunca hay un camino separado que toque
  // `lines` directamente desde afuera de este archivo.

  function addItem(productId, talle, cantidad) {
    var product = getProduct(productId);
    var result = Core.buildLine(product, talle, cantidad);
    if (!result.ok) return result;

    var idx = findIndex(result.line.productId, result.line.talle);
    if (idx > -1) {
      var nuevaCantidad = lines[idx].cantidad + result.line.cantidad;
      lines[idx].cantidad = nuevaCantidad > Core.MAX_QUANTITY ? Core.MAX_QUANTITY : nuevaCantidad;
    } else {
      lines.push(result.line);
    }
    notify();
    return { ok: true, line: result.line };
  }

  function removeItem(productId, talle) {
    var idx = findIndex(productId, talle || null);
    if (idx === -1) return { ok: false, error: 'no_encontrado_en_carrito' };
    lines.splice(idx, 1);
    notify();
    return { ok: true };
  }

  function changeQuantity(productId, talle, delta) {
    var idx = findIndex(productId, talle || null);
    if (idx === -1) return { ok: false, error: 'no_encontrado_en_carrito' };
    lines[idx].cantidad += delta;
    if (lines[idx].cantidad < Core.MIN_QUANTITY) {
      lines.splice(idx, 1);
    } else if (lines[idx].cantidad > Core.MAX_QUANTITY) {
      lines[idx].cantidad = Core.MAX_QUANTITY;
    }
    notify();
    return { ok: true };
  }

  // Cambia la cantidad de una linea existente a un valor ABSOLUTO ya
  // validado (a diferencia de changeQuantity, que aplica un delta relativo
  // desde los botones +/- del drawer). Usado por el asesor de IA: el
  // servidor ya valida el rango real (ver lib/padel-cart.js#validateQuantity)
  // antes de pedirle al cliente que ejecute la accion, pero se vuelve a
  // validar aca tambien, nunca se confia ciegamente en el numero recibido.
  function setQuantity(productId, talle, cantidad) {
    var cantidadResult = Core.validateQuantity(cantidad);
    if (!cantidadResult.ok) return cantidadResult;
    var idx = findIndex(productId, talle || null);
    if (idx === -1) return { ok: false, error: 'no_encontrado_en_carrito' };
    lines[idx].cantidad = cantidadResult.cantidad;
    notify();
    return { ok: true };
  }

  function clear() {
    lines = [];
    notify();
  }

  function getRawLines() {
    // Vista minima para enviarle al asistente/servidor: nunca precio ni
    // nombre (ver lib/padel-advisor.js, que los vuelve a resolver siempre
    // contra el catalogo real).
    return lines.map(function (l) {
      return { productId: l.productId, talle: l.talle, cantidad: l.cantidad };
    });
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function whenReady(fn) {
    if (typeof fn !== 'function') return;
    if (ready) {
      fn();
    } else {
      readyCallbacks.push(fn);
    }
  }

  // Restaura el carrito guardado en localStorage. Se llama SOLO despues de
  // que window.CATALOG ya tiene el catalogo real cargado (ver mas abajo):
  // si se llamara antes, cada linea persistida se veria como "producto
  // inexistente" (porque el catalogo todavia estaria vacio) y se perderia
  // el carrito guardado en cada carga de pagina. Cualquier linea cuyo
  // producto, talle o precio ya no sea valido se descarta silenciosamente
  // (nunca se confia en lo guardado en el navegador: ver
  // lib/padel-cart.js#buildCartSummary).
  function restoreAndInit() {
    var persisted = loadPersisted();
    var summary = Core.buildCartSummary(persisted, getProduct);
    lines = summary.lineas.map(function (l) {
      return { productId: l.productId, talle: l.talle, cantidad: l.cantidad };
    });
    if (summary.descartadas.length > 0) {
      // El carrito guardado tenia lineas que ya no son validas (producto
      // eliminado del catalogo, talle que dejo de existir, etc.): se
      // guarda la version limpia para no volver a arrastrar el problema.
      persist();
    }
    ready = true;
    notify();
    readyCallbacks.forEach(function (fn) {
      try {
        fn();
      } catch (err) {}
    });
    readyCallbacks = [];
  }

  window.CATALOG = window.CATALOG || {};
  fetch('products.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var list = (data && data.productos) || [];
      list.forEach(function (p) {
        if (p && p.id) window.CATALOG[p.id] = p;
      });
    })
    .catch(function () {
      /* el catalogo no cargo: el carrito queda vacio en vez de aceptar datos sin validar */
    })
    .then(restoreAndInit);

  window.PadelCart = {
    addItem: addItem,
    removeItem: removeItem,
    changeQuantity: changeQuantity,
    setQuantity: setQuantity,
    getSummary: getSnapshotSummary,
    getRawLines: getRawLines,
    clear: clear,
    onChange: onChange,
    whenReady: whenReady,
    open: function () {},
    close: function () {},
  };

  // --- Interfaz visual (drawer + contador): mismo drawer y mismo contador
  // que ya existian en index.html, ahora alimentados por el carrito unico.
  // Este archivo se carga con `defer`, asi que el HTML ya esta totalmente
  // parseado en este punto (no hace falta esperar a DOMContentLoaded para
  // buscar estos elementos, a diferencia del script inline original que si
  // lo necesitaba por no ser defer). ---
  (function setupDrawerUI() {
    var cartDrawerOverlay = document.getElementById('cartDrawerOverlay');
    var cartDrawerEl = document.getElementById('cartDrawer');
    var cartDrawerBody = document.getElementById('cartDrawerBody');
    var cartDrawerTotalEl = document.getElementById('cartDrawerTotal');
    var cartDrawerCloseBtn = document.getElementById('cartDrawerClose');
    var cartDrawerCheckoutBtn = document.getElementById('cartDrawerCheckoutBtn');
    var cartBtnEl = document.getElementById('cartBtn');

    function renderDrawer(summary) {
      if (!cartDrawerBody) return;
      if (!summary.lineas.length) {
        cartDrawerBody.innerHTML =
          '<div class="empty" id="cartDrawerEmpty"><div class="empty-ico">&#128722;</div><div class="empty-txt">Tu carrito esta vacio</div></div>';
      } else {
        cartDrawerBody.innerHTML = summary.lineas
          .map(function (l) {
            var talleTxt = l.talle ? ' (Talle ' + escapeHtml(l.talle) + ')' : '';
            var pid = escapeHtml(l.productId);
            var talleAttr = escapeHtml(l.talle || '');
            return (
              '<div class="ci"><div class="ci-ico"><img src="' +
              escapeHtml(l.imagen || '') +
              '" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:8px;"></div>' +
              '<div class="ci-info"><div class="ci-name">' +
              escapeHtml(l.nombre) +
              talleTxt +
              '</div><div class="ci-price">' +
              escapeHtml(l.precioFormateado) +
              '</div><div class="ci-qty">' +
              '<button class="qb" data-action="dec" data-product-id="' + pid + '" data-talle="' + talleAttr + '">&#8722;</button>' +
              '<span class="qn">' + l.cantidad + '</span>' +
              '<button class="qb" data-action="inc" data-product-id="' + pid + '" data-talle="' + talleAttr + '">+</button>' +
              '</div></div>' +
              '<button class="ci-del" data-product-id="' + pid + '" data-talle="' + talleAttr + '" aria-label="Eliminar">&#128465;</button></div>'
            );
          })
          .join('');
      }
      if (cartDrawerTotalEl) cartDrawerTotalEl.textContent = summary.totalFormateado || '$0';
    }

    function updateBadge(summary) {
      var badge = document.querySelector('.cart-badge');
      if (!badge) return;
      if (summary.cantidadTotal > 0) {
        badge.style.display = 'inline';
        badge.textContent = String(summary.cantidadTotal);
      } else {
        badge.style.display = 'none';
        badge.textContent = '';
      }
    }

    onChange(function (summary) {
      renderDrawer(summary);
      updateBadge(summary);
    });

    if (cartDrawerBody) {
      cartDrawerBody.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('button[data-product-id]') : null;
        if (!btn) return;
        var productId = btn.dataset.productId;
        var talle = btn.dataset.talle || null;
        if (btn.dataset.action === 'inc') changeQuantity(productId, talle, 1);
        else if (btn.dataset.action === 'dec') changeQuantity(productId, talle, -1);
        else if (btn.classList.contains('ci-del')) removeItem(productId, talle);
      });
    }

    function openDrawer() {
      renderDrawer(getSnapshotSummary());
      if (cartDrawerOverlay) cartDrawerOverlay.classList.add('open');
      if (cartDrawerEl) cartDrawerEl.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function closeDrawer() {
      if (cartDrawerOverlay) cartDrawerOverlay.classList.remove('open');
      if (cartDrawerEl) cartDrawerEl.classList.remove('open');
      document.body.style.overflow = '';
    }

    window.PadelCart.open = openDrawer;
    window.PadelCart.close = closeDrawer;
    // Fase 3, Etapa 2: widget/padel-checkout.js reutiliza este mismo
    // render (nunca reimplementa el HTML de una linea de carrito) para
    // volver a mostrar la vista de carrito despues de pasar por el
    // formulario/revision/confirmacion. No cambia nada del comportamiento
    // existente: es la misma funcion que ya se llama en cada cambio del
    // carrito y al abrir el drawer.
    window.PadelCart.renderDrawer = function () {
      renderDrawer(getSnapshotSummary());
    };

    if (cartDrawerCloseBtn) cartDrawerCloseBtn.addEventListener('click', closeDrawer);
    if (cartDrawerOverlay) {
      cartDrawerOverlay.addEventListener('click', function (e) {
        if (e.target === cartDrawerOverlay) closeDrawer();
      });
    }
    if (cartBtnEl) cartBtnEl.addEventListener('click', openDrawer);

    // Mismo comportamiento que antes: el checkout del drawer sigue siendo
    // una consulta por WhatsApp con el resumen del carrito. El flujo de
    // pago real (Mercado Pago con el carrito completo) queda para una fase
    // posterior, tal como se pidio para esta fase.
    if (cartDrawerCheckoutBtn) {
      cartDrawerCheckoutBtn.addEventListener('click', function () {
        var summary = getSnapshotSummary();
        if (!summary.lineas.length) return;
        var lineasTexto = summary.lineas
          .map(function (l) {
            var talleTxt = l.talle ? ' (Talle ' + l.talle + ')' : '';
            return '- ' + l.nombre + talleTxt + ' x' + l.cantidad + ': ' + l.precioFormateado;
          })
          .join('%0A');
        var msg =
          'Hola! Quiero confirmar stock y coordinar el pago de mi carrito:%0A' +
          lineasTexto +
          '%0A%0ATotal: ' +
          summary.totalFormateado;
        window.open('https://wa.me/' + WHATSAPP_NUMBER + '?text=' + msg, '_blank');
      });
    }

    // El catalogo (y por lo tanto el carrito restaurado) puede terminar de
    // cargar antes o despues de que este bloque corra: si ya esta listo,
    // renderizamos una vez con el estado real ni bien el drawer existe.
    if (ready) {
      renderDrawer(getSnapshotSummary());
      updateBadge(getSnapshotSummary());
    }
  })();
})();
