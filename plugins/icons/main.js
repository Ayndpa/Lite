// Icon theme plugin. Swap this plugin for another one providing the same `icons` service
// (e.g. Codicons) to re-skin every plugin that asks for icons by name.
//
// Two sets: UI icons from Lucide (monochrome, inline <svg>, follow currentColor) and file/folder icons
// from Material Icon Theme (colored, <img> per SVG file so the browser loads and caches each one lazily).

const SVG_NS = "http://www.w3.org/2000/svg";
// icon-nodes.json only has canonical names (no legacy aliases such as "history" -> "rotate-ccw-clock").
const FALLBACK = "circle-question-mark";

export async function activate(ctx) {
  /** name -> [[tag, attrs], ...] */
  const [nodes, theme] = await Promise.all(
    ["lucide-icon-nodes.json", "file-icons.json"].map(async (f) => JSON.parse(await ctx.assets.readText(f))),
  );

  function create(name, { size = 16, strokeWidth = 1.75, className = "" } = {}) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const attrs = {
      xmlns: SVG_NS,
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": strokeWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      class: `icon icon-${name} ${className}`.trim(),
      "aria-hidden": "true",
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    for (const [tag, props] of nodes[name] ?? nodes[FALLBACK]) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
      svg.appendChild(el);
    }
    return svg;
  }

  // ---------- file icons (VS Code icon-theme matching) ----------

  // The theme's keys are mostly lowercase; match case-insensitively like VS Code does.
  const lower = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  const fileNames = lower(theme.fileNames);
  const fileExtensions = lower(theme.fileExtensions);
  const folderNames = lower(theme.folderNames);
  const folderNamesExpanded = lower(theme.folderNamesExpanded);
  const baseName = (path) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

  /** Theme icon id for a file: exact name first, then the longest extension ("a.test.ts" -> "test.ts", "ts"). */
  function fileIconId(path) {
    const name = baseName(path).toLowerCase();
    if (fileNames[name]) return fileNames[name];
    for (let i = name.indexOf("."); i !== -1; i = name.indexOf(".", i + 1)) {
      const id = fileExtensions[name.slice(i + 1)];
      if (id) return id;
    }
    return theme.file;
  }

  function folderIconId(path, { open = false, root = false } = {}) {
    if (root) return open ? theme.rootFolderExpanded : theme.rootFolder;
    const name = baseName(path).toLowerCase();
    return (open ? folderNamesExpanded[name] : folderNames[name]) ?? (open ? theme.folderExpanded : theme.folder);
  }

  function img(id, { size = 16, className = "" } = {}) {
    const el = document.createElement("img");
    el.src = ctx.assets.url(`file-icons/${theme.icons[id]}`);
    el.width = el.height = size;
    el.alt = "";
    el.draggable = false;
    el.className = `icon file-icon ${className}`.trim();
    return el;
  }

  ctx.services.provide("icons", {
    create,
    has: (name) => name in nodes,
    names: () => Object.keys(nodes),
    /** Colored icon for a file name or path: icons.file("src/main.rs", { size, className }) -> <img> */
    file: (path, opts) => img(fileIconId(path), opts),
    /** Colored folder icon: icons.folder("node_modules", { open, root, size, className }) -> <img> */
    folder: (path, opts) => img(folderIconId(path, opts), opts),
  });
}
