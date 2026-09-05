import OpenAI from "openai";
import {
  cloneLanguageId,
  cloningEnabled,
  sourceLanguageId,
  speakInSpeakersVoice,
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

// Language name lookup for the ISO codes Whisper returns.
const LANG_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

function languageName(code) {
  if (!code) return "Unknown";
  try {
    return LANG_NAMES.of(code) || code;
  } catch {
    return code;
  }
}

export async function POST(request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: "OPENAI_API_KEY is not set on the server." },
      { status: 500 }
    );
  }

  let audio;
  let targetLang = "English";
  let wantsClone = false;
  let reuseVoiceId = null;
  try {
    const form = await request.formData();
    audio = form.get("audio");
    targetLang = form.get("target") || "English";
    wantsClone = form.get("clone") === "1";
    reuseVoiceId = form.get("voiceId") || null;
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!audio || typeof audio === "string" || audio.size === 0) {
    return Response.json({ error: "No audio received." }, { status: 400 });
  }

  try {
    // 1. Speech -> text, with automatic language detection.
    const file = new File([audio], "speech.webm", {
      type: audio.type || "audio/webm",
    });
    const transcription = await openaiClient().audio.transcriptions.create({
      file,
      model: "whisper-1",
      response_format: "verbose_json",
    });

    const sourceText = (transcription.text || "").trim();
    const detected = transcription.language || null;

    // Whisper invents filler text ("you", "Thank you.") for silent or noise-only
    // audio. Reject it here so we never speak a hallucination out loud.
    const segments = transcription.segments || [];
    const noSpeechish =
      segments.length > 0 &&
      segments.every(
        (s) => (s.no_speech_prob ?? 0) > 0.5 || (s.avg_logprob ?? 0) < -1.0
      );
    const tooShortToBeReal = sourceText.replace(/[^\p{L}\p{N}]/gu, "").length < 2;

    if (!sourceText || noSpeechish || tooShortToBeReal) {
      return Response.json(
        {
          error:
            "Didn't catch that. Hold the button, then speak a little closer to the mic.",
        },
        { status: 422 }
      );
    }

    // 2. Translate. Skip the round trip when it is already the target language.
    const detectedName = languageName(detected);
    const alreadyTarget =
      detectedName.toLowerCase() === targetLang.toLowerCase();

    let translated = sourceText;
    if (!alreadyTarget) {
      const completion = await openaiClient().chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              `You are a live conversation interpreter. Translate the user's message into ${promptLanguage(targetLang)}. ` +
              `Output ONLY the translation, with no quotes, no commentary, no romanization. ` +
              `Keep the speaker's tone and register — translate casual speech casually. ` +
              `Preserve names, numbers and units exactly. If the text is already in ${promptLanguage(targetLang)}, return it unchanged.`,
          },
          { role: "user", content: sourceText },
        ],
      });
      translated =
        completion.choices[0]?.message?.content?.trim() || sourceText;
    }

    // 3. Text -> speech. Prefer the speaker's own cloned voice; fall back to a
    //    stock voice if cloning is unavailable or fails for this clip.
    let speechBuffer;
    let voiceMode = "stock";
    let mime = "audio/mp3";
    const languageId = cloneLanguageId(targetLang);

    let voiceId = null;
    if (wantsClone && cloningEnabled() && languageId) {
      try {
        if (reuseVoiceId) {
          // Same speaker as a previous turn: skip the ~6s clone entirely.
          speechBuffer = await speakWithVoice({
            voiceId: reuseVoiceId,
            text: translated,
            languageId,
          });
          voiceId = reuseVoiceId;
        } else {
          const out = await speakInSpeakersVoice({
            audioBuffer: Buffer.from(await audio.arrayBuffer()),
            filename: audio.name || "clip.webm",
            text: translated,
            languageId,
            sourceLangCode: sourceLanguageId(detected),
          });
          speechBuffer = out.audio;
          voiceId = out.voiceId;
        }
        voiceMode = "cloned";
        mime = "audio/mp3";
      } catch (cloneErr) {
        console.warn("voice clone failed, using stock voice:", cloneErr.message);
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
      mime = "audio/mp3";
    }

    return Response.json({
      sourceText,
      translated,
      detectedLanguage: detectedName,
      voiceMode,
      voiceId,
      audio: `data:${mime};base64,${speechBuffer.toString("base64")}`,
    });
  } catch (err) {
    const message =
      err?.error?.message || err?.message || "Translation failed.";
    const status = err?.status && err.status >= 400 ? err.status : 502;
    return Response.json({ error: message }, { status });
  }
}
