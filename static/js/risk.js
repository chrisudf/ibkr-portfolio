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
 * fmtPct, maskAccountId, currentDataRef, buildPriceBook, stockMarks, allUnderlyings,
 * groupExpiries, parseExpiryTs, fundedSeries, navStats, mergeAccounts,
 * showToast, DAY_MS, CASH_EQUIVALENTS, CONTRACT_MULTIPLIER).
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
  noncore_assigned_max: 0.10, // 非核心标的：全部 put 行权后的仓位 ÷ 净值
  profit_take: 0.10,         // 止盈提醒：单笔持仓盈利达到 10%
};

// Names that gap together on an AI-capex scare, gated as one position.
const RISK_CLUSTER = ["SOXL", "SOXX", "SMH", "NVDA", "NVDL", "AVGO", "COHR",
                      "LITE", "LITX", "VRT", "MU", "TSM"];
// Underlyings with a 单标的 row of their own, whatever their size.
const RISK_WATCH = ["SOXL"];
// Held without a take-profit target, these get called out in 止盈提醒: they give
// a gain back fastest. A default, like the cluster; the 目标价 dialog replaces it.
const PROFIT_LEVERED = ["CONL", "ECHX", "ETHU", "GGLL", "LITX", "METU", "NVDL", "SOXL"];

const RISK_KIND_LABEL = { pm: "组合保证金", margin: "Reg-T 保证金", cash: "现金户" };

// Float noise must not decide a verdict. A chain of NAV ratios that lands on
// −10% can come out as −9.999999999999998%, and "exactly on the line" has to
// read the same way every time.
const RISK_EPS = 1e-9;

