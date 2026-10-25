/* ---------------------------------------------------------------------------
 * Risk gate — the position rules, in front of the order ticket.
 *
 * Every number this panel needs was already on the dashboard somewhere: the
 * short-put notional is in the expiry calendar, the drawdown is on the NAV
 * curve, the cluster sums exist (behind a switched-off panel). What none of
 * them carried was the LINE and the CONSEQUENCE. A ratio of 2.3x NAV printed
 * in grey next to a dozen other figures reads as a fact about the book;
 * printed red next to "只许替换，不许净新增" it answers the question you
 * actually have before an order — may I add this?
 *
 * The rules, each judged per account and for the household:
 *
 *   卖 put 名义 ÷ 净值          assigned-if notional of every short put
 *   单标的 卖 put 名义 ÷ 净值    the same, one underlying at a time; the
 *                               RISK_WATCH names (SOXL) get their own row
 *   AI 硬件簇 ÷ 净值            stock + LEAP notional + short-put notional
 *                               across names that gap together
 *   距组合保证金线               PM accounts only: NAV against the US$100k
 *                               floor — under it IBKR accepts only trades that
 *                               reduce margin
 *   近 N 日回撤 / 断路器          flow-adjusted drawdown from the window's high;
 *                               past the stop the answer is 只减不加
 *   到期周 vs 现金               cash accounts only: each expiry week's
 *                               short-put notional against cash + BOXX
 *   跨财报                       every open short option: does its expiry
 *                               fall on or after the underlying's next report
 *
 * It is the same table on every tab, on purpose. Selling the same contract in
 * both accounts on the same day is a household problem, and a gate showing
 * only the account on screen would hide the half you are about to copy the
 * order into. The tab you are on is highlighted, nothing more.
 *
 * None of these lines is an adopted rule. RISK_DEFAULTS are proposals, and
 * the 设置 dialog overrides any of them (stored server-side in
 * uploads/.risk_settings.json, next to the position bands, for the same
 * reason: the same rules whichever device opens the page). The dialog is also
 * where an account's KIND is declared — the payload does not say which
 * account is portfolio-margin and which is cash, and two of the rows depend
 * on it.
 *
 * Loaded after dashboard.js and leans on its helpers ($, esc, fmtMoney,
 * fmtPct, maskAccountId, currentDataRef, buildPriceBook, parseExpiryTs,
 * groupExpiries, fundedSeries, navStats, mergeAccounts, showToast, DAY_MS,
 * CASH_EQUIVALENTS, CONTRACT_MULTIPLIER).
 * ------------------------------------------------------------------------- */

// The proposed lines. A blank box in the 设置 dialog means "this value".
const RISK_DEFAULTS = {
  put_nav_max: 1.0,          // 卖 put 名义合计 ÷ 净值
  single_put_nav_max: 0.25,  // 单标的卖 put 名义 ÷ 净值
  // No line was proposed for the cluster. 1.0x is the red tone the old
  // cluster panel has always used for "this group alone is a whole NAV".
  cluster_nav_max: 1.0,
  pm_floor: 100000,          // PM 账户净值线（账户本币，USD）
  pm_warn: 0.10,             // 缓冲不到净值的 10% 亮黄
  drawdown_days: 30,         // 回撤窗口：最近 N 个 NAV 行
  drawdown_stop: 0.10,       // 窗口高点回撤到 −10% → 断路器
};

// Names that gap together on an AI-capex scare, gated as one position.
const RISK_CLUSTER = ["SOXL", "SOXX", "SMH", "NVDA", "NVDL", "AVGO", "COHR",
                      "LITE", "LITX", "VRT", "MU", "TSM"];
// Underlyings with a 单标的 row of their own, whatever their size.
const RISK_WATCH = ["SOXL"];

// Single-stock leveraged ETFs report nothing themselves but gap on their
// underlying's report, so the earnings column asks about the underlying.
// Hand-maintained, like F13_SHARE_CLASSES. A fund missing from here is asked
// about under its own ticker, Nasdaq answers "no such symbol", and the row
// reads 未知 — the failure is the safe one.
const EARNINGS_ALIAS = {
  LITX: "LITE", APPX: "APP", NVDL: "NVDA", NVDU: "NVDA", CONL: "COIN",
  METU: "META", TSLL: "TSLA", AMDL: "AMD", MSTU: "MSTR", MSTX: "MSTR",
};
// Index / sector / commodity / crypto funds: there is no report to cross, so
// their rows read 不适用 rather than 未知. (A SOXL put does feel NVDA's report
// — that exposure is what the cluster row is for, not this column.)
const EARNINGS_NONE = new Set([
  "SOXL", "SOXS", "TQQQ", "SQQQ", "UPRO", "SPXL", "SPXU", "TNA", "TECL", "FNGU",
  "QQQ", "QQQM", "SPY", "VOO", "IVV", "IWM", "DIA", "SOXX", "SMH", "XLK",
  "TLT", "TMF", "GLD", "GDX", "GDXU", "NUGT", "JNUG", "SLV", "UVXY", "VXX",
  "IBIT", "ETHU", "BITX", "BOXX", "SGOV",
]);

const RISK_KIND_LABEL = { pm: "组合保证金", margin: "Reg-T 保证金", cash: "现金户" };

// Float noise must not decide a verdict. A chain of NAV ratios that lands on
// −10% can come out as −9.999999999999998%, and "exactly on the line" has to
// read the same way every time.
const RISK_EPS = 1e-9;

