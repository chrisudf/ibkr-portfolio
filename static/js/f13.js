/* ---------------------------------------------------------------------------
 * 13F overlay — your book against what the superinvestors did last quarter.
 *
 * Data comes from /api/superinvestors (Dataroma scrape, cached server-side).
 * Everything here is a join on ticker, which makes three things worth stating
 * where the reader can see them:
 *
 *  - **Two flow measures, never averaged.** `net_heads` counts managers
 *    (a new position or an exit counts double, a trim once); `net_shares`
 *    counts shares. They disagree precisely when a few large holders move
 *    against a crowd of small ones — Q2 2026 Alphabet is the case in point:
 *    27 managers trimmed it (heads −27) while Berkshire alone added 48M
 *    shares across both classes (shares +30.9M). Collapsing those into one
 *    "sentiment" number would have reported the exact opposite of the truth,
 *    so the panel shows both and sorts on shares.
 *
 *  - **Dual-class tickers.** A 13F lists GOOG and GOOGL as separate rows. A
 *    holder of one class cares about flow in both, so the classes are merged
 *    on read and the panel says it did.
 *
 *  - **Absence is not a signal.** 13F covers long US equity only. A ticker
 *    with no rows (LITX, ECHO, HOOD, leveraged ETFs) is invisible to the
 *    form, not unloved, and is rendered as "未覆盖" rather than as a zero.
 * ------------------------------------------------------------------------- */

// Share classes that are one company for flow purposes. Deliberately a short
// hand-kept list rather than a prefix rule: "BRK.B"→"BRK" would also sweep up
// any unrelated ticker sharing a stem.
const F13_SHARE_CLASSES = [
  ["GOOG", "GOOGL"],
  ["BRK.A", "BRK.B"],
  ["FOX", "FOXA"],
  ["UHAL", "UHAL.B"],
  ["LEN", "LEN.B"],
];

const F13_CLASS_OF = (() => {
  const map = {};
  for (const group of F13_SHARE_CLASSES) for (const t of group) map[t] = group;
  return map;
})();

let f13Mode = "holdings";

const f13Fmt = {
  shares: (n) => (n === 0 ? "—" : (n > 0 ? "+" : "−") + Math.abs(n).toLocaleString("en-US")),
  heads: (n) => (n > 0 ? "+" : "") + n,
};

// Aggregate the flows of every share class of `symbol` into one record.
function f13Flow(flows, symbol) {
  const group = F13_CLASS_OF[symbol] || [symbol];
  const parts = group.map(t => flows[t]).filter(Boolean);
  if (!parts.length) return null;
  const out = {
    company: parts[0].company, buy: 0, add: 0, reduce: 0, sell: 0,
    shares_in: 0, shares_out: 0, actors: [], merged: parts.length > 1 ? group : null,
  };
  for (const p of parts) {
    for (const k of ["buy", "add", "reduce", "sell", "shares_in", "shares_out"]) out[k] += p[k];
    out.actors = out.actors.concat(p.actors);
  }
  out.net_shares = out.shares_in - out.shares_out;
  out.net_heads = 2 * out.buy + out.add - 2 * out.sell - out.reduce;
  return out;
}

// The loudest few movers on one side, for the "who" column. Ranked by the
// position's weight in THEIR book, not by share count: 3M shares is a rounding
// error to Berkshire and a thesis to a $2B fund.
function f13Who(flow, side, mgrNames, limit = 3) {
  const want = side === "buy" ? ["Buy", "Add"] : ["Sell", "Reduce"];
  // One line per manager. After a dual-class merge the same manager can
  // appear twice (Berkshire moved both GOOG and GOOGL); keep their larger
  // leg, because two rows with the same name look like a bug rather than
  // like two share classes.
  const best = new Map();
  for (const a of flow.actors) {
    if (!want.includes(a.action)) continue;
    const prev = best.get(a.code);
    if (!prev || a.pct_port > prev.pct_port) best.set(a.code, a);
  }
  const rows = [...best.values()]
    .sort((a, b) => b.pct_port - a.pct_port).slice(0, limit);
  if (!rows.length) return '<span class="muted">—</span>';
  return rows.map(a => {
    const nm = esc((mgrNames[a.code] || a.code).split(" - ")[0].trim());
    const tag = a.action === "Buy" ? "建仓" : a.action === "Sell" ? "清仓"
      : (a.action === "Add" ? "加" : "减") + (a.pct_move != null ? ` ${a.pct_move}%` : "");
    const cls = (a.action === "Buy" || a.action === "Add") ? "up" : "down";
    return `<span class="f13-who"><b class="${cls}">${tag}</b> ${nm}</span>`;
  }).join(" ");
}

