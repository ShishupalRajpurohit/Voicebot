"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type Message = { role: "user" | "assistant"; content: string };
type LoadingState = "idle" | "transcribing" | "thinking" | "speaking";

const PROMPTS = [
  "What should we know about your life story?",
  "What's your number-one superpower?",
  "What are the top three areas you'd like to grow in?",
  "What misconception might coworkers have about you?",
  "How do you push your boundaries?",
  "What projects have you built?",
  "What is your educational background?",
  "Where did you work before?",
];

const STORAGE_KEY = "voicebot-conversation";

export default function HomePage() {
  const [messages, setMessages] = useState<Message[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) return JSON.parse(stored);
      } catch { }
    }
    return [{ role: "assistant", content: "Hi, I'm an AI version representing Shishupal. Ask me about my background, projects, strengths or how I approach problems." }];
  });
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState("Ready when you are.");
  const [loadingState, setLoadingState] = useState<LoadingState>("idle");
  const [recording, setRecording] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [provider, setProvider] = useState("");
  const [lastTranscript, setLastTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedVoiceName, setSelectedVoiceName] = useState("");
  const [darkMode, setDarkMode] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const voicesByLangRef = useRef<Record<string, SpeechSynthesisVoice[]>>({});
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioLevelRef = useRef(0);

  // Persist conversation
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    }
  }, [messages]);

  // Dark mode
  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("voicebot-darkmode");
      if (stored !== null) setDarkMode(JSON.parse(stored));
      else setDarkMode(window.matchMedia("(prefers-color-scheme: dark)").matches);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("voicebot-darkmode", JSON.stringify(darkMode));
      document.documentElement.classList.toggle("dark", darkMode);
    }
  }, [darkMode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
    };
  }, []);

  // Load and organize voices on mount
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;

      const byLang: Record<string, SpeechSynthesisVoice[]> = {};
      for (const voice of voices) {
        const lang = voice.lang.split("-")[0];
        if (!byLang[lang]) byLang[lang] = [];
        byLang[lang].push(voice);
      }
      voicesByLangRef.current = byLang;

      // Log for debugging
      console.log("[Voicebot] Voices loaded:", voices.map(v => ({ name: v.name, lang: v.lang })));
    };

    loadVoices();
    if ("onvoiceschanged" in window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
    return () => {
      if ("onvoiceschanged" in window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  }, []);

  // Select best MALE voice for a given language
  const selectVoiceForLang = useCallback((lang: string): SpeechSynthesisVoice | null => {
    const baseLang = lang.split("-")[0];
    const voices = voicesByLangRef.current[baseLang];
    if (!voices || voices.length === 0) return null;

    // ONLY male voices, prefer Google/Microsoft
    const preferredVendors = ["Google", "Microsoft"];

    // 1. Preferred vendor + male
    for (const vendor of preferredVendors) {
      const found = voices.find(v => v.name.includes(vendor) && v.name.toLowerCase().includes("male"));
      if (found) return found;
    }

    // 2. Any male voice
    const maleVoice = voices.find(v => v.name.toLowerCase().includes("male"));
    if (maleVoice) return maleVoice;

    // 3. If no male voice exists for this language, return null (will use default)
    return null;
  }, []);

  // Audio level visualization
  const startAudioLevelMeter = useCallback(async () => {
    if (!streamRef.current) return;
    try {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioContextRef.current.createMediaStreamSource(streamRef.current);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      source.connect(analyserRef.current);

      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      const update = () => {
        if (!analyserRef.current || !recording) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        audioLevelRef.current = average / 255;
        animationFrameRef.current = requestAnimationFrame(update);
      };
      update();
    } catch (e) {
      console.warn("[Voicebot] Audio level meter failed:", e);
    }
  }, [recording]);

  const stopAudioLevelMeter = useCallback(() => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    audioLevelRef.current = 0;
  }, []);

  function speak(text: string) {
    if (!voiceEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);

    const hasDevanagari = /[ऀ-ॿ]/.test(text);
    const hasHinglish = /\b(mai|main|mera|meri|mere|tum|tera|teri|tere|ham|hamara|hamari|kya|kaise|kahan|kab|kyun|kon|acha|accha|theek|thik|haan|nahi|nahin|ji|haanji|nahiji|bas|abhi|ab|kal|aaj|subah|shaam|raat|din|hafta|mahina|saal|kaam|kaam kar|chahiye|chahte|pasand|pasand hai|nahi pasand|achha|accha laga|bura|bura laga|problem|issue|solution|help|madad|shukriya|dhanyawad|sorry|maaf|kripya|please|thank you|thanks)\b/i.test(text);

    const targetLang = hasDevanagari ? "hi-IN" : (hasHinglish ? "hi-IN" : "en-IN");
    const selectedVoice = selectVoiceForLang(targetLang);

    if (selectedVoice) {
      utterance.voice = selectedVoice;
      utterance.lang = selectedVoice.lang;
      setSelectedVoiceName(selectedVoice.name);
      console.log("[Voicebot] Speaking with:", selectedVoice.name, selectedVoice.lang);
    } else {
      utterance.lang = targetLang;
      setSelectedVoiceName("Default (browser)");
      console.log("[Voicebot] No male voice for", targetLang, "- using default");
    }

    utterance.rate = 0.98;
    utterance.pitch = 1;
    utterance.onstart = () => setLoadingState("speaking");
    utterance.onend = () => setLoadingState("idle");
    utterance.onerror = () => setLoadingState("idle");
    window.speechSynthesis.speak(utterance);
  }

  async function ask(text: string, audioBlob?: Blob) {
    const cleaned = text.trim();
    if (!cleaned && !audioBlob) return;
    setError(null);

    const isVoice = !!audioBlob;
    setLoadingState(isVoice ? "transcribing" : "thinking");
    setStatus(isVoice ? "Transcribing your question…" : "Thinking…");

    if (cleaned) setMessages(current => [...current, { role: "user", content: cleaned }]);
    setQuestion("");

    try {
      const form = new FormData();
      if (cleaned) form.append("text", cleaned);
      if (audioBlob) form.append("audio", audioBlob, "question.webm");
      form.append("history", JSON.stringify(messages.slice(-6)));

      const response = await fetch("/api/chat", { method: "POST", body: form });
      const data = await response.json() as { answer?: string; error?: string; transcript?: string; provider?: string; needsConfirmation?: boolean };

      if (!response.ok || !data.answer) {
        if (data.transcript) { setLastTranscript(data.transcript); setQuestion(data.transcript); }
        throw new Error(data.error || "The assistant could not answer that question.");
      }

      if (data.transcript) { setLastTranscript(data.transcript); setMessages(current => [...current, { role: "user", content: data.transcript || "" }]); }
      setMessages(current => [...current, { role: "assistant", content: data.answer || "" }]);
      setProvider(data.provider || "");
      speak(data.answer || "");
      setStatus("Answer ready.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      setError(message);
      setStatus(message);
    } finally {
      setLoadingState("idle");
    }
  }

  async function startRecording() {
    try {
      if (!("MediaRecorder" in window)) throw new Error("This browser does not support microphone recording. Please type your question.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: preferredType });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: preferredType });
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        setRecording(false);
        stopAudioLevelMeter();
        if (blob.size > 0) void ask("", blob);
        else setStatus("No audio was captured. Please try again or type your question.");
      };
      recorder.start(250);
      setRecording(true);
      setStatus("Listening… speak clearly, then click Stop.");
      await startAudioLevelMeter();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone access failed.");
      setStatus(err instanceof Error ? err.message : "Microphone access failed. Please type your question.");
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      setRecording(false);
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
  }

  function stopSpeaking() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setLoadingState("idle");
  }

  function clearConversation() {
    setMessages([{ role: "assistant", content: "Hi, I'm an AI version representing Shishupal. Ask me about my background, projects, strengths or how I approach problems." }]);
    setLastTranscript("");
    setProvider("");
    setSelectedVoiceName("");
    localStorage.removeItem(STORAGE_KEY);
  }

  function exportConversation() {
    const data = { messages, timestamp: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `voicebot-conversation-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExport(false);
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space" && loadingState === "idle" && !recording) { e.preventDefault(); void startRecording(); }
      if (e.code === "Escape") { if (recording) stopRecording(); else if (loadingState === "speaking") stopSpeaking(); }
      if (e.ctrlKey && e.key === "e") { e.preventDefault(); setShowExport(true); }
      if (e.ctrlKey && e.key === "d") { e.preventDefault(); setDarkMode(d => !d); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loadingState, recording]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const formatLevel = (level: number) => Math.round(level * 100);

  return (
    <main className={darkMode ? "dark" : ""}>
      <header>
        <div className="header-content">
          <h1>Shishupal's AI Voice Assistant</h1>
          <p className="subtitle">Ask me about my background, projects, skills, or how I approach problems.</p>
        </div>
        <button className="icon-btn" onClick={() => setDarkMode(d => !d)} aria-label={darkMode ? "Light mode" : "Dark mode"}>
          {darkMode ? "☀️" : "🌙"}
        </button>
      </header>

      <section className="panel" aria-label="Voicebot conversation">
        <div className="transcript" ref={transcriptRef} aria-live="polite">
          {messages.map((message, index) => (
            <div key={`${message.role}-${index}`} className={`message ${message.role}`}>
              <strong>{message.role === "assistant" ? "Shishupal's AI" : "You"}</strong>
              <div>{message.content}</div>
            </div>
          ))}
        </div>

        <div className="status-bar">
          <div className="status-left">
            <span className={`status-indicator ${loadingState}`} aria-hidden="true"></span>
            <span className="status-text">{status}</span>
            {selectedVoiceName && (
              <span className="voice-badge" title="Active TTS voice">
                🔊 {selectedVoiceName}
              </span>
            )}
          </div>
          <div className="status-right">
            {provider && <span className="provider-badge">Provider: {provider}</span>}
            {recording && (
              <span className="recording-indicator" aria-live="polite">
                <span className="pulse" aria-hidden="true"></span>
                REC {formatLevel(audioLevelRef.current)}%
              </span>
            )}
          </div>
        </div>

        {lastTranscript && (
          <p className="transcript-review">
            Last recognised speech: <strong>{lastTranscript}</strong>.
            If it is wrong, edit the text box and press Ask.
          </p>
        )}

        {error && <div className="error-toast" role="alert">{error}</div>}

        <div className="controls">
          <form className="inputrow" onSubmit={e => { e.preventDefault(); void ask(question); }}>
            <input
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="Ask a question in English, Hindi or Hinglish…"
              aria-label="Type your question"
              maxLength={1000}
              disabled={loadingState !== "idle"}
            />
            <button type="submit" disabled={loadingState !== "idle" || !question.trim()} aria-busy={loadingState !== "idle"}>
              {loadingState === "thinking" ? "Thinking…" : loadingState === "transcribing" ? "Transcribing…" : "Ask"}
            </button>
          </form>

          <div className="microw">
            <button
              className={`mic ${recording ? "recording" : ""}`}
              type="button"
              onClick={recording ? stopRecording : () => void startRecording()}
              disabled={loadingState !== "idle"}
              aria-pressed={recording}
              aria-label={recording ? "Stop recording (Esc)" : "Start voice recording (Space)"}
            >
              {recording ? "⏹ Stop" : "🎙 Ask by Voice"}
            </button>
            <button
              type="button"
              onClick={() => setVoiceEnabled(v => !v)}
              aria-pressed={voiceEnabled}
              aria-label={voiceEnabled ? "Disable voice output" : "Enable voice output"}
            >
              {voiceEnabled ? "🔊 Voice: On" : "🔇 Voice: Off"}
            </button>
            <button
              type="button"
              onClick={stopSpeaking}
              disabled={loadingState !== "speaking"}
              aria-label="Stop speaking (Esc)"
            >
              ⏹ Stop Speaking
            </button>
            <button
              type="button"
              onClick={() => setShowExport(true)}
              aria-label="Export conversation"
            >
              💾 Export
            </button>
            <button
              type="button"
              onClick={clearConversation}
              aria-label="Clear conversation"
            >
              🗑 Clear
            </button>
          </div>

          <div className="chips" aria-label="Suggested questions">
            {PROMPTS.map((prompt) => (
              <button
                className="chip"
                type="button"
                key={prompt}
                disabled={loadingState !== "idle"}
                onClick={() => void ask(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>

          <div className="shortcuts">
            <kbd>Space</kbd> Record &nbsp;|&nbsp; <kbd>Esc</kbd> Stop &nbsp;|&nbsp; <kbd>Ctrl+E</kbd> Export &nbsp;|&nbsp; <kbd>Ctrl+D</kbd> Dark mode
          </div>
        </div>
      </section>

      <p className="note">
        This is an AI representation, not the real person. Answers are based on verified profile information.
      </p>

      {showExport && (
        <div className="modal-overlay" onClick={() => setShowExport(false)} role="dialog" aria-modal="true" aria-labelledby="export-title">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 id="export-title">Export Conversation</h3>
            <p>Download the current conversation as JSON.</p>
            <div className="modal-actions">
              <button onClick={exportConversation}>Download JSON</button>
              <button onClick={() => setShowExport(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}