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
# - a refresh pass no longer runs inside a request at all: /api/refresh claims
#   the slot, hands the fetch to a background thread and returns 202, so the
#   worker timeout below is liveness-only and the 8 threads stay free to serve
#   the UI while a pass runs. Auto-sync calls _run_refresh on its own thread
#   and is unaffected either way.
# - that pass can be long: FLEX_MAX_POLLS x FLEX_POLL_INTERVAL is 1800s per
#   query by default (env-overridable, capped at BUDGET_CEILING_SEC = 3600),
#   and queries are fetched serially, so a two-query ACCOUNTS can occupy that
#   background thread for twice as long. Nothing waits on it.
CMD ["gunicorn", "-w", "1", "--threads", "8", "-b", "0.0.0.0:8000", "--timeout", "120", "app:app"]
