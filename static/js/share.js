/* ---------------------------------------------------------------------------
 * Share snapshot — one phone-width PNG of the account view on screen, made to
 * be sent to family and friends.
 *
 * What the image may carry is decided by a whitelist, not by hiding things on
 * the dashboard: buildShareModel() copies percentages, tickers, dates, strikes
 * and an index curve out of the payload, and the card is drawn from that model
 * alone. A panel added to the dashboard later therefore stays out of the image
 * until someone adds it to the model on purpose — tests/test_share_model.mjs
 * pins the model's key set and checks that it is scale-free, so that step
 * can't happen by accident. Three rules decide what the model holds:
 *
 *  - **No dollar amount, no quantity.** Percentages plus any single absolute
 *    figure give the NAV back (a weight and that position's value, a return
 *    and its P&L), so "only a few amounts" is the same as all of them. Share
 *    and contract counts are amounts too: contracts × 100 × strike is a
 *    notional. Strikes and dates stay — they are market terms, not the size
 *    of the book.
 *  - **Outcomes, not mechanics.** Return and drawdown are shown in full; the
 *    leverage is already inside them. Margin, short-put notional, clusters and
 *    the expiry calendar are not — they are the size and shape of the risk —
 *    and the footer says the returns include options, so leaving them out is
 *    not a claim of plain stock holding.
 *  - **TWR index, never raw NAV.** See navStats' `curve`.
 *
 * The card is one SVG drawn by hand rather than a screenshot of HTML: it needs
 * no library to rasterise (no foreignObject, so no style inlining and no
 * canvas tainting), the preview in the dialog is the exact picture that gets
 * exported, and hover titles — several of which on the dashboard carry dollar
 * figures — have nowhere to ride along.
 * ------------------------------------------------------------------------- */

const SHARE_BENCHMARKS = ["QQQ", "SPY"];
const SHARE_TOP_N = 5;
// Card width in CSS px, i.e. a phone screen; chat apps scale it to fit.
const SHARE_W = 420;
// Exported at 3x: 1260 px wide, sharp on a phone's 3x screen.
const SHARE_SCALE = 3;
// Literal hex rather than var(--…): the exported SVG is decoded as an image,
// where the page's custom properties don't exist. Values mirror style.css.
const SHARE_C = {
  bg: "#0a0c12", panel: "#141826", border: "#232a42",
  text: "#e8ecf5", dim: "#8a93ad", faint: "#5a6480",
  accent: "#6bd7ff", accent2: "#a78bfa", cyan: "#22d3ee", amber: "#fbbf24",
  green: "#4ade80", red: "#f87171",
};
const SHARE_SERIES_COLOR = { account: SHARE_C.accent, QQQ: SHARE_C.amber, SPY: SHARE_C.accent2 };
const SHARE_FONT = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif";
// Panel content runs between these x positions (12 px card margin + 14 px pad).
const SHARE_L = 26, SHARE_R = SHARE_W - 26;

// A benchmark indexed onto the account curve's own dates (100 at the first),
// each close carried forward over days the exchange printed no bar. Drawdowns
// are taken on those same dates, so every column of the comparison table is
// sampled identically.
function alignBenchmark(curve, rows) {
  if (!curve.length || !rows || !rows.length) return null;
  const px = [];
  let j = -1;
  for (const p of curve) {
    while (j + 1 < rows.length && rows[j + 1][0] <= p.date) j++;
    // Nothing at or before the first NAV date: no honest anchor for the line.
    if (j < 0) return null;
    px.push(rows[j][1]);
  }
  let peak = 0, maxDD = 0;
  const points = curve.map((p, i) => {
    const v = (px[i] / px[0]) * 100;
    peak = Math.max(peak, v);
    maxDD = Math.max(maxDD, 1 - v / peak);
    return { date: p.date, v };
  });
  const last = points[points.length - 1].v;
  return { periodReturn: last / 100 - 1, maxDD, curDD: 1 - last / peak, curve: points };
}

