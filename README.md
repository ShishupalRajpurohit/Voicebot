# Shishupal's Voicebot

A minimal Next.js frontend with one FastAPI backend file for the Voice Assistant. It supports text, microphone recording, Groq Whisper speech transcription, reviewed answers for the five sample prompts, Groq-first/OpenRouter-second LLM fallback, and browser speech playback.

## Local setup (Windows PowerShell)

Open one terminal for the Python backend:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
Copy-Item .env.example .env
notepad .env
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Add your real `GROQ_API_KEY` and `OPENROUTER_API_KEY` to `backend/.env`. Leave `GROQ_STT_LANGUAGE` blank for automatic speech-language detection unless you want to force one language. The backend health check is `http://localhost:8000/api/v1/health`.

Keep the first terminal running. Open a second terminal in the project root (the folder containing `package.json`) for the frontend:

```powershell
Copy-Item .env.local.example .env.local
notepad .env.local
npm install
npm run typecheck
npm run dev
```

Set `FASTAPI_BACKEND_URL=http://localhost:8000` inside the frontend `.env.local`, then open `http://localhost:3000`. The browser talks to the same-origin Next.js proxy, which forwards requests to FastAPI. API keys remain only in `backend/.env`. Restart the relevant server after changing environment values.

## Deploy on Vercel

1. Deploy `backend/` to a Python host such as Render or Railway, using `pip install -r requirements.txt` as the build command and `uvicorn main:app --host 0.0.0.0 --port $PORT` as the start command. Set the provider environment variables there; do not commit `backend/.env`.
2. Set the backend allowed origin in its `CORS_ORIGINS` environment variable to your Vercel frontend URL plus any local development origins.
3. Import the Next.js frontend into Vercel and use the default Next.js build settings.
4. Set `FASTAPI_BACKEND_URL` on Vercel to the deployed FastAPI base URL. It is a server-only routing setting, not a secret.
5. Set `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_MODEL`, `GROQ_STT_MODEL`, `GROQ_STT_LANGUAGE`, `OPENROUTER_MODEL`, `APP_URL`, and `MAX_AUDIO_MB` on the Python backend host.
6. Use currently valid provider model IDs for your accounts because model catalogs and free-tier availability can change. Deploy, then test the public URL in an incognito browser without any evaluator-supplied key. Microphone access requires HTTPS and user permission.

## Minimal project layout

- `app/page.tsx` — UI, recording and browser speech playback.
- `app/api/chat/route.ts` — thin same-origin proxy to FastAPI.
- `backend/main.py` — transcription, prepared answer lookup, Groq → OpenRouter fallback, history validation, and request limit.
- `backend/requirements.txt` and `backend/.env.example` — minimal Python dependencies and safe configuration template.
- `app/layout.tsx` and `app/globals.css` — required Next.js layout and page styling.
- `.env.local.example` — placeholder for the frontend-to-backend URL.
- `EXPLANATIONS.md` — architecture explanations and deployment caveats.

## Important behavior

- If speech transcription appears wrong, the app refuses to answer a short, suspicious transcript and places it in the text field for editing. This is deliberate: guessing the intended question is worse than asking for clarification.
- The browser's speech voice varies by device. This does not clone Shishupal's voice.
- The sample answers are intentionally conservative. Confirm that each answer sounds accurate before you submit the assessment.
- The in-memory rate limiter is only a small demonstration safeguard and is not globally coordinated across serverless instances.
