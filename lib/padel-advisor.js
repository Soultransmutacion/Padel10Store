'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./padel-advisor-system-prompt');
const { TOOL_DEFINITIONS, executeTool } = require('./padel-advisor-tools');
const { normalizeText, verProducto, deterministicSearch } = require('./padel-catalog');
const PadelProfile = require('./padel-profile');

const MODEL = 'anthropic/claude-haiku-4.5';
const MAX_TOKENS = 500;
const MAX_TOOL_ROUNDS = 3;
// Maximo real de llamadas a AI Gateway por mensaje del usuario: 1 llamada inicial
// + hasta MAX_TOOL_ROUNDS llamadas de seguimiento (una por cada ronda de
// herramientas ejecutada). Nunca se hace una llamada adicional de "sintesis":
// si el modelo todavia pide una herramienta despues de agotar las rondas,
// se responde con un mensaje seguro ya preparado (ver buildExhaustionReply).
const MAX_GATEWAY_CALLS_PER_MESSAGE = MAX_TOOL_ROUNDS + 1;
const MAX_MESSAGE_LENGTH = 700;
const MAX_HISTORY_MESSAGES = 8;
const MAX_OFRECIDOS = 12;
const MAX_CARRITO_LINEAS = 30;

const FALLBACK_REPLY = 'Perdon, no pude generar una respuesta. Proba de nuevo o consultanos por WhatsApp.';
const EXHAUSTION_REPLY_WITH_CARDS = 'Encontre estas opciones con la informacion disponible hasta el momento.';
const EXHAUSTION_REPLY_NO_CARDS = 'No pude terminar de procesar tu consulta con la informacion disponible en este momento. Podes reformularla o escribirnos por WhatsApp y te ayudamos directamente.';

// Frase segura fija que reemplaza cualquier oracion donde se haya escapado una
// URL, un dominio de WhatsApp o el numero de telefono. El boton real de
// WhatsApp de la tarjeta nunca depende de este texto: se arma en el servidor
// a partir del producto completo (ver padel-catalog.buildWhatsappLink).
const WHATSAPP_SAFE_SENTENCE = 'Podés consultarnos desde el botón de WhatsApp de la tarjeta.';

// Patrones que detectan una URL, un dominio de WhatsApp, restos de
// codificacion de URL o el numero de telefono dentro del texto final. Se usan
// para enmascarar el token completo antes de decidir que oracion reemplazar,
// evitando que un punto dentro de una URL (por ejemplo ".com") rompa mal el
// corte de oraciones.
const LEAK_TOKEN_PATTERNS = [
  /https?:\/\/\S+/gi,
  /\bwa\.me\/\S*/gi,
  /\bapi\.whatsapp\.com\/\S*/gi,
  /%[0-9a-f]{2}/gi,
  /\?text=\S*/gi,
  /\+?54\s?9?[\s.-]?341[\s.-]?363[\s.-]?7355/gi,
];

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    const err = new Error('AI_GATEWAY_API_KEY no esta configurada.');
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  client = new Anthropic({ apiKey: apiKey, baseURL: 'https://ai-gateway.vercel.sh' });
  return client;
}

function sanitizeMessage(rawMessage) {
  if (typeof rawMessage !== 'string') return { ok: false, error: 'INVALID_MESSAGE' };
  const trimmed = rawMessage.trim();
  if (!trimmed) return { ok: false, error: 'EMPTY_MESSAGE' };
  if (trimmed.length > MAX_MESSAGE_LENGTH) return { ok: false, error: 'MESSAGE_TOO_LONG' };
  return { ok: true, value: trimmed };
}

function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  const cleaned = [];
  for (const entry of rawHistory) {
    if (!entry || typeof entry !== 'object') continue;
    const role = entry.role;
    const content = entry.content;
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string') continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    cleaned.push({ role: role, content: trimmed.slice(0, MAX_MESSAGE_LENGTH) });
  }

  const alternated = [];
  let last = null;
  for (const msg of cleaned) {
    if (last === null) {
      if (msg.role !== 'user') continue;
    } else if (msg.role === last) {
      continue;
    }
    alternated.push(msg);
    last = msg.role;
  }

  let result = alternated;
  if (result.length % 2 !== 0) {
    result = result.slice(0, -1);
  }
  if (result.length > MAX_HISTORY_MESSAGES) {
    result = result.slice(result.length - MAX_HISTORY_MESSAGES);
  }
  return result;
}

