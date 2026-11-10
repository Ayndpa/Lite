import { showMenu, showFieldMenu, isMenuElement } from "@lite/context-menu"; // bundled copy: this plugin owns its menus

export async function activate(ctx) {
  const wb = await ctx.services.get("workbench");
  const icons = await ctx.services.get("icons");

  const { t } = ctx;
  const editLabels = { cut: t("edit.cut"), copy: t("edit.copy"), paste: t("edit.paste"), selectAll: t("edit.selectAll") };
  const ws = ctx.workspace;
  let tree = null;
  let rootRendered = null; // Promise of the first level being on screen
  const sep = ws.root?.includes("\\") ? "\\" : "/";
  const expanded = new Set(); // folder paths kept open across refreshes
  let selectedPath = null;

  const parentOf = (path) => path.slice(0, path.lastIndexOf(sep));
  const baseName = (path) => path.slice(path.lastIndexOf(sep) + 1);
  const relative = (path) => (path.startsWith(ws.root) ? path.slice(ws.root.length + 1) : path);
  const copy = (text) => navigator.clipboard.writeText(text).catch((e) => console.error("[explorer] copy failed", e));

  function select(row) {
    tree.querySelector(".ex-row.selected")?.classList.remove("selected");
    row?.classList.add("selected");
    selectedPath = row?.title ?? null;
  }
  const findRow = (path) => [...tree.querySelectorAll(".ex-row")].find((r) => r.title === path);

  /** Expand the folders down to `path`, select it and scroll it into view. */
  async function reveal(path) {
    if (!ws.root || !path?.startsWith(ws.root)) return;
    wb.showView("explorer"); // mounts the view if it never was
    await rootRendered;
    const parts = path.slice(ws.root.length + 1).split(/[\\/]/);
    let dir = ws.root;
    for (const part of parts.slice(0, -1)) {
      dir += sep + part;
      const row = findRow(dir);
      if (!row) return;
      if (!expanded.has(dir)) await row.onclick();
    }
    const row = findRow(path);
    if (!row) return;
    select(row);
    row.scrollIntoView({ block: "nearest" });
  }

  // ---------- tree ----------

  /** Row content: [chevron | spacer] [folder/file icon] name */
  function setRow(row, entry, open) {
    const twisty = entry.is_dir
      ? icons.create(open ? "chevron-down" : "chevron-right", { size: 14, className: "ex-twisty" })
      : Object.assign(document.createElement("span"), { className: "ex-twisty" });
    const kind = entry.is_dir
      ? icons.folder(entry.name, { open, className: "ex-kind" })
      : icons.file(entry.name, { className: "ex-kind" });
    const name = Object.assign(document.createElement("span"), { className: "ex-name", textContent: entry.name });
    row.replaceChildren(twisty, kind, name);
  }

  /** Render a folder's entries; folders in `expanded` are opened (recursively) as well. */
  async function renderDir(path, container, depth) {
    let entries;
    try {
      entries = await ctx.fs.readDir(path);
    } catch (e) {
      container.innerHTML = `<div class="ex-error"></div>`;
      container.firstChild.textContent = String(e);
      return;
    }
    const frag = document.createDocumentFragment();
    const pending = [];
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "ex-row";
      row.style.paddingLeft = `${8 + depth * 12}px`;
      row.title = entry.path;
      row.dataset.dir = entry.is_dir ? "1" : "";
      row.dataset.depth = depth;
      if (entry.path === selectedPath) row.classList.add("selected");
      frag.appendChild(row);
      row.oncontextmenu = (e) => { e.preventDefault(); select(row); itemMenu(e, entry); };

      if (entry.is_dir) {
        const children = document.createElement("div");
        children.hidden = !expanded.has(entry.path);
        frag.appendChild(children);
        setRow(row, entry, !children.hidden);
        row.onclick = async () => {
          select(row);
          children.hidden = !children.hidden;
          children.hidden ? expanded.delete(entry.path) : expanded.add(entry.path);
          setRow(row, entry, !children.hidden);
          if (!children.hidden && !children.hasChildNodes()) await renderDir(entry.path, children, depth + 1);
        };
        if (!children.hidden) pending.push(renderDir(entry.path, children, depth + 1));
      } else {
        setRow(row, entry, false);
        // Single click previews and keeps focus here (so F2 / Delete keep working, like VS Code);
        // double-click or Enter moves focus into the editor.
        row.onclick = () => {
          select(row);
          ctx.events.emit("file.open", { path: entry.path, name: entry.name, preserveFocus: true });
        };
        row.ondblclick = () => ctx.events.emit("file.open", { path: entry.path, name: entry.name });
      }
    }
    container.replaceChildren(frag);
    await Promise.all(pending);
  }

  const refresh = () => (tree ? (rootRendered = renderDir(ws.root, tree, 0)) : Promise.resolve());

  /** The children container of a folder row (expanding it first), or the tree for the root. */
  async function childrenOf(dirPath) {
    if (dirPath === ws.root) return { container: tree, depth: 0 };
    const row = findRow(dirPath);
    if (!expanded.has(dirPath)) await row.onclick();
    return { container: row.nextElementSibling, depth: Number(row.dataset.depth) + 1 };
  }

  // ---------- inline name input (new file / folder, rename) ----------

  function validate(name, dir, original) {
    if (!name.trim()) return t("error.empty");
    if (/[\\/:*?"<>|]/.test(name) || name === "." || name === "..") return t("error.invalidName");
    const taken = [...tree.querySelectorAll(".ex-row")].some((r) => r.title === dir + sep + name && r.title !== original);
    return taken ? t("error.exists", { name }) : null;
  }

  /** Put an input in `row`; resolves with the confirmed name, or null if cancelled. */
  function nameInput(row, { value, dir, original, selectBase }) {
    return new Promise((resolve) => {
      const input = Object.assign(document.createElement("input"), { className: "ex-input", value, spellcheck: false });
      const msg = Object.assign(document.createElement("div"), { className: "ex-input-msg" });
      const nameSpan = row.querySelector(".ex-name");
      nameSpan ? nameSpan.replaceWith(input) : row.append(input);
      row.after(msg);
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        msg.remove();
        document.removeEventListener("mousedown", onOutside, true);
        resolve(result);
      };
      const commitOrCancel = () => finish(check() && input.value.trim() !== value ? input.value.trim() : null);
      // Clicking anywhere else ends the edit — also after the input's own right-click menu took focus
      // (the blur that menu causes is ignored below).
      const onOutside = (e) => e.target !== input && !isMenuElement(e.target) && commitOrCancel();
      document.addEventListener("mousedown", onOutside, true);
      const check = () => {
        const error = validate(input.value, dir, original);
        input.classList.toggle("invalid", !!error);
        msg.textContent = error ?? "";
        msg.hidden = !error;
        return !error;
      };
      input.oninput = check;
      input.onkeydown = (e) => {
        e.stopPropagation(); // keep F2 / Delete / Enter from reaching the tree
        if (e.key === "Escape") finish(null);
        else if (e.key === "Enter" && check()) finish(input.value.trim());
      };
      input.onblur = (e) => !isMenuElement(e.relatedTarget) && commitOrCancel();
      input.onclick = (e) => e.stopPropagation();
      input.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation(); // not the row's / tree's menu
        showFieldMenu(ctx, e, input, editLabels);
      };
      msg.hidden = true;
      input.focus();
      const dot = value.lastIndexOf(".");
      input.setSelectionRange(0, selectBase && dot > 0 ? dot : value.length);
    });
  }

  async function create(dirPath, isDir) {
    await rootRendered;
    const { container, depth } = await childrenOf(dirPath);
    const row = document.createElement("div");
    row.className = "ex-row ex-row-new";
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.append(
      Object.assign(document.createElement("span"), { className: "ex-twisty" }),
      isDir ? icons.folder("", { className: "ex-kind" }) : icons.file("", { className: "ex-kind" }),
    );
    container.prepend(row);
    const name = await nameInput(row, { value: "", dir: dirPath, original: null, selectBase: false });
    row.remove();
    if (!name) return;
    const path = dirPath + sep + name;
    try {
      await (isDir ? ctx.fs.createDir(path) : ctx.fs.createFile(path));
    } catch (e) {
      return notify(t("error.op", { error: e }));
    }
    if (isDir) expanded.add(path);
    selectedPath = path;
    await refresh();
    findRow(path)?.scrollIntoView({ block: "nearest" });
    if (!isDir) ctx.events.emit("file.open", { path, name });
  }

  async function rename(path) {
    const row = findRow(path);
    if (!row) return;
    const dir = parentOf(path);
    const name = await nameInput(row, { value: baseName(path), dir, original: path, selectBase: !row.dataset.dir });
    if (!name) return refresh(); // restore the label
    const to = dir + sep + name;
    try {
      await ctx.fs.rename(path, to);
    } catch (e) {
      await refresh();
      return notify(t("error.op", { error: e }));
    }
    // Keep expanded sub-folders open under their new path.
    for (const p of [...expanded]) {
      if (p === path || p.startsWith(path + sep)) { expanded.delete(p); expanded.add(to + p.slice(path.length)); }
    }
    selectedPath = to;
    ctx.events.emit("file.renamed", { from: path, to, name });
    await refresh();
  }

  async function remove(path) {
    const isDir = !!findRow(path)?.dataset.dir;
    const ok = await confirmDialog({
      title: t("delete.title", { name: baseName(path) }),
      body: t(isDir ? "delete.bodyFolder" : "delete.bodyFile"),
      confirm: t("delete.confirm"),
    });
    if (!ok) return;
    try {
      await ctx.fs.trash(path);
    } catch (e) {
      return notify(t("error.op", { error: e }));
    }
    for (const p of [...expanded]) if (p === path || p.startsWith(path + sep)) expanded.delete(p);
    if (selectedPath === path) selectedPath = null;
    ctx.events.emit("file.deleted", { path });
    await refresh();
  }

  // ---------- small modal (delete confirmation, errors) ----------

  function confirmDialog({ title, body, confirm, cancel = t("cancel") }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "ex-dialog-backdrop";
      backdrop.innerHTML = `<div class="ex-dialog"><h3></h3><p></p><div class="ex-dialog-actions"></div></div>`;
      backdrop.querySelector("h3").textContent = title;
      backdrop.querySelector("p").textContent = body ?? "";
      const actions = backdrop.querySelector(".ex-dialog-actions");
      const done = (value) => {
        backdrop.remove();
        window.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        done(false);
      };
      const ok = Object.assign(document.createElement("button"), { className: "ex-btn ex-btn-danger", textContent: confirm });
      ok.onclick = () => done(true);
      actions.append(ok);
      if (cancel) {
        const no = Object.assign(document.createElement("button"), { className: "ex-btn", textContent: cancel });
        no.onclick = () => done(false);
        actions.append(no);
      }
      window.addEventListener("keydown", onKey, true);
      document.body.appendChild(backdrop);
      ok.focus();
    });
  }
  const notify = (message) => confirmDialog({ title: message, confirm: t("ok"), cancel: null });

  // ---------- context menus ----------

  const revealLabel = t(`menu.revealInOS.${ctx.platform}`);

  function itemMenu(e, entry) {
    const dir = entry.is_dir ? entry.path : parentOf(entry.path);
    showMenu(ctx, e, [
      ...(entry.is_dir ? [] : [{ label: t("menu.open"), run: () => ctx.events.emit("file.open", { path: entry.path, name: entry.name }) }, "-"]),
      { label: t("menu.newFile"), run: () => create(dir, false) },
      { label: t("menu.newFolder"), run: () => create(dir, true) },
      "-",
      { label: t("menu.rename"), keys: "F2", run: () => rename(entry.path) },
      { label: t("menu.delete"), keys: "Delete", danger: true, run: () => remove(entry.path) },
      "-",
      { label: t("menu.copyPath"), run: () => copy(entry.path) },
      { label: t("menu.copyRelativePath"), run: () => copy(relative(entry.path)) },
      { label: revealLabel, run: () => ctx.fs.reveal(entry.path).catch((err) => notify(t("error.op", { error: err }))) },
    ]);
  }

  function blankMenu(e) {
    showMenu(ctx, e, [
      { label: t("menu.newFile"), run: () => create(ws.root, false) },
      { label: t("menu.newFolder"), run: () => create(ws.root, true) },
      "-",
      { label: revealLabel, run: () => ctx.fs.reveal(ws.root).catch((err) => notify(t("error.op", { error: err }))) },
      { label: t("menu.refresh"), run: refresh },
      { label: t("menu.collapseAll"), run: collapseAll },
    ]);
  }

  function collapseAll() {
    expanded.clear();
    return refresh();
  }

  // ---------- empty state (no folder) ----------

  async function mountEmpty(el) {
    el.innerHTML = `
      <div class="ex-empty">
        <p></p>
        <button class="ex-open"><span></span></button>
        <div class="ex-recent"></div>
      </div>`;
    el.querySelector(".ex-empty p").textContent = t("empty.text");
    el.querySelector(".ex-open span").textContent = t("empty.open");
    el.querySelector(".ex-open").prepend(icons.create("folder-open", { size: 15 }));
    el.querySelector(".ex-open").onclick = async () => {
      const path = await ws.pickFolder();
      if (path) ws.open(path);
    };
    const recent = await ws.recent();
    const list = el.querySelector(".ex-recent");
    for (const p of recent.slice(0, 5)) {
      const a = document.createElement("div");
      a.className = "ex-recent-item";
      a.append(icons.create("rotate-ccw-clock", { size: 14 }), p.split(/[\\/]/).pop() || p);
      a.title = p;
      a.onclick = () => ws.open(p);
      list.appendChild(a);
    }
  }

  wb.registerView({
    id: "explorer",
    title: t("view.title"),
    icon: "files",
    mount(el) {
      if (!ws.root) return mountEmpty(el);
      el.innerHTML = `<div class="ex-root"></div><div class="ex-tree" tabindex="0"></div>`;
      el.classList.add("ex-view"); // fills the sidebar; the tree stretches into the blank space below
      el.querySelector(".ex-root").textContent = ws.name;
      el.querySelector(".ex-root").title = ws.root;
      tree = el.querySelector(".ex-tree");
      // Right-click on empty space below the items: workspace-level actions.
      el.addEventListener("contextmenu", (e) => {
        if (e.defaultPrevented || e.target.closest(".ex-row, input")) return;
        e.preventDefault();
        select(null);
        blankMenu(e);
      });
      // Only while the tree has focus — a global Delete binding would fire inside text fields.
      tree.addEventListener("keydown", (e) => {
        if (!selectedPath || e.target !== tree) return;
        const row = findRow(selectedPath);
        if (e.key === "F2") rename(selectedPath);
        else if (e.key === "Delete") remove(selectedPath);
        else if (e.key === "Enter") row?.dataset.dir ? row.onclick() : row?.ondblclick();
        else return;
        e.preventDefault();
      });
      // Clicking a row focuses the tree (for F2/Delete) — but not when clicking into a name input.
      tree.addEventListener("mousedown", (e) => !e.target.closest("input") && tree.focus({ preventScroll: true }));
      rootRendered = renderDir(ws.root, tree, 0);
    },
  });

  ctx.commands.register("explorer.refresh", "%cmd.refresh%", refresh);
  ctx.commands.register("explorer.collapseAll", "%cmd.collapseAll%", collapseAll);
  ctx.commands.register("explorer.newFile", "%cmd.newFile%", () => ws.root && create(selectedDir(), false));
  ctx.commands.register("explorer.newFolder", "%cmd.newFolder%", () => ws.root && create(selectedDir(), true));
  ctx.commands.register("explorer.focus", "%cmd.focus%", () => wb.showView("explorer"));
  // Without an argument (e.g. from the command palette) reveal the editor's active file.
  let activeFile = null;
  ctx.events.on("editor.activeFile", ({ path }) => (activeFile = path));
  ctx.commands.register("explorer.reveal", "%cmd.reveal%", (path) => reveal(path ?? activeFile));
  ctx.keybindings.bind("ctrl+shift+e", "explorer.focus");
  ctx.menubar.add("file", [{ command: "explorer.newFile", label: t("menu.newFile") }, { command: "explorer.newFolder", label: t("menu.newFolder") }], { order: 0 });
  ctx.menubar.add("view", [{ command: "explorer.focus" }], { order: 100 });

  /** Folder for "new file" from the palette: the selected folder, the selected file's folder, or the root. */
  function selectedDir() {
    if (!selectedPath || !tree) return ws.root;
    return findRow(selectedPath)?.dataset.dir ? selectedPath : parentOf(selectedPath);
  }
}
