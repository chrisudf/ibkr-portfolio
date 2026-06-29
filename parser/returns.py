"""Money-weighted return (IRR) with money-multiplier fallback.

WHY THIS FILE EXISTS
====================
IBKR's Activity Flex Query (delivered via the Web Service) intentionally
omits TWR — the official Time-Weighted Return only appears in the
network-rendered Activity Statement, never in any Flex section. To keep
the dashboard's "annualized return" KPI populated under the automated
sync path, we compute our own return figure from the external cash flow
list (Statement of Funds → DEP/WITH/BWT activity codes) combined with
the period bookends (ChangeInNAV.FromDate/ToDate) and ending NAV.


SIGN CONVENTION
===============
Inside this module:
  negative amount = money INTO the account   (deposit from investor)
  positive amount = money OUT of the account (withdrawal back to investor)

The starting balance is modeled as the investor "depositing" V_start
at period start; the ending NAV is the investor "withdrawing" V_end
at period end. So a typical timeline looks like:

  (start_date,    -V_start)        # imagine you put V_start in at start
  (deposit_date,  -deposit_amount) # each subsequent deposit
  (withdraw_date, +withdraw_amount)# any withdrawals
  (end_date,      +V_end)          # final liquidation snapshot

Note IBKR's CSV uses the *opposite* sign for deposits (positive = money
in). compute_account_returns() flips the sign before building the flow
series.


TWO METRICS WE COMPUTE
======================

1) IRR (Internal Rate of Return)
   Solve for r where NPV(r) = Σ amount_i / (1+r)^t_i = 0, with t_i in
   years from the earliest flow. Newton's method, capped at 200 iter.
   Returns None if:
     - <2 flows, or flows are all same-signed
     - derivative degenerates (|dNPV/dr| < 1e-14)
     - r runs out of plausible range (<-99% or >100x)
   IRR is "money-weighted" — early-period dollars count for more than
   late-period dollars. Good for: "what rate did *my* money actually
   earn?" Bad for: comparing manager skill across periods or accounts
   that ramped up at different times (it'll over-attribute to early
   periods).

2) Money Multiplier (period return, annualized)
   period_return  = (Σ withdrawals + V_end - Σ deposits - V_start)
                    / (Σ deposits + V_start)
   annualized     = (1 + period_return) ^ (365 / days) - 1

   `days` defaults to the STATEMENT period (FromDate→ToDate), NOT the
   span of actual cash flows. Why: for an account that opened mid-period
   (e.g. SMSF, deposits start Nov, statement runs Jun→Jun), using the
   219-day cash-flow span would extrapolate a 7-month 45% return into
   86% "annualized" — overstated because you're presuming the same rate
   can sustain for another 5 months. Using the 365-day statement period
   instead, the annualized number equals the raw period return (no
   extrapolation), which is more defensible.
   Trade-off: for an account with deposits ONLY in the last month of
   a year-long statement, this understates — but that's the same
   distortion IBKR's TWR avoids and we don't have daily NAV to do the
   real thing.

   The cash-flow span is still surfaced under `cash_span_days` for
   future debugging or a different annualization choice.


DASHBOARD DISPLAY ORDER
=======================
Frontend (dashboard.js) shows in this preference order:
  1. nav.twr               — only present from legacy Activity Statement
  2. annualized multiplier — primary metric under Flex sync
  3. (IRR stored but not shown — over-attributes to early deposits)
  4. hidden
"""
from __future__ import annotations

from datetime import date
from typing import Optional


def _years_between(d0: date, d1: date) -> float:
    return (d1 - d0).days / 365.0


