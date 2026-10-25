// 风险闸门回归 —— node --test tests/test_risk_gate.mjs
//
// 抽取方式与 test_funded_series.mjs 一致：dashboard.js / risk.js 都没有模块
// 导出，按源码正则把被测函数原样抽出来执行，改名/改签名时抽取直接报错。
//
// 这块面板最要紧、也最容易悄悄改坏的几条：
//   1. 合并列是「名义之和 ÷ 净值之和」，不是两个账户比值的平均；
//   2. 线是「严格超过才算超线」，正好压线不算；断路器是「到 −10% 就跳闸」，
//      而且浮点误差不能决定压线那一下的结论；
//   3. 回撤剔除出入金 —— 入金不能把断路器关掉，出金不能凭空跳闸；
//   4. 财报：只有一个真实日期落在到期之后才能说「不跨」，任何拿不到的情况
//      都是「未知」，绝不能落成「不跨」。
// 账号全部是假的（U1111111 / U2222222）—— 仓库是公开的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(path.join(here, "..", ...p), "utf8");
const dash = read("static", "js", "dashboard.js");
const risk = read("static", "js", "risk.js");
const html = read("templates", "dashboard.html");

function extract(src, file, name) {
  // 同 test_funded_series.mjs：声明锁在顶格，函数体到第一个顶格 "}" 为止。
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
  extractConst(dash, /const MARK_ITM_RATIO = [^;]+;/, "MARK_ITM_RATIO"),
  extractConst(dash, /const FUNDED_MIN_RATIO = [^;]+;/, "FUNDED_MIN_RATIO"),
  extractConst(dash, /const _EXPIRY_MON = \{[\s\S]*?\};/, "_EXPIRY_MON"),
  extractConst(dash, /const DAY_MS = [^;]+;/, "DAY_MS"),
  extractConst(risk, /const RISK_DEFAULTS = \{[\s\S]*?\n\};/, "RISK_DEFAULTS"),
  extractConst(risk, /const RISK_CLUSTER = \[[\s\S]*?\];/, "RISK_CLUSTER"),
  extractConst(risk, /const RISK_WATCH = [^;]+;/, "RISK_WATCH"),
  extractConst(risk, /const EARNINGS_ALIAS = \{[\s\S]*?\};/, "EARNINGS_ALIAS"),
  extractConst(risk, /const EARNINGS_NONE = new Set\(\[[\s\S]*?\]\);/, "EARNINGS_NONE"),
  extractConst(risk, /const RISK_EPS = [^;]+;/, "RISK_EPS"),
  extractConst(risk, /const EARNINGS_RANK = [^;]+;/, "EARNINGS_RANK"),
].join("\n");

const DASH_FNS = ["parseExpiryTs", "groupExpiries", "fundedSeries", "navStats"];
const RISK_FNS = ["riskConfig", "riskNav", "riskBook", "mergeRiskBooks", "riskJudge",
                  "riskPmBuffer", "riskDrawdown", "riskTripped", "riskCashWeeks",
                  "earningsTicker", "expiryIso", "earningsVerdict", "riskEarningsRows",
                  "riskVerdict"];
const R = new Function(
  `${consts}\n`
  + DASH_FNS.map(n => extract(dash, "dashboard.js", n)).join("\n") + "\n"
  + RISK_FNS.map(n => extract(risk, "risk.js", n)).join("\n")
  + `\nreturn { ${[...DASH_FNS, ...RISK_FNS, "RISK_DEFAULTS", "RISK_CLUSTER"].join(", ")} };`)();

const near = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

// --- fixtures -------------------------------------------------------------

const put = (u, expiry, strike, qty, extra = {}) => ({
  symbol: `${u} ${expiry} ${strike} P`, underlying: u, expiry, strike, right: "P",
  multiplier: 100, quantity: qty, value: -100 * Math.abs(qty), ...extra,
});
const call = (u, expiry, strike, qty, extra = {}) => ({
  symbol: `${u} ${expiry} ${strike} C`, underlying: u, expiry, strike, right: "C",
  multiplier: 100, quantity: qty, value: 100 * qty, ...extra,
});

