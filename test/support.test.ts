import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { CameraLockHeldError, withCameraLock } from "../src/lock.ts";
import { runLogin } from "../src/login.ts";
import { createRedactingLogger, Redactor } from "../src/logging.ts";
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
    assert.equal(config.country, "US");
    assert.equal(config.acceptInvitations, false);
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
    assert.throws(() => loadConfig({ ...base, TIMELAPSE_CAMERA_LINK: "ethernet" }), /cellular/);
    assert.throws(() => loadConfig({ ...base, EUFY_ACCEPT_INVITATIONS: "yes" }), /true/);
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

  it("replaces a lock left by a dead process", async () => {
    const path = lockPath();
    // Past the highest PID any supported OS hands out, so no process can hold it.
    await writeFile(path, "99999999");
    assert.equal(await withCameraLock(path, async () => "recovered"), "recovered");
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

describe("createRedactingLogger", () => {
  it("writes one redacted JSON line per call, at every level", () => {
    const lines: string[] = [];
    const logger = createRedactingLogger(new Redactor(["hunter2"]), (line) => lines.push(line), () => new Date("2026-01-01T00:00:00.000Z"));
    logger.trace("t");
    logger.debug("d");
    logger.info("login hunter2", { token: "abc" });
    logger.warn("w");
    logger.error("e");
    assert.equal(lines.length, 5);
    const parsed = JSON.parse(lines[2] ?? "") as { ts: string; level: string; message: string; args: Array<{ token: string }> };
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
