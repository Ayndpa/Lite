// Dev-time build for plugins that use npm packages.
//
// 1. Shared modules: every package in SHARED is bundled into plugins/editor/vendor/<name>.js with the
//    other shared packages left as bare imports. The editor's manifest "modules" maps the bare
//    specifiers to those files, the kernel turns that into an import map, and every plugin gets the
//    same single instance (CodeMirror breaks with two copies of @codemirror/state).
// 2. Plugin sources: each plugins/<id>/src/<name>.js is bundled to plugins/<id>/<name>.js with SHARED
//    external. Language plugins keep their parser in a separate lang.js loaded only when needed.
//    "@lite/context-menu" (tools/shared/) is inlined: every plugin gets its own copy of the menu code.
//
// Outputs are committed; the app itself needs no Node.
import { build } from "esbuild";
import { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const tools = dirname(fileURLToPath(import.meta.url));
const pluginsDir = join(tools, "..", "plugins");
const SHARED = [
  "@codemirror/state", "@codemirror/view", "@codemirror/language", "@codemirror/commands",
  "@codemirror/search", "@codemirror/autocomplete", "@codemirror/lint", "@codemirror/merge",
  "@lezer/common", "@lezer/lr", "@lezer/highlight",
];
const vendorFile = (pkg) => `vendor/${pkg.replace(/^@/, "").replace(/\//g, "-")}.js`;
const common = { bundle: true, format: "esm", minify: true, target: "es2022", logLevel: "warning", legalComments: "none" };
const kb = (file) => `${(statSync(file).size / 1024).toFixed(0)} KB`;

// ---- 1. shared vendor modules (owned by the editor plugin) ----
const editorDir = join(pluginsDir, "editor");
mkdirSync(join(editorDir, "vendor"), { recursive: true });
for (const pkg of SHARED) {
  const outfile = join(editorDir, vendorFile(pkg));
  await build({
    ...common,
    stdin: { contents: `export * from "${pkg}";`, resolveDir: tools, loader: "js" },
    external: SHARED.filter((p) => p !== pkg),
    outfile,
  });
  console.log(`vendor  ${pkg.padEnd(26)} ${kb(outfile)}`);
}
const manifestPath = join(editorDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.modules = Object.fromEntries(SHARED.map((p) => [p, vendorFile(p)]));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// ---- 2. plugin sources ----
for (const id of readdirSync(pluginsDir)) {
  const src = join(pluginsDir, id, "src");
  if (!existsSync(src)) continue;
  for (const file of readdirSync(src).filter((f) => f.endsWith(".js"))) {
    const outfile = join(pluginsDir, id, basename(file));
    await build({
      ...common,
      entryPoints: [join(src, file)],
      external: SHARED,
      outfile,
      nodePaths: [join(tools, "node_modules")],
      // Shared source inlined into each plugin (a private copy, not a runtime dependency).
      alias: { "@lite/context-menu": join(tools, "shared", "context-menu.js") },
      // `import css from "x.css"` gives the stylesheet as a string (injected by the plugin when needed).
      loader: { ".css": "text" },
    });
    console.log(`plugin  ${`${id}/${file}`.padEnd(26)} ${kb(outfile)}`);
  }
}
