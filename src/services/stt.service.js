const WebSocket = require('ws');
const logger = require('../utils/logger');

/**
 * Create a streaming Deepgram connection for real-time speech-to-text
 * Returns a WebSocket that accepts audio chunks and emits transcription events
 */
function createStreamingConnection(language, callbacks = {}) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY not configured');

  const dgLang = getDeepgramLanguage(language);

  const ws = new WebSocket(
    `wss://api.deepgram.com/v1/listen?` +
    `model=nova-2&` +
    `language=${dgLang}&` +
    `encoding=mulaw&` +     // Twilio sends mulaw
    `sample_rate=8000&` +   // Twilio sends 8kHz
    `channels=1&` +
    `punctuate=true&` +
    `interim_results=true&` + // Get partial results for faster processing
    `endpointing=300&` +    // 300ms silence = end of speech
    `utterance_end_ms=1000`, // 1s silence = definitely done
    {
      headers: { Authorization: `Token ${apiKey}` }
    }
  );

  ws.on('open', () => {
    logger.debug('Deepgram connection opened');
    if (callbacks.onOpen) callbacks.onOpen();
  });

  ws.on('message', (data) => {
    try {
      const response = JSON.parse(data);

      if (response.type === 'Results') {
        const transcript = response.channel?.alternatives?.[0]?.transcript || '';
        const isFinal = response.is_final;
        const speechFinal = response.speech_final;

        if (transcript) {
          if (isFinal && callbacks.onTranscript) {
            callbacks.onTranscript(transcript, speechFinal);
          } else if (!isFinal && callbacks.onInterim) {
            callbacks.onInterim(transcript);
          }
        }
      }

      // Utterance end = user has definitely stopped speaking
      if (response.type === 'UtteranceEnd') {
        if (callbacks.onUtteranceEnd) callbacks.onUtteranceEnd();
      }
    } catch (err) {
      logger.error(`Deepgram parse error: ${err.message}`);
    }
  });

  ws.on('error', (err) => {
    logger.error(`Deepgram error: ${err.message}`);
    if (callbacks.onError) callbacks.onError(err);
  });

  ws.on('close', () => {
    logger.debug('Deepgram connection closed');
    if (callbacks.onClose) callbacks.onClose();
  });

  return {
    ws,
    sendAudio(audioBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(audioBuffer);
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
        ws.close();
      }
    }
  };
}

function getDeepgramLanguage(lang) {
  const map = { es: 'es', en: 'en-US', it: 'it', fr: 'fr', de: 'de', pt: 'pt-BR' };
  return map[lang] || 'en-US';
}

module.exports = { createStreamingConnection };