// Lista de IDs de producto "ofrecidos" (mostrados) en la conversacion, tal
// como la mantiene el cliente entre mensajes: nunca se confia en su
// contenido mas alla de quedarse con strings no vacios, hasta un limite. La
// validacion real (que cada ID exista de verdad en el catalogo) la hace
// PadelCartCore.resolveOfferedReference en el momento de usarla, nunca aqui.
function sanitizeOfrecidos(rawOfrecidos) {
  if (!Array.isArray(rawOfrecidos)) return [];
  const out = [];
  for (const item of rawOfrecidos) {
    if (typeof item === 'string' && item.trim() && out.length < MAX_OFRECIDOS) {
      out.push(item.trim().slice(0, 120));
    }
  }
  return out;
}

// Lineas crudas del carrito real del cliente (window.PadelCart.getRawLines()),
// tal como las envia el navegador en cada mensaje. Solo se aceptan la forma y
// el tipo minimos (productId string, talle string u null, cantidad lo que
// venga): el precio, el nombre y la validez del talle/producto se recalculan
// SIEMPRE contra el catalogo real dentro de PadelCartCore.buildCartSummary,
// nunca se toma nada de esto como un hecho ya confirmado.
function sanitizeCarritoActual(rawCarrito) {
  if (!Array.isArray(rawCarrito)) return [];
  const out = [];
  for (const item of rawCarrito) {
    if (out.length >= MAX_CARRITO_LINEAS) break;
    if (!item || typeof item !== 'object') continue;
    if (typeof item.productId !== 'string' || !item.productId.trim()) continue;
    out.push({
      productId: item.productId.trim().slice(0, 120),
      talle: typeof item.talle === 'string' && item.talle.trim() ? item.talle.trim().slice(0, 20) : null,
      cantidad: item.cantidad,
    });
  }
  return out;
}

