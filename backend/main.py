# Load local environment values from backend/.env while keeping deployed secrets in host settings.
from dotenv import load_dotenv  # Read a local .env file without requiring manual API keys from website visitors.
load_dotenv()  # Load environment values before reading any provider configuration.

# Import standard-library helpers for environment settings, JSON history, time windows, and typing.
import asyncio  # Async sleep for retry backoff
import json  # Parse the small chat history sent by the browser.
import logging  # Structured logging for request tracing and debugging.
import os  # Read API keys and model names from environment variables.
import random  # Jitter for exponential backoff
import re  # Detect a few suspicious one-word transcription results.
import time  # Track a basic per-process request limit.
import uuid  # Generate correlation IDs for request tracing.
from dataclasses import dataclass, field  # Circuit breaker state
from typing import Any  # Describe the flexible JSON values returned by providers.
from typing import Annotated  # For pydantic field constraints

# Import pydantic for input validation
from pydantic import BaseModel, Field, field_validator  # Type-safe request/response models

# Import the small web server, multipart-upload support, and asynchronous HTTP client.
import httpx  # Call Groq and OpenRouter without exposing provider keys to the browser.
from fastapi import FastAPI, Request  # Define the API and read multipart text/audio requests.
from fastapi.middleware.cors import CORSMiddleware  # Allow a deployed frontend to call this backend directly if needed.
from fastapi.responses import JSONResponse  # Return clear JSON responses for validation and provider errors.
from starlette.middleware.base import BaseHTTPMiddleware  # Base class for custom middleware.
from starlette.responses import Response  # Response type for middleware.

# Import Redis for distributed rate limiting (optional dependency)
try:
    import redis.asyncio as redis  # Async Redis client for distributed rate limiting across instances
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False  # Gracefully degrade to in-memory if Redis not installed

# Import persona and QA profile from data files
from data_loader import PERSONA, find_prepared_answer, find_similar_prepared_answer, FALLBACK_RESPONSE, MAX_HISTORY_TURNS

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger("voicebot")


# Pydantic models for type-safe request/response validation
class ChatRequest(BaseModel):
    """Validated chat request from frontend proxy."""
    text: str = Field(default="", max_length=1000)
    history: list[dict[str, str]] = Field(default_factory=list)

    @field_validator("text")
    @classmethod
    def validate_text(cls, v: str) -> str:
        # Reject control characters (except newline/tab)
        if re.search(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]", v):
            raise ValueError("Question contains invalid characters.")
        return v.strip()

    @field_validator("history")
    @classmethod
    def validate_history(cls, v: list[dict[str, str]]) -> list[dict[str, str]]:
        # Keep only valid message roles and last 6 entries
        valid = [
            item for item in v
            if isinstance(item, dict)
            and item.get("role") in {"user", "assistant"}
            and isinstance(item.get("content"), str)
        ]
        return valid[-6:]


class HealthResponse(BaseModel):
    """Validated health check response."""
    status: str
    service: str
    redis: str | None = None
    providers: dict[str, bool]
    circuit_breakers: dict[str, dict[str, Any]] | None = None


class ChatResponse(BaseModel):
    """Validated chat response."""
    answer: str
    provider: str
    transcript: str | None = None


class ChatErrorResponse(BaseModel):
    """Validated chat error response."""
    error: str
    transcript: str | None = None
    needsConfirmation: bool | None = None


def get_correlation_id(request: Request) -> str:
    """Extract or generate correlation ID for request tracing."""
    return request.headers.get("x-correlation-id") or str(uuid.uuid4())[:8]

