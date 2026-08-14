'use strict';

const catalog = require('./padel-catalog');
const PadelCartCore = require('./padel-cart');
const PadelProfile = require('./padel-profile');
const PadelRecommender = require('./padel-recommender');
const PadelChooser = require('./padel-chooser');

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
      'Compara entre 2 y 3 productos reales. Usa "ids" cuando ya tenes los IDs exactos de una herramienta anterior en esta conversacion. Usa "referencias" cuando el cliente compara por posicion o criterio sobre la ULTIMA lista de productos mostrada, por ejemplo "comparame la primera con la segunda", "comparame esa con la segunda" o "comparame la mas barata con la mas cara": cada elemento de "referencias" identifica un producto exactamente igual que en agregar_al_carrito (productId exacto ya obtenido, o referenciaPosicion primera/segunda/tercera, o referenciaCriterio esa/mas_barata/mas_cara). Nunca inventes ni recuerdes un ID de memoria para completar "ids": si el cliente compara por posicion o criterio, usa siempre "referencias". Devuelve unicamente campos confirmados; usa "No confirmado" donde falte el dato.',
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
        referencias: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              productId: { type: 'string', description: 'ID exacto de producto ya obtenido en esta conversacion.' },
              referenciaPosicion: {
                type: 'string',
                enum: ['primera', 'segunda', 'tercera'],
                description: 'Usar cuando el cliente dice "la primera/segunda/tercera" sobre la ultima lista de productos mostrada.',
              },
              referenciaCriterio: {
                type: 'string',
                enum: ['esa', 'mas_barata', 'mas_cara'],
                description: 'Usar cuando el cliente dice "esa"/"ese" (un solo producto en contexto reciente), "la mas barata" o "la mas cara" de la ultima lista mostrada.',
              },
            },
            additionalProperties: false,
          },
          description: 'Usar en vez de "ids" cuando el cliente compara productos por posicion o criterio en lugar de darte IDs explicitos. Cada elemento identifica un producto real dentro de la ultima lista ofrecida.',
        },
      },
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
  {
    name: 'agregar_al_carrito',
    description:
      'Agrega una unidad real (validada contra el catalogo) al carrito unico de la tienda. Nunca inventes un productId: usa el ID exacto de una herramienta anterior, o referi el producto por su posicion (referenciaPosicion) o criterio (referenciaCriterio) dentro de la ULTIMA lista de productos mostrada en la conversacion. Si el producto requiere talle y no lo diste, la herramienta lo rechaza y te dice que talles existen: preguntale al cliente cual quiere antes de reintentar.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'string', description: 'ID exacto de producto ya obtenido de buscar_catalogo, filtrar_palas, ver_producto o comparar_productos en esta conversacion.' },
        referenciaPosicion: {
          type: 'string',
          enum: ['primera', 'segunda', 'tercera'],
          description: 'Usar cuando el cliente dice "la primera/segunda/tercera" sobre la ultima lista de productos mostrada.',
        },
        referenciaCriterio: {
          type: 'string',
          enum: ['esa', 'mas_barata', 'mas_cara'],
          description: 'Usar cuando el cliente dice "esa"/"ese" (un solo producto en contexto reciente), "la mas barata" o "la mas cara" de la ultima lista mostrada.',
        },
        talle: { type: 'string', description: 'Talle exacto elegido por el cliente, solo si el producto lo requiere.' },
        cantidad: { type: 'number', description: 'Cantidad a agregar. Si no se indica, se agrega 1.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ver_carrito',
    description:
      'Devuelve el contenido REAL y actual del carrito unico de la tienda (recalculado siempre contra el catalogo: nunca uses un total o precio que no venga de esta herramienta).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'quitar_del_carrito',
    description:
      'Saca del carrito una linea real ya existente. Referi el producto por productId exacto, por posicion/criterio de la ultima lista mostrada (referenciaPosicion/referenciaCriterio), o con una descripcion libre de lo que el cliente ve en SU carrito (por ejemplo "la pala" o "las medias negras") en el campo descripcion. Si hay mas de una linea del mismo producto en distintos talles, usa talle para desambiguar.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        referenciaPosicion: { type: 'string', enum: ['primera', 'segunda', 'tercera'] },
        referenciaCriterio: { type: 'string', enum: ['esa', 'mas_barata', 'mas_cara'] },
        descripcion: { type: 'string', description: 'Descripcion libre de la linea del carrito a sacar, cuando el cliente no usa una referencia de lista sino que describe lo que ya tiene en el carrito.' },
        talle: { type: 'string', description: 'Talle para desambiguar si el mismo producto esta en el carrito en mas de un talle.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'modificar_cantidad_carrito',
    description:
      'Cambia la cantidad de una linea real ya existente en el carrito a un valor absoluto (nuevaCantidad). Para identificar la linea, usa las mismas opciones que quitar_del_carrito (productId, referenciaPosicion, referenciaCriterio, descripcion, talle).',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        referenciaPosicion: { type: 'string', enum: ['primera', 'segunda', 'tercera'] },
        referenciaCriterio: { type: 'string', enum: ['esa', 'mas_barata', 'mas_cara'] },
        descripcion: { type: 'string' },
        talle: { type: 'string' },
        nuevaCantidad: { type: 'number', description: 'Cantidad final deseada para esa linea (no un incremento).' },
      },
      required: ['nuevaCantidad'],
      additionalProperties: false,
    },
  },
  {
    name: 'actualizar_perfil_compra',
    description:
      'Actualiza el perfil de compra TEMPORAL del cliente para esta conversacion (nivel de juego, estilo, prioridad, presupuesto maximo y forma preferida de pala), a partir unicamente de lo que el cliente declaro sobre si mismo. Nunca es memoria permanente ni datos personales: no uses esta herramienta para nombre, direccion, telefono, email ni datos de envio. Incluye solo los campos que el cliente menciono en este mensaje: los campos que no incluyas se mantienen exactamente como estaban, nunca se borran. Si el cliente cambia de opinion sobre un dato ya guardado (por ejemplo paso de pedir potencia a pedir control), volve a llamar esta herramienta con el mismo campo y el valor nuevo: el valor mas reciente siempre reemplaza al anterior. Esta herramienta es infraestructura interna: nunca le anuncies al cliente que "actualizaste su perfil", seguí conversando con naturalidad.',
    input_schema: {
      type: 'object',
      properties: {
        nivel: {
          type: 'string',
          enum: PadelProfile.NIVEL_ENUM,
          description: 'Nivel o categoria de juego que declara el cliente.',
        },
        estilo: {
          type: 'string',
          enum: PadelProfile.ESTILO_ENUM,
          description: 'Estilo de juego que declara el cliente.',
        },
        prioridad: {
          type: 'string',
          enum: PadelProfile.PRIORIDAD_ENUM,
          description: 'Que prioriza el cliente en una pala.',
        },
        presupuestoMax: {
          type: 'number',
          description: 'Presupuesto maximo en pesos argentinos que declara el cliente, ya interpretado como numero (por ejemplo "300 mil", "200 lucas" o "hasta $250.000" es 300000, 200000 o 250000).',
        },
        formaPreferida: {
          type: 'string',
          enum: PadelProfile.FORMA_PREFERIDA_ENUM,
          description: 'Forma de pala preferida por el cliente, solo si la menciono.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'recomendar_productos',
    description:
      'Ordena PALAS reales del catalogo segun el perfil de compra ya declarado por el cliente (nivel, estilo, prioridad, presupuesto, forma preferida), combinado opcionalmente con datos nuevos de este mismo turno. El ranking lo calcula siempre el codigo, nunca vos: nunca reordenes ni elijas "la mejor" por tu cuenta, usa siempre el orden que devuelve esta herramienta (mejorCoincidencia, siguientesOpciones, alternativaEconomica). No expone porcentajes ni puntajes: usa unicamente motivos y advertencias reales para explicar cada resultado.',
    input_schema: {
      type: 'object',
      properties: {
        nivel: { type: 'string', enum: PadelProfile.NIVEL_ENUM, description: 'Solo si el cliente declaro un nivel nuevo o distinto en este turno.' },
        estilo: { type: 'string', enum: PadelProfile.ESTILO_ENUM, description: 'Solo si el cliente declaro un estilo nuevo o distinto en este turno.' },
        prioridad: { type: 'string', enum: PadelProfile.PRIORIDAD_ENUM, description: 'Solo si el cliente declaro una prioridad nueva o distinta en este turno.' },
        presupuestoMax: { type: 'number', description: 'Solo si el cliente declaro un presupuesto nuevo o distinto en este turno, en pesos argentinos.' },
        formaPreferida: { type: 'string', enum: PadelProfile.FORMA_PREFERIDA_ENUM, description: 'Solo si el cliente declaro una forma preferida nueva o distinta en este turno.' },
        limit: { type: 'number', description: 'Cantidad maxima de resultados a devolver. Si no se indica, se usa un valor por defecto razonable.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elegir_producto_para_usuario',
    description:
      'Elige, entre 2 o 3 productos reales ya comparados u ofrecidos, cual conviene mas para el perfil de compra del cliente (por ejemplo cuando pregunta "cual me conviene", "cual elegirias para mi", "con cual me quedo" o "entre esas dos, cual me recomendas"). Usa "ids" o "referencias" exactamente igual que comparar_productos cuando el cliente especifica los productos; si no especifica nada, la herramienta usa automaticamente los ultimos productos comparados u ofrecidos en la conversacion. El codigo decide siempre el ganador (nunca vos): si hayGanador es false, no hay una eleccion honesta todavia (empate real o falta de informacion en el perfil) y no debes elegir arbitrariamente.',
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 3,
          description: 'IDs reales de producto obtenidos previamente con buscar_catalogo, filtrar_palas, ver_producto o comparar_productos.',
        },
        referencias: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              productId: { type: 'string', description: 'ID exacto de producto ya obtenido en esta conversacion.' },
              referenciaPosicion: {
                type: 'string',
                enum: ['primera', 'segunda', 'tercera'],
                description: 'Usar cuando el cliente dice "la primera/segunda/tercera" sobre la ultima lista de productos mostrada.',
              },
              referenciaCriterio: {
                type: 'string',
                enum: ['esa', 'mas_barata', 'mas_cara'],
                description: 'Usar cuando el cliente dice "esa"/"ese", "la mas barata" o "la mas cara" de la ultima lista mostrada.',
              },
            },
            additionalProperties: false,
          },
          description: 'Usar cuando el cliente identifica los productos por posicion o criterio (por ejemplo "entre la primera y la segunda, cual me conviene") en vez de listar IDs.',
        },
        nivel: { type: 'string', enum: PadelProfile.NIVEL_ENUM, description: 'Solo si el cliente declaro un nivel nuevo o distinto en este turno, antes de pedir la eleccion.' },
        estilo: { type: 'string', enum: PadelProfile.ESTILO_ENUM, description: 'Solo si el cliente declaro un estilo nuevo o distinto en este turno.' },
        prioridad: { type: 'string', enum: PadelProfile.PRIORIDAD_ENUM, description: 'Solo si el cliente declaro una prioridad nueva o distinta en este turno (por ejemplo "en realidad prefiero control").' },
        presupuestoMax: { type: 'number', description: 'Solo si el cliente declaro un presupuesto nuevo o distinto en este turno, en pesos argentinos.' },
        formaPreferida: { type: 'string', enum: PadelProfile.FORMA_PREFERIDA_ENUM, description: 'Solo si el cliente declaro una forma preferida nueva o distinta en este turno.' },
      },
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

// Vista del producto que ve el modelo para redactar su respuesta. Nunca
// incluye el numero de telefono, el mensaje precargado ni el link de
// WhatsApp: el modelo solo necesita saber que existe un boton de contacto
// disponible. El link real (buildWhatsappLink) viaja unicamente dentro de
// "producto" (la tarjeta completa), que el servidor usa para el cliente y
// nunca se le pasa al modelo como texto.
function buildProductoParaModelo(card) {
  return {
    id: card.id,
    nombre: card.nombre,
    marca: card.marca,
    tipoProducto: card.tipoProducto,
    imagen: card.imagen,
    precio: card.precio,
    precioFormateado: card.precioFormateado,
    precioTransferencia: card.precioTransferencia,
    precioTransferenciaFormateado: card.precioTransferenciaFormateado,
    precioConsultar: card.precioConsultar,
    cuotasTexto: card.cuotasTexto,
    caracteristicasConfirmadas: card.caracteristicasConfirmadas,
    confianza: card.confianza,
    talles: card.talles,
    contactoWhatsappDisponible: true,
  };
}

// Unica forma en que las herramientas de carrito obtienen un producto real:
// siempre por ID exacto contra el catalogo (products.json), nunca contra un
// objeto que haya viajado desde el navegador o desde el modelo.
function getProduct(id) {
  return catalog.getProductById(id);
}

// Resuelve productId/referenciaPosicion/referenciaCriterio contra la lista de
// productos realmente ofrecidos en la conversacion (ver lib/padel-advisor.js,
// que arma esa lista solo a partir de resultados reales de herramientas).
// Este es el UNICO camino por el que "la segunda" o "esa" se convierten en un
// productId: nunca se acepta una posicion o criterio sin una lista real
// detras, y un productId explicito solo se acepta si despues resuelve a un
// producto real del catalogo (ver handleAgregarAlCarrito).
function resolveReferencedProductId(input, offeredProducts) {
  const params = {};
  if (isPlainString(input.productId)) params.productId = input.productId.trim();
  if (isPlainString(input.referenciaPosicion)) params.referenciaPosicion = input.referenciaPosicion.trim();
  if (isPlainString(input.referenciaCriterio)) params.referenciaCriterio = input.referenciaCriterio.trim();
  return PadelCartCore.resolveOfferedReference(params, offeredProducts, getProduct);
}

function handleAgregarAlCarrito(input, offeredProducts) {
  const resolved = resolveReferencedProductId(input, offeredProducts);
  if (!resolved.ok) return resolved;
  const product = getProduct(resolved.productId);
  if (!product) return { ok: false, error: 'producto_no_encontrado' };

  const talle = isPlainString(input.talle) ? input.talle.trim() : undefined;
  const cantidad = isFiniteNumber(input.cantidad) ? input.cantidad : undefined;
  const built = PadelCartCore.buildLine(product, talle, cantidad);
  if (!built.ok) return built; // talle_requerido (+tallesDisponibles), talle_invalido, talle_no_aplica, cantidad_invalida, precio_consultar, producto_invalido

  const card = catalog.toCard(product);
  return {
    ok: true,
    accion: { tipo: 'agregar_al_carrito', productId: built.line.productId, talle: built.line.talle, cantidad: built.line.cantidad },
    producto: card,
    productoParaModelo: buildProductoParaModelo(card),
  };
}

// Resuelve una referencia (productId | referenciaPosicion | referenciaCriterio)
// contra la lista de ofrecidos, con el mismo mecanismo determinista que ya usan
// las herramientas de carrito (resolveReferencedProductId), y ademas valida que
// el productId resuelto exista de verdad en el catalogo real: resolveOfferedReference
// nunca valida un productId explicito por si solo (ver lib/padel-cart.js), asi que
// esta validacion final es indispensable tanto para el carrito como para el
// comparador. No duplica logica de resolucion: solo agrega el mismo chequeo de
// existencia que ya hace handleAgregarAlCarrito.
function resolveComparisonReference(input, offeredProducts) {
  const resolved = resolveReferencedProductId(input, offeredProducts);
  if (!resolved.ok) return resolved;
  const product = getProduct(resolved.productId);
  if (!product) return { ok: false, error: 'producto_no_encontrado' };
  return { ok: true, productId: resolved.productId };
}

// comparar_productos acepta dos formas de identificar los productos a
// comparar, nunca mezcladas dentro del mismo llamado:
// - "ids": IDs explicitos ya obtenidos de otra herramienta (comportamiento
//   original, sin cambios: un ID que no existe queda en noEncontrados, no
//   corta la comparacion completa).
// - "referencias": posicion o criterio sobre la ULTIMA lista de productos
//   ofrecidos ("la primera con la segunda", "esa con la segunda", "la mas
//   barata con la mas cara"), resueltas una por una con el mismo mecanismo
//   determinista del carrito (resolveComparisonReference). A diferencia de
//   "ids", aca cualquier referencia que no resuelva (ambigua, sin contexto,
//   posicion no disponible, producto inexistente) corta toda la comparacion
//   y devuelve ese motivo especifico: nunca se arma una comparacion parcial
//   ni se elige arbitrariamente entre varias coincidencias. Si dos
//   referencias distintas terminan resolviendo al mismo producto real, se
//   deduplican; si despues de deduplicar queda un solo producto, no hay
//   comparacion posible.
//
// Ademas de "productos" (texto/campos para que el modelo redacte su
// respuesta), cuando hay 2 o mas productos realmente encontrados el
// resultado incluye "comparison": la tarjeta visual estructurada que arma
// catalog.buildComparisonCard con los MISMOS productos ya validados (nunca
// se recalcula ni se re-busca nada). Si queda un solo producto encontrado
// (o ninguno), "comparison" es null: nunca se arma una tarjeta visual
// parcial. Esta tarjeta viaja hasta la respuesta del endpoint para el
// frontend (ver lib/padel-advisor.js#collectComparison), pero nunca se le
// envia al modelo (ver lib/padel-advisor.js#buildOutputForModel): el modelo
// ya tiene todo lo que necesita en "productos".campos.
function handleCompararProductos(input, offeredProducts) {
  if (Array.isArray(input.referencias)) {
    const referencias = input.referencias.slice(0, 3);
    if (referencias.length < 2) {
      return { ok: false, error: 'Se necesitan al menos 2 referencias validas para comparar.' };
    }
    const resolvedIds = [];
    for (let i = 0; i < referencias.length; i++) {
      const referencia = referencias[i];
      if (!referencia || typeof referencia !== 'object') {
        return { ok: false, error: 'referencia_invalida' };
      }
      const resolved = resolveComparisonReference(referencia, offeredProducts);
      if (!resolved.ok) return resolved;
      resolvedIds.push(resolved.productId);
    }
    const uniqueIds = Array.from(new Set(resolvedIds));
    if (uniqueIds.length < 2) {
      return { ok: false, error: 'ids_duplicados' };
    }
    const comparison = catalog.compareProducts(uniqueIds);
    return { ok: true, productos: comparison.productos, noEncontrados: comparison.noEncontrados, comparison: comparison.comparison };
  }

  if (Array.isArray(input.ids)) {
    const ids = input.ids.filter(isPlainString).map((id) => id.trim()).slice(0, 3);
    if (ids.length < 2) {
      return { ok: false, error: 'Se necesitan al menos 2 IDs validos para comparar.' };
    }
    const comparison = catalog.compareProducts(ids);
    return { ok: true, productos: comparison.productos, noEncontrados: comparison.noEncontrados, comparison: comparison.comparison };
  }

  return { ok: false, error: 'Se necesitan ids o referencias validas para comparar.' };
}

function handleVerCarrito(carritoActual) {
  const resumen = PadelCartCore.buildCartSummary(carritoActual, getProduct);
  return { ok: true, resumen: resumen };
}

// Encuentra, dentro del carrito REAL actual (carritoActual, enviado por el
// cliente y nunca por el modelo), la unica linea a la que se refiere el
// pedido de "quitar" o "modificar cantidad". Nunca elige arbitrariamente
// entre varias coincidencias: si hay mas de una, devuelve un error 'ambiguo'
// (o 'ambiguo_talle') con las opciones reales para que el asistente pregunte.
function findCartTarget(input, offeredProducts, carritoActual) {
  const resumen = PadelCartCore.buildCartSummary(carritoActual, getProduct);
  if (resumen.lineas.length === 0) return { ok: false, error: 'carrito_vacio' };

  const tieneReferenciaEstructurada = isPlainString(input.productId) || isPlainString(input.referenciaPosicion) || isPlainString(input.referenciaCriterio);
  if (tieneReferenciaEstructurada) {
    const resolved = resolveReferencedProductId(input, offeredProducts);
    if (!resolved.ok) return resolved;
    let candidatos = resumen.lineas.filter((l) => l.productId === resolved.productId);
    if (candidatos.length === 0) return { ok: false, error: 'no_encontrado_en_carrito' };
    if (candidatos.length > 1) {
      if (isPlainString(input.talle)) {
        const talle = input.talle.trim();
        candidatos = candidatos.filter((l) => l.talle === talle);
        if (candidatos.length === 0) return { ok: false, error: 'no_encontrado_en_carrito' };
      } else {
        return { ok: false, error: 'ambiguo_talle', opciones: candidatos.map((l) => ({ productId: l.productId, nombre: l.nombre, talle: l.talle })) };
      }
    }
    return { ok: true, linea: candidatos[0] };
  }

  if (isPlainString(input.descripcion)) {
    const matches = PadelCartCore.matchCartLinesByText(resumen.lineas, input.descripcion);
    if (matches.length === 0) return { ok: false, error: 'no_encontrado_en_carrito' };
    if (matches.length > 1) return { ok: false, error: 'ambiguo', opciones: matches.map((l) => ({ productId: l.productId, nombre: l.nombre, talle: l.talle })) };
    return { ok: true, linea: matches[0] };
  }

  return { ok: false, error: 'sin_referencia' };
}

function handleQuitarDelCarrito(input, offeredProducts, carritoActual) {
  const target = findCartTarget(input, offeredProducts, carritoActual);
  if (!target.ok) return target;
  const l = target.linea;
  return {
    ok: true,
    accion: { tipo: 'quitar_del_carrito', productId: l.productId, talle: l.talle },
    lineaAfectada: { nombre: l.nombre, marca: l.marca, talle: l.talle, cantidad: l.cantidad, precioFormateado: l.precioFormateado },
  };
}

function handleModificarCantidadCarrito(input, offeredProducts, carritoActual) {
  const target = findCartTarget(input, offeredProducts, carritoActual);
  if (!target.ok) return target;
  if (!isFiniteNumber(input.nuevaCantidad)) return { ok: false, error: 'cantidad_invalida' };
  const cantidadResult = PadelCartCore.validateQuantity(input.nuevaCantidad);
  if (!cantidadResult.ok) return cantidadResult;
  const l = target.linea;
  return {
    ok: true,
    accion: { tipo: 'modificar_cantidad_carrito', productId: l.productId, talle: l.talle, cantidad: cantidadResult.cantidad },
    lineaAfectada: {
      nombre: l.nombre,
      marca: l.marca,
      talle: l.talle,
      cantidadAnterior: l.cantidad,
      cantidadNueva: cantidadResult.cantidad,
      precioFormateado: l.precioFormateado,
    },
  };
}

// Aplica la actualizacion parcial que pidio el modelo sobre el perfil de
// compra ACTUAL de este turno (context.perfilCompra, ya saneado por
// lib/padel-advisor.js antes de empezar la ronda de herramientas). Siempre
// devuelve ok:true: un campo invalido o fuera de enum simplemente no se
// aplica (mismo criterio que ya usa filtrar_palas con "version" mas arriba
// en este archivo), nunca corta la conversacion ni corrompe el resto del
// perfil ya guardado. El perfil resultante viaja en la respuesta para que
// lib/padel-advisor.js lo adopte como el nuevo estado de este turno (ver
// updatePerfilCompra).
function handleActualizarPerfilCompra(input, perfilCompraActual) {
  const perfil = PadelProfile.applyPerfilUpdate(perfilCompraActual, input);
  return { ok: true, perfil: perfil };
}

// Ordena palas reales segun el perfil de compra ACTUAL de este turno
// (context.perfilCompra, ya saneado por lib/padel-advisor.js) combinado con
// cualquier campo nuevo que el modelo haya incluido en "input" para esta
// misma llamada (mismo saneamiento cerrado que ya usa
// actualizar_perfil_compra, via PadelProfile.applyPerfilUpdate: un campo
// invalido o fuera de enum simplemente no se aplica). Este merge es SOLO
// para calcular este ranking: nunca reemplaza ni persiste el perfil real de
// la conversacion, que solo cambia via actualizar_perfil_compra (ver
// lib/padel-advisor.js#updatePerfilCompra). El ranking en si (orden,
// motivos, advertencias) lo calcula siempre lib/padel-recommender.js, nunca
// el modelo.
function handleRecomendarProductos(input, perfilCompraActual) {
  const perfilEfectivo = PadelProfile.applyPerfilUpdate(perfilCompraActual, input);
  const limit = isFiniteNumber(input.limit) ? Math.max(1, Math.min(8, Math.floor(input.limit))) : undefined;
  const resultado = PadelRecommender.recommend(catalog.loadCatalog(), perfilEfectivo, limit ? { limit: limit } : undefined);
  return {
    ok: true,
    perfilUsado: resultado.perfilUsado,
    presupuestoDeclarado: resultado.presupuestoDeclarado,
    hayDentroDePresupuesto: resultado.hayDentroDePresupuesto,
    resultados: resultado.resultados,
    mejorCoincidencia: resultado.mejorCoincidencia,
    siguientesOpciones: resultado.siguientesOpciones,
    alternativaEconomica: resultado.alternativaEconomica,
  };
}

// Resuelve el conjunto de candidatos REALES (2 o 3 productos) sobre los que
// elegir_producto_para_usuario debe decidir, con la MISMA politica de
// resolucion que ya usa comparar_productos (nunca una nueva): "ids"
// explicitos (con los no encontrados aparte, sin cortar todo si igual quedan
// 2 o mas), "referencias" posicionales/criterio contra la ultima lista
// ofrecida (cualquier referencia que no resuelva corta toda la operacion,
// igual que en handleCompararProductos), o -si el modelo no mando ninguna de
// las dos- los productos actualmente ofrecidos en la conversacion (por
// ejemplo los que dejo la ultima comparacion o recomendacion), que es
// exactamente lo que pide el pedido original: "debe poder trabajar sobre los
// productos de una comparacion actual [o] los ultimos productos ofrecidos".
// Nunca inventa un ID: todo termina resuelto contra el catalogo real
// (getProduct) antes de devolverse.
function resolveCandidateProducts(input, offeredProducts) {
  if (Array.isArray(input.ids)) {
    const ids = input.ids.filter(isPlainString).map((id) => id.trim()).slice(0, 3);
    if (ids.length < 2) {
      return { ok: false, error: 'Se necesitan al menos 2 IDs validos para elegir.' };
    }
    const uniqueIds = Array.from(new Set(ids));
    const productos = [];
    const noEncontrados = [];
    uniqueIds.forEach((id) => {
      const p = getProduct(id);
      if (p) productos.push(p);
      else noEncontrados.push(id);
    });
    if (productos.length < 2) {
      return { ok: false, error: 'productos_insuficientes', noEncontrados: noEncontrados };
    }
    return { ok: true, productos: productos, noEncontrados: noEncontrados };
  }

  if (Array.isArray(input.referencias)) {
    const referencias = input.referencias.slice(0, 3);
    if (referencias.length < 2) {
      return { ok: false, error: 'Se necesitan al menos 2 referencias validas para elegir.' };
    }
    const resolvedIds = [];
    for (let i = 0; i < referencias.length; i++) {
      const referencia = referencias[i];
      if (!referencia || typeof referencia !== 'object') {
        return { ok: false, error: 'referencia_invalida' };
      }
      const resolved = resolveComparisonReference(referencia, offeredProducts);
      if (!resolved.ok) return resolved;
      resolvedIds.push(resolved.productId);
    }
    const uniqueIds = Array.from(new Set(resolvedIds));
    if (uniqueIds.length < 2) {
      return { ok: false, error: 'ids_duplicados' };
    }
    const productos = uniqueIds.map((id) => getProduct(id)).filter(Boolean);
    if (productos.length < 2) {
      return { ok: false, error: 'productos_insuficientes' };
    }
    return { ok: true, productos: productos, noEncontrados: [] };
  }

  const ofrecidosIds = Array.from(new Set((offeredProducts || []).map((o) => o && o.id).filter(isPlainString)));
  const productos = ofrecidosIds.map((id) => getProduct(id)).filter(Boolean).slice(0, 3);
  if (productos.length < 2) {
    return { ok: false, error: 'sin_candidatos' };
  }
  return { ok: true, productos: productos, noEncontrados: [] };
}

// Decide, de forma determinista, cual de los candidatos conviene mas para el
// perfil de compra de este turno (mezcla del perfil ya guardado con
// eventuales overrides puntuales del mismo mensaje, exactamente igual que
// handleRecomendarProductos: nunca persiste el perfil por si sola). Todo el
// calculo (ganador, empate, falta de informacion, pregunta sugerida,
// alternativa) lo hace lib/padel-chooser.js, que a su vez reutiliza
// lib/padel-recommender.js sin duplicar el algoritmo de scoring.
function handleElegirProductoParaUsuario(input, perfilCompraActual, offeredProducts) {
  const resolved = resolveCandidateProducts(input, offeredProducts);
  if (!resolved.ok) return resolved;
  const perfilEfectivo = PadelProfile.applyPerfilUpdate(perfilCompraActual, input);
  const decision = PadelChooser.choose(resolved.productos, perfilEfectivo);
  if (!decision.ok) return decision;
  decision.noEncontrados = resolved.noEncontrados;
  return decision;
}

function executeTool(name, rawInput, rawContext) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const context = rawContext && typeof rawContext === 'object' ? rawContext : {};
  const offeredProducts = Array.isArray(context.offeredProducts) ? context.offeredProducts : [];
  const carritoActual = Array.isArray(context.carritoActual) ? context.carritoActual : [];
  const perfilCompraActual = context.perfilCompra && typeof context.perfilCompra === 'object'
    ? context.perfilCompra
    : PadelProfile.emptyPerfilCompra();

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
    return handleCompararProductos(input, offeredProducts);
  }

  if (name === 'ver_producto') {
    if (!isPlainString(input.id)) {
      return { ok: false, error: 'id de producto invalido.' };
    }
    const card = catalog.verProducto(input.id.trim());
    if (!card) {
      return { ok: false, error: 'Producto no encontrado en el catalogo real.' };
    }
    return { ok: true, producto: card, productoParaModelo: buildProductoParaModelo(card) };
  }

  if (name === 'agregar_al_carrito') {
    return handleAgregarAlCarrito(input, offeredProducts);
  }

  if (name === 'ver_carrito') {
    return handleVerCarrito(carritoActual);
  }

  if (name === 'quitar_del_carrito') {
    return handleQuitarDelCarrito(input, offeredProducts, carritoActual);
  }

  if (name === 'modificar_cantidad_carrito') {
    return handleModificarCantidadCarrito(input, offeredProducts, carritoActual);
  }

  if (name === 'actualizar_perfil_compra') {
    return handleActualizarPerfilCompra(input, perfilCompraActual);
  }

  if (name === 'recomendar_productos') {
    return handleRecomendarProductos(input, perfilCompraActual);
  }

  if (name === 'elegir_producto_para_usuario') {
    return handleElegirProductoParaUsuario(input, perfilCompraActual, offeredProducts);
  }

  return { ok: false, error: 'Herramienta desconocida: ' + name };
}

module.exports = {
  TOOL_DEFINITIONS: TOOL_DEFINITIONS,
  executeTool: executeTool,
  buildProductoParaModelo: buildProductoParaModelo,
  getProduct: getProduct,
  resolveReferencedProductId: resolveReferencedProductId,
  resolveComparisonReference: resolveComparisonReference,
  handleCompararProductos: handleCompararProductos,
  handleActualizarPerfilCompra: handleActualizarPerfilCompra,
  handleRecomendarProductos: handleRecomendarProductos,
  resolveCandidateProducts: resolveCandidateProducts,
  handleElegirProductoParaUsuario: handleElegirProductoParaUsuario,
};
