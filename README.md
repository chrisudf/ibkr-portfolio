# IBKR Portfolio Dashboard

本地处理 Interactive Brokers Activity / Realized Summary 报表（CSV 或 PDF），生成可视化持仓面板。

## 功能
- 上传 IBKR 导出的 **.csv** 或 **.pdf**（建议使用 CSV，解析最准）
- **一键刷新**：直接走 IBKR Flex Web Service 拉最新报表，无需手动导出（需配置 `scripts/sync.env`，见下）
- KPI：总净值 / 股票 / 期权（多空拆分）/ 现金 / 浮动盈亏 / 已实现盈亏 / 收益率
- **持仓地图（Treemap）**：方块面积 = 市值，颜色 = 浮盈/亏，白圈 = 核心持仓，角标 = 超上限 / 欠配
- **核心持仓与仓位区间**：标记哪些标的是核心仓、每个标的敞口占总资产的目标区间
  （下限 / 上限自己填百分比），越界在地图和专门的面板上提醒
- **资产配置条**：现金 / 股票 / 期权 占比
- **股票持仓明细表**：成本、市值、浮盈、回报率、占比
- **期权持仓表**：拆分 Call/Put、多/空、行权价、到期、浮盈
- **保证金占用**：卖出期权占用的 Reg-T 保证金估算、占账户总值比例、按标的拆分
- **分红收入**：报表期间的税前 / 预扣税 / 净分红，按标的与按月拆分
- **已实现盈亏排行榜**：本期盈亏 Top 标的
- **13F 对照**：把持仓跟 Dataroma 追踪的 83 位超级投资者最新一季的买卖动作对起来，三个视角：你的持仓 / 机构在买你没有 / 机构在清你持有

### 关于「13F 对照」的口径

