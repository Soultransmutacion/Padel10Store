# Padel10Store
Tienda online de artículos de pádel - Padel10Store

## Catalogo estructurado (products.json)

El archivo `products.json` contiene los datos estructurados que usa el asesor de productos. El catálogo visible está en `index.html`; al cambiar un producto, hay que actualizar ambos archivos y validar que coincidan. No inventes precio, stock ni características técnicas: un valor `null` significa “no confirmado”. El catálogo actual tiene 81 productos.

Campos relevantes por producto:
- `especificaciones`: datos tecnicos verificados en fuentes oficiales (forma, balance, peso, materiales, nucleo, etc.). Un valor `null` significa "no confirmado" y no debe completarse con informacion inventada.
- `fuentes`: URLs oficiales (fabricante o distribuidor autorizado) usadas para verificar los datos tecnicos de cada pala. Si esta vacio, no se encontro una fuente oficial vigente para ese modelo.
- `nivelRecomendadoEsInferencia` / `estiloJuegoEsInferencia`: cuando son `true`, el valor es una inferencia razonada a partir de datos tecnicos, no una afirmacion oficial del fabricante.

## Validacion de sincronizacion (validate-catalog.js)

Este script compara `products.json` contra las tarjetas reales de `index.html` para detectar productos faltantes, IDs duplicados, nombres/marcas/precios distintos, imagenes faltantes y precios "Consultar" mal representados como $0.

Requiere tener Node.js instalado (no usa dependencias externas). Para ejecutarlo, pararse en la carpeta del proyecto y correr:

```
node validate-catalog.js
```

El script termina con codigo de salida 1 y detalla cada diferencia encontrada si el catalogo no esta sincronizado, o con codigo 0 si todo coincide.

## Actualizar el catálogo paso a paso

Seguí la [guía para mantener el catálogo](GUIA_CATALOGO.md). Explica qué archivo editar para cada cambio y cómo comprobar que las fichas sigan sincronizadas.
