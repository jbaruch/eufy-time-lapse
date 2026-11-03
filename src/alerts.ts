import { readFileSync } from "node:fs";
import { ConfigError, isFileSystemError } from "./config.ts";
import type { State } from "./state.ts";

export type Notify = (text: string) => Promise<void>;

/** Checked at startup, so a typo stops the service now instead of losing every alert later. Never quotes the URL, which holds a credential. */
function readWebhookUrl(path: string): string {
  let url: string;
  try {
    url = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    throw new ConfigError(`Can't read the alert webhook at ${path} (${error.code}). Fix that file, or set alerts.webhook_url_file to null.`);
  }
  const protocol = URL.canParse(url) ? new URL(url).protocol : "";
  if (protocol !== "https:" && protocol !== "http:") {
    throw new ConfigError(`${path} doesn't hold an http or https URL. Fix that file, or set alerts.webhook_url_file to null.`);
  }
  return url;
}

/** How fetch reports a network that let it down, or the timeout firing. Anything else is a bug, and should be seen. */
function isDeliveryFailure(error: unknown): error is Error {
  if (error instanceof TypeError) return error.message === "fetch failed";
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Posts to one webhook. A delivery failure only logs: it must never wake the camera or stop a capture.
 * Without a webhook, alerts go to the log.
 */
export function createNotifier(webhookUrlFile: string | null, log: (message: string) => void): Notify {
  const url = webhookUrlFile === null ? null : readWebhookUrl(webhookUrlFile);
  return async (text) => {
    log(`ALERT ${text}`);
    if (url === null) return;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) log(`alert webhook answered HTTP ${response.status}`);
    } catch (error) {
      if (!isDeliveryFailure(error)) throw error;
      log(`alert webhook failed: ${error.name}`); // Only the name: a message can quote the URL, which holds a credential.
    }
  };
}

/** One message when a problem starts, at most one reminder per interval, one when it clears. */
export class AlertTracker {
  private readonly state: State;
  private readonly notify: Notify;
  private readonly reminderMs: number;
  private readonly now: () => Date;

  constructor(state: State, notify: Notify, reminderHours: number, now: () => Date) {
    this.state = state;
    this.notify = notify;
    this.reminderMs = reminderHours * 3_600_000;
    this.now = now;
  }

  async raise(key: string, detail: string): Promise<void> {
    const stamp = this.now();
    const existing = this.state.getAlert(key);
    if (existing === undefined) {
      this.state.upsertAlert(key, detail, stamp.toISOString(), stamp.toISOString());
      await this.notify(`Time-lapse problem: ${detail}`);
    } else if (stamp.getTime() - Date.parse(existing.last_sent_at) >= this.reminderMs) {
      this.state.upsertAlert(key, detail, existing.active_since, stamp.toISOString());
      await this.notify(`Time-lapse problem continues since ${existing.active_since}: ${detail}`);
    }
  }

  async clear(key: string): Promise<void> {
    const existing = this.state.getAlert(key);
    if (existing === undefined) return;
    this.state.deleteAlert(key);
    await this.notify(`Time-lapse recovered: ${existing.detail}`);
  }

  async set(key: string, active: boolean, detail: string): Promise<void> {
    if (active) await this.raise(key, detail);
    else await this.clear(key);
  }
}
