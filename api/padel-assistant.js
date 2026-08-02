'use strict';

const { runAdvisor, classifyError } = require('../lib/padel-advisor');

const MAX_BODY_CHARS = 6000;
const REQUEST_TIMEOUT_MS = 20000;

const ERROR_MESSAGES = {
    INVALID_MESSAGE: 'Escribinos una consulta valida para poder ayudarte.',
    MESSAGE_TOO_LONG: 'Tu mensaje es muy largo. Proba resumirlo en menos de 700 caracteres.',
    RATE_LIMITED: 'Estamos recibiendo muchas consultas en este momento. Espera unos segundos y volve a intentar.',
    CONFIG_MISSING: 'El asesor no esta disponible en este momento. Escribinos por WhatsApp mientras lo solucionamos.',
    PROVIDER_LIMIT: 'El asesor alcanzo su limite de uso por ahora. Escribinos por WhatsApp y te ayudamos directamente.',
    PROVIDER_DOWN: 'El asesor no esta disponible en este momento. Proba de nuevo en un rato o escribinos por WhatsApp.',
    TIMEOUT: 'La consulta tardo demasiado. Proba de nuevo o escribinos por WhatsApp.',
    UNKNOWN: 'Ocurrio un error inesperado. Proba de nuevo o escribinos por WhatsApp.',
};

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
                  const err = new Error('TIMEOUT');
                  err.code = 'TIMEOUT';
                  reject(err);
          }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
          res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'Solo se acepta POST.' });
          return;
    }

    const contentType = req.headers['content-type'] || '';
    if (contentType.indexOf('application/json') === -1) {
          res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: 'El contenido debe ser application/json.' });
          return;
    }

    let body = req.body;
    if (typeof body === 'string') {
          try {
                  body = JSON.parse(body);
          } catch (e) {
                  res.status(400).json({ error: 'INVALID_JSON', message: 'El cuerpo de la solicitud no es JSON valido.' });
                  return;
          }
    }

    if (!body || typeof body !== 'object') {
          res.status(400).json({ error: 'INVALID_BODY', message: 'Solicitud invalida.' });
          return;
    }

    let approxSize = 0;
    try {
          approxSize = JSON.stringify(body).length;
    } catch (e) {
          res.status(400).json({ error: 'INVALID_BODY', message: 'Solicitud invalida.' });
          return;
    }
    if (approxSize > MAX_BODY_CHARS) {
          res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'La solicitud es demasiado grande.' });
          return;
    }

    try {
          const result = await withTimeout(
                  runAdvisor({ message: body.message, history: body.history }),
                  REQUEST_TIMEOUT_MS
                );
          res.status(200).json({ reply: result.reply, cards: result.cards });
    } catch (error) {
          const classified = classifyError(error);
          const message = ERROR_MESSAGES[classified.code] || ERROR_MESSAGES.UNKNOWN;
          res.status(classified.status).json({ error: classified.code, message: message });
    }
};
