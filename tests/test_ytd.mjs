// ytdStats —— node --test tests/test_ytd.mjs
// 同 test_funded_series.mjs：从 dashboard.js 源码按名字抽出纯函数执行。
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
  const m = src.match(
    new RegExp(`^function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"));
  if (!m) throw new Error(`cannot extract function ${name} from dashboard.js`);
  return m[0];
}
const constSrc = src.match(/const FUNDED_MIN_RATIO = [^;]+;/)[0];

const { ytdStats, ytdMerged } = new Function(
  [constSrc, ...["fundedSeries", "netFlowBetween", "ytdStats", "ytdMerged"].map(extract)]
    .join("\n") + "\nreturn { ytdStats, ytdMerged };")();

const hist = [
  { date: "2025-12-29", total: 100000 },
  { date: "2025-12-30", total: 101000 },
  { date: "2025-12-31", total: 100000 },
  { date: "2026-01-02", total: 102000 },
  { date: "2026-01-05", total: 103000 },
  { date: "2026-06-01", total: 130000 },   // 含 5 月 20k 入金
  { date: "2026-11-16", total: 140000 },
];

test("基准取去年最后一个净值，扣除今年出入金", () => {
  const flows = [
    { date: "2025-12-15", amount: 50000 },   // 去年的入金不算
    { date: "2026-05-20", amount: 20000 },
    { date: "2026-08-01", amount: -5000 },
  ];
  const y = ytdStats(hist, flows);
  assert.equal(y.baseDate, "2025-12-31");
  assert.equal(y.partial, false);
  assert.equal(y.netFlow, 15000);
  assert.equal(y.pnl, 140000 - 100000 - 15000);
  assert.ok(y.ret > 0);
});

test("收益率与盈亏金额同号（Modified Dietz，不是 TWR）", () => {
  // 小本金先赚、入金后亏：TWR 为正，金额为负
  const h = [
    { date: "2025-12-31", total: 10000 },
    { date: "2026-03-01", total: 15000 },
    { date: "2026-03-02", total: 115000 },
    { date: "2026-11-16", total: 108000 },
  ];
  const y = ytdStats(h, [{ date: "2026-03-02", amount: 100000 }]);
  assert.equal(y.pnl, -2000);
  assert.ok(y.ret < 0);
});

test("今年才注资的账户从首个注资日起算，注资不算盈利", () => {
  const h = [
    { date: "2026-03-02", total: 50000 },
    { date: "2026-03-03", total: 50500 },
    { date: "2026-03-04", total: 51000 },
    { date: "2026-03-05", total: 50800 },
    { date: "2026-03-06", total: 52000 },
  ];
  const y = ytdStats(h, [{ date: "2026-03-01", amount: 50000 }]);
  assert.equal(y.partial, true);
  assert.equal(y.baseDate, "2026-03-02");
  assert.equal(y.pnl, 2000);
});

test("今年涨了 100 倍以上，去年的基准也不能被 fundedSeries 的 1% 线裁掉", () => {
  const h = [
    { date: "2025-12-31", total: 500 },
    { date: "2026-02-02", total: 800 },
    { date: "2026-03-02", total: 100800 },
    { date: "2026-11-16", total: 101000 },
  ];
  const y = ytdStats(h, [{ date: "2026-03-01", amount: 100000 }]);
  assert.equal(y.partial, false);
  assert.equal(y.baseDate, "2025-12-31");
  assert.equal(y.pnl, 101000 - 500 - 100000);
});

test("总账户 = 各户相加；新开户不会抹掉老账户的去年基准", () => {
  const old = { nav_history: hist, cash_flows: [] };
  const fresh = {
    nav_history: [
      { date: "2026-06-01", total: 20000 },
      { date: "2026-11-16", total: 21000 },
    ],
    cash_flows: [{ date: "2026-05-29", amount: 20000 }],
  };
  const a = ytdStats(old.nav_history, old.cash_flows);
  const b = ytdStats(fresh.nav_history, fresh.cash_flows);
  const m = ytdMerged([old, fresh]);
  assert.equal(m.pnl, a.pnl + b.pnl);
  assert.equal(m.baseDate, "2025-12-31");
  assert.equal(m.partial, false);
  assert.ok(Math.abs(m.ret - (a.pnl + b.pnl) / (a.capital + b.capital)) < 1e-12);
  assert.equal(ytdMerged([old, { nav_history: [], cash_flows: [] }]), null);
});

test("没有净值序列时返回 null", () => {
  assert.equal(ytdStats([], []), null);
  assert.equal(ytdStats(undefined, undefined), null);
  assert.equal(ytdStats([{ date: "2026-01-02", total: 1 }], []), null);
});
