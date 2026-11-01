#!/usr/bin/env node
import { appendFileSync, createWriteStream, mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CaptureFailure } from "./adapters/adapter.ts";
import type { CameraAdapter } from "./adapters/adapter.ts";
import { createMegaClient, MegaAdapter } from "./adapters/mega.ts";
import { createNotifier } from "./alerts.ts";
import { ConfigError, loadConfig, loadSettings } from "./config.ts";
import type { AppConfig, AppSettings } from "./config.ts";
import { CameraLockHeldError, withCameraLock } from "./lock.ts";
import { runLogin } from "./login.ts";
import { createRedactingLogger, Redactor } from "./logging.ts";
import { runProbe } from "./probe/probe.ts";
import { render, RenderError } from "./render.ts";
import { loadServiceConfig } from "./service-config.ts";
import type { ServiceConfig } from "./service-config.ts";
import { CaptureService } from "./service.ts";
import { State } from "./state.ts";
import { buildCalibration, buildStatus } from "./status.ts";

const USAGE = `Usage: timelapse <command> [options]

Commands:
  login            Log in interactively (2FA, captcha) and store the session
  probe            Run the native-LTE feasibility test
  run              Run the capture service
  capture          Take one manual frame now
  status           Show service status (--json for the full report)
  calibration      Battery against capture load, hour by hour (--hours <n>, default 24)
  pause            Stop new captures until resumed
  resume           Clear an operator pause (--battery-checked also overrides a low-battery pause)
  render           Build a video: --from YYYY-MM-DD --to YYYY-MM-DD [--output <file>] [--fps <n>]
                   [--include-manual] [--include-degraded]
  export-manifest  Print every capture as one JSON object per line

Probe options:
  --attempts <n>           Capture attempts (default 3)
  --interval-minutes <n>   Time between attempts (default 15)
`;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;
const REVISION = process.env.TIMELAPSE_REVISION ?? "unknown";
const ACQUISITION_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 10_000;
/** Two, so exposure has settled after the step up, and one bad frame can't cost the shot. */
const TARGET_KEYFRAMES = 2;
const MAX_TRIES = 3;
const RETRY_DELAY_MS = 5_000;
const SLOT_DEADLINE_MS = 180_000;
const CAMERA_ID = "site-overview";

