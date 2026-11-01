import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { CameraLockHeldError, CameraLockLostError, withCameraLock } from "../src/lock.ts";
import { runLogin } from "../src/login.ts";
import { createRedactingLogger, Redactor } from "../src/logging.ts";
import { State } from "../src/state.ts";
import { MockAdapter, tempDir } from "./helpers/fixtures.ts";

describe("loadConfig", () => {
  const base = { EUFY_EMAIL: "a@example.com", EUFY_PASSWORD: "pw" };
  let dir: { path: string; remove: () => Promise<void> };

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  it("applies defaults", () => {
    const config = loadConfig(base);
    assert.deepEqual([config.minWidth, config.minHeight], [3840, 2160], "the owner requires native 4K");
    assert.equal(config.country, "US");
    assert.equal(config.link, null);
    assert.equal(config.operator, null);
    assert.equal(config.dataDir, "./data");
    assert.equal("cameraSerial" in config, false);
  });

  it("prefers a Docker secret file over the plain variable", async () => {
    const path = join(dir.path, "password");
    await writeFile(path, "from-file\n");
    const config = loadConfig({ ...base, EUFY_PASSWORD_FILE: path });
    assert.equal(config.password, "from-file");
  });

  it("keeps spaces that are part of a password in a secret file", async () => {
    const path = join(dir.path, "spaced");
    await writeFile(path, " spaced pw \n");
    assert.equal(loadConfig({ ...base, EUFY_PASSWORD_FILE: path }).password, " spaced pw ");
  });

  it("explains a missing secret, and a broken or empty secret file", async () => {
    assert.throws(() => loadConfig({ EUFY_PASSWORD: "pw" }), (error: ConfigError) => /EUFY_EMAIL/.test(error.message) && /set-credentials/.test(error.message));
    const missing = join(dir.path, "nope");
    assert.throws(() => loadConfig({ ...base, EUFY_EMAIL_FILE: missing }), (error: ConfigError) => error.message.includes(missing));
    const empty = join(dir.path, "empty");
    await writeFile(empty, "\n");
    assert.throws(() => loadConfig({ ...base, EUFY_EMAIL_FILE: empty }), /is empty/);
  });

  it("rejects values it doesn't understand", () => {
    assert.throws(() => loadConfig({ ...base, TIMELAPSE_MIN_WIDTH: "4k" }), /TIMELAPSE_MIN_WIDTH/);
    assert.throws(() => loadConfig({ ...base, TIMELAPSE_MIN_HEIGHT: "-1" }), /TIMELAPSE_MIN_HEIGHT/);
    assert.throws(() => loadConfig({ ...base, TIMELAPSE_CAMERA_LINK: "ethernet" }), /cellular/);
  });

  it("treats blank optional values as unset", () => {
    const config = loadConfig({ ...base, TIMELAPSE_CAMERA_LINK: "", TIMELAPSE_CELLULAR_OPERATOR: " " });
    assert.equal(config.link, null);
    assert.equal(config.operator, null);
  });
});

