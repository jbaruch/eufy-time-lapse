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

interface Internals {
  socket: unknown;
  selfHost: string;
  cloudLookup: unknown;
  ackedRounds: number | undefined;
  relay: { step: string } | undefined;
  probeSockets: unknown[];
  connected: boolean;
  startPunchProbes(): Promise<void>;
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

const quiet: ConnectPolicy = { relayAfterRounds: 2, probeSockets: false, stopLookupsOnRelay: true, answerRelayPacket: true };

function relayPacket(flag: number): Buffer {
  const header = Buffer.from([0xf1, 0x83, 0x00, 0x1c]);
  const mark = Buffer.from([0xaa, 0xcc, 0x19, 0x1b]);
  const did = Buffer.alloc(20, 7);
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(flag, 0);
  return Buffer.concat([header, mark, did, tail]);
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

  it("answers the camera's relay packet with relay-ready, naming the device from the packet", () => {
    setConnectPolicy(quiet);
    const { session, sent } = realSession();
    session.onMessage(relayPacket(1), RELAY, session.socket);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.type, "f184");
    assert.equal(sent[0]?.host, RELAY.address);
    assert.equal(sent[0]?.port, RELAY.port);
    assert.deepEqual(sent[0]?.payload, Buffer.alloc(20, 7));
  });

  it("leaves relay packets unanswered, as the SDK does, by default", () => {
    setConnectPolicy(SDK_POLICY);
    const { session, sent } = realSession();
    session.onMessage(relayPacket(1), RELAY, session.socket);
    assert.deepEqual(sent, []);
  });

  it("reports packets both ways to a listener", () => {
    setConnectPolicy(quiet);
    const { session } = realSession();
    const seen: PacketEvent[] = [];
    setPacketListener((packet) => seen.push(packet));
    session.onMessage(relayPacket(1), RELAY, session.socket);
    assert.deepEqual(seen.map((packet) => [packet.direction, packet.type, packet.host]), [["in", "f183", RELAY.address], ["out", "f184", RELAY.address]]);
  });
});
