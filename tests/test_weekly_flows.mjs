// 周复盘「净值变化」拆出入金回归 —— node --test tests/test_weekly_flows.mjs
//
// 抽取方式与 test_weekly_split.mjs 一致：dashboard.js 没有模块导出，按源码正则
// 把被测函数原样抽出来执行，改名/改签名时抽取直接报错而不是静默测旧实现。
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
const fmtMoneySrc = src.match(/const fmtMoney = [\s\S]*?\n\};/);
if (!fmtMoneySrc) throw new Error("cannot extract fmtMoney");

const { netFlowBetween, weeklyNavStats } = new Function(
  `${fmtMoneySrc[0]}\n${extract("netFlowBetween")}\n${extract("weeklyNavStats")}\n`
  + "return { netFlowBetween, weeklyNavStats };")();

const text = (html) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

test("窗口边界：基线当天不算（已在 navBase 里），最新那天算", () => {
  const flows = [
    { date: "2026-10-27", amount: 100 },
    { date: "2026-10-28", amount: 20 },
    { date: "2026-11-03", amount: 3 },
    { date: "2026-11-04", amount: 1000 },
  ];
  assert.equal(netFlowBetween(flows, "2026-10-27", "2026-11-03"), 23);
});

test("入金和出金按符号相抵，没有 cash_flows 时为 0", () => {
  const flows = [
    { date: "2026-10-28", amount: 500 },
    { date: "2026-10-29", amount: -200 },
  ];
  assert.equal(netFlowBetween(flows, "2026-10-27", "2026-11-03"), 300);
  assert.equal(netFlowBetween(undefined, "2026-10-27", "2026-11-03"), 0);
});

test("亏损窗口里有入金：同时印出原始变化和扣除后的亏损", () => {
  const out = text(weeklyNavStats(-10000, 5000));
  assert.match(out, /净值变化 -\$10,000/);
  assert.match(out, /含净入金 \+\$5,000/);
  assert.match(out, /扣除出入金 -\$15,000/);
});

test("出金：扣除后比原始变化好看，文案写出金", () => {
  const out = text(weeklyNavStats(-5000, -3000));
  assert.match(out, /含净出金 -\$3,000/);
  assert.match(out, /扣除出入金 -\$2,000/);
});

test("窗口内没有出入金时，和改之前一样只印净值变化", () => {
  for (const flow of [0, 0.4, -0.4]) {
    const out = text(weeklyNavStats(1234, flow));
    assert.equal(out, "净值变化 +$1,234");
  }
});

test("颜色跟各自的数字走：净值涨但扣除后亏，两个颜色不同", () => {
  const html = weeklyNavStats(1000, 3000);
  assert.match(html, /<b class="up">\+\$1,000<\/b>/);
  assert.match(html, /<b class="down">-\$2,000<\/b>/);
});