# Read provider settings once when the server starts; no provider key is ever sent to the client.
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")  # Use Groq for Whisper transcription and primary LLM responses.
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")  # Use OpenRouter as the LLM fallback.
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")  # Keep the Groq chat model configurable from the hosting dashboard.
GROQ_STT_MODEL = os.getenv("GROQ_STT_MODEL", "whisper-large-v3")  # Prefer Whisper Large v3 for accuracy-sensitive speech recognition.
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openrouter/free")  # Ask OpenRouter to route to an available free model by default.
APP_URL = os.getenv("APP_URL", "https://example.com")  # Identify the app to OpenRouter; replace with the deployed frontend URL.
MAX_AUDIO_MB = float(os.getenv("MAX_AUDIO_MB", "12"))  # Limit audio upload size before forwarding it to the transcription provider.
MAX_AUDIO_DURATION_SECONDS = int(os.getenv("MAX_AUDIO_DURATION_SECONDS", "60"))  # Max audio duration in seconds
RATE_LIMIT = int(os.getenv("RATE_LIMIT_PER_MINUTE", "20"))  # Restrict accidental bursts against the provider keys.

# Rate limiter configuration — use Redis if available, otherwise in-memory fallback
REDIS_URL = os.getenv("REDIS_URL", "").strip()  # Redis connection string; empty = use in-memory
RATE_WINDOW_SECONDS = 60  # Sliding window size in seconds

# Distributed rate limiter using Redis sorted sets (sliding window)
class RateLimiter:
    """Sliding-window rate limiter with Redis backend and in-memory fallback."""

    def __init__(self) -> None:
        self._redis: redis.Redis | None = None
        self._local: dict[str, list[float]] = {}  # Fallback: client_key -> list of request timestamps

    async def init(self) -> None:
        """Initialize Redis connection if configured and available."""
        if REDIS_URL and REDIS_AVAILABLE:
            try:
                self._redis = redis.from_url(REDIS_URL, encoding="utf-8", decode_responses=True)
                await self._redis.ping()  # Verify connection
            except Exception:
                self._redis = None  # Fall back to in-memory on connection failure

    async def close(self) -> None:
        """Close Redis connection on shutdown."""
        if self._redis:
            await self._redis.close()

    async def is_limited(self, client_key: str) -> bool:
        """
        Check if client has exceeded rate limit using sliding window.
        Returns True if limited (should reject), False if allowed.
        """
        now = time.time()
        window_start = now - RATE_WINDOW_SECONDS

        if self._redis:
            # Redis sliding window using sorted set (timestamp as score)
            pipe = self._redis.pipeline()
            pipe.zremrangebyscore(f"ratelimit:{client_key}", 0, window_start)  # Remove expired entries
            pipe.zcard(f"ratelimit:{client_key}")  # Count current requests in window
            pipe.zadd(f"ratelimit:{client_key}", {str(now): now})  # Add current request
            pipe.expire(f"ratelimit:{client_key}", RATE_WINDOW_SECONDS + 1)  # Auto-expire key
            results = await pipe.execute()
            current_count = results[1]
            return current_count >= RATE_LIMIT
        else:
            # In-memory fallback: filter timestamps within window
            timestamps = self._local.get(client_key, [])
            timestamps = [ts for ts in timestamps if ts > window_start]
            if len(timestamps) >= RATE_LIMIT:
                return True
            timestamps.append(now)
            self._local[client_key] = timestamps
            return False

# Single rate limiter instance for the application
rate_limiter = RateLimiter()


# Circuit breaker for provider resilience
@dataclass
class CircuitBreaker:
    """Circuit breaker to prevent cascading failures when a provider is down."""

    failure_threshold: int = 3  # Number of failures before opening circuit
    recovery_timeout: float = 30.0  # Seconds before attempting recovery
    half_open_max_calls: int = 2  # Max calls in half-open state

    failures: int = field(default=0, init=False)
    last_failure_time: float = field(default=0, init=False)
    state: str = field(default="closed", init=False)  # closed, open, half-open
    half_open_calls: int = field(default=0, init=False)

    def record_success(self) -> None:
        """Record a successful call - reset failures and close circuit."""
        self.failures = 0
        self.state = "closed"
        self.half_open_calls = 0

    def record_failure(self) -> None:
        """Record a failure - increment counter and potentially open circuit."""
        self.failures += 1
        self.last_failure_time = time.time()
        if self.failures >= self.failure_threshold:
            self.state = "open"
            logger.warning(f"Circuit breaker opened after {self.failures} failures")

    def can_execute(self) -> bool:
        """Check if a call can be executed based on circuit state."""
        if self.state == "closed":
            return True
        if self.state == "open":
            # Check if recovery timeout has passed
            if time.time() - self.last_failure_time >= self.recovery_timeout:
                self.state = "half-open"
                self.half_open_calls = 0
                logger.info("Circuit breaker entering half-open state")
                return True
            return False
        # half-open state
        return self.half_open_calls < self.half_open_max_calls

    def record_half_open_call(self) -> None:
        """Record a call attempt in half-open state."""
        if self.state == "half-open":
            self.half_open_calls += 1


