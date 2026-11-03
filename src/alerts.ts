import type { State } from "./state.ts";
import { sendTelegram, TelegramDeliveryError } from "./telegram.ts";
import type { TelegramRoute } from "./telegram.ts";

/** Answers whether the message reached its destination, so one that didn't can be tried again. */
export type Notify = (text: string) => Promise<boolean>;

/** Long enough for one slot's alerts to share a failure, short enough that the next slot tries again. */
const QUIET_AFTER_FAILURE_MS = 120_000;

/**
 * Sends alerts to Telegram, and always to the log. A delivery failure only logs: it must never wake the camera or
 * stop a capture. Alerts wait in front of a capture, so after one failure the others skip waiting out the same timeouts.
 * Without a route, the log is the destination.
 */
export function createNotifier(route: TelegramRoute | null, log: (message: string) => void, send: typeof sendTelegram = sendTelegram, now: () => number = Date.now): Notify {
  let failedAt: number | undefined;
  return async (text) => {
    log(`ALERT ${text}`);
    if (route === null) return true;
    if (failedAt !== undefined && now() - failedAt < QUIET_AFTER_FAILURE_MS) return false;
    try {
      await send(route, text);
      return true;
    } catch (error) {
      if (!(error instanceof TelegramDeliveryError)) throw error;
      failedAt = now();
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
      return;
    }
    // Whoever never heard the recovery still thinks this is the same problem, and now they're right.
    if (existing.recovery_owed_since !== null) this.state.upsertAlert(key, detail, existing.active_since, existing.last_sent_at);
    if (stamp.getTime() - Date.parse(existing.last_sent_at) >= this.reminderMs) {
      const text = existing.last_sent_at === NEVER_SENT ? `Time-lapse problem since ${existing.active_since}: ${detail}` : `Time-lapse problem continues since ${existing.active_since}: ${detail}`;
      if (await this.notify(text)) this.state.upsertAlert(key, detail, existing.active_since, stamp.toISOString());
    }
  }

  async clear(key: string): Promise<void> {
    const existing = this.state.getAlert(key);
    // An owed recovery has already been tried, and retryOwed() tries it again.
    if (existing === undefined || existing.recovery_owed_since !== null) return;
    // Nobody heard about the problem, so there's nothing to call over.
    if (existing.last_sent_at === NEVER_SENT) {
      this.state.deleteAlert(key);
      return;
    }
    // Recorded before the send, so a crash can only repeat the message, never lose it.
    const owedSince = this.now().toISOString();
    this.state.oweRecovery(key, owedSince);
    await this.deliverRecovery(key, existing.detail, owedSince);
  }

  /**
   * Someone who heard about a problem and never hears it ended goes on believing in it. One who was never told about it at
   * all needs telling too: an alert raised every slot would get there by itself, but one raised once, by a check that
   * doesn't repeat, wouldn't.
   */
  async retryOwed(): Promise<void> {
    for (const owed of this.state.listOwedRecoveries()) await this.deliverRecovery(owed.key, owed.detail, owed.recovery_owed_since ?? "");
    for (const unsent of this.state.listAlerts().filter((alert) => alert.last_sent_at === NEVER_SENT)) {
      if (await this.notify(`Time-lapse problem since ${unsent.active_since}: ${unsent.detail}`)) this.state.markAlertSent(unsent.key, this.now().toISOString());
    }
  }

  private async deliverRecovery(key: string, detail: string, owedSince: string): Promise<void> {
    // Only the recovery that was sent. The problem can come back while the message is on its way, and that one stays.
    if (await this.notify(`Time-lapse recovered: ${detail}`)) this.state.deleteOwedRecovery(key, owedSince);
  }

  async set(key: string, active: boolean, detail: string): Promise<void> {
    if (active) await this.raise(key, detail);
    else await this.clear(key);
  }
}
