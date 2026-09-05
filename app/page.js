"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { LANGUAGES } from "../lib/languages";

const MIN_MS = 400; // ignore accidental taps
const MAX_MS = 60000; // hard stop, so a stuck press can't record forever

export default function Home() {
  const [status, setStatus] = useState("idle"); // idle | recording | working | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [target, setTarget] = useState("English");
  const [clone, setClone] = useState(false);
  const [speakers, setSpeakers] = useState([
    { id: "s1", name: "Speaker 1", voiceId: null },
  ]);
  const [activeId, setActiveId] = useState("s1");
  const [alt, setAlt] = useState(null); // { target, translated } re-translation
  const [altBusy, setAltBusy] = useState(null); // language being fetched
  const [typed, setTyped] = useState("");
  const [saying, setSaying] = useState(false);

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const startedAtRef = useRef(0);
  const audioRef = useRef(null);
  const unlockedRef = useRef(false);
  const tickRef = useRef(null);
  const targetRef = useRef("English");
  const stopRef = useRef(null);
  const cloneRef = useRef(false);
  const voiceIdRef = useRef(null); // cached voice of the active speaker
  const activeIdRef = useRef("s1");
  const speakersRef = useRef([]);

  // Reuse one <audio> element so iOS treats playback as user-initiated.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("target");
      if (saved && LANGUAGES.some((l) => l.name === saved)) setTarget(saved);
      const savedClone = localStorage.getItem("clone") === "1";
      setClone(savedClone);
      cloneRef.current = savedClone;
      const savedSpeakers = localStorage.getItem("speakers");
      if (savedSpeakers) {
        const parsed = JSON.parse(savedSpeakers);
        if (Array.isArray(parsed) && parsed.length) {
          setSpeakers(parsed);
          setActiveId(parsed[0].id);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    audioRef.current = new Audio();
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Safari/iOS block programmatic playback unless the element has already
  // played once from a user gesture. Prime it during the press.
  const unlockAudio = useCallback(() => {
    if (unlockedRef.current || !audioRef.current) return;
    const el = audioRef.current;
    el.muted = true;
    el.src =
      "data:audio/mp3;base64,//MkxAAHiAICWABIAGBgcAAAAA" +
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const pr = el.play();
    if (pr?.then) {
      pr.then(() => {
        el.pause();
        el.muted = false;
        unlockedRef.current = true;
      }).catch(() => {
        el.muted = false;
      });
    } else {
      el.muted = false;
      unlockedRef.current = true;
    }
  }, []);

  const send = useCallback(async (blob, targetLang, useClone) => {
    setStatus("working");
    const startedWork = Date.now();
    setElapsed(0);
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedWork) / 1000)),
      500
    );
    const form = new FormData();
    form.append("audio", blob, "speech.webm");
    form.append("target", targetLang);
    form.append("clone", useClone ? "1" : "0");
    // Resolve from the ref, kept in sync with the selected speaker below.
    if (useClone && voiceIdRef.current) {
      form.append("voiceId", voiceIdRef.current);
    }
    try {
      const res = await fetch("/api/translate", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
        setError(data.error || "Something went wrong.");
        setStatus("error");
        return;
      }
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      data.producedIn = targetLang;
      if (data.voiceNote) setError(data.voiceNote);
      if (data.voiceId) {
        voiceIdRef.current = data.voiceId;
        const who = activeIdRef.current;
        setSpeakers((prev) =>
          prev.map((s) => (s.id === who ? { ...s, voiceId: data.voiceId } : s))
        );
      }
      setResult(data);
      setStatus("done");
      if (data.audio && audioRef.current) {
        audioRef.current.src = data.audio;
        audioRef.current.play().catch(() => {
          setError("Tap \u21bb Play again to hear it.");
        });
      }
    } catch {
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      setError("Network error. Check your connection and try again.");
      setStatus("error");
    }
  }, []);

  const start = useCallback(async () => {
    if (status === "recording" || status === "working") return;
    setError("");
    setResult(null);
    setAlt(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const held = Date.now() - startedAtRef.current;
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || "audio/webm",
        });
        if (held < MIN_MS || blob.size < 1200) {
          setStatus("idle");
          setError("Hold the button while you speak.");
          return;
        }
        send(blob, targetRef.current, cloneRef.current);
      };

      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      rec.start();
      setStatus("recording");
      setElapsed(0);
      tickRef.current = setInterval(() => {
        const held = Date.now() - startedAtRef.current;
        setElapsed(Math.floor(held / 1000));
        if (held >= MAX_MS) stopRef.current?.();
      }, 250);
    } catch {
      setError(
        "Microphone blocked. Allow mic access for this site in your browser settings."
      );
      setStatus("error");
    }
  }, [status, send]);

  const stop = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recorderRef.current = null;
  }, []);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    cloneRef.current = clone;
  }, [clone]);

  // Point the cached-voice ref at whoever is currently selected.
  useEffect(() => {
    speakersRef.current = speakers;
    try {
      localStorage.setItem("speakers", JSON.stringify(speakers));
    } catch {}
  }, [speakers]);

  useEffect(() => {
    activeIdRef.current = activeId;
    const s = speakers.find((x) => x.id === activeId);
    voiceIdRef.current = s?.voiceId || null;
  }, [activeId, speakers]);

  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);



  // Re-speak the same turn in another language, reusing the cloned voice.
  const retranslate = useCallback(
    async (lang) => {
      if (!result?.sourceText || altBusy) return;
      const original = result.producedIn || target;
      if (lang === original) {
        setAlt(null); // back to the translation this turn produced
        if (result.audio && audioRef.current) {
          audioRef.current.src = result.audio;
          audioRef.current.play().catch(() => {});
        }
        return;
      }
      setAltBusy(lang);
      setError("");
      try {
        const res = await fetch("/api/retranslate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceText: result.sourceText,
            target: lang,
            voiceId: voiceIdRef.current,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Could not translate that language.");
          return;
        }
        setAlt({ target: lang, translated: data.translated });
        if (data.audio && audioRef.current) {
          audioRef.current.src = data.audio;
          audioRef.current.play().catch(() => {});
        }
      } catch {
        setError("Network error.");
      } finally {
        setAltBusy(null);
      }
    },
    [result, target, altBusy]
  );

  // Remove a speaker and release their cloned voice so it does not linger.
  const removeSpeaker = useCallback(
    (id) => {
      const gone = speakersRef.current.find((s) => s.id === id);
      if (gone?.voiceId) {
        fetch("/api/release", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceIds: [gone.voiceId] }),
        }).catch(() => {});
      }
      setSpeakers((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (id === activeIdRef.current) {
          const fallback = next[0];
          setActiveId(fallback.id);
          activeIdRef.current = fallback.id;
          voiceIdRef.current = fallback.voiceId || null;
        }
        speakersRef.current = next;
        return next;
      });
    },
    []
  );

  // Speak typed text verbatim in the selected speaker's saved voice.
  const sayTyped = useCallback(async () => {
    const text = typed.trim();
    if (!text || saying) return;
    setSaying(true);
    setError("");
    try {
      const res = await fetch("/api/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          language: target,
          voiceId: cloneRef.current ? voiceIdRef.current : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not say that.");
        return;
      }
      if (data.audio && audioRef.current) {
        audioRef.current.src = data.audio;
        audioRef.current.play().catch(() => {});
      }
    } catch {
      setError("Network error.");
    } finally {
      setSaying(false);
    }
  }, [typed, saying, target]);

  const replay = () => {
    if (result?.audio && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
    }
  };

  const recording = status === "recording";
  const working = status === "working";

  const label = recording
    ? `Listening… ${elapsed}s`
    : working
    ? "Translating…"
    : "Hold to speak";

  return (
    <main className="wrap">
      <header className="head">
        <div className="titles">
          <h1>
            Interpreter <a className="convlink" href="/conversation">Conversation ›</a>
          </h1>
          <p>Any language in, {target} out.</p>
        </div>
        <label className="picker">
          <span className="picker-label">Translate to</span>
          <select
            value={target}
            onChange={(e) => {
              const v = e.target.value;
              setTarget(v);
              try {
                localStorage.setItem("target", v);
              } catch {}
            }}
            disabled={recording || working}
          >
            {LANGUAGES.map((l) => (
              <option key={l.name} value={l.name}>
                {l.flag}  {l.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      <section className="stage" aria-live="polite">
        {status === "idle" && !error && (
          <p className="hint">
            Hand them the phone. They hold the button, speak, and let go —
            you&apos;ll hear it in {target}.
          </p>
        )}

        {error && <p className="err">{error}</p>}

        {working && (
          <div className="workwrap">
            <div className="spinner" aria-label="Translating" />
            <p className="worknote">
              {clone && elapsed > 4
                ? `Cloning the voice\u2026 ${elapsed}s`
                : "Translating\u2026"}
            </p>
          </div>
        )}

        {result && status === "done" && (
          <div className="cards">
            <div className="card sub">
              <span className="tag">
                {result.detectedLanguage || "Detected"}
              </span>
              <p>{result.sourceText}</p>
            </div>
            <div className="card main">
              <span className="tag">
                {alt ? alt.target : result.producedIn || target}
                {result.voiceMode === "cloned" && (
                  <span className="clonebadge">their voice</span>
                )}
              </span>
              <p>{alt ? alt.translated : result.translated}</p>
            </div>

            <div className="alsorow">
              <span className="alsolabel">Also in</span>
              <div className="chips">
                {(() => {
                  const produced = result.producedIn || target;
                  const pinned = [produced, target].filter(
                    (v, i, a) => v && a.indexOf(v) === i
                  );
                  const head = pinned
                    .map((n) => LANGUAGES.find((l) => l.name === n))
                    .filter(Boolean);
                  const rest = LANGUAGES.filter(
                    (l) => !pinned.includes(l.name)
                  );
                  return [...head, ...rest].slice(0, 7);
                })()
                  .map((l) => {
                    const active = alt
                      ? alt.target === l.name
                      : l.name === (result.producedIn || target);
                    return (
                      <button
                        key={l.name}
                        type="button"
                        className={`chip ${active ? "on" : ""}`}
                        disabled={Boolean(altBusy)}
                        onClick={() => retranslate(l.name)}
                      >
                        {altBusy === l.name ? "…" : `${l.flag} ${l.name}`}
                      </button>
                    );
                  })}
              </div>
            </div>

            <button className="replay" onClick={replay} type="button">
              ↻ Play again
            </button>
          </div>
        )}
      </section>

      <div className="dock">
        {clone && (
          <div className="speakers">
            <span className="speakerlabel">Who&apos;s speaking</span>
            <div className="chips">
              {speakers.map((sp) => (
                <span
                  key={sp.id}
                  className={`chip speaker ${sp.id === activeId ? "on" : ""}`}
                >
                  <button
                    type="button"
                    className="chipmain"
                    disabled={recording || working}
                    onDoubleClick={() => {
                      const name = window.prompt("Name this speaker", sp.name);
                      if (name && name.trim()) {
                        setSpeakers((prev) =>
                          prev.map((x) =>
                            x.id === sp.id ? { ...x, name: name.trim() } : x
                          )
                        );
                      }
                    }}
                    onClick={() => {
                      setActiveId(sp.id);
                      activeIdRef.current = sp.id;
                      voiceIdRef.current = sp.voiceId || null;
                    }}
                  >
                    {sp.voiceId ? "\u25cf " : ""}
                    {sp.name}
                  </button>
                  {speakers.length > 1 && (
                    <button
                      type="button"
                      className="chipx"
                      aria-label={`Remove ${sp.name}`}
                      disabled={recording || working}
                      onClick={() => removeSpeaker(sp.id)}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              <button
                type="button"
                className="chip add"
                disabled={recording || working || speakers.length >= 6}
                onClick={() => {
                  // Lowest unused number, so deleting a speaker cannot
                  // produce a duplicate name.
                  let n = speakers.length + 1;
                  const taken = new Set(speakers.map((x) => x.name));
                  while (taken.has(`Speaker ${n}`)) n += 1;
                  const suggested = `Speaker ${n}`;
                  const entered = window.prompt("Who is speaking?", suggested);
                  if (entered === null) return; // cancelled
                  const name = entered.trim() || suggested;
                  const id = `s${Date.now()}`;
                  setSpeakers((prev) => [...prev, { id, name, voiceId: null }]);
                  setActiveId(id);
                  activeIdRef.current = id;
                  voiceIdRef.current = null;
                }}
              >
                + Add
              </button>
            </div>
          </div>
        )}
        <div className="sayrow">
          <input
            className="sayinput"
            placeholder={
              clone && speakers.find((sp) => sp.id === activeId)?.voiceId
                ? `Type \u2014 ${
                    speakers.find((sp) => sp.id === activeId)?.name
                  }'s voice says it\u2026`
                : "Type something to speak\u2026"
            }
            value={typed}
            maxLength={600}
            disabled={recording || working}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sayTyped();
            }}
          />
          <button
            type="button"
            className="saybtn"
            disabled={!typed.trim() || saying || recording || working}
            onClick={() => {
              unlockAudio();
              sayTyped();
            }}
          >
            {saying ? "…" : "Say"}
          </button>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={clone}
          className={`toggle ${clone ? "on" : ""}`}
          disabled={recording || working}
          onClick={() => {
            const v = !clone;
            setClone(v);
            try {
              localStorage.setItem("clone", v ? "1" : "0");
            } catch {}
          }}
        >
          <span className="knob" aria-hidden="true" />
          <span className="toggle-text">
            <strong>Speaker&apos;s voice</strong>
            <em>{clone ? "on \u00b7 slower" : "off \u00b7 fast"}</em>
          </span>
        </button>
        <button
          type="button"
          className={`ptt ${recording ? "on" : ""}`}
          disabled={working}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            unlockAudio();
            start();
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            stop();
          }}
          onPointerCancel={stop}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="mic" aria-hidden="true">
            {recording ? "●" : "🎤"}
          </span>
          <span className="ptt-label">{label}</span>
        </button>
      </div>

      <style jsx global>{`
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        html, body { margin: 0; height: 100%; }
        body {
          background: #0b0d12;
          color: #eef1f6;
          font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          overscroll-behavior: none;
        }
      `}</style>
      <style jsx>{`
        .wrap {
          min-height: 100dvh;
          display: grid;
          grid-template-rows: auto 1fr auto;
          gap: 16px;
          padding: 28px 20px calc(20px + env(safe-area-inset-bottom));
          max-width: 560px;
          margin: 0 auto;
        }
        .head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .convlink {
          font-size: 12px;
          font-weight: 500;
          color: #6ea8ff;
          text-decoration: none;
          margin-left: 8px;
          vertical-align: middle;
        }
        .head h1 {
          margin: 0;
          font-size: 22px;
          letter-spacing: -0.02em;
        }
        .head p {
          margin: 4px 0 0;
          color: #8d97a8;
          font-size: 14px;
        }
        .picker {
          display: grid;
          gap: 4px;
          justify-items: end;
          flex-shrink: 0;
        }
        .picker-label {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #6f7c91;
        }
        .picker select {
          appearance: none;
          background: #161b26;
          color: #eef1f6;
          border: 1px solid #26303f;
          border-radius: 10px;
          padding: 9px 30px 9px 11px;
          font-size: 14px;
          font-weight: 500;
          max-width: 165px;
          background-image: linear-gradient(45deg, transparent 50%, #7d879a 50%),
            linear-gradient(135deg, #7d879a 50%, transparent 50%);
          background-position: calc(100% - 15px) 52%, calc(100% - 10px) 52%;
          background-size: 5px 5px, 5px 5px;
          background-repeat: no-repeat;
        }
        .picker select:disabled { opacity: 0.5; }
        .stage {
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
        }
        .hint {
          color: #7d879a;
          font-size: 15px;
          max-width: 320px;
          margin: 0;
        }
        .err {
          color: #ffb4a8;
          background: rgba(255, 90, 70, 0.1);
          border: 1px solid rgba(255, 90, 70, 0.25);
          padding: 12px 14px;
          border-radius: 12px;
          font-size: 14px;
          margin: 0;
        }
        .cards {
          width: 100%;
          display: grid;
          gap: 12px;
        }
        .card {
          text-align: left;
          padding: 14px 16px;
          border-radius: 16px;
          border: 1px solid #1e2430;
          background: #12161f;
        }
        .card p { margin: 6px 0 0; }
        .card.sub p { color: #9aa4b6; font-size: 15px; }
        .card.main {
          background: #15202e;
          border-color: #26405c;
        }
        .card.main p {
          font-size: 21px;
          line-height: 1.35;
          font-weight: 500;
          letter-spacing: -0.01em;
        }
        .tag {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #6f7c91;
        }
        .card.main .tag { color: #6ea8ff; }
        .alsorow { display: grid; gap: 7px; }
        .alsolabel {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #6f7c91;
        }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .chip {
          border: 1px solid #26303f;
          background: #12161f;
          color: #9aa4b6;
          padding: 7px 11px;
          border-radius: 999px;
          font-size: 12.5px;
          white-space: nowrap;
        }
        .chip.on {
          background: #15202e;
          border-color: #2f5480;
          color: #cfe0f7;
        }
        .chip:disabled { opacity: 0.55; }
        .replay {
          justify-self: start;
          background: none;
          border: 1px solid #26303f;
          color: #9aa4b6;
          padding: 8px 14px;
          border-radius: 999px;
          font-size: 13px;
        }
        .dock { display: grid; gap: 10px; }
        .sayrow { display: flex; gap: 6px; }
        .sayinput {
          flex: 1;
          min-width: 0;
          background: #12161f;
          color: #eef1f6;
          border: 1px solid #26303f;
          border-radius: 12px;
          padding: 11px 13px;
          font-size: 14px;
          font-family: inherit;
        }
        .sayinput::placeholder { color: #5d6980; }
        .sayinput:disabled { opacity: 0.5; }
        .saybtn {
          border: 1px solid #2f5480;
          background: #15202e;
          color: #6ea8ff;
          border-radius: 12px;
          padding: 0 16px;
          font-size: 14px;
          font-weight: 600;
        }
        .saybtn:disabled { opacity: 0.4; }
        .speakers { display: grid; gap: 6px; }
        .speakerlabel {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #6f7c91;
        }
        .chip.add { border-style: dashed; color: #6f7c91; }
        .chip.speaker {
          display: inline-flex;
          align-items: stretch;
          padding: 0;
          overflow: hidden;
        }
        .chipmain {
          background: none;
          border: none;
          color: inherit;
          font: inherit;
          padding: 7px 4px 7px 11px;
        }
        .chipx {
          background: none;
          border: none;
          color: #6f7c91;
          font-size: 15px;
          line-height: 1;
          padding: 0 9px 0 5px;
        }
        .chip.speaker:disabled, .chipmain:disabled, .chipx:disabled { opacity: 0.55; }
        .toggle {
          display: flex;
          align-items: center;
          gap: 11px;
          width: 100%;
          padding: 11px 14px;
          border-radius: 14px;
          border: 1px solid #232c3a;
          background: #12161f;
          color: #eef1f6;
          text-align: left;
        }
        .toggle:disabled { opacity: 0.5; }
        .toggle .knob {
          position: relative;
          flex: 0 0 40px;
          height: 23px;
          border-radius: 999px;
          background: #2b3444;
          transition: background 0.18s;
        }
        .toggle .knob::after {
          content: "";
          position: absolute;
          top: 3px;
          left: 3px;
          width: 17px;
          height: 17px;
          border-radius: 50%;
          background: #8894a8;
          transition: transform 0.18s, background 0.18s;
        }
        .toggle.on .knob { background: #1d4ed8; }
        .toggle.on .knob::after {
          transform: translateX(17px);
          background: #fff;
        }
        .toggle-text { display: grid; line-height: 1.25; }
        .toggle-text strong { font-size: 14px; font-weight: 600; }
        .toggle-text em {
          font-style: normal;
          font-size: 11.5px;
          color: #7d879a;
        }
        .ptt {
          width: 100%;
          border: none;
          border-radius: 20px;
          padding: 20px;
          background: #2563eb;
          color: white;
          font-size: 17px;
          font-weight: 600;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          touch-action: none;
          user-select: none;
          transition: background 0.15s, transform 0.1s;
        }
        .ptt:active { transform: scale(0.985); }
        .ptt.on {
          background: #dc2626;
          animation: pulse 1.4s ease-in-out infinite;
        }
        .ptt:disabled { background: #2a3140; color: #7c879b; }
        .mic { font-size: 19px; }
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.5); }
          50% { box-shadow: 0 0 0 14px rgba(220, 38, 38, 0); }
        }
        .workwrap { display: grid; gap: 12px; justify-items: center; }
        .worknote { margin: 0; color: #7d879a; font-size: 13px; }
        .clonebadge {
          margin-left: 8px;
          padding: 2px 7px;
          border-radius: 999px;
          background: rgba(110, 168, 255, 0.15);
          color: #6ea8ff;
          font-size: 10px;
          letter-spacing: 0.04em;
        }
        .spinner {
          width: 26px;
          height: 26px;
          border: 3px solid #26303f;
          border-top-color: #6ea8ff;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </main>
  );
}
