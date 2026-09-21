// Write one settings document per bench arm, differing only in the model row.
//
//   node bench/make-settings.mjs
//
// Why a whole document per arm rather than a config override: overriding
// `agent-default-model` in a patch overlay does not change the model. The
// settings file is applied at runtime and wins. What works is pointing the
// `settings` row's `path` at a different document — `path ?? join(resolveDshHome
// (config.dshHome), ...)` in @deepseek-ai/dsh-settings-file, so an explicit
// `path` beats the default.
//
// The copies are written under $DSH_HOME, never into this repo: settings.yaml is
// the user's live configuration and does not belong in a public tree. It carries
// no secret — the OpenRouter key is referenced by env var name (`apiKeyEnv`) and
// never written out — but that is a reason not to need it here, not a reason to
// copy it in.
//
// The live document is read and rewritten rather than templated so every arm
// inherits whatever else is configured today. Only the three lines under
// `agent-default-model` differ.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME, ".dsh");
const SOURCE = join(DSH_HOME, "settings.yaml");
const OUT_DIR = join(DSH_HOME, "bench-settings");

// The arm name is what `--model` is passed on the runner, and what lands in every
// result record. Keep it short; the model id is what it means.
const ARMS = {
  glm: { provider: "openrouter", model: "z-ai/glm-5.3-flash" },
  flash: { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" },
};

const source = readFileSync(SOURCE, "utf8");
const eol = source.includes("\r\n") ? "\r\n" : "\n";

// Match the whole `agent-default-model:` block: the key, then every following
// indented line. Replacing the block rather than the `model:` line alone is what
// keeps `provider:` consistent with it — an arm pointing a DeepSeek model at the
// OpenRouter route would fail at the first call, late and confusingly.
const BLOCK = /^agent-default-model:[ \t]*\r?\n(?:[ \t]+.*\r?\n?)*/m;
if (!BLOCK.test(source)) {
  console.error(`No agent-default-model block in ${SOURCE}; nothing to swap.`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

// Kept once, so a run that behaved oddly can be compared against the document the
// arms were derived from rather than against whatever settings.yaml says later.
copyFileSync(SOURCE, join(OUT_DIR, "settings.source.yaml"));

for (const [arm, { provider, model }] of Object.entries(ARMS)) {
  const block = [
    "agent-default-model:",
    `  provider: ${provider}`,
    `  model: ${model}`,
    // Held constant across arms, as in the 2026-09-20 note: the comparison is
    // between models, not between effort levels.
    "  reasoningEffort: max",
    "",
  ].join(eol);
  const out = join(OUT_DIR, `${arm}.yaml`);
  writeFileSync(out, source.replace(BLOCK, block));
  console.log(`${arm.padEnd(6)} ${model}  ->  ${out}`);
}

console.log(
  `\nOverlays in bench/overlays/ point the settings row at these files.` +
    `\nConfirm the swap from the session log's request/context event, not the model's` +
    `\nself-report: the persona prefix injects the configured name either way.`,
);