# Circuit breakers for each provider
groq_circuit = CircuitBreaker()
openrouter_circuit = CircuitBreaker()


async def retry_with_backoff(
    func,
    *args,
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 10.0,
    circuit: CircuitBreaker | None = None,
    **kwargs
):
    """
    Execute a function with exponential backoff and jitter.
    Respects circuit breaker state if provided.
    """
    last_exception = None

    for attempt in range(max_retries + 1):
        # Check circuit breaker before attempting
        if circuit and not circuit.can_execute():
            raise RuntimeError(f"Circuit breaker is {circuit.state} - provider unavailable")

        try:
            result = await func(*args, **kwargs)
            if circuit:
                circuit.record_success()
            return result
        except Exception as exc:
            last_exception = exc
            if circuit:
                circuit.record_failure()
                # If circuit opened, don't retry
                if circuit.state == "open":
                    break

            if attempt < max_retries:
                # Exponential backoff with jitter: delay = base * 2^attempt + random jitter
                delay = min(base_delay * (2 ** attempt) + random.uniform(0, 0.5), max_delay)
                logger.warning(f"Attempt {attempt + 1} failed: {type(exc).__name__}; retrying in {delay:.2f}s")
                await asyncio.sleep(delay)
            else:
                logger.error(f"All {max_retries + 1} attempts failed: {type(last_exception).__name__}")

    raise last_exception


# Create the small API application with built-in interactive docs at /docs.
app = FastAPI(title="Shishupal Interview Voicebot API", version="1.0.0", description="A profile-grounded voice and text interview demo.")  # Keep server metadata descriptive and easy to discover.

# Permit browser calls from the local frontend and an optional deployed frontend origin.
cors_origins_env = os.getenv("CORS_ORIGINS", "").strip()
if cors_origins_env:
    allowed_origins = [origin.strip() for origin in cors_origins_env.split(",") if origin.strip()]
else:
    # Default to localhost only — require explicit configuration for production
    allowed_origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
    import warnings
    warnings.warn("CORS_ORIGINS not set — defaulting to localhost. Set CORS_ORIGINS in production!", RuntimeWarning)

app.add_middleware(CORSMiddleware, allow_origins=allowed_origins, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "Authorization"])  # Restrict cross-origin calls to configured frontend origins.

# Add security headers middleware to protect against common web vulnerabilities
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to all responses."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        # Prevent clickjacking
        response.headers["X-Frame-Options"] = "DENY"
        # Prevent MIME type sniffing
        response.headers["X-Content-Type-Options"] = "nosniff"
        # Enable XSS protection (legacy but harmless)
        response.headers["X-XSS-Protection"] = "1; mode=block"
        # Referrer policy
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        # Content Security Policy — restrictive but allows inline styles/scripts for this demo
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "font-src 'self'; "
            "connect-src 'self'; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self'"
        )
        # HSTS — only enable in production with HTTPS
        if request.url.scheme == "https":
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        # Permissions-Policy — restrict browser features
        response.headers["Permissions-Policy"] = (
            "accelerometer=(), "
            "ambient-light-sensor=(), "
            "autoplay=(), "
            "battery=(), "
            "camera=(), "
            "cross-origin-isolated=(), "
            "display-capture=(), "
            "document-domain=(), "
            "encrypted-media=(), "
            "execution-while-not-rendered=(), "
            "execution-while-out-of-viewport=(), "
            "fullscreen=(), "
            "geolocation=(), "
            "gyroscope=(), "
            "hid=(), "
            "identity-credentials-get=(), "
            "idle-detection=(), "
            "keyboard-map=(), "
            "local-fonts=(), "
            "magnetometer=(), "
            "microphone=(self), "  # Allow microphone for voice recording
            "midi=(), "
            "navigation-override=(), "
            "otp-credentials=(), "
            "payment=(), "
            "picture-in-picture=(), "
            "publickey-credentials-get=(), "
            "screen-wake-lock=(), "
            "serial=(), "
            "speaker-selection=(), "
            "sync-xhr=(), "
            "usb=(), "
            "web-share=(), "
            "window-management=(), "
            "xr-spatial-tracking=()"
        )
        return response