// The lines in force: defaults, overlaid with whatever the settings file
// holds. Anything unreadable falls back to the default rather than to 0 —
// a line of 0 would turn the whole table red for no reason.
//
// `positions` is the 核心持仓 settings. Without them (not loaded, the request
// failed, or the server could not read its file: read_error) cfg.core is null
// and the non-core line is not judged: every name would otherwise read as
// non-core and light up because of a broken file.
function riskConfig(stored, positions) {
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
  cfg.core = positions && !positions.read_error
    ? new Set(Object.entries(positions.symbols || {}).filter(([, p]) => p && p.core).map(([u]) => u))
    : null;
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
//
// `held` is what is already in each name, on the 仓位区间 definition: stock
// plus long options at market value. It is what an assignment would add to.
function riskBook(data, cfg, priceBook) {
  const members = new Set(cfg.cluster);
  const byU = {}, held = {}, putQty = {};
  let putTotal = 0, unparsed = 0;
  let stockMV = 0, leap = 0, clusterPut = 0, leapAssumed = 0;
  for (const s of data.stocks || []) {
    if (members.has(s.symbol)) stockMV += s.value || 0;
    held[s.symbol] = (held[s.symbol] || 0) + (s.value || 0);
  }
  for (const o of data.options || []) {
    const qty = Math.abs(o.quantity || 0);
    const shares = qty * (o.multiplier || CONTRACT_MULTIPLIER);
    if (o.quantity > 0) {
      held[o.underlying] = (held[o.underlying] || 0) + Math.max(o.value || 0, 0);
    }
    if (o.quantity < 0) {
      // A short whose strike or right did not parse could be a put of any
      // size. Leave it out of the sums and count it, as the delta panel does.
      if (!(o.strike > 0) || (o.right !== "P" && o.right !== "C")) {
        unparsed += qty;
        continue;
      }
      if (o.right !== "P") continue;
      const n = o.strike * shares;
      putTotal += n;
      byU[o.underlying] = (byU[o.underlying] || 0) + n;
      putQty[o.underlying] = (putQty[o.underlying] || 0) + qty;
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
    nav: riskNav(data), putTotal, byU, held, putQty, unparsed,
    cluster: { stockMV, leap, put: clusterPut, leapAssumed },
    cashLike: ((data.nav || {}).cash || 0) + cashEq,
  };
}

function mergeRiskBooks(books) {
  const out = {
    nav: 0, putTotal: 0, byU: {}, held: {}, putQty: {}, unparsed: 0, cashLike: 0,
    cluster: { stockMV: 0, leap: 0, put: 0, leapAssumed: 0 },
  };
  for (const b of books) {
    out.nav += b.nav;
    out.putTotal += b.putTotal;
    out.unparsed += b.unparsed;
    out.cashLike += b.cashLike;
    for (const [u, n] of Object.entries(b.byU)) out.byU[u] = (out.byU[u] || 0) + n;
    for (const [u, n] of Object.entries(b.held)) out.held[u] = (out.held[u] || 0) + n;
    for (const [u, n] of Object.entries(b.putQty)) out.putQty[u] = (out.putQty[u] || 0) + n;
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
  // A non-core name's size if every put on it were assigned. Only names with a
  // short put: the question is what the puts would do, and a holding with none
  // is the 仓位区间's business. NAV stays the divisor — assignment swaps cash
  // for stock and leaves NAV where it was. One contract always passes: a single
  // put on a high-priced name can't be sized any smaller. Crossed names sort
  // first, so a big single contract can't take the top of the list from them.
  const noncore = !cfg.core ? [] : Object.entries(book.byU)
    .filter(([u]) => !cfg.core.has(u) && !CASH_EQUIVALENTS.has(u))
    .map(([u, put]) => {
      const held = book.held[u] || 0, r = ratio(held + put), contracts = book.putQty[u] || 0;
      return { u, held, put, contracts, total: held + put, ratio: r,
               over: contracts > 1 && over(r, cfg.noncore_assigned_max) };
    })
    .sort((a, b) => b.over - a.over || b.total - a.total || a.u.localeCompare(b.u));
  return {
    nav: book.nav,
    noncore,
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

// Positions at the take-profit line, grouped by underlying, best name first.
// The figure is the 回报 column of the holdings tables: unrealized P/L over the
// absolute cost, so a short call's cost is the premium it was sold for. On
// the line counts, like the other position alarms. Long stock only, and no
// cash equivalents: BOXX earning its yield is not a position to close. Calls
// only for now: how puts should be judged is an open question (TODO.md).
//
// `planned` is the names with a live target plan here (riskTargets). Their
// shares leave this line: a plan says where you mean to act, and a leveraged
// ETF reaches 10% in a day, so the generic line would bury it. Calls stay on,
// because the plan is written in the share price.
function riskProfits(data, cfg, planned) {
  const byU = {};
  const add = (u, label, pl, cost) => {
    const ret = (pl || 0) / cost;
    if (ret < cfg.profit_take - RISK_EPS) return;
    (byU[u] || (byU[u] = [])).push({ label, ret, pl: pl || 0, cost });
  };
  for (const s of data.stocks || []) {
    if (CASH_EQUIVALENTS.has(s.symbol) || !(s.quantity > 0) || !(s.cost_basis > 0)) continue;
    if (planned && planned.has(s.symbol)) continue;
    add(s.symbol, "持股", s.unrealized_pl, s.cost_basis);
  }
  for (const o of data.options || []) {
    const u = o.underlying || o.symbol;
    if (o.right !== "C" || CASH_EQUIVALENTS.has(u) || !o.quantity || !o.cost_basis) continue;
    const side = o.quantity < 0 ? "卖" : "买";
    add(u, `${side} ${riskContract({ ...o, qty: Math.abs(o.quantity) })}`,
        o.unrealized_pl, Math.abs(o.cost_basis));
  }
  return Object.entries(byU)
    .map(([u, rows]) => ({ u, rows: rows.sort((a, b) => b.ret - a.ret) }))
    .sort((a, b) => b.rows[0].ret - a.rows[0].ret || a.u.localeCompare(b.u));
}

// One account's take-profit plans, read against what it holds today. The server
// has done the history (parser/targets.py): which tiers have been reached since
// they were set, and whether the account has sold since. What is left is today's
// close against each tier, and what the panel should say about it.
//
// `known` false means the plans or their history could not be read. Nothing is
// judged then, and every name stays on the 10% line, so a broken file cannot
// silently take a position out of the reminders.
//
// Per tier: "hit" reached and still at or above it, "fell" reached and back
// under it, "next" not reached. A tier this account has sold into is done and
// drops out. A name is only listed once a tier has been reached, like every
// other line here; the rest of its tiers come along to show what is left.
//   active  plans still in play here: their shares leave the 10% line
//   blocked plans on file that cannot be judged here, and say why
//   missing leveraged ETFs held with nothing left to reach
function riskTargets(data, acctId, plans, progress, levered) {
  const out = { known: false, active: new Set(), groups: [], blocked: [], missing: [] };
  if (!plans || plans.read_error) return out;
  const symbols = plans.symbols || {};
  if (progress == null && Object.keys(symbols).length) return out;
  out.known = true;
  const spots = {};
  for (const s of data.stocks || []) {
    if (s.quantity > 0) spots[s.symbol] = s.close_price;
  }
  const longCalls = new Set((data.options || [])
    .filter(o => o.quantity > 0 && o.right === "C").map(o => o.underlying || o.symbol));
  for (const [u, plan] of Object.entries(symbols)) {
    const p = (progress || {})[u];
    if (!p || p.state === "expired") continue;
    // Its prices (split) or its history (stale) no longer hold: say so where
    // the shares are, rather than judge on them.
    if (p.state === "split" || p.state === "stale") {
      if (u in spots) out.blocked.push({ u, why: p.state, on: p.split_on });
      continue;
    }
    // Only an account holding the shares is judged. Calls here with no shares
    // say so, or the plan would look like it was watching them.
    if (!(u in spots)) {
      if (longCalls.has(u)) out.blocked.push({ u, why: "no-stock" });
      continue;
    }
    const spot = spots[u];
    const read = (p.accounts || {})[acctId] || [];
    // Read for these prices or not used at all: a reading of other prices
    // would put a reached tier against the wrong one. The shares stay on the
    // 10% line until the two agree again.
    if (read.some((r, i) => r.price != null && r.price !== ((plan.tiers || [])[i] || {}).price)) continue;
    const rows = (plan.tiers || []).map((t, i) => {
      const r = read[i] || {};
      const gap = spot > 0 ? spot / t.price - 1 : null;
      return {
        n: i + 1, price: t.price, reduced: !!r.reduced,
        state: !r.reached ? "next" : gap != null && gap < -RISK_EPS ? "fell" : "hit",
        gap, toGo: spot > 0 ? t.price / spot - 1 : null,
        hitOn: r.hit_on, hitClose: r.hit_close, peakOn: r.peak_on, peakClose: r.peak_close,
      };
    }).filter(r => !r.reduced);
    if (rows.length) out.active.add(u);
    const hits = rows.filter(r => r.state !== "next").length;
    if (hits) {
      out.groups.push({ u, spot, rows, hits, fell: rows.filter(r => r.state === "fell").length });
    }
  }
  out.groups.sort((a, b) => b.fell - a.fell || b.hits - a.hits || a.u.localeCompare(b.u));
  const blocked = new Set(out.blocked.map(b => b.u));
  out.missing = (levered || [])
    .filter(u => u in spots && !out.active.has(u) && !blocked.has(u)).sort();
  return out;
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
  const noncoreOver = judge.noncore.filter(n => n.over).length;
  return {
    crossed, breaker, pmLevel, cashShort, putStops, putWarns, stockDrops, noncoreOver,
    level: breaker || crossed.length || noncoreOver || pmLevel === "red" || cashShort || putStops ? "red"
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
  if (v.noncoreOver) parts.push(`${v.noncoreOver} 只非核心超线`);
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
  return `${p.u} ${riskContract(p)}`;
}

// "11/6 80P ×2": the part of a contract's name that follows the ticker.
function riskContract(p) {
  const ts = parseExpiryTs(p.expiry);
  const when = ts == null ? (p.expiry || "?")
    : `${new Date(ts).getUTCMonth() + 1}/${new Date(ts).getUTCDate()}`;
  return `${when} ${p.strike || "?"}${p.right || "P"}${p.qty > 1 ? ` ×${p.qty}` : ""}`;
}

function riskAccountLabel(id, cfg) {
  const label = ((cfg.accounts || {})[id] || {}).label;
  return label ? `${label} ${maskAccountId(id)}` : maskAccountId(id);
}

function renderRiskGate() {
  const panel = $("risk-panel");
  const accounts = currentDataRef.allAccounts || {};
  const all = Object.keys(accounts).sort();
  panel.hidden = $("profit-panel").hidden = !all.length;
  if (!all.length) return;

  const scope = riskScope(all, currentDataRef.selected);
  const ids = scope.ids;
  const cfg = riskConfig(currentDataRef.riskSettings, currentDataRef.positionSettings);
  // Prices stay pooled across every account even with one on screen: a spot
  // is a market fact, and a LEAP held here may be priced by stock held there.
  const book = buildPriceBook(accounts);
  const todayTs = Date.now();
  const plans = currentDataRef.profitTargets;
  const levered = plans && Array.isArray(plans.levered) ? plans.levered : PROFIT_LEVERED;
  // The plans arrive with the statements (loadPortfolio), and the dialog opens
  // only on plans that were read: never on blanks it could save over them.
  const targetBtn = $("target-btn");
  targetBtn.disabled = !plans;
  targetBtn.title = plans ? "给持仓设 2-3 档止盈目标价，还没持有的也能先填"
    : "目标价读取失败，刷新页面重试";
  const cols = ids.map(id => {
    const a = accounts[id];
    const b = riskBook(a, cfg, book);
    const kind = (cfg.accounts[id] || {}).kind || null;
    const judge = riskJudge(b, cfg);
    const dd = riskDrawdown(a.nav_history, a.cash_flows, cfg.drawdown_days);
    const pm = kind === "pm" ? riskPmBuffer(b.nav, cfg.pm_floor, cfg.pm_warn) : null;
    const weeks = kind === "cash" ? riskCashWeeks(a.options, book, todayTs, b.cashLike) : null;
    const stops = riskUnderwater(a, cfg);
    const targets = riskTargets(a, id, plans, currentDataRef.targetProgress, levered);
    return { id, label: riskAccountLabel(id, cfg), kind, book: b, judge, dd, pm, weeks, stops,
             targets, profits: riskProfits(a, cfg, targets.active),
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
  const coreNote = cfg.core ? "" : "核心持仓没读到，非核心线未判 · ";
  $("risk-note").textContent = asOf + coreNote + (settingsError
    ? `设置读取失败（${settingsError}），按默认线显示，账户类型未知`
    : unkinded
      ? `${unkinded} 个账户未设类型 —— 在「设置」里标出组合保证金户 / 现金户`
      : "线是默认值、未正式采纳，可在「设置」里改");

  renderRiskVerdict(accountCols, cfg);
  renderProfitPanel(accountCols, cfg);
  renderRiskTable(cols, cfg);
  renderRiskCash(accountCols);
}

// An account-wide conclusion: nothing to list, so it reads as one line.
function riskAlertHtml(tone, title, note = "") {
  return `<div class="risk-alert"><b class="${tone}">${title}</b>`
    + (note ? `<span class="risk-alert-note">${note}</span>` : "") + `</div>`;
}

// A rule and everything at its line, one name to a row, so the eye can run
// down the names and the figures separately. `rows` are [name, figure, hover],
// with an optional tone of the row's own where a group holds more than one.
function riskGroupHtml(tone, title, note, rows) {
  return `<section class="risk-group"><b class="${tone}">${title}</b>`
    + (note ? `<div class="risk-group-note">${note}</div>` : "") + `<ul class="risk-group-rows">`
    + rows.map(([name, figure, tip, rowTone]) =>
        `<li${tip ? ` title="${esc(tip)}"` : ""}${rowTone === "muted" ? ` class="muted"` : ""}>`
        + `<span>${esc(name)}</span><span class="${rowTone || tone}">${figure}</span></li>`).join("")
    + `</ul></section>`;
}

// "$30", "$2.875": a target as it was typed, with no padding to two decimals.
const fmtTarget = (v) => `$${+Number(v).toFixed(4)}`;

// One tier as a row of its name's group.
function riskTargetRow(r) {
  const name = `第 ${r.n} 档 ${fmtTarget(r.price)}`;
  if (r.state === "next") {
    return [name, r.toGo == null ? "" : `还差 +${fmtPct(r.toGo, 1)}`, "", "muted"];
  }
  const first = r.hitOn ? `${fmtMD(r.hitOn)} 收盘 ${fmtTarget(r.hitClose)} 到价` : "已到价";
  const peak = r.peakClose > r.hitClose
    ? `，之后最高 ${fmtTarget(r.peakClose)}${r.peakOn ? `（${fmtMD(r.peakOn)}）` : ""}` : "";
  const tip = `${first}${peak}。这一档一直显示，直到这个账户减仓，或者在「目标价」里改掉、删掉它`;
  const label = r.hitOn ? `${name} · ${fmtMD(r.hitOn)} 到价` : `${name} · 已到价`;
  return r.state === "fell"
    ? [label, `已跌回 ${fmtPct(r.gap, 1)}`, tip, "amber"]
    : [label, `高出 ${fmtPct(r.gap, 1)}`, tip, "up"];
}

// A plan on file this account cannot judge, as a row of its name's group.
function riskBlockedRow(b) {
  if (b.why === "split") {
    return ["目标价要重填", `${fmtMD(b.on)} 拆股`,
            "拆股后价格单位变了，这组目标价不再判。到「目标价」里重填", "amber"];
  }
  if (b.why === "stale") {
    return ["目标价要重填", "设得太久",
            "快照只保留最近 400 个，这组目标价设得比它们还早，到价和清仓的记录可能已经不全，"
            + "所以不再判。到「目标价」里重填", "amber"];
  }
  return ["目标价未判", "这个账户没有正股",
          "目标价只判持有正股 / ETF 的账户。这里只有 call，call 的盈利照旧走 10% 线", "muted"];
}

// Every name with something to say in one account. A name's tiers and its
// positions at the 10% line share one group, tiers first: the plan you wrote
// outranks the generic line, and a name that has fallen back past a reached
// tier outranks everything, so those lead.
function riskProfitGroups(c) {
  const lines = new Map(c.profits.map(p => [p.u, p.rows]));
  const lineRow = (r) => [r.label, `+${fmtPct(r.ret, 1)}`,
                          `浮盈 ${fmtMoney(r.pl)} ÷ 成本 ${fmtMoney(r.cost)}`, "up"];
  const take = (u) => {
    const rows = lines.get(u) || [];
    lines.delete(u);
    return rows.map(lineRow);
  };
  const groups = c.targets.groups.map(g => riskGroupHtml(g.fell ? "amber" : "up", esc(g.u),
    `现价 ${fmtMoney(g.spot, 2)}`, [...g.rows.map(riskTargetRow), ...take(g.u)]));
  for (const b of c.targets.blocked) {
    groups.push(riskGroupHtml(b.why === "no-stock" ? "up" : "amber", esc(b.u), "",
      [riskBlockedRow(b), ...take(b.u)]));
  }
  for (const p of c.profits) {
    if (lines.has(p.u)) groups.push(riskGroupHtml("up", esc(p.u), "", take(p.u)));
  }
  return groups;
}

// Its own panel, one card per account: a reminder that something can be closed,
// which says nothing about whether the next order may go in.
function renderProfitPanel(cols, cfg) {
  const lines = (c) => c.profits.reduce((s, p) => s + p.rows.length, 0);
  const hits = (c) => c.targets.groups.reduce((s, g) => s + g.hits, 0);
  const fell = (c) => c.targets.groups.some(g => g.fell);
  const brief = (c) => [hits(c) && `${hits(c)} 档到价`, lines(c) && `${lines(c)} 笔到线`]
    .filter(Boolean).join(" · ") || "没有持仓到线";
  const tone = (c) => (fell(c) ? "amber" : hits(c) || lines(c) ? "up" : "muted");
  const known = cols.every(c => c.targets.known);
  $("profit-note").textContent = `单笔盈利 ≥ ${fmtPct(cfg.profit_take, 0)}`
    + (known ? " · 目标价按收盘判" : " · 目标价没读到，未判");
  const missing = known ? [...new Set(cols.flatMap(c => c.targets.missing))].sort() : [];
  $("profit-nudge").hidden = !missing.length;
  $("profit-nudge-list").textContent = missing.join("、");
  $("profit-list").innerHTML = cols.map(c => {
    const groups = riskProfitGroups(c);
    return `<div class="risk-verdict-card profit">`
      + `<div class="risk-verdict-head"><span class="risk-verdict-icon">◎</span>`
      + `<span><b>${esc(c.label)}</b> <span class="${tone(c)}">${brief(c)}</span></span></div>`
      + (groups.length ? `<div class="risk-groups">${groups.join("")}</div>` : "")
      + `</div>`;
  }).join("");
  $("profit-summary").innerHTML = cols.map(c =>
    `<span class="risk-sum ${fell(c) ? "amber" : "ok"}">◎ <b>${esc(c.label)}</b>：${brief(c)}</span>`).join("");
}

function renderRiskVerdict(cols, cfg) {
  const cards = cols.map(c => {
    const v = c.verdict;
    const alerts = [];
    const groups = [];
    const ddText = c.dd ? `近 ${cfg.drawdown_days} 个交易日回撤 ${fmtPct(c.dd.dd, 1)}` : "";
    if (v.breaker === 2) {
      alerts.push(riskAlertHtml("down", "二级断路器：只减不加", `${ddText}，正股和期权多头也停`));
    } else if (v.breaker === 1) {
      alerts.push(riskAlertHtml("down", "断路器：不开新卖 put",
        `${ddText}；roll 不加张数和名义，闲置现金可以买正股和期权多头`));
    }
    if (c.pm && c.pm.level === "red") {
      alerts.push(riskAlertHtml("down", `净值低于组合保证金线 ${fmtK(-c.pm.gap)}`,
        "IBKR 只接受降低保证金的交易"));
    } else if (c.pm && c.pm.level === "amber") {
      alerts.push(riskAlertHtml("amber", `离组合保证金线只剩 ${fmtK(c.pm.gap)}`,
        `净值再跌 ${fmtPct(c.pm.pct, 1)} 就破线`));
    }
    if (v.cashShort) {
      alerts.push(riskAlertHtml("down", `${v.cashShort} 个到期周的卖 put 名义超过现金 + BOXX`));
    }
    if (v.crossed.length) {
      // riskVerdict words each as "<name> <ratio>"; a name may itself hold a
      // space ("卖 put", "AI 硬件簇"), so only the last one separates them.
      const rows = v.crossed.map(s => {
        const at = s.lastIndexOf(" ");
        return [s.slice(0, at), s.slice(at + 1)];
      });
      groups.push(riskGroupHtml("down", `超线 ${v.crossed.length} 项`, "只许替换，不许净新增", rows));
    }
    if (v.noncoreOver) {
      groups.push(riskGroupHtml("down", `非核心超线 ${v.noncoreOver} 只`,
        `全部 put 行权后超净值 ${fmtPct(cfg.noncore_assigned_max, 0)}，且不止 1 张`,
        c.judge.noncore.filter(n => n.over).map(n => [`${n.u} ×${n.contracts}`, fmtPct(n.ratio, 1),
          `现有仓位 ${fmtMoney(n.held)} + 卖 put 名义 ${fmtMoney(n.put)}`])));
    }
    // Every position at a line is named, however many: these are the ones
    // to act on, and a count would leave the reader to go and find them.
    const putsAt = (lvl) => c.stops.putHits.filter(p => p.level === lvl)
      .map(p => [riskPutLabel(p), fmtX(p.ratio),
                 `平仓 ${fmtMoney(p.close)} ÷ 卖出时收的权利金 ${fmtMoney(p.premium)}`]);
    if (v.putStops) {
      groups.push(riskGroupHtml("down", `止损线：${v.putStops} 张卖 put`,
        `平仓价达到权利金的 ${+cfg.put_close_stop.toFixed(2)} 倍`, putsAt("red")));
    }
    if (v.putWarns) {
      groups.push(riskGroupHtml("amber", `预警：${v.putWarns} 张卖 put`,
        `平仓价达到权利金的 ${+cfg.put_close_warn.toFixed(2)} 倍，该复盘 / 考虑 roll`, putsAt("amber")));
    }
    if (v.stockDrops) {
      groups.push(riskGroupHtml("amber", `${v.stockDrops} 只正股`,
        `较持仓成本跌 ≥ ${fmtPct(cfg.stock_drop_warn, 0)}`,
        c.stops.stockHits.map(s => [s.u, fmtPct(s.ret, 1),
          `成本价 ${fmtMoney(s.cost, 2)}，现价 ${fmtMoney(s.price, 2)}`])));
    }
    const clear = alerts.length || groups.length ? "" : ` <span class="up">全部在线内</span>`;
    const icon = v.level === "red" ? "⛔" : v.level === "amber" ? "⚠" : "✓";
    const kind = c.kind ? ` <span class="muted">${RISK_KIND_LABEL[c.kind] || ""}</span>` : "";
    return `<div class="risk-verdict-card ${v.level}">`
      + `<div class="risk-verdict-head"><span class="risk-verdict-icon">${icon}</span>`
      + `<span><b>${esc(c.label)}</b>${kind}${clear}</span></div>`
      + (alerts.length ? `<div class="risk-alerts">${alerts.join("")}</div>` : "")
      + (groups.length ? `<div class="risk-groups">${groups.join("")}</div>` : "")
      + `</div>`;
  });
  $("risk-verdict").innerHTML = cards.join("");
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
    + `${sub ? `<span class="risk-sub">${sub}</span>` : ""}<b>${html}</b></td>`;
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
  rows.push(row("非核心行权后最大", `≤ ${fmtPct(cfg.noncore_assigned_max, 0)} 或只开 1 张`, cols.map(c => {
    if (!cfg.core) return blank(c, "—", "核心持仓没读到");
    // Per account: two accounts holding one contract each are both within it.
    if (c.merged) return blank(c, "—", "按账户判：只开 1 张是每户自己的");
    const [top, ...rest] = c.judge.noncore;
    if (!top) return blank(c, "无");
    if (top.ratio == null) return blank(c);
    const more = rest.filter(n => n.over).length;
    return cell(c, `${esc(top.u)} ×${top.contracts} ${fmtPct(top.ratio, 1)}`, top.over ? "down" : "",
      more ? `另 ${more} 只超线` : fmtK(top.total),
      `现有仓位 ${fmtMoney(top.held)} + 卖 put 名义 ${fmtMoney(top.put)}`);
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
      const peak = c.dd.peakDate === c.dd.lastDate ? "在窗口高点" : `高点 ${fmtMD(c.dd.peakDate)}`;
      return cell(c, c.dd.dd < -0.0005 ? fmtPct(c.dd.dd, 1) : "0%", step ? "down" : "", peak,
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

/* --- The settings dialog -------------------------------------------------- */

// Inputs speak the units people think in; the file stores ratios and
// fractions. scale: stored × scale = what the box shows.
const RISK_FIELDS = [
  { key: "put_nav_max", label: "卖 put 名义 ÷ 净值", unit: "x", scale: 1 },
  { key: "single_put_nav_max", label: "单标的卖 put 名义 ÷ 净值", unit: "x", scale: 1 },
  { key: "noncore_assigned_max", label: "非核心标的 put 全部行权后 ÷ 净值（只开 1 张不判）", unit: "%", scale: 100 },
  { key: "cluster_nav_max", label: "AI 硬件簇 ÷ 净值", unit: "x", scale: 1 },
  { key: "pm_floor", label: "组合保证金净值线", unit: "US$", scale: 1 },
  { key: "pm_warn", label: "离线缓冲预警（占净值）", unit: "%", scale: 100 },
  { key: "drawdown_days", label: "回撤窗口", unit: "个交易日", scale: 1 },
  { key: "drawdown_stop", label: "回撤一级（停卖 put）", unit: "%", scale: 100 },
  { key: "drawdown_halt", label: "回撤二级（只减不加）", unit: "%", scale: 100 },
  { key: "put_close_warn", label: "卖 put 预警（平仓价 ÷ 权利金）", unit: "x", scale: 1 },
  { key: "put_close_stop", label: "卖 put 止损（平仓价 ÷ 权利金）", unit: "x", scale: 1 },
  { key: "stock_drop_warn", label: "正股较持仓成本跌幅报警", unit: "%", scale: 100 },
  { key: "profit_take", label: "止盈提醒（单笔盈利达到）", unit: "%", scale: 100 },
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

/* --- The take-profit target dialog ---------------------------------------- */

// The dialog's draft: one row per symbol, each box exactly as typed. Rows keep
// their order while it is open, so nothing moves under the cursor; nothing is
// written until 保存.
let targetDraft = null;

const TARGET_TIERS = 3;
const TARGET_SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,15}$/;

// What is wrong with one row, or "". Blank boxes are fine, and a gap closes up:
// typing only the first and third box is a plan of two tiers. The server refuses
// the same cases, but a 400 is a worse way to find out than a line in the dialog.
function targetRowProblem(sym, boxes) {
  let last = 0;
  for (let i = 0; i < boxes.length; i++) {
    const t = String(boxes[i]).trim();
    if (!t) continue;
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return `${sym}：第 ${i + 1} 档要填大于 0 的价格`;
    if (n <= last) return `${sym}：第 ${i + 1} 档要比前一档高`;
    last = n;
  }
  return "";
}

// A target at or under the market is legal, and it is reached the moment it is
// saved. Worth saying while typing: it is also what a typo looks like.
function targetRowWarning(sym, boxes, spot) {
  if (!(spot > 0)) return "";
  for (let i = 0; i < boxes.length; i++) {
    const t = String(boxes[i]).trim();
    if (t && Number(t) > 0 && Number(t) <= spot) {
      return `${sym} 第 ${i + 1} 档 ${fmtTarget(t)} 不高于现价 ${fmtTarget(spot)}，保存后马上算到价`;
    }
  }
  return "";
}

// A row's plan is live unless the position it was written for has ended, or
// its history has.
function targetIsLive(plan, progress) {
  return !!plan && !["expired", "split", "stale"].includes((progress || {}).state);
}

// Every account holding the name has sold into every tier: the plan is still
// valid, it just has nothing left to wait for.
function targetAllReduced(progress) {
  const reads = Object.values((progress || {}).accounts || {});
  return reads.length > 0 && reads.every(tiers => tiers.length > 0 && tiers.every(t => t.reduced));
}

function openTargetModal() {
  const stored = currentDataRef.profitTargets || {};
  const symbols = stored.symbols || {};
  const allProgress = currentDataRef.targetProgress || {};
  // Held shares only: a spot here means "some account holds it". The fuller
  // buildPriceBook also prices option-only names (the delta panel's closes),
  // which would rank an unheld SOXL as 未设 and show it a price it is not
  // judged against.
  const spots = stockMarks(currentDataRef.allAccounts || {});
  const levered = new Set(Array.isArray(stored.levered) ? stored.levered : PROFIT_LEVERED);
  // What still needs a decision comes first, then what has one, then the rest.
  const rank = (u) => {
    const live = targetIsLive(symbols[u], allProgress[u]);
    const waiting = live && !targetAllReduced(allProgress[u]);
    return levered.has(u) && spots[u] > 0 && !waiting ? 0 : live ? 1 : 2;
  };
  const universe = [...new Set([...allUnderlyings(), ...Object.keys(symbols)])];
  targetDraft = universe
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map(sym => {
      const live = targetIsLive(symbols[sym], allProgress[sym]);
      const tiers = live ? symbols[sym].tiers : [];
      return { sym, boxes: Array.from({ length: TARGET_TIERS },
                                      (_, i) => (tiers[i] ? String(tiers[i].price) : "")) };
    });
  $("target-levered").value = (stored.levered || []).join(", ");
  $("target-levered").placeholder = PROFIT_LEVERED.join(", ");
  $("target-add-symbol").value = "";
  renderTargetRows();
  $("target-status").textContent = stored.read_error
    ? "目标价文件读取失败，这里是空的；保存会覆盖它" : "";
  $("target-modal").hidden = false;
  document.body.classList.add("modal-open");
  $("target-modal-close").focus();
}

function closeTargetModal() {
  $("target-modal").hidden = true;
  document.body.classList.remove("modal-open");
  targetDraft = null;
}

// The line under a ticker: today's price, and anything standing in its way.
function targetRowNote(sym, spot, plan, p) {
  const px = spot > 0 ? fmtMoney(spot, 2) : "未持股，没有现价";
  const last = plan ? plan.tiers.map(t => fmtTarget(t.price)).join(" / ") : "";
  if (plan && p && p.state === "split") return `${px} · ${fmtMD(p.split_on)} 拆股，上次 ${last} 已作废`;
  if (plan && p && p.state === "expired") return `${px} · 清仓过，上次 ${last} 已作废`;
  if (plan && p && p.state === "stale") return `${px} · 设得太久，快照已不全，上次 ${last} 已作废`;
  if (plan && targetAllReduced(p)) return `${px} · 每档都减过仓，可以填新的`;
  if (plan && !(spot > 0)) return "未持股 · 持股后才判";
  return px;
}

// Rebuilt from the draft, never from the stored plans, so adding a row keeps
// every box as typed.
function renderTargetRows() {
  const stored = currentDataRef.profitTargets || {};
  const symbols = stored.symbols || {};
  const allProgress = currentDataRef.targetProgress || {};
  const spots = stockMarks(currentDataRef.allAccounts || {});   // held shares only, as above
  const levered = new Set(Array.isArray(stored.levered) ? stored.levered : PROFIT_LEVERED);
  $("target-body").innerHTML = (targetDraft || []).map(({ sym, boxes }) => {
    const live = targetIsLive(symbols[sym], allProgress[sym]);
    const unset = levered.has(sym) && spots[sym] > 0 && !live
      && !boxes.some(b => String(b).trim());
    return `<tr data-sym="${esc(sym)}">
      <td><b>${esc(sym)}</b>${unset ? ` <span class="amber target-unset">未设</span>` : ""}
        <div class="pos-sub">${esc(targetRowNote(sym, spots[sym], symbols[sym], allProgress[sym]))}</div></td>
      ${boxes.map((b, i) => `<td><div class="risk-input">
        <input type="number" data-tier="${i}" inputmode="decimal" step="any" min="0"
               placeholder="$" value="${esc(b)}" aria-label="${esc(sym)} 第 ${i + 1} 档" /></div></td>`).join("")}
    </tr>`;
  }).join("");
}

// Add a ticker nobody holds yet: the way to write the plan while placing the
// order, a day before the statement can show the position.
function addTargetRow() {
  const input = $("target-add-symbol");
  const sym = input.value.trim().toUpperCase();
  if (!sym) return;
  if (!TARGET_SYMBOL_RE.test(sym)) {
    $("target-status").textContent = `${sym} 不像代码`;
    return;
  }
  if (!targetDraft.some(r => r.sym === sym)) {
    targetDraft.unshift({ sym, boxes: Array(TARGET_TIERS).fill("") });
    renderTargetRows();
  }
  input.value = "";
  $("target-status").textContent = "";
  document.querySelector(`#target-body tr[data-sym="${CSS.escape(sym)}"] input`).focus();
}

function targetBody() {
  const symbols = {};
  for (const { sym, boxes } of targetDraft || []) {
    const tiers = boxes.filter(b => String(b).trim()).map(b => ({ price: Number(b) }));
    if (tiers.length) symbols[sym] = { tiers };
  }
  return { symbols, levered: riskListFromInput($("target-levered").value) };
}

async function saveProfitTargets() {
  for (const { sym, boxes } of targetDraft || []) {
    const bad = targetRowProblem(sym, boxes);
    if (bad) { $("target-status").textContent = bad; return; }
  }
  const btn = $("target-save");
  btn.disabled = true;
  $("target-status").textContent = "保存中…";
  try {
    const res = await fetch("/api/settings/targets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(targetBody()),
    });
    const j = await res.json();
    if (!res.ok) {
      // The dialog stays open with everything typed still in it.
      $("target-status").textContent = j.error || `HTTP ${res.status}`;
      return;
    }
    currentDataRef.profitTargets = j;
    currentDataRef.targetProgress = j.progress;
    closeTargetModal();
    showToast("success", "已保存", `${Object.keys(j.symbols || {}).length} 个标的设了目标价`);
    renderRiskGate();
  } catch (exc) {
    $("target-status").textContent = "";
    showToast("error", "保存失败", String(exc));
  } finally {
    btn.disabled = false;
  }
}

function wireTargetModal() {
  $("target-btn").addEventListener("click", openTargetModal);
  $("profit-nudge-btn").addEventListener("click", openTargetModal);
  $("target-modal-close").addEventListener("click", closeTargetModal);
  $("target-cancel").addEventListener("click", closeTargetModal);
  $("target-save").addEventListener("click", saveProfitTargets);
  $("target-add").addEventListener("click", addTargetRow);
  $("target-add-symbol").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTargetRow(); }
  });
  $("target-modal").addEventListener("click", (e) => {
    if (e.target === $("target-modal")) closeTargetModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("target-modal").hidden) closeTargetModal();
  });
  // Delegated: the rows are rebuilt on every open and on every added ticker.
  $("target-body").addEventListener("input", (e) => {
    const tier = e.target.dataset.tier;
    if (tier === undefined) return;
    const row = targetDraft.find(r => r.sym === e.target.closest("tr").dataset.sym);
    row.boxes[+tier] = e.target.value;
    const bad = targetRowProblem(row.sym, row.boxes);
    // The whole row: fixing the box on one side clears the complaint about the other.
    e.target.closest("tr").querySelectorAll("input").forEach(el => el.classList.toggle("bad", !!bad));
    const spot = stockMarks(currentDataRef.allAccounts || {})[row.sym];
    $("target-status").textContent = bad || targetRowWarning(row.sym, row.boxes, spot);
  });
}

/* --- Folding ------------------------------------------------------------ */

// Folded or open is a per-device preference — a phone may want the gate shut
// and the desk want it open — so it lives in this browser, unlike the lines,
// which must read the same everywhere and are kept on the server.
function wirePanelFold(prefix, storageKey) {
  const panel = $(`${prefix}-panel`), body = $(`${prefix}-body`);
  const summary = $(`${prefix}-summary`), toggle = $(`${prefix}-toggle`);
  const apply = (collapsed) => {
    panel.classList.toggle("risk-collapsed", collapsed);
    body.hidden = collapsed;
    summary.hidden = !collapsed;
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(storageKey) === "1";
  } catch (_) { /* storage blocked: start open */ }
  apply(collapsed);
  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    apply(collapsed);
    try {
      localStorage.setItem(storageKey, collapsed ? "1" : "0");
    } catch (_) { /* fine: it just won't be remembered */ }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireRiskModal();
  wireTargetModal();
  wirePanelFold("risk", "ibkr.riskGate.collapsed");
  wirePanelFold("profit", "ibkr.profitPanel.collapsed");
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
