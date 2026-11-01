import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { P2PSession } from "@mega-yfue/eufy-sdk";
import { SDK_POLICY, setConnectPolicy, setPacketListener } from "../src/adapters/p2p-policy.ts";
import type { ConnectPolicy, PacketEvent } from "../src/adapters/p2p-policy.ts";

const DID = "ABCDEFG-000123-ABCDE";
const KEY = "lookup-key";
const LOOKUP_SERVER = { host: "192.0.2.1", port: 32100 };
const RELAY = { address: "192.0.2.9", port: 11441 };

interface SentPacket {
  host: string;
  port: number;
  type: string;
  payload: Buffer;
}

interface RelayState {
  step: string;
  relays: Array<{ host: string; port: number }>;
}

interface Internals {
  socket: unknown;
  selfHost: string;
  cloudLookup: unknown;
  ackedRounds: number | undefined;
  relay: RelayState | undefined;
  probeSockets: unknown[];
  connected: boolean;
  startPunchProbes(): Promise<void>;
  beginCheckCam(address: { host: string; port: number }, socket: unknown): void;
  sendLookups(): void;
  onMessage(message: Buffer, remote: { address: string; port: number }, socket?: unknown): void;
}

/** A real SDK session, on a fake socket that keeps what it's asked to send. */
function realSession(): { session: Internals; sent: SentPacket[]; relayStep: () => string | undefined } {
  const session = new P2PSession({ stationSn: "T86P2FULLSERIAL1234", p2pDid: DID, noBroadcast: true }) as unknown as Internals;
  session.selfHost = "192.0.2.50";
  const sent: SentPacket[] = [];
  session.socket = {
    address: () => ({ port: 40000 }),
    send(packet: Buffer, port: number, host: string, done?: () => void): void {
      sent.push({ host, port, type: packet.subarray(0, 2).toString("hex"), payload: packet.subarray(4) });
      done?.();
    },
  };
  session.cloudLookup = { key: KEY, addresses: [LOOKUP_SERVER] };
  session.ackedRounds = 0;
  return { session, sent, relayStep: () => session.relay?.step };
}

const quiet: ConnectPolicy = { relayAfterRounds: 2, probeSockets: false, holePunch: false, stopLookupsOnRelay: true, relayStallMs: 2000 };

function relayPacket(): Buffer {
  return Buffer.concat([Buffer.from([0xf1, 0x83, 0x00, 0x1c]), Buffer.from([0xaa, 0xcc, 0x19, 0x1b]), Buffer.alloc(20, 7), Buffer.alloc(4)]);
}

/** An address record as the protocol encodes one: family, little-endian port, then the IP in reverse. */
function addressRecord(address: { host: string; port: number }): Buffer {
  const record = Buffer.alloc(16);
  record.writeUInt16BE(2, 0);
  record.writeUInt16LE(address.port, 2);
  const [a = 0, b = 0, c = 0, d = 0] = address.host.split(".").map(Number);
  record.set([d, c, b, a], 4);
  return record;
}

function packet(type: number, payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length, 0);
  return Buffer.concat([Buffer.from([0xf1, type]), length, payload]);
}

const RELAY_A = { host: "192.0.2.10", port: 10000 };
const RELAY_B = { host: "192.0.2.11", port: 10000 };

/** Walks a real session through the handshake to the point of waiting on the camera at RELAY_A. */
function waitingAtRelayA(session: Internals): void {
  const remote = { address: LOOKUP_SERVER.host, port: LOOKUP_SERVER.port };
  session.relay = { step: "list", relays: [] };
  session.onMessage(packet(0x69, Buffer.concat([Buffer.from([2, 0, 0, 0]), addressRecord(RELAY_A), addressRecord(RELAY_B)])), remote, session.socket);
  session.onMessage(packet(0x71, Buffer.alloc(0)), { address: RELAY_A.host, port: RELAY_A.port }, session.socket);
  const portAck = Buffer.alloc(8);
  portAck.writeUInt32BE(0xaabbccdd, 0);
  portAck.writeUInt16BE(11441, 4);
  session.onMessage(packet(0x73, portAck), { address: RELAY_A.host, port: RELAY_A.port }, session.socket);
}