app.add_middleware(SecurityHeadersMiddleware)  # Apply security headers to all responses


# Initialize rate limiter on startup
@app.on_event("startup")
async def startup_event() -> None:
    await rate_limiter.init()  # Connect to Redis if configured

# Close rate limiter on shutdown
@app.on_event("shutdown")
async def shutdown_event() -> None:
    await rate_limiter.close()  # Clean up Redis connection


# Return basic health status so the hosting platform can confirm that the backend is running.
@app.get("/api/v1/health")  # Expose a lightweight health-check endpoint.
async def health() -> dict[str, Any]:  # Use Any to allow flexible response structure.
    health_info: dict[str, Any] = {"status": "ok", "service": "shishupal-voicebot-api"}  # Base health info.

    # Check Redis connectivity if configured
    if REDIS_URL and REDIS_AVAILABLE and rate_limiter._redis:
        try:
            await rate_limiter._redis.ping()
            health_info["redis"] = "connected"
        except Exception:
            health_info["redis"] = "disconnected"
            health_info["status"] = "degraded"
    elif REDIS_URL:
        health_info["redis"] = "unavailable (redis package not installed)"

    # Check provider key configuration (without exposing keys)
    health_info["providers"] = {
        "groq_configured": bool(GROQ_API_KEY),
        "openrouter_configured": bool(OPENROUTER_API_KEY)
    }

    # Circuit breaker status
    health_info["circuit_breakers"] = {
        "groq": {"state": groq_circuit.state, "failures": groq_circuit.failures},
        "openrouter": {"state": openrouter_circuit.state, "failures": openrouter_circuit.failures}
    }

    # Overall status considers circuit breakers
    if groq_circuit.state == "open" and openrouter_circuit.state == "open":
        health_info["status"] = "degraded"

    return health_info  # Return detailed health for monitoring.

# Make one chat-completion call using the common OpenAI-compatible provider format.
async def ask_provider(base_url: str, api_key: str, model: str, messages: list[dict[str, str]], openrouter: bool = False) -> str:  # Share request logic between the two providers.
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}  # Keep authentication on the backend only.
    if openrouter:  # Add OpenRouter-specific attribution headers only for its API.
        headers["HTTP-Referer"] = APP_URL  # Help OpenRouter associate usage with the deployed app.
        headers["X-Title"] = "Shishupal Interview Voicebot"  # Give the request a recognisable application label.
    payload = {"model": model, "messages": messages, "temperature": 0.55, "max_tokens": 240}  # Keep answers short and conversational for spoken playback.
    async with httpx.AsyncClient(timeout=18.0) as client:  # Set a finite timeout so a slow provider cannot hang a request indefinitely.
        response = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)  # Submit the persona and recent history to the provider.
    if response.status_code >= 400:  # Treat provider errors as failures so a backup can be attempted.
        raise RuntimeError(f"{model} returned HTTP {response.status_code}")  # Log the model and status without logging the API key or prompt.
    body: dict[str, Any] = response.json()  # Decode the OpenAI-compatible JSON response.
    answer = body.get("choices", [{}])[0].get("message", {}).get("content", "")  # Extract the first assistant message if present.
    if isinstance(answer, list):  # Handle providers that return text content as an array of parts.
        answer = " ".join(part.get("text", "") for part in answer if isinstance(part, dict))  # Join only text parts into one response string.
    answer = str(answer).strip()  # Normalize content into a clean string before returning it.
    if not answer:  # Do not treat an empty model response as success.
        raise RuntimeError("The selected model returned an empty response")  # Allow provider fallback or a clear API error.
    return answer  # Return the response text without provider-specific metadata.

