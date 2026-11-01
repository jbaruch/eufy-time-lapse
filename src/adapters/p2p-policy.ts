import { P2PSession } from "@mega-yfue/eufy-sdk";

/**
 * How a connect to the camera behaves, where the SDK offers no setting. This wraps private methods of the
 * SDK's session class, which is why the SDK is pinned exactly and test/p2p-policy.test.ts runs against the real class.
 */
export interface ConnectPolicy {
  /** Lookup rounds, about a second each, before trying the relay. null keeps the SDK's 24. */
  relayAfterRounds: number | null;
  /** The SDK's seven extra sockets, which only help a hole punch. */
  probeSockets: boolean;
  /** Stops asking the lookup servers for new P2P sessions once the relay handshake has begun. */
  stopLookupsOnRelay: boolean;
  /** Answers the camera's relay packets with relay-ready, which the SDK never does. */
  answerRelayPacket: boolean;
}

export const SDK_POLICY: ConnectPolicy = { relayAfterRounds: null, probeSockets: true, stopLookupsOnRelay: false, answerRelayPacket: false };

export interface PacketEvent {
  direction: "in" | "out";
  host: string;
  port: number;
  /** The packet's two header bytes in hex, such as f184. */
  type: string;
  /** The bytes after the four-byte packet header. Holds keys on some outbound types, so never log it unfiltered. */
  payload: Buffer;
  did: string;
}

interface Address {
  host: string;
  port: number;
}

interface SessionInternals {
  connected: boolean;
  socket: unknown;
  relay: { step: string } | undefined;
  ackedRounds: number | undefined;
  cloudLookup: unknown;
  cfg: { p2pDid: string };
  startPunchProbes(): Promise<void>;
  sendLookups(): void;
  countAckedRound(): void;
  sendRelay(): void;
  send(address: Address, type: Buffer, payload: Buffer | undefined, socket: unknown, done: unknown): void;
  onMessage(message: Buffer, remote: { address: string; port: number }, socket: unknown): void;
}

const RELAY_PACKET = "f183";
const RELAY_READY_HEADER = Buffer.from([0xf1, 0x84]);
/** A relay packet's payload: a four-byte mark, then the 20-byte device id that relay-ready repeats. */
const RELAY_PACKET_DID = { start: 4, end: 24 };

const WRAPPED_METHODS = ["startPunchProbes", "sendLookups", "countAckedRound", "sendRelay", "send", "onMessage"] as const;

let policy = SDK_POLICY;
let packetListener: ((event: PacketEvent) => void) | null = null;
let installed = false;

function install(): void {
  if (installed) return;
  const session = P2PSession.prototype as unknown as SessionInternals;
  for (const method of WRAPPED_METHODS) {
    if (typeof session[method] !== "function") throw new Error(`The pinned SDK has no P2PSession.${method}, so the connect policy can't apply. Check the SDK version in package.json.`);
  }
  const { startPunchProbes, sendLookups, countAckedRound, send, onMessage } = session;

  session.startPunchProbes = function (this: SessionInternals): Promise<void> {
    return policy.probeSockets ? startPunchProbes.call(this) : Promise.resolve();
  };
  session.countAckedRound = function (this: SessionInternals): void {
    if (policy.relayAfterRounds === null) {
      countAckedRound.call(this);
      return;
    }
    if (this.ackedRounds === undefined || this.relay !== undefined || this.cloudLookup === undefined) return;
    this.ackedRounds += 1;
    if (this.ackedRounds > policy.relayAfterRounds) this.relay = { step: "list", relays: [] } as SessionInternals["relay"];
  };
  session.sendLookups = function (this: SessionInternals): void {
    if (policy.stopLookupsOnRelay && this.relay !== undefined && !this.connected && this.socket !== undefined) {
      this.sendRelay();
      return;
    }
    sendLookups.call(this);
  };
  session.send = function (this: SessionInternals, address, type, payload, socket, done): void {
    packetListener?.({ direction: "out", host: address.host, port: address.port, type: type.toString("hex"), payload: payload ?? Buffer.alloc(0), did: this.cfg.p2pDid });
    send.call(this, address, type, payload, socket, done);
  };
  session.onMessage = function (this: SessionInternals, message, remote, socket): void {
    const type = message.subarray(0, 2).toString("hex");
    const payload = message.subarray(4);
    packetListener?.({ direction: "in", host: remote.address, port: remote.port, type, payload, did: this.cfg.p2pDid });
    if (policy.answerRelayPacket && type === RELAY_PACKET) {
      this.send({ host: remote.address, port: remote.port }, RELAY_READY_HEADER, payload.subarray(RELAY_PACKET_DID.start, RELAY_PACKET_DID.end), socket, undefined);
    }
    onMessage.call(this, message, remote, socket);
  };
  installed = true;
}

export function setConnectPolicy(next: ConnectPolicy): void {
  install();
  policy = next;
}

export function setPacketListener(listener: ((event: PacketEvent) => void) | null): void {
  install();
  packetListener = listener;
}
