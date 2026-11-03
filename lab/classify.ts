/** The logic the rig's findings rest on, kept apart from the rig so it can be tested. */
import type { PacketEvent } from "../src/adapters/p2p-policy.ts";
import type { AttemptRecord } from "../src/capture/acquire.ts";

/** Only these keep their payload in the trace. Everything else, lookups above all, carries the account's lookup key. */
const KEEP_PAYLOAD: ReadonlySet<string> = new Set(["f140", "f169", "f170", "f171", "f172", "f173", "f180", "f181", "f182", "f183", "f184", "f128", "f1f0", "f1e0", "f1e1"]);
const NOISY: ReadonlySet<string> = new Set(["f1d0", "f1d1"]);

export interface Milestones {
  firstAck: number | null;
  address: number | null;
  relayList: number | null;
  relayPort: number | null;
  ready: number | null;
  closed: number | null;
  firstKeyframe: number | null;
  relay: string | null;
  lookupsSent: number;
  dataIn: number;
  relayRequests: Set<string>;
  listRequests: number;
}

export function blankMilestones(): Milestones {
  return { firstAck: null, address: null, relayList: null, relayPort: null, ready: null, closed: null, firstKeyframe: null, relay: null, lookupsSent: 0, dataIn: 0, relayRequests: new Set(), listRequests: 0 };
}

/** Records what this packet says about how far the connect has come, at `t` milliseconds into the try. */
export function notePacket(marks: Milestones, packet: PacketEvent, t: number): void {
  const inbound = packet.direction === "in";
  if (inbound) {
    if (packet.type === "f121") marks.firstAck ??= t;
    if (packet.type === "f140") marks.address ??= t;
    if (packet.type === "f169") marks.relayList ??= t;
    if (packet.type === "f173") {
      marks.relayPort ??= t;
      marks.relay ??= packet.host;
    }
    if (packet.type === "f184") marks.ready ??= t;
    if (packet.type === "f1f0") marks.closed ??= t;
    if (packet.type === "f1d0") marks.dataIn += 1;
    return;
  }
  if (packet.type === "f126" || packet.type === "f120") marks.lookupsSent += 1;
  if (packet.type === "f180") marks.relayRequests.add(packet.payload.toString("hex"));
  if (packet.type === "f16a") marks.listRequests += 1;
}

/** The camera's device id as it appears in packets: an 8-byte prefix, a big-endian number, an 8-byte suffix. */
export function didAsHex(did: string): string {
  const [prefix = "", number = "0", suffix = ""] = did.split("-");
  const bytes = Buffer.alloc(20);
  bytes.write(prefix, 0, "ascii");
  bytes.writeUInt32BE(Number(number), 8);
  bytes.write(suffix, 12, "ascii");
  return bytes.toString("hex");
}

/** What a packet may leave behind in a trace, or null for traffic too noisy to keep. Never a lookup's payload, and never the device id. */
export function traceEntry(packet: PacketEvent): { d: string; peer: string; type: string; len: number; hex?: string } | null {
  if (NOISY.has(packet.type)) return null;
  const entry = { d: packet.direction, peer: `${packet.host}:${packet.port}`, type: packet.type, len: packet.payload.length };
  if (!KEEP_PAYLOAD.has(packet.type)) return entry;
  return { ...entry, hex: packet.payload.toString("hex").replaceAll(didAsHex(packet.did), "<did>") };
}

export type TryOutcome = "clean" | "hangup_4k" | "hangup_low" | "no_rdy" | "no_video";

/** Sorts a try by what the camera did. The failure this rig was built to study is the camera never joining the relay. */
export function classifyOutcome(record: Pick<AttemptRecord, "status" | "stream_stop">, marks: Pick<Milestones, "ready">): TryOutcome {
  if (record.status === "captured") return record.stream_stop === "target_reached" ? "clean" : "hangup_4k";
  if (record.status === "captured_degraded") return "hangup_low";
  return marks.ready === null ? "no_rdy" : "no_video";
}
