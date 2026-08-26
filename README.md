# IBKR Portfolio Dashboard

本地处理 Interactive Brokers Activity / Realized Summary 报表（CSV 或 PDF），生成可视化持仓面板。

## 功能
- 上传 IBKR 导出的 **.csv** 或 **.pdf**（建议使用 CSV，解析最准）
- **一键刷新**：直接走 IBKR Flex Web Service 拉最新报表，无需手动导出（需配置 `scripts/sync.env`，见下）
- KPI：总净值 / 股票 / 期权（多空拆分）/ 现金 / 浮动盈亏 / 已实现盈亏 / 收益率
- **持仓地图（Treemap）**：方块面积 = 市值，颜色 = 浮盈/亏，白圈 = 核心持仓，角标 = 超上限 / 欠配
- **核心持仓与仓位上限**：标记哪些标的是核心仓、每个标的敞口占总资产的上限（5% / 10% / 20%），
  越界在地图和专门的面板上提醒
- **资产配置条**：现金 / 股票 / 期权 占比
- **股票持仓明细表**：成本、市值、浮盈、回报率、占比
- **期权持仓表**：拆分 Call/Put、多/空、行权价、到期、浮盈
- **保证金占用**：卖出期权占用的 Reg-T 保证金估算、占账户总值比例、按标的拆分
- **分红收入**：报表期间的税前 / 预扣税 / 净分红，按标的与按月拆分
- **已实现盈亏排行榜**：本期盈亏 Top 标的

### 关于「保证金占用」的口径

IBKR 的 Flex Web Service **不导出**任何保证金字段（真实数字只在 TWS 和网页版
Activity Statement 里），所以这一栏是**按持仓反推的 Reg-T 估算**，不是 IBKR 的
实际 margin 数字。单张裸卖合约每股要求：

```
put  → max(20% × 正股价 − 价外幅度, 10% × 行权价,  $2.50) + 当前权利金市值
call → max(20% × 正股价 − 价外幅度, 10% × 正股价,  $2.50) + 当前权利金市值
```

有正股覆盖的 covered call 不占保证金。**按整张判定**：一张 call 要有满一份
交割量的正股才算 covered，凑不满就是整张裸卖，不按股摊薄。交割量取自报表的
`Multiplier` / `Mult` 列 —— 标准美股期权是 100 股（80 股 + 1 张 call 在
Reg-T 下是整张裸卖），但拆股/并股调整后的合约可能是别的数（乘数 10 的合约
10 股就足以覆盖）。买入期权已付全额权利金，也不占。

**没建模的**：垂直价差（同标的同到期的多空组合）按裸卖计算，会明显高估 ——
Reg-T 下价差的风险以最大价差损失封顶。当前持仓里没有价差（多头都是不同
标的/到期的 LEAPS call），所以暂不影响；真开始做价差了这栏要重做。正股价取
自当前持仓（跨账户共用，价格是市场事实不是账户数据）；如果某个标的完全没有持仓，
按平值（正股价 = 行权价）估算，面板上会标出有多少张合约走了这条路径。

### 关于「仓位上限」的口径

右上角「核心持仓」按钮里，每个标的两个开关：**是否核心持仓**、**仓位上限**
（占总资产 5% / 10% / 20%，默认「不限」= 不参与提醒）。判定用的敞口是：

```
正股市值 + 期权多头市值
```

也就是**实际投进这个标的的资本**。期权多头按**市值**而不是名义计入（一张
LEAPS call 按 strike × 100 会虚报成实际投入资金的好几倍）。卖方期权两边都不计：
卖 put 本身没有投入资本（担保金已经算在现金里），卖 call 压的是上面已经算过的
正股的上涨空间。

所以**只卖 put、没有正股的标的在这里是 0%** —— 那是定义本身，不是漏算。
被行权风险是另一个问题，「保证金占用」和「卖方到期日历」两张表管它；面板上
这类标的打「仅卖方期权」标签，跟真的清仓了区分开。

分母是**全部账户合并**的总净值，跟你在哪个账号 tab 上看无关 ——「占总资产 5%」
说的是整本账，一个标的分散在两个账号里不该读成两个安逸的半仓。注意持仓地图上
方块的**面积**仍然是当前账号的正股市值，所以小方块也可能挂超上限角标，
hover 能同时看到两个数。没有正股的标的根本不在地图上，看
「核心持仓与仓位上限」那张表。

- **超上限**（weight > 上限）：核心与否都报 —— 上限就是上限。
- **欠配**（weight < 上限 ÷ 2）：**只对核心持仓**报。正在减的仓本来就该缩，
  报它只会让人学会无视这张表。目标区间 `[上限 ÷ 2, 上限]` 从上限推出来，
  是为了只问一个数字；比例写在 `dashboard.js` 的 `CORE_FLOOR_RATIO`。

规则存在服务器上（`uploads/.position_settings.json`，gitignore，docker 下在
`app_data` 卷里），不是浏览器 localStorage —— 同一个面板从手机和电脑都会开，
配置按浏览器各自一份的话，两边的角标会说不一样的话。文件名的点开头是必需的：
`uploads/*.json` 是账号扫描的范围，不带点会被当成一个幽灵账号显示在切换条上。

### 分红数据的前置条件

分红读的是 Flex Query 里的 **Cash Transactions**（推荐，含 Dividends /
Payment In Lieu / Withholding Tax）或 **Statement of Funds**（ActivityCode
DIV / PIL / FRTAX）。两个都勾也不会重复计算 —— 解析器只认其中一个来源。
如果一个都没勾，面板会显示提示而不是空白。统计窗口 = Flex Query 的报表期间
（比如 "Last 365 Calendar Days"），不是开户至今。

