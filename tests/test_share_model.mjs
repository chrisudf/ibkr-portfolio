// 分享快照白名单模型 —— node --test tests/test_share_model.mjs
//
// 抽取方式与 test_funded_series.mjs 一致：dashboard.js / share.js 都没有模块
// 导出，按源码正则把被测函数原样抽出来执行，改名/改签名时抽取直接报错。
//
// 这张图要发给家人朋友，所以最要紧的两条测试是：
//   1. 键集合锁死 —— 往模型里加字段必须同时改这里，逼着人想一遍
//      "这个字段上图会不会暴露体量"；
//   2. 缩放不变 —— 账本里所有金额（含股数/张数）同乘一个常数，模型必须
//      一模一样。只要有任何一个字段带出了绝对金额，它就会跟着变。这条不看
//      字段名，所以换个名字偷渡金额也逃不过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, "..", "static", "js", f), "utf8");
const dash = read("dashboard.js");
const share = read("share.js");

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
  extractConst(dash, /const fmtMoney = [\s\S]*?\n\};/, "fmtMoney"),
  extractConst(dash, /const FUNDED_MIN_RATIO = [^;]+;/, "FUNDED_MIN_RATIO"),
  extractConst(dash, /const _EXPIRY_MON = \{[\s\S]*?\};/, "_EXPIRY_MON"),
  extractConst(dash, /const DAY_MS = [^;]+;/, "DAY_MS"),
  extractConst(share, /const SHARE_BENCHMARKS = [^;]+;/, "SHARE_BENCHMARKS"),
  extractConst(share, /const SHARE_TOP_N = [^;]+;/, "SHARE_TOP_N"),
].join("\n");

const { buildShareModel, alignBenchmark } = new Function(
  `${consts}\n`
  + ["fundedSeries", "navStats", "optionUnderlying", "buildRankEntries", "parseExpiryTs"]
    .map(n => extract(dash, "dashboard.js", n)).join("\n")
  + "\n"
  + ["alignBenchmark", "buildShareModel"].map(n => extract(share, "share.js", n)).join("\n")
  + "\nreturn { buildShareModel, alignBenchmark };")();

