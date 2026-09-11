// Gemini fallback for languages Whisper cannot transcribe (Xitsonga, siSwati,
// and other low-resource languages). Whisper stays the default: it is faster
// and better on the languages it does support.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = "gemini-flash-latest";

export function geminiEnabled() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Whisper reports a language and a confidence per segment. When it is
 * confident, trust it. When the audio is clearly speech but the transcript
 * scores poorly, it is usually a language Whisper does not know.
 */
export function looksUnrecognised(transcription) {
  const segments = transcription.segments || [];
  if (!segments.length) return false;
  const avg =
    segments.reduce((a, s) => a + (s.avg_logprob ?? 0), 0) / segments.length;
  // -0.6 and below is where Whisper starts inventing phonetic spellings.
  return avg < -0.6;
}

/**
 * Transcribe and translate in one call. Returns null on any failure so the
 * caller can fall back to whatever Whisper produced.
 */
export async function transcribeWithGemini({
  audioBuffer,
  mimeType,
  targetLang,
}) {
  const prompt =
    `This is speech, possibly in a low-resource language such as Xitsonga, ` +
    `siSwati, isiZulu, Afrikaans or another South African language. ` +
    `Identify the language, transcribe exactly what is said, then translate ` +
    `it into ${targetLang}.\n` +
    `Reply as strict JSON, nothing else:\n` +
    `{"language":"<name in English>","transcript":"<exact words>","translation":"<${targetLang}>"}`;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: mimeType || "audio/mpeg",
              data: audioBuffer.toString("base64"),
            },
          },
        ],
      },
    ],
    generationConfig: { temperature: 0 },
  };

  // The free tier returns 503 under load often enough that one try is not
  // enough, and a transient 404 shows up on large payloads too.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(
        `${BASE}/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const text = (data?.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text)
          .filter(Boolean)
          .join("");
        if (!text) return null;
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]);
        if (!parsed.transcript?.trim()) return null;
        return {
          language: parsed.language || null,
          transcript: parsed.transcript.trim(),
          translation: (parsed.translation || "").trim(),
        };
      }
      if (res.status === 429) {
        // Free tier allows 20 requests/minute; a short retry will not help.
        return null;
      }
      if (res.status !== 503 && res.status !== 404) {
        return null; // a real error, not congestion
      }
    } catch {
      /* network hiccup: retry */
    }
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  return null;
}
