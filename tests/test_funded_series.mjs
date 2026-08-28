// fundedSeries + navStats 联动回归 —— node --test tests/test_funded_series.mjs
//
// dashboard.js 没有模块导出（纯浏览器全局脚本），这里按源码正则把被测
// 函数原样抽出来执行：函数体一旦改名/改签名，抽取会直接报错而不是静默
// 测到旧实现。只抽纯函数（无 DOM、无全局依赖），这两只恰好都是。
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
  // 函数体到第一个顶格 "}" 为止 —— repo 风格所有顶层函数都如此闭合。
  // 声明本身也锁在顶格（^ 配 m 标志）：嵌套的同名函数一定带缩进，匹配不上。
  // 不锁的话一旦匹到嵌套那个，"到第一个顶格 }" 会把它所在外层函数的尾巴
  // 一起割进来，抽出的是段语法碎片而不是报错。空白写成 \s* —— 括号前后的
  // 空格风格变了不该弄断抽取；改名/改签名依旧照常报错。
  const m = src.match(
    new RegExp(`^function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"));
  if (!m) throw new Error(`cannot extract function ${name} from dashboard.js`);
  return m[0];
}

const constSrc = (() => {
  const m = src.match(/const FUNDED_MIN_RATIO = [^;]+;/);
  if (!m) throw new Error("cannot extract const FUNDED_MIN_RATIO");
  return m[0];
})();

const { fundedSeries, navStats } = new Function(
  `${constSrc}\n${extract("fundedSeries")}\n${extract("navStats")}\n`
  + "return { fundedSeries, navStats };")();

// U228 的真实几何：55 行 $0、三天测试转账残根、注资日 NAV 跳上来，
// 注资流水按 IBKR 惯例记在 NAV 反映日的前一天。
function stubHistory() {
  const pts = [];
  for (let i = 1; i <= 3; i++) pts.push({ date: `2025-09-0${i}`, total: 0 });
  pts.push({ date: "2025-11-10", total: 0.65 });
  pts.push({ date: "2025-11-11", total: 0.80 });
  pts.push({ date: "2025-11-12", total: 1.00 });
  pts.push({ date: "2025-11-13", total: 1.00 });
  pts.push({ date: "2025-11-14", total: 32676 });
  pts.push({ date: "2025-11-17", total: 32800 });
  pts.push({ date: "2025-11-18", total: 32750 });
  pts.push({ date: "2025-11-19", total: 32900 });
  pts.push({ date: "2025-11-20", total: 33000 });
  return pts;
}
const FUNDING_FLOWS = [{ date: "2025-11-13", amount: 32675 }];

test("裁掉零值行和测试转账残根，从注资日起算", () => {
  const out = fundedSeries(stubHistory());
  assert.equal(out[0].date, "2025-11-14");
  assert.equal(out.length, 5);
});

test("序列中途跌到接近零是真实事件，必须留在图上", () => {
  const hist = [
    { date: "2026-01-02", total: 50000 },
    { date: "2026-01-05", total: 48000 },
    { date: "2026-01-06", total: 60 },     // 灾难性回撤
    { date: "2026-01-07", total: 45000 },
  ];
  const out = fundedSeries(hist);
  assert.equal(out.length, 4);
  assert.ok(out.some((p) => p.total === 60));
});

test("只要有正值点就绝不返回空序列（max 点永远在 floor 之上）", () => {
  assert.equal(fundedSeries([{ date: "2026-01-02", total: 0.65 }]).length, 1);
  assert.equal(fundedSeries([]).length, 0);
  assert.equal(fundedSeries(null).length, 0);
});

// ---- 1% 比例 floor 的两侧，都是有意为之，锁死防手滑 --------------------

test("残留裁剪：$150 挂在 $500k 入金前面会被整段裁掉，垃圾链不再产生", () => {
  // floor = 1%·$500,150 ≈ $5,001 > $150 —— 比例 floor 正是靠「跟着 max
  // 长」才裁得掉这种残留；若给 floor 加绝对上限（如 $100），这段就会被
  // 保留，然后在 $150 基数上跨 $500k 入金重演 -99%/+333,233% 的垃圾对。
  const hist = [];
  for (let d = 2; d <= 13; d++) {
    hist.push({ date: `2026-02-${String(d).padStart(2, "0")}`, total: 150 });
  }
  for (let d = 16; d <= 20; d++) {
    hist.push({ date: `2026-02-${d}`, total: 500150 });
  }
  const flows = [{ date: "2026-02-13", amount: 500000 }];
  const out = fundedSeries(hist);
  assert.equal(out[0].date, "2026-02-16");
  const st = navStats(out, flows);
  assert.ok(Math.abs(st.periodReturn) < 0.01,
    `trimmed chain should be flat, got ${st.periodReturn}`);
});

test("保留不变式：被保留的前导段与后续入金天然错不过 clamp，失真对干净抵消", () => {
  // 被保留 ⇒ 基数 ≥ 1%·max；只要入金在某个 NAV 行里印出来过（max ≥ 入金），
  // 就有 入金 ≤ ~100x 基数 ⇒ 跨注资日链环 ≥ -0.99，clamp 不触发，
  // crash×rebound 精确伸缩抵消。保证只到这条前导边界为止：水平无损，但
  // maxDD 仍记下瞬时深坑、方差仍被拉爆；中途崩盘后再注资、从未在 NAV 里
  // 印出来的过路入金都不在保护范围（见 fundedSeries 注释与 TODO [P2]）。
  const hist = [];
  const days = ["05", "06", "07", "08", "09", "12", "13", "14", "15", "16"];
  for (const d of days) hist.push({ date: `2026-01-${d}`, total: 6000 });
  for (const d of ["19", "20", "21", "22", "23"]) {
    hist.push({ date: `2026-01-${d}`, total: 506000 });
  }
  const flows = [{ date: "2026-01-16", amount: 500000 }];
  const out = fundedSeries(hist);   // floor ≈ $5,060 ≤ $6,000 → 一个点不裁
  assert.equal(out.length, hist.length);
  const st = navStats(out, flows);
  // crash 腿 = 6000/506000-1 = -98.81%，没过 -0.99 ⇒ 未被 clamp 改写
  assert.ok(st.periodReturn > -0.001 && st.periodReturn < 0.001,
    `kept-run pair should telescope to ~0, got ${st.periodReturn}`);
});

test(">100x 有机增长会裁掉最早的真实历史 —— 已记录的取舍，锁住以防误改", () => {
  // 这是上面不变式的镜像代价：$29,413 的真实起点在账户 max 过 $2.94M 后
  // 落到 floor 之下被裁，链条重启（面板日期区间会明显移动）。若有一天
  // 想改这个行为，先回去读 fundedSeries 的注释再动 —— 加绝对上限会
  // 打破保留不变式。
  const hist = [{ date: "2025-11-14", total: 29413 }];
  for (let i = 0; i < 9; i++) {
    hist.push({ date: `2025-12-${10 + i}`, total: 3000000 });
  }
  assert.equal(fundedSeries(hist)[0].date, "2025-12-10");
});

// ---- 周复盘回归 ---------------------------------------------------------

test("周复盘切片回归：裁剪后期间收益回到个位数，原始序列是四位数垃圾", () => {
  const hist = stubHistory();
  // 修复前的口径：只滤 total>0（navStats 内部同款），残根全保留。
  const raw = navStats(hist.filter((p) => p.total > 0), FUNDING_FLOWS);
  const fixed = navStats(fundedSeries(hist), FUNDING_FLOWS);
  // 残根链条：clamp 住的 -0.99 后面跟无上限反弹，期间收益爆到 +50000% 级。
  assert.ok(Math.abs(raw.periodReturn) > 10,
    `raw stub chain should be garbage, got ${raw.periodReturn}`);
  // 裁剪后：注资流水日期 <= 新首点，被吸收为起始本金，链条只剩真实波动。
  assert.ok(Math.abs(fixed.periodReturn) < 0.05,
    `funded chain should be sane, got ${fixed.periodReturn}`);
});

test("三个 navStats 消费点都从 fundedSeries 出（源码级 tripwire）", () => {
  // 上面的回归测的是 helper 组合；这里钉住三个调用点本身 —— 任何一处
  // 退回裸 nav_history，套件就红。周复盘那处正是 PR #9 当初漏掉的。
  assert.match(src, /const histories = list\.map\(a => fundedSeries\(a\.nav_history\)\);/,
    "mergeAccounts 必须逐账户走 fundedSeries");
  assert.match(src, /const series = fundedSeries\(data\.nav_history\);/,
    "renderNavHistory 必须走 fundedSeries");
  assert.match(src, /\? fundedSeries\(data\.nav_history\)\.filter\(p => p\.date >= baseDates\[0\]\)/,
    "周复盘期间收益切片必须走 fundedSeries");
});

test("extract 只认顶格声明 —— 抽到嵌套同名函数会割出语法碎片而不是报错", () => {
  for (const name of ["fundedSeries", "navStats"]) {
    const at = src.indexOf(extract(name));
    assert.ok(at === 0 || src[at - 1] === "\n",
      `${name} 的抽取起点不在行首（index ${at}），说明匹到了缩进里的声明`);
  }
});

test("裁剪后注资流水被吸收为起始本金，链条无极端链环", () => {
  const st = navStats(fundedSeries(stubHistory()), FUNDING_FLOWS);
  assert.ok(st.maxDD < 0.05, `maxDD should be tiny, got ${st.maxDD}`);
  assert.ok(st.annVol < 1.0, `vol should not be blown up, got ${st.annVol}`);
});

test("navStats 对裁剩不足 5 点的序列返回 null（面板隐藏而非打印垃圾）", () => {
  const hist = stubHistory().slice(0, 8);   // 裁剪后只剩 1 个注资点
  assert.equal(navStats(fundedSeries(hist), FUNDING_FLOWS), null);
});
