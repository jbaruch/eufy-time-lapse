import { readFileSync } from "node:fs";
import type { CameraLink } from "./probe/report.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type AdapterName = "mega" | "legacy";

export interface AppConfig {
  adapter: AdapterName;
  email: string;
  password: string;
  country: string;
  acceptInvitations: boolean;
  cameraSerial?: string;
  link: CameraLink | null;
  operator: string | null;
  dataDir: string;
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

function parseBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = optional(env, name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError(`${name} must be "true" or "false", got "${value}".`);
}

function parseAdapter(value: string | undefined): AdapterName {
  if (value === undefined || value === "mega") return "mega";
  if (value === "legacy") return value;
  throw new ConfigError(`TIMELAPSE_ADAPTER must be "mega" or "legacy", got "${value}".`);
}

function parseLink(value: string | undefined): CameraLink | null {
  if (value === undefined) return null;
  if (value === "cellular" || value === "wifi") return value;
  throw new ConfigError(`TIMELAPSE_CAMERA_LINK must be "cellular" or "wifi", got "${value}".`);
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const cameraSerial = optional(env, "EUFY_CAMERA_SERIAL");
  return {
    adapter: parseAdapter(optional(env, "TIMELAPSE_ADAPTER")),
    email: secret(env, "EUFY_EMAIL"),
    password: secret(env, "EUFY_PASSWORD"),
    country: optional(env, "EUFY_COUNTRY") ?? "US",
    acceptInvitations: parseBoolean(env, "EUFY_ACCEPT_INVITATIONS", false),
    ...(cameraSerial === undefined ? {} : { cameraSerial }),
    link: parseLink(optional(env, "TIMELAPSE_CAMERA_LINK")),
    operator: optional(env, "TIMELAPSE_CELLULAR_OPERATOR") ?? null,
    dataDir: optional(env, "TIMELAPSE_DATA_DIR") ?? "./data",
  };
}
