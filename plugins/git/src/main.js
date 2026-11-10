// Git: source control (VS Code's SCM view — stage, commit, diff, branches, sync) plus git-insight's
// repository overview, in one plugin. Everything runs the user's `git` through ctx.git.run; the diff
// view (CodeMirror merge) is loaded on first use.
import { showMenu, attachFieldMenu } from "@lite/context-menu"; // bundled copy: this plugin owns its menus
import { createGit, gitAvailable, repoRoot, status as readStatus, branches as readBranches, GitError } from "./lib/git.js";
import { mountOverview } from "./lib/insights.js";
import { readLog, layout, rowSvg, passSvg, commitFiles } from "./lib/graph.js";
import { confirm, prompt, pick, h } from "./lib/ui.js";

const POLL_MS = 5000;
const STATUS_COLORS = { M: "#e2c08d", A: "#73c991", U: "#73c991", D: "#c74e39", R: "#73c991", C: "#73c991", T: "#e2c08d", "!": "#e4676b" };

export async function activate(ctx) {
  const wb = await ctx.services.get("workbench");
  const icons = await ctx.services.get("icons");
  const editor = await ctx.services.get("editor");
  const { t } = ctx;
  const editLabels = { cut: t("edit.cut"), copy: t("edit.copy"), paste: t("edit.paste"), selectAll: t("edit.selectAll") };

  const git = createGit(ctx);
  const sep = ctx.workspace.root?.includes("\\") ? "\\" : "/";
  let root = null; // repository top level (native separators)
  let available = null; // git on PATH?
  let st = null; // last status
  let busy = 0; // running operations (progress bar)
  let diffModule = null;
  const collapsed = new Set();
  let viewEl = null;

  const abs = (p) => root + sep + p.replace(/\//g, sep);
  const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
  const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const toRepoPath = (path) => (root && path?.startsWith(root + sep) ? path.slice(root.length + 1).replace(/\\/g, "/") : null);
  const changeCount = () => (st ? st.staged.length + st.unstaged.length + st.conflicts.length : 0);

  // ---------- running git ----------

  /**
   * Run an operation with the progress bar on; errors become a dialog. Refreshes afterwards.
   * files: the operation may rewrite working-tree files (discard, checkout, pull) — open editors reload.
   */
  async function op(fn, { files = false } = {}) {
    busy++;
    render();
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof GitError)) console.error("[git]", e);
      await confirm({ title: t("error.title"), body: String(e.message ?? e), buttons: [{ label: t("ok"), value: true, primary: true }] });
      return undefined;
    } finally {
      busy--;
      graph.dirty = true; // refs may have moved (fetch, new branch, tags) even when HEAD didn't
      if (files && root) ctx.events.emit("file.changed", { path: root });
      await refresh();
    }
  }

  let refreshing = null;
  let again = false;
  /** Re-read status; overlapping calls collapse into one follow-up run. */
  async function refresh() {
    if (refreshing) { again = true; return refreshing; }
    refreshing = (async () => {
      do {
        again = false;
        if (available === null) available = await gitAvailable(git);
        if (available && ctx.workspace.root && !root) {
          git.setRoot(null);
          root = await repoRoot(git, sep);
          git.setRoot(root);
        }
        st = root ? await readStatus(git).catch((e) => (console.error("[git] status", e), null)) : null;
      } while (again);
      refreshing = null;
      render();
      loadGraph().catch((e) => console.error("[git] log", e));
      renderStatusBar();
      wb.setBadge("scm", changeCount());
    })();
    return refreshing;
  }

  // ---------- actions ----------

  // A staged rename also needs its old path, or unstaging would leave the deletion staged.
  const pathspec = (entries) => ["--", ...entries.flatMap((e) => (e.orig ? [e.path, e.orig] : [e.path]))];

  const stage = (entries) => op(() => git.ok(["add", "-A", ...pathspec(entries)]));
  const unstage = (entries) =>
    op(() => (st?.oid ? git.ok(["restore", "--staged", ...pathspec(entries)]) : git.ok(["rm", "--cached", "-r", "-q", ...pathspec(entries)])));

  async function discard(entries) {
    if (!entries.length) return;
    const untracked = entries.filter((e) => e.untracked);
    const tracked = entries.filter((e) => !e.untracked);
    const body = entries.length === 1
      ? t(untracked.length ? "discard.confirmUntracked" : "discard.confirmOne", { name: baseName(entries[0].path) })
      : t("discard.confirmMany", { n: entries.length });
    const ok = await confirm({ title: t("discard.title"), body, buttons: [{ label: t("discard.action"), value: true, danger: true }, { label: t("cancel"), value: false }] });
    if (!ok) return;
    await op(async () => {
      // Added in the index then changed: restoring from the index keeps the add; the file stays.
      if (tracked.length) await git.ok(["restore", ...pathspec(tracked)]);
      for (const e of untracked) {
        await ctx.fs.trash(abs(e.path));
        ctx.events.emit("file.deleted", { path: abs(e.path) });
      }
    }, { files: true });
  }

  async function commit() {
    if (!st) return;
    const box = viewEl?.querySelector(".git-message");
    const message = box?.value.trim();
    if (!message) {
      wb.showView("scm");
      viewEl?.querySelector(".git-message")?.focus();
      return;
    }
    let all = false;
    if (!st.staged.length) {
      if (!st.unstaged.length) return;
      const choice = await confirm({
        title: t("commit.noStagedTitle"), body: t("commit.noStaged"),
        buttons: [{ label: t("commit.stageAll"), value: true, primary: true }, { label: t("cancel"), value: false }],
      });
      if (!choice) return;
      all = true;
    }
    const done = await op(async () => {
      if (all) await git.ok(["add", "-A"]);
      await git.ok(["commit", "-F", "-"], { stdin: message + "\n" });
      return true;
    });
    if (done && box) {
      box.value = "";
      box.dispatchEvent(new Event("input")); // shrink back to one line
    }
  }

  async function push() {
    if (!st) return;
    if (st.upstream) return op(() => git.ok(["push"]));
    const remotes = ((await git.maybe(["remote"])) ?? "").split("\n").map((r) => r.trim()).filter(Boolean);
    if (!remotes.length) {
      return confirm({ title: t("push.noRemoteTitle"), body: t("push.noRemote"), buttons: [{ label: t("ok"), value: true, primary: true }] });
    }
    const remote = remotes.length === 1 ? remotes[0] : await pick({ placeholder: t("push.pickRemote"), items: remotes.map((r) => ({ label: r, value: r })) });
    if (remote) return op(() => git.ok(["push", "-u", remote, "HEAD"]));
  }
  const pull = () => op(() => git.ok(["pull"]), { files: true });
  const fetch = () => op(() => git.ok(["fetch", "--all", "--prune"]));
  async function sync() {
    if (!st?.upstream) return push();
    await op(async () => {
      await git.ok(["pull"]);
      await git.ok(["push"]);
    }, { files: true });
  }

  const validBranch = (name) => (/^-|[\s~^:?*[\\]|\.\.|@\{|\.lock$|\/$|\.$/.test(name) ? t("branch.invalid") : null);

  async function createBranch() {
    const name = await prompt({ title: t("branch.newTitle"), placeholder: t("branch.newPlaceholder"), okLabel: t("branch.create"), validate: validBranch });
    if (name) await op(() => git.ok(["switch", "-c", name]));
  }

  async function checkout() {
    if (!root) return;
    const list = await readBranches(git);
    const NEW = Symbol("new");
    const value = await pick({
      placeholder: t("branch.pick"),
      items: [
        { label: `+ ${t("branch.newItem")}`, value: NEW },
        ...list.map((b) => ({ label: b.name, detail: b.current ? t("branch.current") : b.remote ? t("branch.remote") : "", value: b })),
      ],
    });
    if (!value) return;
    if (value === NEW) return createBranch();
    if (value.current) return;
    await op(() => git.ok(value.remote ? ["switch", "--track", value.name] : ["switch", value.name]), { files: true });
  }

  async function init() {
    if (!ctx.workspace.root) return;
    await op(async () => {
      git.setRoot(null);
      await git.ok(["init"]);
      root = null; // refresh() finds it
    });
  }

  // ---------- diff / overview tabs ----------

  async function openFile(path) {
    ctx.events.emit("file.open", { path: abs(path), name: baseName(path) });
  }

  /** Text of a git object, or "" when it doesn't exist (added / deleted file). */
  async function show(spec) {
    const r = await git.run(["show", spec]);
    return r.code === 0 ? r.stdout : "";
  }

  async function openDiff(entry, staged) {
    if (entry.conflict) return openFile(entry.path);
    const name = baseName(entry.path);
    let left, right;
    if (staged) {
      left = { label: `${name} (HEAD)`, text: st?.oid && entry.status !== "A" ? await show(`HEAD:${entry.orig ?? entry.path}`) : "" };
      right = { label: `${name} (${t("diff.index")})`, text: await show(`:${entry.path}`) };
    } else {
      left = { label: `${name} (${t("diff.index")})`, text: entry.untracked ? "" : await show(`:${entry.path}`) };
      const working = entry.status === "D" ? "" : await ctx.fs.readText(abs(entry.path)).catch(() => "");
      right = { label: `${name} (${t("diff.workingTree")})`, text: working };
    }
    await diffPage(`git-diff:${staged ? "index" : "work"}:${entry.path}`, `${name} (${staged ? t("diff.index") : t("diff.workingTree")})`, name, left, right);
  }

  /** A file as changed by a commit (against its first parent), from the graph. */
  async function openCommitDiff(commit, file) {
    const name = baseName(file.path);
    const short = commit.hash.slice(0, 7);
    const parent = commit.parents[0];
    const left = { label: `${name} (${parent ? parent.slice(0, 7) : "∅"})`, text: parent && file.status !== "A" ? await show(`${parent}:${file.orig ?? file.path}`) : "" };
    const right = { label: `${name} (${short})`, text: file.status === "D" ? "" : await show(`${commit.hash}:${file.path}`) };
    await diffPage(`git-diff:${commit.hash}:${file.path}`, `${name} (${short})`, name, left, right);
  }

  async function diffPage(id, title, name, left, right) {
    left.binary = left.text.includes("\0");
    right.binary = right.text.includes("\0");
    diffModule ??= await import(ctx.assets.url("diff.js"));
    const extensions = [...editor.viewerExtensions(), await editor.languageFor(name)];
    let dispose = () => {};
    editor.openPage({
      id, title, icon: { file: name }, reload: true,
      render: (el) => (dispose = diffModule.mountDiff(el, { left, right, extensions, binaryLabel: t("diff.binary") })),
      dispose: () => dispose(),
    });
  }

  let overviewHandle = null;
  function openOverview() {
    if (!root) return;
    editor.openPage({
      id: "git-overview",
      title: t("overview.tab"),
      icon: "chart-area",
      reload: !!overviewHandle,
      render: (el) => (overviewHandle = mountOverview(el, { ctx, git, icons, openFile })),
      dispose: () => { overviewHandle?.dispose(); overviewHandle = null; },
    });
  }

  // ---------- source control view ----------

  const iconBtn = (icon, title, onclick, cls = "git-icon-btn") => {
    const b = h("button", cls);
    b.title = title;
    b.setAttribute("aria-label", title);
    b.append(icons.create(icon, { size: 16 }));
    b.onclick = (e) => { e.stopPropagation(); onclick(e); };
    return b;
  };

  function moreMenu(e) {
    showMenu(ctx, e, [
      { command: "git.pull" }, { command: "git.push" }, { command: "git.fetch" }, { command: "git.sync" },
      "-",
      { command: "git.checkout" }, { command: "git.createBranch" },
      "-",
      { command: "git.stageAll" }, { command: "git.unstageAll" }, { command: "git.discardAll" },
      "-",
      { command: "git.overview" },
    ]);
  }

  function rowMenu(e, entry, group) {
    const staged = group === "staged";
    showMenu(ctx, e, [
      { label: t("action.openChanges"), run: () => openDiff(entry, staged), disabled: !!entry.conflict },
      { label: t("action.openFile"), run: () => openFile(entry.path), disabled: entry.status === "D" && !staged },
      "-",
      staged
        ? { label: t("action.unstage"), run: () => unstage([entry]) }
        : { label: t("action.stage"), run: () => stage([entry]) },
      ...(group === "unstaged" ? [{ label: t("action.discard"), danger: true, run: () => discard([entry]) }] : []),
      "-",
      { command: "explorer.reveal", args: [abs(entry.path)], label: t("action.reveal") },
      { label: t("action.copyPath"), run: () => navigator.clipboard.writeText(abs(entry.path)) },
      { label: t("action.copyRelativePath"), run: () => navigator.clipboard.writeText(entry.path) },
    ]);
  }

  function row(entry, group) {
    const r = h("div", "git-row");
    r.tabIndex = 0;
    r.title = `${entry.path}${entry.orig ? ` ← ${entry.orig}` : ""}`;
    const letter = entry.conflict ? "!" : entry.status;
    const name = h("span", `git-row-name${entry.status === "D" ? " deleted" : ""}`, baseName(entry.path));
    name.style.color = STATUS_COLORS[letter] ?? "";
    const actions = h("span", "git-row-actions");
    if (group === "staged") actions.append(iconBtn("minus", t("action.unstage"), () => unstage([entry])));
    else {
      if (entry.status !== "D") actions.append(iconBtn("file-text", t("action.openFile"), () => openFile(entry.path)));
      if (group === "unstaged") actions.append(iconBtn("undo-2", t("action.discard"), () => discard([entry])));
      actions.append(iconBtn("plus", t("action.stage"), () => stage([entry])));
    }
    const badge = h("span", "git-row-status", letter);
    badge.style.color = STATUS_COLORS[letter] ?? "";
    badge.title = t(`status.${entry.conflict ? "conflict" : entry.untracked ? "untracked" : entry.status}`);
    r.append(icons.file(entry.path, { className: "git-file-icon" }), name, h("span", "git-row-dir", dirName(entry.path)), actions, badge);
    const open = () => openDiff(entry, group === "staged");
    r.onclick = open;
    r.onkeydown = (e) => e.key === "Enter" && open();
    r.oncontextmenu = (e) => { e.preventDefault(); rowMenu(e, entry, group); };
    return r;
  }

  function group(id, title, entries, actions) {
    if (!entries.length) return null;
    const g = h("div", "git-group");
    const head = h("div", "git-group-head");
    const chevron = icons.create(collapsed.has(id) ? "chevron-right" : "chevron-down", { size: 16 });
    const acts = h("span", "git-row-actions");
    for (const [icon, label, run] of actions) acts.append(iconBtn(icon, label, run));
    head.append(chevron, h("span", "git-group-title", title), acts, h("span", "git-count", String(entries.length)));
    head.onclick = () => { collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); render(); };
    g.append(head);
    if (!collapsed.has(id)) for (const e of entries) g.append(row(e, id));
    return g;
  }

  // The repository UI is built once and updated in place, so a refresh never disturbs typing (focus,
  // IME composition) in the commit message box.
  let ui = null;
  function buildRepoUi() {
    const progress = h("div", "git-progress");
    const toolbar = h("div", "git-toolbar");
    const branch = h("button", "git-branch");
    branch.title = t("branch.pick");
    branch.onclick = checkout;
    toolbar.append(
      branch,
      h("span", "git-flex"),
      iconBtn("check", t("cmd.commit"), commit),
      iconBtn("refresh-cw", t("action.refresh"), () => refresh()),
      iconBtn("chart-area", t("cmd.overview"), openOverview),
      iconBtn("ellipsis", t("action.more"), moreMenu),
    );
    const box = h("textarea", "git-message lite-thin-scroll");
    box.rows = 1;
    box.spellcheck = false;
    const fit = () => { box.style.height = "auto"; box.style.height = `${Math.min(box.scrollHeight + 2, 160)}px`; };
    box.oninput = fit;
    box.onkeydown = (e) => {
      if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); commit(); }
    };
    attachFieldMenu(ctx, box, editLabels);
    const commitBtn = h("button", "git-btn primary git-commit-btn");
    commitBtn.append(icons.create("check", { size: 14 }), h("span", null, t("commit.button")));
    commitBtn.onclick = commit;
    const syncHost = h("div", "git-sync-host");
    const list = h("div", "git-list lite-thin-scroll");
    const changes = h("div");
    const graphHost = h("div");
    list.append(changes, graphHost);
    const el = h("div", "git-repo");
    el.append(progress, toolbar, box, commitBtn, syncHost, list);
    requestAnimationFrame(fit);
    return { el, progress, branch, box, commitBtn, syncHost, list, changes, graphHost };
  }

  // ---------- commit graph (VS Code's "Source Control Graph") ----------

  const GRAPH_PAGE = 100;
  const graph = { commits: [], key: null, limit: GRAPH_PAGE, more: false, expanded: new Set(), files: new Map(), dirty: true };

  /** Re-read the log when HEAD, its upstream or the page size changed (or after an operation). */
  async function loadGraph() {
    if (!st?.oid) {
      graph.commits = [];
      graph.key = null;
      return renderGraph();
    }
    const key = `${st.oid}|${st.upstream}|${st.ahead}|${st.behind}|${graph.limit}`;
    if (key === graph.key && !graph.dirty) return;
    graph.key = key;
    graph.dirty = false;
    const commits = layout(await readLog(git, { upstream: st.upstream ? "@{upstream}" : null, limit: graph.limit + 1 }));
    graph.more = commits.length > graph.limit;
    graph.commits = commits.slice(0, graph.limit);
    renderGraph();
  }

  /** ref: { kind: "branch" | "remote" | "tag", name } */
  function refBadge({ kind, name }) {
    const current = kind === "branch" && name === st?.branch && !st?.detached;
    const b = h("span", `git-ref ${kind}${current ? " current" : ""}`);
    b.title = name;
    b.append(icons.create({ tag: "tag", remote: "cloud", branch: "git-branch" }[kind], { size: 11 }), h("span", null, name));
    return b;
  }

  function commitMenu(e, c) {
    showMenu(ctx, e, [
      { label: t("graph.copyHash"), run: () => navigator.clipboard.writeText(c.hash) },
      { label: t("graph.copyMessage"), run: () => navigator.clipboard.writeText(c.subject) },
      "-",
      { label: t("graph.branchHere"), run: async () => {
        const name = await prompt({ title: t("branch.newTitle"), placeholder: t("branch.newPlaceholder"), okLabel: t("branch.create"), validate: validBranch });
        if (name) await op(() => git.ok(["switch", "-c", name, c.hash]), { files: true });
      } },
    ]);
  }

  async function toggleCommit(c) {
    if (graph.expanded.has(c.hash)) graph.expanded.delete(c.hash);
    else {
      graph.expanded.add(c.hash);
      if (!graph.files.has(c.hash)) graph.files.set(c.hash, await commitFiles(git, c));
    }
    renderGraph();
  }

  function renderGraph() {
    if (!ui) return;
    const scroll = ui.list.scrollTop;
    const g = h("div", "git-group git-graph");
    const head = h("div", "git-group-head");
    const acts = h("span", "git-row-actions");
    acts.append(iconBtn("refresh-cw", t("action.refresh"), () => { graph.dirty = true; loadGraph(); }));
    head.append(icons.create(collapsed.has("graph") ? "chevron-right" : "chevron-down", { size: 16 }), h("span", "git-group-title", t("group.graph")), acts);
    head.onclick = () => { collapsed.has("graph") ? collapsed.delete("graph") : collapsed.add("graph"); renderGraph(); };
    g.append(head);
    if (!collapsed.has("graph")) {
      if (!graph.commits.length) g.append(h("div", "git-empty git-dim", t("graph.empty")));
      const width = Math.max(1, ...graph.commits.map((c) => Math.max(c.before.length, c.after.length, c.lane + 1)));
      const fmtDate = (ms) => new Date(ms).toLocaleString(ctx.locale, { dateStyle: "medium", timeStyle: "short" });
      for (const c of graph.commits) {
        const r = h("div", `git-commit${graph.expanded.has(c.hash) ? " expanded" : ""}`);
        r.tabIndex = 0;
        r.title = `${c.hash.slice(0, 10)} · ${c.author} · ${fmtDate(c.time)}\n\n${c.subject}`;
        const text = h("span", "git-commit-text");
        text.append(h("span", "git-commit-subject", c.subject));
        for (const ref of c.refs) text.append(refBadge(ref));
        r.append(rowSvg(c, width, c.hash === st?.oid), text, h("span", "git-commit-author", c.author));
        r.onclick = () => toggleCommit(c);
        r.onkeydown = (e) => e.key === "Enter" && toggleCommit(c);
        r.oncontextmenu = (e) => { e.preventDefault(); commitMenu(e, c); };
        g.append(r);
        if (!graph.expanded.has(c.hash)) continue;
        for (const f of graph.files.get(c.hash) ?? []) {
          const fr = h("div", "git-commit-file");
          fr.title = `${f.path}${f.orig ? ` ← ${f.orig}` : ""}`;
          const name = h("span", `git-row-name${f.status === "D" ? " deleted" : ""}`, baseName(f.path));
          name.style.color = STATUS_COLORS[f.status] ?? "";
          const badge = h("span", "git-row-status", f.status);
          badge.style.color = STATUS_COLORS[f.status] ?? "";
          fr.append(passSvg(c.after, width), icons.file(f.path, { className: "git-file-icon" }), name, h("span", "git-row-dir", dirName(f.path)), badge);
          fr.onclick = () => openCommitDiff(c, f);
          g.append(fr);
        }
      }
      if (graph.more) {
        const more = h("button", "git-link git-graph-more", t("graph.more"));
        more.onclick = () => { graph.limit += GRAPH_PAGE; loadGraph(); };
        g.append(more);
      }
    }
    ui.graphHost.replaceChildren(g);
    ui.list.scrollTop = scroll;
  }

  function render() {
    if (!viewEl) return;
    if (!ctx.workspace.root || available === false || !st) {
      ui = null;
      const empty = h("div", "git-empty");
      if (!ctx.workspace.root) empty.append(h("p", null, t("empty.noFolder")));
      else if (available === false) empty.append(h("p", null, t("empty.noGit")));
      else if (available === null || refreshing || root) empty.append(h("p", "git-dim", t("loading")));
      else {
        empty.append(h("p", null, t("empty.noRepo")));
        const b = h("button", "git-btn primary", t("action.init"));
        b.onclick = init;
        empty.append(b);
      }
      return viewEl.replaceChildren(h("div", `git-progress${busy ? " active" : ""}`), empty);
    }
    if (!ui) {
      ui = buildRepoUi();
      viewEl.replaceChildren(ui.el);
      renderGraph();
    }
    ui.progress.classList.toggle("active", !!busy);
    ui.branch.replaceChildren(icons.create("git-branch", { size: 14 }), h("span", null, st.branch ?? t("noBranch")));
    ui.box.placeholder = t("commit.placeholder", { branch: st.branch ?? "HEAD", keys: "Ctrl+Enter" });
    ui.commitBtn.disabled = !!busy || (!st.staged.length && !st.unstaged.length);

    const syncButtons = [];
    if (!st.upstream && st.oid && !st.detached) {
      const pub = h("button", "git-btn git-sync-btn");
      pub.append(icons.create("cloud-upload", { size: 14 }), h("span", null, t("action.publish")));
      pub.onclick = push;
      syncButtons.push(pub);
    } else if (st.ahead || st.behind) {
      const s = h("button", "git-btn git-sync-btn");
      s.append(icons.create("refresh-cw", { size: 14 }), h("span", null, t("action.syncCounts", { ahead: st.ahead, behind: st.behind })));
      s.onclick = sync;
      syncButtons.push(s);
    }
    ui.syncHost.replaceChildren(...syncButtons);

    const scroll = ui.list.scrollTop;
    const conflicts = st.conflicts.map((e) => ({ ...e, conflict: true }));
    const groups = [
      group("conflicts", t("group.conflicts"), conflicts, [["plus", t("action.stageAll"), () => stage(conflicts)]]),
      group("staged", t("group.staged"), st.staged, [["minus", t("action.unstageAll"), () => unstage(st.staged)]]),
      group("unstaged", t("group.changes"), st.unstaged, [
        ["undo-2", t("action.discardAll"), () => discard(st.unstaged)],
        ["plus", t("action.stageAll"), () => stage(st.unstaged)],
      ]),
    ].filter(Boolean);
    ui.changes.replaceChildren(...(groups.length ? groups : [h("div", "git-empty git-dim", t("empty.clean"))]));
    ui.list.scrollTop = scroll;
  }

  wb.registerView({
    id: "scm",
    title: t("view.title"),
    icon: "git-branch",
    mount(el) {
      viewEl = h("div", "git-view");
      el.append(viewEl);
      render();
    },
  });

  // ---------- status bar ----------

  let statusEl = null;
  ctx.slots.contribute("workbench.status.left", (host) => {
    statusEl = h("span", "git-status");
    host.append(statusEl);
    renderStatusBar();
  });

  function renderStatusBar() {
    if (!statusEl) return;
    if (!st) return statusEl.replaceChildren();
    const branch = h("button", "git-status-item");
    branch.title = t("branch.pick");
    branch.append(icons.create("git-branch", { size: 13 }), h("span", null, `${st.branch ?? t("noBranch")}${changeCount() ? "*" : ""}`));
    branch.onclick = checkout;
    const syncItem = h("button", "git-status-item");
    if (st.upstream) {
      syncItem.title = t("action.sync");
      syncItem.append(icons.create("refresh-cw", { size: 13, className: busy ? "git-spin" : "" }));
      if (st.behind || st.ahead) syncItem.append(h("span", null, `${st.behind}↓ ${st.ahead}↑`));
      syncItem.onclick = sync;
    } else if (st.oid) {
      syncItem.title = t("action.publish");
      syncItem.append(icons.create("cloud-upload", { size: 13 }));
      syncItem.onclick = push;
    }
    statusEl.replaceChildren(branch, ...(syncItem.childNodes.length ? [syncItem] : []));
  }

  // ---------- commands ----------

  const cmd = (id, run) => ctx.commands.register(`git.${id}`, `%cmd.${id}%`, run);
  cmd("focus", () => { wb.showView("scm"); viewEl?.querySelector(".git-message")?.focus(); });
  cmd("refresh", () => refresh());
  cmd("commit", commit);
  cmd("stageAll", () => st && stage([...st.unstaged, ...st.conflicts]));
  cmd("unstageAll", () => st?.staged.length && unstage(st.staged));
  cmd("discardAll", () => st && discard(st.unstaged));
  cmd("pull", pull);
  cmd("push", push);
  cmd("fetch", fetch);
  cmd("sync", sync);
  cmd("checkout", checkout);
  cmd("createBranch", createBranch);
  cmd("init", init);
  cmd("overview", openOverview);
  // Diff of the editor's active file against the index (or what's staged when there's nothing else).
  let activeFile = null;
  ctx.events.on("editor.activeFile", ({ path }) => (activeFile = path));
  cmd("openChanges", () => {
    const p = toRepoPath(activeFile);
    const entry = p && (st?.unstaged.find((e) => e.path === p) ?? st?.staged.find((e) => e.path === p));
    if (entry) openDiff(entry, !st.unstaged.includes(entry));
  });
  ctx.keybindings.bind("ctrl+shift+g", "git.focus");

  // ---------- staying current ----------

  for (const ev of ["file.saved", "file.renamed", "file.deleted"]) ctx.events.on(ev, () => refresh());
  window.addEventListener("focus", () => refresh());
  // Changes made outside the app (a terminal, another editor): poll while the window is in use.
  setInterval(() => !busy && document.hasFocus() && document.visibilityState === "visible" && refresh(), POLL_MS);
  refresh();
}
