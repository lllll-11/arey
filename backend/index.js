const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const n8nRoutes = require('./routes/n8nRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const chatRoutes = require('./routes/chatRoutes');
const memoryRoutes = require('./routes/memoryRoutes');
const calendarRoutes = require('./routes/calendarRoutes');
const integrationRoutes = require('./routes/integrationRoutes');
const discordService = require('./services/discordService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));


// Servir manifest.json y sw.js en la raíz
app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'manifest.json'));
});
app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'sw.js'));
});

// Servir frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Rutas API
app.use('/api/n8n', n8nRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/integrations', integrationRoutes);

// Servir icons
app.use('/icons', express.static(path.join(__dirname, 'icons')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', n8nUrl: process.env.N8N_BASE_URL });
});

app.listen(PORT, () => {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const baseUrl = renderUrl
    ? renderUrl
    : railwayDomain
      ? `https://${railwayDomain}`
      : `http://localhost:${PORT}`;
  console.log(`\n🤖 Asistente Virtual IA corriendo en ${baseUrl}`);
  console.log(`   n8n: ${process.env.N8N_BASE_URL}`);
  discordService.initDiscord(baseUrl);

  // ── Keep-alive: auto-ping cada 13 min para que Render no apague el servidor ──
  if (renderUrl || railwayDomain) {
    const pingUrl = `${baseUrl}/health`;
    const INTERVAL = 13 * 60 * 1000; // 13 minutos
    setInterval(() => {
      require('https').get(pingUrl, (res) => {
        console.log(`[keep-alive] ping ${res.statusCode}`);
      }).on('error', (err) => {
        console.log(`[keep-alive] error: ${err.message}`);
      });
    }, INTERVAL);
    console.log(`   keep-alive: ping cada 13 min a ${pingUrl}`);
  }
});
