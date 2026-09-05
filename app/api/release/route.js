import { releaseVoice } from "../../../lib/voice";

/**
 * Discard cloned voices when a session ends, so they don't accumulate in the
 * Cartesia account. Called via sendBeacon on page unload, so it must be cheap
 * and must never throw.
 */
export async function POST(request) {
  try {
    const { voiceIds } = await request.json();
    if (Array.isArray(voiceIds)) {
      await Promise.all(voiceIds.filter(Boolean).map((id) => releaseVoice(id)));
    }
  } catch {
    /* best effort */
  }
  return Response.json({ ok: true });
}
