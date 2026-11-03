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

  function setup(): { tracker: AlertTracker; sent: string[]; delivering: { now: boolean }; clock: { ms: number }; state: State; path: string } {
    run += 1;
    const clock = { ms: Date.parse("2026-07-01T00:00:00Z") };
    const path = join(dir.path, `undelivered-${run}.sqlite`);
    const state = new State(path, () => new Date(clock.ms));
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
    return { tracker, sent, delivering, clock, state, path };
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

  it("keeps owing a recovery that didn't arrive, and sends it once when delivery returns", async () => {
    const { tracker, sent, delivering, state } = setup();
    delivering.now = true;
    await tracker.raise("x", "broken");
    delivering.now = false;
    await tracker.clear("x");
    assert.deepEqual(state.listOwedRecoveries().map((owed) => owed.key), ["x"]);
    await tracker.retryOwed();
    assert.equal(sent.length, 1, "still only the problem");
    delivering.now = true;
    await tracker.retryOwed();
    assert.match(sent[1] ?? "", /recovered: broken/);
    assert.equal(state.getAlert("x"), undefined);
    await tracker.retryOwed();
    assert.equal(sent.length, 2, "and only once");
    state.close();
  });

  it("doesn't count a problem that ended as still going on", async () => {
    const { tracker, delivering, state } = setup();
    delivering.now = true;
    await tracker.raise("x", "broken");
    delivering.now = false;
    await tracker.clear("x");
    assert.deepEqual(state.listAlerts(), []);
    state.close();
  });

  it("leaves retries of an owed recovery to retryOwed", async () => {
    const { tracker, sent, delivering, state } = setup();
    delivering.now = true;
    await tracker.raise("x", "broken");
    delivering.now = false;
    await tracker.clear("x");
    delivering.now = true;
    await tracker.clear("x");
    assert.equal(sent.length, 1, "a second clear doesn't send");
    assert.equal(state.listOwedRecoveries().length, 1);
    state.close();
  });

  it("drops an owed recovery when the problem comes back", async () => {
    const { tracker, sent, delivering, state } = setup();
    delivering.now = true;
    await tracker.raise("x", "broken");
    delivering.now = false;
    await tracker.clear("x");
    delivering.now = true;
    await tracker.raise("x", "broken again");
    assert.deepEqual(state.listOwedRecoveries(), []);
    assert.deepEqual(state.listAlerts().map((alert) => alert.key), ["x"]);
    await tracker.retryOwed();
    assert.equal(sent.length, 1, "neither a recovery nor a second start: for the reader it never stopped");
    state.close();
  });

  it("sends an alert raised only once when delivery returns, the way the storage audit raises one", async () => {
    const { tracker, sent, delivering, clock, state } = setup();
    await tracker.raise("stored_frames_damaged", "2 stored frames are damaged");
    clock.ms += 300_000;
    delivering.now = true;
    await tracker.retryOwed();
    assert.deepEqual(sent, ["Time-lapse problem since 2026-07-01T00:00:00.000Z: 2 stored frames are damaged"]);
    await tracker.retryOwed();
    assert.equal(sent.length, 1, "and only once");
    state.close();
  });

  it("keeps a problem that came back while its recovery was on the way", async () => {
    const { state, clock } = setup();
    let reraise: (() => Promise<void>) | undefined;
    const sent: string[] = [];
    const tracker = new AlertTracker(
      state,
      async (text) => {
        sent.push(text);
        // Another process raises it again while this recovery is being sent.
        await reraise?.();
        return true;
      },
      24,
      () => new Date(clock.ms),
    );
    await tracker.raise("x", "broken");
    const other = new AlertTracker(state, async () => true, 24, () => new Date(clock.ms));
    reraise = async () => {
      reraise = undefined;
      await other.raise("x", "broken again");
    };
    await tracker.clear("x");
    assert.equal(state.getAlert("x")?.detail, "broken again");
    assert.deepEqual(state.listAlerts().map((alert) => alert.key), ["x"]);
    state.close();
  });

  it("survives a restart still owing a recovery", async () => {
    const { tracker, sent, delivering, clock, state, path } = setup();
    delivering.now = true;
    await tracker.raise("x", "broken");
    delivering.now = false;
    await tracker.clear("x");
    state.close();
    const reopened = new State(path, () => new Date(clock.ms));
    await new AlertTracker(reopened, async (text) => {
      sent.push(text);
      return true;
    }, 24, () => new Date(clock.ms)).retryOwed();
    assert.match(sent[1] ?? "", /recovered: broken/);
    assert.equal(reopened.getAlert("x"), undefined);
    reopened.close();
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

  it("doesn't make the next alert wait out the same failure in front of a capture", async () => {
    const clock = { ms: 1_000_000 };
    const attempts: string[] = [];
    const delivering = { now: false };
    const notify = createNotifier(route, () => {}, async (_to, text) => {
      attempts.push(text);
      if (!delivering.now) throw new TelegramDeliveryError("the gateway didn't answer in time");
    }, () => clock.ms);
    assert.equal(await notify("first"), false);
    assert.equal(await notify("second"), false);
    assert.deepEqual(attempts, ["first"], "the second alert owes a retry, but doesn't wait");
    clock.ms += 119_000;
    assert.equal(await notify("third"), false);
    assert.equal(attempts.length, 1, "still the same slot's failure");
    clock.ms += 1_000;
    assert.equal(await notify("fourth"), false);
    assert.deepEqual(attempts, ["first", "fourth"], "the next slot tries again");
    clock.ms += 120_000;
    delivering.now = true;
    assert.equal(await notify("fifth"), true);
    assert.deepEqual(attempts, ["first", "fourth", "fifth"]);
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