# Run Groq first and use OpenRouter when Groq is missing or fails.
async def generate_answer(question: str, history: list[dict[str, str]]) -> tuple[str, str]:  # Return the answer and a source label for diagnostics.
    # Try exact pattern match first
    prepared = find_prepared_answer(question)
    if prepared:
        return prepared, "Prepared answer"

    # Try similar question match (keyword overlap)
    similar = find_similar_prepared_answer(question)
    if similar:
        return similar, "Prepared answer (similar)"

    # No prepared answer found - use LLM with persona
    messages = [{"role": "system", "content": PERSONA}, *history[-MAX_HISTORY_TURNS:], {"role": "user", "content": question}]  # Limit history to recent turns and put persona rules first.
    if GROQ_API_KEY:  # Attempt the primary model only when its key exists.
        try:  # Allow the fallback provider to handle rate limits and temporary Groq failures.
            answer = await retry_with_backoff(
                ask_provider,
                "https://api.groq.com/openai/v1",
                GROQ_API_KEY,
                GROQ_MODEL,
                messages,
                max_retries=2,
                base_delay=1.0,
                max_delay=5.0,
                circuit=groq_circuit,
            )  # Call Groq with retry and circuit breaker
            return answer, "Groq"  # Report the actual provider used to the frontend.
        except Exception as exc:  # Catch provider and network failures without exposing them to website visitors.
            logger.warning(f"Groq generation failed; trying OpenRouter: {type(exc).__name__}")  # Log only the error type, not secrets or user audio.
    if OPENROUTER_API_KEY:  # Try the fallback when Groq is unavailable or failed.
        answer = await retry_with_backoff(
            ask_provider,
            "https://openrouter.ai/api/v1",
            OPENROUTER_API_KEY,
            OPENROUTER_MODEL,
            messages,
            openrouter=True,
            max_retries=2,
            base_delay=1.0,
            max_delay=5.0,
            circuit=openrouter_circuit,
        )  # Request the same grounded response from OpenRouter with retry
        return answer, "OpenRouter"  # Tell the frontend which provider succeeded.

    # No providers available - return fallback response
    return FALLBACK_RESPONSE, "Fallback (no provider)"

# Apply basic rate limiting before expensive transcription or LLM calls.
async def rate_limited(client_key: str) -> bool:  # Check whether a client has exceeded the configured minute window.
    return await rate_limiter.is_limited(client_key)  # Delegate to sliding-window limiter (Redis or in-memory)

