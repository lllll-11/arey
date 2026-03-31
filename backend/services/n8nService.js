const axios = require('axios');

class N8nService {
  constructor() {
    this.baseURL = process.env.N8N_BASE_URL || 'http://localhost:5678';
    this.apiKey = process.env.N8N_API_KEY;

    this.client = axios.create({
      baseURL: `${this.baseURL}/api/v1`,
      headers: {
        'X-N8N-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  // ====== WORKFLOWS ======

  async getWorkflows() {
    const { data } = await this.client.get('/workflows');
    return data;
  }

  async getWorkflow(id) {
    const { data } = await this.client.get(`/workflows/${encodeURIComponent(id)}`);
    return data;
  }

  async createWorkflow(workflowData) {
    const { data } = await this.client.post('/workflows', workflowData);
    return data;
  }

  async updateWorkflow(id, workflowData) {
    const { data } = await this.client.put(`/workflows/${encodeURIComponent(id)}`, workflowData);
    return data;
  }

  async deleteWorkflow(id) {
    const { data } = await this.client.delete(`/workflows/${encodeURIComponent(id)}`);
    return data;
  }

  async activateWorkflow(id) {
    const { data } = await this.client.post(`/workflows/${encodeURIComponent(id)}/activate`);
    return data;
  }

  async deactivateWorkflow(id) {
    const { data } = await this.client.post(`/workflows/${encodeURIComponent(id)}/deactivate`);
    return data;
  }

  // ====== EXECUTIONS ======

  async getExecutions(workflowId) {
    const params = workflowId ? { workflowId } : {};
    const { data } = await this.client.get('/executions', { params });
    return data;
  }

  async getExecution(id) {
    const { data } = await this.client.get(`/executions/${encodeURIComponent(id)}`);
    return data;
  }

  // ====== WEBHOOKS ======

  async triggerWebhook(webhookPath, payload) {
    const { data } = await axios.post(
      `${this.baseURL}/webhook/${webhookPath}`,
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );
    return data;
  }

  async triggerTestWebhook(webhookPath, payload) {
    const { data } = await axios.post(
      `${this.baseURL}/webhook-test/${webhookPath}`,
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );
    return data;
  }
}

module.exports = new N8nService();
