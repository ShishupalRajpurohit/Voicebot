// Use Node.js because this route forwards multipart FormData to the FastAPI backend.
export const runtime = "nodejs";

// Forward browser requests to a separately deployed FastAPI service without handling any AI logic here.
export async function POST(request: Request) {
  // Read the backend base URL from a server-only environment variable, never from client-controlled form data.
  const backendUrl = process.env.FASTAPI_BACKEND_URL?.replace(/\/$/, "");

  // Return a clear configuration error when the API URL has not been configured yet.
  if (!backendUrl) return Response.json({ error: "The voicebot backend is not configured yet. Please try again later." }, { status: 503 });

  try {
    // Parse the incoming browser form so its text, history, and audio can be forwarded as a new multipart request.
    const incoming = await request.formData();
    const outgoing = new FormData();

    // Preserve every accepted form field while retaining the original file name and content type.
    for (const [key, value] of incoming.entries()) {
      if (value instanceof File) outgoing.append(key, value, value.name || "question.webm");
      else outgoing.append(key, value);
    }

    // Forward correlation ID if present (for request tracing)
    const correlationId = request.headers.get("x-correlation-id") || crypto.randomUUID().slice(0, 8);

    // Send user input to FastAPI; the Groq and OpenRouter keys stay exclusively on the Python server.
    const forwardedIp = request.headers.get("x-forwarded-for");
    const response = await fetch(`${backendUrl}/api/v1/chat`, {
      method: "POST",
      headers: {
        ...(forwardedIp ? { "X-Forwarded-For": forwardedIp } : {}),
        "X-Correlation-ID": correlationId
      },
      body: outgoing,
      signal: AbortSignal.timeout(35_000)
    });

    // Return FastAPI's JSON and status code to the browser without leaking server exception details.
    const body = await response.text();
    const responseHeaders: Record<string, string> = {
      "Content-Type": response.headers.get("content-type") || "application/json"
    };
    // Pass through correlation ID
    const returnedCorrelationId = response.headers.get("x-correlation-id");
    if (returnedCorrelationId) responseHeaders["X-Correlation-ID"] = returnedCorrelationId;

    return new Response(body, { status: response.status, headers: responseHeaders });
  } catch (error) {
    // Log only a short error description so keys and user recordings are never written to browser-facing output.
    console.error("FastAPI proxy failed:", error instanceof Error ? error.message : "Unknown error");
    // Give the visitor a recovery option when the backend is unreachable or times out.
    return Response.json({ error: "I couldn't reach the voicebot service. Please try again or type your question." }, { status: 502 });
  }
}
