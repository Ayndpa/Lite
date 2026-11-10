// Icon theme plugin. Swap this plugin for another one providing the same `icons` service
// (e.g. Codicons) to re-skin every plugin that asks for icons by name.

const SVG_NS = "http://www.w3.org/2000/svg";
// icon-nodes.json only has canonical names (no legacy aliases such as "history" -> "rotate-ccw-clock").
const FALLBACK = "circle-question-mark";

export async function activate(ctx) {
  /** name -> [[tag, attrs], ...] */
  const nodes = JSON.parse(await ctx.assets.readText("lucide-icon-nodes.json"));

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

  ctx.services.provide("icons", {
    create,
    has: (name) => name in nodes,
    names: () => Object.keys(nodes),
  });
}
