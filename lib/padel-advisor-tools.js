'use strict';

const catalog = require('./padel-catalog');

const TOOL_DEFINITIONS = [
  {
        name: 'buscar_catalogo',
        description:
                'Busca productos reales en el catalogo de Padel10Store por texto libre, marca, tipo de producto y rango de precio. Nunca inventa productos: solo devuelve lo que existe en products.json.',
        input_schema: {
                type: 'object',
                properties: {
                          texto: { type: 'string', description: 'Texto libre a buscar en nombre, marca o seccion.' },
                          marca: { type: 'string', description: 'Marca exacta, por ejemplo Royal Padel, Bullpadel, Siux, Adidas.' },
                          tipo: { type: 'string', description: 'Tipo de producto, por ejemplo Paleta, Accesorio, Ropa Hombre.' },
                          precioMin: { type: 'number', description: 'Precio minimo en pesos argentinos.' },
                          precioMax: { type: 'number', description: 'Precio maximo en pesos argentinos.' },
                },
                additionalProperties: false,
        },
  },
  {
        name: 'filtrar_palas',
        description:
                'Filtra especificamente palas (paletas) del catalogo real segun presupuesto y caracteristicas tecnicas confirmadas. Solo aplica un filtro si el dato fue provisto por el usuario.',
        input_schema: {
                type: 'object',
                properties: {
                          presupuestoMin: { type: 'number' },
                          presupuestoMax: { type: 'number' },
                          marca: { type: 'string' },
                          forma: { type: 'string', description: 'redondo, diamante, lagrima, etc.' },
                          balance: { type: 'string' },
                          peso: { type: 'string' },
                          material: { type: 'string' },
                          nivel: { type: 'string' },
                          estilo: { type: 'string' },
                          clasificacionComercial: {
                                      type: 'string',
                                      description: 'control, ataque, polivalente, ninos, etc. Es la clasificacion comercial del sitio, no un hecho tecnico verificado.',
                          },
                          version: { type: 'string', enum: ['liviana', 'femenina', 'junior', 'infantil'] },
                },
                additionalProperties: false,
        },
  },
  {
        name: 'comparar_productos',
        description:
                'Compara entre 2 y 3 productos reales por su ID exacto. Devuelve unicamente campos confirmados; usa "No confirmado" donde falte el dato.',
        input_schema: {
                type: 'object',
                properties: {
                          ids: {
                                      type: 'array',
                                      items: { type: 'string' },
                                      minItems: 2,
                                      maxItems: 3,
                                      description: 'IDs reales de producto obtenidos previamente con buscar_catalogo, filtrar_palas o ver_producto.',
                          },
                },
                required: ['ids'],
                additionalProperties: false,
        },
  },
  {
        name: 'ver_producto',
        description:
                'Devuelve la ficha de un producto real por su ID exacto, lista para mostrar como tarjeta, incluyendo el enlace de WhatsApp precargado.',
        input_schema: {
                type: 'object',
                properties: {
                          id: { type: 'string', description: 'ID real del producto.' },
                },
                required: ['id'],
                additionalProperties: false,
        },
  },
  ];

function isPlainString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function executeTool(name, rawInput) {
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};

  if (name === 'buscar_catalogo') {
        const args = {};
        if (isPlainString(input.texto)) args.texto = input.texto.slice(0, 80);
        if (isPlainString(input.marca)) args.marca = input.marca.slice(0, 60);
        if (isPlainString(input.tipo)) args.tipo = input.tipo.slice(0, 60);
        if (isFiniteNumber(input.precioMin)) args.precioMin = Math.max(0, input.precioMin);
        if (isFiniteNumber(input.precioMax)) args.precioMax = Math.max(0, input.precioMax);
        const resultados = catalog.searchCatalog(args);
        return { ok: true, resultados: resultados, total: resultados.length };
  }

  if (name === 'filtrar_palas') {
        const args = {};
        if (isFiniteNumber(input.presupuestoMin)) args.presupuestoMin = Math.max(0, input.presupuestoMin);
        if (isFiniteNumber(input.presupuestoMax)) args.presupuestoMax = Math.max(0, input.presupuestoMax);
        if (isPlainString(input.marca)) args.marca = input.marca.slice(0, 60);
        if (isPlainString(input.forma)) args.forma = input.forma.slice(0, 40);
        if (isPlainString(input.balance)) args.balance = input.balance.slice(0, 40);
        if (isPlainString(input.peso)) args.peso = input.peso.slice(0, 40);
        if (isPlainString(input.material)) args.material = input.material.slice(0, 40);
        if (isPlainString(input.nivel)) args.nivel = input.nivel.slice(0, 40);
        if (isPlainString(input.estilo)) args.estilo = input.estilo.slice(0, 40);
        if (isPlainString(input.clasificacionComercial)) args.clasificacionComercial = input.clasificacionComercial.slice(0, 40);
        if (['liviana', 'femenina', 'junior', 'infantil'].indexOf(input.version) !== -1) args.version = input.version;
        const resultados = catalog.filterPalas(args);
        return { ok: true, resultados: resultados, total: resultados.length };
  }

  if (name === 'comparar_productos') {
        if (!Array.isArray(input.ids)) {
                return { ok: false, error: 'ids debe ser una lista de 2 a 3 IDs reales.' };
        }
        const ids = input.ids.filter(isPlainString).map((id) => id.trim()).slice(0, 3);
        if (ids.length < 2) {
                return { ok: false, error: 'Se necesitan al menos 2 IDs validos para comparar.' };
        }
        const comparison = catalog.compareProducts(ids);
        return { ok: true, productos: comparison.productos, noEncontrados: comparison.noEncontrados };
  }

  if (name === 'ver_producto') {
        if (!isPlainString(input.id)) {
                return { ok: false, error: 'id de producto invalido.' };
        }
        const card = catalog.verProducto(input.id.trim());
        if (!card) {
                return { ok: false, error: 'Producto no encontrado en el catalogo real.' };
        }
        return { ok: true, producto: card };
  }

  return { ok: false, error: 'Herramienta desconocida: ' + name };
}

module.exports = { TOOL_DEFINITIONS: TOOL_DEFINITIONS, executeTool: executeTool };
