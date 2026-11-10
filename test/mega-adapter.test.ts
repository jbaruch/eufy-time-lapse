import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EufyMega, FileSessionStore, LoginStatus, MegaApiError, SessionExpiredError, StationUnreachableError } from "@mega-yfue/eufy-sdk";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import type { AuthChallenge, AuthInput, CleanupResult } from "../src/adapters/adapter.ts";
import { createMegaClient, isProgrammingError, isTrustedDevice, MegaAdapter } from "../src/adapters/mega.ts";
import type { MegaClient, MegaDevice, MegaLiveStream, MegaLoginResult, MegaPositions, SecurityApi } from "../src/adapters/mega.ts";

const SERIAL = "T86P2FULLSERIAL1234";

class FakeStream extends EventEmitter implements MegaLiveStream {
  stops = 0;
  stop(): void {
    this.stops += 1;
    this.emit("stop");
  }
}

function fakeDevice(overrides: Partial<MegaDevice> = {}, stream: MegaLiveStream = new FakeStream()): MegaDevice {
  const properties: Record<string, { value: unknown }> = {
    battery: { value: 66 },
    wifiRssi: { value: -60 },
    cellularSignal: { value: "good" },
    solarIntensity: { value: 3 },
    cellularIMEI: { value: "SECRET-IMEI" },
    cellularICCID: { value: "SECRET-ICCID" },
    motionTracking: { value: true },
  };
  return {
    stationSn: SERIAL,
    camera: () => ({ live: async () => stream }),
    info: () => ({ firmwareVersion: "3.4.5" }),
    getProperty: (name) => properties[name],
    getProperties: () => properties,
    ...overrides,
  };
}

const HELD_SESSION = JSON.stringify({ authToken: "held", tokenExpiresAt: 1_700_000_000 });
const FRESH_SESSION = JSON.stringify({ authToken: "fresh", tokenExpiresAt: 1_702_592_000 });

class FakeClient implements MegaClient {
  loginResults: MegaLoginResult[] = [{ status: "ok" }];
  logins = 0;
  codes: string[] = [];
  captchas: string[] = [];
  devices = [{ sn: SERIAL, model: "T86P2321" }];
  device: MegaDevice = fakeDevice();
  sessions = new Map<string, unknown>();
  disconnects = 0;
  routed: Array<{ serial: string; command: Parameters<MegaClient["routeCommand"]>[1] }> = [];
  onRoute: ((command: Parameters<MegaClient["routeCommand"]>[1]) => void) | undefined;

  async routeCommand(serial: string, command: Parameters<MegaClient["routeCommand"]>[1]): Promise<void> {
    this.routed.push({ serial, command });
    this.onRoute?.(command);
  }

  stuckOpen = false;
  connect: (signal?: AbortSignal) => Promise<void> = async () => {
    this.sessions.set(SERIAL, {});
  };
  listError: Error | undefined;
  loginError: Error | undefined;
  lastSeenMs: number | undefined;
  trustAnswers: string[] = [];
  trustError: Error | undefined;
  trustedNow = false;
  /** What a real client persists once a login completes. */
  sessionFile: string | undefined;

  async login(): Promise<MegaLoginResult> {
    this.logins += 1;
    if (this.loginError !== undefined) throw this.loginError;
    const result = this.loginResults.shift() ?? { status: "ok" };
    if (result.status === "ok") await this.persist();
    return result;
  }
  async submitVerifyCode(code: string): Promise<MegaLoginResult> {
    this.codes.push(code);
    await this.persist();
    return { status: "ok" };
  }
  private async persist(): Promise<void> {
    if (this.sessionFile !== undefined) await writeFile(this.sessionFile, FRESH_SESSION);
  }
  async earnTrust(answer: (challenge: AuthChallenge) => Promise<AuthInput>): Promise<void> {
    if (this.trustError !== undefined) throw this.trustError;
    const input = await answer({ status: "tfa_required" });
    if ("verifyCode" in input) this.trustAnswers.push(input.verifyCode);
    this.trustedNow = true;
  }
  async isTrustedDevice(): Promise<boolean> {
    return this.trustedNow;
  }
  async solveCaptcha(answer: string): Promise<MegaLoginResult> {
    this.captchas.push(answer);
    return { status: "ok" };
  }
  async getDevices(): Promise<Array<{ sn: string; model: string }>> {
    if (this.listError !== undefined) throw this.listError;
    return this.devices;
  }
  async getDevice(): Promise<MegaDevice> {
    return this.device;
  }
  async connectStation(_serial: string, signal?: AbortSignal): Promise<void> {
    await this.connect(signal);
  }
  getP2pSessions(): Map<string, unknown> {
    return this.sessions;
  }
  deviceState(): { lastSeenMs?: number } {
    return this.lastSeenMs === undefined ? {} : { lastSeenMs: this.lastSeenMs };
  }
  async disconnect(): Promise<void> {
    this.disconnects += 1;
    if (!this.stuckOpen) this.sessions.clear();
  }
}

function setup(): { client: FakeClient; adapter: MegaAdapter; warnings: string[]; secrets: string[] } {
  const client = new FakeClient();
  const warnings: string[] = [];
  const secrets: string[] = [];
  const adapter = new MegaAdapter(client, (message) => warnings.push(message), (value) => secrets.push(value));
  return { client, adapter, warnings, secrets };
}

const openSignal = (): AbortSignal => new AbortController().signal;

function abortedWith(cause: string): AbortSignal {
  const controller = new AbortController();
  controller.abort(cause);
  return controller.signal;
}

describe("MegaAdapter authentication", () => {
  it("reports each state the login can land in", async () => {
    const { client, adapter } = setup();
    client.loginResults = [{ status: "2fa" }, { status: "captcha", image: "data:image/png;base64,AAAA" }, { status: "ok" }];
    assert.deepEqual(await adapter.authenticate(), { status: "tfa_required" });
    assert.deepEqual(await adapter.authenticate(), { status: "captcha_required", captchaId: "", captchaImage: "data:image/png;base64,AAAA" });
    assert.deepEqual(await adapter.authenticate(), { status: "authenticated" });
    await adapter.shutdown();
  });

  it("routes a code and a captcha answer to the right call", async () => {
    const { client, adapter } = setup();
    await adapter.authenticate({ verifyCode: "123456" });
    await adapter.authenticate({ captcha: { id: "", code: "abc" } });
    assert.deepEqual(client.codes, ["123456"]);
    assert.deepEqual(client.captchas, ["abc"]);
    assert.equal(client.logins, 0);
    await adapter.shutdown();
  });

  it("turns a cloud rejection into an auth failure that says what to do", async () => {
    const { client, adapter } = setup();
    client.login = async () => {
      throw new MegaApiError("bad password", 100, 200);
    };
    await assert.rejects(adapter.authenticate(), (error: CaptureFailure) => {
      assert.equal(error.reason, "auth_required");
      assert.match(error.message, /login command/);
      return true;
    });
    await adapter.shutdown();
  });
});

