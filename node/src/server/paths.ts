/** Locate the repo root (the directory containing registry.yaml).
 *
 * Walks up from a start directory so the value stays correct both when
 * running from src (tsx-free dev builds) and from the compiled dist tree.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

export function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "registry.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`repo root (registry.yaml) not found above ${start}`);
    }
    dir = parent;
  }
}
