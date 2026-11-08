// Delta 敞口回归 —— node --test tests/test_delta.mjs
//
// 抽取方式与 test_risk_gate.mjs 一致：delta.js / dashboard.js 没有模块导出，
// 按源码正则把被测函数原样抽出来执行，改名/改签名时抽取直接报错。
//
// 这块面板最要紧、也最容易悄悄改坏的几条：
//   1. 符号：卖 put 折出来的股数是正的（跌的时候跟正股一起亏），卖 call / 买 put 是负的；
//   2. 隐含波动率从合约自己的收盘价反推，正股价必须是同一天的 —— 换一天的价格 delta 就错了；
//   3. 合约乘数取合约自己的，不硬编码 100；
//   4. 「投入资本」跟核心持仓表的敞口是同一个数，两个口径并排时不能各说各的；
//   5. 总账户 = 各账户分别算再相加。
// 账号全部是假的（U1111111 / U2222222）—— 仓库是公开的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(path.join(here, "..", ...p), "utf8");
const dash = read("static", "js", "dashboard.js");
const delta = read("static", "js", "delta.js");
const html = read("templates", "dashboard.html");

function extract(src, file, name) {
  const m = src.match(
    new RegExp(`^function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"));
  if (!m) throw new Error(`cannot extract function ${name} from ${file}`);
  return m[0];
}
function extractConst(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`cannot extract ${what}`);
  return m[0];
}

const consts = [
  extractConst(dash, /const CASH_EQUIVALENTS = [^;]+;/, "CASH_EQUIVALENTS"),
  extractConst(dash, /const CONTRACT_MULTIPLIER = [^;]+;/, "CONTRACT_MULTIPLIER"),
  extractConst(dash, /const _EXPIRY_MON = \{[\s\S]*?\};/, "_EXPIRY_MON"),
  extractConst(dash, /const MONTH_NUM = \{[\s\S]*?\};/, "MONTH_NUM"),
  extractConst(dash, /const parsePeriodBounds = \(period\) => \{[\s\S]*?\n\};/, "parsePeriodBounds"),
  extractConst(delta, /const DELTA_RATE = [^;]+;/, "DELTA_RATE"),
  extractConst(delta, /const DELTA_VOL_MIN = [^;]+;/, "DELTA_VOL_MIN"),
  extractConst(delta, /const DELTA_YEAR_MS = [^;]+;/, "DELTA_YEAR_MS"),
  extractConst(delta, /const DELTA_SHOCK = [^;]+;/, "DELTA_SHOCK"),
].join("\n");

const DASH_FNS = ["parseExpiryTs", "computeExposures"];
const DELTA_FNS = ["deltaNormCdf", "bsValue", "bsDelta", "impliedVol", "optionDelta", "deltaAsOf",
                   "deltaDayTs", "deltaNeeds", "deltaPricer", "blankDeltaRow", "finishDeltaBook",
                   "deltaBook", "mergeDeltaBooks"];
const D = new Function(
  `${consts}\n`
  + DASH_FNS.map(n => extract(dash, "dashboard.js", n)).join("\n") + "\n"
  + DELTA_FNS.map(n => extract(delta, "delta.js", n)).join("\n")
  + `\nreturn { ${[...DASH_FNS, ...DELTA_FNS, "DELTA_RATE", "DELTA_SHOCK"].join(", ")} };`)();

const near = (a, b, eps, what = "") =>
  assert.ok(Math.abs(a - b) <= eps, `${what} expected ${b} ± ${eps}, got ${a}`);

// --- fixtures -------------------------------------------------------------

const ASOF = "2026-11-05";
const ASOF_TS = Date.UTC(2026, 10, 5);
const opt = (u, expiry, strike, right, qty, mark, extra = {}) => ({
  symbol: `${u} ${expiry} ${strike} ${right}`, underlying: u, expiry, strike, right,
  multiplier: 100, quantity: qty, close_price: mark,
  value: mark * qty * (extra.multiplier || 100), ...extra,
});
const stock = (symbol, quantity, px) => ({ symbol, quantity, close_price: px, value: quantity * px });
const navTo = (day, total) => ({ nav: { total }, nav_history: [{ date: day, total }] });

// --- math -----------------------------------------------------------------

test("正态分布函数：中心、对称、两侧尾部都准", () => {
  // erfc 的拟合精度是相对误差 < 1.2e-7，delta 只显示两位小数，够用
  near(D.deltaNormCdf(0), 0.5, 1e-7);
  near(D.deltaNormCdf(1.96), 0.9750021048517795, 2e-7);
  for (const x of [0.3, 1.1, 2.5, 4]) near(D.deltaNormCdf(x) + D.deltaNormCdf(-x), 1, 1e-12);
  // 深度价外的合约在尾部求解：相对误差也得小，不能只看绝对误差
  const tail = D.deltaNormCdf(-6);
  near(tail / 9.865876450377e-10, 1, 1e-6, "N(-6) relative");
});

test("Black-Scholes 对得上教科书例子，满足平价关系", () => {
  // Hull：S=42, K=40, r=10%, σ=20%, T=0.5 → call 4.76, put 0.81
  near(D.bsValue("C", 42, 40, 0.5, 0.1, 0.2), 4.76, 0.005, "call");
  near(D.bsValue("P", 42, 40, 0.5, 0.1, 0.2), 0.81, 0.005, "put");
  for (const [S, K, T, v] of [[42, 40, 0.5, 0.2], [40.87, 58, 0.12, 1.5], [180, 220, 1.2, 0.45]]) {
    const parity = D.bsValue("C", S, K, T, 0.04, v) - D.bsValue("P", S, K, T, 0.04, v);
    near(parity, S - K * Math.exp(-0.04 * T), 1e-6, "C - P");
    near(D.bsDelta("C", S, K, T, 0.04, v) - D.bsDelta("P", S, K, T, 0.04, v), 1, 1e-9, "Δc - Δp");
  }
  // 没有时间或没有波动率：退化成内在价值，delta 非 0 即 ±1
  assert.equal(D.bsValue("P", 30, 40, 0, 0.04, 0.5), 10);
  assert.equal(D.bsDelta("P", 30, 40, 0, 0.04, 0.5), -1);
  assert.equal(D.bsDelta("C", 30, 40, 0, 0.04, 0.5), 0);
});

test("隐含波动率：从价格反推回原来的波动率；地板以下给 0，天花板以上给 null", () => {
  for (const right of ["C", "P"]) {
    for (const [S, K, T, v] of [[100, 100, 0.25, 0.3], [40.87, 58, 0.12, 1.54], [100, 70, 1.5, 0.6], [500, 355, 0.04, 0.8]]) {
      const px = D.bsValue(right, S, K, T, 0.04, v);
      near(D.impliedVol(right, px, S, K, T, 0.04), v, 1e-5, `${right} K=${K}`);
    }
  }
  // 美式深度价内 put 按内在价值成交：欧式模型读不出时间价值 → 0，delta 落在 -1
  assert.equal(D.impliedVol("P", 17.44 - 0.2, 7.56, 25, 0.12, 0.04), 0);
  // 比正股还贵的 call / 比贴现行权价还贵的 put：没有波动率给得出这个价
  assert.equal(D.impliedVol("C", 50, 45, 30, 0.2, 0.04), null);
  assert.equal(D.impliedVol("P", 60, 10, 60, 0.2, 0.04), null);
  assert.equal(D.impliedVol("P", 5, 40, 50, 0, 0.04), 0);   // 到期日当天
});

test("真实收盘价锚点：SOXL 58P 在 11/5 读 154% / −0.65，换成 11/6 的正股价就错成 203% / −0.49", () => {
  const o = opt("SOXL", "18DEC26", 58, "P", -1, 20.7372);
  const same = D.optionDelta(o, 40.87, ASOF_TS);
  near(same.iv, 1.538, 0.002, "iv same-day");
  near(same.delta, -0.652, 0.002, "delta same-day");
  const stale = D.optionDelta(o, 45.97, ASOF_TS);
  near(stale.iv, 2.033, 0.002, "iv next-day spot");
  near(stale.delta, -0.491, 0.002, "delta next-day spot");
});

// --- one contract -----------------------------------------------------------

test("符号：卖 put、买 call 折成正股数；卖 call、买 put 是负的", () => {
  const S = 100;
  const shortPut = D.optionDelta(opt("X", "18DEC26", 110, "P", -3, 13), S, ASOF_TS);
  const longCall = D.optionDelta(opt("X", "18DEC26", 110, "C", 2, 4), S, ASOF_TS);
  const shortCall = D.optionDelta(opt("X", "18DEC26", 110, "C", -2, 4), S, ASOF_TS);
  const longPut = D.optionDelta(opt("X", "18DEC26", 110, "P", 1, 13), S, ASOF_TS);
  assert.ok(shortPut.delta < 0 && shortPut.shares > 0, "short put");
  assert.ok(longCall.shares > 0, "long call");
  assert.ok(shortCall.shares < 0, "short call");
  assert.ok(longPut.shares < 0, "long put");
  near(shortPut.shares, shortPut.delta * -3 * 100, 1e-9);
  near(shortCall.shares, -longCall.shares, 1e-9);
});

test("合约乘数取合约自己的，不硬编码 100", () => {
  const std = D.optionDelta(opt("X", "18DEC26", 50, "P", -1, 6), 48, ASOF_TS);
  const adj = D.optionDelta(opt("X", "18DEC26", 50, "P", -1, 6, { multiplier: 10 }), 48, ASOF_TS);
  near(adj.shares * 10, std.shares, 1e-9);
  // 没有 close_price 的旧数据：从市值反推每股价格，同样按合约自己的乘数
  const noMark = D.optionDelta({ ...opt("X", "18DEC26", 50, "P", -2, 6, { multiplier: 10 }), close_price: 0 }, 48, ASOF_TS);
  near(noMark.mark, 6, 1e-9);
});

test("到期日当天按内在价值：价内卖 put 一张顶 100 股，价外是 0", () => {
  const itm = D.optionDelta(opt("X", "5NOV26", 50, "P", -2, 10), 40, ASOF_TS);
  assert.equal(itm.T, 0);
  assert.equal(itm.shares, 200);
  const otm = D.optionDelta(opt("X", "5NOV26", 30, "P", -2, 0), 40, ASOF_TS);
  near(otm.shares, 0, 1e-12);
});

test("读不出的合约、没有正股价的合约分开标，不硬算", () => {
  assert.equal(D.optionDelta(opt("X", "18DEC26", 0, "P", -1, 3), 40, ASOF_TS).status, "unparsed");
  assert.equal(D.optionDelta(opt("X", "18DEC26", 50, "", -1, 3), 40, ASOF_TS).status, "unparsed");
  assert.equal(D.optionDelta(opt("X", "DEC26", 50, "P", -1, 3), 40, ASOF_TS).status, "unparsed");
  assert.equal(D.optionDelta(opt("X", "18DEC26", 50, "P", -1, 3), null, ASOF_TS).status, "unpriced");
  const bad = D.optionDelta(opt("X", "18DEC26", 50, "C", 1, 45), 40, ASOF_TS);   // 比正股还贵
  assert.equal(bad.status, "nosolve");
  assert.equal(bad.delta, 0);       // 价外：按内在价值是 0
});

test("全线跌 10%：卖 put 按原波动率重算，比按 delta 线性估亏得多（负 gamma）", () => {
  const g = D.optionDelta(opt("X", "18DEC26", 100, "P", -1, 6), 100, ASOF_TS);
  const linear = g.shares * 100 * D.DELTA_SHOCK;
  assert.ok(g.shockPnl < 0);
  assert.ok(g.shockPnl < linear, `repriced ${g.shockPnl} should be worse than linear ${linear}`);
});

// --- dates and prices ---------------------------------------------------------

test("报表日期跟服务端 _as_of_date 同一套规则", () => {
  assert.equal(D.deltaAsOf(navTo(ASOF, 1)), ASOF);
  assert.equal(D.deltaAsOf({ statement: { Period: "2025-11-06 → 2026-11-05" } }), ASOF);
  assert.equal(D.deltaAsOf({ statement: { Period: "January 1, 2026 - June 30, 2026" } }), "2026-06-30");
  assert.equal(D.deltaAsOf({ statement: { Period: "截至 2026-08-19" } }), "2026-08-19");
  assert.equal(D.deltaAsOf({ statement: { Period: "gibberish" } }), "");
  assert.equal(D.deltaDayTs(ASOF), ASOF_TS);
});

test("要取价的名单：同一天有账户持有正股就不取，日期不同的不能拿来顶", () => {
  const accounts = {
    U1111111: { ...navTo(ASOF, 1), stocks: [stock("VRT", 10, 176.73)],
                options: [opt("SOXL", "18DEC26", 58, "P", -1, 20), opt("VRT", "18DEC26", 185, "P", -1, 21)] },
    U2222222: { ...navTo(ASOF, 1), stocks: [stock("COHR", 1, 170)],
                options: [opt("COHR", "18DEC26", 220, "P", -1, 55), opt("VRT", "27NOV26", 195, "P", -1, 25)] },
    U3333333: { ...navTo("2026-11-04", 1), stocks: [stock("RKLB", 5, 52.37)],
                options: [opt("SOXL", "18DEC26", 58, "P", -1, 20)] },
    U4444444: { stocks: [], options: [opt("ORCL", "19MAR27", 175, "P", -1, 61)] },   // 没有日期
  };
  const dayOf = (id) => D.deltaAsOf(accounts[id]);
  assert.deepEqual(D.deltaNeeds(accounts, dayOf), ["2026-11-04 SOXL", `${ASOF} SOXL`]);

  const closes = { [ASOF]: { SOXL: { close: 40.87, bar: ASOF }, VRT: { close: 999, bar: ASOF } } };
  const px = D.deltaPricer(accounts, closes, ASOF, dayOf);
  assert.deepEqual(px("VRT"), { px: 176.73, src: "ibkr", bar: ASOF });    // 报表价优先
  assert.deepEqual(px("SOXL"), { px: 40.87, src: "yahoo", bar: ASOF });
  assert.equal(px("RKLB"), null);       // 只有 11/4 的账户持有：不拿前一天的价
});

// --- books --------------------------------------------------------------------

const BOOK_ACCT = {
  ...navTo(ASOF, 50000),
  stocks: [stock("NVDA", 15, 181.6), stock("BOXX", 100, 115), stock("SOFI", 120, 16.04)],
  options: [
    opt("SOXL", "18DEC26", 58, "P", -3, 20.7372),
    opt("SOXL", "18DEC26", 30, "P", -4, 4.625),
    opt("NVDA", "21JAN28", 220, "C", 1, 23.622),
    opt("SOFI", "21JAN28", 15, "C", 2, 4.7028),
    opt("SOFI", "20NOV26", 20, "C", -1, 0.05),
    opt("BOXX", "18DEC26", 110, "P", -1, 0.1),          // 现金等价物：不算
    opt("ZZZZ", "18DEC26", 10, "P", -1, 1),             // 没有正股价
  ],
};
const BOOK_PRICE = (sym) => ({ SOXL: { px: 40.87, src: "yahoo", bar: ASOF },
                               NVDA: { px: 181.6, src: "ibkr", bar: ASOF },
                               SOFI: { px: 16.04, src: "ibkr", bar: ASOF } })[sym] || null;

test("按标的汇总：正股 + 各类期权分开记，合计 = 各腿之和，占比按净值", () => {
  const b = D.deltaBook(BOOK_ACCT, BOOK_PRICE, ASOF_TS);
  const by = Object.fromEntries(b.rows.map(r => [r.symbol, r]));
  assert.ok(!by.BOXX, "BOXX 当现金");
  const soxl = by.SOXL;
  assert.equal(soxl.stockShares, 0);
  assert.ok(soxl.legs.shortPut > 0);
  near(soxl.deltaShares, soxl.legs.shortPut, 1e-9);
  near(soxl.deltaValue, soxl.legs.shortPut * 40.87, 1e-6);
  const sofi = by.SOFI;
  near(sofi.legValue.stock, 120 * 16.04, 1e-9);
  assert.ok(sofi.legs.longCall > 0 && sofi.legs.shortCall < 0);
  near(sofi.deltaShares, 120 + sofi.legs.longCall + sofi.legs.shortCall, 1e-9);
  near(sofi.weight, sofi.deltaValue / 50000, 1e-12);
  const sum = b.rows.reduce((s, r) => s + r.deltaValue, 0);
  near(b.totals.deltaValue, sum, 1e-6);
  near(b.totals.deltaValue, Object.values(b.totals.legValue).reduce((s, v) => s + v, 0), 1e-6);
  // 按 |Delta 市值| 从大到小
  for (let i = 1; i < b.rows.length; i++) {
    assert.ok(Math.abs(b.rows[i - 1].deltaValue) >= Math.abs(b.rows[i].deltaValue));
  }
});

test("缺正股价的合约单独计数，不进金额，标的照样列出", () => {
  const b = D.deltaBook(BOOK_ACCT, BOOK_PRICE, ASOF_TS);
  const z = b.rows.find(r => r.symbol === "ZZZZ");
  assert.equal(z.unpriced, 1);
  assert.equal(z.deltaValue, 0);
  assert.equal(z.spot, null);
  assert.deepEqual(b.totals.unpricedNames, ["ZZZZ"]);
  assert.equal(b.totals.unpriced, 1);
});

test("「投入资本」跟核心持仓表的敞口是同一个数", () => {
  const b = D.deltaBook(BOOK_ACCT, BOOK_PRICE, ASOF_TS);
  const exp = D.computeExposures(BOOK_ACCT).bySymbol;
  for (const r of b.rows) near(r.capital, exp[r.symbol].exposure, 1e-9, r.symbol);
});

test("总账户 = 各账户分别算再相加，合约带上账户", () => {
  const other = { ...navTo(ASOF, 120000), stocks: [stock("SOFI", 330, 16.04)],
                  options: [opt("SOXL", "4DEC26", 70, "P", -4, 30.2295)] };
  const a = D.deltaBook(BOOK_ACCT, BOOK_PRICE, ASOF_TS, "U1111111");
  const b = D.deltaBook(other, BOOK_PRICE, ASOF_TS, "U2222222");
  const m = D.mergeDeltaBooks([a, b]);
  assert.equal(m.totalNav, 170000);
  near(m.totals.deltaValue, a.totals.deltaValue + b.totals.deltaValue, 1e-6);
  near(m.totals.shockPnl, a.totals.shockPnl + b.totals.shockPnl, 1e-6);
  const soxl = m.rows.find(r => r.symbol === "SOXL");
  near(soxl.legs.shortPut,
       a.rows.find(r => r.symbol === "SOXL").legs.shortPut + b.rows.find(r => r.symbol === "SOXL").legs.shortPut, 1e-9);
  assert.deepEqual([...new Set(soxl.contracts.map(c => c.acct))].sort(), ["U1111111", "U2222222"]);
  near(m.rows.find(r => r.symbol === "SOFI").stockShares, 450, 1e-9);
  near(soxl.weight, soxl.deltaValue / 170000, 1e-12);
});

// --- wiring ---------------------------------------------------------------------

test("delta.js 用到的每个元素 id 都在模板里，脚本在 dashboard.js 之后加载", () => {
  const ids = [...delta.matchAll(/\$\("([a-z0-9-]+)"\)/g)].map(m => m[1]);
  assert.ok(ids.length >= 5);
  for (const id of new Set(ids)) {
    assert.ok(html.includes(`id="${id}"`), `templates/dashboard.html 里没有 #${id}`);
  }
  assert.ok(html.indexOf("/static/js/delta.js") > html.indexOf("/static/js/dashboard.js"),
            "delta.js 要在 dashboard.js 之后加载");
  const render = extract(dash, "dashboard.js", "render");
  assert.ok(render.indexOf("renderDeltaExposure()") > render.indexOf("renderRiskGate()"),
            "render() 要在风险闸门之后调 renderDeltaExposure");
});