describe("MegaAdapter discovery", () => {
  it("finds the camera, reports its firmware, and registers the serial for redaction", async () => {
    const { adapter, secrets } = setup();
    const camera = await adapter.discoverCamera();
    assert.equal(camera.key, SERIAL);
    assert.equal(camera.model, "T86P2321");
    assert.equal(camera.firmware, "3.4.5");
    assert.ok(secrets.includes(SERIAL));
    await adapter.shutdown();
  });

  it("reports the camera's newest report time as the battery's freshest possible age", async () => {
    const { client, adapter } = setup();
    client.lastSeenMs = Date.parse("2026-01-02T03:04:05.000Z");
    const { battery } = await adapter.discoverCamera();
    assert.equal(battery.percent, 66);
    assert.equal(battery.observedAt, "2026-01-02T03:04:05.000Z");
    assert.match(battery.note ?? "", /at least this old/);
    await adapter.shutdown();
  });

  it("doesn't invent an age when the cloud gives no report time", async () => {
    const { adapter } = setup();
    const { battery } = await adapter.discoverCamera();
    assert.equal(battery.percent, 66);
    assert.equal(battery.observedAt, null);
    assert.ok(battery.note !== null);
    await adapter.shutdown();
  });

  it("reports an unknown battery as unknown, never zero", async () => {
    const { client, adapter } = setup();
    client.device = fakeDevice({ getProperty: () => undefined });
    const { battery } = await adapter.discoverCamera();
    assert.equal(battery.percent, null);
    await adapter.shutdown();
  });

  it("keeps the battery's temperature and health", async () => {
    const { adapter, client } = setup();
    const properties: Record<string, { value: unknown }> = { battery: { value: 66 }, batteryTemperature: { value: 11 }, batteryHealth: { value: 99 }, floodlightColorTemperatureValue: { value: 100 } };
    client.device = fakeDevice({ getProperty: (name) => properties[name], getProperties: () => properties });
    const camera = await adapter.discoverCamera();
    assert.equal(camera.telemetry.batteryTemperature, 11);
    assert.equal(camera.telemetry.batteryHealth, 99);
    assert.equal(camera.telemetry.floodlightColorTemperatureValue, undefined, "a light's color is no business of the battery's");
    await adapter.shutdown();
  });

  it("keeps connection telemetry and leaves out the SIM's identifiers", async () => {
    const { adapter } = setup();
    const camera = await adapter.discoverCamera();
    assert.deepEqual(camera.telemetry, { wifiRssi: -60, cellularSignal: "good", solarIntensity: 3 });
    assert.doesNotMatch(JSON.stringify(camera), /SECRET-/);
    await adapter.shutdown();
  });

  it("names what the account can see, and how to fix a share", async () => {
    const { client, adapter } = setup();
    client.devices = [{ sn: "OTHER", model: "T8160" }];
    await assert.rejects(adapter.discoverCamera(), (error: CaptureFailure) => {
      assert.equal(error.reason, "camera_not_found");
      assert.match(error.message, /T8160/);
      assert.match(error.message, /accept the invitation/);
      return true;
    });
    await adapter.shutdown();
  });

  it("refuses to guess between two cameras, and honors an explicit serial", async () => {
    const { client, adapter } = setup();
    client.devices = [
      { sn: SERIAL, model: "T86P2321" },
      { sn: "T86P2OTHER", model: "T86P2321" },
    ];
    await assert.rejects(adapter.discoverCamera(), /EUFY_CAMERA_SERIAL/);
    assert.equal((await adapter.discoverCamera("T86P2OTHER")).key, "T86P2OTHER");
    await adapter.shutdown();
  });

  it("asks for a login when a finished token's replacement needs a person", async () => {
    const { client, adapter } = setup();
    client.listError = new SessionExpiredError("token rejected");
    client.loginResults = [{ status: "2fa" }];
    await assert.rejects(adapter.discoverCamera(), (error: CaptureFailure) => error.reason === "auth_required");
    await adapter.shutdown();
  });

  it("asks for a login when Eufy refuses a finished token's replacement", async () => {
    const { client, adapter } = setup();
    client.listError = new SessionExpiredError("token rejected");
    client.loginError = new MegaApiError("wrong password", 26006, 401);
    await assert.rejects(adapter.discoverCamera(), (error: CaptureFailure) => error.reason === "auth_required");
    await adapter.shutdown();
  });

  it("carries on by itself when a finished token's replacement works", async () => {
    const { client, adapter } = setup();
    client.listError = new SessionExpiredError("token rejected");
    await assert.rejects(adapter.discoverCamera(), (error: CaptureFailure) => error.reason === "camera_unreachable" && /logging in again worked/.test(error.message));
    assert.equal(client.logins, 1);
    client.listError = undefined;
    assert.equal((await adapter.discoverCamera()).key, SERIAL);
    await adapter.shutdown();
  });

  it("doesn't stop captures for an outage during a finished token's replacement", async () => {
    const { client, adapter } = setup();
    client.listError = new SessionExpiredError("token rejected");
    client.loginError = new TypeError("fetch failed");
    await assert.rejects(adapter.discoverCamera(), (error: CaptureFailure) => error.reason === "camera_unreachable");
    await adapter.shutdown();
  });

  it("waits out the SDK's hold-off without spending a login", async () => {
    const { client, adapter } = setup();
    client.listError = new SessionExpiredError("token rejected again", { contended: true, retryAfterMs: 60_000 });
    await assert.rejects(adapter.discoverCamera(), (error: CaptureFailure) => error.reason === "camera_unreachable" && /token rejected again/.test(error.message));
    assert.equal(client.logins, 0);
    await adapter.shutdown();
  });

  it("retries in the slot, not crashes, when a token dies during a connect", async () => {
    const { client, adapter } = setup();
    client.connect = async () => {
      throw new SessionExpiredError("token rejected");
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), (error: CaptureFailure) => error.reason === "camera_unreachable" && error.phase === "connect");
    assert.equal(client.logins, 1);
    await adapter.shutdown();
  });

  it("retries in the slot, not crashes, when a token dies during a stream start", async () => {
    const { client, adapter } = setup();
    client.device = fakeDevice({
      camera: () => ({
        live: async () => {
          throw new SessionExpiredError("token rejected");
        },
      }),
    });
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), (error: CaptureFailure) => error.reason === "camera_unreachable" && error.phase === "stream_start");
    assert.equal(client.logins, 1);
    await adapter.shutdown();
  });
});

describe("MegaAdapter login renewal", () => {
  async function renewalSetup(prepare: (spare: FakeClient) => void = () => {}): Promise<{ adapter: MegaAdapter; spare: FakeClient; warnings: string[]; sessionDir: string; held: () => Promise<string>; leftovers: () => Promise<string[]>; done: () => Promise<void> }> {
    const sessionDir = await mkdtemp(join(tmpdir(), "renewal-test-"));
    await writeFile(join(sessionDir, "eufy-sdk-session.json"), HELD_SESSION);
    const spare = new FakeClient();
    prepare(spare);
    const warnings: string[] = [];
    const adapter = new MegaAdapter(new FakeClient(), (message) => warnings.push(message), () => {}, undefined, {
      sessionDir,
      createClient: (directory) => {
        spare.sessionFile = join(directory, "eufy-sdk-session.json");
        return spare;
      },
    });
    return {
      adapter,
      spare,
      warnings,
      sessionDir,
      held: () => readFile(join(sessionDir, "eufy-sdk-session.json"), "utf8"),
      leftovers: async () => (await readdir(sessionDir)).filter((entry) => entry !== "eufy-sdk-session.json"),
      done: async () => {
        await adapter.shutdown();
        await rm(sessionDir, { recursive: true, force: true });
      },
    };
  }

  it("swaps in a login that needed nobody, and leaves nothing behind", async () => {
    const t = await renewalSetup();
    assert.deepEqual(await t.adapter.renewLogin(), { status: "renewed" });
    assert.equal(await t.held(), FRESH_SESSION);
    assert.deepEqual(await t.leftovers(), []);
    assert.ok(t.spare.disconnects >= 1);
    await t.done();
  });

  it("leaves the held login alone when Eufy wants a code and nobody is there", async () => {
    const t = await renewalSetup((spare) => {
      spare.loginResults = [{ status: "2fa" }];
    });
    assert.deepEqual(await t.adapter.renewLogin(), { status: "needs_person" });
    assert.equal(await t.held(), HELD_SESSION);
    assert.deepEqual(await t.leftovers(), []);
    await t.done();
  });

  it("reports an outage without touching the held login", async () => {
    const t = await renewalSetup((spare) => {
      spare.loginError = new TypeError("fetch failed");
    });
    await assert.rejects(t.adapter.renewLogin(), (error: CaptureFailure) => error.reason === "camera_unreachable");
    assert.equal(await t.held(), HELD_SESSION);
    assert.deepEqual(await t.leftovers(), []);
    await t.done();
  });

  it("reports a refusal without touching the held login", async () => {
    const t = await renewalSetup((spare) => {
      spare.loginError = new MegaApiError("wrong password", 26006, 401);
    });
    await assert.rejects(t.adapter.renewLogin(), (error: CaptureFailure) => error.reason === "auth_required");
    assert.equal(await t.held(), HELD_SESSION);
    await t.done();
  });

  it("clears out a renewal a crash left behind, token and all", async () => {
    const t = await renewalSetup();
    await mkdir(join(t.sessionDir, "renewal-abandoned"));
    await writeFile(join(t.sessionDir, "renewal-abandoned", "eufy-sdk-session.json"), FRESH_SESSION);
    await t.adapter.renewLogin();
    assert.deepEqual(await t.leftovers(), []);
    await t.done();
  });

  it("reads when the login ends from the SDK's own stored session", async () => {
    const t = await renewalSetup();
    new FileSessionStore(join(t.sessionDir, "eufy-sdk-session.json")).save({ authToken: "x", tokenExpiresAt: 1_700_000_000 } as never);
    assert.equal(t.adapter.loginExpiresAt()?.toISOString(), "2023-11-14T22:13:20.000Z");
    await rm(join(t.sessionDir, "eufy-sdk-session.json"));
    assert.equal(t.adapter.loginExpiresAt(), null);
    await t.done();
  });

  it("knows nothing about expiry without a login store", async () => {
    const { adapter } = setup();
    assert.equal(adapter.loginExpiresAt(), null);
    await adapter.shutdown();
  });
});

