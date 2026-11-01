import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  CommandType,
  EufySecurity,
  LogLevel,
  P2PConnectionType,
  PropertyName,
  VideoCodec,
  libVersion,
} from "eufy-security-client";
import type { EufySecurityConfig, Logger, StreamMetadata } from "eufy-security-client";
import { CaptureFailure } from "./adapter.ts";
import type {
  AbortCause,
  AuthInput,
  AuthState,
  BatteryReading,
  CameraAdapter,
  CameraInfo,
  CleanupResult,
  FailurePhase,
  LiveSession,
  VideoCodecName,
} from "./adapter.ts";

const CAMERA_MODEL_PREFIX = "T86P2";
const AUTH_TIMEOUT_MS = 120_000;
const CLOSE_POLL_MS = 100;

const TELEMETRY_PROPERTIES = [
  PropertyName.DeviceCellularRSSI,
  PropertyName.DeviceCellularSignalLevel,
  PropertyName.DeviceCellularSignal,
  PropertyName.DeviceCellularBand,
  PropertyName.DeviceWifiRSSI,
  PropertyName.DeviceWifiSignalLevel,
  PropertyName.DeviceChargingStatus,
  PropertyName.DevicePowerSource,
  PropertyName.DeviceVideoStreamingQuality,
];

export interface LegacyDevice {
  getSerial(): string;
  getStationSerial(): string;
  getModel(): string;
  getSoftwareVersion(): string;
  hasProperty(name: string): boolean;
  getPropertyValue(name: string): unknown;
  getRawDevice(): { params?: Array<{ param_type: number; update_time: number }> };
}

export interface LegacyStation {
  getSerial(): string;
  isConnected(): boolean;
  isEnergySavingDevice(): boolean;
  isLiveStreaming(device: LegacyDevice): boolean;
  close(): void;
}

export interface LegacyEvents {
  connect: () => void;
  "connection error": (error: Error) => void;
  "tfa request": () => void;
  "captcha request": (id: string, captcha: string) => void;
  "station connect": (station: LegacyStation) => void;
  "station connection error": (station: LegacyStation, error: Error) => void;
  "station close": (station: LegacyStation) => void;
  "station livestream start": (
    station: LegacyStation,
    device: LegacyDevice,
    metadata: StreamMetadata,
    video: Readable,
    audio: Readable,
  ) => void;
}

/** The part of EufySecurity this adapter uses. Tests supply a fake. */
export interface LegacyClient {
  on<E extends keyof LegacyEvents>(event: E, listener: LegacyEvents[E]): unknown;
  off<E extends keyof LegacyEvents>(event: E, listener: LegacyEvents[E]): unknown;
  isConnected(): boolean;
  connect(options: { verifyCode?: string; captcha?: { captchaId: string; captchaCode: string }; force: boolean }): Promise<void>;
  refreshCloudData(): Promise<void>;
  getDevices(): Promise<LegacyDevice[]>;
  getDevice(serial: string): Promise<LegacyDevice>;
  getStation(serial: string): Promise<LegacyStation>;
  connectToStation(serial: string, type: P2PConnectionType): Promise<void>;
  startStationLivestream(serial: string): Promise<void>;
  stopStationLivestream(serial: string): Promise<void>;
  setCameraMaxLivestreamDuration(seconds: number): void;
  close(): void;
}

export interface LegacyClientOptions {
  email: string;
  password: string;
  country: string;
  acceptInvitations: boolean;
  /** Must already exist: the library silently falls back to a path inside node_modules otherwise. */
  persistentDir: string;
  logger: Logger;
}

