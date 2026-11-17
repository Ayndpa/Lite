// Integrated terminal, VS Code style: the user's default shell (the host picks it) in the workspace
// folder, in the workbench's bottom panel. xterm.js (term.js) is loaded on first use only.
import { showMenu } from "@lite/context-menu"; // bundled copy: this plugin owns its menus

// xterm draws on a canvas, so it needs real colors: the color theme's terminal.* tokens.
const XTERM_KEYS = [
  "background", "foreground", "cursor", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];
const xtermTheme = ({ colors }) => ({
  ...Object.fromEntries(XTERM_KEYS.map((k) => [k, colors[`terminal.${k}`]])),
  selectionBackground: colors["terminal.selection"],
});

export async function activate(ctx) {
  const wb = await ctx.services.get("workbench");
  const icons = await ctx.services.get("icons");
  const { t } = ctx;

  let xterm = null; // term.js module, loaded on first use
  const terms = []; // { id (pty), name, term, fit, el }
  let active = null;
  let tabsEl, bodyEl;
  ctx.theme.onChange((theme) => { for (const { term } of terms) term.options.theme = xtermTheme(theme); });

  // ---------- key routing (like VS Code: the shell gets Ctrl+letter, the app gets the rest it binds) ----------

  /** App shortcuts that still work inside the terminal: bound by the app AND not a plain Ctrl+letter. */
  function goesToApp(combo) {
    if (!combo || !ctx.keybindings.list().some((k) => k.keys.includes(combo))) return false;
    const parts = combo.split("+");
    const key = parts.at(-1);
    return parts.includes("shift") || parts.includes("alt") || !/^[a-z]$/.test(key);
  }

  const copySelection = (entry) => {
    navigator.clipboard.writeText(entry.term.getSelection()).catch(() => {});
    entry.term.clearSelection();
  };
  const paste = async (entry) => {
    const text = await navigator.clipboard.readText().catch(() => "");
    if (text) entry.term.paste(text);
    entry.term.focus();
  };

  // ---------- terminals ----------

  async function newTerminal() {
    wb.showPanel();
    xterm ??= await import(ctx.assets.url("term.js"));
    const el = Object.assign(document.createElement("div"), { className: "term-view" });
    bodyEl.append(el);
    const { term, fit } = xterm.createXterm({
      fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei UI", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 1000, // bounded memory per terminal
      theme: xtermTheme(ctx.theme.current()),
    });
    term.open(el);
    const entry = { id: null, name: "…", term, fit, el };
    terms.push(entry);
    setActive(entry);
    fit.fit();

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const combo = ctx.keybindings.fromEvent(e);
      if (combo === "ctrl+c" && term.hasSelection()) { copySelection(entry); e.preventDefault(); return false; }
      if (combo === "ctrl+v") return false; // let the browser's paste event reach xterm
      return !goesToApp(combo); // false: xterm ignores it and the app's shortcut runs
    });
    // Keys the shell consumed must not also trigger app commands (e.g. Ctrl+S, Ctrl+W).
    el.addEventListener("keydown", (e) => !goesToApp(ctx.keybindings.fromEvent(e)) && e.stopPropagation());
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); termMenu(e, entry); });

    try {
      const { id, shell } = await ctx.pty.spawn({
        cols: term.cols,
        rows: term.rows,
        onData: (bytes) => term.write(bytes),
        onExit: () => removeTerminal(entry),
      });
      entry.id = id;
      entry.name = shell.replace(/\.exe$/i, "");
    } catch (e) {
      term.write(`\x1b[31m${t("error.spawn", { error: e })}\x1b[0m\r\n`);
    }
    term.onData((data) => entry.id && ctx.pty.write(entry.id, data));
    term.onResize(({ cols, rows }) => entry.id && ctx.pty.resize(entry.id, cols, rows));
    renderTabs();
    term.focus();
    return entry;
  }

  function setActive(entry) {
    active = entry;
    for (const e of terms) e.el.hidden = e !== entry;
    renderTabs();
    if (entry) requestAnimationFrame(() => { entry.fit.fit(); entry.term.focus(); });
  }

  /** The shell exited (typed `exit`, or was killed): drop its tab; hide the panel after the last one. */
  function removeTerminal(entry) {
    const i = terms.indexOf(entry);
    if (i < 0) return;
    terms.splice(i, 1);
    entry.term.dispose();
    entry.el.remove();
    if (active === entry) setActive(terms[Math.min(i, terms.length - 1)] ?? null);
    if (!terms.length) wb.hidePanel();
    renderTabs();
  }

  function kill(entry) {
    if (!entry) return;
    if (entry.id) ctx.pty.kill(entry.id).catch(() => removeTerminal(entry)); // exit callback removes it
    else removeTerminal(entry);
  }

  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.replaceChildren();
    terms.forEach((entry, i) => {
      const tab = Object.assign(document.createElement("button"), { className: `term-tab${entry === active ? " active" : ""}` });
      tab.append(icons.create("terminal", { size: 14 }), Object.assign(document.createElement("span"), { textContent: terms.length > 1 ? `${i + 1}: ${entry.name}` : entry.name }));
      tab.onclick = () => setActive(entry);
      tab.onauxclick = (e) => e.button === 1 && kill(entry);
      tab.onmousedown = (e) => e.button === 1 && e.preventDefault();
      tab.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); tabMenu(e, entry); };
      tabsEl.append(tab);
    });
  }

  // ---------- context menus: the screen, a tab, the rest of the panel ----------

  /** The panel itself: the same actions as the header's buttons. */
  const panelItems = () => [
    { command: "terminal.toggleMaximize", label: t(wb.isPanelMaximized() ? "action.restore" : "action.maximize") },
    { label: t("action.hide"), keys: ctx.keysFor("terminal.toggle"), run: () => wb.hidePanel() },
  ];
  const newItem = () => ({ command: "terminal.new", label: t("action.new") });
  const clear = (entry) => { entry.term.clear(); entry.term.focus(); };

  function termMenu(e, entry) {
    showMenu(ctx, e, [
      { label: t("edit.copy"), keys: "Ctrl+C", disabled: !entry.term.hasSelection(), run: () => copySelection(entry) },
      { label: t("edit.paste"), keys: "Ctrl+V", run: () => paste(entry) },
      { label: t("edit.selectAll"), run: () => entry.term.selectAll() },
      "-",
      { label: t("action.clear"), run: () => clear(entry) },
      "-",
      newItem(),
      { label: t("action.kill"), danger: true, run: () => kill(entry) },
      "-",
      ...panelItems(),
    ]);
  }

  /** A tab: acts on that terminal, which need not be the one on screen. */
  function tabMenu(e, entry) {
    const others = terms.filter((other) => other !== entry);
    showMenu(ctx, e, [
      newItem(),
      "-",
      { label: t("action.clear"), run: () => clear(entry) },
      { label: t("action.kill"), danger: true, run: () => kill(entry) },
      { label: t("action.killOthers"), danger: true, disabled: !others.length, run: () => others.forEach(kill) },
      "-",
      ...panelItems(),
    ]);
  }

  /** The header and any other empty part of the panel. */
  function panelMenu(e) {
    showMenu(ctx, e, [
      newItem(),
      { label: t("action.clear"), disabled: !active, run: () => clear(active) },
      { label: t("action.kill"), danger: true, disabled: !active, run: () => kill(active) },
      "-",
      ...panelItems(),
    ]);
  }

  // ---------- panel UI ----------

  ctx.slots.contribute("workbench.panel", (host) => {
    host.innerHTML = `
      <div class="term-panel">
        <header class="term-header">
          <span class="term-title"></span>
          <div class="term-tabs lite-thin-scroll"></div>
          <div class="term-actions"></div>
        </header>
        <div class="term-body"></div>
      </div>`;
    host.querySelector(".term-title").textContent = t("panel.title");
    tabsEl = host.querySelector(".term-tabs");
    bodyEl = host.querySelector(".term-body");
    const actions = host.querySelector(".term-actions");
    const button = (icon, title, run) => {
      const b = Object.assign(document.createElement("button"), { className: "term-btn", title });
      b.setAttribute("aria-label", title);
      b.append(icons.create(icon, { size: 15 }));
      b.onclick = run;
      actions.append(b);
      return b;
    };
    button("plus", t("action.new"), () => newTerminal());
    button("trash", t("action.kill"), () => kill(active));
    // Maximize: the panel covers the editor area too (like VS Code's "Maximize Panel Size").
    const maxBtn = button("maximize-2", "", () => wb.togglePanelMaximized());
    const syncMax = () => {
      const max = wb.isPanelMaximized();
      maxBtn.replaceChildren(icons.create(max ? "minimize-2" : "maximize-2", { size: 15 }));
      maxBtn.title = t(max ? "action.restore" : "action.maximize");
      maxBtn.setAttribute("aria-label", maxBtn.title);
    };
    syncMax();
    ctx.events.on("workbench.panel", syncMax);
    button("x", t("action.hide"), () => wb.hidePanel());
    // Right-click anywhere else in the panel (terminals and tabs show their own menu and stop the event).
    host.querySelector(".term-panel").addEventListener("contextmenu", (e) => { e.preventDefault(); panelMenu(e); });
    // Keep the active terminal's grid matched to the panel size (drag handle, window resize).
    let pending = false;
    new ResizeObserver(() => {
      if (pending || !active) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; active?.fit.fit(); });
    }).observe(bodyEl);
  });

  // ---------- commands ----------

  /** Like VS Code's "Toggle Terminal": open (creating one if needed) and focus, or hide. */
  async function toggle() {
    if (wb.isPanelVisible() && terms.length) return wb.hidePanel();
    wb.showPanel();
    if (!terms.length) await newTerminal();
    else setActive(active ?? terms.at(-1));
  }

  ctx.commands.register("terminal.toggle", "%cmd.toggle%", toggle);
  ctx.commands.register("terminal.new", "%cmd.new%", () => newTerminal());
  ctx.commands.register("terminal.kill", "%cmd.kill%", () => kill(active));
  ctx.commands.register("terminal.clear", "%cmd.clear%", () => active?.term.clear());
  ctx.commands.register("terminal.toggleMaximize", "%cmd.toggleMaximize%", async () => {
    if (!terms.length) await newTerminal();
    wb.togglePanelMaximized();
    requestAnimationFrame(() => active?.term.focus());
  });
  ctx.keybindings.bind("ctrl+`", "terminal.toggle");
  ctx.keybindings.bind("ctrl+shift+`", "terminal.new");

  ctx.menubar.add("terminal", [{ command: "terminal.new" }, { command: "terminal.kill" }], { order: 100 });
  ctx.menubar.add("terminal", [{ command: "terminal.clear" }, { command: "terminal.toggleMaximize" }], { order: 200 });
  ctx.menubar.add("view", [{ command: "terminal.toggle" }], { order: 200 });
}
