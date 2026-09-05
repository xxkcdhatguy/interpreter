"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { LANGUAGES } from "../../lib/languages";

const MIN_MS = 400;
const MAX_MS = 60000;

export default function Conversation() {
  const [langA, setLangA] = useState("Portuguese"); // your side
  const [langB, setLangB] = useState("German"); // their side
  const [clone, setClone] = useState(true);
  const [nameA, setNameA] = useState("Me");
  const [nameB, setNameB] = useState("Them");
  const [status, setStatus] = useState("idle");
  const [turns, setTurns] = useState([]);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const startedAtRef = useRef(0);
  const tickRef = useRef(null);
  const audioRef = useRef(null);
  const stopRef = useRef(null);

  // Each side keeps its own cloned voice, so only the first turn per person
  // pays the cloning cost.
  const voiceA = useRef(null);
  const voiceB = useRef(null);
  const cfg = useRef({ langA, langB, clone, side: null });

  useEffect(() => {
    cfg.current = { ...cfg.current, langA, langB, clone };
    if (!clone) {
      voiceA.current = null;
      voiceB.current = null;
    }
  }, [langA, langB, clone]);

  useEffect(() => {
    audioRef.current = new Audio();
    try {
      const a = localStorage.getItem("cv_langA");
      const b = localStorage.getItem("cv_langB");
      if (a) setLangA(a);
      if (b) setLangB(b);
      const c = localStorage.getItem("cv_clone");
      if (c !== null) setClone(c === "1");
      const na = localStorage.getItem("cv_nameA");
      const nb = localStorage.getItem("cv_nameB");
      if (na) setNameA(na);
      if (nb) setNameB(nb);
    } catch {}
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const send = useCallback(async (blob, forcedSide) => {
    setStatus("working");
    setElapsed(0);
    const t0 = Date.now();
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(
      () => setElapsed(Math.floor((Date.now() - t0) / 1000)),
      500
    );

    const { langA: a, langB: b, clone: useClone } = cfg.current;
    const form = new FormData();
    form.append("audio", blob, "speech.webm");
    form.append("langA", a);
    form.append("langB", b);
    form.append("clone", useClone ? "1" : "0");
    if (forcedSide) form.append("side", forcedSide);
    if (voiceA.current) form.append("voiceIdA", voiceA.current);
    if (voiceB.current) form.append("voiceIdB", voiceB.current);

    try {
      const res = await fetch("/api/converse", { method: "POST", body: form });
      const data = await res.json();
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        setStatus("idle");
        return;
      }
      if (data.voiceId) {
        if (data.side === "A") voiceA.current = data.voiceId;
        else voiceB.current = data.voiceId;
      }
      setTurns((prev) => [...prev, { ...data, id: Date.now() }]);
      setStatus("idle");
      if (data.audio && audioRef.current) {
        audioRef.current.src = data.audio;
        audioRef.current.play().catch(() => {});
      }
    } catch {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      setError("Network error.");
      setStatus("idle");
    }
  }, []);

  const start = useCallback(
    async (side) => {
      if (status !== "idle") return;
      setError("");
      cfg.current.side = side;
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
        const rec = new MediaRecorder(
          stream,
          mime ? { mimeType: mime } : undefined
        );
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
          send(blob, cfg.current.side);
        };
        recorderRef.current = rec;
        startedAtRef.current = Date.now();
        rec.start();
        setStatus(side === "A" ? "recA" : "recB");
        setElapsed(0);
        tickRef.current = setInterval(() => {
          const held = Date.now() - startedAtRef.current;
          setElapsed(Math.floor(held / 1000));
          if (held >= MAX_MS) stopRef.current?.();
        }, 250);
      } catch {
        setError("Microphone blocked. Allow mic access for this site.");
        setStatus("idle");
      }
    },
    [status, send]
  );

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
    stopRef.current = stop;
  }, [stop]);

  // Release cloned voices when the tab closes, so they don't pile up.
  useEffect(() => {
    const release = () => {
      const ids = [voiceA.current, voiceB.current].filter(Boolean);
      if (!ids.length) return;
      navigator.sendBeacon?.(
        "/api/release",
        new Blob([JSON.stringify({ voiceIds: ids })], {
          type: "application/json",
        })
      );
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, []);


  const busy = status === "working";
  const last = turns[turns.length - 1];

  // Each half shows what that person should read: their own language.
  const halfFor = (side) => {
    const lang = side === "A" ? langA : langB;
    const relevant = [...turns].reverse().find((t) => {
      const heard = t.side !== side; // the other person spoke
      return heard ? t.targetLang === lang : t.detectedLanguage;
    });
    if (!relevant) return null;
    return relevant.side === side ? relevant.sourceText : relevant.translated;
  };

  return (
    <main className="wrap">
      <Half
        side="B"
        name={nameB}
        setName={setNameB}
        nameKey="cv_nameB"
        lang={langB}
        setLang={setLangB}
        storeKey="cv_langB"
        recording={status === "recB"}
        text={halfFor("B")}
        busy={busy}
        status={status}
        clone={clone}
        elapsed={elapsed}
        onStart={start}
        onStop={stop}
        onLangChange={() => {
          voiceB.current = null;
        }}
      />

      <div className="middle">
        <a className="back" href="/">
          ‹ One-way
        </a>
        {error ? (
          <span className="err">{error}</span>
        ) : (
          <span className="mid-meta">
            {last?.voiceMode === "cloned" ? "cloned voices" : "conversation"}
          </span>
        )}
        <button
          type="button"
          className={`mini ${clone ? "on" : ""}`}
          disabled={status !== "idle"}
          onClick={() => {
            const v = !clone;
            setClone(v);
            try {
              localStorage.setItem("cv_clone", v ? "1" : "0");
            } catch {}
          }}
        >
          {clone ? "voices: on" : "voices: off"}
        </button>
      </div>

      <Half
        side="A"
        name={nameA}
        setName={setNameA}
        nameKey="cv_nameA"
        lang={langA}
        setLang={setLangA}
        storeKey="cv_langA"
        recording={status === "recA"}
        text={halfFor("A")}
        busy={busy}
        status={status}
        clone={clone}
        elapsed={elapsed}
        onStart={start}
        onStop={stop}
        onLangChange={() => {
          voiceA.current = null;
        }}
      />

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
          height: 100dvh;
          display: grid;
          grid-template-rows: 1fr auto 1fr;
          max-width: 560px;
          margin: 0 auto;
        }
        .half {
          display: grid;
          grid-template-rows: auto 1fr auto;
          gap: 10px;
          padding: 14px 16px;
          min-height: 0;
        }
        .half.flip { transform: rotate(180deg); }
        .halftop {
          display: flex;
          justify-content: center;
          gap: 6px;
        }
        .nameinput {
          width: 78px;
          background: #161b26;
          color: #eef1f6;
          border: 1px solid #26303f;
          border-radius: 999px;
          padding: 6px 12px;
          font-size: 13px;
          font-weight: 600;
          text-align: center;
          font-family: inherit;
        }
        .nameinput:disabled { opacity: 0.5; }
        .halftop select {
          appearance: none;
          background: #161b26;
          color: #eef1f6;
          border: 1px solid #26303f;
          border-radius: 999px;
          padding: 6px 14px;
          font-size: 13px;
          font-weight: 500;
        }
        .halftop select:disabled { opacity: 0.5; }
        .bubble {
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          overflow-y: auto;
          min-height: 0;
          padding: 4px;
        }
        .bubble p {
          margin: 0;
          font-size: 20px;
          line-height: 1.35;
          font-weight: 500;
          letter-spacing: -0.01em;
        }
        .muted { color: #6f7c91; font-size: 14px; }
        .talk {
          border: none;
          border-radius: 16px;
          padding: 16px;
          background: #2563eb;
          color: #fff;
          font-size: 15px;
          font-weight: 600;
          touch-action: none;
          user-select: none;
        }
        .talk.on { background: #dc2626; }
        .talk:disabled { background: #2a3140; color: #7c879b; }
        .middle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 7px 14px;
          border-top: 1px solid #1b212c;
          border-bottom: 1px solid #1b212c;
          background: #0e1219;
        }
        .back { color: #6f7c91; font-size: 12px; text-decoration: none; }
        .mid-meta { color: #55607a; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
        .err { color: #ffb4a8; font-size: 12px; }
        .mini {
          border: 1px solid #26303f;
          background: #12161f;
          color: #7d879a;
          border-radius: 999px;
          padding: 5px 11px;
          font-size: 11.5px;
        }
        .mini.on { color: #6ea8ff; border-color: #2f5480; background: #15202e; }
      `}</style>
    </main>
  );
}

/**
 * One person's half of the screen. Defined at module scope so React keeps the
 * same DOM node across renders — a nested definition remounts the button
 * mid-press and cancels the recording.
 */
function Half({
  side,
  name,
  setName,
  nameKey,
  lang,
  setLang,
  storeKey,
  recording,
  text,
  busy,
  status,
  clone,
  elapsed,
  onStart,
  onStop,
  onLangChange,
}) {
  return (
    <section className={`half ${side === "B" ? "flip" : ""}`}>
      <div className="halftop">
        <input
          className="nameinput"
          value={name}
          disabled={status !== "idle"}
          maxLength={14}
          aria-label="Speaker name"
          onChange={(e) => {
            setName(e.target.value);
            try {
              localStorage.setItem(nameKey, e.target.value);
            } catch {}
          }}
        />
        <select
          value={lang}
          disabled={status !== "idle"}
          onChange={(e) => {
            setLang(e.target.value);
            try {
              localStorage.setItem(storeKey, e.target.value);
            } catch {}
            onLangChange();
          }}
        >
          {LANGUAGES.map((l) => (
            <option key={l.name} value={l.name}>
              {l.flag} {l.name}
            </option>
          ))}
        </select>
      </div>

      <div className="bubble">
        {busy ? (
          <span className="muted">
            {clone && elapsed > 4 ? `Working… ${elapsed}s` : "Working…"}
          </span>
        ) : text ? (
          <p>{text}</p>
        ) : (
          <span className="muted">Hold your button and speak.</span>
        )}
      </div>

      <button
        type="button"
        className={`talk ${recording ? "on" : ""}`}
        disabled={busy || (status !== "idle" && !recording)}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          onStart(side);
        }}
        onPointerUp={(e) => {
          e.preventDefault();
          onStop();
        }}
        onPointerCancel={onStop}
        onContextMenu={(e) => e.preventDefault()}
      >
        {recording ? `● ${elapsed}s` : `🎤 ${name || "Hold"} — hold to speak`}
      </button>

      <style jsx>{`
        .half {
          display: grid;
          grid-template-rows: auto 1fr auto;
          gap: 10px;
          padding: 14px 16px;
          min-height: 0;
        }
        .half.flip { transform: rotate(180deg); }
        .halftop {
          display: flex;
          justify-content: center;
          gap: 6px;
        }
        .nameinput {
          width: 78px;
          background: #161b26;
          color: #eef1f6;
          border: 1px solid #26303f;
          border-radius: 999px;
          padding: 6px 12px;
          font-size: 13px;
          font-weight: 600;
          text-align: center;
          font-family: inherit;
        }
        .nameinput:disabled { opacity: 0.5; }
        .halftop select {
          appearance: none;
          background: #161b26;
          color: #eef1f6;
          border: 1px solid #26303f;
          border-radius: 999px;
          padding: 6px 14px;
          font-size: 13px;
          font-weight: 500;
        }
        .halftop select:disabled { opacity: 0.5; }
        .bubble {
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          overflow-y: auto;
          min-height: 0;
          padding: 4px;
        }
        .bubble p {
          margin: 0;
          font-size: 20px;
          line-height: 1.35;
          font-weight: 500;
          letter-spacing: -0.01em;
        }
        .muted { color: #6f7c91; font-size: 14px; }
        .talk {
          border: none;
          border-radius: 16px;
          padding: 16px;
          background: #2563eb;
          color: #fff;
          font-size: 15px;
          font-weight: 600;
          touch-action: none;
          user-select: none;
        }
        .talk.on { background: #dc2626; }
        .talk:disabled { background: #2a3140; color: #7c879b; }
      `}</style>
    </section>
  );
}
