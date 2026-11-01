import { readFileSync } from "node:fs";
import type { CameraLink } from "./probe/report.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The owner requires native 4K. A smaller frame is kept, but marked degraded. */
const DEFAULT_MIN_WIDTH = 3840;
const DEFAULT_MIN_HEIGHT = 2160;

export interface AppConfig {
  email: string;
  password: string;
  country: string;
  cameraSerial?: string;
  link: CameraLink | null;
  operator: string | null;
  dataDir: string;
  minWidth: number;
  minHeight: number;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/** Reads NAME_FILE (a Docker secret) when set, otherwise NAME. */
function secret(env: NodeJS.ProcessEnv, name: string): string {
  const path = optional(env, `${name}_FILE`);
  if (path !== undefined) {
    let content: string;
    try {
      // Only the file's line ending goes: a password can legitimately start or end with a space.
      content = readFileSync(path, "utf8").replace(/\r?\n$/, "");
    } catch (error) {
      throw new ConfigError(`Can't read ${name}_FILE at ${path}: ${(error as Error).message}. Run scripts/set-credentials.sh on this host.`);
    }
    if (content.length === 0) throw new ConfigError(`${name}_FILE at ${path} is empty. Run scripts/set-credentials.sh on this host.`);
    return content;
  }
  const value = optional(env, name);
  if (value === undefined) {
    throw new ConfigError(`Neither ${name}_FILE nor ${name} is set. Run scripts/set-credentials.sh, or copy .env.example to .env for local development.`);
  }
  return value;
}

function parsePixels(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = optional(env, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive whole number of pixels, got "${value}".`);
  return parsed;
}

function parseLink(value: string | undefined): CameraLink | null {
  if (value === undefined) return null;
  if (value === "cellular" || value === "wifi") return value;
  throw new ConfigError(`TIMELAPSE_CAMERA_LINK must be "cellular" or "wifi", got "${value}".`);
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const cameraSerial = optional(env, "EUFY_CAMERA_SERIAL");
  return {
    email: secret(env, "EUFY_EMAIL"),
    password: secret(env, "EUFY_PASSWORD"),
    country: optional(env, "EUFY_COUNTRY") ?? "US",
    ...(cameraSerial === undefined ? {} : { cameraSerial }),
    link: parseLink(optional(env, "TIMELAPSE_CAMERA_LINK")),
    operator: optional(env, "TIMELAPSE_CELLULAR_OPERATOR") ?? null,
    dataDir: optional(env, "TIMELAPSE_DATA_DIR") ?? "./data",
    minWidth: parsePixels(env, "TIMELAPSE_MIN_WIDTH", DEFAULT_MIN_WIDTH),
    minHeight: parsePixels(env, "TIMELAPSE_MIN_HEIGHT", DEFAULT_MIN_HEIGHT),
  };
}