// The whitelist. Everything the card shows comes out of this object, and
// nothing in it may move when every dollar figure in `data` is multiplied by
// the same constant — that property, not a list of field names, is what keeps
// the size of the account out of the picture.
function buildShareModel(data, benchSeries) {
  const series = fundedSeries(data.nav_history);
  const st = navStats(series, data.cash_flows || []);
  const curve = st ? st.curve.map(p => ({ date: p.date, v: p.index * 100 })) : [];
  const win = st ? { start: st.first.date, end: st.last.date } : null;
  const perf = st ? {
    periodReturn: st.periodReturn,
    maxDD: st.maxDD, ddStart: st.ddStart, ddEnd: st.ddEnd,
    curDD: st.curDD,
  } : null;
  const benchmarks = SHARE_BENCHMARKS
    .map(symbol => {
      const b = alignBenchmark(curve, (benchSeries || {})[symbol]);
      return b && { symbol, ...b };
    })
    .filter(Boolean);

  // Composition is measured against what the account HOLDS — stock, long
  // options and any positive cash — not against NAV. Over NAV a margin loan
  // shows as negative cash or a stock line above 100%, which is exactly the
  // mechanics this card leaves out. Cash equivalents count as cash, as they
  // do in the dashboard's allocation bar.
  const stocks = data.stocks || [];
  const stockRows = stocks.filter(s => !CASH_EQUIVALENTS.has(s.symbol) && s.value > 0);
  const cashEq = stocks.filter(s => CASH_EQUIVALENTS.has(s.symbol))
    .reduce((sum, s) => sum + (s.value || 0), 0);
  const stockMV = stockRows.reduce((sum, s) => sum + s.value, 0);
  const longOptMV = (data.options || []).filter(o => o.value > 0)
    .reduce((sum, o) => sum + o.value, 0);
  const cash = Math.max(((data.nav || {}).cash || 0) + cashEq, 0);
  const held = stockMV + longOptMV + cash;
  const ofHeld = (v) => (held > 0 ? v / held : 0);
  const allocation = { stock: ofHeld(stockMV), longOptions: ofHeld(longOptMV), cash: ofHeld(cash) };

  const holdings = stockRows.map(s => ({
    symbol: s.symbol,
    weight: ofHeld(s.value),
    // Since cost, as in the dashboard's holdings table — not over the window.
    ret: s.cost_basis ? s.unrealized_pl / s.cost_basis : 0,
  })).sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol));

  // One row per contract. With no count on the card, the merged view's
  // concatenated legs would print the same contract twice with nothing to
  // tell the rows apart — fold them, pooling P&L and premium for the return.
  const contracts = new Map();
  for (const o of data.options || []) {
    if (!o.quantity) continue;
    const side = o.quantity > 0 ? "long" : "short";
    const key = `${o.underlying}|${o.right}|${side}|${o.strike}|${o.expiry}`;
    const c = contracts.get(key) || {
      underlying: o.underlying, right: o.right, side, strike: o.strike,
      expiry: o.expiry, pl: 0, basis: 0,
    };
    c.pl += o.unrealized_pl || 0;
    c.basis += Math.abs(o.cost_basis || 0);
    contracts.set(key, c);
  }
  const asOfTs = win ? Date.parse(win.end) : null;
  const options = [...contracts.values()].map(c => {
    const ts = parseExpiryTs(c.expiry);
    return {
      underlying: c.underlying, right: c.right, side: c.side, strike: c.strike,
      expiry: ts == null ? "" : new Date(ts).toISOString().slice(0, 10),
      // Counted from the data's own date, not from today: the picture has to
      // stay true to the day it describes whenever someone opens it.
      dte: ts == null || asOfTs == null ? null : Math.round((ts - asOfTs) / DAY_MS),
      ret: c.basis ? c.pl / c.basis : 0,
    };
  }).sort((a, b) => a.underlying.localeCompare(b.underlying)
    || a.expiry.localeCompare(b.expiry) || a.strike - b.strike);

  // Contribution = strategy P&L per underlying (stock + options, realised +
  // floating, the dashboard's default ranking) over the window's average NAV:
  // "this name added 3% to the account".
  const avgNav = series.length ? series.reduce((sum, p) => sum + p.total, 0) / series.length : 0;
  const ranked = buildRankEntries((data.performance || {}).by_symbol || {}, "underlying")
    .filter(e => e.value && !CASH_EQUIVALENTS.has(e.key));
  const contrib = (e) => ({ symbol: e.key, contrib: avgNav > 0 ? e.value / avgNav : 0 });
  const contributors = {
    winners: ranked.filter(e => e.value > 0).sort((a, b) => b.value - a.value)
      .slice(0, SHARE_TOP_N).map(contrib),
    losers: ranked.filter(e => e.value < 0).sort((a, b) => a.value - b.value)
      .slice(0, SHARE_TOP_N).map(contrib),
  };

  return {
    asOf: win ? win.end : "",
    window: win, perf, curve, benchmarks, allocation, holdings, options, contributors,
  };
}

