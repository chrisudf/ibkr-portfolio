"""Pure-Python equivalent of scripts/ibkr_sync.sh for the web "refresh now"
button. Shells out to IBKR Flex Web Service, polls until ready, returns the
CSV body — no temp files, no subprocess, no env file gymnastics from inside
the Docker container.

The two scripts live side by side on purpose: bash + cron remains the
unattended weekly path, this module is the on-demand UI path. They read
the same credentials format (TOKEN:QUERY_ID space-separated) so a single
env var keeps both in sync.
"""
from __future__ import annotations

import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Iterator, Optional

API_BASE = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService"

# Error codes that the bash script also treats as terminal — no point retrying
# from the UI either. Everything else (1001, 1019, network blips) is a slow
# / temporarily-unavailable hint and the caller can suggest "try again later".
PERMANENT_CODES = {"1011", "1014", "1015", "1018", "1020"}


class FlexFetchError(Exception):
    """Raised when we can't pull a CSV for a given (token, query) pair.

    `permanent` distinguishes config errors (bad token, bad query) from
    transient ones (throttled, slow, weekend maintenance) so the UI can
    decide whether retrying makes sense.
    """

    def __init__(self, message: str, *, permanent: bool = False, code: str = ""):
        super().__init__(message)
        self.permanent = permanent
        self.code = code


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
        raise FlexFetchError(f"network error on SendRequest: {exc}") from exc

    status = _find_tag(send_resp, "Status")
    if status != "Success":
        code = _find_tag(send_resp, "ErrorCode") or ""
        msg = _find_tag(send_resp, "ErrorMessage") or "unknown error"
        raise FlexFetchError(
            f"IBKR refused request: code={code} msg={msg}",
            permanent=code in PERMANENT_CODES,
            code=code,
        )

    ref = _find_tag(send_resp, "ReferenceCode")
    if not ref:
        raise FlexFetchError("SendRequest succeeded but no ReferenceCode in response")

    # --- Step 2: poll GetStatement until ready --------------------------------
    get_url = f"{API_BASE}.GetStatement?{urllib.parse.urlencode({'t': spec.token, 'q': ref, 'v': 3})}"
    for _ in range(max_polls):
        time.sleep(poll_interval)
        try:
            body = _http_get(get_url, timeout=60)
        except Exception as exc:
            raise FlexFetchError(f"network error on GetStatement: {exc}") from exc
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
            )
        # Anything else is the raw CSV body.
        return body

    raise FlexFetchError(
        f"IBKR still generating after {int(max_polls * poll_interval)}s — try again later",
        code="timeout",
    )


def fetch_all(specs: list[AccountSpec], **kwargs) -> Iterator[tuple[AccountSpec, str]]:
    """Yield (spec, csv) per account, serially. Stops at first permanent error.

    Transient errors are re-raised too — the UI layer decides whether to
    show "partial success" or fail the whole refresh.
    """
    for spec in specs:
        yield spec, fetch_one(spec, **kwargs)