function f13Counts(flow) {
  const cell = (n, cls, label) =>
    n ? `<span class="f13-chip ${cls}" title="${label} ${n} 家">${n}</span>`
      : '<span class="f13-chip zero">·</span>';
  // One nowrap container: without it the four chips stack into a vertical
  // column as soon as the table is squeezed, which reads as four unrelated
  // numbers instead of one buy/sell profile.
  return '<span class="f13-counts">'
       + cell(flow.buy, "buy", "建仓") + cell(flow.add, "add", "加仓")
       + cell(flow.reduce, "reduce", "减仓") + cell(flow.sell, "sell", "清仓")
       + '</span>';
}

function f13Bar(net, scale) {
  const w = scale > 0 ? Math.min(Math.round(Math.abs(net) / scale * 38), 38) : 0;
  const side = net >= 0 ? "left:50%" : "right:50%";
  const cls = net >= 0 ? "up" : "down";
  return `<span class="f13-bar"><i class="${cls}" style="${side};width:${w}px"></i></span>`;
}

/* --- the three views ---------------------------------------------------- */

function f13RowsHoldings(flows, exposures, mgrNames) {
  const rows = [];
  for (const sym of allUnderlyings()) {
    const exp = exposures.bySymbol[sym];
    rows.push({ sym, exposure: exp ? exp.exposure : 0, flow: f13Flow(flows, sym) });
  }
  rows.sort((a, b) => b.exposure - a.exposure || a.sym.localeCompare(b.sym));
  return rows;
}

function f13RowsExits(flows, exposures, mgrNames) {
  return f13RowsHoldings(flows, exposures, mgrNames)
    .filter(r => r.flow && r.flow.net_shares < 0)
    .sort((a, b) => a.flow.net_shares - b.flow.net_shares);
}

function f13RowsGaps(flows, exposures) {
  const held = new Set();
  for (const sym of allUnderlyings()) {
    for (const t of (F13_CLASS_OF[sym] || [sym])) held.add(t);
  }
  const out = [];
  for (const [tk, f] of Object.entries(flows)) {
    if (held.has(tk) || f.buy < 2) continue;
    out.push({ sym: tk, exposure: 0, flow: { ...f, net_heads: 2 * f.buy + f.add - 2 * f.sell - f.reduce } });
  }
  out.sort((a, b) => b.flow.buy - a.flow.buy || b.flow.net_heads - a.flow.net_heads);
  return out.slice(0, 25);
}

// One line for everything 13F cannot see, listed largest exposure first so
// the names worth knowing about sit at the front of the sentence.
function f13UncoveredRow(uncovered) {
  if (!uncovered.length) return "";
  const total = uncovered.reduce((s, r) => s + r.exposure, 0);
  const names = uncovered
    .slice()
    .sort((a, b) => b.exposure - a.exposure)
    .map(r => esc(r.sym))
    .join("、");
  return `<tr class="f13-uncovered">
    <td><b>13F 未覆盖</b></td>
    <td class="num">${fmtMoney(total)}</td>
    <td colspan="4"><span class="f13-uncovered-names">${names}</span>
      <span class="muted">共 ${uncovered.length} 只 —— 13F 只报美股多头，
      这些标的不在申报范围内，是这张表看不到，不是没人要</span></td></tr>`;
}

/* --- render ------------------------------------------------------------- */

