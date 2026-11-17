// Code editor on CodeMirror 6. One EditorView for all tabs (each tab keeps its own EditorState:
// document, undo history, selection), so memory grows with open documents, not with editors.
//
// Provides the `editor` service. Language plugins register languages; a language's parser is only
// loaded when a file of that type is first opened.
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine,
} from "@codemirror/view";
import {
  foldGutter, indentOnInput, syntaxHighlighting, bracketMatching, foldKeymap, HighlightStyle, LanguageDescription,
} from "@codemirror/language";
import { history, defaultKeymap, historyKeymap, indentWithTab, selectAll, undo, redo } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap, openSearchPanel } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";
import { showMenu, showFieldMenu } from "@lite/context-menu"; // bundled copy: this plugin owns its menus

// Large files (same idea as VS Code's): measured on an 80 MB HTML file, parsing it for highlighting is
// what freezes the UI (CodeMirror already renders only the visible part of even 28M-char lines).
const LARGE_FILE = 10_000_000; // characters; above this, syntax highlighting starts paused

// CodeMirror's built-in UI strings (search panel, folding, …), translated through our locale files.
const CM_PHRASES = [
  "Find", "Replace", "next", "previous", "all", "match case", "regexp", "by word", "replace", "replace all",
  "close", "Go to line", "go", "Folded lines", "Unfolded lines", "to", "folded code", "unfold", "Fold line",
  "Unfold line", "Selection deleted", "Control character", "Completions", "current match", "on line",
];

// Colors are the color theme's CSS variables (syntax.*, editor.*), so a theme switch needs no reconfiguring.
const c = (token) => `var(--lite-${token.replace(/./g, "-")})`;