export async function createLegacyClient(options: LegacyClientOptions): Promise<LegacyClient> {
  const config: EufySecurityConfig = {
    username: options.email,
    password: options.password,
    country: options.country,
    language: "en",
    trustedDeviceName: "timelapse-service",
    persistentDir: options.persistentDir,
    p2pConnectionSetup: P2PConnectionType.QUICKEST,
    // No background cloud polling. Reads happen on request, and each refresh can trigger station connects.
    pollingIntervalMinutes: 0,
    eventDurationSeconds: 10,
    acceptInvitations: options.acceptInvitations,
    // main and http debug output carries tokens and login data, so only p2p goes to debug.
    logging: { level: LogLevel.Info, categories: [{ category: "p2p", level: LogLevel.Debug }] },
  };
  const client = await EufySecurity.initialize(config, options.logger);
  // EufySecurity's event map is far wider than LegacyEvents, which TypeScript can't relate generically.
  return client as unknown as LegacyClient;
}

function codecName(codec: VideoCodec): VideoCodecName {
  if (codec === VideoCodec.H265) return "h265";
  if (codec === VideoCodec.H264) return "h264";
  return "unknown";
}

function positiveOrNull(value: number): number | null {
  return value > 0 ? value : null;
}

function readBattery(device: LegacyDevice): BatteryReading {
  if (!device.hasProperty(PropertyName.DeviceBattery)) {
    return { percent: null, observedAt: null, note: "camera does not expose a battery property" };
  }
  const value = device.getPropertyValue(PropertyName.DeviceBattery);
  if (typeof value !== "number") {
    return { percent: null, observedAt: null, note: "cloud returned no battery value" };
  }
  const param = device.getRawDevice().params?.find((entry) => entry.param_type === CommandType.CMD_GET_BATTERY);
  if (param === undefined || param.update_time <= 0) {
    return { percent: value, observedAt: null, note: "cloud gave no timestamp for this reading" };
  }
  return { percent: value, observedAt: new Date(param.update_time * 1000).toISOString(), note: null };
}

function readTelemetry(device: LegacyDevice): Record<string, string | number | boolean> {
  const telemetry: Record<string, string | number | boolean> = {};
  for (const name of TELEMETRY_PROPERTIES) {
    if (!device.hasProperty(name)) continue;
    const value = device.getPropertyValue(name);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      telemetry[name] = value;
    }
  }
  return telemetry;
}

export class LegacyAdapter implements CameraAdapter {
  readonly name = "eufy-security-client";
  readonly version = libVersion;

  private readonly createClient: () => Promise<LegacyClient>;
  private readonly warn: (message: string) => void;
  private client: LegacyClient | undefined;
  private targetStation: string | undefined;
  private activeStation: string | undefined;
  private unexpectedConnections = 0;

  constructor(createClient: () => Promise<LegacyClient>, warn: (message: string) => void) {
    this.createClient = createClient;
    this.warn = warn;
  }

  private async getClient(): Promise<LegacyClient> {
    if (this.client !== undefined) return this.client;
    const client = await this.createClient();
    client.setCameraMaxLivestreamDuration(60);
    this.installConnectionGuard(client);
    this.client = client;
    return client;
  }

  /**
   * The library can reach the camera outside an attempt, and on a battery camera every one of those
   * is a wake: Station.onTimeout schedules a reconnect unconditionally, Station.close() ends only
   * sessions that are already connected, and EufySecurity re-queries a station 12 hours after its
   * last connect. So anything landing outside an active attempt gets closed.
   */
  private installConnectionGuard(client: LegacyClient): void {
    client.on("station connect", (station) => {
      if (station.getSerial() === this.activeStation) return;
      if (this.targetStation === undefined || station.getSerial() === this.targetStation) {
        this.unexpectedConnections += 1;
        this.warn("closed a camera connection that opened outside a capture attempt");
      }
      station.close();
    });
    client.on("station connection error", (station) => {
      if (station.getSerial() === this.activeStation) return;
      // The library schedules its reconnect right after emitting this, and close() is what clears it.
      setImmediate(() => station.close());
    });
  }