// 「组合保证金户」形状：卖 put 名义已经超过净值，SOXL 单列超线，簇里有 LEAP。
const ACCT_A = {
  nav: { total: 80000, cash: 20000 },
  stocks: [
    { symbol: "BOXX", value: 10000, close_price: 118 },
    { symbol: "NVDA", value: 6000, close_price: 180 },
    { symbol: "LITE", value: 4000, close_price: 400 },
    { symbol: "MSFT", value: 5000, close_price: 500 },
  ],
  options: [
    put("SOXL", "27NOV26", 75, -4),        // 30,000 —— 簇内、单列
    put("COHR", "20NOV26", 220, -1),       // 22,000 —— 簇内
    put("MSFT", "18DEC26", 400, -1),       // 40,000 —— 簇外
    call("LITX", "20NOV26", 50, -1),       // 卖 call：不进卖 put 名义
    call("NVDA", "21JAN28", 220, 1),       // LEAP：180 × 100 = 18,000
    call("AVGO", "15JAN27", 300, 1),       // LEAP，组合里没有 AVGO 报价 → 按行权价 30,000
    put("QQQ", "20NOV26", 500, 1),         // 买 put：对冲，不进任何一项
    { symbol: "XYZ ADJ", underlying: "XYZ", expiry: "20NOV26", strike: 0, right: "",
      multiplier: 100, quantity: -2, value: -50 },   // 读不出行权价的空头
  ],
};
// 「现金户」形状：更大的净值、更少的名义。
const ACCT_B = {
  nav: { total: 160000, cash: 5000 },
  stocks: [{ symbol: "BOXX", value: 45000, close_price: 118 }],
  options: [put("SOXL", "27NOV26", 75, -4), put("VRT", "06NOV26", 200, -1)],
};
const BOOK = { NVDA: 180, LITE: 400, MSFT: 500, BOXX: 118 };
const CFG = R.riskConfig(null);

// --- notional books ---------------------------------------------------------

test("卖 put 名义按 行权价 × 张数 × 乘数，卖 call / 买 put 不算，读不出的单列计数", () => {
  const b = R.riskBook(ACCT_A, CFG, BOOK);
  assert.equal(b.putTotal, 92000);
  assert.deepEqual(b.byU, { SOXL: 30000, COHR: 22000, MSFT: 40000 });
  assert.equal(b.unparsed, 2);
  assert.equal(b.cashLike, 30000);               // 现金 + BOXX
  assert.equal(b.nav, 80000);
});

test("合约乘数取合约自己的，不硬编码 100", () => {
  const b = R.riskBook({ nav: { total: 10000 }, stocks: [],
    options: [put("NVDL", "20NOV26", 30, -1, { multiplier: 10 })] }, CFG, {});
  assert.equal(b.putTotal, 300);
});

test("AI 簇 = 成员正股 + LEAP（正股价 × 股数，无报价按行权价并计数）+ 成员卖 put", () => {
  const b = R.riskBook(ACCT_A, CFG, BOOK);
  assert.equal(b.cluster.stockMV, 10000);        // NVDA + LITE；MSFT、BOXX 不是成员
  assert.equal(b.cluster.leap, 18000 + 30000);
  assert.equal(b.cluster.leapAssumed, 1);        // AVGO 那张
  assert.equal(b.cluster.put, 52000);            // SOXL + COHR；MSFT 不是成员
  const j = R.riskJudge(b, CFG);
  near(j.cluster.ratio, 110000 / 80000);
  assert.equal(j.cluster.over, true);
});

test("簇成员走配置：换一套成员，数字跟着变", () => {
  const cfg = R.riskConfig({ cluster: ["MSFT"] });
  const b = R.riskBook(ACCT_A, cfg, BOOK);
  assert.equal(b.cluster.stockMV, 5000);
  assert.equal(b.cluster.put, 40000);
  assert.equal(b.cluster.leap, 0);
});