// The lines in force: defaults, overlaid with whatever the settings file
// holds. Anything unreadable falls back to the default rather than to 0 —
// a line of 0 would turn the whole table red for no reason.
function riskConfig(stored) {
  const s = stored || {};
  const cfg = { ...RISK_DEFAULTS };
  for (const [k, v] of Object.entries(s.thresholds || {})) {
    if (k in cfg && v != null && Number.isFinite(Number(v))) cfg[k] = Number(v);
  }
  cfg.cluster = Array.isArray(s.cluster) ? s.cluster : RISK_CLUSTER;
  cfg.watch = Array.isArray(s.watch) ? s.watch : RISK_WATCH;
  cfg.accounts = s.accounts || {};
  return cfg;
}

function riskNav(data) {
  const nav = data.nav || {};
  return nav.total || ((nav.cash || 0) + (nav.stock || 0) + (nav.options || 0)) || 0;
}

// One account's raw sums, in dollars, before any ratio. Kept in dollars so
// the household column can add books and divide once: its ratio is total
// notional over total NAV, never an average of the accounts' ratios.
//
// Short-put notional is strike × contracts × multiplier — the cash an
// assignment of every one of them would take — regardless of moneyness, the
// same figure the expiry calendar and the margin footnote print. LEAP
// notional is the long calls' share-equivalent: spot × contracts × multiplier,
// spot from the pooled price book; with no quote anywhere the strike stands
// in and the contract is counted so the panel can say so.
function riskBook(data, cfg, priceBook) {
  const members = new Set(cfg.cluster);
  const byU = {};
  let putTotal = 0, unparsed = 0;
  let stockMV = 0, leap = 0, clusterPut = 0, leapAssumed = 0;
  for (const s of data.stocks || []) {
    if (members.has(s.symbol)) stockMV += s.value || 0;
  }
  for (const o of data.options || []) {
    const qty = Math.abs(o.quantity || 0);
    const shares = qty * (o.multiplier || CONTRACT_MULTIPLIER);
    if (o.quantity < 0) {
      // A short whose strike or right did not parse could be a put of any
      // size. Leave it out of the sums and count it, as the margin panel does.
      if (!(o.strike > 0) || (o.right !== "P" && o.right !== "C")) {
        unparsed += qty;
        continue;
      }
      if (o.right !== "P") continue;
      const n = o.strike * shares;
      putTotal += n;
      byU[o.underlying] = (byU[o.underlying] || 0) + n;
      if (members.has(o.underlying)) clusterPut += n;
    } else if (o.quantity > 0 && o.right === "C" && members.has(o.underlying)) {
      const spot = priceBook[o.underlying];
      if (!(spot > 0)) leapAssumed += qty;
      leap += (spot > 0 ? spot : (o.strike || 0)) * shares;
    }
  }
  const cashEq = (data.stocks || []).reduce(
    (s, x) => s + (CASH_EQUIVALENTS.has(x.symbol) ? (x.value || 0) : 0), 0);
  return {
    nav: riskNav(data), putTotal, byU, unparsed,
    cluster: { stockMV, leap, put: clusterPut, leapAssumed },
    cashLike: ((data.nav || {}).cash || 0) + cashEq,
  };
}

function mergeRiskBooks(books) {
  const out = {
    nav: 0, putTotal: 0, byU: {}, unparsed: 0, cashLike: 0,
    cluster: { stockMV: 0, leap: 0, put: 0, leapAssumed: 0 },
  };
  for (const b of books) {
    out.nav += b.nav;
    out.putTotal += b.putTotal;
    out.unparsed += b.unparsed;
    out.cashLike += b.cashLike;
    for (const [u, n] of Object.entries(b.byU)) out.byU[u] = (out.byU[u] || 0) + n;
    for (const k of Object.keys(out.cluster)) out.cluster[k] += b.cluster[k] || 0;
  }
  return out;
}

// Ratios and over/under for one book. A line is crossed when the ratio is
// strictly above it: sitting exactly on 1.00x is at the line, not over it.
// With no NAV there is nothing to divide by — ratio null, never "over".
function riskJudge(book, cfg) {
  const ratio = (v) => (book.nav > 0 ? v / book.nav : null);
  const over = (r, line) => r != null && r > line + RISK_EPS;
  const watch = new Set(cfg.watch);
  const single = Object.entries(book.byU)
    .filter(([u]) => !watch.has(u))
    .map(([u, notional]) => ({ u, notional, ratio: ratio(notional) }))
    .map(r => ({ ...r, over: over(r.ratio, cfg.single_put_nav_max) }))
    .sort((a, b) => b.notional - a.notional || a.u.localeCompare(b.u));
  const c = book.cluster;
  const clusterTotal = c.stockMV + c.leap + c.put;
  const putRatio = ratio(book.putTotal);
  return {
    nav: book.nav,
    put: { notional: book.putTotal, ratio: putRatio, over: over(putRatio, cfg.put_nav_max) },
    watch: cfg.watch.map(u => {
      const notional = book.byU[u] || 0;
      return { u, notional, ratio: ratio(notional),
               over: over(ratio(notional), cfg.single_put_nav_max) };
    }),
    single,
    cluster: { ...c, total: clusterTotal, ratio: ratio(clusterTotal),
               over: over(ratio(clusterTotal), cfg.cluster_nav_max) },
    unparsed: book.unparsed,
  };
}

