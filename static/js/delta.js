/* ---------------------------------------------------------------------------
 * Delta exposure — every position counted as the shares it moves like.
 *
 * The rest of the board measures an underlying by the capital in it: stock
 * value plus what the long options are worth. A name held only through sold
 * puts reads 0% there, by definition (the core panel says so). That answers
 * "where is my money" and says nothing about "what does a drop cost": a put
 * sold deep in the money moves almost share for share with the stock.
 *
 *   delta shares = stock shares + Σ contract delta × contracts × multiplier
 *   delta $      = delta shares × the underlying's close
 *
 * A short put's delta shares are positive — through it you are long the
 * stock. The 卖 put column keeps them apart, because how much of a name's
 * exposure they are is the thing the capital view cannot show.
 *
 * Each contract's delta is Black-Scholes at the implied vol backed out of its
 * own closing mark, so the market's pricing (skew, a crash day's vol) is in
 * it. Not modelled: dividends, anything past first order, and early exercise
 * — a European model reads part of a deep-ITM American put's exercise value
 * as vol, so its delta comes out a little short. Checked against a CRR tree
 * on the 2026-11-05 short puts: most within 0.01, ORCL 175P (134 days) 0.05,
 * LITX 25P (priced at intrinsic, so −1 on the tree) 0.07 — about 2% of the
 * puts' delta dollars in all, not worth a tree on every render. Short puts
 * are short gamma — the delta grows as the stock falls — so the linear
 * 每跌 1% is honest for small moves only, and the −10% line beside it
 * reprices every contract instead.
 *
 * Spot: the statement's own stock mark where an account dated the same day
 * holds the shares; otherwise that date's close from /api/underlying-closes
 * (Yahoo, parser/quotes.py). Never a later price: the option marks are that
 * day's, and a vol solved against another day's spot is a wrong vol.
 *
 * Follows the account tab. 总账户 computes each account on its own statement
 * date and sums.
 * ------------------------------------------------------------------------- */

// Risk-free rate for the Black-Scholes solve. Delta hardly notices it: moving
// it a full point shifts the 2028 LEAPs' deltas by under 0.01, and only a
// deep-ITM put with months left moves more (ORCL 175P, 0.02) — so a round
// number beats plumbing in a yield.
const DELTA_RATE = 0.04;
// Bisection range for the implied vol, 0.01% to 2000%. A 3x ETF after a crash
// day trades well past 150%; nothing listed comes near the ceiling.
const DELTA_VOL_MIN = 1e-4, DELTA_VOL_MAX = 20;
const DELTA_YEAR_MS = 365 * 86400000;
// The stress line beside the linear one: everything gaps this far at once.
const DELTA_SHOCK = -0.10;
// A failed /api/underlying-closes is asked again on a render after this long.
const DELTA_RETRY_MS = 60 * 1000;

// Standard normal CDF through erfc — Numerical Recipes' Chebyshev fit, whose
// fractional error stays under 1.2e-7 into the tails, where a deep
// out-of-the-money contract's solve spends its time.
function deltaNormCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196
    + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398
    + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

// European Black-Scholes value per share. No time or no vol collapses to the
// discounted intrinsic value, which is the vol → 0 limit.
function bsValue(right, S, K, T, r, vol) {
  const df = Math.exp(-r * Math.max(T, 0));
  if (!(T > 0) || !(vol > 0)) {
    return right === "C" ? Math.max(S - K * df, 0) : Math.max(K * df - S, 0);
  }
  const sd = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + vol * vol / 2) * T) / sd;
  const d2 = d1 - sd;
  return right === "C"
    ? S * deltaNormCdf(d1) - K * df * deltaNormCdf(d2)
    : K * df * deltaNormCdf(-d2) - S * deltaNormCdf(-d1);
}

// Delta per share of ONE long contract: a call in [0, 1], a put in [−1, 0].
function bsDelta(right, S, K, T, r, vol) {
  if (!(T > 0) || !(vol > 0)) {
    // The vol → 0 limit: all or nothing against the discounted strike.
    const k = K * Math.exp(-r * Math.max(T, 0));
    if (right === "C") return S > k ? 1 : S < k ? 0 : 0.5;
    return S < k ? -1 : S > k ? 0 : -0.5;
  }
  const d1 = (Math.log(S / K) + (r + vol * vol / 2) * T) / (vol * Math.sqrt(T));
  return right === "C" ? deltaNormCdf(d1) : deltaNormCdf(d1) - 1;
}

