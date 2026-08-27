/* IBKR Portfolio Dashboard — frontend */

// Symbols treated as cash equivalents (money-market / short-T ETFs).
// They're held in the brokerage account but used as parked cash.
const CASH_EQUIVALENTS = new Set(["BOXX", "SGOV"]);

const fmtMoney = (v, digits = 0) => {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return sign + "$" + abs.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
};
// fmtMoney hard-codes "$". The dividend panel is denominated in whatever
// currency the parser elected as that account's base, which is USD for most
// books but need not be — printing HKD 780 as "$780" is exactly the 1:1
// conflation the currency segregation exists to prevent, just moved into the
// label. Empty / USD keeps the bare "$" so nothing changes for the common case.
const fmtCcy = (v, digits = 0, ccy = "") => {
  if (!ccy || ccy === "USD") return fmtMoney(v, digits);
  const sign = v < 0 ? "-" : "";
  return sign + ccy + " " + Math.abs(v).toLocaleString("en-US",
    { maximumFractionDigits: digits, minimumFractionDigits: digits });
};
const fmtPct = (v, digits = 1) => (v * 100).toFixed(digits) + "%";
const fmtNum = (v, digits = 2) => Number(v).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

// Statement periods come in two spellings and both must parse: the Flex path
// synthesizes "2025-08-20 → 2026-08-19", while the Activity Statement path
// passes IBKR's own wording through verbatim — "January 1, 2026 - June 30,
// 2026". Matching only the ISO form silently disabled every window-derived
// number (period days, chart bounds, 月均) on Activity uploads.
// Kept as plain {y,m,d} — no Date round-trips, so no UTC/local off-by-one.
const MONTH_NUM = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const parsePeriodBounds = (period) => {
  const p = period || "";
  const iso = p.match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return [{ y: +iso[1], m: +iso[2], d: +iso[3] },
            { y: +iso[4], m: +iso[5], d: +iso[6] }];
  }
  const named = p.match(/([A-Za-z]+) (\d{1,2}), (\d{4})\s*[-–—]\s*([A-Za-z]+) (\d{1,2}), (\d{4})/);
  if (named) {
    const m1 = MONTH_NUM[named[1].toLowerCase()], m2 = MONTH_NUM[named[4].toLowerCase()];
    if (m1 && m2) {
      return [{ y: +named[3], m: m1, d: +named[2] },
              { y: +named[6], m: m2, d: +named[5] }];
    }
  }
  return null;
};

// The return KPI is computed over the Flex query's period, NOT since account
// inception — a "Last 365 Calendar Days" query on an account opened earlier
// simply can't see the first months. Label the window explicitly so the
// number isn't mistaken for a lifetime return.
// "2025-07-10 → 2026-07-09" → 364. Returns 0 for the "截至 YYYY-MM-DD"
// fallback period and anything else we can't read two dates out of.
const periodDays = (period) => {
  const b = parsePeriodBounds(period);
  if (!b) return 0;
  const days = Math.round((Date.UTC(b[1].y, b[1].m - 1, b[1].d)
    - Date.UTC(b[0].y, b[0].m - 1, b[0].d)) / 86400000);
  return days > 0 ? days : 0;
};

// "近 N" (= the last N) is only true for trailing windows — Flex "Last 365
// Calendar Days" queries. An Activity Statement covers a FIXED calendar
// range that may have ended months ago; calling CY2025 "近 12 个月" in
// August 2026 mislabels which year the return belongs to.
const fmtSpan = (days, trailing = true) => {
  if (!days || days <= 0) return "";
  const p = trailing ? "近 " : "";
  if (days >= 350) {
    const yrs = days / 365;
    return yrs >= 1.9 ? `${p}${yrs.toFixed(1)} 年` : `${p}12 个月`;
  }
  const months = Math.round(days / 30.44);
  return months >= 2 ? `${p}${months} 个月` : `${p}${days} 天`;
};

const $ = (id) => document.getElementById(id);

const currentDataRef = { data: null, allAccounts: null, selected: null };

function maskAccountId(id) {
  if (!id || id.length < 6) return id;
  return id.slice(0, 4) + "*".repeat(Math.max(0, id.length - 6)) + id.slice(-2);
}

function mergeAccounts(accounts) {
  const list = Object.values(accounts);
  if (list.length === 1) return list[0];

  const nav = { cash: 0, stock: 0, options: 0, dividend_accruals: 0, total: 0, twr: 0 };
  // For the merged view we deliberately DO NOT use IBKR's per-account TWR —
  // weighted-averaging TWRs across accounts is mathematically wrong (each
  // TWR is itself a chain-link of daily returns over a different timeline).
  // Instead we build a single combined money-multiplier from the summed
  // gross_in / net_gain across all accounts, which approximates the real
  // consolidated return that IBKR's PortfolioAnalyst shows (typically within
  // a few percentage points of their Modified Dietz number).
  let mmIn = 0, mmGain = 0, mmDays = 0;
  for (const a of list) {
    nav.cash += a.nav.cash || 0;
    nav.stock += a.nav.stock || 0;
    nav.options += a.nav.options || 0;
    nav.dividend_accruals += a.nav.dividend_accruals || 0;
    nav.total += a.nav.total || 0;
    const mm = a.nav.money_multiplier;
    if (mm) {
      mmIn += mm.gross_in;
      mmGain += mm.net_gain;
      mmDays = Math.max(mmDays, mm.days);
    }
  }
  // nav.twr stays 0 → render() falls through to the money-multiplier branch.
  nav.money_multiplier = mmIn > 0 ? {
    gross_in: mmIn,
    net_gain: mmGain,
    period_return: mmGain / mmIn,
    annualized: Math.pow(1 + mmGain / mmIn, 365 / Math.max(mmDays, 1)) - 1,
    days: mmDays,
  } : null;

  // Merge stocks by symbol (sum qty/cost/value, weighted avg cost_price)
  const stockMap = {};
  for (const a of list) {
    for (const s of a.stocks) {
      const k = s.symbol;
      if (!stockMap[k]) { stockMap[k] = { ...s }; continue; }
      const m = stockMap[k];
      m.quantity += s.quantity;
      m.cost_basis += s.cost_basis;
      m.value += s.value;
      m.unrealized_pl += s.unrealized_pl;
      m.cost_price = m.quantity ? m.cost_basis / m.quantity : 0;
    }
  }
  const stocks = Object.values(stockMap).sort((a, b) => b.value - a.value);

  // Options: concat (each contract is account-specific anyway)
  const options = list.flatMap(a => a.options || []);

  // Performance by symbol — sum across accounts
  const bySymbol = {};
  let realizedTotal = 0, unrealizedTotal = 0;
  for (const a of list) {
    realizedTotal += a.performance.realized_total || 0;
    unrealizedTotal += a.performance.unrealized_total || 0;
    for (const [k, v] of Object.entries(a.performance.by_symbol || {})) {
      if (!bySymbol[k]) { bySymbol[k] = { ...v }; continue; }
      bySymbol[k].realized_total += v.realized_total;
      bySymbol[k].unrealized_total += v.unrealized_total;
      bySymbol[k].total = bySymbol[k].realized_total + bySymbol[k].unrealized_total;
    }
  }

  // Dividends — sum across accounts, keyed by symbol and by month.
  //
  // Accounts can disagree on base currency (each parser run elects its own
  // dominant one). Adding a HKD-based account's totals into a USD-based
  // account's at 1:1 would be the exact mixing the per-account segregation
  // exists to prevent — so first elect a merged base (net payment count,
  // gross breaks ties), then treat every other-base account the way one
  // account treats its own foreign rows: totals into the foreign buckets,
  // nothing into by_symbol / by_month / the per-share union.
  const ccyVotes = {};
  for (const a of list) {
    const d = a.dividends;
    if (!d || !d.by_symbol || !d.base_currency) continue;
    const v = ccyVotes[d.base_currency] || (ccyVotes[d.base_currency] = [0, 0]);
    // NET payment count, matching the parser's own election. by_symbol.count
    // only tallies positive bookings, so a corrected payout (+780/−780/+780)
    // would cast two votes here for what the parser counts as one — enough to
    // elect the wrong merged base and push the real base's totals into the
    // foreign bucket. Signed gross events give the same −1 for a reversal the
    // parser applies; count stays as the fallback for legacy payloads that
    // predate the per-event currency field.
    // Only the account's OWN base-currency payouts vote for it — `events`
    // carries its foreign rows too, and those belong to their own currency,
    // not to this account's base. (by_symbol, the fallback, already holds
    // main rows only, which is why the count version needed no such filter.)
    const evs = (d.events || []).filter(
      e => e.kind === "gross" && e.currency === d.base_currency);
    if (evs.length) {
      for (const e of evs) v[0] += e.amount > 0 ? 1 : -1;
    } else {
      for (const s of d.by_symbol) v[0] += s.count || 0;
    }
    v[1] += Math.abs(d.gross || 0);
  }
  // Currency code breaks an exact count+amount tie so the election can't turn
  // on object key order — same determinism the parsers guarantee.
  const divBase = Object.keys(ccyVotes).reduce((best, c) => {
    if (!best) return c;
    const [a, b] = [ccyVotes[best], ccyVotes[c]];
    return (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1])
      || (b[0] === a[0] && b[1] === a[1] && c > best)) ? c : best;
  }, "");
  const otherBase = (d) =>
    !!(d.base_currency && divBase && d.base_currency !== divBase);

  const divSym = {}, divMonth = {}, divForeign = {};
  let divGross = 0, divTax = 0, divNonDiv = 0, divSource = "";

  // Ingest one raw event into the merged aggregates. Only needed for accounts
  // whose own elected base differs from the merged one: their by_symbol /
  // by_month sums are denominated in the wrong currency and can't be added,
  // but individual payouts they made IN the merged base are ordinary
  // merged-base cash. Mirrors _finalize_dividends' per-row logic so the two
  // paths can't drift.
  const ingestEvent = (e) => {
    const t = divSym[e.symbol] || (divSym[e.symbol] = {
      symbol: e.symbol, gross: 0, tax: 0, net: 0, count: 0,
      per_share: 0, per_share_ordinary: 0, non_dividend: 0,
      rate_missing: 0, last_date: "",
    });
    if (e.kind === "gross") {
      divGross += e.amount; t.gross += e.amount;
      if (e.amount > 0) t.count += 1;                       // reversals aren't payments
      if (e.income_class !== "ordinary") { t.non_dividend += e.amount; divNonDiv += e.amount; }
      if (!e.per_share && e.amount > 0) t.rate_missing += 1;
    } else {
      divTax += e.amount; t.tax += e.amount;
    }
    t.net = t.gross + t.tax;
    if (e.date > t.last_date) t.last_date = e.date;
    const mk = (e.date || "").slice(0, 7);
    const m = divMonth[mk] || (divMonth[mk] = { month: mk, gross: 0, tax: 0, net: 0 });
    if (e.kind === "gross") m.gross += e.amount; else m.tax += e.amount;
    m.net = m.gross + m.tax;
  };

  for (const a of list) {
    const d = a.dividends;
    if (!d || !d.by_symbol) continue;
    divSource = !divSource ? d.source
      : (d.source && d.source !== divSource ? "mixed" : divSource);
    // Foreign-currency payouts are excluded from every total, so summing the
    // per-currency buckets across accounts is safe — they're plain cash.
    // One exception: a bucket denominated in the MERGED base isn't foreign
    // here at all. An HKD-dominant account files its USD payouts under
    // foreign.USD; if another account makes USD the merged base, that cash is
    // ordinary merged-base income and gets re-ingested from events below.
    for (const [c, f] of Object.entries(d.foreign || {})) {
      if (c === divBase) continue;
      const t = divForeign[c] || (divForeign[c] = { gross: 0, tax: 0, net: 0, count: 0 });
      t.gross += f.gross; t.tax += f.tax; t.net += f.net; t.count += f.count || 0;
    }
    if (otherBase(d)) {
      // Whole account denominated in another currency: report, don't add.
      const t = divForeign[d.base_currency]
        || (divForeign[d.base_currency] = { gross: 0, tax: 0, net: 0, count: 0 });
      t.gross += d.gross || 0; t.tax += d.tax || 0; t.net += d.net || 0;
      for (const s of d.by_symbol) t.count += s.count || 0;
      // ...except whatever it paid in the merged base, which does belong in
      // the totals, by_symbol and by_month like any other account's income.
      for (const e of d.events || []) {
        if (e.currency && e.currency === divBase) ingestEvent(e);
      }
      continue;
    }
    divGross += d.gross || 0;
    divTax += d.tax || 0;
    divNonDiv += d.non_dividend || 0;
    for (const s of d.by_symbol) {
      const t = divSym[s.symbol] || (divSym[s.symbol] = {
        symbol: s.symbol, gross: 0, tax: 0, net: 0, count: 0,
        per_share: 0, per_share_ordinary: 0, non_dividend: 0,
        rate_missing: 0, last_date: "",
      });
      t.gross += s.gross; t.tax += s.tax; t.net += s.net; t.count += s.count;
      // per_share is a property of the security, not of the account — both
      // accounts holding MSFT booked the same $1.82/share. Summing would
      // double it. Take the widest coverage instead: the account that held
      // through the most ex-dates saw the most of the year's rate.
      t.non_dividend += s.non_dividend || 0;   // cash, so this one does add
      // A count of rate-less PIL cash events; events in different accounts
      // are distinct payments, so counts add (same as `count` above) — max
      // undercounts whenever both accounts had them.
      t.rate_missing += s.rate_missing || 0;
      t.last_date = t.last_date > s.last_date ? t.last_date : s.last_date;
    }
    for (const m of d.by_month || []) {
      const t = divMonth[m.month] || (divMonth[m.month] = { month: m.month, gross: 0, tax: 0, net: 0 });
      t.gross += m.gross; t.tax += m.tax; t.net += m.net;
    }
  }
  // Per-share rates can't be summed across accounts (both holders of MSFT
  // booked the same $1.82) but taking the max is wrong too: when the accounts
  // held the name over different stretches, each one saw payments the other
  // missed. Union the distinct payments instead — same identity the dedupe
  // uses — so a household that held SGOV Sep-Mar in one account and Dec-Jun in
  // the other gets credit for every ex-date either of them was present for.
  const seenPay = {};
  for (const a of list) {
    const d = a.dividends || {};
    // Occurrence ordinal per account: a cancel + re-book at the same
    // date/rate is (+r, -r, +r) — without the ordinal the re-book collides
    // with the original's key and the union nets to zero, re-dropping in
    // the merged view the exact payout the parser's own seq keeps. Counting
    // per account, then unioning on (payment, n), still collapses the same
    // payment seen from two accounts while keeping within-account repeats.
    const occ = {};
    for (const e of d.events || []) {
      if (e.kind !== "gross" || !e.per_share) continue;
      // Rates outside the MERGED base never joined the merged by_symbol sums,
      // so they must not join the union either — an AUD rate divided by a USD
      // cost is not a yield. Testing against divBase rather than the account's
      // own base is what lets an other-base account still contribute the rates
      // of the payouts it made in the merged base (those did join, above).
      if (e.currency && divBase && e.currency !== divBase) continue;
      const t = divSym[e.symbol];
      if (!t) continue;
      const pay = `${e.symbol}|${e.date}|${e.per_share}`;
      const n = (occ[pay] = (occ[pay] || 0) + 1);
      const key = `${pay}|${n}`;
      if (seenPay[key]) continue;
      seenPay[key] = true;
      t.per_share += e.per_share;
      if ((e.income_class || "ordinary") === "ordinary") t.per_share_ordinary += e.per_share;
    }
  }

  const dividends = Object.keys(divSym).length ? {
    source: divSource,
    gross: divGross,
    tax: divTax,
    net: divGross + divTax,
    non_dividend: divNonDiv,
    base_currency: divBase,
    foreign: divForeign,
    by_symbol: Object.values(divSym).sort((a, b) => b.net - a.net),
    by_month: Object.values(divMonth).sort((a, b) => a.month.localeCompare(b.month)),
    events: list.flatMap(a => a.dividends?.events || [])
      .sort((a, b) => (a.date < b.date ? 1 : -1)),
  } : {};

  // Cost history: re-derive the average from summed tallies rather than
  // averaging averages, which would ignore how many shares each account held.
  const histAcc = {};
  for (const a of list) {
    // Each account's own per-share rates, for the ex-date benchmark below.
    // Other-base accounts contribute nothing: their rates are denominated in
    // a currency whose cash never enters the merged gross either.
    const rateBySym = {};
    if (otherBase(a.dividends || {})) {
      // by_symbol is denominated in this account's own base, which isn't the
      // merged one — but the payouts it made in the merged base do count, and
      // their rates are exactly the ones that joined the merged sums above.
      for (const e of a.dividends?.events || []) {
        if (e.kind === "gross" && e.currency === divBase && e.per_share) {
          rateBySym[e.symbol] = (rateBySym[e.symbol] || 0) + e.per_share;
        }
      }
    } else {
      for (const s of a.dividends?.by_symbol || []) rateBySym[s.symbol] = s.per_share || 0;
    }
    for (const [sym, h] of Object.entries(a.cost_history || {})) {
      const t = histAcc[sym] || (histAcc[sym] = {
        qty: 0, cost: 0, sold: 0, covered: true, start: "", end: "", shares: 0, pre: false,
        should: 0, split: false,
      });
      // A forward split is a corporate action — it hits the name in every
      // account. One flagged entry poisons the merged one: its start/end
      // still span the window, so recomputing days below would resurrect
      // the exact phantom annualization the parser just suppressed.
      t.split = t.split || !!h.split_suspect;
      // The "what a steady holder would have collected" benchmark must be
      // built per account and summed — each avg_shares is a time-average over
      // that account's OWN window, so multiplying the summed shares by the
      // union-of-windows rate would claim every account attended every
      // ex-date either of them saw, firing a phantom 除息日缺口 exactly when
      // the accounts held the name over different stretches.
      t.should += (h.avg_shares || 0) * (rateBySym[sym] || 0);
      t.qty += h.bought_qty;
      t.cost += h.avg_price * h.bought_qty;
      t.sold += h.sold_qty;
      t.covered = t.covered && h.covered;
      // Union of the deployed windows, to match the unioned payments above:
      // earliest start to latest end across the accounts.
      if (h.start && (!t.start || h.start < t.start)) t.start = h.start;
      if (h.end && (!t.end || h.end > t.end)) t.end = h.end;
      t.shares += h.avg_shares || 0;
      t.pre = t.pre || !!h.pre_existing;
    }
  }
  const cost_history = {};
  for (const [sym, t] of Object.entries(histAcc)) {
    // qty > 0 = at least one account traded it; shares > 0 = at least one
    // account carries a seeded buy-and-hold entry (zero trades, whole-window
    // deployment). Both deserve a merged entry — dropping the seeded-only
    // case would lose days/avg_shares in the 总账户 view that every
    // per-account view still shows.
    if (t.qty > 0 || t.shares > 0 || t.split) {
      cost_history[sym] = t.split
        // Split-poisoned: keep the entry (so the row renders) but with every
        // time-derived stat suppressed, matching the per-account views.
        ? { avg_price: 0, bought_qty: t.qty, sold_qty: t.sold, covered: false,
            days: 0, avg_shares: 0, pre_existing: t.pre, should_gross: 0,
            split_suspect: true }
        : { avg_price: t.qty > 0 ? t.cost / t.qty : 0, bought_qty: t.qty, sold_qty: t.sold,
            covered: t.covered && t.qty > 0,
            days: (t.start && t.end)
              ? Math.max(0, Math.round((Date.parse(t.end) - Date.parse(t.start)) / 86400000))
              : 0,
            avg_shares: t.shares, pre_existing: t.pre,
            should_gross: t.should,
          };
    }
  }

  // NAV history — dates are a union, each account forward-filled from its
  // own first observation, and the merged curve starts only where EVERY
  // account has begun reporting (a partial sum would read as a fake crash).
  // Any account without a history (old JSON) disables the merged curve
  // rather than misrepresenting the household as one thinner account.
  // Pre-filter with the same total>0 predicate the single-account stats use:
  // a padded/blank NAV row parses to 0.0, and forward-filling a zero would
  // paint a full-NAV one-day crash on the household curve that neither
  // per-account view shows.
  const histories = list.map(a => (a.nav_history || []).filter(p => p.total > 0));
  let nav_history = [];
  if (histories.length && histories.every(h => h.length)) {
    const dates = [...new Set(histories.flat().map(p => p.date))].sort();
    const startDate = histories.map(h => h[0].date).reduce((a, b) => (a > b ? a : b));
    // Truncate the tail symmetrically: accounts are refreshed independently,
    // and past the stale one's last observation the merged point would be
    // "today's A + last week's B" — worse, a deposit booked after B's NAV
    // series ends would be stripped from a merged NAV that never received
    // it, printing a fake drawdown at exactly the staleness boundary.
    const endDate = histories.map(h => h[h.length - 1].date).reduce((a, b) => (a < b ? a : b));
    const idx = histories.map(() => 0);
    const lastVal = histories.map(() => 0);
    for (const d of dates) {
      histories.forEach((h, i) => {
        while (idx[i] < h.length && h[idx[i]].date <= d) { lastVal[i] = h[idx[i]].total; idx[i]++; }
      });
      if (d < startDate || d > endDate) continue;
      nav_history.push({ date: d, total: lastVal.reduce((s, v) => s + v, 0) });
    }
  }
  // External flows: plain concat — navStats needs them to strip deposits
  // out of the merged return chain, and each flow belongs to exactly one
  // account so no dedupe question arises.
  const cash_flows = list.flatMap(a => a.cash_flows || []);

  // If accounts share the same period (the usual case) collapse to one.
  const periods = [...new Set(list.map(a => a.statement?.Period).filter(Boolean))];
  return {
    account: { Account: "ALL" },
    statement: { Period: periods.length === 1 ? periods[0] : periods.join(" / ") },
    nav, stocks, options, dividends, cost_history, nav_history, cash_flows,
    performance: {
      realized_total: realizedTotal,
      unrealized_total: unrealizedTotal,
      by_symbol: bySymbol,
    },
  };
}

