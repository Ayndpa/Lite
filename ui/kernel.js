// Lite UI kernel.
// Provides: workspace (one folder per window), plugin loading (dependency order), commands,
// keybindings, events, slots (UI mount points), services (plugin-to-plugin APIs) and
// permission-gated host access, localization. Its own UI: the title bar (project switcher, window
// controls — titlebar.js; plugins add buttons and the "titlebar.center" slot) and the background: a
// logo watermark (with hints contributed by plugins), the About dialog and the language picker — see shell.js.

import { createLogo, formatCombo, mountWatermark, showAbout, showLanguagePicker } from "./shell.js";
import { mountTitlebar } from "./titlebar.js";
import { createPluginManager } from "./plugin-manager.js";
import { LOCALES, loadMessages, localeName, resolvePlaceholder, resolveLocale, systemLocale, translator } from "./i18n.js";

const { invoke } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const appWebview = window.__TAURI__.webview.getCurrentWebview();

const ACTIVATE_TIMEOUT_MS = 5000;

const appInfo = { name: "Lite", version: "", tauri: "" };

// Localization. The locale is fixed for the life of a window; changing it reloads the window.
let localePreference = null; // state.json "locale": a locale id, or null = follow the system
let locale = resolveLocale(null);
let t = translator({}); // kernel's own messages (ui/locales)
let tEn = t;
const pluginI18n = new Map(); // plugin id -> { t, en }

/** Resolve a "%key%" title in both the UI language and English (for bilingual search). */
function dualTitle(title, i18n) {
  if (title && typeof title === "object") return { title: title.title, titleEn: title.titleEn ?? title.title };
  return { title: resolvePlaceholder(title, i18n.t), titleEn: resolvePlaceholder(title, i18n.en) };
}
let watermark = null;
const watermarkHints = []; // { commandId, label, plugin }
let pluginManager = null; // built in (ui/plugin-manager.js), created in boot()

let workspace = { root: null, name: null };
let titlebar = null; // created in boot(), once the workspace is known
const platform = /Mac/.test(navigator.platform) ? "macos" : /Win/.test(navigator.platform) ? "windows" : "linux";

/** Switching folders reloads the window, so plugins never need to handle a workspace change. */
function openWorkspace(path) {
  location.search = `?folder=${encodeURIComponent(path ?? "")}`;
}

// ---------- primitives ----------

const listeners = new Map(); // event -> Set<fn>
const commands = new Map(); // id -> { id, title, run, plugin }
// Keybindings: plugins declare defaults, the user may override per command (persisted in state.json).
const defaultBindings = new Map(); // commandId -> [combo]
let userBindings = new Map(); // commandId -> [combo]; [] = explicitly unbound
const keymap = new Map(); // combo -> commandId (effective; rebuilt on every change)
let takenCombos = new Map(); // combo -> true if another app owns it as a global hotkey
const slots = new Map(); // name -> HTMLElement
const pendingContributions = new Map(); // slot name -> [{ plugin, mount }]
const services = new Map(); // name -> api
const serviceProviders = new Map(); // service name -> plugin id (shown on the plugin details page)
const slotOwners = new Map(); // slot name -> plugin id
const serviceWaiters = new Map(); // name -> [resolve]
const plugins = new Map(); // id -> { manifest, status, error }

function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) {
    try { fn(payload); } catch (e) { console.error(`[lite] listener for ${event} failed`, e); }
  }
}

function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

async function executeCommand(id, ...args) {
  const cmd = commands.get(id);
  if (!cmd) throw new Error(`Unknown command: ${id}`);
  return cmd.run(...args);
}

function mountContribution(slotEl, plugin, mount) {
  const el = document.createElement("div");
  el.className = "lite-contribution";
  el.dataset.plugin = plugin;
  slotEl.appendChild(el);
  try { mount(el); } catch (e) { console.error(`[lite] ${plugin} failed to mount`, e); }
}

function defineSlot(name, el) {
  if (slots.has(name)) throw new Error(`Slot already defined: ${name}`);
  slots.set(name, el);
  for (const { plugin, mount } of pendingContributions.get(name) ?? []) mountContribution(el, plugin, mount);
  pendingContributions.delete(name);
  emit("kernel.slotDefined", name);
}

