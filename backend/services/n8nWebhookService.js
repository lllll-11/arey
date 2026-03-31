const axios = require('axios');

class N8nWebhookService {
  constructor() {
    this.baseURL = process.env.N8N_BASE_URL || 'http://localhost:5678';
  }

  /**
   * Dispara un webhook de n8n en modo producción
   * @param {string} webhookPath - Path del webhook (ej: "mi-webhook")
   * @param {object} payload - Datos a enviar
   * @param {string} method - Método HTTP (default: POST)
   */
  async triggerWebhook(webhookPath, payload = {}, method = 'POST') {
    const url = `${this.baseURL}/webhook/${webhookPath}`;
    const config = { headers: { 'Content-Type': 'application/json' } };

    if (method === 'GET') {
      const { data } = await axios.get(url, { params: payload, ...config });
      return data;
    }

    const { data } = await axios.post(url, payload, config);
    return data;
  }

  /**
   * Dispara un webhook de n8n en modo test (para desarrollo)
   * @param {string} webhookPath - Path del webhook
   * @param {object} payload - Datos a enviar
   */
  async triggerTestWebhook(webhookPath, payload = {}) {
    const url = `${this.baseURL}/webhook-test/${webhookPath}`;
    const { data } = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
    });
    return data;
  }
}

module.exports = new N8nWebhookService();
