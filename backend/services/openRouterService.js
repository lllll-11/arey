const https = require('https');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Envía un mensaje a OpenRouter y devuelve la respuesta del modelo.
 * @param {string} systemPrompt - Instrucciones del sistema (personalidad + memorias)
 * @param {string} userMessage  - Mensaje del usuario
 * @param {{model?: string, maxTokens?: number, temperature?: number, imageUrl?: string}} [options] - Opciones opcionales
 * @returns {Promise<string>}
 */
async function chat(systemPrompt, userMessage, options = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY no configurada en .env');

  const model = options.model || process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
  const userContent = options.imageUrl
    ? [
      { type: 'text', text: userMessage },
      { type: 'image_url', image_url: { url: options.imageUrl } },
    ]
    : userMessage;

  const body = JSON.stringify({
    model,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  return new Promise((resolve, reject) => {
    const url = new URL(OPENROUTER_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://arey.onrender.com',
        'X-Title': 'Arey IA',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('OpenRouter error detalle:', JSON.stringify(parsed.error));
            const code = parsed.error?.code != null ? `code=${parsed.error.code}` : '';
            const raw = parsed.error?.metadata?.raw ? ` raw=${parsed.error.metadata.raw}` : '';
            const provider = parsed.error?.metadata?.provider_name ? ` provider=${parsed.error.metadata.provider_name}` : '';
            const baseMessage = parsed.error.message || JSON.stringify(parsed.error);
            return reject(new Error([baseMessage, code, provider, raw].filter(Boolean).join(' | ')));
          }
          const rawReply = parsed.choices?.[0]?.message?.content;
          if (!rawReply) return reject(new Error('Respuesta vacía de OpenRouter'));

          const reply = Array.isArray(rawReply)
            ? rawReply
              .filter((part) => part?.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .join('\n')
            : String(rawReply);

          resolve(reply.trim());
        } catch (e) {
          reject(new Error('Error al parsear respuesta de OpenRouter: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('Timeout al contactar OpenRouter (120s)'));
    });
    req.write(body);
    req.end();
  });
}

module.exports = { chat, chatStream };

function chatStream(systemPrompt, userMessage, options = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY no configurada en .env');

  const model = options.model || process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
  const userContent = options.imageUrl
    ? [
      { type: 'text', text: userMessage },
      { type: 'image_url', image_url: { url: options.imageUrl } },
    ]
    : userMessage;

  const body = JSON.stringify({
    model,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  const url = new URL(OPENROUTER_API_URL);
  const reqOptions = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://arey.onrender.com',
      'X-Title': 'Arey IA',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return { body, reqOptions };
}
