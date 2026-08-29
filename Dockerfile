FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . .

ENV PORT=8000
EXPOSE 8000

# Single worker + thread pool, on purpose:
# - app.py's refresh cooldown/lock is in-process state, so it is only
#   authoritative with exactly one worker. More workers would let refreshes
#   run concurrently and bypass the IBKR throttle guard.
# - gthread heartbeats from its accept loop, not per-request, so a long
#   /api/refresh (up to ~900s per account — see FLEX_MAX_POLLS — accounts
#   fetched serially) can't trip the worker timeout the way sync workers
#   would. Timeout is liveness-only here; other threads keep serving the UI
#   meanwhile. That budget now outlasts any browser/proxy patience: the
#   button's HTTP response can be lost while the fetch itself runs to
#   completion and writes. Auto-sync calls _run_refresh in-process and is
#   unaffected either way.
CMD ["gunicorn", "-w", "1", "--threads", "8", "-b", "0.0.0.0:8000", "--timeout", "120", "app:app"]
