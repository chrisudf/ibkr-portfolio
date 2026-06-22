/* IBKR Portfolio Dashboard — frontend */

// Symbols treated as cash equivalents (money-market / short-T ETFs).
// They're held in the brokerage account but used as parked cash.
const CASH_EQUIVALENTS = new Set(["BOXX", "SGOV"]);

const fmtMoney = (v, digits = 0) => {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return sign + "$" + abs.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
};
const fmtPct = (v, digits = 1) => (v * 100).toFixed(digits) + "%";
const fmtNum = (v, digits = 2) => Number(v).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

const $ = (id) => document.getElementById(id);

const currentDataRef = { data: null, allAccounts: null, selected: null };

function maskAccountId(id) {
  if (!id || id.length < 6) return id;
  return id.slice(0, 4) + "*".repeat(Math.max(0, id.length - 6)) + id.slice(-2);
}

function mergeAccounts(accounts) {
  const list = Object.values(accounts);
  if (list.length === 1) return list[0];

  const nav = { cash: 0, stock: 0, options: 0, dividend_accruals: 0, total: 0, twr: 0 };
  let twrNumerator = 0, twrDenom = 0;
  for (const a of list) {
    nav.cash += a.nav.cash || 0;
    nav.stock += a.nav.stock || 0;
    nav.options += a.nav.options || 0;
    nav.dividend_accruals += a.nav.dividend_accruals || 0;
    nav.total += a.nav.total || 0;
    if (a.nav.twr) { twrNumerator += a.nav.twr * (a.nav.total || 0); twrDenom += a.nav.total || 0; }
  }
  nav.twr = twrDenom ? twrNumerator / twrDenom : 0;

  // Merge stocks by symbol (sum qty/cost/value, weighted avg cost_price)
  const stockMap = {};
  for (const a of list) {
    for (const s of a.stocks) {
      const k = s.symbol;
      if (!stockMap[k]) { stockMap[k] = { ...s }; continue; }
      const m = stockMap[k];
      m.quantity += s.quantity;
      m.cost_basis += s.cost_basis;
      m.value += s.value;
      m.unrealized_pl += s.unrealized_pl;
      m.cost_price = m.quantity ? m.cost_basis / m.quantity : 0;
    }
  }
  const stocks = Object.values(stockMap).sort((a, b) => b.value - a.value);

  // Options: concat (each contract is account-specific anyway)
  const options = list.flatMap(a => a.options || []);

  // Performance by symbol — sum across accounts
  const bySymbol = {};
  let realizedTotal = 0, unrealizedTotal = 0;
  for (const a of list) {
    realizedTotal += a.performance.realized_total || 0;
    unrealizedTotal += a.performance.unrealized_total || 0;
    for (const [k, v] of Object.entries(a.performance.by_symbol || {})) {
      if (!bySymbol[k]) { bySymbol[k] = { ...v }; continue; }
      bySymbol[k].realized_total += v.realized_total;
      bySymbol[k].unrealized_total += v.unrealized_total;
      bySymbol[k].total = bySymbol[k].realized_total + bySymbol[k].unrealized_total;
    }
  }

  // If accounts share the same period (the usual case) collapse to one.
  const periods = [...new Set(list.map(a => a.statement?.Period).filter(Boolean))];
  return {
    account: { Account: "ALL" },
    statement: { Period: periods.length === 1 ? periods[0] : periods.join(" / ") },
    nav, stocks, options,
    performance: {
      realized_total: realizedTotal,
      unrealized_total: unrealizedTotal,
      by_symbol: bySymbol,
    },
  };
}

function renderAccountSwitcher() {
  const accounts = currentDataRef.allAccounts;
  const el = $("account-switcher");
  if (!accounts || Object.keys(accounts).length < 2) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const ids = Object.keys(accounts).sort();
  // Individual accounts first; "总账户" merge view as the trailing option.
  el.innerHTML = `<span class="label">账号</span>`
    + ids.map(id => `<button data-acct="${id}">${maskAccountId(id)}</button>`).join("")
    + `<button data-acct="ALL">总账户</button>`;
  el.querySelectorAll("button").forEach(btn => {
    if (btn.dataset.acct === currentDataRef.selected) btn.classList.add("active");
    btn.addEventListener("click", () => {
      currentDataRef.selected = btn.dataset.acct;
      el.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderSelected();
    });
  });
}

