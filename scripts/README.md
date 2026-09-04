# 自动同步 IBKR 报表

> **⚠ bash + cron 路径已弃用。** 自动同步现在由 app 内置调度器完成：在
> `sync.env` 里设 `AUTO_SYNC=daily`（或 `weekly`，可配 `AUTO_SYNC_UTC_HOUR`
> / `AUTO_SYNC_UTC_DAY`），重启容器即可，无需 crontab。它与「刷新 IBKR」
> 按钮走同一条 Python 代码路径：同一把节流锁、同一套 token 脱敏、同一份
> 错误码表（含 1025 锁定识别），且每次尝试的结果显示在 dashboard 顶栏。
> 弃用原因：bash 脚本自带的重试梯子会把临时的 1001 一路重试到被 IBKR
> `1025` 拉黑（见 lesson.md 第 11 条），且从面板上完全看不见。
> 下面的内容仅留档。

`ibkr_sync.sh` 通过 IBKR **Flex Web Service** 拉取你的 Activity Flex Query，
然后 POST 到 dashboard 的 `/api/upload`。

## 一次性配置（在 droplet 上）

```bash
ssh deploy@<your-droplet-ip>   # 用普通用户，别用 root
cd /opt/ibkr-portfolio/scripts
cp sync.env.example sync.env
chmod 600 sync.env
vim sync.env   # 填入 token、query_id、basic auth、域名
```

`ACCOUNTS` 支持多账号，用空格分隔，每对 `TOKEN:QUERY_ID`：
```
ACCOUNTS="aaaaTOKEN1:1111111 bbbbTOKEN2:2222222"
```

## 手动跑一次确认能跑通

```bash
./ibkr_sync.sh
```
正常输出大致是：
```
[…] [111111] requesting statement (query=1111111)…
[…] [111111] ref=1234567890, polling…
[…] [111111] still generating (1/30)…
[…] [111111] downloaded 1472 lines
[…] [111111] uploading to https://your-domain.example/api/upload…
[…] [111111] uploaded OK (200)
[…] all accounts synced
```

## 加到 cron（每周六 16:00 AEST）

为什么是周六下午 16:00 AEST：
- 对应美东周五 01:00–02:00（取决于美国夏令时），美股周五收盘已 8–9 小时
- Realized statement 此时已生成完毕
- IBKR 周末维护窗口通常在美东周六下午开始（≈ AEST 周日凌晨），不会撞车

```bash
crontab -e
```
加一行：
```
0 16 * * 6 /opt/ibkr-portfolio/scripts/ibkr_sync.sh >> /var/log/ibkr_sync.log 2>&1
```

cron 用 droplet 的系统时区。检查 / 切到澳洲：
```bash
timedatectl                                          # 查看当前时区
sudo timedatectl set-timezone Australia/Sydney       # NSW 含夏令时
# 或 Australia/Brisbane                              # QLD 全年 AEST 不调时
```

## 重试机制

IBKR 周末有计划维护窗口（一般 2–4 小时），脚本内置 2 次重试，
分别在首次失败后 **+2 小时** 和 **+4 小时** 重跑，总覆盖约 4 小时。
配置在 `ibkr_sync.sh` 顶部的 `RETRY_DELAYS` 数组。

永久错误（无效 token / 无效 query / 参数错）会立即放弃，不浪费时间重试。
列表在 `PERMANENT_CODES` 变量里。

## 常见问题

- **`Statement generation in progress` 卡很久**: 每次拉取的轮询预算是
  `FLEX_MAX_POLLS × FLEX_POLL_INTERVAL`，默认 120 × 5s = 10 分钟。健康时
  5–15 秒就好；2026-09 起这个 query 连续四次打满 600s 仍是 1019，真实生成
  时间尚未测出，所以默认值是「已知的下限」而不是够用的值。刷新按钮不会因此
  卡住 —— 它拿到 202 就返回，进度走 `/api/refresh/status`。
- **`ErrorCode 1001` Statement could not be generated**: 暂时不可用（维护或
  限流），脚本会自动 backoff 重试，无需手动干预。
- **`ErrorCode 1019` 限流**: 同上，会自动重试。
- **Token 过期（每年一次）**: IBKR 邮件提醒续期，去 Account Management 重新
  生成 token，更新 `sync.env`。
- **403 from upload**: basic auth 写错了，或者哈希在 Caddyfile 里被改了。

## 刷新按钮失败时去哪看细节

`/api/refresh` 会把 IBKR 的**原始响应**记到日志（token 已打码），错误码列表
解释不了的情况就靠它。三个地方都能读到同一份信息：

- 本地：`run-local.ps1` 的终端输出
- droplet：`docker compose logs -f app`
- 浏览器：DevTools → Network → `/api/refresh/status` 响应里 `last.results[].raw`
  （`/api/refresh` 本身只回一个 202，真正的结果在 status 里）

**成功**的那次也会记一行，列出这份报表实际包含哪些 section，例如：

```
[154914] fetched 182304 bytes, sections: NAV[2], OpenPositions[91], CashTransactions[47], StatementOfFunds[210]
```

面板缺数据时先看这行 —— 比如分红是空的，但 section 列表里没有
`CashTransactions` 也没有 `StatementOfFunds`，那就是 Flex Query 没勾，
不是解析器的问题。