describe("MegaAdapter saved positions", () => {
  type Slot = { id: number; raw: Record<string, unknown> };
  const slots = (used: number[]): Slot[] => Array.from({ length: 10 }, (_, id) => ({ id, raw: { index: id, enable: used.includes(id) ? 1 : 0, zoom: 1, isdefault: id === 0 ? 1 : 0 } }));

  function camera(start: number[] = [0, 1, 2]): { calls: string[]; used: number[]; positions: MegaPositions } {
    const used = [...start];
    const calls: string[] = [];
    return {
      calls,
      used,
      positions: {
        list: async () => {
          calls.push("list");
          return slots(used);
        },
        save: async (id) => {
          calls.push(`save ${id}`);
          used.push(id);
        },
        preview: async (id) => {
          calls.push(`preview ${id}`);
        },
        delete: async (id) => {
          calls.push(`delete ${id}`);
          used.splice(used.indexOf(id), 1);
        },
      },
    };
  }

  /** No settling time, or these tests would wait out a camera that isn't there. */
  function withPositions(positions: MegaPositions | undefined, onFatal?: (error: Error) => void): { adapter: MegaAdapter; client: FakeClient; warnings: string[] } {
    const client = new FakeClient();
    const warnings: string[] = [];
    const adapter = new MegaAdapter(client, (message) => warnings.push(message), () => {}, onFatal, undefined, { saveMs: 0, moveMs: 0, settingMs: 0, inPlaceMs: 50 });
    client.device = fakeDevice(positions === undefined ? {} : { ptz: () => ({ preset: () => positions }) });
    return { adapter, client, warnings };
  }

  it("saves in the first empty slot, leaves the others alone, and checks the camera kept it", async () => {
    const c = camera();
    const { adapter } = withPositions(c.positions);
    assert.equal(await adapter.savePosition(SERIAL), 3);
    assert.deepEqual(c.calls, ["list", "save 3", "list"]);
    await adapter.shutdown();
  });

  it("calls a save the camera didn't keep a failure", async () => {
    const c = camera();
    c.positions.save = async () => {};
    const { adapter } = withPositions(c.positions);
    await assert.rejects(adapter.savePosition(SERIAL), (error: CaptureFailure) => error instanceof CaptureFailure && /didn't keep/.test(error.message));
    await adapter.shutdown();
  });

  it("says what to do when every slot is in use, and saves nothing", async () => {
    const c = camera([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const { adapter } = withPositions(c.positions);
    await assert.rejects(adapter.savePosition(SERIAL), /Delete one in the Eufy app/);
    assert.deepEqual(c.calls, ["list"]);
    await adapter.shutdown();
  });

  it("returns to a position that exists", async () => {
    const c = camera([0, 3]);
    const { adapter } = withPositions(c.positions);
    assert.equal(await adapter.prepareFrame(SERIAL, 3), "ready");
    assert.deepEqual(c.calls, ["list", "preview 3"]);
    await adapter.shutdown();
  });

  it("won't go to an empty slot, because that position is gone", async () => {
    const c = camera([0]);
    const { adapter } = withPositions(c.positions);
    assert.equal(await adapter.prepareFrame(SERIAL, 3), "gone");
    assert.deepEqual(c.calls, ["list"]);
    await adapter.shutdown();
  });

  it("deletes only a position that's still there", async () => {
    const c = camera([0, 3]);
    const { adapter } = withPositions(c.positions);
    await adapter.forgetPosition(SERIAL, 3);
    await adapter.forgetPosition(SERIAL, 3);
    assert.deepEqual(c.calls, ["list", "delete 3", "list"]);
    await adapter.shutdown();
  });

  it("closes the connection afterwards, and doesn't count it as an unexpected wake", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    const before = client.disconnects;
    client.sessions.set(SERIAL, {});
    await adapter.resumeTracking(SERIAL);
    assert.ok(client.disconnects > before);
    assert.equal(adapter.unexpectedConnectionCount(), 0);
    await adapter.shutdown();
  });

  it("logs in again before using the camera if it's been closed", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    await adapter.resumeTracking(SERIAL);
    const logins = client.logins;
    await adapter.prepareFrame(SERIAL, 3);
    assert.ok(client.logins > logins);
    await adapter.shutdown();
  });

  it("calls an unreachable camera a capture failure, and still closes up", async () => {
    const c = camera([0, 3]);
    c.positions.list = async () => {
      throw new StationUnreachableError("SN", 45000);
    };
    const { adapter, client } = withPositions(c.positions);
    const before = client.disconnects;
    await assert.rejects(adapter.prepareFrame(SERIAL, 3), (error: CaptureFailure) => error instanceof CaptureFailure && error.reason === "camera_unreachable" && error.phase === "position");
    assert.ok(client.disconnects > before);
    await adapter.shutdown();
  });

  describe("when the reset runs out of time", () => {
    /** Bounded, so a step that never comes fails the test instead of spinning the process forever. */
    const untilTrue = async (done: () => boolean): Promise<void> => {
      for (let turn = 0; !done(); turn += 1) {
        if (turn === 1_000) throw new Error("the reset never got to the step this test waits for");
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    it("says which step never finished, and what the ones before it took", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const c = camera([0, 3]);
      let listed = false;
      c.positions.list = () => {
        listed = true;
        return new Promise(() => {});
      };
      const { adapter, client } = withPositions(c.positions);
      client.connect = async () => {
        t.mock.timers.tick(4_000);
        client.sessions.set(SERIAL, {});
      };
      const reset = assert.rejects(adapter.prepareFrame(SERIAL, 3), { message: "The camera didn't finish with its saved positions within 45 seconds: connecting (4.0 s), turning tracking off (0.0 s), reading its saved positions (41.0 s, unfinished). Trying again is safe, and the unfinished step says whether the connection or the camera was slow." });
      await untilTrue(() => listed);
      t.mock.timers.tick(41_000);
      await reset;
      await adapter.shutdown();
    });

    it("tells a connection that never came up from a camera that didn't answer", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const c = camera([0, 3]);
      const { adapter, client } = withPositions(c.positions);
      let connecting = false;
      client.connect = () => {
        connecting = true;
        return new Promise(() => {});
      };
      const reset = assert.rejects(adapter.prepareFrame(SERIAL, 3), { message: "The camera didn't finish with its saved positions within 45 seconds: connecting (45.0 s, unfinished). Trying again is safe, and the unfinished step says whether the connection or the camera was slow." });
      await untilTrue(() => connecting);
      t.mock.timers.tick(45_000);
      await reset;
      assert.deepEqual(c.calls, [], "nothing was asked of a camera it never reached");
      await adapter.shutdown();
    });

    it("leaves the steps out of the message for work that names none", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const { adapter, client } = withPositions(camera([0, 3]).positions);
      let routed = false;
      client.routeCommand = () => {
        routed = true;
        return new Promise(() => {});
      };
      const resume = assert.rejects(adapter.resumeTracking(SERIAL), { message: "The camera didn't finish with its saved positions within 45 seconds. Trying again is safe." });
      await untilTrue(() => routed);
      t.mock.timers.tick(45_000);
      await resume;
      await adapter.shutdown();
    });

    it("stops the connection at the deadline, and asks nothing of a camera it reaches late", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const c = camera([0, 3]);
      const fatal: Error[] = [];
      const { adapter, client } = withPositions(c.positions, (error) => fatal.push(error));
      let comeUp: (() => void) | undefined;
      let stopped = false;
      client.connect = (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            stopped = true;
          });
          comeUp = () => {
            client.sessions.set(SERIAL, {});
            resolve();
          };
        });
      const reset = assert.rejects(adapter.prepareFrame(SERIAL, 3), /connecting \(45\.0 s, unfinished\)/);
      await untilTrue(() => comeUp !== undefined);
      t.mock.timers.tick(45_000);
      await reset;
      assert.equal(stopped, true, "the connection was told to stop");
      // As an SDK that ignored the abort would.
      comeUp?.();
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(client.routed, [], "tracking left alone");
      assert.deepEqual(c.calls, [], "no list, and no move");
      assert.deepEqual(fatal, []);
      await adapter.shutdown();
    });

    it("doesn't let a tracking-off answer that lands after its deadline undo what a retry did since", async (t) => {
      const c = camera([0, 3]);
      const { adapter, client } = withPositions(c.positions);
      const log: string[] = [];
      let lateOff: (() => void) | undefined;
      const route = client.routeCommand.bind(client);
      client.routeCommand = (serial, command) => {
        if (lateOff === undefined) return new Promise((resolve) => (lateOff = () => resolve()));
        client.sessions.set(SERIAL, {});
        if (command.kind === "set-json") log.push(`tracking ${(command.data as { value: number }).value}`);
        return route(serial, command);
      };
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const first = assert.rejects(adapter.prepareFrame(SERIAL, 3), /turning tracking off \(45\.0 s, unfinished\)/);
      await untilTrue(() => lateOff !== undefined);
      t.mock.timers.tick(45_000);
      await first;
      t.mock.timers.reset();
      // The retry: a reset, its frame, and the teardown that turns tracking back on.
      await adapter.prepareFrame(SERIAL, 3);
      await adapter.openLiveSession(SERIAL, new AbortController().signal);
      await adapter.teardown(SERIAL, 5_000);
      lateOff?.();
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      log.length = 0;
      // A frame with no reset before it, as a retry whose reset had no time takes.
      await adapter.openLiveSession(SERIAL, new AbortController().signal);
      assert.deepEqual(log, ["tracking 0"], "it still knows tracking was turned back on, so it turns it off for this frame");
      await adapter.teardown(SERIAL, 5_000);
      await adapter.shutdown();
    });

    /** A list that answers only when told to, with whatever the camera holds by then. */
    function lateList(c: ReturnType<typeof camera>): { answer: () => void; asked: () => boolean } {
      let resolveList: ((value: Slot[]) => void) | undefined;
      c.positions.list = () =>
        new Promise((resolve) => {
          resolveList = resolve;
        });
      return { answer: () => resolveList?.(slots(c.used)), asked: () => resolveList !== undefined };
    }

    it("says trying again is safe for a deletion cut short, and doesn't delete on a list that answers late", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const c = camera([0, 3]);
      const late = lateList(c);
      const { adapter } = withPositions(c.positions);
      const forget = assert.rejects(adapter.forgetPosition(SERIAL, 3), { message: "The camera didn't finish with its saved positions within 90 seconds: reading its saved positions (90.0 s, unfinished). Trying again is safe." });
      await untilTrue(late.asked);
      t.mock.timers.tick(90_000);
      await forget;
      late.answer();
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(c.calls, [], "the position the caller was told is still there stays there");
      await adapter.shutdown();
    });

    it("doesn't save on a list that answers late with a free slot", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const c = camera([0, 1, 2]);
      const late = lateList(c);
      const { adapter } = withPositions(c.positions);
      const save = assert.rejects(adapter.savePosition(SERIAL), /reading its saved positions \(90\.0 s, unfinished\)/);
      await untilTrue(late.asked);
      t.mock.timers.tick(90_000);
      await save;
      late.answer();
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(c.calls, [], "no position saved after the caller was told the save failed");
      await adapter.shutdown();
    });

    it("names the slot a save was stuck on, and says to wait before looking, since it can still land", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const c = camera([0, 1, 2]);
      let sent = false;
      c.positions.save = () => {
        sent = true;
        return new Promise(() => {});
      };
      const { adapter } = withPositions(c.positions);
      const save = assert.rejects(adapter.savePosition(SERIAL), { message: "The camera didn't finish with its saved positions within 90 seconds: reading its saved positions (0.0 s), saving in slot 3 (90.0 s, unfinished). If the steps above got as far as saving, the position may still land in that slot after this message: wait a minute, then delete it in the Eufy app if it's there and unwanted, and only then try again. If they didn't, trying again is safe." });
      await untilTrue(() => sent);
      t.mock.timers.tick(90_000);
      await save;
      await adapter.shutdown();
    });

    it("says a save cut short may have landed, and doesn't crash over the answer arriving late", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const c = camera([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      const fatal: Error[] = [];
      const { adapter } = withPositions(c.positions, (error) => fatal.push(error));
      let answer: (() => void) | undefined;
      c.positions.list = () =>
        new Promise((resolve) => {
          answer = () => {
            // By the time the camera answers, the last free slot has gone.
            c.used.push(9);
            resolve(slots(c.used));
          };
        });
      const save = assert.rejects(adapter.savePosition(SERIAL), { message: "The camera didn't finish with its saved positions within 90 seconds: reading its saved positions (90.0 s, unfinished). If the steps above got as far as saving, the position may still land in that slot after this message: wait a minute, then delete it in the Eufy app if it's there and unwanted, and only then try again. If they didn't, trying again is safe." });
      await untilTrue(() => answer !== undefined);
      t.mock.timers.tick(90_000);
      await save;
      answer?.();
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(fatal, [], "every slot in use is an answer, not a bug");
      await adapter.shutdown();
    });

    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    const late: Array<[string, Error, boolean]> = [
      ["a bug", new TypeError("positions is not iterable"), true],
      ["the camera's connection going", new StationUnreachableError("SN", 45000), false],
      ["an outcome the work reports on purpose", new CaptureFailure("camera_unreachable", "position", "Every saved-position slot on the camera is in use."), false],
      ["a login that ran out", new SessionExpiredError("token rejected"), false],
      ["the SDK stopping as told", aborted, false],
    ];
    for (const [name, error, surfaces] of late) {
      it(`${surfaces ? "still surfaces" : "doesn't count"} ${name} that lands after the deadline`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
        const c = camera([0, 3]);
        let fail: ((reason: Error) => void) | undefined;
        c.positions.list = () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          });
        const fatal: Error[] = [];
        const { adapter } = withPositions(c.positions, (reported) => fatal.push(reported));
        const reset = assert.rejects(adapter.prepareFrame(SERIAL, 3), /reading its saved positions \(45\.0 s, unfinished\)/);
        await untilTrue(() => fail !== undefined);
        t.mock.timers.tick(45_000);
        await reset;
        fail?.(error);
        for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(fatal, surfaces ? [error] : []);
        await adapter.shutdown();
      });
    }
  });

  for (const message of ["timeout waiting for p2p control query 6034 reply from SN", "timeout waiting for p2p query 12 reply from SN", "P2P session SN is not connected", "P2P session closed before connecting for station SN", "P2P connect timeout for SN (relay: list)", "P2P session start superseded for SN"]) {
    it(`calls "${message}" a capture failure, because the camera just didn't answer`, async () => {
      const c = camera([0, 3]);
      c.positions.list = async () => {
        throw new Error(message);
      };
      const { adapter, client } = withPositions(c.positions);
      const before = client.disconnects;
      await assert.rejects(adapter.prepareFrame(SERIAL, 3), (error: CaptureFailure) => error instanceof CaptureFailure && error.reason === "camera_unreachable" && error.phase === "position");
      assert.ok(client.disconnects > before);
      await adapter.shutdown();
    });

    it(`calls "${message}" a capture failure when turning tracking back on too`, async () => {
      const c = camera([0, 3]);
      const { adapter, client } = withPositions(c.positions);
      client.onRoute = () => {
        throw new Error(message);
      };
      await assert.rejects(adapter.resumeTracking(SERIAL), (error: CaptureFailure) => error instanceof CaptureFailure && error.reason === "camera_unreachable");
      await adapter.shutdown();
    });
  }

  for (const code of ["ERR_SOCKET_DGRAM_NOT_RUNNING", "ERR_SOCKET_CLOSED"]) {
    it(`calls a socket closed under a command (${code}) a capture failure, because the connection went away`, async () => {
      const c = camera([0, 3]);
      const { adapter, client } = withPositions(c.positions);
      // What the SDK did on 2026-11-03 at 09:00: it sent on a session whose socket had already closed.
      client.onRoute = () => {
        throw Object.assign(new Error("Not running"), { code });
      };
      await assert.rejects(adapter.resumeTracking(SERIAL), (error: CaptureFailure) => error instanceof CaptureFailure && error.reason === "camera_unreachable" && error.phase === "position");
      await adapter.shutdown();
    });
  }

  it("lets a plain error that isn't about the camera through as itself", async () => {
    const c = camera([0, 3]);
    c.positions.list = async () => {
      throw new Error("something this code doesn't know about");
    };
    const { adapter } = withPositions(c.positions);
    await assert.rejects(adapter.prepareFrame(SERIAL, 3), (error: Error) => !(error instanceof CaptureFailure) && /doesn't know/.test(error.message));
    await adapter.shutdown();
  });

  it("lets a bug through as itself, and still closes up", async () => {
    const c = camera([0, 3]);
    c.positions.preview = async () => {
      throw new TypeError("not a function");
    };
    const { adapter, client } = withPositions(c.positions);
    const before = client.disconnects;
    await assert.rejects(adapter.prepareFrame(SERIAL, 3), TypeError);
    assert.ok(client.disconnects > before);
    await adapter.shutdown();
  });

  it("leaves the connection open after a reset, for the frame that follows", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    client.onRoute = () => client.sessions.set(SERIAL, {});
    const before = client.disconnects;
    await adapter.prepareFrame(SERIAL, 3);
    assert.equal(client.disconnects, before);
    const session = await adapter.openLiveSession(SERIAL, new AbortController().signal);
    assert.equal(session.coldConnection, false);
    await adapter.teardown(SERIAL, 1000);
    assert.ok(client.disconnects > before);
    await adapter.shutdown();
  });

  /** Room to turn tracking back on and still close: the step is skipped when the caller's budget can't fit it. */
  const ROOMY_TEARDOWN_MS = 5_000;
  /** A reset, then the frame on its connection, closed the way a capture closes it. Commands are logged in order with the closes. */
  async function frameAfterReset(adapter: MegaAdapter, client: FakeClient, log: string[]): Promise<CleanupResult> {
    await adapter.prepareFrame(SERIAL, 3);
    await adapter.openLiveSession(SERIAL, new AbortController().signal);
    const disconnect = client.disconnect.bind(client);
    client.disconnect = async () => {
      log.push("close");
      await disconnect();
    };
    return adapter.teardown(SERIAL, ROOMY_TEARDOWN_MS);
  }
  const tracking = (log: string[]) => (command: Parameters<MegaClient["routeCommand"]>[1]): void => {
    if (command.kind === "set-json") log.push(`tracking ${(command.data as { value: number }).value}`);
  };

  it("turns tracking back on over the frame's connection, before closing it, and doesn't connect again for it", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    const log: string[] = [];
    client.onRoute = (command) => {
      client.sessions.set(SERIAL, {});
      tracking(log)(command);
    };
    const cleanup = await frameAfterReset(adapter, client, log);
    assert.equal(cleanup.status, "ok");
    assert.deepEqual(log, ["tracking 0", "tracking 1", "close"]);
    const closes = client.disconnects;
    await adapter.resumeTracking(SERIAL);
    assert.deepEqual(log, ["tracking 0", "tracking 1", "close"], "nothing more sent");
    assert.equal(client.disconnects, closes, "no new connection to close");
    await adapter.shutdown();
  });

  it("leaves tracking alone when closing a frame it didn't turn tracking off for", async () => {
    const { adapter, client } = withPositions(camera([0, 3]).positions);
    await adapter.openLiveSession(SERIAL, new AbortController().signal);
    await adapter.teardown(SERIAL, 1000);
    assert.deepEqual(client.routed, []);
    await adapter.shutdown();
  });

  it("doesn't turn tracking back on when a reset fails, so the frame still isn't taken mid-chase", async () => {
    const c = camera([0, 3]);
    c.positions.preview = async () => {
      throw new StationUnreachableError("SN", 45000);
    };
    const { adapter, client } = withPositions(c.positions);
    const log: string[] = [];
    client.onRoute = tracking(log);
    await assert.rejects(adapter.prepareFrame(SERIAL, 3), CaptureFailure);
    assert.deepEqual(log, ["tracking 0"]);
    await adapter.shutdown();
  });

  it("connects again for tracking when the frame's connection wouldn't take it", async () => {
    const c = camera([0, 3]);
    const { adapter, client, warnings } = withPositions(c.positions);
    const log: string[] = [];
    let refuse = true;
    client.onRoute = (command) => {
      client.sessions.set(SERIAL, {});
      tracking(log)(command);
      if (command.kind === "set-json" && (command.data as { value: number }).value === 1 && refuse) {
        refuse = false;
        throw Object.assign(new Error("Not running"), { code: "ERR_SOCKET_DGRAM_NOT_RUNNING" });
      }
    };
    const cleanup = await frameAfterReset(adapter, client, log);
    assert.equal(cleanup.status, "ok", "the frame's close is still fine");
    assert.match(warnings.join("\n"), /couldn't take tracking back/);
    const closes = client.disconnects;
    await adapter.resumeTracking(SERIAL);
    assert.deepEqual(log.filter((entry) => entry === "tracking 1").length, 2, "tried again on a new connection");
    assert.ok(client.disconnects > closes);
    await adapter.shutdown();
  });

  /** A reset and its frame, ready to close, with the next "tracking on" command held until the test lets it go. */
  async function frameWithHeldResume(onFatal?: (error: Error) => void): Promise<{ adapter: MegaAdapter; client: FakeClient; warnings: string[]; log: string[]; release: { reject: (error: Error) => void } }> {
    const c = camera([0, 3]);
    const { adapter, client, warnings } = withPositions(c.positions, onFatal);
    const log: string[] = [];
    const release: { reject: (error: Error) => void } = { reject: () => {} };
    let hold = false;
    client.routeCommand = async (serial, command) => {
      client.routed.push({ serial, command });
      client.sessions.set(SERIAL, {});
      tracking(log)(command);
      if (hold && command.kind === "set-json" && (command.data as { value: number }).value === 1) {
        hold = false;
        await new Promise<void>((_resolve, reject) => {
          release.reject = reject;
        });
      }
    };
    await adapter.prepareFrame(SERIAL, 3);
    await adapter.openLiveSession(SERIAL, new AbortController().signal);
    hold = true;
    return { adapter, client, warnings, log, release };
  }
  const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("closes the frame's connection on time when it doesn't answer, and leaves tracking to a new one", async (t) => {
    const { adapter, warnings, log } = await frameWithHeldResume();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const closing = adapter.teardown(SERIAL, ROOMY_TEARDOWN_MS);
    while (!log.includes("tracking 1")) await settled();
    t.mock.timers.tick(50);
    assert.equal((await closing).status, "ok");
    assert.match(warnings.join("\n"), /didn't take tracking back within/);
    t.mock.timers.reset();
    await adapter.resumeTracking(SERIAL);
    assert.equal(log.filter((entry) => entry === "tracking 1").length, 2, "tried again on a new connection");
    await adapter.shutdown();
  });

  it("reports a bug that rejects the frame's command after its time ran out, and nothing else", async (t) => {
    const fatal: Error[] = [];
    const late = await frameWithHeldResume((error) => fatal.push(error));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const closing = late.adapter.teardown(SERIAL, ROOMY_TEARDOWN_MS);
    while (!late.log.includes("tracking 1")) await settled();
    t.mock.timers.tick(50);
    await closing;
    late.release.reject(new TypeError("not a function"));
    await settled();
    assert.equal(fatal.length, 1);
    assert.ok(fatal[0] instanceof TypeError);
    t.mock.timers.reset();
    await late.adapter.shutdown();

    const gone = await frameWithHeldResume((error) => fatal.push(error));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const closingGone = gone.adapter.teardown(SERIAL, ROOMY_TEARDOWN_MS);
    while (!gone.log.includes("tracking 1")) await settled();
    t.mock.timers.tick(50);
    await closingGone;
    gone.release.reject(Object.assign(new Error("Not running"), { code: "ERR_SOCKET_DGRAM_NOT_RUNNING" }));
    await settled();
    assert.equal(fatal.length, 1, "a camera that answered late is no bug");
    t.mock.timers.reset();
    await gone.adapter.shutdown();
  });

  it("doesn't crash when the closed connection's late tracking command comes back superseded, as on 2026-11-06 and 2026-11-07", async (t) => {
    // The SDK's own class, which it doesn't export: a bare Error subclass, told apart only by its message.
    class SessionSupersededError extends Error {}
    const fatal: Error[] = [];
    const late = await frameWithHeldResume((error) => fatal.push(error));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const closing = late.adapter.teardown(SERIAL, ROOMY_TEARDOWN_MS);
    while (!late.log.includes("tracking 1")) await settled();
    t.mock.timers.tick(50);
    await closing;
    late.release.reject(new SessionSupersededError("P2P session start superseded for SN"));
    await settled();
    assert.deepEqual(fatal, [], "a session closed under a waiting command is the teardown's doing, not a bug");
    t.mock.timers.reset();
    await late.adapter.shutdown();
  });

  it("leaves tracking to a new connection when the caller's budget has no room for it before the close", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    const log: string[] = [];
    client.onRoute = (command) => {
      client.sessions.set(SERIAL, {});
      tracking(log)(command);
    };
    await adapter.prepareFrame(SERIAL, 3);
    await adapter.openLiveSession(SERIAL, new AbortController().signal);
    // 1 s can't hold the 50 ms step and still leave room to close.
    assert.equal((await adapter.teardown(SERIAL, 1000)).status, "ok");
    assert.deepEqual(log, ["tracking 0"]);
    await adapter.resumeTracking(SERIAL);
    assert.deepEqual(log, ["tracking 0", "tracking 1"]);
    await adapter.shutdown();
  });

  it("lets a bug in turning tracking back on over the frame's connection through", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    client.onRoute = (command) => {
      client.sessions.set(SERIAL, {});
      if (command.kind === "set-json" && (command.data as { value: number }).value === 1) throw new TypeError("not a function");
    };
    await adapter.prepareFrame(SERIAL, 3);
    await adapter.openLiveSession(SERIAL, new AbortController().signal);
    await assert.rejects(adapter.teardown(SERIAL, ROOMY_TEARDOWN_MS), TypeError);
    await adapter.shutdown();
  });

  it("takes a retry's frame with tracking off when its reset had no time, though the last frame turned it back on", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    const log: string[] = [];
    client.onRoute = (command) => {
      client.sessions.set(SERIAL, {});
      tracking(log)(command);
    };
    await frameAfterReset(adapter, client, log);
    // The retry, straight to the frame.
    await adapter.openLiveSession(SERIAL, new AbortController().signal);
    assert.equal(log.at(-1), "tracking 0", "off over the frame's connection before it streams");
    await adapter.teardown(SERIAL, ROOMY_TEARDOWN_MS);
    assert.deepEqual(log.slice(-3), ["tracking 0", "tracking 1", "close"]);
    await adapter.shutdown();
  });

  it("takes a retry's frame with tracking off when its reset couldn't send that", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    const log: string[] = [];
    client.onRoute = (command) => {
      client.sessions.set(SERIAL, {});
      tracking(log)(command);
    };
    await frameAfterReset(adapter, client, log);
    let failReset = true;
    client.onRoute = (command) => {
      client.sessions.set(SERIAL, {});
      tracking(log)(command);
      if (command.kind === "set-json" && (command.data as { value: number }).value === 0 && failReset) {
        failReset = false;
        throw new StationUnreachableError("SN", 45000);
      }
    };
    await assert.rejects(adapter.prepareFrame(SERIAL, 3), CaptureFailure);
    const before = log.length;
    await adapter.openLiveSession(SERIAL, new AbortController().signal);
    assert.deepEqual(log.slice(before), ["tracking 0"], "sent again over the frame's connection");
    await adapter.shutdown();
  });

  it("still takes the frame when its connection won't turn tracking off, and turns it back on after", async () => {
    const c = camera([0, 3]);
    const { adapter, client, warnings } = withPositions(c.positions);
    const log: string[] = [];
    client.onRoute = (command) => {
      client.sessions.set(SERIAL, {});
      tracking(log)(command);
    };
    await frameAfterReset(adapter, client, log);
    client.onRoute = (command) => {
      client.sessions.set(SERIAL, {});
      tracking(log)(command);
      if (command.kind === "set-json" && (command.data as { value: number }).value === 0) throw new StationUnreachableError("SN", 45000);
    };
    const session = await adapter.openLiveSession(SERIAL, new AbortController().signal);
    assert.ok(session !== undefined);
    assert.match(warnings.join("\n"), /couldn't turn tracking off for this frame/);
    await adapter.teardown(SERIAL, ROOMY_TEARDOWN_MS);
    assert.deepEqual(log.slice(-3), ["tracking 0", "tracking 1", "close"], "back on, since the off may have landed");
    await adapter.shutdown();
  });

  it("doesn't take a new adapter's word that tracking is on, and remembers once it has turned it on", async () => {
    const { adapter, client } = withPositions(camera([0, 3]).positions);
    await adapter.resumeTracking(SERIAL);
    assert.equal(client.routed.length, 1);
    await adapter.resumeTracking(SERIAL);
    assert.equal(client.routed.length, 1, "no second wake for a setting already on");
    await adapter.shutdown();
  });

  it("counts tracking as off from a reset whose command errored, since it may have landed", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    const log: string[] = [];
    client.onRoute = (command) => {
      client.sessions.set(SERIAL, {});
      tracking(log)(command);
    };
    // A first frame leaves tracking on, as far as this adapter knows.
    await frameAfterReset(adapter, client, log);
    client.onRoute = (command) => {
      tracking(log)(command);
      if (command.kind === "set-json" && (command.data as { value: number }).value === 0) throw new StationUnreachableError("SN", 45000);
    };
    await assert.rejects(adapter.prepareFrame(SERIAL, 3), CaptureFailure);
    const before = log.length;
    await adapter.resumeTracking(SERIAL);
    assert.deepEqual(log.slice(before), ["tracking 1", "close"], "it connects to turn tracking back on, rather than trusting the earlier frame");
    await adapter.shutdown();
  });

  it("reports the path the reset's connection took, since the frame stays on it", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    client.onRoute = () => {
      client.sessions.set(SERIAL, {});
      adapter.noteRelayUsed();
    };
    await adapter.prepareFrame(SERIAL, 3);
    assert.equal((await adapter.openLiveSession(SERIAL, new AbortController().signal)).connectionPath, "relay");
    await adapter.shutdown();
  });

  it("doesn't carry a path over from an earlier reset", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    client.onRoute = () => client.sessions.set(SERIAL, {});
    adapter.noteRelayUsed();
    await adapter.prepareFrame(SERIAL, 3);
    assert.equal((await adapter.openLiveSession(SERIAL, new AbortController().signal)).connectionPath, "direct");
    await adapter.shutdown();
  });

  it("turns tracking off before moving, in the one form the camera took", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    client.onRoute = (command) => c.calls.push(`tracking ${command.data.value}`);
    await adapter.prepareFrame(SERIAL, 3);
    assert.deepEqual(c.calls, ["tracking 0", "list", "preview 3"]);
    assert.deepEqual(client.routed, [{ serial: SERIAL, command: { kind: "set-json", param: 6016, data: { value: 0 }, channel: 0 } }]);
    await adapter.shutdown();
  });

  it("turns tracking off even when the position is gone, since the frame still gets taken", async () => {
    const c = camera([0]);
    const { adapter, client } = withPositions(c.positions);
    assert.equal(await adapter.prepareFrame(SERIAL, 3), "gone");
    assert.deepEqual(client.routed.map(({ command }) => command.data.value), [0]);
    await adapter.shutdown();
  });

  it("turns tracking back on, closes up, and moves nothing", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    const before = client.disconnects;
    await adapter.resumeTracking(SERIAL);
    assert.deepEqual(client.routed, [{ serial: SERIAL, command: { kind: "set-json", param: 6016, data: { value: 1 }, channel: 0 } }]);
    assert.deepEqual(c.calls, []);
    assert.ok(client.disconnects > before);
    await adapter.shutdown();
  });

  it("calls an unreachable camera a capture failure when turning tracking back on", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    client.onRoute = () => {
      throw new StationUnreachableError("SN", 45000);
    };
    await assert.rejects(adapter.resumeTracking(SERIAL), (error: CaptureFailure) => error instanceof CaptureFailure && error.reason === "camera_unreachable" && error.phase === "position");
    await adapter.shutdown();
  });

  it("says so when the SDK offers no saved positions", async () => {
    const { adapter } = withPositions(undefined);
    await assert.rejects(adapter.prepareFrame(SERIAL, 3), /offers no saved positions/);
    await adapter.shutdown();
  });
});