describe("withCameraLock", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let run = 0;
  const lockPath = (): string => {
    run += 1;
    return join(dir.path, `camera-${run}.lock`);
  };

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  it("refuses a second holder while the first is alive", async () => {
    const path = lockPath();
    await withCameraLock(path, async () => {
      await assert.rejects(withCameraLock(path, async () => "second"), CameraLockHeldError);
    });
  });

  it("releases the lock when the work throws", async () => {
    const path = lockPath();
    await assert.rejects(
      withCameraLock(path, async () => {
        throw new RangeError("boom");
      }),
      RangeError,
    );
    assert.equal(await withCameraLock(path, async () => "again"), "again");
  });

  const NOW = Date.parse("2026-07-01T13:00:00Z");
  const at = { now: () => NOW };

  async function heldSince(path: string, ms: number): Promise<void> {
    await writeFile(path, "some-other-holder");
    await utimes(path, new Date(ms), new Date(ms));
  }

  it("replaces a lock whose holder stopped its heartbeat, as a crashed container does", async () => {
    const path = lockPath();
    await heldSince(path, NOW - 60_000);
    assert.equal(await withCameraLock(path, async () => "recovered", at), "recovered");
  });

  it("respects a lock with a live heartbeat, whatever process wrote it", async () => {
    const path = lockPath();
    await heldSince(path, NOW - 10_000);
    await assert.rejects(withCameraLock(path, async () => "second", at), CameraLockHeldError);
  });

  it("doesn't remove a lock that another holder has taken over", async () => {
    const path = lockPath();
    await withCameraLock(path, async () => {
      await writeFile(path, "my-successor");
    });
    assert.equal(await readFile(path, "utf8"), "my-successor");
  });

  it("keeps a live holder's lock fresh", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const path = lockPath();
    await withCameraLock(path, async () => {
      const before = (await stat(path)).mtimeMs;
      t.mock.timers.tick(5_000);
      while ((await stat(path)).mtimeMs === before) await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await stat(path)).mtimeMs, NOW);
    }, at);
  });

  for (const [name, breakIt] of [
    ["disappears", async (path: string): Promise<void> => rm(path)],
    ["is taken by another holder", async (path: string): Promise<void> => writeFile(path, "my-successor")],
  ] as const) {
    it(`stops the camera work, and says so, when the lock ${name}`, async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const path = lockPath();
      let sawAbort = false;
      await assert.rejects(
        withCameraLock(path, async (lost) => {
          await breakIt(path);
          t.mock.timers.tick(5_000);
          while (!lost.aborted) await new Promise((resolve) => setImmediate(resolve));
          sawAbort = true;
          return "finished anyway";
        }),
        (error: Error) => error instanceof CameraLockLostError && /data directory is writable/.test(error.message),
      );
      assert.equal(sawAbort, true);
    });
  }

  it("reports a lost lock over whatever the aborted work threw", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const path = lockPath();
    await assert.rejects(
      withCameraLock(path, async (lost) => {
        await rm(path);
        t.mock.timers.tick(5_000);
        while (!lost.aborted) await new Promise((resolve) => setImmediate(resolve));
        throw new RangeError("aborted work");
      }),
      CameraLockLostError,
    );
  });
});

describe("Redactor", () => {
  it("scrubs known values wherever they appear", () => {
    const redactor = new Redactor(["hunter2"]);
    redactor.addLiteral("T86P2SERIAL");
    const text = redactor.redact({ message: "login hunter2 for T86P2SERIAL", nested: ["T86P2SERIAL"] });
    assert.doesNotMatch(text, /hunter2|T86P2SERIAL/);
  });

  it("scrubs a literal that JSON encoding would otherwise change", () => {
    const text = new Redactor(['pa"ss\\word']).redact('login pa"ss\\word');
    assert.equal(JSON.parse(text), "login [redacted]");
  });

  it("removes sensitive fields by name, at any depth", () => {
    const text = new Redactor().redact({
      args: [{ token: "t0k3n", persistentData: { anything: "x" }, station_sn: "S123", p2p_did: "D456", request: { password: "p4ss", dsk_key: "k3y" } }],
    });
    assert.doesNotMatch(text, /t0k3n|S123|D456|p4ss|k3y/);
  });

  it("removes secrets embedded in message strings", () => {
    const text = new Redactor().redact(`request {"auth_token":"abc123","password":"p4ss"} token=xyz789`);
    assert.doesNotMatch(text, /abc123|p4ss|xyz789/);
  });

  it("keeps ordinary diagnostics readable, and survives odd values", () => {
    const circular: Record<string, unknown> = { state: "connected" };
    circular.self = circular;
    const text = new Redactor().redact({ error: new Error("lookup failed"), size: 10n, frame: Buffer.alloc(8), circular });
    assert.match(text, /lookup failed/);
    assert.match(text, /connected/);
    assert.match(text, /<8 bytes>/);
    assert.match(text, /\[circular\]/);
  });
});

describe("the command line", () => {
  const run = promisify(execFile);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  it("prints its usage on --help, and exits cleanly", async () => {
    const { stdout } = await run(process.execPath, [cli, "--help"]);
    assert.match(stdout, /^Usage: timelapse/);
  });

  it("refuses an unknown command, with the usage and a failing exit code", async () => {
    await assert.rejects(run(process.execPath, [cli, "nonsense"]), (error: { code: number; stderr: string }) => error.code === 2 && /Usage: timelapse/.test(error.stderr));
  });
});

