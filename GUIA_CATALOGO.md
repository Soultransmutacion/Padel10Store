# Guía simple para mantener el catálogo

Esta tienda tiene dos archivos con información de productos. Hoy no hay un editor visual que los sincronice automáticamente, así que cualquier alta o cambio de producto debe hacerse en ambos.

## Qué archivo editar

- `index.html`: lo que ve la persona que compra: foto, nombre, categoría, precio y botón.
- `products.json`: los datos que usa el asesor de productos y algunas funciones de la tienda.

Usá el mismo `id` en los dos archivos. Ese identificador une la tarjeta con su ficha; no lo cambies al corregir el precio o la foto.

## Cambiar un precio o una foto

1. Buscá el producto por nombre en `index.html` y actualizá el dato visible.
2. Buscá su `id` en `products.json` y actualizá el mismo dato allí.
3. Si cambia el precio, actualizá también `precioTransferencia` solo con el valor que la tienda haya confirmado.
4. Si la disponibilidad no fue confirmada, dejá `stockConfirmado` en `false`.
5. Ejecutá la validación que aparece abajo.

## Agregar o quitar un producto

- Para agregarlo, copiá una tarjeta existente en la sección correcta de `index.html`, asignale un `id` nuevo y único y agregá el objeto correspondiente a la lista `productos` de `products.json`.
- Para quitarlo, borrá la tarjeta y su objeto del catálogo.
- Después de agregar o quitar, actualizá `meta.totalProductos` en `products.json` para que coincida con la cantidad de productos listados.
- No publiques un producto sin precio. Si el precio no está confirmado, no lo agregues al catálogo visible hasta tenerlo.

## Revisar que todo coincida

Con Node.js instalado, abrí una terminal dentro de la carpeta del proyecto y ejecutá:

```sh
node validate-catalog.js
```

Si aparece un error, corregí lo que indique y volvé a ejecutar el comando. La guía no publica cambios: solo explica cómo mantener los archivos y verificar la sincronización.

## Antes de mostrar condiciones

El stock no se confirma automáticamente. Los medios de pago, costos y plazos de envío también se deben confirmar antes de anunciarlos. No marques `stockConfirmado` como `true` sin una confirmación real.
