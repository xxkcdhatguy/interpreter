import OpenAI from "openai";
import {
  cloneLanguageId,
  cloningEnabled,
  speakWithVoice,
} from "../../../lib/voice";

// Constructed lazily: instantiating at module scope makes the build fail,
// since Next evaluates route modules before env vars are available.
let _openai;
function openaiClient() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

// Portuguese means Brazilian Portuguese in this app.
function promptLanguage(name) {
  if (name === "Portuguese") return "Brazilian Portuguese (pt-BR)";
  if (name === "Austrian German") return "German as spoken in Austria";
  return name;
}

/**
 * Re-translate an existing turn into another language, without re-recording.
 * Reuses the cloned voice from the original turn when one is supplied.
 */
export async function POST(request) {
  let sourceText;
  let targetLang;
  let voiceId = null;

  try {
    const body = await request.json();
    sourceText = (body.sourceText || "").trim();
    targetLang = body.target || "English";
    voiceId = body.voiceId || null;
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!sourceText) {
    return Response.json({ error: "Nothing to translate." }, { status: 400 });
  }

  try {
    const completion = await openaiClient().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            `You are a live conversation interpreter. Translate the user's message into ${promptLanguage(targetLang)}. ` +
            `Output ONLY the translation, with no quotes, no commentary, no romanization. ` +
            `Keep the speaker's tone and register. Preserve names, numbers and units exactly. ` +
            `If the text is already in ${promptLanguage(targetLang)}, return it unchanged.`,
        },
        { role: "user", content: sourceText },
      ],
    });
    const translated =
      completion.choices[0]?.message?.content?.trim() || sourceText;

    const languageId = cloneLanguageId(targetLang);
    let speechBuffer;
    let voiceMode = "stock";
    let mime = "audio/mp3";

    if (voiceId && cloningEnabled() && languageId) {
      try {
        speechBuffer = await speakWithVoice({
          voiceId,
          text: translated,
          languageId,
        });
        voiceMode = "cloned";
      } catch (err) {
        console.warn("reuse failed, using stock voice:", err.message);
      }
    }

    if (!speechBuffer) {
      const speech = await openaiClient().audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: translated,
        response_format: "mp3",
      });
      speechBuffer = Buffer.from(await speech.arrayBuffer());
    }

    return Response.json({
      translated,
      voiceMode,
      audio: `data:${mime};base64,${speechBuffer.toString("base64")}`,
    });
  } catch (err) {
    const message = err?.error?.message || err?.message || "Translation failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
