// Shared SOURCE for right-click menus — not a plugin and not a service. tools/build.mjs bundles a
// private copy into every plugin that imports "@lite/context-menu", so each plugin owns its menus and
// depends on nobody at runtime. Fix bugs here once; rebuild to update every copy.

const STYLE_ID = "lite-context-menu-style";
const CSS = `
.lite-menu {
  position: fixed; z-index: 3000; min-width: 220px; max-width: 360px; padding: 4px;
  background: var(--lite-surface); border: 1px solid var(--lite-border); border-radius: 6px;
  box-shadow: 0 10px 30px var(--lite-shadow); user-select: none;
}
.lite-menu-item {
  display: grid; grid-template-columns: 1fr auto; gap: 24px; width: 100%; padding: 5px 10px;
  border: 0; border-radius: 4px; background: none; color: var(--lite-fg); font: inherit; text-align: left; cursor: pointer;
}
.lite-menu-item:focus { outline: none; background: var(--lite-primary); color: var(--lite-primary-fg); }
.lite-menu-item.danger { color: var(--lite-danger-fg); }
.lite-menu-item.danger:focus { background: var(--lite-danger); color: var(--lite-primary-fg); }
.lite-menu-item:disabled { color: var(--lite-fg-disabled); cursor: default; }
.lite-menu-keys { color: var(--lite-fg-dim); font-size: 12px; }
.lite-menu-item:focus .lite-menu-keys { color: var(--lite-primary-fg-dim); }
.lite-menu-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lite-menu-sep { height: 1px; margin: 4px 6px; background: var(--lite-active); }
`;

/** True while focus sits in a menu — lets e.g. an inline input ignore the blur a menu causes. */
export const isMenuElement = (el) => !!el?.closest?.(".lite-menu");

/**
 * ctx: the plugin's context. at: a MouseEvent or { x, y }.
 * items: [{ label, run, keys?, disabled?, danger? } | { command, args?, label?, … } | "-"]
 * A command item takes its label, shortcut and action from the command, and is disabled when the
 * command doesn't exist (its plugin is off). Focus returns to where it was when the menu closes
 * without running anything.
 */
export function showMenu(ctx, at, items) {
  if (!document.getElementById(STYLE_ID)) {
    document.head.appendChild(Object.assign(document.createElement("style"), { id: STYLE_ID, textContent: CSS }));
  }
  document.querySelector(".lite-menu")?.remove(); // another plugin's open menu
  const returnFocus = document.activeElement;
  const commands = new Map(ctx.commands.list().map((c) => [c.id, c]));
  const el = document.createElement("div");
  el.className = "lite-menu";
  el.setAttribute("role", "menu");
  const buttons = [];

  for (let item of items) {
    if (item === "-") {
      if (el.lastChild && !el.lastChild.classList.contains("lite-menu-sep")) {
        el.appendChild(Object.assign(document.createElement("div"), { className: "lite-menu-sep" }));
      }
      continue;
    }
    if (item.command) {
      const cmd = commands.get(item.command);
      item = {
        label: cmd?.title ?? item.command,
        keys: ctx.keysFor(item.command),
        run: () => ctx.commands.execute(item.command, ...(item.args ?? [])).catch((e) => console.error(e)),
        disabled: !cmd,
        ...item,
      };
    }
    const btn = document.createElement("button");
    btn.className = `lite-menu-item${item.danger ? " danger" : ""}`;
    btn.setAttribute("role", "menuitem");
    btn.disabled = !!item.disabled;
    btn.innerHTML = `<span class="lite-menu-label"></span><span class="lite-menu-keys"></span>`;
    btn.firstChild.textContent = item.label;
    btn.lastChild.textContent = item.keys ?? "";
    const run = item.run;
    btn.onclick = () => { close(false); run?.(); };
    btn.onmouseenter = () => btn.focus({ preventScroll: true });
    el.appendChild(btn);
    if (!btn.disabled) buttons.push(btn);
  }
  if (el.lastChild?.classList.contains("lite-menu-sep")) el.lastChild.remove();

  document.body.appendChild(el);
  // Keep inside the window: flip left/up when it would overflow.
  const { innerWidth: w, innerHeight: h } = window;
  const r = el.getBoundingClientRect();
  const x = at.clientX ?? at.x, y = at.clientY ?? at.y;
  el.style.left = `${Math.max(4, x + r.width > w ? x - r.width : x)}px`;
  el.style.top = `${Math.max(4, y + r.height > h ? y - r.height : y)}px`;

  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === "Escape") close(true);
    else if (e.key === "ArrowDown") buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === "ArrowUp") buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (e.key === "Home") buttons[0]?.focus();
    else if (e.key === "End") buttons.at(-1)?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onOutside = (e) => !el.contains(e.target) && close(false);
  const onDismiss = () => close(false);
  function close(restore) {
    el.remove();
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("wheel", onDismiss, true);
    window.removeEventListener("blur", onDismiss);
    window.removeEventListener("resize", onDismiss);
    if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("mousedown", onOutside, true);
  window.addEventListener("wheel", onDismiss, true);
  window.addEventListener("blur", onDismiss);
  window.addEventListener("resize", onDismiss);
  buttons[0]?.focus({ preventScroll: true });
}

/**
 * Cut / Copy / Paste / Select All for a plain <input> or <textarea> the plugin owns.
 * labels: { cut, copy, paste, selectAll } in the plugin's language.
 */
export function showFieldMenu(ctx, e, field, labels) {
  const hasSelection = field.selectionStart !== field.selectionEnd;
  const editable = !field.readOnly && !field.disabled;
  const exec = (cmd) => { field.focus(); document.execCommand(cmd); };
  showMenu(ctx, e, [
    { label: labels.cut, keys: "Ctrl+X", disabled: !hasSelection || !editable, run: () => exec("cut") },
    { label: labels.copy, keys: "Ctrl+C", disabled: !hasSelection, run: () => exec("copy") },
    {
      label: labels.paste, keys: "Ctrl+V", disabled: !editable,
      run: async () => {
        const text = await navigator.clipboard.readText().catch(() => "");
        field.focus();
        field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      },
    },
    "-",
    { label: labels.selectAll, keys: "Ctrl+A", run: () => { field.focus(); field.select(); } },
  ]);
}

/** Give one field the edit menu: attachFieldMenu(ctx, input, labels). */
export function attachFieldMenu(ctx, field, labels) {
  field.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showFieldMenu(ctx, e, field, labels);
  });
}