function contribute(slot, plugin, mount) {
  const el = slots.get(slot);
  if (el) return mountContribution(el, plugin, mount);
  if (!pendingContributions.has(slot)) pendingContributions.set(slot, []);
  pendingContributions.get(slot).push({ plugin, mount });
}

function provideService(name, api) {
  services.set(name, api);
  for (const resolve of serviceWaiters.get(name) ?? []) resolve(api);
  serviceWaiters.delete(name);
}

function getService(name) {
  if (services.has(name)) return Promise.resolve(services.get(name));
  return new Promise((resolve) => {
    if (!serviceWaiters.has(name)) serviceWaiters.set(name, []);
    serviceWaiters.get(name).push(resolve);
  });
}

// ---------- keybindings ----------

const MODIFIERS = ["ctrl", "alt", "shift", "meta"];
const CODE_KEYS = {
  Comma: ",", Period: ".", Slash: "/", Minus: "-", Equal: "=", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Backslash: "\\", Backquote: "`", Space: "space",
};

/** Physical key name, independent of Shift ("Ctrl+Shift+," must not become "<"). Null for bare modifiers. */
function keyName(e) {
  if (e.code.startsWith("Key")) return e.code.slice(3).toLowerCase();
  if (e.code.startsWith("Digit")) return e.code.slice(5);
  if (CODE_KEYS[e.code]) return CODE_KEYS[e.code];
  const k = e.key.toLowerCase();
  return ["control", "shift", "alt", "meta", "altgraph"].includes(k) ? null : k;
}

function comboFromEvent(e) {
  const key = keyName(e);
  if (!key) return null;
  return [...MODIFIERS.filter((m) => e[`${m}Key`]), key].join("+");
}

/** Canonical form: lower case, modifiers in a fixed order. */
function normalizeCombo(combo) {
  const parts = combo.toLowerCase().split("+");
  const key = parts.filter((p) => !MODIFIERS.includes(p)).pop();
  return [...MODIFIERS.filter((m) => parts.includes(m)), key].join("+");
}

function bindDefault(combo, commandId) {
  const list = defaultBindings.get(commandId) ?? [];
  list.push(normalizeCombo(combo));
  defaultBindings.set(commandId, list);
  rebuildKeymap();
}

const bindingsOf = (commandId) => userBindings.get(commandId) ?? defaultBindings.get(commandId) ?? [];

function rebuildKeymap() {
  keymap.clear();
  for (const commandId of new Set([...defaultBindings.keys(), ...userBindings.keys()])) {
    for (const combo of bindingsOf(commandId)) if (!keymap.has(combo)) keymap.set(combo, commandId);
  }
}

/** Ask the host which bound combos are global hotkeys of other apps (they never reach us). */
async function refreshTakenCombos() {
  const all = new Set([...keymap.keys(), ...[...defaultBindings.values()].flat()]);
  try {
    takenCombos = new Map(Object.entries(await invoke("hotkeys_taken", { combos: [...all] })));
  } catch (e) {
    console.error("[lite] hotkey check failed", e);
  }
}

async function setUserBinding(commandId, combos) {
  combos === null ? userBindings.delete(commandId) : userBindings.set(commandId, combos.map(normalizeCombo));
  rebuildKeymap();
  const state = await invoke("read_state");
  await invoke("write_state", { state: { ...state, keybindings: Object.fromEntries(userBindings) } });
  await refreshTakenCombos();
  renderWatermarkHints();
  emit("keybindings.changed");
}

/** The binding to advertise: the first one that actually reaches us. */
const comboFor = (commandId) => {
  const combos = bindingsOf(commandId);
  return combos.find((c) => !takenCombos.get(c)) ?? combos[0] ?? null;
};
/** "Ctrl+Shift+," for display, or "". */
const keysFor = (commandId) => {
  const combo = comboFor(commandId);
  return combo ? formatCombo(combo).join("+") : "";
};


window.addEventListener("keydown", (e) => {
  // Already handled by a focused widget (e.g. the code editor's own keymap): don't run a command too.
  if (e.defaultPrevented) return;
  const combo = comboFromEvent(e);
  const id = combo && keymap.get(combo);
  if (!id) return;
  e.preventDefault();
  executeCommand(id).catch((err) => console.error(err));
});

// ---------- shell: About + watermark ----------