// 30 个工作日。前两行是注资前的 $0 / $1 残根（fundedSeries 会剪掉），
// 第 3 行注资到位；第 15 行盘前再入金 2 万（按 navStats 的期初口径：入金
// 当天也吃到当天的涨跌），所以那一天链出来的收益应当恰好是脚本里的 R[15]。
const DATES = (() => {
  const out = [];
  for (let t = Date.UTC(2026, 7, 3); out.length < 30; t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
})();
// 每次回撤幅度都不同：完全周期的收益序列会出现并列的最大回撤，缩放后的
// 浮点噪声会让 ddStart 在并列者之间跳，测出来的是夹具的巧合而不是泄露。
const R = DATES.map((_, i) => (i % 3 === 0 ? -0.006 - 0.0004 * i : 0.012) + (i === 15 ? 0.005 : 0));
const DEPOSIT_DAY = 15;

function account({ id = "U1234567", cash = -5000 } = {}) {
  const nav_history = [];
  let nav = 0;
  DATES.forEach((date, i) => {
    if (i < 2) { nav_history.push({ date, total: i }); return; }
    nav = i === 2 ? 50000 : (nav + (i === DEPOSIT_DAY ? 20000 : 0)) * (1 + R[i]);
    nav_history.push({ date, total: nav });
  });
  return {
    account: { Account: id },
    statement: { Period: `${DATES[0]} → ${DATES[29]}` },
    nav: { cash, stock: 58000, options: 3500, total: nav_history[29].total },
    nav_history,
    cash_flows: [
      { date: DATES[1], amount: 50000, code: "DEP", id: "a",
        description: "Electronic Fund Transfer from SECRET BANK 4242" },
      { date: DATES[DEPOSIT_DAY], amount: 20000, code: "DEP", id: "b",
        description: "Electronic Fund Transfer from SECRET BANK 4242" },
    ],
    stocks: [
      { symbol: "MSFT", quantity: 60, cost_price: 416.67, close_price: 500,
        cost_basis: 25000, value: 30000, unrealized_pl: 5000 },
      { symbol: "GOOG", quantity: 100, cost_price: 220, close_price: 200,
        cost_basis: 22000, value: 20000, unrealized_pl: -2000 },
      { symbol: "BOXX", quantity: 70, cost_price: 112, close_price: 114.29,
        cost_basis: 7840, value: 8000, unrealized_pl: 160 },
    ],
    options: [
      { symbol: "NVDA 15JAN27 200 C", underlying: "NVDA", expiry: "15JAN27", strike: 200,
        right: "C", multiplier: 100, quantity: 2, cost_basis: 3000, value: 4000, unrealized_pl: 1000 },
      { symbol: "SOXL 18SEP26 50 P", underlying: "SOXL", expiry: "18SEP26", strike: 50,
        right: "P", multiplier: 100, quantity: -3, cost_basis: -1500, value: -500, unrealized_pl: 1000 },
    ],
    performance: {
      realized_total: 0, unrealized_total: 0,
      by_symbol: {
        MSFT: { realized_total: 1000, unrealized_total: 5000, total: 6000, asset_category: "Stocks" },
        GOOG: { realized_total: -500, unrealized_total: -2000, total: -2500, asset_category: "Stocks" },
        BOXX: { realized_total: 300, unrealized_total: 160, total: 460, asset_category: "Stocks" },
        AMZU: { realized_total: -800, unrealized_total: 0, total: -800, asset_category: "Stocks" },
        "NVDA 15JAN27 200 C": { realized_total: 0, unrealized_total: 1000, total: 1000,
          asset_category: "Equity and Index Options" },
        "SOXL 18SEP26 50 P": { realized_total: 2000, unrealized_total: 1000, total: 3000,
          asset_category: "Equity and Index Options" },
      },
    },
  };
}

// 基准：故意缺几天（交易所没开）且第一根在窗口开始之前。
const BENCH = {
  QQQ: DATES.filter((_, i) => i % 4 !== 1).map((d, i) => [d, 500 + 3 * i]),
  SPY: DATES.map((d, i) => [d, 600 - i]),
};

// 账本里所有"体量"字段同乘 k。价格类（行权价、现价、成本价）不动 ——
// 它们是市场条款，不是体量；股数/张数要动，它们乘出来就是金额。
function scaled(acct, k) {
  const c = structuredClone(acct);
  for (const f of ["cash", "stock", "options", "total"]) c.nav[f] *= k;
  for (const p of c.nav_history) p.total *= k;
  for (const f of c.cash_flows) f.amount *= k;
  for (const row of [...c.stocks, ...c.options]) {
    for (const f of ["quantity", "cost_basis", "value", "unrealized_pl"]) row[f] *= k;
  }
  for (const p of Object.values(c.performance.by_symbol)) {
    for (const f of ["realized_total", "unrealized_total", "total"]) p[f] *= k;
  }
  return c;
}

function assertClose(a, b, where = "model") {
  if (typeof a === "number" && typeof b === "number") {
    assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)),
      `${where}: ${a} vs ${b}`);
  } else if (Array.isArray(a)) {
    assert.ok(Array.isArray(b), `${where}: array vs ${typeof b}`);
    assert.equal(a.length, b.length, `${where}: length`);
    a.forEach((x, i) => assertClose(x, b[i], `${where}[${i}]`));
  } else if (a && typeof a === "object") {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b || {}).sort(), `${where}: keys`);
    for (const key of Object.keys(a)) assertClose(a[key], b[key], `${where}.${key}`);
  } else {
    assert.equal(a, b, where);
  }
}

const keys = (o) => Object.keys(o).sort();

test("键集合锁死：加字段先想清楚它上图会暴露什么", () => {
  const m = buildShareModel(account(), BENCH);
  assert.deepEqual(keys(m), ["allocation", "asOf", "benchmarks", "contributors",
    "curve", "holdings", "options", "perf", "window"]);
  assert.deepEqual(keys(m.window), ["end", "start"]);
  assert.deepEqual(keys(m.perf), ["curDD", "ddEnd", "ddStart", "maxDD", "periodReturn"]);
  for (const p of m.curve) assert.deepEqual(keys(p), ["date", "v"]);
  assert.equal(m.benchmarks.length, 2);
  for (const b of m.benchmarks) {
    assert.deepEqual(keys(b), ["curDD", "curve", "maxDD", "periodReturn", "symbol"]);
    for (const p of b.curve) assert.deepEqual(keys(p), ["date", "v"]);
  }
  assert.deepEqual(keys(m.allocation), ["cash", "longOptions", "stock"]);
  for (const h of m.holdings) assert.deepEqual(keys(h), ["ret", "symbol", "weight"]);
  for (const o of m.options) {
    assert.deepEqual(keys(o), ["dte", "expiry", "ret", "right", "side", "strike", "underlying"]);
  }
  assert.deepEqual(keys(m.contributors), ["losers", "total", "winners"]);
  for (const c of [...m.contributors.winners, ...m.contributors.losers]) {
    assert.deepEqual(keys(c), ["contrib", "symbol"]);
  }
});

