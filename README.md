# IBKR Portfolio Dashboard

本地处理 Interactive Brokers Activity / Realized Summary 报表（CSV 或 PDF），生成可视化持仓面板。

## 功能
- 上传 IBKR 导出的 **.csv** 或 **.pdf**（建议使用 CSV，解析最准）
- **一键刷新**：直接走 IBKR Flex Web Service 拉最新报表，无需手动导出（需配置 `scripts/sync.env`，见下）
- KPI：总净值 / 股票 / 期权（多空拆分）/ 现金 / 浮动盈亏 / 已实现盈亏 / 收益率
- **持仓地图（Treemap）**：方块面积 = 市值，颜色 = 浮盈/亏
- **资产配置条**：现金 / 股票 / 期权 占比
- **股票持仓明细表**：成本、市值、浮盈、回报率、占比
- **期权持仓表**：拆分 Call/Put、多/空、行权价、到期、浮盈
- **已实现盈亏排行榜**：本期盈亏 Top 标的

## 首次安装
```bash
cd ~/Desktop/ibkr-portfolio
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
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
├── scripts/
│   ├── run-local.ps1       # 本地启动（加载 sync.env）
│   ├── ibkr_sync.sh        # cron 无人值守同步
│   └── sync.env            # 凭据，gitignore，需自行创建
├── templates/dashboard.html
├── static/css/style.css
├── static/js/dashboard.js  # D3 treemap + 表格渲染
└── uploads/                # 每账户一份解析结果缓存
```

## 数据安全
所有解析都在本地完成，文件只缓存到 `uploads/`，不发送到任何外部服务。
