// Repository overview tab — git-insight's dashboard: info card, KPIs, commit activity chart, and the
// language breakdown (segmented bar + languages / files lists).
import { overview, lineCounts } from "./git.js";
import { summarize } from "./languages.js";
import { h } from "./ui.js";

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/** env: { ctx, git, icons, openFile(repoRelativePath) } ; returns dispose() */
export function mountOverview(el, env) {
  const { ctx, icons } = env;
  const { t } = ctx;
  const state = { days: 28, respectIgnore: true, tab: "languages", info: null, langs: null };
  let disposed = false;
  el.classList.add("git-ov", "lite-thin-scroll");

  const fmt = (n) => n.toLocaleString(ctx.locale);
  const iconBtn = (icon, title, onclick) => {
    const b = h("button", "git-icon-btn");
    b.title = title;
    b.setAttribute("aria-label", title);
    b.append(icons.create(icon, { size: 15 }));
    b.onclick = onclick;
    return b;
  };

  const head = h("div", "git-ov-head");
  const titleEl = h("h2", null, t("overview.title"));
  head.append(titleEl, iconBtn("refresh-cw", t("action.refresh"), () => load()));
  const infoCard = h("section", "git-card git-ov-info");
  const kpis = h("section", "git-ov-kpis");
  const activity = h("section", "git-card git-ov-activity");
  const langCard = h("section", "git-card git-ov-langs");
  el.append(head, infoCard, kpis, activity, langCard);

  // ---------- info card ----------
  function renderInfo() {
    const i = state.info;
    const rows = [];
    const row = (label, value) => {
      const r = h("div", "git-ov-row");
      r.append(h("span", "git-ov-label", label), value instanceof Node ? value : h("span", null, value ?? "—"));
      rows.push(r);
    };
    const branch = h("span", "git-ov-inline");
    branch.append(icons.create("git-branch", { size: 14 }), h("span", null, i.branch ?? t("noBranch")));
    if (i.upstream) branch.append(h("small", "git-dim", `${i.upstream}  ↑${i.ahead} ↓${i.behind}`));
    row(t("overview.branch"), branch);
    if (i.shortSha) {
      const sha = h("button", "git-link mono", i.shortSha);
      sha.title = t("overview.copySha");
      sha.onclick = () => navigator.clipboard.writeText(i.shortSha).then(() => (sha.textContent = t("overview.copied"), setTimeout(() => (sha.textContent = i.shortSha), 1200)));
      const last = h("span", "git-ov-inline");
      last.append(sha, h("span", "git-ov-subject", i.lastCommit ?? ""), h("small", "git-dim", `${i.lastAuthor ?? ""} · ${relTime(i.lastDate)}`));
      row(t("overview.lastCommit"), last);
    }
    if (i.remote) {
      const remote = h("span", "git-ov-inline");
      if (i.remoteUrl) {
        const a = h("button", "git-link", i.remoteUrl.replace(/^https?:\/\//, ""));
        a.title = t("overview.openRemote");
        a.onclick = () => ctx.openExternal(i.remoteUrl);
        remote.append(a, icons.create("external-link", { size: 12 }));
      } else remote.append(h("span", "mono", i.remote));
      row(t("overview.remote", { name: i.remoteName }), remote);
    }
    infoCard.replaceChildren(...rows);
  }

  function relTime(iso) {
    if (!iso) return "";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(ctx.locale, { numeric: "auto" });
    for (const [unit, sec] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
      if (s >= sec) return rtf.format(-Math.floor(s / sec), unit);
    }
    return rtf.format(0, "second");
  }

  // ---------- KPIs ----------
  function renderKpis() {
    const i = state.info;
    const inPeriod = i.activity.reduce((a, d) => a + d.count, 0);
    const trend = i.prevPeriodCommits ? Math.round(((inPeriod - i.prevPeriodCommits) / i.prevPeriodCommits) * 100) : null;
    const kpi = (label, value, sub, cls = "") => {
      const k = h("div", `git-card git-kpi ${cls}`);
      k.append(h("div", "git-kpi-label", label), h("div", "git-kpi-value", value), h("div", "git-kpi-sub", sub ?? ""));
      return k;
    };
    kpis.replaceChildren(
      kpi(t("overview.commits"), fmt(i.totalCommits), t("overview.inPeriod", { n: fmt(inPeriod), days: state.days })),
      kpi(t("overview.trend"), trend == null ? "—" : `${trend > 0 ? "+" : ""}${trend}%`, t("overview.vsPrev", { days: state.days }), trend > 0 ? "up" : trend < 0 ? "down" : ""),
      kpi(t("overview.changes"), fmt(i.dirty), t("overview.untracked", { n: fmt(i.untracked) }), i.dirty ? "warn" : ""),
      kpi(t("overview.lines"), state.langs ? fmt(state.langs.totalLines) : "…", state.langs ? t("overview.files", { n: fmt(state.langs.totalFiles) }) : ""),
    );
  }

  // ---------- activity chart ----------
  function renderActivity() {
    const data = state.info.activity;
    const top = h("div", "git-card-head");
    top.append(h("h3", null, t("overview.activity")));
    const seg = h("div", "git-seg");
    for (const d of [7, 28, 90]) {
      const b = h("button", d === state.days ? "active" : "", t("overview.days", { n: d }));
      b.onclick = () => { if (state.days !== d) { state.days = d; load({ langs: false }); } };
      seg.append(b);
    }
    top.append(seg);

    const W = 800, H = 160, P = { l: 30, r: 10, t: 10, b: 22 };
    const max = Math.max(1, ...data.map((d) => d.count));
    const x = (i) => P.l + (data.length === 1 ? 0 : (i / (data.length - 1)) * (W - P.l - P.r));
    const y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
    const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "git-chart", preserveAspectRatio: "none" });
    const grid = svg("g", { class: "git-chart-grid" });
    for (const v of [0, Math.ceil(max / 2), max]) {
      grid.append(svg("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v) }));
      const lbl = svg("text", { x: P.l - 6, y: y(v) + 3, "text-anchor": "end" });
      lbl.textContent = v;
      grid.append(lbl);
    }
    const pts = data.map((d, i) => `${x(i)},${y(d.count)}`);
    const defs = svg("defs");
    const grad = svg("linearGradient", { id: "git-area", x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(svg("stop", { offset: "0", "stop-color": "#4d8bf5", "stop-opacity": "0.45" }), svg("stop", { offset: "1", "stop-color": "#4d8bf5", "stop-opacity": "0" }));
    defs.append(grad);
    const area = svg("polygon", { points: `${x(0)},${y(0)} ${pts.join(" ")} ${x(data.length - 1)},${y(0)}`, fill: "url(#git-area)" });
    const line = svg("polyline", { points: pts.join(" "), class: "git-chart-line" });
    const labels = svg("g", { class: "git-chart-grid" });
    const step = Math.ceil(data.length / 7);
    data.forEach((d, i) => {
      if (i % step && i !== data.length - 1) return;
      const l = svg("text", { x: x(i), y: H - 6, "text-anchor": i === 0 ? "start" : i === data.length - 1 ? "end" : "middle" });
      l.textContent = d.date.slice(5);
      labels.append(l);
    });
    const cursor = svg("line", { class: "git-chart-cursor", y1: P.t, y2: H - P.b, visibility: "hidden" });
    const dot = svg("circle", { r: 4, class: "git-chart-dot", visibility: "hidden" });
    chart.append(defs, grid, area, line, labels, cursor, dot);

    const wrap = h("div", "git-chart-wrap");
    const tip = h("div", "git-chart-tip");
    tip.hidden = true;
    wrap.append(chart, tip);
    wrap.onmousemove = (e) => {
      const r = chart.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(data.length - 1, Math.round(((vx - P.l) / (W - P.l - P.r)) * (data.length - 1))));
      for (const el of [cursor, dot]) el.setAttribute("visibility", "visible");
      cursor.setAttribute("x1", x(i)); cursor.setAttribute("x2", x(i));
      dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(data[i].count));
      tip.hidden = false;
      tip.textContent = t("overview.tip", { date: data[i].date, n: data[i].count });
      const px = (x(i) / W) * r.width;
      tip.style.left = `${Math.min(r.width - tip.offsetWidth, Math.max(0, px - tip.offsetWidth / 2))}px`;
    };
    wrap.onmouseleave = () => { tip.hidden = true; for (const el of [cursor, dot]) el.setAttribute("visibility", "hidden"); };
    activity.replaceChildren(top, wrap);
  }

  // ---------- languages ----------
  function renderLangs() {
    const top = h("div", "git-card-head");
    top.append(h("h3", null, t("overview.languages")));
    const toggle = h("label", "git-check");
    const cb = h("input");
    cb.type = "checkbox";
    cb.checked = state.respectIgnore;
    cb.onchange = () => { state.respectIgnore = cb.checked; state.langs = null; renderLangs(); renderKpis(); loadLangs(); };
    toggle.append(cb, h("span", null, t("overview.respectIgnore")));
    top.append(toggle);
    const L = state.langs;
    if (!L) {
      const busy = h("div", "git-dim git-ov-busy");
      busy.append(icons.create("loader-circle", { size: 16, className: "git-spin" }), h("span", null, t("overview.counting")));
      return langCard.replaceChildren(top, busy);
    }
    if (!L.totalLines) return langCard.replaceChildren(top, h("div", "git-dim", t("overview.noFiles")));

    const bar = h("div", "git-langbar");
    for (const g of L.languages) {
      const pct = (g.lines / L.totalLines) * 100;
      if (pct < 0.1) continue;
      const s = h("span");
      s.style.cssText = `width:${pct}%;background:${g.color}`;
      s.title = `${g.name} ${pct.toFixed(1)}%`;
      bar.append(s);
    }
    const tabs = h("div", "git-seg");
    for (const id of ["languages", "files"]) {
      const b = h("button", id === state.tab ? "active" : "", t(`overview.tab.${id}`));
      b.onclick = () => { state.tab = id; renderLangs(); };
      tabs.append(b);
    }
    const list = h("div", "git-ov-list");
    const max = state.tab === "languages" ? L.languages[0].lines : L.topFiles[0]?.lines || 1;
    const item = (color, name, meta, value, onclick) => {
      const r = h(onclick ? "button" : "div", "git-ov-item");
      const sw = h("span", "git-swatch");
      sw.style.background = color;
      const meter = h("span", "git-meter");
      const fill = h("span");
      fill.style.cssText = `width:${(value / max) * 100}%;background:${color}`;
      meter.append(fill);
      r.append(sw, h("span", "git-ov-name", name), h("small", "git-dim", meta), meter, h("span", "git-ov-num", fmt(value)));
      if (onclick) { r.onclick = onclick; r.title = name; }
      return r;
    };
    if (state.tab === "languages") {
      for (const g of L.languages) {
        list.append(item(g.color, g.name, `${((g.lines / L.totalLines) * 100).toFixed(1)}% · ${t("overview.files", { n: fmt(g.files) })}`, g.lines));
      }
    } else {
      for (const f of L.topFiles) list.append(item(f.color, f.path, f.language, f.lines, () => env.openFile(f.path)));
    }
    langCard.replaceChildren(top, bar, tabs, list);
  }

  // ---------- loading ----------
  let loadSeq = 0;
  let langSeq = 0;
  async function loadLangs() {
    const seq = ++langSeq;
    try {
      const counts = await lineCounts(env.git, state.respectIgnore);
      if (disposed || seq !== langSeq) return;
      state.langs = summarize(counts);
    } catch (e) {
      state.langs = { languages: [], totalFiles: 0, totalLines: 0, topFiles: [] };
      console.error("[git] line count failed", e);
    }
    renderLangs();
    renderKpis();
  }

  async function load({ langs = true } = {}) {
    const seq = ++loadSeq;
    titleEl.textContent = t("overview.title");
    try {
      const info = await overview(env.git, state.days);
      if (disposed || seq !== loadSeq) return;
      state.info = info;
    } catch (e) {
      infoCard.replaceChildren(h("div", "git-error", String(e.message ?? e)));
      return;
    }
    if (langs) state.langs = null;
    renderInfo();
    renderKpis();
    renderActivity();
    renderLangs();
    if (langs) loadLangs();
  }

  load();
  return { dispose: () => { disposed = true; }, reload: () => load() };
}
