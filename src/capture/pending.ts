import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isFileSystemError } from "../config.ts";

const PENDING_FILE = "pending.json";

/**
 * What a capture attempt knew when the stream stopped, kept beside the raw stream so a crash during teardown or decoding
 * doesn't cost bytes that already arrived. Owned by this module, its only writer and reader. A new shape means a new
 * schema_version here, and a record of a version this doesn't know is left alone: it costs one frame, not a wrong one.
 */
export interface PendingCapture {
  schema_version: 1;
  attempt_id: string;
  request_started_at: string;
  stream_started_at: string;
  first_media_at: string;
  stream_stopped_at: string;
  stream_stop: "target_reached" | "deadline" | "stream_ended";
  connect_ms: number;
  connect_retries: number;
  connection_path: "direct" | "relay" | null;
  cold_connection: boolean | null;
  codec: "h264" | "h265" | "unknown";
  video_bytes: number;
  audio_bytes: number;
  adapter: string;
  adapter_version: string;
}

/** Replaced whole, so a crash leaves the record or nothing, never half of one. */
export async function writePendingCapture(directory: string, pending: PendingCapture): Promise<void> {
  const path = join(directory, PENDING_FILE);
  await writeFile(`${path}.tmp`, `${JSON.stringify(pending, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

function isPendingCapture(value: unknown): value is PendingCapture {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const isText = (field: string): boolean => typeof record[field] === "string" && record[field].length > 0;
  const isTime = (field: string): boolean => typeof record[field] === "string" && !Number.isNaN(Date.parse(record[field]));
  const isAmount = (field: string): boolean => typeof record[field] === "number" && Number.isFinite(record[field]) && record[field] >= 0;
  return (
    record.schema_version === 1 &&
    ["attempt_id", "adapter", "adapter_version"].every(isText) &&
    ["request_started_at", "stream_started_at", "first_media_at", "stream_stopped_at"].every(isTime) &&
    ["connect_ms", "connect_retries", "audio_bytes"].every(isAmount) &&
    typeof record.video_bytes === "number" &&
    record.video_bytes > 0 &&
    (record.stream_stop === "target_reached" || record.stream_stop === "deadline" || record.stream_stop === "stream_ended") &&
    (record.connection_path === "direct" || record.connection_path === "relay" || record.connection_path === null) &&
    (record.cold_connection === true || record.cold_connection === false || record.cold_connection === null) &&
    (record.codec === "h264" || record.codec === "h265" || record.codec === "unknown")
  );
}

/** The record an attempt left behind, or null if it left none this build can vouch for. */
export async function readPendingCapture(directory: string): Promise<PendingCapture | null> {
  let content: string;
  try {
    content = await readFile(join(directory, PENDING_FILE), "utf8");
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return isPendingCapture(value) ? value : null;
}
