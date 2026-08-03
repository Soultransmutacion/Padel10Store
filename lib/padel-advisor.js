'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./padel-advisor-system-prompt');
const { TOOL_DEFINITIONS, executeTool } = require('./padel-advisor-tools');
const { normalizeText } = require('./padel-catalog');

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

const FALLBACK_REPLY = 'Perdon, no pude generar una respuesta. Proba de nuevo o consultanos por WhatsApp.';
const EXHAUSTION_REPLY_WITH_CARDS = 'Encontre estas opciones con la informacion disponible hasta el momento.';
const EXHAUSTION_REPLY_NO_CARDS = 'No pude terminar de procesar tu consulta con la informacion disponible en este momento. Podes reformularla o escribirnos por WhatsApp y te ayudamos directamente.';

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

// Deja pasar solo las tarjetas cuyo nombre de producto aparece mencionado en el
// texto final de la respuesta (comparando de forma normalizada: sin tildes, sin
// apostrofes, sin mayusculas). Evita que se adjunte una tarjeta de un resultado
// descartado o de una busqueda anterior que el modelo ya no menciona.
function filterCardsByMention(cards, reply) {
  if (!Array.isArray(cards) || cards.length === 0) return [];
  const replyNorm = normalizeText(reply);
  const mentioned = cards.filter((c) => {
    const nombreNorm = normalizeText(c.nombre);
    return !!nombreNorm && replyNorm.indexOf(nombreNorm) !== -1;
  });
  return mentioned;
}

function buildExhaustionReply(hasCards) {
  return hasCards ? EXHAUSTION_REPLY_WITH_CARDS : EXHAUSTION_REPLY_NO_CARDS;
}

function collectCards(toolName, output, cardsById) {
  if (!output || output.ok !== true) return;
  if (toolName === 'ver_producto' && output.producto) {
    cardsById.set(output.producto.id, output.producto);
  }
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

async function runAdvisor(params) {
  const message = params && params.message;
  const history = params && params.history;

  const sanitizedMessage = sanitizeMessage(message);
  if (!sanitizedMessage.ok) {
    const err = new Error(sanitizedMessage.error);
    err.code = sanitizedMessage.error;
    throw err;
  }
  const cleanHistory = sanitizeHistory(history);

  const anthropic = getClient();

  const messages = cleanHistory.map((m) => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: sanitizedMessage.value });

  const cardsById = new Map();
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
        output = executeTool(toolUse.name, toolUse.input);
      } catch (e) {
        output = { ok: false, error: 'Error interno al ejecutar la herramienta.' };
      }
      collectCards(toolUse.name, output, cardsById);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(output),
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
    // seguro y completo, y se conservan todas las tarjetas ya confirmadas por
    // herramientas para no perder informacion util ya obtenida.
    reply = buildExhaustionReply(allCards.length > 0);
    cards = allCards;
  } else {
    reply = stripMarkdown(extractText(response.content)) || FALLBACK_REPLY;
    cards = filterCardsByMention(allCards, reply);
  }

  return { reply: reply, cards: cards };
}

module.exports = {
  runAdvisor: runAdvisor,
  sanitizeMessage: sanitizeMessage,
  sanitizeHistory: sanitizeHistory,
  classifyError: classifyError,
  stripMarkdown: stripMarkdown,
  filterCardsByMention: filterCardsByMention,
  buildExhaustionReply: buildExhaustionReply,
  MAX_MESSAGE_LENGTH: MAX_MESSAGE_LENGTH,
  MAX_HISTORY_MESSAGES: MAX_HISTORY_MESSAGES,
  MAX_TOOL_ROUNDS: MAX_TOOL_ROUNDS,
  MAX_GATEWAY_CALLS_PER_MESSAGE: MAX_GATEWAY_CALLS_PER_MESSAGE,
};
