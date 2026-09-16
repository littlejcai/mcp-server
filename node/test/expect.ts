/** Minimal vitest-compatible expect() shim on top of node:test.
 *
 * The vitest runner pathologically stalls on this heavily loaded machine
 * (load average 60+ on 8 cores), so the suite runs with `tsx --test` instead;
 * only the assertion surface used by these tests is implemented.
 */

import { strict as assert } from "node:assert";
import {
  after as afterAll,
  before as beforeAll,
  beforeEach,
  describe,
  it,
} from "node:test";

export { afterAll, beforeAll, beforeEach, describe, it };

type AnyCtor = { new (...args: never[]): unknown };

interface AnyMarker {
  __anyCtor: AnyCtor;
}

function isAnyMarker(value: unknown): value is AnyMarker {
  return (
    value !== null &&
    typeof value === "object" &&
    "__anyCtor" in (value as Record<string, unknown>)
  );
}

function deepEqual(actual: unknown, expected: unknown): boolean {
  if (isAnyMarker(expected)) {
    // vitest's expect.any matches primitives by typeof, not instanceof
    const ctor = expected.__anyCtor;
    if (ctor === String) return typeof actual === "string";
    if (ctor === Number) return typeof actual === "number";
    if (ctor === Boolean) return typeof actual === "boolean";
    return actual instanceof ctor;
  }
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== typeof expected) return false;
  if (actual === null || expected === null) return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(actual)) {
    const other = expected as unknown[];
    return (
      actual.length === other.length &&
      actual.every((v, i) => deepEqual(v, other[i]))
    );
  }
  if (typeof actual === "object") {
    const a = actual as Record<string, unknown>;
    const b = expected as Record<string, unknown>;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function deepMatch(actual: unknown, expected: unknown): boolean {
  if (isAnyMarker(expected)) {
    return actual instanceof expected.__anyCtor;
  }
  if (
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual)
  ) {
    return Object.entries(expected).every(([k, v]) =>
      deepMatch((actual as Record<string, unknown>)[k], v),
    );
  }
  return deepEqual(actual, expected);
}

function fmt(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function makeMatchers(actual: unknown, negated = false, allowNot = true) {
  const check = (ok: boolean, message: string): void => {
    if (negated ? ok : !ok) {
      throw new assert.AssertionError({ message });
    }
  };
  const wrap = (fn: () => boolean, label: string): void => {
    let ok = false;
    let failure: unknown;
    try {
      ok = fn();
    } catch (err) {
      failure = err;
    }
    check(ok, `${label}${failure ? ` (${String(failure)})` : ""}`);
  };

  const matchers = {
    toBe(expected: unknown): void {
      check(Object.is(actual, expected), `expected ${fmt(actual)} to be ${fmt(expected)}`);
    },
    toEqual(expected: unknown): void {
      wrap(() => deepEqual(actual, expected), `expected ${fmt(actual)} to equal ${fmt(expected)}`);
    },
    toMatchObject(expected: unknown): void {
      wrap(
        () => deepMatch(actual, expected),
        `expected ${fmt(actual)} to match ${fmt(expected)}`,
      );
    },
    toContain(expected: string | unknown): void {
      const ok =
        typeof actual === "string"
          ? actual.includes(expected as string)
          : Array.isArray(actual) && actual.includes(expected);
      check(ok, `expected ${fmt(actual)} to contain ${fmt(expected)}`);
    },
    toMatch(pattern: RegExp | string): void {
      const ok =
        pattern instanceof RegExp
          ? pattern.test(String(actual))
          : String(actual).includes(pattern);
      check(ok, `expected ${fmt(actual)} to match ${String(pattern)}`);
    },
    toBeTruthy(): void {
      check(Boolean(actual), `expected ${fmt(actual)} to be truthy`);
    },
    toBeFalsy(): void {
      check(!actual, `expected ${fmt(actual)} to be falsy`);
    },
    toBeUndefined(): void {
      check(actual === undefined, `expected ${fmt(actual)} to be undefined`);
    },
    toBeDefined(): void {
      check(actual !== undefined, `expected value to be defined`);
    },
    toBeGreaterThan(expected: number): void {
      check(
        typeof actual === "number" && actual > expected,
        `expected ${fmt(actual)} to be greater than ${expected}`,
      );
    },
    toBeInstanceOf(ctor: AnyCtor): void {
      check(actual instanceof ctor, `expected value to be instance of ${String(ctor)}`);
    },
    toThrow(expected?: RegExp | string): void {
      let err: unknown;
      let threw = false;
      try {
        (actual as () => unknown)();
      } catch (caught) {
        err = caught;
        threw = true;
      }
      const message = err instanceof Error ? err.message : String(err ?? "");
      const ok =
        threw &&
        (expected === undefined ||
          (expected instanceof RegExp ? expected.test(message) : message.includes(expected)));
      check(ok, `expected function to throw ${String(expected ?? "")}, got ${message || "nothing"}`);
    },
    rejects: {
      async toThrow(expected?: RegExp | string): Promise<void> {
        let err: unknown;
        try {
          await (actual as Promise<unknown>);
        } catch (caught) {
          err = caught;
        }
        if (err === undefined) {
          check(false, "expected promise to reject, but it resolved");
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        const ok =
          expected === undefined ||
          (expected instanceof RegExp ? expected.test(message) : message.includes(expected));
        check(ok, `expected rejection to match ${String(expected ?? "")}, got ${message}`);
      },
      async toBeInstanceOf(ctor: AnyCtor): Promise<void> {
        let err: unknown;
        try {
          await (actual as Promise<unknown>);
        } catch (caught) {
          err = caught;
        }
        check(err instanceof ctor, `expected rejection to be instance of ${String(ctor)}`);
      },
    },
  };
  const out = matchers as typeof matchers & { not: ReturnType<typeof makeMatchers> };
  if (allowNot) out.not = makeMatchers(actual, !negated, false);
  return out;
}

export function expect(actual: unknown) {
  return makeMatchers(actual);
}

expect.any = (ctor: AnyCtor): AnyMarker => ({ __anyCtor: ctor });
