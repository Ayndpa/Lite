// Side-by-side diff tab (loaded on first use). CodeMirror's MergeView with the editor's own look.
import { MergeView } from "@codemirror/merge";

/**
 * el: the tab's element. left/right: { label, text }. extensions: editor.viewerExtensions() + language.
 * Returns dispose().
 */
export function mountDiff(el, { left, right, extensions, binaryLabel }) {
  el.classList.add("git-diff");
  const header = document.createElement("div");
  header.className = "git-diff-header";
  for (const side of [left, right]) header.append(Object.assign(document.createElement("div"), { textContent: side.label }));
  el.append(header);
  if (left.binary || right.binary) {
    el.append(Object.assign(document.createElement("div"), { className: "git-diff-binary", textContent: binaryLabel }));
    return () => {};
  }
  const body = document.createElement("div");
  body.className = "git-diff-body lite-thin-scroll";
  el.append(body);
  const view = new MergeView({
    a: { doc: left.text, extensions },
    b: { doc: right.text, extensions },
    parent: body,
    gutter: true,
    highlightChanges: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  });
  // Start at the first change.
  requestAnimationFrame(() => {
    const first = body.querySelector(".cm-changedLine, .cm-deletedChunk");
    first?.scrollIntoView({ block: "center" });
  });
  return () => view.destroy();
}
