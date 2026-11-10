// Kernel-owned "shell" visuals: the logo, the background watermark, the About dialog and the
// language and color theme pickers.
// The watermark sits under the #root slot, so any plugin with an opaque surface (e.g. the workbench) hides it.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Logo: three modules plus an accent one being plugged in. */
const LOGO_BLOCKS = [
  { x: 6, y: 6, s: 24, cls: "logo-block" },
  { x: 34, y: 6, s: 24, cls: "logo-block" },
  { x: 6, y: 34, s: 24, cls: "logo-block" },
  { x: 36, y: 36, s: 22, cls: "logo-accent" },
];

export function createLogo(size = 64) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("class", "lite-logo");
  svg.setAttribute("aria-hidden", "true");
  for (const b of LOGO_BLOCKS) {
    const r = document.createElementNS(SVG_NS, "rect");
    for (const [k, v] of Object.entries({ x: b.x, y: b.y, width: b.s, height: b.s, rx: 6, class: b.cls })) r.setAttribute(k, v);
    svg.appendChild(r);
  }
  return svg;
}

const KEY_LABELS = {
  arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", escape: "Esc", pageup: "PgUp",
  pagedown: "PgDn", delete: "Del", insert: "Ins", backspace: "Backspace", meta: "Win",
};

/** "ctrl+shift+p" -> ["Ctrl", "Shift", "P"] */
export const formatCombo = (combo) =>
  combo.split("+").map((k) => KEY_LABELS[k] ?? (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)));

export function mountWatermark({ appName, logoTitle, onLogoClick }) {
  const wm = document.createElement("div");
  wm.id = "watermark";
  wm.innerHTML = `
    <button class="wm-logo"></button>
    <div class="wm-name"></div>
    <div class="wm-hints"></div>`;
  const logoBtn = wm.querySelector(".wm-logo");
  logoBtn.title = logoTitle;
  logoBtn.setAttribute("aria-label", logoBtn.title);
  logoBtn.appendChild(createLogo(96));
  logoBtn.onclick = onLogoClick;
  wm.querySelector(".wm-name").textContent = appName;
  document.body.prepend(wm);

  const hintsEl = wm.querySelector(".wm-hints");
  return {
    setName: (name) => (wm.querySelector(".wm-name").textContent = name),
    /** hints: [{ label, combo, run }] */
    renderHints(hints) {
      hintsEl.replaceChildren();
      for (const h of hints) {
        const row = document.createElement("button");
        row.className = "wm-hint";
        row.innerHTML = `<span class="wm-hint-label"></span><span class="wm-keys"></span>`;
        row.firstChild.textContent = h.label;
        for (const k of h.combo ? formatCombo(h.combo) : []) {
          row.lastChild.appendChild(Object.assign(document.createElement("kbd"), { textContent: k }));
        }
        row.onclick = h.run;
        hintsEl.appendChild(row);
      }
    },
  };
}

/**
 * Kernel modal: a card on a dimmed backdrop; Escape or a backdrop click closes it (and calls onDismiss).
 * Returns { card, close }.
 */
function modal(id, onDismiss) {
  document.getElementById(id)?.remove();
  const backdrop = document.createElement("div");
  backdrop.id = id;
  backdrop.className = "kernel-modal";
  backdrop.innerHTML = `<div class="about-card" role="dialog" aria-modal="true"></div>`;
  const close = () => {
    backdrop.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const dismiss = () => { close(); onDismiss?.(); };
  const onKey = (e) => {
    // Enter on a focused button activates that button instead.
    if (e.key === "Escape" || (e.key === "Enter" && !e.target.closest?.("button"))) {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };
  backdrop.addEventListener("mousedown", (e) => e.target === backdrop && dismiss());
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(backdrop);
  return { card: backdrop.firstElementChild, close };
}

// The few Lucide icons the About dialog needs, inlined (the kernel can't depend on the icons plugin).
const ABOUT_ICONS = {
  "palette": [["path", { d: "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" }], ["circle", { cx: "13.5", cy: "6.5", r: ".5", fill: "currentColor" }], ["circle", { cx: "17.5", cy: "10.5", r: ".5", fill: "currentColor" }], ["circle", { cx: "6.5", cy: "12.5", r: ".5", fill: "currentColor" }], ["circle", { cx: "8.5", cy: "7.5", r: ".5", fill: "currentColor" }]],
  "languages": [["path", { d: "m5 8 6 6" }], ["path", { d: "m4 14 6-6 2-3" }], ["path", { d: "M2 5h12" }], ["path", { d: "M7 2h1" }], ["path", { d: "m22 22-5-10-5 10" }], ["path", { d: "M14 18h6" }]],
  "puzzle": [["path", { d: "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" }]],
  "chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
};

function aboutIcon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attrs = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.75,
    "stroke-linecap": "round", "stroke-linejoin": "round", class: "icon", "aria-hidden": "true",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, props] of ABOUT_ICONS[name]) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

/**
 * version: shown under the name; settings: [{ icon: "palette" | "languages" | "puzzle", label, value, run }]
 * — rows that open a setting (the dialog closes first); rows: [[label, value], ...] — plain details.
 */