describe("MegaAdapter device trust", () => {
  const api = (): SecurityApi => ({
    securityAppHost: () => "security-app.example",
    baseHeaders: () => ({ openudid: "device" }),
    authTokenHeaders: () => ({ "x-auth-token": "token" }),
  });
  const answering = (status: number, body: string): typeof fetch => (async () => new Response(body, { status })) as typeof fetch;

  it("earns trust by asking the person, and answers what Eufy's list then says", async () => {
    const { adapter, client } = setup();
    assert.equal(await adapter.trustDevice(async () => ({ verifyCode: "123456" })), true);
    assert.deepEqual(client.trustAnswers, ["123456"]);
  });

  it("believes Eufy's list over a call that claimed success", async () => {
    const { adapter, client } = setup();
    client.isTrustedDevice = async () => false;
    assert.equal(await adapter.trustDevice(async () => ({ verifyCode: "123456" })), false);
  });

  it("answers false, and says how to retry, when Eufy refuses the trust", async () => {
    const { adapter, client, warnings } = setup();
    client.trustError = new MegaApiError("Failed to request.", 26050, 200);
    assert.equal(await adapter.trustDevice(async () => ({ verifyCode: "123456" })), false);
    assert.match(warnings.join(), /Run login again/);
  });

  it("says to check the credentials, not to retry, when the older login refuses the password", async () => {
    const { adapter, client, warnings } = setup();
    client.trustError = new MegaApiError("/v1/passport/login failed (200/26006)", 26006, 200);
    await assert.rejects(adapter.trustDevice(async () => ({ verifyCode: "123456" })), (error: CaptureFailure) => error instanceof CaptureFailure && error.reason === "auth_required" && /Check the Eufy credentials/.test(error.message));
    assert.doesNotMatch(warnings.join(), /Run login again/);
  });

  it("doesn't call a bug in this code a refusal from Eufy", async () => {
    const { adapter, client } = setup();
    client.trustError = new TypeError("not a function");
    await assert.rejects(adapter.trustDevice(async () => ({ verifyCode: "123456" })), TypeError);
  });

  it("finds this device on Eufy's list by Eufy's own marker", async () => {
    const list = (flags: number[]): string => JSON.stringify({ code: 0, data: { list: flags.map((is_current_device) => ({ is_current_device })) } });
    assert.equal(await isTrustedDevice(api(), answering(200, list([0, 0, 1]))), true);
    assert.equal(await isTrustedDevice(api(), answering(200, list([0, 0, 0]))), false);
    assert.equal(await isTrustedDevice(api(), answering(200, JSON.stringify({ code: 0, data: {} }))), false);
  });

  it("sends the login's own headers to the list", async () => {
    let sent: RequestInit | undefined;
    let url = "";
    const capture = (async (target: string, init: RequestInit) => {
      url = target;
      sent = init;
      return new Response(JSON.stringify({ code: 0, data: { list: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    await isTrustedDevice(api(), capture);
    assert.equal(url, "https://security-app.example/v1/app/trust_device/list");
    assert.deepEqual(sent?.headers, { openudid: "device", "x-auth-token": "token" });
  });

  it("calls a refused or garbled list a failure, not an empty one", async () => {
    await assert.rejects(isTrustedDevice(api(), answering(401, JSON.stringify({ code: 26000 }))), MegaApiError);
    await assert.rejects(isTrustedDevice(api(), answering(200, JSON.stringify({ code: 26000 }))), MegaApiError);
    await assert.rejects(isTrustedDevice(api(), answering(502, "<html>bad gateway</html>")), MegaApiError);
  });

  it("answers null when Eufy can't say whether the device is trusted", async () => {
    const { client, adapter, warnings } = setup();
    client.isTrustedDevice = async () => {
      throw new MegaApiError("trust_device/list failed (500/undefined)", undefined, 500);
    };
    assert.equal(await adapter.isDeviceTrusted(), null);
    assert.match(warnings.join(), /whether this device is trusted/);
    await adapter.shutdown();
  });

  it("lets a bug in the trust call through", async () => {
    const { client, adapter } = setup();
    client.isTrustedDevice = async () => {
      throw new TypeError("not a function");
    };
    await assert.rejects(adapter.isDeviceTrusted(), TypeError);
    await adapter.shutdown();
  });

  it("the SDK still has the calls this reaches for", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "real-client-"));
    const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const client = createMegaClient({ email: "a@example.com", password: "x", country: "US", sessionDir, logger: quiet });
    const real = (client as unknown as { api: SecurityApi }).api;
    assert.equal(typeof real.baseHeaders().openudid, "string", "the trust has to land on this device");
    assert.equal(typeof real.baseHeaders().phone_model, "string");
    for (const name of ["securityAppHost", "baseHeaders", "authTokenHeaders"] as const) {
      assert.equal(typeof real[name], "function", name);
    }
    assert.equal(real.securityAppHost(), "security-app.eufylife.com");
    await client.disconnect();
    await rm(sessionDir, { recursive: true, force: true });
  });
});

describe("MegaAdapter live sessions", () => {
  it("opens a cold session and forwards video and audio", async () => {
    const { client, adapter } = setup();
    const stream = new FakeStream();
    client.device = fakeDevice({}, stream);
    const session = await adapter.openLiveSession(SERIAL, openSignal());
    assert.equal(session.coldConnection, true);
    assert.ok(client.sessions.has(SERIAL));

    const received: Buffer[] = [];
    session.video.on("data", (chunk: Buffer) => received.push(chunk));
    stream.emit("video", { data: Buffer.from([1, 2, 3]), codec: "h265", width: 1920, height: 1080, keyframe: false });
    stream.emit("audio", { data: Buffer.from([9]) });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(Buffer.concat(received), Buffer.from([1, 2, 3]));
    assert.equal(session.codec, "h265");
    assert.deepEqual([session.reportedWidth, session.reportedHeight], [1920, 1080]);
    await adapter.shutdown();
  });

  it("reports keyframes at their coded size, and only keyframes", async () => {
    const { client, adapter } = setup();
    const stream = new FakeStream();
    client.device = fakeDevice({}, stream);
    const session = await adapter.openLiveSession(SERIAL, openSignal());
    session.video.resume();
    const seen: Array<{ width: number; height: number }> = [];
    session.onKeyframe((size) => seen.push(size));

    stream.emit("video", { data: Buffer.from([1]), codec: "h265", width: 1280, height: 720, keyframe: true });
    stream.emit("video", { data: Buffer.from([2]), codec: "h265", width: 1280, height: 720, keyframe: false });
    stream.emit("video-config", { codec: "h265", width: 3840, height: 2160 });
    // The header disagrees with the parameter sets, and the parameter sets win.
    stream.emit("video", { data: Buffer.from([3]), codec: "h265", width: 1280, height: 720, keyframe: true });

    assert.deepEqual(seen, [
      { width: 1280, height: 720 },
      { width: 3840, height: 2160 },
    ]);
    await adapter.shutdown();
  });

  it("records whether the SDK had to use its relay", async () => {
    const direct = setup();
    assert.equal((await direct.adapter.openLiveSession(SERIAL, openSignal())).connectionPath, "direct");
    await direct.adapter.teardown(SERIAL, 50);

    direct.client.connect = async () => {
      direct.adapter.noteRelayUsed();
      direct.client.sessions.set(SERIAL, {});
    };
    assert.equal((await direct.adapter.openLiveSession(SERIAL, openSignal())).connectionPath, "relay");
    await direct.adapter.teardown(SERIAL, 50);

    direct.client.connect = async () => {
      direct.client.sessions.set(SERIAL, {});
    };
    assert.equal((await direct.adapter.openLiveSession(SERIAL, openSignal())).connectionPath, "direct", "each attempt starts fresh");
    await direct.adapter.shutdown();
  });

  it("flags a session that reused an open connection as not cold", async () => {
    const { client, adapter } = setup();
    client.sessions.set(SERIAL, {});
    const session = await adapter.openLiveSession(SERIAL, openSignal());
    assert.equal(session.coldConnection, false);
    await adapter.shutdown();
  });

  it("ends the video when the stream stops", async () => {
    const { client, adapter } = setup();
    const stream = new FakeStream();
    client.device = fakeDevice({}, stream);
    const session = await adapter.openLiveSession(SERIAL, openSignal());
    const ended = new Promise((resolve) => session.video.once("end", resolve));
    session.video.resume();
    stream.emit("stop");
    await ended;
    await adapter.shutdown();
  });

  it("reports an unreachable camera with the SDK's reason", async () => {
    const { client, adapter } = setup();
    client.connect = async () => {
      throw new StationUnreachableError("SN", 45000);
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), (error: CaptureFailure) => {
      assert.equal(error.reason, "camera_unreachable");
      assert.equal(error.phase, "connect");
      return true;
    });
    await adapter.shutdown();
  });

  it("reports the deadline by phase, and a termination as an abort", async () => {
    const rejectAlways = async (): Promise<void> => {
      throw new Error("aborted");
    };

    const connecting = setup();
    connecting.client.connect = rejectAlways;
    await assert.rejects(connecting.adapter.openLiveSession(SERIAL, abortedWith("deadline")), (error: CaptureFailure) => error.reason === "camera_unreachable" && error.phase === "connect");
    await connecting.adapter.shutdown();

    const streaming = setup();
    streaming.client.device = fakeDevice({ camera: () => ({ live: rejectAlways as never }) });
    await assert.rejects(streaming.adapter.openLiveSession(SERIAL, abortedWith("deadline")), (error: CaptureFailure) => error.reason === "capture_timeout" && error.phase === "stream_start");
    await streaming.adapter.shutdown();

    const terminated = setup();
    terminated.client.connect = rejectAlways;
    await assert.rejects(terminated.adapter.openLiveSession(SERIAL, abortedWith("terminated")), (error: CaptureFailure) => error.reason === "aborted");
    await terminated.adapter.shutdown();
  });

  it("treats the SDK's plain connect-timeout error as an unreachable camera, not a crash", async () => {
    const { client, adapter } = setup();
    client.connect = async () => {
      throw new Error("P2P connect timeout for SN (relay: request)");
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), (error: CaptureFailure) => {
      assert.ok(error instanceof CaptureFailure);
      assert.equal(error.reason, "camera_unreachable");
      assert.match(error.message, /relay: request/);
      return true;
    });
    await adapter.shutdown();
  });

  it("treats the network being down as an unreachable camera", async () => {
    const { client, adapter } = setup();
    client.connect = async () => {
      throw new TypeError("fetch failed");
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), (error: CaptureFailure) => error.reason === "camera_unreachable");
    await adapter.shutdown();
  });

  it("lets a bug propagate instead of calling it a camera problem", async () => {
    const { client, adapter } = setup();
    client.connect = async () => {
      throw new TypeError("a bug");
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), TypeError);
    await adapter.shutdown();
  });

  it("says so when the SDK has no live path for the camera", async () => {
    const { client, adapter } = setup();
    client.device = fakeDevice({ camera: () => ({}) });
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), (error: CaptureFailure) => error.reason === "camera_unreachable" && /no live video path/.test(error.message));
    await adapter.shutdown();
  });

  it("restores the login before the next attempt, after a teardown", async () => {
    const { client, adapter } = setup();
    await adapter.openLiveSession(SERIAL, openSignal());
    assert.equal(client.logins, 0);
    await adapter.teardown(SERIAL, 50);
    const second = await adapter.openLiveSession(SERIAL, openSignal());
    assert.equal(client.logins, 1);
    assert.equal(second.coldConnection, true, "teardown left nothing to reuse");
    await adapter.shutdown();
  });

  it("restores the login before reading the cloud between attempts", async () => {
    const { client, adapter } = setup();
    await adapter.openLiveSession(SERIAL, openSignal());
    await adapter.teardown(SERIAL, 50);
    await adapter.discoverCamera();
    assert.equal(client.logins, 1);
    await adapter.openLiveSession(SERIAL, openSignal());
    assert.equal(client.logins, 1, "one restore per teardown is enough");
    await adapter.shutdown();
  });

  it("stops before touching the camera if restoring the login needs a person", async () => {
    const { client, adapter } = setup();
    await adapter.openLiveSession(SERIAL, openSignal());
    await adapter.teardown(SERIAL, 50);
    client.loginResults = [{ status: "2fa" }];
    let connects = 0;
    client.connect = async () => {
      connects += 1;
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), (error: CaptureFailure) => error.reason === "auth_required");
    assert.equal(connects, 0);
    await adapter.shutdown();
  });
});

