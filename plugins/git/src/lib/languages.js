// Extension -> [language, GitHub linguist colour]. Ported from git-insight's languages.rs.
const TABLE = {
  rs: ["Rust", 0xdea584], toml: ["TOML", 0x9c4221], py: ["Python", 0x3572a5],
  js: ["JavaScript", 0xf1e05a], jsx: ["JavaScript", 0xf1e05a], mjs: ["JavaScript", 0xf1e05a], cjs: ["JavaScript", 0xf1e05a],
  ts: ["TypeScript", 0x3178c6], tsx: ["TypeScript", 0x3178c6], c: ["C", 0x555555], h: ["C", 0x555555],
  cpp: ["C++", 0xf34b7d], cc: ["C++", 0xf34b7d], cxx: ["C++", 0xf34b7d], hpp: ["C++", 0xf34b7d], cs: ["C#", 0x178600],
  go: ["Go", 0x00add8], java: ["Java", 0xb07219], kt: ["Kotlin", 0xa97bff], kts: ["Kotlin", 0xa97bff],
  swift: ["Swift", 0xf05138], scala: ["Scala", 0xc22d40], rb: ["Ruby", 0x701516], php: ["PHP", 0x4f5d95],
  lua: ["Lua", 0x000080], r: ["R", 0x198ce7], dart: ["Dart", 0x00b4ab], jl: ["Julia", 0xa270ba], hs: ["Haskell", 0x5e5086],
  zig: ["Zig", 0xec915c], m: ["MATLAB", 0xe16737], sh: ["Shell", 0x89e051], bash: ["Shell", 0x89e051], zsh: ["Shell", 0x89e051],
  ps1: ["PowerShell", 0x012456], css: ["CSS", 0x663399], scss: ["SCSS", 0xc6538c], html: ["HTML", 0xe34c26], htm: ["HTML", 0xe34c26],
  vue: ["Vue", 0x41b883], svelte: ["Svelte", 0xff3e00], md: ["Markdown", 0x083fa1], markdown: ["Markdown", 0x083fa1],
  sql: ["SQL", 0xe38c00], sqlite: ["SQLite", 0xe38c00], dockerfile: ["Dockerfile", 0x384d54], yml: ["YAML", 0xcb171e],
  yaml: ["YAML", 0xcb171e], json: ["JSON", 0x292929], xml: ["XML", 0x0060ac], txt: ["Text", 0x606060],
  conf: ["Config", 0x8a8a8a], cfg: ["Config", 0x8a8a8a], ini: ["Config", 0x8a8a8a], gitignore: ["GitIgnore", 0x606060],
  svg: ["SVG", 0xff9900], proto: ["Protobuf", 0x4285f4], graphql: ["GraphQL", 0xe10098], gql: ["GraphQL", 0xe10098],
  ex: ["Elixir", 0x6e4a7e], exs: ["Elixir", 0x6e4a7e], erl: ["Erlang", 0xb83998], clj: ["Clojure", 0xdb5855],
  nim: ["Nim", 0xffc200], nix: ["Nix", 0x7ebaa4],
};
// Not worth counting (binary or generated); git grep -I already skips true binaries.
const SKIP = new Set("png jpg jpeg gif webp ico bmp woff woff2 ttf eot exe dll so dylib o a lib class jar zip gz tar 7z rar lock pdf mp3 mp4 mov vsix pdb wasm bin dat pyc pyo rlib rmeta".split(" "));

/** -> { name, color: "#rrggbb" } ; unknown extensions become "Text (ext)" like git-insight. */
export function detectLanguage(fileName) {
  const lower = fileName.toLowerCase();
  const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return { name: "Dockerfile", color: hex(0x384d54) };
  if (lower.endsWith(".gitignore")) return { name: "GitIgnore", color: hex(0x606060) };
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  if (!ext) return { name: "Text", color: hex(0x606060) };
  const hit = TABLE[ext];
  return hit ? { name: hit[0], color: hex(hit[1]) } : { name: `Text (${ext})`, color: hex(0x606060) };
}

export const skipFile = (path) => SKIP.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());

/** Very dark linguist colours (C, JSON, Lua…) are invisible on a dark theme: lift their lightness. */
export function readableOnDark(hex) {
  const n = parseInt(hex.slice(1), 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum >= 90) return hex;
  const k = 90 / Math.max(lum, 1);
  [r, g, b] = [r, g, b].map((v) => Math.min(255, Math.round(v * k + 40)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** [{ path, lines }] -> { languages: [{ name, color, files, lines, fileList }], totalFiles, totalLines, topFiles } */
export function summarize(counts) {
  const groups = new Map();
  const files = [];
  let totalLines = 0;
  for (const f of counts) {
    if (skipFile(f.path)) continue;
    const { name, color } = detectLanguage(f.path.slice(f.path.lastIndexOf("/") + 1));
    const c = readableOnDark(color);
    totalLines += f.lines;
    files.push({ ...f, color: c, language: name });
    const g = groups.get(name) ?? { name, color: c, files: 0, lines: 0, fileList: [] };
    g.files++;
    g.lines += f.lines;
    g.fileList.push(f);
    groups.set(name, g);
  }
  const byLines = (a, b) => b.lines - a.lines || (a.name ?? a.path).localeCompare(b.name ?? b.path);
  const languages = [...groups.values()].sort(byLines);
  for (const g of languages) g.fileList.sort(byLines);
  return { languages, totalFiles: files.length, totalLines, topFiles: files.sort(byLines).slice(0, 100) };
}
