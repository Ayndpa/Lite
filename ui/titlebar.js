// Kernel-owned title bar. Projects (folders) are a kernel concept, so the bar that shows and switches
// them is the kernel's too: logo (About), the menu bar (File, Edit, …), project menu (open / recent /
// new window / close), the settings button and the window controls. Plugins only add to it: menu items via ctx.menubar.add,
// the "titlebar.center" slot (e.g. the palette's search box) and icon buttons via ctx.titlebar.addButton.

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
  "settings": [["path", { d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
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

/** Top-level menus, in order; one only shows once it has items. Titles: "menubar.<id>" in the kernel's locales. */
const MENUS = ["file", "edit", "view", "terminal", "help"];

/**
 * opts: { t, workspace: { root, name }, recent(), logo(size), aboutTitle, keysFor(commandId),
 *         run(commandId, ...args), commandTitle(commandId) -> title | null, openPath(path), appWindow,
 *         controls: show window buttons }
 * Returns { center (element for the "titlebar.center" slot), addButton, addMenuItems }.
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
      <div class="tb-menubar" role="menubar"></div>
    </div>
    <div class="tb-center"></div>
    <div class="tb-side tb-right">
      <div class="tb-buttons"></div>
      <div class="tb-kernel-buttons"></div>
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

  // Settings: always there, right of whatever buttons plugins add, next to the window controls.
  $(".tb-kernel-buttons").append(
    iconButton(icon("settings"), t("settings.title"), () => opts.run("app.settings"), "tb-button tb-settings", "app.settings"),
  );

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

  // ----- dropdown shared by the project menu and the menu bar (one open at a time) -----
  const menu = $(".tb-menu");
  let anchor = null; // the button whose menu is open
  function openAt(btn, compact) {
    anchor?.classList.remove("open");
    anchor = btn;
    btn.classList.add("open");
    menu.classList.toggle("tb-menu-compact", compact);
    menu.style.left = `${Math.max(4, btn.offsetLeft)}px`;
    menu.hidden = false;
  }
  const closeMenu = () => {
    menu.hidden = true;
    anchor?.classList.remove("open");
    anchor = null;
  };
  // Clicking in a menu must not take focus from the editor: Edit > Undo acts on what was focused.
  menu.addEventListener("mousedown", (e) => e.preventDefault());

  // ----- menu bar -----
  const menubar = $(".tb-menubar");
  const menuGroups = new Map(); // menu id -> [{ order, items }]
  /** "File: Save" -> "Save": inside a menu the category prefix is noise. */
  const menuLabel = (title) => title.replace(/^[^:：]+[:：]\s*/, "");
  function openBarMenu(id, btn) {
    menu.replaceChildren();
    // A line between groups; groups with the same order (from different plugins) run together.
    const groups = [...menuGroups.get(id)].sort((a, b) => a.order - b.order);
    const rows = groups.flatMap((g, i) => (i && g.order !== groups[i - 1].order ? ["-", ...g.items] : g.items));
    rows.forEach((it, i) => {
      if (it === "-") {
        // No doubled, leading or trailing separators.
        if (i && rows[i - 1] !== "-" && i < rows.length - 1) menu.append(Object.assign(document.createElement("div"), { className: "tb-menu-line" }));
        return;
      }
      const title = it.command ? opts.commandTitle(it.command) : null;
      const disabled = it.command ? title == null : !it.run;
      const el = document.createElement("div");
      el.className = `tb-menu-item${disabled ? " disabled" : ""}`;
      el.setAttribute("role", "menuitem");
      el.innerHTML = `<span class="tb-menu-label"></span><small></small>`;
      el.querySelector(".tb-menu-label").textContent = it.label ?? menuLabel(title ?? it.command);
      el.querySelector("small").textContent = it.keys ?? (it.command ? opts.keysFor(it.command) : "");
      if (!disabled) el.onclick = () => { closeMenu(); it.command ? opts.run(it.command, ...(it.args ?? [])) : it.run(); };
      menu.append(el);
    });
    openAt(btn, true);
  }
  function renderMenubar() {
    menubar.replaceChildren();
    for (const id of MENUS) {
      if (!menuGroups.get(id)?.length) continue;
      const btn = document.createElement("button");
      btn.className = "tb-menubar-item";
      btn.setAttribute("role", "menuitem");
      btn.textContent = t(`menubar.${id}`);
      btn.onmousedown = (e) => e.preventDefault(); // keep focus where it is
      btn.onclick = () => (anchor === btn ? closeMenu() : openBarMenu(id, btn));
      // Like every menu bar: once one menu is open, moving along the bar switches menus.
      btn.onmouseenter = () => anchor && anchor !== btn && menubar.contains(anchor) && openBarMenu(id, btn);
      menubar.append(btn);
    }
  }

  // ----- project menu -----
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
    openAt(projectBtn, false);
  }
  projectBtn.onclick = () => (anchor === projectBtn ? closeMenu() : openMenu());
  document.addEventListener("mousedown", (e) => {
    if (anchor && !menu.contains(e.target) && !anchor.contains(e.target) && !menubar.contains(e.target)) closeMenu();
  });
  window.addEventListener("blur", closeMenu);
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
    /**
     * Add one group of items to a top-level menu ("file" | "edit" | "view" | "terminal" | "help").
     * items: { command, args?, label?, keys? } (label defaults to the command's title without its
     * "Category: " prefix; greyed out while the command doesn't exist), { label, run } or "-".
     * Groups are sorted by order (default 100) and separated by lines; groups of equal order run together.
     */
    addMenuItems(id, items, { order = 100 } = {}) {
      if (!MENUS.includes(id)) throw new Error(`Unknown menu: ${id}`);
      if (!menuGroups.has(id)) menuGroups.set(id, []);
      menuGroups.get(id).push({ order, items });
      renderMenubar();
    },
  };
}