function renderSelected() {
  const accounts = currentDataRef.allAccounts;
  const sel = currentDataRef.selected;
  const data = sel === "ALL" ? mergeAccounts(accounts) : accounts[sel];
  currentDataRef.data = data;
  render(data);
}

async function loadPortfolio() {
  const res = await fetch("/api/portfolio");
  const payload = await res.json();
  if (payload.empty) {
    $("empty").hidden = false;
    $("dashboard").hidden = true;
    return;
  }
  $("empty").hidden = true;
  $("dashboard").hidden = false;
  // Accept both new multi-account payload and legacy single-account shape.
  const accounts = payload.accounts || { "default": payload };
  currentDataRef.allAccounts = accounts;
  // Default to the alphabetically-first account (puts U17xxxx ahead of U22xxxx)
  // rather than the merged view — most viewing happens per-account.
  if (!currentDataRef.selected || (currentDataRef.selected !== "ALL" && !accounts[currentDataRef.selected])) {
    const ids = Object.keys(accounts).sort();
    currentDataRef.selected = ids[0];
  }
  renderAccountSwitcher();
  renderSelected();
}

function render(data) {
  const { nav, options, performance, account, statement } = data;
  // Split stocks into real positions vs cash equivalents
  const cashEqHoldings = data.stocks.filter(s => CASH_EQUIVALENTS.has(s.symbol));
  const stocks = data.stocks.filter(s => !CASH_EQUIVALENTS.has(s.symbol));
  const cashEqValue = cashEqHoldings.reduce((s, x) => s + x.value, 0);
  const cashEqCost = cashEqHoldings.reduce((s, x) => s + x.cost_basis, 0);
  const adjStock = nav.stock - cashEqValue;
  const adjCash = nav.cash + cashEqValue;
  const totalNav = nav.total || (nav.cash + nav.stock + nav.options);

  // Account line — show masked account + period, hide name
  const acct = account.Account || "";
  const masked = acct === "ALL" ? "总账户" : maskAccountId(acct);
  const period = statement.Period || "";
  $("account-line").textContent = [masked, period].filter(Boolean).join(" · ") || "已导入";

  // KPIs
  $("kpi-nav").textContent = fmtMoney(totalNav);
  const twrEl = $("kpi-twr");
  if (nav.twr) {
    twrEl.textContent = `时间加权收益率 ${fmtPct(nav.twr, 2)}`;
    twrEl.hidden = false;
  } else {
    twrEl.hidden = true;
  }

  $("kpi-stock").textContent = fmtMoney(adjStock);
  $("kpi-stock-pct").textContent = `占总净值 ${fmtPct(adjStock / totalNav)}`;

  // Gross exposure: sum of long-contract market value vs sum of |short-contract market value|
  const grossLong = options.filter(o => o.value > 0).reduce((s, o) => s + o.value, 0);
  const grossShort = options.filter(o => o.value < 0).reduce((s, o) => s + Math.abs(o.value), 0);
  $("kpi-options").textContent = fmtMoney(grossLong + grossShort);
  $("kpi-options-detail").textContent = `买入 ${fmtMoney(grossLong)} · 卖出 ${fmtMoney(grossShort)}`;

  $("kpi-cash").textContent = fmtMoney(adjCash);
  const cashEqLabel = cashEqValue > 0
    ? `含 ${cashEqHoldings.map(h => h.symbol).join("/")} ${fmtMoney(cashEqValue)}`
    : `占总净值 ${fmtPct(adjCash / totalNav)}`;
  $("kpi-cash-pct").textContent = cashEqLabel;

  const unr = data.stocks.reduce((s, x) => s + x.unrealized_pl, 0) + options.reduce((s, x) => s + x.unrealized_pl, 0);
  const kpiUnr = $("kpi-unrealized");
  kpiUnr.textContent = fmtMoney(unr);
  kpiUnr.classList.toggle("up", unr >= 0);
  kpiUnr.classList.toggle("down", unr < 0);
  $("kpi-realized").textContent = `已实现 ${fmtMoney(performance.realized_total)}`;

  // Treemap
  renderTreemap(stocks);

  // Allocation bar — position view: cash, stock, long options (MV)
  // Short options excluded (their premium is already in cash); shown as a footnote.
  const longOptMV = options.filter(o => o.value > 0).reduce((s, o) => s + o.value, 0);
  const shortOptMV = options.filter(o => o.value < 0).reduce((s, o) => s + Math.abs(o.value), 0);
  renderAllocation({ cash: adjCash, stock: adjStock, longOptions: longOptMV, shortOptionsNote: shortOptMV }, totalNav);

  // Holdings — show all positions including cash equivalents (tagged)
  renderHoldings(data.stocks);

  // Options
  renderOptions(options);

  // Realized rankings
  renderRankings(performance.by_symbol);
}

