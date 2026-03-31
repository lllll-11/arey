const express = require('express');
const router = express.Router();
const n8nWebhookService = require('../services/n8nWebhookService');

// POST /api/webhook/:path - Disparar un webhook de n8n (producción)
router.post('/:path', async (req, res) => {
  try {
    const result = await n8nWebhookService.triggerWebhook(req.params.path, req.body);
    res.json(result);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al disparar webhook',
      details: error.message,
    });
  }
});

// GET /api/webhook/:path - Disparar webhook con GET
router.get('/:path', async (req, res) => {
  try {
    const result = await n8nWebhookService.triggerWebhook(req.params.path, req.query, 'GET');
    res.json(result);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al disparar webhook',
      details: error.message,
    });
  }
});

// POST /api/webhook/test/:path - Disparar webhook en modo test
router.post('/test/:path', async (req, res) => {
  try {
    const result = await n8nWebhookService.triggerTestWebhook(req.params.path, req.body);
    res.json(result);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al disparar webhook de test',
      details: error.message,
    });
  }
});

module.exports = router;
