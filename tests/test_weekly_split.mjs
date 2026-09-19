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
  extractConst(/const REALIZED_EPS = [^;]+;/, "REALIZED_EPS"),
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

/* --- 清仓徽章 --------------------------------------------------------------
 * 「清仓」一直在算、也一直在印，只是印成了跟涨跌幅同款的 12px 灰字，窄屏还把
 * 那一整列隐了 —— 于是「今天卖光了」这件事在手机上根本不存在。下面三条锁的是
 * 「看得见」，不是「算得对」。
 */
const { positionTag } = new Function(
  `${extractConst(/const CLOSED_TAG = [^;]+;/, "CLOSED_TAG")}\n`
  + `${extract("positionTag")}\nreturn { positionTag };`)();

// 一条真实形状的清仓：MSTR 基线 12 股、浮盈 2790，窗口内卖光，已实现从 0 跑到
// 3412。本周切片因此是 3412 − 2790 = 622 —— 是这一周的贡献，不是全程收益。
const CLOSED_LIVE = {
  date: "2026-09-18", nav: 100000,
  stocks: { APP: [10, 308.11, 3081, +500] },
  perf: { APP: [0, 0, "S"], MSTR: [3412, 0, "S"] },
};
const CLOSED_BASE = {
  date: "2026-09-11", nav: 97000,
  stocks: { APP: [10, 298.87, 2989, +408], MSTR: [12, 330.00, 3960, +2790] },
  perf: { APP: [0, 0, "S"], MSTR: [0, 0, "S"] },
};

test("清仓行：标签认得出来，但没有涨跌幅可印（徽章独占那一格）", () => {
  const r = Object.fromEntries(
    weeklyDiff(CLOSED_LIVE, [CLOSED_BASE]).rows.map(x => [x.u, x])).MSTR;
  assert.equal(positionTag(r), "清仓");
  // 卖光之后没有「现价」可比，pxPct 只能是 null。所以徽章永远独占 wk-meta，
  // 不会排出「+10.8% · [已清仓]」这种两件事挤一格 —— 窄屏也就不用为它让位。
  assert.equal(r.pxPct, null);
  assert.ok(Math.abs(r.total - 622) < 1e-6, `total=${r.total}`);
});

test("清仓渲染成徽章，不是灰字（源码级 tripwire）", () => {
  assert.match(src, /closed \? `<span class="tag tag-flow-out">已清仓<\/span>`/);
  // 徽章在不在还不够：窄屏豁免认的是这个类名，丢了就又回到手机上看不见。
  // 挂的是 tag 不是 closed —— 加仓/减仓/新建 同样要活过窄屏那刀。
  assert.match(src, /class="wk-meta muted\$\{tag \? " has-tag" : ""\}"/);
});

/* --- 仓位变动幅度 ----------------------------------------------------------
 * 「减仓」只说了股票走了，没说走了一成还是一半 —— 而这两件事一个是修剪、一个
 * 是改主意。百分比按基线股数算，读作「减了 37%」，不是「剩 37%」。
 */
const pos = (qtyBase, qtyNow, extra = {}) =>
  positionTag({ qtyBase, qtyNow, ...extra });

test("减仓/加仓带上幅度，按基线股数算", () => {
  assert.equal(pos(42, 26.46), "减仓 37%");   // 走掉 37%
  assert.equal(pos(10, 15), "加仓 50%");      // 多了一半
  assert.equal(pos(10, 20), "加仓 100%");     // 翻倍 = 加了 100%，不是 200%
});

test("没有分母的不印百分比：新建从零开始", () => {
  assert.equal(pos(0, 10), "新建");
  assert.equal(pos(0, 10000), "新建");
});

test("清仓仍然只给徽章 —— 幅度恒等于 100%，印出来是废话", () => {
  assert.equal(pos(42, 0), "清仓");
});

test("零点几个百分点的抖动不印「减仓 0%」", () => {
  assert.equal(pos(100, 100.2), "加仓");      // +0.2% → 只留词
  assert.equal(pos(100, 99.8), "减仓");
  assert.equal(pos(100, 99.4), "减仓 1%");    // 0.6% → 进位到 1%，开始印
});

test("拆股改的是股数的单位，不是仓位 —— 一个字都不该说", () => {
  assert.equal(pos(12, 36, { splitLike: true }), "");
});

test("纯期权行（两边都是零股）既不报标签也不产生 NaN", () => {
  const t = pos(0, 0);
  assert.equal(t, "");
  assert.ok(!/NaN/.test(t));
});

/* --- 减仓 vs 拆股 ----------------------------------------------------------
 * 「股数比 ≈ 价格比的倒数」这个判据本身分不出二者：一个波动大的票，卖掉一成
 * 半、同期涨一成八，两个比值就能撞进容差里。真正分得开的是已实现盈亏 ——
 * 拆股只是给同一笔仓位换计价单位，没有买也没有卖，动不了它。
 */
function diffOne(sym, base, now) {
  const snap = (date, s) => ({
    date, nav: 100000,
    stocks: { [sym]: [s.qty, s.px, s.qty * s.px, s.unreal] },
    perf: { [sym]: [s.realized, 0, "S"], ...(s.opt || {}) },
  });
  const d = weeklyDiff(snap("2026-09-18", now), [snap("2026-09-11", base)]);
  return d.rows.find(r => r.u === sym);
}

