// Keyboard shortcut editor. No dependencies: it lives on the kernel's root slot so it also works
// on the empty background, which is exactly when a broken shortcut hurts most.
import { attachFieldMenu } from "@lite/context-menu"; // bundled copy: this plugin owns its menus

export function activate(ctx) {
  const { t } = ctx;
  const kb = ctx.keybindings;
  let overlay, list, search;
  let recording = null; // { command, combo, row }

  function keycaps(combo) {
    const el = document.createElement("span");
    el.className = "ks-keys";
    for (const k of kb.format(combo)) el.appendChild(Object.assign(document.createElement("kbd"), { textContent: k }));
    return el;
  }

  /** combo -> [command titles] for in-app conflicts */
  function usage(entries) {
    const map = new Map();
    for (const e of entries) for (const c of e.keys) map.set(c, [...(map.get(c) ?? []), e]);
    return map;
  }

  function warningsFor(combo, entry, used) {
    const out = [];
    if (kb.isTaken(combo)) out.push(t("warning.taken"));
    const others = (used.get(combo) ?? []).filter((e) => e.command !== entry.command);
    if (others.length) out.push(t("warning.alsoBound", { commands: others.map((e) => e.title).join(t("list.separator")) }));
    return out;
  }

  function render() {
    if (!overlay || overlay.hidden) return;
    const q = search.value.trim().toLowerCase();
    const entries = kb.list().sort((a, b) => a.title.localeCompare(b.title));
    const used = usage(entries);
    list.replaceChildren();

    for (const entry of entries) {
      const keyText = entry.keys.map((k) => kb.format(k).join("+")).join(" ");
      if (q && !`${entry.title} ${entry.titleEn} ${entry.command} ${keyText}`.toLowerCase().includes(q)) continue;

      const row = document.createElement("div");
      row.className = "ks-row";
      row.innerHTML = `
        <div class="ks-command"><span class="ks-title"></span><small></small></div>
        <div class="ks-bindings"></div>
        <div class="ks-source"></div>
        <div class="ks-actions"></div>`;
      row.querySelector(".ks-title").textContent = entry.title;
      row.querySelector("small").textContent = entry.command;
      row.querySelector(".ks-source").textContent = entry.custom ? t("source.user") : entry.keys.length ? t("source.default") : "";

      const bindings = row.querySelector(".ks-bindings");
      if (recording?.command === entry.command) {
        bindings.appendChild(recorderView());
      } else if (!entry.keys.length) {
        bindings.append(Object.assign(document.createElement("span"), { className: "ks-none", textContent: "—" }));
      }
      for (const combo of recording?.command === entry.command ? [] : entry.keys) {
        const line = document.createElement("div");
        line.className = "ks-binding";
        line.appendChild(keycaps(combo));
        for (const w of warningsFor(combo, entry, used)) {
          line.appendChild(Object.assign(document.createElement("span"), { className: "ks-warning", textContent: w }));
        }
        bindings.appendChild(line);
      }

      const actions = row.querySelector(".ks-actions");
      const action = (label, fn) => {
        const b = Object.assign(document.createElement("button"), { className: "ks-btn", textContent: label });
        b.onclick = fn;
        actions.appendChild(b);
      };
      if (recording?.command === entry.command) {
        action(t("action.save"), saveRecording);
        action(t("action.cancel"), cancelRecording);
      } else {
        action(t(entry.keys.length ? "action.change" : "action.add"), () => startRecording(entry.command));
        if (entry.keys.length) action(t("action.remove"), () => kb.set(entry.command, []));
        if (entry.custom) action(t("action.reset"), () => kb.reset(entry.command));
      }
      list.appendChild(row);
    }
  }

  // ---------- recording ----------

  function recorderView() {
    const el = document.createElement("div");
    el.className = "ks-recorder";
    if (recording.combo) {
      el.appendChild(keycaps(recording.combo));
      const used = usage(kb.list());
      for (const w of warningsFor(recording.combo, { command: recording.command }, used)) {
        el.appendChild(Object.assign(document.createElement("span"), { className: "ks-warning", textContent: w }));
      }
      if (recording.taken && !kb.isTaken(recording.combo)) el.appendChild(Object.assign(document.createElement("span"), { className: "ks-warning", textContent: t("warning.takenShort") }));
      el.appendChild(Object.assign(document.createElement("span"), { className: "ks-hint", textContent: t("recorder.confirm") }));
    } else {
      el.appendChild(Object.assign(document.createElement("span"), { className: "ks-hint", textContent: t("recorder.prompt") }));
    }
    return el;
  }

  function startRecording(command) {
    recording = { command, combo: null, taken: false };
    render();
  }
  function cancelRecording() {
    recording = null;
    render();
  }
  async function saveRecording() {
    const { command, combo } = recording ?? {};
    recording = null;
    if (combo) await kb.set(command, [combo]); // emits keybindings.changed -> render
    else render();
  }

  // Capture phase: runs before the kernel's dispatcher, so recorded keys never trigger commands.
  window.addEventListener(
    "keydown",
    async (e) => {
      if (!recording) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
      if (plain && e.key === "Escape") return cancelRecording();
      if (plain && e.key === "Enter") return recording.combo ? saveRecording() : undefined;
      const combo = kb.fromEvent(e);
      if (!combo) return; // bare modifier: wait for the key
      recording.combo = combo;
      recording.taken = (await kb.check([combo]))[combo] === true;
      render();
    },
    true,
  );

  // ---------- panel ----------

  ctx.slots.contribute("root", (host) => {
    host.innerHTML = `
      <div class="ks-overlay" hidden>
        <div class="ks-panel">
          <header>
            <span class="ks-heading"></span>
            <input class="ks-search" spellcheck="false" />
            <button class="ks-btn ks-close"></button>
          </header>
          <div class="ks-list"></div>
        </div>
      </div>`;
    overlay = host.querySelector(".ks-overlay");
    list = host.querySelector(".ks-list");
    search = host.querySelector(".ks-search");
    host.querySelector(".ks-heading").textContent = t("heading");
    host.querySelector(".ks-close").textContent = t("close");
    search.placeholder = t("search");
    attachFieldMenu(ctx, search, { cut: t("edit.cut"), copy: t("edit.copy"), paste: t("edit.paste"), selectAll: t("edit.selectAll") });
    search.oninput = render;
    host.querySelector(".ks-close").onclick = close;
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.hidden && !recording) close();
    });
  });

  function open() {
    overlay.hidden = false;
    search.value = "";
    render();
    search.focus();
  }
  function close() {
    recording = null;
    overlay.hidden = true;
  }

  ctx.events.on("keybindings.changed", render);
  ctx.commands.register("keybindings.open", "%cmd.open%", open);
  ctx.keybindings.bind("ctrl+,", "keybindings.open");
  ctx.menubar.add("file", [{ command: "keybindings.open" }], { order: 800 });
  ctx.watermark.addHint("keybindings.open", "%hint.open%");
}