test("单列标的（SOXL）单独判，其余单标的按名义从大到小", () => {
  const j = R.riskJudge(R.riskBook(ACCT_A, CFG, BOOK), CFG);
  near(j.put.ratio, 92000 / 80000);
  assert.equal(j.put.over, true);
  assert.equal(j.watch.length, 1);
  assert.equal(j.watch[0].u, "SOXL");
  near(j.watch[0].ratio, 0.375);
  assert.equal(j.watch[0].over, true);
  assert.deepEqual(j.single.map(r => r.u), ["MSFT", "COHR"]);   // SOXL 不重复出现
  assert.deepEqual(j.single.map(r => r.over), [true, true]);     // 0.5、0.275 都 > 0.25
});

test("合并列 = 名义之和 ÷ 净值之和，不是两个比值的平均", () => {
  const a = R.riskBook(ACCT_A, CFG, BOOK);
  const b = R.riskBook(ACCT_B, CFG, BOOK);
  const m = R.riskJudge(R.mergeRiskBooks([a, b]), CFG);
  near(m.put.ratio, (92000 + 50000) / (80000 + 160000));
  const avg = (R.riskJudge(a, CFG).put.ratio + R.riskJudge(b, CFG).put.ratio) / 2;
  assert.ok(Math.abs(m.put.ratio - avg) > 0.1, "合并比值不该等于平均值");
  near(m.watch[0].ratio, 60000 / 240000);        // 两边的 SOXL 加在一起
  assert.equal(m.watch[0].over, false);          // 正好 0.25：压线不算超
  assert.equal(m.nav, 240000);
});

test("压线不算超线，超一点点才算；浮点误差不改结论", () => {
  const book = (putTotal) => ({ nav: 100000, putTotal, byU: {}, unparsed: 0,
    cluster: { stockMV: 0, leap: 0, put: 0, leapAssumed: 0 }, cashLike: 0 });
  assert.equal(R.riskJudge(book(100000), CFG).put.over, false);
  assert.equal(R.riskJudge(book(100000 * (0.1 + 0.2) / 0.3), CFG).put.over, false);
  assert.equal(R.riskJudge(book(100001), CFG).put.over, true);
});

test("没有净值就没有比值，也不报超线", () => {
  const j = R.riskJudge(R.riskBook({ nav: {}, stocks: [], options: [put("SOXL", "27NOV26", 75, -1)] },
    CFG, {}), CFG);
  assert.equal(j.put.ratio, null);
  assert.equal(j.put.over, false);
  assert.equal(j.watch[0].over, false);
});

// --- settings ----------------------------------------------------------------

test("设置：缺省全走默认值，覆盖只改填了的，读不懂的回落默认而不是 0", () => {
  const d = R.riskConfig(null);
  assert.equal(d.put_nav_max, 1.0);
  assert.equal(d.single_put_nav_max, 0.25);
  assert.equal(d.pm_floor, 100000);
  assert.equal(d.drawdown_days, 30);
  assert.equal(d.drawdown_stop, 0.10);
  assert.deepEqual(d.watch, ["SOXL"]);
  assert.deepEqual(d.cluster, R.RISK_CLUSTER);
  const c = R.riskConfig({ thresholds: { put_nav_max: 1.5, pm_warn: "abc", bogus: 3 },
                           watch: [], accounts: { U1111111: { kind: "pm" } } });
  assert.equal(c.put_nav_max, 1.5);
  assert.equal(c.pm_warn, R.RISK_DEFAULTS.pm_warn);
  assert.equal(c.bogus, undefined);
  assert.deepEqual(c.watch, []);                 // 明确清空 ≠ 用默认
  assert.equal(c.accounts.U1111111.kind, "pm");
  // 默认值对象不能被一次覆盖改掉
  assert.equal(R.riskConfig(null).put_nav_max, 1.0);
});

// --- portfolio-margin floor ----------------------------------------------------