describe("MegaAdapter teardown", () => {
  it("stops the stream and closes the connection", async () => {
    const { client, adapter } = setup();
    const stream = new FakeStream();
    client.device = fakeDevice({}, stream);
    await adapter.openLiveSession(SERIAL, openSignal());
    assert.deepEqual(await adapter.teardown(SERIAL, 50), { status: "ok", detail: null });
    assert.equal(stream.stops, 1);
    assert.equal(client.sessions.size, 0);
    await adapter.shutdown();
  });

  it("is safe when the attempt never got a stream", async () => {
    const { adapter } = setup();
    assert.equal((await adapter.teardown(SERIAL, 20)).status, "ok");
    await adapter.shutdown();
  });

  it("reports a connection that won't close", async () => {
    const { client, adapter } = setup();
    client.sessions.set(SERIAL, {});
    client.stuckOpen = true;
    const result = await adapter.teardown(SERIAL, 20);
    assert.equal(result.status, "timeout");
    assert.match(result.detail ?? "", /still open/);
    await adapter.shutdown();
  });

  it("reports a failed disconnect", async () => {
    const { client, adapter } = setup();
    const original = client.disconnect.bind(client);
    client.disconnect = async () => {
      throw Object.assign(new Error("socket stuck"), { code: "ERR_SOCKET_DGRAM_NOT_RUNNING" });
    };
    const result = await adapter.teardown(SERIAL, 20);
    assert.equal(result.status, "error");
    assert.match(result.detail ?? "", /socket stuck/);
    client.disconnect = original;
    await adapter.shutdown();
  });
});

