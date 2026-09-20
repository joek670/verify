// NOT PART OF THE APPLICATION. Deliberately unsafe code, kept so `npm run gate`
// can prove the rules in ../rules.yml still fire. Nothing imports this file, and
// the repo scan excludes this directory. Do not copy anything from here.

import { exec, execSync } from "node:child_process"; // shell-invoking-import
import * as childProcess from "child_process"; // shell-invoking-import

export function lookup(name) {
  exec("echo " + name, () => {}); // shell-from-concatenation
  execSync(`ls ${name}`); // shell-from-concatenation
}

export function lookupIndirectly(name) {
  childProcess.exec("echo " + name, () => {});
}

export function evaluate(expression) {
  eval(expression); // dynamic-code-execution
  return new Function("arg", expression); // dynamic-code-execution
}

export function reply(response) {
  response.writeHead(204); // writehead-without-headers
}
