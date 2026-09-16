"""md-stats: read a markdown file inside the workspace, produce a stats report.

Contract: JSON request envelope on stdin -> JSON response envelope on stdout.
Demonstrates the script-type skill convention; honors dry_run for the
optional report file.
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    request = json.loads(sys.stdin.read())
    inputs = request.get("inputs", {})
    dry_run = bool(request.get("dry_run", True))

    source = Path(inputs["source_path"])
    if not source.is_file():
        print(json.dumps({
            "status": "error",
            "summary": f"source not found: {source}",
            "data": {},
            "artifacts": [],
            "warnings": [],
        }, ensure_ascii=False))
        return 1

    text = source.read_text(encoding="utf-8")
    lines = text.splitlines()
    headings = [
        (len(m.group(1)), m.group(2).strip())
        for m in (re.match(r"^(#{1,6})\s+(.+)$", line) for line in lines)
        if m
    ]
    top_n = int(inputs.get("top_headings", 10))
    words = len(re.findall(r"[\w\u4e00-\u9fff]+", text))

    data = {
        "file": str(source),
        "chars": len(text),
        "words": words,
        "lines": len(lines),
        "heading_count": len(headings),
        "headings": [
            {"level": level, "text": title}
            for level, title in headings[:top_n]
        ],
    }

    artifacts = []
    output = inputs.get("output_path")
    if output:
        target = Path(output)
        if dry_run:
            artifacts.append({"type": "report", "path": str(target), "note": "dry_run: not written"})
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            report_lines = [f"# md-stats report", "", f"- file: {data['file']}",
                            f"- chars: {data['chars']}", f"- words: {data['words']}",
                            f"- lines: {data['lines']}", f"- headings: {data['heading_count']}", ""]
            target.write_text("\n".join(report_lines), encoding="utf-8")
            artifacts.append({"type": "report", "path": str(target)})

    print(json.dumps({
        "status": "success",
        "summary": f"{data['words']} words, {data['lines']} lines, "
                   f"{data['heading_count']} headings (dry_run={dry_run})",
        "data": data,
        "artifacts": artifacts,
        "warnings": [],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
