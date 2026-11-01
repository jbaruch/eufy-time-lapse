import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    assert.throws(() => loadConfig({ ...base, EUFY_EMAIL_FILE: dir.path }), (error: ConfigError) => error instanceof ConfigError && error.message.includes("EISDIR"));
    const empty = join(dir.path, "empty");
    await writeFile(empty, "\n");
    assert.throws(() => loadConfig({ ...base, EUFY_EMAIL_FILE: empty }), /is empty/);
  });

  it("rejects values it doesn't understand", () => {
    assert.throws(() => loadConfig({ ...base, TIMELAPSE_MIN_WIDTH: "4k" }), /TIMELAPSE_MIN_WIDTH/);
    assert.throws(() => loadConfig({ ...base, TIMELAPSE_MIN_HEIGHT: "-1" }), /TIMELAPSE_MIN_HEIGHT/);
    assert.throws(() => loadConfig({ ...base, TIMELAPSE_CAMERA_LINK: "ethernet" }), /cellular/);
  });

  it("lets a bug through as itself, not as a bad secret file", () => {
    assert.throws(() => loadConfig({ ...base, EUFY_EMAIL_FILE: "a\0b" }), (error: Error) => error instanceof TypeError && !(error instanceof ConfigError));
  });

  it("treats blank optional values as unset", () => {
    const config = loadConfig({ ...base, TIMELAPSE_CAMERA_LINK: "", TIMELAPSE_CELLULAR_OPERATOR: " " });
    assert.equal(config.link, null);
    assert.equal(config.operator, null);
  });
});

