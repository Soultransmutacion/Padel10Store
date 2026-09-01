(function () {
  'use strict';

  // Fase 3, Etapa 2: formulario de comprador y datos de envio, dentro del
  // mismo drawer del carrito (window.PadelCart, widget/padel-cart.js).
  //
  // Flujo: CARRITO -> CONTINUAR CON MIS DATOS -> FORMULARIO -> REVISION ->
  // CREAR PEDIDO -> CONFIRMACION. "Consultar por WhatsApp" sigue existiendo
  // tal cual, como alternativa independiente (no se toca su logica).
  //
  // Esta etapa TODAVIA NO integra Mercado Pago: crear el pedido no cobra
  // nada, y el mensaje de confirmacion lo aclara explicitamente. Ningun
  // dato del comprador se envia nunca al asistente de IA (este archivo no
  // importa ni referencia widget/padel-advisor.js ni lib/padel-advisor-tools.js
  // en ningun sentido).
  //
  // El navegador solo le manda a POST /api/pedidos: comprador{nombre,
  // apellido}, contacto{email,telefono}, direccionEnvio{...} y las lineas
  // del carrito en su forma minima (window.PadelCart.getRawLines(): solo
  // productId/talle/cantidad). El precio, el nombre y el total SIEMPRE los
  // recalcula el servidor contra el catalogo real (ver api/pedidos.js):
  // este archivo nunca le manda un precio a la API.

  var Fields = window.PadelCheckoutFields;
  var Core = window.PadelCartCore;
  if (!Fields || !Core) {
    // Si lib/padel-checkout-fields.js o lib/padel-cart.js no cargaron, el
    // flujo de checkout queda deshabilitado (el boton "Continuar con mis
    // datos" simplemente no hace nada) en vez de romper el resto del
    // carrito.
    return;
  }

  // Unico producto piloto comprable con "Comprar ahora" (ver tambien
  // index.html#PURCHASABLE_PRODUCT_IDS y
  // widget/padel-advisor.js#MP_PURCHASABLE_PRODUCT_ID, que gatean cuando
  // se muestra el boton). Se vuelve a verificar aca, del lado de quien
  // arma el pedido, para no depender unicamente de que el boton este
  // oculto en el resto de los 91 productos.
  var BUY_NOW_PRODUCT_ID = 'royal-padel-cross-black-26';

  function getCatalogProduct(id) {
    return (window.CATALOG && window.CATALOG[id]) || null;
  }

  var ENDPOINT = '/api/pedidos';
  var RETRY_ENDPOINT = '/api/pedidos-preferencia';
  var GENERIC_ERROR_MESSAGE = 'No pudimos registrar tu pedido. Intentá nuevamente en unos minutos.';
  var RETRY_ERROR_MESSAGE = 'No pudimos reiniciar el pago. Intentá nuevamente en unos minutos.';
  // Se muestra cuando se pierde la respuesta (timeout, corte de red) y por
  // lo tanto no hay forma de saber si el servidor llego a crear el pedido:
  // a diferencia de GENERIC_ERROR_MESSAGE, deja explicito que reintentar es
  // seguro (la idempotencyKey nunca se borra en este caso, ver mas abajo).
  var UNCERTAIN_RESULT_MESSAGE = 'No pudimos confirmar si tu pedido se registró. Podés reintentar tranquilo: no se va a duplicar.';
  // Se muestra ante un 409: la idempotencyKey guardada ya se uso antes con
  // datos distintos a los actuales (deberia ser un caso raro: implica que
  // el contenido cambio sin que se detectara localmente).
  var CONFLICT_ERROR_MESSAGE = 'Tus datos cambiaron respecto a un intento anterior. Volvé a intentar.';
  // Tiempo maximo que se espera la respuesta de POST /api/pedidos antes de
  // abortar el fetch. No implica que el servidor no haya procesado el
  // pedido igual (ver UNCERTAIN_RESULT_MESSAGE): solo evita que el
  // comprador quede esperando indefinidamente.
  var SUBMIT_TIMEOUT_MS = 20000;
  // Clave de sessionStorage (nunca localStorage: se prefiere que la
  // proteccion no sobreviva mas alla de la pestaña/sesion actual) donde se
  // guarda temporalmente { key, firma } de la intencion de compra en
  // curso. Solo contiene la clave opaca y un hash NO reversible del
  // contenido (ver hashContenido mas abajo): nunca el nombre, email,
  // telefono o direccion del comprador en texto plano.
  var IDEMPOTENCY_STORAGE_KEY = 'padel10store:checkoutIdempotencia';
  // Mismo formato que valida el servidor para idempotencyKey (16-100
  // caracteres, [A-Za-z0-9_-]).
  var IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{16,100}$/;

  // Nunca se navega a una URL de checkout que no sea explicitamente de
  // Mercado Pago sandbox (protocolo https + host conocido).
  var ALLOWED_SANDBOX_HOSTS = ['sandbox.mercadopago.com.ar', 'sandbox.mercadopago.com'];
  function isValidSandboxUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    var parsed;
    try { parsed = new URL(url); } catch (e) { return false; }
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_SANDBOX_HOSTS.indexOf(parsed.hostname) !== -1;
  }

  var PROVINCIAS = [
    'Buenos Aires', 'Ciudad Autónoma de Buenos Aires', 'Catamarca', 'Chaco', 'Chubut',
    'Córdoba', 'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja',
    'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan', 'San Luis',
    'Santa Cruz', 'Santa Fe', 'Santiago del Estero', 'Tierra del Fuego', 'Tucumán',
  ];

  // Campos del formulario, en el orden en que se muestran (y en el mismo
  // orden en que valida lib/padel-checkout-fields.js#validarFormularioCheckout).
  var CAMPOS = [
    { key: 'nombre', label: 'Nombre', autocomplete: 'given-name' },
    { key: 'apellido', label: 'Apellido', autocomplete: 'family-name' },
    { key: 'email', label: 'Email', autocomplete: 'email', type: 'email' },
    { key: 'telefono', label: 'Teléfono', autocomplete: 'tel' },
    { key: 'provincia', label: 'Provincia', select: true },
    { key: 'localidad', label: 'Localidad' },
    { key: 'codigoPostal', label: 'Código postal' },
    { key: 'calle', label: 'Calle' },
    { key: 'numero', label: 'Número' },
    { key: 'pisoDepto', label: 'Piso / Depto (opcional)', opcional: true },
    { key: 'aclaraciones', label: 'Aclaraciones de entrega (opcional)', opcional: true, textarea: true },
  ];

  // --- estado local (solo en memoria: nunca en localStorage, son datos del
  // comprador) ---------------------------------------------------------
  var view = 'carrito'; // 'carrito' | 'formulario' | 'revision' | 'confirmacion'
  // mode: 'cart' (flujo normal, el carrito persistente de window.PadelCart)
  // o 'buyNow' (compra directa de UN SOLO producto disparada por "Comprar
  // ahora", ver startBuyNow mas abajo). En modo 'buyNow', buyNowLine es la
  // UNICA linea del pedido: nunca se mezcla con lo que ya hubiera en el
  // carrito persistente, y ese carrito nunca se toca ni se vacia.
  var mode = 'cart';
  var buyNowLine = null; // {productId, talle, cantidad} | null
  var formState = { nombre: '', apellido: '', email: '', telefono: '', provincia: '', localidad: '', codigoPostal: '', calle: '', numero: '', pisoDepto: '', aclaraciones: '' };
  var currentError = null; // { campo, mensaje } | null
  var submitError = null; // string | null
  var submitting = false;
  var pedidoConfirmadoNumero = null;
  // paymentRetryToken: SOLO vive en memoria (nunca localStorage, nunca se
  // loguea). Autoriza unicamente un intento de reiniciar el pago de ESTE
  // pedido puntual; no reemplaza ningun otro identificador. Se recibe de
  // /api/pedidos SOLAMENTE cuando el pedido se registro correctamente
  // pero no se pudo iniciar el pago en el mismo request.
  var paymentRetryToken = null;
  var retrying = false;
  var retryError = null;
  // AbortController de la solicitud POST /api/pedidos en curso (null si no
  // hay ninguna). motivoAborto distingue POR QUE se aborto, para decidir
  // que hacer cuando esa promesa efectivamente se resuelve/rechaza despues:
  // 'user' (el comprador navego lejos a proposito: no se muestra nada) vs
  // 'timeout' (se agoto SUBMIT_TIMEOUT_MS: resultado incierto).
  var solicitudPedidoEnCurso = null;
  var motivoAborto = null;
  var timeoutIdSolicitudPedido = null;
  // true si, al inicializar el widget, YA habia una idempotencyKey guardada
  // en sessionStorage de un intento de compra anterior sin confirmar (por
  // ejemplo, la pestaña se restauro o se recargo en medio del checkout).
  // Se usa solo para mostrar un aviso; nunca cambia el comportamiento del
  // envio (la idempotencyKey en si ya resuelve la seguridad real).
  var sesionConIntentoPrevioSinConfirmar = false;

  function cancelarSolicitudPedidoPendiente() {
    if (timeoutIdSolicitudPedido) {
      clearTimeout(timeoutIdSolicitudPedido);
      timeoutIdSolicitudPedido = null;
    }
    if (solicitudPedidoEnCurso) {
      motivoAborto = 'user';
      solicitudPedidoEnCurso.abort();
      solicitudPedidoEnCurso = null;
    }
  }

  // Hash NO criptografico (solo para detectar si el contenido del checkout
  // cambio entre un intento y el siguiente): nunca se usa con fines de
  // seguridad. El fingerprint de seguridad real (SHA-256) lo calcula
  // exclusivamente el servidor, a partir del contenido ya validado (nunca
  // de un valor que mande el navegador).
  function hashContenido(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i += 1) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  function leerIdempotenciaAlmacenada() {
    try {
      var raw = window.sessionStorage.getItem(IDEMPOTENCY_STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.key !== 'string' || typeof parsed.firma !== 'string') return null;
      if (!IDEMPOTENCY_KEY_REGEX.test(parsed.key)) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function guardarIdempotenciaAlmacenada(key, firma) {
    try {
      window.sessionStorage.setItem(IDEMPOTENCY_STORAGE_KEY, JSON.stringify({ key: key, firma: firma }));
    } catch (e) {
      // Si sessionStorage no esta disponible (modo privado estricto, cuota
      // agotada, etc.) el checkout sigue funcionando igual: solo se pierde
      // la proteccion extra ante recarga/restauracion de pestaña.
    }
  }

  function borrarIdempotenciaAlmacenada() {
    try {
      window.sessionStorage.removeItem(IDEMPOTENCY_STORAGE_KEY);
    } catch (e) {}
  }

  // Genera una clave de idempotencia opaca. crypto.randomUUID() es el
  // camino normal; el fallback a getRandomValues cubre navegadores viejos
  // que tienen Web Crypto pero no randomUUID; el ultimo fallback (Math.random)
  // solo se usaria si no hubiera Web Crypto en absoluto, algo hoy
  // practicamente inexistente: sigue siendo aceptable porque esta clave es
  // unicamente un identificador opaco de idempotencia, nunca un secreto.
  function generarIdempotencyKeySegura() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      var bytes = new Uint8Array(24);
      window.crypto.getRandomValues(bytes);
      var hex = '';
      for (var i = 0; i < bytes.length; i += 1) {
        hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
      }
      return hex;
    }
    var fallback = '';
    for (var j = 0; j < 32; j += 1) fallback += Math.floor(Math.random() * 16).toString(16);
    return fallback;
  }

  // Contenido "relevante" del intento de compra actual: producto(s),
  // cantidad, talle y datos de comprador/contacto/envio. Se usa tanto para
  // armar el body real de la request como para calcular la firma que
  // decide si se reutiliza la idempotencyKey guardada o se genera una
  // nueva (ver obtenerIdempotencyKeyParaIntento).
  function contenidoDelIntentoActual() {
    return {
      comprador: { nombre: formState.nombre.trim(), apellido: formState.apellido.trim() },
      contacto: { email: formState.email.trim(), telefono: formState.telefono.trim() },
      direccionEnvio: {
        provincia: formState.provincia.trim(),
        localidad: formState.localidad.trim(),
        codigoPostal: formState.codigoPostal.trim(),
        calle: formState.calle.trim(),
        numero: formState.numero.trim(),
        pisoDepto: formState.pisoDepto.trim(),
        aclaraciones: formState.aclaraciones.trim(),
      },
      items:
        mode === 'buyNow' && buyNowLine
          ? [{ productId: buyNowLine.productId, talle: buyNowLine.talle, cantidad: buyNowLine.cantidad }]
          : window.PadelCart.getRawLines(),
    };
  }

  // Devuelve la idempotencyKey a usar para EL CONTENIDO ACTUAL: si ya habia
  // una guardada para el mismo contenido (misma firma), la reutiliza -esto
  // es lo que le permite sobrevivir a una recarga/restauracion de pestaña o
  // a un reintento manual sin generar pedidos duplicados-; si el contenido
  // cambio (otro producto, cantidad, talle, direccion, etc.) o no habia
  // ninguna guardada, genera una nueva.
  function obtenerIdempotencyKeyParaIntento(contenido) {
    var firmaActual = hashContenido(JSON.stringify(contenido));
    var almacenado = leerIdempotenciaAlmacenada();
    if (almacenado && almacenado.firma === firmaActual) {
      return almacenado.key;
    }
    var nuevaKey = generarIdempotencyKeySegura();
    guardarIdempotenciaAlmacenada(nuevaKey, firmaActual);
    return nuevaKey;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var MENSAJES_ERROR = {
    nombre_invalido: 'Ingresá tu nombre.',
    apellido_invalido: 'Ingresá tu apellido.',
    nombre_completo_demasiado_largo: 'El nombre y apellido juntos son demasiado largos.',
    email_invalido: 'Ingresá un email válido.',
    telefono_invalido: 'Ingresá un teléfono de contacto.',
    provincia_invalida: 'Elegí tu provincia.',
    localidad_invalida: 'Ingresá tu localidad.',
    codigo_postal_invalido: 'Ingresá un código postal válido.',
    calle_invalida: 'Ingresá tu calle.',
    numero_invalido: 'Ingresá el número.',
    piso_depto_invalido: 'Ese piso/depto es demasiado largo.',
    aclaraciones_invalidas: 'Esas aclaraciones son demasiado largas.',
  };

  // Resumen activo: la unica linea de "Comprar ahora" en modo buyNow, o el
  // carrito persistente real en modo cart. Reutiliza PadelCartCore.buildCartSummary
  // -la misma funcion que ya usa window.PadelCart- para nunca reimplementar
  // el calculo de precio/nombre/total de una linea.
  function getActiveSummary() {
    if (mode === 'buyNow' && buyNowLine) {
      return Core.buildCartSummary([buyNowLine], getCatalogProduct);
    }
    return window.PadelCart.getSummary();
  }

  function resetBuyNow() {
    mode = 'cart';
    buyNowLine = null;
  }

  function whenReady(fn) {
    if (window.PadelCart && typeof window.PadelCart.whenReady === 'function') {
      window.PadelCart.whenReady(fn);
    } else {
      fn();
    }
  }

  // --- construccion del input que espera lib/padel-checkout-fields.js ----

  function formStateToValidationInput() {
    return {
      comprador: { nombre: formState.nombre, apellido: formState.apellido },
      contacto: { email: formState.email, telefono: formState.telefono },
      direccionEnvio: {
        provincia: formState.provincia,
        localidad: formState.localidad,
        codigoPostal: formState.codigoPostal,
        calle: formState.calle,
        numero: formState.numero,
        pisoDepto: formState.pisoDepto,
        aclaraciones: formState.aclaraciones,
      },
    };
  }

  // --- render: campos del elemento raiz del drawer ------------------------

  var els = {};

  function cacheEls() {
    els.title = document.getElementById('cartDrawerTitle');
    els.body = document.getElementById('cartDrawerBody');
    els.footerCart = document.getElementById('cartDrawerFooterCart');
    els.footerCheckout = document.getElementById('cartDrawerFooterCheckout');
    els.continueBtn = document.getElementById('cartDrawerContinueBtn');
    els.backBtn = document.getElementById('cartDrawerBackBtn');
    els.nextBtn = document.getElementById('cartDrawerNextBtn');
    els.overlay = document.getElementById('cartDrawerOverlay');
    els.closeBtn = document.getElementById('cartDrawerClose');
  }

  function fieldRow(campo) {
    var value = escapeHtml(formState[campo.key]);
    var errored = currentError && currentError.campo === campo.key;
    var borderStyle = errored ? 'border-color:#ff6b6b' : '';
    var label = '<label class="fg"><span class="flbl">' + escapeHtml(campo.label) + '</span>';
    var control;
    if (campo.select) {
      var options = '<option value="">Elegí una opción</option>' + PROVINCIAS.map(function (p) {
        var sel = formState[campo.key] === p ? ' selected' : '';
        return '<option value="' + escapeHtml(p) + '"' + sel + '>' + escapeHtml(p) + '</option>';
      }).join('');
      control = '<select class="fsel" data-field="' + campo.key + '" style="' + borderStyle + '">' + options + '</select>';
    } else if (campo.textarea) {
      control = '<textarea class="finp" data-field="' + campo.key + '" rows="2" style="' + borderStyle + '">' + value + '</textarea>';
    } else {
      control = '<input class="finp" type="' + (campo.type || 'text') + '" data-field="' + campo.key + '" value="' + value + '" style="' + borderStyle + '">';
    }
    var errorMsg = errored
      ? '<span style="color:#ff6b6b;font-size:11px;margin-top:2px">' + escapeHtml(MENSAJES_ERROR[currentError.error] || 'Revisá este campo.') + '</span>'
      : '';
    return label + control + errorMsg + '</label>';
  }

  // Aviso de "sesion restaurada": informa, sin bloquear nada, que ya habia
  // un intento de compra sin confirmar guardado en esta pestaña (recarga o
  // restauracion de sesion en medio del checkout). Nunca es un error: el
  // mecanismo de idempotencyKey ya garantiza que continuar es seguro.
  function avisoSesionRestauradaHtml() {
    if (!sesionConIntentoPrevioSinConfirmar) return '';
    return (
      '<div class="mp-buy-hint" role="status" style="font-size:11px;color:#ffd166;' +
      'background:rgba(255,209,102,0.08);border:1px solid rgba(255,209,102,0.3);' +
      'border-radius:8px;padding:8px;margin-bottom:8px;line-height:1.4">' +
      'Encontramos un intento de compra anterior en esta pestaña que no llegamos a confirmar. ' +
      'Si ya recibiste la confirmación no hace falta repetirlo; si no, podés continuar tranquilo: no se va a duplicar.' +
      '</div>'
    );
  }

  function renderFormularioView() {
    if (els.title) els.title.textContent = 'Tus datos';
    var rows = CAMPOS.map(function (c) {
      return '<div class="form-row full">' + fieldRow(c) + '</div>';
    }).join('');
    els.body.innerHTML =
      '<div style="padding-bottom:0.5rem">' +
      avisoSesionRestauradaHtml() +
      '<div class="os-t">COMPRADOR, CONTACTO Y ENVÍO</div>' +
      rows +
      '</div>';
  }

  function renderRevisionView(summary) {
    if (els.title) els.title.textContent = 'Revisá tu pedido';
    var itemsHtml = summary.lineas
      .map(function (l) {
        var talleTxt = l.talle ? ' (Talle ' + escapeHtml(l.talle) + ')' : '';
        return (
          '<div class="os-item"><span>' +
          escapeHtml(l.nombre) + talleTxt + ' x' + l.cantidad +
          '</span><span>' + escapeHtml(l.precioFormateado) + '</span></div>'
        );
      })
      .join('');
    var direccionLinea2 = [formState.pisoDepto].filter(Boolean).map(escapeHtml).join(', ');
    els.body.innerHTML =
      avisoSesionRestauradaHtml() +
      '<div class="ord-sum"><div class="os-t">COMPRADOR</div>' +
      '<div class="os-item"><span>Nombre</span><span>' + escapeHtml(formState.nombre + ' ' + formState.apellido) + '</span></div>' +
      '<div class="os-item"><span>Email</span><span>' + escapeHtml(formState.email) + '</span></div>' +
      '<div class="os-item"><span>Teléfono</span><span>' + escapeHtml(formState.telefono) + '</span></div>' +
      '</div>' +
      '<div class="ord-sum"><div class="os-t">ENVÍO</div>' +
      '<div class="os-item"><span>Dirección</span><span>' + escapeHtml(formState.calle + ' ' + formState.numero) + (direccionLinea2 ? ' (' + direccionLinea2 + ')' : '') + '</span></div>' +
      '<div class="os-item"><span>Localidad</span><span>' + escapeHtml(formState.localidad + ', ' + formState.provincia) + '</span></div>' +
      '<div class="os-item"><span>Código postal</span><span>' + escapeHtml(formState.codigoPostal) + '</span></div>' +
      (formState.aclaraciones ? '<div class="os-item"><span>Aclaraciones</span><span>' + escapeHtml(formState.aclaraciones) + '</span></div>' : '') +
      '</div>' +
      '<div class="ord-sum"><div class="os-t">PEDIDO</div>' +
      itemsHtml +
      '<div class="os-total"><span class="os-tl">Total</span><span class="os-tv">' + escapeHtml(summary.totalFormateado) + '</span></div>' +
      '</div>' +
      (submitError ? '<div class="mp-buy-error" role="alert" style="text-align:left;margin-bottom:8px">' + escapeHtml(submitError) + '</div>' : '') +
      '<div style="font-size:11px;color:rgba(255,255,255,0.35);line-height:1.5">Al confirmar, todavía no se realiza ningún cobro: solo se registra tu pedido.</div>';
  }

  function renderConfirmacionView() {
    if (els.title) els.title.textContent = '¡Pedido registrado!';
    var retryHtml = '';
    if (paymentRetryToken) {
      retryHtml =
        (retryError ? '<div class="mp-buy-error" role="alert" style="text-align:left;margin:8px 0">' + escapeHtml(retryError) + '</div>' : '') +
        '<button type="button" class="chk-btn" data-action="retry-payment" ' + (retrying ? 'disabled' : '') + '>' +
        (retrying ? 'Iniciando pago…' : 'Pagar ahora') +
        '</button>';
    }
    els.body.innerHTML =
      '<div class="success">' +
      '<div class="succ-ico">&#9989;</div>' +
      '<div class="succ-t">Pedido ' + escapeHtml(pedidoConfirmadoNumero) + '</div>' +
      '<div class="succ-s">Tu pedido quedó registrado correctamente.<br><strong>Todavía no se realizó ningún cobro.</strong><br>Nos vamos a comunicar para coordinar el pago.</div>' +
      retryHtml +
      '</div>';
  }

  function updateFooter() {
    if (view === 'carrito') {
      if (els.footerCart) els.footerCart.hidden = false;
      if (els.footerCheckout) els.footerCheckout.hidden = true;
      var summary = window.PadelCart.getSummary();
      if (els.continueBtn) els.continueBtn.disabled = summary.lineas.length === 0;
      return;
    }
    if (els.footerCart) els.footerCart.hidden = true;
    if (els.footerCheckout) els.footerCheckout.hidden = false;
    if (!els.backBtn || !els.nextBtn) return;
    els.backBtn.disabled = false;

    if (view === 'formulario') {
      els.backBtn.hidden = false;
      els.backBtn.textContent = 'Volver al carrito';
      els.nextBtn.disabled = false;
      els.nextBtn.textContent = 'Revisar pedido';
    } else if (view === 'revision') {
      els.backBtn.hidden = false;
      // Deshabilitado mientras hay un envio en curso: evita que el
      // comprador dispare una navegacion mientras se decide si hace falta
      // cancelarla (igual, el click de todos modos queda cubierto por
      // cancelarSolicitudPedidoPendiente en el handler, por si llega a
      // disparase de otra forma).
      els.backBtn.disabled = submitting;
      els.backBtn.textContent = 'Volver a editar mis datos';
      els.nextBtn.disabled = submitting;
      els.nextBtn.textContent = submitting ? 'Creando pedido…' : 'Confirmar y crear pedido';
    } else if (view === 'confirmacion') {
      els.backBtn.hidden = true;
      els.nextBtn.disabled = false;
      els.nextBtn.textContent = 'Seguir comprando';
    }
  }

  function render() {
    if (view === 'carrito') {
      if (els.title) els.title.textContent = 'Carrito';
      window.PadelCart.renderDrawer();
    } else if (view === 'formulario') {
      renderFormularioView();
    } else if (view === 'revision') {
      renderRevisionView(getActiveSummary());
    } else if (view === 'confirmacion') {
      renderConfirmacionView();
    }
    updateFooter();
  }

  function goto(nextView) {
    view = nextView;
    render();
  }

  // --- avanzar de formulario a revision: valida TODO antes de dejar avanzar
  // (esta validacion es solo UX: api/pedidos.js vuelve a validar todo del
  // lado servidor con las mismas reglas de lib/padel-checkout-fields.js) --

  function intentarAvanzarARevision() {
    var resultado = Fields.validarFormularioCheckout(formStateToValidationInput());
    if (!resultado.ok) {
      currentError = resultado;
      renderFormularioView();
      return;
    }
    currentError = null;
    submitError = null;
    goto('revision');
  }

  // --- envio real a POST /api/pedidos -------------------------------------

  function submitPedido() {
    if (submitting) return;
    submitting = true;
    submitError = null;
    updateFooter();

    var contenido = contenidoDelIntentoActual();
    var idempotencyKey = obtenerIdempotencyKeyParaIntento(contenido);

    var body = {
      comprador: contenido.comprador,
      contacto: contenido.contacto,
      direccionEnvio: {
        provincia: contenido.direccionEnvio.provincia,
        localidad: contenido.direccionEnvio.localidad,
        codigoPostal: contenido.direccionEnvio.codigoPostal,
        calle: contenido.direccionEnvio.calle,
        numero: contenido.direccionEnvio.numero,
      },
      // En modo 'buyNow' se manda UNICAMENTE la linea de "Comprar ahora"
      // (nunca lo que ya hubiera en el carrito persistente, que en ese modo
      // no se toca en ningun momento). En modo 'cart', las lineas reales
      // del carrito, igual que antes.
      items: contenido.items,
      idempotencyKey: idempotencyKey,
    };
    if (contenido.direccionEnvio.pisoDepto) body.direccionEnvio.pisoDepto = contenido.direccionEnvio.pisoDepto;
    if (contenido.direccionEnvio.aclaraciones) body.direccionEnvio.aclaraciones = contenido.direccionEnvio.aclaraciones;

    var controller = new AbortController();
    solicitudPedidoEnCurso = controller;
    motivoAborto = null;
    timeoutIdSolicitudPedido = setTimeout(function () {
      motivoAborto = 'timeout';
      controller.abort();
    }, SUBMIT_TIMEOUT_MS);

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: response.ok, status: response.status, data: data }; });
      })
      .then(function (result) {
        // Si ya no es la solicitud "vigente" (se cancelo, o ya se agoto su
        // propio timeout y el usuario/flujo siguio adelante), esta
        // respuesta tardia nunca debe tocar el carrito, cerrar pantallas ni
        // redirigir: se descarta en silencio.
        if (controller !== solicitudPedidoEnCurso) return;
        clearTimeout(timeoutIdSolicitudPedido);
        timeoutIdSolicitudPedido = null;
        solicitudPedidoEnCurso = null;
        submitting = false;

        if (!result.ok || !result.data || typeof result.data.numero !== 'string') {
          // El carrito NUNCA se vacia si falla la creacion del pedido: el
          // comprador no pierde lo que ya habia armado.
          if (result.status === 409) {
            submitError = CONFLICT_ERROR_MESSAGE;
            // La idempotencyKey usada ya no corresponde al contenido
            // actual (segun el servidor): se descarta para que el proximo
            // intento use una nueva en vez de repetir el mismo conflicto.
            borrarIdempotenciaAlmacenada();
          } else {
            submitError = GENERIC_ERROR_MESSAGE;
          }
          render();
          return;
        }

        // Exito confirmado por el servidor: recien ACA se descarta la
        // idempotencyKey guardada (nunca antes, ni en el catch de abajo):
        // un timeout o un abort no garantizan que el servidor no haya
        // creado igual el pedido, asi que hasta este punto la clave debe
        // seguir disponible para que un reintento la reutilice.
        borrarIdempotenciaAlmacenada();
        sesionConIntentoPrevioSinConfirmar = false;

        pedidoConfirmadoNumero = result.data.numero;
        paymentRetryToken = typeof result.data.paymentRetryToken === 'string' ? result.data.paymentRetryToken : null;
        retryError = null;
        // El carrito se vacia UNICAMENTE aca, despues de una confirmacion
        // real del servidor (nunca antes, ni de forma optimista): el
        // pedido ya quedo registrado, se pueda o no continuar con el pago
        // en este mismo paso. En modo 'buyNow' el carrito persistente
        // nunca se toco (la linea de "Comprar ahora" es independiente), asi
        // que tampoco se vacia aca.
        if (mode !== 'buyNow') {
          window.PadelCart.clear();
        }
        if (isValidSandboxUrl(result.data.redirectUrl)) {
          // El pago ya se puede iniciar: se navega directo al checkout de
          // Mercado Pago sandbox. No hace falta mostrar la vista de
          // confirmacion (el comprador la va a ver al volver del pago).
          window.location.href = result.data.redirectUrl;
          return;
        }
        goto('confirmacion');
      })
      .catch(function () {
        if (controller !== solicitudPedidoEnCurso) return;
        clearTimeout(timeoutIdSolicitudPedido);
        timeoutIdSolicitudPedido = null;
        var motivo = motivoAborto;
        solicitudPedidoEnCurso = null;
        submitting = false;

        if (motivo === 'user') {
          // El comprador navego lejos a proposito (cerro el drawer, volvio
          // a editar sus datos): no se muestra ningun mensaje ni se toca
          // el carrito. La idempotencyKey queda guardada tal cual para un
          // futuro reintento del mismo contenido.
          render();
          return;
        }

        // Timeout o un error de red genuino: no hay forma de saber con
        // certeza si el servidor llego a crear el pedido antes de que se
        // perdiera la respuesta. Nunca se borra la idempotencyKey en este
        // caso: un reintento del mismo contenido la va a reusar y, gracias
        // a la RPC idempotente, va a devolver el MISMO pedido en vez de
        // crear uno duplicado.
        submitError = UNCERTAIN_RESULT_MESSAGE;
        render();
      });
  }

  // --- reintento de pago (POST /api/pedidos-preferencia) -------------------
  //
  // Solo se usa cuando el pedido ya se registro pero no se pudo iniciar el
  // pago en el mismo request. El cliente manda UNICAMENTE
  // paymentRetryToken (nunca el numero ni ningun otro dato del pedido).

  function retryPayment() {
    if (retrying || !paymentRetryToken) return;
    retrying = true;
    retryError = null;
    render();

    fetch(RETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentRetryToken: paymentRetryToken }),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        retrying = false;
        if (!result.ok || !result.data || !isValidSandboxUrl(result.data.redirectUrl)) {
          retryError = RETRY_ERROR_MESSAGE;
          render();
          return;
        }
        window.location.href = result.data.redirectUrl;
      })
      .catch(function () {
        retrying = false;
        retryError = RETRY_ERROR_MESSAGE;
        render();
      });
  }

  // --- wiring de eventos ---------------------------------------------------

  function onBodyInput(e) {
    var target = e.target;
    var key = target && target.dataset ? target.dataset.field : null;
    if (!key || !(key in formState)) return;
    formState[key] = target.value;
    if (currentError && currentError.campo === key) {
      currentError = null;
      // Solo se vuelve a pintar el borde/mensaje de error, sin perder foco
      // de mas de lo necesario: alcanza con quitar el estilo de error.
      target.style.borderColor = '';
      var next = target.parentElement && target.parentElement.querySelector('span[style*="ff6b6b"]');
      if (next) next.remove();
    }
  }

  function onBodyClick(e) {
    var target = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!target) return;
    if (target.dataset.action === 'retry-payment') retryPayment();
  }

  function resetToCarritoView() {
    // Si habia un POST /api/pedidos en vuelo, se cancela: una respuesta
    // tardia de un checkout que el comprador ya abandono nunca debe volver
    // a mutar el carrito, cerrar pantallas ni redirigir (ver el
    // .catch(...) de submitPedido).
    cancelarSolicitudPedidoPendiente();
    view = 'carrito';
    currentError = null;
    submitError = null;
    submitting = false;
    retryError = null;
    retrying = false;
    resetBuyNow();
  }

  // --- "Comprar ahora": inicia el checkout real de UN SOLO producto -------
  //
  // Llamado por widget/mercadopago-buy.js cuando se clickea un boton
  // [data-mp-buy-button] (modal de producto o tarjeta del asesor). Nunca
  // agrega la linea al carrito persistente (window.PadelCart): abre el
  // drawer directamente en el paso "Tus datos" con una unica linea en
  // memoria, sin obligar al comprador a pasar por la vista de carrito ni a
  // abrirlo manualmente.
  function startBuyNow(productId, talle) {
    if (!els.body) return; // el widget todavia no termino de inicializarse
    if (productId !== BUY_NOW_PRODUCT_ID) return; // unico producto piloto
    var summary = Core.buildCartSummary([{ productId: productId, talle: talle || null, cantidad: 1 }], getCatalogProduct);
    if (summary.lineas.length !== 1) return; // producto no resuelto contra el catalogo real

    cancelarSolicitudPedidoPendiente();
    submitting = false;
    mode = 'buyNow';
    buyNowLine = { productId: productId, talle: talle || null, cantidad: 1 };
    currentError = null;
    submitError = null;
    pedidoConfirmadoNumero = null;
    paymentRetryToken = null;
    retryError = null;
    retrying = false;
    if (window.PadelCart && typeof window.PadelCart.open === 'function') window.PadelCart.open();
    goto('formulario');
  }

  function init() {
    cacheEls();
    if (!els.body || !els.footerCart || !els.footerCheckout) return;

    // Si ya habia una idempotencyKey guardada de un intento anterior (la
    // pestaña se recargo o se restauro en medio de un checkout), se
    // conserva tal cual (sessionStorage ya la persistio) y solo se marca
    // para mostrar el aviso correspondiente: nunca se borra ni se genera
    // una nueva aca.
    sesionConIntentoPrevioSinConfirmar = Boolean(leerIdempotenciaAlmacenada());

    if (els.body) els.body.addEventListener('input', onBodyInput);
    if (els.body) els.body.addEventListener('change', onBodyInput);
    if (els.body) els.body.addEventListener('click', onBodyClick);

    if (els.continueBtn) {
      els.continueBtn.addEventListener('click', function () {
        var summary = window.PadelCart.getSummary();
        if (!summary.lineas.length) return;
        resetBuyNow();
        currentError = null;
        submitError = null;
        goto('formulario');
      });
    }

    if (els.backBtn) {
      els.backBtn.addEventListener('click', function () {
        if (view === 'formulario') {
          // "Volver al carrito" desde una compra directa ("Comprar ahora")
          // vuelve a mostrar el carrito persistente real (nunca la linea
          // de buyNow, que se descarta): son dos cosas independientes.
          resetBuyNow();
          goto('carrito');
        } else if (view === 'revision') {
          // Igual que al cerrar el drawer: si habia un envio en curso, se
          // cancela para que una respuesta tardia no vuelva a mutar nada
          // despues de que el comprador ya decidio volver a editar.
          cancelarSolicitudPedidoPendiente();
          submitting = false;
          currentError = null;
          goto('formulario');
        }
      });
    }

    if (els.nextBtn) {
      els.nextBtn.addEventListener('click', function () {
        if (view === 'formulario') intentarAvanzarARevision();
        else if (view === 'revision') submitPedido();
        else if (view === 'confirmacion') {
          // "Seguir comprando": el pedido ya quedo resuelto (con o sin
          // pago iniciado); se descarta cualquier token de reintento que
          // hubiera quedado en memoria, nunca se reutiliza para otro
          // pedido. Si el pedido resuelto fue una compra directa, tambien
          // se descarta ese modo: la proxima vez se vuelve a mostrar el
          // carrito persistente real.
          paymentRetryToken = null;
          retryError = null;
          resetBuyNow();
          goto('carrito');
        }
      });
    }

    // Si el drawer se cierra en medio del formulario/revision, la proxima
    // vez que se abra vuelve a mostrar el carrito (los datos ingresados no
    // se persisten: no es informacion que deba sobrevivir a cerrar el
    // drawer, y nunca se guarda en localStorage por ser datos del
    // comprador).
    if (els.closeBtn) els.closeBtn.addEventListener('click', resetToCarritoView);
    if (els.overlay) {
      els.overlay.addEventListener('click', function (e) {
        if (e.target === els.overlay) resetToCarritoView();
      });
    }

    window.PadelCart.onChange(function () {
      if (view === 'carrito') updateFooter();
    });

    updateFooter();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { whenReady(init); });
  } else {
    whenReady(init);
  }

  // API real: unico punto de entrada que otro archivo de produccion puede
  // llamar (hoy, widget/mercadopago-buy.js desde el boton "Comprar ahora").
  window.PadelCheckoutWidget = {
    startBuyNow: startBuyNow,
  };

  // Expuesto solo para pruebas (tests/padel-checkout-widget.test.js): nunca
  // se usa desde otro archivo de produccion.
  window.PadelCheckoutWidgetInternal = {
    getView: function () { return view; },
    getFormState: function () { return formState; },
    getPaymentRetryToken: function () { return paymentRetryToken; },
    getMode: function () { return mode; },
    getSubmitError: function () { return submitError; },
    isSubmitting: function () { return submitting; },
    getIdempotenciaAlmacenada: function () { return leerIdempotenciaAlmacenada(); },
    tieneSesionPreviaSinConfirmar: function () { return sesionConIntentoPrevioSinConfirmar; },
    cancelarSolicitudPendiente: function () { cancelarSolicitudPedidoPendiente(); },
    // Simula que se cumplio SUBMIT_TIMEOUT_MS sin esperar el tiempo real:
    // dispara exactamente lo mismo que el setTimeout real de submitPedido.
    simularTimeoutParaPruebas: function () {
      if (solicitudPedidoEnCurso) {
        motivoAborto = 'timeout';
        solicitudPedidoEnCurso.abort();
      }
    },
  };
})();
