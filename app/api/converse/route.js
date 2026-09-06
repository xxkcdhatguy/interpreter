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

const LANG_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

function languageName(code) {
  if (!code) return "Unknown";
  try {
    return LANG_NAMES.of(code) || code;
  } catch {
    return code;
  }
}

/**
 * One turn of a two-way conversation.
 *
 * The client says which side spoke; this translates into the *other* side's
 * language and speaks it back in the speaker's own voice. Each side's cloned
 * voice is cached by the client and passed back, so only the first turn per
 * speaker pays the cloning cost.
 */
export async function POST(request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY is not set." }, { status: 500 });
  }

  let audio;
  let langA;
  let langB;
  let forcedSide = null;
  let wantsClone = false;
  let voiceIdA = null;
  let voiceIdB = null;
  let speakerName = null;

  try {
    const form = await request.formData();
    audio = form.get("audio");
    langA = form.get("langA") || "English";
    langB = form.get("langB") || "Portuguese";
    forcedSide = form.get("side") || null; // manual override
    wantsClone = form.get("clone") === "1";
    voiceIdA = form.get("voiceIdA") || null;
    voiceIdB = form.get("voiceIdB") || null;
    speakerName = form.get("speakerName") || null;
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!audio || typeof audio === "string" || audio.size === 0) {
    return Response.json({ error: "No audio received." }, { status: 400 });
  }

  try {
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

    const segments = transcription.segments || [];
    const noSpeechish =
      segments.length > 0 &&
      segments.every(
        (s) => (s.no_speech_prob ?? 0) > 0.5 || (s.avg_logprob ?? 0) < -1.0
      );
    const tooShort = sourceText.replace(/[^\p{L}\p{N}]/gu, "").length < 2;

    if (!sourceText || noSpeechish || tooShort) {
      return Response.json(
        { error: "Didn't catch that. Hold the button and speak a bit closer." },
        { status: 422 }
      );
    }

    // Whose turn was this? The detected language identifies the speaker when
    // the two sides speak different languages; a forced side always wins.
    // Whoever pressed the button is the speaker. This is explicit and works for
    // any language pairing, including both sides speaking the same language —
    // unlike inferring the speaker from the detected language.
    const detectedName = languageName(detected);
    const side = forcedSide === "B" ? "B" : "A";

    // Translate into the OTHER side's language.
    const targetLang = side === "A" ? langB : langA;
    const reuseVoiceId = side === "A" ? voiceIdA : voiceIdB;

    const completion = await openaiClient().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            `You are interpreting a live back-and-forth conversation. Translate the ` +
            `speaker's message into ${promptLanguage(targetLang)}. Output ONLY the translation — no ` +
            `quotes, commentary, or romanization. Keep their tone and register: ` +
            `translate casual speech casually. Preserve names, numbers and units. ` +
            `If it is already in ${promptLanguage(targetLang)}, return it unchanged.`,
        },
        { role: "user", content: sourceText },
      ],
    });
    const translated =
      completion.choices[0]?.message?.content?.trim() || sourceText;

    const languageId = cloneLanguageId(targetLang);
    let speechBuffer;
    let voiceMode = "stock";
    let voiceNote = null;
    let voiceId = null;

    if (wantsClone && cloningEnabled() && languageId) {
      try {
        if (reuseVoiceId) {
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
            speakerName,
          });
          speechBuffer = out.audio;
          voiceId = out.voiceId;
        }
        voiceMode = "cloned";
      } catch (err) {
        console.warn("clone failed, using stock voice:", err.message);
        voiceNote = "Couldn't clone that voice — used the standard one.";
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
      sourceText,
      translated,
      detectedLanguage: detectedName,
      side,
      targetLang,
      voiceMode,
      voiceNote,
      voiceId,
      audio: `data:audio/mp3;base64,${speechBuffer.toString("base64")}`,
    });
  } catch (err) {
    const message = err?.error?.message || err?.message || "Translation failed.";
    const status = err?.status && err.status >= 400 ? err.status : 502;
    return Response.json({ error: message }, { status });
  }
}