test("缩放不变：金额和数量同乘 7.3，模型一个数都不能变", () => {
  const acct = account();
  assertClose(buildShareModel(acct, BENCH), buildShareModel(scaled(acct, 7.3), BENCH));
  // 负现金（融资）与正现金两种形状都要过
  const flush = account({ cash: 12000 });
  assertClose(buildShareModel(flush, BENCH), buildShareModel(scaled(flush, 0.37), BENCH));
});

test("缩放不变这条检查本身抓得住泄露", () => {
  // 对照组：只多带一个净值字段的"模型"，同一把尺子必须报错。
  const leaky = (d) => ({ ...buildShareModel(d, BENCH), nav: d.nav.total });
  const acct = account();
  assert.throws(() => assertClose(leaky(acct), leaky(scaled(acct, 7.3))), /nav/);
});

test("没有账号、没有 $、没有出入金描述", () => {
  const json = JSON.stringify(buildShareModel(account({ id: "U7654321" }), BENCH));
  assert.ok(!json.includes("U7654321"), "account id leaked");
  assert.ok(!json.includes("$"), "a formatted dollar string leaked");
  assert.ok(!json.includes("SECRET BANK"), "cash-flow description leaked");
  assert.ok(!/quantity|cost_basis|unrealized_pl|value"/.test(json), "a raw position field leaked");
});

test("曲线是 TWR 指数：起点 100，入金那天不是台阶", () => {
  const m = buildShareModel(account(), null);
  assert.equal(m.curve[0].date, DATES[2]);            // 注资前的残根被剪掉
  assert.equal(m.curve[0].v, 100);
  const k = DEPOSIT_DAY - 2;                           // 剪掉两行后的下标
  const dayRet = m.curve[k].v / m.curve[k - 1].v - 1;
  assert.ok(Math.abs(dayRet - R[DEPOSIT_DAY]) < 1e-12,
    `deposit day reads ${dayRet}, market moved ${R[DEPOSIT_DAY]}`);
  const chained = R.slice(3).reduce((x, r) => x * (1 + r), 1) - 1;
  assert.ok(Math.abs(m.perf.periodReturn - chained) < 1e-12);
  assert.ok(Math.abs(m.curve.at(-1).v / 100 - 1 - chained) < 1e-12, "headline = curve endpoint");
  assert.deepEqual(m.window, { start: DATES[2], end: DATES[29] });
  assert.equal(m.asOf, DATES[29]);
});

test("持仓构成按持有额算：融资时现金记 0，不出现超过 100% 的股票", () => {
  const m = buildShareModel(account({ cash: -5000 }), null);
  // 现金 −5000 + BOXX 8000 = 3000 正现金；股票 50000（不含 BOXX）；期权多头 4000
  const held = 50000 + 4000 + 3000;
  assertClose(m.allocation, { stock: 50000 / held, longOptions: 4000 / held, cash: 3000 / held });
  const deep = buildShareModel(account({ cash: -20000 }), null);   // −20000 + 8000 < 0
  assert.equal(deep.allocation.cash, 0);
  assert.ok(Math.abs(deep.allocation.stock + deep.allocation.longOptions - 1) < 1e-12);
});

test("持仓：不含现金等价物，按占比排序，占比合计等于股票那一段", () => {
  const m = buildShareModel(account(), null);
  assert.deepEqual(m.holdings.map(h => h.symbol), ["MSFT", "GOOG"]);
  assert.ok(Math.abs(m.holdings[0].ret - 0.2) < 1e-12);            // 5000 / 25000
  assert.ok(Math.abs(m.holdings[1].ret + 2000 / 22000) < 1e-12);
  const sum = m.holdings.reduce((s, h) => s + h.weight, 0);
  assert.ok(Math.abs(sum - m.allocation.stock) < 1e-12);
});

test("期权：方向看正负号、剩余天数从数据日起算、同一合约合并", () => {
  const m = buildShareModel(account(), null);
  const nvda = m.options.find(o => o.underlying === "NVDA");
  const soxl = m.options.find(o => o.underlying === "SOXL");
  assert.equal(nvda.side, "long");
  assert.equal(soxl.side, "short");
  assert.equal(soxl.expiry, "2026-09-18");
  assert.equal(soxl.dte, Math.round((Date.UTC(2026, 8, 18) - Date.parse(DATES[29])) / 86400000));
  assert.ok(Math.abs(soxl.ret - 1000 / 1500) < 1e-12);              // 盈亏 ÷ |权利金|
  // 合并视图：两个账户各一张同样的 SOXL put → 一行，回报按合计算
  const merged = account();
  merged.options.push({ ...merged.options[1], cost_basis: -500, unrealized_pl: -100 });
  const rows = buildShareModel(merged, null).options.filter(o => o.underlying === "SOXL");
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].ret - 900 / 2000) < 1e-12);
});

