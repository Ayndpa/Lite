// Built-in plugin manager. Part of the kernel, not a plugin: it is how the user recovers from any
// plugin state (including "everything off"), so it can never be disabled or fail to load.
//
// UI pieces:
//   - list (mountList): rows with avatar, name, version, description, status and a quick
//     enable/disable button; clicking a row opens the details page.
//   - details page (mountDetails): VS Code style — enable/disable, dependencies, permissions, contributions.
//   - standalone panel on document.body (list | details side by side) when no layout hosts them.
// A layout plugin can host the list (setHost) and the details page (setDetailsHost), e.g. as a sidebar
// view and an editor tab.

/** Transitive closure over an edge function. */
function closure(start, next) {
  const out = new Set();
  const stack = [...start];
  while (stack.length) {
    for (const n of next(stack.pop())) if (!out.has(n)) { out.add(n); stack.push(n); }
  }
  return out;
}

const PERMISSIONS = ["fs", "workspace", "window", "plugins", "keybindings", "terminal", "git", "theme"];
// Survives the window reload that enabling/disabling triggers, so the details page comes back.
const REOPEN_KEY = "lite.pluginManager.reopen";

/** Two-letter avatar with a stable colour per plugin. */
function avatar(p, size) {
  const el = document.createElement("div");
  el.className = "pm-avatar";
  const words = (p.nameEn ?? p.name ?? p.id).split(/[\s/_-]+/).filter((w) => /^[A-Za-z0-9]/.test(w));
  el.textContent = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? p.id).slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const c of p.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  el.style.setProperty("--pm-hue", String(hash % 360));
  el.style.setProperty("--pm-size", `${size}px`);
  return el;
}

const h = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text != null ? { textContent: text } : {});

/**
 * deps: {
 *   t, tEn,                     kernel translators (keys prefixed "pm.")
 *   list(),                     plugins: [{ id, name, nameEn, description, version, dependencies, permissions, dir, main, status, error }]
 *   setEnabled(ids, enabled),   persist
 *   reload(),
 *   shortcut(commandId),        current binding for display ("Ctrl+Shift+,") or ""
 *   contributions(id),          { commands: [{ id, title, keys }], services, slots, modules } of a running plugin
 * }
 */