describe("MegaAdapter connection guard", () => {
  it("closes and counts a connection that opens outside an attempt", async () => {
    const { client, adapter, warnings } = setup();
    client.sessions.set(SERIAL, {});
    await adapter.sweepConnections();
    assert.equal(client.sessions.size, 0);
    assert.equal(adapter.unexpectedConnectionCount(), 1);
    assert.equal(warnings.length, 1);
    await adapter.shutdown();
  });

  it("leaves the attempt's own connection alone", async () => {
    const { client, adapter } = setup();
    await adapter.openLiveSession(SERIAL, openSignal());
    await adapter.sweepConnections();
    assert.equal(client.sessions.size, 1);
    assert.equal(adapter.unexpectedConnectionCount(), 0);
    await adapter.shutdown();
  });

  it("catches a connection that opens after teardown", async () => {
    const { client, adapter } = setup();
    await adapter.openLiveSession(SERIAL, openSignal());
    await adapter.teardown(SERIAL, 50);
    client.sessions.set(SERIAL, {});
    await adapter.sweepConnections();
    assert.equal(adapter.unexpectedConnectionCount(), 1);
    await adapter.shutdown();
  });
});

describe("the pinned SDK still has what the adapter calls", () => {
  it("EufyMega", () => {
    for (const method of ["login", "submitVerifyCode", "solveCaptcha", "getDevices", "getDevice", "connectStation", "getP2pSessions", "deviceState", "disconnect", "on"]) {
      assert.equal(typeof (EufyMega.prototype as unknown as Record<string, unknown>)[method], "function", method);
    }
  });

  it("uses the login statuses the adapter's types assume", () => {
    assert.deepEqual([LoginStatus.Ok, LoginStatus.Captcha, LoginStatus.TwoFactor], ["ok", "captcha", "2fa"]);
  });

  it("still words a superseded session start the way the adapter recognizes it", async () => {
    // The SDK doesn't export the class, so its message is the only way to tell this from a bug. An upgrade that rewords it
    // has to fail here, not crash the service.
    const source = await readFile(fileURLToPath(import.meta.resolve("@mega-yfue/eufy-sdk")), "utf8");
    assert.match(source, /new SessionSupersededError\(`P2P session start superseded for \$\{key\}`\)/);
  });
});