/* ---- drawing ------------------------------------------------------------ */

// "+12.3%" / "−4.5%" with a real minus sign; no sign on a value that rounds
// to zero, so a flat line doesn't read as a tiny loss.
function sharePct(v, digits = 1, signed = true) {
  const s = (Math.abs(v) * 100).toFixed(digits);
  if (!signed || Number(s) === 0) return `${s}%`;
  return `${v > 0 ? "+" : "−"}${s}%`;
}

// Coloured by the value as printed, so a "0.0%" is never green or red.
function shareTone(v, digits = 1) {
  const shown = Number((v * 100).toFixed(digits));
  return shown > 0 ? SHARE_C.green : shown < 0 ? SHARE_C.red : SHARE_C.dim;
}

// Rough advance width, for layout decisions only (legend spacing, whether a
// ticker fits its tile): CJK glyphs run about one em, Latin about 0.6 em.
function shareTextWidth(str, size) {
  let w = 0;
  for (const ch of String(str)) w += /[⺀-鿿＀-￯]/.test(ch) ? size : size * 0.6;
  return w;
}

function shareText(x, y, str, o = {}) {
  const attrs = [`x="${+x.toFixed(1)}"`, `y="${+y.toFixed(1)}"`,
    `font-size="${o.size || 12}"`, `fill="${o.fill || SHARE_C.text}"`];
  if (o.weight) attrs.push(`font-weight="${o.weight}"`);
  if (o.anchor) attrs.push(`text-anchor="${o.anchor}"`);
  if (o.opacity != null) attrs.push(`fill-opacity="${o.opacity}"`);
  return `<text ${attrs.join(" ")}>${esc(str)}</text>`;
}

// One rounded panel: a title row, then `body(y)` lays out from y and returns
// { parts, y } with y at its last baseline. The rect is emitted first so it
// paints underneath, which is why its height has to wait for the body.
function sharePanel(y0, title, note, body) {
  const head = [shareText(SHARE_L, y0 + 25, title, { size: 13.5, weight: 700 })];
  if (note) head.push(shareText(SHARE_R, y0 + 25, note, { size: 10.5, fill: SHARE_C.faint, anchor: "end" }));
  const b = body(y0 + 46);
  const y1 = b.y + 16;
  const rect = `<rect x="12" y="${y0}" width="${SHARE_W - 24}" height="${y1 - y0}" rx="12"`
    + ` fill="${SHARE_C.panel}" stroke="${SHARE_C.border}"/>`;
  return { parts: [rect, ...head, ...b.parts], y: y1 };
}

function shareReturnsBody(model) {
  return (y) => {
    const p = model.perf;
    const parts = [shareText(SHARE_L, y + 26, sharePct(p.periodReturn), {
      size: 36, weight: 700, fill: shareTone(p.periodReturn) })];
    const cols = [{ label: "本账户", color: SHARE_SERIES_COLOR.account, ...p },
      ...model.benchmarks.map(b => ({ label: b.symbol, color: SHARE_SERIES_COLOR[b.symbol], ...b }))];
    const colW = 78;
    const right = (i) => SHARE_R - (cols.length - 1 - i) * colW;
    let ty = y + 62;
    cols.forEach((c, i) => parts.push(shareText(right(i), ty, c.label,
      { size: 11, weight: 600, fill: c.color, anchor: "end" })));
    const rows = [
      ["区间收益", c => sharePct(c.periodReturn), c => shareTone(c.periodReturn)],
      ["最大回撤", c => sharePct(-c.maxDD), c => (c.maxDD > 0 ? SHARE_C.red : SHARE_C.dim)],
      ["当前回撤", c => (c.curDD > 0.0005 ? sharePct(-c.curDD) : "在高点"),
        c => (c.curDD > 0.0005 ? SHARE_C.red : SHARE_C.dim)],
    ];
    for (const [label, fmt, tone] of rows) {
      parts.push(`<line x1="${SHARE_L}" x2="${SHARE_R}" y1="${ty + 8}" y2="${ty + 8}" stroke="${SHARE_C.border}"/>`);
      ty += 25;
      parts.push(shareText(SHARE_L, ty, label, { size: 12, fill: SHARE_C.dim }));
      cols.forEach((c, i) => parts.push(shareText(right(i), ty, fmt(c),
        { size: 13, weight: 600, fill: tone(c), anchor: "end" })));
    }
    ty += 24;
    parts.push(shareText(SHARE_L, ty, `本账户最大回撤区间 ${p.ddStart} → ${p.ddEnd}`,
      { size: 10.5, fill: SHARE_C.faint }));
    return { parts, y: ty };
  };
}

