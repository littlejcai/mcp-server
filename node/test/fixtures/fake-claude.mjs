// Fake `claude -p --output-format json` fixture: emulates the headless CLI
// contract so AgentRunner tests run as real processes without mocks.
// Usage: node fake-claude.mjs <variant>
//   success (default) — writes the result file AND echoes {"result": "..."}
//   no-file           — stdout only (exercises the result-file fallback)
//   fenced            — result text wraps the envelope in a fenced block
//   fail              — exits 3 with a credential-looking stderr line
//   slow              — sleeps far beyond any test timeout
import { readFileSync, writeFileSync } from "node:fs";

const variant = process.argv[2] ?? "success";

if (variant === "fail") {
  process.stderr.write("boom sk-abcdefghijklmnop here\n");
  process.exit(3);
}
if (variant === "slow") {
  readFileSync(0); // consume stdin so the parent's EPIPE guard stays quiet
  setTimeout(() => process.exit(0), 30_000);
}

const prompt = readFileSync(0, "utf8");
const match = /to (\S+) using the Write tool\./.exec(prompt);
const resultPath = match?.[1];

const envelope = {
  status: "success",
  summary: "值得写",
  data: { verdict: "strong", argv: process.argv.slice(2) },
  artifacts: [],
  warnings: [],
};

const envelopeJson = JSON.stringify(envelope);
if (resultPath && variant !== "no-file") {
  writeFileSync(resultPath, envelopeJson, "utf8");
}

const resultText =
  variant === "fenced"
    ? `分析完成。\n\`\`\`json\n${envelopeJson}\n\`\`\`\n谢谢`
    : envelopeJson;
process.stdout.write(JSON.stringify({ result: resultText }));
