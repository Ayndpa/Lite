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

/** rows: [[label, value], ...] */
export function showAbout({ appName, t, rows, onChangeLanguage, onChangeTheme }) {
  const { card, close } = modal("about");
  card.innerHTML = `
    <div class="about-head"><div class="about-title"></div></div>
    <dl class="about-rows"></dl>
    <div class="about-actions"><button class="about-btn about-theme"></button><button class="about-btn about-lang"></button><button class="about-btn about-ok"></button></div>`;
  card.querySelector(".about-head").prepend(createLogo(56));
  card.querySelector(".about-title").textContent = appName;
  const dl = card.querySelector(".about-rows");
  for (const [k, v] of rows) {
    dl.append(Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: v }));
  }
  const ok = card.querySelector(".about-ok");
  ok.textContent = t("about.ok");
  ok.onclick = close;
  const lang = card.querySelector(".about-lang");
  lang.textContent = t("about.changeLanguage");
  lang.onclick = () => { close(); onChangeLanguage(); };
  const theme = card.querySelector(".about-theme");
  theme.textContent = t("about.changeTheme");
  theme.onclick = () => { close(); onChangeTheme(); };
  ok.focus();
}

/** options: [{ id (null = auto), name }]; current: the saved preference (null = auto). */
export function showLanguagePicker({ t, options, current, onPick }) {
  const { card, close } = modal("language");
  card.innerHTML = `
    <div class="about-title lang-title"></div>
    <div class="lang-options" role="radiogroup"></div>
    <p class="lang-hint"></p>
    <div class="about-actions"><button class="about-btn lang-cancel"></button></div>`;
  card.querySelector(".lang-title").textContent = t("language.title");
  card.querySelector(".lang-hint").textContent = t("language.reloadHint");
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
 * Focusing an option (arrows, Tab, hover) previews it; Cancel / Escape go back via onCancel.
 */
export function showThemePicker({ t, options, current, preview, onPick, onCancel, onCustomize }) {
  const { card, close } = modal("theme", onCancel);
  card.innerHTML = `
    <div class="about-title lang-title"></div>
    <div class="lang-options theme-options" role="radiogroup"></div>
    <p class="lang-hint"></p>
    <div class="about-actions"><button class="about-btn theme-customize"></button><button class="about-btn lang-cancel"></button></div>`;
  card.querySelector(".lang-title").textContent = t("theme.title");
  card.querySelector(".lang-hint").textContent = t("theme.hint");
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
    btn.onmouseenter = () => btn.focus();
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
