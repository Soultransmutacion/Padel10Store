'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./padel-advisor-system-prompt');
const { TOOL_DEFINITIONS, executeTool } = require('./padel-advisor-tools');

const MODEL = 'anthropic/claude-haiku-4.5';
const MAX_TOKENS = 500;
const MAX_TOOL_ROUNDS = 3;
const MAX_MESSAGE_LENGTH = 700;
const MAX_HISTORY_MESSAGES = 8;

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

  const reply = extractText(response.content) || 'Perdon, no pude generar una respuesta. Proba de nuevo o consultanos por WhatsApp.';
    return { reply: reply, cards: Array.from(cardsById.values()) };
}

module.exports = {
    runAdvisor: runAdvisor,
    sanitizeMessage: sanitizeMessage,
    sanitizeHistory: sanitizeHistory,
    classifyError: classifyError,
    MAX_MESSAGE_LENGTH: MAX_MESSAGE_LENGTH,
    MAX_HISTORY_MESSAGES: MAX_HISTORY_MESSAGES,
    MAX_TOOL_ROUNDS: MAX_TOOL_ROUNDS,
};