数据是 [Dataroma](https://www.dataroma.com/m/managers.php) 整理的 **Form 13F-HR**，
服务端抓完存在 `uploads/.dataroma_cache.json`，面板右上角「重抓」触发，也可以命令行跑：

```bash
.venv/Scripts/python.exe scripts/fetch_dataroma.py   # Windows
python3 scripts/fetch_dataroma.py                    # droplet
```

**不耗配额** —— Dataroma 是公开页面，没有每日生成限制，多跑一次只是不礼貌，不会有副作用。
这跟 IBKR 那条同步链完全无关，「别手点刷新」那条规矩在这里不适用。一次约 90–150 秒。

**更新节奏是跳变，不是渗出。** 13F 每季一报，**季末后 45 天**截止，落在周末或联邦假日
顺延到下一个工作日。EDGAR 上核过：Berkshire、Lone Pine、Southeastern、Bridgewater 报
Q2 2026 全部落在 **2026-08-14** 当天，Q3 2025 全部落在 2025-11-14 当天 —— 管理人基本
都卡截止日报，所以 Dataroma 的数字是某一天整体换掉的。面板上直接写着下一次截止日；
过了那天 `stale` 会置位，提示可以重抓。陈旧判定按**季度**不按天数：五个月前抓的缓存
在下一个截止日之前是完全当期的，按天数报警只会训练人无视横幅。

**这个数据源结构上看不到的东西**（面板脚注里也写着，这里是给改代码的人看的）：

- 13F 是**季末快照**不是成交流水 —— 季内开了又平的仓永远不出现；
- 披露时已经滞后最多 45 天，到下一次截止前最多滞后 135 天；
- **只报美股多头**。做空、期权义务、债券、非美上市全都没有。本账户 26 张卖方合约的
  风险在这张表里**不存在**，别拿它当风险对照。一个标的在这里没有数据（LITX、ECHO、
  HOOD、各种杠杆 ETF）意味着「13F 看不到」，不是「没人要」，面板渲染成「未覆盖」
  而不是 0。

#### 「净人头」和「机构净股数」是两把尺，故意不合并

**净人头**按管理人数计，权重按动作的强度给：

```
净人头 = 2×建仓 + 1×加仓 − 1×减仓 − 2×清仓
```

从零买进和彻底卖光是**表态**，在已有仓位上加减只是**调整**，所以前者算两票。
拿真实数据验算几行：

| 标的 | 建/加/减/清 | 算式 | 净人头 |
|---|---|---|---|
| PFE | 1 / 5 / 4 / 0 | 2+5−4−0 | **+3** |
| MSFT | 2 / 16 / 16 / 4 | 4+16−16−8 | **−4** |
| NVDA | 1 / 4 / 11 / 2 | 2+4−11−4 | **−9** |
| SOFI | 0 / 1 / 1 / 0 | 0+1−1−0 | **0** |

**机构净股数**则是 (建仓+加仓的股数) − (减仓+清仓的股数)。两者分工：

- **净人头** = 有多少人这么想 —— 意见的**广度**
- **净股数** = 实际多少钱进出 —— 意见的**分量**

**两者相反的时候信息量最大**，Q2 2026 的 Alphabet 就是活教材：GOOG + GOOGL 合并后
41 家在减、5 家清光，净人头 **−38**；但 Berkshire 一家两类合计加了 4,800 万股、
Loeb 把 GOOGL 加了 486%，净股数 **+3,087 万**。**人数上一边倒看空，钱是净流入的。**
合成一个「情绪分」会把这一行报反 —— 所以两列并排放，表格按**股数**排序。

实用读法：问「钱往哪去了」看净股数，问「这是共识还是孤例」看净人头。一个 +2 的净人头
背后可能是一家巨头也可能是两家小基金，净人头分不出来，那正是净股数的活。

两个注脚：①**这不是行业标准指标**，2× 的权重是本项目定的口径，换个倍数排序会微调 ——
适合做相对比较，不适合当绝对数读；②**合并双类股的行，净人头会重复计算**同时持有
GOOG 和 GOOGL 且两边都动的管理人（−38 就有这个问题）。净股数没有这个毛病，这也是
排序走股数的另一个理由。

**A/C 两类股合并。** 13F 把 GOOG 和 GOOGL 分两行报，持有其中一类的人关心的是两类合计，
所以读取时合并，并在标的后面打 `+GOOGL` 角标。名单是 `static/js/f13.js` 里手工维护的
`F13_SHARE_CLASSES`，没用前缀规则（`BRK.B` → `BRK` 会顺手吞掉无关的同词根标的）。

**爬虫的两个坑**（`parser/dataroma.py` 顶部有完整说明，都会安静地产出「看着合理但是错的」
结果，不会报错）：activity 表**每页 100 行封顶**且按动作类型排序，只读第一页会把大盘子的
卖出侧整段丢掉（实测 3,178 行 vs 翻完分页 4,265 行，缺的 1,087 行几乎全是 Reduce/Sell）；
以及数据行**没有 `<tr>` 开标签**，用 `<tr>...</tr>` 配对只能匹配到季度表头、一条数据都拿不到。

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

### 关于「仓位区间」的口径

右上角「核心持仓」按钮里，每个标的三列：**标的**（带当前敞口占比）、**是否核心
持仓**、**仓位区间**（两个输入框，自己填百分比，支持小数）。判定用的敞口是：

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

**规则全局共享，数字按账号算**：一套区间分别套在每本账上 —— 看 U17 时分母是 U17
的净值，切到 U22 整列数字都变，「总账户」页签下算的是合并后的账。所以一个标的
只在另一个账号里持有时，当前账号下会显示 0% 并打「本账号无持仓」标签（跟真的
「已清仓」区分开）。弹窗里的标的列表则是**所有账号**的并集 —— 规则既然全局，
就不该因为你切到了另一个页签而配不了某个标的。

持仓地图上方块的**面积**只是正股市值，而角标算的是正股 + 期权多头，所以主要靠
call 持有的标的可能小方块挂超上限角标，hover 能同时看到两个数。没有正股的标的
根本不在地图上，看「核心持仓与仓位区间」那张表。

区间两端都可以留空，留空按所在位置取一个谁也碰不到的边界：

| 填法 | 含义 |
|---|---|
| `5` – `10` | 低于 5% 报欠配，高于 10% 报超上限 |
| 空 – `10` | 下限按 **0%** 算，只报超上限 |
| `5` – 空 | 上限按 **100%** 算，只报欠配 |
| 空 – 空 | 不参与提醒（勾了核心持仓的话仍然显示，只是不判定） |

**核心持仓不参与判定**，只是热力图上的白圈和这张表的排序优先级 —— 下限既然是
你填出来的，再拿一个勾选框把它关掉，只会让人填了数字却等不到提醒。

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

打开 <http://127.0.0.1:5050/>，上传你的 IBKR 报表。

> **本地实例的刷新按钮默认锁死**（返回 409），哪怕 `sync.env` 已经加载 ——
> 恰恰因为它加载的就是生产那一套凭据。同一个 Flex query 每天大约只放行一次
> 生成，而计划同步已经占住了它：在本地点一次，饿死的是部署实例第二天早上
> 那一次。2026-09-19 就这么丢过一次（本地按钮，距计划拉取 2 小时 58 分，
> 换回一个 1001）。
>
> 按钮由 `ALLOW_MANUAL_REFRESH=1` 解锁，**只应该设在跑计划同步的那个实例上**。
> 本地想看最新数据，从部署实例把 `uploads/*.json` 和 `*.snapshots.jsonl`
> 拷下来就行 —— 不花配额：
>
> ```bash
> for f in U1234567.json U1234567.snapshots.jsonl; do
>   ssh root@your-droplet "cd /opt/ibkr-portfolio/deploy && docker compose exec -T app cat /app/uploads/$f" > uploads/$f
> done
> ```

> 只想上传文件的话，`python app.py` 依然可用 —— 只是刷新按钮会报上面那个错。

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

### 让「周复盘」面板立刻有东西可看

该面板要两条相隔 5–16 天的快照，正常得等一周真实同步才凑得齐。本地验收
UI 时可以伪造一条基线：

```bash
python scripts/seed_snapshot.py seed     # 从当前持仓反推一条 7 天前的基线
python scripts/seed_snapshot.py clean    # 看完删掉
```

基线锚在**报表的 as-of 日期**上，不是今天 —— 面板按报表日期算间隔，用墙上
时钟回退 7 天会因为间隔不足 5 天而选不中。

⚠️ **看完一定要 clean**：留着伪造基线，下次真实刷新会拿真快照去比它，算出
来的周复盘盈亏是错的而且看不出错。`seed` 遇到已存在的快照文件会拒绝覆盖
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
    ├── .position_settings.json   # 核心持仓 / 仓位区间（gitignore）
    └── .auto_sync_state.json     # 自动同步的最近一次结果（gitignore）
```

## 数据安全
所有解析都在本地完成，文件只缓存到 `uploads/`，不发送到任何外部服务。
