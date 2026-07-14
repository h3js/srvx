import { describe, it, expect } from "vitest";
import { log, type LogOptions } from "../src/log.ts";

const run = async (options: LogOptions) => {
  const mw = log(options);
  return mw(new Request("http://localhost/test") as any, () => new Response("ok", { status: 200 }));
};

describe("log()", () => {
  it("sends formatted lines to a custom sink", async () => {
    const lines: string[] = [];
    await run({ sink: (line) => lines.push(line), colors: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("GET");
    expect(lines[0]).toContain("http://localhost/test");
    expect(lines[0]).toContain("200");
  });

  it("emits ANSI colors when explicitly enabled", async () => {
    const lines: string[] = [];
    await run({ sink: (line) => lines.push(line), colors: true });
    expect(lines[0]).toContain("\u001B[");
  });

  it("strips colors when disabled", async () => {
    const lines: string[] = [];
    await run({ sink: (line) => lines.push(line), colors: false });
    expect(lines[0]).not.toContain("\u001B[");
  });

  it("honors NO_COLOR for auto color detection", async () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const lines: string[] = [];
      await run({ sink: (line) => lines.push(line) });
      expect(lines[0]).not.toContain("\u001B[");
    } finally {
      if (prev === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prev;
      }
    }
  });
});
