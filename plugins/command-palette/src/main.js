import { attachFieldMenu, isMenuElement } from "@lite/context-menu"; // bundled copy: this plugin owns its menus

export function activate(ctx) {
  ctx.slots.contribute("root", (host) => {
    host.innerHTML = `
      <div class="cp-backdrop" hidden>
        <div class="cp">
          <input class="cp-input" spellcheck="false" />
          <ul class="cp-list"></ul>
        </div>
      </div>`;
    const backdrop = host.querySelector(".cp-backdrop");
    const input = host.querySelector(".cp-input");
    const list = host.querySelector(".cp-list");
    input.placeholder = ctx.t("placeholder");
    let items = [];
    let selected = 0;

    function render() {
      const q = input.value.toLowerCase();
      items = ctx.commands
        .list()
        .filter((c) => c.id !== "commandPalette.show")
        // Match the UI-language title, the English title and the id, so "保存" and "save" both work.
        .filter((c) => !q || [c.title, c.titleEn, c.id].some((s) => s?.toLowerCase().includes(q)))
        .sort((a, b) => a.title.localeCompare(b.title));
      selected = Math.min(selected, Math.max(items.length - 1, 0));
      list.innerHTML = "";
      items.forEach((c, i) => {
        const li = document.createElement("li");
        li.className = i === selected ? "selected" : "";
        li.innerHTML = `<span></span><small></small>`;
        li.firstChild.textContent = c.title;
        li.lastChild.textContent = c.plugin;
        li.onmousedown = (e) => { e.preventDefault(); run(i); };
        list.appendChild(li);
      });
      if (!items.length) list.appendChild(Object.assign(document.createElement("li"), { className: "empty", textContent: ctx.t("empty") }));
    }

    function open() {
      backdrop.hidden = false;
      input.value = "";
      selected = 0;
      render();
      input.focus();
    }
    const close = () => (backdrop.hidden = true);

    function run(i) {
      const c = items[i];
      close();
      if (c) ctx.commands.execute(c.id).catch((e) => console.error(e));
    }

    input.oninput = () => { selected = 0; render(); };
    // Losing focus closes the palette — except to the input's own right-click menu.
    input.onblur = (e) => !isMenuElement(e.relatedTarget) && close();
    backdrop.onmousedown = (e) => e.target === backdrop && close();
    attachFieldMenu(ctx, input, { cut: ctx.t("edit.cut"), copy: ctx.t("edit.copy"), paste: ctx.t("edit.paste"), selectAll: ctx.t("edit.selectAll") });
    input.onkeydown = (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter") run(selected);
      else if (e.key === "ArrowDown") { selected = Math.min(selected + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { selected = Math.max(selected - 1, 0); render(); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    };

    ctx.commands.register("commandPalette.show", "%cmd.show%", open);
    ctx.keybindings.bind("ctrl+shift+p", "commandPalette.show");
    ctx.keybindings.bind("f1", "commandPalette.show");
    ctx.watermark.addHint("commandPalette.show", "%hint.show%");
    ctx.menubar.add("view", [{ command: "commandPalette.show" }], { order: 0 });
  });

  // Search box in the middle of the kernel's title bar; shows the current shortcut.
  ctx.slots.contribute("titlebar.center", (host) => {
    const box = Object.assign(document.createElement("button"), { className: "cp-search" });
    box.append(Object.assign(document.createElement("span"), { textContent: ctx.t("search") }), document.createElement("kbd"));
    const showKeys = () => (box.querySelector("kbd").textContent = ctx.keysFor("commandPalette.show"));
    showKeys();
    ctx.events.on("keybindings.changed", showKeys);
    box.onclick = () => ctx.commands.execute("commandPalette.show");
    // Optional: the magnifier only when an icon theme is installed.
    ctx.services.get("icons").then((icons) => box.prepend(icons.create("search", { size: 14 })));
    host.append(box);
  });
}
