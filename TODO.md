# TODO

排序按优先级从高到低。

---

## [P1] 上传数据管理 — 幽灵账号、旧覆新、手动删除

当前 upload 路径只做「按 account_id overwrite JSON」，没有清理也没有冲突
检测。已经踩到的 / 会踩到的坑：

### 1.1 幽灵账号清理

**问题**：先上传 Flex 多账号 CSV → `uploads/` 同时有 `U17xxx.json` +
`U22xxx.json`。后来只上传 U17 的 Activity Statement → 只覆盖 U17，U22
的 JSON 永远留着，前端切换条还显示 U22 这个「幽灵账号」。

**方案**（任选其一）：
- **手动**：dashboard 上每个账号 tab 加一个 hover 才显示的 `×` 按钮 →
  调 `DELETE /api/accounts/<id>` 删 JSON。最简单。
- **自动**：上传时如果新 payload 里**没有**某个之前存在过的账号，
  保留旧 JSON 但加 `_stale: true` 标记，前端切换条显示成灰色 +
  「最后更新于 YYYY-MM-DD」hint。复杂但温柔。

**推荐手动 + 加确认弹窗**，UI 简单且符合用户心理预期。

### 1.2 旧快照覆盖新快照检测

**问题**：误上传一份旧的 Activity Statement CSV（比如几个月前导出过的）
会**直接覆盖**当前账号的最新数据，无任何提示。

**方案**：upload route 在写盘前对比新旧 `statement.Period` 的截止日期：
- 新 > 旧 → 直接覆盖（正常更新）
- 新 == 旧 → 直接覆盖（重新跑同一份）
- 新 < 旧 → 返回 `{warning: "旧快照覆盖新数据，确认?"}`，前端弹确认框，
  二次确认时带 `?force=true` 重发请求

存储格式不变；只需要解析 Period 字符串里的截止日期做日期比较。

### 1.3 手动删账号 UI

跟 1.1 是同一件事。**优先做这个**，1.1 自动化逻辑可以以后再加。

具体改动：
- `app.py`：加 `DELETE /api/accounts/<account_id>` route，删
  `uploads/<account_id>.json`，返回剩余账号列表
- `dashboard.js`：账号 tab 上加 `×` 按钮（hover 显示），点击弹确认
- 切换条 CSS：button hover 时右上角显出 × 图标

### 文件改动清单
- `app.py` — 新增 DELETE route + 上传时的 Period 对比逻辑
- `templates/dashboard.html`、`static/css/style.css`、`static/js/dashboard.js`
  — × 按钮 + 弹窗 + 「旧覆新」确认 UI

预计 1–1.5 小时。

---

## [P2] 自定义收益率指标（MWR/IRR）

**状态**：基础版已实现（money multiplier 年化），落在 KPI 副标题。
IRR 仍计算但暂不显示（早期资金权重过高 → 数值偏高）。

**背景**：IBKR Activity Flex Query 通过 Web Service 不输出 TWR
字段（只在网页 Statement 里生成），导致自动同步后的数据缺收益率展示。

**已落地**：自己算 **Money Multiplier 年化**作为主指标，IRR 在
`returns.py` 里有但前端不显示。详见 `parser/returns.py` 顶部 docstring。

**还可以做**（未来）：

### 数据来源
Flex CSV 的 `Statement of Funds` section（已勾选）有每笔
deposits/withdrawals 的日期 + 金额，足够建现金流序列。

### 算法
1. 现金流序列 = [(date, -deposit), ..., (today, +EndingNAV)]
2. 用 Newton 迭代解 NPV(r) = 0 → 年化 IRR
3. 如果迭代不收敛、CF 数据不足、或 IRR 离谱（>500% 或 <-100%）
   → 降级 money multiplier: `(NAV - 累计净入金) / 累计净入金`，
   按 (FromDate, ToDate) 期间天数年化

### UI 改动
KPI 总净值卡的副标题：
- 主行: `年化 IRR ~28%`
- hover tooltip: `期间总回报 +$12,500`
- 数据缺失或求解失败: 隐藏，不显示 "—"

### 文件
- `parser/ibkr_flex_csv.py` — 加 `_ingest_statement_of_funds` 抽现金流
- 新建 `parser/returns.py` — IRR solver + fallback 逻辑
- `static/js/dashboard.js` — KPI 副标题切换显示