function renderTreemap(stocks) {
  const el = $("treemap");
  el.innerHTML = "";
  if (!stocks.length) {
    el.innerHTML = '<div class="muted" style="padding:30px">无股票持仓</div>';
    return;
  }
  const rect = el.getBoundingClientRect();
  const w = rect.width, h = rect.height || 480;

  const root = d3.hierarchy({ children: stocks.map(s => ({ ...s, size: Math.max(s.value, 0.0001) })) })
    .sum(d => d.size);
  d3.treemap().size([w, h]).padding(4).round(true)(root);

  const maxAbs = d3.max(stocks, d => Math.abs(d.unrealized_pl)) || 1;
  const color = (pl) => {
    const t = Math.max(-1, Math.min(1, pl / maxAbs));
    // vibrant green for positive, vibrant red for negative
    if (t >= 0) return d3.interpolateRgb("#16a34a", "#22ff7a")(0.3 + t * 0.7);
    return d3.interpolateRgb("#dc2626", "#ff3355")(0.3 + Math.abs(t) * 0.7);
  };

  for (const leaf of root.leaves()) {
    const d = leaf.data;
    const w = leaf.x1 - leaf.x0;
    const h = leaf.y1 - leaf.y0;
    const div = document.createElement("div");
    div.className = "tile";
    div.style.left = leaf.x0 + "px";
    div.style.top = leaf.y0 + "px";
    div.style.width = w + "px";
    div.style.height = h + "px";
    div.style.background = color(d.unrealized_pl);

    // Scale font sizes proportionally to tile size, with a floor
    const symSize = Math.max(8, Math.min(16, Math.min(w / 5, h / 4)));
    const metaSize = Math.max(8, symSize * 0.7);
    div.style.padding = w < 60 ? "4px 6px" : "10px 12px";

    if (w < 36 || h < 28) {
      // Tile too small for any text
      div.innerHTML = "";
    } else if (w < 70 || h < 60) {
      div.innerHTML = `<div class="sym" style="font-size:${symSize}px">${d.symbol}</div>`;
    } else {
      div.innerHTML = `
        <div class="sym" style="font-size:${symSize}px">${d.symbol}</div>
        <div class="meta" style="font-size:${metaSize}px">${fmtMoney(d.value)}</div>
        <div class="pnl" style="font-size:${metaSize}px">${d.unrealized_pl >= 0 ? "+" : ""}${fmtMoney(d.unrealized_pl)}</div>`;
    }
    div.title = `${d.symbol}\n市值 ${fmtMoney(d.value, 2)}\n成本 ${fmtMoney(d.cost_basis, 2)}\n浮盈 ${fmtMoney(d.unrealized_pl, 2)}`;
    el.appendChild(div);
  }
}