function renderAccountSwitcher() {
  const accounts = currentDataRef.allAccounts;
  const el = $("account-switcher");
  if (!accounts || Object.keys(accounts).length < 2) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const ids = Object.keys(accounts).sort();
  // Individual accounts first; "总账户" merge view as the trailing option.
  el.innerHTML = `<span class="label">账号</span>`
    + ids.map(id => `<button data-acct="${id}">${maskAccountId(id)}</button>`).join("")
    + `<button data-acct="ALL">总账户</button>`;
  el.querySelectorAll("button").forEach(btn => {
    if (btn.dataset.acct === currentDataRef.selected) btn.classList.add("active");
    btn.addEventListener("click", () => {
      currentDataRef.selected = btn.dataset.acct;
      el.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderSelected();
    });
  });
}

function renderSelected() {
  const accounts = currentDataRef.allAccounts;
  const sel = currentDataRef.selected;
  const data = sel === "ALL" ? mergeAccounts(accounts) : accounts[sel];
  currentDataRef.data = data;
  render(data);
}

async function loadPortfolio() {
  const res = await fetch("/api/portfolio");
  const payload = await res.json();
  if (payload.empty) {
    $("empty").hidden = false;
    $("dashboard").hidden = true;
    return;
  }
  $("empty").hidden = true;
  $("dashboard").hidden = false;
  // Accept both new multi-account payload and legacy single-account shape.
  // For legacy, key by the real account id when present so the account
  // switcher doesn't label it as a masked "default".
  const accounts = payload.accounts || { [payload.account?.Account || "default"]: payload };
  currentDataRef.allAccounts = accounts;
  currentDataRef.sync = payload.sync || null;
  currentDataRef._universe = null;    // memoized symbol list is now stale
  // Default to the alphabetically-first account (puts U17xxxx ahead of U22xxxx)
  // rather than the merged view — most viewing happens per-account.
  if (!currentDataRef.selected || (currentDataRef.selected !== "ALL" && !accounts[currentDataRef.selected])) {
    const ids = Object.keys(accounts).sort();
    currentDataRef.selected = ids[0];
  }
  renderAccountSwitcher();
  renderSelected();
}

function render(data) {
  const { nav, options, performance, account, statement } = data;
  // Split stocks into real positions vs cash equivalents
  const cashEqHoldings = data.stocks.filter(s => CASH_EQUIVALENTS.has(s.symbol));
  const stocks = data.stocks.filter(s => !CASH_EQUIVALENTS.has(s.symbol));
  const cashEqValue = cashEqHoldings.reduce((s, x) => s + x.value, 0);
  const cashEqCost = cashEqHoldings.reduce((s, x) => s + x.cost_basis, 0);
  const adjStock = nav.stock - cashEqValue;
  const adjCash = nav.cash + cashEqValue;
  const totalNav = nav.total || (nav.cash + nav.stock + nav.options);

  // Account line — show masked account + period, hide name
  const acct = account.Account || "";
  const masked = acct === "ALL" ? "总账户" : maskAccountId(acct);
  const period = statement.Period || "";
  // Auto-sync heartbeat next to the account id — "is the unattended sync
  // alive" should be answerable at a glance, not by ssh-ing into the box.
  const sync = currentDataRef.sync;
  let syncLabel = "";
  if (sync && sync.mode && sync.mode !== "off") {
    const cadence = sync.mode === "daily" ? "每日" : "每周";
    syncLabel = sync.last_attempt
      ? `自动同步(${cadence}) ${sync.last_attempt.slice(5, 16).replace("T", " ")}Z ${sync.ok ? "✓" : "✗"}`
      : `自动同步(${cadence}) 待首跑`;
  }
  const line = $("account-line");
  line.textContent = [masked, period, syncLabel].filter(Boolean).join(" · ") || "已导入";
  line.title = sync && sync.detail ? sync.detail : "";

  // KPIs
  $("kpi-nav").textContent = fmtMoney(totalNav);
  const twrEl = $("kpi-twr");
  // Preference: TWR (official, only present in legacy Activity Statement
  // uploads) → annualized money multiplier (computed from Flex cash flows).
  // IRR is kept on the data but not displayed — it overweights early
  // deposits and tends to print misleadingly high numbers when the account
  // ramped up mid-period.
  const mm = nav.money_multiplier;
  // Both branches are scoped to the statement period, so both carry the
  // window in the label. Single accounts read it off statement.Period.
  // The merged view must NOT: mergeAccounts() joins differing periods into
  // one string ("A / B") while annualizing over the longest mm.days, so
  // parsing that string would label the number with the wrong window —
  // it'd pick up whichever range happens to be listed first.
  const spanDays = (acct === "ALL" ? 0 : periodDays(period)) || (mm && mm.days) || 0;
  // Month-name periods (Activity Statements) are fixed calendar ranges, not
  // trailing windows — label them by length only, without "近".
  const fixedWindow = /[A-Za-z]+ \d{1,2}, \d{4}/.test(period);
  const span = fmtSpan(spanDays, !fixedWindow);
  const suffix = span ? `（${span}）` : "";
  const scopeHint = `${span ? span + "，" : ""}按报表期间计算，非开户至今`;
  if (nav.twr) {
    twrEl.textContent = `时间加权收益率 ${fmtPct(nav.twr, 2)}${suffix}`;
    twrEl.title = `${scopeHint} · 报表期间 ${period || "—"}`;
    twrEl.hidden = false;
  } else if (mm && mm.annualized != null) {
    twrEl.textContent = `年化回报率 ${fmtPct(mm.annualized, 1)}${suffix}`;
    twrEl.title = `${scopeHint} · `
      + `期间净入金 ${fmtMoney(mm.gross_in)} · 净收益 ${fmtMoney(mm.net_gain)} · ${mm.days} 天`;
    twrEl.hidden = false;
  } else {
    twrEl.hidden = true;
  }

  $("kpi-stock").textContent = fmtMoney(adjStock);
  $("kpi-stock-pct").textContent = `占总净值 ${fmtPct(adjStock / totalNav)}`;

  // Gross exposure: sum of long-contract market value vs sum of |short-contract market value|
  const grossLong = options.filter(o => o.value > 0).reduce((s, o) => s + o.value, 0);
  const grossShort = options.filter(o => o.value < 0).reduce((s, o) => s + Math.abs(o.value), 0);
  $("kpi-options").textContent = fmtMoney(grossLong + grossShort);
  $("kpi-options-detail").textContent = `买入 ${fmtMoney(grossLong)} · 卖出 ${fmtMoney(grossShort)}`;

  $("kpi-cash").textContent = fmtMoney(adjCash);
  const cashEqLabel = cashEqValue > 0
    ? `含 ${cashEqHoldings.map(h => h.symbol).join("/")} ${fmtMoney(cashEqValue)}`
    : `占总净值 ${fmtPct(adjCash / totalNav)}`;
  $("kpi-cash-pct").textContent = cashEqLabel;

  const unr = data.stocks.reduce((s, x) => s + x.unrealized_pl, 0) + options.reduce((s, x) => s + x.unrealized_pl, 0);
  const kpiUnr = $("kpi-unrealized");
  kpiUnr.textContent = fmtMoney(unr);
  kpiUnr.classList.toggle("up", unr >= 0);
  kpiUnr.classList.toggle("down", unr < 0);
  $("kpi-realized").textContent = `已实现 ${fmtMoney(performance.realized_total)}`;

  // NAV history (equity curve + drawdown/vol stats)
  renderNavHistory(data);

  // Weekly recap (per-underlying movers vs the ~7-day-old snapshot)
  renderWeekly(data, currentDataRef.allAccounts, currentDataRef.selected);

  // Position rules are judged against THIS view — recompute before the
  // treemap reads it per tile.
  currentDataRef._exposures = computeExposures(data);

  // Treemap (tiles carry the core-holding ring / over-under badge)
  renderTreemap(stocks);

  // Core holdings vs their bands — the badge legend, and the only place an
  // underlying with no stock leg (long options only) can show up.
  renderCorePositions(masked);

  // Allocation bar — position view: cash, stock, long options (MV)
  // Short options excluded (their premium is already in cash); shown as a footnote.
  const longOptMV = options.filter(o => o.value > 0).reduce((s, o) => s + o.value, 0);
  const shortOptMV = options.filter(o => o.value < 0).reduce((s, o) => s + Math.abs(o.value), 0);
  renderAllocation({ cash: adjCash, stock: adjStock, longOptions: longOptMV, shortOptionsNote: shortOptMV }, totalNav);

  // Cluster exposure (mapping loads async from static/clusters.json; the
  // panel re-renders once it arrives)
  renderClusters(data, currentDataRef.clusters);

  // Margin — prices are pooled across every loaded account, so pass the whole
  // set rather than just the account being viewed.
  renderMargin(data, currentDataRef.allAccounts);

  // Holdings — show all positions including cash equivalents (tagged)
  renderHoldings(data.stocks);

  // Options
  renderOptions(options);

  // Expiry calendar (short options by expiry week)
  renderExpiries(data, currentDataRef.allAccounts);

  // Dividends
  renderDividends(data);

  // Realized rankings
  renderRankings(performance.by_symbol);
}

/* ---------------------------------------------------------------------------
 * Margin — estimated, not reported.
 *
 * IBKR's Flex Web Service does not export margin requirements in any section
 * (they only exist in TWS and the rendered Activity Statement), so we
 * reconstruct the standard Reg-T initial requirement from the positions we do
 * have. Per share, for an uncovered short option:
 *
 *   put  → max(0.20 × underlying − OTM amount, 0.10 × strike,     $2.50)
 *   call → max(0.20 × underlying − OTM amount, 0.10 × underlying, $2.50)
 *
 * plus the contract's current market value (the premium you'd pay to close).
 * Short calls backed by stock in the same account are covered — the shares are
 * the collateral, so they consume no margin.
 *
 * Long options need no margin (the premium is already paid), and stock bought
 * with cash needs none either — this account only borrows to back short puts,
 * which is exactly what the panel reports.
 * ------------------------------------------------------------------------- */

