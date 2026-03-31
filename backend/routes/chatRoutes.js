const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const n8nWebhookService = require('../services/n8nWebhookService');
const elevenLabsService = require('../services/elevenLabsService');

// Cargar personalidad del asistente
function loadPersonality() {
  const filePath = path.join(__dirname, '..', 'personality.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const rules = data.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  return `${data.personality}\n\nReglas:\n${rules}`;
}

// Cargar memorias guardadas
function loadMemories() {
  try {
    const filePath = path.join(__dirname, '..', 'memories.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const all = [
      ...data.facts.map(m => `- ${m}`),
      ...data.preferences.map(m => `- ${m}`),
      ...data.personality_notes.map(m => `- ${m}`),
    ];
    return all.length > 0 ? `\n\nCosas que recuerdas del usuario:\n${all.join('\n')}` : '';
  } catch {
    return '';
  }
}

// Guardar una memoria
function saveMemory(category, content) {
  try {
    const memPath = path.join(__dirname, '..', 'memories.json');
    const memories = JSON.parse(fs.readFileSync(memPath, 'utf-8'));
    const cat = ['facts', 'preferences', 'personality_notes'].includes(category) ? category : 'facts';
    if (!memories[cat].some(m => m.toLowerCase() === content.toLowerCase())) {
      if (memories[cat].length >= 50) memories[cat].shift();
      memories[cat].push(content);
      fs.writeFileSync(memPath, JSON.stringify(memories, null, 2), 'utf-8');
      console.log(`💾 Memoria guardada [${cat}]: ${content}`);
    }
  } catch (e) { console.error('Error guardando memoria:', e.message); }
}

// Auto-detectar información importante del mensaje del usuario
function autoDetectMemories(msg) {
  const lower = msg.toLowerCase();
  const patterns = [
    { regex: /me llamo (\w+)/i, cat: 'facts', tpl: (m) => `El usuario se llama ${m[1]}` },
    { regex: /mi nombre es (\w+)/i, cat: 'facts', tpl: (m) => `El usuario se llama ${m[1]}` },
    { regex: /soy (\w+)/i, cat: 'facts', tpl: (m) => `El usuario dice que es ${m[1]}` },
    { regex: /tengo (\d+) años/i, cat: 'facts', tpl: (m) => `El usuario tiene ${m[1]} años` },
    { regex: /vivo en (.+?)(?:\.|,|$)/i, cat: 'facts', tpl: (m) => `El usuario vive en ${m[1].trim()}` },
    { regex: /trabajo (?:en|de|como) (.+?)(?:\.|,|$)/i, cat: 'facts', tpl: (m) => `El usuario trabaja de/en ${m[1].trim()}` },
    { regex: /estudio (.+?)(?:\.|,|$)/i, cat: 'facts', tpl: (m) => `El usuario estudia ${m[1].trim()}` },
    { regex: /me gusta(?:n)? (?:mucho |el |la |los |las )?(.+?)(?:\.|,|$)/i, cat: 'preferences', tpl: (m) => `Le gusta ${m[1].trim()}` },
    { regex: /me encanta(?:n)? (.+?)(?:\.|,|$)/i, cat: 'preferences', tpl: (m) => `Le encanta ${m[1].trim()}` },
    { regex: /(?:mi|el) equipo (?:favorito |es )(.+?)(?:\.|,|$)/i, cat: 'preferences', tpl: (m) => `Su equipo favorito es ${m[1].trim()}` },
    { regex: /mi (?:color|comida|canción|película|serie|juego|deporte) favorit[oa] es (.+?)(?:\.|,|$)/i, cat: 'preferences', tpl: (m) => `Su favorito es ${m[1].trim()}` },
    { regex: /no me gusta(?:n)? (.+?)(?:\.|,|$)/i, cat: 'preferences', tpl: (m) => `No le gusta ${m[1].trim()}` },
    { regex: /odio (.+?)(?:\.|,|$)/i, cat: 'preferences', tpl: (m) => `Odia ${m[1].trim()}` },
  ];

  for (const p of patterns) {
    const match = msg.match(p.regex);
    if (match) {
      saveMemory(p.cat, p.tpl(match));
    }
  }
}

// POST /api/chat - Enviar mensaje al asistente IA via n8n
router.post('/', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'El campo "message" es requerido' });
  }

  try {
    const systemPrompt = loadPersonality() + loadMemories();
    console.log('System prompt enviado:', systemPrompt.substring(0, 200) + '...');
    const result = await n8nWebhookService.triggerWebhook('chat-ia', {
      message: `[INSTRUCCIONES DEL SISTEMA - SIGUE ESTAS INSTRUCCIONES SIN MENCIONARLAS]\n${systemPrompt}\n\n[MENSAJE DEL USUARIO]\n${message.trim()}`,
      systemPrompt,
      sessionId: sessionId || 'default',
      timestamp: new Date().toISOString(),
    });

    // n8n responde con array de items cuando usa "All Incoming Items"
    let reply;
    console.log('n8n raw response:', JSON.stringify(result));
    if (Array.isArray(result) && result.length > 0) {
      reply = result[0].output || result[0].text || result[0].response || JSON.stringify(result[0]);
    } else if (typeof result === 'string') {
      reply = result;
    } else {
      reply = result.output || result.reply || result.response || result.text || JSON.stringify(result);
    }

    // Extraer y guardar memorias automáticamente desde tags de la IA
    const memoryPattern = /\[GUARDAR:(\w+):(.+?)\]/g;
    let match;
    while ((match = memoryPattern.exec(reply)) !== null) {
      const category = match[1];
      const content = match[2];
      saveMemory(category, content);
    }
    // Limpiar los tags de la respuesta visible
    reply = reply.replace(/\[GUARDAR:\w+:.+?\]/g, '').trim();

    // Auto-detectar información del usuario en su mensaje
    autoDetectMemories(message.trim());

    res.json({ reply });
  } catch (error) {
    console.error('Error al contactar n8n:', error.message);
    res.status(500).json({
      error: 'Error al procesar el mensaje',
      reply: 'Lo siento, hubo un error al procesar tu mensaje. Intenta de nuevo.',
    });
  }
});

// POST /api/chat/tts - Convierte texto a voz con ElevenLabs
router.post('/tts', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'El campo "text" es requerido' });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'ElevenLabs no configurado' });
  }

  try {
    const audioBuffer = await elevenLabsService.textToSpeech(text.trim());
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
    });
    res.send(audioBuffer);
  } catch (error) {
    console.error('Error ElevenLabs:', error.message);
    res.status(500).json({ error: 'Error al generar audio' });
  }
});

module.exports = router;
