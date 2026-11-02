// 核心持仓表排序 —— node --test tests/test_core_sort.mjs
//
// 抽取方式同 test_risk_gate.mjs：dashboard.js 没有模块导出，按源码正则把排序表
// 原样抽出来执行，改名时抽取直接报错。
//
// 锁两件事：
//   1. 「按状态」（默认）：超上限 → 欠配 → 区间内 → 未设区间，同一状态核心优先、再按占比；
//   2. 「按占总资产」：只看占比从高到低。两种都是占比相同按代码排，刷新不会乱跳。
// 标的和数字都是编的 —— 仓库是公开的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(path.join(here, "..", ...p), "utf8");
const dash = read("static", "js", "dashboard.js");
const html = read("templates", "dashboard.html");

function extractConst(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`cannot extract ${what}`);
  return m[0];
}

const { CORE_SORTS } = new Function(
  extractConst(dash, /const CORE_STATUS_RANK = [^;]+;/, "CORE_STATUS_RANK") + "\n"
  + extractConst(dash, /const CORE_SORTS = \{[\s\S]*?\n\};/, "CORE_SORTS")
  + "\nreturn { CORE_SORTS };")();

const row = (symbol, weight, status, core = true) => ({ symbol, weight, status, core });
// 一页典型的表：一个超上限、四个欠配（KO 不是核心）、四个区间内，两个 0%。
const ROWS = [
  row("AAPL", 0.140, "ok"), row("AMZN", 0.095, "ok"), row("META", 0.030, "ok"), row("PG", 0, "ok"),
  row("V", 0.080, "under"), row("JNJ", 0.020, "under"), row("XOM", 0, "under"),
  row("KO", 0.050, "under", false), row("NFLX", 0.220, "over"),
];
const order = (mode, rows = ROWS) => [...rows].sort(CORE_SORTS[mode]).map(r => r.symbol);

test("按状态（默认）：要调整的排前面，同一状态核心优先、再按占比", () => {
  assert.deepEqual(order("status"), [
    "NFLX",                                   // 超上限
    "V", "JNJ", "XOM", "KO",                  // 欠配：核心按占比，非核心 KO 垫底
    "AAPL", "AMZN", "META", "PG",             // 区间内
  ]);
  const mixed = [row("A", 0.05, null), row("B", 0.30, "over"), row("C", 0.20, "ok"), row("D", 0.01, "under")];
  assert.deepEqual(order("status", mixed), ["B", "D", "C", "A"]);   // 未设区间排最后
});

test("按占总资产：只看占比从高到低，状态和核心都不管", () => {
  assert.deepEqual(order("weight"), ["NFLX", "AAPL", "AMZN", "V", "KO", "META", "JNJ", "PG", "XOM"]);
});

test("占比相同按代码排：结果跟输入顺序无关", () => {
  const zeros = [row("XOM", 0, "under"), row("PG", 0, "ok"), row("BA", 0, "ok")];
  for (const mode of ["weight", "status"]) {
    const sorted = order(mode, zeros);
    assert.deepEqual(order(mode, [...zeros].reverse()), sorted);
  }
  assert.deepEqual(order("weight", zeros), ["BA", "PG", "XOM"]);
});

test("模板里的切换按钮和排序表对得上，默认按状态", () => {
  const block = html.match(/id="core-sort"[\s\S]*?<\/div>/);
  assert.ok(block, "templates/dashboard.html 里没有 #core-sort");
  const modes = [...block[0].matchAll(/data-sort="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(modes, ["status", "weight"]);
  for (const m of modes) assert.equal(typeof CORE_SORTS[m], "function", `CORE_SORTS 里没有 ${m}`);
  assert.match(block[0], /data-sort="status" class="active"/);
});
