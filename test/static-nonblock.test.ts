import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerRequest } from "../src/types.ts";

// `serveStatic` reads a candidate's mode with `stat()` and opens it a syscall
// later, so an attacker who can write into the root can swap a regular file for
// a FIFO in between and `open()` will wait for a writer that never comes. That
// window is too narrow to hit deterministically, so it is reproduced here by
// making every `stat()` report a regular file whatever is really on disk — the
// state the middleware believes it is in after losing the race. `FileHandle.stat()`
// is a method on the returned handle, not this module binding, so the mode check
// inside `openServable` stays honest.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (path: Parameters<typeof actual.stat>[0]) => {
      const stats = await actual.stat(path); // still throws ENOENT for a real miss
      stats.isFile = () => true;
      return stats;
    },
  };
});

const { serveStatic } = await import("../src/static.ts");

let tmp: string;
let dir: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "srvx-nonblock-"));
  dir = join(tmp, "public");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "real.bin"), "REAL");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const fetchStatic = (path: string) =>
  serveStatic({ dir })(
    new Request(`http://localhost${path}`) as unknown as ServerRequest,
    () => new Response("next()", { status: 404 }),
  ) as Promise<Response>;

// `mkfifo` is POSIX-only, and `O_NONBLOCK` does not exist on Windows because
// `open()` cannot block this way there.
describe.skipIf(process.platform === "win32")("open() cannot block on a non-regular file", () => {
  test("the lying stat still serves a genuine regular file", async () => {
    // Guards the mock itself: if this broke, the FIFO test below would pass for
    // the wrong reason.
    const res = await fetchStatic("/real.bin");
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("REAL");
  });

  // `.bin` is incompressible, so no variant probing runs before the open.
  test("declines a FIFO that stat claimed was a regular file", async () => {
    const fifo = join(dir, "swapped.bin");
    execFileSync("mkfifo", [fifo]);
    try {
      // Without O_NONBLOCK this never settles and the test times out.
      const res = await fetchStatic("/swapped.bin");
      expect(res.status).toBe(404);
      await expect(res.text()).resolves.toBe("next()");
    } finally {
      await rm(fifo, { force: true });
    }
  });
});
