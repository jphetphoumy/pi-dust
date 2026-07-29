import type * as fs from "fs";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `dust-attachments.ts` imports `readFileSync` by name, so a plain
 * `vi.spyOn(fs, "readFileSync")` cannot intercept it — Node's ESM/CJS interop
 * makes the named export non-configurable. `vi.mock` replaces the whole
 * module before anything imports it, which does work; the module under test
 * is dynamically imported below, after the mock is registered.
 */
const readFileSyncSpy = vi.fn();

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      readFileSyncSpy(...args);
      return actual.readFileSync(...args);
    },
  };
});

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-dust-attach-perf-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  readFileSyncSpy.mockClear();
});

describe("parseUserMessage: image markers never read the file as text", () => {
  // `readTextFile` used to be called unconditionally, with only a 50 MB
  // ceiling — so a 20 MB screenshot marker meant a full `readFileSync(path,
  // "utf8")` plus a byte-for-byte compare, per image marker, per turn, purely
  // to fail. The file here is far too big to fit `text.length - bodyStart`
  // (a handful of characters), so the size pre-check must reject it on a
  // `statSync` alone, without ever calling `readFileSync`.
  it("does not read a large image's bytes off disk as UTF-8", async () => {
    const { parseUserMessage } = await import("../src/dust-attachments.js");
    const bigPath = join(dir, "big-screenshot.png");
    writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024, "x"));

    const text = `<file name="${bigPath}"></file>\nwhat is this`;
    const parsed = parseUserMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: Buffer.from("resized-bytes").toString("base64") },
      ],
    }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(readFileSyncSpy).not.toHaveBeenCalledWith(bigPath, "utf8");
  });

  // A genuine text marker must still be read and verified normally — the
  // pre-check only rejects sizes that could never fit, never a real match.
  it("still reads and verifies a text marker that does fit", async () => {
    const { parseUserMessage } = await import("../src/dust-attachments.js");
    const path = join(dir, "small.ts");
    const content = "y".repeat(5000);
    writeFileSync(path, content, "utf8");
    const text = `<file name="${path}">\n${content}\n</file>\nexplain`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toHaveLength(1);
    expect(readFileSyncSpy).toHaveBeenCalledWith(path, "utf8");
  });

  // The old pre-check compared `size` (UTF-8 *bytes* on disk) against
  // `remainingLength` (UTF-16 *code units* of the message) as if they were the
  // same unit. A file with any multibyte content — e.g. accented characters in
  // comments — has more bytes than UTF-16 units, so the old bound
  // (`size + 9 > remainingLength`) could reject a marker whose *real*
  // necessary bound (`diskContent.length + 9 <= remainingLength`) is
  // satisfied: verification would have succeeded had it been allowed to run.
  // 20 non-ASCII characters ("é", 2 UTF-8 bytes / 1 UTF-16 unit each) added to
  // an otherwise-ASCII 5000-unit file adds 20 bytes of overhead but 0 units —
  // enough to push the old, byte-vs-unit bound past a short suffix's slack
  // while the correct, unit-based bound still clears it easily.
  it("verifies a text marker whose UTF-8 byte length exceeds its UTF-16 length", async () => {
    const { parseUserMessage } = await import("../src/dust-attachments.js");
    const path = join(dir, "multibyte.ts");
    const content = `${"y".repeat(4980)}${"é".repeat(20)}`;
    writeFileSync(path, content, "utf8");
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(content.length);
    const text = `<file name="${path}">\n${content}\n</file>\nexplain`;

    const parsed = parseUserMessage({ role: "user", content: text }, dir);

    expect(parsed.attachments).toHaveLength(1);
  });
});
