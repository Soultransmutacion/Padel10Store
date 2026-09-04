'use strict';

// Redireccion permanente del hosting antiguo (GitHub Pages) hacia el sitio
// real en Vercel. Padel10Store se aloja ahora en
// https://padel10-store.vercel.app; el hosting antiguo en
// https://soultransmutacion.github.io/Padel10Store queda solo como
// redirector: nunca vuelve a servir el contenido real de la tienda.
//
// Este archivo es intencionalmente independiente del entorno (mismo
// criterio que lib/padel-cart.js): calcularRedireccionHostingAntiguo es
// una funcion PURA (nunca toca `location`, `document` ni hace ningun
// efecto) para poder probarla con Node puro (`require`), sin jsdom ni
// necesidad de simular una navegacion real. El unico efecto (location.replace)
// vive en index.html, en el bootstrap inline que llama a esta funcion.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PadelLegacyRedirect = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  var HOST_ANTIGUO = 'soultransmutacion.github.io';
  var PREFIJO_RUTA = '/Padel10Store';
  var DESTINO_ORIGIN = 'https://padel10-store.vercel.app';

  /**
   * Decide si corresponde redirigir el hosting antiguo, y a que URL exacta.
   *
   * hostname: debe coincidir EXACTAMENTE con HOST_ANTIGUO. Nunca un
   * sufijo/subdominio/dominio parecido: "soultransmutacion.github.io.evil.com",
   * "evil-soultransmutacion.github.io" o "notsoultransmutacion.github.io"
   * NUNCA deben matchear (comparacion ===, nunca includes/startsWith).
   * Tampoco redirige en localhost, cualquier dominio *.vercel.app (Preview
   * o Production) ni ningun otro hostname: la funcion es fail-closed, solo
   * actua ante ese unico hostname exacto.
   *
   * pathname: debe SER exactamente PREFIJO_RUTA, o empezar con
   * PREFIJO_RUTA + "/". Nunca un prefijo parcial: "/Padel10Store-otro" o
   * "/Padel10StoreClon" NUNCA deben matchear.
   *
   * Devuelve la URL de destino (string) preservando la ruta interna util
   * (todo lo que sigue al prefijo), el query string y el hash tal cual,
   * quitando UNICAMENTE el prefijo "/Padel10Store"; o null si no
   * corresponde redirigir.
   */
  function calcularRedireccionHostingAntiguo(hostname, pathname, search, hash) {
    if (hostname !== HOST_ANTIGUO) return null;

    var path = typeof pathname === 'string' ? pathname : '';
    var esRutaExacta = path === PREFIJO_RUTA;
    var esSubruta = path.indexOf(PREFIJO_RUTA + '/') === 0;
    if (!esRutaExacta && !esSubruta) return null;

    // Se concatena a mano sobre un origin FIJO (DESTINO_ORIGIN), nunca via
    // resolucion de URL relativa (`new URL(resto, base)`): si "resto"
    // empezara con "//" (por ejemplo, una ruta manipulada como
    // "/Padel10Store//evil.com"), una resolucion relativa lo interpretaria
    // como protocol-relative y CAMBIARIA de host. Concatenando un string a
    // mano sobre un origin fijo, el host de destino nunca puede ser otro
    // que DESTINO_ORIGIN, sin importar el contenido de "resto". Igual se
    // colapsa cualquier "/" inicial repetido a una sola, por prolijidad y
    // como capa extra.
    var resto = path.slice(PREFIJO_RUTA.length).replace(/^\/+/, '/');
    if (resto === '') resto = '/';

    return DESTINO_ORIGIN + resto + (search || '') + (hash || '');
  }

  return {
    HOST_ANTIGUO: HOST_ANTIGUO,
    PREFIJO_RUTA: PREFIJO_RUTA,
    DESTINO_ORIGIN: DESTINO_ORIGIN,
    calcularRedireccionHostingAntiguo: calcularRedireccionHostingAntiguo,
  };
});