function shareChartBody(model) {
  return (y) => {
    const parts = [];
    const lines = [{ key: "account", label: "本账户", curve: model.curve },
      ...model.benchmarks.map(b => ({ key: b.symbol, label: b.symbol, curve: b.curve }))];
    let lx = SHARE_L;
    for (const s of lines) {
      parts.push(`<line x1="${lx}" x2="${lx + 16}" y1="${y - 4}" y2="${y - 4}" stroke="${SHARE_SERIES_COLOR[s.key]}"`
        + ` stroke-width="${s.key === "account" ? 2.6 : 1.8}" stroke-linecap="round"/>`);
      parts.push(shareText(lx + 21, y, s.label, { size: 11, fill: SHARE_C.dim }));
      lx += 21 + shareTextWidth(s.label, 11) + 18;
    }
    const top = y + 16, H = 156, left = SHARE_L + 28, right = SHARE_R;
    const all = lines.flatMap(s => s.curve.map(p => p.v));
    let lo = Math.min(100, ...all), hi = Math.max(100, ...all);
    const padY = (hi - lo) * 0.06 || 1;
    lo -= padY; hi += padY;
    const n = model.curve.length;
    const X = (i) => left + (right - left) * (n > 1 ? i / (n - 1) : 0);
    const Y = (v) => top + H - (H * (v - lo)) / (hi - lo);
    const step = [2, 5, 10, 20, 25, 50, 100, 200, 500].find(s => (hi - lo) / s <= 5) || 1000;
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
      const at100 = Math.abs(t - 100) < 1e-9;
      parts.push(`<line x1="${left}" x2="${right}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"`
        + ` stroke="${at100 ? SHARE_C.dim : SHARE_C.border}"${at100 ? ' stroke-dasharray="4 4"' : ""}/>`);
      parts.push(shareText(left - 6, Y(t) + 3.5, String(t), { size: 10, fill: SHARE_C.faint, anchor: "end" }));
    }
    // Benchmarks first, so the account's own line sits on top.
    for (const s of [...lines.slice(1), lines[0]]) {
      const pts = s.curve.map((p, i) => `${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
      parts.push(`<polyline points="${pts}" fill="none" stroke="${SHARE_SERIES_COLOR[s.key]}"`
        + ` stroke-width="${s.key === "account" ? 2.2 : 1.4}" stroke-linejoin="round"/>`);
    }
    const by = top + H + 16;
    parts.push(shareText(left, by, model.curve[0].date, { size: 10, fill: SHARE_C.faint }));
    parts.push(shareText(right, by, model.curve[n - 1].date, { size: 10, fill: SHARE_C.faint, anchor: "end" }));
    return { parts, y: by };
  };
}

function shareAllocationBody(a) {
  return (y) => {
    const segs = [["股票", a.stock, SHARE_C.cyan], ["期权多头", a.longOptions, SHARE_C.amber],
      ["现金", a.cash, SHARE_C.accent2]];
    const w = SHARE_R - SHARE_L;
    const parts = [`<clipPath id="share-alloc-clip"><rect x="${SHARE_L}" y="${y - 4}" width="${w}" height="12" rx="6"/></clipPath>`,
      `<rect x="${SHARE_L}" y="${y - 4}" width="${w}" height="12" rx="6" fill="${SHARE_C.border}"/>`,
      `<g clip-path="url(#share-alloc-clip)">`];
    let x = SHARE_L;
    for (const [, v, color] of segs) {
      if (v <= 0) continue;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y - 4}" width="${(w * v).toFixed(1)}" height="12" fill="${color}"/>`);
      x += w * v;
    }
    parts.push("</g>");
    const ly = y + 28;
    let lx = SHARE_L;
    for (const [label, v, color] of segs) {
      const t = `${label} ${sharePct(v, 1, false)}`;
      parts.push(`<circle cx="${lx + 4}" cy="${ly - 4}" r="4" fill="${color}"/>`);
      parts.push(shareText(lx + 13, ly, t, { size: 11.5, fill: SHARE_C.dim }));
      lx += 13 + shareTextWidth(t, 11.5) + 20;
    }
    return { parts, y: ly };
  };
}