function renderAllocation(nav, totalNav) {
  const cashAbs = Math.max(nav.cash, 0);
  const stockAbs = Math.max(nav.stock, 0);
  const longOptAbs = Math.max(nav.longOptions || 0, 0);
  const total = cashAbs + stockAbs + longOptAbs || 1;
  const segs = [
    { label: "现金", value: cashAbs, color: "var(--accent-2)" },
    { label: "股票", value: stockAbs, color: "var(--cyan)" },
    { label: "期权多头", value: longOptAbs, color: "var(--amber)" },
  ];

  const bar = $("alloc-bar");
  bar.innerHTML = "";
  for (const s of segs) {
    if (s.value <= 0) continue;
    const div = document.createElement("div");
    div.className = "alloc-seg";
    div.style.background = s.color;
    const pct = (s.value / total * 100);
    div.style.width = pct + "%";
    // Scale font with segment width so smaller slices still show
    if (pct >= 6) {
      div.style.fontSize = "12px";
      div.textContent = `${s.label} ${pct.toFixed(1)}%`;
    } else if (pct >= 2.5) {
      div.style.fontSize = "10px";
      div.textContent = `${pct.toFixed(1)}%`;
    } else {
      div.textContent = "";
    }
    div.title = `${s.label} ${fmtMoney(s.value)} · ${pct.toFixed(1)}%`;
    bar.appendChild(div);
  }
  const legend = $("alloc-legend");
  const segLines = segs.map(s =>
    `<div><span class="dot" style="background:${s.color}"></span>${s.label} ${fmtMoney(s.value)} · ${(s.value/total*100).toFixed(1)}%</div>`
  );
  if (nav.shortOptionsNote > 0) {
    segLines.push(`<div class="muted" style="margin-left:auto">另有卖方期权义务 ${fmtMoney(nav.shortOptionsNote)}（权利金已在现金中）</div>`);
  }
  legend.innerHTML = segLines.join("");
}

const stocksSort = { key: "value", dir: "desc" };

