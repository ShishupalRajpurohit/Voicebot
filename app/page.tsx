"use client"; // Enable browser microphone, state, and speech synthesis features for this page.

// Import React hooks for chat state, recording and audio playback.
import { useEffect, useRef, useState } from "react"; // Use refs for browser objects and state for visible UI updates.

// Define the shape of a message shown in the conversation transcript.
type Message = { role: "user" | "assistant"; content: string }; // Keep the UI history consistent with the API's accepted message format.

// Provide short starter questions that let an evaluator try the demo immediately.
const prompts = ["What should we know about your life story?", "What's your number-one superpower?", "What are the top three areas you'd like to grow in?", "What misconception might coworkers have about you?", "How do you push your boundaries?"]; // Mirror the assessment's example prompts as one-click demo chips.

// Render the complete interview voicebot interface.
export default function HomePage() { // Define the page component used at the public root URL.
  const [messages, setMessages] = useState<Message[]>([{ role: "assistant", content: "Hi, I'm an AI version representing Sandip. Ask me about my background, projects, strengths or how I approach problems." }]); // Start with a transparent greeting so evaluators know this is an AI representative.
  const [question, setQuestion] = useState(""); // Track text currently entered into the question box.
  const [status, setStatus] = useState("Ready when you are."); // Show what the app is doing in plain language.
  const [busy, setBusy] = useState(false); // Prevent overlapping requests while a response is being generated.
  const [recording, setRecording] = useState(false); // Reflect whether microphone recording is active.
  const [voiceEnabled, setVoiceEnabled] = useState(true); // Let visitors turn spoken answers off if they prefer reading.
  const [provider, setProvider] = useState(""); // Display which model path answered for troubleshooting.
  const [lastTranscript, setLastTranscript] = useState(""); // Keep the most recent speech transcript available for correction.
  const recorderRef = useRef<MediaRecorder | null>(null); // Keep the browser's active recording object between renders.
  const streamRef = useRef<MediaStream | null>(null); // Keep the microphone stream so it can be stopped safely.
  const chunksRef = useRef<BlobPart[]>([]); // Collect audio chunks until the user stops recording.
  const transcriptRef = useRef<HTMLDivElement | null>(null); // Reference the transcript so new messages can be brought into view.

  // Cleanup on unmount: stop any active recording and speech
  useEffect(() => {
    return () => {
      // Stop recording if active
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      // Stop all audio tracks
      streamRef.current?.getTracks().forEach((track) => track.stop());
      // Cancel speech synthesis
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []); // Run once on mount/unmount

  useEffect(() => { // Keep the latest message visible after a reply is added.
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }); // Scroll only the transcript region, not the whole page.
  }, [messages]); // Run the scroll behavior whenever conversation messages change.

  function speak(text: string) { // Read a reply aloud using the browser's built-in speech engine.
    if (!voiceEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) return; // Skip voice when disabled or unsupported by the browser.
    window.speechSynthesis.cancel(); // Stop previous speech so replies do not overlap.
    const utterance = new SpeechSynthesisUtterance(text); // Convert the answer text into a browser speech request.

    // Improved language detection: check for Devanagari, common Hinglish words, and Latin script
    const hasDevanagari = /[\u0900-\u097F]/.test(text);
    const hasHinglish = /\b(mai|main|mera|meri|mere|tum|tera|teri|tere|ham|hamara|hamari|kya|kaise|kahan|kab|kyun|kon|acha|accha|theek|thik|haan|nahi|nahin|ji|haanji|nahiji|bas|abhi|ab|kal|aaj|subah|shaam|raat|din|hafta|mahina|saal|kaam|kaam kar|chahiye|chahte|pasand|pasand hai|nahi pasand|achha|accha laga|bura|bura laga|problem|issue|solution|help|madad|shukriya|dhanyawad|sorry|maaf|kripya|please|thank you|thanks)\b/i.test(text);

    utterance.lang = hasDevanagari ? "hi-IN" : (hasHinglish ? "hi-IN" : "en-IN"); // Select Hindi for Devanagari or Hinglish, English otherwise
    utterance.rate = 0.98; // Use a slightly measured pace for more natural interview-style speech.
    utterance.pitch = 1; // Keep a neutral pitch instead of an exaggerated voice effect.
    window.speechSynthesis.speak(utterance); // Play the answer using a voice available on the visitor's device.
  }

  async function ask(text: string, audioBlob?: Blob) { // Submit either typed text or a recorded audio question.
    const cleaned = text.trim(); // Remove accidental leading and trailing spaces from typed questions.
    if (!cleaned && !audioBlob) return; // Do not send an empty question to the server.
    setBusy(true); // Disable controls until the request finishes.
    setStatus(audioBlob ? "Transcribing your question…" : "Thinking…"); // Tell the visitor which stage is in progress.
    if (cleaned) setMessages((current) => [...current, { role: "user", content: cleaned }]); // Show a typed question immediately in the transcript.
    setQuestion(""); // Clear the input after a valid submission starts.
    try { // Handle network and API errors without breaking the interface.
      const form = new FormData(); // Use multipart form data for text and optional recorded audio.
      if (cleaned) form.append("text", cleaned); // Send text input when provided.
      if (audioBlob) form.append("audio", audioBlob, "question.webm"); // Attach the microphone recording when this is a voice question.
      form.append("history", JSON.stringify(messages.slice(-6))); // Send only a small recent history window to preserve conversational context.
      const response = await fetch("/api/chat", { method: "POST", body: form }); // Call our own backend so private provider keys stay on the server.
      const data = await response.json() as { answer?: string; error?: string; transcript?: string; provider?: string; needsConfirmation?: boolean }; // Parse the typed response from the API route.
      if (!response.ok || !data.answer) { // Handle transcription confirmation separately so the user can correct recognition errors.
        if (data.transcript) { setLastTranscript(data.transcript); setQuestion(data.transcript); } // Put the uncertain transcript in the text box where the user can edit it.
        throw new Error(data.error || "The assistant could not answer that question."); // Convert API failures into a friendly message.
      }
      if (data.transcript) { setLastTranscript(data.transcript); setMessages((current) => [...current, { role: "user", content: data.transcript || "" }]); } // Show the recognized question only after the backend accepted it.
      setMessages((current) => [...current, { role: "assistant", content: data.answer || "" }]); // Add the assistant's answer to the transcript.
      setProvider(data.provider || ""); // Store the provider label for the small diagnostics line.
      speak(data.answer || ""); // Speak the answer when voice output is enabled and supported.
      setStatus("Answer ready."); // Return the status to a calm completed state.
    } catch (error) { // Handle unavailable network, provider and browser errors.
      const message = error instanceof Error ? error.message : "Something went wrong. Please try again."; // Extract a readable error message.
      setStatus(message); // Surface the problem in the status line rather than hiding it.
    } finally { // Always restore the input controls when the request completes.
      setBusy(false); // Allow the visitor to ask another question.
    }
  }

  async function startRecording() { // Ask for microphone access and begin capturing the question.
    try { // Handle browsers that deny permission or do not support recording.
      if (!("MediaRecorder" in window)) throw new Error("This browser does not support microphone recording. Please type your question."); // Check recording support before opening the microphone.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // Request microphone access only after the visitor clicks the mic button.
      streamRef.current = stream; // Keep the stream so all microphone tracks can be stopped later.
      const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm"; // Prefer the widely supported compressed WebM format.
      const recorder = new MediaRecorder(stream, { mimeType: preferredType }); // Create a recorder using the selected supported format.
      recorderRef.current = recorder; // Store the recorder so the stop button can access it.
      chunksRef.current = []; // Clear any chunks from an earlier recording.
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); }; // Collect non-empty audio chunks emitted by the browser.
      recorder.onstop = () => { const blob = new Blob(chunksRef.current, { type: preferredType }); stream.getTracks().forEach((track) => track.stop()); streamRef.current = null; setRecording(false); if (blob.size > 0) void ask("", blob); else setStatus("No audio was captured. Please try again or type your question."); }; // Package the audio, release the microphone and send the recording for transcription.
      recorder.start(250); // Collect audio in short chunks so the browser can build the recording progressively.
      setRecording(true); // Update the button label and recording indicator.
      setStatus("Listening… speak clearly, then click Stop. You can review the transcript before sending."); // Explain how to end recording without relying on hidden auto-stop behavior.
    } catch (error) { // Show a useful fallback when microphone setup fails.
      setStatus(error instanceof Error ? error.message : "Microphone access failed. Please type your question."); // Preserve text chat as the fallback path.
      streamRef.current?.getTracks().forEach((track) => track.stop()); // Release any stream opened before the failure occurred.
      streamRef.current = null; // Clear the stored stream reference.
      setRecording(false); // Ensure the UI no longer claims recording is active.
    }
  }

  function stopRecording() { // Stop the current recording and trigger the recorder's onstop handler.
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop(); // Stop only an active recorder to avoid browser exceptions.
  }

  function stopSpeaking() { // Allow the visitor to interrupt the spoken answer.
    if ("speechSynthesis" in window) window.speechSynthesis.cancel(); // Cancel browser speech immediately when the visitor clicks Stop speaking.
  }

  return ( // Render the page with a header, transcript, text input, mic and prompt chips.
    <main>
      <header><div><div className="eyebrow">100x · Gen AI assessment</div><h1>Meet Sandip’s AI voicebot</h1><p>An interactive, profile-grounded assistant for questions about my work and approach.</p></div></header>
      <section className="panel" aria-label="Voicebot conversation">
        <div className="transcript" ref={transcriptRef} aria-live="polite">{messages.map((message, index) => <div className={`message ${message.role}`} key={`${message.role}-${index}`}><strong>{message.role === "assistant" ? "Sandip’s AI" : "You"}</strong><div>{message.content}</div></div>)}</div>
        <div className="status" role="status">{status}{provider ? ` · Response source: ${provider}` : ""}</div>
        {lastTranscript ? <p className="transcript-review">Last recognised speech: <strong>{lastTranscript}</strong>. If it is wrong, edit the text box and press Ask.</p> : null}
        <div className="controls">
          <form className="inputrow" onSubmit={(event) => { event.preventDefault(); void ask(question); }}><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a question in English, Hindi or Hinglish…" aria-label="Type your question" maxLength={2000} /><button type="submit" disabled={busy || !question.trim()}>Ask</button></form>
          <div className="microw"><button className="mic" type="button" onClick={recording ? stopRecording : () => void startRecording()} disabled={busy}>{recording ? "Stop recording" : "🎙 Ask by voice"}</button><button type="button" onClick={() => setVoiceEnabled((enabled) => !enabled)}>{voiceEnabled ? "Voice: on" : "Voice: off"}</button><button type="button" onClick={stopSpeaking}>Stop speaking</button></div>
          <div className="chips" aria-label="Suggested questions">{prompts.map((prompt) => <button className="chip" type="button" key={prompt} disabled={busy} onClick={() => void ask(prompt)}>{prompt}</button>)}</div>
        </div>
      </section>
      <p className="note">This is an AI representation, not the real person. Answers are based on verified profile information and may not cover every personal detail.</p>
    </main>
  );
}
