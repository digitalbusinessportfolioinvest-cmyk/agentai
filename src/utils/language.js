/**
 * Conversation language resolution for voice/WhatsApp.
 * Precedence: Agent.languageOverride → PhoneNumber.language → fallback es.
 */

const ALLOWED = ['es', 'en', 'it', 'fr', 'de', 'pt'];

function normalizeLang(code, fallback = 'es') {
  const two = String(code || '')
    .trim()
    .toLowerCase()
    .slice(0, 2);
  if (ALLOWED.includes(two)) return two;
  return fallback;
}

/** Empty / invalid → null (inherit phone number setting). */
function normalizeLanguageOverride(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const two = String(raw).trim().toLowerCase().slice(0, 2);
  if (!ALLOWED.includes(two)) return null;
  return two;
}

function resolveConversationLanguage(agent, phoneNumber, fallback = 'es') {
  if (agent?.languageOverride) {
    return normalizeLang(agent.languageOverride, fallback);
  }
  return normalizeLang(phoneNumber?.language || fallback, fallback);
}

module.exports = {
  ALLOWED_CONVERSATION_LANGS: ALLOWED,
  normalizeLang,
  normalizeLanguageOverride,
  resolveConversationLanguage
};