function webviewVersion() {
  const ua = navigator.userAgent;
  return ua.match(/Edg\/([\d.]+)/)?.[0].replace("Edg/", "WebView2 ") ?? ua.match(/AppleWebKit\/([\d.]+)/)?.[0] ?? "unknown";
}

function openAbout() {
  const all = [...plugins.values()];
  showAbout({
    appName: appInfo.name,
    t,
    rows: [
      [t("about.version"), appInfo.version],
      [t("about.tauri"), appInfo.tauri],
      [t("about.engine"), webviewVersion()],
      [t("about.platform"), `${platform} (${navigator.userAgent.match(/\(([^)]+)\)/)?.[1] ?? navigator.platform})`],
      [t("about.plugins"), t("about.pluginsValue", { active: all.filter((p) => p.status === "active").length, total: all.length })],
      [t("about.workspace"), workspace.root ?? t("about.workspaceNone")],
      [t("about.language"), localeName(locale)],
    ],
    onChangeLanguage: openLanguagePicker,
  });
}

function openLanguagePicker() {
  showLanguagePicker({
    t,
    current: localePreference,
    options: [{ id: null, name: t("language.auto", { system: localeName(systemLocale()) }) }, ...LOCALES],
    async onPick(preference) {
      if (preference === localePreference) return;
      try {
        const state = await invoke("read_state");
        const next = { ...state };
        preference ? (next.locale = preference) : delete next.locale;
        await invoke("write_state", { state: next });
      } catch (e) {
        // e.g. the plugins folder (where state.json lives) was moved or is read-only
        console.error("[lite] cannot save the language", e);
        alert(t("language.saveFailed", { error: String(e) }));
        return;
      }
      location.reload();
    },
  });
}

// Kernel-owned commands, so palettes, title bars and the watermark logo can all reach them.
// Titles are filled in once the kernel's messages are loaded (see boot).
commands.set("app.about", { id: "app.about", title: "", titleEn: "", run: openAbout, plugin: "kernel" });
commands.set("app.language", { id: "app.language", title: "", titleEn: "", run: openLanguagePicker, plugin: "kernel" });

/** Shown under the logo; only commands that exist (and their current keybinding) are listed. */
function renderWatermarkHints() {
  watermark?.renderHints(
    watermarkHints
      .filter((h) => commands.has(h.commandId))
      .map((h) => ({ label: h.label, combo: comboFor(h.commandId), run: () => executeCommand(h.commandId) })),
  );
}

// ---------- plugins (shared by the context API and the built-in manager) ----------

const listPlugins = () => [...plugins.values()].map(({ manifest, status, error }) => ({ ...manifest, status, error }));

/** ids: one id or an array, applied in a single state write. */
async function setPluginsEnabled(ids, enabled) {
  const state = await invoke("read_state");
  const disabled = new Set(state.disabled ?? []);
  for (const pluginId of [ids].flat()) enabled ? disabled.delete(pluginId) : disabled.add(pluginId);
  await invoke("write_state", { state: { ...state, disabled: [...disabled] } });
}

const kernelCommand = (id, title, titleEn, run) => commands.set(id, { id, title, titleEn, run, plugin: "kernel" });

function setupPluginManager() {
  pluginManager = createPluginManager({
    t,
    tEn,
    list: listPlugins,
    setEnabled: setPluginsEnabled,
    reload: () => location.reload(),
    shortcut: keysFor,
    /** What a loaded plugin added to the app (empty for plugins that aren't running). */
    contributions: (pluginId) => ({
      commands: [...commands.values()].filter((c) => c.plugin === pluginId).map((c) => ({ id: c.id, title: c.title, keys: keysFor(c.id) })),
      services: [...serviceProviders].filter(([, p]) => p === pluginId).map(([name]) => name),
      slots: [...slotOwners].filter(([, p]) => p === pluginId).map(([name]) => name),
      modules: Object.keys(plugins.get(pluginId)?.manifest.modules ?? {}),
    }),
  });
  kernelCommand("plugins.manage", t("pm.cmd.manage"), tEn("pm.cmd.manage"), () => pluginManager.manage());
  kernelCommand("plugins.reload", t("pm.cmd.reload"), tEn("pm.cmd.reload"), () => location.reload());
  // Not Ctrl+Shift+X (VS Code's): input methods and chat apps often grab it as a global hotkey.
  bindDefault("ctrl+shift+,", "plugins.manage");
  bindDefault("ctrl+r", "plugins.reload");
  watermarkHints.push({ commandId: "plugins.manage", label: t("pm.hint.manage"), plugin: "kernel" });
}