// Perfil de compra TEMPORAL del cliente para esta conversacion (Fase 2 -
// Etapa 4): nivel, estilo, prioridad, presupuesto maximo y forma preferida,
// declarados unicamente por el cliente. Nunca es memoria permanente ni
// datos personales (ver lib/padel-profile.js). Igual que sanitizeOfrecidos
// y sanitizeCarritoActual, nunca se confia en el objeto que manda el
// cliente mas alla de lo que ya sanea PadelProfile.sanitizePerfilCompra
// (enums cerrados + numero de presupuesto en un rango razonable): un
// perfil manipulado a mano (por ejemplo con un enum inventado o un
// presupuesto no numerico) nunca se convierte en un perfil valido.
function sanitizePerfilCompra(rawPerfilCompra) {
  return PadelProfile.sanitizePerfilCompra(rawPerfilCompra);
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// Limpieza segura de Markdown simple (negrita, cursiva, encabezados, vinetas,
// codigo en linea, enlaces). Nunca se usa innerHTML con el resultado: el widget
// siempre lo inserta como texto plano (textContent). Se conservan los saltos
// de linea legibles.
function stripMarkdown(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = text;
  out = out.replace(/```[\s\S]*?```/g, function (block) {
    return block.replace(/```/g, '').trim();
  });
  out = out.replace(/`([^`]+)`/g, '$1');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/(^|\s)\*([^*\s][^*]*?)\*(?=$|\s|[.,;:!?])/g, '$1$2');
  out = out.replace(/(^|\s)_([^_\s][^_]*?)_(?=$|\s|[.,;:!?])/g, '$1$2');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s*[-*+]\s+/gm, '');
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return out.trim();
}

// Enmascara cualquier token de fuga (URL, dominio de WhatsApp, restos de
// codificacion o el numero de telefono) con un marcador unico, para poder
// luego reemplazar la oracion completa que lo contiene sin que un punto
// dentro de la URL corte mal la oracion.
function maskLeakTokens(text) {
  let masked = text;
  LEAK_TOKEN_PATTERNS.forEach(function (re) {
    masked = masked.replace(re, '@@LEAK@@');
  });
  return masked;
}

// Ultima capa de saneamiento determinista: si por cualquier motivo el modelo
// escribiera una URL, un dominio de WhatsApp o el numero de telefono en el
// texto de la respuesta, se reemplaza la oracion completa que lo contiene por
// una frase segura y fija. Si varias oraciones seguidas quedan contaminadas,
// la frase segura no se repite. El boton de WhatsApp de la tarjeta (armado en
// el servidor a partir de datos internos, nunca del texto del modelo) no se
// ve afectado por este saneamiento.
function sanitizeWhatsappLeak(text) {
  if (typeof text !== 'string' || !text) return text;
  const masked = maskLeakTokens(text);
  if (masked.indexOf('@@LEAK@@') === -1) return text;

  const parts = masked.split(/([.!?\n]+\s*)/);
  let out = '';
  let lastWasSafe = false;
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i] || '';
    const delimiter = parts[i + 1] || '';
    if (sentence.indexOf('@@LEAK@@') !== -1) {
      if (!lastWasSafe) {
        out += WHATSAPP_SAFE_SENTENCE + (delimiter || ' ');
        lastWasSafe = true;
      }
    } else {
      out += sentence + delimiter;
      if (sentence.trim()) lastWasSafe = false;
    }
  }
  return out.trim();
}

// Deja pasar solo las tarjetas cuyo nombre de producto aparece mencionado en el
// texto final de la respuesta (comparando de forma normalizada: sin tildes, sin
// apostrofes, sin mayusculas). Evita que se adjunte una tarjeta de un resultado
// descartado o de una busqueda anterior que el modelo ya no menciona.
function filterCardsByMention(cards, reply) {
  if (Array.isArray(cards) === false || cards.length === 0) return [];
  const replyNorm = normalizeText(reply);
  const replyTokens = new Set(replyNorm ? replyNorm.split(' ').filter(Boolean) : []);
  const seen = new Set();
  const candidates = [];
  cards.forEach((c) => {
    if (c == null || typeof c.id !== 'string' || seen.has(c.id)) return;
    seen.add(c.id);
    const nombreNorm = normalizeText(c.nombre);
    const nombreTokens = nombreNorm ? nombreNorm.split(' ').filter(Boolean) : [];
    if (nombreTokens.length === 0) return;
    const covered = nombreTokens.every((token) => replyTokens.has(token));
    if (covered) candidates.push({ card: c, tokens: nombreTokens });
  });
  // Si el nombre de un candidato esta totalmente cubierto por el de otro
  // candidato mas especifico que tambien matchea, se descarta el menos
  // especifico para evitar tarjetas ambiguas o duplicadas.
  const finalCandidates = candidates.filter((candidate, idx) => {
    const esSubconjunto = candidates.some((other, otherIdx) => {
      if (otherIdx === idx) return false;
      if (other.tokens.length <= candidate.tokens.length) return false;
      return candidate.tokens.every((token) => other.tokens.indexOf(token) !== -1);
    });
    return esSubconjunto === false;
  });
  return finalCandidates.map((entry) => entry.card);
}

function buildExhaustionReply(hasCards) {
  return hasCards ? EXHAUSTION_REPLY_WITH_CARDS : EXHAUSTION_REPLY_NO_CARDS;
}

// Construye la version del resultado de una herramienta que se le envia al
// modelo. Para ver_producto, reemplaza la tarjeta completa (que incluye el
// numero, el mensaje precargado y el link de WhatsApp) por la vista sin datos
// de contacto que ya arma padel-advisor-tools.js. Para comparar_productos,
// saca el campo "comparison" (la tarjeta visual estructurada para el
// frontend, ver collectComparison mas abajo): el modelo ya tiene toda la
// informacion que necesita para redactar su respuesta en "productos".campos,
// asi que enviarle ademas la tarjeta visual (que repite nombre/precio/imagen
// y los mismos atributos en otro formato) seria informacion innecesaria en
// cada llamada al modelo. Las demas herramientas no exponen datos de
// WhatsApp ni tarjetas visuales, asi que se devuelven sin cambios.
function buildOutputForModel(output) {
  if (output && output.ok && output.producto && output.productoParaModelo) {
    const clone = Object.assign({}, output);
    clone.producto = output.productoParaModelo;
    delete clone.productoParaModelo;
    return clone;
  }
  if (output && output.ok && output.comparison) {
    const clone = Object.assign({}, output);
    delete clone.comparison;
    return clone;
  }
  return output;
}

// Contexto compartido durante un mismo mensaje del usuario (una llamada a
// runAdvisor): registra los IDs que aparecieron como resultados de una
// busqueda estructurada (buscar_catalogo o filtrar_palas) en este turno.
// Sirve para validar, de forma deterministica, cualquier seleccion posterior
// por ver_producto contra ese conjunto de resultados permitidos. Se crea uno
// nuevo por cada mensaje del usuario; nunca se comparte entre mensajes.
function createCardContext() {
  return { searchResultIds: new Set() };
}

// Decide, de forma deterministica y basada unicamente en IDs validados contra
// el catalogo, que tarjetas se adjuntan a la respuesta. La redaccion final del
// modelo NUNCA decide esto (ver runAdvisor, que ya no filtra por texto):
// - ver_producto: la tarjeta se adjunta solo si el ID existe en el catalogo
//   (si no existe, output.ok es false y no hay nada que adjuntar) y, cuando
//   en este mismo turno hubo una busqueda estructurada con resultados
//   registrados en el contexto, el ID elegido pertenece a esos resultados
//   permitidos. Esta es la unica via para resolver una busqueda con varios
//   candidatos: una seleccion explicita y estructurada por ID.
// - buscar_catalogo / filtrar_palas: registra los IDs de todos los
//   resultados como "permitidos" para una eventual seleccion posterior por
//   ver_producto. Si el resultado es unico y exacto, se adjunta esa unica
//   tarjeta directamente, sin esperar una segunda llamada (evita perder la
//   tarjeta cuando el modelo responde directamente con el resumen). Si hay
//   varios candidatos, ninguno se adjunta todavia: no se decide por
//   coincidencia de palabras del texto final.
function collectCards(toolName, output, cardsById, context) {
  const ctx = context || createCardContext();
  if (output == null || output.ok !== true) return;

  if (toolName === 'ver_producto' && output.producto) {
    const id = output.producto.id;
    const huboBusquedaEnEsteTurno = ctx.searchResultIds.size > 0;
    const perteneceALosResultadosPermitidos = ctx.searchResultIds.has(id);
    if (huboBusquedaEnEsteTurno && perteneceALosResultadosPermitidos === false) return;
    cardsById.set(id, output.producto);
    return;
  }

  // agregar_al_carrito ya valido el producto real contra el catalogo dentro
  // de PadelCartCore antes de devolver ok:true (ver lib/padel-advisor-tools.js):
  // a diferencia de ver_producto, no hace falta restringirlo a los resultados
  // de una busqueda de este turno, porque el propio exito de la accion de
  // carrito ya es una validacion mas fuerte que "el modelo lo menciono".
  if (toolName === 'agregar_al_carrito' && output.producto) {
    cardsById.set(output.producto.id, output.producto);
    return;
  }

  const esBusquedaEstructurada = toolName === 'buscar_catalogo' || toolName === 'filtrar_palas';
  if (esBusquedaEstructurada && Array.isArray(output.resultados)) {
    output.resultados.forEach((resultado) => {
      if (resultado != null && typeof resultado.id === 'string') {
        ctx.searchResultIds.add(resultado.id);
      }
    });
    if (output.resultados.length === 1) {
      const unico = output.resultados[0];
      if (unico != null && typeof unico.id === 'string' && cardsById.has(unico.id) === false) {
        const card = verProducto(unico.id);
        if (card) cardsById.set(card.id, card);
      }
    }
  }
}

// Contexto separado (independiente de createCardContext/collectCards, que
// solo controla que tarjeta se muestra) para resolver referencias
// conversacionales como "la segunda" o "esa" contra una lista ORDENADA y
// real de productos "ofrecidos". Se inicializa con la lista que mando el
// cliente (lo que se le mostro en el mensaje anterior) y se REEMPLAZA por
// completo -nunca se acumula- cada vez que este turno produce una lista
// nueva mas relevante (una busqueda, una comparacion o un producto puntual
// visto): la referencia siempre apunta a lo ULTIMO mostrado, nunca a una
// mezcla de turnos distintos.
function createOfferedContext(rawOfrecidos) {
  return { ids: sanitizeOfrecidos(rawOfrecidos) };
}

function offeredProductsList(offeredContext) {
  return offeredContext.ids.map((id) => ({ id: id }));
}

function updateOfferedProducts(toolName, output, offeredContext) {
  if (output == null || output.ok !== true) return;

  const esBusquedaEstructurada = toolName === 'buscar_catalogo' || toolName === 'filtrar_palas';
  if (esBusquedaEstructurada && Array.isArray(output.resultados)) {
    const ids = output.resultados.map((r) => r && r.id).filter((id) => typeof id === 'string');
    if (ids.length > 0) offeredContext.ids = ids.slice(0, MAX_OFRECIDOS);
    return;
  }

  if (toolName === 'ver_producto' && output.producto && typeof output.producto.id === 'string') {
    offeredContext.ids = [output.producto.id];
    return;
  }

  if (toolName === 'comparar_productos' && Array.isArray(output.productos)) {
    const ids = output.productos.map((p) => p && p.id).filter((id) => typeof id === 'string');
    if (ids.length > 0) offeredContext.ids = ids;
  }
}

// Recolecta las acciones de carrito (agregar/quitar/modificar) que el
// servidor ya valido por completo en esta respuesta, para que el cliente las
// ejecute siempre contra window.PadelCart. El servidor nunca ejecuta la
// accion: solo la valida y la estructura (ver lib/padel-advisor-tools.js).
function collectActions(toolName, output, actions) {
  if (output == null || output.ok !== true || !output.accion) return;
  actions.push(output.accion);
}

// Devuelve la tarjeta visual de comparacion (Fase 2 - Etapa 2) de esta
// ejecucion de herramienta, o null si esta ejecucion no produjo una. A
// diferencia de collectCards (que acumula tarjetas de producto en un Map a
// lo largo de todo el turno), la comparacion NO se acumula: en runAdvisor,
// el resultado de esta funcion reemplaza por completo cualquier comparacion
// anterior del mismo turno, para que la respuesta siempre refleje la ULTIMA
// comparacion pedida (mismo criterio que ya usa updateOfferedProducts para
// la lista de ofrecidos). handleCompararProductos (padel-advisor-tools.js)
// ya deja "comparison" en null cuando queda un solo producto encontrado (o
// ninguno): esta funcion no repite esa logica, solo la propaga.
function collectComparison(toolName, output) {
  if (output == null || output.ok !== true) return null;
  if (toolName === 'comparar_productos' && output.comparison) return output.comparison;
  return null;
}

// Adopta, como nuevo estado del perfil de compra de este turno, el perfil
// ya actualizado y saneado que devolvio actualizar_perfil_compra (ver
// lib/padel-advisor-tools.js#handleActualizarPerfilCompra). A diferencia de
// updateOfferedProducts (que REEMPLAZA la lista de ofrecidos ante distintas
// herramientas), aca solo una herramienta puede tocar el perfil: cualquier
// otra herramienta (buscar_catalogo, comparar_productos, agregar_al_carrito,
// etc.) deja el perfil actual sin cambios, que es exactamente lo que
// garantiza el requisito de que comparar/buscar/agregar al carrito nunca
// borren el perfil ya guardado.
function updatePerfilCompra(toolName, output, currentPerfilCompra) {
  if (toolName === 'actualizar_perfil_compra' && output && output.ok === true && output.perfil) {
    return output.perfil;
  }
  return currentPerfilCompra;
}

function classifyError(error) {
  if (error && error.code === 'EMPTY_MESSAGE') return { status: 400, code: 'INVALID_MESSAGE' };
  if (error && error.code === 'INVALID_MESSAGE') return { status: 400, code: 'INVALID_MESSAGE' };
  if (error && error.code === 'MESSAGE_TOO_LONG') return { status: 400, code: 'MESSAGE_TOO_LONG' };
  if (error && error.code === 'CONFIG_MISSING') return { status: 503, code: 'CONFIG_MISSING' };
  const status = error && (error.status || (error.response && error.response.status));
  if (status === 429) return { status: 429, code: 'RATE_LIMITED' };
  if (status === 402 || status === 403) return { status: 402, code: 'PROVIDER_LIMIT' };
  if (typeof status === 'number' && status >= 500) return { status: 502, code: 'PROVIDER_DOWN' };
  return { status: 500, code: 'UNKNOWN' };
}

async function runAdvisor(params, injectedClient) {
  const message = params && params.message;
  const history = params && params.history;

  const sanitizedMessage = sanitizeMessage(message);
  if (!sanitizedMessage.ok) {
    const err = new Error(sanitizedMessage.error);
    err.code = sanitizedMessage.error;
    throw err;
  }
  const cleanHistory = sanitizeHistory(history);

  const anthropic = injectedClient || getClient();

  const messages = cleanHistory.map((m) => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: sanitizedMessage.value });

  const cardsById = new Map();

  const cardContext = createCardContext();

  // Contexto de carrito para este mensaje: la lista de productos "ofrecidos"
  // (para resolver "la segunda"/"esa"/etc.) se inicializa con lo que mando el
  // cliente del turno anterior, y el carrito real (para quitar/modificar) se
  // sanea pero nunca se valida aqui -eso lo hace siempre PadelCartCore contra
  // el catalogo real dentro de cada herramienta de carrito-.
  const offeredContext = createOfferedContext(params && params.ofrecidos);
  const carritoActual = sanitizeCarritoActual(params && params.carritoActual);
  // Perfil de compra temporal de esta conversacion (Fase 2 - Etapa 4): se
  // inicializa saneando lo que mando el cliente del turno anterior (el
  // mismo patron conceptual que ya usa "ofrecidos") y solo puede cambiar
  // dentro de este turno via actualizar_perfil_compra (ver updatePerfilCompra
  // mas abajo). El servidor nunca guarda este perfil en ningun lado: vive
  // unicamente en memoria durante esta llamada y viaja de ida y vuelta con
  // el cliente en cada mensaje.
  let perfilCompra = sanitizePerfilCompra(params && params.perfilCompra);
  const acciones = [];
  // Tarjeta visual de comparacion (Fase 2 - Etapa 2) de este turno: null
  // hasta que comparar_productos resuelva 2 o mas productos reales. No se
  // acumula entre llamadas a herramientas: la ULTIMA comparacion exitosa del
  // turno es la que viaja en la respuesta (ver collectComparison).
  let comparison = null;

  // Busqueda determinista de catalogo ejecutada siempre por el servidor para
  // el mensaje mas reciente del usuario, sin depender de que el modelo
  // decida invocar buscar_catalogo. Si esa busqueda resuelve un unico
  // producto exacto, su ID pasa a formar parte de los resultados permitidos
  // del turno y su tarjeta completa se adjunta directamente. Si devuelve
  // varios candidatos, ninguno se adjunta todavia pero todos quedan
  // registrados como resultados permitidos para una eventual seleccion
  // explicita por ID (por ejemplo, via ver_producto). Si no devuelve nada
  // (consulta generica o saludo), no se registra ni se adjunta nada. La
  // misma lista tambien pasa a ser la lista "ofrecida" para referencias
  // conversacionales de este turno (ver actualizacion de offeredContext).
  const preSearchResults = deterministicSearch(sanitizedMessage.value);
  if (preSearchResults.length > 0) {
    preSearchResults.forEach((r) => cardContext.searchResultIds.add(r.id));
    offeredContext.ids = preSearchResults.map((r) => r.id).slice(0, MAX_OFRECIDOS);
    if (preSearchResults.length === 1) {
      const preSearchCard = verProducto(preSearchResults[0].id);
      if (preSearchCard) cardsById.set(preSearchCard.id, preSearchCard);
    }
  }

  let rounds = 0;
  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS,
    messages: messages,
  });

  while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;
    const toolUses = response.content.filter((block) => block.type === 'tool_use');
    const toolResults = [];
    for (const toolUse of toolUses) {
      let output;
      try {
        output = executeTool(toolUse.name, toolUse.input, {
          offeredProducts: offeredProductsList(offeredContext),
          carritoActual: carritoActual,
          perfilCompra: perfilCompra,
        });
      } catch (e) {
        output = { ok: false, error: 'Error interno al ejecutar la herramienta.' };
      }
      collectCards(toolUse.name, output, cardsById, cardContext);
      updateOfferedProducts(toolUse.name, output, offeredContext);
      collectActions(toolUse.name, output, acciones);
      const maybeComparison = collectComparison(toolUse.name, output);
      if (maybeComparison) comparison = maybeComparison;
      perfilCompra = updatePerfilCompra(toolUse.name, output, perfilCompra);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(buildOutputForModel(output)),
      });
    }
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages: messages,
    });
  }

  const allCards = Array.from(cardsById.values());
  let reply;
  let cards;

  if (response.stop_reason === 'tool_use') {
    // Se agotaron las rondas permitidas y el modelo todavia pedia otra
    // herramienta: no se hace una llamada adicional (se mantiene el maximo
    // fijo de MAX_GATEWAY_CALLS_PER_MESSAGE). Se responde con un mensaje
    // seguro y completo, y se conservan todas las tarjetas y acciones de
    // carrito ya confirmadas por herramientas para no perder informacion
    // (ni acciones) util ya validada.
    reply = buildExhaustionReply(allCards.length > 0);
    cards = allCards;
  } else {
    reply = stripMarkdown(extractText(response.content)) || FALLBACK_REPLY;
    reply = sanitizeWhatsappLeak(reply) || FALLBACK_REPLY;
    // La identidad de las tarjetas ya quedo decidida de forma deterministica
    // y basada en IDs en collectCards (ver arriba): la redaccion final del
    // modelo no vuelve a filtrar ni a decidir que tarjeta se muestra.
    cards = allCards;
  }

  return { reply: reply, cards: cards, ofrecidos: offeredContext.ids, acciones: acciones, comparison: comparison, perfilCompra: perfilCompra };
}