function log(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

function buildAdapter(config: AppConfig, persistentDir: string, write: (line: string) => void, debugLogs: boolean): CameraAdapter {
  const redactor = new Redactor([config.password, config.email, ...(config.cameraSerial ? [config.cameraSerial] : [])]);
  const logger = createRedactingLogger(redactor, write);
  let adapter: MegaAdapter | undefined;
  const sdkLogger = {
    ...logger,
    debug: (message: unknown, ...args: unknown[]): void => {
      if (typeof message === "string" && message.includes("relay ->")) adapter?.noteRelayUsed();
      // The SDK has one log level for everything, and login traffic is the wrong place for debug output.
      if (debugLogs) logger.debug(message, ...args);
    },
  };
  const client = createMegaClient({ email: config.email, password: config.password, country: config.country, sessionDir: persistentDir, logger: sdkLogger });
  adapter = new MegaAdapter(client, log, (value) => redactor.addLiteral(value));
  return adapter;
}

function fileWriter(path: string): (line: string) => void {
  const file = createWriteStream(path, { flags: "a" });
  file.on("error", (error) => log(`library log unavailable (${path}): ${error.message}`));
  return (line) => file.write(line);
}

/** One log file per UTC day, so a long-running service never grows a single file without bound. */
function dailyWriter(directory: string): (line: string) => void {
  mkdirSync(directory, { recursive: true });
  return (line) => {
    appendFileSync(join(directory, `service-${new Date().toISOString().slice(0, 10)}.log`), line);
  };
}

function positiveNumber(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ConfigError(`--${name} must be a positive number, got "${value}".`);
  return parsed;
}

function terminationSignal(): AbortSignal {
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    log(`${signal} received: releasing the camera`);
    controller.abort("terminated");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return controller.signal;
}

interface Paths {
  dataDir: string;
  sessionDir: string;
  databasePath: string;
}

function preparePaths(settings: AppSettings): Paths {
  const dataDir = resolve(settings.dataDir);
  const sessionDir = join(dataDir, "session");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  return { dataDir, sessionDir, databasePath: join(dataDir, "state.sqlite") };
}

function serviceConfigFor(settings: AppSettings, paths: Paths): ServiceConfig {
  return loadServiceConfig(settings.configPath ?? join(paths.dataDir, "config.json"));
}

async function diskFreeMb(dataDir: string): Promise<number> {
  const stats = await statfs(dataDir);
  return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
}

async function commandLogin(paths: Paths): Promise<number> {
  const config = loadConfig(process.env);
  const adapter = buildAdapter(config, paths.sessionDir, fileWriter(join(paths.dataDir, "login.log")), false);
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const result = await withCameraLock(join(paths.dataDir, "camera.lock"), () =>
      runLogin({
        adapter,
        dataDir: paths.dataDir,
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
    // A running service sees this and picks up the fresh session.
    const state = new State(paths.databasePath);
    state.setFlag("auth_required", null);
    state.addEvent("login", "operator completed a login");
    state.close();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    readline.close();
    await adapter.shutdown();
  }
}

async function commandProbe(paths: Paths, args: string[]): Promise<number> {
  const config = loadConfig(process.env);
  const { values } = parseArgs({ args, options: { attempts: { type: "string" }, "interval-minutes": { type: "string" } } });
  const attempts = positiveNumber(values.attempts, "attempts", 3);
  const intervalMinutes = positiveNumber(values["interval-minutes"], "interval-minutes", 15);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(paths.dataDir, "probe", runId);
  mkdirSync(runDir, { recursive: true });
  const adapter = buildAdapter(config, paths.sessionDir, fileWriter(join(runDir, "library.log")), true);
  const signal = terminationSignal();

  try {
    const report = await withCameraLock(join(paths.dataDir, "camera.lock"), () =>
      runProbe({
        adapter,
        runId,
        runDir,
        cameraId: CAMERA_ID,
        ...(config.cameraSerial ? { cameraSerial: config.cameraSerial } : {}),
        attempts,
        intervalMs: intervalMinutes * 60_000,
        targetKeyframes: TARGET_KEYFRAMES,
        maxTries: MAX_TRIES,
        retryDelayMs: RETRY_DELAY_MS,
        slotDeadlineMs: SLOT_DEADLINE_MS,
        acquisitionTimeoutMs: ACQUISITION_TIMEOUT_MS,
        cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
        minWidth: config.minWidth,
        minHeight: config.minHeight,
        link: config.link,
        operator: config.operator,
        signal,
        log,
      }),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    log(`report: ${join(runDir, "report.json")}`);
    if (signal.aborted) return EXIT_INTERRUPTED;
    return report.verdict.result === "pass" ? 0 : EXIT_FAILURE;
  } finally {
    await adapter.shutdown();
  }
}

function buildService(config: AppConfig, service: ServiceConfig, paths: Paths, state: State, write: (line: string) => void): CaptureService {
  return new CaptureService({
    config: service,
    state,
    createAdapter: () => buildAdapter(config, paths.sessionDir, write, service.logging.sdk_debug),
    dataDir: paths.dataDir,
    ...(config.cameraSerial ? { cameraSerial: config.cameraSerial } : {}),
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    link: config.link,
    operator: config.operator,
    log,
    notify: createNotifier(service.alerts.webhook_url_file, log),
  });
}

async function commandRun(paths: Paths): Promise<number> {
  const config = loadConfig(process.env);
  const serviceConfig = serviceConfigFor(config, paths);
  const state = new State(paths.databasePath);
  const write = dailyWriter(join(paths.dataDir, "logs"));
  const service = buildService(config, serviceConfig, paths, state, write);
  const signal = terminationSignal();

  // /healthz says only that this process is alive. Whether frames are arriving is /status's job.
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("alive\n");
      return;
    }
    if (request.url === "/status") {
      diskFreeMb(paths.dataDir).then(
        (free) => {
          response.writeHead(200, { "content-type": "application/json" }).end(`${JSON.stringify(buildStatus(state, serviceConfig, new Date(), free, REVISION), null, 2)}\n`);
        },
        (error: Error) => {
          response.writeHead(500, { "content-type": "text/plain" }).end(`${error.message}\n`);
        },
      );
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(serviceConfig.http.port, serviceConfig.http.bind);
  log(`service running at revision ${REVISION}; status on http://${serviceConfig.http.bind}:${serviceConfig.http.port}/status`);

  await service.run(signal);
  server.close();
  state.close();
  return signal.aborted ? EXIT_INTERRUPTED : 0;
}

async function commandCapture(paths: Paths): Promise<number> {
  const config = loadConfig(process.env);
  const serviceConfig = serviceConfigFor(config, paths);
  const state = new State(paths.databasePath);
  const service = buildService(config, serviceConfig, paths, state, fileWriter(join(paths.dataDir, "capture.log")));
  const result = await service.captureManual(terminationSignal());
  state.close();
  if (result instanceof CaptureFailure) throw result;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function commandStatus(settings: AppSettings, paths: Paths, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
  const state = new State(paths.databasePath);
  const report = buildStatus(state, serviceConfigFor(settings, paths), new Date(), await diskFreeMb(paths.dataDir), REVISION);
  state.close();
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const c = report.completeness_24h;
  const lines = [
    `Last frame: ${report.last_success === null ? "none yet" : `${report.last_success.at} (${report.last_success.age_seconds} s ago), ${report.last_success.width}x${report.last_success.height}`}`,
    `Next slot:  ${report.next_slot?.local_time ?? "none planned"}`,
    `Last 24 h:  ${c.captured_at_target_quality} at target, ${c.captured_degraded} degraded, ${c.missed} missed, of ${c.scheduled} grid slots`,
    `Skipped:    ${JSON.stringify(c.skipped_by_reason)}`,
    `Battery:    ${report.battery.percent ?? "unknown"}%${report.battery.every_minutes === null ? "" : `, capturing every ${report.battery.every_minutes} min`}`,
    `Paused:     ${report.pause_reasons.join(", ") || "no"}`,
    `Alerts:     ${report.active_alerts.join(", ") || "none"}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function commandCalibration(settings: AppSettings, paths: Paths, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { hours: { type: "string" } } });
  const hours = positiveNumber(values.hours, "hours", 24);
  const state = new State(paths.databasePath);
  const report = buildCalibration(state, serviceConfigFor(settings, paths), new Date(Date.now() - hours * 3_600_000));
  state.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

function commandPause(paths: Paths): number {
  const state = new State(paths.databasePath);
  state.setFlag("operator_paused", new Date().toISOString());
  state.addEvent("operator_pause", "paused by operator");
  state.close();
  log("capture paused; the service stays up, and no slot will wake the camera");
  return 0;
}

function commandResume(paths: Paths, args: string[]): number {
  const { values } = parseArgs({ args, options: { "battery-checked": { type: "boolean" } } });
  const state = new State(paths.databasePath);
  state.setFlag("operator_paused", null);
  if (values["battery-checked"] === true) {
    // An explicit override, logged as one. It doesn't turn an old reading into a fresh one.
    state.setFlag("battery_override", new Date().toISOString());
    state.addEvent("battery_override", "operator checked the charge and resumed");
  }
  state.addEvent("operator_resume", "resumed by operator");
  state.close();
  log("capture resumed");
  return 0;
}

async function commandRender(paths: Paths, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      output: { type: "string" },
      fps: { type: "string" },
      "include-manual": { type: "boolean" },
      "include-degraded": { type: "boolean" },
    },
  });
  if (values.from === undefined || values.to === undefined) throw new ConfigError("render needs --from YYYY-MM-DD and --to YYYY-MM-DD.");
  const state = new State(paths.databasePath);
  const manifest = await render({
    state,
    dataDir: paths.dataDir,
    from: values.from,
    to: values.to,
    outputPath: values.output ?? join(paths.dataDir, "renders", `timelapse-${values.from}-to-${values.to}.mp4`),
    fps: positiveNumber(values.fps, "fps", 30),
    includeManual: values["include-manual"] === true,
    includeDegraded: values["include-degraded"] === true,
    now: () => new Date(),
  });
  state.close();
  const { inputs: _inputs, exclusions: _exclusions, ...summary } = manifest;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

function commandExportManifest(paths: Paths): number {
  const state = new State(paths.databasePath);
  for (const capture of state.allCaptures()) process.stdout.write(`${JSON.stringify(capture)}\n`);
  state.close();
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // Everything this process writes, including the Eufy session token, stays owner-only.
  process.umask(0o077);
  const settings = (): { settings: AppSettings; paths: Paths } => {
    const loaded = loadSettings(process.env);
    return { settings: loaded, paths: preparePaths(loaded) };
  };
  switch (command) {
    case "login":
      return await commandLogin(settings().paths);
    case "probe":
      return await commandProbe(settings().paths, rest);
    case "run":
      return await commandRun(settings().paths);
    case "capture":
      return await commandCapture(settings().paths);
    case "status": {
      const loaded = settings();
      return await commandStatus(loaded.settings, loaded.paths, rest);
    }
    case "calibration": {
      const loaded = settings();
      return await commandCalibration(loaded.settings, loaded.paths, rest);
    }
    case "pause":
      return commandPause(settings().paths);
    case "resume":
      return commandResume(settings().paths, rest);
    case "render":
      return await commandRender(settings().paths, rest);
    case "export-manifest":
      return commandExportManifest(settings().paths);
    default:
      process.stderr.write(USAGE);
      return EXIT_USAGE;
  }
}

if (import.meta.main) {
  try {
    // The SDK can leave sockets and timers behind after shutdown, so the exit has to be explicit.
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof CaptureFailure || error instanceof CameraLockHeldError || error instanceof RenderError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(error instanceof ConfigError ? EXIT_USAGE : EXIT_FAILURE);
  }
}
