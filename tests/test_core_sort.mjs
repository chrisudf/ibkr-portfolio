// 核心持仓表排序 —— node --test tests/test_core_sort.mjs
//
// 抽取方式同 test_risk_gate.mjs：dashboard.js 没有模块导出，按源码正则把排序表
// 和两个纯函数原样抽出来执行，改名/改签名时抽取直接报错。
//
// 锁这几件事：
//   1. 「状态」▼（默认）：超上限 → 卖 put 已折过上限 → 欠配 → 区间内 → 未设区间，
//      同一状态核心优先、再按占比；▲ 整个倒过来；
//   2. 「占总资产」▼ 从高到低，▲ 从低到高；
//   3. 占比相同按代码 A→Z，正反向都一样，刷新不会乱跳；
//   4. 浏览器里存的排序读回来时，看不懂的一律回到默认；
//   5. 表头点了排的是这张表，不是股票持仓明细（两张都是 .holdings 表）。
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

function extract(src, name) {
  // 同 test_risk_gate.mjs：声明锁在顶格，函数体到第一个顶格 "}" 为止。
  const m = src.match(new RegExp(`^function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"));
  if (!m) throw new Error(`cannot extract function ${name}`);
  return m[0];
}
function extractConst(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`cannot extract ${what}`);
  return m[0];
}

const S = new Function([
  extractConst(dash, /const CORE_STATUS_RANK = [^;]+;/, "CORE_STATUS_RANK"),
  extractConst(dash, /const CORE_SORTS = \{[\s\S]*?\n\};/, "CORE_SORTS"),
  extractConst(dash, /const CORE_SORT_DEFAULT = [^;]+;/, "CORE_SORT_DEFAULT"),
  extract(dash, "coreRowOrder"),
  extract(dash, "coreSortFrom"),
  "return { CORE_SORTS, CORE_SORT_DEFAULT, coreRowOrder, coreSortFrom };",
].join("\n"))();

const row = (symbol, weight, status, core = true) => ({ symbol, weight, status, core });
// 一页典型的表：一个超上限、四个欠配（KO 不是核心）、四个区间内，两个 0%。
const ROWS = [
  row("AAPL", 0.140, "ok"), row("AMZN", 0.095, "ok"), row("META", 0.030, "ok"), row("PG", 0, "ok"),
  row("V", 0.080, "under"), row("JNJ", 0.020, "under"), row("XOM", 0, "under"),
  row("KO", 0.050, "under", false), row("NFLX", 0.220, "over"),
];
const order = (key, dir, rows = ROWS) =>
  [...rows].sort(S.coreRowOrder({ key, dir })).map(r => r.symbol);

test("默认是「状态」▼", () => {
  assert.deepEqual(S.CORE_SORT_DEFAULT, { key: "status", dir: "desc" });
});

test("状态 ▼：要调整的排前面，同一状态核心优先、再按占比；▲ 整个倒过来", () => {
  const desc = [
    "NFLX",                                   // 超上限
    "V", "JNJ", "XOM", "KO",                  // 欠配：核心按占比，非核心 KO 垫底
    "AAPL", "AMZN", "META", "PG",             // 区间内
  ];
  assert.deepEqual(order("status", "desc"), desc);
  assert.deepEqual(order("status", "asc"), [...desc].reverse());
  const mixed = [row("A", 0.05, null), row("B", 0.30, "over"), row("C", 0.20, "ok"), row("D", 0.01, "under")];
  assert.deepEqual(order("status", "desc", mixed), ["B", "D", "C", "A"]);   // 未设区间排最后
});

test("「卖 put 已折过上限」排在超上限之后、欠配之前", () => {
  const rows = [row("A", 0.05, null), row("B", 0.30, "over"), row("C", 0.20, "ok"),
                row("D", 0.01, "under"), row("E", 0, "putfilled")];
  assert.deepEqual(order("status", "desc", rows), ["B", "E", "D", "C", "A"]);
  assert.deepEqual(order("status", "asc", rows), ["A", "C", "D", "E", "B"]);
});

// --- 欠配的保护：区间按投入资本判，卖 put 折出的 delta 已经超过上限时不标欠配 ----------

const G = new Function([
  extractConst(dash, /const BOUND_FLOOR = [^;]+;/, "BOUND_FLOOR"),
  extractConst(dash, /const resolveBounds = \(cfg\) => \[[\s\S]*?\];/, "resolveBounds"),
  extract(dash, "positionStatus"),
  extract(dash, "coreStatus"),
  "return { coreStatus };",
].join("\n"))();
const band = (min, max) => ({ min, max });

test("欠配 + 卖 put 的 delta 加上现有仓位超过上限 → 不标欠配", () => {
  assert.equal(G.coreStatus(0, band(0.05, 0.10), 0.40), "putfilled");       // 0% 资本，put 折 40%
  assert.equal(G.coreStatus(0.03, band(0.05, 0.10), 0.08), "putfilled");    // 3% + 8% > 10%
});

test("加起来没超过上限、没有卖 put：照旧是欠配", () => {
  assert.equal(G.coreStatus(0.02, band(0.05, 0.10), 0.07), "under");        // 2% + 7% 还在上限内
  assert.equal(G.coreStatus(0, band(0.05, 0.5), 0.5), "under");             // 正好压线不算超（二进制精确的数）
  assert.equal(G.coreStatus(0.02, band(0.05, 0.10), 0), "under");
});

test("只有欠配会改：超上限、区间内、没设区间都照旧", () => {
  assert.equal(G.coreStatus(0.30, band(0.05, 0.10), 0.50), "over");
  assert.equal(G.coreStatus(0.07, band(0.05, 0.10), 0.50), "ok");
  assert.equal(G.coreStatus(0.07, band(null, null), 0.50), null);
  assert.equal(G.coreStatus(0.07, null, 0.50), null);
});

test("上限留空按 100% 算：卖 put 要折过整个净值才算", () => {
  assert.equal(G.coreStatus(0, band(0.05, null), 0.60), "under");
  assert.equal(G.coreStatus(0, band(0.05, null), 1.20), "putfilled");
});

test("占总资产 ▼ 从高到低、▲ 从低到高，状态和核心都不管", () => {
  assert.deepEqual(order("weight", "desc"), ["NFLX", "AAPL", "AMZN", "V", "KO", "META", "JNJ", "PG", "XOM"]);
  assert.deepEqual(order("weight", "asc"), ["PG", "XOM", "JNJ", "META", "KO", "V", "AMZN", "AAPL", "NFLX"]);
});

test("占比相同按代码 A→Z，正反向都一样，跟输入顺序无关", () => {
  const zeros = [row("XOM", 0, "under"), row("PG", 0, "ok"), row("BA", 0, "ok")];
  for (const dir of ["desc", "asc"]) {
    assert.deepEqual(order("weight", dir, zeros), ["BA", "PG", "XOM"]);
    assert.deepEqual(order("weight", dir, [...zeros].reverse()), ["BA", "PG", "XOM"]);
  }
});

test("浏览器里存的排序：认得的照用，看不懂的回到默认", () => {
  assert.deepEqual(S.coreSortFrom('{"key":"weight","dir":"asc"}'), { key: "weight", dir: "asc" });
  for (const raw of [null, "", "weight", "{oops", '{"key":"symbol","dir":"desc"}',
                     '{"key":"weight","dir":"up"}', '{"key":"toString","dir":"desc"}', "null"]) {
    assert.deepEqual(S.coreSortFrom(raw), S.CORE_SORT_DEFAULT, `读 ${raw} 应当回到默认`);
  }
  // 回落的是一份新对象，改它不会改到默认值本身
  const s = S.coreSortFrom(null);
  s.key = "weight";
  assert.equal(S.CORE_SORT_DEFAULT.key, "status");
});

test("模板：「占总资产」「状态」两个表头可点，key 都在排序表里；点了排的是这张表", () => {
  const table = html.match(/<tbody id="core-body">/) && html.slice(
    html.lastIndexOf("<table", html.indexOf('id="core-body"')), html.indexOf('id="core-body"'));
  assert.ok(table, "templates/dashboard.html 里没有 #core-body");
  const keys = [...table.matchAll(/<th class="[^"]*sortable[^"]*" data-sort="([a-z]+)">/g)].map(m => m[1]);
  assert.deepEqual(keys.sort(), ["status", "weight"]);
  for (const k of keys) assert.equal(typeof S.CORE_SORTS[k], "function", `CORE_SORTS 里没有 ${k}`);
  assert.ok(!html.includes('id="core-sort"'), "右上角的切换按钮应当已经去掉");
  assert.match(extract(dash, "attachSorters"), /\["core-body", coreSort,/);
});