module.exports = {
  runAdvisor: runAdvisor,
  collectCards: collectCards,
  createCardContext: createCardContext,
  createOfferedContext: createOfferedContext,
  offeredProductsList: offeredProductsList,
  updateOfferedProducts: updateOfferedProducts,
  collectActions: collectActions,
  collectComparison: collectComparison,
  updatePerfilCompra: updatePerfilCompra,
  sanitizeMessage: sanitizeMessage,
  sanitizeHistory: sanitizeHistory,
  sanitizeOfrecidos: sanitizeOfrecidos,
  sanitizeCarritoActual: sanitizeCarritoActual,
  sanitizePerfilCompra: sanitizePerfilCompra,
  classifyError: classifyError,
  stripMarkdown: stripMarkdown,
  filterCardsByMention: filterCardsByMention,
  buildExhaustionReply: buildExhaustionReply,
  sanitizeWhatsappLeak: sanitizeWhatsappLeak,
  buildOutputForModel: buildOutputForModel,
  MAX_MESSAGE_LENGTH: MAX_MESSAGE_LENGTH,
  MAX_HISTORY_MESSAGES: MAX_HISTORY_MESSAGES,
  MAX_OFRECIDOS: MAX_OFRECIDOS,
  MAX_CARRITO_LINEAS: MAX_CARRITO_LINEAS,
  MAX_TOOL_ROUNDS: MAX_TOOL_ROUNDS,
  MAX_GATEWAY_CALLS_PER_MESSAGE: MAX_GATEWAY_CALLS_PER_MESSAGE,
};