const F13_HEADS = {
  holdings: `<tr><th>标的</th><th class="num">你的敞口</th>
      <th class="num f13-counts-h">建/加/减/清</th><th class="num">机构净股数</th>
      <th class="num">净人头</th><th>主要动作方</th></tr>`,
  exits: `<tr><th>标的</th><th class="num">你的敞口</th>
      <th class="num f13-counts-h">建/加/减/清</th><th class="num">机构净股数</th>
      <th class="num">净人头</th><th>主要卖方</th></tr>`,
  gaps: `<tr><th>标的</th><th>公司</th>
      <th class="num f13-counts-h">建/加/减/清</th><th class="num">机构净股数</th>
      <th class="num">净人头</th><th>主要买方</th></tr>`,
};

const F13_NOTES = {
  holdings: "你持有的每个标的（正股或期权），按你的敞口从大到小。「机构净股数」= 本季建仓+加仓的股数 − 减仓+清仓的股数。",
  exits: "你还拿着、但机构本季净卖出的标的，按卖得最狠的排在最前。",
  gaps: "至少 2 家机构本季全新建仓、而你零敞口的标的（前 25）。",
};

function renderSuperinvestors() {
  const body = $("f13-body"), head = $("f13-head");
  const note = $("f13-note"), foot = $("f13-foot");
  const cache = currentDataRef.f13;
  const data = currentDataRef.data;
  if (!body || !head) return;

  if (!cache || cache.empty) {
    head.innerHTML = "";
    body.innerHTML = `<tr><td colspan="6" class="f13-empty">
      还没有 13F 数据。<button id="f13-fetch" class="ghost-btn" type="button">抓取 Dataroma</button>
      <span class="muted">首次抓取约 2 分钟（83 位管理人 + 分页）</span></td></tr>`;
    note.textContent = "";
    foot.innerHTML = F13_FOOT_BASE;
    const btn = $("f13-fetch");
    if (btn) btn.addEventListener("click", fetch13F);
    return;
  }
  if (!data) return;

  const flows = cache.flows || {};
  const mgrNames = {};
  for (const m of cache.managers || []) mgrNames[m.code] = m.name;
  const exposures = currentExposures();

  const all = f13Mode === "gaps" ? f13RowsGaps(flows, exposures)
    : f13Mode === "exits" ? f13RowsExits(flows, exposures, mgrNames)
    : f13RowsHoldings(flows, exposures, mgrNames);

  // Tickers 13F cannot see get one collapsed line at the bottom instead of a
  // row each. They carry no comparison — a row per ticker spent a third of the
  // table repeating the same sentence and pushed the names that DO have flow
  // off the screen. The roster still has to name them, though: silently dropping
  // a position would make the panel look like a complete view of the book
  // when it is a view of the covered part.
  const rows = all.filter(r => r.flow);
  const uncovered = all.filter(r => !r.flow);

  const scale = rows.reduce((m, r) => Math.max(m, Math.abs(r.flow.net_shares)), 0);

  head.innerHTML = F13_HEADS[f13Mode];
  if (!rows.length && !uncovered.length) {
    body.innerHTML = `<tr><td colspan="6" class="f13-empty">没有符合的标的</td></tr>`;
  } else {
    body.innerHTML = rows.map(r => {
      const f = r.flow;
      // The badge names only the OTHER classes — repeating the row's own
      // ticker inside it reads as "GOOGGOOG+GOOGL".
      const alsoIn = f && f.merged ? f.merged.filter(t => t !== r.sym) : [];
      const name = `<b>${esc(r.sym)}</b>` + (alsoIn.length
        ? `<span class="f13-merged" title="同一家公司的另一股份类别，流向已合并">+${esc(alsoIn.join("+"))}</span>`
        : "");
      const first = f13Mode === "gaps"
        ? `<td>${name}</td><td class="co">${esc(f.company || "")}</td>`
        : `<td>${name}</td><td class="num">${fmtMoney(r.exposure)}</td>`;
      const who = f13Who(f, f13Mode === "gaps" ? "buy" : (f13Mode === "exits" ? "sell" : (f.net_shares >= 0 ? "buy" : "sell")), mgrNames);
      return `<tr>${first}
        <td class="num">${f13Counts(f)}</td>
        <td class="num ${f.net_shares >= 0 ? "up" : "down"}">${f13Fmt.shares(f.net_shares)} ${f13Bar(f.net_shares, scale)}</td>
        <td class="num ${f.net_heads >= 0 ? "up" : "down"}">${f13Fmt.heads(f.net_heads)}</td>
        <td>${who}</td></tr>`;
    }).join("") + f13UncoveredRow(uncovered);
  }

  const filed = (cache.managers || []).filter(m => m.quarter === cache.quarter).length;
  const behind = (cache.managers || []).filter(m => m.quarter && m.quarter !== cache.quarter);
  note.innerHTML = `${esc(cache.quarter || "?")} · 持仓日 ${esc(cache.as_of || "?")} · `
    + `${filed} 位管理人已报 · ${(cache.row_count || 0).toLocaleString("en-US")} 条动作 · `
    + `<b>下次 13F 截止 ${esc(cache.next_due || "?")}</b>`
    + (cache.stale ? ' <span class="down">· 已过截止日，可以重抓</span>' : "")
    + ` <button id="f13-fetch" class="link-btn" type="button">重抓</button>`;
  $("f13-fetch").addEventListener("click", fetch13F);

  foot.innerHTML = F13_NOTES[f13Mode] + " " + F13_FOOT_BASE
    + (behind.length ? `<br><b>${behind.length} 位管理人还没报本季</b>（${behind.map(m => esc(m.name.split(" - ")[0])).join("、")}），
       他们的旧数据已从统计中剔除，不是按上季当本季算。` : "");
}