预计 1.5–2 小时。

---

## [P3] 「刷新 IBKR」网页按钮

**背景**：cron 每周六 16:00 自动同步，但有时想立刻拿最新数据
（市场剧烈波动、周末已过想看周一开盘后情况、调仓后想立刻核对）。
当前唯一方式是 SSH 上 droplet 手动跑 script。加一个网页按钮，
点一下就触发同步。

**前置条件 — 等 cron 自动跑稳定 1–2 周再做**。理由：
现在 cron 还没真在生产环境跑过完整周期，需要先确认
- token 长期有效
- 周六 16:00 IBKR 没维护窗口冲突
- 失败重试 + log 写入实际表现
- 多账号串行同步无并发问题

baseline 稳了再加 web 通道，否则两条链路同时排查更累。

### 实现方案

**B. Python 端独立实现**（不复用 bash 脚本，避免容器化跳板）

- 新建 `parser/flex_fetch.py`：包含 `SendRequest` + 轮询 +
  `GetStatement` 的纯 Python 版，复用 `parse_ibkr_flex_csv`
- 新建 `POST /api/refresh` endpoint：
  - 读 token、query IDs 从 docker env（`env_file: ../scripts/sync.env`）
  - 串行处理每个账号（避免 IBKR 把你当 spam）
  - 同步等待结果（典型 5–30 秒）
  - 返回 `{ok: true, accounts: ["U17456181", "U22846783"]}` 或
    `{error: "1001 throttled, try again in 5 min"}`
- 容器化：`deploy/docker-compose.yml` 加一行
  ```yaml
  services:
    app:
      env_file:
        - ../scripts/sync.env
  ```
  `sync.env` 已经在 `.gitignore` 里，不会进 repo

### UI

`templates/dashboard.html` 顶栏加按钮：
```
[ 上传 CSV / PDF ]   [ ⟳ 刷新 IBKR ]
```

行为：
1. 点击 → disable + spinner
2. 后端响应：
   - 成功 → 绿色 toast「U174 + U228 已更新」+ 自动 `loadPortfolio()`
   - 失败 → 红色 toast 显示 IBKR 错误码 / 错误描述
3. 完成后 button 重新启用

### 后端节流保护

防止手滑连点 + IBKR 把这个 query 拉黑：
- Flask 维护一个全局 `last_refresh_ts`
- 距上次成功 < 5 分钟时直接返回 `{error: "rate limited, wait X seconds"}`
  不打 IBKR API
- bash cron 不受影响（独立进程）

### 决策点

1. **同步 vs 异步**：选**同步**。Caddy 默认 timeout 充裕（120s+），
   IBKR 30s 内回是常态。异步要轮询状态 endpoint，UI 复杂一倍，
   收益不明显。
2. **轮询上限**：跟 bash 一致 — 30 次 × 5 秒 = 2.5 分钟。
   超时回 `{error: "timeout"}`。
3. **是否替代 cron**：不替代。Cron 兜底 + button 即时刷新，
   两条链路并存。

### 文件改动清单

- `parser/flex_fetch.py` ← 新建
- `app.py` ← 加 `/api/refresh` route
- `deploy/docker-compose.yml` ← 加 `env_file`
- `templates/dashboard.html` ← 加按钮
- `static/js/dashboard.js` ← 按钮事件 + toast
- `static/css/style.css` ← spinner + toast 样式

预计 1.5–2 小时。

---

## ~~[P4] 「按标的合并」全账户 IRR~~ ✓ 已完成

合并视图原本对各账户 TWR 做 NAV 加权（数学错误，TWR 不能这样合并），
现在改成：直接把每个账户的 gross_in / net_gain 相加，重算合并版
money multiplier。结果跟 IBKR PortfolioAnalyst 的 consolidated return
差几个百分点（25.5% vs 22.55%），剩余 gap 是 Modified Dietz 时间加权
vs 简单 multiplier 的差异，可接受。

merged view 现在用 NAV 加权平均各账户的 money multiplier，
近似但不精确。严谨做法是把所有账户的现金流序列合并，重解一次 IRR。

低优先 — 平时按账号看就够，「总账户」tab 多是粗略概览。

