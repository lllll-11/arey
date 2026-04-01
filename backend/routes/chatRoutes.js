const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const openRouterService = require('../services/openRouterService');
const internetService = require('../services/internetService');
const elevenLabsService = require('../services/elevenLabsService');
const googleCalendarService = require('../services/googleCalendarService');
const googleOAuthService = require('../services/googleOAuthService');
const spotifyOAuthService = require('../services/spotifyOAuthService');
const spotifyService = require('../services/spotifyService');
const discordService = require('../services/discordService');

const pendingCalendarActions = new Map();
const CONVERSATIONS_FILE = path.join(__dirname, '..', 'conversationMemory.json');
const SELF_RULES_FILE = path.join(__dirname, '..', 'selfRules.json');

function readSelfRules() {
  try {
    if (!fs.existsSync(SELF_RULES_FILE)) return { sessions: {} };
    const raw = JSON.parse(fs.readFileSync(SELF_RULES_FILE, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { sessions: {} };
    if (!raw.sessions || typeof raw.sessions !== 'object') raw.sessions = {};
    return raw;
  } catch {
    return { sessions: {} };
  }
}

function writeSelfRules(data) {
  fs.writeFileSync(SELF_RULES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function addSelfRule(sessionId, ruleText) {
  const sid = String(sessionId || 'default');
  const db = readSelfRules();
  if (!db.sessions[sid]) db.sessions[sid] = [];

  const cleanRule = String(ruleText || '').replace(/\s+/g, ' ').trim();
  if (!cleanRule) return null;

  db.sessions[sid].push({
    at: new Date().toISOString(),
    rule: cleanRule,
  });
  db.sessions[sid] = db.sessions[sid].slice(-20);
  writeSelfRules(db);
  return cleanRule;
}

function clearSelfRules(sessionId) {
  const sid = String(sessionId || 'default');
  const db = readSelfRules();
  delete db.sessions[sid];
  writeSelfRules(db);
}

function loadSelfRulesPrompt(sessionId) {
  const sid = String(sessionId || 'default');
  const db = readSelfRules();
  const rules = Array.isArray(db.sessions?.[sid]) ? db.sessions[sid] : [];
  if (rules.length === 0) return '';

  const lines = rules.map((r, i) => `${i + 1}. ${r.rule}`);
  return `\n\nReglas de reprogramacion solicitadas por el usuario (solo por orden explicita):\n${lines.join('\n')}`;
}

function readConversations() {
  try {
    if (!fs.existsSync(CONVERSATIONS_FILE)) return { sessions: {} };
    const raw = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { sessions: {} };
    if (!raw.sessions || typeof raw.sessions !== 'object') raw.sessions = {};
    return raw;
  } catch {
    return { sessions: {} };
  }
}

function writeConversations(data) {
  fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function clipText(text, maxLen = 800) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}...`;
}

function loadConversationContext(sessionId, maxTurns = 20) {
  const sid = String(sessionId || 'default');
  const db = readConversations();
  const turns = Array.isArray(db.sessions?.[sid]) ? db.sessions[sid] : [];
  const recent = turns.slice(-Math.max(1, maxTurns));

  if (recent.length === 0) return '';

  const lines = recent.flatMap((t) => {
    const userLine = t?.user ? `Usuario: ${clipText(t.user)}` : '';
    const assistantLine = t?.assistant ? `Arey: ${clipText(t.assistant)}` : '';
    return [userLine, assistantLine].filter(Boolean);
  });

  if (lines.length === 0) return '';
  return `\n\nContexto reciente de la conversacion (memoria por sesion):\n${lines.join('\n')}`;
}

function saveConversationTurn(sessionId, userText, assistantText) {
  const sid = String(sessionId || 'default');
  const user = clipText(userText, 2000);
  const assistant = clipText(assistantText, 2000);
  if (!user && !assistant) return;

  const db = readConversations();
  if (!db.sessions[sid]) db.sessions[sid] = [];

  db.sessions[sid].push({
    at: new Date().toISOString(),
    user,
    assistant,
  });

  db.sessions[sid] = db.sessions[sid].slice(-40);

  const keys = Object.keys(db.sessions);
  if (keys.length > 120) {
    keys
      .sort((a, b) => {
        const la = db.sessions[a]?.[db.sessions[a].length - 1]?.at || '';
        const lb = db.sessions[b]?.[db.sessions[b].length - 1]?.at || '';
        return la.localeCompare(lb);
      })
      .slice(0, keys.length - 120)
      .forEach((k) => {
        delete db.sessions[k];
      });
  }

  writeConversations(db);
}

// Cargar personalidad del asistente
function loadPersonality() {
  const filePath = path.join(__dirname, '..', 'personality.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const rules = data.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  return `${data.personality}\n\nReglas:\n${rules}`;
}

// Cargar memorias guardadas
function loadMemories(limit = 999) {
  try {
    const filePath = path.join(__dirname, '..', 'memories.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const all = [
      ...data.facts.map(m => `- ${m}`),
      ...data.preferences.map(m => `- ${m}`),
      ...data.personality_notes.map(m => `- ${m}`),
    ].slice(-Math.max(0, limit));
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

// Detectar si el mensaje parece técnico/de programación
function isCodingPrompt(msg) {
  const text = msg.toLowerCase();
  const codingHints = [
    'codigo', 'código', 'programa', 'programar', 'funcion', 'función', 'bug', 'error',
    'javascript', 'js', 'typescript', 'python', 'java', 'c++', 'html', 'css', 'sql',
    'api', 'backend', 'frontend', 'debug', 'stack trace', 'regex', 'algoritmo',
    'refactor', 'commit', 'git', 'terminal', 'npm', 'node', 'express',
  ];

  if (text.includes('```')) return true;
  return codingHints.some((hint) => text.includes(hint));
}

function detectUserTone(msg) {
  const text = normalizeText(msg || '');
  const strongSlang = /(wey|wey\b|guey|cabr[oó]n|ching(a|as|ado|ona)|verga|pinche|pendej[oa]|no mames|alv|vato|compa)/.test(text);
  return strongSlang ? 'strong' : 'neutral';
}

function parseModelList(raw) {
  return String(raw || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

function uniqueModels(models) {
  const seen = new Set();
  const out = [];
  for (const model of models) {
    const key = String(model || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(model.trim());
  }
  return out;
}

function wantsInternetLookup(msg) {
  const text = normalizeText(msg || '');
  if (!text.trim()) return false;

  return /(busca|buscar|investiga|investigar|internet|web|noticias|que paso hoy|que pasa hoy|ultimas noticias|actualizado|actualizacion|fuentes|referencias)/.test(text);
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/\uFFFD/g, 'n')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isAffirmative(text) {
  return /^(si|sí|ok|vale|confirmo|confirmar|dale|hazlo|yes)\b/.test(normalizeText(text).trim());
}

function isNegative(text) {
  return /^(no|cancelar|cancela|olvidalo|olvidalo|mejor no|deten)\b/.test(normalizeText(text).trim());
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('es-MX', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildDateTime(dateObj, timeObj) {
  const out = new Date(dateObj);
  out.setHours(timeObj.hour, timeObj.minute, 0, 0);
  return out;
}

function extractDateFromText(text) {
  const now = new Date();
  const lower = normalizeText(text);
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (lower.includes('pasado manana') || lower.includes('pasado mañana')) {
    date.setDate(date.getDate() + 2);
    return date;
  }
  if (lower.includes('manana') || lower.includes('mañana')) {
    date.setDate(date.getDate() + 1);
    return date;
  }
  if (lower.includes('hoy')) {
    return date;
  }

  const explicitDateMatch = lower.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (explicitDateMatch) {
    const day = Number(explicitDateMatch[1]);
    const month = Number(explicitDateMatch[2]) - 1;
    const year = explicitDateMatch[3]
      ? Number(explicitDateMatch[3].length === 2 ? `20${explicitDateMatch[3]}` : explicitDateMatch[3])
      : now.getFullYear();
    return new Date(year, month, day);
  }

  return null;
}

function extractTimeFromText(text) {
  const lower = normalizeText(text);
  const timeMatch = lower.match(/(?:a las|alas|a la|al)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!timeMatch) return null;

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  const ampm = timeMatch[3];

  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  if (!ampm) {
    if (lower.includes('de la tarde') && hour < 12) hour += 12;
    if (lower.includes('de la noche') && hour < 12) hour += 12;
    if (lower.includes('de la manana') || lower.includes('de la mañana')) {
      if (hour === 12) hour = 0;
    }
  }

  return { hour, minute };
}

function extractDurationMinutes(text) {
  const lower = normalizeText(text);
  const mins = lower.match(/(\d{1,3})\s*(min|minuto|minutos)/);
  if (mins) return Number(mins[1]);

  const hours = lower.match(/(\d{1,2})\s*(hora|horas)/);
  if (hours) return Number(hours[1]) * 60;

  return 60;
}

function extractSummary(text) {
  const lower = normalizeText(text);
  const withMatch = lower.match(/(?:cita|reunion)\s+con\s+(.+?)(?:\s+(?:hoy|manana|pasado manana|a las)\b|$)/);
  if (withMatch) {
    const who = withMatch[1].trim();
    return `Cita con ${who}`;
  }
  return 'Cita';
}

function parseAppointmentIntent(text) {
  const lower = normalizeText(text);
  if (/(cancela|cancelar|elimina|eliminar|borra|borrar|mueve|mover|reagenda|reagendar|cambia|cambiar)/.test(lower)) {
    return null;
  }
  const asksForAppointment = /(agenda|agendar|agendame|crear cita|crea una cita|programa una cita|programar cita|cita)/.test(lower);
  if (!asksForAppointment) return null;

  // Patrón común: "agenda una cita mañana a las 2 de la tarde"
  let date = null;
  let time = null;
  const commonPattern = lower.match(/(hoy|manana|pasado manana).*?a\s*las?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|de la tarde|de la noche|de la manana)?/);
  if (commonPattern) {
    const dayToken = commonPattern[1];
    const h = Number(commonPattern[2]);
    const m = Number(commonPattern[3] || 0);
    const marker = commonPattern[4] || '';

    const base = new Date();
    date = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    if (dayToken === 'manana') date.setDate(date.getDate() + 1);
    if (dayToken === 'pasado manana') date.setDate(date.getDate() + 2);

    let hour = h;
    if ((marker === 'pm' || marker === 'de la tarde' || marker === 'de la noche') && hour < 12) hour += 12;
    if ((marker === 'am' || marker === 'de la manana') && hour === 12) hour = 0;
    time = { hour, minute: m };
  }

  if (!date) date = extractDateFromText(text);
  if (!time) time = extractTimeFromText(text);
  if (!date || !time) return null;

  const start = new Date(date);
  start.setHours(time.hour, time.minute, 0, 0);

  const durationMinutes = extractDurationMinutes(text);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  return {
    summary: extractSummary(text),
    description: `Creada desde Arey: ${text}`,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function parseCancelIntent(text) {
  const lower = normalizeText(text);
  const asksCancel = /(cancela|cancelar|elimina|eliminar|borra|borrar)/.test(lower)
    && /(cita|evento|reunion)/.test(lower);
  if (!asksCancel) return null;

  return {
    date: extractDateFromText(text),
    time: extractTimeFromText(text),
    summaryHint: (lower.match(/con\s+(.+?)(?:\s+(?:hoy|manana|pasado manana|a las)|$)/) || [])[1] || '',
  };
}

function parseMoveIntent(text) {
  const lower = normalizeText(text);
  const asksMove = /(mueve|mover|reagenda|reagendar|cambia|cambiar)/.test(lower)
    && /(cita|evento|reunion)/.test(lower);
  if (!asksMove) return null;

  const match = lower.match(/(?:mueve|mover|reagenda|reagendar|cambia|cambiar).+?de\s+(.+?)\s+(?:a|para)\s+(.+)/);
  if (!match) return { invalid: true };

  const fromText = match[1];
  const toText = match[2];
  const fromDate = extractDateFromText(fromText) || extractDateFromText(text);
  const fromTime = extractTimeFromText(fromText) || extractTimeFromText(text);
  const toDate = extractDateFromText(toText) || fromDate;
  const toTime = extractTimeFromText(toText);

  if (!fromDate || !fromTime || !toDate || !toTime) return { invalid: true };

  return {
    fromDate,
    fromTime,
    toDate,
    toTime,
    summaryHint: (lower.match(/con\s+(.+?)(?:\s+de\s+|\s+a\s+|\s+para\s+|$)/) || [])[1] || '',
  };
}

function parseConnectServiceIntent(text) {
  const lower = normalizeText(text);
  const asksConnect = /(conecta|conectate|conectarse|integra|integrar|vincula|vincular)/.test(lower);
  if (!asksConnect) return null;

  if (/(google calendar|calendar|calendario|google)/.test(lower)) {
    return { service: 'google-calendar' };
  }

  if (/(whatsapp)/.test(lower)) {
    return { service: 'whatsapp' };
  }

  if (/(spotify)/.test(lower)) {
    return { service: 'spotify' };
  }

  if (/(discord)/.test(lower)) {
    return { service: 'discord' };
  }

  if (/(telegram)/.test(lower)) {
    return { service: 'telegram' };
  }

  return { service: 'unknown' };
}

function parseSpotifyCredentialsIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized.includes('spotify')) return null;

  const clientIdMatch = text.match(/(?:spotify\s*)?(?:client\s*id|id\s*de\s*spotify)\s*(?:es|:)?\s*([a-zA-Z0-9]+)/i);
  const clientSecretMatch = text.match(/(?:spotify\s*)?(?:client\s*secret|secret\s*de\s*spotify)\s*(?:es|:)?\s*([a-zA-Z0-9_-]+)/i);

  if (!clientIdMatch && !clientSecretMatch) return null;

  return {
    clientId: clientIdMatch ? clientIdMatch[1].trim() : '',
    clientSecret: clientSecretMatch ? clientSecretMatch[1].trim() : '',
  };
}

function parseDiscordCredentialsIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized.includes('discord')) return null;

  const tokenMatch = text.match(/(?:discord\s*)?(?:bot\s*token|token\s*de\s*discord)\s*(?:es|:)?\s*([a-zA-Z0-9._-]+)/i);
  const clientIdMatch = text.match(/(?:discord\s*)?(?:client\s*id|application\s*id|id\s*de\s*discord)\s*(?:es|:)?\s*([a-zA-Z0-9]+)/i);

  if (!tokenMatch && !clientIdMatch) return null;

  return {
    botToken: tokenMatch ? tokenMatch[1].trim() : '',
    clientId: clientIdMatch ? clientIdMatch[1].trim() : '',
  };
}

function parseSpotifyCommand(text) {
  const n = normalizeText(text);

  // Play / Pon / Reproduce
  const playMatch = n.match(/^(?:pon(?:me|le)?|reproduce|play|toca|ponme)\s+(.+)/);
  if (playMatch) {
    const query = playMatch[1].replace(/\s+en\s+spotify$/i, '').trim();
    // Detect type
    let type = 'track';
    if (/(playlist|lista)\s+/.test(n)) type = 'playlist';
    else if (/(album|disco)\s+/.test(n)) type = 'album';
    else if (/musica\s+de\s+|de\s+.+$/.test(n) && !n.includes(' cancion ')) type = 'artist';
    return { action: 'play', query, type };
  }

  // Pause
  if (/^(pausa|pausar|pause|para la musica|para la cancion|detener|deten)(\s|$)/.test(n)) {
    return { action: 'pause' };
  }

  // Resume
  if (/^(continua|continuar|resume|reanuda|reanudar|dale play|sigue)(\s+la)?\s*(musica|cancion|reproduccion)?$/.test(n)) {
    return { action: 'resume' };
  }

  // Next
  if (/^(siguiente|next|skip|salta|cambia(?:le)?|pasa(?:le)?)(\s+cancion|\s+tema|\s+track)?$/.test(n)) {
    return { action: 'next' };
  }

  // Previous
  if (/^(anterior|previous|prev|regresa|la\s+de\s+antes|la\s+anterior)(\s+cancion|\s+tema)?$/.test(n)) {
    return { action: 'previous' };
  }

  // Volume
  const volMatch = n.match(/^(?:volumen|volume|vol|sube(?:le)?|baja(?:le)?)\s*(?:a|al)?\s*(\d+)/);
  if (volMatch) return { action: 'volume', volume: Number(volMatch[1]) };
  if (/^sube(?:le)?\s*(?:el\s+)?(?:volumen|volume|vol)$/.test(n)) return { action: 'volume_up' };
  if (/^baja(?:le)?\s*(?:el\s+)?(?:volumen|volume|vol)$/.test(n)) return { action: 'volume_down' };

  // Shuffle
  if (/^(aleatorio|shuffle|mezcla|random)(\s+on|\s+off)?$/.test(n)) {
    const off = /off|desactiva/.test(n);
    return { action: 'shuffle', state: !off };
  }

  // Repeat
  if (/^(repetir|repeat|repite|loop)/.test(n)) {
    if (/cancion|track|tema/.test(n)) return { action: 'repeat', state: 'track' };
    if (/off|no|desactiva|quita/.test(n)) return { action: 'repeat', state: 'off' };
    return { action: 'repeat', state: 'context' };
  }

  // Now playing
  if (/^(que suena|que esta sonando|now playing|que cancion es|que se escucha|que escucho|que oigo|que cancion|que tema)/.test(n)) {
    return { action: 'now_playing' };
  }

  // Queue
  if (/^(cola|queue|fila|que sigue)$/.test(n)) {
    return { action: 'queue' };
  }
  const queueMatch = n.match(/^(?:agrega|agregar|pon|add)\s+(?:a la cola|al queue|en cola)\s+(.+)/);
  if (queueMatch) return { action: 'add_queue', query: queueMatch[1].trim() };
  const queueMatch2 = n.match(/^(?:agrega|agregar|pon|add)\s+(.+?)\s+(?:a la cola|al queue|en cola)$/);
  if (queueMatch2) return { action: 'add_queue', query: queueMatch2[1].trim() };

  // Search
  const searchMatch = n.match(/^busca(?:r|me)?\s+(?:en\s+spotify\s+)?(.+?)(?:\s+en\s+spotify)?$/);
  if (searchMatch && /(spotify|cancion|artista|album|musica|track)/.test(n)) {
    return { action: 'search', query: searchMatch[1].trim() };
  }

  // Top tracks
  if (/^(?:mis|mi)\s+(?:top|canciones mas escuchadas|mas escuchad[oa]s)/.test(n)) {
    return { action: 'top_tracks' };
  }

  // Top artists
  if (/^(?:mis|mi)\s+(?:artistas favoritos|artistas mas escuchados|top artistas)/.test(n)) {
    return { action: 'top_artists' };
  }

  // Recently played
  if (/^(?:recientes|historial|lo que escuche|escuchado recientemente|recently played|que escuche)/.test(n)) {
    return { action: 'recent' };
  }

  // Recommendations
  if (/^(?:recomienda|recomendaciones|recomiendame|sugiere|sugerencias)(?:\s+(?:musica|canciones|algo))?/.test(n)) {
    return { action: 'recommendations' };
  }

  // New releases
  if (/^(?:novedades|lanzamientos|nuevo|nuevos lanzamientos|new releases|que hay nuevo)/.test(n)) {
    return { action: 'new_releases' };
  }

  // My playlists
  if (/^(?:mis playlists|mis listas|playlists)$/.test(n)) {
    return { action: 'my_playlists' };
  }

  // Devices
  if (/^(?:dispositivos|devices|donde suena|en que dispositivo)/.test(n)) {
    return { action: 'devices' };
  }

  // Like
  if (/^(?:like|me gusta|guardar?|dale like|likea)(?:\s+(?:esta|la|cancion))?$/.test(n)) {
    return { action: 'like' };
  }

  // Profile
  if (/^(?:mi perfil|perfil)\s*(?:de\s+)?spotify$/.test(n)) {
    return { action: 'profile' };
  }

  return null;
}

async function handleSpotifyCommand(cmd) {
  switch (cmd.action) {
    case 'play': {
      const result = await spotifyService.playBySearch(cmd.query, cmd.type || 'track');
      if (!result.success) return result.error;
      const what = result.track || result.playlist || result.album || result.artist || cmd.query;
      return `Reproduciendo: ${what}`;
    }
    case 'pause': {
      const r = await spotifyService.pause();
      return r.success ? 'Musica pausada.' : r.error;
    }
    case 'resume': {
      const r = await spotifyService.play();
      return r.success ? 'Reproduccion reanudada.' : r.error;
    }
    case 'next': {
      const r = await spotifyService.next();
      if (!r.success) return r.error;
      // Esperar un poco y mostrar la siguiente cancion
      await new Promise(res => setTimeout(res, 500));
      const now = await spotifyService.getNowPlaying();
      return now.playing ? `Siguiente: ${now.track} - ${now.artists}` : 'Siguiente cancion.';
    }
    case 'previous': {
      const r = await spotifyService.previous();
      if (!r.success) return r.error;
      await new Promise(res => setTimeout(res, 500));
      const now = await spotifyService.getNowPlaying();
      return now.playing ? `Anterior: ${now.track} - ${now.artists}` : 'Cancion anterior.';
    }
    case 'volume': {
      const r = await spotifyService.setVolume(cmd.volume);
      return r.success ? `Volumen al ${r.volume}%.` : r.error;
    }
    case 'volume_up': {
      const devices = await spotifyService.getDevices();
      const active = devices.find(d => d.active);
      const current = active?.volume ?? 50;
      const r = await spotifyService.setVolume(Math.min(100, current + 15));
      return r.success ? `Volumen subido a ${r.volume}%.` : r.error;
    }
    case 'volume_down': {
      const devices = await spotifyService.getDevices();
      const active = devices.find(d => d.active);
      const current = active?.volume ?? 50;
      const r = await spotifyService.setVolume(Math.max(0, current - 15));
      return r.success ? `Volumen bajado a ${r.volume}%.` : r.error;
    }
    case 'shuffle': {
      const r = await spotifyService.setShuffle(cmd.state);
      return r.success ? `Aleatorio ${r.state ? 'activado' : 'desactivado'}.` : r.error;
    }
    case 'repeat': {
      const r = await spotifyService.setRepeat(cmd.state);
      const labels = { track: 'cancion', context: 'playlist/album', off: 'desactivado' };
      return r.success ? `Repetir: ${labels[r.state] || r.state}.` : r.error;
    }
    case 'now_playing': {
      const np = await spotifyService.getNowPlaying();
      return np.message;
    }
    case 'queue': {
      const q = await spotifyService.getQueue();
      return q.message;
    }
    case 'add_queue': {
      const results = await spotifyService.search(cmd.query, 'track', 1);
      if (!results.tracks?.length) return `No encontre "${cmd.query}" en Spotify.`;
      const track = results.tracks[0];
      const r = await spotifyService.addToQueue(track.uri);
      return r.success ? `Agregado a la cola: ${track.name} - ${track.artists}` : r.error;
    }
    case 'search': {
      const results = await spotifyService.search(cmd.query, 'track,artist,album', 5);
      const lines = [];
      if (results.tracks?.length) {
        lines.push('Canciones:');
        results.tracks.forEach(t => lines.push(`  ${t.position}. ${t.name} - ${t.artists} (${t.duration})`));
      }
      if (results.artists?.length) {
        lines.push('Artistas:');
        results.artists.forEach(a => lines.push(`  ${a.position}. ${a.name} - ${a.genres}`));
      }
      if (results.albums?.length) {
        lines.push('Albums:');
        results.albums.forEach(a => lines.push(`  ${a.position}. ${a.name} - ${a.artists} (${a.year})`));
      }
      return lines.length ? lines.join('\n') : `No encontre resultados para "${cmd.query}".`;
    }
    case 'top_tracks': {
      const tracks = await spotifyService.getTopTracks('short_term', 10);
      if (!tracks.length) return 'No tengo datos de tus canciones mas escuchadas aun.';
      return 'Tus canciones mas escuchadas:\n' + tracks.map(t => `${t.position}. ${t.name} - ${t.artists}`).join('\n');
    }
    case 'top_artists': {
      const artists = await spotifyService.getTopArtists('short_term', 10);
      if (!artists.length) return 'No tengo datos de tus artistas mas escuchados aun.';
      return 'Tus artistas mas escuchados:\n' + artists.map(a => `${a.position}. ${a.name} (${a.genres})`).join('\n');
    }
    case 'recent': {
      const recent = await spotifyService.getRecentlyPlayed(10);
      if (!recent.length) return 'No hay historial reciente.';
      return 'Escuchaste recientemente:\n' + recent.map(t => `${t.position}. ${t.name} - ${t.artists}`).join('\n');
    }
    case 'recommendations': {
      const recs = await spotifyService.getRecommendations([], [], [], 10);
      if (!recs.length) return 'No pude generar recomendaciones en este momento.';
      return 'Te recomiendo:\n' + recs.map(t => `${t.position}. ${t.name} - ${t.artists}`).join('\n');
    }
    case 'new_releases': {
      const releases = await spotifyService.getNewReleases(10);
      if (!releases.length) return 'No hay lanzamientos nuevos disponibles.';
      return 'Nuevos lanzamientos:\n' + releases.map(a => `${a.position}. ${a.name} - ${a.artists} (${a.releaseDate})`).join('\n');
    }
    case 'my_playlists': {
      const playlists = await spotifyService.getMyPlaylists(15);
      if (!playlists.length) return 'No tienes playlists.';
      return 'Tus playlists:\n' + playlists.map(p => `${p.position}. ${p.name} (${p.tracks} tracks)`).join('\n');
    }
    case 'devices': {
      const devices = await spotifyService.getDevices();
      if (!devices.length) return 'No hay dispositivos activos. Abre Spotify en tu cel o compu.';
      return 'Dispositivos:\n' + devices.map(d => `- ${d.name} (${d.type}) ${d.active ? '← activo' : ''} vol: ${d.volume}%`).join('\n');
    }
    case 'like': {
      const np = await spotifyService.getNowPlaying();
      if (!np.playing || !np.uri) return 'No hay cancion sonando para dar like.';
      const trackId = np.uri.split(':').pop();
      await spotifyService.saveTracks([trackId]);
      return `Le diste like a: ${np.track} - ${np.artists}`;
    }
    case 'profile': {
      const p = await spotifyService.getProfile();
      return `Perfil de Spotify:\nNombre: ${p.name}\nPlan: ${p.product}\nPais: ${p.country}\nSeguidores: ${p.followers}`;
    }
    default:
      return null;
  }
}

// ── Todo / Notes System ──
const TODOS_FILE = path.join(__dirname, '..', 'todos.json');

function readTodos() {
  try {
    if (!fs.existsSync(TODOS_FILE)) return { items: [] };
    return JSON.parse(fs.readFileSync(TODOS_FILE, 'utf-8'));
  } catch { return { items: [] }; }
}

function writeTodos(data) {
  fs.writeFileSync(TODOS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

async function handleTodoCommand(msg, sid) {
  const n = normalizeText(msg);

  // Add todo
  const addMatch = n.match(/^(?:recuerdame|recordar|apunta|anota|agrega tarea|tarea|nota|todo|pendiente|agregar?\s+(?:a\s+)?(?:la\s+)?(?:lista|pendientes))\s*:?\s+(.+)/);
  if (addMatch) {
    const db = readTodos();
    db.items.push({
      id: Date.now(),
      text: addMatch[1].trim(),
      done: false,
      createdAt: new Date().toISOString(),
      session: sid,
    });
    writeTodos(db);
    return `Anotado: "${addMatch[1].trim()}"`;
  }

  // List todos
  if (/^(?:mis tareas|mis pendientes|mi lista|todos|notas|que tengo pendiente|que tengo anotado|pendientes|lista)$/.test(n)) {
    const db = readTodos();
    const pending = db.items.filter(i => !i.done);
    if (!pending.length) return 'No tienes pendientes. Todo limpio.';
    return 'Tus pendientes:\n' + pending.map((t, i) => `${i + 1}. ${t.text}`).join('\n');
  }

  // Complete todo
  const doneMatch = n.match(/^(?:listo|hecho|completar?|tacha|done)\s+(.+)/);
  if (doneMatch) {
    const db = readTodos();
    const hint = doneMatch[1].trim().toLowerCase();
    const idx = db.items.findIndex(i => !i.done && normalizeText(i.text).includes(hint));
    if (idx >= 0) {
      db.items[idx].done = true;
      db.items[idx].completedAt = new Date().toISOString();
      writeTodos(db);
      return `Marcado como hecho: "${db.items[idx].text}"`;
    }
    return `No encontre un pendiente que coincida con "${hint}".`;
  }

  // Clear completed
  if (/^(?:limpia|limpiar|borra)\s+(?:los\s+)?(?:completados|hechos|terminados)$/.test(n)) {
    const db = readTodos();
    db.items = db.items.filter(i => !i.done);
    writeTodos(db);
    return 'Listo, borre los pendientes completados.';
  }

  return null;
}

// ── Weather ──
async function handleWeatherCommand(msg) {
  const n = normalizeText(msg);
  const weatherMatch = n.match(/^(?:clima|weather|temperatura|que clima|como esta el clima|pronostico|hace frio|hace calor|va a llover)\s*(?:en\s+)?(.*)$/);
  if (!weatherMatch) return null;

  const city = weatherMatch[1]?.trim() || 'Mexico City';
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=es`;
      https.get(url, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });

    const current = data.current_condition?.[0];
    if (!current) return `No pude obtener el clima de ${city}.`;

    const temp = current.temp_C;
    const feels = current.FeelsLikeC;
    const desc = current.lang_es?.[0]?.value || current.weatherDesc?.[0]?.value || '';
    const humidity = current.humidity;
    const wind = current.windspeedKmph;
    const forecast = data.weather?.[0];
    const max = forecast?.maxtempC;
    const min = forecast?.mintempC;

    return `Clima en ${city}:\n🌡️ ${temp}°C (se siente ${feels}°C)\n☁️ ${desc}\n💧 Humedad: ${humidity}%\n💨 Viento: ${wind} km/h\n📊 Max: ${max}°C / Min: ${min}°C`;
  } catch {
    return `No pude obtener el clima de "${city}". Intenta con otra ciudad.`;
  }
}

async function findClosestEvent({ date, time, summaryHint }) {
  if (!date || !time) return null;

  const target = buildDateTime(date, time);
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const events = await googleCalendarService.listEvents({
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    maxResults: 100,
  });

  const timedEvents = events.filter((e) => e.start?.dateTime && e.end?.dateTime);
  const filtered = summaryHint
    ? timedEvents.filter((e) => normalizeText(e.summary || '').includes(summaryHint))
    : timedEvents;
  const base = filtered.length > 0 ? filtered : timedEvents;
  if (base.length === 0) return null;

  let best = null;
  let bestDiff = Number.MAX_SAFE_INTEGER;
  for (const event of base) {
    const diff = Math.abs(new Date(event.start.dateTime).getTime() - target.getTime());
    if (diff < bestDiff) {
      best = event;
      bestDiff = diff;
    }
  }

  // 3 horas de tolerancia para evitar borrar/mover eventos equivocados
  if (bestDiff > 3 * 60 * 60 * 1000) return null;
  return best;
}

// POST /api/chat - Enviar mensaje al asistente IA via OpenRouter
router.post('/', async (req, res) => {
  const { message, sessionId, mode, imageDataUrl, imageUrl } = req.body;

  const normalizedImageDataUrl = typeof imageDataUrl === 'string' ? imageDataUrl.trim() : '';
  const normalizedImageUrl = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  const hasImageDataUrl = normalizedImageDataUrl.startsWith('data:image/');
  const hasImageUrl = /^https?:\/\//i.test(normalizedImageUrl);
  const providedImage = hasImageDataUrl ? normalizedImageDataUrl : (hasImageUrl ? normalizedImageUrl : '');
  const hasImage = Boolean(providedImage);

  if ((!message || typeof message !== 'string' || message.trim().length === 0) && !hasImage) {
    return res.status(400).json({ error: 'Debes enviar "message" o una imagen valida.' });
  }

  if (hasImageDataUrl && normalizedImageDataUrl.length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: 'La imagen es demasiado grande. Usa una de hasta ~6MB.' });
  }

  try {
    const msg = (typeof message === 'string' ? message : '').trim();
    const sid = sessionId || 'default';

    const clearReprogram = /^(borra|limpia|quita)\s+(la\s+)?reprogramacion$/i.test(msg);
    if (clearReprogram) {
      clearSelfRules(sid);
      return res.json({ reply: 'Listo. Borre las reglas de reprogramacion de esta sesion.' });
    }

    const reprogramMatch = msg.match(/^reprograma(?:\s+su\s+codigo)?\s*:?\s+(.+)$/i);
    const directPermission = /te\s+doy\s+permiso\s+de\s+actualizar\s+tu\s+codigo/i.test(normalizeText(msg));
    if (reprogramMatch || directPermission) {
      const requestedRule = reprogramMatch
        ? reprogramMatch[1]
        : 'Tienes permiso del usuario para proponer y aplicar reprogramaciones solo cuando lo pida explicitamente.';

      const savedRule = addSelfRule(sid, requestedRule);
      if (!savedRule) {
        return res.json({ reply: 'No pude guardar esa reprogramacion. Enviamela otra vez con texto claro.' });
      }
      return res.json({
        reply: `Hecho. Aplicare esta reprogramacion solo cuando tu la pidas: "${savedRule}".`,
      });
    }

    const pending = pendingCalendarActions.get(sid);

    if (pending) {
      if (isNegative(msg)) {
        pendingCalendarActions.delete(sid);
        return res.json({ reply: 'Listo, cancelado. No hice ningun cambio en tu calendario.' });
      }

      if (!isAffirmative(msg)) {
        return res.json({ reply: 'Responde "si" para confirmar o "no" para cancelar.' });
      }

      pendingCalendarActions.delete(sid);

      if (pending.type === 'create') {
        const created = await googleCalendarService.createEvent(pending.payload.appointment);
        return res.json({
          reply: `Perfecto. Cita creada: ${created.summary} para ${formatDateTime(created.start.dateTime)}.`,
          calendarEvent: {
            id: created.id,
            summary: created.summary,
            start: created.start,
            end: created.end,
            htmlLink: created.htmlLink,
          },
        });
      }

      if (pending.type === 'cancel') {
        await googleCalendarService.deleteEvent(pending.payload.event.id);
        return res.json({
          reply: `Hecho. Cancele la cita "${pending.payload.event.summary || 'Sin titulo'}" de ${formatDateTime(pending.payload.event.start.dateTime)}.`,
        });
      }

      if (pending.type === 'move') {
        const updated = await googleCalendarService.updateEvent(pending.payload.event.id, {
          start: pending.payload.newStart,
          end: pending.payload.newEnd,
        });
        return res.json({
          reply: `Listo. Movi la cita "${updated.summary || 'Sin titulo'}" para ${formatDateTime(updated.start.dateTime)}.`,
          calendarEvent: {
            id: updated.id,
            summary: updated.summary,
            start: updated.start,
            end: updated.end,
            htmlLink: updated.htmlLink,
          },
        });
      }
    }

    const appointment = parseAppointmentIntent(msg);
    if (appointment) {
      pendingCalendarActions.set(sid, {
        type: 'create',
        payload: { appointment },
      });
      return res.json({
        reply: `Quieres que cree esta cita: "${appointment.summary}" para ${formatDateTime(appointment.start)}? Responde si/no.`,
      });
    }

    const cancelIntent = parseCancelIntent(msg);
    if (cancelIntent) {
      if (!cancelIntent.date || !cancelIntent.time) {
        return res.json({
          reply: 'Para cancelar, dime fecha y hora. Ejemplo: "cancela la cita de manana a las 2 pm".',
        });
      }

      const event = await findClosestEvent(cancelIntent);
      if (!event) {
        return res.json({ reply: 'No encontre una cita que coincida con esa fecha/hora.' });
      }

      pendingCalendarActions.set(sid, {
        type: 'cancel',
        payload: { event },
      });
      return res.json({
        reply: `Quieres que cancele la cita "${event.summary || 'Sin titulo'}" de ${formatDateTime(event.start.dateTime)}? Responde si/no.`,
      });
    }

    const moveIntent = parseMoveIntent(msg);
    if (moveIntent) {
      if (moveIntent.invalid) {
        return res.json({
          reply: 'Para mover una cita usa este formato: "mueve la cita de manana a las 2 pm para pasado manana a las 4 pm".',
        });
      }

      const event = await findClosestEvent({
        date: moveIntent.fromDate,
        time: moveIntent.fromTime,
        summaryHint: moveIntent.summaryHint,
      });

      if (!event) {
        return res.json({ reply: 'No encontre la cita original para mover.' });
      }

      const oldStart = new Date(event.start.dateTime);
      const oldEnd = new Date(event.end.dateTime);
      const oldDurationMs = Math.max(15 * 60 * 1000, oldEnd.getTime() - oldStart.getTime());
      const newStartDate = buildDateTime(moveIntent.toDate, moveIntent.toTime);
      const newEndDate = new Date(newStartDate.getTime() + oldDurationMs);

      pendingCalendarActions.set(sid, {
        type: 'move',
        payload: {
          event,
          newStart: newStartDate.toISOString(),
          newEnd: newEndDate.toISOString(),
        },
      });

      return res.json({
        reply: `Quieres mover "${event.summary || 'Sin titulo'}" a ${formatDateTime(newStartDate.toISOString())}? Responde si/no.`,
      });
    }

    const spotifyCredentials = parseSpotifyCredentialsIntent(msg);
    if (spotifyCredentials) {
      spotifyOAuthService.setStoredSpotifyCredentials(spotifyCredentials);
      const missing = spotifyOAuthService.getMissingSpotifyCredentials();
      if (missing.length > 0) {
        return res.json({
          reply: `Listo, guarde parte de la configuracion de Spotify. Aun falta: ${missing.join(', ')}. Puedes pasarmelo por este chat.`,
          integration: {
            service: 'spotify',
            status: 'missing-credentials',
            missing,
          },
        });
      }

      const authUrl = spotifyOAuthService.getSpotifyAuthUrl();
      return res.json({
        reply: `Perfecto, ya tengo las credenciales base. Ahora abre este enlace y autoriza Spotify: ${authUrl}`,
        integration: {
          service: 'spotify',
          status: 'pending-user-auth',
          authUrl,
        },
      });
    }

    const discordCredentials = parseDiscordCredentialsIntent(msg);
    if (discordCredentials) {
      discordService.setStoredDiscordCredentials(discordCredentials);
      const missing = discordService.getMissingDiscordCredentials();
      if (missing.length > 0) {
        return res.json({
          reply: `Listo, guarde parte de la configuracion de Discord. Aun falta: ${missing.join(', ')}. Puedes pasarmelo por este chat.`,
          integration: {
            service: 'discord',
            status: 'missing-credentials',
            missing,
          },
        });
      }

      try {
        const status = await discordService.connectDiscord('http://localhost:3000');
        return res.json({
          reply: `Discord ya quedo conectado. Invita el bot con este enlace: ${status.inviteUrl}`,
          integration: {
            service: 'discord',
            status: 'connected',
            inviteUrl: status.inviteUrl,
            botTag: status.botTag,
          },
        });
      } catch (error) {
        return res.json({
          reply: `Guarde las credenciales de Discord, pero no pude conectar el bot: ${error.message}`,
          integration: {
            service: 'discord',
            status: 'connection-error',
          },
        });
      }
    }

    const connectIntent = parseConnectServiceIntent(msg);
    if (connectIntent) {
      if (connectIntent.service === 'google-calendar') {
        if (googleCalendarService.isGoogleConfigured()) {
          return res.json({
            reply: 'Google Calendar ya esta conectado y funcionando.',
          });
        }

        const authUrl = googleOAuthService.buildGoogleAuthUrl();
        return res.json({
          reply: `Para terminar la conexion abre este enlace y autoriza: ${authUrl}`,
          integration: {
            service: 'google-calendar',
            status: 'pending-user-auth',
            authUrl,
          },
        });
      }

      if (connectIntent.service === 'whatsapp') {
        return res.json({
          reply: 'Puedo conectarme a WhatsApp, pero necesito configurar primero API oficial (Meta o Twilio). Cuando quieras lo armamos.',
        });
      }

      if (connectIntent.service === 'spotify') {
        if (spotifyOAuthService.isSpotifyConfigured()) {
          return res.json({
            reply: 'Spotify ya esta conectado y funcionando.',
          });
        }

        try {
          const authUrl = spotifyOAuthService.getSpotifyAuthUrl();
          return res.json({
            reply: `Para conectar Spotify, abre este enlace y autoriza acceso: ${authUrl}`,
            integration: {
              service: 'spotify',
              status: 'pending-user-auth',
              authUrl,
            },
          });
        } catch (error) {
          const missing = spotifyOAuthService.getMissingSpotifyCredentials();
          return res.json({
            reply: `Para conectar Spotify me falta acceso. Enviame por chat ${missing.join(' y ')} en este formato: "spotify client id es ..." y "spotify client secret es ...".`,
            integration: {
              service: 'spotify',
              status: 'missing-credentials',
              missing,
            },
          });
        }
      }

      if (connectIntent.service === 'discord') {
        const missing = discordService.getMissingDiscordCredentials();
        if (missing.length > 0) {
          return res.json({
            reply: `Para conectar Discord enviame por chat ${missing.join(' y ')}. Formato: "discord bot token es ..." y "discord client id es ...".`,
            integration: {
              service: 'discord',
              status: 'missing-credentials',
              missing,
            },
          });
        }

        try {
          const status = await discordService.connectDiscord('http://localhost:3000');
          return res.json({
            reply: status.wakeWordEnabled
              ? `Discord ya esta conectado. Puedes llamarla escribiendo "${status.wakeWord} ..." en el grupo. Si aun no lo agregas a tu servidor, usa este enlace: ${status.inviteUrl}`
              : `Discord ya esta conectado, pero para usar la palabra clave "${status.wakeWord}" en grupos debes activar Message Content Intent en Discord Developer Portal. Mientras tanto usa DM o mencion. Enlace del bot: ${status.inviteUrl}`,
            integration: {
              service: 'discord',
              status: 'connected',
              inviteUrl: status.inviteUrl,
              botTag: status.botTag,
              wakeWord: status.wakeWord,
              wakeWordEnabled: status.wakeWordEnabled,
              warning: status.warning,
            },
          });
        } catch (error) {
          return res.json({
            reply: `No pude conectar Discord aun: ${error.message}`,
            integration: {
              service: 'discord',
              status: 'connection-error',
              missing,
            },
          });
        }
      }

      if (connectIntent.service === 'telegram') {
        return res.json({
          reply: 'Puedo conectarme a Telegram con un bot token. Si quieres, lo configuramos y queda automatico desde chat.',
        });
      }

      return res.json({
        reply: 'Dime exactamente que servicio quieres conectar (Google Calendar, WhatsApp o Telegram).',
      });
    }

    const isCallMode = mode === 'call';

    // ── Spotify commands via natural language ──
    if (spotifyService.isConnected()) {
      const spotifyCmd = parseSpotifyCommand(msg);
      if (spotifyCmd) {
        try {
          const spotifyReply = await handleSpotifyCommand(spotifyCmd);
          if (spotifyReply) {
            saveConversationTurn(sid, msg, spotifyReply);
            return res.json({ reply: spotifyReply, source: 'spotify' });
          }
        } catch (spotifyError) {
          console.warn('Spotify command error:', spotifyError.message);
          const errMsg = spotifyError.response?.data?.error?.message || spotifyError.message;
          if (/premium|403/.test(String(errMsg).toLowerCase())) {
            return res.json({ reply: 'Esa funcion requiere Spotify Premium.' });
          }
          return res.json({ reply: `Error de Spotify: ${errMsg}` });
        }
      }
    }

    // ── Todo / Notes commands ──
    const todoResult = await handleTodoCommand(msg, sid);
    if (todoResult) {
      saveConversationTurn(sid, msg, todoResult);
      return res.json({ reply: todoResult, source: 'todo' });
    }

    // ── Weather commands ──
    const weatherResult = await handleWeatherCommand(msg);
    if (weatherResult) {
      saveConversationTurn(sid, msg, weatherResult);
      return res.json({ reply: weatherResult, source: 'weather' });
    }

    const memoryLimit = isCallMode ? 8 : 999;
    const callHint = isCallMode
      ? '\n\nModo llamada: responde con una sola frase corta y directa.'
      : '';
    const userTone = detectUserTone(msg);
    const toneHint = userTone === 'strong'
      ? '\n\nAjuste de tono: el usuario esta hablando con jerga fuerte mexicana. Responde con estilo mas barrio y directo, puedes usar groserias leves/contextuales. Evita lenguaje discriminatorio o de odio.'
      : '\n\nAjuste de tono: usa tono casual, claro y natural.';
    const conversationContext = loadConversationContext(sid, isCallMode ? 8 : 25);
    const selfRulesPrompt = loadSelfRulesPrompt(sid);
    const mexicoTime = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'full', timeStyle: 'short' });
    const timeHint = `\n\nFecha y hora actual en México: ${mexicoTime}.`;
    const systemPrompt = loadPersonality() + loadMemories(memoryLimit) + conversationContext + selfRulesPrompt + callHint + toneHint + timeHint;
    const useCodingModel = !hasImage && isCodingPrompt(msg);
    const defaultBase = process.env.OPENROUTER_MODEL || 'qwen/qwen3-coder:free';
    const chatModel = process.env.OPENROUTER_MODEL_CHAT || defaultBase || 'qwen/qwen3.6-plus-preview:free';
    const callModel = process.env.OPENROUTER_MODEL_CALL || chatModel;
    const codeModel = process.env.OPENROUTER_MODEL_CODE || defaultBase || 'qwen/qwen3-coder:free';
    const visionModel = process.env.OPENROUTER_MODEL_VISION || 'qwen/qwen3-vl-8b-instruct';
    const visionFallbackModel = process.env.OPENROUTER_MODEL_VISION_FALLBACK || 'qwen/qwen2.5-vl-32b-instruct';

    const chatCandidates = uniqueModels([
      chatModel,
      ...parseModelList(process.env.OPENROUTER_MODELS_CHAT),
      codeModel,
      ...parseModelList(process.env.OPENROUTER_MODELS_CODE),
      defaultBase,
    ]);
    const codeCandidates = uniqueModels([
      codeModel,
      ...parseModelList(process.env.OPENROUTER_MODELS_CODE),
      chatModel,
      ...parseModelList(process.env.OPENROUTER_MODELS_CHAT),
      defaultBase,
    ]);
    const callCandidates = uniqueModels([
      callModel,
      ...parseModelList(process.env.OPENROUTER_MODELS_CALL),
      ...chatCandidates,
    ]);
    const visionCandidates = uniqueModels([
      visionModel,
      ...parseModelList(process.env.OPENROUTER_MODELS_VISION),
      visionFallbackModel,
    ]);

    const modelCandidates = hasImage
      ? visionCandidates
      : (useCodingModel ? codeCandidates : (isCallMode ? callCandidates : chatCandidates));
    const maxTokens = isCallMode
      ? Number(process.env.OPENROUTER_MAX_TOKENS_CALL || 80)
      : Number(process.env.OPENROUTER_MAX_TOKENS_CHAT || 240);

    const internetEnabled = process.env.INTERNET_LOOKUP_ENABLED !== 'false';
    const internetLookupAlways = process.env.INTERNET_LOOKUP_ALWAYS === 'true';
    const internetLookupRequested = !hasImage
      && internetEnabled
      && (internetLookupAlways || wantsInternetLookup(msg));
    const internetMaxResults = Number(process.env.INTERNET_LOOKUP_MAX_RESULTS || 5);
    let internetContextText = '';
    let modelMessage = msg || 'Describe esta imagen con detalle.';

    if (internetLookupRequested) {
      try {
        const internetData = await internetService.gatherInternetContext(msg, {
          maxResults: internetMaxResults,
        });

        if (internetData.contextText) {
          internetContextText = `\n\nContexto de internet (datos recientes para apoyar tu respuesta):\n${internetData.contextText}\n\nReglas para usar este contexto:\n- Usa solo lo que aparezca en estas fuentes o deja claro si no hay suficiente informacion.\n- Si das datos concretos, menciona la fuente (URL).\n- No inventes enlaces ni cifras.`;
          modelMessage = `${msg}\n\nUsa la informacion de internet incluida en el prompt del sistema y cita fuentes cuando sea posible.`;
        }
      } catch (internetError) {
        console.warn(`Busqueda web fallida: ${internetError.message}`);
      }
    }

    const effectiveSystemPrompt = systemPrompt + internetContextText;

    console.log(`Modelos OpenRouter candidatos: ${modelCandidates.join(', ')}`);
    let reply;
    let lastModelError = null;
    let successfulModel = '';
    for (const modelName of modelCandidates) {
      try {
        reply = await openRouterService.chat(effectiveSystemPrompt, modelMessage, {
          model: modelName,
          maxTokens,
          temperature: isCallMode ? 0.5 : 0.7,
          imageUrl: providedImage || undefined,
        });
        successfulModel = modelName;
        break;
      } catch (modelError) {
        lastModelError = modelError;
        const msgText = String(modelError?.message || '').toLowerCase();
        const isRateOrUnavailable = /429|rate limit|temporarily rate-limited|provider returned error|unavailable|overloaded/.test(msgText);
        console.warn(`Modelo fallo (${modelName}): ${modelError.message}`);
        if (!isRateOrUnavailable) break;
      }
    }

    if (!reply) {
      if (hasImage) {
        const detail = lastModelError?.message || 'error desconocido';
        return res.json({
          reply: `No pude analizar esa imagen en este momento (${detail}). Intenta otra imagen o vuelve a intentarlo en unos segundos.`,
        });
      }
      throw (lastModelError || new Error('No fue posible obtener respuesta del modelo'));
    }

    if (successfulModel) {
      console.log(`Modelo exitoso: ${successfulModel}`);
    }

    saveConversationTurn(sid, msg, reply);

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
    console.error('Error al contactar OpenRouter:', error.message);

    const errorText = String(error?.message || '').toLowerCase();
    const isRateLimit = /429|rate limit|free-models-per-day|temporarily rate-limited/.test(errorText);
    const isSpendLimit = /402|spend limit exceeded|usd spend limit|insufficient credits|no credits/.test(errorText);
    if (isRateLimit) {
      return res.status(200).json({
        reply: 'Estoy limitado por cuota del modelo de IA en este momento. Intenta mas tarde o cambia a un modelo con credito para seguir respondiendo sin cortes.',
      });
    }

    if (isSpendLimit) {
      return res.status(200).json({
        reply: 'Tu clave de OpenRouter llego al limite de gasto configurado. Sube el limite o agrega credito en OpenRouter para que Arey vuelva a responder.',
      });
    }

    res.status(500).json({
      error: 'Error al procesar el mensaje',
      reply: 'Lo siento, hubo un error al procesar tu mensaje. Intenta de nuevo.',
    });
  }
});

// POST /api/chat/stream - SSE streaming responses
router.post('/stream', async (req, res) => {
  const { message, sessionId, mode, imageDataUrl, imageUrl } = req.body;
  const msg = (typeof message === 'string' ? message : '').trim();
  const sid = sessionId || 'default';

  if (!msg) return res.status(400).json({ error: 'Mensaje requerido' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    // Check Spotify commands first
    if (spotifyService.isConnected()) {
      const spotifyCmd = parseSpotifyCommand(msg);
      if (spotifyCmd) {
        const spotifyReply = await handleSpotifyCommand(spotifyCmd);
        if (spotifyReply) {
          saveConversationTurn(sid, msg, spotifyReply);
          res.write(`data: ${JSON.stringify({ token: spotifyReply })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
      }
    }

    // Check todo/notes/weather/calendar intents
    const todoResult = await handleTodoCommand(msg, sid);
    if (todoResult) {
      saveConversationTurn(sid, msg, todoResult);
      res.write(`data: ${JSON.stringify({ token: todoResult })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const weatherResult = await handleWeatherCommand(msg);
    if (weatherResult) {
      saveConversationTurn(sid, msg, weatherResult);
      res.write(`data: ${JSON.stringify({ token: weatherResult })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const isCallMode = mode === 'call';
    const memoryLimit = isCallMode ? 8 : 999;
    const callHint = isCallMode ? '\n\nModo llamada: responde con una sola frase corta y directa.' : '';
    const userTone = detectUserTone(msg);
    const toneHint = userTone === 'strong'
      ? '\n\nAjuste de tono: el usuario esta hablando con jerga fuerte mexicana. Responde con estilo mas barrio y directo, puedes usar groserias leves/contextuales. Evita lenguaje discriminatorio o de odio.'
      : '\n\nAjuste de tono: usa tono casual, claro y natural.';
    const conversationContext = loadConversationContext(sid, isCallMode ? 8 : 25);
    const selfRulesPrompt = loadSelfRulesPrompt(sid);
    const mexicoTime = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'full', timeStyle: 'short' });
    const timeHint = `\n\nFecha y hora actual en México: ${mexicoTime}.`;
    const systemPrompt = loadPersonality() + loadMemories(memoryLimit) + conversationContext + selfRulesPrompt + callHint + toneHint + timeHint;

    const defaultBase = process.env.OPENROUTER_MODEL || 'qwen/qwen3-coder:free';
    const chatModel = process.env.OPENROUTER_MODEL_CHAT || defaultBase;
    const modelCandidates = uniqueModels([chatModel, ...parseModelList(process.env.OPENROUTER_MODELS_CHAT), defaultBase]);

    let success = false;
    let fullReply = '';
    let lastErr = null;

    for (const modelName of modelCandidates) {
      try {
        const { body, reqOptions } = openRouterService.chatStream(systemPrompt, msg, {
          model: modelName,
          maxTokens: Number(process.env.OPENROUTER_MAX_TOKENS_CHAT || 240),
          temperature: 0.7,
        });

        await new Promise((resolve, reject) => {
          const https = require('https');
          const apiReq = https.request(reqOptions, (apiRes) => {
            if (apiRes.statusCode !== 200) {
              let errData = '';
              apiRes.on('data', c => errData += c);
              apiRes.on('end', () => reject(new Error(`HTTP ${apiRes.statusCode}: ${errData}`)));
              return;
            }
            let buffer = '';
            apiRes.on('data', (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop();
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(payload);
                  const token = parsed.choices?.[0]?.delta?.content || '';
                  if (token) {
                    fullReply += token;
                    res.write(`data: ${JSON.stringify({ token })}\n\n`);
                  }
                } catch {}
              }
            });
            apiRes.on('end', resolve);
          });
          apiReq.on('error', reject);
          apiReq.setTimeout(120000, () => apiReq.destroy(new Error('Timeout')));
          apiReq.write(body);
          apiReq.end();
        });

        success = true;
        break;
      } catch (err) {
        lastErr = err;
        const msgText = String(err?.message || '').toLowerCase();
        if (!/429|rate limit|unavailable|overloaded/.test(msgText)) break;
      }
    }

    if (!success) {
      const fallback = lastErr?.message || 'Error al obtener respuesta';
      res.write(`data: ${JSON.stringify({ token: fallback })}\n\n`);
    }

    // Clean memory tags
    const cleanReply = fullReply.replace(/\[GUARDAR:\w+:.+?\]/g, '').trim();
    const memoryPattern = /\[GUARDAR:(\w+):(.+?)\]/g;
    let match;
    while ((match = memoryPattern.exec(fullReply)) !== null) {
      saveMemory(match[1], match[2]);
    }
    if (cleanReply) saveConversationTurn(sid, msg, cleanReply);
    autoDetectMemories(msg);

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ token: 'Error: ' + err.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// GET /api/chat/history - Load conversation history for a session
router.get('/history', (req, res) => {
  const sid = req.query.sessionId || 'default';
  const db = readConversations();
  const turns = Array.isArray(db.sessions?.[sid]) ? db.sessions[sid] : [];
  res.json({ turns: turns.slice(-40) });
});

// GET /api/chat/sessions - List all session IDs with last message
router.get('/sessions', (req, res) => {
  const db = readConversations();
  const sessions = Object.entries(db.sessions || {}).map(([id, turns]) => {
    const last = Array.isArray(turns) && turns.length ? turns[turns.length - 1] : null;
    return {
      id,
      lastMessage: last?.user || '',
      lastReply: last?.assistant || '',
      lastAt: last?.at || '',
      turns: Array.isArray(turns) ? turns.length : 0,
    };
  }).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  res.json({ sessions });
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

// POST /api/chat/quick - Endpoint optimizado para asistentes de voz (Siri, Tasker, etc.)
router.post('/quick', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Falta "message"' });
  }
  const msg = message.trim();
  const sid = sessionId || 'siri-' + Date.now();

  try {
    // Spotify commands
    const spotifyCmd = parseSpotifyCommand(msg);
    if (spotifyCmd) {
      const result = await handleSpotifyCommand(spotifyCmd);
      return res.json({ reply: result });
    }

    // Todo commands
    const todoResult = await handleTodoCommand(msg, sid);
    if (todoResult) return res.json({ reply: todoResult });

    // Weather
    const weatherResult = await handleWeatherCommand(msg);
    if (weatherResult) return res.json({ reply: weatherResult });

    // Calendar quick check
    const calendarPatterns = /(?:que tengo|mi agenda|mis eventos|calendario|citas?)\s*(?:hoy|mañana|manana|esta semana)?/i;
    if (calendarPatterns.test(msg) && googleOAuthService.isConnected()) {
      try {
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + 1);
        end.setHours(23, 59, 59, 999);
        const events = await googleCalendarService.listEvents({
          timeMin: now.toISOString(),
          timeMax: end.toISOString(),
          maxResults: 5,
        });
        if (events.length) {
          const list = events.map(e => {
            const t = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : 'todo el dia';
            return `${t} - ${e.summary || 'Sin titulo'}`;
          }).join('. ');
          return res.json({ reply: 'Tus proximos eventos: ' + list });
        } else {
          return res.json({ reply: 'No tienes eventos proximos.' });
        }
      } catch {}
    }

    // General AI - with short-response instruction
    const db = readConversations();
    const turns = db.sessions?.[sid] || [];
    const recentTurns = turns.slice(-6);
    const historyMsgs = recentTurns.flatMap(t => {
      const out = [];
      if (t.user) out.push({ role: 'user', content: t.user });
      if (t.assistant) out.push({ role: 'assistant', content: t.assistant });
      return out;
    });

    const basePrompt = loadPersonality() + loadMemories(10) + loadSelfRulesPrompt(sid);
    const systemPrompt = basePrompt + '\n\nIMPORTANTE: Esta es una peticion desde un asistente de voz (Siri/Google Assistant). Responde en MAXIMO 2-3 oraciones cortas y directas. No uses markdown, asteriscos, ni formato especial. Solo texto plano hablado. Ve directo al punto sin rodeos.';

    const messages = [
      { role: 'system', content: systemPrompt },
      ...historyMsgs,
      { role: 'user', content: msg },
    ];

    const reply = await openRouterService.chat(messages);
    const clean = reply.replace(/\*+/g, '').replace(/#{1,6}\s*/g, '').replace(/`{1,3}/g, '').trim();

    // Save to conversation
    if (!db.sessions) db.sessions = {};
    if (!db.sessions[sid]) db.sessions[sid] = [];
    db.sessions[sid].push({ user: msg, assistant: clean, at: new Date().toISOString() });
    if (db.sessions[sid].length > 15) db.sessions[sid] = db.sessions[sid].slice(-15);
    writeConversations(db);

    return res.json({ reply: clean });
  } catch (err) {
    console.error('Quick endpoint error:', err.message);
    return res.json({ reply: 'Hubo un error. Intenta de nuevo.' });
  }
});

module.exports = router;