/** Projects are the kernel's: open / new window / close, used by the title bar's project menu. */
function setupWorkspaceCommands() {
  const openFolder = async (newWindow) => {
    const path = await invoke("pick_folder");
    if (!path) return;
    newWindow ? invoke("open_window", { folder: path }) : openWorkspace(path);
  };
  const cmd = (id, key, run) => kernelCommand(id, t(key), tEn(key), run);
  cmd("workspace.openFolder", "cmd.openFolder", () => openFolder(false));
  cmd("workspace.openFolderNewWindow", "cmd.openFolderNewWindow", () => openFolder(true));
  cmd("workspace.newWindow", "cmd.newWindow", () => invoke("open_window", { folder: null }));
  cmd("workspace.close", "cmd.closeFolder", () => workspace.root && openWorkspace(null));
  bindDefault("ctrl+o", "workspace.openFolder");
  bindDefault("ctrl+shift+n", "workspace.newWindow");
}

// ---------- plugin context ----------

function createContext(manifest) {
  const id = manifest.id;
  const perms = new Set(manifest.permissions ?? []);
  const need = (p) => {
    if (!perms.has(p)) throw new Error(`Plugin "${id}" lacks permission "${p}"`);
  };
  const i18n = pluginI18n.get(id);
  const pt = Object.assign((key, params) => i18n.t(key, params), { en: (key, params) => i18n.en(key, params) });

  return {
    id,
    manifest,
    platform,
    /**
     * t("key", { param }) translates from this plugin's locales/<locale>.json (English fallback);
     * t.en(...) always gives English. Titles passed to commands.register may be "%key%".
     */
    t: pt,
    locale,
    app: {
      get name() { return appInfo.name; },
      get version() { return appInfo.version; },
      /** The product logo as an <svg> element. */
      logo: (size) => createLogo(size),
    },
    /** Hints on the empty background, e.g. addHint("commandPalette.show", "%hint.show%"). */
    watermark: {
      addHint(commandId, label) {
        watermarkHints.push({ commandId, label: resolvePlaceholder(label, i18n.t), plugin: id });
      },
    },
    /** Read-only access to this plugin's own files (bundled data, templates, …). */
    assets: {
      readText: (file) => invoke("read_plugin_file", { dir: manifest.dir, file }),
      /** URL for import()/fetch()/<img> — loads lazily, e.g. `await import(ctx.assets.url("lang.js"))`. */
      url: (file) => pluginUrl(manifest.dir, file),
    },
    /** The kernel's title bar: icon buttons on the right (the tooltip shows the command's current shortcut). */
    titlebar: {
      /** { id, icon: Element (e.g. from the icons service), title (localized, no keys), command } */
      addButton: (button) => titlebar.addButton({ ...button, plugin: id }),
    },
    window: {
      minimize: () => (need("window"), appWindow.minimize()),
      toggleMaximize: () => (need("window"), appWindow.toggleMaximize()),
      close: () => (need("window"), appWindow.close()),
      startDragging: () => (need("window"), appWindow.startDragging()),
      isMaximized: () => appWindow.isMaximized(),
      onResized: (fn) => appWindow.onResized(fn),
    },
    commands: {
      /** title: "%key%" (resolved in both languages), a plain string, or { title, titleEn }. */
      register(cmdId, title, run) { commands.set(cmdId, { id: cmdId, ...dualTitle(title, i18n), run, plugin: id }); },
      execute: executeCommand,
      list: () => [...commands.values()].map(({ id, title, titleEn, plugin }) => ({ id, title, titleEn, plugin })),
    },
    keybindings: {
      /** Declare a default binding; the user's override (if any) wins. */
      bind: bindDefault,
      /** Every command with its effective, default and taken-by-another-app bindings. */
      list: () =>
        [...commands.values()].map((c) => ({
          command: c.id,
          title: c.title,
          titleEn: c.titleEn,
          plugin: c.plugin,
          keys: bindingsOf(c.id),
          defaults: defaultBindings.get(c.id) ?? [],
          custom: userBindings.has(c.id),
        })),
      /** Combo owned by another app as a global hotkey: true / false / undefined (unknown). */
      isTaken: (combo) => takenCombos.get(combo),
      check: (combos) => invoke("hotkeys_taken", { combos }),
      /** Combo string for a KeyboardEvent ("ctrl+shift+,"), or null for a bare modifier. */
      fromEvent: comboFromEvent,
      /** ["Ctrl", "Shift", ","] for display. */
      format: formatCombo,
      set: (commandId, combos) => (need("keybindings"), setUserBinding(commandId, combos)),
      reset: (commandId) => (need("keybindings"), setUserBinding(commandId, null)),
    },
    events: { on, emit },
    slots: {
      define: (name, el) => (slotOwners.set(name, id), defineSlot(name, el)),
      contribute: (slot, mount) => contribute(slot, id, mount),
    },
    services: {
      provide: (name, api) => (serviceProviders.set(name, id), provideService(name, api)),
      get: getService,
    },
    /** Current shortcut of a command for display ("Ctrl+W"), or "". */
    keysFor,
    workspace: {
      get root() { return workspace.root; },
      get name() { return workspace.name; },
      pickFolder: () => (need("workspace"), invoke("pick_folder")),
      open: (path) => (need("workspace"), openWorkspace(path)),
      close: () => (need("workspace"), openWorkspace(null)),
      openInNewWindow: (path) => (need("workspace"), invoke("open_window", { folder: path ?? null })),
      recent: async () => (await invoke("read_state")).recent ?? [],
    },
    // Scoped to the workspace by the Rust kernel; fails when no folder is open.
    fs: {
      readDir: (path) => (need("fs"), invoke("fs_read_dir", { path })),
      // Arrives as raw bytes (no JSON round-trip); invalid UTF-8 shows as U+FFFD instead of failing.
      readText: async (path) => (need("fs"), new TextDecoder().decode(await invoke("fs_read_text", { path }))),
      writeText: (path, text) => (need("fs"), invoke("fs_write_text", { path, text })),
      /** Fails if the path exists (never overwrites). */
      createFile: (path) => (need("fs"), invoke("fs_create_file", { path })),
      createDir: (path) => (need("fs"), invoke("fs_create_dir", { path })),
      /** Fails if `to` exists. The workspace root itself can't be renamed or trashed. */
      rename: (from, to) => (need("fs"), invoke("fs_rename", { from, to })),
      /** Delete by moving to the system recycle bin / trash. */
      trash: (path) => (need("fs"), invoke("fs_trash", { path })),
      /** Show in the OS file manager. */
      reveal: (path) => (need("fs"), invoke("fs_reveal", { path })),
    },
    /** run(args, { stdin }) -> { code, stdout, stderr }: `git` in the workspace folder (no prompts, no console). */
    git: {
      run: (args, { stdin } = {}) => (need("git"), invoke("git_run", { args, stdin: stdin ?? null })),
    },
    /** Open an http(s) URL in the default browser. */
    openExternal: (url) => invoke("open_external", { url }),
    /**
     * Pseudo-terminals running the user's default shell in the workspace folder (they die with the window).
     * spawn({ cols, rows, onData(Uint8Array), onExit(code) }) -> { id, shell }
     */
    pty: {
      defaultShell: () => (need("terminal"), invoke("pty_default_shell")),
      async spawn({ cols, rows, onData, onExit }) {
        need("terminal");
        const { Channel } = window.__TAURI__.core;
        const data = new Channel();
        data.onmessage = (buf) => onData(new Uint8Array(buf)); // raw bytes, no JSON
        const exit = new Channel();
        exit.onmessage = (code) => onExit?.(code);
        return invoke("pty_spawn", { cols, rows, onData: data, onExit: exit });
      },
      write: (id, data) => (need("terminal"), invoke("pty_write", { id, data })),
      resize: (id, cols, rows) => (need("terminal"), invoke("pty_resize", { id, cols, rows })),
      kill: (id) => (need("terminal"), invoke("pty_kill", { id })),
    },
    /** The built-in plugin manager, for layouts that want to host its list (e.g. as a sidebar view). */
    pluginManager: {
      mountList: (el) => (need("plugins"), pluginManager.mountList(el)),
      /** show(): reveal the hosted list; the "Manage Plugins" command then uses it instead of the standalone panel. */
      setHost: (show) => (need("plugins"), pluginManager.setHost(show)),
      /** open({ id, title, render(el) }): show a plugin's details page, e.g. as an editor tab. */
      setDetailsHost: (open) => (need("plugins"), pluginManager.setDetailsHost(open)),
    },
    plugins: {
      list: listPlugins,
      /** ids: one id or an array, applied in a single state write. */
      setEnabled: (ids, enabled) => (need("plugins"), setPluginsEnabled(ids, enabled)),
      reload: () => (need("plugins"), location.reload()),
    },
  };
}

