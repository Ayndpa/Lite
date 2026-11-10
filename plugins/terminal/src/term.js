// The heavy part (xterm.js + its stylesheet), built to term.js and imported only when the first
// terminal opens — until then the terminal plugin costs next to nothing.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import css from "@xterm/xterm/css/xterm.css";

const STYLE_ID = "lite-xterm-css";

export function createXterm(options) {
  if (!document.getElementById(STYLE_ID)) {
    document.head.appendChild(Object.assign(document.createElement("style"), { id: STYLE_ID, textContent: css }));
  }
  const term = new Terminal(options);
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}
