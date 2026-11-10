// Color themes. A theme is { id, name, type: "dark" | "light", colors: { token: CSS color } }.
// Every token becomes a CSS variable on :root (`--lite-` + the token with dots as dashes, e.g.
// "fg.muted" -> --lite-fg-muted), so the kernel's and every plugin's stylesheets follow a switch live,
// without a reload. Themes may be partial (contributed by plugins or the user's own): missing tokens
// come from the built-in theme of the same type.
//
// Sources: built-in (ui/themes/*.json), plugins (manifest "themes": ["themes/x.json"]) and the
// user's custom themes (state.json "customThemes"). state.json "theme" is the chosen id, or "auto"
// (dark or light following the system); default "dark".

export const BUILTIN_THEMES = ["dark", "light"];
export const AUTO = "auto";
const CUSTOM_PREFIX = "custom.";

export const cssVar = (token) => `--lite-${token.replace(/\./g, "-")}`;

/**
 * readState/writeState: state.json access; broadcast(): tell other windows the themes changed;
 * nameOf(theme): display name (built-ins are localized by the kernel).
 */
export function createThemes({ readState, writeState, broadcast }) {
  const builtins = new Map(); // id -> theme (complete)
  const contributed = new Map(); // id -> { ...theme, plugin }
  let custom = new Map(); // id -> theme (partial)
  let preference = "dark";
  let active = null; // resolved theme on screen (may be a preview)
  let previewing = false;
  const listeners = new Set();
  const systemDark = matchMedia("(prefers-color-scheme: dark)");

  const find = (id) => builtins.get(id) ?? custom.get(id) ?? contributed.get(id);

  /** Complete a (possibly partial) theme from the built-in of its type. */
  function resolve(theme) {
    const type = theme.type === "light" ? "light" : "dark";
    return { id: theme.id, name: theme.name, type, colors: { ...builtins.get(type).colors, ...theme.colors } };
  }

  function chosenId() {
    const id = preference === AUTO ? (systemDark.matches ? "dark" : "light") : preference;
    return find(id) ? id : "dark";
  }

  function apply(theme) {
    active = resolve(theme);
    const root = document.documentElement;
    for (const [token, value] of Object.entries(active.colors)) root.style.setProperty(cssVar(token), value);
    root.dataset.theme = active.type;
    root.style.colorScheme = active.type; // native controls (checkboxes, color inputs, …)
    for (const fn of listeners) {
      try {
        fn(active);
      } catch (e) {
        console.error("[lite] theme listener failed", e);
      }
    }
  }

  const applyChosen = () => { previewing = false; apply(find(chosenId())); };

  async function loadState() {
    const state = await readState();
    preference = typeof state.theme === "string" ? state.theme : "dark";
    custom = new Map(
      Object.values(state.customThemes ?? {})
        .filter((th) => th && typeof th.id === "string" && th.id.startsWith(CUSTOM_PREFIX))
        .map((th) => [th.id, { id: th.id, name: String(th.name ?? th.id), type: th.type === "light" ? "light" : "dark", colors: { ...th.colors } }]),
    );
  }

  async function update(fn) {
    const state = await readState();
    fn(state);
    await writeState(state);
    broadcast();
  }

  systemDark.addEventListener("change", () => preference === AUTO && !previewing && applyChosen());

  return {
    /** builtinThemes: [theme]; call once before plugins load. */
    async init(builtinThemes) {
      for (const th of builtinThemes) builtins.set(th.id, th);
      await loadState();
      applyChosen();
    },
    /** A plugin's theme file (manifest "themes"); re-applies if it is the chosen one. */
    contribute(plugin, theme) {
      if (!theme?.id || builtins.has(theme.id) || theme.id.startsWith(CUSTOM_PREFIX)) return;
      contributed.set(theme.id, { ...theme, plugin });
      if (!previewing && chosenId() === theme.id) applyChosen();
    },
    /** Another window changed the themes. */
    async reload() {
      await loadState();
      if (!previewing) applyChosen();
    },
    current: () => active,
    preference: () => preference,
    /** Every theme: [{ id, name, type, source: "builtin" | "plugin" | "custom", plugin? }] */
    list: () => [
      ...[...builtins.values()].map((th) => ({ id: th.id, name: th.name, type: th.type, source: "builtin" })),
      ...[...contributed.values()].map((th) => ({ id: th.id, name: th.name, type: th.type === "light" ? "light" : "dark", source: "plugin", plugin: th.plugin })),
      ...[...custom.values()].map((th) => ({ id: th.id, name: th.name, type: th.type, source: "custom" })),
    ],
    /** Resolved (complete) theme by id, or null. */
    get: (id) => (find(id) ? resolve(find(id)) : null),
    /** The built-in token list with its values for a type ("dark" | "light"). */
    defaults: (type = "dark") => ({ ...builtins.get(type === "light" ? "light" : "dark").colors }),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Show a theme (an id or a theme object) without saving it; null goes back to the chosen one. */
    preview(theme) {
      if (theme == null) return applyChosen();
      const th = typeof theme === "string" ? find(theme) : theme;
      if (!th) return;
      previewing = true;
      apply(th);
    },
    /** Choose a theme id (or "auto") and save it. */
    async set(id) {
      if (id !== AUTO && !find(id)) throw new Error(`unknown theme: ${id}`);
      preference = id;
      applyChosen();
      await update((state) => { state.theme = id; });
    },
    /** Save a custom theme { id?, name, type, colors }; returns its id ("custom.<…>"). */
    async saveCustom(theme) {
      const id = theme.id?.startsWith(CUSTOM_PREFIX) ? theme.id : `${CUSTOM_PREFIX}${Date.now().toString(36)}`;
      const saved = { id, name: String(theme.name || id), type: theme.type === "light" ? "light" : "dark", colors: { ...theme.colors } };
      custom.set(id, saved);
      await update((state) => { state.customThemes = { ...state.customThemes, [id]: saved }; });
      if (!previewing && chosenId() === id) applyChosen();
      return id;
    },
    async removeCustom(id) {
      if (!custom.has(id)) return;
      const type = custom.get(id).type;
      custom.delete(id);
      if (preference === id) preference = type;
      await update((state) => {
        const { [id]: _, ...rest } = state.customThemes ?? {};
        state.customThemes = rest;
        if (state.theme === id) state.theme = type;
      });
      if (!previewing) applyChosen();
    },
  };
}