  async authenticate(input?: AuthInput): Promise<AuthState> {
    const client = await this.getClient();
    if (client.isConnected()) return { status: "authenticated" };

    const options: Parameters<LegacyClient["connect"]>[0] = { force: false };
    if (input !== undefined && "verifyCode" in input) options.verifyCode = input.verifyCode;
    if (input !== undefined && "captcha" in input) {
      options.captcha = { captchaId: input.captcha.id, captchaCode: input.captcha.code };
    }

    return await new Promise<AuthState>((resolve, reject) => {
      // The library logs in to two backends and treats the legacy one as best-effort, so a "connection
      // error" isn't final. The login has failed only if connect() finishes without reaching an outcome.
      let lastError: Error | undefined;
      let settled = false;
      const onConnect = (): void => settle(() => resolve({ status: "authenticated" }));
      const onTfa = (): void => settle(() => resolve({ status: "tfa_required" }));
      const onCaptcha = (id: string, image: string): void =>
        settle(() => resolve({ status: "captcha_required", captchaId: id, captchaImage: image }));
      const onError = (error: Error): void => {
        lastError = error;
      };
      const fail = (error: Error): void =>
        settle(() =>
          reject(new CaptureFailure("auth_required", "auth", `Eufy login failed: ${error.message}. Check EUFY_EMAIL, EUFY_PASSWORD and EUFY_COUNTRY, then run the login command.`, { cause: error })),
        );
      const timer = setTimeout(
        () => fail(lastError ?? new Error(`no answer from the Eufy cloud within ${AUTH_TIMEOUT_MS / 1000} s`)),
        AUTH_TIMEOUT_MS,
      );
      const settle = (done: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.off("connect", onConnect);
        client.off("tfa request", onTfa);
        client.off("captcha request", onCaptcha);
        client.off("connection error", onError);
        done();
      };
      client.on("connect", onConnect);
      client.on("tfa request", onTfa);
      client.on("captcha request", onCaptcha);
      client.on("connection error", onError);
      client.connect(options).then(() => fail(lastError ?? new Error("the login finished without a result")), fail);
    });
  }

  async discoverCamera(preferredKey?: string): Promise<CameraInfo> {
    const client = await this.getClient();
    await client.refreshCloudData();
    const devices = await client.getDevices();
    const matches = devices.filter((device) =>
      preferredKey === undefined ? device.getModel().startsWith(CAMERA_MODEL_PREFIX) : device.getSerial() === preferredKey,
    );
    const seen = devices.map((device) => device.getModel()).join(", ") || "no devices";
    const [device, ...others] = matches;
    if (device === undefined) {
      throw new CaptureFailure(
        "camera_not_found",
        "discovery",
        `No matching ${CAMERA_MODEL_PREFIX} on this account (it sees: ${seen}). If this is a separate account, share the camera to it from the owner account and accept the invitation. If the eufy app already shows the camera on this account, the legacy API isn't returning it, and the next step is a different adapter.`,
      );
    }
    if (others.length > 0) {
      throw new CaptureFailure(
        "camera_not_found",
        "discovery",
        `This account sees ${matches.length} ${CAMERA_MODEL_PREFIX} cameras. Set EUFY_CAMERA_SERIAL to pick one.`,
      );
    }
    const station = await client.getStation(device.getStationSerial());
    this.targetStation = station.getSerial();
    return {
      key: device.getSerial(),
      model: device.getModel(),
      firmware: device.getSoftwareVersion() || null,
      energySaving: station.isEnergySavingDevice(),
      battery: readBattery(device),
      telemetry: readTelemetry(device),
    };
  }