// The vol at which bsValue matches the mark, by bisection: the value rises
// strictly with vol, so this always converges and cannot wander off to a
// second root the way Newton can from a bad start.
//   0    the mark is at or under the vol-0 floor. An American put deep in the
//        money trades at intrinsic, which a European model can only read as
//        "no time value at all" — its delta is then the floor's −1.
//   null no vol reaches the mark (at or above S for a call, the discounted
//        strike for a put): the mark and the spot disagree, say so.
function impliedVol(right, mark, S, K, T, r) {
  if (!(T > 0)) return 0;
  const df = Math.exp(-r * T);
  const floor = right === "C" ? Math.max(S - K * df, 0) : Math.max(K * df - S, 0);
  const ceil = right === "C" ? S : K * df;
  if (!(mark > floor)) return 0;
  if (mark >= ceil || bsValue(right, S, K, T, r, DELTA_VOL_MAX) < mark) return null;
  let lo = DELTA_VOL_MIN, hi = DELTA_VOL_MAX;
  for (let i = 0; i < 100 && hi - lo > 1e-7; i++) {
    const mid = (lo + hi) / 2;
    if (bsValue(right, S, K, T, r, mid) < mark) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// One contract, as of `asOfTs` (the statement date at UTC midnight — the same
// instant its mark and the spot were taken). `shares` is the position's
// delta in shares of the underlying, sign included: a short put is positive.
// `shockPnl` is the contract repriced at the same vol after a DELTA_SHOCK gap.
function optionDelta(o, spot, asOfTs) {
  const right = o.right, K = o.strike;
  const exp = parseExpiryTs(o.expiry);
  if ((right !== "C" && right !== "P") || !(K > 0) || exp == null) return { status: "unparsed" };
  if (!(spot > 0)) return { status: "unpriced" };
  const qty = o.quantity || 0;
  const mult = o.multiplier || CONTRACT_MULTIPLIER;
  const T = Math.max(0, (exp - asOfTs) / DELTA_YEAR_MS);
  const mark = o.close_price > 0 ? o.close_price
    : (qty ? Math.abs(o.value || 0) / Math.abs(qty * mult) : 0);
  const iv = impliedVol(right, mark, spot, K, T, DELTA_RATE);
  // An unsolvable mark still sits on one side of the strike: fall back to the
  // vol-0 delta and flag the contract rather than drop its exposure.
  const vol = iv || 0;
  const delta = bsDelta(right, spot, K, T, DELTA_RATE, vol);
  const shockPnl = (bsValue(right, spot * (1 + DELTA_SHOCK), K, T, DELTA_RATE, vol)
    - bsValue(right, spot, K, T, DELTA_RATE, vol)) * qty * mult;
  return { status: iv == null ? "nosolve" : "ok", delta, iv, T, mark,
           shares: delta * qty * mult, shockPnl };
}

// The statement's own date — same rules as parser/snapshots.py _as_of_date,
// so a fallback here lands on the date the server fetched for.
function deltaAsOf(data) {
  const h = (data && data.nav_history) || [];
  if (h.length && h[h.length - 1].date) return h[h.length - 1].date;
  const period = ((data && data.statement) || {}).Period || "";
  const iso = period.match(/\d{4}-\d{2}-\d{2}/g);
  if (iso) return iso.sort()[iso.length - 1];
  const b = parsePeriodBounds(period);
  if (!b) return "";
  const p2 = (n) => String(n).padStart(2, "0");
  return `${b[1].y}-${p2(b[1].m)}-${p2(b[1].d)}`;
}

// "2026-11-05" → that date's UTC midnight, the clock parseExpiryTs uses. An
// undatable statement falls back to today, which only shortens time to expiry.
function deltaDayTs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

// Which "date symbol" pairs have no stock mark to price them — the client's
// mirror of parser/quotes.py needed_closes, so the page knows whether to ask
// at all and what to call "still loading".
function deltaNeeds(accounts, dayOf) {
  const held = {};
  for (const [id, a] of Object.entries(accounts || {})) {
    const day = dayOf(id);
    if (!day) continue;
    const set = held[day] || (held[day] = new Set());
    for (const s of a.stocks || []) if (s.close_price > 0) set.add(s.symbol);
  }
  const need = new Set();
  for (const [id, a] of Object.entries(accounts || {})) {
    const day = dayOf(id);
    if (!day) continue;
    for (const o of a.options || []) {
      const u = (o.underlying || "").trim();
      if (u && !held[day].has(u)) need.add(`${day} ${u}`);
    }
  }
  return [...need].sort();
}

// sym → { px, src, bar } | null for one statement date: stock marks from the
// accounts dated that day first, then the fetched close for that day.
function deltaPricer(accounts, closes, day, dayOf) {
  const book = {};
  for (const [id, a] of Object.entries(accounts || {})) {
    if (dayOf(id) !== day) continue;
    for (const s of a.stocks || []) {
      if (s.close_price > 0 && !(s.symbol in book)) book[s.symbol] = { px: s.close_price, src: "ibkr", bar: day };
    }
  }
  const fetched = (closes && closes[day]) || {};
  return (sym) => {
    if (book[sym]) return book[sym];
    const c = fetched[sym];
    return c && c.close > 0 ? { px: c.close, src: "yahoo", bar: c.bar || day } : null;
  };
}

function blankDeltaRow(symbol) {
  return {
    symbol, spot: null, src: null, bar: "",
    stockShares: 0, stockValue: 0, stockLines: [],
    // Delta shares and delta dollars, by where they come from.
    legs: { shortPut: 0, longCall: 0, shortCall: 0, longPut: 0 },
    legValue: { stock: 0, shortPut: 0, longCall: 0, shortCall: 0, longPut: 0 },
    capital: 0,        // stock value + long option value: the core panel's measure
    shockPnl: 0,
    contracts: [],
    unpriced: 0, unparsed: 0, nosolve: 0,     // contract counts
  };
}

// Derived fields and totals. Shared by the per-account and the merged book.
function finishDeltaBook(rows, totalNav) {
  const list = Object.values(rows);
  const totals = {
    deltaValue: 0, capital: 0, shockPnl: 0,
    legValue: { stock: 0, shortPut: 0, longCall: 0, shortCall: 0, longPut: 0 },
    unpriced: 0, unparsed: 0, nosolve: 0, unpricedNames: [],
  };
  for (const r of list) {
    const L = r.legs, V = r.legValue;
    r.optionShares = L.shortPut + L.longCall + L.shortCall + L.longPut;
    r.deltaShares = r.stockShares + r.optionShares;
    r.deltaValue = V.stock + V.shortPut + V.longCall + V.shortCall + V.longPut;
    r.weight = totalNav > 0 ? r.deltaValue / totalNav : 0;
    totals.deltaValue += r.deltaValue;
    for (const k of Object.keys(V)) totals.legValue[k] += V[k];
    totals.capital += r.capital;
    totals.shockPnl += r.shockPnl;
    totals.unpriced += r.unpriced;
    totals.unparsed += r.unparsed;
    totals.nosolve += r.nosolve;
    if (r.unpriced) totals.unpricedNames.push(r.symbol);
  }
  list.sort((a, b) => Math.abs(b.deltaValue) - Math.abs(a.deltaValue)
    || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { totalNav, rows: list, totals };
}

// One account's book. `price(sym)` comes from deltaPricer for this account's
// statement date; `acct` tags the lines for the merged view's detail rows.
function deltaBook(data, price, asOfTs, acct = "") {
  const nav = data.nav || {};
  const totalNav = nav.total || ((nav.cash || 0) + (nav.stock || 0) + (nav.options || 0)) || 0;
  const rows = {};
  const row = (sym) => rows[sym] || (rows[sym] = blankDeltaRow(sym));
  for (const s of data.stocks || []) {
    if (!s.symbol || CASH_EQUIVALENTS.has(s.symbol)) continue;
    const r = row(s.symbol), value = s.value || 0;
    r.stockShares += s.quantity || 0;
    r.stockValue += value;
    r.legValue.stock += value;
    r.capital += value;
    r.shockPnl += value * DELTA_SHOCK;
    r.stockLines.push({ acct, shares: s.quantity || 0, value, px: s.close_price || 0 });
  }
  for (const o of data.options || []) {
    const sym = (o.underlying || "").trim();
    if (!sym || CASH_EQUIVALENTS.has(sym)) continue;
    const r = row(sym), qty = o.quantity || 0;
    if (qty > 0) r.capital += Math.max(o.value || 0, 0);
    const p = price(sym);
    const g = optionDelta(o, p ? p.px : null, asOfTs);
    // The spot and dollars this contract was valued at — its own account's
    // statement date. The merged view's detail rows print these: the row's
    // spot is one account's, and on another date it would price the rest wrong.
    const c = { o, acct, ...g, spot: p ? p.px : null, value: 0 };
    r.contracts.push(c);
    if (g.status === "unparsed") { r.unparsed += Math.abs(qty); continue; }
    if (g.status === "unpriced") { r.unpriced += Math.abs(qty); continue; }
    if (g.status === "nosolve") r.nosolve += Math.abs(qty);
    const kind = (qty < 0 ? "short" : "long") + (o.right === "P" ? "Put" : "Call");
    c.value = g.shares * p.px;
    r.legs[kind] += g.shares;
    r.legValue[kind] += c.value;
    r.shockPnl += g.shockPnl;
  }
  for (const r of Object.values(rows)) {
    const p = price(r.symbol);
    if (p) Object.assign(r, { spot: p.px, src: p.src, bar: p.bar || "" });
    else if (r.stockShares) Object.assign(r, { spot: r.stockValue / r.stockShares, src: "ibkr" });
  }
  return finishDeltaBook(rows, totalNav);
}

// 总账户: sums per underlying. Each account was priced on its own date, so the
// spot shown is the first account's — the same number whenever the dates match.
function mergeDeltaBooks(books) {
  const rows = {};
  let totalNav = 0;
  for (const b of books) {
    totalNav += b.totalNav;
    for (const r of b.rows) {
      const m = rows[r.symbol] || (rows[r.symbol] = blankDeltaRow(r.symbol));
      if (m.spot == null && r.spot != null) Object.assign(m, { spot: r.spot, src: r.src, bar: r.bar });
      m.stockShares += r.stockShares;
      m.stockValue += r.stockValue;
      for (const k of Object.keys(r.legs)) m.legs[k] += r.legs[k];
      for (const k of Object.keys(r.legValue)) m.legValue[k] += r.legValue[k];
      for (const k of ["capital", "shockPnl", "unpriced", "unparsed", "nosolve"]) m[k] += r[k];
      m.stockLines.push(...r.stockLines);
      m.contracts.push(...r.contracts);
    }
  }
  return finishDeltaBook(rows, totalNav);
}

/* ---- loading ------------------------------------------------------------ */

let deltaQuotes = { key: null, state: "idle", data: null, at: 0, error: "",
                    retryAt: Infinity, inflight: false };

// Only the (date, name) pairs the loaded statements asked for. The endpoint
// reads the statements on its own, so right after a sync it can answer for a
// newer date than the page holds — and a close from another day must not
// price these option marks. Such a name stays unpriced (缺价) instead.
function deltaPickCloses(closes, needs) {
  const out = {};
  for (const k of needs) {
    const cut = k.indexOf(" ");
    const day = k.slice(0, cut), sym = k.slice(cut + 1);
    const c = closes && closes[day] && closes[day][sym];
    if (c && c.close > 0) (out[day] || (out[day] = {}))[sym] = c;
  }
  return out;
}

// Whether the answer on hand for the same names should be asked for again:
// the last ask failed (after DELTA_RETRY_MS), or the server said part of it
// would come out differently by now (retry_after — a name Yahoo missed, past
// its back-off; a bar taken mid-session, past its TTL). A partial answer is
// still a 200, so without this a miss would stick for as long as the tab is
// open. Never while an ask is in flight.
function deltaRefreshDue(q, now) {
  if (q.inflight) return false;
  if (q.state === "error") return now - q.at > DELTA_RETRY_MS;
  return now >= q.retryAt;
}

// Asks /api/underlying-closes once per distinct set of names the statements
// need, and again when deltaRefreshDue says so. No names → no request. The
// answer goes on currentDataRef.underlyingCloses, where buildPriceBook
// (dashboard.js) reads it, so the expiry calendar, the risk gate and the core
// table price option-only names from it too — hence the whole view redraws.
function ensureDeltaQuotes(accounts) {
  const needs = deltaNeeds(accounts, (id) => deltaAsOf(accounts[id]));
  const key = needs.join("|");
  let q = deltaQuotes;
  if (q.key !== key) {
    // A different set of names (new statements): closes fetched for the old
    // set must not price anything until this set's answer is in.
    currentDataRef.underlyingCloses = null;
    q = deltaQuotes = { key, state: needs.length ? "loading" : "ok", data: null,
                        at: Date.now(), error: "", retryAt: Infinity, inflight: false };
    if (needs.length) fetchDeltaQuotes(q, needs);
  } else if (needs.length && deltaRefreshDue(q, Date.now())) {
    // Same names again: the answer on hand keeps pricing until the new one lands.
    fetchDeltaQuotes(q, needs);
  }
  return { ...q, needs };
}

function fetchDeltaQuotes(q, needs) {
  q.inflight = true;
  fetch("/api/underlying-closes")
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(d => {
      Object.assign(q, { state: "ok", data: d, error: "",
        retryAt: typeof d.retry_after === "number" ? Date.now() + d.retry_after * 1000 : Infinity });
    })
    .catch(exc => {
      q.error = String(exc.message || exc);
      // A failed first ask has nothing to show; a failed refresh keeps the
      // answer it had and tries again after the same back-off.
      if (q.data) q.retryAt = Date.now() + DELTA_RETRY_MS;
      else q.state = "error";
    })
    .then(() => {
      q.inflight = false;
      q.at = Date.now();
      if (deltaQuotes !== q) return;
      currentDataRef.underlyingCloses = q.data ? { closes: deltaPickCloses(q.data.closes, needs) } : null;
      if (currentDataRef.allAccounts) renderSelected();
    });
}

// The delta book for the account tab on screen. render() calls this once per
// pass, before the core table and the treemap read the sold puts' delta from
// it (putWeight: each name's short-put delta $ ÷ the view's NAV), and
// renderDeltaExposure draws it. null when it cannot be had: the panels that
// read it then judge as they did before this panel existed, rather than not
// at all.
function computeDeltaView() {
  try {
    const accounts = currentDataRef.allAccounts || {};
    const all = Object.keys(accounts).sort();
    const sel = currentDataRef.selected;
    const ids = sel && sel !== "ALL" && accounts[sel] ? [sel] : all;
    if (!ids.length) return null;
    const q = ensureDeltaQuotes(accounts);
    // Valued on each loaded statement's own date, always: its option marks
    // are that day's. The closes are only the pairs these statements asked
    // for (deltaPickCloses), so a reply dated otherwise prices nothing here.
    const closes = (currentDataRef.underlyingCloses || {}).closes || {};
    const dayOf = (id) => deltaAsOf(accounts[id]);
    const merged = ids.length > 1;
    const books = ids.map(id => deltaBook(accounts[id],
      deltaPricer(accounts, closes, dayOf(id), dayOf), deltaDayTs(dayOf(id)), merged ? id : ""));
    const book = merged ? mergeDeltaBooks(books) : books[0];
    const putWeight = {};
    if (book.totalNav > 0) {
      for (const r of book.rows) {
        if (r.legValue.shortPut > 0) putWeight[r.symbol] = r.legValue.shortPut / book.totalNav;
      }
    }
    return { book, q, ids, merged, dayOf, putWeight };
  } catch (exc) {
    console.error("[delta] view failed", exc);
    return null;
  }
}

/* ---- rendering ---------------------------------------------------------- */

const deltaOpen = new Set();     // expanded underlyings, kept across re-renders

// One decimal at most. A delta share count is rarely whole (3 short puts at a
// −0.652 delta are 195.6 shares), and printing it to the whole share made the
// column disagree with Delta 市值 when multiplied out by hand — a quarter of a
// share is $10 on a $40 stock. Whole counts (stock) still print bare.
const deltaFmtShares = (v) => {
  const s = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 1 });
  return s === "0" ? "0" : (v > 0 ? "+" : "-") + s;
};
// The multiplication behind a Delta 市值 cell, to a thousandth of a share —
// enough to check by hand to the dollar, which the 0.1-share column is not
// (0.05 of a share is already $8 at $170).
const deltaValueTip = (shares, spot, value) =>
  (spot > 0 ? `${shares.toFixed(3)} 股 × ${fmtMoney(spot, 2)} ≈ ${fmtMoney(value)}` : "");
const deltaTone = (v) => (v > 0.5 ? "up" : v < -0.5 ? "down" : "muted");

const DELTA_LEG_LABEL = {
  stock: "正股", shortPut: "卖 put", longCall: "买 call", shortCall: "卖 call", longPut: "买 put",
};

function deltaHeroHtml(book) {
  const t = book.totals, nav = book.totalNav;
  const per1 = -t.deltaValue * 0.01;
  const linear10 = t.deltaValue * DELTA_SHOCK;
  const extra = t.shockPnl - linear10;      // negative: the gap costs more than delta says
  const legs = Object.keys(DELTA_LEG_LABEL)
    .map(k => [k, t.legValue[k]])
    .filter(([, v]) => Math.abs(v) >= 0.5);
  const shareOf = (v) => (t.deltaValue ? ` <span class="muted">${fmtPct(v / t.deltaValue, 0)}</span>` : "");
  return `
    <div class="delta-stat">
      <div class="delta-stat-label">Delta 市值合计</div>
      <div class="delta-stat-value">${fmtMoney(t.deltaValue)}</div>
      <div class="delta-stat-sub">${nav > 0
        ? `是净值 ${fmtMoney(nav)} 的 <b>${(t.deltaValue / nav).toFixed(2)} 倍</b>`
        : "没有净值，算不了倍数"}</div>
    </div>
    <div class="delta-stat">
      <div class="delta-stat-label">每跌 1%（按 delta 线性估）</div>
      <div class="delta-stat-value ${deltaTone(per1)}">${fmtMoney(per1)}</div>
      <div class="delta-stat-sub" title="期权按原来的隐含波动率重算；真跌的时候隐含波动率通常会涨，所以这仍是下界">
        全线跌 ${fmtPct(-DELTA_SHOCK, 0)}：约 <b class="${deltaTone(t.shockPnl)}">${fmtMoney(t.shockPnl)}</b>${
        extra < -0.5 ? `，比线性估多亏 ${fmtMoney(-extra)}（卖 put 越跌 delta 越大）` : ""}</div>
    </div>
    <div class="delta-stat">
      <div class="delta-stat-label">构成</div>
      <ul class="delta-legs">${legs.map(([k, v]) => `
        <li><span><i class="delta-dot ${k === "stock" || k === "shortPut" ? k : "other"}"></i>${DELTA_LEG_LABEL[k]}</span>
          <span><b>${fmtMoney(v)}</b>${shareOf(v)}</span></li>`).join("")}
      </ul>
      <div class="delta-stat-sub">按投入资本（正股 + 期权多头市值）只算 ${fmtMoney(t.capital)}</div>
    </div>`;
}

// Stacked by source when every leg points the same way; one tone otherwise,
// since segments of opposite sign cannot add up to the net they sit beside.
function deltaBarHtml(r, scale) {
  if (!(scale > 0) || !r.deltaValue) return "";
  const parts = [
    ["stock", r.legValue.stock],
    ["shortPut", r.legValue.shortPut],
    ["other", r.legValue.longCall + r.legValue.shortCall + r.legValue.longPut],
  ].filter(([, v]) => Math.abs(v) >= 0.5);
  const pct = (v) => `${Math.min(100, (Math.abs(v) / scale) * 100).toFixed(2)}%`;
  const oneWay = parts.every(([, v]) => v * r.deltaValue > 0);
  const segs = r.deltaValue > 0 && oneWay
    ? parts.map(([k, v]) => `<span class="delta-seg ${k}" style="width:${pct(v)}"></span>`).join("")
    : `<span class="delta-seg ${r.deltaValue < 0 ? "neg" : "mixed"}" style="width:${pct(r.deltaValue)}"></span>`;
  return `<div class="delta-bar">${segs}</div>`;
}

function deltaDetailHtml(r, merged) {
  const acctCell = (id) => (merged ? `<td>${esc(maskAccountId(id))}</td>` : "");
  const lines = r.stockLines.map(s => `
    <tr><td>正股</td>${acctCell(s.acct)}
      <td class="num">${fmtNum(s.shares, Math.abs(s.shares % 1) > 1e-9 ? 2 : 0)} 股</td>
      <td class="num">${fmtMoney(s.px, 2)}</td><td class="num muted">—</td>
      <td class="num">1.00</td><td class="num">${deltaFmtShares(s.shares)}</td>
      <td class="num">${fmtMoney(s.value)}</td><td class="num muted">—</td></tr>`);
  const contracts = [...r.contracts].sort((a, b) =>
    (parseExpiryTs(a.o.expiry) || 0) - (parseExpiryTs(b.o.expiry) || 0) || a.o.strike - b.o.strike);
  for (const c of contracts) {
    const o = c.o, qty = o.quantity || 0;
    const side = qty < 0 ? `<span class="tag tag-short">卖</span>` : `<span class="tag tag-long">买</span>`;
    const label = `${esc(o.symbol || `${o.underlying} ${o.expiry} ${o.strike} ${o.right}`)} ${side}`;
    if (c.status === "unparsed" || c.status === "unpriced") {
      lines.push(`<tr><td>${label}</td>${acctCell(c.acct)}
        <td class="num">${fmtNum(qty, 0)} 张</td>
        <td class="num">${o.close_price ? fmtMoney(o.close_price, 2) : "—"}</td>
        <td class="num muted" colspan="5">${c.status === "unpriced" ? "缺正股价，没算 delta" : "读不出行权价 / 方向 / 到期，没算"}</td></tr>`);
      continue;
    }
    const ivText = c.iv == null ? `<span class="amber" title="期权价高过了任何波动率能给的价格，期权价和正股价对不上；按到期内在价值算 delta">对不上</span>`
      : c.T <= 0 ? `<span class="muted">到期日</span>`
      : c.iv === 0 ? `<span class="muted" title="期权价不高于内在价值，没有时间价值可反推">≈0</span>`
      : fmtPct(c.iv, 0);
    lines.push(`<tr><td>${label}</td>${acctCell(c.acct)}
      <td class="num">${fmtNum(qty, 0)} 张</td>
      <td class="num">${fmtMoney(c.mark, 2)}</td>
      <td class="num">${ivText}</td>
      <td class="num">${c.delta.toFixed(2)}</td>
      <td class="num ${deltaTone(c.shares)}">${deltaFmtShares(c.shares)}</td>
      <td class="num" title="${esc(deltaValueTip(c.shares, c.spot, c.value))}">${fmtMoney(c.value)}</td>
      <td class="num">${Math.round(c.T * 365)}</td></tr>`);
  }
  return `
    <table class="delta-sub">
      <thead><tr><th>持仓</th>${merged ? "<th>账户</th>" : ""}
        <th class="num">数量</th><th class="num">价格</th><th class="num">隐含波动率</th>
        <th class="num">Delta</th><th class="num">折合股数</th><th class="num">Delta 市值</th>
        <th class="num">剩余天数</th></tr></thead>
      <tbody>${lines.join("")}</tbody>
    </table>`;
}

function deltaRowHtml(r, scale, merged, q) {
  const open = deltaOpen.has(r.symbol);
  const L = r.legs;
  const other = L.longCall + L.shortCall + L.longPut;
  const otherTip = [["买 call", L.longCall], ["卖 call", L.shortCall], ["买 put", L.longPut]]
    .filter(([, v]) => Math.abs(v) >= 0.05).map(([k, v]) => `${k} ${deltaFmtShares(v)} 股`).join(" · ");
  const tags = [];
  if (!r.stockShares) tags.push(`<span class="tag tag-short" title="没有正股，敞口全部来自期权">仅期权</span>`);
  if (r.unpriced) {
    const sym = r.symbol;
    const missing = q.data && q.data.missing ? Object.values(q.data.missing).map(m => m[sym]).find(Boolean) : "";
    // Answered, yet neither priced nor reported missing: the reply was for a
    // different statement date than the page holds (a sync landed mid-load).
    const why = missing || q.error
      || (q.data ? "取到的收盘价不是这份报表那天的（服务器上的报表可能刚更新过），刷新页面" : "没有正股价");
    tags.push(q.state === "loading"
      ? `<span class="tag tag-gone">取价中</span>`
      : `<span class="tag tag-over" title="${esc(why)}">缺价 ${r.unpriced} 张未计</span>`);
  }
  if (r.nosolve) tags.push(`<span class="tag tag-under" title="期权价和正股价对不上，按到期内在价值算">${r.nosolve} 张价不符</span>`);
  const srcTip = r.src === "yahoo"
    ? `<span class="delta-src" title="报表里没有这只正股，用 Yahoo ${esc(r.bar)} 的收盘价">Y</span>` : "";
  const cell = (v) => (Math.abs(v) >= 0.05 ? `<span class="${deltaTone(v)}">${deltaFmtShares(v)}</span>` : `<span class="muted">—</span>`);
  return `
    <tr class="delta-row">
      <td><button type="button" class="delta-toggle" data-delta-sym="${esc(r.symbol)}" aria-expanded="${open}">
        <span class="chev" aria-hidden="true">▸</span>${esc(r.symbol)}</button> ${tags.join(" ")}</td>
      <td class="num">${r.spot > 0 ? fmtMoney(r.spot, 2) : "—"}${srcTip}</td>
      <td class="num">${cell(r.stockShares)}</td>
      <td class="num">${cell(L.shortPut)}</td>
      <td class="num" title="${esc(otherTip)}">${cell(other)}</td>
      <td class="num"><b>${deltaFmtShares(r.deltaShares)}</b></td>
      <td class="num" title="${esc(deltaValueTip(r.deltaShares, r.spot, r.deltaValue))}"><b class="${r.deltaValue < -0.5 ? "down" : ""}">${fmtMoney(r.deltaValue)}</b></td>
      <td class="num">${fmtPct(r.weight, 1)}</td>
      <td class="delta-bar-cell">${deltaBarHtml(r, scale)}</td>
    </tr>
    <tr class="delta-detail" data-delta-for="${esc(r.symbol)}"${open ? "" : " hidden"}>
      <td colspan="9">${deltaDetailHtml(r, merged)}</td>
    </tr>`;
}

// The line a folded panel keeps. Rendered whether or not the panel is folded,
// so unfolding and folding never shows a stale line.
function deltaSummaryHtml(book, q) {
  const t = book.totals, nav = book.totalNav;
  const per1 = -t.deltaValue * 0.01;
  const parts = [
    `Delta 市值 <b>${fmtMoney(t.deltaValue)}</b>`
      + (nav > 0 ? `，净值的 <b>${(t.deltaValue / nav).toFixed(2)} 倍</b>` : ""),
    `每跌 1% ≈ <b class="${deltaTone(per1)}">${fmtMoney(per1)}</b>`,
  ];
  if (t.deltaValue && Math.abs(t.legValue.shortPut) >= 0.5) {
    parts.push(`卖 put 占 <b>${fmtPct(t.legValue.shortPut / t.deltaValue, 0)}</b>`);
  }
  if (q.state === "loading") parts.push(`<span class="muted">正在取收盘价…</span>`);
  else if (t.unpriced) parts.push(`<span class="amber">${t.unpriced} 张缺正股价，没算进去</span>`);
  return parts.map(p => `<span class="delta-sum">${p}</span>`).join("");
}

// Draws the view render() computed this pass (currentDataRef._delta).
function renderDeltaExposure() {
  const panel = $("delta-panel");
  if (!panel) return;
  const view = currentDataRef._delta;
  if (!view || !view.book.rows.length) { panel.hidden = true; return; }
  const { book, q, ids, merged, dayOf } = view;
  panel.hidden = false;

  const days = [...new Set(ids.map(dayOf).filter(Boolean))].sort();
  const yahoo = book.rows.filter(r => r.src === "yahoo").map(r => r.symbol);
  // "date SYMBOL", where the symbol may itself hold a space ("BRK B").
  const waiting = q.state === "loading" ? [...new Set(q.needs.map(k => k.slice(k.indexOf(" ") + 1)))] : [];
  $("delta-note").textContent = [
    days.length ? `数据截至 ${days.map(d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`).join(" / ")} 收盘` : "",
    waiting.length ? `正在取 ${waiting.join("、")} 的收盘价…` : "",
    yahoo.length ? `${yahoo.join("、")} 的正股价来自 Yahoo` : "",
  ].filter(Boolean).join(" · ");

  $("delta-summary").innerHTML = deltaSummaryHtml(book, q);
  $("delta-hero").innerHTML = deltaHeroHtml(book);

  const t = book.totals;
  const warn = [];
  if (t.unpriced && q.state !== "loading") {
    // When the next ask happens: a failed one after DELTA_RETRY_MS, a partial
    // answer when the server's retry_after says it could change.
    const at = q.state === "error" ? q.at + DELTA_RETRY_MS : q.retryAt;
    const mins = Number.isFinite(at) ? Math.max(1, Math.ceil((at - Date.now()) / 60000)) : null;
    warn.push(`${t.unpriced} 张合约（${t.unpricedNames.join("、")}）缺正股价，没算进上面的数`
      + (q.state === "error" ? `：取价失败（${q.error}）` : "")
      + (mins ? `，约 ${mins} 分钟后切换账号或刷新页面会再取` : "，刷新页面再试"));
  }
  if (t.unparsed) warn.push(`${t.unparsed} 张合约读不出行权价 / 方向 / 到期日，没算`);
  if (t.nosolve) warn.push(`${t.nosolve} 张合约的期权价跟正股价对不上，按到期内在价值算 delta`);
  const warnEl = $("delta-warn");
  warnEl.hidden = !warn.length;
  warnEl.textContent = warn.join("；");

  const scale = book.rows.reduce((m, r) => Math.max(m, Math.abs(r.deltaValue)), 0);
  $("delta-rows").innerHTML = book.rows.map(r => deltaRowHtml(r, scale, merged, q)).join("");
}

document.addEventListener("DOMContentLoaded", () => {
  // #delta-body is the fold wrapper wirePanelFold wants; the rows are #delta-rows.
  const body = $("delta-rows");
  if (!body) return;
  // Delegated: the rows are rebuilt on every render.
  body.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-delta-sym]");
    if (!btn) return;
    const sym = btn.dataset.deltaSym;
    const open = !deltaOpen.has(sym);
    if (open) deltaOpen.add(sym);
    else deltaOpen.delete(sym);
    btn.setAttribute("aria-expanded", String(open));
    const detail = [...body.querySelectorAll("tr.delta-detail")].find(tr => tr.dataset.deltaFor === sym);
    if (detail) detail.hidden = !open;
  });
  // The title folds the panel, the same switch as 风险闸门 / 止盈提醒 (the
  // helper lives in risk.js, which loads first); remembered per browser.
  wirePanelFold("delta", "ibkr.deltaPanel.collapsed");
});
