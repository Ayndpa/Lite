// Theme editor: make custom color themes. An editor tab lists every theme token by group with a color
// picker and a text field (any CSS color, rgba(), gradients); every change previews live, Save stores the
// theme in state.json (kernel ctx.theme.saveCustom) and switches to it. Themes can be exported/imported as JSON.
import { attachFieldMenu } from "@lite/context-menu"; // bundled copy: this plugin owns its menus

const h = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

/** Group of a token, by its first segment ("syntax.keyword" -> "syntax"); general UI tokens share groups. */
const GROUPS = [
  ["base", /^(bg|fg|accent|link|logo)(\.|$)/],
  ["surfaces", /^(surface|backdrop|shadow|titlebar|activitybar|sidebar|panel|tabbar|tab|statusbar|badge|scrollbar)(\.|$)/],
  ["states", /^(hover|active|fill|border|list|accent\.subtle)(\.|$)/],
  ["controls", /^(primary|control|input|kbd)(\.|$)/],
  ["status", /^(danger|warning|success|error)(\.|$)/],
  ["git", /^git\./],
  ["diff", /^diff\./],
  ["editor", /^editor\./],
  ["syntax", /^syntax\./],
  ["terminal", /^terminal\./],
];
const groupOf = (token) => (token === "accent.subtle" ? "states" : GROUPS.find(([, re]) => re.test(token))?.[0] ?? "base");

// ---------- color parsing for the native picker (it only speaks #rrggbb) ----------

