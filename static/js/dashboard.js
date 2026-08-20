/* IBKR Portfolio Dashboard — frontend */

// Symbols treated as cash equivalents (money-market / short-T ETFs).
// They're held in the brokerage account but used as parked cash.
const CASH_EQUIVALENTS = new Set(["BOXX", "SGOV"]);

const fmtMoney = (v, digits = 0) => {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return sign + "$" + abs.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
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

const fmtSpan = (days) => {
  if (!days || days <= 0) return "";
  if (days >= 350) {
    const yrs = days / 365;
    return yrs >= 1.9 ? `近 ${yrs.toFixed(1)} 年` : "近 12 个月";
  }
  const months = Math.round(days / 30.44);
  return months >= 2 ? `近 ${months} 个月` : `近 ${days} 天`;
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
    for (const s of d.by_symbol) v[0] += s.count || 0;
    v[1] += Math.abs(d.gross || 0);
  }
  const divBase = Object.keys(ccyVotes).reduce((best, c) => {
    if (!best) return c;
    const [a, b] = [ccyVotes[best], ccyVotes[c]];
    return (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1])) ? c : best;
  }, "");
  const otherBase = (d) =>
    !!(d.base_currency && divBase && d.base_currency !== divBase);

  const divSym = {}, divMonth = {}, divForeign = {};
  let divGross = 0, divTax = 0, divNonDiv = 0, divSource = "";
  for (const a of list) {
    const d = a.dividends;
    if (!d || !d.by_symbol) continue;
    divSource = !divSource ? d.source
      : (d.source && d.source !== divSource ? "mixed" : divSource);
    // Foreign-currency payouts are excluded from every total, so summing the
    // per-currency buckets across accounts is safe — they're plain cash.
    for (const [c, f] of Object.entries(d.foreign || {})) {
      const t = divForeign[c] || (divForeign[c] = { gross: 0, tax: 0, net: 0, count: 0 });
      t.gross += f.gross; t.tax += f.tax; t.net += f.net; t.count += f.count || 0;
    }
    if (otherBase(d)) {
      // Whole account denominated in another currency: report, don't add.
      const t = divForeign[d.base_currency]
        || (divForeign[d.base_currency] = { gross: 0, tax: 0, net: 0, count: 0 });
      t.gross += d.gross || 0; t.tax += d.tax || 0; t.net += d.net || 0;
      for (const s of d.by_symbol) t.count += s.count || 0;
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
    if (otherBase(d)) continue;  // whole account reported under foreign
    // Occurrence ordinal per account: a cancel + re-book at the same
    // date/rate is (+r, -r, +r) — without the ordinal the re-book collides
    // with the original's key and the union nets to zero, re-dropping in
    // the merged view the exact payout the parser's own seq keeps. Counting
    // per account, then unioning on (payment, n), still collapses the same
    // payment seen from two accounts while keeping within-account repeats.
    const occ = {};
    for (const e of d.events || []) {
      if (e.kind !== "gross" || !e.per_share) continue;
      // Foreign-currency rates never joined the account's own by_symbol
      // sums, so they must not join the union either — an AUD rate divided
      // by a USD cost is not a yield.
      const base = d.base_currency || "";
      if (e.currency && base && e.currency !== base) continue;
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
    if (!otherBase(a.dividends || {})) {
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

  // If accounts share the same period (the usual case) collapse to one.
  const periods = [...new Set(list.map(a => a.statement?.Period).filter(Boolean))];
  return {
    account: { Account: "ALL" },
    statement: { Period: periods.length === 1 ? periods[0] : periods.join(" / ") },
    nav, stocks, options, dividends, cost_history,
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
  $("account-line").textContent = [masked, period].filter(Boolean).join(" · ") || "已导入";

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
  const span = fmtSpan(spanDays);
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

  // Treemap
  renderTreemap(stocks);

  // Allocation bar — position view: cash, stock, long options (MV)
  // Short options excluded (their premium is already in cash); shown as a footnote.
  const longOptMV = options.filter(o => o.value > 0).reduce((s, o) => s + o.value, 0);
  const shortOptMV = options.filter(o => o.value < 0).reduce((s, o) => s + Math.abs(o.value), 0);
  renderAllocation({ cash: adjCash, stock: adjStock, longOptions: longOptMV, shortOptionsNote: shortOptMV }, totalNav);

  // Margin — prices are pooled across every loaded account, so pass the whole
  // set rather than just the account being viewed.
  renderMargin(data, currentDataRef.allAccounts);

  // Holdings — show all positions including cash equivalents (tagged)
  renderHoldings(data.stocks);

  // Options
  renderOptions(options);

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

function computeMargin(data, priceBook) {
  const stocks = data.stocks || [];
  const options = data.options || [];
  const nav = data.nav || {};
  const totalNav = nav.total || (nav.cash + nav.stock + nav.options);

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
  // multi-thousand-dollar requirement quietly prints as ~$250. Exclude them
  // and say so — an admitted gap beats a silently wrong total.
  let unparsedContracts = 0;
  for (const o of shorts) {
    if (!(o.strike > 0) || (o.right !== "P" && o.right !== "C")) {
      unparsedContracts += Math.abs(o.quantity);
      continue;
    }
    const qty = Math.abs(o.quantity);
    const mult = o.multiplier || CONTRACT_MULTIPLIER;
    const shares = qty * mult;
    const mv = Math.abs(o.value);
    const known = priceBook[o.underlying];
    // No price anywhere in the portfolio → assume the contract sits at the
    // money. That lands the estimate on 20% of strike, the middle of the
    // Reg-T range, and every such contract is counted so the UI can say so.
    const spot = known || o.strike;
    if (!known) assumedContracts += qty;

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
  //   excess ≈ (cash + stock) − (25% × stock + short-option requirement)
  const stockValue = nav.stock || 0;
  return {
    requirement,
    notional,
    premium,
    totalNav,
    pctOfNav: totalNav > 0 ? requirement / totalNav : 0,
    excess: (nav.cash || 0) + stockValue * 0.75 - requirement,
    // Negative cash is a real margin loan — that part accrues interest, unlike
    // collateral tied up behind short options.
    borrowed: Math.max(0, -(nav.cash || 0)),
    assumedContracts,
    assumedRequirement,
    assumedShare: requirement > 0 ? assumedRequirement / requirement : 0,
    unparsedContracts,
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
    assumedContracts: 0, assumedRequirement: 0, unparsedContracts: 0, rows: [],
  };
  const byU = {};
  for (const m of parts) {
    for (const k of ["requirement", "notional", "premium", "totalNav", "excess",
                     "borrowed", "assumedContracts", "assumedRequirement",
                     "unparsedContracts"]) {
      out[k] += m[k] || 0;
    }
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
  gaugeNote.textContent =
    `账户总值 ${fmtMoney(m.totalNav)} · 估算剩余流动性 ${fmtMoney(m.excess)}`
    + `（现金 + 75% 正股 − 占用）`;
  gaugeNote.title =
    "近似 IBKR 的 Excess Liquidity：Reg-T 下长期权（含 LEAP）没有抵押价值、"
    + "正股按 25% 维持保证金扣减，所以不是「净值 − 占用」。";

  const note = $("margin-note");
  note.textContent = (m.assumedContracts > 0
    ? `Reg-T 估算 · ${m.assumedContracts} 张合约无正股报价，按平值估算`
      + `（占估算额 ${fmtPct(m.assumedShare, 0)}）`
    : "Reg-T 估算 · 正股价格取自当前持仓")
    + (m.unparsedContracts > 0
      ? ` · ${m.unparsedContracts} 张合约读不出行权价/方向，未计入 —— 实际占用高于显示`
      : "");
  note.title = m.assumedContracts > 0
    ? "平值假设对价外的卖put偏保守 —— 实际保证金通常低于此。"
      + "买入这些标的的正股后，价格会自动接入，数字随之收紧。"
    : "";

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
    div.title = `${d.symbol}\n市值 ${fmtMoney(d.value, 2)}\n成本 ${fmtMoney(d.cost_basis, 2)}\n浮盈 ${fmtMoney(d.unrealized_pl, 2)}`;
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

  $("div-net").textContent = fmtMoney(div.net, 2);
  const foreignCcys = Object.keys(div.foreign || {});
  $("div-gross").textContent = `税前 ${fmtMoney(div.gross, 2)} · 预扣税 ${fmtMoney(div.tax, 2)}`
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
  }[div.source] || "报表";
  $("div-note").textContent = `${data.statement?.Period || ""} · 数据来自 ${sourceLabel}`
    + (accrued ? ` · 另有应计未付 ${fmtMoney(accrued, 2)}` : "");

  // Monthly bars
  const months = monthRange(div.by_month || [], data.statement?.Period);
  const maxNet = Math.max(...months.map(m => Math.abs(m.net)), 1);
  const chart = $("div-chart");
  chart.innerHTML = months.map(m => {
    const h = Math.max(2, Math.abs(m.net) / maxNet * 100);
    const label = m.month.slice(2).replace("-", "/");
    return `<div class="div-bar" title="${m.month} 净分红 ${fmtMoney(m.net, 2)}">
        <div class="div-bar-fill" style="height:${h}%"></div>
        <div class="div-bar-label">${label}</div>
      </div>`;
  }).join("");
  const best = months.reduce((a, b) => (b.net > (a?.net ?? -Infinity) ? b : a), null);
  $("div-chart-note").textContent = months.length
    ? `${months.length} 个月 · 月均 ${fmtMoney(div.net / months.length, 2)}`
      + (best && best.net > 0 ? ` · 最高 ${best.month} ${fmtMoney(best.net, 2)}` : "")
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
      ? `每股股息 ${fmtMoney(dpsIncome, 4)}`
        + (nonDiv ? `（已扣除每股 ${fmtMoney(dps - dpsIncome, 4)} 的资本利得分配）` : "")
        + ` ÷ ${rebuilt ? "重建" : "平均"}成本 ${fmtMoney(cp, 2)}`
        + ` = 实收 ${fmtPct(realized, 2)}`
        + (days ? `（${days} 天）` : "")
        + (annual ? ` · 年化 ${fmtPct(annual, 2)}` : days ? " · 不足 30 天，不做年化" : "")
        + (h && h.pre_existing ? "（建仓早于报表期间，只算期内）" : "")
        + (rebuilt ? ` · 已清仓，成本由本期 ${fmtNum(h.bought_qty, 2)} 股买入记录重建` : "")
        + (s.rate_missing ? ` · ${s.rate_missing} 笔代付股息(PIL)不含每股报价，实际略高于此` : "")
      // The Activity Statement path builds no cost_history at all (no
      // Statement of Funds trade rows), so "opened before the window" would
      // be a fabricated explanation there — the machinery is simply absent.
      : div.source === "activity_statement"
        ? "Activity Statement 不含逐笔资金记录，无法重建成本与持有天数 ——"
          + " 用 Flex 刷新（含 Statement of Funds）可得成本股息率"
        : "建仓在报表期间之前，本期数据里没有买入记录，无法重建成本";
    tr.innerHTML = `
      <td><b>${s.symbol}</b>${soldTag}${nonDivShare >= 0.05 ? ` <span class="tag tag-capgain" title="${
        `其中 ${fmtMoney(nonDiv, 2)}（占税前 ${fmtPct(nonDivShare, 0)}）是资本利得/资本返还分配，`
        + `不是股息收入。已计入税前与净额，但不计入成本股息率。`
      }">含资本利得</span>` : ""}${missed ? ` <span class="tag tag-miss" title="${
        `期间平均持仓 ${fmtNum(avgShares, 2)} 股，若整段持有本可收 ${fmtMoney(should, 2)}，`
        + `实收 ${fmtMoney(s.gross, 2)}，差 ${fmtMoney(shortfall, 2)}。`
        + `常见原因：除息日前清仓（当期分红作废），或期间才建仓（错过前几次）。`
      }">除息日缺口 ${fmtMoney(shortfall, 0)}</span>` : ""}</td>
      <td class="num">${s.count}</td>
      <td class="num muted">${fmtMoney(s.gross, 2)}</td>
      <td class="num ${s.tax < 0 ? "down" : "muted"}">${s.tax ? fmtMoney(s.tax, 2) : "—"}</td>
      <td class="num"><b>${fmtMoney(s.net, 2)}</b></td>
      <td class="num">${fmtPct(div.net ? s.net / div.net : 0, 1)}</td>
      <td class="num muted">${dps ? fmtMoney(dps, 4) : "—"}</td>
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
  // "NVDA 17JUL26 155 P" -> "NVDA"
  const m = sym.match(/^([A-Z\.]+)\s/);
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
