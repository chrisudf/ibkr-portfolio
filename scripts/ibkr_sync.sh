#!/usr/bin/env bash
#
# Sync IBKR Activity Flex Query → portfolio dashboard.
#
# Reads credentials from scripts/sync.env (next to this script). Example:
#     ACCOUNTS="TOKEN_A:QUERY_ID_A TOKEN_B:QUERY_ID_B"
#     BASIC_AUTH="admin:yourpassword"
#     UPLOAD_URL="https://nomad403.cc/api/upload"
#
# Then run manually:  ./ibkr_sync.sh
# Or via cron — see scripts/README.md
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${IBKR_SYNC_ENV:-$DIR/sync.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing config file: $ENV_FILE" >&2
  exit 2
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${ACCOUNTS:?ACCOUNTS not set in $ENV_FILE}"
: "${BASIC_AUTH:?BASIC_AUTH not set in $ENV_FILE}"
: "${UPLOAD_URL:?UPLOAD_URL not set in $ENV_FILE}"

API="https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

# Error codes treated as permanent (don't retry).
PERMANENT_CODES=" 1011 1014 1015 1020 1018 "

# Retry backoff schedule in seconds — at +2h and +4h after the first
# attempt. Covers typical IBKR weekend maintenance windows without
# burning cycles on dense early retries.
RETRY_DELAYS=(7200 7200)

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

# Returns: 0 success, 1 transient (retry), 2 permanent (give up)
try_once() {
  local token="$1" query_id="$2" tag="$3" out="$4"

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
    printf '%s' "$body" > "$out"
    log "[$tag] downloaded $(wc -l <"$out" | tr -d ' ') lines"
    break
  done

  if [[ ! -s "$out" ]]; then
    log "[$tag] timeout waiting for statement"
    return 1
  fi

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

fail=0
for entry in $ACCOUNTS; do
  token="${entry%%:*}"
  query="${entry#*:}"
  tag="${query:0:6}"
  sync_one "$token" "$query" "$tag" || fail=$((fail + 1))
done

if (( fail > 0 )); then
  log "completed with $fail failure(s)"
  exit 1
fi
log "all accounts synced"
