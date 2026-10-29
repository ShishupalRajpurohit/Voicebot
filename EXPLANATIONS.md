# Code explanations (English)

Every non-empty source line in `backend/main.py`, `app/page.tsx`, `app/api/chat/route.ts`, `app/layout.tsx`, `app/globals.css`, `next.config.ts`, and the environment examples has an adjacent English comment where practical. JSX and CSS sometimes require comments outside a rendered element or selector; those comments explain the complete block immediately beside it.

## Why the project is kept small

- `app/page.tsx` contains the complete user-facing chat, microphone recording, transcript review, and browser speech playback. It avoids adding component files that would not materially improve this assessment prototype.
- `app/api/chat/route.ts` is a small same-origin proxy. It forwards the browser form to FastAPI so browser JavaScript does not need a cross-origin backend URL and does not see provider keys.
- `backend/main.py` contains the FastAPI endpoints, upload checks, Groq Whisper transcription, answer-bank lookup, Groq → OpenRouter fallback, history validation, and basic request throttling in one file to keep the backend easy to inspect.
- `backend/main.py` stores the active verified profile and five assessment answer drafts together, avoiding duplicate persona definitions across TypeScript and Python.
- `app/layout.tsx` and `app/globals.css` provide the required root HTML metadata and compact responsive design.
- `backend/.env` contains the real provider keys locally and should never be committed. `backend/.env.example` contains placeholders only. Frontend `.env.local` contains only `FASTAPI_BACKEND_URL`, not AI provider credentials.

## Reliability decisions

1. The voicebot never invents a question when transcription fails. It surfaces the transcript for correction or asks the user to retry.
2. Prepared answers are used for the five sample prompts to keep those high-priority responses consistent and grounded.
3. Other prompts use Groq first and OpenRouter second. Provider model availability and free-tier limits may change, so values remain configurable.
4. Text chat remains available if microphone permissions or speech recognition fail.
5. Browser speech synthesis is intentionally the minimal text-to-speech option. Its voices differ by browser and device; this is not voice cloning.
6. The in-memory per-IP request counter is only a basic safeguard; serverless instances do not share that counter. For a widely shared production site, add a hosted distributed rate limiter.
7. The five prepared answers are drafts based on facts available from the user profile, not claims about unverified personal events or coworker opinions. Review their wording before submitting.
