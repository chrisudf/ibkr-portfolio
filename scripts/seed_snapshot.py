#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""开发用：伪造一条历史基线快照，让「本周复盘」面板立刻有东西可比。

面板要求两条相隔 5–16 天的快照，正常得等一周真实同步才凑得齐。这个脚本
从当前持仓反推一条基线出来，用于本地验收 UI，**不产生任何真实数据**。

    python scripts/seed_snapshot.py seed     # 写入伪造基线
    python scripts/seed_snapshot.py clean    # 删除全部快照文件

基线锚在报表的 as-of 日期上（有 nav_history 取其末条，否则取 Period 的
期末日），**不是今天** —— 面板按报表日期算间隔，用墙上时钟回退 7 天会因为
间隔不足 5 天而选不中基线。价格随机 ±2~7%、随机挑两个标的改仓位，好让
赢家/输家/涨跌幅/仓位标签四种渲染路径都被覆盖。

看完记得 clean：留着伪造基线，下次真实刷新会拿真快照去比它，算出来的
「本周盈亏」是错的，而且看不出错。
"""
from __future__ import annotations

import json
import random
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parser.snapshots import _as_of_date  # noqa: E402

UPLOAD_DIR = Path(__file__).resolve().parents[1] / "uploads"

# 价格变动候选：三涨三跌，保证两侧榜单都有内容。
_MOVES = (0.05, 0.03, 0.015, -0.02, -0.04, -0.07)


def seed(force: bool = False) -> int:
    snaps = sorted(UPLOAD_DIR.glob("*.snapshots.jsonl"))
    if snaps and not force:
        # 真实快照是攒出来的，覆盖掉就再也回不来了。
        print("已存在快照文件，拒绝覆盖：")
        for f in snaps:
            print(f"  {f.name}（{sum(1 for _ in f.open(encoding='utf-8'))} 条）")
        print("\n确认这些是伪造的、可以丢弃，再加 --force 重跑；")
        print("如果是真实同步攒下来的，别 force —— 直接看面板就行。")
        return 1

    random.seed(7)
    # 与 app.py._load_all_accounts 同一套发现规则：只认 U*.json 会漏掉
    # DU 开头的模拟盘和回退到 "default" 的账户，还会谎称「没有账户 JSON」。
    accounts = [f for f in sorted(UPLOAD_DIR.glob("*.json"))
                if not f.name.startswith(".") and f.name != "last_portfolio.json"]
    if not accounts:
        print(f"{UPLOAD_DIR} 下没有账户 JSON，先上传或刷新一次报表。")
        return 1

    skipped = []
    for src in accounts:
        data = json.load(src.open(encoding="utf-8"))
        # 复用 parser.snapshots 的解析器而不是重写一份：AS 的
        # "January 1, 2026 - June 30, 2026" 里没有 ISO 日期，自写正则会
        # 静默回退到「今天」，基线就锚错位置 —— 正是本脚本 docstring
        # 警告过的坑。解析不出时它返回 ""，那种报表没有可靠 as-of 日期，
        # 跳过比瞎猜一个好。
        asof = _as_of_date(data)
        if not asof:
            skipped.append(src.stem)
            continue
        base_date = (date.fromisoformat(asof) - timedelta(days=7)).isoformat()

        holdings = [s for s in data.get("stocks", []) if s.get("symbol")]
        resized = set(random.sample([s["symbol"] for s in holdings],
                                    min(2, len(holdings))))
        stocks = {}
        for s in holdings:
            qty = s.get("quantity", 0.0)
            price = s.get("close_price", 0.0)
            value = s.get("value", 0.0)
            unrealized = s.get("unrealized_pl", 0.0)
            move = random.choice(_MOVES)
            base_qty = qty * 0.5 if s["symbol"] in resized else qty
            base_price = price * (1 - move)
            stocks[s["symbol"]] = [base_qty, base_price, base_qty * base_price,
                                   unrealized - abs(value) * move]

        perf = {}
        for sym, p in (data.get("performance", {}).get("by_symbol") or {}).items():
            kind = "S" if p.get("asset_category") == "Stocks" else "O"
            # 期权腿回退一点，制造权利金衰减/roll 带来的盈亏。
            drift = 0.0 if kind == "S" else random.choice([80.0, -60.0, 25.0])
            perf[sym] = [p.get("realized_total", 0.0),
                         p.get("unrealized_total", 0.0) - drift, kind]

        out = UPLOAD_DIR / f"{src.stem}.snapshots.jsonl"
        out.write_text(
            json.dumps({"date": base_date,
                        "nav": (data.get("nav") or {}).get("total", 0.0) * 0.97,
                        "stocks": stocks, "perf": perf},
                       ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8")
        print(f"  {src.stem}: 基线 {base_date} → {out.name}"
              f"（{len(stocks)} 标的，{len(perf)} 条 perf，仓位变动 {'/'.join(sorted(resized))}）")

    for acct in skipped:
        print(f"  {acct}: 报表里没有可靠的 as-of 日期，跳过")
    print("\n刷新页面即可看到「本周复盘」。看完请跑 clean。")
    return 0


def clean() -> int:
    files = sorted(UPLOAD_DIR.glob("*.snapshots.jsonl"))
    if not files:
        print("没有快照文件。")
        return 0
    for f in files:
        f.unlink()
        print("  已删除", f.name)
    print(f"清理完成（{len(files)} 个文件）。下次刷新/上传会重新开始积累真实快照。")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else ""
    if cmd == "seed":
        sys.exit(seed(force="--force" in args))
    if cmd == "clean":
        sys.exit(clean())
    print(__doc__)
    sys.exit(2)
