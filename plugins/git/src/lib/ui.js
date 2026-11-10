// Small UI pieces the git plugin owns: confirmation / message dialogs, a quick-pick list, and an
// input box. Plain DOM, styled in style.css.

export const h = (tag, className, text) =>
  Object.assign(document.createElement(tag), className ? { className } : {}, text != null ? { textContent: text } : {});

function modal(build) {
  return new Promise((resolve) => {
    const backdrop = h("div", "git-modal-backdrop");
    const box = h("div", "git-modal");
    backdrop.append(box);
    const done = (value) => {
      backdrop.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      done(null);
    };
    backdrop.addEventListener("mousedown", (e) => e.target === backdrop && done(null));
    window.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    build(box, done);
  });
}

/** buttons: [{ label, value, primary?, danger? }]; resolves the value (null on Esc). */
export function confirm({ title, body, buttons }) {
  return modal((box, done) => {
    box.append(h("h3", null, title));
    if (body) box.append(h("p", "git-modal-body", body));
    const actions = h("div", "git-modal-actions");
    for (const b of buttons) {
      const btn = h("button", `git-btn${b.primary ? " primary" : ""}${b.danger ? " danger" : ""}`, b.label);
      btn.onclick = () => done(b.value);
      actions.append(btn);
    }
    box.append(actions);
    (actions.querySelector(".primary, .danger") ?? actions.firstChild)?.focus();
  });
}

/** Single-line input; resolves the trimmed text or null. validate(text) -> error message | null. */
export function prompt({ title, placeholder = "", value = "", validate = () => null, okLabel }) {
  return modal((box, done) => {
    box.append(h("h3", null, title));
    const input = h("input", "git-input");
    Object.assign(input, { placeholder, value, spellcheck: false });
    const error = h("div", "git-input-error");
    const ok = h("button", "git-btn primary", okLabel);
    const check = () => {
      const msg = input.value.trim() ? validate(input.value.trim()) : "";
      error.textContent = msg ?? "";
      ok.disabled = !input.value.trim() || !!msg;
      return !ok.disabled;
    };
    input.oninput = check;
    input.onkeydown = (e) => e.key === "Enter" && check() && done(input.value.trim());
    ok.onclick = () => check() && done(input.value.trim());
    const actions = h("div", "git-modal-actions");
    actions.append(ok);
    box.append(input, error, actions);
    check();
    input.focus();
    input.select();
  });
}

/** Filterable list. items: [{ label, detail?, value }]; resolves the chosen value or null. */
export function pick({ placeholder, items }) {
  return modal((box, done) => {
    box.classList.add("git-pick");
    const input = h("input", "git-input");
    Object.assign(input, { placeholder, spellcheck: false });
    const list = h("ul", "git-pick-list");
    box.append(input, list);
    let shown = [];
    let sel = 0;
    const render = () => {
      const q = input.value.toLowerCase();
      shown = items.filter((i) => !q || `${i.label} ${i.detail ?? ""}`.toLowerCase().includes(q));
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((item, i) => {
        const li = h("li", i === sel ? "selected" : "");
        li.append(h("span", null, item.label), h("small", null, item.detail ?? ""));
        li.onmousedown = (e) => { e.preventDefault(); done(item.value); };
        return li;
      }));
    };
    input.oninput = () => { sel = 0; render(); };
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown") sel = Math.min(sel + 1, shown.length - 1);
      else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
      else if (e.key === "Enter") return shown[sel] && done(shown[sel].value);
      else return;
      e.preventDefault();
      render();
    };
    render();
    input.focus();
  });
}