def compute_irr(
    flows: list[tuple[date, float]],
    guess: float = 0.1,
    max_iter: int = 200,
    tol: float = 1e-8,
) -> Optional[float]:
    """Annualized IRR. Returns None if it can't be solved cleanly.

    Newton's method on NPV(r) = Σ amount_i / (1+r)^t_i. `t_i` is years
    from the earliest flow. We bail out for any pathological input
    (single-sign flows, divergence, blow-up) and the caller falls back
    to the simpler money-multiplier metric.
    """
    if len(flows) < 2:
        return None
    flows = sorted(flows, key=lambda x: x[0])
    amounts = [a for _, a in flows]
    # Need both signs for a meaningful IRR.
    if min(amounts) >= 0 or max(amounts) <= 0:
        return None

    t0 = flows[0][0]
    times = [_years_between(t0, d) for d, _ in flows]

    r = guess
    for _ in range(max_iter):
        # Skip the t=0 term in the derivative (its derivative is zero).
        try:
            npv = sum(a / (1.0 + r) ** t for a, t in zip(amounts, times))
            dnpv = sum(-t * a / (1.0 + r) ** (t + 1.0) for a, t in zip(amounts, times) if t > 0)
        except (OverflowError, ZeroDivisionError):
            return None
        if abs(dnpv) < 1e-14:
            return None
        r_next = r - npv / dnpv
        # Keep solver in plausible territory; absurd magnitudes mean
        # the data is too sparse to trust the result.
        if r_next <= -0.999 or r_next > 100:
            return None
        if abs(r_next - r) < tol:
            return r_next
        r = r_next
    return None


def money_multiplier(
    flows: list[tuple[date, float]],
    statement_days: Optional[int] = None,
) -> Optional[dict]:
    """Fallback when IRR doesn't converge — simple (out - in) / in.

    Annualization uses `statement_days` (the official report period) when
    supplied, otherwise falls back to the cash-flow span. Using the
    statement period avoids over-annualizing the return on a freshly
    opened account whose money was only at work for part of the period.

    Returns None if there's nothing to divide by.
    """
    if not flows:
        return None
    gross_in = -sum(a for _, a in flows if a < 0)  # deposits + starting NAV
    gross_out = sum(a for _, a in flows if a > 0)  # withdrawals + ending NAV
    if gross_in <= 0:
        return None
    period_return = (gross_out - gross_in) / gross_in
    dates = [d for d, _ in flows]
    cash_span = max((max(dates) - min(dates)).days, 1)
    days = statement_days if statement_days and statement_days > 0 else cash_span
    annualized = (1.0 + period_return) ** (365.0 / days) - 1.0 if (1.0 + period_return) > 0 else None
    return {
        "period_return": period_return,
        "annualized": annualized,
        "gross_in": gross_in,
        "net_gain": gross_out - gross_in,
        "days": days,
        "cash_span_days": cash_span,
    }


def compute_account_returns(
    deposits_withdrawals: list[tuple[date, float]],
    starting_nav: float,
    starting_date: Optional[date],
    ending_nav: float,
    ending_date: Optional[date],
    statement_days: Optional[int] = None,
) -> dict:
    """Build the full cash flow series and return both IRR and the
    money-multiplier fallback so the UI can show whichever is available.

    deposits_withdrawals: each item is (date, signed amount) where
        deposits are POSITIVE in the IBKR CSV (we flip the sign here).
    """
    flows: list[tuple[date, float]] = []
    if starting_date and starting_nav > 0:
        # Investor "deposited" the starting NAV at period start.
        flows.append((starting_date, -starting_nav))
    for d, amt in deposits_withdrawals:
        # CSV convention: deposit amounts are positive (money into account).
        # IRR convention: deposits are negative (out of investor's pocket).
        flows.append((d, -amt))
    if ending_date and ending_nav > 0:
        flows.append((ending_date, ending_nav))

    out: dict = {
        "irr_annualized": None,
        "money_multiplier": None,
        "method": None,
    }
    if not flows:
        return out

    irr = compute_irr(flows)
    if irr is not None:
        out["irr_annualized"] = irr
        out["method"] = "irr"
    fallback = money_multiplier(flows, statement_days=statement_days)
    if fallback is not None:
        out["money_multiplier"] = fallback
        if out["method"] is None:
            out["method"] = "money_multiplier"
    return out