// ---------- loading ----------

/**
 * URL of a file inside a plugin, served by the host's lite-plugin protocol. The webview fetches it
 * on demand (nothing is copied into JS memory) and relative imports between plugin files just work.
 */
function pluginUrl(dir, file) {
  const path = [dir, ...file.split("/")].map(encodeURIComponent).join("/");
  return platform === "windows" ? `http://lite-plugin.localhost/${path}` : `lite-plugin://localhost/${path}`;
}

/**
 * Plugins may share ES modules: manifest "modules": { "<specifier>": "<file>" }. All enabled plugins'
 * modules go into one import map before any plugin code runs, so e.g. every language plugin imports
 * the editor's single copy of "@codemirror/state". The first plugin (in load order) to provide a specifier wins.
 */
function installImportMap(order) {
  const imports = {};
  for (const m of order) {
    for (const [specifier, file] of Object.entries(m.modules ?? {})) {
      if (specifier in imports) console.warn(`[lite] ${m.id}: module "${specifier}" already provided`);
      else imports[specifier] = pluginUrl(m.dir, file);
    }
  }
  if (!Object.keys(imports).length) return;
  const script = document.createElement("script");
  script.type = "importmap";
  script.textContent = JSON.stringify({ imports });
  document.head.appendChild(script);
}