function renderHoldings(stocks) {
  const tbody = $("holdings-body");
  tbody.innerHTML = "";
  const totalVal = stocks.reduce((s, x) => s + x.value, 0) || 1;
  const enriched = stocks.map(s => ({
    ...s,
    ret: s.cost_basis ? s.unrealized_pl / s.cost_basis : 0,
    weight: s.value / totalVal,
  }));
  enriched.sort((a, b) => {
    const av = a[stocksSort.key], bv = b[stocksSort.key];
    return stocksSort.dir === "asc" ? av - bv : bv - av;
  });
  for (const s of enriched) {
    const tr = document.createElement("tr");
    const cashEqTag = CASH_EQUIVALENTS.has(s.symbol) ? ` <span class="tag tag-flow-in">现金等价</span>` : "";
    tr.innerHTML = `
      <td><b>${s.symbol}</b>${cashEqTag}</td>
      <td class="num">${fmtNum(s.quantity, 4)}</td>
      <td class="num">${fmtMoney(s.cost_price, 2)}</td>
      <td class="num">${fmtMoney(s.close_price, 2)}</td>
      <td class="num muted">${fmtMoney(s.cost_basis, 0)}</td>
      <td class="num">${fmtMoney(s.value, 0)}</td>
      <td class="num ${s.unrealized_pl >= 0 ? "up" : "down"}">${s.unrealized_pl >= 0 ? "+" : ""}${fmtMoney(s.unrealized_pl, 0)}</td>
      <td class="num ${s.ret >= 0 ? "up" : "down"}">${(s.ret * 100).toFixed(1)}%</td>
      <td class="num">${(s.weight * 100).toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  }
  updateSortIndicators("holdings-body", stocksSort);
}

const optionsSort = { key: "abs_value", dir: "desc" };

function renderOptions(options) {
  const panel = $("options-panel");
  if (!options.length) { panel.hidden = true; return; }
  panel.hidden = false;
  const tbody = $("options-body");
  tbody.innerHTML = "";
  const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const parseExpiry = (s) => {
    const m = (s || "").match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!m) return Infinity;
    return new Date(2000 + parseInt(m[3]), MONTHS[m[2]] ?? 0, parseInt(m[1])).getTime();
  };
  const fmtExpiry = (ts) => {
    if (!isFinite(ts)) return "—";
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}/${mm}/${dd}`;
  };
  const enriched = options.map(o => ({
    ...o,
    abs_value: Math.abs(o.value),
    abs_cost: Math.abs(o.cost_basis),
    abs_qty: Math.abs(o.quantity),
    expiry_ts: parseExpiry(o.expiry),
    expiry_fmt: fmtExpiry(parseExpiry(o.expiry)),
    // Return = P/L as % of premium basis (works for both long and short options)
    ret: o.cost_basis ? o.unrealized_pl / Math.abs(o.cost_basis) : 0,
  }));
  enriched.sort((a, b) => {
    const av = a[optionsSort.key], bv = b[optionsSort.key];
    return optionsSort.dir === "asc" ? av - bv : bv - av;
  });
  for (const o of enriched) {
    const isBuy = o.quantity > 0;
    const isCall = o.right === "C";
    // Action: buy/sell × call/put
    const actionLabel = (isBuy ? "买入" : "卖出") + (isCall ? "看涨" : "看跌");
    const actionClass = isBuy ? "tag-long" : "tag-short";
    // Market bias: long call & short put = bullish; short call & long put = bearish
    const isBullish = (isBuy && isCall) || (!isBuy && !isCall);
    const biasLabel = isBullish ? "看多" : "看空";
    const biasClass = isBullish ? "tag-bull" : "tag-bear";
    const rightTag = isCall ? `<span class="tag tag-call">CALL</span>` : `<span class="tag tag-put">PUT</span>`;
    // Premium cash-flow direction: buy = paid (付), sell = received (收)
    const flowTag = isBuy ? `<span class="tag tag-flow-out">付</span>` : `<span class="tag tag-flow-in">收</span>`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${o.underlying}</b> ${rightTag}</td>
      <td><span class="tag ${actionClass}">${actionLabel}</span></td>
      <td><span class="tag ${biasClass}">${biasLabel}</span></td>
      <td class="num">${o.strike ? "$" + o.strike : "—"}</td>
      <td>${o.expiry_fmt}</td>
      <td class="num">${o.quantity}</td>
      <td class="num">${fmtMoney(Math.abs(o.cost_basis), 0)} ${flowTag}</td>
      <td class="num">${fmtMoney(Math.abs(o.value), 0)}</td>
      <td class="num ${o.unrealized_pl >= 0 ? "up" : "down"}">${o.unrealized_pl >= 0 ? "+" : ""}${fmtMoney(o.unrealized_pl, 0)}</td>
      <td class="num ${o.ret >= 0 ? "up" : "down"}">${o.ret >= 0 ? "+" : ""}${(o.ret * 100).toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  }
  updateSortIndicators("options-body", optionsSort);
}

function updateSortIndicators(tbodyId, state) {
  const table = document.getElementById(tbodyId).closest("table");
  table.querySelectorAll("th.sortable").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === state.key) {
      th.classList.add(state.dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

function attachSorters(currentDataRef) {
  document.querySelectorAll("table.holdings").forEach(table => {
    const isOptions = table.querySelector("#options-body");
    const state = isOptions ? optionsSort : stocksSort;
    table.querySelectorAll("th.sortable").forEach(th => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.key === key) {
          state.dir = state.dir === "asc" ? "desc" : "asc";
        } else {
          state.key = key;
          state.dir = "desc";
        }
        if (isOptions) renderOptions(currentDataRef.data.options);
        else renderHoldings(currentDataRef.data.stocks);
      });
    });
  });
}

let rankMode = "underlying";

function optionUnderlying(sym) {
  // "NVDA 17JUL26 155 P" -> "NVDA"
  const m = sym.match(/^([A-Z\.]+)\s/);
  return m ? m[1] : sym;
}

