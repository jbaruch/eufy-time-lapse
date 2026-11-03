import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
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
  AuthChallenge,
  AuthInput,
  AuthState,
  BatteryReading,
  CameraAdapter,
  CameraInfo,
  CleanupResult,
  FailurePhase,
  FrameSize,
  LiveSession,
  LoginRenewal,
  VideoCodecName,
} from "./adapter.ts";

const CAMERA_MODEL_PREFIX = "T86P2";
/** The spec caps the idle window at five seconds. Teardown closes the session sooner than this anyway. */
const P2P_IDLE_MS = 5_000;
const CLOSE_POLL_MS = 100;
const SWEEP_INTERVAL_MS = 5_000;
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set(["ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);
const SOCKET_GONE_CODES: ReadonlySet<string> = new Set(["ERR_SOCKET_DGRAM_NOT_RUNNING", "ERR_SOCKET_CLOSED", "ERR_STREAM_DESTROYED", "EBADF"]);
/** What the pinned SDK says when it can't set up a session. test/mega-adapter.test.ts holds these wordings. */
const SDK_CONNECT_FAILURE = /^P2P connect timeout for |^station .* is not in the device list$|^no P2P endpoint \(p2p_did\) for station /;
const TELEMETRY_NAME = /signal|rssi|band|cellular|network|lte|charging|solar|power|quality/i;
const TELEMETRY_EXCLUDED = /imei|iccid|imsi|mac|ssid|serial|ip_?addr/i;

export type MegaLoginResult = { status: "ok" } | { status: "captcha"; image: string } | { status: "2fa" };

const SESSION_FILE = "eufy-sdk-session.json";
const RENEWAL_DIR_PREFIX = "renewal-";
const MAX_RENEWAL_STEPS = 5;
const TRUST_LIST_TIMEOUT_MS = 20_000;

/** The SDK's HTTP client, for the trusted-device calls it doesn't wrap. test/mega-adapter.test.ts checks these against the real class. */
export interface SecurityApi {
  securityAppPost(path: string, body: Record<string, unknown>): Promise<unknown>;
  securityAppHost(): string;
  baseHeaders(): Record<string, string>;
  authTokenHeaders(): Record<string, string>;
}

/** Eufy checks the code here too, and answers 26050 for a wrong one. */
export async function addTrustedDevice(api: SecurityApi, code: string): Promise<void> {
  await api.securityAppPost("/v1/app/trust_device/add", { verify_code: code, transaction: `${Date.now()}` });
}

/** A plain GET, unlike the add. Going around the SDK also keeps a surprise 401 from clearing the session. */
export async function isTrustedDevice(api: SecurityApi, fetchTrustList: typeof fetch = fetch): Promise<boolean> {
  const response = await fetchTrustList(`https://${api.securityAppHost()}/v1/app/trust_device/list`, {
    headers: { ...api.baseHeaders(), ...api.authTokenHeaders() },
    signal: AbortSignal.timeout(TRUST_LIST_TIMEOUT_MS),
  });
  let envelope: { code?: number; data?: { list?: Array<{ is_current_device?: number }> } };
  try {
    envelope = JSON.parse(await response.text()) as typeof envelope;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new MegaApiError("trust_device/list didn't answer in JSON", undefined, response.status);
  }
  if (response.status !== 200 || envelope.code !== 0) throw new MegaApiError(`trust_device/list failed (${response.status}/${envelope.code})`, envelope.code, response.status);
  return (envelope.data?.list ?? []).some((device) => device.is_current_device === 1);
}

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
  addTrustedDevice(code: string): Promise<void>;
  isTrustedDevice(): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface MegaClientOptions {
  email: string;
  password: string;
  country: string;
  sessionDir: string;
  logger: { debug(message: string, ...args: unknown[]): void; info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void; error(message: string, ...args: unknown[]): void };
  /** Gets a programming error the SDK emits, which nothing can catch. By default it ends the process, as any bug should. */
  onFatal?: (error: Error) => void;
}

function crash(error: Error): void {
  setImmediate(() => {
    throw error;
  });
}

/**
 * Tells a bug from the rest of what the SDK emits. Most of it reports trouble the SDK has already handled, like a packet it
 * couldn't parse, and each try's own deadline bounds what that can cost. Ending the process over those would lose frames.
 */
export function isProgrammingError(error: unknown): error is Error {
  if (error instanceof TypeError) return error.message !== "fetch failed";
  return error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError;
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
  client.on("error", (error) => {
    if (isProgrammingError(error)) (options.onFatal ?? crash)(error);
    else options.logger.error("SDK error", error);
  });
  const api = client.api as unknown as SecurityApi;
  // Device's capability accessors are generated at runtime, which TypeScript can't relate to this shape.
  return Object.assign(client, {
    addTrustedDevice: (code: string): Promise<void> => addTrustedDevice(api, code),
    isTrustedDevice: (): Promise<boolean> => isTrustedDevice(api),
  }) as unknown as MegaClient;
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
  // Not a charge at all, so it can't choose a rate, and the record couldn't hold it.
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return { percent: null, observedAt: null, note: `cloud returned a battery value that isn't a percentage: ${value}` };
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

/** How closing a session fails: the network, or a socket already gone. Anything else, even with a code, is a bug. */
function isDisconnectFailure(error: unknown): error is Error {
  const code = (error as NodeJS.ErrnoException).code ?? "";
  return error instanceof Error && (NETWORK_ERROR_CODES.has(code) || SOCKET_GONE_CODES.has(code));
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

/** A trust call failing, which costs the next login a code and costs this one nothing. A bug propagates instead. */
function isTrustFailure(error: unknown): error is Error {
  return error instanceof MegaApiError || error instanceof SessionExpiredError || isNetworkError(error) || (error instanceof Error && error.name === "TimeoutError");
}

/** How the SDK rejects when its signal fires: the signal's own reason, a DOMException, or a plain "aborted". */
function isAbortRejection(error: unknown, signal: AbortSignal): boolean {
  if (error === signal.reason) return true;
  return error instanceof Error && (error.name === "AbortError" || error.message === "aborted");
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

/** Where the stored login lives, and how to get a second client for logging in beside it. */
export interface LoginStore {
  sessionDir: string;
  createClient: (sessionDir: string) => MegaClient;
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
  private readonly identifiers = new Set<string>();
  private readonly onFatal: (error: Error) => void;
  private readonly loginStore: LoginStore | undefined;

  /** `onFatal` gets a failure on a background timer, which nothing can catch. By default it ends the process, as any bug should. */
  constructor(client: MegaClient, warn: (message: string) => void, registerSecret: (value: string) => void, onFatal?: (error: Error) => void, loginStore?: LoginStore) {
    this.client = client;
    this.loginStore = loginStore;
    this.onFatal = onFatal ?? crash;
    this.warn = warn;
    this.registerSecret = registerSecret;
    this.sweepTimer = setInterval(() => {
      this.sweepConnections().catch((error: Error) => this.onFatal(error));
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private identify(value: string): void {
    if (this.identifiers.has(value)) return;
    this.identifiers.add(value);
    this.registerSecret(value);
  }

  /** The SDK's messages quote the camera's serial, and these reach logs and reports that the log redactor never sees. */
  private scrub(text: string): string {
    let scrubbed = text;
    for (const identifier of this.identifiers) scrubbed = scrubbed.replaceAll(identifier, "[camera]");
    return scrubbed;
  }

  private cloudUnreachable(error: Error, phase: FailurePhase): CaptureFailure {
    return new CaptureFailure("camera_unreachable", phase, `Eufy's cloud can't be reached right now (${this.scrub(error.message)}). Check this host's internet connection. The next slot tries again by itself.`, { cause: error });
  }

  private authFailure(error: Error): CaptureFailure {
    return new CaptureFailure("auth_required", "auth", `Eufy login failed: ${this.scrub(error.message)}. Check the Eufy credentials, then run the login command.`, { cause: error });
  }

  private manualLoginStep(cause?: Error): CaptureFailure {
    return new CaptureFailure("auth_required", "auth", "Eufy needs a manual login step. Run the login command in a terminal.", { cause });
  }

  /**
   * A token that ended before the service renewed it. By now the SDK's own re-login has failed, for a reason its error
   * doesn't give, and only a person being needed should stop captures. The login itself tells an outage from a refusal.
   */
  private async sessionFailure(error: SessionExpiredError, phase: FailurePhase): Promise<CaptureFailure> {
    const retry = (detail: string): CaptureFailure => new CaptureFailure("camera_unreachable", phase, `${detail} The next try is automatic.`, { cause: error });
    // Inside the SDK's hold-off, where another login would only trade one token for another. Waiting is the cure.
    if (error.contended) return retry(`Eufy rejected the login token (${this.scrub(error.message)}).`);
    const state = await this.authenticate();
    if (state.status !== "authenticated") return this.manualLoginStep(error);
    return retry("Eufy rejected the login token, and logging in again worked.");
  }

  /** The SDK reports its relay handshake only in its logs, so the logger passes that along. */
  noteRelayUsed(): void {
    this.relayUsed = true;
  }

  /** The SDK shouldn't open a session on its own here. If it ever does, that's a battery wake: close and count it. */
  async sweepConnections(): Promise<void> {
    if (this.attemptActive || this.client.getP2pSessions().size === 0) return;
    this.unexpectedConnections += 1;
    // disconnect() ends the login too, whether or not it closes cleanly, so the next attempt restores it either way.
    this.loginNeeded = true;
    try {
      await this.client.disconnect();
      this.warn("closed a camera connection that opened outside a capture attempt");
    } catch (error) {
      if (!isDisconnectFailure(error)) throw error;
      this.warn(`couldn't close a camera connection that opened outside a capture attempt, and will try again: ${this.scrub(error.message)}`);
    }
  }

  async authenticate(input?: AuthInput): Promise<AuthState> {
    return this.loginStep(this.client, input);
  }

  loginExpiresAt(): Date | null {
    if (this.loginStore === undefined) return null;
    const seconds = new FileSessionStore(join(this.loginStore.sessionDir, SESSION_FILE)).load()?.tokenExpiresAt;
    return seconds === undefined || seconds === 0 ? null : new Date(seconds * 1000);
  }

  /** A crash can leave a renewal's directory behind, holding a token. */
  private async removeLeftoverRenewals(sessionDir: string): Promise<void> {
    for (const entry of await readdir(sessionDir)) {
      if (entry.startsWith(RENEWAL_DIR_PREFIX)) await rm(join(sessionDir, entry), { recursive: true, force: true });
    }
  }

  async renewLogin(answer?: (challenge: AuthChallenge) => Promise<AuthInput>): Promise<LoginRenewal> {
    if (this.loginStore === undefined) throw new Error("This adapter has no login store to renew.");
    const { sessionDir, createClient } = this.loginStore;
    await this.removeLeftoverRenewals(sessionDir);
    const directory = await mkdtemp(join(sessionDir, RENEWAL_DIR_PREFIX));
    const spare = createClient(directory);
    try {
      let input: AuthInput | undefined;
      for (let step = 0; step < MAX_RENEWAL_STEPS; step += 1) {
        const state = await this.loginStep(spare, input);
        if (state.status === "authenticated") {
          const trusted = input !== undefined && "verifyCode" in input ? await this.trust(spare, input.verifyCode) : null;
          await this.closeClient(spare);
          await rename(join(directory, SESSION_FILE), join(sessionDir, SESSION_FILE));
          return { status: "renewed", trusted };
        }
        if (answer === undefined) return { status: "needs_person" };
        input = await answer(state);
      }
      return { status: "needs_person" };
    } finally {
      await this.closeClient(spare);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async isDeviceTrusted(): Promise<boolean | null> {
    try {
      return await this.client.isTrustedDevice();
    } catch (error) {
      if (!isTrustFailure(error)) throw error;
      this.warn(`couldn't ask Eufy whether this device is trusted: ${this.scrub(error.message)}`);
      return null;
    }
  }

  async trustDevice(code: string): Promise<boolean> {
    return this.trust(this.client, code);
  }

  private async trust(client: MegaClient, code: string): Promise<boolean> {
    try {
      await client.addTrustedDevice(code);
      return await client.isTrustedDevice();
    } catch (error) {
      if (!isTrustFailure(error)) throw error;
      this.warn(`logged in, but Eufy didn't make this device trusted, so renewing the login will ask for a code again: ${this.scrub(error.message)}`);
      return false;
    }
  }

  private async closeClient(client: MegaClient): Promise<void> {
    await client.disconnect().catch((error: unknown) => {
      if (!isDisconnectFailure(error)) throw error;
      this.warn(`the camera client didn't shut down cleanly: ${this.scrub(error.message)}`);
    });
  }

  private async loginStep(client: MegaClient, input?: AuthInput): Promise<AuthState> {
    let result: MegaLoginResult;
    try {
      if (input === undefined) result = await client.login();
      else if ("verifyCode" in input) result = await client.submitVerifyCode(input.verifyCode);
      else result = await client.solveCaptcha(input.captcha.code);
    } catch (error) {
      // Only a real refusal means a person has to log in. An outage mustn't stop captures until someone does.
      if (isNetworkError(error) || isTransientApiError(error)) throw this.cloudUnreachable(error, "auth");
      if (error instanceof MegaApiError || error instanceof SessionExpiredError) throw this.authFailure(error);
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
    if (state.status !== "authenticated") throw this.manualLoginStep();
    this.loginNeeded = false;
  }

  private async deviceFor(key: string): Promise<MegaDevice> {
    try {
      return await this.client.getDevice(key);
    } catch (error) {
      if (error instanceof SessionExpiredError) throw await this.sessionFailure(error, "discovery");
      if (isCameraError(error)) throw this.cloudUnreachable(error, "discovery");
      throw error;
    }
  }

  async discoverCamera(preferredKey?: string): Promise<CameraInfo> {
    if (preferredKey !== undefined) this.identify(preferredKey);
    await this.restoreLogin();
    let listed: Array<{ sn: string; model: string }>;
    try {
      listed = await this.client.getDevices();
    } catch (error) {
      if (error instanceof SessionExpiredError) throw await this.sessionFailure(error, "discovery");
      if (isCameraError(error)) throw this.cloudUnreachable(error, "discovery");
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
    this.identify(match.sn);
    const device = await this.deviceFor(match.sn);
    this.identify(device.stationSn);
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

  private async failureFrom(error: unknown, phase: FailurePhase, signal: AbortSignal): Promise<CaptureFailure> {
    // Only a failure that's about the abort counts as one. A bug that happens to land after the deadline is still a bug.
    if (signal.aborted && (isAbortRejection(error, signal) || isCameraError(error))) {
      if ((signal.reason as AbortCause) === "terminated") return new CaptureFailure("aborted", phase, "Stopped by a termination signal.", { cause: error });
      return phase === "connect"
        ? new CaptureFailure("camera_unreachable", phase, "No P2P connection to the camera before the attempt deadline.", { cause: error })
        : new CaptureFailure("capture_timeout", phase, "The camera connected, but the live stream did not start before the attempt deadline.", { cause: error });
    }
    if (error instanceof SessionExpiredError) return this.sessionFailure(error, phase);
    if (isCameraError(error)) return new CaptureFailure("camera_unreachable", phase, `${error.name}: ${this.scrub(error.message)}`, { cause: error });
    throw error;
  }

  async openLiveSession(cameraKey: string, signal: AbortSignal): Promise<LiveSession> {
    this.attemptActive = true;
    this.relayUsed = false;
    await this.restoreLogin();

    this.identify(cameraKey);
    const device = await this.deviceFor(cameraKey);
    this.identify(device.stationSn);
    const camera = device.camera?.();
    if (camera?.live === undefined) {
      throw new CaptureFailure("camera_unreachable", "stream_start", "The SDK exposes no live video path for this camera.");
    }
    const coldConnection = !this.client.getP2pSessions().has(device.stationSn);

    const startedAt = Date.now();
    try {
      await this.client.connectStation(cameraKey, signal);
    } catch (error) {
      throw await this.failureFrom(error, "connect", signal);
    }
    const connectMs = Date.now() - startedAt;

    let stream: MegaLiveStream;
    try {
      stream = await camera.live({ signal });
    } catch (error) {
      throw await this.failureFrom(error, "stream_start", signal);
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
      // The stream can still deliver after it has stopped. Writing then would be an error with nobody listening.
      if (video.writableEnded || video.destroyed) return;
      video.write(frame.data);
      if (frame.keyframe) {
        const size = codedSize ?? { width: frame.width, height: frame.height };
        for (const listener of keyframeListeners) listener(size);
      }
    });
    stream.on("audio", (frame) => {
      if (!audio.writableEnded && !audio.destroyed) audio.write(frame.data);
    });
    stream.on("stop", () => {
      video.end();
      audio.end();
    });
    stream.on("error", (error) => {
      // A bug stays a bug, whatever reported it. This attempt still ends now, instead of at its deadline.
      if (isProgrammingError(error)) this.onFatal(error);
      video.destroy(new Error(this.scrub(error.message), { cause: error }));
    });
    return session;
  }

  async teardown(_cameraKey: string, timeoutMs: number): Promise<CleanupResult> {
    const problems: string[] = [];
    this.stream?.stop();
    this.stream = undefined;
    await this.client.disconnect().catch((error: unknown) => {
      if (!isDisconnectFailure(error)) throw error;
      problems.push(`disconnect failed: ${this.scrub(error.message)}`);
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
    await this.closeClient(this.client);
  }
}
