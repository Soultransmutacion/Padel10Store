(function () {
  'use strict';

  /**
   * Medicion de visitas y compras: Google Analytics 4 y pixel de Meta.
   *
   * - Las etiquetas se cargan SOLO si lib/analytics-config.js tiene IDs con
   *   formato valido. Con los IDs en null (estado actual), este archivo no
   *   carga nada de terceros: solo conserva los parametros de campaña.
   * - Escucha los eventos 'padel10:evento' que emiten la ficha de producto
   *   (index.html), el carrito (widget/padel-cart.js) y el checkout
   *   (widget/padel-checkout.js), y los traduce a:
   *     ver_producto     -> GA4 view_item      / Meta ViewContent
   *     agregar_carrito  -> GA4 add_to_cart    / Meta AddToCart
   *     inicio_checkout  -> GA4 begin_checkout / Meta InitiateCheckout
   *     pedido_registrado-> GA4 pedido_registrado (evento propio)
   *     compra_confirmada-> GA4 purchase       / Meta Purchase
   *   "compra_confirmada" lo dispara mercadopago/success.html cuando
   *   Mercado Pago vuelve con el pago aprobado (una sola vez por pago).
   * - Nunca envia nombre, email, telefono ni direccion del comprador.
   * - Conserva utm_*, gclid y fbclid de la URL de llegada (sessionStorage,
   *   y localStorage por 30 dias) para que la atribucion no se pierda al
   *   ir y volver de Mercado Pago o al abrir las paginas legales.
   */

  var CONFIG = window.PadelAnalyticsConfig || {};
  var GA4_REGEX = /^G-[A-Z0-9]{4,20}$/;
  var PIXEL_REGEX = /^[0-9]{8,20}$/;
  var ATRIBUCION_KEY = 'padel10store:atribucion';
  var ATRIBUCION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  var PARAMS_CAMPANA = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'gclid', 'fbclid'];
  var MONEDA = 'ARS';

  var ga4Id = typeof CONFIG.ga4MeasurementId === 'string' && GA4_REGEX.test(CONFIG.ga4MeasurementId) ? CONFIG.ga4MeasurementId : null;
  var pixelId = typeof CONFIG.metaPixelId === 'string' && PIXEL_REGEX.test(CONFIG.metaPixelId) ? CONFIG.metaPixelId : null;

  // --- parametros de campaña (UTM) ----------------------------------------

  function leerAtribucionDeUrl(search) {
    var datos = {};
    var hay = false;
    try {
      var params = new URLSearchParams(search || '');
      PARAMS_CAMPANA.forEach(function (k) {
        var v = params.get(k);
        if (v && v.length <= 200) {
          datos[k] = v;
          hay = true;
        }
      });
    } catch (e) {}
    return hay ? datos : null;
  }

  function guardar(storage, valor) {
    try { storage.setItem(ATRIBUCION_KEY, JSON.stringify(valor)); } catch (e) {}
  }

  function leer(storage) {
    try {
      var raw = storage.getItem(ATRIBUCION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function getAtribucion() {
    var sesion = leer(window.sessionStorage);
    if (sesion && sesion.params) return sesion.params;
    var local = leer(window.localStorage);
    if (local && local.params && typeof local.ts === 'number' && Date.now() - local.ts < ATRIBUCION_TTL_MS) return local.params;
    return null;
  }

  var deUrl = leerAtribucionDeUrl(window.location.search);
  if (deUrl) {
    var registro = { params: deUrl, ts: Date.now(), landing: window.location.pathname };
    guardar(window.sessionStorage, registro);
    guardar(window.localStorage, registro);
  }

  // --- carga de etiquetas -------------------------------------------------

  function cargarScript(src) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
  }

  if (ga4Id) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    // Si la pagina actual no trae UTM pero la visita si (por ejemplo, al
    // volver de Mercado Pago), se las pasamos a GA4 como datos de campaña.
    var configGa = { send_page_view: true };
    var atrib = !deUrl ? getAtribucion() : null;
    if (atrib) {
      if (atrib.utm_source) configGa.campaign_source = atrib.utm_source;
      if (atrib.utm_medium) configGa.campaign_medium = atrib.utm_medium;
      if (atrib.utm_campaign) configGa.campaign_name = atrib.utm_campaign;
      if (atrib.utm_term) configGa.campaign_term = atrib.utm_term;
      if (atrib.utm_content) configGa.campaign_content = atrib.utm_content;
    }
    window.gtag('config', ga4Id, configGa);
    cargarScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ga4Id));
  }

  if (pixelId) {
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', pixelId);
    window.fbq('track', 'PageView');
  }

  // --- traduccion de eventos ----------------------------------------------

  function numero(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function itemDeProducto(p, cantidad, talle) {
    p = p || {};
    var item = {
      item_id: p.id || p.productId || '',
      item_name: p.nombre || '',
      item_brand: p.marca || 'Royal Padel',
      price: numero(p.precio),
      quantity: cantidad || p.cantidad || 1,
    };
    if (p.tipoProducto) item.item_category = p.tipoProducto;
    if (talle || p.talle) item.item_variant = 'Talle ' + (talle || p.talle);
    return item;
  }

  function itemsDeResumen(resumen) {
    var lineas = resumen && Array.isArray(resumen.lineas) ? resumen.lineas : [];
    return lineas.map(function (l) { return itemDeProducto(l, l.cantidad, l.talle); });
  }

  function valorDe(items) {
    return items.reduce(function (acc, it) { return acc + it.price * it.quantity; }, 0);
  }

  function enviarGa(nombre, params) {
    if (ga4Id && typeof window.gtag === 'function') window.gtag('event', nombre, params);
  }

  function enviarMeta(nombre, params, opciones) {
    if (pixelId && typeof window.fbq === 'function') window.fbq('track', nombre, params, opciones || {});
  }

  function conAtribucion(params) {
    var a = getAtribucion();
    if (a) {
      if (a.utm_source) params.utm_source = a.utm_source;
      if (a.utm_medium) params.utm_medium = a.utm_medium;
      if (a.utm_campaign) params.utm_campaign = a.utm_campaign;
    }
    return params;
  }

  function manejar(tipo, datos) {
    datos = datos || {};
    var items;
    if (tipo === 'ver_producto' && datos.producto) {
      items = [itemDeProducto(datos.producto, 1)];
      enviarGa('view_item', { currency: MONEDA, value: valorDe(items), items: items });
      enviarMeta('ViewContent', { content_ids: [items[0].item_id], content_name: items[0].item_name, content_type: 'product', value: valorDe(items), currency: MONEDA });
    } else if (tipo === 'agregar_carrito' && datos.producto) {
      items = [itemDeProducto(datos.producto, datos.cantidad || 1, datos.talle)];
      enviarGa('add_to_cart', { currency: MONEDA, value: valorDe(items), items: items });
      enviarMeta('AddToCart', { content_ids: [items[0].item_id], content_type: 'product', value: valorDe(items), currency: MONEDA });
    } else if (tipo === 'inicio_checkout') {
      items = itemsDeResumen(datos.resumen);
      enviarGa('begin_checkout', conAtribucion({ currency: MONEDA, value: valorDe(items), items: items }));
      enviarMeta('InitiateCheckout', { content_ids: items.map(function (i) { return i.item_id; }), content_type: 'product', num_items: items.length, value: valorDe(items), currency: MONEDA });
    } else if (tipo === 'pedido_registrado') {
      items = itemsDeResumen(datos.resumen);
      enviarGa('pedido_registrado', conAtribucion({ currency: MONEDA, value: valorDe(items), envio_a_confirmar: datos.envioAConfirmar === true, items: items }));
    } else if (tipo === 'compra_confirmada') {
      var transaccion = String(datos.transactionId || '');
      if (!transaccion) return;
      var dedupeKey = 'padel10store:compraMedida:' + transaccion;
      try {
        if (window.localStorage.getItem(dedupeKey)) return;
        window.localStorage.setItem(dedupeKey, '1');
      } catch (e) {}
      items = Array.isArray(datos.items) ? datos.items.map(function (l) { return itemDeProducto(l, l.cantidad, l.talle); }) : [];
      var valor = typeof datos.total === 'number' ? datos.total : valorDe(items);
      enviarGa('purchase', conAtribucion({ transaction_id: transaccion, currency: MONEDA, value: valor, shipping: numero(datos.envio), items: items }));
      enviarMeta('Purchase', { content_ids: items.map(function (i) { return i.item_id; }), content_type: 'product', value: valor, currency: MONEDA }, { eventID: transaccion });
    }
  }

  document.addEventListener('padel10:evento', function (e) {
    var d = e && e.detail;
    if (!d || typeof d.tipo !== 'string') return;
    try { manejar(d.tipo, d.datos); } catch (err) {}
  });

  window.PadelAnalytics = {
    activo: Boolean(ga4Id || pixelId),
    ga4Activo: Boolean(ga4Id),
    metaActivo: Boolean(pixelId),
    getAtribucion: getAtribucion,
    track: manejar,
    _leerAtribucionDeUrl: leerAtribucionDeUrl,
  };
})();
