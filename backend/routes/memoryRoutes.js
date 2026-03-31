const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const MEMORIES_FILE = path.join(__dirname, '..', 'memories.json');

function loadMemories() {
  try {
    return JSON.parse(fs.readFileSync(MEMORIES_FILE, 'utf-8'));
  } catch {
    return { facts: [], preferences: [], personality_notes: [] };
  }
}

function saveMemories(data) {
  fs.writeFileSync(MEMORIES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// GET /api/memory - Leer todas las memorias (la IA las usa para contexto)
router.get('/', (req, res) => {
  const memories = loadMemories();
  const allMemories = [
    ...memories.facts.map(m => `[Dato] ${m}`),
    ...memories.preferences.map(m => `[Preferencia] ${m}`),
    ...memories.personality_notes.map(m => `[Nota] ${m}`),
  ];
  res.json({ memories: allMemories });
});

// POST /api/memory - Guardar una nueva memoria
router.post('/', (req, res) => {
  const { content, category } = req.body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'El campo "content" es requerido' });
  }

  const cat = ['facts', 'preferences', 'personality_notes'].includes(category) ? category : 'facts';
  const memories = loadMemories();

  // Evitar duplicados
  if (memories[cat].some(m => m.toLowerCase() === content.trim().toLowerCase())) {
    return res.json({ status: 'already_exists', message: 'Ya tengo esa información guardada.' });
  }

  // Límite de 50 memorias por categoría
  if (memories[cat].length >= 50) {
    memories[cat].shift(); // Quitar la más antigua
  }

  memories[cat].push(content.trim());
  saveMemories(memories);

  res.json({ status: 'saved', message: `Guardado en ${cat}: "${content.trim()}"` });
});

// DELETE /api/memory - Borrar una memoria específica
router.delete('/', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Se necesita "content"' });

  const memories = loadMemories();
  let found = false;
  for (const cat of ['facts', 'preferences', 'personality_notes']) {
    const idx = memories[cat].findIndex(m => m.toLowerCase().includes(content.toLowerCase()));
    if (idx !== -1) {
      memories[cat].splice(idx, 1);
      found = true;
    }
  }
  saveMemories(memories);
  res.json({ status: found ? 'deleted' : 'not_found' });
});

module.exports = router;
