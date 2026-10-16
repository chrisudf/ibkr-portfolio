// 敞口费面板的汇总与合并 —— node --test tests/test_fee_summary.mjs
//
// 抽取方式与 test_weekly_split.mjs 一致：dashboard.js 没有模块导出，按源码
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
  const m = src.match(
    new RegExp(`^function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"));
  if (!m) throw new Error(`cannot extract function ${name} from dashboard.js`);
  return m[0];
}
const dayMs = src.match(/const DAY_MS = [^;]+;/);
if (!dayMs) throw new Error("cannot extract DAY_MS");

const { feeSummary, mergeFees } = new Function(
  `${dayMs[0]}\n${extract("feeSummary")}\n${extract("mergeFees")}\n`
  + "return { feeSummary, mergeFees };")();

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// 解析器给的形状：IBKR 记账符号（费用为负），新到旧。
const ev = (date, for_date, fee, gst, extra = {}) => ({
  date, for_date, fee, gst, total: +(fee + gst).toFixed(6),
  weekend: false, category: "exposure", currency: "USD", ...extra,
});
const EVENTS = [
  ev("2026-10-16", "2026-10-15", -2.00, -0.20),
  ev("2026-10-05", "2026-10-03", -4.50, -0.45, { weekend: true }),
  ev("2026-10-02", "2026-10-01", -12.00, -1.20, { category: "other" }),
  ev("2026-09-10", "2026-09-09", -1.00, -0.10),
  ev("2026-08-20", "2026-08-19", -2.41, -0.241),
];

test("费用翻成正数成本，其他费用不进标题数", () => {
  const s = feeSummary(EVENTS, "2026-10-16");
  assert.equal(s.count, 4);
  near(s.fee, 9.91);
  near(s.gst, 0.991);
  near(s.total, 10.901);
  assert.equal(s.other.count, 1);
  near(s.other.total, 13.2);
  assert.equal(s.first, "2026-08-19");
});

test("近 30 天以数据日期为锚，边界当天不算", () => {
  const evs = [
    ev("2026-10-16", "2026-10-15", -2.00, -0.20),
    ev("2026-09-17", "2026-09-16", -1.00, -0.10),  // 第 30 天，算
    ev("2026-09-16", "2026-09-15", -5.00, -0.50),  // 正好 30 天前，不算
  ];
  const s = feeSummary(evs, "2026-10-16");
  assert.equal(s.recent.count, 2);
  near(s.recent.total, 3.3);
  // 没给 as-of 时退回最近一笔的入账日，结果一样
  assert.deepEqual(feeSummary(evs, "").recent, s.recent);
});

test("最近一笔和按月汇总不依赖输入顺序", () => {
  const s = feeSummary([...EVENTS].reverse(), "2026-10-16");
  assert.equal(s.last.date, "2026-10-16");
  assert.equal(s.last.for_date, "2026-10-15");
  assert.deepEqual(s.by_month.map(m => m.month), ["2026-08", "2026-09", "2026-10"]);
  near(s.by_month[2].net, 7.15);  // 10 月只算敞口费，行情费那笔不进
});

test("退款是事件不是笔数，会冲减合计", () => {
  const s = feeSummary([
    ev("2026-07-15", "2026-07-09", 1.50, 0),
    ev("2026-07-10", "2026-07-09", -1.50, -0.15),
  ], "2026-07-15");
  assert.equal(s.count, 1);
  near(s.total, 0.15);
});

test("没有敞口费时没有最近一笔（面板据此隐藏）", () => {
  assert.equal(feeSummary([], "2026-10-16").last, null);
  assert.equal(feeSummary(undefined, "").last, null);
  assert.equal(feeSummary(EVENTS.filter(e => e.category === "other"), "").last, null);
});

test("合并视图拼接两个账户的事件并标上账户，新到旧", () => {
  const merged = mergeFees([
    { account: { Account: "U1111111" }, fees: { events: [EVENTS[0], EVENTS[3]] } },
    { account: { Account: "U2222222" }, fees: { events: [ev("2026-10-16", "2026-10-15", -1, -0.1)] } },
    { account: { Account: "U3333333" }, fees: {} },  // 没有 Statement of Funds
  ]);
  assert.deepEqual(merged.events.map(e => [e.date, e.account]), [
    ["2026-10-16", "U1111111"],
    ["2026-10-16", "U2222222"],
    ["2026-09-10", "U1111111"],
  ]);
  near(feeSummary(merged.events, "2026-10-16").total, 2.2 + 1.1 + 1.1);
  assert.deepEqual(mergeFees([{ account: { Account: "U1" }, fees: {} }]), {});
});