// Tile fill by return since cost: a slate base pulled toward green or red,
// saturating at ±40%, dark enough that white labels stay legible at both ends.
function shareTileColor(ret) {
  const t = Math.max(-1, Math.min(1, ret / 0.4));
  return t >= 0
    ? d3.interpolateRgb("#1e293b", "#15803d")(0.25 + 0.75 * t)
    : d3.interpolateRgb("#1e293b", "#b91c1c")(0.25 + 0.75 * -t);
}

function shareHoldingsBody(holdings) {
  return (y) => {
    const parts = [];
    const w = SHARE_R - SHARE_L, h = 224, top = y - 10;
    const root = d3.hierarchy({ children: holdings.map(d => ({ ...d, size: Math.max(d.weight, 1e-6) })) })
      .sum(d => d.size).sort((a, b) => b.value - a.value);
    d3.treemap().size([w, h]).padding(2).round(true)(root);
    for (const leaf of root.leaves()) {
      const d = leaf.data;
      const x = SHARE_L + leaf.x0, ty = top + leaf.y0, tw = leaf.x1 - leaf.x0, th = leaf.y1 - leaf.y0;
      parts.push(`<rect x="${x}" y="${ty}" width="${tw}" height="${th}" rx="3" fill="${shareTileColor(d.ret)}"/>`);
      let fs = Math.max(8, Math.min(15, tw / 4.2, th / 2.6));
      // Bold Latin runs ~8% wider than the regular estimate.
      while (fs > 8 && shareTextWidth(d.symbol, fs) * 1.08 > tw - 10) fs -= 0.5;
      if (fs < 8.5 || th < fs + 8 || shareTextWidth(d.symbol, fs) * 1.08 > tw - 8) continue;
      parts.push(shareText(x + 5, ty + 4 + fs, d.symbol, { size: fs, weight: 700, fill: "#ffffff" }));
      const sub = Math.max(8.5, fs * 0.74);
      if (th >= fs + 2 * (sub + 3) + 8 && tw >= 50) {
        parts.push(shareText(x + 5, ty + 4 + fs + sub + 4, sharePct(d.weight, 1, false),
          { size: sub, fill: "#ffffff", opacity: 0.85 }));
        parts.push(shareText(x + 5, ty + 4 + fs + 2 * (sub + 4), sharePct(d.ret),
          { size: sub, fill: "#ffffff", opacity: 0.85 }));
      }
    }
    // Every holding as text too: small tiles have no room for a label.
    let ly = top + h + 26;
    const half = Math.ceil(holdings.length / 2);
    for (const x0 of [SHARE_L, SHARE_L + 192]) {
      parts.push(shareText(x0, ly, "标的", { size: 10, fill: SHARE_C.faint }));
      parts.push(shareText(x0 + 118, ly, "占比", { size: 10, fill: SHARE_C.faint, anchor: "end" }));
      parts.push(shareText(x0 + 176, ly, "持仓回报", { size: 10, fill: SHARE_C.faint, anchor: "end" }));
    }
    // Column-major, so the weight order reads straight down the left column.
    holdings.forEach((d, i) => {
      const x0 = i < half ? SHARE_L : SHARE_L + 192;
      const ry = ly + 20 * ((i % half) + 1);
      parts.push(shareText(x0, ry, d.symbol, { size: 12, weight: 600 }));
      parts.push(shareText(x0 + 118, ry, sharePct(d.weight, 1, false), { size: 12, fill: SHARE_C.dim, anchor: "end" }));
      parts.push(shareText(x0 + 176, ry, sharePct(d.ret), { size: 12, fill: shareTone(d.ret), anchor: "end" }));
    });
    return { parts, y: ly + 20 * half };
  };
}

