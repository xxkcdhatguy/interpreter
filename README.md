# Interpreter

Hand someone your phone. They hold the button and speak in any language —
you hear it back in the language you picked.

## Setup

```bash
npm install
echo "OPENAI_API_KEY=sk-..." > .env.local
npm run dev          # http://localhost:3005
```

## How it works

One request per turn, `POST /api/translate`:

1. **Whisper** (`whisper-1`) transcribes the audio and auto-detects the language.
2. **gpt-4o-mini** translates into the selected target, preserving tone,
   names and numbers. Skipped entirely when the speaker already used the
   target language.
3. **gpt-4o-mini-tts** speaks the result, returned as a base64 MP3.

Silence and noise-only clips are rejected before step 2 — Whisper otherwise
hallucinates filler like "you" or "Thank you.", which would be spoken aloud.

## Speakers and voice cloning

With cloning on, a **Who's speaking** row appears. Each speaker's cloned voice is
saved in that browser's `localStorage`, so it survives closing the app — and it
is per-device: your phone remembers your voice, hers remembers hers.

The first turn for a new speaker clones (~9s); every turn after reuses the saved
voice (~4s). Deleting a speaker (the `×`) releases their voice from Cartesia.

## Notes

- 16 output languages; the choice persists in `localStorage`.
- Push-to-talk: min 400 ms (ignores stray taps), max 60 s (stuck-press guard).
- Roughly $0.01–0.02 per exchange, plus Cartesia credits when cloning.
- Cloned voices persist per device and are only removed when you delete the speaker.
- Mic access needs HTTPS in production (`localhost` is exempt).

## Deploy

```bash
npx vercel            # then add OPENAI_API_KEY in project settings
```