// Distance to the portfolio-margin floor. pct is measured against NAV, which
// makes it the drop that would cross the line ("再跌 4%") above it, and the
// rise that would get back over it ("需涨 21%") below it.
function riskPmBuffer(nav, floor, warn) {
  if (!(nav > 0)) return null;
  const gap = nav - floor;
  const pct = gap / nav;
  return { gap, pct, level: gap < 0 ? "red" : pct < warn ? "amber" : "ok" };
}

// Drawdown from the highest point of the last `days` NAV rows, on navStats'
// TWR chain — a deposit is not a rally and a withdrawal is not a loss, so
// topping the account up cannot switch the breaker off. Rows, not calendar
// days: IBKR books a NAV row on US market holidays too, so 30 rows is ~30
// trading days, give or take a holiday.
function riskDrawdown(navHistory, flows, days) {
  const series = fundedSeries(navHistory).slice(-days);
  const st = navStats(series, flows || []);
  if (!st) return null;
  return { dd: -st.curDD, peakDate: st.curPeakDate, lastDate: st.last.date,
           rows: series.length };
}

// At or past the stop. Inclusive: the rule is "−10% trips it", not "worse
// than −10%".
function riskTripped(dd, cfg) {
  return !!dd && dd.dd <= -cfg.drawdown_stop + RISK_EPS;
}

// Cash account: short-put notional by expiry week against cash + BOXX. The
// running total is the harsher reading — shares put to you in one week still
// hold the cash when the next week's puts come due, unless you sell them.
function riskCashWeeks(options, priceBook, todayTs, cashLike) {
  const puts = (options || []).filter(o => o.quantity < 0 && o.right === "P");
  let cum = 0;
  return groupExpiries(puts, priceBook, todayTs).map(w => {
    cum += w.putNotional;
    return {
      weekStart: w.weekStart, dte: w.dte, items: w.items, contracts: w.contracts,
      putNotional: w.putNotional, cum,
      ratio: cashLike > 0 ? w.putNotional / cashLike : null,
      cumRatio: cashLike > 0 ? cum / cashLike : null,
      over: w.putNotional > cashLike,
      cumOver: cum > cashLike,
    };
  });
}

// Which ticker's report a contract on `u` is exposed to; null = none (index
// and commodity funds).
function earningsTicker(u) {
  if (!u || EARNINGS_NONE.has(u)) return null;
  return EARNINGS_ALIAS[u] || u;
}

// "27NOV26" → "2026-11-27"; "" when the expiry does not parse.
function expiryIso(s) {
  const ts = parseExpiryTs(s);
  return ts == null ? "" : new Date(ts).toISOString().slice(0, 10);
}

// cross / clear / unknown / na. The asymmetry is the whole point: only a
// real date that falls AFTER the expiry may say clear. Every way of not
// knowing — no answer yet, a failed fetch, Nasdaq without the symbol, a date
// already behind us — is unknown, never clear. A report ON expiry day counts
// as crossing: even after the close it lands inside the exercise window.
function earningsVerdict(expiry, ticker, entry, todayIso) {
  if (ticker == null) return { state: "na" };
  const exp = expiryIso(expiry);
  if (!exp) return { state: "unknown", why: "到期日读不出" };
  if (!entry) return { state: "unknown", why: "还没取到" };
  if (entry.status !== "ok" || !entry.date) {
    return { state: "unknown",
             why: entry.status === "none" ? "Nasdaq 没有这个代码的财报日期" : "取数失败" };
  }
  if (entry.date < todayIso) {
    return { state: "unknown", why: `数据源给的日期 ${entry.date} 已经过了` };
  }
  return { state: entry.date <= exp ? "cross" : "clear", date: entry.date };
}

const EARNINGS_RANK = { cross: 0, unknown: 1, clear: 2, na: 3 };

// Every open short option across the accounts, with its verdict. Mirrored
// contracts stay two rows: each account has to close its own.
function riskEarningsRows(accounts, earnings, todayIso) {
  const rows = [];
  for (const [acct, a] of Object.entries(accounts || {})) {
    for (const o of a.options || []) {
      if (!(o.quantity < 0)) continue;
      const ticker = earningsTicker(o.underlying);
      const entry = ticker ? (earnings || {})[ticker] : null;
      rows.push({ acct, o, ticker, entry, ...earningsVerdict(o.expiry, ticker, entry, todayIso) });
    }
  }
  const exp = (r) => parseExpiryTs(r.o.expiry) ?? Infinity;
  rows.sort((a, b) => EARNINGS_RANK[a.state] - EARNINGS_RANK[b.state]
    || exp(a) - exp(b)
    || String(a.o.symbol).localeCompare(String(b.o.symbol))
    || a.acct.localeCompare(b.acct));
  return rows;
}

// The verdict for one account column. The breaker outranks the lines: past
// it nothing new goes on, replacement included.
function riskVerdict(judge, dd, pm, cashWeeks, cfg) {
  const fx = (r) => `${r.toFixed(2)}x`;
  const crossed = [];
  if (judge.put.over) crossed.push(`卖 put ${fx(judge.put.ratio)}`);
  for (const w of judge.watch) if (w.over) crossed.push(`${w.u} ${fx(w.ratio)}`);
  for (const s of judge.single) if (s.over) crossed.push(`${s.u} ${fx(s.ratio)}`);
  if (judge.cluster.over) crossed.push(`AI 硬件簇 ${fx(judge.cluster.ratio)}`);
  const breaker = riskTripped(dd, cfg);
  const cashShort = (cashWeeks || []).filter(w => w.over).length;
  const pmLevel = pm ? pm.level : "ok";
  return {
    crossed, breaker, pmLevel, cashShort,
    level: breaker || crossed.length || pmLevel === "red" || cashShort ? "red"
      : pmLevel === "amber" ? "amber" : "ok",
  };
}

