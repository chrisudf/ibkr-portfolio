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

## [P2] 净值曲线 —— 注资期的现金流与 NAV 行对不上，TWR/波动仍不可信

`fundedSeries()` 裁掉了注资前的残根（$0 / $0.65 那几天），把 U228 从
`TWR −99.1% / maxDD −99.5%` 拉回了合理区间。**但注资爬坡期本身还没解决**，
覆盖 2025-11 的窗口，U228 和总账户的 TWR / 年化波动都不能当真。

### 证据：起点敏感性

把 U228 的序列起点逐日往后推，重算 `navStats`：

| 起点 | 年化 TWR | 年化波动 |
|---|---|---|
| 2025-11-14 | 117.2% | 88.9% |
| 2025-11-17 | **205.7%** | 84.9% |
| 2025-11-21 | 214.4% | 85.7% |
| 2025-12-02 | **81.5%** | **45.2%** |
| 2025-12-12 | 82.9% | 46.0% |

少算一天跳 88pp，跨过 11 月底波动直接腰斩 —— 说明 11-14 ~ 12-01 之间有
几个链节在主导整条链的均值和方差。12-02 之后数字才稳定。

### 成因（原列两条，2026-08-28 真 CSV 裁决后合并为一条；都在 11 月）

**1. 记账日（电汇发起日）≠ 入账日（NAV 反映日）。** `navStats` 用 begin-of-day 约定
（`denom = 前一日 NAV + 区间内入金`），但 IBKR 把现金流记在电汇**发起**日、当天的
NAV 行却还没反映它，钱落账后才涨上去（下表是滞后 1 天的两个链节）：

| 链节 | NAV | 计入入金 | r |
|---|---|---|---|
| 11-14 → 11-17 | $29,413 → $29,224 | $8,904 | **−23.7%** |
| 11-27 → 11-28 | $101,245 → $101,913 | $14,205 | **−11.7%** |

一负一正成对出现，乘积大致抵消，但**方差被拉爆** —— 这就是波动 85% vs 45%
的来源。已有的 `if (r < -0.99) r = -0.99` 只挡住符号翻转，挡不住这个。
（补一句实测更正：滞后不是「一天」——见成因 2 的破案，实测 −1 ~ +14 天，
一轮注资还会拆成多笔错峰到账。−99.1% 被按死的真实机制正在于此：每个
到账日链环的分母里都有当日新记账的入金，镜像反弹从不成形，一条 clamp
链环就把链条钉在 ×0.01。）

边界子案例（**不抵消的水平误差**，不只是方差）：一笔流水日期**恰好等于**
裁剪后序列的首点、NAV 次日才反映时，`navStats` 的起始本金跳过
（`date <= pts[0].date`）会把它整笔吞掉——首点 NAV 里根本没有这笔钱，
下一链环把入金全额记成收益。按首日 \$29,413 的基数，\$8,904 那笔要是
被吞就是 +30% 的假涨幅，永久乘进链条，clamp（只有下限）拦不住。
真实数据差一天躲过：该笔实际落在窗内，打出的是上表 −23.7% 的成对失真。

同族残留（`fundedSeries` 的裁剪护不到的，都是「流水挂在极小前日 NAV 上」
这一个病）：**中途崩盘后再注资** —— 裁剪只护序列开头，中途跌剩的小基数是
真实事件被保留，大额再注资挂上去照样触发 −0.99 clamp、亏损被永久低估；
以及**从未在任何 NAV 行印出来的入金**（当天穿仓、或隔日原路退回的过路
电汇）。都归本节的日期重对齐一并处理。

**2. ~~有一笔约 $39.5k 的流入根本不在 `cash_flows` 里~~ 已破案（2026-08-28，
真 CSV 逐笔核对）：三笔在途电汇 11-27 集中到账，成因与 1 是同一个病。**

```
11-26 → 11-27   NAV $48,660 → $101,245  (+$52,585)   计入入金只有 $13,068   r = +64.0%
```

SoF 原始行显示当天到账（`ReportDate` = 11-27）的其实是**四**笔：
\$13,068.20（记账 11-27）+ \$16,335.25（记账 11-13，**在途 +14 天**）+
\$8,904.49（记账 11-17，+10 天）+ \$14,204.93（记账 11-28，**−1 天**，
前一晚入账），合计 \$52,512.87，加当日 P&L +\$71 = +\$52,584 ✓。
「缺失的 \$39.5k」全部都在 `cash_flows` 里，只是记账日（SoF `Date`，
电汇发起日）≠ 入账日（`ReportDate`，每行现成就有、与 NAV 区块同框架）。
不是 ACATS，不需要 Transfers section。全账户对账：11-28 前记账入金合计
\$98,195.77，11-28 NAV \$101,912.73，隐含累计 P&L +\$3,717，自洽。

### 修法（待办）

- **日期错配（成因 1 与 2 是同一个病，一并治）**：不用按 `NAV_i − NAV_{i−1}`
  差值猜要不要顺延——现成根治已离线交付：本机
  `~/Desktop/ibkr-portfolio-navcurve-patches/` 的 **0001**（现金流按 SoF 的
  `ReportDate`（入账日）记账；其实测结论「滞后 −1 ~ +14 天、电汇在途两周」
  已被本次破案独立复证，按差值猜一天根本不够）和 **0002**（原则：TWR 链
  永远不改写，错位只检测+隐藏统计）。基座是 08-23 的 main，需 rebase 后
  apply，apply 后重新「刷新 IBKR」按新口径重记流水。2026-08-28 已拿真
  CSV 验证：每笔流水单条记录、无双日期双计，重对齐**不需要**去重。
  上面「起始本金跳过」的 `<=` 边界也随重对齐一起消失：按入账日分桶后，
  「日期 ≤ 首点 ⇒ 已含在首点 NAV 里」才真正成立。

