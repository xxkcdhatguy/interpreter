import OpenAI from "openai";
import {
  cloneLanguageId,
  cloningEnabled,
  speakWithVoice,
} from "../../../lib/voice";

let _openai;
function openaiClient() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const MAX_CHARS = 600;

/**
 * Speak typed text verbatim — no translation. Uses a saved cloned voice when
 * one is supplied, otherwise the stock voice.
 */
export async function POST(request) {
  let text;
  let language;
  let voiceId = null;

  try {
    const body = await request.json();
    text = (body.text || "").trim();
    language = body.language || "English";
    voiceId = body.voiceId || null;
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!text) {
    return Response.json({ error: "Type something first." }, { status: 400 });
  }
  if (text.length > MAX_CHARS) {
    return Response.json(
      { error: `Keep it under ${MAX_CHARS} characters.` },
      { status: 413 }
    );
  }

  try {
    const languageId = cloneLanguageId(language);
    let speechBuffer;
    let voiceMode = "stock";

    if (voiceId && cloningEnabled() && languageId) {
      try {
        speechBuffer = await speakWithVoice({ voiceId, text, languageId });
        voiceMode = "cloned";
      } catch (err) {
        console.warn("cloned voice failed, using stock:", err.message);
      }
    }

    if (!speechBuffer) {
      const speech = await openaiClient().audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: text,
        response_format: "mp3",
      });
      speechBuffer = Buffer.from(await speech.arrayBuffer());
    }

    return Response.json({
      text,
      voiceMode,
      audio: `data:audio/mp3;base64,${speechBuffer.toString("base64")}`,
    });
  } catch (err) {
    const message = err?.error?.message || err?.message || "Speech failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
