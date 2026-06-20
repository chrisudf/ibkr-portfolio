/* IBKR Portfolio Dashboard — frontend */

const fmtMoney = (v, digits = 0) => {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return sign + "$" + abs.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
};
const fmtPct = (v, digits = 1) => (v * 100).toFixed(digits) + "%";
const fmtNum = (v, digits = 2) => Number(v).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

const $ = (id) => document.getElementById(id);

const currentDataRef = { data: null };

async function loadPortfolio() {
  const res = await fetch("/api/portfolio");
  const data = await res.json();
  if (data.empty) {
    $("empty").hidden = false;
    $("dashboard").hidden = true;
    return;
  }
  $("empty").hidden = true;
  $("dashboard").hidden = false;
  currentDataRef.data = data;
  render(data);
}

function render(data) {
  const { nav, stocks, options, performance, account, statement } = data;
  const totalNav = nav.total || (nav.cash + nav.stock + nav.options);

  // Account line — keep period only, hide personal info
  const period = statement.Period || "";
  $("account-line").textContent = period || "已导入";

  // KPIs
  $("kpi-nav").textContent = fmtMoney(totalNav);
  $("kpi-twr").textContent = nav.twr ? `时间加权收益率 ${fmtPct(nav.twr, 2)}` : "时间加权收益率 —";

  $("kpi-stock").textContent = fmtMoney(nav.stock);
  $("kpi-stock-pct").textContent = `占总净值 ${fmtPct(nav.stock / totalNav)}`;

  $("kpi-options").textContent = fmtMoney(nav.options);
  const longOpt = options.filter(o => o.value > 0).reduce((s, o) => s + o.value, 0);
  const shortOpt = options.filter(o => o.value < 0).reduce((s, o) => s + o.value, 0);
  $("kpi-options-detail").textContent = `多 ${fmtMoney(longOpt)} · 空 ${fmtMoney(shortOpt)}`;

  $("kpi-cash").textContent = fmtMoney(nav.cash);
  $("kpi-cash-pct").textContent = `占总净值 ${fmtPct(nav.cash / totalNav)}`;

  const unr = stocks.reduce((s, x) => s + x.unrealized_pl, 0) + options.reduce((s, x) => s + x.unrealized_pl, 0);
  const kpiUnr = $("kpi-unrealized");
  kpiUnr.textContent = fmtMoney(unr);
  kpiUnr.classList.toggle("up", unr >= 0);
  kpiUnr.classList.toggle("down", unr < 0);
  $("kpi-realized").textContent = `已实现 ${fmtMoney(performance.realized_total)}`;

  // Treemap
  renderTreemap(stocks);

  // Allocation bar
  renderAllocation(nav, totalNav);

  // Holdings
  renderHoldings(stocks);

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
    const div = document.createElement("div");
    div.className = "tile";
    div.style.left = leaf.x0 + "px";
    div.style.top = leaf.y0 + "px";
    div.style.width = (leaf.x1 - leaf.x0) + "px";
    div.style.height = (leaf.y1 - leaf.y0) + "px";
    div.style.background = color(d.unrealized_pl);
    const small = (leaf.x1 - leaf.x0) < 70 || (leaf.y1 - leaf.y0) < 50;
    div.innerHTML = small
      ? `<div class="sym">${d.symbol}</div>`
      : `<div class="sym">${d.symbol}</div>
         <div class="meta">${fmtMoney(d.value)}</div>
         <div class="pnl">${d.unrealized_pl >= 0 ? "+" : ""}${fmtMoney(d.unrealized_pl)}</div>`;
    div.title = `${d.symbol}\n市值 ${fmtMoney(d.value, 2)}\n成本 ${fmtMoney(d.cost_basis, 2)}\n浮盈 ${fmtMoney(d.unrealized_pl, 2)}`;
    el.appendChild(div);
  }
}

function renderAllocation(nav, totalNav) {
  const cashAbs = Math.max(nav.cash, 0);
  const stockAbs = Math.max(nav.stock, 0);
  // For options use absolute exposure (long + |short|) to surface risk; but use net for share of NAV
  const optAbs = Math.abs(nav.options);
  const total = cashAbs + stockAbs + optAbs || 1;
  const segs = [
    { label: "现金", value: cashAbs, color: "var(--accent-2)" },
    { label: "股票", value: stockAbs, color: "var(--cyan)" },
    { label: "期权", value: optAbs, color: "var(--amber)" },
  ];

  const bar = $("alloc-bar");
  bar.innerHTML = "";
  for (const s of segs) {
    if (s.value <= 0) continue;
    const div = document.createElement("div");
    div.className = "alloc-seg";
    div.style.background = s.color;
    div.style.width = (s.value / total * 100) + "%";
    const pct = (s.value / total * 100);
    div.textContent = pct > 6 ? `${s.label} ${pct.toFixed(1)}%` : "";
    bar.appendChild(div);
  }
  const legend = $("alloc-legend");
  legend.innerHTML = segs.map(s =>
    `<div><span class="dot" style="background:${s.color}"></span>${s.label} ${fmtMoney(s.value)} · ${(s.value/total*100).toFixed(1)}%</div>`
  ).join("");
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
    tr.innerHTML = `
      <td><b>${s.symbol}</b></td>
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
  const enriched = options.map(o => ({ ...o, abs_value: Math.abs(o.value) }));
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
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${o.underlying}</b> ${rightTag}</td>
      <td><span class="tag ${actionClass}">${actionLabel}</span></td>
      <td><span class="tag ${biasClass}">${biasLabel}</span></td>
      <td class="num">${o.strike ? "$" + o.strike : "—"}</td>
      <td>${o.expiry || "—"}</td>
      <td class="num">${o.quantity}</td>
      <td class="num muted">${fmtMoney(o.cost_basis, 0)}</td>
      <td class="num">${fmtMoney(o.value, 0)}</td>
      <td class="num ${o.unrealized_pl >= 0 ? "up" : "down"}">${o.unrealized_pl >= 0 ? "+" : ""}${fmtMoney(o.unrealized_pl, 0)}</td>
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

function renderRankings(bySymbol) {
  const arr = Object.entries(bySymbol).map(([sym, p]) => ({ sym, ...p }));
  const winners = arr.filter(x => x.realized_total > 0).sort((a, b) => b.realized_total - a.realized_total).slice(0, 8);
  const losers = arr.filter(x => x.realized_total < 0).sort((a, b) => a.realized_total - b.realized_total).slice(0, 8);
  $("winners").innerHTML = winners.map(w => `<li><span class="sym">${w.sym}</span><span class="up">+${fmtMoney(w.realized_total, 0)}</span></li>`).join("") || '<li class="muted">无</li>';
  $("losers").innerHTML = losers.map(w => `<li><span class="sym">${w.sym}</span><span class="down">${fmtMoney(w.realized_total, 0)}</span></li>`).join("") || '<li class="muted">无</li>';
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
  loadPortfolio();
});