test("误判现场复现：CONL 减了 100 股，不是拆股", () => {
  // U228***83 在 2026-09-18 那一周的真实数字。510/610 = 0.8361，而价格比的
  // 倒数 5.32/6.27 = 0.8485 —— 只差 1.46%，旧判据据此把整行噤声。
  const r = diffOne("CONL",
    { qty: 610, px: 5.32, unreal: 3.40,   realized: -841.86 },
    { qty: 510, px: 6.27, unreal: 664.90, realized: -943.89 });
  assert.ok(!r.splitLike, "卖出 100 股被当成了拆股");
  assert.ok(Math.abs(r.pxPct - 0.178571) < 1e-5, `pxPct=${r.pxPct}`);
  assert.equal(positionTag(r), "减仓 16%");
  // 顺带钉住这一行的总额，和当时截图上的 +$559 对得上：
  // 浮盈 +661.50 与已实现 −102.03 相抵。
  assert.ok(Math.abs(r.total - 559.47) < 1e-6, `total=${r.total}`);
});

test("真拆股仍然认得出来 —— 已实现纹丝不动", () => {
  // 1 拆 2：股数翻倍、价格腰斩、没有任何成交。
  const r = diffOne("XYZ",
    { qty: 100, px: 50, unreal: 500, realized: 0 },
    { qty: 200, px: 25, unreal: 800, realized: 0 });
  assert.equal(r.splitLike, true);
  assert.equal(r.pxPct, null, "拆股不该印 −50%");
  assert.equal(positionTag(r), "", "拆股不该印「加仓 100%」");
});

test("反向拆股同理（10 合 1）", () => {
  const r = diffOne("XYZ",
    { qty: 200, px: 5,  unreal: 300, realized: 0 },
    { qty: 20,  px: 50, unreal: 600, realized: 0 });
  assert.equal(r.splitLike, true);
  assert.equal(positionTag(r), "");
});

test("否决权只归正股：期权腿的已实现不算数", () => {
  // 同一个标的上有一条到期的 put 实现了 +$400。股票一股没动过手，
  // 所以这仍然是拆股 —— 判据读的是 sRealized，不是把期权拌进去的 pnlR。
  const r = diffOne("XYZ",
    { qty: 100, px: 50, unreal: 500, realized: 0, opt: { "XYZ 17JUL26 40 P": [0, 0, "O"] } },
    { qty: 200, px: 25, unreal: 800, realized: 0, opt: { "XYZ 17JUL26 40 P": [400, 0, "O"] } });
  assert.equal(r.splitLike, true, "期权的已实现不该否掉拆股判定");
  assert.equal(positionTag(r), "");
});

test("已知缺口：买入不实现盈亏，所以「翻倍 + 腰斩」仍会被当成拆股", () => {
  // 加仓一倍、同期价格正好腰斩、且没有卖出 —— 快照里没有任何字段能把它和
  // 1 拆 2 分开。留作已知限制：它要两件互相独立的事撞在一起，而减仓那个只
  // 需要一个波动大的票加一次普通卖出。改掉这个行为时，这条会先响。
  const r = diffOne("XYZ",
    { qty: 100, px: 50, unreal: 500, realized: 0 },
    { qty: 200, px: 25, unreal: 800, realized: 0 });
  assert.equal(r.splitLike, true);
});

test("幅度的分母挂在 ⓘ 上 —— 37% 掉 42 股和掉 4 股不是一回事", () => {
  assert.match(src,
    /<span class="wk-tip" title="持仓 \$\{fmtNum\(r\.qtyBase, 2\)\} → \$\{fmtNum\(r\.qtyNow, 2\)\} 股">ⓘ<\/span>/);
  // 清仓行没有「现在多少股」可写，别给它挂一个 → 0.00 股的提示。
  assert.match(src, /const tip = tag && !closed && r\.qtyBase > 1e-9 && r\.qtyNow > 1e-9/);
  // 挂回整条 trailer 就等于没有：原生 tooltip 要静止悬停约一秒，而一段不给
  // 任何暗示的文字没人会停在上面 —— 实测就是这样错过的。钉住那个把手。
  assert.doesNotMatch(src, /class="wk-meta muted\$\{tag \? " has-tag" : ""\}"\$\{tip\}/);
  assert.match(src, /class="wk-meta muted\$\{tag \? " has-tag" : ""\}">/);
});

test("窄屏豁免：整列隐藏时清仓徽章必须留下来", () => {
  const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)),
              "..", "static", "css", "style.css"), "utf8");
  // style.css 里有三个 600px 断点块，按 .wk-row 定位到周复盘那一个。
  const m = css.match(/\.wk-row \{ grid-template-columns: 52px[\s\S]*?\n\}/);
  assert.ok(m, "cannot find the narrow-screen .wk-row block");
  assert.match(m[0], /\.wk-meta \{ display: none; \}/);
  assert.match(m[0], /\.wk-meta\.has-tag \{ display: block;/);
});
