// 読み取り専用ダッシュボード（1 ファイル・外部依存なし・操作ボタンなし。§1/§14）。
// データは /dash/data.json（現在状態）と /dash/history.json（Analytics Engine 24h）から取得。
// チャート規約: 2px ライン・端点マーカー r4+2px サーフェスリング・ヘアライン実線グリッド・
// 系列色は検証済みパレットの固定順・凡例(≥2系列)+クロスヘアツールチップ+データ表ツイン。

export function dashPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>homectl</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300;
  --seq-track: #cde2fb;
  --status-warn: #fab219;
  --status-critical: #d03b3b;
  --status-good: #0ca30c;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300;
    --seq-track: #184f95;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px; line-height: 1.5;
}
main { max-width: 1080px; margin: 0 auto; padding: 16px 16px 48px; }
header.site { display: flex; align-items: baseline; gap: 12px; padding: 20px 0 4px; flex-wrap: wrap; }
header.site h1 { font-size: 18px; margin: 0; font-weight: 650; }
header.site .sub { color: var(--muted); font-size: 12px; }
.banner {
  display: none; margin: 12px 0; padding: 10px 14px; border-radius: 8px;
  background: color-mix(in srgb, var(--status-critical) 12%, var(--surface));
  border: 1px solid var(--status-critical); color: var(--ink); font-weight: 600;
}
.banner.show { display: block; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 16px 0; }
.tile {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px;
}
.tile .label { color: var(--ink-2); font-size: 12px; }
.tile .value { font-size: 30px; font-weight: 650; margin-top: 2px; }
.tile .value .unit { font-size: 14px; font-weight: 500; color: var(--ink-2); margin-left: 3px; }
.tile .note { color: var(--muted); font-size: 12px; margin-top: 2px; }
.meter { height: 6px; border-radius: 3px; background: var(--seq-track); margin-top: 10px; overflow: hidden; }
.meter > div { height: 100%; border-radius: 3px; background: var(--s1); }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 16px 16px 12px; margin: 16px 0;
}
.card h2 { font-size: 14px; font-weight: 650; margin: 0; }
.card .desc { color: var(--muted); font-size: 12px; margin: 2px 0 10px; }
.chart-wrap { position: relative; outline: none; }
.chart-wrap:focus-visible { box-shadow: 0 0 0 2px var(--s1); border-radius: 6px; }
.chart-wrap svg { display: block; width: 100%; height: auto; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 6px 2px 2px; }
.legend .item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2); }
.legend .key { width: 14px; height: 0; border-top: 3px solid; border-radius: 2px; }
.tooltip {
  position: absolute; pointer-events: none; display: none; z-index: 10;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.13); min-width: 130px;
}
.tooltip .t { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
.tooltip .row { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 1px 0; }
.tooltip .row .key { width: 12px; height: 0; border-top: 3px solid; border-radius: 2px; flex: none; }
.tooltip .row .v { font-weight: 650; font-variant-numeric: tabular-nums; }
.tooltip .row .n { color: var(--ink-2); }
details.tablev { margin-top: 8px; }
details.tablev summary { color: var(--muted); font-size: 12px; cursor: pointer; }
.scroll-x { overflow-x: auto; }
table.data { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; }
table.data th, table.data td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
table.data th { color: var(--muted); font-weight: 500; }
table.data td.num { font-variant-numeric: tabular-nums; }
table.data.hist { max-height: 260px; }
.hist-box { max-height: 280px; overflow-y: auto; }
.badge {
  display: inline-block; font-size: 11px; border: 1px solid var(--border); border-radius: 999px;
  padding: 0 8px; margin-right: 4px; color: var(--ink-2); background: transparent;
}
.badge.assumed { border-style: dashed; }
.stale { color: var(--ink-2); }
.stale .dot { color: var(--status-warn); }
.empty { color: var(--muted); padding: 24px 0 16px; text-align: center; font-size: 13px; }
footer { color: var(--muted); font-size: 12px; margin-top: 24px; }
a { color: var(--s1); }
</style>
</head>
<body>
<main>
  <header class="site">
    <h1>homectl</h1>
    <span class="sub" id="generated-at"></span>
  </header>
  <div class="banner" id="kill-banner">🚨 キルスイッチ ON — 全ての機器操作を拒否中（解除は MCP の set_kill_switch）</div>

  <section class="tiles" id="tiles"></section>

  <section class="card" id="power-card" hidden>
    <h2>消費電力（合計）</h2>
    <p class="desc">直近 24 時間 / 10 分平均 / power_read を持つ全機器の合算</p>
    <div id="power-chart"></div>
    <details class="tablev"><summary>データ表</summary><div class="hist-box scroll-x" id="power-table"></div></details>
  </section>

  <section class="card" id="temp-card" hidden>
    <h2>温度</h2>
    <p class="desc" id="temp-desc">直近 24 時間 / 10 分平均</p>
    <div id="temp-chart"></div>
    <details class="tablev"><summary>データ表</summary><div class="hist-box scroll-x" id="temp-table"></div></details>
  </section>

  <section class="card" id="history-note" hidden>
    <h2>履歴グラフ</h2>
    <p class="desc" id="history-note-text"></p>
  </section>

  <section class="card">
    <h2>機器</h2>
    <p class="desc">状態キャッシュの最新値（取得元と時刻つき）。このページに操作ボタンはない — 操作は MCP 経由</p>
    <div class="scroll-x"><table class="data" id="devices-table"></table></div>
  </section>

  <footer>読み取り専用ダッシュボード / homectl</footer>
</main>
<script>
"use strict";
(async function () {
  const $ = (id) => document.getElementById(id);
  const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6"];
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmtJst = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
  const fmtJstFull = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const [data, history] = await Promise.all([
    fetch("/dash/data.json").then((r) => r.json()),
    fetch("/dash/history.json?hours=24").then((r) => r.json()).catch(() => ({ configured: false, rows: [] })),
  ]);

  $("generated-at").textContent = "取得 " + data.generatedAt;
  if (data.killSwitch) $("kill-banner").classList.add("show");

  // ---- タイル ----
  const hasCap = (d, c) => d.device.capabilities.some((x) => x.capability === c);
  const powerDevices = data.devices.filter((d) => hasCap(d, "power_read"));
  const totalW = powerDevices.reduce((a, d) => a + (typeof d.state?.powerW === "number" ? d.state.powerW : 0), 0);
  const staleCount = data.devices.filter(
    (d) => d.updatedAtMs !== null && data.now - d.updatedAtMs > 2 * 3600e3,
  ).length;

  const tiles = $("tiles");
  {
    const t = el("div", "tile");
    t.append(el("div", "label", "現在の合計消費電力"));
    const v = el("div", "value", powerDevices.length ? String(Math.round(totalW)) : "—");
    if (powerDevices.length) v.append(el("span", "unit", "W"));
    t.append(v);
    t.append(el("div", "note", powerDevices.length ? powerDevices.length + " 機器の合算" : "power_read 機器なし"));
    tiles.append(t);
  }
  {
    const t = el("div", "tile");
    t.append(el("div", "label", "機器"));
    t.append(el("div", "value", String(data.devices.length)));
    t.append(el("div", "note", staleCount ? "⚠ " + staleCount + " 台が 2 時間以上未更新" : "全機器が最近更新"));
    tiles.append(t);
  }
  for (const b of data.rateBudget) {
    const t = el("div", "tile");
    t.append(el("div", "label", "API 残枠 — " + b.vendor));
    const pct = b.dailyLimit > 0 ? (b.used / b.dailyLimit) * 100 : 0;
    const v = el("div", "value", String(b.used));
    v.append(el("span", "unit", "/ " + b.dailyLimit.toLocaleString()));
    t.append(v);
    const note = el("div", "note");
    note.textContent =
      pct >= 95 ? "🚨 95% 超 — ポーリング停止中" : pct >= 80 ? "⚠ 80% 超" : "本日 " + pct.toFixed(1) + "% 消費";
    t.append(note);
    const meter = el("div", "meter");
    const fill = el("div");
    fill.style.width = Math.min(100, pct) + "%";
    if (pct >= 95) fill.style.background = css("--status-critical");
    else if (pct >= 80) fill.style.background = css("--status-warn");
    meter.append(fill);
    t.append(meter);
    tiles.append(t);
  }

  // ---- 履歴の整形 ----
  const BUCKET = 10 * 60; // 秒
  const deviceById = new Map(data.devices.map((d) => [d.device.id, d]));
  const buckets = new Map(); // t(sec) -> Map(deviceId -> row)
  if (history.configured) {
    for (const r of history.rows) {
      if (!buckets.has(r.t)) buckets.set(r.t, new Map());
      buckets.get(r.t).set(r.device_id, r);
    }
  }
  const times = [...buckets.keys()].sort((a, b) => a - b);

  function lineChart(container, tableContainer, seriesDefs, opts) {
    // seriesDefs: [{ id, label, color, points: Map(t -> value) }]
    const W = 860, H = 250, M = { t: 14, r: 18, b: 30, l: 48 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const ns = "http://www.w3.org/2000/svg";
    const svgEl = (t) => document.createElementNS(ns, t);
    const nowSec = Math.floor(data.now / 1000);
    const x0 = nowSec - (opts.hours || 24) * 3600, x1 = nowSec;
    const X = (t) => M.l + ((t - x0) / (x1 - x0)) * iw;

    let values = [];
    for (const s of seriesDefs) values.push(...s.points.values());
    if (!values.length) {
      container.append(el("div", "empty", "まだデータがない（デプロイ直後は最初のポーリングを待つ）"));
      return;
    }
    let ymin = opts.zeroBase ? 0 : Math.min(...values);
    let ymax = Math.max(...values);
    if (ymin === ymax) { ymax += 1; ymin = opts.zeroBase ? 0 : ymin - 1; }
    const pad = (ymax - ymin) * 0.08;
    if (!opts.zeroBase) ymin -= pad;
    ymax += pad;
    const Y = (v) => M.t + ih - ((v - ymin) / (ymax - ymin)) * ih;

    const svg = svgEl("svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", opts.ariaLabel);

    // Y グリッド（ヘアライン実線・控えめ）+ 目盛り
    const yTicks = niceTicks(ymin, ymax, 4);
    for (const v of yTicks) {
      const y = Y(v);
      const ln = svgEl("line");
      ln.setAttribute("x1", M.l); ln.setAttribute("x2", W - M.r);
      ln.setAttribute("y1", y); ln.setAttribute("y2", y);
      ln.setAttribute("stroke", css("--grid")); ln.setAttribute("stroke-width", "1");
      svg.append(ln);
      const tx = svgEl("text");
      tx.setAttribute("x", M.l - 8); tx.setAttribute("y", y + 4);
      tx.setAttribute("text-anchor", "end");
      tx.setAttribute("fill", css("--muted")); tx.setAttribute("font-size", "11");
      tx.setAttribute("style", "font-variant-numeric: tabular-nums");
      tx.append(document.createTextNode(v.toLocaleString()));
      svg.append(tx);
    }
    // X 目盛り（4h ごと）
    for (let t = Math.ceil(x0 / (4 * 3600)) * 4 * 3600; t <= x1; t += 4 * 3600) {
      const tx = svgEl("text");
      tx.setAttribute("x", X(t)); tx.setAttribute("y", H - 8);
      tx.setAttribute("text-anchor", "middle");
      tx.setAttribute("fill", css("--muted")); tx.setAttribute("font-size", "11");
      tx.append(document.createTextNode(fmtJst.format(new Date(t * 1000))));
      svg.append(tx);
    }
    // ベースライン
    const base = svgEl("line");
    base.setAttribute("x1", M.l); base.setAttribute("x2", W - M.r);
    base.setAttribute("y1", M.t + ih); base.setAttribute("y2", M.t + ih);
    base.setAttribute("stroke", css("--axis")); base.setAttribute("stroke-width", "1");
    svg.append(base);

    // 系列（線 2px round・ギャップ>2.5バケットで分断・単系列はエリアウォッシュ 10%）
    for (const s of seriesDefs) {
      const ts = [...s.points.keys()].sort((a, b) => a - b);
      let segs = [], cur = [];
      for (let i = 0; i < ts.length; i++) {
        if (cur.length && ts[i] - ts[i - 1] > BUCKET * 2.5) { segs.push(cur); cur = []; }
        cur.push(ts[i]);
      }
      if (cur.length) segs.push(cur);
      for (const seg of segs) {
        const d = seg.map((t, i) => (i ? "L" : "M") + X(t).toFixed(1) + " " + Y(s.points.get(t)).toFixed(1)).join(" ");
        if (seriesDefs.length === 1 && opts.zeroBase && seg.length > 1) {
          const area = svgEl("path");
          const y0 = Y(ymin);
          area.setAttribute("d", d + " L" + X(seg[seg.length - 1]).toFixed(1) + " " + y0 + " L" + X(seg[0]).toFixed(1) + " " + y0 + " Z");
          area.setAttribute("fill", s.color); area.setAttribute("fill-opacity", "0.1");
          svg.append(area);
        }
        const path = svgEl("path");
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", s.color);
        path.setAttribute("stroke-width", "2");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.append(path);
      }
      // 端点マーカー r4 + 2px サーフェスリング
      const lastT = ts[ts.length - 1];
      if (lastT !== undefined) {
        const c = svgEl("circle");
        c.setAttribute("cx", X(lastT)); c.setAttribute("cy", Y(s.points.get(lastT)));
        c.setAttribute("r", "4");
        c.setAttribute("fill", s.color);
        c.setAttribute("stroke", css("--surface")); c.setAttribute("stroke-width", "2");
        svg.append(c);
      }
    }

    // 直接ラベル（2〜4 系列のとき、端点の内側上に系列名。衝突したら凡例+ツールチップに任せて省く）
    if (seriesDefs.length >= 2 && seriesDefs.length <= 4) {
      const ends = seriesDefs
        .map((s) => {
          const ts = [...s.points.keys()].sort((a, b) => a - b);
          const lastT = ts[ts.length - 1];
          return lastT === undefined ? null : { s, x: X(lastT), y: Y(s.points.get(lastT)) };
        })
        .filter((e) => e !== null)
        .sort((a, b) => a.y - b.y);
      for (let i = 0; i < ends.length; i++) {
        const collides =
          (i > 0 && ends[i].y - ends[i - 1].y < 16) || (i + 1 < ends.length && ends[i + 1].y - ends[i].y < 16);
        if (collides) continue; // 積み重ねて線から遊離させるくらいなら出さない
        const e = ends[i];
        const tx = svgEl("text");
        tx.setAttribute("x", e.x - 9);
        tx.setAttribute("y", e.y - 9);
        tx.setAttribute("text-anchor", "end");
        tx.setAttribute("fill", css("--ink-2"));
        tx.setAttribute("font-size", "11");
        tx.append(document.createTextNode(e.s.label));
        svg.append(tx);
      }
    }

    // クロスヘア + ツールチップ（凡例と表がゲートなしの読み取り経路）
    const wrap = el("div", "chart-wrap");
    wrap.tabIndex = 0;
    wrap.setAttribute("aria-label", opts.ariaLabel + "。矢印キーで時刻を移動");
    const cross = svgEl("line");
    cross.setAttribute("y1", M.t); cross.setAttribute("y2", M.t + ih);
    cross.setAttribute("stroke", css("--axis")); cross.setAttribute("stroke-width", "1");
    cross.setAttribute("visibility", "hidden");
    svg.append(cross);
    const tip = el("div", "tooltip");
    wrap.append(svg, tip);
    container.append(wrap);

    const allTimes = [...new Set(seriesDefs.flatMap((s) => [...s.points.keys()]))].sort((a, b) => a - b);
    let tipIdx = -1;
    function showTip(idx) {
      if (idx < 0 || idx >= allTimes.length) return;
      tipIdx = idx;
      const t = allTimes[idx];
      cross.setAttribute("x1", X(t)); cross.setAttribute("x2", X(t));
      cross.setAttribute("visibility", "visible");
      tip.replaceChildren(el("div", "t", fmtJstFull.format(new Date(t * 1000))));
      for (const s of seriesDefs) {
        const v = s.points.get(t);
        if (v === undefined) continue;
        const row = el("div", "row");
        const key = el("span", "key");
        key.style.borderTopColor = s.color;
        row.append(key, el("span", "v", v.toLocaleString(undefined, { maximumFractionDigits: 1 }) + (opts.unit || "")), el("span", "n", s.label));
        tip.append(row);
      }
      tip.style.display = "block";
      const rect = wrap.getBoundingClientRect();
      const px = (X(t) / W) * rect.width;
      tip.style.left = Math.min(Math.max(px + 12, 0), rect.width - tip.offsetWidth - 4) + "px";
      tip.style.top = "8px";
    }
    function hideTip() {
      tip.style.display = "none";
      cross.setAttribute("visibility", "hidden");
      tipIdx = -1;
    }
    wrap.addEventListener("pointermove", (ev) => {
      if (!allTimes.length) return;
      const rect = wrap.getBoundingClientRect();
      const t = x0 + ((ev.clientX - rect.left) / rect.width) * (x1 - x0);
      let best = 0, bd = Infinity;
      for (let i = 0; i < allTimes.length; i++) {
        const d = Math.abs(allTimes[i] - t);
        if (d < bd) { bd = d; best = i; }
      }
      showTip(best);
    });
    wrap.addEventListener("pointerleave", hideTip);
    wrap.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowRight") { showTip(tipIdx < 0 ? allTimes.length - 1 : Math.min(tipIdx + 1, allTimes.length - 1)); ev.preventDefault(); }
      else if (ev.key === "ArrowLeft") { showTip(tipIdx < 0 ? allTimes.length - 1 : Math.max(tipIdx - 1, 0)); ev.preventDefault(); }
      else if (ev.key === "Escape") hideTip();
    });
    wrap.addEventListener("blur", hideTip);

    // 凡例（2 系列以上は必須。テキストは text token、識別は横のラインキー）
    if (seriesDefs.length >= 2) {
      const lg = el("div", "legend");
      for (const s of seriesDefs) {
        const item = el("span", "item");
        const key = el("span", "key");
        key.style.borderTopColor = s.color;
        item.append(key, document.createTextNode(s.label));
        lg.append(item);
      }
      container.append(lg);
    }

    // データ表ツイン（ツールチップはゲートしない）
    const table = el("table", "data hist");
    const thead = el("thead"); const trh = el("tr");
    trh.append(el("th", "", "時刻 (JST)"));
    for (const s of seriesDefs) trh.append(el("th", "", s.label));
    thead.append(trh); table.append(thead);
    const tbody = el("tbody");
    for (const t of allTimes) {
      const tr = el("tr");
      tr.append(el("td", "", fmtJstFull.format(new Date(t * 1000))));
      for (const s of seriesDefs) {
        const v = s.points.get(t);
        tr.append(el("td", "num", v === undefined ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 1 })));
      }
      tbody.append(tr);
    }
    table.append(tbody);
    tableContainer.append(table);
  }

  function niceTicks(min, max, n) {
    const span = max - min;
    const step = Math.pow(10, Math.floor(Math.log10(span / n)));
    const err = span / n / step;
    const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    const s = step * mult;
    const ticks = [];
    for (let v = Math.ceil(min / s) * s; v <= max; v += s) ticks.push(Math.round(v * 1000) / 1000);
    return ticks;
  }

  // ---- チャート描画 ----
  if (!history.configured) {
    $("history-note").hidden = false;
    $("history-note-text").textContent =
      "Analytics Engine の SQL API が未設定（CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN）。現在値は下の機器表で見られる。";
  } else if (history.error) {
    $("history-note").hidden = false;
    $("history-note-text").textContent = "履歴の取得に失敗: " + history.error;
  } else {
    // 消費電力（合計・単系列）
    if (powerDevices.length) {
      $("power-card").hidden = false;
      const pts = new Map();
      for (const t of times) {
        let sum = 0, seen = false;
        for (const [id, r] of buckets.get(t)) {
          const dd = deviceById.get(id);
          if (dd && hasCap(dd, "power_read") && typeof r.powerW === "number") { sum += r.powerW; seen = true; }
        }
        if (seen) pts.set(t, Math.round(sum));
      }
      lineChart($("power-chart"), $("power-table"),
        [{ id: "total", label: "合計電力", color: css("--s1"), points: pts }],
        { unit: " W", zeroBase: true, hours: 24, ariaLabel: "直近24時間の合計消費電力" });
    }
    // 温度（機器ごと・最大 6 系列にキャップ、色は id 順で固定割当）
    const tempDevices = data.devices.filter((d) => hasCap(d, "temperature_read"))
      .sort((a, b) => a.device.id.localeCompare(b.device.id));
    if (tempDevices.length) {
      $("temp-card").hidden = false;
      const shown = tempDevices.slice(0, SERIES.length);
      if (tempDevices.length > shown.length) {
        $("temp-desc").textContent = "直近 24 時間 / 10 分平均 / 先頭 " + shown.length + " 機器（残りはデータ表・機器表を参照）";
      }
      const defs = shown.map((d, i) => {
        const pts = new Map();
        for (const t of times) {
          const r = buckets.get(t).get(d.device.id);
          if (r && typeof r.tempC === "number" && r.tempC !== 0) pts.set(t, r.tempC);
        }
        return { id: d.device.id, label: d.device.name, color: css(SERIES[i]), points: pts };
      }).filter((s) => s.points.size > 0);
      if (defs.length) {
        lineChart($("temp-chart"), $("temp-table"), defs,
          { unit: " ℃", zeroBase: false, hours: 24, ariaLabel: "直近24時間の機器別温度" });
      } else {
        $("temp-chart").append(el("div", "empty", "まだデータがない（デプロイ直後は最初のポーリングを待つ）"));
      }
    }
  }

  // ---- 機器表 ----
  const tbl = $("devices-table");
  {
    const thead = el("thead"); const tr = el("tr");
    for (const h of ["機器", "部屋", "状態", "能力（フィードバック信頼度）", "更新"]) tr.append(el("th", "", h));
    thead.append(tr); tbl.append(thead);
    const tbody = el("tbody");
    for (const d of data.devices) {
      const tr2 = el("tr");
      tr2.append(el("td", "", d.device.name));
      tr2.append(el("td", "", d.device.room));
      const stateTd = el("td", "num");
      stateTd.textContent = d.state ? summarizeState(d.state) : "—";
      tr2.append(stateTd);
      const capTd = el("td");
      for (const c of d.device.capabilities) {
        const b = el("span", "badge" + (c.feedback !== "verified" ? " assumed" : ""),
          c.capability + ":" + c.feedback + (c.via ? "→" + c.via : ""));
        capTd.append(b);
      }
      if (!d.device.capabilities.length) capTd.append(el("span", "badge", "能力なし"));
      tr2.append(capTd);
      const upTd = el("td");
      if (d.updatedAtMs === null) upTd.textContent = "未取得";
      else {
        const min = Math.round((data.now - d.updatedAtMs) / 60000);
        const ageText = min < 60 ? min + " 分前" : (min / 60).toFixed(1) + " 時間前";
        if (data.now - d.updatedAtMs > 2 * 3600e3) {
          upTd.className = "stale";
          upTd.append(el("span", "dot", "⚠ "), document.createTextNode(ageText + "（stale） · " + d.source));
        } else {
          upTd.textContent = ageText + " · " + d.source;
        }
      }
      tr2.append(upTd);
      tbody.append(tr2);
    }
    if (!data.devices.length) {
      const tr3 = el("tr");
      const td = el("td", "", "機器なし — secrets を設定してデプロイすると 24 時間以内（初回は数分以内）に自動発見される");
      td.colSpan = 5;
      tr3.append(td);
      tbody.append(tr3);
    }
    tbl.append(tbody);
  }

  function summarizeState(s) {
    const parts = [];
    if (typeof s.temperature === "number") parts.push(s.temperature + "℃");
    if (typeof s.humidity === "number") parts.push(s.humidity + "%");
    if (typeof s.powerW === "number") parts.push(s.powerW + "W");
    if (s.power) parts.push(s.power);
    if (typeof s.setTemp === "number") parts.push("設定" + s.setTemp + "℃");
    if (typeof s.locked === "boolean") parts.push(s.locked ? "施錠" : "解錠");
    if (typeof s.curtainPos === "number") parts.push("開度" + s.curtainPos + "%");
    return parts.join(" / ") || "—";
  }
})().catch((e) => {
  document.body.prepend(Object.assign(document.createElement("pre"), { textContent: "dashboard error: " + e }));
});
</script>
</body>
</html>`;
}