const probe = document.createElement("span");
/** Any CSS color -> { hex: "#rrggbb", alpha } or null (gradients, var(), invalid). */
function parseColor(value) {
  if (!value || /gradient|var\(/.test(value)) return null;
  probe.style.color = "";
  probe.style.color = value;
  if (!probe.style.color) return null;
  document.body.append(probe);
  const m = getComputedStyle(probe).color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  probe.remove();
  if (!m) return null;
  const hex = `#${[m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, "0")).join("")}`;
  return { hex, alpha: m[4] == null ? 1 : Number(m[4]) };
}
/** Picker hex + the previous alpha -> "#rrggbb" or "rgba(r, g, b, a)". */
function withAlpha(hex, alpha) {
  if (alpha >= 1) return hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export async function activate(ctx) {
  const editor = await ctx.services.get("editor");
  const icons = await ctx.services.get("icons");
  const { t } = ctx;
  const fieldLabels = { cut: t("edit.cut"), copy: t("edit.copy"), paste: t("edit.paste"), selectAll: t("edit.selectAll") };
  let page = null; // { el, draft, dirty } while the tab is open

  /** A draft: { id?, name, type, colors: overrides of the built-in theme of `type` }. */
  function draftFrom(themeId) {
    const th = ctx.theme.get(themeId) ?? ctx.theme.current();
    const custom = th.id?.startsWith("custom.");
    const base = ctx.theme.defaults(th.type);
    const colors = Object.fromEntries(Object.entries(th.colors).filter(([k, v]) => base[k] !== v));
    return { id: custom ? th.id : undefined, name: custom ? th.name : t("newName", { name: th.name }), type: th.type, colors };
  }

  function open() {
    editor.openPage({
      id: "theme-editor",
      title: t("tab"),
      icon: "palette",
      reload: !page,
      render: (el) => {
        page = { el, draft: draftFrom(ctx.theme.current().id), dirty: false };
        render();
      },
      dispose: () => {
        if (page?.dirty) ctx.theme.preview(null); // unsaved edits were only a preview
        page = null;
      },
    });
  }

  const preview = () => ctx.theme.preview({ id: page.draft.id ?? "draft", ...page.draft });
  const markDirty = () => {
    page.dirty = true;
    page.el.querySelector(".te-save").disabled = false;
    preview();
  };

  function render() {
    const { el, draft } = page;
    const base = ctx.theme.defaults(draft.type);
    el.replaceChildren();
    const root = h("div", "te");

    // ----- header: name, type, start from, actions -----
    const head = h("div", "te-head");
    const title = h("h2", null, t("title"));
    const name = h("input", "te-input te-name");
    name.value = draft.name;
    name.placeholder = t("name");
    name.oninput = () => { draft.name = name.value; markDirty(); };
    attachFieldMenu(ctx, name, fieldLabels);

    const type = h("select", "te-input");
    for (const v of ["dark", "light"]) type.append(Object.assign(h("option", null, t(`type.${v}`)), { value: v }));
    type.value = draft.type;
    type.title = t("type.hint");
    type.onchange = () => { draft.type = type.value; markDirty(); render(); };

    const from = h("select", "te-input");
    from.append(Object.assign(h("option", null, t("startFrom")), { value: "", disabled: true, selected: true }));
    for (const th of ctx.theme.list()) from.append(Object.assign(h("option", null, th.name), { value: th.id }));
    from.onchange = () => {
      const keepId = draft.id;
      page.draft = { ...draftFrom(from.value), id: keepId };
      if (keepId) page.draft.name = draft.name;
      markDirty();
      render();
    };

    const save = button(t("save"), "te-save primary", async () => {
      if (!draft.name.trim()) draft.name = t("untitled");
      draft.id = await ctx.theme.saveCustom(draft);
      await ctx.theme.set(draft.id);
      page.dirty = false;
      render();
    });
    save.disabled = !page.dirty;
    const actions = h("div", "te-actions");
    actions.append(
      save,
      button(t("export"), "", () => togglePanel("export")),
      button(t("import"), "", () => togglePanel("import")),
    );
    if (draft.id) {
      actions.append(button(t("delete"), "danger", async () => {
        if (!confirm(t("deleteConfirm", { name: draft.name }))) return;
        await ctx.theme.removeCustom(draft.id);
        page.draft = draftFrom(ctx.theme.current().id);
        page.dirty = false;
        render();
      }));
    }
    const row = h("div", "te-row");
    row.append(name, type, from);
    head.append(title, row, actions);

    const panel = h("div", "te-panel");
    panel.hidden = true;

    // ----- filter + tokens -----
    const filter = h("input", "te-input te-filter");
    filter.placeholder = t("filter");
    attachFieldMenu(ctx, filter, fieldLabels);
    const list = h("div", "te-list");
    const rows = [];
    let group = null;
    for (const token of Object.keys(base)) {
      const g = groupOf(token);
      if (g !== group) {
        group = g;
        const gh = h("h3", "te-group", t(`group.${g}`));
        gh.dataset.group = g;
        list.append(gh);
      }
      const r = tokenRow(token, base[token]);
      r.dataset.group = g;
      rows.push(r);
      list.append(r);
    }
    filter.oninput = () => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rows) r.hidden = !!q && !r.dataset.token.includes(q);
      for (const gh of list.querySelectorAll(".te-group")) gh.hidden = !rows.some((r) => !r.hidden && r.dataset.group === gh.dataset.group);
    };

    root.append(head, panel, filter, list);
    el.append(root);

    function togglePanel(kind) {
      if (!panel.hidden && panel.dataset.kind === kind) return (panel.hidden = true);
      panel.dataset.kind = kind;
      panel.hidden = false;
      panel.replaceChildren();
      const text = h("textarea", "te-input te-json");
      text.spellcheck = false;
      attachFieldMenu(ctx, text, fieldLabels);
      const msg = h("span", "te-msg");
      const bar = h("div", "te-panel-bar");
      if (kind === "export") {
        text.value = JSON.stringify({ name: draft.name, type: draft.type, colors: draft.colors }, null, 2);
        text.readOnly = true;
        bar.append(button(t("copy"), "", async () => {
          await navigator.clipboard.writeText(text.value);
          msg.textContent = t("copied");
        }), msg);
      } else {
        text.placeholder = t("importHint");
        bar.append(button(t("importApply"), "primary", () => {
          try {
            const th = JSON.parse(text.value);
            if (!th || typeof th.colors !== "object") throw new Error(t("importBadShape"));
            const known = ctx.theme.defaults("dark");
            page.draft = {
              id: draft.id,
              name: String(th.name ?? draft.name),
              type: th.type === "light" ? "light" : "dark",
              colors: Object.fromEntries(Object.entries(th.colors).filter(([k, v]) => k in known && typeof v === "string")),
            };
            markDirty();
            render();
          } catch (e) {
            msg.textContent = t("importFailed", { error: e.message });
          }
        }), msg);
      }
      panel.append(text, bar);
      text.focus();
    }

    function tokenRow(token, baseValue) {
      const r = h("div", "te-token");
      r.dataset.token = token.toLowerCase();
      const value = () => draft.colors[token] ?? baseValue;
      const swatch = h("label", "te-swatch");
      const picker = h("input");
      picker.type = "color";
      swatch.append(picker);
      const text = h("input", "te-input te-value");
      text.spellcheck = false;
      attachFieldMenu(ctx, text, fieldLabels);
      const reset = h("button", "te-reset");
      reset.title = t("reset");
      reset.append(icons.create("rotate-ccw", { size: 14 }));
      const sync = () => {
        const v = value();
        const parsed = parseColor(v);
        swatch.style.setProperty("--te-color", v);
        picker.disabled = !parsed;
        if (parsed) picker.value = parsed.hex;
        if (document.activeElement !== text) text.value = v;
        text.classList.remove("invalid");
        const changed = token in draft.colors;
        r.classList.toggle("changed", changed);
        reset.hidden = !changed;
      };
      const set = (v) => {
        if (v === baseValue) delete draft.colors[token];
        else draft.colors[token] = v;
        sync();
        markDirty();
      };
      picker.oninput = () => set(withAlpha(picker.value, parseColor(value())?.alpha ?? 1));
      text.oninput = () => {
        const v = text.value.trim();
        // Accept anything CSS takes as a background (colors, gradients); flag the rest without applying it.
        probe.style.background = "";
        probe.style.background = v;
        if (!v || !probe.style.background) return text.classList.add("invalid");
        set(v);
      };
      text.onblur = sync;
      reset.onclick = () => set(baseValue);
      const label = h("span", "te-token-name", token);
      label.title = cssVarName(token);
      r.append(swatch, label, text, reset);
      sync();
      return r;
    }
  }

  const cssVarName = (token) => ctx.theme.cssVar(token);

  function button(label, cls, onclick) {
    const b = h("button", `te-btn ${cls}`.trim(), label);
    b.onclick = () => Promise.resolve(onclick()).catch((e) => alert(String(e)));
    return b;
  }

  ctx.commands.register("theme.customize", "%cmd.customize%", open);
  // A theme switch from elsewhere (the picker, another window) while the editor is open and clean:
  // follow it, so the editor always starts from what is on screen.
  ctx.theme.onChange((th) => {
    if (page && !page.dirty && th.id !== "draft" && th.id !== page.draft.id) {
      page.draft = draftFrom(th.id);
      render();
    }
  });
}
