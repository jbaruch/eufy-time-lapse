import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AlertTracker, createNotifier } from "../src/alerts.ts";
import { ConfigError } from "../src/config.ts";
import { State } from "../src/state.ts";
import { tempDir } from "./helpers/fixtures.ts";

describe("AlertTracker", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let run = 0;

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  function setup(): { tracker: AlertTracker; sent: string[]; clock: { ms: number }; state: State } {
    run += 1;
    const clock = { ms: Date.parse("2026-07-01T00:00:00Z") };
    const state = new State(join(dir.path, `alerts-${run}.sqlite`), () => new Date(clock.ms));
    const sent: string[] = [];
    const tracker = new AlertTracker(state, async (text) => void sent.push(text), 24, () => new Date(clock.ms));
    return { tracker, sent, clock, state };
  }

  it("sends once when a problem starts, however often it's raised", async () => {
    const { tracker, sent, clock, state } = setup();
    await tracker.raise("x", "broken");
    clock.ms += 3_600_000;
    await tracker.raise("x", "broken");
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /problem: broken/);
    state.close();
  });

  it("reminds at most once per interval", async () => {
    const { tracker, sent, clock, state } = setup();
    await tracker.raise("x", "broken");
    clock.ms += 23 * 3_600_000;
    await tracker.raise("x", "broken");
    assert.equal(sent.length, 1);
    clock.ms += 3_600_000;
    await tracker.raise("x", "broken");
    assert.equal(sent.length, 2);
    assert.match(sent[1] ?? "", /continues since/);
    clock.ms += 3_600_000;
    await tracker.raise("x", "broken");
    assert.equal(sent.length, 2);
    state.close();
  });

  it("sends once on recovery, and nothing when there was no problem", async () => {
    const { tracker, sent, state } = setup();
    await tracker.clear("x");
    assert.equal(sent.length, 0);
    await tracker.raise("x", "broken");
    await tracker.clear("x");
    await tracker.clear("x");
    assert.deepEqual(sent.slice(1), ["Time-lapse recovered: broken"]);
    state.close();
  });

  it("survives a restart without repeating itself", async () => {
    const first = setup();
    await first.tracker.raise("x", "broken");
    const sent: string[] = [];
    const again = new AlertTracker(first.state, async (text) => void sent.push(text), 24, () => new Date(first.clock.ms));
    await again.raise("x", "broken");
    assert.deepEqual(sent, []);
    first.state.close();
  });
});

describe("createNotifier", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let server: Server;
  let received: Array<{ text: string }>;
  let status = 200;

  before(async () => {
    dir = await tempDir();
    received = [];
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        received.push(JSON.parse(body) as { text: string });
        response.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  after(async () => {
    server.close();
    await dir.remove();
  });

  async function urlFile(url: string): Promise<string> {
    const path = join(dir.path, `webhook-${received.length}-${status}`);
    await writeFile(path, `${url}\n`);
    return path;
  }

  it("posts to the webhook", async () => {
    const { port } = server.address() as AddressInfo;
    const notify = createNotifier(await urlFile(`http://127.0.0.1:${port}/hook`), () => {});
    await notify("hello");
    assert.equal(received.at(-1)?.text, "hello");
  });

  it("logs a refused delivery instead of throwing", async () => {
    status = 500;
    const { port } = server.address() as AddressInfo;
    const logged: string[] = [];
    const notify = createNotifier(await urlFile(`http://127.0.0.1:${port}/hook`), (message) => logged.push(message));
    await notify("hello");
    assert.ok(logged.some((line) => line.includes("HTTP 500")));
    status = 200;
  });

  it("logs an unreachable webhook without quoting its URL, which holds a credential", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const logged: string[] = [];
    const notify = createNotifier(await urlFile("https://example.com/secret-token"), (message) => logged.push(message));
    await notify("hello");
    assert.ok(logged.some((line) => line.includes("webhook failed")));
    assert.equal(logged.join("\n").includes("secret-token"), false);
  });

  it("logs a webhook that times out", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const logged: string[] = [];
    await createNotifier(await urlFile("https://example.com/hook"), (message) => logged.push(message))("hello");
    assert.ok(logged.some((line) => line.includes("webhook failed: TimeoutError")));
  });

  for (const bug of [new RangeError("a bug"), new TypeError("x is not a function")]) {
    it(`lets a ${bug.name} that isn't a delivery failure through`, async (t) => {
      t.mock.method(globalThis, "fetch", async () => {
        throw bug;
      });
      await assert.rejects(createNotifier(await urlFile("https://example.com/hook"), () => {})("hello"), bug);
    });
  }

  for (const [name, content] of [["isn't a URL", "secret-token"], ["isn't http", "ftp://example.com/secret-token"], ["is empty", ""]] as const) {
    it(`refuses at startup a webhook file that ${name}, without quoting it`, async () => {
      const path = await urlFile(content);
      assert.throws(() => createNotifier(path, () => {}), (error: Error) => error instanceof ConfigError && /http or https URL/.test(error.message) && !error.message.includes("secret-token"));
    });
  }

  for (const [name, path] of [["missing", join("no", "such", "webhook")], ["a directory", "."]] as const) {
    it(`explains at startup a webhook file that's ${name}`, () => {
      assert.throws(() => createNotifier(path, () => {}), (error: Error) => error instanceof ConfigError && /Can't read the alert webhook/.test(error.message));
    });
  }

  it("lets a bug reading the webhook file through as itself", () => {
    assert.throws(() => createNotifier("a\0b", () => {}), (error: Error) => error instanceof TypeError && !(error instanceof ConfigError));
  });

  it("falls back to the log when no webhook is set", async () => {
    const logged: string[] = [];
    await createNotifier(null, (message) => logged.push(message))("hello");
    assert.deepEqual(logged, ["ALERT hello"]);
  });
});