describe("opening the state database", () => {
  let dir: { path: string; remove: () => Promise<void> };

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  it("lets several processes open a new one at once, and migrates it once", async () => {
    const database = join(dir.path, "fresh.sqlite");
    const module = new URL("../src/state.ts", import.meta.url).href;
    const run = promisify(execFile);
    const openers = Array.from({ length: 6 }, () =>
      run(process.execPath, ["--input-type=module", "-e", `
        import { State } from ${JSON.stringify(module)};
        new State(${JSON.stringify(database)}).close();
      `]),
    );
    await Promise.all(openers);
    const db = new DatabaseSync(database);
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'slots'").get() as { count: number };
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    db.close();
    assert.equal(count, 1);
    assert.ok(version > 0);
  });

  it("refuses a database from a newer build, and leaves it alone", () => {
    const database = join(dir.path, "newer.sqlite");
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE marker (id INTEGER); PRAGMA user_version = 99");
    db.close();
    assert.throws(() => new State(database), /version 99/);
    const after = new DatabaseSync(database);
    const { user_version: version } = after.prepare("PRAGMA user_version").get() as { user_version: number };
    after.close();
    assert.equal(version, 99);
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
  const at = (ms: number) => ({ now: () => ms });

  /** Leaves a claim behind with the given heartbeat time, as a crashed holder does, by holding the lock through `inner`. */
  async function heldSince<T>(path: string, ms: number, inner: () => Promise<T>): Promise<T> {
    return await withCameraLock(path, inner, at(ms));
  }

  it("replaces a lock whose holder stopped its heartbeat, as a crashed container does", async () => {
    const path = lockPath();
    const result = await heldSince(path, NOW - 60_000, () => withCameraLock(path, async () => "recovered", at(NOW)));
    assert.equal(result, "recovered");
  });

  it("respects a lock with a live heartbeat, whatever process wrote it", async () => {
    const path = lockPath();
    await heldSince(path, NOW - 10_000, async () => {
      await assert.rejects(withCameraLock(path, async () => "second", at(NOW)), CameraLockHeldError);
    });
  });

  it("is free again once released", async () => {
    const path = lockPath();
    await withCameraLock(path, async () => "first", at(NOW));
    assert.equal(await withCameraLock(path, async () => "second", at(NOW)), "second");
  });

  it("doesn't let a stale holder's release remove its successor's claim", async () => {
    const path = lockPath();
    await heldSince(path, NOW - 60_000, async () => {
      // The successor takes over, and is still holding when the stale holder finishes.
      let finish = (): void => {};
      const successor = withCameraLock(
        path,
        () =>
          new Promise<string>((resolve) => {
            finish = () => resolve("done");
          }),
        at(NOW),
      );
      await new Promise((resolve) => setImmediate(resolve));
      return { finish, successor };
    }).then(async ({ finish, successor }) => {
      await assert.rejects(withCameraLock(path, async () => "third", at(NOW)), CameraLockHeldError);
      finish();
      await successor;
    });
    assert.equal(await withCameraLock(path, async () => "free", at(NOW)), "free");
  });

  it("holds against a real second process, and frees up when that process finishes", async () => {
    const path = lockPath();
    const module = new URL("../src/lock.ts", import.meta.url).href;
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `
      import { withCameraLock } from ${JSON.stringify(module)};
      await withCameraLock(${JSON.stringify(path)}, () => new Promise((resolve) => {
        process.stdin.once("data", resolve);
        process.stdout.write("holding\\n");
      }));
      process.exit(0);
    `], { stdio: ["pipe", "pipe", "inherit"] });
    await once(holder.stdout, "data");
    await assert.rejects(withCameraLock(path, async () => "mine"), CameraLockHeldError);
    const exited = once(holder, "exit");
    holder.stdin.write("done\n");
    assert.deepEqual((await exited)[0], 0);
    assert.equal(await withCameraLock(path, async () => "mine"), "mine");
  });

  it("refuses a lock file from a version it doesn't know, rather than guessing", async () => {
    const path = lockPath();
    await withCameraLock(path, async () => "first", at(NOW));
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    await assert.rejects(withCameraLock(path, async () => "second", at(NOW)), /version 99/);
  });

  it("keeps a live holder's claim fresh", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const path = lockPath();
    let clock = NOW;
    await withCameraLock(
      path,
      async () => {
        clock = NOW + 60_000;
        t.mock.timers.tick(5_000);
        await assert.rejects(withCameraLock(path, async () => "second", at(clock)), CameraLockHeldError, "its heartbeat kept it alive");
      },
      { now: () => clock },
    );
  });

  for (const [name, breakIt] of [
    ["disappears", async (path: string): Promise<void> => rm(path)],
    [
      "is taken by another holder",
      async (path: string): Promise<void> => {
        await withCameraLock(path, async () => "successor", at(NOW + 60_000)).then(() => {
          const db = new DatabaseSync(path);
          db.prepare("INSERT OR REPLACE INTO holder (id, token, heartbeat_at) VALUES (1, 'my-successor', ?)").run(NOW + 60_000);
          db.close();
        });
      },
    ],
    [
      "can no longer be opened",
      async (path: string): Promise<void> => {
        await rm(path);
        await mkdir(path);
      },
    ],
    [
      "is replaced by a version this build doesn't know",
      async (path: string): Promise<void> => {
        const db = new DatabaseSync(path);
        db.exec("PRAGMA user_version = 99");
        db.close();
      },
    ],
  ] as const) {
    it(`stops the camera work, and says so, when the lock ${name}`, async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const path = lockPath();
      let sawAbort = false;
      await assert.rejects(
        withCameraLock(
          path,
          async (lost) => {
            await breakIt(path);
            t.mock.timers.tick(5_000);
            sawAbort = lost.aborted;
            return "finished anyway";
          },
          at(NOW),
        ),
        (error: Error) => error instanceof CameraLockLostError && /data directory is writable/.test(error.message),
      );
      assert.equal(sawAbort, true);
    });
  }

  for (const [name, finish] of [
    ["finishes anyway", async (): Promise<string> => "finished anyway"],
    [
      "fails because it was stopped",
      async (): Promise<string> => {
        throw new Error("aborted");
      },
    ],
  ] as const) {
    it(`reports a bug in the heartbeat as that bug, when the work ${name}`, async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const path = lockPath();
      const bug = new TypeError("x is not a function");
      let broken = false;
      let sawAbort = false;
      await assert.rejects(
        withCameraLock(
          path,
          async (lost) => {
            broken = true;
            t.mock.timers.tick(5_000);
            sawAbort = lost.aborted;
            broken = false;
            return await finish();
          },
          {
            now: () => {
              if (broken) throw bug;
              return NOW;
            },
          },
        ),
        (error: Error) => error === bug,
      );
      assert.equal(sawAbort, true);
    });
  }

  it("leaves a claim it can't prove to go stale, rather than touching it", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const path = lockPath();
    let broken = false;
    await assert.rejects(
      withCameraLock(
        path,
        async () => {
          broken = true;
          t.mock.timers.tick(5_000);
          broken = false;
          return "finished anyway";
        },
        {
          now: () => {
            if (broken) throw new RangeError("a bug");
            return NOW;
          },
        },
      ),
      RangeError,
    );
    await assert.rejects(withCameraLock(path, async () => "too soon", at(NOW)), CameraLockHeldError);
    assert.equal(await withCameraLock(path, async () => "after it went stale", at(NOW + 60_000)), "after it went stale");
  });

  it("reports a lost lock over whatever the aborted work threw", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const path = lockPath();
    await assert.rejects(
      withCameraLock(path, async () => {
        await rm(path);
        t.mock.timers.tick(5_000);
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

describe("Redactor, on credential headers", () => {
  const cases: Array<[string, string, string]> = [
    ["an authorization header", "Authorization: Bearer TOPSECRET", "TOPSECRET"],
    ["a proxy authorization header", "Proxy-Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["a cookie with several values", "Cookie: session=TOPSECRET; other=ALSOSECRET", "ALSOSECRET"],
    ["a set-cookie header", "set-cookie: session=TOPSECRET; Path=/", "TOPSECRET"],
    ["a quoted header in logged JSON", '{"Authorization":"Bearer TOPSECRET"}', "TOPSECRET"],
  ];
  for (const [name, text, secret] of cases) {
    it(`removes the whole value of ${name}`, () => {
      assert.equal(new Redactor().redact(text).includes(secret), false);
    });
  }

  it("removes one in a later line, and keeps the lines around it", () => {
    const text = new Redactor().redact("GET /path\nAuthorization: Bearer TOPSECRET\nAccept: */*");
    assert.equal(text.includes("TOPSECRET"), false);
    assert.match(text, /GET \/path/);
    assert.match(text, /Accept/);
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

describe("the export-manifest command", () => {
  it("delivers a manifest far longer than a pipe's buffer, whole", async () => {
    const dir = await tempDir();
    try {
      const state = new State(join(dir.path, "state.sqlite"));
      const total = 3_000;
      for (let index = 0; index < total; index += 1) {
        state.insertCapture({ capture_id: `capture-${index}`, slot_id: null, kind: "manual", local_date: "2026-07-01", frame_received_at: "2026-07-01T13:00:00.000Z", width: 3840, height: 2160, jpeg_bytes: 700_000, sha256: "a".repeat(64), quality_status: "ok", relative_dir: `spool/${"x".repeat(100)}/${index}`, archive_status: "not_configured", created_at: "2026-07-01T13:01:00.000Z" });
      }
      state.close();
      const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "export-manifest"], { env: { ...process.env, TIMELAPSE_DATA_DIR: dir.path }, stdio: ["ignore", "pipe", "inherit"] });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      const [code] = await once(child, "close");
      assert.equal(code, 0);
      assert.ok(output.length > 256 * 1024, `this test needs more than a pipe's worth of output, got ${output.length}`);
      assert.equal(output.trim().split("\n").length, total);
    } finally {
      await dir.remove();
    }
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