function buildRankEntries(bySymbol, mode) {
  const arr = Object.entries(bySymbol).map(([sym, p]) => ({ sym, ...p }));
  if (mode === "stocks") {
    return arr
      .filter(x => x.asset_category === "Stocks")
      .map(x => ({ key: x.sym, value: x.realized_total, note: "已实现" }));
  }
  if (mode === "options_underlying") {
    const byU = {};
    for (const x of arr) {
      if (!x.asset_category || x.asset_category === "Stocks") continue;
      const u = optionUnderlying(x.sym);
      if (!byU[u]) byU[u] = { realized: 0, unrealized: 0 };
      byU[u].realized += x.realized_total;
      byU[u].unrealized += x.unrealized_total;
    }
    return Object.entries(byU).map(([u, v]) => ({
      key: u,
      value: v.realized + v.unrealized,
      note: `已实现 ${fmtMoney(v.realized, 0)} · 浮动 ${fmtMoney(v.unrealized, 0)}`,
    }));
  }
  if (mode === "underlying") {
    // Strategy P&L: per underlying, sum stock + options (realized + unrealized)
    const byU = {};
    for (const x of arr) {
      const isStock = x.asset_category === "Stocks";
      const u = isStock ? x.sym : optionUnderlying(x.sym);
      if (!byU[u]) byU[u] = { sR: 0, sU: 0, oR: 0, oU: 0 };
      if (isStock) {
        byU[u].sR += x.realized_total;
        byU[u].sU += x.unrealized_total;
      } else {
        byU[u].oR += x.realized_total;
        byU[u].oU += x.unrealized_total;
      }
    }
    return Object.entries(byU).map(([u, v]) => {
      const total = v.sR + v.sU + v.oR + v.oU;
      const parts = [];
      if (v.sR || v.sU) parts.push(`股 ${fmtMoney(v.sR + v.sU, 0)}`);
      if (v.oR || v.oU) parts.push(`期权 ${fmtMoney(v.oR + v.oU, 0)}`);
      return { key: u, value: total, note: parts.join(" · ") || "—" };
    });
  }
  // all realized
  return arr.map(x => ({ key: x.sym, value: x.realized_total, note: "已实现" }));
}

function renderRankings(bySymbol) {
  const explain = {
    underlying: "按标的合并：股票 + 期权的「已实现 + 浮动」全部相加，反映你在该 ticker 上的真实 thesis 净盈亏",
    stocks: "仅看股票的已实现盈亏，不受期权展期干扰",
    options_underlying: "同一标的所有期权合约的「已实现 + 浮动」合并，包含未平仓的 premium",
    all: "全部标的的原始已实现盈亏（含展期噪声，仅供对账）",
  };
  $("rank-explain").textContent = explain[rankMode];

  const entries = buildRankEntries(bySymbol, rankMode);
  const winners = entries.filter(x => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 10);
  const losers = entries.filter(x => x.value < 0).sort((a, b) => a.value - b.value).slice(0, 10);
  const render = (rows, cls, prefix) => rows.map(r =>
    `<li><span class="sym">${r.key}</span>
       <span class="${cls}">${prefix}${fmtMoney(r.value, 0)}<span class="muted" style="margin-left:8px;font-weight:400;font-size:11px">${r.note}</span></span>
     </li>`
  ).join("") || '<li class="muted">无</li>';
  $("winners").innerHTML = render(winners, "up", "+");
  $("losers").innerHTML = render(losers, "down", "");
}

document.addEventListener("DOMContentLoaded", () => {
  $("file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $("status").textContent = "解析中…";
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const j = await res.json();
    if (!res.ok) {
      $("status").textContent = "失败: " + (j.error || "未知错误");
      return;
    }
    $("status").textContent = "已更新 ✓";
    await loadPortfolio();
    setTimeout(() => $("status").textContent = "", 2500);
  });

  attachSorters(currentDataRef);

  document.querySelectorAll("#rank-mode button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#rank-mode button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      rankMode = btn.dataset.mode;
      if (currentDataRef.data) renderRankings(currentDataRef.data.performance.by_symbol);
    });
  });

  loadPortfolio();
});
