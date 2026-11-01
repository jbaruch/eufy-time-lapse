export interface Logger {
  debug(message: unknown, ...args: unknown[]): void;
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /password|passwd|token|secret|auth|cookie|email|dsk|private_?key|public_?key|p2p_?did|p2p_?license|p2p_?conn|app_?conn|iccid|imei|ssid|mac|local_?ip|^ip$|persistentdata|sn$|serial|openudid|user_?id/i;
const INLINE_SECRET = /("?(?:password|passwd|[a-z_]*token|auth[a-z_]*|dsk_?key)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi;

interface SerializedBuffer {
  type: "Buffer";
  data: number[];
}

function isSerializedBuffer(value: object): value is SerializedBuffer {
  return "type" in value && value.type === "Buffer" && "data" in value && Array.isArray(value.data);
}

/** Removes secrets from SDK log output, which goes to disk and can end up in a bug report. */
export class Redactor {
  private readonly literals = new Set<string>();

  constructor(literals: string[] = []) {
    for (const literal of literals) this.addLiteral(literal);
  }

  /** Registers a value to scrub wherever it appears, such as a serial learned after startup. */
  addLiteral(literal: string): void {
    if (literal.length > 0) this.literals.add(literal);
  }

  // Runs on raw strings, before JSON encoding escapes their quotes and hides them from these patterns.
  private scrub(text: string): string {
    let scrubbed = text.replace(INLINE_SECRET, `$1${REDACTED}`);
    for (const literal of this.literals) scrubbed = scrubbed.replaceAll(literal, REDACTED);
    return scrubbed;
  }

  redact(value: unknown): string {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (key, entry: unknown) => {
      if (key !== "" && SENSITIVE_KEY.test(key)) return REDACTED;
      if (typeof entry === "string") return this.scrub(entry);
      if (typeof entry === "bigint") return entry.toString();
      if (entry instanceof Error) return { name: entry.name, message: entry.message };
      if (typeof entry === "object" && entry !== null) {
        // JSON.stringify has already applied Buffer.toJSON by the time a value gets here.
        if (isSerializedBuffer(entry)) return `<${entry.data.length} bytes>`;
        if (seen.has(entry)) return "[circular]";
        seen.add(entry);
      }
      return entry;
    });
    return json ?? "null";
  }
}

export function createRedactingLogger(redactor: Redactor, write: (line: string) => void, now: () => Date = () => new Date()): Logger {
  const emit =
    (level: string) =>
    (message: unknown, ...args: unknown[]): void => {
      write(`${redactor.redact({ ts: now().toISOString(), level, message, args })}\n`);
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}
