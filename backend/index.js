const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const n8nRoutes = require('./routes/n8nRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const chatRoutes = require('./routes/chatRoutes');
const memoryRoutes = require('./routes/memoryRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());


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

// Servir icons
app.use('/icons', express.static(path.join(__dirname, 'icons')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', n8nUrl: process.env.N8N_BASE_URL });
});

app.listen(PORT, () => {
  console.log(`\n🤖 Asistente Virtual IA corriendo en http://localhost:${PORT}`);
  console.log(`   n8n: ${process.env.N8N_BASE_URL}`);
});