describe("MegaAdapter, telling an outage from a refusal from a bug", () => {
  const rejectLogin = (error: Error): { client: FakeClient; adapter: MegaAdapter } => {
    const { client, adapter } = setup();
    client.login = async () => {
      throw error;
    };
    return { client, adapter };
  };
  const reasonOf = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
    } catch (error) {
      if (error instanceof CaptureFailure) return error.reason;
      throw error;
    }
    return "no failure";
  };

  for (const status of [500, 502, 503, 429, 408]) {
    it(`doesn't ask for a login over a ${status} from Eufy, since that would stop captures until someone logged in`, async () => {
      const { adapter } = rejectLogin(new MegaApiError("login failed", 1, status));
      assert.equal(await reasonOf(adapter.authenticate()), "camera_unreachable");
    });
  }

  for (const status of [400, 401, 403]) {
    it(`asks for a login over a ${status}`, async () => {
      const { adapter } = rejectLogin(new MegaApiError("login failed", 1, status));
      assert.equal(await reasonOf(adapter.authenticate()), "auth_required");
    });
  }

  it("treats a dead network at login as an outage", async () => {
    const { adapter } = rejectLogin(new TypeError("fetch failed"));
    assert.equal(await reasonOf(adapter.authenticate()), "camera_unreachable");
  });

  it("treats a socket-level network error at login as an outage", async () => {
    const { adapter } = rejectLogin(Object.assign(new Error("getaddrinfo"), { code: "EAI_AGAIN" }));
    assert.equal(await reasonOf(adapter.authenticate()), "camera_unreachable");
  });

  it("lets a bug at login propagate", async () => {
    const { adapter } = rejectLogin(new RangeError("a bug"));
    await assert.rejects(adapter.authenticate(), RangeError);
  });

  it("names the internet connection first when the device list comes back empty, which is how the SDK reports being offline", async () => {
    const { client, adapter } = setup();
    client.devices = [];
    await assert.rejects(adapter.discoverCamera(), (error: CaptureFailure) => error.reason === "camera_not_found" && error.message.startsWith("Check this host's internet connection"));
  });

  it("doesn't blame the connection when the account can see other devices", async () => {
    const { client, adapter } = setup();
    client.devices = [{ sn: "OTHER", model: "T8200" }];
    await assert.rejects(adapter.discoverCamera(), (error: CaptureFailure) => error.reason === "camera_not_found" && !error.message.includes("internet"));
  });

  it("treats an unreachable cloud during discovery as an outage", async () => {
    const { client, adapter } = setup();
    client.getDevices = async () => {
      throw new TypeError("fetch failed");
    };
    assert.equal(await reasonOf(adapter.discoverCamera()), "camera_unreachable");
  });

  it("treats a dead network between attempts as an outage, not a crash", async () => {
    const { client, adapter } = setup();
    client.getDevice = async () => {
      throw new TypeError("fetch failed");
    };
    assert.equal(await reasonOf(adapter.openLiveSession(SERIAL, openSignal())), "camera_unreachable");
  });

  for (const message of ["P2P connect timeout for SN (relay: request)", "station SN is not in the device list", "no P2P endpoint (p2p_did) for station SN"]) {
    it(`recognises the SDK's plain error "${message}" as a camera failure`, async () => {
      const { client, adapter } = setup();
      client.connect = async () => {
        throw new Error(message);
      };
      assert.equal(await reasonOf(adapter.openLiveSession(SERIAL, openSignal())), "camera_unreachable");
    });
  }

  it("lets any other plain error from a connect propagate, because that's a bug", async () => {
    const { client, adapter } = setup();
    client.connect = async () => {
      throw new Error("something nobody expected");
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), /something nobody expected/);
  });
});

