// Kernel-owned title bar. Projects (folders) are a kernel concept, so the bar that shows and switches
// them is the kernel's too: logo (About), project menu (open / recent / new window / close) and the
// window controls. Plugins only add to it: the "titlebar.center" slot (e.g. the palette's search box)
// and icon buttons via ctx.titlebar.addButton.

const SVG_NS = "http://www.w3.org/2000/svg";
// The few Lucide icons the bar needs, inlined: the kernel can't depend on the icons plugin (it may be off).
const ICONS = {
  "folder": [["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]],
  "folder-open": [["path", { d: "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" }]],
  "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]],
  "folder-plus": [["path", { d: "M12 10v6" }], ["path", { d: "M9 13h6" }], ["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]],
  "app-window": [["rect", { x: "2", y: "4", width: "20", height: "16", rx: "2" }], ["path", { d: "M10 4v4" }], ["path", { d: "M2 8h20" }], ["path", { d: "M6 4v4" }]],
  "folder-x": [["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }], ["path", { d: "m9.5 10.5 5 5" }], ["path", { d: "m14.5 10.5-5 5" }]],
  "rotate-ccw-clock": [["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }], ["path", { d: "M3 3v5h5" }], ["path", { d: "M12 7v5l4 2" }]],
  "minus": [["path", { d: "M5 12h14" }]],
  "square": [["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }]],
  "copy": [["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }], ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]],
  "x": [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
};

function icon(name, size = 16, className = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attrs = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.75,
    "stroke-linecap": "round", "stroke-linejoin": "round", class: `icon ${className}`.trim(), "aria-hidden": "true",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, props] of ICONS[name]) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

/**
 * opts: { t, workspace: { root, name }, recent(), logo(size), aboutTitle, keysFor(commandId),
 *         run(commandId), openPath(path), appWindow, controls: show window buttons }
 * Returns { center (element for the "titlebar.center" slot), addButton }.
 */
export function mountTitlebar(opts) {
  const { t, workspace: ws, appWindow } = opts;
  const bar = document.createElement("header");
  bar.id = "titlebar";
  bar.className = "tb";
  bar.innerHTML = `
    <div class="tb-side tb-left">
      <button class="tb-logo"></button>
      <button class="tb-project"><span class="tb-project-name"></span></button>
    </div>
    <div class="tb-center"></div>
    <div class="tb-side tb-right">
      <div class="tb-buttons"></div>
      <div class="tb-window"></div>
    </div>
    <div class="tb-menu" hidden></div>`;
  document.body.prepend(bar);

  const $ = (sel) => bar.querySelector(sel);
  const withKeys = (label, command) => {
    const keys = command ? opts.keysFor(command) : "";
    return keys ? `${label} (${keys})` : label;
  };
  /** Icon-only button; `command` (optional) adds its live shortcut to the tooltip (bindings can change). */
  function iconButton(iconEl, title, onclick, className, command = null) {
    const btn = document.createElement("button");
    btn.className = className;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    if (command) btn.addEventListener("mouseenter", () => (btn.title = withKeys(title, command)));
    btn.append(iconEl);
    btn.onclick = onclick;
    return btn;
  }

  const logoBtn = $(".tb-logo");
  logoBtn.title = opts.aboutTitle;
  logoBtn.setAttribute("aria-label", opts.aboutTitle);
  logoBtn.append(opts.logo(18));
  logoBtn.onclick = () => opts.run("app.about");

  const projectBtn = $(".tb-project");
  projectBtn.prepend(icon(ws.root ? "folder-open" : "folder"));
  projectBtn.append(icon("chevron-down", 14, "tb-caret"));
  $(".tb-project-name").textContent = ws.name ?? t("project.none");
  projectBtn.title = ws.root ?? t("project.tooltip");

  // Empty areas move the window; double-click maximizes.
  bar.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input, .tb-menu, .tb-center > *")) return;
    e.detail === 2 ? appWindow.toggleMaximize() : appWindow.startDragging();
  });

  // ----- window controls -----
  if (opts.controls) {
    const maxBtn = iconButton(icon("square", 13), t("window.maximize"), () => appWindow.toggleMaximize(), "tb-winbtn");
    $(".tb-window").append(
      iconButton(icon("minus"), t("window.minimize"), () => appWindow.minimize(), "tb-winbtn"),
      maxBtn,
      iconButton(icon("x"), t("window.close"), () => appWindow.close(), "tb-winbtn tb-close"),
    );
    const syncMaximized = async () => {
      const max = await appWindow.isMaximized();
      maxBtn.replaceChildren(max ? icon("copy", 14) : icon("square", 13));
      maxBtn.title = t(max ? "window.restore" : "window.maximize");
    };
    syncMaximized();
    appWindow.onResized(syncMaximized);
  }

  // ----- project menu -----
  const menu = $(".tb-menu");
  function item(iconName, label, run, hint = "") {
    const el = document.createElement("div");
    el.className = "tb-menu-item";
    el.innerHTML = `<span class="tb-menu-label"></span><small></small>`;
    el.prepend(icon(iconName, 15));
    el.querySelector(".tb-menu-label").textContent = label;
    el.querySelector("small").textContent = hint;
    el.onclick = () => { closeMenu(); run(); };
    menu.append(el);
  }
  const commandItem = (iconName, label, command) => item(iconName, label, () => opts.run(command), opts.keysFor(command));
  async function openMenu() {
    menu.replaceChildren();
    commandItem("folder-open", t("menu.openFolder"), "workspace.openFolder");
    commandItem("folder-plus", t("menu.openFolderNewWindow"), "workspace.openFolderNewWindow");
    commandItem("app-window", t("menu.newWindow"), "workspace.newWindow");
    if (ws.root) commandItem("folder-x", t("menu.closeFolder"), "workspace.close");
    const recent = (await opts.recent()).filter((p) => p.toLowerCase() !== ws.root?.toLowerCase());
    if (recent.length) {
      menu.append(Object.assign(document.createElement("div"), { className: "tb-menu-sep", textContent: t("menu.recent") }));
      for (const p of recent) item("rotate-ccw-clock", p.split(/[\\/]/).pop() || p, () => opts.openPath(p), p);
    }
    menu.hidden = false;
  }
  const closeMenu = () => (menu.hidden = true);
  projectBtn.onclick = () => (menu.hidden ? openMenu() : closeMenu());
  document.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !projectBtn.contains(e.target)) closeMenu();
  });
  window.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

  const buttons = $(".tb-buttons");
  return {
    center: $(".tb-center"),
    /** { id, icon: Element, title (localized, without keys), command, plugin } */
    addButton({ id, icon: iconEl, title, command, plugin }) {
      const btn = iconButton(iconEl, title, () => opts.run(command), "tb-button", command);
      btn.dataset.id = id;
      btn.dataset.plugin = plugin;
      buttons.append(btn);
    },
  };
}