test("盈亏贡献：按标的合并、剔除现金等价物、除以期间平均净值", () => {
  const acct = account();
  const m = buildShareModel(acct, null);
  const funded = acct.nav_history.slice(2);
  const avg = funded.reduce((s, p) => s + p.total, 0) / funded.length;
  assert.deepEqual(m.contributors.winners.map(w => w.symbol), ["MSFT", "SOXL", "NVDA"]);
  assert.deepEqual(m.contributors.losers.map(w => w.symbol), ["GOOG", "AMZU"]);
  assert.ok(Math.abs(m.contributors.winners[0].contrib - 6000 / avg) < 1e-12);
  assert.ok(!m.contributors.winners.some(w => w.symbol === "BOXX"));
  // 合计覆盖全部标的（不只印出来的前五）、同样剔除现金等价物：
  // MSFT 6000 + SOXL 3000 + NVDA 1000 − GOOG 2500 − AMZU 800 = 6700
  assert.ok(Math.abs(m.contributors.total - 6700 / avg) < 1e-12);
});

test("合计不受前五截断：第六名以后也算进去", () => {
  const acct = account();
  for (let i = 0; i < 4; i++) {
    acct.performance.by_symbol[`ZZ${i}`] = { realized_total: 100, unrealized_total: 0, total: 100,
      asset_category: "Stocks" };
  }
  const m = buildShareModel(acct, null);
  const funded = acct.nav_history.slice(2);
  const avg = funded.reduce((s, p) => s + p.total, 0) / funded.length;
  assert.equal(m.contributors.winners.length, 5);                  // 印出来的仍是前五
  assert.ok(Math.abs(m.contributors.total - 7100 / avg) < 1e-12);  // 合计是全部七个赢家 + 两个输家
});

test("没有基准数据时照常出图，只是不带对比", () => {
  const m = buildShareModel(account(), { QQQ: [], SPY: undefined });
  assert.deepEqual(m.benchmarks, []);
  assert.ok(m.perf && m.curve.length);
});

test("基准对齐：按净值日期取当天或之前最近一根，起点 100", () => {
  const curve = [{ date: "2026-08-03" }, { date: "2026-08-04" }, { date: "2026-08-05" }, { date: "2026-08-06" }];
  const rows = [["2026-07-31", 100], ["2026-08-04", 110], ["2026-08-06", 99]];
  const b = alignBenchmark(curve, rows);
  // 08-03 没有自己的 bar → 用 07-31 的 100；08-05 沿用 08-04 的 110
  assert.deepEqual(b.curve.map(p => +p.v.toFixed(6)), [100, 110, 110, 99]);
  assert.ok(Math.abs(b.periodReturn - -0.01) < 1e-12);
  assert.ok(Math.abs(b.maxDD - 0.1) < 1e-12);
  assert.ok(Math.abs(b.curDD - 0.1) < 1e-12);
  // 第一个净值日之前一根都没有：没法锚定，宁可不画
  assert.equal(alignBenchmark(curve, [["2026-08-04", 110]]), null);
  assert.equal(alignBenchmark(curve, []), null);
});
