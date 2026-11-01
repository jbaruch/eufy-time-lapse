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
  /** The hole punch itself: bursts at consecutive ports on the camera's address, which carrier NAT defeats anyway. */
  holePunch: boolean;
  /** Stops asking the lookup servers for new P2P sessions once the relay handshake has begun. */
  stopLookupsOnRelay: boolean;
  /**
   * How long one relay step may wait before asking the lookup servers for the relay list again. Relays answer only
   * once the camera has heard about them, and the SDK asks once, so a lost message would otherwise end the connect.
   */
  relayStallMs: number | null;
  /** Keeps a stream's first start when the level-2 key arrives, instead of starting it again with the key. */
  singleStart: boolean;
}

export const SDK_POLICY: ConnectPolicy = { relayAfterRounds: null, probeSockets: true, holePunch: true, stopLookupsOnRelay: false, relayStallMs: null, singleStart: false };

/** What this camera needs on carrier NAT: 98 of 100 back-to-back tries at 4K, against 3 of 10 with the SDK's own. lab/ measures it. */
export const CELLULAR_POLICY: ConnectPolicy = { relayAfterRounds: 1, probeSockets: false, holePunch: false, stopLookupsOnRelay: true, relayStallMs: 2000, singleStart: true };

/** Goes in each frame's adapter version, because this policy changes how the SDK reaches the camera. */
export const CONNECT_POLICY_VERSION = "cellular-1";

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

interface RelayHandshake {
  step: string;
  relays: Address[];
  via?: Address | undefined;
  mark?: number | undefined;
  /** Not the SDK's: the step this project last saw the handshake waiting on, and since when. */
  waitingOn?: string | undefined;
  waitingSince?: number | undefined;
}

interface SessionInternals {
  connected: boolean;
  socket: unknown;
  relay: RelayHandshake | undefined;
  ackedRounds: number | undefined;
  cloudLookup: unknown;
  cfg: { p2pDid: string };
  level2Key: Buffer | undefined;
  liveStartedChannels: Map<number, string>;
  startLiveMedia(channel: number, accountId: string, homeBaseAttached: boolean, options: { force?: boolean } | undefined): void;
  startPunchProbes(): Promise<void>;
  beginCheckCam(address: Address, socket: unknown): void;
  sendLookups(): void;
  countAckedRound(): void;
  sendRelay(): void;
  send(address: Address, type: Buffer, payload: Buffer | undefined, socket: unknown, done: unknown): void;
  onMessage(message: Buffer, remote: { address: string; port: number }, socket: unknown): void;
}

const WRAPPED_METHODS = ["startPunchProbes", "beginCheckCam", "sendLookups", "countAckedRound", "sendRelay", "startLiveMedia", "send", "onMessage"] as const;

let policy = SDK_POLICY;
let packetListener: ((event: PacketEvent) => void) | null = null;
let installed = false;

function restartRelayHandshake(relay: RelayHandshake): void {
  relay.step = "list";
  relay.relays = [];
  relay.via = undefined;
  relay.mark = undefined;
  relay.waitingOn = undefined;
  relay.waitingSince = undefined;
}

function install(): void {
  if (installed) return;
  const session = P2PSession.prototype as unknown as SessionInternals;
  for (const method of WRAPPED_METHODS) {
    if (typeof session[method] !== "function") throw new Error(`The pinned SDK has no P2PSession.${method}, so the connect policy can't apply. Check the SDK version in package.json.`);
  }
  const { startPunchProbes, beginCheckCam, sendLookups, countAckedRound, sendRelay, startLiveMedia, send, onMessage } = session;

  session.startPunchProbes = function (this: SessionInternals): Promise<void> {
    return policy.probeSockets ? startPunchProbes.call(this) : Promise.resolve();
  };
  session.beginCheckCam = function (this: SessionInternals, address, socket): void {
    if (policy.holePunch) beginCheckCam.call(this, address, socket);
  };
  session.countAckedRound = function (this: SessionInternals): void {
    if (policy.relayAfterRounds === null) {
      countAckedRound.call(this);
      return;
    }
    if (this.ackedRounds === undefined || this.relay !== undefined || this.cloudLookup === undefined) return;
    this.ackedRounds += 1;
    if (this.ackedRounds > policy.relayAfterRounds) this.relay = { step: "list", relays: [] };
  };
  session.sendLookups = function (this: SessionInternals): void {
    if (policy.stopLookupsOnRelay && this.relay !== undefined && !this.connected && this.socket !== undefined) {
      this.sendRelay();
      return;
    }
    sendLookups.call(this);
  };
  session.sendRelay = function (this: SessionInternals): void {
    const relay = this.relay;
    if (policy.relayStallMs !== null && relay !== undefined && relay.step !== "list" && !this.connected) {
      if (relay.waitingOn !== relay.step) {
        relay.waitingOn = relay.step;
        relay.waitingSince = Date.now();
      } else if (Date.now() - (relay.waitingSince ?? 0) >= policy.relayStallMs) {
        restartRelayHandshake(relay);
      }
    }
    sendRelay.call(this);
  };
  session.startLiveMedia = function (this: SessionInternals, channel, accountId, homeBaseAttached, options): void {
    // Telling the SDK this channel already started with the key turns its second start into a keepalive.
    if (policy.singleStart && options?.force !== true && this.level2Key !== undefined && this.liveStartedChannels.has(channel)) this.liveStartedChannels.set(channel, "l2");
    startLiveMedia.call(this, channel, accountId, homeBaseAttached, options);
  };
  session.send = function (this: SessionInternals, address, type, payload, socket, done): void {
    packetListener?.({ direction: "out", host: address.host, port: address.port, type: type.toString("hex"), payload: payload ?? Buffer.alloc(0), did: this.cfg.p2pDid });
    send.call(this, address, type, payload, socket, done);
  };
  session.onMessage = function (this: SessionInternals, message, remote, socket): void {
    packetListener?.({ direction: "in", host: remote.address, port: remote.port, type: message.subarray(0, 2).toString("hex"), payload: message.subarray(4), did: this.cfg.p2pDid });
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
