const express = require('express');
const router = express.Router();
const googleCalendarService = require('../services/googleCalendarService');

router.get('/health', (req, res) => {
  const configured = googleCalendarService.isGoogleConfigured();

  res.json({
    configured,
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
  });
});

router.get('/events', async (req, res) => {
  try {
    const timeMin = req.query.timeMin;
    const timeMax = req.query.timeMax;
    const maxResults = Number(req.query.maxResults || 20);

    const events = await googleCalendarService.listEvents({
      timeMin,
      timeMax,
      maxResults,
    });

    res.json({ events });
  } catch (error) {
    res.status(500).json({
      error: 'No se pudo listar eventos',
      detail: error.message,
    });
  }
});

router.post('/events', async (req, res) => {
  try {
    const event = await googleCalendarService.createEvent(req.body);
    res.status(201).json({ event });
  } catch (error) {
    const statusCode = error.message.includes('requeridos') ? 400 : 500;
    res.status(statusCode).json({
      error: 'No se pudo crear la cita',
      detail: error.message,
    });
  }
});

router.delete('/events/:eventId', async (req, res) => {
  try {
    await googleCalendarService.deleteEvent(req.params.eventId);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      error: 'No se pudo eliminar la cita',
      detail: error.message,
    });
  }
});

module.exports = router;
