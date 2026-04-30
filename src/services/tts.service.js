const logger = require('../utils/logger');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

// Default voice IDs (multilingual v2 voices)
const DEFAULT_VOICES = {
  es: { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily' },
  en: { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
  it: { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily' },
  fr: { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily' },
  de: { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily' },
  pt: { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily' },
};

const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

/**
 * Synthesize text to audio (non-streaming).
 *
 * @param text     Text to synthesize
 * @param voiceId  ElevenLabs voice ID
 * @param apiKey   Optional override (per-user API key); defaults to env var
 * @param format   Output format. Default 'ulaw_8000' so the result can be sent
 *                 directly into Twilio Media Streams. Use 'mp3_44100_128' for
 *                 generic playback (e.g. previewing a voice in the dashboard).
 * @returns Buffer of audio bytes in the requested format
 */
async function synthesize(text, voiceId, apiKey, format = 'ulaw_8000') {
  const key = apiKey || process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY not configured');

  const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}?output_format=${encodeURIComponent(format)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': key,
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: VOICE_SETTINGS,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs error: ${response.status} ${err}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Streaming TTS — returns a ReadableStream of audio chunks in ulaw_8000
 * (Twilio's native phone-call format). Audio starts arriving before the
 * full text is processed, which is the heart of Layer 3 audio streaming.
 */
async function synthesizeStream(text, voiceId, apiKey) {
  const key = apiKey || process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY not configured');

  const response = await fetch(`${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': key,
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: VOICE_SETTINGS,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs stream error: ${response.status} ${err}`);
  }

  return response.body;
}

/**
 * Stream TTS directly to a Twilio Media Stream WebSocket.
 * Forwards ElevenLabs ulaw_8000 audio chunks as Twilio media events as soon
 * as they arrive — this is real audio streaming, not a buffer-then-send.
 */
async function streamToTwilio(text, voiceId, twilioWs, streamSid, apiKey) {
  try {
    const audioStream = await synthesizeStream(text, voiceId, apiKey);
    const reader = audioStream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (twilioWs.readyState === 1) {
        const payload = Buffer.from(value).toString('base64');
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload }
        }));
      }
    }

    if (twilioWs.readyState === 1) {
      twilioWs.send(JSON.stringify({
        event: 'mark',
        streamSid,
        mark: { name: 'speech_end' }
      }));
    }
  } catch (err) {
    logger.error(`TTS stream to Twilio error: ${err.message}`);
  }
}

function getDefaultVoice(language) {
  return DEFAULT_VOICES[language] || DEFAULT_VOICES.en;
}

module.exports = { synthesize, synthesizeStream, streamToTwilio, getDefaultVoice, DEFAULT_VOICES };
