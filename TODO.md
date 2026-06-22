# TODO

## 自定义收益率指标（MWR/IRR）

**背景**：IBKR Activity Flex Query 通过 Web Service 不输出 TWR
字段（只在网页 Statement 里生成），导致自动同步后的数据缺收益率展示。

**方案**：自己算 **Money-Weighted Return (MWR / IRR)** 作为主指标，
IRR 求解失败时降级到 **Money Multiplier**。

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
