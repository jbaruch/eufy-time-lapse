import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { isFileSystemError } from "./config.ts";
import type { CameraLink } from "./probe/report.ts";
import type { CaptureRow } from "./state.ts";

/** Whose frames these are. A file copied in from elsewhere can be perfectly well formed. */
export interface CaptureOwner {
  projectId: string;
  cameraId: string;
}

/** The immutable record stored beside each frame. Archive state is mutable, so it lives in SQLite instead. */
export interface CaptureMetadata {
  schema_version: 1;
  capture_id: string;
  project_id: string;
  camera_id: string;
  kind: "scheduled" | "manual";
  slot_id: string | null;
  attempt_id: string;
  schedule_revision: string | null;
  scheduled_at_utc: string | null;
  request_started_at: string;
  stream_started_at: string | null;
  frame_received_at: string;
  camera_captured_at: null;
  camera_captured_at_note: string;
  site_time_zone: string;
  local_date: string;
  source: "live_p2p";
  capture_session_id: string;
  freshness_basis: string;
  cold_connection: boolean | null;
  retained: false;
  adapter: string;
  adapter_version: string;
  camera_firmware: string | null;
  connection_type: CameraLink | null;
  connection_path: string | null;
  cellular_operator: string | null;
  width: number;
  height: number;
  source_codec: string | null;
  jpeg_bytes: number;
  sha256: string;
  quality_status: "ok" | "degraded";
  attempt_count: number;
  connect_ms: number | null;
  session_ms: number;
  cleanup_status: string;
  cleanup_detail: string | null;
  battery_percent: number | null;
  battery_observed_at: string | null;
  battery_note: string | null;
  every_minutes: number | null;
  media_video_bytes: number;
  media_audio_bytes: number;
  traffic_measurement_basis: string;
}

/** The part of a capture's stored metadata that recovery reads, which is all this code vouches for. */
export type AdoptableCapture = Pick<CaptureMetadata, "capture_id" | "project_id" | "camera_id" | "slot_id" | "schedule_revision" | "scheduled_at_utc" | "kind" | "local_date" | "frame_received_at" | "width" | "height" | "jpeg_bytes" | "sha256" | "quality_status">;

/** Reads what recovery needs from stored metadata, or null if it isn't a version and shape this build understands. */
export function parseCaptureMetadata(text: string): AdoptableCapture | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const field = (key: string): string => (typeof record[key] === "string" ? record[key] : "");
  const counts = ["width", "height", "jpeg_bytes"].every((key) => Number.isInteger(record[key]) && (record[key] as number) > 0);
  const valid =
    record.schema_version === 1 &&
    field("capture_id").length > 0 &&
    field("project_id").length > 0 &&
    field("camera_id").length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(field("local_date")) &&
    !Number.isNaN(Date.parse(field("frame_received_at"))) &&
    /^[0-9a-f]{64}$/.test(field("sha256")) &&
    counts &&
    (record.slot_id === null || typeof record.slot_id === "string") &&
    (record.schedule_revision === null || typeof record.schedule_revision === "string") &&
    (record.scheduled_at_utc === null || !Number.isNaN(Date.parse(field("scheduled_at_utc")))) &&
    (record.kind === "scheduled" || record.kind === "manual") &&
    (record.quality_status === "ok" || record.quality_status === "degraded");
  return valid ? (record as unknown as AdoptableCapture) : null;
}

/** A name that can only be one directory. Dots and separators are how a stored value climbs out of the spool. */
const SAFE_NAME = /^[\w-][\w.-]*$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function spoolDay(owner: CaptureOwner, localDate: string): string {
  const [year, month, day] = localDate.split("-") as [string, string, string];
  return join("spool", owner.projectId, owner.cameraId, year, month, day);
}

/** Where a capture lives, worked out from who it is. A path a row recorded is only a claim about that. */
export function spoolDirectory(owner: CaptureOwner, localDate: string, captureId: string): string {
  return join(spoolDay(owner, localDate), captureId);
}

