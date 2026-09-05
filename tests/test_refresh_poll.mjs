// 异步刷新的前端收尾逻辑 —— node --test tests/test_refresh_poll.mjs
//
// dashboard.js 没有模块导出，沿用 test_funded_series.mjs 的做法按源码正则
// 抽函数。这里的被测函数不纯（fetch / DOM / 模块级 let），所以整段塞进
// new Function，把依赖全部换成可观测的 stub，模块级 let 在前缀里先声明。
// 抽取对 async function 也放行 —— pollRefreshStatus / refreshFromIBKR 都是。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)),
            "..", "static", "js", "dashboard.js"),
  "utf8");

// 顶层 const 箭头函数（parsePeriodBounds / MONTH_NUM）走这个 —— extract()
// 只认 function 声明。两者都以行首的 `};` 收尾。
function extractConst(name) {
  const m = src.match(new RegExp(`^const ${name} = [\\s\\S]*?\\n\\};`, "m"));
  if (!m) throw new Error(`cannot extract const ${name} from dashboard.js`);
  return m[0];
}

function extract(name) {
  const m = src.match(new RegExp(
    `^(?:async )?function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"));
  if (!m) throw new Error(`cannot extract function ${name} from dashboard.js`);
  return m[0];
}

// ---- pollRefreshStatus 的沙箱 ----------------------------------------------
// reportRefreshOutcome 用真的（它是播报口径本身），showToast/loadPortfolio/
// setRefreshBusy 记录调用，fetch 喂一份固定的 /api/refresh/status 应答。
function pollSandbox({ status, tracked, loadRejects = false }) {
  const calls = { toasts: [], loads: 0, busy: [], timers: 0 };
  const stubs = {
    fetch: async () => ({ json: async () => status }),
    showToast: (kind, title, detail) => calls.toasts.push({ kind, title, detail: detail || "" }),
    loadPortfolio: async () => {
      calls.loads += 1;
      if (loadRejects) throw new TypeError("Failed to fetch");
    },
    setRefreshBusy: (busy, label) => calls.busy.push({ busy, label }),
    setTimeout: () => { calls.timers += 1; return 0; },
    clearTimeout: () => {},
  };
  const build = new Function("stubs", `
    const { fetch, showToast, loadPortfolio, setRefreshBusy,
            setTimeout, clearTimeout } = stubs;
    let refreshPollTimer = null;
    let trackedRunId = ${JSON.stringify(tracked)};
    let refreshPollGen = 0;
    ${extract("fmtElapsed")}
    ${extract("reportRefreshOutcome")}
    ${extract("pollRefreshStatus")}
    return { run: pollRefreshStatus, tracked: () => trackedRunId };
  `);
  return { ...build(stubs), calls };
}

const okPass = (runId) => ({
  in_progress: false,
  last: { run_id: runId, ok: true, results: [{ tag: "a", ok: true, accounts: ["U111"] }] },
});
const failedPass = (runId) => ({
  in_progress: false,
  last: { run_id: runId, ok: false, results: [{ tag: "a", ok: false, error: "1019" }] },
});

test("自己跟到底的 run 成功：播报 + 重取 portfolio", async () => {
  const s = pollSandbox({ status: okPass(7), tracked: 7 });
  await s.run();
  assert.equal(s.calls.loads, 1);
  assert.equal(s.calls.toasts[0].title, "已更新");
  assert.equal(s.tracked(), null);
});

test("tab 睡过头、自己的 run 已被调度器盖过（run_id 更大）：仍然重取", async () => {
  // 承诺是「可以关掉页面，回来还能看到进度」——回来看到刷新前的旧数字
  // 就是违约。gate 是「不早于」，不是「恰好等于」。
  const s = pollSandbox({ status: okPass(8), tracked: 7 });
  await s.run();
  assert.equal(s.calls.loads, 1);
});

test("全失败的 pass 也要重取：表头 ✗ 和告警条读的 sync 状态只有 loadPortfolio 会刷新", async () => {
  const s = pollSandbox({ status: failedPass(7), tracked: 7 });
  await s.run();
  assert.equal(s.calls.toasts[0].title, "同步失败");
  assert.equal(s.calls.loads, 1);
});

test("loadPortfolio 挂了：收进 error toast，绝不留一个绿色已更新盖在旧数字上", async () => {
  const s = pollSandbox({ status: okPass(7), tracked: 7, loadRejects: true });
  await s.run();   // 没被捕获的话这里直接 rejection
  assert.ok(s.calls.toasts.some((t) => t.title === "页面数据刷新失败"));
});

test("没跟任何 run：不播报、不重取——reload 不该把旧结果当新闻重播", async () => {
  const s = pollSandbox({ status: okPass(7), tracked: null });
  await s.run();
  assert.equal(s.calls.loads, 0);
  assert.equal(s.calls.toasts.length, 0);
});

test("服务器重启后 run_id 回卷（last 比 tracked 旧）：静默", async () => {
  const s = pollSandbox({ status: okPass(1), tracked: 7 });
  await s.run();
  assert.equal(s.calls.loads, 0);
  assert.equal(s.calls.toasts.length, 0);
});

test("在飞的 pass 被领养：busy label + 续约下一次 poll", async () => {
  const s = pollSandbox({
    status: { in_progress: true, run_id: 5, trigger: "auto", elapsed_sec: 34 },
    tracked: null,
  });
  await s.run();
  assert.equal(s.tracked(), 5);
  assert.equal(s.calls.timers, 1);
  const busy = s.calls.busy.at(-1);
  assert.equal(busy.busy, true);
  assert.match(busy.label, /自动同步/);
});

// ---- refreshFromIBKR 的 429 分支 -------------------------------------------
function buttonSandbox(response) {
  const calls = { toasts: [], busy: [], polls: 0 };
  const stubs = {
    $: () => ({ disabled: false }),
    fetch: async () => ({ status: response.status, json: async () => response.body }),
    showToast: (kind, title, detail) => calls.toasts.push({ kind, title, detail: detail || "" }),
    setRefreshBusy: (busy, label) => calls.busy.push({ busy, label }),
    pollRefreshStatus: () => { calls.polls += 1; },
  };
  const build = new Function("stubs", `
    const { $, fetch, showToast, setRefreshBusy, pollRefreshStatus } = stubs;
    let trackedRunId = null;
    ${extract("fmtElapsed")}
    ${extract("refreshFromIBKR")}
    return { run: refreshFromIBKR, tracked: () => trackedRunId };
  `);
  return { ...build(stubs), calls };
}

test("429 already-in-progress：领养在飞的 pass，而不是在一场活同步旁边装 idle", async () => {
  const s = buttonSandbox({
    status: 429, body: { error: "refresh already in progress", run_id: 42 },
  });
  await s.run();
  assert.equal(s.tracked(), 42);
  assert.equal(s.calls.polls, 1);
  // 按钮保持 busy —— 只有开头那一次 setRefreshBusy(true)，没有回落。
  assert.deepEqual(s.calls.busy.map((b) => b.busy), [true]);
});

test("429 too-soon（带 retry_after_sec）：真的要等，不领养", async () => {
  const s = buttonSandbox({
    status: 429, body: { error: "too soon — wait 120s", retry_after_sec: 120 },
  });
  await s.run();
  assert.equal(s.tracked(), null);
  assert.equal(s.calls.polls, 0);
  assert.equal(s.calls.busy.at(-1).busy, false);
  assert.equal(s.calls.toasts[0].title, "请稍后再试");
});


// ---- 并发 poll 的单飞保护 ---------------------------------------------------
// clearTimeout 只能取消一个待触发的 timer，取消不了已经发出去的请求。页面加载
// 的 resume 和一次按钮点击可以各自起一条 poll 链，晚到的那份 in_progress 会把
// 已经结束的 run 重新领养回来。
function racePollSandbox({ responses, tracked }) {
  const calls = { toasts: [], loads: 0, busy: [], timers: 0 };
  let n = 0;
  const stubs = {
    fetch: async () => {
      const { body, delayMs } = responses[Math.min(n++, responses.length - 1)];
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { json: async () => body };
    },
    showToast: (kind, title, detail) => calls.toasts.push({ kind, title, detail: detail || "" }),
    loadPortfolio: async () => { calls.loads += 1; },
    setRefreshBusy: (busy, label) => calls.busy.push({ busy, label }),
    setTimeout: () => { calls.timers += 1; return 0; },
    clearTimeout: () => {},
  };
  const build = new Function("stubs", `
    const { fetch, showToast, loadPortfolio, setRefreshBusy,
            setTimeout, clearTimeout } = stubs;
    let refreshPollTimer = null;
    let trackedRunId = ${JSON.stringify(tracked)};
    let refreshPollGen = 0;
    ${extract("fmtElapsed")}
    ${extract("reportRefreshOutcome")}
    ${extract("pollRefreshStatus")}
    return { run: pollRefreshStatus, tracked: () => trackedRunId };
  `);
  return { ...build(stubs), calls };
}

test("晚到的 in_progress 应答被丢掉：不复活 spinner，也不把完成态播报两次", async () => {
  const s = racePollSandbox({
    tracked: 5,
    responses: [
      // 先发出、后返回的那一份：还在飞。
      { body: { in_progress: true, run_id: 5, trigger: "auto", elapsed_sec: 10 }, delayMs: 40 },
      // 后发出、先返回的那一份：已经结束。
      { body: okPass(5), delayMs: 0 },
    ],
  });
  const stale = s.run();          // gen 1
  const fresh = s.run();          // gen 2，先落地
  await Promise.all([stale, fresh]);

  assert.equal(s.calls.loads, 1, "完成态只该被处理一次");
  assert.equal(s.calls.toasts.filter((t) => t.title === "已更新").length, 1);
  // 晚到的 in_progress 不得把按钮重新按成忙碌，也不得把 trackedRunId 改回去。
  assert.equal(s.calls.busy.at(-1).busy, false);
  assert.equal(s.tracked(), null);
});

// ---- 合并视图的 as-of ------------------------------------------------------
test("合并视图取最旧的 as-of —— 新账号不该把陈旧的那个挡住", () => {
  const build = new Function(`
    ${extractConst("MONTH_NUM")}
    ${extractConst("parsePeriodBounds")}
    ${extract("oldestPeriodEnd")}
    return oldestPeriodEnd;
  `);
  const oldestPeriodEnd = build();

  assert.deepEqual(oldestPeriodEnd("2025-08-29 → 2026-08-28"), { y: 2026, m: 8, d: 28 });
  // mergeAccounts 把不同的期间用 " / " 连起来，而 parsePeriodBounds 只返回第一
  // 个匹配 —— 直接用它，刚同步好的那个账号会把陈旧的那个藏起来，而合并 NAV
  // 本来就被截到最旧的那个账号上。
  assert.deepEqual(
    oldestPeriodEnd("2025-09-05 → 2026-09-04 / 2025-08-29 → 2026-08-28"),
    { y: 2026, m: 8, d: 28 }, "第一段是新的，仍要报出旧的那一段");
  // Activity 上传的写法也要认，否则这类报表整条 banner 静默失效。
  assert.deepEqual(oldestPeriodEnd("January 1, 2026 - June 30, 2026"), { y: 2026, m: 6, d: 30 });
  // 读不出两个日期的兜底期间：不猜，交给 banner 跳过这一半。
  assert.equal(oldestPeriodEnd("截至 2026-08-28"), null);
});