Cash Transactions 至少要选到这几列，否则 section 认不出来或者标的会并成「—」：

| 列 | 作用 |
|---|---|
| `ClientAccountID` | 分段 + 归账号，必需 |
| `Type` + `Amount` | 识别 section 用，必需 |
| `SettleDate` 或 `Date/Time` | 任选其一即可（真实输出里是带斜杠的 `Date/Time`）|
| `Symbol` 或 `Description` | 没有的话所有分红并到「—」 |
| `TransactionID` | 去重用，强烈建议 |

预扣税只认**能归到某个标的**的那些。IBKR 把「信用利息的预扣税」也归在
`Withholding Tax` 类型下（描述形如 `WITHHOLDING @ 10% ON CREDIT INT FOR
NOV-2025`，Symbol 为空），那不是分红税；算进来会虚增税负、压低净分红。所以
没有标的的预扣税行会被跳过 —— 跟 IBKR 报表对账时数字对不上，多半是这个差异。

⚠️ 别开这两个开关，会直接把解析器打挂：**Include section code and line
descriptor**（第一列会变成 section code，解析器靠字面量 `ClientAccountID`
分段）和 **Display single column header row**（多 section 会塌成一个表头）。

## 首次安装
```bash
cd ~/Desktop/ibkr-portfolio
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

跑测试还需要 pytest（`requirements-dev.txt` = 上面那份 + pytest）：
```bash
pip install -r requirements-dev.txt
```

## 启动

**刷新按钮依赖环境变量，直接 `python app.py` 起不会加载它们。** `/api/refresh`
在请求时读 `ACCOUNTS`，进程里没有就返回
`ACCOUNTS env var not configured on server`。所以除非你只打算手动上传文件，
否则用下面的启动脚本，别直接跑 `python app.py`。

Windows（PowerShell，在仓库根目录）：
```powershell
.\scripts\run-local.ps1
```

macOS / Linux：
```bash
set -a && . scripts/sync.env && set +a && python app.py
```

两者都是先把 `scripts/sync.env` 里的变量灌进环境再起 Flask。
`sync.env` 的格式见 `scripts/sync.env.example`，配置说明见
[`scripts/README.md`](scripts/README.md)。

打开 <http://127.0.0.1:5050/>，点右上角刷新按钮拉取，或上传你的 IBKR 报表。

> 只想上传文件、不用刷新按钮的话，`python app.py` 依然可用 —— 只是刷新按钮会报上面那个错。

## 测试

解析器的回归测试用内置的 CSV 夹具，不连 IBKR、不碰 `uploads/`：
```bash
python -m pytest tests/ -q
```

注意用**虚拟环境里**的解释器 —— Windows 上直接敲 `python` 很可能打到系统
Python，那边没装依赖：
```powershell
.\.venv\Scripts\python.exe -m pytest tests/ -q
```

`tests/test_parsers.py` 锁的是保证金口径、分红去重 / 多币种、成本股息率的
时间基准这些容易悄悄回退的地方 —— 改 `parser/` 或 `app.py` 之前先跑一遍。
`tests/test_app_features.py` 覆盖快照留存与自动同步的调度判定。

### 让「本周复盘」立刻有东西可看

该面板要两条相隔 5–16 天的快照，正常得等一周真实同步才凑得齐。本地验收
UI 时可以伪造一条基线：

```bash
python scripts/seed_snapshot.py seed     # 从当前持仓反推一条 7 天前的基线
python scripts/seed_snapshot.py clean    # 看完删掉
```

基线锚在**报表的 as-of 日期**上，不是今天 —— 面板按报表日期算间隔，用墙上
时钟回退 7 天会因为间隔不足 5 天而选不中。

⚠️ **看完一定要 clean**：留着伪造基线，下次真实刷新会拿真快照去比它，算出
来的「本周盈亏」是错的而且看不出错。`seed` 遇到已存在的快照文件会拒绝覆盖
（真实快照是攒出来的，覆盖了回不来），确认可丢弃再加 `--force`。

## 文件结构
```
ibkr-portfolio/
├── app.py                  # Flask 入口
├── parser/
│   ├── ibkr_csv.py         # 手动导出的 Activity Statement CSV 解析
│   ├── ibkr_flex_csv.py    # Flex Web Service CSV 解析（多账户多 section）
│   ├── ibkr_pdf.py         # PDF 解析（基于 pdfplumber）
│   ├── flex_fetch.py       # 刷新按钮走的 Flex API 拉取
│   └── returns.py          # IRR / 年化回报率计算
├── tests/test_parsers.py   # 解析器回归测试（pytest，CSV 夹具）
├── scripts/
│   ├── run-local.ps1       # 本地启动（加载 sync.env）
│   ├── ibkr_sync.sh        # cron 无人值守同步
│   └── sync.env            # 凭据，gitignore，需自行创建
├── templates/dashboard.html
├── static/css/style.css
├── static/js/dashboard.js  # D3 treemap + 表格渲染
└── uploads/                # 每账户一份解析结果缓存
    ├── .position_settings.json   # 核心持仓 / 仓位上限（gitignore）
    └── .auto_sync_state.json     # 自动同步的最近一次结果（gitignore）
```

## 数据安全
所有解析都在本地完成，文件只缓存到 `uploads/`，不发送到任何外部服务。
