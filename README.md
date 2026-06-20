# IBKR Portfolio Dashboard

本地处理 Interactive Brokers Activity / Realized Summary 报表（CSV 或 PDF），生成可视化持仓面板。

## 功能
- 上传 IBKR 导出的 **.csv** 或 **.pdf**（建议使用 CSV，解析最准）
- KPI：总净值 / 股票 / 期权（多空拆分）/ 现金 / 浮动盈亏 / 已实现盈亏 / 时间加权收益率
- **持仓地图（Treemap）**：方块面积 = 市值，颜色 = 浮盈/亏
- **资产配置条**：现金 / 股票 / 期权 占比
- **股票持仓明细表**：成本、市值、浮盈、回报率、占比
- **期权持仓表**：拆分 Call/Put、多/空、行权价、到期、浮盈
- **已实现盈亏排行榜**：本期盈亏 Top 标的

## 启动
```bash
cd ~/Desktop/ibkr-portfolio
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```
打开 <http://127.0.0.1:5050/>，点击右上角上传你的 IBKR 报表。

## 文件结构
```
ibkr-portfolio/
├── app.py                  # Flask 入口
├── parser/
│   ├── ibkr_csv.py         # CSV 解析
│   └── ibkr_pdf.py         # PDF 解析（基于 pdfplumber）
├── templates/dashboard.html
├── static/css/style.css
├── static/js/dashboard.js  # D3 treemap + 表格渲染
└── uploads/                # 最近一次解析结果缓存
```

## 数据安全
所有解析都在本地完成，文件只缓存到 `uploads/`，不发送到任何外部服务。
