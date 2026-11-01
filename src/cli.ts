#!/usr/bin/env node
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CaptureFailure } from "./adapters/adapter.ts";
import type { CameraAdapter } from "./adapters/adapter.ts";
import { createMegaClient, MegaAdapter } from "./adapters/mega.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { AppConfig } from "./config.ts";
import { CameraLockHeldError, withCameraLock } from "./lock.ts";
import { runLogin } from "./login.ts";
import { createRedactingLogger, Redactor } from "./logging.ts";
import { runProbe } from "./probe/probe.ts";

const USAGE = `Usage: timelapse <command> [options]

Commands:
  login   Log in interactively (2FA, captcha) and store the session
  probe   Run the native-LTE feasibility test

Probe options:
  --attempts <n>           Capture attempts (default 3)
  --interval-minutes <n>   Time between attempts (default 15)
  --stream-seconds <n>     Stream kept open after first media (default 12)
`;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;
const ACQUISITION_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const CAMERA_ID = "site-overview";

function log(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

function buildAdapter(config: AppConfig, persistentDir: string, logPath: string, debugLogs: boolean): CameraAdapter {
  const redactor = new Redactor([config.password, config.email, ...(config.cameraSerial ? [config.cameraSerial] : [])]);
  const logFile = createWriteStream(logPath, { flags: "a" });
  logFile.on("error", (error) => log(`library log unavailable (${logPath}): ${error.message}`));
  const logger = createRedactingLogger(redactor, (line) => logFile.write(line));
  // The SDK has one log level for everything, and login traffic is the wrong place for debug output.
  const sdkLogger = debugLogs ? logger : { ...logger, debug: () => {} };
  const client = createMegaClient({ email: config.email, password: config.password, country: config.country, sessionDir: persistentDir, logger: sdkLogger });
  return new MegaAdapter(client, log, (value) => redactor.addLiteral(value));
}

function positiveNumber(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ConfigError(`--${name} must be a positive number, got "${value}".`);
  return parsed;
}

async function commandLogin(config: AppConfig, dataDir: string, sessionDir: string): Promise<number> {
  const adapter = buildAdapter(config, sessionDir, join(dataDir, "login.log"), false);
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const result = await withCameraLock(join(dataDir, "camera.lock"), () =>
      runLogin({
        adapter,
        dataDir,
        ...(config.cameraSerial ? { cameraSerial: config.cameraSerial } : {}),
        prompt: async (question) => {
          if (process.stdin.isTTY !== true) {
            throw new CaptureFailure("auth_required", "auth", "Eufy needs a code from you, and this session has no terminal. Run the login command from an interactive terminal (ssh -t).");
          }
          return await readline.question(question);
        },
        log,
      }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    readline.close();
    await adapter.shutdown();
  }
}

async function commandProbe(config: AppConfig, dataDir: string, sessionDir: string, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      attempts: { type: "string" },
      "interval-minutes": { type: "string" },
      "stream-seconds": { type: "string" },
    },
  });
  const attempts = positiveNumber(values.attempts, "attempts", 3);
  const intervalMinutes = positiveNumber(values["interval-minutes"], "interval-minutes", 15);
  const streamSeconds = positiveNumber(values["stream-seconds"], "stream-seconds", 12);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(dataDir, "probe", runId);
  mkdirSync(runDir, { recursive: true });
  const adapter = buildAdapter(config, sessionDir, join(runDir, "library.log"), true);

  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    log(`${signal} received: releasing the camera`);
    controller.abort("terminated");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const report = await withCameraLock(join(dataDir, "camera.lock"), () =>
      runProbe({
        adapter,
        runId,
        runDir,
        cameraId: CAMERA_ID,
        ...(config.cameraSerial ? { cameraSerial: config.cameraSerial } : {}),
        attempts,
        intervalMs: intervalMinutes * 60_000,
        streamMs: streamSeconds * 1000,
        acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
        cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
        minWidth: config.minWidth,
        minHeight: config.minHeight,
        link: config.link,
        operator: config.operator,
        signal: controller.signal,
        log,
      }),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    log(`report: ${join(runDir, "report.json")}`);
    if (controller.signal.aborted) return EXIT_INTERRUPTED;
    return report.verdict.result === "pass" ? 0 : EXIT_FAILURE;
  } finally {
    await adapter.shutdown();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "login" && command !== "probe") {
    process.stderr.write(USAGE);
    return EXIT_USAGE;
  }

  // Everything this process writes, including the Eufy session token, stays owner-only.
  process.umask(0o077);
  const config = loadConfig(process.env);
  const dataDir = resolve(config.dataDir);
  const sessionDir = join(dataDir, "session");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  return command === "login" ? await commandLogin(config, dataDir, sessionDir) : await commandProbe(config, dataDir, sessionDir, rest);
}

if (import.meta.main) {
  try {
    // The SDK can leave sockets and timers behind after shutdown, so the exit has to be explicit.
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof CaptureFailure || error instanceof CameraLockHeldError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(error instanceof ConfigError ? EXIT_USAGE : EXIT_FAILURE);
  }
}
