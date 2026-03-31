const axios = require('axios');

class ElevenLabsService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.voiceId = process.env.ELEVENLABS_VOICE_ID || 'XrExE9yKIg1WjnnlVkGX'; // Default: Matilda
    this.modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
    this.baseURL = 'https://api.elevenlabs.io/v1';
  }

  async textToSpeech(text) {
    const response = await axios.post(
      `${this.baseURL}/text-to-speech/${encodeURIComponent(this.voiceId)}`,
      {
        text,
        model_id: this.modelId,
        language_code: 'es',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.9,
          style: 0.3,
        },
      },
      {
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
      }
    );

    return Buffer.from(response.data);
  }
}

module.exports = new ElevenLabsService();
