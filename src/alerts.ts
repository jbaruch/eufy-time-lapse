import type { State } from "./state.ts";
import { sendTelegram, TelegramDeliveryError } from "./telegram.ts";
import type { TelegramRoute } from "./telegram.ts";

/** Answers whether the message reached its destination, so one that didn't can be tried again. */
export type Notify = (text: string) => Promise<boolean>;

/**
 * Sends alerts to Telegram, and always to the log. A delivery failure only logs: it must never wake the camera or
 * stop a capture. Without a route, the log is the destination.
 */
export function createNotifier(route: TelegramRoute | null, log: (message: string) => void, send: typeof sendTelegram = sendTelegram): Notify {
  return async (text) => {
    log(`ALERT ${text}`);
    if (route === null) return true;
    try {
      await send(route, text);
      return true;
    } catch (error) {
      if (!(error instanceof TelegramDeliveryError)) throw error;
      log(`that alert didn't reach Telegram, and the next slot tries again. ${error.message}`);
      return false;
    }
  };
}

/** Marks an alert no one has heard about yet. Being far in the past, it also makes the next check send it. */
const NEVER_SENT = new Date(0).toISOString();

/**
 * One message when a problem starts, at most one reminder per interval, one when it clears. An alert raised during an
 * outage often can't be delivered at the time, so one that wasn't is tried again at the next check, not a day later.
 */
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
      this.state.upsertAlert(key, detail, stamp.toISOString(), NEVER_SENT);
      if (await this.notify(`Time-lapse problem: ${detail}`)) this.state.upsertAlert(key, detail, stamp.toISOString(), stamp.toISOString());
    } else if (stamp.getTime() - Date.parse(existing.last_sent_at) >= this.reminderMs) {
      const text = existing.last_sent_at === NEVER_SENT ? `Time-lapse problem since ${existing.active_since}: ${detail}` : `Time-lapse problem continues since ${existing.active_since}: ${detail}`;
      if (await this.notify(text)) this.state.upsertAlert(key, detail, existing.active_since, stamp.toISOString());
    }
  }

  async clear(key: string): Promise<void> {
    const existing = this.state.getAlert(key);
    if (existing === undefined) return;
    this.state.deleteAlert(key);
    // Nobody heard about the problem, so there's nothing to call over.
    if (existing.last_sent_at !== NEVER_SENT) await this.notify(`Time-lapse recovered: ${existing.detail}`);
  }

  async set(key: string, active: boolean, detail: string): Promise<void> {
    if (active) await this.raise(key, detail);
    else await this.clear(key);
  }
}
