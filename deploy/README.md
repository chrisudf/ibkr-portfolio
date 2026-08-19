# 部署到 Digital Ocean VPS

整套用 Docker Compose + Caddy（自动 HTTPS） + HTTP Basic Auth 保护。

## 前置
- DO Droplet（Ubuntu 22.04+ 推荐）
- 一个域名（A 记录指向 droplet IP）— 没有域名也能跑，但拿不到 Let's Encrypt 证书

## 1. 一次性安装 Docker

```bash
ssh root@YOUR_DROPLET_IP
curl -fsSL https://get.docker.com | sh
```

## 2. 上传代码

```bash
# 在本地推完 GitHub 后，到 droplet 上：
ssh root@YOUR_DROPLET_IP
cd /opt
git clone https://github.com/chrisudf/ibkr-portfolio.git
cd ibkr-portfolio/deploy
```

## 3. 配置 Caddyfile

生成 basic auth 密码哈希：
```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext '换成你的密码'
```
把输出（`$2a$14$...`）粘到 `Caddyfile` 里替换 `REPLACE_WITH_HASH`。

把 `your-domain.com` 改成你的真实域名。

## 4. 防火墙

```bash
ufw allow 22
ufw allow 80
ufw allow 443
ufw enable
```

## 5. 启动

```bash
docker compose up -d --build
docker compose logs -f
```

打开 `https://your-domain.com`，浏览器会弹 basic auth，输入 `admin` + 你设的密码即可。

## 更新代码

```bash
cd /opt/ibkr-portfolio
git pull
cd deploy
docker compose up -d --build
```

## 备份持仓数据

数据放在 `app_data` volume 里。**注意实际的 volume 名带 compose 项目名前缀** ——
compose 是在 `deploy/` 目录里跑的，所以项目名是 `deploy`，volume 叫
`deploy_app_data`，不是 `ibkr-portfolio_app_data`。

先确认名字：
```bash
docker volume ls | grep app_data
# 或者直接问容器挂的是哪个：
docker inspect deploy-app-1 --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{println}}{{end}}'
```

备份：
```bash
docker run --rm -v deploy_app_data:/data -v $PWD:/backup alpine \
  tar czf /backup/portfolio-$(date +%F).tar.gz -C /data .
```

**跑完一定要看一眼大小。** volume 名写错时 docker 不会报错，而是**新建一个空
volume**、把空目录打包好 —— 得到一个 87 字节、语法完全正确的 tar.gz。正常备份
是几十 KB：
```bash
ls -lh portfolio-*.tar.gz
```
写错还会留下一个空 volume，顺手删掉：`docker volume rm ibkr-portfolio_app_data`

恢复到某个备份：
```bash
cd /opt/ibkr-portfolio/deploy && docker compose stop app
docker run --rm -v deploy_app_data:/data -v $PWD:/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/portfolio-YYYY-MM-DD.tar.gz -C /data'
docker compose start app
```

## 不想用域名（只用 IP + 自签证书）

把 Caddyfile 改成：
```
:443 {
    tls internal
    basicauth /* { admin REPLACE_WITH_HASH }
    reverse_proxy app:8000
}
```
浏览器会提示证书不受信任，自行接受即可。