// Ex-date capture: what a payout stream collected, against what a steady
// holder of the same average size would have collected over the same window.
//
// Under 100% doesn't automatically mean money was lost — a position built up
// during the period naturally misses the earlier ex-dates, and one trimmed
// early naturally over-collects (these run past 180% in real data). So the
// ratio alone is a position-timing statistic, not a mistake detector. The
// dollar floor is what makes it worth showing: it only surfaces cases where
// the gap is large enough to be real money rather than rounding on a stub.
const CAPTURE_FLAG_RATIO = 0.8;
const CAPTURE_FLAG_DOLLARS = 10;

// Reg-T floor for an uncovered contract: $250, i.e. $2.50/share.
const MARGIN_FLOOR_PER_SHARE = 2.5;
// Fallback deliverable for JSONs saved before the parser exported the
// contract's own Multiplier column; standard US equity options are 100.
const CONTRACT_MULTIPLIER = 100;
// Mark-to-strike ratio above which an option without an underlying quote is
// treated as probably in-the-money. Listed equity options don't carry 10% of
// strike in pure time value at the DTEs a seller's calendar shows.
const MARK_ITM_RATIO = 0.10;

// Underlying mark prices, pooled across every loaded account — a price is a
// market fact, not account data, so a stock held only in U22 still prices a
// U17 short put. Populated from stock positions; underlyings we hold no
// shares of simply aren't in here.
function buildPriceBook(accounts) {
  const px = {};
  for (const a of Object.values(accounts || {})) {
    for (const s of a.stocks || []) {
      if (s.close_price > 0 && !(s.symbol in px)) px[s.symbol] = s.close_price;
    }
  }
  return px;
}

// Reg-T requirement for one short contract, per share of underlying.
function regTPerShare(right, strike, underlying) {
  const otm = right === "P"
    ? Math.max(0, underlying - strike)   // put is OTM when spot is above strike
    : Math.max(0, strike - underlying);  // call is OTM when spot is below strike
  const floorPct = right === "P" ? 0.10 * strike : 0.10 * underlying;
  return Math.max(0.20 * underlying - otm, floorPct, MARGIN_FLOOR_PER_SHARE);
}

// shock: uniform gap applied to every underlying spot AND the stock sleeve
// (e.g. -0.2 = everything opens 20% down). Option premiums are NOT repriced —
// in a real gap the short-put mark explodes, so the stressed requirement here
// is a floor, not a forecast. shock=0 is the live estimate.
function computeMargin(data, priceBook, shock = 0) {
  const stocks = data.stocks || [];
  const options = data.options || [];
  const nav = data.nav || {};
  // Cash equivalents (SGOV/BOXX) are T-bill parking, not equity — the rest
  // of the dashboard already reclassifies them as cash, and "T-bills gap
  // −30%" is not the scenario this table models. Only the true equity
  // sleeve takes the shock.
  const cashEq = stocks.reduce(
    (s, x) => s + (CASH_EQUIVALENTS.has(x.symbol) ? (x.value || 0) : 0), 0);
  const equitySleeve = (nav.stock || 0) - cashEq;
  // Stressed NAV moves by the equity sleeve only (options unrepriced, cash fixed).
  const totalNav = (nav.total || (nav.cash + nav.stock + nav.options))
    + equitySleeve * shock;

  // Shares available to cover short calls, spent longest-dated first.
  const sharesLeft = {};
  for (const s of stocks) sharesLeft[s.symbol] = (sharesLeft[s.symbol] || 0) + s.quantity;

  const byUnderlying = {};
  let requirement = 0, notional = 0, premium = 0, assumedContracts = 0;
  // How much of the total leans on an assumed spot. Counting contracts
  // understates it — the assumed ones are often the biggest requirements,
  // because assuming at-the-money is the most expensive guess you can make.
  let assumedRequirement = 0;

  // Short calls before puts so covering shares go to the calls that need them.
  const shorts = options.filter(o => o.quantity < 0)
    .sort((a, b) => (a.right === "C" ? 0 : 1) - (b.right === "C" ? 0 : 1));

  // Contracts whose strike/right didn't parse (adjusted symbols the Activity
  // Statement path couldn't read) must NOT fall through the formula: with
  // strike 0 and no right, regTPerShare degenerates to the $2.50 floor and a
  // multi-thousand-dollar requirement quietly prints as ~$250. Exclude their
  // Reg-T leg and say so — but their market value is parsed independently of
  // the symbol, and it is a hard lower bound on the liability, so it still
  // belongs in the premium total and comes off the excess.
  let unparsedContracts = 0, unparsedMv = 0;
  for (const o of shorts) {
    if (!(o.strike > 0) || (o.right !== "P" && o.right !== "C")) {
      unparsedContracts += Math.abs(o.quantity);
      unparsedMv += Math.abs(o.value || 0);
      continue;
    }
    const qty = Math.abs(o.quantity);
    const mult = o.multiplier || CONTRACT_MULTIPLIER;
    const shares = qty * mult;
    const known = priceBook[o.underlying];
    // No price anywhere in the portfolio → assume the contract sits at the
    // money. That lands the estimate on 20% of strike, the middle of the
    // Reg-T range, and every such contract is counted so the UI can say so.
    // The gap shock hits the assumed spot the same as a real one.
    const spot = (known || o.strike) * (1 + shock);
    if (!known) assumedContracts += qty;
    // Premium leg. In STRESS scenarios only, the mark is floored at intrinsic
    // value — an option is never worth less than intrinsic, so after a gap
    // the unrepriced mark would otherwise make the requirement SHRINK as the
    // 20%-of-spot leg deflates while a deep-ITM put's real liability
    // explodes. At shock=0 the floor must stay OFF: the price book pools
    // spots across accounts refreshed on different dates, and intrinsic
    // against a stale spot would silently overwrite the statement's own
    // mark — the live estimate belongs to the statement, gaps belong to
    // the stress table.
    const intrinsicPS = o.right === "P"
      ? Math.max(0, o.strike - spot)
      : Math.max(0, spot - o.strike);
    const mv = shock !== 0
      ? Math.max(Math.abs(o.value), intrinsicPS * shares)
      : Math.abs(o.value);

    let covered = 0;
    if (o.right === "C") {
      // Reg-T covers by whole 100-share lots: a call is either backed by its
      // full deliverable or it is naked. 80 shares against one short call earn
      // no per-share credit — IBKR charges the full uncovered requirement.
      // Prorating per share would understate exactly the odd-lot cases
      // (fractional ETF positions) where the panel matters most.
      const lots = Math.floor(Math.max(sharesLeft[o.underlying] || 0, 0) / mult);
      const coveredContracts = Math.min(qty, lots);
      covered = coveredContracts * mult;
      sharesLeft[o.underlying] = (sharesLeft[o.underlying] || 0) - covered;
    }
    const nakedShares = shares - covered;
    // mv is the whole position's market value, so only the naked slice of the
    // premium belongs in the requirement — a call half covered by stock would
    // otherwise carry the covered half's premium too.
    const req = nakedShares > 0
      ? regTPerShare(o.right, o.strike, spot) * nakedShares + mv * (nakedShares / shares)
      : 0;
    const notionalHere = o.right === "P" ? o.strike * shares : 0;

    requirement += req;
    if (!known) assumedRequirement += req;
    premium += mv;
    notional += notionalHere;

    const b = byUnderlying[o.underlying] || (byUnderlying[o.underlying] = {
      underlying: o.underlying, contracts: 0, puts: 0, calls: 0, covered: 0,
      requirement: 0, notional: 0, premium: 0, spot, priceKnown: !!known,
    });
    b.contracts += qty;
    b[o.right === "P" ? "puts" : "calls"] += qty;
    b.covered += covered / mult;
    b.requirement += req;
    b.notional += notionalHere;
    b.premium += mv;
  }

  // Excess liquidity the way IBKR actually computes it under Reg-T, not
  // NAV − requirement. Two things NAV counts are not collateral: long US
  // equity options have no loan value (a LEAP book cannot back new short
  // puts), and long stock carries ~25% maintenance. NAV − requirement would
  // overstate "can I sell another put" headroom by the whole LEAP sleeve
  // plus a quarter of the stock — the dangerous direction for this panel.
  //   excess ≈ cash + 75% × long stock − 130% × |short stock| − requirement
  // Short stock gets a charge, not a credit: its sale proceeds already sit
  // in cash at 100%, and Reg-T maintenance adds ~30% on top — folding it
  // into a single 75% haircut would turn the maintenance into a credit.
  // Unparsed short options also come off: their Reg-T leg is unknown (see
  // above) but their market value is a known lower bound on the liability.
  const stockValue = cashEq + equitySleeve * (1 + shock);
  const longStock = Math.max(stockValue, 0);
  const shortStock = Math.min(stockValue, 0);
  const excess = (nav.cash || 0) + longStock * 0.75 + shortStock * 1.3
    - requirement - unparsedMv;
  return {
    requirement,
    notional,
    premium: premium + unparsedMv,
    totalNav,
    pctOfNav: totalNav > 0 ? requirement / totalNav : 0,
    excess,
    // Worst single account — for the merged view's margin-call flag, since
    // IBKR never lets one account's surplus bail out another's deficit.
    minExcess: excess,
    // Negative cash is a real margin loan — that part accrues interest, unlike
    // collateral tied up behind short options.
    borrowed: Math.max(0, -(nav.cash || 0)),
    assumedContracts,
    assumedRequirement,
    assumedShare: requirement > 0 ? assumedRequirement / requirement : 0,
    unparsedContracts,
    unparsedMv,
    // Magnitude of the short-stock deduction, so the panel can name the term
    // only when it actually applies.
    shortStockCharge: -shortStock * 1.3,
    rows: Object.values(byUnderlying).sort((a, b) => b.requirement - a.requirement),
  };
}

// Margin is per account: IBKR does not let one account's shares cover another
// account's short call, nor its credit balance offset another's debit. So the
// merged view sums separately-computed requirements rather than computing one
// requirement over pooled positions.
function mergeMargin(parts) {
  const out = {
    requirement: 0, notional: 0, premium: 0, totalNav: 0, excess: 0, borrowed: 0,
    assumedContracts: 0, assumedRequirement: 0, unparsedContracts: 0,
    unparsedMv: 0, shortStockCharge: 0, rows: [],
  };
  const byU = {};
  out.minExcess = Infinity;
  for (const m of parts) {
    for (const k of ["requirement", "notional", "premium", "totalNav", "excess",
                     "borrowed", "assumedContracts", "assumedRequirement",
                     "unparsedContracts", "unparsedMv", "shortStockCharge"]) {
      out[k] += m[k] || 0;
    }
    // The sum can look fine while one account is under water — margin calls
    // fire per account, so the flag must track the worst one.
    out.minExcess = Math.min(out.minExcess, m.minExcess != null ? m.minExcess : m.excess);
    for (const r of m.rows) {
      // First sight of an underlying seeds the bucket with a copy of the row;
      // that copy already carries the row's values, so it must NOT be added
      // into again. (Comparing `b !== r` doesn't express that — the spread
      // copy is never === the source row, so it re-added the first account.)
      const b = byU[r.underlying];
      if (!b) {
        byU[r.underlying] = { ...r };
        continue;
      }
      for (const k of ["contracts", "puts", "calls", "covered", "requirement",
                       "notional", "premium"]) b[k] += r[k];
      b.priceKnown = b.priceKnown && r.priceKnown;
    }
  }
  out.pctOfNav = out.totalNav > 0 ? out.requirement / out.totalNav : 0;
  out.assumedShare = out.requirement > 0 ? out.assumedRequirement / out.requirement : 0;
  out.rows = Object.values(byU).sort((a, b) => b.requirement - a.requirement);
  return out;
}

function renderMargin(data, accounts) {
  const panel = $("margin-panel");
  const book = buildPriceBook(accounts);
  const merged = (data.account || {}).Account === "ALL";
  const m = merged
    ? mergeMargin(Object.values(accounts || {}).map(a => computeMargin(a, book)))
    : computeMargin(data, book);
  if (!m.rows.length && !m.unparsedContracts) { panel.hidden = true; return; }
  panel.hidden = false;

  $("margin-amount").textContent = fmtMoney(m.requirement);
  $("margin-pct").textContent = fmtPct(m.pctOfNav, 1);
  $("margin-basis").textContent = m.borrowed > 0
    ? `其中融资借款 ${fmtMoney(m.borrowed)}（这部分计息）`
    : "仅为卖出期权抵押，不付利息（现金为正，无融资借款）";

  // Gauge: requirement against net liquidation value.
  const gauge = $("margin-gauge");
  const pct = Math.min(100, Math.max(0, m.pctOfNav * 100));
  // Bands mirror how the cushion actually behaves: under 30% there's plenty of
  // room, past 60% a gap-down starts eating into excess liquidity fast.
  const tone = pct >= 60 ? "var(--red)" : pct >= 30 ? "var(--amber)" : "var(--green)";
  gauge.innerHTML = `<div class="margin-gauge-fill" style="width:${pct}%;background:${tone}"></div>`;
  const gaugeNote = $("margin-gauge-note");
  // The printed formula has to list every term actually deducted, or an
  // account carrying short stock / unparsed contracts sees a number that
  // can't be reconciled with the text sitting next to it. Both extra terms
  // are conditional, so they only show when they're non-zero.
  const excessTerms = "现金 + 75% 正股"
    + (m.shortStockCharge > 0 ? " − 130% 做空正股" : "")
    + (m.unparsedMv > 0 ? " − 未解析合约权利金" : "")
    + " − 占用";
  gaugeNote.textContent =
    `账户总值 ${fmtMoney(m.totalNav)} · 估算剩余流动性 ${fmtMoney(m.excess)}`
    + `（${excessTerms}）`;
  gaugeNote.title =
    "近似 IBKR 的 Excess Liquidity：Reg-T 下长期权（含 LEAP）没有抵押价值、"
    + "正股按 25% 维持保证金扣减，所以不是「净值 − 占用」。"
    + "做空正股不是抵押品 —— 卖出所得已 100% 记在现金里，Reg-T 再加约 30% "
    + "维持保证金，故按 130% 扣减。";

  const note = $("margin-note");
  note.textContent = (m.assumedContracts > 0
    ? `Reg-T 估算 · ${m.assumedContracts} 张合约无正股报价，按平值估算`
      + `（占估算额 ${fmtPct(m.assumedShare, 0)}）`
    : "Reg-T 估算 · 正股价格取自当前持仓")
    + (m.unparsedContracts > 0
      ? ` · ${m.unparsedContracts} 张合约读不出行权价/方向，其权利金负债`
        + `（${fmtMoney(m.unparsedMv)}）已计入并从剩余流动性扣除，`
        + `Reg-T 腿未计 —— 实际占用高于显示`
      : "");
  note.title = m.assumedContracts > 0
    ? "平值假设对价外的卖put偏保守 —— 实际保证金通常低于此。"
      + "买入这些标的的正股后，价格会自动接入，数字随之收紧。"
    : "";

  // Gap stress: same estimator, spot and stock sleeve shocked together.
  // Premiums are not repriced, so every stressed number is a FLOOR — the
  // honest headline is "at least this bad", which is the side a crisis
  // dashboard should err on.
  const stressFor = (shock) => merged
    ? mergeMargin(Object.values(accounts || {}).map(a => computeMargin(a, book, shock)))
    : computeMargin(data, book, shock);
  const scenarios = [0, -0.10, -0.20, -0.30];
  const stressRows = scenarios.map(s => ({ s, m: s === 0 ? m : stressFor(s) }));
  $("margin-stress").innerHTML = `
    <table class="stress-table">
      <thead><tr>
        <th>跳空情景</th><th class="num">保证金占用</th>
        <th class="num">剩余流动性</th><th class="num">占用/净值</th>
      </tr></thead>
      <tbody>${stressRows.map(({ s, m: sm }) => {
        // Margin calls fire per account: the merged sum can be positive
        // while one account is already under water.
        const worst = sm.minExcess != null ? sm.minExcess : sm.excess;
        const busted = worst < 0;
        const partial = busted && sm.excess >= 0;
        return `<tr class="${busted ? "stress-bust" : ""}">
          <td>${s === 0 ? "现价" : `全线 ${fmtPct(s, 0)}`}</td>
          <td class="num">${fmtMoney(sm.requirement)}</td>
          <td class="num ${busted ? "down" : ""}">${fmtMoney(sm.excess)}${
            busted ? (partial ? ` <span title="跨账户不共享抵押品：至少一个账户的剩余流动性已为负">⚠ 单账户</span>` : " ⚠") : ""
          }</td>
          <td class="num">${sm.totalNav > 0 ? fmtPct(sm.requirement / sm.totalNav, 1) : "—"}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>
    <div class="margin-foot">正股与期权标的同步跳空；权利金负债取 max(现价, 跳空后内在价值) ——
      不含时间价值与 IV 爆炸，所以每一行仍是下界（实际会更糟）。剩余流动性转负 ⚠ ≈ 追保/强平区。</div>`;

  const tbody = $("margin-body");
  tbody.innerHTML = "";
  for (const r of m.rows) {
    const kinds = [r.puts ? `${r.puts} PUT` : "", r.calls ? `${r.calls} CALL` : ""].filter(Boolean).join(" · ");
    const priceTag = r.priceKnown ? "" : ` <span class="tag tag-short">估算价</span>`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${r.underlying}</b>${priceTag}</td>
      <td>${kinds}${r.covered ? ` <span class="tag tag-flow-in">${r.covered} 张有正股覆盖</span>` : ""}</td>
      <td class="num">${fmtMoney(r.spot, 2)}</td>
      <td class="num muted">${r.notional ? fmtMoney(r.notional, 0) : "—"}</td>
      <td class="num">${fmtMoney(r.premium, 0)}</td>
      <td class="num"><b>${fmtMoney(r.requirement, 0)}</b></td>
      <td class="num">${fmtPct(m.requirement ? r.requirement / m.requirement : 0, 1)}</td>
    `;
    tbody.appendChild(tr);
  }

  $("margin-foot").textContent =
    `卖出看跌名义抵押合计 ${fmtMoney(m.notional)}（若全部现金担保需要的资金）· `
    + `当前卖方权利金负债 ${fmtMoney(m.premium)}`;
}