describe("Redactor, on packet dumps", () => {
  it("removes the hex of a packet the SDK logs, which holds the device id", () => {
    const dump = "f183001cafcc651441424344454647000000007b414243444500000001000000";
    const text = new Redactor().redact(`[p2p] UNHANDLED payload hex: ${dump}`);
    assert.equal(text.includes(dump), false);
    assert.match(text, /UNHANDLED payload hex: <32 bytes of hex>/);
  });

  it("keeps short hex, such as a packet header", () => {
    assert.match(new Redactor().redact("<<< 192.0.2.1:32100 header=f121 len=8"), /header=f121/);
  });
});

describe("createRedactingLogger", () => {
  it("writes one redacted JSON line per call, at every level", () => {
    const lines: string[] = [];
    const logger = createRedactingLogger(new Redactor(["hunter2"]), (line) => lines.push(line), () => new Date("2026-01-01T00:00:00.000Z"));
    logger.debug("d");
    logger.info("login hunter2", { token: "abc" });
    logger.warn("w");
    logger.error("e");
    assert.equal(lines.length, 4);
    const parsed = JSON.parse(lines[1] ?? "") as { ts: string; level: string; message: string; args: Array<{ token: string }> };
    assert.equal(parsed.level, "info");
    assert.equal(parsed.ts, "2026-01-01T00:00:00.000Z");
    assert.equal(parsed.message, "login [redacted]");
    assert.equal(parsed.args[0]?.token, "[redacted]");
  });
});

describe("runLogin", () => {
  let dir: { path: string; remove: () => Promise<void> };

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  it("walks through 2FA and proves the account can see the camera", async () => {
    const prompts: string[] = [];
    const result = await runLogin({
      adapter: new MockAdapter({ auth: [{ status: "tfa_required" }, { status: "authenticated" }] }),
      dataDir: dir.path,
      prompt: async (question) => {
        prompts.push(question);
        return " 123456 ";
      },
      log: () => {},
    });
    assert.equal(prompts.length, 1);
    assert.equal(result.status, "authenticated");
    assert.equal(result.camera.model, "T86P2");
    assert.equal(result.camera.serial_masked.endsWith("1234"), true);
    assert.equal(JSON.stringify(result).includes("T86P2FULLSERIAL1234"), false);
  });

  it("saves a captcha where a person can open it", async () => {
    const logged: string[] = [];
    await runLogin({
      adapter: new MockAdapter({
        auth: [{ status: "captcha_required", captchaId: "id", captchaImage: `data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}` }, { status: "authenticated" }],
      }),
      dataDir: dir.path,
      prompt: async () => "abc",
      log: (message) => logged.push(message),
    });
    const path = join(dir.path, "captcha.png");
    await access(path);
    assert.equal((await readFile(path)).toString(), "PNGDATA");
    assert.match(logged[0] ?? "", /captcha\.png/);
  });

  it("gives up instead of hammering the login", async () => {
    let prompts = 0;
    const tfa = { status: "tfa_required" } as const;
    await assert.rejects(
      runLogin({
        adapter: new MockAdapter({ auth: [tfa, tfa, tfa, tfa, tfa, tfa, tfa] }),
        dataDir: dir.path,
        prompt: async () => {
          prompts += 1;
          return "000000";
        },
        log: () => {},
      }),
      (error: CaptureFailure) => error.reason === "auth_required",
    );
    assert.equal(prompts, 5);
  });
});

describe("the resume command", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = promisify(execFile);

  async function resume(pausedFlag: boolean): Promise<string | undefined> {
    const dir = await tempDir();
    try {
      const database = join(dir.path, "state.sqlite");
      const before = new State(database);
      if (pausedFlag) before.setFlag("battery_paused", "20");
      before.close();
      await run(process.execPath, [cli, "resume", "--battery-checked"], { env: { ...process.env, TIMELAPSE_DATA_DIR: dir.path } });
      const after = new State(database);
      const override = after.getFlag("battery_override");
      after.close();
      return override;
    } finally {
      await dir.remove();
    }
  }

  it("records an override when a low-battery pause is active", async () => {
    assert.notEqual(await resume(true), undefined);
  });

  it("records none when there's no pause, so it can't cancel a later one", async () => {
    assert.equal(await resume(false), undefined);
  });
});