test("组合保证金线：缓冲 <10% 黄、破线红，百分比按净值算", () => {
  const amber = R.riskPmBuffer(110000, 100000, 0.10);
  assert.equal(amber.gap, 10000);
  near(amber.pct, 10000 / 110000);
  assert.equal(amber.level, "amber");
  assert.equal(R.riskPmBuffer(125000, 100000, 0.10).level, "ok");
  const red = R.riskPmBuffer(82900, 100000, 0.10);
  assert.equal(red.level, "red");
  near(red.gap, -17100);
  near(-red.pct, 17100 / 82900);                 // 需涨多少才回到线上
  assert.equal(R.riskPmBuffer(100000, 100000, 0.10).level, "amber");   // 正好在线上
  assert.equal(R.riskPmBuffer(0, 100000, 0.10), null);
});

// --- drawdown breaker ------------------------------------------------------------

function weekdays(n, start = Date.UTC(2026, 6, 1)) {
  const out = [];
  for (let t = start; out.length < n; t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
// 按收益率序列生成净值：returns[i] 是第 i 天相对前一天的涨跌。
function navPath(returns, start = 100000) {
  return navPathWithFlows(returns, {}, start).pts;
}
// 同上，外加出入金：flows[k] 是第 k 个点那天的金额。按 navStats 的口径落账
// —— 入金期初到账、吃到当天涨跌，出金期末离开 —— 所以剔除出入金后的收益链
// 恰好等于 returns 本身，回撤应当和没有出入金时一模一样。
function navPathWithFlows(returns, flows, start = 100000) {
  const dates = weekdays(returns.length + 1);
  const pts = [{ date: dates[0], total: start }];
  const fl = [];
  returns.forEach((r, i) => {
    const amt = flows[i + 1] || 0;
    if (amt) fl.push({ date: dates[i + 1], amount: amt });
    const base = pts[i].total + Math.max(amt, 0);
    pts.push({ date: dates[i + 1], total: base * (1 + r) + Math.min(amt, 0) });
  });
  return { pts, flows: fl };
}

test("断路器：窗口高点回撤 −15% 跳闸，并给出高点日期", () => {
  const rets = [...Array(15).fill(0.01), ...Array(14).fill(0), -0.15];
  const hist = navPath(rets);
  const dd = R.riskDrawdown(hist, [], 30);
  near(dd.dd, -0.15, 1e-12);
  assert.equal(dd.peakDate, hist[hist.length - 2].date);   // 平台期推到最后一天
  assert.equal(dd.lastDate, hist[hist.length - 1].date);
  assert.equal(R.riskTripped(dd, CFG), true);
});

test("断路器：正好 −10% 也跳闸（含浮点误差），−9.9% 不跳", () => {
  const exact = [{ total: 100000 }, { total: 100000 }, { total: 100000 },
                 { total: 95000 }, { total: 90000 }]
    .map((p, i) => ({ ...p, date: weekdays(5)[i] }));
  assert.equal(R.riskTripped(R.riskDrawdown(exact, [], 30), CFG), true);
  const almost = exact.map((p, i) => (i === 4 ? { ...p, total: 90100 } : p));
  assert.equal(R.riskTripped(R.riskDrawdown(almost, [], 30), CFG), false);
});

test("入金不能把断路器关掉：剔除出入金后回撤不变", () => {
  const rets = [...Array(10).fill(0), -0.05, -0.05, -0.05];
  const base = R.riskDrawdown(navPath(rets), [], 30);
  near(base.dd, -(1 - 0.95 ** 3), 1e-12);
  // 跌到一半时入金 3 万：原始净值上看，跌势被这笔钱盖住了大半
  const { pts, flows } = navPathWithFlows(rets, { 12: 30000 });
  const withFlow = R.riskDrawdown(pts, flows, 30);
  near(withFlow.dd, base.dd, 1e-12);
  assert.equal(R.riskTripped(withFlow, CFG), true);
  // 同样的净值如果不剔除入金，就会被读成「没事」—— 说明上面那条确实在起作用
  assert.equal(R.riskTripped(R.riskDrawdown(pts, [], 30), CFG), false);
});

test("出金不能凭空跳闸", () => {
  const { pts, flows } = navPathWithFlows(Array(20).fill(0), { 20: -40000 });
  assert.equal(pts[pts.length - 1].total, 60000);       // 原始净值掉了 40%
  const dd = R.riskDrawdown(pts, flows, 30);
  near(dd.dd, 0, 1e-12);
  assert.equal(R.riskTripped(dd, CFG), false);
});

test("回撤只看最近 N 行：窗口外的老回撤不算", () => {
  // 60 天前高点比现在高 50%，但最近 30 行一直是平的
  const rets = [...Array(10).fill(0.05), ...Array(10).fill(-0.04), ...Array(40).fill(0)];
  const hist = navPath(rets);
  const dd = R.riskDrawdown(hist, [], 30);
  near(dd.dd, 0, 1e-9);
  assert.equal(dd.rows, 30);
  assert.ok(R.riskDrawdown(hist, [], 61).dd < -0.2, "放大窗口后老回撤应当出现");
});

test("净值行不足 5 个：给不出回撤，也不跳闸", () => {
  const dd = R.riskDrawdown(navPath([-0.2, -0.2]), [], 30);
  assert.equal(dd, null);
  assert.equal(R.riskTripped(dd, CFG), false);
});

// --- cash account weeks ------------------------------------------------------------

test("现金户：按到期周汇总卖 put 名义，当周超现金+BOXX 标红，累计超标黄", () => {
  const options = [
    put("SOXL", "30OCT26", 80, -2),            // 16,000
    call("SOXL", "30OCT26", 120, -1),          // 卖 call：不进这张表
    put("SOXL", "06NOV26", 85, -2),            // 17,000
    put("VRT", "06NOV26", 200, -1),            // 20,000 → 当周 37,000
    put("COHR", "20NOV26", 220, -1),           // 22,000
  ];
  const weeks = R.riskCashWeeks(options, {}, Date.UTC(2026, 9, 26, 12), 30000);
  assert.deepEqual(weeks.map(w => w.putNotional), [16000, 37000, 22000]);
  assert.deepEqual(weeks.map(w => w.cum), [16000, 53000, 75000]);
  assert.deepEqual(weeks.map(w => w.over), [false, true, false]);
  assert.deepEqual(weeks.map(w => w.cumOver), [false, true, true]);
  assert.equal(weeks[0].dte, 4);
  assert.ok(weeks[0].items.every(s => s.includes("P")), "卖 call 混进来了");
  near(weeks[1].ratio, 37000 / 30000);
});

// --- earnings ----------------------------------------------------------------------

test("财报代码：单股杠杆 ETF 映射到底层，指数 ETF 不标", () => {
  assert.equal(R.earningsTicker("LITX"), "LITE");
  assert.equal(R.earningsTicker("APPX"), "APP");
  assert.equal(R.earningsTicker("NVDL"), "NVDA");
  assert.equal(R.earningsTicker("SOXL"), null);
  assert.equal(R.earningsTicker("TQQQ"), null);
  assert.equal(R.earningsTicker("COHR"), "COHR");
  assert.equal(R.earningsTicker(""), null);
});

const TODAY = "2026-10-25";
const ok = (date, extra = {}) => ({ status: "ok", date, timing: "", estimated: false, ...extra });

test("财报在到期前或到期当天 → 跨；在到期之后 → 不跨", () => {
  assert.equal(R.earningsVerdict("20NOV26", "COHR", ok("2026-11-04"), TODAY).state, "cross");
  assert.equal(R.earningsVerdict("20NOV26", "COHR", ok("2026-11-20"), TODAY).state, "cross");
  assert.equal(R.earningsVerdict("20NOV26", "COHR", ok("2026-11-21"), TODAY).state, "clear");
  assert.equal(R.earningsVerdict("20NOV26", "COHR", ok(TODAY), TODAY).state, "cross");
});

test("拿不到日期的每一种情况都是未知，绝不是不跨", () => {
  const junk = [
    undefined, null,
    { status: "error", date: null }, { status: "none", date: null },
    { status: "ok", date: null }, { status: "ok" }, { status: "pending", date: "2026-12-01" },
    ok("2026-10-01"),                                    // 日期已经过去
  ];
  for (const e of junk) {
    const v = R.earningsVerdict("20NOV26", "COHR", e, TODAY);
    assert.equal(v.state, "unknown", `entry ${JSON.stringify(e)} → ${v.state}`);
    assert.ok(v.why, "未知要说明原因");
  }
  assert.equal(R.earningsVerdict("garbage", "COHR", ok("2026-12-01"), TODAY).state, "unknown");
  assert.equal(R.earningsVerdict("20NOV26", null, ok("2026-11-04"), TODAY).state, "na");
});

test("每张未平的卖出期权一行（镜像合约两行），排序：跨 → 未知 → 不跨 → 不适用", () => {
  const accounts = {
    U2222222: { options: [put("COHR", "20NOV26", 220, -1), put("SOXL", "27NOV26", 75, -4)] },
    U1111111: { options: [
      put("COHR", "20NOV26", 220, -1),
      call("LITX", "20NOV26", 50, -1),
      put("MSFT", "18DEC26", 400, -1),
      put("ORCL", "19MAR27", 175, -1),
      call("NVDA", "21JAN28", 220, 1),                   // 多头：不在这张表
    ] },
  };
  const earnings = {
    COHR: ok("2026-11-04", { timing: "amc" }),
    LITE: ok("2026-11-05"),
    MSFT: ok("2027-01-27"),
    ORCL: { status: "error", date: null },
  };
  const rows = R.riskEarningsRows(accounts, earnings, TODAY);
  assert.deepEqual(rows.map(r => [r.acct, r.o.underlying, r.state]), [
    ["U1111111", "COHR", "cross"],
    ["U2222222", "COHR", "cross"],
    ["U1111111", "LITX", "cross"],                       // 按 LITE 的财报判
    ["U1111111", "ORCL", "unknown"],
    ["U1111111", "MSFT", "clear"],
    ["U2222222", "SOXL", "na"],
  ]);
  assert.equal(rows.find(r => r.o.underlying === "LITX").ticker, "LITE");
});

// --- verdict -------------------------------------------------------------------------

test("结论：断路器、超线、PM 破线、现金不够都是红；只有 PM 缓冲薄是黄；都没有是线内", () => {
  const j = R.riskJudge(R.riskBook(ACCT_A, CFG, BOOK), CFG);
  const v = R.riskVerdict(j, { dd: -0.12 }, { level: "red" }, null, CFG);
  assert.equal(v.breaker, true);
  assert.equal(v.level, "red");
  assert.deepEqual(v.crossed, ["卖 put 1.15x", "SOXL 0.38x", "MSFT 0.50x", "COHR 0.28x",
                               "AI 硬件簇 1.38x"]);
  const calm = R.riskJudge(R.riskBook({ nav: { total: 500000 }, stocks: [],
    options: [put("MSFT", "18DEC26", 400, -1)] }, CFG, {}), CFG);
  assert.equal(R.riskVerdict(calm, { dd: -0.02 }, null, null, CFG).level, "ok");
  assert.equal(R.riskVerdict(calm, { dd: -0.02 }, { level: "amber" }, null, CFG).level, "amber");
  const v2 = R.riskVerdict(calm, null, null, [{ over: true }, { over: false }], CFG);
  assert.equal(v2.cashShort, 1);
  assert.equal(v2.level, "red");
});

// --- wiring ----------------------------------------------------------------------------

test("risk.js 用到的每个元素 id 都在模板里", () => {
  const ids = [...risk.matchAll(/\$\("([a-z0-9-]+)"\)/g)].map(m => m[1]);
  assert.ok(ids.length > 10);
  for (const id of new Set(ids)) {
    assert.ok(html.includes(`id="${id}"`), `templates/dashboard.html 里没有 #${id}`);
  }
  assert.ok(html.indexOf("/static/js/risk.js") > html.indexOf("/static/js/dashboard.js"),
            "risk.js 要在 dashboard.js 之后加载");
});