const F13_FOOT_BASE = `
  数据源 <b>Dataroma</b> 抓的 <b>Form 13F-HR</b>，每季一次，季末后 <b>45 天</b>截止申报，
  周末/联邦假日顺延到下一个工作日。EDGAR 上核过：管理人基本都卡在截止日<b>当天</b>报
  （Q2 2026 全在 2026-08-14），所以数据是<b>某一天跳变</b>，不是慢慢渗出来的。
  <br><b>这张表的三个硬边界</b>：①13F 是<b>季末快照</b>不是成交流水，季内开了又平的仓永远不出现；
  ②披露时已经滞后最多 45 天，到下一次截止前最多滞后 135 天；
  ③<b>只报美股多头</b> —— 做空、期权义务、债券、非美上市全都没有。你账上 26 张卖方合约的风险，
  这个数据源<b>结构上就看不到</b>，别拿它当风险对照。
  <br><b>两个方向指标故意不合并</b>：「净人头」按管理人数计（建仓/清仓算两票，加减算一票），
  「净股数」按股数计。两者相反时才是最有信息量的时候 —— Q2 2026 的 Alphabet 就是：
  27 家在减（人头 −27），但 Berkshire 一家两类合计加了 4,800 万股（股数 +3,090 万）。
  排序用的是<b>股数</b>。`;

/* --- fetch -------------------------------------------------------------- */

async function fetch13F() {
  try {
    const res = await fetch("/api/superinvestors/refresh", { method: "POST" });
    if (res.status === 409) { showToast("info", "13F 抓取已在进行中", "", 3000); return; }
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    showToast("info", "开始抓取 13F", "83 位管理人，约 2 分钟", 4000);
    poll13F();
  } catch (exc) {
    showToast("error", "13F 抓取启动失败", String(exc.message || exc), 6000);
  }
}

function poll13F() {
  const tick = async () => {
    let st;
    try {
      st = await (await fetch("/api/superinvestors/status")).json();
    } catch { return; }
    const note = $("f13-note");
    if (st.in_progress) {
      if (note) note.textContent = `抓取中… ${st.done}/${st.total || "?"} 位管理人（${st.elapsed_sec || 0}s）`;
      setTimeout(tick, 2000);
      return;
    }
    if (st.error) {
      // showToast renders title/detail as textContent, so this must be the
      // raw server string — esc() here would print the entities literally.
      showToast("error", "13F 抓取失败", st.error, 8000);
      renderSuperinvestors();
      return;
    }
    await load13F();
    showToast("ok", "13F 数据已更新", "", 3000);
  };
  setTimeout(tick, 1500);
}

async function load13F() {
  try {
    const res = await fetch("/api/superinvestors");
    currentDataRef.f13 = res.ok ? await res.json() : null;
  } catch {
    currentDataRef.f13 = null;
  }
  renderSuperinvestors();
}
