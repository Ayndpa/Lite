// Layout is just a plugin: it fills the kernel's "root" slot and defines new slots
// (workbench.main, workbench.panel, workbench.status.left/right) plus a `workbench`
// service for sidebar views and the bottom panel.

const PANEL_HEIGHT_KEY = "lite.workbench.panelHeight";
const PANEL_MIN = 80;

export async function activate(ctx) {
  const icons = await ctx.services.get("icons");

  ctx.slots.contribute("root", (host) => {
    host.innerHTML = `
      <div class="wb">
        <nav class="wb-activity"></nav>
        <aside class="wb-sidebar">
          <header class="wb-sidebar-title"></header>
          <div class="wb-sidebar-body"></div>
        </aside>
        <div class="wb-center">
          <main class="wb-main"></main>
          <div class="wb-sash" hidden></div>
          <section class="wb-panel" hidden></section>
        </div>
        <footer class="wb-status">
          <div class="wb-status-left"></div>
          <div class="wb-status-right"></div>
        </footer>
      </div>`;

    const wb = host.querySelector(".wb");
    const activity = host.querySelector(".wb-activity");
    const sidebarTitle = host.querySelector(".wb-sidebar-title");
    const sidebarBody = host.querySelector(".wb-sidebar-body");
    const views = new Map(); // id -> { view, button, panel, mounted }
    let active = null;

    // ----- bottom panel (terminal, output, …): hidden until a plugin shows it; height is draggable -----
    const center = host.querySelector(".wb-center");
    const panel = host.querySelector(".wb-panel");
    const sash = host.querySelector(".wb-sash");
    const storedHeight = (() => { try { return Number(localStorage.getItem(PANEL_HEIGHT_KEY)) || 0; } catch { return 0; } })();
    const setPanelHeight = (px) => {
      const max = Math.max(PANEL_MIN, center.clientHeight - 60);
      panel.style.height = `${Math.round(Math.min(max, Math.max(PANEL_MIN, px)))}px`;
    };
    setPanelHeight(storedHeight || 260);
    // Maximized (VS Code's "Maximize Panel Size"): the panel covers the whole editor area. The state
    // survives hiding the panel, so it comes back maximized.
    let panelMaximized = false;
    function setPanelVisible(visible) {
      if (panel.hidden === !visible) return;
      panel.hidden = !visible;
      sash.hidden = !visible || panelMaximized;
      center.classList.toggle("panel-max", visible && panelMaximized);
      ctx.events.emit("workbench.panel", { visible, maximized: panelMaximized });
    }
    function setPanelMaximized(max) {
      panelMaximized = max;
      if (max) panel.hidden = false;
      sash.hidden = panel.hidden || max;
      center.classList.toggle("panel-max", max);
      ctx.events.emit("workbench.panel", { visible: !panel.hidden, maximized: max });
    }
    sash.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      sash.setPointerCapture(e.pointerId);
      sash.classList.add("dragging");
      const move = (ev) => setPanelHeight(center.getBoundingClientRect().bottom - ev.clientY);
      const up = () => {
        sash.classList.remove("dragging");
        sash.removeEventListener("pointermove", move);
        try { localStorage.setItem(PANEL_HEIGHT_KEY, String(panel.offsetHeight)); } catch {}
      };
      sash.addEventListener("pointermove", move);
      sash.addEventListener("pointerup", up, { once: true });
    });

    /** toggle: clicking the active activity-bar item collapses the sidebar; programmatic calls always reveal. */
    function show(id, { toggle = false } = {}) {
      const entry = views.get(id);
      if (!entry) return;
      if (toggle && active === id && !wb.classList.contains("no-sidebar")) {
        wb.classList.add("no-sidebar");
        return;
      }
      wb.classList.remove("no-sidebar");
      for (const [vid, e] of views) {
        e.panel.hidden = vid !== id;
        e.button.classList.toggle("active", vid === id);
      }
      sidebarTitle.textContent = entry.view.title;
      if (!entry.mounted) {
        entry.view.mount(entry.panel);
        entry.mounted = true;
      }
      active = id;
    }

    const api = {
      /** view: { id, title, icon (icon name from the `icons` service), mount(el) } */
      registerView(view) {
        const button = document.createElement("button");
        button.className = "wb-activity-item";
        button.title = view.title;
        button.setAttribute("aria-label", view.title);
        button.appendChild(icons.create(view.icon ?? "layout-grid", { size: 22, strokeWidth: 1.5 }));
        button.onclick = () => show(view.id, { toggle: true });
        activity.appendChild(button);

        const panel = document.createElement("div");
        panel.className = "wb-view";
        panel.hidden = true;
        sidebarBody.appendChild(panel);

        views.set(view.id, { view, button, panel, mounted: false });
        if (!active) show(view.id);
      },
      showView: (id) => show(id),
      /** Small count on a view's activity-bar icon (e.g. number of changes); 0 / "" hides it. */
      setBadge(id, value) {
        const entry = views.get(id);
        if (!entry) return;
        let badge = entry.button.querySelector(".wb-badge");
        if (!value) return badge?.remove();
        badge ??= entry.button.appendChild(Object.assign(document.createElement("span"), { className: "wb-badge" }));
        badge.textContent = typeof value === "number" && value > 999 ? "999+" : String(value);
      },
      /** Bottom panel. Plugins put content into the "workbench.panel" slot; "workbench.panel" events report visibility. */
      showPanel: () => setPanelVisible(true),
      hidePanel: () => setPanelVisible(false),
      togglePanel: () => setPanelVisible(panel.hidden),
      isPanelVisible: () => !panel.hidden,
      /** Panel over the whole editor area (shows the panel if hidden); "workbench.panel" reports it as `maximized`. */
      setPanelMaximized,
      togglePanelMaximized: () => setPanelMaximized(!panelMaximized),
      isPanelMaximized: () => panelMaximized,
    };
    ctx.services.provide("workbench", api);

    // Host the kernel's built-in plugin manager as the last activity-bar entry (after plugin views),
    // and make "Manage Plugins" reveal it here instead of the kernel's standalone panel.
    ctx.events.on("kernel.ready", () => {
      // Last of the title bar's buttons (other plugins add theirs while activating).
      ctx.titlebar.addButton({ id: "sidebar", icon: icons.create("panel-left"), title: ctx.t("button.sidebar"), command: "workbench.toggleSidebar" });
      api.registerView({ id: "plugins", title: ctx.t("view.plugins"), icon: "puzzle", mount: (el) => ctx.pluginManager.mountList(el) });
      ctx.pluginManager.setHost(() => show("plugins"));
      // Details open as a tab when the editor is there; otherwise the kernel's own panel is used.
      ctx.services.get("editor").then((editor) =>
        ctx.pluginManager.setDetailsHost(({ id, title, render }) => editor.openPage({ id: `plugin:${id}`, title, icon: "puzzle", render })),
      );
    });

    ctx.commands.register("workbench.toggleSidebar", "%cmd.toggleSidebar%", () => wb.classList.toggle("no-sidebar"));
    ctx.keybindings.bind("ctrl+b", "workbench.toggleSidebar");

    ctx.slots.define("workbench.main", host.querySelector(".wb-main"));
    ctx.slots.define("workbench.panel", panel);
    ctx.slots.define("workbench.status.left", host.querySelector(".wb-status-left"));
    ctx.slots.define("workbench.status.right", host.querySelector(".wb-status-right"));

    // The status bar only shows while something in it has content (text or an icon), whichever plugin
    // put it there — an empty bar is just a blue stripe. Its grid row collapses when hidden.
    const status = host.querySelector(".wb-status");
    const syncStatus = () => {
      const empty = !status.textContent.trim() && !status.querySelector("svg, img, canvas");
      if (status.hidden !== empty) status.hidden = empty;
    };
    new MutationObserver(syncStatus).observe(status, { childList: true, subtree: true, characterData: true });
    syncStatus();
  });
}
