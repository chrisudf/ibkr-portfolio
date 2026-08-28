// 周复盘「正股 / 期权」拆分回归 —— node --test tests/test_weekly_split.mjs
//
// 抽取方式与 test_funded_series.mjs 一致：dashboard.js 没有模块导出，按源码
// 正则把被测函数原样抽出来执行，改名/改签名时抽取直接报错而不是静默测旧实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)),
            "..", "static", "js", "dashboard.js"),
  "utf8");

function extract(name) {
  // 与 test_funded_series.mjs 同一份正则（含顶格锁定）：不锁行首会匹到缩进
  // 里的同名嵌套声明，而"到第一个顶格 } 为止"会把外层函数尾巴一起割进来，
  // 抽出语法碎片、拖到 new Function 才炸成无关的 SyntaxError。
  const m = src.match(
    new RegExp(`^function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"));
  if (!m) throw new Error(`cannot extract function ${name} from dashboard.js`);
  return m[0];
}
function extractConst(re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`cannot extract ${what}`);
  return m[0];
}

const consts = [
  extractConst(/const CASH_EQUIVALENTS = [^;]+;/, "CASH_EQUIVALENTS"),
  extractConst(/const fmtMoney = [\s\S]*?\n\};/, "fmtMoney"),
  extractConst(/const DAY_MS = [^;]+;/, "DAY_MS"),
  extractConst(/const SNAP_MIN_GAP = [^;]+;/, "SNAP_* gaps"),
  extractConst(/const SPLIT_MIN = [^;]+;/, "SPLIT_MIN"),
].join("\n");

const { weeklyDiff, splitLabel } = new Function(
  `${consts}\n${extract("pickBaseline")}\n${extract("optionUnderlying")}\n`
  + `${extract("weeklyDiff")}\n${extract("splitLabel")}\n`
  + "return { weeklyDiff, splitLabel };")();

// 一份贴着真实形状的账本：
//   MSFT  正股 + 一条期权腿    → 两侧都实质贡献
//   CRWV  只有已平仓的期权腿   → 账上没有一股，正是「我没有 CRWV 敞口」那个问题
//   APP   只有正股             → 默认情形，不该多嘴
//   GOOG  正股大 + 期权几毛钱  → 灰尘不该印成「期权 +$0」
//   NVDA  正股没动 + 期权大     → 盈亏全来自期权
const LIVE = {
  date: "2026-08-26", nav: 100000,
  stocks: {
    MSFT: [15, 496.37, 7445, -1000],
    APP:  [10, 308.11, 3081, +500],
    GOOG: [20, 200.00, 4000, +800],
    NVDA: [30, 180.00, 5400, +300],
  },
  perf: {
    MSFT: [0, 0, "S"], APP: [0, 0, "S"], GOOG: [0, 0, "S"], NVDA: [0, 0, "S"],
    "MSFT 17JUL26 400 P": [-60, 0, "O"],
    "CRWV 17APR26 70 P":  [300, 0, "O"],
    "CRWV 20FEB26 65 P":  [120, 0, "O"],
    "GOOG 19JUN26 150 P": [0.4, 0, "O"],
    "NVDA 18SEP26 150 P": [840, 0, "O"],
  },
};
const BASE = {
  date: "2026-08-19", nav: 97000,
  stocks: {
    MSFT: [15, 531.12, 7967, -477],
    APP:  [10, 298.87, 2989, +408],
    GOOG: [20, 196.00, 3920, +600],
    NVDA: [30, 180.00, 5400, +300],
  },
  perf: {
    MSFT: [0, 0, "S"], APP: [0, 0, "S"], GOOG: [0, 0, "S"], NVDA: [0, 0, "S"],
    "MSFT 17JUL26 400 P": [0, 0, "O"],
    "CRWV 17APR26 70 P":  [0, 0, "O"],
    "CRWV 20FEB26 65 P":  [0, 0, "O"],
    "GOOG 19JUN26 150 P": [0, 0, "O"],
    "NVDA 18SEP26 150 P": [0, 0, "O"],
  },
};
const byU = () => Object.fromEntries(
  weeklyDiff(LIVE, [BASE]).rows.map(r => [r.u, r]));

test("不变式：sPnl + oPnl 恒等于 total —— 同一个数的另一种拆法，不是另算一遍", () => {
  for (const r of weeklyDiff(LIVE, [BASE]).rows) {
    assert.ok(Math.abs((r.sPnl + r.oPnl) - r.total) < 1e-9,
              `${r.u}: ${r.sPnl} + ${r.oPnl} !== ${r.total}`);
    // 另一条轴（已实现/浮动）同时成立，两种拆法互不干扰。
    assert.ok(Math.abs((r.pnlU + r.pnlR) - r.total) < 1e-9, `${r.u} 轴 2`);
  }
});

test("正股 + 期权都有贡献时两边分别归位（MSFT −$523 / −$60）", () => {
  const r = byU().MSFT;
  assert.ok(Math.abs(r.sPnl - (-523)) < 1e-6);
  assert.equal(r.oPnl, -60);
  assert.ok(Math.abs(r.total - (-583)) < 1e-6);
  assert.equal(splitLabel(r), "正股 -$523 · 期权 -$60");
});

test("一股都没有的标的，盈亏全部落在期权侧（CRWV 的 CSP 阶梯）", () => {
  const r = byU().CRWV;
  assert.equal(r.sPnl, 0);
  assert.equal(r.oPnl, 420);
  assert.equal(r.qtyNow, 0);
  assert.equal(r.qtyBase, 0);
  assert.equal(splitLabel(r), "全期权");
});

test("只有正股的行保持沉默 —— 默认读法本来就对，不该加噪音", () => {
  const r = byU().APP;
  assert.equal(r.oPnl, 0);
  assert.equal(splitLabel(r), "");
});

test("期权侧只有几毛钱时不印「期权 +$0」", () => {
  const r = byU().GOOG;
  assert.equal(r.oPnl, 0.4);
  assert.equal(splitLabel(r), "");
});

test("正股没动、盈亏全来自期权时也标注出来（NVDA）", () => {
  const r = byU().NVDA;
  assert.equal(r.sPnl, 0);
  assert.equal(r.oPnl, 840);
  assert.equal(splitLabel(r), "全期权");
});

test("合并视图的累加器要带上两个新桶，否则 ALL 视图拆分恒为空", () => {
  const m = src.match(/const t = merged\[r\.u\] \|\| \(merged\[r\.u\] = \{[\s\S]*?\}\);/);
  assert.ok(m, "cannot find renderWeekly merged accumulator");
  assert.match(m[0], /sPnl: 0/);
  assert.match(m[0], /oPnl: 0/);
  assert.match(src, /t\.sPnl \+= r\.sPnl; t\.oPnl \+= r\.oPnl;/);
});

test("渲染必须走 splitLabel（源码级 tripwire，防被改回单一数字）", () => {
  assert.match(src, /<span class="wk-split muted">\$\{splitLabel\(r\)\}<\/span>/);
});
