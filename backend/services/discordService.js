const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const { Client, GatewayIntentBits, Partials, PermissionsBitField } = require('discord.js');
const selfCodingService = require('./selfCodingService');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  EndBehaviorType,
} = require('@discordjs/voice');
const FormData = require('form-data');
const OpusScript = require('opusscript');
const execAsync = util.promisify(exec);

const INTEGRATIONS_FILE = path.join(__dirname, '..', 'integrations.json');

let discordClient = null;
let isReady = false;
let loginPromise = null;
let bridgeBaseUrl = null;
let currentUsesMessageContent = false;
let lastWarning = '';

const voicePlayers = new Map();       // guildId -> AudioPlayer
const userDecoders = new Map();       // userId -> OpusScript decoder
const activeVoiceChannels = new Map(); // guildId -> textChannel (for echoing)
const userProcessing = new Map();      // userId -> boolean (rate-limit lock)
let sttBlockedUntil = 0;
const sttNoticeUntilByGuild = new Map();
const ttsNoticeUntilByGuild = new Map();
const BACKEND_ROOT = path.join(__dirname, '..');

function readIntegrations() {
  try {
    if (!fs.existsSync(INTEGRATIONS_FILE)) return {};
    return JSON.parse(fs.readFileSync(INTEGRATIONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeIntegrations(data) {
  fs.writeFileSync(INTEGRATIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function getCredentials() {
  const data = readIntegrations();
  return {
    botToken: process.env.DISCORD_BOT_TOKEN || data?.discord?.botToken || '',
    clientId: process.env.DISCORD_CLIENT_ID || data?.discord?.clientId || '',
  };
}

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getWakeWord() {
  const data = readIntegrations();
  return data?.discord?.wakeWord || 'arey';
}

function wantsMessageContent() {
  const data = readIntegrations();
  return data?.discord?.preferWakeWord !== false;
}

function getMissingDiscordCredentials() {
  const { botToken, clientId } = getCredentials();
  const missing = [];
  if (!botToken) missing.push('DISCORD_BOT_TOKEN');
  if (!clientId) missing.push('DISCORD_CLIENT_ID');
  return missing;
}

function setStoredDiscordCredentials({ botToken, clientId }) {
  const data = readIntegrations();
  data.discord = {
    ...(data.discord || {}),
    botToken: botToken || data?.discord?.botToken || '',
    clientId: clientId || data?.discord?.clientId || '',
    wakeWord: data?.discord?.wakeWord || 'arey',
    preferWakeWord: data?.discord?.preferWakeWord !== false,
    updatedAt: new Date().toISOString(),
  };
  writeIntegrations(data);
}

function isDiscordConfigured() {
  const { botToken, clientId } = getCredentials();
  return Boolean(botToken && clientId);
}

function getInviteUrl() {
  const { clientId } = getCredentials();
  if (!clientId) return '';

  const permissions = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.UseApplicationCommands,
  ]).bitfield.toString();

  const params = new URLSearchParams({
    client_id: clientId,
    permissions,
    scope: 'bot applications.commands',
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function getStatus() {
  return {
    configured: isDiscordConfigured(),
    connected: Boolean(discordClient && isReady),
    missing: getMissingDiscordCredentials(),
    inviteUrl: getInviteUrl(),
    botTag: discordClient?.user?.tag || '',
    wakeWord: getWakeWord(),
    wakeWordEnabled: currentUsesMessageContent,
    warning: lastWarning,
  };
}

async function handleIncomingDiscordMessage(message) {
  if (!bridgeBaseUrl) return;
  if (message.author.bot) return;

  const isDm = message.channel?.isDMBased?.() || message.guildId == null;
  const mentioned = message.mentions?.users?.has?.(discordClient.user.id);
  const wakeWord = getWakeWord();
  const normalizedContent = normalizeText(message.content || '').trim();
  const usesWakeWord = currentUsesMessageContent
    && !isDm
    && normalizedContent.startsWith(`${wakeWord} `);

  if (!isDm && !mentioned && !usesWakeWord) return;

  const content = isDm
    ? message.content.trim()
    : (usesWakeWord
      ? message.content.trim().slice(wakeWord.length).trim()
      : message.content.replace(new RegExp(`<@!?${discordClient.user.id}>`, 'g'), '').trim());

  const imageAttachment = message.attachments?.find?.((att) => {
    const contentType = String(att?.contentType || '').toLowerCase();
    const name = String(att?.name || '').toLowerCase();
    return contentType.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
  });
  const attachedImageUrl = imageAttachment?.url || '';

  // "arey analiza" es alias explícito para analizar imagen adjunta
  const isAnalyzeCommand = /^analiza\b/i.test(normalizeText(content));
  const effectiveContent = isAnalyzeCommand && attachedImageUrl
    ? (content.replace(/^analiza\s*/i, '').trim() || '')
    : content;

  if (!effectiveContent && !attachedImageUrl) return;

  const voiceCommandReply = handleVoiceCommand(message, effectiveContent);
  if (voiceCommandReply) {
    await message.reply(voiceCommandReply);
    return;
  }

  const maintenanceReply = await handleOwnerMaintenanceCommand(message, effectiveContent);
  if (maintenanceReply) {
    await message.reply(maintenanceReply);
    return;
  }

  const codingReply = await handleOwnerCodingCommand(message, effectiveContent);
  if (codingReply) {
    if (codingReply !== '__handled__') await message.reply(codingReply);
    return;
  }

  try {
    await message.channel.sendTyping();
    const response = await axios.post(`${bridgeBaseUrl}/api/chat`, {
      message: effectiveContent || 'Analiza la imagen y responde en espanol.',
      sessionId: `discord-${message.author.id}`,
      mode: 'chat',
      imageUrl: attachedImageUrl || undefined,
    }, {
      timeout: 180000,
    });

    const reply = response.data?.reply || 'No pude responder en este momento.';
    await message.reply(reply);

    // Si Arey esta conectada a voz en este servidor, tambien responde hablando.
    if (message.guildId && getVoiceConnection(message.guildId)) {
      try {
        await speakInVoiceChannel(message.guildId, reply);
      } catch (ttsError) {
        console.error('[voz] No pude reproducir TTS para respuesta de texto:', ttsError.message);
        const text = String(ttsError?.message || '').toLowerCase();
        const isAuthOrConfig = text.includes('401') || text.includes('403') || text.includes('sin proveedor tts');
        if (isAuthOrConfig) {
          const now = Date.now();
          const noticeUntil = ttsNoticeUntilByGuild.get(message.guildId) || 0;
          if (now > noticeUntil) {
            ttsNoticeUntilByGuild.set(message.guildId, now + 180000);
            await message.reply('No pude hablar en voz porque el proveedor TTS rechazo las credenciales. Revisa ELEVENLABS_API_KEY o activa fallback con OPENAI_API_KEY.');
          }
        }
      }
    }
  } catch (error) {
    const backendReply = error?.response?.data?.reply;
    await message.reply(backendReply || 'No pude procesar tu mensaje en Discord en este momento.');
  }
}

async function runCommandSafe(command, cwd, timeout = 180000) {
  const { stdout, stderr } = await execAsync(command, { cwd, timeout });
  return `${stdout || ''}${stderr || ''}`.trim();
}

async function handleOwnerMaintenanceCommand(message, content) {
  const normalized = normalizeText(content);
  const asksUpdate = /^(actualiza|actualizar|update)\b.*(codigo|code|bot)?/.test(normalized);
  const asksRestart = /^(reinicia|restart)\b/.test(normalized);
  if (!asksUpdate && !asksRestart) return null;

  const ownerId = String(process.env.DISCORD_OWNER_ID || '').trim();
  if (!ownerId) {
    return 'No tengo configurado el owner para mantenimiento. Define DISCORD_OWNER_ID en .env.';
  }

  if (String(message.author?.id || '') !== ownerId) {
    return 'Solo el owner puede ejecutar mantenimiento de codigo.';
  }

  try {
    if (asksRestart && !asksUpdate) {
      await runCommandSafe('pm2 restart arey-backend --update-env', BACKEND_ROOT, 120000);
      return 'Listo, reinicie el backend.';
    }

    const pullOut = await runCommandSafe('git pull --rebase', BACKEND_ROOT, 180000);
    const installOut = await runCommandSafe('npm install', BACKEND_ROOT, 240000);
    const restartOut = await runCommandSafe('pm2 restart arey-backend --update-env', BACKEND_ROOT, 120000);

    const summary = [pullOut, installOut, restartOut]
      .filter(Boolean)
      .join('\n')
      .replace(/\s+/g, ' ')
      .slice(0, 500);

    return `Actualizacion aplicada. Resumen: ${summary || 'ok'}`;
  } catch (error) {
    const detail = String(error?.message || 'error desconocido').slice(0, 220);
    return `No pude actualizar codigo: ${detail}`;
  }
}

async function handleOwnerCodingCommand(message, content) {
  const normalized = normalizeText(content);

  // Detect code modification requests
  const codingPatterns = [
    /(?:modifica|cambia|edita|actualiza|agrega|anade|quita|elimina|reprograma|programa).*(?:tu\s*)?(?:codigo|code|programacion|fuente|script)/,
    /(?:programa(?:te)?|codea(?:te)?|hazte)\s+(?:para|que|un|una)/,
    /(?:agrega(?:te)?|anade(?:te)?|implementa(?:te)?|crea(?:te)?)\s+(?:la\s+)?(?:funcion|funcionalidad|feature|capacidad|habilidad|opcion)/,
    /(?:tu\s*misma?\s+)?(?:modifica|cambia|arregla|corrige).*(?:tu\s+)?(?:archivo|code|codigo)/,
    /(?:self[- ]?(?:code|modify|program|edit))/,
    /(?:hazlo?\s+en\s+tu\s+codigo)/,
    /(?:cambia(?:te)?|modifica(?:te)?)\s+(?:para|a\s+ti\s+misma)/,
  ];

  const isCodingRequest = codingPatterns.some(rx => rx.test(normalized));
  if (!isCodingRequest) return null;

  const ownerId = String(process.env.DISCORD_OWNER_ID || '').trim();
  if (!ownerId) {
    return 'No tengo configurado DISCORD_OWNER_ID. Sin eso no puedo modificar mi codigo.';
  }
  if (String(message.author?.id || '') !== ownerId) {
    return 'Solo mi owner puede pedirme que modifique mi propio codigo.';
  }

  try {
    await message.channel.sendTyping();
    await message.reply('Analizando tu peticion y planeando los cambios...');

    const result = await selfCodingService.executeCodeChange(content);

    const filesChanged = result.modifiedFiles.map(f => `\`${f}\``).join(', ');
    const reply = `Listo! Modifique mi codigo.\n**Cambios:** ${result.summary}\n**Archivos:** ${filesChanged}\n**Backups creados:** ${result.backups.length}\nReiniciando...`;
    await message.reply(reply);

    // Auto-restart after a short delay
    setTimeout(async () => {
      try {
        await runCommandSafe('pm2 restart arey-backend --update-env', BACKEND_ROOT, 120000);
      } catch {
        console.log('[self-coding] pm2 no disponible, reiniciando con process.exit...');
        process.exit(0);
      }
    }, 2000);

    return '__handled__';
  } catch (error) {
    const detail = String(error?.message || 'error desconocido').slice(0, 400);
    return `No pude modificar mi codigo: ${detail}`;
  }
}

function handleVoiceCommand(message, content) {
  const normalized = normalizeText(content);
  const asksJoinVoice = /(unete|unete|conectate|entra|join|metete).*(voz|canal de voz)|ven al canal de voz/.test(normalized);
  const asksLeaveVoice = /(sal|salte|desconectate|desconecta|leave).*(voz|canal de voz)/.test(normalized);

  if (!asksJoinVoice && !asksLeaveVoice) return null;

  if (!message.guild) {
    return 'Para controlar voz necesito que me escribas desde un servidor (no por DM).';
  }

  if (asksLeaveVoice) {
    const existing = getVoiceConnection(message.guild.id);
    if (!existing) return 'No estoy conectado a ningun canal de voz ahora mismo.';
    existing.destroy();
    voicePlayers.delete(message.guild.id);
    activeVoiceChannels.delete(message.guild.id);
    return 'Listo, sali del canal de voz.';
  }

  const memberVoiceChannel = message.member?.voice?.channel;
  if (!memberVoiceChannel) {
    return 'Primero unete tu a un canal de voz y luego me dices que entre.';
  }

  try {
    const existing = getVoiceConnection(message.guild.id);
    if (existing) existing.destroy();

    const connection = joinVoiceChannel({
      channelId: memberVoiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    setupVoiceReceiver(connection, message.guild, message.channel);
    return `Listo, ya me uni a **${memberVoiceChannel.name}**. Ya te escucho y te respondo por mensaje.`;
  } catch (error) {
    return `No pude unirme al canal de voz: ${error.message}`;
  }
}

// ─── Voice pipeline helpers ──────────────────────────────────────────────────

function setupVoiceReceiver(connection, guild, textChannel) {
  let player = voicePlayers.get(guild.id);
  if (!player) {
    player = createAudioPlayer();
    voicePlayers.set(guild.id, player);
  }
  connection.subscribe(player);

  if (textChannel) {
    activeVoiceChannels.set(guild.id, textChannel);
  }

  connection.receiver.speaking.on('start', (userId) => {
    // Si ya estamos procesando audio de este usuario, ignorar
    if (userProcessing.get(userId)) return;
    userProcessing.set(userId, true);  // bloquear inmediatamente

    console.log(`[voz] speaking start: userId=${userId}`);

    if (!userDecoders.has(userId)) {
      userDecoders.set(userId, new OpusScript(48000, 2, OpusScript.Application.AUDIO));
    }
    const decoder = userDecoders.get(userId);
    const pcmChunks = [];
    let rawChunkCount = 0;

    const audioStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
    });

    audioStream.on('data', (chunk) => {
      rawChunkCount++;
      try {
        const pcm = decoder.decode(chunk, chunk.length);
        pcmChunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      } catch (e) {
        console.warn('[voz] decode error:', e.message);
      }
    });

    audioStream.on('end', async () => {
      console.log(`[voz] speaking end: rawChunks=${rawChunkCount} pcmChunks=${pcmChunks.length}`);
      if (pcmChunks.length < 3) {
        setTimeout(() => userProcessing.delete(userId), 1000);
        return;
      }

      try {
        const wavBuffer = buildWavBuffer(pcmChunks);
        console.log(`[voz] WAV size: ${wavBuffer.length} bytes`);

        const transcript = await transcribeAudio(wavBuffer);
        console.log(`[voz] transcript: "${transcript}"`);
        const transcriptText = (transcript || '').trim();
        if (transcriptText.length < 2) return;

        const wakeWord = getWakeWord();
        const normalizedTranscript = normalizeText(transcriptText);
        const startsWithWakeWord = normalizedTranscript === wakeWord
          || normalizedTranscript.startsWith(`${wakeWord} `);

        // En modo voz, solo responder cuando la frase inicia con la palabra clave.
        if (!startsWithWakeWord) return;

        const wakeWordRegex = new RegExp(`^${wakeWord}\\s+`, 'i');
        const voiceCommandText = transcriptText.replace(wakeWordRegex, '').trim();
        if (!voiceCommandText) return;

        const ch = activeVoiceChannels.get(guild.id);
        if (ch) ch.send(`🎤 **"${voiceCommandText}"**`).catch(() => {});

        const aiReply = await getAiVoiceResponse(voiceCommandText, `discord-voice-${userId}`);
        console.log(`[voz] aiReply: "${aiReply}"`);
        if (!aiReply) return;

        if (ch) ch.send(`🤖 ${aiReply}`).catch(() => {});
        await speakInVoiceChannel(guild.id, aiReply, player);
      } catch (err) {
        console.error('[voz] pipeline error:', err.message, err.stack);
        const ch = activeVoiceChannels.get(guild.id);
        const isRateLimit = String(err?.message || '').toLowerCase().includes('429')
          || String(err?.message || '').toLowerCase().includes('stt temporalmente limitado')
          || String(err?.message || '').toLowerCase().includes('enfriando');

        if (isRateLimit && ch) {
          const now = Date.now();
          const noticeUntil = sttNoticeUntilByGuild.get(guild.id) || 0;
          if (now > noticeUntil) {
            sttNoticeUntilByGuild.set(guild.id, now + 120000);
            ch.send('Estoy un poco saturada con voz ahora mismo. Intenta de nuevo en unos 2 minutos.').catch(() => {});
          }
        }
      } finally {
        // Liberar el lock después de 3s para evitar spam
        setTimeout(() => userProcessing.delete(userId), 3000);
      }
    });
  });
}

function buildWavBuffer(pcmChunks) {
  const pcmData = Buffer.concat(pcmChunks);
  const numChannels = 2;
  const sampleRate = 48000;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 26);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

async function transcribeAudio(wavBuffer) {
  if (Date.now() < sttBlockedUntil) {
    const remainingSec = Math.ceil((sttBlockedUntil - Date.now()) / 1000);
    throw new Error(`STT temporalmente limitado. Intenta de nuevo en ${remainingSec}s.`);
  }

  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) {
    console.warn('[voz] Sin OPENAI_API_KEY, no se puede transcribir.');
    return null;
  }

  const form = new FormData();
  form.append('file', wavBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('model', 'whisper-1');
  form.append('language', 'es');

  let response;
  try {
    response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${openAiKey}` },
        timeout: 30000,
      },
    );
  } catch (error) {
    const status = error?.response?.status;
    if (status === 429) {
      sttBlockedUntil = Date.now() + 120000;
      throw new Error('OpenAI STT devolvio 429 (limite). Enfriando 120s.');
    }
    throw error;
  }

  return response.data?.text || null;
}

async function getAiVoiceResponse(text, sessionId) {
  const response = await axios.post(
    `${bridgeBaseUrl}/api/chat`,
    { message: text, sessionId, mode: 'chat' },
    { timeout: 60000 },
  );
  return response.data?.reply || null;
}

async function speakInVoiceChannel(guildId, text, player) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return;

  let p = player || voicePlayers.get(guildId);
  if (!p) {
    const connection = getVoiceConnection(guildId);
    if (!connection) return;
    p = createAudioPlayer();
    voicePlayers.set(guildId, p);
    connection.subscribe(p);
  }
  if (!p) return;

  let audioStream = null;
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (elevenLabsKey && voiceId) {
    try {
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          text: cleanText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        },
        {
          headers: {
            'xi-api-key': elevenLabsKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          responseType: 'stream',
          timeout: 30000,
        },
      );

      audioStream = response.data;
    } catch (error) {
      const status = error?.response?.status;
      console.error(`[voz] ElevenLabs TTS fallo${status ? ` (${status})` : ''}: ${error.message}`);
    }
  }

  if (!audioStream && process.env.OPENAI_API_KEY) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/audio/speech',
        {
          model: process.env.OPENAI_TTS_MODEL || 'tts-1',
          voice: process.env.OPENAI_TTS_VOICE || 'alloy',
          input: cleanText.slice(0, 3500),
          format: process.env.OPENAI_TTS_FORMAT || 'mp3',
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
          timeout: 30000,
        },
      );

      audioStream = response.data;
    } catch (error) {
      const status = error?.response?.status;
      console.error(`[voz] OpenAI TTS fallback fallo${status ? ` (${status})` : ''}: ${error.message}`);
    }
  }

  if (!audioStream) {
    throw new Error('Sin proveedor TTS disponible o credenciales invalidas (ElevenLabs/OpenAI).');
  }

  const resource = createAudioResource(audioStream, { inputType: StreamType.Arbitrary });
  p.play(resource);
}

// ─────────────────────────────────────────────────────────────────────────────

function createClient(useMessageContent) {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ];

  if (useMessageContent) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  const client = new Client({
    intents,
    partials: [Partials.Channel],
  });

  client.once('clientReady', () => {
    isReady = true;
    console.log(`Discord conectado como ${client.user.tag}`);
  });

  client.on('messageCreate', (message) => {
    handleIncomingDiscordMessage(message);
  });

  client.on('error', (error) => {
    console.error('Discord client error:', error.message);
  });

  return client;
}

async function connectDiscord(baseUrl) {
  const { botToken } = getCredentials();
  if (!botToken) {
    throw new Error('Falta DISCORD_BOT_TOKEN');
  }

  bridgeBaseUrl = baseUrl || bridgeBaseUrl;

  if (discordClient && isReady) {
    return getStatus();
  }

  if (loginPromise) {
    await loginPromise;
    return getStatus();
  }

  const preferredUseMessageContent = wantsMessageContent();

  async function attemptLogin(useMessageContent) {
    discordClient = createClient(useMessageContent);
    isReady = false;
    currentUsesMessageContent = useMessageContent;
    await discordClient.login(botToken);
    return getStatus();
  }

  loginPromise = attemptLogin(preferredUseMessageContent)
    .then((status) => {
      lastWarning = preferredUseMessageContent
        ? ''
        : 'Discord conectado sin palabra clave; usa DM o mencion.';
      loginPromise = null;
      return status;
    })
    .catch(async (error) => {
      if (preferredUseMessageContent && String(error.message || '').toLowerCase().includes('disallowed intents')) {
        lastWarning = 'Activa Message Content Intent en Discord Developer Portal para usar la palabra clave "arey" en grupos. Mientras tanto, usa DM o mencion.';
        try {
          if (discordClient) {
            discordClient.removeAllListeners();
            discordClient.destroy();
          }
        } catch {}

        try {
          const status = await attemptLogin(false);
          loginPromise = null;
          return status;
        } catch (fallbackError) {
          loginPromise = null;
          discordClient = null;
          isReady = false;
          currentUsesMessageContent = false;
          throw fallbackError;
        }
      }

      loginPromise = null;
      discordClient = null;
      isReady = false;
      currentUsesMessageContent = false;
      throw error;
    });

  return loginPromise;
}

async function initDiscord(baseUrl) {
  bridgeBaseUrl = baseUrl;
  const { botToken, clientId } = getCredentials();
  console.log(`[discord] initDiscord llamado. baseUrl=${baseUrl}`);
  console.log(`[discord] botToken presente: ${Boolean(botToken)} (${(botToken || '').length} chars)`);
  console.log(`[discord] clientId presente: ${Boolean(clientId)} (${clientId || 'vacio'})`);
  console.log(`[discord] isDiscordConfigured: ${isDiscordConfigured()}`);
  if (isDiscordConfigured()) {
    try {
      console.log('[discord] Intentando conectar a Discord...');
      await connectDiscord(baseUrl);
      console.log('[discord] Discord conectado exitosamente!');
    } catch (error) {
      console.error('[discord] No se pudo iniciar Discord automaticamente:', error.message);
    }
  } else {
    console.log('[discord] Discord NO configurado - falta botToken o clientId');
  }
}

module.exports = {
  setStoredDiscordCredentials,
  getMissingDiscordCredentials,
  isDiscordConfigured,
  getInviteUrl,
  getStatus,
  connectDiscord,
  initDiscord,
};