/* ---------------------------------------------------------------------------
 * Weekly recap — what moved this week, per underlying.
 *
 * Raw material: dated snapshots the server records on every refresh/upload
 * (uploads/{acct}.snapshots.jsonl, attached to the payload as `snapshots`).
 * The recap diffs the live book against the snapshot closest to seven days
 * back. P&L per underlying = Δunrealized (position-based, clean) +
 * Δrealized (rolling-window cumulative — a trade dropping off the window's
 * far end can distort it, which the panel footnote admits).
 * ------------------------------------------------------------------------- */

const SNAP_MIN_GAP = 5, SNAP_TARGET_GAP = 7, SNAP_MAX_GAP = 16;

// The live payload reduced to the exact shape the server snapshots.
function liveSnapshot(data) {
  const hist = data.nav_history || [];
  // As-of date: the NAV series tail (Flex), else the statement period's end
  // (Activity Statement) — mirroring the server's _as_of_date, so AS-only
  // accounts can diff too instead of forever showing "快照积累中".
  let date = hist.length ? hist[hist.length - 1].date : "";
  if (!date) {
    const b = parsePeriodBounds(data.statement?.Period);
    if (b) date = `${b[1].y}-${String(b[1].m).padStart(2, "0")}-${String(b[1].d).padStart(2, "0")}`;
  }
  const stocks = {};
  for (const s of data.stocks || []) {
    stocks[s.symbol] = [s.quantity, s.close_price, s.value, s.unrealized_pl];
  }
  const perf = {};
  for (const [sym, p] of Object.entries(data.performance?.by_symbol || {})) {
    perf[sym] = [p.realized_total || 0, p.unrealized_total || 0,
                 p.asset_category === "Stocks" ? "S" : "O"];
  }
  return { date, nav: data.nav?.total || 0, stocks, perf };
}

function pickBaseline(snapshots, curDate) {
  if (!curDate) return null;
  const cur = Date.parse(curDate);
  let best = null;
  for (const s of snapshots || []) {
    const gap = Math.round((cur - Date.parse(s.date)) / DAY_MS);
    if (gap < SNAP_MIN_GAP || gap > SNAP_MAX_GAP) continue;
    if (!best || Math.abs(gap - SNAP_TARGET_GAP) < Math.abs(best.gap - SNAP_TARGET_GAP)) {
      best = { snap: s, gap };
    }
  }
  return best;
}

function weeklyDiff(current, snapshots) {
  const base = pickBaseline(snapshots, current.date);
  if (!base) return null;
  const rows = {};
  const R = (u) => rows[u] || (rows[u] = {
    u, pnlU: 0, pnlR: 0, pxPct: null, qtyNow: 0, qtyBase: 0,
  });
  // P&L per underlying: stock rows key by their own symbol, option rows by
  // the underlying pulled from the contract description.
  const keys = new Set([
    ...Object.keys(current.perf || {}), ...Object.keys(base.snap.perf || {}),
  ]);
  for (const k of keys) {
    const now = (current.perf || {})[k] || [0, 0, null];
    const was = (base.snap.perf || {})[k] || [0, 0, null];
    const kind = now[2] || was[2] || "O";
    const u = kind === "S" ? k : optionUnderlying(k);
    if (CASH_EQUIVALENTS.has(u)) continue;  // SGOV drift is not a "mover"
    const r = R(u);
    r.pnlR += now[0] - was[0];
    // Stocks take ΔU from the position maps below, NOT from perf: a stock
    // held at the baseline but absent from that statement's MTM section
    // would otherwise default to 0 and book its entire LIFETIME unrealized
    // as this week's move (a $2k phantom "winner" in live testing).
    // Options have no stocks-map entry, so perf is their only source; a
    // one-sided option row is a genuine open/close, not a data gap.
    if (kind !== "S") r.pnlU += now[1] - was[1];
  }
  const syms = new Set([
    ...Object.keys(current.stocks || {}), ...Object.keys(base.snap.stocks || {}),
  ]);
  for (const sym of syms) {
    if (CASH_EQUIVALENTS.has(sym)) continue;
    const now = (current.stocks || {})[sym];
    const was = (base.snap.stocks || {})[sym];
    const r = R(sym);
    r.pnlU += (now ? now[3] : 0) - (was ? was[3] : 0);
    r.qtyNow = now ? now[0] : 0;
    r.qtyBase = was ? was[0] : 0;
    if (now && was && now[1] > 0 && was[1] > 0) {
      r.pxPct = now[1] / was[1] - 1;
      // A split between the two snapshots changes the share-count unit:
      // qty and price move in reciprocal proportion while the value stays
      // continuous. "-75% · 加仓" would be doubly wrong, so suppress both.
      if (r.qtyBase > 0 && r.qtyNow > 0) {
        const qr = r.qtyNow / r.qtyBase, pr = was[1] / now[1];
        if (Math.abs(qr - 1) > 0.05 && Math.abs(qr / pr - 1) < 0.02) {
          r.pxPct = null;
          r.splitLike = true;
        }
      }
    }
  }
  const list = Object.values(rows)
    .map(r => ({ ...r, total: r.pnlU + r.pnlR }))
    .filter(r => Math.abs(r.total) >= 1 || r.pxPct != null)
    .sort((a, b) => b.total - a.total);
  return {
    baseDate: base.snap.date, days: base.gap,
    navBase: base.snap.nav, navNow: current.nav, rows: list,
  };
}

function positionTag(r) {
  if (r.splitLike) return "";  // share counts changed unit, not conviction
  if (r.qtyBase > 1e-9 && r.qtyNow <= 1e-9) return "清仓";
  if (r.qtyBase <= 1e-9 && r.qtyNow > 1e-9) return "新建";
  if (r.qtyNow > r.qtyBase + 1e-9) return "加仓";
  if (r.qtyNow < r.qtyBase - 1e-9) return "减仓";
  return "";
}

function renderWeekly(data, accounts, selected) {
  const panel = $("weekly-panel");
  const targets = selected === "ALL"
    ? Object.values(accounts || {})
    : [data];
  const anySnapshots = targets.some(a => (a.snapshots || []).length);
  if (!anySnapshots) { panel.hidden = true; return; }
  panel.hidden = false;

  const diffs = [];
  let fresh = 0;
  for (const a of targets) {
    const d = weeklyDiff(liveSnapshot(a), a.snapshots || []);
    if (d) diffs.push(d); else if ((a.snapshots || []).length) fresh++;
  }
  const winnersEl = $("weekly-winners"), losersEl = $("weekly-losers");
  if (!diffs.length) {
    $("weekly-note").textContent = "";
    $("weekly-summary").innerHTML =
      `<span class="muted">快照积累中 —— 最早基线距今不足 ${SNAP_MIN_GAP} 天，`
      + `下次刷新间隔够一周后这里会出现对比。</span>`;
    winnersEl.innerHTML = ""; losersEl.innerHTML = "";
    return;
  }

  // Amounts are additive across accounts; per-account baselines may differ
  // by a day or two, which the note reflects with the widest window.
  const merged = {};
  for (const d of diffs) {
    for (const r of d.rows) {
      const t = merged[r.u] || (merged[r.u] = {
        u: r.u, pnlU: 0, pnlR: 0, total: 0, pxPct: null, qtyNow: 0, qtyBase: 0,
      });
      t.pnlU += r.pnlU; t.pnlR += r.pnlR; t.total += r.total;
      t.qtyNow += r.qtyNow; t.qtyBase += r.qtyBase;
      if (t.pxPct == null) t.pxPct = r.pxPct;  // same security, same move
      t.splitLike = t.splitLike || !!r.splitLike;
      if (t.splitLike) t.pxPct = null;
    }
  }
  const rows = Object.values(merged).sort((a, b) => b.total - a.total);
  const winners = rows.filter(r => r.total > 0).slice(0, 5);
  const losers = rows.filter(r => r.total < 0).reverse().slice(0, 5);

  const baseDates = diffs.map(d => d.baseDate).sort();
  const curDate = liveSnapshot(targets[0]).date || "";
  $("weekly-note").textContent =
    `${baseDates[0]} → ${curDate || "最新"} · ${diffs[0].days} 天`
    + (fresh ? ` · ${fresh} 个账户快照尚新未计入` : "");

  // Headline: NAV change over the same window. Numerator and denominator
  // must cover the SAME account set — summing every account's current NAV
  // against only the baselined accounts' old NAV would book a newly added
  // account's entire balance as this week's "gain". weeklyDiff carries its
  // own navNow so both sides come from exactly the accounts being diffed.
  const navNow = diffs.reduce((s, d) => s + (d.navNow || 0), 0);
  const navBase = diffs.reduce((s, d) => s + (d.navBase || 0), 0);
  // Same account-set rule as the NAV delta above, which the delta learned
  // the hard way: nav_history/cash_flows here cover EVERY loaded account,
  // while `diffs` covers only the baselined ones. Showing a return built
  // from the full household beside a delta built from a subset recreates
  // the same false-household-return the P0 fix removed — one account short
  // of a baseline is enough. Only publish the statistic when every target
  // actually produced a diff.
  const allDiffed = diffs.length === targets.length;
  const slice = allDiffed
    ? (data.nav_history || []).filter(p => p.date >= baseDates[0]) : [];
  const st = allDiffed ? navStats(slice, data.cash_flows || []) : null;
  const navDelta = navNow - navBase;
  $("weekly-summary").innerHTML =
    `<span class="nav-stat"><span class="muted">净值变化</span> <b class="${navDelta >= 0 ? "up" : "down"}">`
    + `${navDelta >= 0 ? "+" : ""}${fmtMoney(navDelta)}</b></span>`
    + (st ? `<span class="nav-stat"><span class="muted">期间收益(剔除出入金)</span> `
      + `<b class="${st.periodReturn >= 0 ? "up" : "down"}">${st.periodReturn >= 0 ? "+" : ""}`
      + `${fmtPct(st.periodReturn, 2)}</b></span>` : "")
    + `<span class="nav-stat"><span class="muted">上涨/下跌标的</span> `
    + `<b>${rows.filter(r => r.total > 0).length} / ${rows.filter(r => r.total < 0).length}</b></span>`;

  const maxAbs = Math.max(...rows.map(r => Math.abs(r.total)), 1);
  const bar = (r) => {
    const tag = positionTag(r);
    const px = r.pxPct != null
      ? `${r.pxPct >= 0 ? "+" : ""}${fmtPct(r.pxPct, 1)}` : "";
    const meta = [px, tag].filter(Boolean).join(" · ");
    return `<div class="wk-row">
      <span class="wk-sym"><b>${r.u}</b></span>
      <div class="wk-bar"><div class="wk-fill ${r.total >= 0 ? "pos" : "neg"}"
        style="width:${Math.max(3, Math.abs(r.total) / maxAbs * 100)}%"></div></div>
      <span class="wk-val ${r.total >= 0 ? "up" : "down"}">${r.total >= 0 ? "+" : ""}${fmtMoney(r.total, 0)}</span>
      <span class="wk-meta muted">${meta}</span>
    </div>`;
  };
  winnersEl.innerHTML = winners.map(bar).join("") || '<div class="muted">无</div>';
  losersEl.innerHTML = losers.map(bar).join("") || '<div class="muted">无</div>';
}

/* ---------------------------------------------------------------------------
 * Cluster exposure — names that move together managed as one position.
 *
 * The mapping lives in static/clusters.json ({"AI-infra": ["RKLB", ...]}),
 * hand-maintained. Exposure = stock market value + assigned-if notional of
 * every short put on the cluster's members: correlated names gap together,
 * so the question is "if this whole cluster gets put to me, how much of NAV
 * is it" — not each ticker on its own.
 * ------------------------------------------------------------------------- */

function computeClusters(data, map) {
  if (!map || !Object.keys(map).length) return null;
  // A symbol may legitimately belong to several clusters ("MU" in both
  // AI-infra and Memory): correlated exposure counts in EVERY cluster that
  // claims it — a symbol→single-cluster map would silently drop it from
  // all but the last, shrinking exactly the concentration number this
  // panel exists to surface. (其他 only catches symbols claimed by none;
  // per-cluster totals may overlap by design and must not be summed.)
  const symClusters = {};
  for (const [name, syms] of Object.entries(map)) {
    for (const s of syms || []) (symClusters[s] || (symClusters[s] = [])).push(name);
  }
  const rows = {};
  const bucket = (name) => rows[name]
    || (rows[name] = { name, stockMV: 0, putNotional: 0, members: {} });
  const member = (b, sym) => b.members[sym]
    || (b.members[sym] = { mv: 0, notional: 0 });
  for (const s of data.stocks || []) {
    if (CASH_EQUIVALENTS.has(s.symbol)) continue;
    for (const name of symClusters[s.symbol] || ["其他"]) {
      const b = bucket(name);
      b.stockMV += s.value || 0;
      member(b, s.symbol).mv += s.value || 0;
    }
  }
  for (const o of data.options || []) {
    if (!(o.quantity < 0) || o.right !== "P" || !(o.strike > 0)) continue;
    const notional = o.strike * Math.abs(o.quantity) * (o.multiplier || CONTRACT_MULTIPLIER);
    for (const name of symClusters[o.underlying] || ["其他"]) {
      const b = bucket(name);
      b.putNotional += notional;
      member(b, o.underlying).notional += notional;
    }
  }
  const nav = data.nav || {};
  const totalNav = nav.total || (nav.cash + nav.stock + nav.options) || 0;
  const list = Object.values(rows).map(r => ({
    ...r,
    total: r.stockMV + r.putNotional,
    pct: totalNav > 0 ? (r.stockMV + r.putNotional) / totalNav : 0,
  }));
  // Defined clusters by size, the catch-all 其他 bucket last.
  list.sort((a, b) =>
    (a.name === "其他") - (b.name === "其他") || b.total - a.total);
  return { totalNav, rows: list };
}