/* --- Rendering ------------------------------------------------------------ */

const fmtX = (r) => (r == null ? "—" : `${r.toFixed(2)}x`);
// Compact dollars for the second line of a cell, where the exact figure is a
// hover away and six digits would wrap the column.
const fmtK = (v) => {
  const a = Math.abs(v || 0), sign = v < 0 ? "-" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}$${Math.round(a / 1e3)}k`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}k`;
  return `${sign}$${Math.round(a)}`;
};
const fmtMD = (iso) => (iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : "");
const EARNINGS_TIMING = { amc: "盘后", bmo: "盘前" };

// Earnings dates are US dates; Brisbane's Saturday morning is New York's
// Friday, and a report due that Friday must not read as already past.
function usTodayIso() {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

function riskAccountLabel(id, cfg) {
  const label = ((cfg.accounts || {})[id] || {}).label;
  return label ? `${label} ${maskAccountId(id)}` : maskAccountId(id);
}

// The symbol set last asked for. Re-renders (tab switches, settings saves)
// ask again only when the set of short-option underlyings actually changed.
let riskEarningsKey = null;

function ensureEarnings(tickers) {
  const key = [...new Set(tickers)].sort().join(",");
  if (key === riskEarningsKey) return;
  riskEarningsKey = key;
  if (!key) { currentDataRef.earnings = { symbols: {} }; return; }
  currentDataRef.earnings = { loading: true, symbols: {} };
  fetch(`/api/earnings?symbols=${encodeURIComponent(key)}`)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(j => {
      if (riskEarningsKey === key) currentDataRef.earnings = { symbols: j.symbols || {} };
    })
    .catch(exc => {
      if (riskEarningsKey === key) {
        currentDataRef.earnings = { error: String(exc.message || exc), symbols: {} };
      }
    })
    .then(() => { if (riskEarningsKey === key) renderRiskGate(); });
}

function renderRiskGate() {
  const panel = $("risk-panel");
  const accounts = currentDataRef.allAccounts || {};
  const ids = Object.keys(accounts).sort();
  if (!ids.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const cfg = riskConfig(currentDataRef.riskSettings);
  const book = buildPriceBook(accounts);
  const todayTs = Date.now();
  const cols = ids.map(id => {
    const a = accounts[id];
    const b = riskBook(a, cfg, book);
    const kind = (cfg.accounts[id] || {}).kind || null;
    const judge = riskJudge(b, cfg);
    const dd = riskDrawdown(a.nav_history, a.cash_flows, cfg.drawdown_days);
    const pm = kind === "pm" ? riskPmBuffer(b.nav, cfg.pm_floor, cfg.pm_warn) : null;
    const weeks = kind === "cash" ? riskCashWeeks(a.options, book, todayTs, b.cashLike) : null;
    return { id, label: riskAccountLabel(id, cfg), kind, book: b, judge, dd, pm, weeks,
             verdict: riskVerdict(judge, dd, pm, weeks, cfg) };
  });
  if (ids.length > 1) {
    const merged = mergeAccounts(accounts);
    const b = mergeRiskBooks(cols.map(c => c.book));
    cols.push({ id: "ALL", label: "合并", kind: null, book: b, judge: riskJudge(b, cfg),
                dd: riskDrawdown(merged.nav_history, merged.cash_flows, cfg.drawdown_days),
                merged: true });
  }
  const accountCols = cols.filter(c => !c.merged);

  // Earnings: asked once per distinct symbol set; the table re-renders when
  // the answer lands. Until then every row is 未知, which is what it is.
  const earnRows = riskEarningsRows(accounts, (currentDataRef.earnings || {}).symbols, usTodayIso());
  ensureEarnings(earnRows.map(r => r.ticker).filter(Boolean));

  // A gate read before an order has to say how old its numbers are: these are
  // the last statement's closes, not live prices.
  const asOfs = [...new Set(ids.map(id => {
    const h = accounts[id].nav_history || [];
    return h.length ? h[h.length - 1].date : "";
  }).filter(Boolean))].sort();
  const asOf = asOfs.length ? `数据截至 ${asOfs.map(fmtMD).join(" / ")} 收盘 · ` : "";
  const settingsError = currentDataRef.riskSettingsError;
  const unkinded = accountCols.filter(c => !c.kind).length;
  $("risk-note").textContent = asOf + (settingsError
    ? `设置读取失败（${settingsError}），按默认线显示，账户类型未知`
    : unkinded
      ? `${unkinded} 个账户未设类型 —— 在「设置」里标出组合保证金户 / 现金户`
      : "线是默认值、未正式采纳，可在「设置」里改");

  renderRiskVerdict(accountCols, earnRows, cfg);
  renderRiskTable(cols, cfg);
  renderRiskCash(accountCols);
  renderRiskEarnings(earnRows, accounts, cfg);
}

function renderRiskVerdict(cols, earnRows, cfg) {
  const lines = cols.map(c => {
    const v = c.verdict;
    const parts = [];
    if (v.breaker) {
      parts.push(`<b class="down">断路器：只减不加</b>`
        + `（近 ${cfg.drawdown_days} 个交易日回撤 ${fmtPct(c.dd.dd, 1)}）`);
    }
    if (v.crossed.length) {
      parts.push(`<b class="down">超线 ${v.crossed.length} 项：只许替换，不许净新增</b>`
        + `（${v.crossed.map(esc).join("、")}）`);
    }
    if (c.pm && c.pm.level === "red") {
      parts.push(`<b class="down">净值低于组合保证金线 ${fmtK(-c.pm.gap)}</b>`
        + `：IBKR 只接受降低保证金的交易`);
    } else if (c.pm && c.pm.level === "amber") {
      parts.push(`<b class="amber">离组合保证金线只剩 ${fmtK(c.pm.gap)}</b>`
        + `（净值再跌 ${fmtPct(c.pm.pct, 1)} 就破线）`);
    }
    if (v.cashShort) {
      parts.push(`<b class="down">${v.cashShort} 个到期周的卖 put 名义超过现金 + BOXX</b>`);
    }
    if (!parts.length) parts.push(`<span class="up">全部在线内</span>`);
    const icon = v.level === "red" ? "⛔" : v.level === "amber" ? "⚠" : "✓";
    const kind = c.kind ? ` <span class="muted">${RISK_KIND_LABEL[c.kind] || ""}</span>` : "";
    return `<div class="risk-verdict-line ${v.level}"><span class="risk-verdict-icon">${icon}</span>`
      + `<span><b>${esc(c.label)}</b>${kind}：${parts.join("；")}</span></div>`;
  });
  const cross = earnRows.filter(r => r.state === "cross");
  const unknown = earnRows.filter(r => r.state === "unknown");
  const earn = currentDataRef.earnings || {};
  if (cross.length || unknown.length) {
    const sum = (rows) => rows.reduce((s, r) => s + Math.abs(r.o.quantity || 0), 0);
    lines.push(`<div class="risk-verdict-line ${cross.length ? "red" : "amber"}">`
      + `<span class="risk-verdict-icon">${cross.length ? "⛔" : "⚠"}</span><span>`
      + (cross.length ? `<b class="down">${sum(cross)} 张卖出期权的到期跨过财报</b>` : "")
      + (cross.length && unknown.length ? "；" : "")
      + (unknown.length
        ? `<b class="amber">${sum(unknown)} 张${earn.loading ? "的财报日期读取中" : "查不到财报日期"}</b>`
          + `<span class="muted">（未知不等于不跨）</span>`
        : "")
      + `</span></div>`);
  }
  $("risk-verdict").innerHTML = lines.join("");
}

function renderRiskTable(cols, cfg) {
  const active = currentDataRef.selected;
  const on = (c) => (c.id === active ? " risk-active" : "");
  const cell = (c, html, tone = "", sub = "", tip = "") =>
    `<td class="num${on(c)}${tone ? ` ${tone}` : ""}"${tip ? ` title="${esc(tip)}"` : ""}>`
    + `<b>${html}</b>${sub ? `<div class="risk-sub">${sub}</div>` : ""}</td>`;
  const blank = (c, text = "—", tip = "") =>
    `<td class="num muted${on(c)}"${tip ? ` title="${esc(tip)}"` : ""}>${text}</td>`;
  const row = (label, line, cells) =>
    `<tr><th scope="row">${label}</th>${cells.join("")}<td class="risk-line">${line}</td></tr>`;

  const rows = [];
  rows.push(row("卖 put 名义 ÷ 净值", `≤ ${fmtX(cfg.put_nav_max)}`, cols.map(c => {
    const p = c.judge.put;
    if (p.ratio == null) return blank(c);
    return cell(c, fmtX(p.ratio), p.over ? "down" : "",
      `${fmtK(p.notional)} / ${fmtK(c.judge.nav)}`,
      `卖 put 名义 ${fmtMoney(p.notional)} ÷ 净值 ${fmtMoney(c.judge.nav)}`);
  })));
  cfg.watch.forEach((u, i) => {
    rows.push(row(`${esc(u)} 卖 put ÷ 净值`, `≤ ${fmtX(cfg.single_put_nav_max)}`, cols.map(c => {
      const w = c.judge.watch[i];
      if (!w || !w.notional) return blank(c, "无");
      return cell(c, fmtX(w.ratio), w.over ? "down" : "", fmtK(w.notional));
    })));
  });
  rows.push(row(cfg.watch.length ? "其余单标的 卖 put 最大" : "单标的 卖 put 最大",
    `≤ ${fmtX(cfg.single_put_nav_max)}`, cols.map(c => {
      const [top, ...rest] = c.judge.single;
      if (!top) return blank(c, "无");
      const more = rest.filter(r => r.over);
      const sub = more.length
        ? `另 ${more.slice(0, 3).map(r => `${esc(r.u)} ${fmtX(r.ratio)}`).join(" · ")}`
          + (more.length > 3 ? ` 等 ${more.length} 个` : "") + " 超线"
        : fmtK(top.notional);
      return cell(c, `${esc(top.u)} ${fmtX(top.ratio)}`, top.over ? "down" : "", sub);
    })));
  rows.push(row("AI 硬件簇 ÷ 净值", `≤ ${fmtX(cfg.cluster_nav_max)}`, cols.map(c => {
    const k = c.judge.cluster;
    if (k.ratio == null) return blank(c);
    if (!k.total) return blank(c, "无");
    return cell(c, fmtX(k.ratio), k.over ? "down" : "",
      `正股 ${fmtK(k.stockMV)} · LEAP ${fmtK(k.leap)} · put ${fmtK(k.put)}`,
      `正股市值 ${fmtMoney(k.stockMV)} + LEAP 名义 ${fmtMoney(k.leap)} + 卖 put 名义 ${fmtMoney(k.put)}`
      + (k.leapAssumed ? `（${k.leapAssumed} 张 LEAP 无正股报价，按行权价估）` : ""));
  })));
  if (cols.some(c => c.kind === "pm")) {
    rows.push(row(`距组合保证金线 ${fmtK(cfg.pm_floor)}`,
      `缓冲 < ${fmtPct(cfg.pm_warn, 0)} 黄 · 破线红`, cols.map(c => {
        if (c.kind !== "pm") return blank(c, "—", c.merged ? "按账户判" : "不是组合保证金户");
        const p = c.pm;
        if (!p) return blank(c);
        const tone = p.level === "red" ? "down" : p.level === "amber" ? "amber" : "";
        return cell(c, `${p.gap >= 0 ? "+" : ""}${fmtK(p.gap)}`, tone,
          p.gap >= 0 ? `再跌 ${fmtPct(p.pct, 1)} 破线` : `需涨 ${fmtPct(-p.pct, 1)} 回到线上`);
      })));
  }
  rows.push(row(`近 ${cfg.drawdown_days} 个交易日回撤`,
    `≤ −${fmtPct(cfg.drawdown_stop, 0)} 断路器`, cols.map(c => {
      if (!c.dd) return blank(c, "—", "净值序列不足 5 个点");
      const tripped = riskTripped(c.dd, cfg);
      const peak = c.dd.peakDate === c.dd.lastDate ? "在窗口高点" : `高点 ${fmtMD(c.dd.peakDate)}`;
      return cell(c, c.dd.dd < -0.0005 ? fmtPct(c.dd.dd, 1) : "0%", tripped ? "down" : "",
        tripped && !c.merged ? `<span class="tag tag-over">断路器</span> ${peak}` : peak,
        `${c.dd.rows} 个 NAV 行，截至 ${c.dd.lastDate}，剔除出入金`);
    })));
  const head = cols.map(c => `<th class="num${on(c)}">${esc(c.label)}`
    + (c.kind ? `<span class="th-sub">${RISK_KIND_LABEL[c.kind] || ""}</span>` : "")
    + `</th>`).join("");
  $("risk-table").innerHTML = `<thead><tr><th>规则</th>${head}<th>线</th></tr></thead>`
    + `<tbody>${rows.join("")}</tbody>`;

  const unparsed = cols.filter(c => !c.merged).reduce((s, c) => s + c.judge.unparsed, 0);
  $("risk-table-note").textContent = unparsed
    ? `${unparsed} 张卖出合约读不出行权价/方向，未计入名义 —— 实际比显示的高` : "";
}

function renderRiskCash(cols) {
  const el = $("risk-cash");
  const cash = cols.filter(c => c.kind === "cash");
  el.hidden = !cash.length;
  el.innerHTML = cash.map(c => {
    const weeks = c.weeks || [];
    const head = `<h3>${esc(c.label)} · 现金户：到期周卖 put 名义 vs 现金 + BOXX `
      + `<span class="muted">${fmtMoney(c.book.cashLike)}</span></h3>`;
    if (!weeks.length) return `${head}<div class="muted">没有卖出的 put。</div>`;
    const label = (w) => {
      if (w.weekStart === Infinity) return "到期日未识别";
      const f = (t) => { const d = new Date(t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
      return `${f(w.weekStart)}–${f(w.weekStart + 4 * DAY_MS)}`;
    };
    const pctCell = (r, flag, tone) =>
      `<td class="num${flag ? ` ${tone}` : ""}">${r == null ? "—" : `<b>${fmtPct(r, 0)}</b>`}</td>`;
    const body = weeks.map(w => `<tr>
        <td><b>${label(w)}</b></td>
        <td class="num">${w.dte == null ? "—" : w.dte}</td>
        <td class="expiry-items">${w.items.map(esc).join(" · ")}</td>
        <td class="num${w.over ? " down" : ""}"><b>${fmtMoney(w.putNotional)}</b></td>
        ${pctCell(w.ratio, w.over, "down")}
        <td class="num${w.cumOver ? " amber" : ""}">${fmtMoney(w.cum)}</td>
        ${pctCell(w.cumRatio, w.cumOver, "amber")}
      </tr>`).join("");
    return `${head}<div class="table-wrap"><table class="holdings">
      <thead><tr><th>到期周</th><th class="num">DTE</th><th>卖出 put</th>
        <th class="num">当周名义</th><th class="num">÷ 现金+BOXX</th>
        <th class="num">累计名义</th><th class="num">累计 ÷ 现金+BOXX</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }).join("");
}

function renderRiskEarnings(rows, accounts, cfg) {
  const el = $("risk-earnings");
  if (!rows.length) { el.innerHTML = ""; el.hidden = true; return; }
  el.hidden = false;
  const earn = currentDataRef.earnings || {};
  const TAG = {
    cross: '<span class="tag tag-over">跨财报</span>',
    unknown: '<span class="tag tag-under">未知</span>',
    clear: '<span class="tag tag-inband">不跨</span>',
    na: '<span class="tag tag-gone">不适用</span>',
  };
  const multi = Object.keys(accounts || {}).length > 1;
  // Index-fund contracts have nothing to cross. Listed one per row they
  // outnumbered the contracts that do, so they collapse into one closing
  // line — still counted, never silently dropped.
  const flagged = rows.filter(r => r.state !== "na");
  const na = rows.filter(r => r.state === "na");
  const body = flagged.map(r => {
    const o = r.o;
    const e = r.entry;
    let when;
    if (e && e.status === "ok" && e.date) {
      const via = r.ticker !== o.underlying ? `${esc(r.ticker)} ` : "";
      const tags = [EARNINGS_TIMING[e.timing] || "", e.estimated ? "估" : "",
                    e.stale ? "旧缓存" : ""].filter(Boolean);
      when = `${via}${fmtMD(e.date)}`
        + (tags.length ? ` <span class="muted">${tags.join(" · ")}</span>` : "");
    } else {
      when = `<span class="muted">${earn.loading ? "读取中…" : esc(r.why || "未知")}</span>`;
    }
    const tip = r.state === "unknown" ? (r.why || "")
      : (e && e.as_of ? `Nasdaq，取于 ${e.as_of}` : "");
    const exp = expiryIso(o.expiry);
    return `<tr>
      ${multi ? `<td>${esc(riskAccountLabel(r.acct, cfg))}</td>` : ""}
      <td><b>${esc(o.symbol)}</b></td>
      <td class="num">${Math.abs(o.quantity)}</td>
      <td>${exp ? fmtMD(exp) : esc(o.expiry || "?")}</td>
      <td title="${esc(tip)}">${when}</td>
      <td>${TAG[r.state]}</td>
    </tr>`;
  }).join("") + (na.length
    ? `<tr class="risk-na-row"><td colspan="${multi ? 5 : 4}" class="muted">另有 `
      + `${na.reduce((s, r) => s + Math.abs(r.o.quantity || 0), 0)} 张卖出期权在指数 / 商品 ETF 上（`
      + `${[...new Set(na.map(r => r.o.underlying))].map(esc).join("、")}）—— 没有财报，不标</td>`
      + `<td>${TAG.na}</td></tr>`
    : "");
  const n = (s) => rows.filter(r => r.state === s).length;
  el.innerHTML = `<h3>卖出期权 × 下次财报
      <span class="muted">跨 ${n("cross")} · 未知 ${n("unknown")} · 不跨 ${n("clear")} · 不适用 ${n("na")}</span></h3>
    <div class="table-wrap"><table class="holdings">
      <thead><tr>${multi ? "<th>账户</th>" : ""}<th>合约</th><th class="num">张数</th>
        <th>到期</th><th>下次财报</th><th>判定</th></tr></thead>
      <tbody>${body}</tbody></table></div>`
    + (earn.error
      ? `<div class="margin-foot down">财报日期读取失败：${esc(earn.error)} —— 全部按未知处理。</div>`
      : "");
}

/* --- The settings dialog -------------------------------------------------- */

// Inputs speak the units people think in; the file stores ratios and
// fractions. scale: stored × scale = what the box shows.
const RISK_FIELDS = [
  { key: "put_nav_max", label: "卖 put 名义 ÷ 净值", unit: "x", scale: 1 },
  { key: "single_put_nav_max", label: "单标的卖 put 名义 ÷ 净值", unit: "x", scale: 1 },
  { key: "cluster_nav_max", label: "AI 硬件簇 ÷ 净值", unit: "x", scale: 1 },
  { key: "pm_floor", label: "组合保证金净值线", unit: "US$", scale: 1 },
  { key: "pm_warn", label: "离线缓冲预警（占净值）", unit: "%", scale: 100 },
  { key: "drawdown_days", label: "回撤窗口", unit: "个交易日", scale: 1 },
  { key: "drawdown_stop", label: "回撤断路器", unit: "%", scale: 100 },
];

// toFixed round-trips: 0.1 × 100 is 10.000000000000002 in binary floating
// point, and that is what would otherwise sit in the box.
const riskToInput = (v, scale) => (v == null ? "" : String(+(v * scale).toFixed(6)));
const riskFromInput = (raw, scale) => {
  const t = String(raw).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? +(n / scale).toFixed(8) : NaN;
};
// "SOXL, SOXX  smh" → ["SOXL", "SOXX", "SMH"]; blank → null (the default).
const riskListFromInput = (raw) => {
  const list = String(raw || "").split(/[\s,，、;]+/)
    .map(s => s.trim().toUpperCase()).filter(Boolean);
  return list.length ? list : null;
};

function openRiskModal() {
  const stored = currentDataRef.riskSettings || {};
  const th = stored.thresholds || {};
  $("risk-form-body").innerHTML = RISK_FIELDS.map(f => `<tr>
      <td>${f.label}</td>
      <td><div class="risk-input">
        <input type="number" data-key="${f.key}" inputmode="decimal" step="any" min="0"
               placeholder="${riskToInput(RISK_DEFAULTS[f.key], f.scale)}"
               value="${riskToInput(th[f.key], f.scale)}" aria-label="${f.label}" />
        <span class="unit">${f.unit}</span></div></td>
      <td class="muted">默认 ${riskToInput(RISK_DEFAULTS[f.key], f.scale)}</td>
    </tr>`).join("")
    + `<tr><td>单列标的</td><td colspan="2"><input type="text" class="risk-text" data-list="watch"
          aria-label="单列标的" placeholder="${RISK_WATCH.join(", ")}"
          value="${esc((stored.watch || []).join(", "))}" /></td></tr>`
    + `<tr><td>AI 硬件簇成员</td><td colspan="2"><textarea class="risk-text" data-list="cluster" rows="2"
          aria-label="AI 硬件簇成员" placeholder="${RISK_CLUSTER.join(", ")}"
          >${esc((stored.cluster || []).join(", "))}</textarea></td></tr>`;
  const accts = new Set([...Object.keys(currentDataRef.allAccounts || {}),
                         ...Object.keys(stored.accounts || {})]);
  $("risk-accounts-body").innerHTML = [...accts].sort().map(id => {
    const a = (stored.accounts || {})[id] || {};
    const opt = (v, text) =>
      `<option value="${v}"${(a.kind || "") === v ? " selected" : ""}>${text}</option>`;
    return `<tr data-acct="${esc(id)}">
      <td><b>${esc(maskAccountId(id))}</b></td>
      <td><select data-role="kind" aria-label="${esc(maskAccountId(id))} 账户类型">
        ${opt("", "未设置")}${opt("pm", "组合保证金")}${opt("margin", "Reg-T 保证金")}${opt("cash", "现金户")}
      </select></td>
      <td><input type="text" class="risk-text" data-role="label" maxlength="24"
                 aria-label="${esc(maskAccountId(id))} 名称"
                 placeholder="名称（可选，如 个人 / SMSF）" value="${esc(a.label || "")}" /></td>
    </tr>`;
  }).join("");
  $("risk-status").textContent = "";
  $("risk-modal").hidden = false;
  document.body.classList.add("modal-open");
  $("risk-modal-close").focus();
}

function closeRiskModal() {
  $("risk-modal").hidden = true;
  document.body.classList.remove("modal-open");
}

function riskDraft() {
  const thresholds = {};
  for (const f of RISK_FIELDS) {
    const input = document.querySelector(`#risk-form-body input[data-key="${f.key}"]`);
    const v = riskFromInput(input.value, f.scale);
    if (Number.isNaN(v)) return { error: `${f.label}：填的不是数字` };
    thresholds[f.key] = v;
  }
  const list = (name) => riskListFromInput(
    document.querySelector(`#risk-form-body [data-list="${name}"]`).value);
  const accounts = {};
  document.querySelectorAll("#risk-accounts-body tr[data-acct]").forEach(tr => {
    const kind = tr.querySelector('[data-role="kind"]').value || null;
    const label = tr.querySelector('[data-role="label"]').value.trim();
    if (kind || label) accounts[tr.dataset.acct] = { kind, label };
  });
  return { body: { thresholds, watch: list("watch"), cluster: list("cluster"), accounts } };
}

async function saveRiskSettings() {
  const draft = riskDraft();
  if (draft.error) { $("risk-status").textContent = draft.error; return; }
  const btn = $("risk-save");
  btn.disabled = true;
  $("risk-status").textContent = "保存中…";
  try {
    const res = await fetch("/api/settings/risk", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft.body),
    });
    const j = await res.json();
    if (!res.ok) {
      // The server names the field; the dialog stays open with everything
      // typed still in it.
      $("risk-status").textContent = j.error || `HTTP ${res.status}`;
      return;
    }
    currentDataRef.riskSettings = j;
    currentDataRef.riskSettingsError = null;
    closeRiskModal();
    showToast("success", "已保存", "风险闸门设置已更新");
    renderRiskGate();
  } catch (exc) {
    $("risk-status").textContent = "";
    showToast("error", "保存失败", String(exc));
  } finally {
    btn.disabled = false;
  }
}

function wireRiskModal() {
  $("risk-btn").addEventListener("click", openRiskModal);
  $("risk-modal-close").addEventListener("click", closeRiskModal);
  $("risk-cancel").addEventListener("click", closeRiskModal);
  $("risk-save").addEventListener("click", saveRiskSettings);
  // Clearing the boxes is a draft like any other — nothing is written until 保存.
  $("risk-reset").addEventListener("click", () => {
    document.querySelectorAll("#risk-form-body input, #risk-form-body textarea")
      .forEach(el => { el.value = ""; });
    $("risk-status").textContent = "已清空为默认值，保存后生效";
  });
  $("risk-modal").addEventListener("click", (e) => {
    if (e.target === $("risk-modal")) closeRiskModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("risk-modal").hidden) closeRiskModal();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireRiskModal();
  // Same guard as the position rules: the 设置 button ships disabled and only
  // a successful read enables it, so a failed GET can never lead to a save
  // that writes blanks over the stored lines. The panel itself still renders
  // — on the defaults, and saying so.
  fetch("/api/settings/risk")
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(cfg => {
      currentDataRef.riskSettings = cfg;
      currentDataRef.riskSettingsError = null;
      const btn = $("risk-btn");
      btn.disabled = false;
      btn.title = "改风险闸门的线和 AI 簇成员，标出组合保证金户 / 现金户";
    })
    .catch(exc => {
      currentDataRef.riskSettingsError = String(exc.message || exc);
      $("risk-btn").title = "设置读取失败，刷新页面重试";
    })
    .then(() => { if (currentDataRef.allAccounts) renderRiskGate(); });
});