export function createPluginManager({ t, tEn, list, setEnabled: persist, reload, shortcut, contributions }) {
  let host = null; // () => void — reveals the list inside a layout (e.g. a sidebar view)
  let detailsHost = null; // ({ id, title, render(el) }) => void — shows a details page (e.g. an editor tab)
  let selected = null; // plugin id highlighted in lists
  const lists = new Set(); // mounted list elements, re-rendered when the selection changes

  // ---------- dependency graph ----------

  const pluginMap = () => new Map(list().map((p) => [p.id, p]));
  const dependentsOf = (ids, plugins) =>
    closure(ids, (id) => [...plugins.values()].filter((p) => (p.dependencies ?? []).includes(id)).map((p) => p.id));
  const dependenciesOf = (ids, plugins) => closure(ids, (id) => (plugins.get(id)?.dependencies ?? []).filter((d) => plugins.has(d)));
  const names = (ids, plugins) => [...ids].map((id) => plugins.get(id)?.name ?? id);

  /**
   * Returns true if something changed (the window then reloads). from: "details" | "list" — where to
   * take the user back to after the reload.
   */
  async function setEnabled(id, enabled, from = "list") {
    const plugins = pluginMap();
    const target = plugins.get(id);

    if (!enabled) {
      // Everything that (transitively) needs this plugin goes down with it — say so first.
      const affected = [...dependentsOf([id], plugins)].filter((d) => plugins.get(d).status !== "disabled");
      if (affected.length) {
        const ok = await ask({
          title: t("pm.disable.title", { name: target.name }),
          body: t("pm.disable.body"),
          items: names(affected, plugins),
          buttons: [
            { label: t("pm.disable.confirm", { count: affected.length + 1 }), value: true, danger: true },
            { label: t("pm.cancel"), value: false },
          ],
        });
        if (!ok) return false;
      }
      await persist([id, ...affected], false);
    } else {
      // Offer to bring back plugins that were turned off with it.
      const dependents = [...dependentsOf([id], plugins)].filter((d) => plugins.get(d).status === "disabled");
      let ids = [id];
      if (dependents.length) {
        const choice = await ask({
          title: t("pm.enable.title", { name: target.name }),
          body: t("pm.enable.body"),
          items: names(dependents, plugins),
          buttons: [
            { label: t("pm.enable.all"), value: "all", primary: true },
            { label: t("pm.enable.only", { name: target.name }), value: "one" },
            { label: t("pm.cancel"), value: null },
          ],
        });
        if (!choice) return false;
        if (choice === "all") ids.push(...dependents);
      }
      // Required dependencies are not optional: enable them silently.
      ids = [...new Set([...ids, ...dependenciesOf(ids, plugins)])];
      await persist(ids, true);
    }
    sessionStorage.setItem(REOPEN_KEY, JSON.stringify(from === "details" ? { view: "details", id } : { view: "list" }));
    reload();
    return true;
  }

  // ---------- list ----------

  function renderList(el) {
    el.replaceChildren();
    el.classList.add("pm-list-view");
    for (const p of list()) {
      const enabled = p.status !== "disabled";
      const row = h("div", `pm-item pm-${p.status}${p.id === selected ? " selected" : ""}`);
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.title = p.name;

      const main = h("div", "pm-item-main");
      const line = h("div", "pm-item-line");
      line.append(h("span", "pm-item-name", p.name), h("span", "pm-item-version", p.version));
      const failed = p.status === "skipped" || p.status === "failed";
      main.append(line, h("div", "pm-item-desc", failed ? p.error : p.description ?? ""));

      const side = h("div", "pm-item-side");
      if (p.status !== "active") side.append(h("span", `pm-badge pm-badge-${p.status}`, t(`pm.status.${p.status}`)));
      // Quick toggle: always visible for disabled plugins, on hover/focus for enabled ones (VS Code style).
      const quick = h("button", `pm-quick${enabled ? "" : " always"}`, t(enabled ? "pm.menu.disable" : "pm.menu.enable"));
      quick.onclick = (e) => { e.stopPropagation(); setEnabled(p.id, !enabled); };
      side.append(quick);

      row.append(avatar(p, 36), main, side);
      row.onclick = () => openDetails(p.id);
      row.onkeydown = (e) => e.key === "Enter" && openDetails(p.id);
      el.appendChild(row);
    }
  }

  function mountList(el) {
    lists.add(el);
    renderList(el);
  }

  // ---------- details page ----------

  function section(title, body) {
    const s = h("section", "pm-section");
    s.append(h("h2", null, title), body);
    return s;
  }

  function pluginChips(ids, plugins) {
    if (!ids.length) return h("p", "pm-muted", t("pm.none"));
    const wrap = h("div", "pm-chips");
    for (const id of ids) {
      const p = plugins.get(id);
      const chip = h("button", `pm-chip pm-${p?.status ?? "missing"}`);
      chip.append(h("span", null, p?.name ?? id), h("small", null, p ? t(`pm.status.${p.status}`) : t("pm.status.missing")));
      if (p) chip.onclick = () => openDetails(id);
      else chip.disabled = true;
      wrap.append(chip);
    }
    return wrap;
  }

  function mountDetails(el, id) {
    const plugins = pluginMap();
    const p = plugins.get(id);
    el.replaceChildren();
    if (!p) return;
    const page = h("div", "pm-details");
    const enabled = p.status !== "disabled";

    // header
    const head = h("header", "pm-details-head");
    const info = h("div", "pm-details-info");
    const title = h("div", "pm-details-title");
    title.append(h("h1", null, p.name), h("span", "pm-item-version", `v${p.version}`));
    if (p.status !== "active") title.append(h("span", `pm-badge pm-badge-${p.status}`, t(`pm.status.${p.status}`)));
    const actions = h("div", "pm-details-actions");
    const toggle = h("button", `pm-btn ${enabled ? "pm-danger-outline" : "pm-primary"}`, t(enabled ? "pm.menu.disable" : "pm.menu.enable"));
    toggle.onclick = () => setEnabled(p.id, !enabled, "details");
    actions.append(toggle);
    info.append(title, h("div", "pm-details-id", p.id), h("p", "pm-details-desc", p.description ?? ""), actions);
    head.append(avatar(p, 72), info);
    page.append(head);

    if (p.status === "skipped" || p.status === "failed") {
      const box = h("div", "pm-error");
      box.append(h("b", null, t("pm.error.title")), h("span", null, p.error));
      page.append(box);
    }

    // dependencies, both ways
    page.append(section(t("pm.section.dependencies"), pluginChips(p.dependencies ?? [], plugins)));
    const dependents = [...plugins.values()].filter((q) => (q.dependencies ?? []).includes(p.id)).map((q) => q.id);
    page.append(section(t("pm.section.dependents"), pluginChips(dependents, plugins)));

    // permissions, in plain words
    const perms = p.permissions ?? [];
    const permList = h("ul", "pm-perms");
    for (const perm of perms) {
      const li = h("li");
      li.append(h("code", null, perm), h("span", null, PERMISSIONS.includes(perm) ? t(`pm.perm.${perm}`) : ""));
      permList.append(li);
    }
    page.append(section(t("pm.section.permissions"), perms.length ? permList : h("p", "pm-muted", t("pm.permissions.none"))));

    // what it adds to the app (only known while it runs)
    const contrib = h("div", "pm-contrib");
    if (p.status !== "active") {
      contrib.append(h("p", "pm-muted", t("pm.contrib.notRunning")));
    } else {
      const c = contributions(p.id);
      if (c.commands.length) {
        const table = h("table", "pm-commands");
        for (const cmd of c.commands) {
          const tr = h("tr");
          const keys = h("td", "pm-keys");
          for (const k of cmd.keys ? cmd.keys.split("+") : []) keys.append(h("kbd", null, k));
          tr.append(h("td", null, cmd.title), h("td", "pm-muted", cmd.id), keys);
          table.append(tr);
        }
        contrib.append(h("h3", null, t("pm.contrib.commands")), table);
      }
      for (const [key, items] of [["services", c.services], ["slots", c.slots], ["modules", c.modules]]) {
        if (!items.length) continue;
        const wrap = h("div", "pm-tags");
        for (const it of items) wrap.append(h("code", null, it));
        contrib.append(h("h3", null, t(`pm.contrib.${key}`)), wrap);
      }
      if (!contrib.childElementCount) contrib.append(h("p", "pm-muted", t("pm.none")));
    }
    page.append(section(t("pm.section.contributions"), contrib));

    // facts
    const dl = h("dl", "pm-facts");
    for (const [k, v] of [["id", p.id], ["version", p.version], ["folder", `plugins/${p.dir}`], ["entry", p.main ?? "main.js"]]) {
      dl.append(h("dt", null, t(`pm.details.${k}`)), h("dd", null, v));
    }
    page.append(section(t("pm.section.info"), dl));

    el.append(page);
  }

  function openDetails(id) {
    selected = id;
    for (const el of lists) if (el.isConnected) renderList(el); else lists.delete(el);
    const p = pluginMap().get(id);
    if (!p) return;
    if (detailsHost) return detailsHost({ id, title: p.name, render: (el) => mountDetails(el, id) });
    showPanel();
  }

  // ---------- body-level UI: standalone panel, dialog, toast ----------

  const ui = document.createElement("div");
  ui.innerHTML = `
    <div class="pm-overlay" hidden>
      <div class="pm-panel">
        <header><span class="pm-title"></span><button class="pm-btn pm-close"></button></header>
        <div class="pm-panel-body">
          <div class="pm-panel-list"></div>
          <div class="pm-panel-details"></div>
        </div>
        <footer></footer>
      </div>
    </div>
    <div class="pm-dialog-backdrop" hidden><div class="pm-dialog"></div></div>
    <div class="pm-toast" hidden></div>`;
  document.body.append(...ui.children);
  const overlay = document.querySelector(".pm-overlay");
  const panelList = overlay.querySelector(".pm-panel-list");
  const panelDetails = overlay.querySelector(".pm-panel-details");
  const dialog = document.querySelector(".pm-dialog-backdrop");
  const toast = document.querySelector(".pm-toast");
  overlay.querySelector(".pm-title").textContent = t("pm.panel.title");
  overlay.querySelector(".pm-close").textContent = t("pm.panel.close");
  overlay.querySelector(".pm-close").onclick = () => (overlay.hidden = true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dialog.hidden) overlay.hidden = true;
  });

  /** Standalone panel: list on the left, details of the selected plugin on the right. */
  function showPanel() {
    selected ??= list()[0]?.id ?? null;
    mountList(panelList);
    if (selected) mountDetails(panelDetails, selected);
    overlay.querySelector("footer").textContent = shortcut("plugins.manage");
    overlay.hidden = false;
  }

  /** Modal question; resolves with the clicked button's value (Escape = last button). */
  function ask({ title, body, items = [], buttons }) {
    return new Promise((resolve) => {
      const box = dialog.firstElementChild;
      box.innerHTML = `<h3></h3><p></p><ul></ul><div class="pm-actions"></div>`;
      box.querySelector("h3").textContent = title;
      box.querySelector("p").textContent = body;
      for (const it of items) box.querySelector("ul").appendChild(h("li", null, it));
      const done = (value) => {
        dialog.hidden = true;
        window.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        done(buttons.at(-1).value);
      };
      for (const b of buttons) {
        const btn = h("button", `pm-btn${b.danger ? " pm-danger" : ""}${b.primary ? " pm-primary" : ""}`, b.label);
        btn.onclick = () => done(b.value);
        box.querySelector(".pm-actions").appendChild(btn);
      }
      window.addEventListener("keydown", onKey, true);
      dialog.hidden = false;
      box.querySelector(".pm-danger, .pm-primary, .pm-btn")?.focus();
    });
  }

  function manage() {
    toast.hidden = true;
    if (host) return host();
    showPanel();
  }

  function showToast(text) {
    toast.innerHTML = `<span></span><button class="pm-btn pm-primary"></button><button class="pm-btn"></button>`;
    toast.firstChild.textContent = text;
    toast.children[1].textContent = t("pm.toast.manage");
    toast.children[2].textContent = t("pm.toast.dismiss");
    toast.children[1].onclick = manage;
    toast.children[2].onclick = () => (toast.hidden = true);
    toast.hidden = false;
  }

  return {
    manage,
    mountList,
    mountDetails,
    openDetails,
    /** A layout can show the list itself (e.g. as a sidebar view) instead of the standalone panel. */
    setHost: (show) => (host = show),
    /** …and the details page, e.g. as an editor tab: open({ id, title, render(el) }). */
    setDetailsHost: (open) => (detailsHost = open),
    /** After all plugins loaded: toggle commands and a recovery hint for plugins that could not load. */
    ready(registerCommand) {
      const plugins = list();
      for (const p of plugins) {
        const enabled = p.status !== "disabled";
        const key = enabled ? "pm.cmd.disable" : "pm.cmd.enable";
        // Both languages, so the palette finds it by either name.
        registerCommand(`plugins.toggle.${p.id}`, t(key, { name: p.name }), tEn(key, { name: p.nameEn }), () => setEnabled(p.id, !enabled));
      }
      // Turning everything off on purpose marks plugins "disabled", so a deliberately empty window stays quiet.
      const skipped = plugins.filter((p) => p.status === "skipped" || p.status === "failed");
      if (skipped.length) {
        const joined = skipped.map((p) => p.name).join(t("pm.list.separator"));
        showToast(t(skipped.length === 1 ? "pm.toast.one" : "pm.toast.other", { count: skipped.length, names: joined }));
      }
    },
    /**
     * Take the user back to where they toggled a plugin before the reload. Call after "kernel.ready",
     * once layouts have registered their hosts.
     */
    restore() {
      let reopen = null;
      try {
        reopen = JSON.parse(sessionStorage.getItem(REOPEN_KEY));
      } catch {}
      sessionStorage.removeItem(REOPEN_KEY);
      if (!reopen) return;
      if (reopen.view === "details" && list().some((p) => p.id === reopen.id)) {
        if (host) host();
        openDetails(reopen.id);
      } else {
        manage();
      }
    },
  };
}
