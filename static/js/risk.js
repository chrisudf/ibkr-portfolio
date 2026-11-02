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
 *   近 N 日回撤 / 断路器          flow-adjusted drawdown from the window's high,
 *                               in two steps: at −10% no new short puts, at
 *                               −20% 只减不加 (shares and long options too)
 *   到期周 vs 现金               cash accounts only: each expiry week's
 *                               short-put notional against cash + BOXX
 *   卖 put 预警 / 止损           each short put on its own: what buying it
 *                               back costs against the premium it was sold
 *                               for — amber at 2× (the price doubled, a loss
 *                               of one premium), red at 3×
 *   正股较持仓成本               each stock position against its own cost
 *                               basis — amber at −20%
 *
 * The last two are about positions already on, not the next order, and they
 * never merge: a contract belongs to one account, and so does the cost a
 * stock is measured against — one name can sit 25% under water in one
 * account and 15% in the other. The household column leaves them to the
 * accounts.
 *
 * Earnings are deliberately not a rule here: a "this put crosses a report"
 * column was built and taken out again — earnings season is watched by hand.
 *
 * It follows the account tab like every other panel: an account's tab shows
 * that account alone, and 总账户 lays every account side by side with the
 * household column. Looking only at the account you are trading in misses no
 * alarm — every line is judged per account, and the household ratio is the
 * accounts' NAV-weighted average, so it can never be over a line that every
 * account is under. The side-by-side view is for the other question: is the
 * same bet sitting in both accounts.
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
 * fmtPct, maskAccountId, currentDataRef, buildPriceBook, groupExpiries,
 * parseExpiryTs, fundedSeries, navStats, mergeAccounts, showToast, DAY_MS,
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
  drawdown_stop: 0.10,       // 一级断路器：窗口高点回撤到 −10% → 停卖 put
  drawdown_halt: 0.20,       // 二级断路器：回撤到 −20% → 只减不加
  put_close_warn: 2.0,       // 卖 put 预警：平仓价达到卖出时收的权利金的 2 倍 → 黄
  put_close_stop: 3.0,       // 卖 put 止损：平仓价达到 3 倍 → 红
  stock_drop_warn: 0.20,     // 正股较持仓成本跌到 −20% → 黄
};

// Names that gap together on an AI-capex scare, gated as one position.
const RISK_CLUSTER = ["SOXL", "SOXX", "SMH", "NVDA", "NVDL", "AVGO", "COHR",
                      "LITE", "LITX", "VRT", "MU", "TSM"];
// Underlyings with a 单标的 row of their own, whatever their size.
const RISK_WATCH = ["SOXL"];

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
  // A put warning above the stop could never show: the stop claims every put
  // first. The dialog refuses that pair, but the server stores only what was
  // typed, so a lone override meets its partner's default only here — and a
  // default can move after a value was saved. The effective pair is put in
  // order where the two meet: the warning folds into the stop, one line, the
  // same thing the dialog accepts when both are typed equal.
  if (cfg.put_close_warn > cfg.put_close_stop) cfg.put_close_warn = cfg.put_close_stop;
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