// Cluster panel is built and tested but switched off: with clusters.json
// holding a single group, the dominant row is the catch-all "其他", whose
// percentage is a property of how little has been grouped rather than a
// concentration signal — and it renders red on every load. Flip to true after
// filling in static/clusters.json.
const SHOW_CLUSTER_PANEL = false;

function renderClusters(data, map) {
  const panel = $("cluster-panel");
  if (!SHOW_CLUSTER_PANEL) { panel.hidden = true; return; }
  const c = computeClusters(data, map);
  if (!c || !c.rows.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const defined = c.rows.filter(r => r.name !== "其他");
  $("cluster-note").textContent = defined.length
    ? `${defined.length} 个簇 · 最大簇敞口占净值 ${fmtPct(Math.max(...defined.map(r => r.pct), 0), 1)}`
    : "clusters.json 里还没有分组，全部标的在「其他」";

  const tbody = $("cluster-body");
  tbody.innerHTML = "";
  for (const r of c.rows) {
    const tone = r.pct >= 1 ? "down" : r.pct >= 0.5 ? "amber" : "";
    const members = Object.entries(r.members).map(([sym, m]) => {
      const bits = [];
      if (m.mv) bits.push(fmtMoney(m.mv, 0));
      if (m.notional) bits.push(`put ${fmtMoney(m.notional, 0)}`);
      return `${sym} ${bits.join("+")}`;
    }).join(" · ");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${r.name}</b></td>
      <td class="muted">${members}</td>
      <td class="num">${r.stockMV ? fmtMoney(r.stockMV, 0) : "—"}</td>
      <td class="num">${r.putNotional ? fmtMoney(r.putNotional, 0) : "—"}</td>
      <td class="num"><b>${fmtMoney(r.total, 0)}</b></td>
      <td class="num ${tone}"><b>${fmtPct(r.pct, 1)}</b></td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------------------------------------------------------------------
 * Expiry calendar — short options grouped by the week they expire.
 * ------------------------------------------------------------------------- */

const _EXPIRY_MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
                      JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// "15JAN27" → UTC ms; null on anything unparseable. Both ingestion paths
// emit this spelling (Flex via _fmt_expiry, Activity Statements natively).
function parseExpiryTs(s) {
  const m = (s || "").trim().match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const mon = _EXPIRY_MON[m[2]];
  if (!mon) return null;
  return Date.UTC(2000 + Number(m[3]), mon - 1, Number(m[1]));
}

const DAY_MS = 86400000;

function groupExpiries(options, priceBook, todayTs) {
  const buckets = {};
  for (const o of options || []) {
    if (!(o.quantity < 0)) continue;
    const ts = parseExpiryTs(o.expiry);
    const qty = Math.abs(o.quantity);
    const mult = o.multiplier || CONTRACT_MULTIPLIER;
    // Monday of the expiry's week keys the bucket; unparseable expiries get
    // their own row instead of silently vanishing from a risk view.
    const key = ts != null
      ? ts - (((new Date(ts)).getUTCDay() + 6) % 7) * DAY_MS
      : Infinity;
    const b = buckets[key] || (buckets[key] = {
      weekStart: key, firstExpiry: Infinity, contracts: 0,
      premium: 0, putNotional: 0, itm: 0, likelyItm: 0, unpriced: 0, items: [],
    });
    if (ts != null) b.firstExpiry = Math.min(b.firstExpiry, ts);
    b.contracts += qty;
    b.premium += Math.abs(o.value || 0);
    if (o.right === "P" && o.strike > 0) b.putNotional += o.strike * qty * mult;
    const spot = priceBook[o.underlying];
    if (spot > 0 && o.strike > 0 && (o.right === "P" || o.right === "C")) {
      const itm = o.right === "P" ? spot < o.strike : spot > o.strike;
      if (itm) b.itm += qty;
    } else {
      b.unpriced += qty;
      // No underlying quote (nothing in the portfolio prices this name), so
      // moneyness can't be settled from spot. The contract's OWN mark still
      // says something: an option can't be worth much more than its time
      // value unless it carries intrinsic. A mark above MARK_ITM_RATIO of the
      // strike is not a far-OTM lottery ticket at any listed IV/DTE — that is
      // assignment risk, and reporting it as "0 ITM" reads as reassurance the
      // data does not support. Flagged separately from confirmed ITM because
      // it is inferred from price, not measured against spot.
      const markPerShare = Math.abs(o.value || 0) / (qty * mult);
      if (o.strike > 0 && markPerShare > MARK_ITM_RATIO * o.strike) {
        b.likelyItm += qty;
      }
    }
    b.items.push(`${o.underlying} ${o.strike || "?"}${o.right || "?"} ×${qty}`);
  }
  // DTE counts calendar days, so compare dates, not instants: expiries sit
  // at UTC midnight while todayTs is a local "now" — in UTC+ timezones
  // (Brisbane +10) the raw difference rounds a Friday expiry to 0 while it
  // is still Thursday evening local. Map the local calendar date to UTC
  // midnight first and the difference is an exact whole number of days.
  const now = new Date(todayTs);
  const today0 = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Object.values(buckets)
    .map(b => ({
      ...b,
      dte: b.firstExpiry === Infinity ? null
        : Math.max(0, Math.round((b.firstExpiry - today0) / DAY_MS)),
    }))
    .sort((a, b) => a.weekStart - b.weekStart);
}

function renderExpiries(data, accounts) {
  const panel = $("expiry-panel");
  const book = buildPriceBook(accounts);
  const weeks = groupExpiries(data.options || [], book, Date.now());
  if (!weeks.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const totPrem = weeks.reduce((s, w) => s + w.premium, 0);
  const totNotional = weeks.reduce((s, w) => s + w.putNotional, 0);
  $("expiry-note").textContent =
    `${weeks.reduce((s, w) => s + w.contracts, 0)} 张卖方合约 · `
    + `权利金负债合计 ${fmtMoney(totPrem)} · 卖put名义合计 ${fmtMoney(totNotional)}`;

  const weekLabel = (w) => {
    if (w.weekStart === Infinity) return "到期日未识别";
    const mon = new Date(w.weekStart);
    const fri = new Date(w.weekStart + 4 * DAY_MS);
    const f = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    return `${f(mon)}–${f(fri)}`;
  };
  const tbody = $("expiry-body");
  tbody.innerHTML = "";
  for (const w of weeks) {
    // "0" may only be printed when every contract in the week was actually
    // measured. With an unpriced contract present, 0 is not a finding — it is
    // a gap — and the deep-ITM ones are exactly the contracts that matter.
    const itmCell = w.unpriced
      ? [
          w.itm ? `<span class="down"><b>${w.itm}</b></span>` : "",
          w.likelyItm
            ? `<span class="down" title="无正股报价，按合约自身市价推断：`
              + `权利金已超行权价的 ${fmtPct(MARK_ITM_RATIO, 0)}，几乎不可能是纯时间价值">`
              + `<b>可能 ${w.likelyItm}</b></span>`
            : "",
          `<span class="muted" title="组合里没有该标的正股，无法用现价判定价内外">`
            + `价? ${w.unpriced}</span>`,
        ].filter(Boolean).join(" · ")
      : (w.itm ? `<span class="down"><b>${w.itm}</b></span>` : "0");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${weekLabel(w)}</b></td>
      <td class="num">${w.dte == null ? "—" : w.dte}</td>
      <td class="expiry-items">${w.items.join(" · ")}</td>
      <td class="num">${w.contracts}</td>
      <td class="num">${fmtMoney(w.premium, 0)}</td>
      <td class="num">${w.putNotional ? fmtMoney(w.putNotional, 0) : "—"}</td>
      <td class="num">${itmCell}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------------------------------------------------------------------------
 * NAV history — the equity curve the Flex NAV section has carried all along.
 *
 * The curve plots raw NAV, but every statistic is computed on a TWR chain
 * with external flows stripped out: a $50k deposit is not a +50% day, and a
 * withdrawal is not a drawdown. Flows dated between two NAV points attach to
 * the later point (weekend deposits land on Monday's return).
 * ------------------------------------------------------------------------- */

function navStats(series, flows) {
  const pts = (series || []).filter(p => p.total > 0);
  if (pts.length < 5) return null;
  const fl = (flows || [])
    .map(f => ({ date: f.date, amount: f.amount || 0 }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  let fi = 0;
  // Flows on or before the first observation are starting capital, not P&L.
  while (fi < fl.length && fl[fi].date <= pts[0].date) fi++;
  let index = 1, peak = 1, peakDate = pts[0].date;
  let maxDD = 0, ddStart = pts[0].date, ddEnd = pts[0].date;
  const rets = [];
  for (let i = 1; i < pts.length; i++) {
    // Accumulate the two directions SEPARATELY. Netting them first would
    // cancel a deposit against a withdrawal landing in the same interval
    // (a $50k transfer in and $50k out over one weekend nets to zero) and
    // both timing conventions below would then be applied to nothing,
    // distorting the link exactly when the flows were largest.
    let dep = 0, wd = 0;
    while (fi < fl.length && fl[fi].date <= pts[i].date) {
      const amt = fl[fi].amount;
      if (amt > 0) dep += amt; else wd += amt;
      fi++;
    }
    // Deposits use the begin-of-day convention (they join the denominator),
    // withdrawals the end-of-day one (added back to the numerator): both
    // keep the base large. The naive (end − flow) / begin link divides the
    // day's P&L by the pre-deposit base — seed a $5k account with $200k on
    // a red day and it prints a −20% "drawdown", or flips the whole chain
    // negative. Clamp guards the chain's sign against any residual gap.
    const denom = pts[i - 1].total + dep;
    let r = denom > 0 ? (pts[i].total - wd) / denom - 1 : 0;
    if (r < -0.99) r = -0.99;
    rets.push(r);
    index *= 1 + r;
    // >= so a flat stretch at the peak advances the date: the drawdown
    // "starts" at the last day you were whole, not the first.
    if (index >= peak) { peak = index; peakDate = pts[i].date; }
    const dd = 1 - index / peak;
    if (dd > maxDD) { maxDD = dd; ddStart = peakDate; ddEnd = pts[i].date; }
  }
  const n = rets.length;
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(n - 1, 1);
  const annVol = Math.sqrt(variance) * Math.sqrt(252);
  const annRet = n > 0 ? Math.pow(Math.max(index, 1e-9), 252 / n) - 1 : 0;
  return {
    maxDD, ddStart, ddEnd,
    curDD: 1 - index / peak,
    annVol, annRet,
    // Un-annualized chained return over the series — what a short window
    // (the weekly recap) actually wants; annualizing 5 days is noise.
    periodReturn: index - 1,
    // rf=0 return/vol — labelled as such, not passed off as a true Sharpe.
    retOverVol: annVol > 0 ? annRet / annVol : 0,
    calmar: maxDD > 0 ? annRet / maxDD : 0,
    high: Math.max(...pts.map(p => p.total)),
    low: Math.min(...pts.map(p => p.total)),
    first: pts[0], last: pts[pts.length - 1],
  };
}

function renderNavHistory(data) {
  const panel = $("nav-history-panel");
  const series = (data.nav_history || []).filter(p => p.total > 0);
  const stats = navStats(series, data.cash_flows || []);
  if (!stats) { panel.hidden = true; return; }
  panel.hidden = false;

  $("nav-history-note").textContent =
    `${stats.first.date} → ${stats.last.date} · ${series.length} 个交易日`;

  // Plain SVG polyline — no library, no external anything.
  const W = 800, H = 200, PAD = 4;
  const lo = stats.low, hi = stats.high;
  const spanY = Math.max(hi - lo, 1e-9);
  const x = (i) => PAD + (W - 2 * PAD) * (series.length > 1 ? i / (series.length - 1) : 0);
  const y = (v) => H - PAD - (H - 2 * PAD) * ((v - lo) / spanY);
  const points = series.map((p, i) => `${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(" ");
  const area = `M${x(0).toFixed(1)},${H - PAD} L${points.replaceAll(" ", " L")} L${x(series.length - 1).toFixed(1)},${H - PAD} Z`;
  $("nav-chart").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="净值曲线">
      <path d="${area}" fill="rgba(107,215,255,0.08)"></path>
      <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.6"
        vector-effect="non-scaling-stroke"></polyline>
    </svg>`;

  const chip = (label, val, cls = "") =>
    `<span class="nav-stat"><span class="muted">${label}</span> <b class="${cls}">${val}</b></span>`;
  $("nav-stats").innerHTML = [
    chip("期末", fmtMoney(stats.last.total)),
    chip("期间高/低", `${fmtMoney(stats.high)} / ${fmtMoney(stats.low)}`),
    chip("最大回撤", `−${fmtPct(stats.maxDD, 1)}（${stats.ddStart.slice(5)} → ${stats.ddEnd.slice(5)}）`,
      stats.maxDD >= 0.2 ? "down" : ""),
    chip("当前回撤", stats.curDD > 0.001 ? `−${fmtPct(stats.curDD, 1)}` : "在高点",
      stats.curDD >= 0.1 ? "down" : ""),
    chip("年化收益 TWR", fmtPct(stats.annRet, 1), stats.annRet >= 0 ? "up" : "down"),
    chip("年化波动", fmtPct(stats.annVol, 1)),
    chip("收益/波动 (rf=0)", stats.retOverVol.toFixed(2)),
    chip("Calmar", stats.calmar ? stats.calmar.toFixed(2) : "—"),
  ].join("");
}

/* ---------------------------------------------------------------------------
 * Core holdings & position caps
 *
 * Two decisions per underlying, set in the modal behind the topbar button:
 *   核心持仓 — a label: the treemap ring, the tag, sort priority. Not a rule.
 *   仓位区间 — the share of total assets it should sit between, both ends
 *              typed as free percentages and either one optional
 *
 * The RULES are global — one set of numbers, shared by every account — but the
 * NUMBERS THEY JUDGE follow the account tab you are on: switch to U228 and the
 * weights, badges and verdicts are all that account's. So the same 5–10% band
 * is applied separately to each book, and the 总账户 tab applies it to the
 * combined one.
 *
 * Exposure, per underlying:
 *
 *   正股市值 + 期权多头市值
 *
 * — capital actually deployed into the name. Long options enter at MARKET
 * VALUE, the same number the 资产配置 bar counts, rather than at notional: a
 * LEAPS call's strike × 100 would print a position several times the capital
 * actually at risk. Short legs are excluded on both sides — a short put has no
 * capital in it (its collateral is already counted as cash) and a short call
 * only caps the upside on stock counted above.
 *
 * So an underlying you are only short puts on reads as 0% here. That is the
 * definition working as intended, not a gap: assignment risk is a different
 * question, and 保证金占用 + 卖方到期日历 are the panels that answer it.
 * ------------------------------------------------------------------------- */

// Both ends of the band are free numbers typed as percentages of total NAV
// and stored as fractions. Either may be left blank, which resolves to a
// bound no position can breach — so a blank side simply never fires, and a
// symbol with both blank is "not configured" and warns about nothing.
const BOUND_FLOOR = 0, BOUND_CEIL = 1;
const resolveBounds = (cfg) => [
  cfg && cfg.min != null ? cfg.min : BOUND_FLOOR,
  cfg && cfg.max != null ? cfg.max : BOUND_CEIL,
];

function positionSettings() {
  return (currentDataRef.positionSettings && currentDataRef.positionSettings.symbols) || {};
}

// Symbols reach these rows from two places: the settings file, whose keys the
// server validates against a strict ticker regex, and the parsed statement,
// whose Symbol column is whatever the uploaded CSV said. The rows below put
// them in text AND attribute contexts, so escape rather than trust — a stray
// quote in a ticker would otherwise break straight out of an aria-label.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function computeExposures(data) {
  const nav = data.nav || {};
  const totalNav = nav.total || ((nav.cash || 0) + (nav.stock || 0) + (nav.options || 0)) || 0;
  const rows = {};
  const bucket = (sym) => rows[sym] || (rows[sym] = {
    symbol: sym, stockMV: 0, longOptMV: 0, optionLegs: 0,
  });
  for (const s of data.stocks || []) {
    if (CASH_EQUIVALENTS.has(s.symbol)) continue;
    bucket(s.symbol).stockMV += s.value || 0;
  }
  for (const o of data.options || []) {
    const sym = o.underlying;
    if (!sym || CASH_EQUIVALENTS.has(sym)) continue;
    const b = bucket(sym);
    // Short legs still create the bucket — an underlying held only through
    // sold puts must stay listed (and configurable) even at 0 exposure.
    b.optionLegs += 1;
    if (o.quantity > 0) b.longOptMV += Math.max(o.value || 0, 0);
  }
  for (const b of Object.values(rows)) {
    b.exposure = b.stockMV + b.longOptMV;
    b.weight = totalNav > 0 ? b.exposure / totalNav : 0;
  }
  return { totalNav, bySymbol: rows };
}

// Exposure for the account currently on screen (the 总账户 tab passes the
// merged book, so that case falls out for free). render() recomputes this
// once per pass before anything reads it — the treemap calls it per tile, and
// re-walking every position 22 times would be silly.
function currentExposures() {
  return currentDataRef._exposures || { totalNav: 0, bySymbol: {} };
}

// Every underlying held in ANY loaded account. The rules are global, so the
// modal has to offer every symbol — otherwise a name held only in the account
// you are not looking at would be unconfigurable until you switched tabs.
// Memoized per data load; loadPortfolio() clears it.
function allUnderlyings() {
  if (!currentDataRef._universe) {
    const set = new Set();
    for (const acct of Object.values(currentDataRef.allAccounts || {})) {
      for (const st of acct.stocks || []) {
        if (!CASH_EQUIVALENTS.has(st.symbol)) set.add(st.symbol);
      }
      for (const o of acct.options || []) {
        if (o.underlying && !CASH_EQUIVALENTS.has(o.underlying)) set.add(o.underlying);
      }
    }
    currentDataRef._universe = set;
  }
  return currentDataRef._universe;
}

// null when there is nothing to judge (both boxes blank); else ok/over/under.
// 核心持仓 does NOT gate this. Once the floor is a number you type, gating the
// under-alert on a separate checkbox would mean typing 5% and getting silence
// — the number you entered IS the intent. The flag stays a label: the treemap
// ring, the 核心 tag, and sort priority in the panel.
function positionStatus(weight, cfg) {
  if (!cfg || (cfg.min == null && cfg.max == null)) return null;
  const [lo, hi] = resolveBounds(cfg);
  if (weight > hi) return "over";
  if (weight < lo) return "under";
  return "ok";
}

const POS_STATUS_LABEL = { over: "超上限", under: "欠配", ok: "区间内" };

function exposureTip(r) {
  const bits = [];
  if (r.stockMV) bits.push(`正股 ${fmtMoney(r.stockMV, 0)}`);
  if (r.longOptMV) bits.push(`期权多头 ${fmtMoney(r.longOptMV, 0)}`);
  return bits.join(" + ") || "无投入资本";
}

// One row per CONFIGURED symbol, scored against the account on screen.
// Symbols with no position in this view keep their row: a core holding at 0%
// here is the most extreme under-weight there is, and dropping the row would
// hide exactly the case the panel exists to catch. Whether it is 0% because
// you exited or because it lives in the other account is a real distinction
// though, so carry it.
function positionRows() {
  const cfg = positionSettings();
  const { totalNav, bySymbol } = currentExposures();
  const universe = allUnderlyings();
  const empty = { stockMV: 0, longOptMV: 0, exposure: 0, weight: 0, optionLegs: 0 };
  const rows = Object.keys(cfg).map(sym => {
    const ex = bySymbol[sym] || empty;
    const c = cfg[sym];
    return {
      symbol: sym, ...ex,
      core: !!c.core,
      min: c.min, max: c.max,
      status: positionStatus(ex.weight, c),
      held: !!bySymbol[sym],
      elsewhere: !bySymbol[sym] && universe.has(sym),
    };
  });
  const rank = { over: 0, under: 1, ok: 2 };
  rows.sort((a, b) =>
    (rank[a.status] ?? 3) - (rank[b.status] ?? 3)
    || (b.core - a.core)
    || b.weight - a.weight);
  return { totalNav, rows };
}

function renderCorePositions(scopeLabel) {
  const panel = $("core-panel");
  const { totalNav, rows } = positionRows();
  if (!rows.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const alerts = rows.filter(r => r.status === "over" || r.status === "under");
  const coreCount = rows.filter(r => r.core).length;
  $("core-note").textContent =
    `${coreCount} 个核心持仓 · ${rows.length} 条规则 · `
    + (alerts.length ? `${alerts.length} 项需要调整` : "全部在区间内")
    + ` · 口径 ${scopeLabel || "当前账号"}（总净值 ${fmtMoney(totalNav)}）`;

  const tbody = $("core-body");
  tbody.innerHTML = "";
  for (const r of rows) {
    const [lo, hi] = resolveBounds(r);
    // Bar scale leaves room above the upper bound so an over-weight marker
    // lands inside the track instead of pinning to the right edge. A blank
    // 上限 resolves to 100%, which must NOT set the scale — it would squash
    // every real number into the leftmost few pixels — so only a typed one
    // counts, and the open-ended zone just runs off the right edge.
    const scale = Math.max((r.max || 0) * 1.6, lo * 1.6, r.weight * 1.15, 0.02);
    const pct = (v) => Math.min(100, Math.max(0, v / scale * 100));
    let band = "";
    if (r.status) {
      band = `<div class="band-zone" style="left:${pct(lo)}%;width:${pct(hi) - pct(lo)}%"></div>`;
      if (r.max != null) band += `<div class="band-cap" style="left:${pct(hi)}%"></div>`;
    }
    const tone = r.status === "over" ? "down" : r.status === "under" ? "amber" : "";
    const target = !r.status ? "—"
      : r.min == null ? `≤ ${fmtPct(r.max, 1)}`
      : r.max == null ? `≥ ${fmtPct(r.min, 1)}`
      : `${fmtPct(r.min, 1)} – ${fmtPct(r.max, 1)}`;
    let verdict = '<span class="muted">未设区间</span>';
    if (r.status === "over") {
      verdict = `<span class="tag tag-over">超上限 +${((r.weight - hi) * 100).toFixed(1)}pp</span>`;
    } else if (r.status === "under") {
      verdict = `<span class="tag tag-under">欠配 −${((lo - r.weight) * 100).toFixed(1)}pp</span>`;
    } else if (r.status === "ok") {
      verdict = '<span class="tag tag-inband">区间内</span>';
    }
    // Zero exposure has three very different causes and a core holding sitting
    // at 0% deserves to say which: it is in the other account, you are out of
    // it entirely, or you only sold premium on it (which this definition
    // deliberately does not count as capital deployed).
    const stateTag = r.elsewhere ? ' <span class="tag tag-gone">本账号无持仓</span>'
      : !r.held ? ' <span class="tag tag-gone">已清仓</span>'
      : r.exposure > 0 ? ""
      : ' <span class="tag tag-gone">仅卖方期权</span>';
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${esc(r.symbol)}</b>${r.core ? ' <span class="tag tag-core">核心</span>' : ""}${stateTag}</td>
      <td class="num" title="${esc(exposureTip(r))}">${fmtMoney(r.exposure, 0)}</td>
      <td class="num ${tone}"><b>${fmtPct(r.weight, 1)}</b></td>
      <td class="num muted">${target}</td>
      <td class="band-cell">
        <div class="band-bar" title="标尺 0 – ${fmtPct(scale, 1)}">
          ${band}<div class="band-mark ${r.status || ""}" style="left:${pct(r.weight)}%"></div>
        </div>
      </td>
      <td>${verdict}</td>
    `;
    tbody.appendChild(tr);
  }
}

// Treemap decoration for one stock tile. Tile and badge now describe the same
// book — whichever account is on screen. They are still not the same NUMBER:
// the tile's AREA is stock market value, the badge weighs stock + long option
// market value against NAV, so a name held mostly through calls can wear a
// 超上限 badge on a modest tile. The tooltip prints both.
function tileFlag(symbol) {
  const cfg = positionSettings()[symbol];
  if (!cfg) return { core: false, status: null };
  const row = currentExposures().bySymbol[symbol];
  const weight = row ? row.weight : 0;
  const status = positionStatus(weight, cfg);
  const scope = currentDataRef.selected === "ALL" ? "全账户合并" : "本账号";
  const parts = [cfg.core ? "核心持仓" : "已设区间", `${scope}敞口占比 ${fmtPct(weight, 1)}`];
  if (cfg.min != null || cfg.max != null) {
    parts.push(cfg.min == null ? `上限 ${fmtPct(cfg.max, 1)}`
      : cfg.max == null ? `下限 ${fmtPct(cfg.min, 1)}`
      : `目标区间 ${fmtPct(cfg.min, 1)} – ${fmtPct(cfg.max, 1)}`);
  }
  if (status === "over" || status === "under") parts.push(POS_STATUS_LABEL[status]);
  return {
    core: !!cfg.core,
    status,
    icon: status === "over" ? "▲" : status === "under" ? "▼" : "",
    badge: status === "over" ? "▲ 超上限" : status === "under" ? "▼ 欠配" : "",
    tip: parts.join(" · "),
  };
}

/* --- The settings modal --------------------------------------------------- */

// Draft state lives here while the modal is open; nothing is written until
// 保存, so 取消 / Esc really do discard.
let posDraft = null;

// Fraction → the string that goes in the input box, and back. The toFixed
// round-trip is not decoration: 0.05 * 100 is 5.000000000000001 in binary
// floating point, and that is what the user would see in the box.
const boundToInput = (v) => (v == null || Number.isNaN(v) ? "" : String(+(v * 100).toFixed(4)));
const inputToBound = (raw) => {
  const t = String(raw).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? +(n / 100).toFixed(6) : NaN;
};

// Row order in the modal. Kept in module scope, not reset on open — the order
// you last picked is the one you get next time.
const POS_SORTS = {
  // Ties broken by ticker in every mode, so the list never reshuffles between
  // two renders that agree on the primary key.
  weight: (a, b) => b.w - a.w || a.sym.localeCompare(b.sym),
  symbol: (a, b) => a.sym.localeCompare(b.sym),
  core: (a, b) => b.core - a.core || b.w - a.w || a.sym.localeCompare(b.sym),
};
let posSort = "weight";

function openPositionModal() {
  const cfg = positionSettings();
  // Rows: every underlying held in ANY account (the rules are global), plus
  // anything already configured — so a rule on a since-exited symbol stays
  // editable and removable. The percentages beside them are the CURRENT
  // view's, which the modal note says out loud.
  posDraft = {};
  for (const sym of new Set([...allUnderlyings(), ...Object.keys(cfg)])) {
    const c = cfg[sym] || {};
    posDraft[sym] = { core: !!c.core, min: c.min ?? null, max: c.max ?? null };
  }
  renderPositionRows();
  $("pos-status").textContent = "";
  $("pos-modal").hidden = false;
  document.body.classList.add("modal-open");
  $("pos-modal-close").focus();
}

// Rebuilt from posDraft, never from the stored config — so re-sorting in the
// middle of an edit keeps every box exactly as typed.
function renderPositionRows() {
  const { bySymbol } = currentExposures();
  const rows = Object.keys(posDraft || {}).map(sym => ({
    sym,
    core: posDraft[sym].core,
    // Not held in THIS view sorts below a held-but-zero position (short
    // premium only), which is a real difference, not a tie.
    w: bySymbol[sym] ? bySymbol[sym].weight : -1,
  }));
  rows.sort(POS_SORTS[posSort] || POS_SORTS.weight);

  $("pos-sort").querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.sort === posSort));

  const tbody = $("pos-body");
  tbody.innerHTML = "";
  for (const { sym } of rows) {
    const ex = bySymbol[sym];
    const tr = document.createElement("tr");
    tr.dataset.sym = sym;
    const held = ex && ex.exposure > 0
      ? `${fmtPct(ex.weight, 1)} · ${fmtMoney(ex.exposure, 0)}`
      : ex ? "0% · 仅卖方期权"
      : allUnderlyings().has(sym) ? "本账号无持仓"
      : "已清仓";
    tr.innerHTML = `
      <td>
        <b>${esc(sym)}</b>
        <div class="pos-sub" title="${esc(ex ? exposureTip(ex) : "无持仓")}">${esc(held)}</div>
      </td>
      <td>
        <label class="pos-check">
          <input type="checkbox" data-role="core" ${posDraft[sym].core ? "checked" : ""} />
          <span>核心持仓</span>
        </label>
      </td>
      <td>
        <div class="pos-range">
          <input type="number" data-role="min" inputmode="decimal" step="any"
                 min="0" max="100" placeholder="0" aria-label="${esc(sym)} 下限百分比"
                 value="${boundToInput(posDraft[sym].min)}" /><span class="pct">%</span>
          <span class="dash">–</span>
          <input type="number" data-role="max" inputmode="decimal" step="any"
                 min="0" max="100" placeholder="100" aria-label="${esc(sym)} 上限百分比"
                 value="${boundToInput(posDraft[sym].max)}" /><span class="pct">%</span>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function closePositionModal() {
  $("pos-modal").hidden = true;
  document.body.classList.remove("modal-open");
  posDraft = null;
}

// Returns the first offending symbol, or "" when the draft is sound. The
// server rejects the same cases, but a 400 naming one symbol out of thirty
// is a worse way to find out than a message next to the row.
function firstBadBound() {
  for (const [sym, d] of Object.entries(posDraft || {})) {
    if (Number.isNaN(d.min) || Number.isNaN(d.max)) return `${sym}：百分比填的不是数字`;
    for (const v of [d.min, d.max]) {
      if (v != null && (v < 0 || v > 1)) return `${sym}：百分比要在 0 – 100 之间`;
    }
    if (d.min != null && d.max != null && d.min > d.max) {
      return `${sym}：下限 ${boundToInput(d.min)}% 大于上限 ${boundToInput(d.max)}%`;
    }
  }
  return "";
}

async function savePositionSettings() {
  const bad = firstBadBound();
  if (bad) { $("pos-status").textContent = bad; return; }
  const btn = $("pos-save");
  btn.disabled = true;
  $("pos-status").textContent = "保存中…";
  // Only real decisions travel. The server drops no-op entries anyway, but
  // sending them would grow the file with every symbol ever held.
  const symbols = {};
  for (const [sym, d] of Object.entries(posDraft || {})) {
    if (d.core || d.min != null || d.max != null) {
      symbols[sym] = { core: d.core, min: d.min, max: d.max };
    }
  }
  try {
    const res = await fetch("/api/settings/positions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols }),
    });
    const j = await res.json();
    if (!res.ok) {
      $("pos-status").textContent = "";
      showToast("error", "保存失败", j.error || `HTTP ${res.status}`);
      return;
    }
    currentDataRef.positionSettings = j;
    closePositionModal();
    showToast("success", "已保存", `${Object.keys(j.symbols || {}).length} 条持仓规则`);
    if (currentDataRef.data) render(currentDataRef.data);
  } catch (exc) {
    $("pos-status").textContent = "";
    showToast("error", "保存失败", String(exc));
  } finally {
    btn.disabled = false;
  }
}

function wirePositionModal() {
  $("pos-btn").addEventListener("click", openPositionModal);
  $("pos-modal-close").addEventListener("click", closePositionModal);
  $("pos-cancel").addEventListener("click", closePositionModal);
  $("pos-save").addEventListener("click", savePositionSettings);
  // Re-sorting rebuilds the rows from posDraft, so anything typed survives it.
  $("pos-sort").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-sort]");
    if (!btn || btn.dataset.sort === posSort) return;
    posSort = btn.dataset.sort;
    renderPositionRows();
  });
  // Backdrop click closes; a click inside the dialog must not reach it.
  $("pos-modal").addEventListener("click", (e) => {
    if (e.target === $("pos-modal")) closePositionModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("pos-modal").hidden) closePositionModal();
  });
  // Delegated: the table is rebuilt on every open, and per-row listeners
  // would be re-attached (and leak) with it.
  $("pos-body").addEventListener("input", (e) => {
    const role = e.target.dataset.role;
    if (role !== "min" && role !== "max") return;
    const d = posDraft[e.target.closest("tr").dataset.sym];
    d[role] = inputToBound(e.target.value);
    // Live feedback while typing, but never mid-keystroke clamping — being
    // told "5 > 1" halfway through typing "15" would be maddening.
    e.target.classList.toggle("bad", Number.isNaN(d[role]));
    $("pos-status").textContent = firstBadBound();
  });
  $("pos-body").addEventListener("change", (e) => {
    if (e.target.dataset.role !== "core") return;
    posDraft[e.target.closest("tr").dataset.sym].core = e.target.checked;
  });
}

function renderTreemap(stocks) {
  const el = $("treemap");
  el.innerHTML = "";
  if (!stocks.length) {
    el.innerHTML = '<div class="muted" style="padding:30px">无股票持仓</div>';
    return;
  }
  const rect = el.getBoundingClientRect();
  const w = rect.width, h = rect.height || 480;

  const root = d3.hierarchy({ children: stocks.map(s => ({ ...s, size: Math.max(s.value, 0.0001) })) })
    .sum(d => d.size);
  d3.treemap().size([w, h]).padding(4).round(true)(root);

  const maxAbs = d3.max(stocks, d => Math.abs(d.unrealized_pl)) || 1;
  const color = (pl) => {
    const t = Math.max(-1, Math.min(1, pl / maxAbs));
    // vibrant green for positive, vibrant red for negative
    if (t >= 0) return d3.interpolateRgb("#16a34a", "#22ff7a")(0.3 + t * 0.7);
    return d3.interpolateRgb("#dc2626", "#ff3355")(0.3 + Math.abs(t) * 0.7);
  };

  for (const leaf of root.leaves()) {
    const d = leaf.data;
    const w = leaf.x1 - leaf.x0;
    const h = leaf.y1 - leaf.y0;
    const div = document.createElement("div");
    div.className = "tile";
    div.style.left = leaf.x0 + "px";
    div.style.top = leaf.y0 + "px";
    div.style.width = w + "px";
    div.style.height = h + "px";
    div.style.background = color(d.unrealized_pl);

    // Core / band markers. Tile and badge describe the same book — whichever
    // account tab is open — but not the same NUMBER: the tile's AREA is stock
    // market value, while the badge weighs stock + long option market value
    // against NAV. So a name held mostly through calls can wear a 超上限 badge
    // on a modest tile, and the tooltip prints both figures.
    const flag = tileFlag(d.symbol);
    if (flag.core) div.classList.add("tile-core");
    if (flag.status === "over" || flag.status === "under") div.classList.add("tile-" + flag.status);

    // Scale font sizes proportionally to tile size, with a floor
    const symSize = Math.max(8, Math.min(16, Math.min(w / 5, h / 4)));
    const metaSize = Math.max(8, symSize * 0.7);
    div.style.padding = w < 60 ? "4px 6px" : "10px 12px";

    if (w < 36 || h < 28) {
      // Tile too small for any text
      div.innerHTML = "";
    } else if (w < 70 || h < 60) {
      div.innerHTML = `<div class="sym" style="font-size:${symSize}px">${d.symbol}</div>`;
    } else {
      div.innerHTML = `
        <div class="sym" style="font-size:${symSize}px">${d.symbol}</div>
        <div class="meta" style="font-size:${metaSize}px">${fmtMoney(d.value)}</div>
        <div class="pnl" style="font-size:${metaSize}px">${d.unrealized_pl >= 0 ? "+" : ""}${fmtMoney(d.unrealized_pl)}</div>`;
    }
    // Badge goes on after innerHTML — the text branches above overwrite it.
    // Below ~48px it would sit on top of the ticker, and the coloured
    // outline (red over / amber under) already carries the same signal.
    if (flag.badge && w >= 48 && h >= 28) {
      const badge = document.createElement("div");
      badge.className = `tile-badge ${flag.status}`;
      badge.textContent = w < 90 ? flag.icon : flag.badge;
      div.appendChild(badge);
    }
    div.title = `${d.symbol}\n市值 ${fmtMoney(d.value, 2)}\n成本 ${fmtMoney(d.cost_basis, 2)}\n浮盈 ${fmtMoney(d.unrealized_pl, 2)}`
      + (flag.tip ? `\n\n${flag.tip}` : "");
    el.appendChild(div);
  }
}

function renderAllocation(nav, totalNav) {
  const cashAbs = Math.max(nav.cash, 0);
  const stockAbs = Math.max(nav.stock, 0);
  const longOptAbs = Math.max(nav.longOptions || 0, 0);
  const total = cashAbs + stockAbs + longOptAbs || 1;
  const segs = [
    { label: "现金", value: cashAbs, color: "var(--accent-2)" },
    { label: "股票", value: stockAbs, color: "var(--cyan)" },
    { label: "期权多头", value: longOptAbs, color: "var(--amber)" },
  ];

  const bar = $("alloc-bar");
  bar.innerHTML = "";
  for (const s of segs) {
    if (s.value <= 0) continue;
    const div = document.createElement("div");
    div.className = "alloc-seg";
    div.style.background = s.color;
    const pct = (s.value / total * 100);
    div.style.width = pct + "%";
    // Scale font with segment width so smaller slices still show
    if (pct >= 6) {
      div.style.fontSize = "12px";
      div.textContent = `${s.label} ${pct.toFixed(1)}%`;
    } else if (pct >= 2.5) {
      div.style.fontSize = "10px";
      div.textContent = `${pct.toFixed(1)}%`;
    } else {
      div.textContent = "";
    }
    div.title = `${s.label} ${fmtMoney(s.value)} · ${pct.toFixed(1)}%`;
    bar.appendChild(div);
  }
  const legend = $("alloc-legend");
  const segLines = segs.map(s =>
    `<div><span class="dot" style="background:${s.color}"></span>${s.label} ${fmtMoney(s.value)} · ${(s.value/total*100).toFixed(1)}%</div>`
  );
  if (nav.shortOptionsNote > 0) {
    segLines.push(`<div class="muted" style="margin-left:auto">另有卖方期权义务 ${fmtMoney(nav.shortOptionsNote)}（权利金已在现金中）</div>`);
  }
  legend.innerHTML = segLines.join("");
}

const stocksSort = { key: "value", dir: "desc" };

function renderHoldings(stocks) {
  const tbody = $("holdings-body");
  tbody.innerHTML = "";
  const totalVal = stocks.reduce((s, x) => s + x.value, 0) || 1;
  const enriched = stocks.map(s => ({
    ...s,
    ret: s.cost_basis ? s.unrealized_pl / s.cost_basis : 0,
    weight: s.value / totalVal,
  }));
  enriched.sort((a, b) => {
    const av = a[stocksSort.key], bv = b[stocksSort.key];
    return stocksSort.dir === "asc" ? av - bv : bv - av;
  });
  for (const s of enriched) {
    const tr = document.createElement("tr");
    const cashEqTag = CASH_EQUIVALENTS.has(s.symbol) ? ` <span class="tag tag-flow-in">现金等价</span>` : "";
    tr.innerHTML = `
      <td><b>${s.symbol}</b>${cashEqTag}</td>
      <td class="num">${fmtNum(s.quantity, 4)}</td>
      <td class="num">${fmtMoney(s.cost_price, 2)}</td>
      <td class="num">${fmtMoney(s.close_price, 2)}</td>
      <td class="num muted">${fmtMoney(s.cost_basis, 0)}</td>
      <td class="num">${fmtMoney(s.value, 0)}</td>
      <td class="num ${s.unrealized_pl >= 0 ? "up" : "down"}">${s.unrealized_pl >= 0 ? "+" : ""}${fmtMoney(s.unrealized_pl, 0)}</td>
      <td class="num ${s.ret >= 0 ? "up" : "down"}">${(s.ret * 100).toFixed(1)}%</td>
      <td class="num">${(s.weight * 100).toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  }
  updateSortIndicators("holdings-body", stocksSort);
}

const optionsSort = { key: "abs_value", dir: "desc" };

function renderOptions(options) {
  const panel = $("options-panel");
  if (!options.length) { panel.hidden = true; return; }
  panel.hidden = false;
  const tbody = $("options-body");
  tbody.innerHTML = "";
  const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const parseExpiry = (s) => {
    const m = (s || "").match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!m) return Infinity;
    return new Date(2000 + parseInt(m[3]), MONTHS[m[2]] ?? 0, parseInt(m[1])).getTime();
  };
  const fmtExpiry = (ts) => {
    if (!isFinite(ts)) return "—";
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}/${mm}/${dd}`;
  };
  const enriched = options.map(o => ({
    ...o,
    abs_value: Math.abs(o.value),
    abs_cost: Math.abs(o.cost_basis),
    abs_qty: Math.abs(o.quantity),
    expiry_ts: parseExpiry(o.expiry),
    expiry_fmt: fmtExpiry(parseExpiry(o.expiry)),
    // Return = P/L as % of premium basis (works for both long and short options)
    ret: o.cost_basis ? o.unrealized_pl / Math.abs(o.cost_basis) : 0,
  }));
  enriched.sort((a, b) => {
    const av = a[optionsSort.key], bv = b[optionsSort.key];
    return optionsSort.dir === "asc" ? av - bv : bv - av;
  });
  for (const o of enriched) {
    const isBuy = o.quantity > 0;
    const isCall = o.right === "C";
    // Action: buy/sell × call/put
    const actionLabel = (isBuy ? "买入" : "卖出") + (isCall ? "看涨" : "看跌");
    const actionClass = isBuy ? "tag-long" : "tag-short";
    // Market bias: long call & short put = bullish; short call & long put = bearish
    const isBullish = (isBuy && isCall) || (!isBuy && !isCall);
    const biasLabel = isBullish ? "看多" : "看空";
    const biasClass = isBullish ? "tag-bull" : "tag-bear";
    const rightTag = isCall ? `<span class="tag tag-call">CALL</span>` : `<span class="tag tag-put">PUT</span>`;
    // Premium cash-flow direction: buy = paid (付), sell = received (收)
    const flowTag = isBuy ? `<span class="tag tag-flow-out">付</span>` : `<span class="tag tag-flow-in">收</span>`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${o.underlying}</b> ${rightTag}</td>
      <td><span class="tag ${actionClass}">${actionLabel}</span></td>
      <td><span class="tag ${biasClass}">${biasLabel}</span></td>
      <td class="num">${o.strike ? "$" + o.strike : "—"}</td>
      <td>${o.expiry_fmt}</td>
      <td class="num">${o.quantity}</td>
      <td class="num">${fmtMoney(Math.abs(o.cost_basis), 0)} ${flowTag}</td>
      <td class="num">${fmtMoney(Math.abs(o.value), 0)}</td>
      <td class="num ${o.unrealized_pl >= 0 ? "up" : "down"}">${o.unrealized_pl >= 0 ? "+" : ""}${fmtMoney(o.unrealized_pl, 0)}</td>
      <td class="num ${o.ret >= 0 ? "up" : "down"}">${o.ret >= 0 ? "+" : ""}${(o.ret * 100).toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  }
  updateSortIndicators("options-body", optionsSort);
}

/* ---------------------------------------------------------------------------
 * Dividends — payouts over the statement period.
 *
 * The parser hands us gross (dividends + payment-in-lieu) and tax (withholding,
 * already negative) so net is just their sum. The window is whatever the Flex
 * query covers — a "Last 365 Calendar Days" query can't see further back than
 * that, so the panel labels the period rather than implying since-inception.
 * ------------------------------------------------------------------------- */

// Fill the gaps so a month with no payout still gets a (zero-height) bar —
// otherwise quarterly payers render as an evenly-spaced row that hides the
// actual cadence.
function monthRange(months, period) {
  if (!months.length) return [];
  const step = (ym, delta) => {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const byMonth = Object.fromEntries(months.map(m => [m.month, m]));
  // Span the whole reporting window, not just first payout to last. A
  // quarterly payer inside a 12-month window otherwise renders ~10 bars and
  // the monthly average divides by the wrong number of months — and the empty
  // months at the edges are exactly where a missed ex-date would show.
  const bounds = parsePeriodBounds(period);
  let cur = months[0].month;
  let last = months[months.length - 1].month;
  if (bounds) {
    const ym = (b) => `${b.y}-${String(b.m).padStart(2, "0")}`;
    const b1 = ym(bounds[0]), b2 = ym(bounds[1]);
    if (b1 < cur) cur = b1;
    if (b2 > last) last = b2;
  }
  const out = [];
  for (let i = 0; i < 240 && cur <= last; i++) {
    out.push(byMonth[cur] || { month: cur, gross: 0, tax: 0, net: 0 });
    cur = step(cur, 1);
  }
  return out;
}

function renderDividends(data) {
  const panel = $("dividends-panel");
  const div = data.dividends;
  const empty = $("div-empty");
  const body = $("div-content");
  panel.hidden = false;

  if (!div || !div.by_symbol || !div.by_symbol.length) {
    // Distinguish "no payouts" from "the query never asked for them" — the
    // fix for the second one is a checkbox in the Flex query, not the code.
    empty.hidden = false;
    body.hidden = true;
    $("div-note").textContent = "";
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  // Every money value below is dividend cash in the elected base currency.
  const fm = (v, d) => fmtCcy(v, d, div.base_currency);

  $("div-net").textContent = fm(div.net, 2);
  const foreignCcys = Object.keys(div.foreign || {});
  $("div-gross").textContent = `税前 ${fm(div.gross, 2)} · 预扣税 ${fm(div.tax, 2)}`
    + (foreignCcys.length
      ? ` · 另有 ${foreignCcys.map(c => `${c} ${fmtNum(div.foreign[c].net, 2)}`).join(" / ")}`
        + ` 未计入（多币种不换汇）`
      : "");

  // Yield is against the stock sleeve, not total NAV: cash and short options
  // pay no dividends, so dividing by NAV would understate what the equity
  // actually returns.
  const stockValue = (data.stocks || []).reduce((s, x) => s + x.value, 0);
  const yieldPct = stockValue > 0 ? div.net / stockValue : 0;
  $("div-yield").textContent = stockValue > 0
    ? `${fmtPct(yieldPct, 2)} 分红收益率（净额 ÷ 当前股票市值 ${fmtMoney(stockValue)}）`
    : "";

  const accrued = data.nav?.dividend_accruals || 0;
  const sourceLabel = {
    cash_transactions: "Cash Transactions",
    statement_of_funds: "Statement of Funds",
    activity_statement: "Activity Statement",
    mixed: "多来源（各账户报表类型不同）",
  }[div.source] || "报表";
  $("div-note").textContent = `${data.statement?.Period || ""} · 数据来自 ${sourceLabel}`
    + (accrued ? ` · 另有应计未付 ${fm(accrued, 2)}` : "");

  // Monthly bars
  const months = monthRange(div.by_month || [], data.statement?.Period);
  const maxNet = Math.max(...months.map(m => Math.abs(m.net)), 1);
  const chart = $("div-chart");
  chart.innerHTML = months.map(m => {
    const h = Math.max(2, Math.abs(m.net) / maxNet * 100);
    const label = m.month.slice(2).replace("-", "/");
    return `<div class="div-bar" title="${m.month} 净分红 ${fm(m.net, 2)}">
        <div class="div-bar-fill" style="height:${h}%"></div>
        <div class="div-bar-label">${label}</div>
      </div>`;
  }).join("");
  const best = months.reduce((a, b) => (b.net > (a?.net ?? -Infinity) ? b : a), null);
  $("div-chart-note").textContent = months.length
    ? `${months.length} 个月 · 月均 ${fm(div.net / months.length, 2)}`
      + (best && best.net > 0 ? ` · 最高 ${best.month} ${fm(best.net, 2)}` : "")
    : "";

  const tbody = $("div-body");
  tbody.innerHTML = "";
  // Yield is per-share on both sides: the payments you actually collected per
  // share, over what you paid per share. Dividing total dividends by the
  // current cost basis instead would compare a full year of payouts against
  // whatever position survived to today — on a position trimmed 90% through
  // the year that reads as a 36% yield. Per-share cancels the size change out.
  const costPrice = {};
  for (const s of data.stocks || []) if (s.cost_price > 0) costPrice[s.symbol] = s.cost_price;
  // Closed positions fall back to a cost rebuilt from the period's trades.
  // IBKR's own CostBasisPrice wins whenever the position still exists — the
  // rebuilt average only describes a position that ended flat.
  const hist = data.cost_history || {};
  for (const s of div.by_symbol) {
    const tr = document.createElement("tr");
    const open = s.symbol in costPrice;
    const h = hist[s.symbol];
    const rebuilt = !open && h && h.covered && h.avg_price > 0 ? h.avg_price : 0;
    const soldTag = open ? "" : ` <span class="tag tag-flow-out">已清仓</span>`;
    const cp = open ? costPrice[s.symbol] : rebuilt;
    const dps = s.per_share || 0;
    // Still no cost means the position was opened before this statement's
    // window, so its buys simply aren't in the data to average.
    // Annualized, because that is what a dividend yield means everywhere —
    // TTM, forward, SEC 30-day, yield-on-cost are all annual rates. It is also
    // the only form that lets the column be sorted: a 5.05% collected over 312
    // days and a 1.90% over 182 days aren't measuring the same thing until
    // both are put on a yearly footing. The raw collected figure stays in the
    // tooltip, and the window is printed under the number so a rate
    // extrapolated from a few weeks can't pass for a settled one. Below a
    // month the extrapolation is noise, so it is withheld entirely.
    const days = h && h.days ? h.days : 0;
    // Yield counts dividend income only. A fund's capital-gain distribution
    // arrives as cash through the same channel but isn't yield — it's realized
    // trading profit handed back, and on a leveraged ETF it can be most of the
    // payout. It stays in 税前/净额 (the cash was real) and out of this rate.
    const dpsIncome = s.per_share_ordinary != null ? s.per_share_ordinary : dps;
    const realized = (cp && dpsIncome) ? dpsIncome / cp : 0;
    const annual = (realized && days >= 30) ? realized * 365 / days : 0;
    const nonDiv = s.non_dividend || 0;
    // Worth flagging only when it moves the number, not on a rounding tail.
    const nonDivShare = s.gross > 0 ? nonDiv / s.gross : 0;
    // Did the shares actually exist on the ex-dates? The merged view ships a
    // pre-summed benchmark (each account's avg_shares × its own rates) —
    // summed avg_shares times the unioned rate would overstate it whenever
    // the accounts held the name over different stretches.
    const avgShares = h && h.avg_shares ? h.avg_shares : 0;
    const should = h && h.should_gross != null ? h.should_gross : avgShares * dps;
    const shortfall = should - s.gross;
    const missed = should > 0 && s.gross / should < CAPTURE_FLAG_RATIO
      && shortfall >= CAPTURE_FLAG_DOLLARS;

    const marks = `${rebuilt ? '<span class="muted">†</span>' : ""}`
      + `${s.rate_missing ? '<span class="muted">*</span>' : ""}`;
    const yieldCell = annual
      ? `${fmtPct(annual, 2)}${marks}<div class="yield-days">${days} 天</div>`
      : realized
        ? `<span class="muted">—</span>${marks}`
          + `<div class="yield-days">${days ? days + " 天，太短" : ""}</div>`
        : `<span class="muted">—</span>`;
    const yieldTitle = (cp && dps)
      ? `每股股息 ${fm(dpsIncome, 4)}`
        + (nonDiv ? `（已扣除每股 ${fm(dps - dpsIncome, 4)} 的资本利得分配）` : "")
        + ` ÷ ${rebuilt ? "重建" : "平均"}成本 ${fm(cp, 2)}`
        + ` = 实收 ${fmtPct(realized, 2)}`
        + (days ? `（${days} 天）` : "")
        + (annual ? ` · 年化 ${fmtPct(annual, 2)}` : days ? " · 不足 30 天，不做年化" : "")
        + (h && h.pre_existing ? "（建仓早于报表期间，只算期内）" : "")
        + (rebuilt ? ` · 已清仓，成本由本期 ${fmtNum(h.bought_qty, 2)} 股买入记录重建` : "")
        + (s.rate_missing ? ` · ${s.rate_missing} 笔代付股息(PIL)不含每股报价，实际略高于此` : "")
      // The Activity Statement path builds no cost_history at all (no
      // Statement of Funds trade rows), so "opened before the window" would
      // be a fabricated explanation there — the machinery is simply absent.
      // In a merged view with heterogeneous sources one flag can't say which
      // pipeline this symbol came through, so the wording stays neutral.
      : div.source === "activity_statement"
        ? "Activity Statement 不含逐笔资金记录，无法重建成本与持有天数 ——"
          + " 用 Flex 刷新（含 Statement of Funds）可得成本股息率"
        : div.source === "mixed"
          ? "该标的所在账户的报表不含逐笔资金记录（Activity Statement），"
            + "或建仓早于报表期间 —— 两种情况都无法重建成本"
          : "建仓在报表期间之前，本期数据里没有买入记录，无法重建成本";
    tr.innerHTML = `
      <td><b>${s.symbol}</b>${soldTag}${nonDivShare >= 0.05 ? ` <span class="tag tag-capgain" title="${
        `其中 ${fm(nonDiv, 2)}（占税前 ${fmtPct(nonDivShare, 0)}）是资本利得/资本返还分配，`
        + `不是股息收入。已计入税前与净额，但不计入成本股息率。`
      }">含资本利得</span>` : ""}${missed ? ` <span class="tag tag-miss" title="${
        `期间平均持仓 ${fmtNum(avgShares, 2)} 股，若整段持有本可收 ${fm(should, 2)}，`
        + `实收 ${fm(s.gross, 2)}，差 ${fm(shortfall, 2)}。`
        + `常见原因：除息日前清仓（当期分红作废），或期间才建仓（错过前几次）。`
      }">除息日缺口 ${fm(shortfall, 0)}</span>` : ""}</td>
      <td class="num">${s.count}</td>
      <td class="num muted">${fm(s.gross, 2)}</td>
      <td class="num ${s.tax < 0 ? "down" : "muted"}">${s.tax ? fm(s.tax, 2) : "—"}</td>
      <td class="num"><b>${fm(s.net, 2)}</b></td>
      <td class="num">${fmtPct(div.net ? s.net / div.net : 0, 1)}</td>
      <td class="num muted">${dps ? fm(dps, 4) : "—"}</td>
      <td class="num" title="${yieldTitle}">${yieldCell}</td>
      <td class="muted">${s.last_date || "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

function updateSortIndicators(tbodyId, state) {
  const table = document.getElementById(tbodyId).closest("table");
  table.querySelectorAll("th.sortable").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === state.key) {
      th.classList.add(state.dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

function attachSorters(currentDataRef) {
  document.querySelectorAll("table.holdings").forEach(table => {
    const isOptions = table.querySelector("#options-body");
    const state = isOptions ? optionsSort : stocksSort;
    table.querySelectorAll("th.sortable").forEach(th => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.key === key) {
          state.dir = state.dir === "asc" ? "desc" : "asc";
        } else {
          state.key = key;
          state.dir = "desc";
        }
        if (isOptions) renderOptions(currentDataRef.data.options);
        else renderHoldings(currentDataRef.data.stocks);
      });
    });
  });
}

let rankMode = "underlying";

function optionUnderlying(sym) {
  // "NVDA 17JUL26 155 P" -> "NVDA". Corporate-action-adjusted contracts are
  // spelled with a numeric suffix ("COHR1 16OCT26 320 C") — strip it so the
  // adjusted legs merge back onto the same underlying as the stock; US
  // tickers themselves never contain digits.
  const m = sym.match(/^([A-Z\.]+)\d*\s/);
  return m ? m[1] : sym;
}

function buildRankEntries(bySymbol, mode) {
  const arr = Object.entries(bySymbol).map(([sym, p]) => ({ sym, ...p }));
  if (mode === "stocks") {
    return arr
      .filter(x => x.asset_category === "Stocks")
      .map(x => ({ key: x.sym, value: x.realized_total, note: "已实现" }));
  }
  if (mode === "options_underlying") {
    const byU = {};
    for (const x of arr) {
      if (!x.asset_category || x.asset_category === "Stocks") continue;
      const u = optionUnderlying(x.sym);
      if (!byU[u]) byU[u] = { realized: 0, unrealized: 0 };
      byU[u].realized += x.realized_total;
      byU[u].unrealized += x.unrealized_total;
    }
    return Object.entries(byU).map(([u, v]) => ({
      key: u,
      value: v.realized + v.unrealized,
      note: `已实现 ${fmtMoney(v.realized, 0)} · 浮动 ${fmtMoney(v.unrealized, 0)}`,
    }));
  }
  if (mode === "underlying") {
    // Strategy P&L: per underlying, sum stock + options (realized + unrealized)
    const byU = {};
    for (const x of arr) {
      const isStock = x.asset_category === "Stocks";
      const u = isStock ? x.sym : optionUnderlying(x.sym);
      if (!byU[u]) byU[u] = { sR: 0, sU: 0, oR: 0, oU: 0 };
      if (isStock) {
        byU[u].sR += x.realized_total;
        byU[u].sU += x.unrealized_total;
      } else {
        byU[u].oR += x.realized_total;
        byU[u].oU += x.unrealized_total;
      }
    }
    return Object.entries(byU).map(([u, v]) => {
      const total = v.sR + v.sU + v.oR + v.oU;
      const parts = [];
      if (v.sR || v.sU) parts.push(`股 ${fmtMoney(v.sR + v.sU, 0)}`);
      if (v.oR || v.oU) parts.push(`期权 ${fmtMoney(v.oR + v.oU, 0)}`);
      return { key: u, value: total, note: parts.join(" · ") || "—" };
    });
  }
  // all realized
  return arr.map(x => ({ key: x.sym, value: x.realized_total, note: "已实现" }));
}

function renderRankings(bySymbol) {
  const explain = {
    underlying: "按标的合并：股票 + 期权的「已实现 + 浮动」全部相加，反映你在该 ticker 上的真实 thesis 净盈亏",
    stocks: "仅看股票的已实现盈亏，不受期权展期干扰",
    options_underlying: "同一标的所有期权合约的「已实现 + 浮动」合并，包含未平仓的 premium",
    all: "全部标的的原始已实现盈亏（含展期噪声，仅供对账）",
  };
  $("rank-explain").textContent = explain[rankMode];

  const entries = buildRankEntries(bySymbol, rankMode);
  const winners = entries.filter(x => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 10);
  const losers = entries.filter(x => x.value < 0).sort((a, b) => a.value - b.value).slice(0, 10);
  const render = (rows, cls, prefix) => rows.map(r =>
    `<li><span class="sym">${r.key}</span>
       <span class="${cls}">${prefix}${fmtMoney(r.value, 0)}<span class="muted" style="margin-left:8px;font-weight:400;font-size:11px">${r.note}</span></span>
     </li>`
  ).join("") || '<li class="muted">无</li>';
  $("winners").innerHTML = render(winners, "up", "+");
  $("losers").innerHTML = render(losers, "down", "");
}

function showToast(kind, title, detail = "", durationMs = 4500) {
  const el = $("toast");
  el.className = `toast ${kind}`;
  // textContent (not innerHTML) — title and detail can include server-supplied
  // strings (IBKR error messages, account ids) that must not be parsed as HTML.
  el.replaceChildren();
  const titleEl = document.createElement("div");
  titleEl.className = "toast-title";
  titleEl.textContent = title;
  el.appendChild(titleEl);
  if (detail) {
    const detailEl = document.createElement("div");
    detailEl.className = "toast-detail";
    detailEl.textContent = detail;
    el.appendChild(detailEl);
  }
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, durationMs);
}

async function refreshFromIBKR() {
  const btn = $("refresh-btn");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("spinning");
  const label = btn.querySelector(".refresh-label");
  const origLabel = label.textContent;
  label.textContent = "同步中...";
  try {
    const res = await fetch("/api/refresh", { method: "POST" });
    const data = await res.json();
    if (res.status === 429) {
      showToast("warn", "请稍后再试", data.error || "刷新过于频繁");
      return;
    }
    if (!res.ok) {
      showToast("error", "同步失败", data.error || `HTTP ${res.status}`);
      return;
    }
    const ok = (data.results || []).filter(r => r.ok);
    const failed = (data.results || []).filter(r => !r.ok);
    const okAccts = ok.flatMap(r => r.accounts || []);
    if (ok.length && !failed.length) {
      showToast("success", "已更新", okAccts.join(" + ") || "数据已同步");
    } else if (ok.length && failed.length) {
      showToast("warn", "部分成功",
        `成功: ${okAccts.join(", ")} / 失败: ${failed.map(f => `${f.tag} (${f.error})`).join("; ")}`);
    } else {
      const first = failed[0] || {};
      showToast("error", "同步失败", first.error || "未知错误");
    }
    if (ok.length) await loadPortfolio();
  } catch (exc) {
    showToast("error", "同步失败", String(exc));
  } finally {
    btn.disabled = false;
    btn.classList.remove("spinning");
    label.textContent = origLabel;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("refresh-btn").addEventListener("click", refreshFromIBKR);
  wirePositionModal();

  // Core-holding rules. Like the cluster fetch below, the first render may
  // land before this resolves, so re-render once it arrives.
  //
  // The button ships disabled and only this success path enables it. A failed
  // GET leaves positionSettings null, which every reader treats as "nothing
  // configured" — and opening the modal on top of that would show 32 blank
  // rows, so 保存 would PUT an empty map over a perfectly good server-side
  // config and wipe every rule without the user ever seeing them. A dead
  // button and a toast beat silent data loss.
  fetch("/api/settings/positions")
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(cfg => {
      currentDataRef.positionSettings = cfg;
      const btn = $("pos-btn");
      btn.disabled = false;
      btn.title = "标记核心持仓、设置每个标的的仓位区间";
      if (currentDataRef.data) render(currentDataRef.data);
    })
    .catch(exc => {
      $("pos-btn").title = "持仓规则读取失败，刷新页面重试";
      showToast("error", "持仓规则读取失败",
        `${exc.message || exc} · 按钮已停用，以免空配置覆盖服务器上已存的规则`, 8000);
    });

  // Cluster mapping — a static file the user edits by hand. 404/parse
  // failure just leaves the panel hidden; nothing else depends on it.
  fetch("/static/clusters.json")
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then(map => {
      currentDataRef.clusters = map;
      if (currentDataRef.data) renderClusters(currentDataRef.data, map);
    });

  $("file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $("status").textContent = "解析中…";
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const j = await res.json();
    if (!res.ok) {
      $("status").textContent = "失败: " + (j.error || "未知错误");
      return;
    }
    $("status").textContent = "已更新 ✓";
    await loadPortfolio();
    setTimeout(() => $("status").textContent = "", 2500);
  });

  attachSorters(currentDataRef);

  document.querySelectorAll("#rank-mode button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#rank-mode button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      rankMode = btn.dataset.mode;
      if (currentDataRef.data) renderRankings(currentDataRef.data.performance.by_symbol);
    });
  });

  loadPortfolio();
});
