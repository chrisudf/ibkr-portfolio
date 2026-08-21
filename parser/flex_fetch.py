"""IBKR Flex Web Service fetcher: SendRequest, poll, return the CSV body.

This is now the ONLY fetch path — both the dashboard's "refresh now"
button and the in-app AUTO_SYNC scheduler (app.py) go through here, so
throttling, token redaction and error-code policy live in exactly one
place. scripts/ibkr_sync.sh (the old bash + cron path) is retired: its
independent retry ladder could walk a transient 1001 into IBKR's 1025
lockout with nothing visible on the dashboard.
"""
from __future__ import annotations

import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Iterator, Optional

API_BASE = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService"

# Error codes that are terminal — no point retrying. Everything else
# (1001, 1019, network blips) is a slow / temporarily-unavailable hint and
# the caller can suggest "try again later".
# 1025 ("Too many failed attempts") is IBKR escalating repeated 1001s into a
# lockout — retrying against it digs the hole deeper (lesson 11: the old
# bash cron walked its whole retry ladder into exactly this).
PERMANENT_CODES = {"1011", "1014", "1015", "1018", "1020", "1025"}


class FlexFetchError(Exception):
    """Raised when we can't pull a CSV for a given (token, query) pair.

    `permanent` distinguishes config errors (bad token, bad query) from
    transient ones (throttled, slow, weekend maintenance) so the UI can
    decide whether retrying makes sense.

    `raw` holds IBKR's own response body (token-redacted, truncated). The
    parsed code/message throw away everything IBKR said around them, which is
    exactly what you want to read when a refresh fails for a reason the code
    list doesn't explain.
    """

    def __init__(self, message: str, *, permanent: bool = False, code: str = "",
                 raw: str = ""):
        super().__init__(message)
        self.permanent = permanent
        self.code = code
        self.raw = raw


@dataclass
class AccountSpec:
    token: str
    query_id: str

    @property
    def tag(self) -> str:
        # First 6 digits of the query id, matches the bash script's log tags.
        return self.query_id[:6]


def parse_accounts_env(value: str) -> list[AccountSpec]:
    """`"TOKEN_A:QUERY_A TOKEN_B:QUERY_B"` → list of specs."""
    specs: list[AccountSpec] = []
    for entry in value.split():
        if ":" not in entry:
            continue
        token, _, query = entry.partition(":")
        token, query = token.strip(), query.strip()
        if token and query:
            specs.append(AccountSpec(token=token, query_id=query))
    return specs


# The token is a query parameter on every call, so it can surface in an
# exception string, a redirect URL echoed back, or an error envelope. Scrub it
# before anything reaches a log line or an HTTP response.
_TOKEN_PARAM_RE = re.compile(r"([?&]t=)[^&\s\"'<>]+")

# Enough to hold a whole error envelope without dumping a stray CSV into logs.
RAW_SNIPPET_LIMIT = 2000


def redact(text: str, *secrets: str) -> str:
    out = text or ""
    for s in secrets:
        if s:
            out = out.replace(s, "<token>")
    return _TOKEN_PARAM_RE.sub(lambda m: m.group(1) + "<token>", out)


def _snippet(text: str, *secrets: str) -> str:
    out = redact((text or "").strip(), *secrets)
    return out[:RAW_SNIPPET_LIMIT] + ("…[truncated]" if len(out) > RAW_SNIPPET_LIMIT else "")


def _http_get(url: str, timeout: float = 30.0) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "ibkr-portfolio/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _find_tag(body: str, tag: str) -> Optional[str]:
    m = re.search(f"<{tag}>([^<]+)</{tag}>", body)
    return m.group(1) if m else None


def fetch_one(
    spec: AccountSpec,
    *,
    max_polls: int = 60,
    poll_interval: float = 5.0,
) -> str:
    """Block until IBKR delivers the CSV for this query, or raise.

    Mirrors the bash script: SendRequest gets a reference code, then
    GetStatement is polled until the body is no longer the
    "in-progress" XML envelope.
    """
    # --- Step 1: queue the report ---------------------------------------------
    send_url = f"{API_BASE}.SendRequest?{urllib.parse.urlencode({'t': spec.token, 'q': spec.query_id, 'v': 3})}"
    try:
        send_resp = _http_get(send_url, timeout=30)
    except Exception as exc:  # network blip
        raise FlexFetchError(
            redact(f"network error on SendRequest: {exc}", spec.token)) from exc

    status = _find_tag(send_resp, "Status")
    if status != "Success":
        code = _find_tag(send_resp, "ErrorCode") or ""
        msg = _find_tag(send_resp, "ErrorMessage") or "unknown error"
        raise FlexFetchError(
            f"IBKR refused request: code={code} msg={msg}",
            permanent=code in PERMANENT_CODES,
            code=code,
            raw=_snippet(send_resp, spec.token),
        )

    ref = _find_tag(send_resp, "ReferenceCode")
    if not ref:
        raise FlexFetchError("SendRequest succeeded but no ReferenceCode in response",
                             raw=_snippet(send_resp, spec.token))

    # --- Step 2: poll GetStatement until ready --------------------------------
    # First poll fires immediately — small queries are often ready by the
    # time SendRequest returns the reference code. Subsequent iterations
    # sleep between attempts.
    get_url = f"{API_BASE}.GetStatement?{urllib.parse.urlencode({'t': spec.token, 'q': ref, 'v': 3})}"
    body = ""  # so the give-up branch below can report the last thing we saw
    for attempt in range(max_polls):
        if attempt > 0:
            time.sleep(poll_interval)
        try:
            body = _http_get(get_url, timeout=60)
        except Exception as exc:
            raise FlexFetchError(
                redact(f"network error on GetStatement: {exc}", spec.token)) from exc
        # IBKR's "still generating" status comes back as an XML envelope
        # carrying the literal phrase, sometimes with ErrorCode 1019.
        if "Statement generation in progress" in body:
            continue
        # An XML error response (not the in-progress one) means we should bail.
        if "<ErrorCode>" in body and "<FlexStatementResponse" in body:
            code = _find_tag(body, "ErrorCode") or ""
            msg = _find_tag(body, "ErrorMessage") or "unknown error"
            raise FlexFetchError(
                f"IBKR error on download: code={code} msg={msg}",
                permanent=code in PERMANENT_CODES,
                code=code,
                raw=_snippet(body, spec.token),
            )
        # Anything else is the raw CSV body.
        return body

    raise FlexFetchError(
        f"IBKR still generating after {int(max_polls * poll_interval)}s — try again later",
        code="timeout",
        raw=_snippet(body, spec.token),
    )


def fetch_all(specs: list[AccountSpec], **kwargs) -> Iterator[tuple[AccountSpec, str]]:
    """Yield (spec, csv) per account, serially. Stops at first permanent error.

    Transient errors are re-raised too — the UI layer decides whether to
    show "partial success" or fail the whole refresh.
    """
    for spec in specs:
        yield spec, fetch_one(spec, **kwargs)
