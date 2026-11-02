import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EufyMega, FileSessionStore, LoginStatus, MegaApiError, SessionExpiredError, StationUnreachableError } from "@mega-yfue/eufy-sdk";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import type { AuthChallenge, AuthInput } from "../src/adapters/adapter.ts";
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

const HELD_SESSION = JSON.stringify({ authToken: "held", tokenExpiresAt: 1_800_000_000 });
const FRESH_SESSION = JSON.stringify({ authToken: "fresh", tokenExpiresAt: 1_802_592_000 });

class FakeClient implements MegaClient {
  loginResults: MegaLoginResult[] = [{ status: "ok" }];
  logins = 0;
  codes: string[] = [];
  captchas: string[] = [];
  devices = [{ sn: SERIAL, model: "T86P2321" }];
  device: MegaDevice = fakeDevice();
  sessions = new Map<string, unknown>();
  disconnects = 0;
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
    new FileSessionStore(join(t.sessionDir, "eufy-sdk-session.json")).save({ authToken: "x", tokenExpiresAt: 1_800_000_000 } as never);
    assert.equal(t.adapter.loginExpiresAt()?.toISOString(), "2027-01-15T08:00:00.000Z");
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
  function withPositions(positions: MegaPositions | undefined): { adapter: MegaAdapter; client: FakeClient; warnings: string[] } {
    const client = new FakeClient();
    const warnings: string[] = [];
    const adapter = new MegaAdapter(client, (message) => warnings.push(message), () => {}, undefined, undefined, { saveMs: 0, moveMs: 0 });
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
    assert.equal(await adapter.returnToPosition(SERIAL, 3), "returned");
    assert.deepEqual(c.calls, ["list", "preview 3"]);
    await adapter.shutdown();
  });

  it("won't go to an empty slot, because that position is gone", async () => {
    const c = camera([0]);
    const { adapter } = withPositions(c.positions);
    assert.equal(await adapter.returnToPosition(SERIAL, 3), "gone");
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
    await adapter.returnToPosition(SERIAL, 3);
    assert.ok(client.disconnects > before);
    assert.equal(adapter.unexpectedConnectionCount(), 0);
    await adapter.shutdown();
  });

  it("logs in again before using the camera if it's been closed", async () => {
    const c = camera([0, 3]);
    const { adapter, client } = withPositions(c.positions);
    await adapter.returnToPosition(SERIAL, 3);
    const logins = client.logins;
    await adapter.returnToPosition(SERIAL, 3);
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
    await assert.rejects(adapter.returnToPosition(SERIAL, 3), (error: CaptureFailure) => error instanceof CaptureFailure && error.reason === "camera_unreachable" && error.phase === "position");
    assert.ok(client.disconnects > before);
    await adapter.shutdown();
  });

  it("lets a bug through as itself, and still closes up", async () => {
    const c = camera([0, 3]);
    c.positions.preview = async () => {
      throw new TypeError("not a function");
    };
    const { adapter, client } = withPositions(c.positions);
    const before = client.disconnects;
    await assert.rejects(adapter.returnToPosition(SERIAL, 3), TypeError);
    assert.ok(client.disconnects > before);
    await adapter.shutdown();
  });

  it("says so when the SDK offers no saved positions", async () => {
    const { adapter } = withPositions(undefined);
    await assert.rejects(adapter.returnToPosition(SERIAL, 3), /offers no saved positions/);
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
