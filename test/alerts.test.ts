import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AlertTracker, createNotifier } from "../src/alerts.ts";
import { State } from "../src/state.ts";
import { TelegramDeliveryError } from "../src/telegram.ts";
import type { TelegramRoute } from "../src/telegram.ts";
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
    const tracker = new AlertTracker(state, async (text) => {
      sent.push(text);
      return true;
    }, 24, () => new Date(clock.ms));
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
    const again = new AlertTracker(first.state, async (text) => {
      sent.push(text);
      return true;
    }, 24, () => new Date(first.clock.ms));
    await again.raise("x", "broken");
    assert.deepEqual(sent, []);
    first.state.close();
  });
});

describe("AlertTracker, when a message doesn't arrive", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let run = 0;

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  function setup(): { tracker: AlertTracker; sent: string[]; delivering: { now: boolean }; clock: { ms: number }; state: State } {
    run += 1;
    const clock = { ms: Date.parse("2026-07-01T00:00:00Z") };
    const state = new State(join(dir.path, `undelivered-${run}.sqlite`), () => new Date(clock.ms));
    const sent: string[] = [];
    const delivering = { now: false };
    const tracker = new AlertTracker(
      state,
      async (text) => {
        if (delivering.now) sent.push(text);
        return delivering.now;
      },
      24,
      () => new Date(clock.ms),
    );
    return { tracker, sent, delivering, clock, state };
  }

  it("tries again at the next check, not a day later, and says when the problem began", async () => {
    const { tracker, sent, delivering, clock, state } = setup();
    await tracker.raise("x", "broken");
    clock.ms += 300_000;
    delivering.now = true;
    await tracker.raise("x", "broken");
    assert.deepEqual(sent, ["Time-lapse problem since 2026-07-01T00:00:00.000Z: broken"]);
    state.close();
  });

  it("then goes quiet until the reminder is due", async () => {
    const { tracker, sent, delivering, clock, state } = setup();
    delivering.now = true;
    await tracker.raise("x", "broken");
    clock.ms += 300_000;
    await tracker.raise("x", "broken");
    assert.equal(sent.length, 1);
    state.close();
  });

  it("keeps trying a reminder that didn't arrive", async () => {
    const { tracker, sent, delivering, clock, state } = setup();
    delivering.now = true;
    await tracker.raise("x", "broken");
    delivering.now = false;
    clock.ms += 24 * 3_600_000;
    await tracker.raise("x", "broken");
    clock.ms += 300_000;
    delivering.now = true;
    await tracker.raise("x", "broken");
    assert.equal(sent.length, 2);
    assert.match(sent[1] ?? "", /continues since/);
    state.close();
  });

  it("announces no recovery from a problem nobody heard about", async () => {
    const { tracker, sent, delivering, state } = setup();
    await tracker.raise("x", "broken");
    delivering.now = true;
    await tracker.clear("x");
    assert.deepEqual(sent, []);
    assert.equal(state.getAlert("x"), undefined);
    state.close();
  });

  it("survives a restart still owing the message", async () => {
    const { tracker, sent, delivering, clock, state } = setup();
    await tracker.raise("x", "broken");
    const fresh = new AlertTracker(
      state,
      async (text) => {
        sent.push(text);
        return true;
      },
      24,
      () => new Date(clock.ms),
    );
    delivering.now = true;
    await fresh.raise("x", "broken");
    assert.equal(sent.length, 1);
    state.close();
  });
});

describe("createNotifier", () => {
  const route: TelegramRoute = { botId: "1", chatId: "-2", proxyUrl: "http://x:secret@127.0.0.1:1", ca: "" };

  it("sends to the route, and also logs", async () => {
    const logged: string[] = [];
    const sent: Array<[TelegramRoute, string]> = [];
    const notify = createNotifier(route, (message) => logged.push(message), async (to, text) => {
      sent.push([to, text]);
    });
    assert.equal(await notify("hello"), true);
    assert.deepEqual(sent, [[route, "hello"]]);
    assert.deepEqual(logged, ["ALERT hello"]);
  });

  it("logs a failed delivery, says it wasn't delivered, and doesn't throw", async () => {
    const logged: string[] = [];
    const notify = createNotifier(route, (message) => logged.push(message), async () => {
      throw new TelegramDeliveryError("Telegram answered HTTP 403");
    });
    assert.equal(await notify("hello"), false);
    assert.ok(logged.some((line) => line.includes("HTTP 403") && line.includes("next slot")));
  });

  it("lets a bug propagate", async () => {
    const notify = createNotifier(route, () => {}, async () => {
      throw new RangeError("a bug");
    });
    await assert.rejects(notify("hello"), RangeError);
  });

  it("counts the log as delivery when no route is set", async () => {
    const logged: string[] = [];
    assert.equal(await createNotifier(null, (message) => logged.push(message))("hello"), true);
    assert.deepEqual(logged, ["ALERT hello"]);
  });
});