function shareOptionsBody(options) {
  return (y) => {
    const parts = [];
    const tagOf = (o) => (o.right === "C" ? "CALL" : "PUT");
    // Columns are laid out for a four-letter ticker; a longer one pushes
    // everything but the return column right, into slack the 3-digit DTE of
    // a LEAP still leaves free.
    const symW = Math.max(...options.map(o =>
      shareTextWidth(o.underlying, 12) * 1.08 + 5 + shareTextWidth(tagOf(o), 8.5) + 8));
    const dx = Math.min(12, Math.max(0, symW + 8 - 74));
    const col = { act: SHARE_L + 74 + dx, view: SHARE_L + 126 + dx, strike: SHARE_L + 188 + dx,
      exp: SHARE_L + 196 + dx, dte: SHARE_L + 304 + dx, ret: SHARE_R };
    const head = (x, t, anchor) => parts.push(shareText(x, y, t, { size: 10, fill: SHARE_C.faint, anchor }));
    head(SHARE_L, "合约");
    head(col.act, "动作");
    head(col.view, "观点");
    head(col.strike, "行权价", "end");
    head(col.exp, "到期");
    head(col.dte, "剩余", "end");
    head(col.ret, "回报", "end");
    let ry = y;
    for (const o of options) {
      ry += 22;
      const isCall = o.right === "C", isLong = o.side === "long";
      parts.push(shareText(SHARE_L, ry, o.underlying, { size: 12, weight: 700 }));
      const tagX = SHARE_L + shareTextWidth(o.underlying, 12) * 1.08 + 5;
      const tag = tagOf(o);
      const tagW = shareTextWidth(tag, 8.5) + 8;
      const tagColor = isCall ? SHARE_C.green : SHARE_C.red;
      parts.push(`<rect x="${tagX.toFixed(1)}" y="${ry - 10}" width="${tagW.toFixed(1)}" height="13" rx="3"`
        + ` fill="${tagColor}" fill-opacity="0.16"/>`);
      parts.push(shareText(tagX + 4, ry, tag, { size: 8.5, weight: 700, fill: tagColor }));
      parts.push(shareText(col.act, ry, (isLong ? "买入" : "卖出") + (isCall ? "看涨" : "看跌"),
        { size: 11.5, fill: isLong ? SHARE_C.accent : SHARE_C.amber }));
      // Long call and short put both profit from a rise.
      const bull = isLong === isCall;
      parts.push(shareText(col.view, ry, bull ? "看多" : "看空", { size: 11.5, fill: bull ? SHARE_C.green : SHARE_C.red }));
      parts.push(shareText(col.strike, ry, o.strike ? `$${+o.strike.toFixed(2)}` : "—", { size: 12, anchor: "end" }));
      parts.push(shareText(col.exp, ry, o.expiry || "—", { size: 11, fill: SHARE_C.dim }));
      parts.push(shareText(col.dte, ry, o.dte == null ? "—" : `${o.dte}天`, { size: 11.5, fill: SHARE_C.dim, anchor: "end" }));
      parts.push(shareText(col.ret, ry, sharePct(o.ret), { size: 12, weight: 600, fill: shareTone(o.ret), anchor: "end" }));
    }
    return { parts, y: ry };
  };
}

function shareContribBody(c) {
  return (y) => {
    const parts = [];
    const maxAbs = Math.max(...[...c.winners, ...c.losers].map(e => Math.abs(e.contrib)), 1e-9);
    const sides = [[c.winners, "拉动最多", SHARE_C.green, SHARE_L], [c.losers, "拖累最多", SHARE_C.red, SHARE_L + 192]];
    let bottom = y;
    for (const [rows, label, color, x0] of sides) {
      parts.push(shareText(x0, y, label, { size: 11.5, weight: 600, fill: color }));
      let ry = y;
      if (!rows.length) parts.push(shareText(x0, (ry += 22), "无", { size: 12, fill: SHARE_C.faint }));
      for (const e of rows) {
        ry += 22;
        parts.push(shareText(x0, ry, e.symbol, { size: 12, weight: 600 }));
        const bw = Math.max(2, (70 * Math.abs(e.contrib)) / maxAbs);
        parts.push(`<rect x="${x0 + 52}" y="${ry - 8}" width="${bw.toFixed(1)}" height="7" rx="2" fill="${color}" fill-opacity="0.45"/>`);
        parts.push(shareText(x0 + 176, ry, sharePct(e.contrib), { size: 12, fill: color, anchor: "end" }));
      }
      bottom = Math.max(bottom, ry);
    }
    return { parts, y: bottom };
  };
}

