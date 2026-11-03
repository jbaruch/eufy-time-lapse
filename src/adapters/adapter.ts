import type { Readable } from "node:stream";

export type FailureReason =
  | "auth_required"
  | "camera_not_found"
  | "camera_unreachable"
  | "capture_timeout"
  | "decode_failed"
  | "stale_source"
  | "budget_spent"
  | "cleanup_timeout"
  | "storage_full"
  | "aborted";

export type FailurePhase = "auth" | "discovery" | "connect" | "stream_start" | "first_media" | "decode" | "cleanup";

export class CaptureFailure extends Error {
  readonly reason: FailureReason;
  readonly phase: FailurePhase;

  constructor(reason: FailureReason, phase: FailurePhase, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CaptureFailure";
    this.reason = reason;
    this.phase = phase;
  }
}

/** Why an attempt's AbortSignal fired. Passed as the signal's `reason`. */
export type AbortCause = "deadline" | "terminated";

export type AuthInput = { verifyCode: string } | { captcha: { id: string; code: string } };

/** `trusted` is null when no code was asked for, so there was nothing to earn trust with. */
export type LoginRenewal = { status: "renewed"; trusted: boolean | null } | { status: "needs_person" };

export type AuthState =
  | { status: "authenticated" }
  | { status: "tfa_required" }
  | { status: "captcha_required"; captchaId: string; captchaImage: string };

export type AuthChallenge = Exclude<AuthState, { status: "authenticated" }>;

export interface BatteryReading {
  percent: number | null;
  observedAt: string | null;
  note: string | null;
}

export interface CameraInfo {
  /** Full device serial. Never write it to logs or reports. */
  key: string;
  model: string;
  firmware: string | null;
  energySaving: boolean;
  battery: BatteryReading;
  telemetry: Record<string, string | number | boolean>;
}

export type VideoCodecName = "h264" | "h265" | "unknown";

export type ConnectionPath = "direct" | "relay";

export interface FrameSize {
  width: number;
  height: number;
}

export interface LiveSession {
  codec: VideoCodecName;
  reportedWidth: number | null;
  reportedHeight: number | null;
  reportedFps: number | null;
  video: Readable;
  audio: Readable;
  connectMs: number;
  connectRetries: number;
  /** True when no P2P connection to the camera existed before this attempt. */
  coldConnection: boolean;
  /** Whether video reached us directly or through a relay. The two behave very differently on cellular. */
  connectionPath: ConnectionPath;
  /** Reports each keyframe's coded size, after its bytes have gone to `video`. */
  onKeyframe(listener: (size: FrameSize) => void): void;
}

export interface CleanupResult {
  /** `unknown_after_crash`: the process died before teardown finished, so whether the connection closed can't be known. */
  status: "ok" | "timeout" | "error" | "unknown_after_crash";
  detail: string | null;
}

/**
 * Service-level camera operations. The scheduler, archiver and renderer depend on this contract,
 * never on a concrete SDK.
 */
export interface CameraAdapter {
  readonly name: string;
  readonly version: string;
  authenticate(input?: AuthInput): Promise<AuthState>;
  /** When the stored login ends, if Eufy said. A reason to renew it, not proof that it still works. */
  loginExpiresAt(): Date | null;
  /**
   * Logs in from scratch beside the held login, and swaps the result in only once it's complete. Without `answer`,
   * a challenge ends it with the held login untouched. Rejects with CaptureFailure on an outage or a refusal.
   */
  renewLogin(answer?: (challenge: AuthChallenge) => Promise<AuthInput>): Promise<LoginRenewal>;
  /** Whether Eufy lists this device as trusted, or null if it can't be asked. Eufy asks an untrusted one for a code at every login. */
  isDeviceTrusted(): Promise<boolean | null>;
  /** Spends the code a login just used to make this device trusted. Answers whether Eufy now lists it. */
  trustDevice(code: string): Promise<boolean>;
  discoverCamera(preferredKey?: string): Promise<CameraInfo>;
  /** Starts a new live session. Rejects with CaptureFailure; aborts promptly when `signal` fires. */
  openLiveSession(cameraKey: string, signal: AbortSignal): Promise<LiveSession>;
  /** Stops the stream and the camera connection. Reports problems in its result. */
  /** Resolves with the outcome, including one that failed in a way the adapter understands. A rejection means a bug. */
  teardown(cameraKey: string, timeoutMs: number): Promise<CleanupResult>;
  /** Connections to the camera that opened outside an attempt. Each one wakes it. */
  unexpectedConnectionCount(): number;
  shutdown(): Promise<void>;
}
