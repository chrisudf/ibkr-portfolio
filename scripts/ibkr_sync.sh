#!/usr/bin/env bash
#
# ============================================================================
# ibkr_sync.sh — Pull IBKR Activity Flex CSV and push it to the dashboard.
# ============================================================================
#
# WHAT THIS SCRIPT DOES (high level)
# -----------------------------------
#   1. Reads credentials from scripts/sync.env (gitignored).
#   2. For each (TOKEN, QUERY_ID) pair in $ACCOUNTS:
#        a. POST  FlexStatementService.SendRequest    → server returns a
#           ReferenceCode (the queued report's ID).
#        b. Poll  FlexStatementService.GetStatement   every 5 seconds, up to
#           30 times (2.5 min total). While IBKR is still building the CSV
#           the response contains "Statement generation in progress"; once
#           ready the response *body* is the raw CSV.
#        c. Save the CSV to a tempdir.
#        d. POST  the CSV multipart to $UPLOAD_URL with HTTP Basic Auth.
#           The dashboard's /api/upload route auto-detects format, runs the
#           Flex parser, splits by ClientAccountID and writes per-account
#           JSON under uploads/.
#   3. If a step fails with a *transient* error (1001 throttle, 1019 rate
#      limit, network blip, …) the whole sync_one() retries after a delay
#      (see RETRY_DELAYS below). Permanent errors (1011/1014/1015/1018/1020 —
#      invalid token, invalid query, parameter errors) abort immediately.
#
# HOW IT'S AUTO-RUN
# -----------------
# Cron on the droplet, one weekly entry. From `crontab -e`:
#
#     0 16 * * 6 /opt/ibkr-portfolio/scripts/ibkr_sync.sh \
#                >> /var/log/ibkr_sync.log 2>&1
#
# Field meanings:  minute=0  hour=16  day-of-month=*  month=*  day-of-week=6
#                  → every Saturday at 16:00 in the droplet's local timezone.
# Timezone is set with `timedatectl set-timezone Australia/Brisbane` (QLD,
# no DST) or `Australia/Sydney` (NSW with DST). Saturday 16:00 AEST is the
# sweet spot: US Friday close + 8–9h (statement ready) and *before* IBKR's
# weekend maintenance window (which starts ~Sat afternoon US Eastern, ≈
# Sunday morning AEST).
#
# With set -euo pipefail and the retry loop, cron sees:
#   exit 0 → success (all accounts synced)
#   exit 1 → at least one account failed after exhausting retries
#   exit 2 → missing sync.env (configuration error)
#
# DEBUGGING
# ---------
#   - Tail the log:    tail -f /var/log/ibkr_sync.log
#   - Manual run:      ./ibkr_sync.sh
#   - Skip the env:    IBKR_SYNC_ENV=/path/to/other.env ./ibkr_sync.sh
#
# EXPECTED sync.env CONTENTS (chmod 600, never commit)
# -----------------------------------------------------
#   ACCOUNTS="TOKEN_A:QUERY_ID_A TOKEN_B:QUERY_ID_B"
#   BASIC_AUTH="admin:yourpassword"
#   UPLOAD_URL="https://nomad403.cc/api/upload"
# ============================================================================

# `set -e`  → fail fast on any non-zero exit
# `set -u`  → unbound vars become errors (catches typo'd env vars)
# `set -o pipefail` → propagate failures through pipes
set -euo pipefail