/** Token classes in VS Code's Dark+ / Light+ grouping. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.bool, t.null, t.atom, t.self], color: c("syntax.keyword") },
  { tag: [t.controlKeyword, t.moduleKeyword], color: c("syntax.control") },
  { tag: [t.name, t.variableName, t.propertyName, t.attributeName, t.definition(t.name)], color: c("syntax.variable") },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName, t.labelName], color: c("syntax.function") },
  { tag: [t.typeName, t.className, t.namespace, t.annotation, t.definition(t.typeName)], color: c("syntax.type") },
  { tag: [t.constant(t.name), t.standard(t.name), t.color], color: c("syntax.constant") },
  { tag: [t.number, t.integer, t.float], color: c("syntax.number") },
  { tag: [t.string, t.attributeValue, t.character, t.docString], color: c("syntax.string") },
  { tag: [t.regexp, t.escape, t.special(t.string), t.url], color: c("syntax.regexp") },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c("syntax.comment") },
  { tag: [t.meta, t.processingInstruction], color: c("syntax.control") },
  { tag: [t.tagName, t.angleBracket], color: c("syntax.tag") },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: c("syntax.operator") },
  { tag: t.heading, color: c("syntax.keyword"), fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: c("syntax.constant"), textDecoration: "underline" },
  { tag: [t.inserted], color: c("syntax.number") },
  { tag: [t.deleted, t.invalid], color: c("syntax.invalid") },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: c("editor.fg"), fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: 'Consolas, "Cascadia Code", "Microsoft YaHei UI", monospace', lineHeight: "1.5" },
  ".cm-content": { caretColor: c("editor.cursor") },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: c("editor.cursor") },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: c("editor.selection"),
  },
  ".cm-activeLine": { backgroundColor: c("editor.activeLine") },
  ".cm-selectionMatch": { backgroundColor: c("editor.selectionMatch") },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: c("editor.bracketMatch"), outline: `1px solid ${c("fg.dim")}` },
  ".cm-gutters": { backgroundColor: "transparent", color: c("editor.lineNumber"), border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: c("editor.lineNumber.active") },
  ".cm-foldPlaceholder": { backgroundColor: c("active"), border: "none", color: c("fg.muted") },
  ".cm-searchMatch": { backgroundColor: c("editor.findMatch") },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: c("editor.findMatch.selected") },
  ".cm-panels": { backgroundColor: c("surface"), color: c("fg") },
  ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${c("border.subtle")}` },
  ".cm-panel input, .cm-panel button": { color: c("fg") },
  ".cm-textfield": { backgroundColor: c("input.bg"), border: `1px solid ${c("control.border")}`, borderRadius: "3px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: c("control.bg"), border: `1px solid ${c("control.border")}`, borderRadius: "3px" },
  ".cm-tooltip": { backgroundColor: c("surface"), border: `1px solid ${c("border")}`, color: c("fg") },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: c("primary"), color: c("primary.fg") },
});

export async function activate(ctx) {
  const icons = await ctx.services.get("icons");
  const editLabels = { cut: ctx.t("edit.cut"), copy: ctx.t("edit.copy"), paste: ctx.t("edit.paste"), selectAll: ctx.t("edit.selectAll") };

  // ---------- language registry ----------

  /** id -> { id, name, extensions: [".js"], filenames: ["Dockerfile"], aliases: [], description: LanguageDescription } */
  const languages = new Map();

  function registerLanguage({ id, name, extensions = [], filenames = [], aliases = [], load }) {
    // LanguageDescription memoizes load(): a parser is fetched and evaluated at most once.
    const description = LanguageDescription.of({ name: id, alias: [name, ...aliases], extensions: extensions.map((e) => e.replace(/^\./, "")), filename: filenames.length ? new RegExp(`^(${filenames.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`, "i") : undefined, load });
    languages.set(id, { id, name, extensions, filenames, aliases, description });
  }

  function languageForFile(fileName) {
    const lower = fileName.toLowerCase();
    let best = null;
    for (const lang of languages.values()) {
      if (lang.filenames.some((f) => f.toLowerCase() === lower)) return lang;
      for (const ext of lang.extensions) {
        if (lower.endsWith(ext.toLowerCase()) && (!best || ext.length > best.ext.length)) best = { lang, ext };
      }
    }
    return best?.lang ?? null;
  }

  // ---------- documents ----------

  const languageConf = new Compartment();
  const phrases = ctx.locale === "en" ? {} : Object.fromEntries(CM_PHRASES.map((p) => [p, ctx.t(`cm.${p}`)]));
  /**
   * Tabs, in order. key -> doc
   *   text: { kind: "text", name, state, dirty, language, scroll }   (key = file path)
   *   page: { kind: "page", name, icon, el }                         (key = "page:<id>", e.g. plugin details;
   *                                                                   icon: Lucide name or { file: path } for a file icon)
   */
  const docs = new Map();
  let current = null;
  let shownDoc = null; // the doc object whose state is in the view right now
  let view, tabs, host, pageHost, empty, statusPos, statusLang, statusFile;

  const baseExtensions = [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
    dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
    autocompletion(), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
    syntaxHighlighting(highlight, { fallback: true }),
    theme,
    EditorState.phrases.of(phrases),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const doc = docs.get(current);
        if (doc?.kind === "text" && !doc.dirty) { doc.dirty = true; renderTabs(); }
      }
      if (u.docChanged || u.selectionSet) updateStatus();
    }),
  ];

  function createState(text) {
    return EditorState.create({ doc: text, extensions: [baseExtensions, languageConf.of([])] });
  }

  /** Load the file's language (lazily) and plug it into that document's state. */
  async function applyLanguage(path) {
    const doc = docs.get(path);
    if (!doc) return;
    let support = []; // no language: plain text
    if (doc.language && !doc.highlightPaused) {
      try {
        support = await doc.language.description.load();
      } catch (e) {
        console.error(`[editor] cannot load language ${doc.language.id}`, e);
        return;
      }
    }
    if (docs.get(path) !== doc) return; // closed or renamed meanwhile
    const effect = languageConf.reconfigure(support);
    if (doc === shownDoc) {
      view.dispatch({ effects: effect });
      doc.state = view.state;
    } else {
      doc.state = doc.state.update({ effects: effect }).state;
    }
  }

  // ---------- UI ----------

  ctx.slots.contribute("workbench.main", (el) => {
    el.innerHTML = `
      <div class="ed">
        <div class="ed-tabs lite-thin-scroll"></div>
        <div class="ed-host" hidden></div>
        <div class="ed-page-host" hidden></div>
        <div class="ed-empty"></div>
      </div>`;
    tabs = el.querySelector(".ed-tabs");
    host = el.querySelector(".ed-host");
    pageHost = el.querySelector(".ed-page-host");
    empty = el.querySelector(".ed-empty");
    empty.textContent = ctx.t("empty");
    view = new EditorView({ parent: host, state: createState("") });
    view.contentDOM.addEventListener("contextmenu", (e) => { e.preventDefault(); textMenu(e); });
    // Inputs of CodeMirror's own panels (find / replace / go to line).
    view.dom.addEventListener("contextmenu", (e) => {
      const field = e.target.closest?.(".cm-panels input[type=text], .cm-panels input:not([type])");
      if (!field) return;
      e.preventDefault();
      showFieldMenu(ctx, e, field, editLabels);
    });
  });

  /** Right-click inside the text: our edit menu (the webview's own menu is disabled). */
  function textMenu(e) {
    const empty = view.state.selection.main.empty;
    const exec = (cmd) => { view.focus(); document.execCommand(cmd); }; // CodeMirror handles the copy/cut events
    showMenu(ctx, e, [
      { label: editLabels.cut, keys: "Ctrl+X", disabled: empty, run: () => exec("cut") },
      { label: editLabels.copy, keys: "Ctrl+C", disabled: empty, run: () => exec("copy") },
      {
        label: editLabels.paste, keys: "Ctrl+V",
        run: async () => {
          const text = await navigator.clipboard.readText().catch(() => "");
          view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.paste" });
          view.focus();
        },
      },
      "-",
      { label: editLabels.selectAll, keys: "Ctrl+A", run: () => { selectAll(view); view.focus(); } },
      { label: ctx.t("edit.find"), keys: "Ctrl+F", run: () => openSearchPanel(view) },
      "-",
      { command: "commandPalette.show" },
    ]);
  }

  ctx.slots.contribute("workbench.status.left", (el) => (statusFile = el));
  ctx.slots.contribute("workbench.status.right", (el) => {
    el.innerHTML = `<span class="ed-status-pos"></span><span class="ed-status-lang"></span>`;
    statusPos = el.querySelector(".ed-status-pos");
    statusLang = el.querySelector(".ed-status-lang");
  });

  function renderTabs() {
    tabs.replaceChildren();
    for (const [key, doc] of docs) {
      const tab = document.createElement("div");
      tab.className = `ed-tab${key === current ? " active" : ""}`;
      tab.title = doc.kind === "text" ? key : doc.name;
      tab.innerHTML = `<span></span><button></button>`;
      if (doc.kind === "loading") tab.prepend(icons.create("loader-circle", { size: 14, className: "ed-tab-icon ed-spin" }));
      else if (doc.kind === "text") tab.prepend(icons.file(doc.name, { size: 14, className: "ed-tab-icon" }));
      else if (doc.icon?.file) tab.prepend(icons.file(doc.icon.file, { size: 14, className: "ed-tab-icon" }));
      else if (doc.icon) tab.prepend(icons.create(doc.icon, { size: 14, className: "ed-tab-icon" }));
      tab.querySelector("span").textContent = doc.name;
      tab.classList.toggle("dirty", !!doc.dirty);
      // Dirty tabs show a dot that turns into the close icon on hover (CSS).
      const closeBtn = tab.querySelector("button");
      closeBtn.title = ctx.t("tab.close");
      closeBtn.append(icons.create("x", { size: 14, className: "ed-close" }), icons.create("circle", { size: 10, className: "ed-dirty" }));
      tab.onclick = () => show(key);
      closeBtn.onclick = (e) => { e.stopPropagation(); closeTabs([key]); };
      // Middle click closes; suppress the browser's middle-click autoscroll on mousedown.
      tab.onmousedown = (e) => e.button === 1 && e.preventDefault();
      tab.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTabs([key]); } };
      tab.oncontextmenu = (e) => { e.preventDefault(); tabMenu(e, key); };
      tabs.appendChild(tab);
    }
  }

  function tabMenu(e, key) {
    const keys = [...docs.keys()];
    const i = keys.indexOf(key);
    const isText = docs.get(key).kind === "text";
    showMenu(ctx, e, [
      { label: ctx.t("menu.close"), keys: ctx.keysFor("editor.close"), run: () => closeTabs([key]) },
      { label: ctx.t("menu.closeOthers"), disabled: keys.length < 2, run: () => closeTabs(keys.filter((k) => k !== key)) },
      { label: ctx.t("menu.closeRight"), disabled: i === keys.length - 1, run: () => closeTabs(keys.slice(i + 1)) },
      { label: ctx.t("menu.closeSaved"), run: () => closeTabs(keys.filter((k) => !docs.get(k).dirty)) },
      { label: ctx.t("menu.closeAll"), keys: ctx.keysFor("editor.closeAll"), run: () => closeTabs(keys) },
      "-",
      { label: ctx.t("menu.copyPath"), disabled: !isText, run: () => copy(key) },
      { label: ctx.t("menu.copyRelativePath"), disabled: !isText, run: () => copy(relative(key)) },
      "-",
      // Disabled automatically when the explorer plugin isn't running.
      { command: "explorer.reveal", args: [key], label: ctx.t("menu.reveal"), ...(isText ? {} : { disabled: true }) },
    ]);
  }

  const relative = (path) => {
    const root = ctx.workspace.root;
    return root && path.startsWith(root) ? path.slice(root.length + 1) : path;
  };
  const copy = (text) => navigator.clipboard.writeText(text).catch((e) => console.error("[editor] copy failed", e));

  /** focus: false keeps keyboard focus where it is (e.g. single click in the explorer). */
  function show(key, { focus = true } = {}) {
    // Save the view into the doc that was actually on screen — not docs.get(current), which may
    // already be a different object (a loading placeholder replaced by the loaded file).
    if (shownDoc?.kind === "text") {
      shownDoc.state = view.state;
      shownDoc.scroll = view.scrollSnapshot();
    }
    current = key;
    const doc = docs.get(key);
    shownDoc = doc ?? null;
    const hasEl = doc?.kind === "page" || doc?.kind === "loading";
    host.hidden = doc?.kind !== "text";
    pageHost.hidden = !hasEl;
    empty.hidden = !!doc;
    if (doc?.kind === "text") {
      view.setState(doc.state);
      if (doc.scroll) view.dispatch({ effects: doc.scroll });
      if (focus) view.focus();
    } else {
      view.setState(createState("")); // drop the last document's state so it can be collected
    }
    if (hasEl) pageHost.replaceChildren(doc.el);
    else pageHost.replaceChildren();
    renderTabs();
    updateStatus();
    ctx.events.emit("editor.activeFile", { path: doc?.kind === "text" ? key : null });
  }

  /** Write a text tab to disk (the visible one or a background one); throws if the write fails. */
  async function saveDoc(key) {
    const doc = docs.get(key);
    if (doc?.kind !== "text") return;
    await ctx.fs.writeText(key, (doc === shownDoc ? view.state : doc.state).doc.toString());
    doc.savedAt = Date.now();
    doc.dirty = false;
    renderTabs();
    ctx.events.emit("file.saved", { path: key }); // e.g. source control refreshes
  }

  /** Save several tabs; on the first failure tells the user and returns false (nothing more is saved). */
  async function saveDocs(keys) {
    for (const key of keys) {
      try {
        await saveDoc(key);
      } catch (e) {
        await ctx.dialogs.confirm({
          title: ctx.t("error.save", { name: docs.get(key)?.name ?? key }),
          body: String(e?.message ?? e),
          buttons: [{ label: ctx.t("unsaved.ok"), value: true, primary: true }],
        });
        return false;
      }
    }
    return true;
  }

  const dirtyKeys = (keys = [...docs.keys()]) => keys.filter((k) => docs.get(k)?.dirty);

  /**
   * These tabs are about to go away (tab closed, window closed or reloaded, folder switched): ask about
   * the unsaved ones — Save / Don't Save / Cancel. Returns false if the user cancelled or a save failed.
   */
  async function resolveUnsaved(keys) {
    const dirty = dirtyKeys(keys);
    if (!dirty.length) return true;
    const names = dirty.map((k) => docs.get(k).name);
    const one = dirty.length === 1;
    const choice = await ctx.dialogs.confirm({
      title: one ? ctx.t("unsaved.title", { name: names[0] }) : ctx.t("unsaved.titleMany", { count: dirty.length }),
      body: one ? ctx.t("unsaved.body") : `${names.join("\n")}\n\n${ctx.t("unsaved.body")}`,
      buttons: [
        { label: ctx.t(one ? "unsaved.save" : "unsaved.saveAll"), value: "save", primary: true },
        { label: ctx.t("unsaved.discard"), value: "discard" },
        { label: ctx.t("unsaved.cancel"), value: null },
      ],
    });
    if (choice === "save") return saveDocs(dirtyKeys(dirty));
    return choice === "discard";
  }

  /** Close tabs, asking first about unsaved ones; resolves false (nothing closed) if the user cancelled. */
  async function closeTabs(keys) {
    if (!(await resolveUnsaved(keys))) return false;
    for (const key of keys) {
      const doc = docs.get(key);
      if (!doc) continue;
      doc.dispose?.();
      docs.delete(key);
    }
    show(docs.has(current) ? current : [...docs.keys()].at(-1) ?? null);
    return true;
  }

  // Closing or reloading the window, or opening another folder, would drop unsaved text silently.
  ctx.window.onBeforeUnload(() => resolveUnsaved([...docs.keys()]));

  /**
   * Open (or focus) a non-text tab, e.g. a plugin's details page or a diff. render(el) fills it;
   * dispose() runs when the tab closes (or is re-rendered); reload: true re-renders an open tab.
   */
  function openPage({ id, title, icon, render, dispose, reload = false }) {
    const key = `page:${id}`;
    const existing = docs.get(key);
    if (existing && reload) {
      existing.dispose?.();
      existing.el.replaceChildren();
      Object.assign(existing, { name: title, icon, dispose });
      render(existing.el);
    } else if (!existing) {
      const el = document.createElement("div");
      el.className = "ed-page";
      docs.set(key, { kind: "page", name: title, icon, el, dispose });
      render(el);
    }
    show(key);
  }

  function updateStatus() {
    if (!statusPos) return;
    const doc = docs.get(current);
    if (doc?.kind !== "text") {
      statusPos.textContent = statusLang.textContent = "";
      statusFile.textContent = doc?.name ?? "";
      return;
    }
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    statusPos.textContent = ctx.t("status.position", { line: line.number, col: head - line.from + 1 });
    const langName = doc.language?.name ?? ctx.t("plainText");
    statusLang.textContent = doc.highlightPaused ? ctx.t("largeFile.status", { language: langName }) : langName;
    statusLang.title = doc.highlightPaused ? ctx.t("largeFile.enable") : "";
    statusLang.classList.toggle("ed-status-action", !!doc.highlightPaused);
    statusLang.onclick = doc.highlightPaused ? () => enableHighlighting(current) : null;
    statusFile.textContent = relative(current);
  }

  /** Large file: the user asked for highlighting anyway. */
  function enableHighlighting(path) {
    const doc = docs.get(path);
    if (!doc?.highlightPaused) return;
    doc.highlightPaused = false;
    applyLanguage(path);
    updateStatus();
  }

  /** Placeholder tab while a file loads; its spinner only appears if loading takes a while (CSS delay). */
  function loadingDoc(name) {
    const el = document.createElement("div");
    el.className = "ed-loading";
    el.append(icons.create("loader-circle", { size: 28, className: "ed-spin" }), Object.assign(document.createElement("div"), { textContent: ctx.t("loading", { name }) }));
    return { kind: "loading", name, el };
  }

  /** Let the browser paint (e.g. the loading tab) before the next synchronous chunk of work. */
  const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

  // { path, name, preserveFocus? } — preserveFocus: show the file but leave keyboard focus where it is.
  ctx.events.on("file.open", async ({ path, name, preserveFocus = false }) => {
    if (docs.has(path)) return show(path, { focus: !preserveFocus });
    const placeholder = loadingDoc(name);
    docs.set(path, placeholder);
    show(path, { focus: false });
    let text;
    try {
      text = await ctx.fs.readText(path); // async: read on a host thread, no JSON round-trip
    } catch (e) {
      if (docs.get(path) === placeholder) closeTabs([path]);
      alert(ctx.t("error.open", { name, error: e }));
      return;
    }
    await nextPaint(); // spinner is on screen before splitting the text into lines (≈0.1 s for 80 MB)
    if (docs.get(path) !== placeholder) return; // tab was closed while loading
    const highlightPaused = text.length > LARGE_FILE;
    docs.set(path, {
      kind: "text", name, state: createState(text), dirty: false, language: languageForFile(name), scroll: null, highlightPaused,
    });
    if (current === path) show(path, { focus: !preserveFocus });
    else renderTabs();
    applyLanguage(path); // async: text shows immediately, colours follow once the parser is loaded
  });

  // ---------- follow file operations made elsewhere (e.g. the explorer) ----------

  /** key is `base` itself or something inside the folder `base`. */
  const isUnder = (key, base) => key === base || key.startsWith(base + "\\") || key.startsWith(base + "/");

  // Renamed/moved (a file, or a folder containing open files): re-key the tabs, keep their state.
  ctx.events.on("file.renamed", ({ from, to }) => {
    if (![...docs.keys()].some((k) => isUnder(k, from))) return;
    const relanguage = [];
    const entries = [...docs].map(([key, doc]) => {
      if (doc.kind !== "text" || !isUnder(key, from)) return [key, doc];
      const newKey = to + key.slice(from.length);
      doc.name = newKey.slice(Math.max(newKey.lastIndexOf("\\"), newKey.lastIndexOf("/")) + 1);
      const language = languageForFile(doc.name);
      if (language !== doc.language) { doc.language = language; relanguage.push(newKey); }
      return [newKey, doc];
    });
    if (current && isUnder(current, from) && docs.get(current)?.kind === "text") current = to + current.slice(from.length);
    docs.clear();
    for (const [k, d] of entries) docs.set(k, d);
    relanguage.forEach(applyLanguage); // e.g. notes.txt -> notes.md
    renderTabs();
    updateStatus();
    ctx.events.emit("editor.activeFile", { path: docs.get(current)?.kind === "text" ? current : null });
  });

  // Changed on disk by someone else (e.g. git discard / checkout / pull): reload open files without
  // unsaved changes, so a later save doesn't write the old text back. { path }: a file or a folder.
  ctx.events.on("file.changed", ({ path }) => reloadFromDisk((key) => isUnder(key, path)));
  // The same for changes the kernel's file watcher saw (another program, a terminal, …).
  ctx.events.on("fs.changed", ({ all, paths }) => {
    // Skip the echo of a save we just made (re-reading a huge file only to find it equal is slow).
    const fresh = (key) => Date.now() - (docs.get(key).savedAt ?? 0) > 1000;
    if (all) return reloadFromDisk(fresh);
    const changed = new Set(paths.map((p) => p.toLowerCase())); // the watcher's spelling may differ in case
    return reloadFromDisk((key) => changed.has(key.toLowerCase()) && fresh(key));
  });

  async function reloadFromDisk(matches) {
    let reloaded = false;
    for (const [key, doc] of [...docs]) {
      if (doc.kind !== "text" || doc.dirty || !matches(key)) continue;
      let text;
      try {
        text = await ctx.fs.readText(key);
      } catch {
        continue; // gone: file.deleted handles that
      }
      if (docs.get(key) !== doc || doc.dirty) continue; // closed or edited meanwhile
      const live = shownDoc === doc;
      const state = live ? view.state : doc.state;
      const old = state.doc.toString();
      if (old === text) continue;
      // Replace only the differing middle, so the cursor and scroll stay put around unchanged text.
      let start = 0;
      while (start < old.length && start < text.length && old[start] === text[start]) start++;
      let end = 0;
      while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) end++;
      const change = { changes: { from: start, to: old.length - end, insert: text.slice(start, text.length - end) } };
      if (live) view.dispatch(change);
      else doc.state = state.update(change).state;
      doc.dirty = false; // the update listener marked it; it matches the disk now
      reloaded = true;
    }
    if (reloaded) renderTabs();
  }

  // Deleted: close the tabs — except ones with unsaved changes, which stay (saving recreates the file).
  ctx.events.on("file.deleted", ({ path }) => {
    const keys = [...docs].filter(([k, d]) => d.kind === "text" && isUnder(k, path) && !d.dirty).map(([k]) => k);
    if (keys.length) closeTabs(keys);
  });

  ctx.commands.register("editor.save", "%cmd.save%", () => current && saveDocs([current]));
  ctx.commands.register("editor.saveAll", "%cmd.saveAll%", () => saveDocs(dirtyKeys()));
  // Undo / redo / find for the Edit menu (the keys themselves are handled by CodeMirror's keymap).
  // A focused text field elsewhere (commit message, search box, …) gets the browser's own undo.
  const historyCommand = (cmCommand, execName) => () => {
    if (document.activeElement?.matches?.("input, textarea")) return void document.execCommand(execName);
    if (shownDoc?.kind !== "text") return;
    cmCommand(view);
    view.focus();
  };
  ctx.commands.register("editor.undo", "%cmd.undo%", historyCommand(undo, "undo"));
  ctx.commands.register("editor.redo", "%cmd.redo%", historyCommand(redo, "redo"));
  ctx.commands.register("editor.find", "%cmd.find%", () => shownDoc?.kind === "text" && openSearchPanel(view));
  ctx.commands.register("editor.close", "%cmd.close%", () => current && closeTabs([current]));
  ctx.commands.register("editor.closeOthers", "%cmd.closeOthers%", () => closeTabs([...docs.keys()].filter((k) => k !== current)));
  ctx.commands.register("editor.closeSaved", "%cmd.closeSaved%", () => closeTabs([...docs.keys()].filter((k) => !docs.get(k).dirty)));
  ctx.commands.register("editor.closeAll", "%cmd.closeAll%", () => closeTabs([...docs.keys()]));
  ctx.commands.register("editor.copyPath", "%cmd.copyPath%", () => docs.get(current)?.kind === "text" && copy(current));
  ctx.commands.register("editor.copyRelativePath", "%cmd.copyRelativePath%", () => docs.get(current)?.kind === "text" && copy(relative(current)));
  ctx.keybindings.bind("ctrl+s", "editor.save");
  ctx.keybindings.bind("ctrl+w", "editor.close");
  ctx.keybindings.bind("ctrl+shift+w", "editor.closeAll");

  ctx.services.provide("editor", {
    /**
     * lang: { id, name, extensions: [".rs"], filenames?: ["Cargo.lock"], aliases?: ["rs"],
     *         load: () => Promise<LanguageSupport> }  — load is called lazily, at most once.
     */
    registerLanguage,
    /** All registered languages as CodeMirror LanguageDescriptions (e.g. for Markdown code blocks). */
    languageDescriptions: () => [...languages.values()].map((l) => l.description),
    /** page: { id, title, icon?, render(el), dispose?(), reload? } — a tab with custom content (no text editing). */
    openPage,
    /** Extensions for read-only viewers (e.g. a diff) that should look exactly like the editor. */
    viewerExtensions: () => [
      lineNumbers(), highlightSpecialChars(), drawSelection(), syntaxHighlighting(highlight, { fallback: true }), theme,
      EditorState.phrases.of(phrases), EditorState.readOnly.of(true), EditorView.editable.of(false),
    ],
    /** The language support for a file name (loaded on demand), or [] for plain text. */
    async languageFor(fileName) {
      const lang = languageForFile(fileName);
      return lang ? lang.description.load().catch(() => []) : [];
    },
  });

  ctx.menubar.add("file", [{ command: "editor.save" }, { command: "editor.saveAll" }], { order: 100 });
  ctx.menubar.add("file", [{ command: "editor.close" }, { command: "editor.closeAll" }], { order: 200 });
  ctx.menubar.add("edit", [{ command: "editor.undo", keys: "Ctrl+Z" }, { command: "editor.redo", keys: "Ctrl+Y" }], { order: 100 });
  ctx.menubar.add("edit", [{ command: "editor.find", keys: "Ctrl+F" }], { order: 200 });
}