describe("MegaAdapter, when disconnecting fails", () => {
  function refusing(error: Error = Object.assign(new Error("socket stuck"), { code: "ERR_SOCKET_DGRAM_NOT_RUNNING" })): { client: FakeClient; adapter: MegaAdapter; warnings: string[] } {
    const parts = setup();
    parts.client.disconnect = async () => {
      throw error;
    };
    return parts;
  }

  it("survives a failed sweep, says so, and restores the login next time", async () => {
    const { client, adapter, warnings } = refusing();
    client.sessions.set(SERIAL, {});
    await adapter.sweepConnections();
    assert.match(warnings.join(), /couldn't close a camera connection.*socket stuck/);
    assert.equal(adapter.unexpectedConnectionCount(), 1);
    const logins = client.logins;
    await adapter.discoverCamera();
    assert.equal(client.logins, logins + 1);
    await adapter.shutdown();
  });

  it("survives a socket failure at shutdown, and says so", async () => {
    const { adapter, warnings } = refusing();
    await adapter.shutdown();
    assert.match(warnings.join(), /didn't shut down cleanly.*socket stuck/);
  });

  it("lets a bug at shutdown or teardown propagate", async () => {
    const { adapter } = refusing(new RangeError("a bug"));
    await assert.rejects(adapter.teardown(SERIAL, 20), RangeError);
    await assert.rejects(adapter.shutdown(), RangeError);
  });

  it("treats a programming error as a bug even when it has a code", async () => {
    const { client, adapter } = refusing(Object.assign(new TypeError("bad argument"), { code: "ERR_INVALID_ARG_TYPE" }));
    client.sessions.set(SERIAL, {});
    await assert.rejects(adapter.sweepConnections(), TypeError);
    await assert.rejects(adapter.shutdown(), TypeError);
  });

  it("hands a sweep's unexpected failure to the fatal path, rather than logging and carrying on", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const client = new FakeClient();
    const fatal: Error[] = [];
    const adapter = new MegaAdapter(client, () => {}, () => {}, (error) => fatal.push(error));
    client.getP2pSessions = () => {
      throw new RangeError("the sweep itself broke");
    };
    t.mock.timers.tick(5_000);
    while (fatal.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fatal[0] instanceof RangeError);
    client.getP2pSessions = () => client.sessions;
    await adapter.shutdown();
  });
});

describe("MegaAdapter, keeping the camera's identifiers out of messages", () => {
  it("removes the serial from a connect failure", async () => {
    const { client, adapter } = setup();
    client.connect = async () => {
      throw new Error(`P2P connect timeout for ${SERIAL} (relay: request)`);
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), (error: CaptureFailure) => {
      assert.equal(error.reason, "camera_unreachable");
      assert.equal(error.message.includes(SERIAL), false, error.message);
      assert.match(error.message, /P2P connect timeout for \[camera\]/);
      return true;
    });
  });

  it("removes the station serial as well, once it's known", async () => {
    const { client, adapter } = setup();
    client.device = fakeDevice({ stationSn: "T86P2STATION99" });
    client.connect = async () => {
      throw new StationUnreachableError("T86P2STATION99", 45000);
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), (error: CaptureFailure) => !error.message.includes("T86P2STATION99"));
  });

  it("removes it from an outage message too", async () => {
    const { client, adapter } = setup();
    client.getDevice = async () => {
      throw Object.assign(new Error(`connect ENETUNREACH for ${SERIAL}`), { code: "ENETUNREACH" });
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, openSignal()), (error: CaptureFailure) => error.reason === "camera_unreachable" && !error.message.includes(SERIAL));
  });
});

describe("isProgrammingError", () => {
  for (const [name, error] of [["a TypeError", new TypeError("x is not a function")], ["a RangeError", new RangeError("bad")], ["a ReferenceError", new ReferenceError("x")], ["a SyntaxError", new SyntaxError("x")]] as const) {
    it(`takes ${name} for a bug`, () => {
      assert.equal(isProgrammingError(error), true);
    });
  }

  for (const [name, error] of [["fetch's report of a dead network", new TypeError("fetch failed")], ["a plain SDK diagnostic", new Error("malformed packet")], ["an API error", new MegaApiError("refused", 1, 500)], ["something that isn't an error", "text"]] as const) {
    it(`doesn't take ${name} for a bug`, () => {
      assert.equal(isProgrammingError(error), false);
    });
  }
});

describe("MegaAdapter, when a try's deadline and a failure land together", () => {
  it("lets a bug through even after the deadline, rather than calling it a timeout", async () => {
    const { client, adapter } = setup();
    client.connect = async () => {
      throw new RangeError("a bug that raced the deadline");
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, abortedWith("deadline")), RangeError);
    await adapter.shutdown();
  });

  for (const [name, rejection] of [
    ["the signal's own reason", "deadline"],
    ["a DOMException", new DOMException("P2P station wait aborted", "AbortError")],
    ['a plain "aborted"', new Error("aborted")],
    ["a camera failure", new StationUnreachableError("SN", 45000)],
  ] as const) {
    it(`takes ${name} after the deadline as the deadline`, async () => {
      const { client, adapter } = setup();
      client.connect = async () => {
        throw rejection;
      };
      await assert.rejects(adapter.openLiveSession(SERIAL, abortedWith("deadline")), (error: CaptureFailure) => error.reason === "camera_unreachable" && /before the attempt deadline/.test(error.message));
      await adapter.shutdown();
    });
  }
});

describe("MegaAdapter, reading a battery value that isn't a percentage", () => {
  for (const value of [101, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`calls ${value} unknown, and says what came back`, async () => {
      const { client, adapter } = setup();
      client.device = fakeDevice({ getProperty: (name) => (name === "battery" ? { value } : undefined) });
      const { battery } = await adapter.discoverCamera(SERIAL);
      assert.deepEqual([battery.percent, battery.observedAt], [null, null]);
      assert.match(battery.note ?? "", /isn't a percentage/);
      await adapter.shutdown();
    });
  }

  for (const value of [0, 100]) {
    it(`takes ${value} as it is`, async () => {
      const { client, adapter } = setup();
      client.device = fakeDevice({ getProperty: (name) => (name === "battery" ? { value } : undefined) });
      assert.equal((await adapter.discoverCamera(SERIAL)).battery.percent, value);
      await adapter.shutdown();
    });
  }
});

describe("MegaAdapter, when the live stream reports an error", () => {
  async function open(): Promise<{ stream: FakeStream; video: NodeJS.ReadableStream; fatal: Error[]; adapter: MegaAdapter }> {
    const client = new FakeClient();
    const fatal: Error[] = [];
    const adapter = new MegaAdapter(client, () => {}, () => {}, (error) => fatal.push(error));
    const stream = new FakeStream();
    client.device = fakeDevice({}, stream);
    const session = await adapter.openLiveSession(SERIAL, openSignal());
    return { stream, video: session.video, fatal, adapter };
  }

  function failureOf(video: NodeJS.ReadableStream): Promise<Error> {
    return new Promise((resolve) => video.once("error", resolve));
  }

  it("ends the attempt, and doesn't call a stream fault a bug", async () => {
    const { stream, video, fatal, adapter } = await open();
    const failure = failureOf(video);
    stream.emit("error", new Error(`relay closed for ${SERIAL}`));
    assert.equal((await failure).message, "relay closed for [camera]");
    assert.deepEqual(fatal, []);
    await adapter.shutdown();
  });

  for (const bug of [new TypeError("x is not a function"), new RangeError("offset out of range")]) {
    it(`takes a ${bug.name} to the fatal path, and still ends the attempt`, async () => {
      const { stream, video, fatal, adapter } = await open();
      const failure = failureOf(video);
      stream.emit("error", bug);
      await failure;
      assert.deepEqual(fatal, [bug]);
      await adapter.shutdown();
    });
  }
});

describe("MegaAdapter, when frames arrive after the stream has stopped", () => {
  it("ignores them, instead of raising an error nobody is listening for", async () => {
    const { client, adapter } = setup();
    const stream = new FakeStream();
    client.device = fakeDevice({}, stream);
    const session = await adapter.openLiveSession(SERIAL, openSignal());
    const errors: Error[] = [];
    session.video.on("error", (error: Error) => errors.push(error));
    session.video.resume();
    session.audio.resume();
    stream.stop();
    stream.emit("video", { data: Buffer.from([1]), codec: "h265", width: 3840, height: 2160, keyframe: true });
    stream.emit("audio", { data: Buffer.from([1]) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, []);
    await adapter.shutdown();
  });
});