// Which breaker step the drawdown has reached: 0 none, 1 no new short puts,
// 2 nothing new at all. Inclusive — "−10% trips it", not "worse than −10%".
// The first step is aimed at short puts on purpose: they are the leverage that
// compounds a slide (the assignment bill grows and margin rises as prices
// fall), while a share or a long option paid for with idle cash risks only
// itself. Past the second step that distinction stops mattering.
function riskBreaker(dd, cfg) {
  if (!dd) return 0;
  if (dd.dd <= -cfg.drawdown_halt + RISK_EPS) return 2;
  if (dd.dd <= -cfg.drawdown_stop + RISK_EPS) return 1;
  return 0;
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

// The two per-position lines, for one account. Both read the statement the
// way the tables further down print it. A short put is measured by what
// buying it back costs — the options table's 市值, negative on a short —
// against the premium it was sold for, its 权利金 (cost_basis, negative too),
// in two steps. Sold for $100 and marked at −$200 is 2×: the price has
// doubled, the loss is one premium (回报 −100%) — amber, time to review.
// Marked at −$300 is 3×, red, the stop. A stock's figure is the holdings
// table's 回报, unrealized_pl ÷ cost_basis. Inclusive, like the breaker:
// exactly on a line trips it, float noise or not.
//
// Short calls stay out (a covered call's loss is its shares' gain), and so do
// cash equivalents and short stock. Each list is sorted worst first, which
// makes its hits a prefix of it — the red puts ahead of the amber ones.
function riskUnderwater(data, cfg) {
  const level = (r) => (r >= cfg.put_close_stop - RISK_EPS ? "red"
    : r >= cfg.put_close_warn - RISK_EPS ? "amber" : "ok");
  const puts = [];
  for (const o of data.options || []) {
    if (!(o.quantity < 0) || o.right !== "P" || !(o.cost_basis < 0)) continue;
    const premium = -o.cost_basis, close = -(o.value || 0), ratio = close / premium;
    puts.push({ u: o.underlying || o.symbol, expiry: o.expiry, strike: o.strike,
                qty: -o.quantity, premium, close, ratio, level: level(ratio) });
  }
  puts.sort((a, b) => b.ratio - a.ratio || a.u.localeCompare(b.u));
  const stocks = [];
  for (const s of data.stocks || []) {
    if (CASH_EQUIVALENTS.has(s.symbol) || !(s.quantity > 0) || !(s.cost_basis > 0)) continue;
    stocks.push({ u: s.symbol, cost: s.cost_price, price: s.close_price,
                  ret: (s.unrealized_pl || 0) / s.cost_basis });
  }
  stocks.sort((a, b) => a.ret - b.ret || a.u.localeCompare(b.u));
  return {
    puts, stocks,
    putHits: puts.filter(p => p.level !== "ok"),
    stockHits: stocks.filter(s => s.ret <= -cfg.stock_drop_warn + RISK_EPS),
  };
}

// The verdict for one account column. `breaker` is the step reached (0–2);
// `stops` is riskUnderwater's read of the same account. A put at its stop is
// red like a crossed line. A put at its first step, and a stock under its
// cost line, are amber: they say a holding needs looking at, not whether the
// next order may go in.
function riskVerdict(judge, dd, pm, cashWeeks, cfg, stops) {
  const fx = (r) => `${r.toFixed(2)}x`;
  const crossed = [];
  if (judge.put.over) crossed.push(`卖 put ${fx(judge.put.ratio)}`);
  for (const w of judge.watch) if (w.over) crossed.push(`${w.u} ${fx(w.ratio)}`);
  for (const s of judge.single) if (s.over) crossed.push(`${s.u} ${fx(s.ratio)}`);
  if (judge.cluster.over) crossed.push(`AI 硬件簇 ${fx(judge.cluster.ratio)}`);
  const breaker = riskBreaker(dd, cfg);
  const cashShort = (cashWeeks || []).filter(w => w.over).length;
  const pmLevel = pm ? pm.level : "ok";
  const putStops = stops ? stops.putHits.filter(p => p.level === "red").length : 0;
  const putWarns = stops ? stops.putHits.length - putStops : 0;
  const stockDrops = stops ? stops.stockHits.length : 0;
  return {
    crossed, breaker, pmLevel, cashShort, putStops, putWarns, stockDrops,
    level: breaker || crossed.length || pmLevel === "red" || cashShort || putStops ? "red"
      : pmLevel === "amber" || putWarns || stockDrops ? "amber" : "ok",
  };
}

// Which accounts the selected tab shows. An account's own tab shows just that
// account; 总账户 — or a selection that no longer exists — shows them all,
// plus the household column when there is more than one.
function riskScope(ids, selected) {
  if (selected && selected !== "ALL" && ids.includes(selected)) {
    return { ids: [selected], merged: false };
  }
  return { ids, merged: ids.length > 1 };
}

// One account's verdict in a few words, for the folded panel's single line.
function riskBrief(v, cfg) {
  const parts = [];
  if (v.breaker === 2) parts.push("只减不加");
  else if (v.breaker === 1) parts.push("停卖 put");
  if (v.crossed.length) parts.push(`超线 ${v.crossed.length} 项`);
  if (v.pmLevel === "red") parts.push("PM 线下");
  else if (v.pmLevel === "amber") parts.push("PM 缓冲薄");
  if (v.cashShort) parts.push(`${v.cashShort} 周现金不够`);
  if (v.putStops) parts.push(`${v.putStops} 张 put 到止损线`);
  if (v.putWarns) parts.push(`${v.putWarns} 张 put 到预警线`);
  if (v.stockDrops) parts.push(`${v.stockDrops} 只正股跌 ≥ ${fmtPct(cfg.stock_drop_warn, 0)}`);
  return parts.length ? parts.join(" · ") : "线内";
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

// "SOXL 11/6 80P ×2": a put ladder puts several contracts on one name, and
// the expiry and strike are what tell its rungs apart.
function riskPutLabel(p) {
  const ts = parseExpiryTs(p.expiry);
  const when = ts == null ? (p.expiry || "?")
    : `${new Date(ts).getUTCMonth() + 1}/${new Date(ts).getUTCDate()}`;
  return `${p.u} ${when} ${p.strike || "?"}P${p.qty > 1 ? ` ×${p.qty}` : ""}`;
}

function riskAccountLabel(id, cfg) {
  const label = ((cfg.accounts || {})[id] || {}).label;
  return label ? `${label} ${maskAccountId(id)}` : maskAccountId(id);
}

function renderRiskGate() {
  const panel = $("risk-panel");
  const accounts = currentDataRef.allAccounts || {};
  const all = Object.keys(accounts).sort();
  if (!all.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const scope = riskScope(all, currentDataRef.selected);
  const ids = scope.ids;
  const cfg = riskConfig(currentDataRef.riskSettings);
  // Prices stay pooled across every account even with one on screen: a spot
  // is a market fact, and a LEAP held here may be priced by stock held there.
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
    const stops = riskUnderwater(a, cfg);
    return { id, label: riskAccountLabel(id, cfg), kind, book: b, judge, dd, pm, weeks, stops,
             verdict: riskVerdict(judge, dd, pm, weeks, cfg, stops) };
  });
  if (scope.merged) {
    const merged = mergeAccounts(accounts);
    const b = mergeRiskBooks(cols.map(c => c.book));
    cols.push({ id: "ALL", label: "合并", kind: null, book: b, judge: riskJudge(b, cfg),
                dd: riskDrawdown(merged.nav_history, merged.cash_flows, cfg.drawdown_days),
                merged: true });
  }
  const accountCols = cols.filter(c => !c.merged);

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

  renderRiskVerdict(accountCols, cfg);
  renderRiskTable(cols, cfg);
  renderRiskCash(accountCols);
}

function renderRiskVerdict(cols, cfg) {
  const lines = cols.map(c => {
    const v = c.verdict;
    const parts = [];
    const ddText = c.dd ? `近 ${cfg.drawdown_days} 个交易日回撤 ${fmtPct(c.dd.dd, 1)}` : "";
    if (v.breaker === 2) {
      parts.push(`<b class="down">二级断路器：只减不加</b>（${ddText}，正股和期权多头也停）`);
    } else if (v.breaker === 1) {
      parts.push(`<b class="down">断路器：不开新卖 put</b>`
        + `（${ddText}；roll 不加张数和名义，闲置现金可以买正股和期权多头）`);
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
    // Every position at a line is named, however many: these are the ones
    // to act on, and a count would leave the reader to go and find them.
    const putsAt = (lvl) => c.stops.putHits.filter(p => p.level === lvl)
      .map(p => `${esc(riskPutLabel(p))} ${fmtX(p.ratio)}`).join("、");
    if (v.putStops) {
      parts.push(`<b class="down">止损线：${v.putStops} 张卖 put 平仓价达到权利金的 `
        + `${+cfg.put_close_stop.toFixed(2)} 倍</b>（${putsAt("red")}）`);
    }
    if (v.putWarns) {
      parts.push(`<b class="amber">预警：${v.putWarns} 张卖 put 平仓价达到权利金的 `
        + `${+cfg.put_close_warn.toFixed(2)} 倍</b>，该复盘 / 考虑 roll（${putsAt("amber")}）`);
    }
    if (v.stockDrops) {
      parts.push(`<b class="amber">${v.stockDrops} 只正股较持仓成本跌 ≥ ${fmtPct(cfg.stock_drop_warn, 0)}</b>（`
        + c.stops.stockHits.map(s => `${esc(s.u)} ${fmtPct(s.ret, 1)}`).join("、") + "）");
    }
    if (!parts.length) parts.push(`<span class="up">全部在线内</span>`);
    const icon = v.level === "red" ? "⛔" : v.level === "amber" ? "⚠" : "✓";
    const kind = c.kind ? ` <span class="muted">${RISK_KIND_LABEL[c.kind] || ""}</span>` : "";
    return `<div class="risk-verdict-line ${v.level}"><span class="risk-verdict-icon">${icon}</span>`
      + `<span><b>${esc(c.label)}</b>${kind}：${parts.join("；")}</span></div>`;
  });
  $("risk-verdict").innerHTML = lines.join("");
  // Rendered whether or not the panel is folded, so unfolding and folding
  // never shows a stale line.
  $("risk-summary").innerHTML = cols.map(c => {
    const icon = c.verdict.level === "red" ? "⛔" : c.verdict.level === "amber" ? "⚠" : "✓";
    return `<span class="risk-sum ${c.verdict.level}">${icon} <b>${esc(c.label)}</b>：`
      + `${riskBrief(c.verdict, cfg)}</span>`;
  }).join("");
}

function renderRiskTable(cols, cfg) {
  const active = currentDataRef.selected;
  // A lone column needs no highlight; on 总账户 it marks the household one.
  const on = (c) => (cols.length > 1 && c.id === active ? " risk-active" : "");
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
    `≤ −${fmtPct(cfg.drawdown_stop, 0)} 停卖 put · ≤ −${fmtPct(cfg.drawdown_halt, 0)} 只减不加`,
    cols.map(c => {
      if (!c.dd) return blank(c, "—", "净值序列不足 5 个点");
      const step = riskBreaker(c.dd, cfg);
      const tag = step === 2 ? "只减不加" : step === 1 ? "停卖 put" : "";
      const peak = c.dd.peakDate === c.dd.lastDate ? "在窗口高点" : `高点 ${fmtMD(c.dd.peakDate)}`;
      return cell(c, c.dd.dd < -0.0005 ? fmtPct(c.dd.dd, 1) : "0%", step ? "down" : "",
        tag && !c.merged ? `<span class="tag tag-over">${tag}</span> ${peak}` : peak,
        `${c.dd.rows} 个 NAV 行，截至 ${c.dd.lastDate}，剔除出入金`);
    })));
  // Per position: the household column has nothing of its own to add, the
  // account columns already hold every contract and every lot. A cell lists
  // every position at a line, one per line — hits first, always: a 1x put
  // line or a 0% stock line puts a position that has lost nothing on the
  // line, and 全部浮盈 must not hide it. Only with no hits does a cell fall
  // back to the worst position and how far it is from the line.
  // [html, tone] per position: one put cell can hold a stop and a warning.
  const items = (list) => list.map(([html, tone]) =>
    `<span class="risk-item${tone ? ` ${tone}` : ""}">${html}</span>`).join("");
  const STEP = { red: "止损", amber: "预警" };
  rows.push(row("卖 put 平仓价 ÷ 权利金",
    `≥ ${fmtX(cfg.put_close_warn)} 预警 · ≥ ${fmtX(cfg.put_close_stop)} 止损`, cols.map(c => {
      if (!c.stops) return blank(c, "—", "按账户判：每张合约只属于一个账户");
      const hits = c.stops.putHits;
      const tip = (p) => `${riskPutLabel(p)}：平仓 ${fmtMoney(p.close)} ÷ 卖出时收的权利金 `
        + `${fmtMoney(p.premium)}${STEP[p.level] ? `（${STEP[p.level]}）` : ""}`;
      if (!hits.length) {
        const [top] = c.stops.puts;
        if (!top) return blank(c, "无");
        if (!(top.ratio > 1)) return blank(c, "全部浮盈");
        return cell(c, `${esc(riskPutLabel(top))} ${fmtX(top.ratio)}`, "",
          `平仓 ${fmtK(top.close)} / 权利金 ${fmtK(top.premium)}`, tip(top));
      }
      const red = hits.filter(p => p.level === "red").length;
      return cell(c,
        items(hits.map(p => [`${esc(riskPutLabel(p))} ${fmtX(p.ratio)}`,
                             p.level === "red" ? "down" : "amber"])),
        red ? "down" : "amber",
        [red && `${red} 张止损`, hits.length - red && `${hits.length - red} 张预警`]
          .filter(Boolean).join(" · "),
        hits.map(tip).join("\n"));
    })));
  rows.push(row("正股较持仓成本", `≤ −${fmtPct(cfg.stock_drop_warn, 0)} 报警`, cols.map(c => {
    if (!c.stops) return blank(c, "—", "按账户判：成本按各账户自己的算");
    const hits = c.stops.stockHits;
    const tip = (s) => `${s.u}：成本价 ${fmtMoney(s.cost, 2)}，现价 ${fmtMoney(s.price, 2)}`;
    if (!hits.length) {
      const [top] = c.stops.stocks;
      if (!top) return blank(c, "无");
      if (!(top.ret < 0)) return blank(c, "全部浮盈");
      return cell(c, `${esc(top.u)} ${fmtPct(top.ret, 1)}`, "",
        `成本 ${fmtMoney(top.cost, 2)} → ${fmtMoney(top.price, 2)}`, tip(top));
    }
    return cell(c, items(hits.map(s => [`${esc(s.u)} ${fmtPct(s.ret, 1)}`, ""])), "amber",
      `${hits.length} 只到线`, hits.map(tip).join("\n"));
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
  { key: "drawdown_stop", label: "回撤一级（停卖 put）", unit: "%", scale: 100 },
  { key: "drawdown_halt", label: "回撤二级（只减不加）", unit: "%", scale: 100 },
  { key: "put_close_warn", label: "卖 put 预警（平仓价 ÷ 权利金）", unit: "x", scale: 1 },
  { key: "put_close_stop", label: "卖 put 止损（平仓价 ÷ 权利金）", unit: "x", scale: 1 },
  { key: "stock_drop_warn", label: "正股较持仓成本跌幅报警", unit: "%", scale: 100 },
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
  // Checked against the defaults too: typing only the first step deeper than
  // the default second one would make 停卖 put the stricter-sounding, later one.
  const stop = thresholds.drawdown_stop ?? RISK_DEFAULTS.drawdown_stop;
  const halt = thresholds.drawdown_halt ?? RISK_DEFAULTS.drawdown_halt;
  if (halt < stop) return { error: "回撤二级（只减不加）不能比一级（停卖 put）浅" };
  // Same for the two put steps: a stop below the warning would leave amber unreachable.
  const putWarn = thresholds.put_close_warn ?? RISK_DEFAULTS.put_close_warn;
  const putStop = thresholds.put_close_stop ?? RISK_DEFAULTS.put_close_stop;
  if (putStop < putWarn) return { error: "卖 put 止损线不能比预警线低" };
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

/* --- Folding ------------------------------------------------------------ */

// Folded or open is a per-device preference — a phone may want the gate shut
// and the desk want it open — so it lives in this browser, unlike the lines,
// which must read the same everywhere and are kept on the server.
const RISK_FOLD_KEY = "ibkr.riskGate.collapsed";

function applyRiskFold(collapsed) {
  $("risk-panel").classList.toggle("risk-collapsed", collapsed);
  $("risk-body").hidden = collapsed;
  $("risk-summary").hidden = !collapsed;
  $("risk-toggle").setAttribute("aria-expanded", String(!collapsed));
}

function wireRiskToggle() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(RISK_FOLD_KEY) === "1";
  } catch (_) { /* storage blocked: start open */ }
  applyRiskFold(collapsed);
  $("risk-toggle").addEventListener("click", () => {
    collapsed = !collapsed;
    applyRiskFold(collapsed);
    try {
      localStorage.setItem(RISK_FOLD_KEY, collapsed ? "1" : "0");
    } catch (_) { /* fine: it just won't be remembered */ }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireRiskModal();
  wireRiskToggle();
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