export function showAbout({ appName, version, t, settings, rows }) {
  const { card, close } = modal("about");
  card.innerHTML = `
    <div class="about-head"><div><div class="about-title"></div><div class="about-version"></div></div></div>
    <div class="about-section"></div>
    <div class="about-settings"></div>
    <div class="about-section"></div>
    <dl class="about-rows"></dl>
    <div class="about-actions"><button class="about-btn about-ok"></button></div>`;
  card.querySelector(".about-head").prepend(createLogo(48));
  card.querySelector(".about-title").textContent = appName;
  card.querySelector(".about-version").textContent = version;
  const [settingsTitle, detailsTitle] = card.querySelectorAll(".about-section");
  settingsTitle.textContent = t("about.settings");
  detailsTitle.textContent = t("about.details");
  const list = card.querySelector(".about-settings");
  for (const s of settings) {
    const btn = document.createElement("button");
    btn.className = "about-setting";
    btn.innerHTML = `<span class="about-setting-label"></span><span class="about-setting-value"></span>`;
    btn.querySelector(".about-setting-label").textContent = s.label;
    btn.querySelector(".about-setting-value").textContent = s.value;
    btn.prepend(aboutIcon(s.icon));
    btn.append(aboutIcon("chevron-right", 14));
    btn.onclick = () => { close(); s.run(); };
    list.append(btn);
  }
  const dl = card.querySelector(".about-rows");
  for (const [k, v] of rows) {
    dl.append(Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: v }));
  }
  const ok = card.querySelector(".about-ok");
  ok.textContent = t("about.ok");
  ok.onclick = close;
  ok.focus();
}

/** options: [{ id (null = auto), name }]; current: the saved preference (null = auto). */
export function showLanguagePicker({ t, options, current, onPick }) {
  const { card, close } = modal("language");
  card.innerHTML = `
    <div class="about-title lang-title"></div>
    <div class="lang-options" role="radiogroup"></div>
    <div class="about-actions"><button class="about-btn lang-cancel"></button></div>`;
  card.querySelector(".lang-title").textContent = t("language.title");
  const cancel = card.querySelector(".lang-cancel");
  cancel.textContent = t("language.cancel");
  cancel.onclick = close;
  const list = card.querySelector(".lang-options");
  for (const o of options) {
    const btn = document.createElement("button");
    btn.className = "lang-option";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(o.id === current));
    btn.textContent = o.name;
    btn.onclick = () => { close(); onPick(o.id); };
    list.appendChild(btn);
  }
  (list.querySelector('[aria-checked="true"]') ?? list.firstElementChild).focus();
}

/**
 * options: [{ id, name, type?, source? }]; current: the saved preference.
 * Focusing an option with the keyboard (arrows, Tab) previews it — the mouse only picks; Cancel / Escape
 * go back via onCancel.
 */
export function showThemePicker({ t, options, current, preview, onPick, onCancel, onCustomize }) {
  const { card, close } = modal("theme", onCancel);
  card.innerHTML = `
    <div class="about-title lang-title"></div>
    <div class="lang-options theme-options" role="radiogroup"></div>
    <div class="about-actions"><button class="about-btn theme-customize"></button><button class="about-btn lang-cancel"></button></div>`;
  card.querySelector(".lang-title").textContent = t("theme.title");
  const cancel = card.querySelector(".lang-cancel");
  cancel.textContent = t("language.cancel");
  cancel.onclick = () => { close(); onCancel(); };
  const customize = card.querySelector(".theme-customize");
  customize.textContent = t("theme.customize");
  customize.hidden = !onCustomize;
  customize.onclick = () => { close(); onCancel(); onCustomize(); };
  const list = card.querySelector(".lang-options");
  const buttons = options.map((o) => {
    const btn = document.createElement("button");
    btn.className = "lang-option";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(o.id === current));
    btn.innerHTML = `<span class="theme-name"></span><small></small>`;
    btn.firstChild.textContent = o.name;
    btn.lastChild.textContent = o.source === "custom" ? t("theme.source.custom") : o.source === "plugin" ? t("theme.source.plugin") : "";
    btn.onfocus = () => preview(o.id);
    btn.onclick = () => { close(); onPick(o.id); };
    list.appendChild(btn);
    return btn;
  });
  list.addEventListener("keydown", (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = buttons.indexOf(document.activeElement);
    buttons[(i + step + buttons.length) % buttons.length].focus();
  });
  (list.querySelector('[aria-checked="true"]') ?? list.firstElementChild).focus();
}

/**
 * A question with buttons: [{ label, value, primary?, danger? }]. Resolves the clicked button's value,
 * or null when dismissed (Escape, backdrop). Only one is open at a time.
 */
export function showConfirm({ title, body, buttons }) {
  return new Promise((resolve) => {
    const { card, close } = modal("confirm", () => resolve(null));
    card.classList.add("confirm-card");
    card.innerHTML = `<div class="confirm-title"></div><p class="confirm-body"></p><div class="about-actions"></div>`;
    card.querySelector(".confirm-title").textContent = title;
    const p = card.querySelector(".confirm-body");
    body ? (p.textContent = body) : p.remove();
    const actions = card.querySelector(".about-actions");
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = `about-btn${b.primary ? " about-ok" : ""}${b.danger ? " confirm-danger" : ""}`;
      btn.textContent = b.label;
      btn.onclick = () => { close(); resolve(b.value); };
      actions.append(btn);
    }
    (actions.querySelector(".about-ok") ?? actions.firstElementChild)?.focus();
  });
}