function loadStylesheet(href, pluginId) {
  return new Promise((resolve) => {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href });
    link.dataset.plugin = pluginId;
    link.onload = link.onerror = resolve; // a broken stylesheet must not block boot
    document.head.appendChild(link);
  });
}

async function loadPlugin(manifest) {
  await Promise.all((manifest.styles ?? []).map((css) => loadStylesheet(pluginUrl(manifest.dir, css), manifest.id)));
  const mod = await import(pluginUrl(manifest.dir, manifest.main ?? "main.js"));
  // A plugin awaiting a service nobody provides must not block boot (the window is still hidden).
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(t("plugin.error.timeout", { ms: ACTIVATE_TIMEOUT_MS }))), ACTIVATE_TIMEOUT_MS);
  });
  await Promise.race([mod.activate?.(createContext(manifest)), timeout]).finally(() => clearTimeout(timer));
}

/** Topologically order plugins; disabled ones and anything depending on them are skipped. */
function resolveOrder(manifests, disabled) {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const order = [];
  const visiting = new Set();
  const done = new Map(); // id -> ok?

  const visit = (m) => {
    if (done.has(m.id)) return done.get(m.id);
    if (visiting.has(m.id)) return fail(m, t("plugin.error.circular"));
    if (disabled.has(m.id)) return fail(m, null, "disabled");
    visiting.add(m.id);
    for (const dep of m.dependencies ?? []) {
      const d = byId.get(dep);
      if (!d) return fail(m, t("plugin.error.missing", { dep }));
      if (!visit(d)) return fail(m, t("plugin.error.notLoaded", { dep: d.name }));
    }
    visiting.delete(m.id);
    order.push(m);
    done.set(m.id, true);
    return true;
  };
  const fail = (m, error, status = "skipped") => {
    visiting.delete(m.id);
    plugins.set(m.id, { manifest: m, status, error });
    done.set(m.id, false);
    return false;
  };

  manifests.forEach(visit);
  return order;
}

/** Windows start frameless and hidden (the kernel draws the title bar); show once plugins are in. */
async function revealWindow() {
  try {
    // Older builds could switch native decorations on; make sure a reused window is frameless.
    await appWindow.setDecorations(false);
  } finally {
    await appWindow.show();
    await appWindow.setFocus();
    // Showing a window that started hidden focuses the native window but not the WebView2 inside it,
    // so keystrokes go nowhere until the user clicks. Hand focus over now and on every re-activation.
    const focusWebview = () => appWebview.setFocus().catch((e) => console.error("[lite] cannot focus webview", e));
    await focusWebview();
    appWindow.onFocusChanged(({ payload: focused }) => focused && !document.hasFocus() && focusWebview());
  }
}

