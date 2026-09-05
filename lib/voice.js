// Voice cloning via Cartesia: clone whoever just spoke, speak the translation
// back in their voice, then discard the clone. Falls back to stock TTS when
// the key is missing or the call fails.

const BASE = "https://api.cartesia.ai";
const VERSION = "2024-11-13";

// Cartesia language codes for the targets offered in the picker.
const LANG_IDS = {
  English: "en",
  Portuguese: "pt",
  Spanish: "es",
  French: "fr",
  German: "de",
  Italian: "it",
  Japanese: "ja",
  Korean: "ko",
  "Mandarin Chinese": "zh",
  Hindi: "hi",
  Hebrew: "he",
  Russian: "ru",
  Dutch: "nl",
  Turkish: "tr",
  Polish: "pl",
};

export function cloningEnabled() {
  return Boolean(process.env.CARTESIA_API_KEY);
}

export function cloneLanguageId(targetLang) {
  return LANG_IDS[targetLang] || null;
}

/** Map a Whisper language name ("portuguese") to a Cartesia code ("pt"). */
export function sourceLanguageId(detectedName) {
  if (!detectedName) return "en";
  const key = Object.keys(LANG_IDS).find(
    (k) => k.toLowerCase() === detectedName.toLowerCase()
  );
  return key ? LANG_IDS[key] : "en";
}

function headers(extra = {}) {
  return {
    "X-API-Key": process.env.CARTESIA_API_KEY,
    "Cartesia-Version": VERSION,
    ...extra,
  };
}

async function cloneVoice(audioBuffer, filename, sourceLangCode) {
  const form = new FormData();
  form.append("clip", new Blob([audioBuffer]), filename || "clip.webm");
  form.append("name", `turn-${Date.now()}`);
  form.append("description", "Ephemeral clone for one interpreter turn");
  form.append("mode", "similarity");
  form.append("enhance", "true");
  // Cartesia rejects a clone without the language actually spoken in the clip.
  form.append("language", sourceLangCode || "en");

  const res = await fetch(`${BASE}/voices/clone`, {
    method: "POST",
    headers: headers(),
    body: form,
  });
  if (!res.ok) throw new Error(`clone ${res.status}: ${await res.text()}`);
  return (await res.json()).id;
}

async function speakAs(voiceId, text, languageId) {
  const res = await fetch(`${BASE}/tts/bytes`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model_id: "sonic-3",
      transcript: text,
      voice: { mode: "id", id: voiceId },
      language: languageId,
      output_format: {
        container: "mp3",
        bit_rate: 128000,
        sample_rate: 44100,
      },
    }),
  });
  if (!res.ok) throw new Error(`tts ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Best effort: a leftover voice costs nothing but clutters the account.
async function deleteVoice(voiceId) {
  try {
    await fetch(`${BASE}/voices/${voiceId}`, {
      method: "DELETE",
      headers: headers(),
    });
  } catch {}
}

/** Speak with an already-cloned voice. ~1s, versus ~6s to clone first. */
export async function speakWithVoice({ voiceId, text, languageId }) {
  return speakAs(voiceId, text, languageId);
}

/** Discard a cached voice once the caller is done with it. */
export async function releaseVoice(voiceId) {
  // Awaited so /api/release does not resolve before the delete is issued.
  if (voiceId) await deleteVoice(voiceId);
}

/**
 * Clone the speaker and speak the translation in their voice.
 * Returns the audio plus the voice id, so the caller can reuse it for
 * later turns or re-translations instead of paying the clone cost again.
 */
export async function speakInSpeakersVoice({
  audioBuffer,
  filename,
  text,
  languageId,
  sourceLangCode,
}) {
  const voiceId = await cloneVoice(audioBuffer, filename, sourceLangCode);
  const audio = await speakAs(voiceId, text, languageId);
  return { audio, voiceId };
}