/** Whether a recorded path is the one a capture's identity gives it. Everything read from the spool goes through this first. */
function isItsOwnLocation(relativeDir: string, captureId: string, localDate: string, owner: CaptureOwner): boolean {
  return SAFE_NAME.test(captureId) && LOCAL_DATE.test(localDate) && relativeDir === spoolDirectory(owner, localDate, captureId);
}

type StoredFile = { bytes: Buffer } | { problem: string };

/** A stored file, if it's really at its place in the spool. A link leading elsewhere could be anything. */
async function readStoredFile(dataDir: string, relativePath: string, label: string): Promise<StoredFile> {
  try {
    const location = await realpath(join(dataDir, relativePath));
    const root = await realpath(dataDir);
    if (location !== join(root, relativePath) || !location.startsWith(`${root}${sep}`)) return { problem: `the ${label} file leads outside the spool` };
    return { bytes: await readFile(location) };
  } catch (error) {
    // A bug isn't a bad file. One unreadable file, on the other hand, must not stop capture or a render.
    if (!isFileSystemError(error)) throw error;
    return { problem: error.code === "ENOENT" ? `the ${label} file is missing` : `the ${label} file can't be read (${error.code})` };
  }
}

function frameMatches(frame: Buffer, facts: { jpeg_bytes: number; sha256: string }): boolean {
  return frame.length === facts.jpeg_bytes && createHash("sha256").update(frame).digest("hex") === facts.sha256;
}

/** What's stored at a place in the spool, if its record, that place and its frame all agree, and it's this camera's. */
export async function readStoredCapture(dataDir: string, relativeDir: string, captureId: string, localDate: string, owner: CaptureOwner): Promise<AdoptableCapture | null> {
  if (!isItsOwnLocation(relativeDir, captureId, localDate, owner)) return null;
  const metadataFile = await readStoredFile(dataDir, join(relativeDir, "metadata.json"), "metadata");
  if ("problem" in metadataFile) return null;
  const metadata = parseCaptureMetadata(metadataFile.bytes.toString("utf8"));
  if (metadata === null || metadata.capture_id !== captureId || metadata.local_date !== localDate) return null;
  if (metadata.project_id !== owner.projectId || metadata.camera_id !== owner.cameraId) return null;
  const frameFile = await readStoredFile(dataDir, join(relativeDir, "frame.jpg"), "frame");
  return !("problem" in frameFile) && frameMatches(frameFile.bytes, metadata) ? metadata : null;
}

/** What's wrong with what's stored for a database row, in words, or null if it's all still what the row says. */
export async function storedCaptureProblem(dataDir: string, row: CaptureRow, owner: CaptureOwner): Promise<string | null> {
  if (!isItsOwnLocation(row.relative_dir, row.capture_id, row.local_date, owner)) return "its recorded location isn't where this camera's frames belong";
  const frameFile = await readStoredFile(dataDir, join(row.relative_dir, "frame.jpg"), "frame");
  if ("problem" in frameFile) return frameFile.problem;
  if (!frameMatches(frameFile.bytes, row)) return "the frame file doesn't match its record";

  const metadataFile = await readStoredFile(dataDir, join(row.relative_dir, "metadata.json"), "metadata");
  if ("problem" in metadataFile) return metadataFile.problem;
  const stored = parseCaptureMetadata(metadataFile.bytes.toString("utf8"));
  const agrees =
    stored !== null &&
    stored.project_id === owner.projectId &&
    stored.camera_id === owner.cameraId &&
    stored.capture_id === row.capture_id &&
    stored.slot_id === row.slot_id &&
    stored.kind === row.kind &&
    stored.local_date === row.local_date &&
    stored.frame_received_at === row.frame_received_at &&
    stored.width === row.width &&
    stored.height === row.height &&
    stored.jpeg_bytes === row.jpeg_bytes &&
    stored.sha256 === row.sha256 &&
    stored.quality_status === row.quality_status;
  return agrees ? null : "the metadata file doesn't match its record";
}
