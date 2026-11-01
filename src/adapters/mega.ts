import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  CameraDisabledError,
  EufyMega,
  FileSessionStore,
  LiveStreamStartError,
  LoginStatus,
  MegaApiError,
  SessionExpiredError,
  StationKeyUnavailableError,
  StationUnreachableError,
} from "@mega-yfue/eufy-sdk";
import { CaptureFailure } from "./adapter.ts";
import { CELLULAR_POLICY, CONNECT_POLICY_VERSION, setConnectPolicy } from "./p2p-policy.ts";
import type {
  AbortCause,
  AuthInput,
  AuthState,
  BatteryReading,
  CameraAdapter,
  CameraInfo,
  CleanupResult,
  FailurePhase,
  FrameSize,
  LiveSession,
  VideoCodecName,
} from "./adapter.ts";

const CAMERA_MODEL_PREFIX = "T86P2";
/** The spec caps the idle window at five seconds. Teardown closes the session sooner than this anyway. */
const P2P_IDLE_MS = 5_000;
const CLOSE_POLL_MS = 100;
const SWEEP_INTERVAL_MS = 5_000;
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set(["ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);
/** What the pinned SDK says when it can't set up a session. test/mega-adapter.test.ts holds these wordings. */
const SDK_CONNECT_FAILURE = /^P2P connect timeout for |^station .* is not in the device list$|^no P2P endpoint \(p2p_did\) for station /;
const TELEMETRY_NAME = /signal|rssi|band|cellular|network|lte|charging|solar|power|quality/i;
const TELEMETRY_EXCLUDED = /imei|iccid|imsi|mac|ssid|serial|ip_?addr/i;

export type MegaLoginResult = { status: "ok" } | { status: "captcha"; image: string } | { status: "2fa" };

export interface MegaLiveStream {
  on(event: "video-config", listener: (config: { width: number; height: number }) => void): unknown;
  on(event: "video", listener: (frame: { data: Buffer; codec: string; width: number; height: number; keyframe: boolean }) => void): unknown;
  on(event: "audio", listener: (frame: { data: Buffer }) => void): unknown;
  on(event: "stop", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  stop(): void;
}

export interface MegaDevice {
  stationSn: string;
  camera?(): { live?(options: { signal: AbortSignal }): Promise<MegaLiveStream> } | undefined;
  info?(): { firmwareVersion?: string } | undefined;
  getProperty(name: string): { value: unknown } | undefined;
  getProperties(): Record<string, { value: unknown }>;
}

/** The part of EufyMega this adapter uses. Tests supply a fake. */
export interface MegaClient {
  login(): Promise<MegaLoginResult>;
  submitVerifyCode(code: string): Promise<MegaLoginResult>;
  solveCaptcha(answer: string): Promise<MegaLoginResult>;
  getDevices(): Promise<Array<{ sn: string; model: string }>>;
  getDevice(serial: string): Promise<MegaDevice>;
  connectStation(serial: string, signal?: AbortSignal): Promise<void>;
  getP2pSessions(): Map<string, unknown>;
  deviceState(serial: string): { lastSeenMs?: number };
  disconnect(): Promise<void>;
}

export interface MegaClientOptions {
  email: string;
  password: string;
  country: string;
  sessionDir: string;
  logger: { debug(message: string, ...args: unknown[]): void; info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void; error(message: string, ...args: unknown[]): void };
}

export function createMegaClient(options: MegaClientOptions): MegaClient {
  setConnectPolicy(CELLULAR_POLICY);
  const client = new EufyMega({
    email: options.email,
    password: options.password,
    countryCode: options.country,
    store: new FileSessionStore(join(options.sessionDir, "eufy-sdk-session.json")),
    logger: options.logger,
    // Nothing reaches this camera unless an attempt asks. These are the SDK's opt-outs from background work.
    autoRealtime: false,
    pollMs: 0,
    prewarmEvents: [],
    // A retained thumbnail must never be able to pass for a fresh frame.
    storedSnapshotCache: false,
    p2pIdleMs: P2P_IDLE_MS,
    // The camera is on cellular, so a LAN broadcast can't find it and only adds noise to the NAS's network.
    noBroadcast: true,
  });
  // With no listener, EventEmitter throws an "error" event and takes the whole process down.
  client.on("error", (error) => options.logger.error("SDK error", error));
  // Device's capability accessors are generated at runtime, which TypeScript can't relate to this shape.
  return client as unknown as MegaClient;
}

/** The SDK doesn't export its own version, so read the exact pin from this project's manifest. */
function pinnedVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  return manifest.dependencies["@mega-yfue/eufy-sdk"] ?? "unknown";
}

function codecName(codec: string): VideoCodecName {
  if (codec === "h265") return "h265";
  if (codec === "h264") return "h264";
  return "unknown";
}

function readBattery(device: MegaDevice, lastSeenMs: number | undefined): BatteryReading {
  const value = device.getProperty("battery")?.value;
  if (typeof value !== "number") {
    return { percent: null, observedAt: null, note: "cloud returned no battery value" };
  }
  if (lastSeenMs === undefined) return { percent: value, observedAt: null, note: "the cloud gave no report time for this camera" };
  // The newest time on any of the camera's values. The battery's own time isn't exposed, so it may be older than this.
  return { percent: value, observedAt: new Date(lastSeenMs).toISOString(), note: "newest report from the camera; the battery value is at least this old" };
}

function readTelemetry(device: MegaDevice): Record<string, string | number | boolean> {
  const telemetry: Record<string, string | number | boolean> = {};
  for (const [name, property] of Object.entries(device.getProperties())) {
    if (!TELEMETRY_NAME.test(name) || TELEMETRY_EXCLUDED.test(name)) continue;
    const { value } = property;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") telemetry[name] = value;
  }
  return telemetry;
}

function cloudUnreachable(error: Error, phase: FailurePhase): CaptureFailure {
  return new CaptureFailure("camera_unreachable", phase, `Eufy's cloud can't be reached right now (${error.message}). Check this host's internet connection. The next slot tries again by itself.`, { cause: error });
}

function authFailure(error: Error): CaptureFailure {
  return new CaptureFailure("auth_required", "auth", `Eufy login failed: ${error.message}. Check the Eufy credentials, then run the login command.`, { cause: error });
}

/** The network being down, however Node reports it. */
function isNetworkError(error: unknown): error is Error {
  // fetch's own report. The cause varies, the message doesn't.
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  return error instanceof Error && NETWORK_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

/** Eufy's cloud having a bad moment, as opposed to refusing this account. */
function isTransientApiError(error: unknown): error is MegaApiError {
  if (!(error instanceof MegaApiError)) return false;
  const { status } = error;
  return status === undefined || status >= 500 || status === 408 || status === 429;
}

function isCameraError(error: unknown): error is Error {
  return (
    error instanceof StationUnreachableError ||
    error instanceof LiveStreamStartError ||
    error instanceof StationKeyUnavailableError ||
    error instanceof CameraDisabledError ||
    error instanceof MegaApiError ||
    isNetworkError(error) ||
    // The SDK rejects these as plain Errors, so their wording is all there is to go on. A bug propagates instead.
    (error instanceof Error && error.name === "Error" && SDK_CONNECT_FAILURE.test(error.message))
  );
}

export class MegaAdapter implements CameraAdapter {
  readonly name = "@mega-yfue/eufy-sdk";
  readonly version = `${pinnedVersion()}+${CONNECT_POLICY_VERSION}`;

  private readonly client: MegaClient;
  private readonly warn: (message: string) => void;
  private readonly registerSecret: (value: string) => void;
  private readonly sweepTimer: NodeJS.Timeout;
  private stream: MegaLiveStream | undefined;
  private attemptActive = false;
  private relayUsed = false;
  private loginNeeded = false;
  private unexpectedConnections = 0;

  constructor(client: MegaClient, warn: (message: string) => void, registerSecret: (value: string) => void) {
    this.client = client;
    this.warn = warn;
    this.registerSecret = registerSecret;
    this.sweepTimer = setInterval(() => void this.sweepConnections(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** The SDK reports its relay handshake only in its logs, so the logger passes that along. */
  noteRelayUsed(): void {
    this.relayUsed = true;
  }

  /** The SDK shouldn't open a session on its own here. If it ever does, that's a battery wake: close and count it. */
  async sweepConnections(): Promise<void> {
    if (this.attemptActive || this.client.getP2pSessions().size === 0) return;
    this.unexpectedConnections += 1;
    this.warn("closed a camera connection that opened outside a capture attempt");
    await this.client.disconnect();
    this.loginNeeded = true;
  }

  async authenticate(input?: AuthInput): Promise<AuthState> {
    let result: MegaLoginResult;
    try {
      if (input === undefined) result = await this.client.login();
      else if ("verifyCode" in input) result = await this.client.submitVerifyCode(input.verifyCode);
      else result = await this.client.solveCaptcha(input.captcha.code);
    } catch (error) {
      // Only a real refusal means a person has to log in. An outage mustn't stop captures until someone does.
      if (isNetworkError(error) || isTransientApiError(error)) throw cloudUnreachable(error, "auth");
      if (error instanceof MegaApiError || error instanceof SessionExpiredError) throw authFailure(error);
      throw error;
    }
    if (result.status === LoginStatus.Ok) return { status: "authenticated" };
    if (result.status === LoginStatus.TwoFactor) return { status: "tfa_required" };
    // The SDK keeps the challenge itself, so there is no id to carry.
    return { status: "captcha_required", captchaId: "", captchaImage: result.image };
  }

  /** disconnect() keeps the login, and this restores it with no network call. */
  private async restoreLogin(): Promise<void> {
    if (!this.loginNeeded) return;
    const state = await this.authenticate();
    if (state.status !== "authenticated") {
      throw new CaptureFailure("auth_required", "auth", "Eufy needs a manual login step. Run the login command in a terminal.");
    }
    this.loginNeeded = false;
  }

  private async deviceFor(key: string): Promise<MegaDevice> {
    try {
      return await this.client.getDevice(key);
    } catch (error) {
      if (error instanceof SessionExpiredError) throw authFailure(error);
      if (isCameraError(error)) throw cloudUnreachable(error, "discovery");
      throw error;
    }
  }

  async discoverCamera(preferredKey?: string): Promise<CameraInfo> {
    await this.restoreLogin();
    let listed: Array<{ sn: string; model: string }>;
    try {
      listed = await this.client.getDevices();
    } catch (error) {
      if (error instanceof SessionExpiredError) throw authFailure(error);
      if (isCameraError(error)) throw cloudUnreachable(error, "discovery");
      throw error;
    }
    const matches = listed.filter((device) => (preferredKey === undefined ? device.model.startsWith(CAMERA_MODEL_PREFIX) : device.sn === preferredKey));
    const seen = listed.map((device) => device.model).join(", ") || "no devices";
    const [match, ...others] = matches;
    if (match === undefined) {
      // The SDK reports an empty list when it can't reach the cloud at all, not an error.
      const offline = listed.length === 0 ? "Check this host's internet connection first: an outage looks the same as an empty account. " : "";
      throw new CaptureFailure(
        "camera_not_found",
        "discovery",
        `${offline}No matching ${CAMERA_MODEL_PREFIX} on this account (it sees: ${seen}). If this is a separate account, share the camera to it from the owner account, then accept the invitation in the eufy app while logged in as that account.`,
      );
    }
    if (others.length > 0) {
      throw new CaptureFailure("camera_not_found", "discovery", `This account sees ${matches.length} ${CAMERA_MODEL_PREFIX} cameras. Set EUFY_CAMERA_SERIAL to pick one.`);
    }
    this.registerSecret(match.sn);
    const device = await this.deviceFor(match.sn);
    this.registerSecret(device.stationSn);
    return {
      key: match.sn,
      model: match.model,
      firmware: device.info?.()?.firmwareVersion ?? null,
      // A standalone battery camera, by the SDK's own account of its power tiers.
      energySaving: true,
      battery: readBattery(device, this.client.deviceState(match.sn).lastSeenMs),
      telemetry: readTelemetry(device),
    };
  }

  private failureFrom(error: unknown, phase: FailurePhase, signal: AbortSignal): CaptureFailure {
    if (signal.aborted) {
      if ((signal.reason as AbortCause) === "terminated") return new CaptureFailure("aborted", phase, "Stopped by a termination signal.", { cause: error });
      return phase === "connect"
        ? new CaptureFailure("camera_unreachable", phase, "No P2P connection to the camera before the attempt deadline.", { cause: error })
        : new CaptureFailure("capture_timeout", phase, "The camera connected, but the live stream did not start before the attempt deadline.", { cause: error });
    }
    if (isCameraError(error)) return new CaptureFailure("camera_unreachable", phase, `${error.name}: ${error.message}`, { cause: error });
    throw error;
  }

  async openLiveSession(cameraKey: string, signal: AbortSignal): Promise<LiveSession> {
    this.attemptActive = true;
    this.relayUsed = false;
    await this.restoreLogin();

    const device = await this.deviceFor(cameraKey);
    const camera = device.camera?.();
    if (camera?.live === undefined) {
      throw new CaptureFailure("camera_unreachable", "stream_start", "The SDK exposes no live video path for this camera.");
    }
    const coldConnection = !this.client.getP2pSessions().has(device.stationSn);

    const startedAt = Date.now();
    try {
      await this.client.connectStation(cameraKey, signal);
    } catch (error) {
      throw this.failureFrom(error, "connect", signal);
    }
    const connectMs = Date.now() - startedAt;

    let stream: MegaLiveStream;
    try {
      stream = await camera.live({ signal });
    } catch (error) {
      throw this.failureFrom(error, "stream_start", signal);
    }
    this.stream = stream;

    const video = new PassThrough();
    const audio = new PassThrough();
    const keyframeListeners: Array<(size: FrameSize) => void> = [];
    // The SDK's stated authority on size. A frame's own width and height are only what its header reported.
    let codedSize: FrameSize | undefined;
    const session: LiveSession = {
      codec: "unknown",
      reportedWidth: null,
      reportedHeight: null,
      reportedFps: null,
      video,
      audio,
      connectMs,
      connectRetries: 0,
      coldConnection,
      connectionPath: this.relayUsed ? "relay" : "direct",
      onKeyframe: (listener) => {
        keyframeListeners.push(listener);
      },
    };
    stream.on("video-config", (config) => {
      codedSize = { width: config.width, height: config.height };
    });
    stream.on("video", (frame) => {
      session.codec = codecName(frame.codec);
      session.reportedWidth = frame.width;
      session.reportedHeight = frame.height;
      video.write(frame.data);
      if (frame.keyframe) {
        const size = codedSize ?? { width: frame.width, height: frame.height };
        for (const listener of keyframeListeners) listener(size);
      }
    });
    stream.on("audio", (frame) => audio.write(frame.data));
    stream.on("stop", () => {
      video.end();
      audio.end();
    });
    stream.on("error", (error) => video.destroy(error));
    return session;
  }

  async teardown(_cameraKey: string, timeoutMs: number): Promise<CleanupResult> {
    const problems: string[] = [];
    this.stream?.stop();
    this.stream = undefined;
    await this.client.disconnect().catch((error: Error) => {
      problems.push(`disconnect failed: ${error.message}`);
    });
    this.loginNeeded = true;

    const deadline = Date.now() + timeoutMs;
    while (this.client.getP2pSessions().size > 0 && Date.now() < deadline) {
      await delay(CLOSE_POLL_MS);
    }
    const stillOpen = this.client.getP2pSessions().size > 0;
    // The sweep is live again from here, so anything that opens after this point is caught and counted.
    this.attemptActive = false;
    if (stillOpen) {
      problems.push(`camera connection still open ${timeoutMs} ms after disconnect`);
      return { status: "timeout", detail: problems.join("; ") };
    }
    return problems.length > 0 ? { status: "error", detail: problems.join("; ") } : { status: "ok", detail: null };
  }

  unexpectedConnectionCount(): number {
    return this.unexpectedConnections;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweepTimer);
    await this.client.disconnect();
  }
}