// The whole card as SVG markup at 1x, plus its height. shareSvgDocument()
// wraps it at whatever pixel scale the caller needs.
function renderShareSvg(model, title) {
  const parts = [shareText(20, 40, title, { size: 21, weight: 700 })];
  if (model.window) {
    const days = Math.round((Date.parse(model.window.end) - Date.parse(model.window.start)) / DAY_MS);
    parts.push(shareText(20, 62, [fmtSpan(days), `${model.window.start} → ${model.window.end}`]
      .filter(Boolean).join(" · "), { size: 11.5, fill: SHARE_C.dim }));
  }
  let y = 80;
  const add = (section) => { parts.push(...section.parts); y = section.y + 12; };
  if (model.perf) add(sharePanel(y, "收益（时间加权）", "已剔除出入金", shareReturnsBody(model)));
  if (model.curve.length > 1) add(sharePanel(y, "净值走势", "起点 = 100", shareChartBody(model)));
  add(sharePanel(y, "持仓构成", "占持仓总额", shareAllocationBody(model.allocation)));
  if (model.holdings.length) {
    add(sharePanel(y, "正股持仓", "面积 = 占比 · 颜色 = 持仓回报", shareHoldingsBody(model.holdings)));
  }
  if (model.options.length) add(sharePanel(y, "期权持仓", "回报 = 浮动盈亏 ÷ 权利金", shareOptionsBody(model.options)));
  const c = model.contributors;
  if (c.winners.length || c.losers.length) {
    add(sharePanel(y, "盈亏贡献（按标的）", "盈亏 ÷ 期间平均净值", shareContribBody(c)));
  }
  const foot = [
    model.asOf ? `数据截至 ${model.asOf} · 收益按时间加权计算，已剔除出入金` : "",
    model.benchmarks.length
      ? `基准 ${model.benchmarks.map(b => b.symbol).join(" / ")} 为同期含分红总回报` : "",
    "含期权：收益和回撤不等于单纯持有上述股票",
    "个人记录，不构成投资建议",
  ].filter(Boolean);
  // Dim rather than faint: these lines are the honest half of what the card
  // leaves out, so they have to survive a phone screen.
  y += 4;
  for (const line of foot) {
    y += 18;
    parts.push(shareText(20, y, line, { size: 11, fill: SHARE_C.dim }));
  }
  return { body: parts.join(""), w: SHARE_W, h: Math.ceil(y + 24) };
}

function shareSvgDocument(card, scale = 1) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${card.w * scale}" height="${card.h * scale}"`
    + ` viewBox="0 0 ${card.w} ${card.h}" font-family="${SHARE_FONT}" style="font-variant-numeric: tabular-nums">`
    + `<rect width="${card.w}" height="${card.h}" fill="${SHARE_C.bg}"/>${card.body}</svg>`;
}

/* ---- dialog & export ---------------------------------------------------- */

// `loading` holds the export buttons while the benchmark fetch is out: the
// preview draws at once without QQQ/SPY, and that version must not be the one
// that gets sent just because it was the first ready.
const shareState = { gen: 0, renderGen: 0, loading: false, bench: null, note: "",
  blob: null, name: "", timer: null };

// The title is the one thing on the card the viewer types; remembered per
// view so "个人" / "SMSF" only have to be named once. Browser storage is a
// convenience here — when it's unavailable the default title is used.
const shareTitleKey = () => `ibkr-share-title:${currentDataRef.selected || ""}`;
const defaultShareTitle = () => (currentDataRef.selected === "ALL" ? "投资组合 · 全部账户" : "投资组合");

function storedShareTitle() {
  try { return localStorage.getItem(shareTitleKey()) || ""; } catch { return ""; }
}

function storeShareTitle(v) {
  try { localStorage.setItem(shareTitleKey(), v); } catch { /* private mode etc. */ }
}

function rasterizeShareSvg(svg) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("canvas 导出为空"))), "image/png");
    };
    img.onerror = () => reject(new Error("SVG 无法解码"));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

function setShareReady(ready) {
  for (const id of ["share-copy", "share-native", "share-save"]) $(id).disabled = !ready;
}

// Rebuild the card from the current view. The preview and the export are the
// same SVG at two scales, so what the dialog shows is what gets sent.
function renderSharePreview() {
  const model = buildShareModel(currentDataRef.data, shareState.bench);
  const card = renderShareSvg(model, $("share-title").value.trim() || defaultShareTitle());
  $("share-preview").innerHTML = shareSvgDocument(card, 1);
  shareState.blob = null;
  setShareReady(false);
  const gen = ++shareState.renderGen;
  rasterizeShareSvg(shareSvgDocument(card, SHARE_SCALE))
    .then(blob => {
      if (gen !== shareState.renderGen) return;
      shareState.blob = blob;
      shareState.name = `portfolio-${model.asOf || "snapshot"}.png`;
      setShareReady(!shareState.loading);
      if (!shareState.note) {
        $("share-status").textContent =
          `${card.w * SHARE_SCALE} × ${card.h * SHARE_SCALE} px · ${Math.round(blob.size / 1024)} KB`;
      }
    })
    .catch(exc => {
      if (gen === shareState.renderGen) $("share-status").textContent = `图片生成失败：${exc.message || exc}`;
    });
  return model;
}