# Accept multipart text or recorded audio and return a JSON answer plus the recognised transcript.
@app.post("/api/v1/chat")  # Keep both text and voice behind one public endpoint.
async def chat(request: Request) -> JSONResponse:  # Read form values manually so text and audio share one compact request contract.
    correlation_id = get_correlation_id(request)  # Track request across logs
    forwarded_ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip()  # Read the browser-facing IP forwarded by the same-origin proxy when available.
    client_key = forwarded_ip or (request.client.host if request.client else "unknown-client")  # Fall back to the TCP peer address when no forwarded IP exists.

    logger.info(f"[{correlation_id}] Request from {client_key}")

    if await rate_limited(client_key):  # Apply the small per-process abuse guard before doing provider work.
        logger.warning(f"[{correlation_id}] Rate limited: {client_key}")
        return JSONResponse({"error": "Too many requests. Please wait a minute and try again."}, status_code=429, headers={"X-Correlation-ID": correlation_id})  # Tell the user when they may retry.
    try:  # Keep malformed uploads and provider failures inside a controlled JSON error boundary.
        form = await request.form()  # Parse the multipart form sent by the browser proxy.

        # --- Text input validation ---
        raw_text = form.get("text", "")
        if not isinstance(raw_text, str):
            return JSONResponse({"error": "Invalid text input."}, status_code=400, headers={"X-Correlation-ID": correlation_id})
        question = raw_text.strip()  # Remove accidental leading/trailing spaces

        # Validate text length and content
        MAX_QUESTION_LENGTH = 1000  # Reduced from 2000 for safety
        if len(question) > MAX_QUESTION_LENGTH:
            return JSONResponse({"error": f"Please keep your question under {MAX_QUESTION_LENGTH} characters."}, status_code=413, headers={"X-Correlation-ID": correlation_id})

        # Basic sanitization: reject control characters (except newline/tab)
        if re.search(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]", question):
            return JSONResponse({"error": "Question contains invalid characters."}, status_code=400, headers={"X-Correlation-ID": correlation_id})

        # --- Audio input handling ---
        audio = form.get("audio")  # Read the optional microphone recording field.
        transcript = ""  # Track the recognised speech so it can be reviewed in the UI.

        if not question and hasattr(audio, "read"):  # Run STT only when no typed question was sent and a file is present.
            audio_bytes = await audio.read()  # Read the uploaded recording into memory for the short voice request.
            if not audio_bytes:  # Reject empty recordings before calling the transcription API.
                return JSONResponse({"error": "The recording was empty. Please try again or type your question."}, status_code=400, headers={"X-Correlation-ID": correlation_id})

            # Validate audio size
            MAX_AUDIO_BYTES = int(MAX_AUDIO_MB * 1024 * 1024)
            if len(audio_bytes) > MAX_AUDIO_BYTES:
                return JSONResponse({"error": f"That recording is too large. Maximum size is {MAX_AUDIO_MB} MB."}, status_code=413, headers={"X-Correlation-ID": correlation_id})

            # Validate audio duration (estimate from file size for common formats)
            # Rough estimate: 128 kbps = 16 KB/sec, so max bytes ≈ MAX_AUDIO_DURATION_SECONDS * 16000
            # This is a heuristic since we can't parse duration without additional libraries
            estimated_max_bytes = MAX_AUDIO_DURATION_SECONDS * 16000
            if len(audio_bytes) > estimated_max_bytes:
                logger.warning(f"Audio file size ({len(audio_bytes)} bytes) may exceed {MAX_AUDIO_DURATION_SECONDS}s duration limit")

            # Validate content type (basic check) — accept base MIME type even with codec params (e.g., "audio/webm;codecs=opus")
            content_type = getattr(audio, "content_type", None) or "audio/webm"
            allowed_audio_types = {"audio/webm", "audio/ogg", "audio/wav", "audio/mpeg", "audio/mp4", "audio/mp3"}
            base_content_type = content_type.split(";")[0].strip().lower()
            if base_content_type not in allowed_audio_types:
                return JSONResponse({"error": "Unsupported audio format. Please use WebM, OGG, WAV, or MP3."}, status_code=415, headers={"X-Correlation-ID": correlation_id})

            if not GROQ_API_KEY:  # Whisper is provided by Groq in this minimal voice pipeline.
                return JSONResponse({"error": "Voice recognition is unavailable right now. Please type your question instead."}, status_code=503, headers={"X-Correlation-ID": correlation_id})

            # Sanitize filename — use only extension from original
            filename = getattr(audio, "filename", None) or "question.webm"
            # Extract safe extension
            safe_ext = ".webm"
            if "." in filename:
                ext = filename.rsplit(".", 1)[-1].lower()
                if ext in {"webm", "ogg", "wav", "mp3", "mp4", "m4a"}:
                    safe_ext = f".{ext}"
            safe_filename = f"question{safe_ext}"

            transcription_data = {"model": GROQ_STT_MODEL, "temperature": "0", "response_format": "json", "prompt": "Transcribe the speaker's exact words verbatim. Do not paraphrase or replace them with a guessed question."}  # Ask for literal speech instead of an inferred intent.
            language = os.getenv("GROQ_STT_LANGUAGE", "").strip()  # Read an optional fixed language but allow automatic detection by default.
            if language:  # Only set language when a deployment explicitly configures one.
                transcription_data["language"] = language  # Avoid forcing English when the user may speak Hindi or Hinglish.

            files = {"file": (safe_filename, audio_bytes, content_type)}  # Attach the recording using the exact multipart field expected by Groq.
            async with httpx.AsyncClient(timeout=28.0) as client:  # Allow speech recognition longer than a short text completion.
                stt_response = await client.post("https://api.groq.com/openai/v1/audio/transcriptions", headers={"Authorization": f"Bearer {GROQ_API_KEY}"}, data=transcription_data, files=files)  # Keep the Groq credential out of the user's browser.

            if stt_response.status_code >= 400:  # Do not silently replace failed transcription with a guessed question.
                raise RuntimeError(f"Groq transcription returned HTTP {stt_response.status_code}")  # Let the API error handler return a safe retry message.

            transcript = str(stt_response.json().get("text", "")).strip()  # Read the literal transcript supplied by Whisper.
            question = transcript  # Use only the actual transcript as the question; never infer what the user meant.

            if len(question) < 2:  # Reject empty or unusably short transcription results.
                return JSONResponse({ "error": "I couldn't recognise enough speech. Please try again or type your question.", "transcript": transcript }, status_code=422, headers={ "X-Correlation-ID": correlation_id })

            # Improved suspicious transcript detection
            suspicious_pattern = re.compile(
                r"^(?:thank you|thanks|you|use|okay|ok|hmm|um|uh|yeah|yes|no|hi|hello|hey|what|who|how|why|when|where|the|a|an|is|it|this|that|and|or|but|so|then|there|here|i|we|my|your|our|their|his|her|me|us|them|him|her|she|he|they|we|i am|i'm|you are|you're|it is|it's|that is|that's|there is|there's|what is|what's|how is|how's|who is|who's|where is|where's|when is|when's|why is|why's)[.!? ]*$",
                re.IGNORECASE
            )
            if suspicious_pattern.fullmatch(question):
                return JSONResponse({ "error": f'I heard "{question}", but I may have misheard you. Please edit the text box or record again.', "transcript": transcript, "needsConfirmation": True }, status_code=422, headers={ "X-Correlation-ID": correlation_id })

        if not question:  # Validate the request even if both text and file were absent.
            return JSONResponse({ "error": "Please ask a question by voice or type it in the box." }, status_code=400, headers={ "X-Correlation-ID": correlation_id })

        history: list[dict[str, str]] = []  # Start with no previous context if none is sent.
        try:  # Validate browser history before inserting it into the model conversation.
            raw_history = json.loads(str(form.get("history", "[]")))  # Parse the JSON history field from the multipart form.
            if isinstance(raw_history, list):  # Ignore malformed history containers.
                history = [item for item in raw_history if isinstance(item, dict) and item.get("role") in {"user", "assistant"} and isinstance(item.get("content"), str)][-6:]  # Keep only valid message roles and the last six entries.
        except (json.JSONDecodeError, TypeError):  # A malformed history should not prevent the current question from being answered.
            history = []  # Continue with an empty context when history cannot be parsed.

        answer, provider = await generate_answer(question, history)  # Select a golden answer or call Groq with OpenRouter fallback.
        logger.info(f"[{correlation_id}] Response from {provider}, length={len(answer)}")
        return JSONResponse({ "answer": answer, "provider": provider, "transcript": transcript or None }, headers={ "X-Correlation-ID": correlation_id })  # Return only UI-required output fields.
    except Exception as exc:  # Handle unexpected parsing, network, and model failures at the API boundary.
        logger.error(f"[{correlation_id}] Request failed: {type(exc).__name__}: {exc}")
        return JSONResponse({ "error": "Sorry, I'm having trouble right now. Please try again, or type your question." }, status_code=502, headers={ "X-Correlation-ID": correlation_id })  # Keep the public-facing error understandable.
