// NOT PART OF THE APPLICATION. The safe counterpart to bad.js: the same four
// shapes written the way they should be. `npm run gate` asserts the rules find
// nothing here, which is what keeps them from being noise.

import { execFile } from "node:child_process";
import { securityHeaders } from "./headers.js";

// Argument arrays never reach a shell, so there is nothing to quote or escape.
export function lookup(name) {
  execFile("echo", [name], () => {});
}

// A lookup table instead of evaluated text.
const OPERATIONS = { double: (n) => n * 2, negate: (n) => -n };

export function evaluate(operation, value) {
  const fn = Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : null;
  return fn ? fn(value) : null;
}

export function reply(response) {
  response.writeHead(204, securityHeaders);
}