/** Load each plugin's locales/<locale>.json and resolve "%key%" in its manifest name/description. */
async function localizeManifests(manifests) {
  await Promise.all(
    manifests.map(async (m) => {
      const { messages, english } = await loadMessages(locale, (loc) =>
        invoke("read_plugin_file", { dir: m.dir, file: `locales/${loc}.json` }),
      );
      const i18n = { t: translator(messages), en: translator(english) };
      pluginI18n.set(m.id, i18n);
      for (const field of ["name", "description"]) {
        m[`${field}En`] = resolvePlaceholder(m[field], i18n.en);
        m[field] = resolvePlaceholder(m[field], i18n.t);
      }
    }),
  );
}

async function boot() {
  // The webview's own menu (Back / Reload / Inspect) never shows (also disabled host-side on Windows).
  // Each plugin shows its own menus for its own UI; the kernel provides none.
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  const state = await invoke("read_state");
  localePreference = state.locale ?? null;
  locale = resolveLocale(localePreference);
  document.documentElement.lang = locale;
  const kernelMessages = await loadMessages(locale, (loc) =>
    fetch(`locales/${loc}.json`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText)))),
  );
  t = translator(kernelMessages.messages);
  tEn = translator(kernelMessages.english);

  const tauriApp = window.__TAURI__.app;
  [appInfo.name, appInfo.version, appInfo.tauri] = await Promise.all([tauriApp.getName(), tauriApp.getVersion(), tauriApp.getTauriVersion()]);
  Object.assign(commands.get("app.about"), { title: t("command.about", appInfo), titleEn: tEn("command.about", appInfo) });
  Object.assign(commands.get("app.language"), { title: t("command.language"), titleEn: tEn("command.language") });
  watermark = mountWatermark({ appName: appInfo.name, logoTitle: t("about.tooltip", appInfo), onLogoClick: openAbout });
  setupPluginManager();

  defineSlot("root", document.getElementById("root"));

  // ?folder=<path> binds a folder; ?folder= (empty) means explicitly none; no param restores the last one.
  const query = new URLSearchParams(location.search);
  workspace = await invoke("init_workspace", { folder: query.get("folder"), restore: !query.has("folder") });
  setupWorkspaceCommands();
  titlebar = mountTitlebar({
    t,
    workspace,
    recent: async () => (await invoke("read_state")).recent ?? [],
    logo: createLogo,
    aboutTitle: t("about.tooltip", appInfo),
    keysFor,
    run: (commandId) => executeCommand(commandId).catch((e) => console.error(e)),
    openPath: openWorkspace,
    appWindow,
    controls: platform !== "macos",
  });
  defineSlot("titlebar.center", titlebar.center);

  const manifests = await invoke("list_plugins");
  await localizeManifests(manifests);
  userBindings = new Map(Object.entries(state.keybindings ?? {}).filter(([, v]) => Array.isArray(v)));
  const order = resolveOrder(manifests, new Set(state.disabled ?? []));
  installImportMap(order);

  for (const m of order) {
    try {
      await loadPlugin(m);
      plugins.set(m.id, { manifest: m, status: "active" });
    } catch (e) {
      console.error(`[lite] plugin ${m.id} failed`, e);
      plugins.set(m.id, { manifest: m, status: "failed", error: String(e) });
    }
  }

  pluginManager.ready(kernelCommand);
  rebuildKeymap();
  await refreshTakenCombos();
  renderWatermarkHints();
  emit("kernel.ready");
  // Layouts register plugin-manager hosts in their "kernel.ready" handlers, some via an (already
  // resolved) service promise: let those callbacks run first, then restore the pre-reload view.
  await null;
  pluginManager.restore();
  console.log("[lite] workspace:", workspace.root, "plugins:", Object.fromEntries([...plugins].map(([k, v]) => [k, v.status])));
}

// Never leave the window invisible, even if boot fails.
boot().catch((e) => console.error("[lite] boot failed", e)).finally(revealWindow);
