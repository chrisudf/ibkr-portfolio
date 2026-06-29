# 自动同步 IBKR 报表

`ibkr_sync.sh` 通过 IBKR **Flex Web Service** 拉取你的 Activity Flex Query，
然后 POST 到 dashboard 的 `/api/upload`。

## 一次性配置（在 droplet 上）

```bash
ssh root@167.71.193.42
cd /opt/ibkr-portfolio/scripts
cp sync.env.example sync.env
chmod 600 sync.env
vim sync.env   # 填入 token、query_id、basic auth、域名
```

`ACCOUNTS` 支持多账号，用空格分隔，每对 `TOKEN:QUERY_ID`：
```
ACCOUNTS="aaaaTOKEN1:1549141 bbbbTOKEN2:1549142"
```

## 手动跑一次确认能跑通

```bash
./ibkr_sync.sh
```
正常输出大致是：
```
[…] [154914] requesting statement (query=1549141)…
[…] [154914] ref=1234567890, polling…
[…] [154914] still generating (1/30)…
[…] [154914] downloaded 1472 lines
[…] [154914] uploading to https://nomad403.cc/api/upload…
[…] [154914] uploaded OK (200)
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

- **`Statement generation in progress` 卡很久**: IBKR 偶尔慢，每次拉取最多
  轮询 30 × 5s = 2.5 分钟，正常 5–15 秒就好。
- **`ErrorCode 1001` Statement could not be generated**: 暂时不可用（维护或
  限流），脚本会自动 backoff 重试，无需手动干预。
- **`ErrorCode 1019` 限流**: 同上，会自动重试。
- **Token 过期（每年一次）**: IBKR 邮件提醒续期，去 Account Management 重新
  生成 token，更新 `sync.env`。
- **403 from upload**: basic auth 写错了，或者哈希在 Caddyfile 里被改了。