  async openLiveSession(cameraKey: string, signal: AbortSignal): Promise<LiveSession> {
    const client = await this.getClient();
    const device = await client.getDevice(cameraKey);
    const stationSerial = device.getStationSerial();
    const station = await client.getStation(stationSerial);
    this.targetStation = stationSerial;

    const coldConnection = !station.isConnected();
    if (station.isLiveStreaming(device)) {
      throw new CaptureFailure("stale_source", "connect", "The camera is already streaming from an earlier session, so a frame from it would not be fresh.");
    }

    const startedAt = Date.now();
    this.activeStation = stationSerial;

    return await new Promise<LiveSession>((resolve, reject) => {
      let phase: FailurePhase = "connect";
      let connectMs = 0;
      let connectRetries = 0;

      const removeListeners = (): void => {
        client.off("station connect", onConnect);
        client.off("station connection error", onConnectionError);
        client.off("station close", onClose);
        client.off("station livestream start", onLiveStart);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (failure: CaptureFailure): void => {
        removeListeners();
        reject(failure);
      };
      const startStream = (): void => {
        connectMs = Date.now() - startedAt;
        phase = "stream_start";
        client.startStationLivestream(cameraKey).catch((error: Error) => {
          fail(new CaptureFailure("camera_unreachable", "stream_start", `Live stream start was refused: ${error.message}`, { cause: error }));
        });
      };
      const onConnect = (connected: LegacyStation): void => {
        if (connected.getSerial() === stationSerial && phase === "connect") startStream();
      };
      // The library retries a timed-out connect on its own. Those retries count against this attempt's deadline.
      const onConnectionError = (failed: LegacyStation): void => {
        if (failed.getSerial() === stationSerial) connectRetries += 1;
      };
      const onClose = (closed: LegacyStation): void => {
        if (closed.getSerial() === stationSerial && phase === "stream_start") {
          fail(new CaptureFailure("camera_unreachable", "stream_start", "The camera connection closed before the live stream started."));
        }
      };
      const onLiveStart = (
        _station: LegacyStation,
        streaming: LegacyDevice,
        metadata: StreamMetadata,
        video: Readable,
        audio: Readable,
      ): void => {
        if (streaming.getSerial() !== cameraKey) return;
        removeListeners();
        resolve({
          codec: codecName(metadata.videoCodec),
          reportedWidth: positiveOrNull(metadata.videoWidth),
          reportedHeight: positiveOrNull(metadata.videoHeight),
          reportedFps: positiveOrNull(metadata.videoFPS),
          video,
          audio,
          connectMs,
          connectRetries,
          coldConnection,
        });
      };
      const onAbort = (): void => {
        const cause = signal.reason as AbortCause;
        if (cause === "terminated") {
          fail(new CaptureFailure("aborted", phase, "Stopped by a termination signal."));
        } else if (phase === "connect") {
          fail(new CaptureFailure("camera_unreachable", phase, `No P2P connection to the camera after ${connectRetries} retries before the attempt deadline.`));
        } else {
          fail(new CaptureFailure("capture_timeout", phase, "The camera connected, but the live stream did not start before the attempt deadline."));
        }
      };

      // Listeners go on before the first command, so nothing the camera sends can be missed.
      client.on("station connect", onConnect);
      client.on("station connection error", onConnectionError);
      client.on("station close", onClose);
      client.on("station livestream start", onLiveStart);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      if (station.isConnected()) {
        startStream();
        return;
      }
      client.connectToStation(stationSerial, P2PConnectionType.QUICKEST).catch((error: Error) => {
        fail(new CaptureFailure("camera_unreachable", "connect", `P2P connect failed: ${error.message}`, { cause: error }));
      });
    });
  }

  async teardown(cameraKey: string, timeoutMs: number): Promise<CleanupResult> {
    const client = await this.getClient();
    const device = await client.getDevice(cameraKey);
    const station = await client.getStation(device.getStationSerial());

    // The connection guard is live again from here, so a connect still in flight is closed when it lands.
    this.activeStation = undefined;

    const problems: string[] = [];
    if (station.isLiveStreaming(device)) {
      await client.stopStationLivestream(cameraKey).catch((error: Error) => {
        problems.push(`stopping the stream failed: ${error.message}`);
      });
    }
    station.close();

    const deadline = Date.now() + timeoutMs;
    while (station.isConnected() && Date.now() < deadline) {
      await delay(CLOSE_POLL_MS);
    }
    if (station.isConnected()) {
      problems.push(`camera connection still open ${timeoutMs} ms after close`);
      return { status: "timeout", detail: problems.join("; ") };
    }
    return problems.length > 0 ? { status: "error", detail: problems.join("; ") } : { status: "ok", detail: null };
  }

  unexpectedConnectionCount(): number {
    return this.unexpectedConnections;
  }

  async shutdown(): Promise<void> {
    this.client?.close();
    this.client = undefined;
  }
}
