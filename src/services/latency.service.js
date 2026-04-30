const logger = require('../utils/logger');

// Pre-defined filler phrases per language
// These are sent INSTANTLY while the LLM processes the real answer
const FILLERS = {
  es: [
    'Mmm, veamos...',
    'Claro...',
    'Entendido...',
    'Perfecto...',
    'Un momento...',
    'Déjame ver...',
  ],
  en: [
    'Mmm, let me see...',
    'Sure...',
    'Got it...',
    'Right...',
    'One moment...',
    'Let me check...',
  ],
  it: ['Vediamo...', 'Certo...', 'Un momento...', 'Capito...'],
  fr: ['Voyons...', 'Bien sûr...', 'Un moment...', 'Compris...'],
  de: ['Mal sehen...', 'Natürlich...', 'Einen Moment...', 'Verstanden...'],
  pt: ['Vamos ver...', 'Claro...', 'Um momento...', 'Entendido...'],
};

// Contextual fillers based on what just happened
const CONTEXTUAL_FILLERS = {
  es: {
    first_response: '¡Hola! Gracias por llamar.',
    data_received: 'Perfecto, lo tengo.',
    question_asked: 'Buena pregunta, veamos...',
    almost_done: 'Ya casi terminamos...',
    thinking: 'Déjame anotar eso...',
  },
  en: {
    first_response: 'Hi there! Thanks for calling.',
    data_received: 'Perfect, got it.',
    question_asked: 'Good question, let me see...',
    almost_done: 'Almost done...',
    thinking: 'Let me note that down...',
  },
};

let fillerIndex = {};

/**
 * Get a filler phrase for the given language
 * Rotates through available fillers to avoid repetition
 */
function getFiller(language, context) {
  // Try contextual filler first
  if (context) {
    const contextFillers = CONTEXTUAL_FILLERS[language] || CONTEXTUAL_FILLERS.en;
    if (contextFillers[context]) return contextFillers[context];
  }

  const fillers = FILLERS[language] || FILLERS.en;
  if (!fillerIndex[language]) fillerIndex[language] = 0;
  const filler = fillers[fillerIndex[language] % fillers.length];
  fillerIndex[language]++;
  return filler;
}

/**
 * Audio cache for pre-generated common phrases
 * In production, these would be actual audio files stored on disk
 * For now, we track what should be cached and generate on first use
 */
const audioCache = new Map();

function getCachedAudio(key) {
  return audioCache.get(key) || null;
}

function setCachedAudio(key, audioBuffer) {
  audioCache.set(key, audioBuffer);
}

function hasCachedAudio(key) {
  return audioCache.has(key);
}

/**
 * Pre-generate common phrases for an agent's voice.
 * Audio is requested in ulaw_8000 so it can be sent directly to Twilio Media
 * Streams without re-encoding. Call this when an agent is created or its voice
 * is changed; otherwise the cache populates lazily on first use.
 */
async function pregenerateCommonPhrases(voiceId, language, ttsService) {
  if (!ttsService || !voiceId) return;

  const phrases = FILLERS[language] || FILLERS.en;
  const contextPhrases = CONTEXTUAL_FILLERS[language] || CONTEXTUAL_FILLERS.en;
  const allPhrases = [...phrases, ...Object.values(contextPhrases)];

  logger.info(`Pre-generating ${allPhrases.length} audio phrases for voice ${voiceId}`);

  for (const phrase of allPhrases) {
    const cacheKey = `${voiceId}:${phrase}`;
    if (!hasCachedAudio(cacheKey)) {
      try {
        // ulaw_8000 = native Twilio phone format; can be sent without re-encoding
        const audio = await ttsService.synthesize(phrase, voiceId, null, 'ulaw_8000');
        setCachedAudio(cacheKey, audio);
      } catch (err) {
        logger.warn(`Failed to cache phrase "${phrase}": ${err.message}`);
      }
    }
  }

  logger.info(`Audio cache ready: ${audioCache.size} phrases cached`);
}

module.exports = {
  getFiller,
  getCachedAudio,
  setCachedAudio,
  hasCachedAudio,
  pregenerateCommonPhrases,
  FILLERS,
  CONTEXTUAL_FILLERS
};
