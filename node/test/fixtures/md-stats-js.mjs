// JS port of skills/md-stats/run.py — same envelope contract, used as the
// script-type fixture so the Node test suite needs no Python interpreter.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

function send(envelope, code = 0) {
  process.stdout.write(JSON.stringify(envelope));
  process.exit(code);
}

let request;
try {
  request = JSON.parse(readFileSync(0, "utf8"));
} catch (err) {
  send(
    {
      status: "error",
      summary: `bad request envelope: ${err}`,
      data: {},
      artifacts: [],
      warnings: [],
    },
    1,
  );
}

const inputs = request.inputs ?? {};
const dryRun = Boolean(request.dry_run ?? true);
const source = path.resolve(String(inputs.source_path));

if (!existsSync(source) || !statSync(source).isFile()) {
  send(
    {
      status: "error",
      summary: `source not found: ${source}`,
      data: {},
      artifacts: [],
      warnings: [],
    },
    1,
  );
}

const text = readFileSync(source, "utf8");
const lines = text.split(/\r?\n/);
const headings = [];
for (const line of lines) {
  const m = /^(#{1,6})\s+(.+)$/.exec(line);
  if (m) headings.push({ level: m[1].length, text: m[2].trim() });
}
const topN = Number(inputs.top_headings ?? 10);
const words = (text.match(/[\w\u4e00-\u9fff]+/g) ?? []).length;

const data = {
  file: source,
  chars: text.length,
  words,
  lines: lines.length,
  heading_count: headings.length,
  headings: headings.slice(0, topN),
};

const artifacts = [];
if (inputs.output_path) {
  const out = path.resolve(String(inputs.output_path));
  if (dryRun) {
    artifacts.push({ path: out, written: false, note: "dry_run: not written" });
  } else {
    mkdirSync(path.dirname(out), { recursive: true });
    const report = [
      `# stats: ${path.basename(source)}`,
      ...headings.slice(0, topN).map((h) => `${"#".repeat(h.level)} ${h.text}`),
      "",
    ].join("\n");
    writeFileSync(out, report, "utf8");
    artifacts.push({ path: out, written: true });
  }
}

send({
  status: "success",
  summary: `${words} words in ${path.basename(source)}`,
  data,
  artifacts,
  warnings: [],
});