describe("connect policy, against the real SDK session", () => {
  afterEach(() => {
    setConnectPolicy(SDK_POLICY);
    setPacketListener(null);
  });

  it("keeps the SDK's own wait for the relay by default: 24 rounds", () => {
    setConnectPolicy(SDK_POLICY);
    const { session, relayStep } = realSession();
    for (let round = 0; round < 24; round += 1) session.sendLookups();
    assert.equal(relayStep(), undefined);
    session.sendLookups();
    assert.equal(relayStep(), "list");
  });

  it("starts the relay after the configured rounds", () => {
    setConnectPolicy(quiet);
    const { session, relayStep } = realSession();
    session.sendLookups();
    session.sendLookups();
    assert.equal(relayStep(), undefined);
    session.sendLookups();
    assert.equal(relayStep(), "list");
  });

  it("doesn't start the relay before the lookup server has acknowledged", () => {
    setConnectPolicy(quiet);
    const { session, relayStep } = realSession();
    session.ackedRounds = undefined;
    for (let round = 0; round < 10; round += 1) session.sendLookups();
    assert.equal(relayStep(), undefined);
  });

  it("stops asking for new P2P sessions once the relay handshake has begun, and keeps the handshake going", () => {
    setConnectPolicy(quiet);
    const { session, sent } = realSession();
    session.sendLookups();
    session.sendLookups();
    session.sendLookups();
    sent.length = 0;
    session.sendLookups();
    assert.deepEqual(sent.map((packet) => packet.type), ["f16a"], "only the relay list request");
  });

  it("keeps sending lookups during the relay handshake when told to", () => {
    setConnectPolicy({ ...quiet, stopLookupsOnRelay: false });
    const { session, sent } = realSession();
    session.sendLookups();
    session.sendLookups();
    session.sendLookups();
    sent.length = 0;
    session.sendLookups();
    assert.deepEqual(sent.map((packet) => packet.type), ["f126", "f16a"]);
  });

  it("opens no extra sockets when probes are off", async () => {
    setConnectPolicy(quiet);
    const { session } = realSession();
    await session.startPunchProbes();
    assert.deepEqual(session.probeSockets, []);
  });

  it("sends no hole-punch bursts when the punch is off, and the SDK's burst of seven when it's on", () => {
    const camera = { host: "192.0.2.77", port: 40000 };
    setConnectPolicy(quiet);
    const off = realSession();
    off.session.beginCheckCam(camera, off.session.socket);
    assert.deepEqual(off.sent, []);
    setConnectPolicy(SDK_POLICY);
    const on = realSession();
    on.session.beginCheckCam(camera, on.session.socket);
    assert.deepEqual(on.sent.map((one) => one.port).sort(), [39997, 39998, 39999, 40000, 40001, 40002, 40003]);
  });

  describe("when a relay step stalls", () => {
    it("keeps waiting on the same relay session while it still has time", (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      setConnectPolicy(quiet);
      const { session, sent, relayStep } = realSession();
      waitingAtRelayA(session);
      assert.equal(relayStep(), "request");
      sent.length = 0;
      t.mock.timers.tick(1999);
      session.sendLookups();
      assert.equal(relayStep(), "request");
      assert.deepEqual(sent.map((one) => one.type), ["f180"]);
    });

    it("asks the lookup servers for the relay list again when the camera doesn't join", (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      setConnectPolicy(quiet);
      const { session, sent, relayStep } = realSession();
      waitingAtRelayA(session);
      t.mock.timers.tick(2000);
      sent.length = 0;
      session.sendLookups();
      assert.equal(relayStep(), "list");
      assert.deepEqual(sent.map((one) => [one.type, one.host]), [["f16a", LOOKUP_SERVER.host]]);
    });

    it("asks for the relay list again when no relay answers hello", (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      setConnectPolicy(quiet);
      const { session, sent, relayStep } = realSession();
      session.relay = { step: "hello", relays: [RELAY_A, RELAY_B] };
      session.sendLookups();
      t.mock.timers.tick(1999);
      session.sendLookups();
      assert.equal(relayStep(), "hello");
      t.mock.timers.tick(1);
      sent.length = 0;
      session.sendLookups();
      assert.equal(relayStep(), "list");
      assert.deepEqual(sent.map((one) => one.type), ["f16a"]);
    });

    it("gives each step its own time", (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      setConnectPolicy(quiet);
      const { session, relayStep } = realSession();
      session.relay = { step: "hello", relays: [RELAY_A, RELAY_B] };
      session.sendLookups();
      t.mock.timers.tick(1900);
      session.sendLookups();
      session.onMessage(packet(0x71, Buffer.alloc(0)), { address: RELAY_A.host, port: RELAY_A.port }, session.socket);
      const portAck = Buffer.alloc(8);
      portAck.writeUInt16BE(11441, 4);
      session.onMessage(packet(0x73, portAck), { address: RELAY_A.host, port: RELAY_A.port }, session.socket);
      assert.equal(relayStep(), "request");
      t.mock.timers.tick(1900);
      session.sendLookups();
      assert.equal(relayStep(), "request");
    });

    it("never restarts by default", (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      setConnectPolicy({ ...quiet, relayStallMs: null });
      const { session, relayStep } = realSession();
      waitingAtRelayA(session);
      session.sendLookups();
      t.mock.timers.tick(60_000);
      session.sendLookups();
      assert.equal(relayStep(), "request");
    });
  });

  it("reports inbound and outbound packets to a listener", () => {
    setConnectPolicy(quiet);
    const { session } = realSession();
    const seen: PacketEvent[] = [];
    setPacketListener((event) => seen.push(event));
    session.onMessage(relayPacket(), RELAY, session.socket);
    session.sendLookups();
    assert.deepEqual(seen[0] && [seen[0].direction, seen[0].type, seen[0].host], ["in", "f183", RELAY.address]);
    assert.equal(seen[1]?.direction, "out");
  });
});