# --- Bootstrap: locate and source sync.env ----------------------------------
# Script lives at .../scripts/ibkr_sync.sh; sync.env lives next to it unless
# IBKR_SYNC_ENV is set (handy for testing alternate creds).
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${IBKR_SYNC_ENV:-$DIR/sync.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing config file: $ENV_FILE" >&2
  exit 2
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

# Fail loudly if any required env var is missing — :? prints message & exits.
: "${ACCOUNTS:?ACCOUNTS not set in $ENV_FILE}"
: "${BASIC_AUTH:?BASIC_AUTH not set in $ENV_FILE}"
: "${UPLOAD_URL:?UPLOAD_URL not set in $ENV_FILE}"

# IBKR's Flex Web Service base URL. The two endpoints we use are
# .SendRequest (queue a report) and .GetStatement (download it).
API="https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService"

# Throwaway scratch dir for downloaded CSVs; cleaned up on any exit path.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

# Error codes treated as PERMANENT (don't retry). Space-padded so we can
# do a substring match like `[[ "$PERMANENT_CODES" == *" $errcode "* ]]`.
#   1011  parameter error          1014  invalid query
#   1015  invalid request          1018  authentication problem
#   1020  invalid token
# Everything else (1001, 1019, network failures, etc.) is treated as
# transient and retried.
PERMANENT_CODES=" 1011 1014 1015 1020 1018 "

# Retry backoff schedule in seconds. Two retries at +2h and +4h after the
# first attempt, covering a typical IBKR weekend-maintenance window
# (~3 hours). One initial attempt + this array's length = total tries.
# Dense early retries don't help when IBKR is actually down — better to
# spread them out and let the maintenance finish.
RETRY_DELAYS=(7200 7200)

# sync_one(): top-level per-account driver. Calls try_once() in a loop,
# honouring the backoff schedule and the permanent-error short circuit.
sync_one() {
  local token="$1" query_id="$2" tag="$3"
  local out="$WORKDIR/$tag.csv"
  local attempt=0 max_attempts=$((${#RETRY_DELAYS[@]} + 1))

  while (( attempt < max_attempts )); do
    attempt=$((attempt + 1))
    if try_once "$token" "$query_id" "$tag" "$out"; then
      return 0
    fi
    local rc=$?
    if (( rc == 2 )); then
      # Permanent error — don't retry
      return 1
    fi
    if (( attempt >= max_attempts )); then
      log "[$tag] gave up after $attempt attempts"
      return 1
    fi
    local delay=${RETRY_DELAYS[$((attempt - 1))]}
    log "[$tag] retrying in ${delay}s (attempt $((attempt + 1))/$max_attempts)..."
    sleep "$delay"
  done
}

# try_once(): exactly one shot at the SendRequest → poll → download → upload
# pipeline. Returns:
#   0 success           — CSV downloaded and uploaded
#   1 transient failure — IBKR throttled, generating slowly, network blip
#   2 permanent failure — config error, bad token/query/etc. (caller bails)
try_once() {
  local token="$1" query_id="$2" tag="$3" out="$4"

  # --- Step 1: queue the report ---------------------------------------------
  # IBKR responds with XML containing <Status>Success</Status> and a
  # <ReferenceCode>...</ReferenceCode> we use to poll for the file. On
  # failure the XML contains <ErrorCode> and <ErrorMessage>.
  log "[$tag] requesting statement (query=$query_id)..."
  local resp
  resp=$(curl -sS --max-time 30 "$API.SendRequest?t=$token&q=$query_id&v=3") || {
    log "[$tag] network error on send"
    return 1
  }
  local status ref errcode errmsg
  status=$(grep -oE '<Status>[^<]+' <<<"$resp" | sed 's/<Status>//')
  ref=$(grep -oE '<ReferenceCode>[^<]+' <<<"$resp" | sed 's/<ReferenceCode>//')

  if [[ "$status" != "Success" ]]; then
    errcode=$(grep -oE '<ErrorCode>[^<]+' <<<"$resp" | sed 's/<ErrorCode>//' || true)
    errmsg=$(grep -oE '<ErrorMessage>[^<]+' <<<"$resp" | sed 's/<ErrorMessage>//' || true)
    if [[ "$PERMANENT_CODES" == *" $errcode "* ]]; then
      log "[$tag] PERMANENT failure: code=$errcode msg=$errmsg"
      return 2
    fi
    log "[$tag] transient failure: code=$errcode msg=$errmsg"
    return 1
  fi
  log "[$tag] ref=$ref, polling..."

  # --- Step 2: poll GetStatement until the report is ready ------------------
  # Up to 30 attempts × 5s = 2.5 minutes. While IBKR is still building, the
  # body is an XML envelope containing "Statement generation in progress".
  # When ready, the body IS the raw CSV (no XML wrapper). If it's an error
  # we get an XML body with <ErrorCode>.
  local body i
  for i in $(seq 1 30); do
    sleep 5
    body=$(curl -sS --max-time 60 "$API.GetStatement?t=$token&q=$ref&v=3")
    if grep -q "Statement generation in progress" <<<"$body"; then
      log "[$tag] still generating ($i/30)..."
      continue
    fi
    if grep -q "<ErrorCode>" <<<"$body"; then
      errcode=$(grep -oE '<ErrorCode>[^<]+' <<<"$body" | sed 's/<ErrorCode>//')
      errmsg=$(grep -oE '<ErrorMessage>[^<]+' <<<"$body" | sed 's/<ErrorMessage>//')
      if [[ "$PERMANENT_CODES" == *" $errcode "* ]]; then
        log "[$tag] PERMANENT fetch failure: code=$errcode msg=$errmsg"
        return 2
      fi
      log "[$tag] transient fetch failure: code=$errcode msg=$errmsg"
      return 1
    fi
    # No XML envelope and no error → body is the actual CSV.
    printf '%s' "$body" > "$out"
    log "[$tag] downloaded $(wc -l <"$out" | tr -d ' ') lines"
    break
  done

  # 30 polls exhausted without a successful body or error → timeout.
  if [[ ! -s "$out" ]]; then
    log "[$tag] timeout waiting for statement"
    return 1
  fi

  # --- Step 3: upload the CSV to the dashboard -------------------------------
  # Multipart POST. -w "%{http_code}" lets us inspect status without losing
  # the body (which we dump to a tmp file for error logging).
  log "[$tag] uploading to $UPLOAD_URL..."
  local http
  http=$(curl -sS -o /tmp/upload_resp.$$ -w "%{http_code}" \
    -u "$BASIC_AUTH" -F "file=@$out" "$UPLOAD_URL")
  if [[ "$http" =~ ^2 ]]; then
    log "[$tag] uploaded OK ($http)"
  else
    log "[$tag] upload FAILED ($http): $(cat /tmp/upload_resp.$$)"
    rm -f /tmp/upload_resp.$$
    return 1
  fi
  rm -f /tmp/upload_resp.$$
}

# --- Main loop: iterate ACCOUNTS and tally failures -------------------------
# ACCOUNTS is a space-separated list of "TOKEN:QUERY_ID" pairs. We
# deliberately don't quote $ACCOUNTS in the for-loop — we WANT word
# splitting on spaces so multiple accounts become multiple iterations.
fail=0
for entry in $ACCOUNTS; do
  token="${entry%%:*}"   # everything before the first ':'
  query="${entry#*:}"    # everything after  the first ':'
  tag="${query:0:6}"     # first 6 chars of query id, just for log readability
  sync_one "$token" "$query" "$tag" || fail=$((fail + 1))
done

if (( fail > 0 )); then
  log "completed with $fail failure(s)"
  exit 1
fi
log "all accounts synced"