async function openShareModal() {
  if (!currentDataRef.data) return;
  const gen = ++shareState.gen;
  shareState.bench = null;
  const sel = currentDataRef.selected;
  $("share-scope").textContent = sel === "ALL" ? "总账户（合并视图）" : `账号 ${maskAccountId(sel)}`;
  $("share-title").value = storedShareTitle() || defaultShareTitle();
  $("share-modal").hidden = false;
  document.body.classList.add("modal-open");
  $("share-modal-close").focus();
  shareState.loading = true;
  shareState.note = "正在获取 QQQ / SPY 同期走势…";
  $("share-status").textContent = shareState.note;
  const model = renderSharePreview();
  if (!model.window) {
    shareState.loading = false;
    shareState.note = "没有净值历史：图中不含收益和基准对比";
    $("share-status").textContent = shareState.note;
    renderSharePreview();
    return;
  }
  let note = "";
  try {
    const q = new URLSearchParams({ start: model.window.start, end: model.window.end });
    const res = await fetch(`/api/benchmarks?${q}`);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    if (gen !== shareState.gen) return;
    shareState.bench = j.series || {};
    const missing = SHARE_BENCHMARKS.filter(s => !(shareState.bench[s] || []).length);
    if (missing.length) note = `${missing.join(" / ")} 数据暂缺，图中不含该基准`;
  } catch (exc) {
    if (gen !== shareState.gen) return;
    note = `基准数据获取失败（${exc.message || exc}），图中不含基准对比`;
  }
  shareState.loading = false;
  shareState.note = note;
  $("share-status").textContent = note || "生成图片中…";
  renderSharePreview();
}

function closeShareModal() {
  $("share-modal").hidden = true;
  document.body.classList.remove("modal-open");
  shareState.gen++;          // drops an in-flight benchmark fetch
  shareState.renderGen++;    // ...and an in-flight rasterisation
  shareState.loading = false;
  clearTimeout(shareState.timer);
  shareState.blob = null;
  $("share-preview").innerHTML = "";
}

function saveShareImage() {
  const url = URL.createObjectURL(shareState.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = shareState.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function copyShareImage() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": shareState.blob })]);
    showToast("ok", "图片已复制", "可直接粘贴到微信等聊天窗口", 3000);
  } catch (exc) {
    showToast("error", "复制失败", String(exc.message || exc), 6000);
  }
}

// The blob is prepared before the click, so share() runs inside the user's
// gesture — Safari refuses a share that only starts after an await.
async function nativeShareImage() {
  const file = new File([shareState.blob], shareState.name, { type: "image/png" });
  try {
    await navigator.share({ files: [file] });
  } catch (exc) {
    if (exc.name !== "AbortError") showToast("error", "分享失败", String(exc.message || exc), 6000);
  }
}

function wireShareModal() {
  $("share-btn").addEventListener("click", openShareModal);
  $("share-modal-close").addEventListener("click", closeShareModal);
  $("share-save").addEventListener("click", saveShareImage);
  $("share-copy").addEventListener("click", copyShareImage);
  $("share-native").addEventListener("click", nativeShareImage);
  // Offered only where the browser can actually do it: clipboard images need
  // ClipboardItem (and a secure context), file sharing needs canShare(files).
  $("share-copy").hidden = !(typeof ClipboardItem === "function" && navigator.clipboard?.write);
  let canShareFiles = false;
  try {
    canShareFiles = !!navigator.canShare?.({ files: [new File([""], "x.png", { type: "image/png" })] });
  } catch { /* old engines throw on the files key */ }
  $("share-native").hidden = !canShareFiles;
  $("share-title").addEventListener("input", () => {
    clearTimeout(shareState.timer);
    shareState.timer = setTimeout(() => {
      storeShareTitle($("share-title").value.trim());
      renderSharePreview();
    }, 300);
  });
  // Backdrop click closes; a click inside the dialog must not reach it.
  $("share-modal").addEventListener("click", (e) => {
    if (e.target === $("share-modal")) closeShareModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("share-modal").hidden) closeShareModal();
  });
}
