// Commit graph (VS Code's "Source Control Graph"): `git log` of HEAD (+ its upstream), laid out in
// lanes and drawn one small SVG per row.

const SVG = "http://www.w3.org/2000/svg";
// Theme colors (CSS variables, so lines follow a theme switch); set as style, since SVG attributes can't take var().
export const LANE_COLORS = ["accent", "git-modified", "success", "syntax-control", "danger-fg", "syntax-type", "syntax-string", "syntax-variable"].map((c) => `var(--lite-${c})`);
const LANE_W = 12;
const ROW_H = 22;

/** -> [{ hash, parents, author, time (ms), refs: [string], subject }] */
export async function readLog(git, { upstream, limit }) {
  // Full ref names tell local branches, remote branches and tags apart (a local "feature/x" has a slash too).
  const args = ["log", "--topo-order", "--decorate=full", `-n${limit}`, "--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s%x1e", "HEAD"];
  if (upstream) args.push(upstream);
  const out = (await git.maybe(args)) ?? "";
  const ref = (s) => {
    s = s.replace(/^HEAD -> /, "");
    if (s.startsWith("tag: refs/tags/")) return { kind: "tag", name: s.slice(15) };
    if (s.startsWith("refs/heads/")) return { kind: "branch", name: s.slice(11) };
    if (s.startsWith("refs/remotes/") && !s.endsWith("/HEAD")) return { kind: "remote", name: s.slice(13) };
    return null; // HEAD itself, refs/stash, …
  };
  return out.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, parents, author, at, refs, subject] = r.split("\0");
    return {
      hash, parents: parents ? parents.split(" ") : [], author, time: Number(at) * 1000, subject,
      refs: refs ? refs.split(", ").map(ref).filter(Boolean) : [],
    };
  });
}

/**
 * Lane layout. Each lane slot holds the hash it is waiting for; slots keep their position (no
 * shifting), so a pass-through line is always vertical.
 * Adds to each commit: { lane, before: [hash|null], after: [hash|null], joins: [laneIdx] (lines into
 * the node from above), forks: [laneIdx] (lines out of the node below) }.
 */
export function layout(commits) {
  let lanes = [];
  for (const c of commits) {
    const before = lanes.slice();
    let lane = lanes.indexOf(c.hash);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.push(null) - 1;
    }
    const joins = [];
    lanes.forEach((h, i) => {
      if (h === c.hash) { joins.push(i); lanes[i] = null; }
    });
    const forks = [];
    c.parents.forEach((p, k) => {
      const existing = lanes.indexOf(p);
      if (existing >= 0) return forks.push(existing); // merges into a line that's already there
      let slot = k === 0 ? lane : lanes.indexOf(null);
      if (slot < 0 || (k > 0 && slot === lane)) slot = lanes.indexOf(null, lane + 1);
      if (slot < 0) slot = lanes.push(null) - 1;
      lanes[slot] = p;
      forks.push(slot);
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    Object.assign(c, { lane, before, after: lanes.slice(), joins, forks });
  }
  return commits;
}

const color = (i) => LANE_COLORS[i % LANE_COLORS.length];
const x = (i) => i * LANE_W + LANE_W / 2;

function line(svg, x1, y1, x2, y2, stroke) {
  const el = document.createElementNS(SVG, "path");
  // Diagonal joins/forks as a soft curve, like VS Code.
  const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
  for (const [k, v] of Object.entries({ d, fill: "none", "stroke-width": 1.6 })) el.setAttribute(k, v);
  el.style.stroke = stroke;
  svg.append(el);
}

/** The graph cell of one row. width: lanes to reserve (the widest row nearby). */
export function rowSvg(c, width, isHead) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", width * LANE_W);
  svg.setAttribute("height", ROW_H);
  svg.classList.add("git-graph-svg");
  const mid = ROW_H / 2;
  // Lines passing by this row.
  c.before.forEach((h, i) => {
    if (h && h !== c.hash && c.after[i] === h) line(svg, x(i), 0, x(i), ROW_H, color(i));
  });
  for (const i of c.joins) line(svg, x(i), 0, x(c.lane), mid, color(i));
  for (const i of c.forks) line(svg, x(c.lane), mid, x(i), ROW_H, color(i === c.lane ? c.lane : i));
  const dot = document.createElementNS(SVG, "circle");
  const merge = c.parents.length > 1;
  for (const [k, v] of Object.entries({ cx: x(c.lane), cy: mid, r: isHead ? 4.5 : merge ? 3 : 3.5 })) dot.setAttribute(k, v);
  dot.style.fill = isHead || merge ? "var(--lite-git-graph-hollow)" : color(c.lane);
  dot.style.stroke = color(c.lane);
  dot.setAttribute("stroke-width", isHead ? 2 : 1.6);
  svg.append(dot);
  return svg;
}

/** Lines only (for rows inserted under a commit, e.g. its expanded file list): the lanes keep going. */
export function passSvg(lanes, width) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", width * LANE_W);
  svg.setAttribute("height", ROW_H);
  svg.classList.add("git-graph-svg");
  lanes.forEach((h, i) => h && line(svg, x(i), 0, x(i), ROW_H, color(i)));
  return svg;
}

/** Files changed by a commit (against its first parent): [{ status, path, orig? }] */
export async function commitFiles(git, commit) {
  const args = commit.parents.length
    ? ["diff", "--no-color", "--no-ext-diff", "-z", "--name-status", "-M", commit.parents[0], commit.hash]
    : ["diff-tree", "-r", "-z", "--root", "--no-commit-id", "--name-status", commit.hash];
  const out = (await git.maybe(args)) ?? "";
  const parts = out.split("\0").filter((s) => s !== "");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i][0];
    if (status === "R" || status === "C") files.push({ status, orig: parts[++i], path: parts[++i] });
    else files.push({ status, path: parts[++i] });
  }
  return files;
}