### 影响面

只影响**账户注资爬坡期**在窗口内的情况。U174 全程都是注资完成后的状态，
262 个点一个没被裁，数字（TWR 35.9% / maxDD −29.3%）本来就是对的 ——
可以拿它当回归基准。

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

## ~~[P3] 「刷新 IBKR」网页按钮~~ ✓ 已完成

已按下面的方案 B 落地：`parser/flex_fetch.py` + `POST /api/refresh` + 顶栏按钮
+ 5 分钟节流。后来又补了失败时记录 IBKR 原始响应、成功时记录报表 section
列表（见 `scripts/README.md` 的「刷新按钮失败时去哪看细节」）。以下为原始方案，留档。

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

---

## [P5] 分红 / 现金流跨报表累积 —— upload 改成按 id 合并

**问题**：分红面板只能显示 Flex Query 期间内的数据（现在是 Last 365
Calendar Days），再往前就没了。而且这**不是改 query 期间就能解决的** ——
`/api/upload` 是整份覆盖（`app.py` `_save_accounts` → `os.replace`），
手动拉一份更早年份的报表传上去，结果是把当前这份顶掉，而不是拼成两年。

跟 1.2「旧快照覆盖新快照检测」是同一个病根：写盘逻辑里没有「合并」这个概念。

**地基已经有了** —— 去重键是 IBKR 的 TransactionID：
- 现金流：`cash_flows[].id` 存成 `txn:<TransactionID>`（缺列时降级 `synth:`）
- 分红：`_dividend_id()` 用同一套键，重叠期间不会双算

**缺的两块**：
1. 分红 event 现在**没把 id 存进 JSON**（只有 date/symbol/kind/amount/
   per_share/description），现金流那边有。先补上，否则合并时无键可依
2. upload / refresh 写盘前先读旧 JSON，按 id 取并集，再从全集重算
   `by_symbol` / `by_month` / `cost_history` / IRR

**顺带收益**：`cost_history` 的 `covered` 判定会跟着变好 —— 窗口越长，
建仓记录落在窗口内的清仓标的越多，能重建成本的也就越多。

**注意，不是所有字段都能合并**：
- NAV / OpenPositions / 期间 TWR 是**快照**，永远取最新那份，不能相加
- 只有事件流（cash_flows、dividends.events）能取并集
- 合并后 `statement.Period` 要改成实际覆盖的最早 → 最晚，不能照抄其中一份

### 文件改动清单
- `parser/ibkr_flex_csv.py` — `_ingest_dividend_row` 把 id 存进 event
- `app.py` — `_save_accounts` 改成 merge-then-write
- 新建 `parser/merge.py` — 快照取新 / 事件取并集

预计 1–2 小时。

---

## [P6] 真正的 consolidated Modified Dietz / IRR

当前合并视图用 sum gross_in + sum net_gain 算 money multiplier，
得到 25.49% — 跟 IBKR PortfolioAnalyst 的 22.55% 差 ~3 个百分点。

差距来源：simple multiplier 不按时间加权现金流，而 IBKR 用 Modified
Dietz / TWR 给每笔现金流按 `(T-t)/T` 加权。对像 U228 这种半路加入
（11 月才砸 $109k）的账户，我们会**轻微高估**合并回报率，因为把
后期资金也摊到全年分母里算。

**对单账户也有影响**：U228 money multiplier 35% < IBKR TWR 42%
（dashboard 单账户视角现在显示 IBKR TWR，没问题；但合并视角拿不到
TWR 这种东西）。

### 实现思路

1. `parser/ibkr_flex_csv.py` 别在 finalize 时 strip 掉 `_cash_flows`
   —— 保留每个账户的现金流序列在 JSON 里（带日期）
2. `mergeAccounts` 把所有账户的现金流 concat 成单一序列：
   - 起始：每个账户的 `(start_date, -starting_value)`
   - 中间：每笔 `(date, signed_amount)`
   - 终点：每个账户的 `(end_date, +ending_NAV)` 合成
     `(common_end_date, +total_ending_NAV)`
3. 调 `parser/returns.py` 已有的 `compute_irr()` 求解器
4. 失败降级到当前的 simple multiplier（保留作 fallback）

### 工作量
- parser 改动：不 strip cash_flows（1 行）
- mergeAccounts：~20 行 JS（cashflow 拼接 + 调 IRR）
- 但 IRR solver 现在是 Python，得在 JS 端再写一个 Newton's method 实现
  （或者新增 `POST /api/merged-return` 后端算，UI 异步取）

后端算更稳。30–45 分钟。

### 决策点

- 收益：合并视图数字跟 IBKR PortfolioAnalyst 对齐到小数点
- 代价：JSON 文件变大（每个账户多存现金流序列，几 KB）
- 推荐：等其他 P1–P3 做完再做。3 个点的偏差，对我们这种自用面板
  够用了。

merged view 现在用 NAV 加权平均各账户的 money multiplier，
近似但不精确。严谨做法是把所有账户的现金流序列合并，重解一次 IRR。

低优先 — 平时按账号看就够，「总账户」tab 多是粗略概览。

