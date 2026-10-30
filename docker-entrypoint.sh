#!/bin/bash
# Docker entrypoint script for Shishupal Interview Voicebot

set -e

echo "Starting Shishupal Interview Voicebot..."

# Function to start backend
start_backend() {
    echo "Starting FastAPI backend on port 8000..."
    cd /app/backend
    python -m uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1 &
    BACKEND_PID=$!
    echo "Backend started with PID: $BACKEND_PID"
}

# Function to start frontend
start_frontend() {
    echo "Starting Next.js frontend on port 3000..."
    cd /app
    # Next.js standalone output runs as a simple node server
    node server.js &
    FRONTEND_PID=$!
    echo "Frontend started with PID: $FRONTEND_PID"
}

# Wait for backend to be healthy
wait_for_backend() {
    echo "Waiting for backend to be ready..."
    local max_attempts=30
    local attempt=1
    while [ $attempt -le $max_attempts ]; do
        if curl -f -s http://localhost:8000/api/v1/health > /dev/null 2>&1; then
            echo "Backend is ready!"
            return 0
        fi
        echo "Attempt $attempt/$max_attempts: Backend not ready yet, waiting..."
        sleep 2
        attempt=$((attempt + 1))
    done
    echo "ERROR: Backend failed to start within timeout"
    return 1
}

# Signal handler
cleanup() {
    echo "Shutting down..."
    if [ ! -z "$BACKEND_PID" ]; then
        kill -TERM "$BACKEND_PID" 2>/dev/null || true
    fi
    if [ ! -z "$FRONTEND_PID" ]; then
        kill -TERM "$FRONTEND_PID" 2>/dev/null || true
    fi
    wait 2>/dev/null || true
    echo "Shutdown complete"
    exit 0
}

trap cleanup SIGTERM SIGINT

# Start services
start_backend
wait_for_backend
start_frontend

# Wait for both processes
wait $BACKEND_PID $FRONTEND_PID