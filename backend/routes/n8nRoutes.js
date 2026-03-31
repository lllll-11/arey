const express = require('express');
const router = express.Router();
const n8nService = require('../services/n8nService');

// GET /api/n8n/workflows - Listar todos los workflows
router.get('/workflows', async (req, res) => {
  try {
    const workflows = await n8nService.getWorkflows();
    res.json(workflows);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al obtener workflows',
      details: error.message,
    });
  }
});

// GET /api/n8n/workflows/:id - Obtener un workflow
router.get('/workflows/:id', async (req, res) => {
  try {
    const workflow = await n8nService.getWorkflow(req.params.id);
    res.json(workflow);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al obtener workflow',
      details: error.message,
    });
  }
});

// POST /api/n8n/workflows - Crear un workflow
router.post('/workflows', async (req, res) => {
  try {
    const workflow = await n8nService.createWorkflow(req.body);
    res.status(201).json(workflow);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al crear workflow',
      details: error.message,
    });
  }
});

// PUT /api/n8n/workflows/:id - Actualizar un workflow
router.put('/workflows/:id', async (req, res) => {
  try {
    const workflow = await n8nService.updateWorkflow(req.params.id, req.body);
    res.json(workflow);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al actualizar workflow',
      details: error.message,
    });
  }
});

// DELETE /api/n8n/workflows/:id - Eliminar un workflow
router.delete('/workflows/:id', async (req, res) => {
  try {
    await n8nService.deleteWorkflow(req.params.id);
    res.json({ message: 'Workflow eliminado' });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al eliminar workflow',
      details: error.message,
    });
  }
});

// POST /api/n8n/workflows/:id/activate - Activar un workflow
router.post('/workflows/:id/activate', async (req, res) => {
  try {
    const workflow = await n8nService.activateWorkflow(req.params.id);
    res.json(workflow);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al activar workflow',
      details: error.message,
    });
  }
});

// POST /api/n8n/workflows/:id/deactivate - Desactivar un workflow
router.post('/workflows/:id/deactivate', async (req, res) => {
  try {
    const workflow = await n8nService.deactivateWorkflow(req.params.id);
    res.json(workflow);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al desactivar workflow',
      details: error.message,
    });
  }
});

// GET /api/n8n/executions - Listar ejecuciones
router.get('/executions', async (req, res) => {
  try {
    const executions = await n8nService.getExecutions(req.query.workflowId);
    res.json(executions);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al obtener ejecuciones',
      details: error.message,
    });
  }
});

// GET /api/n8n/executions/:id - Obtener una ejecución
router.get('/executions/:id', async (req, res) => {
  try {
    const execution = await n8nService.getExecution(req.params.id);
    res.json(execution);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al obtener ejecución',
      details: error.message,
    });
  }
});

// POST /api/n8n/webhook/:path - Disparar un webhook de n8n
router.post('/webhook/:path', async (req, res) => {
  try {
    const result = await n8nService.triggerWebhook(req.params.path, req.body);
    res.json(result);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Error al disparar webhook',
      details: error.message,
    });
  }
});

module.exports = router;
