# Padel10Store
Tienda online de artículos de pádel - Padel10Store

## Catalogo estructurado (products.json)

El archivo `products.json` es la fuente de datos estructurada del catalogo (92 productos), generada a partir de `index.html`. Es la unica fuente que debe usar el futuro asistente de IA: nunca debe inventar productos, precios, stock ni caracteristicas tecnicas que no figuren alli.

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
