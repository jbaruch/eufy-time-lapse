import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blankMilestones, classifyOutcome, didAsHex, notePacket, traceEntry } from "../lab/classify.ts";
import type { PacketEvent } from "../src/adapters/p2p-policy.ts";

const DID = "ABCDEFG-000123-ABCDE";

function packet(direction: "in" | "out", type: string, payload: Buffer = Buffer.alloc(0), host = "192.0.2.1"): PacketEvent {
  return { direction, type, payload, host, port: 10000, did: DID };
}

describe("classifyOutcome", () => {
  const cases: Array<[string, Parameters<typeof classifyOutcome>[0], number | null, string]> = [
    ["a 4K frame with the target reached", { status: "captured", stream_stop: "target_reached" }, 9000, "clean"],
    ["a 4K frame before the camera hung up", { status: "captured", stream_stop: "stream_ended" }, 9000, "hangup_4k"],
    ["a 4K frame at the deadline, which isn't the target", { status: "captured", stream_stop: "deadline" }, 9000, "hangup_4k"],
    ["only a low-resolution frame", { status: "captured_degraded", stream_stop: "stream_ended" }, 9000, "hangup_low"],
    ["a failure before the camera joined", { status: "failed", stream_stop: null }, null, "no_rdy"],
    ["a failure after the camera joined", { status: "failed", stream_stop: "stream_ended" }, 9000, "no_video"],
  ];
  for (const [name, record, ready, expected] of cases) {
    it(`calls ${name} ${expected}`, () => {
      assert.equal(classifyOutcome(record, { ready }), expected);
    });
  }
});

describe("notePacket", () => {
  it("keeps the first time for each milestone", () => {
    const marks = blankMilestones();
    notePacket(marks, packet("in", "f184"), 100);
    notePacket(marks, packet("in", "f184"), 200);
    assert.equal(marks.ready, 100);
  });

  it("names the relay that granted the port", () => {
    const marks = blankMilestones();
    notePacket(marks, packet("in", "f173", Buffer.alloc(8), "192.0.2.5"), 50);
    assert.deepEqual([marks.relayPort, marks.relay], [50, "192.0.2.5"]);
  });

  it("counts lookups and list requests going out, not coming in", () => {
    const marks = blankMilestones();
    notePacket(marks, packet("out", "f126"), 1);
    notePacket(marks, packet("in", "f126"), 2);
    notePacket(marks, packet("out", "f16a"), 3);
    assert.deepEqual([marks.lookupsSent, marks.listRequests], [1, 1]);
  });

  it("counts distinct relay requests, so a re-send isn't a new roll", () => {
    const marks = blankMilestones();
    notePacket(marks, packet("out", "f180", Buffer.from([1])), 1);
    notePacket(marks, packet("out", "f180", Buffer.from([1])), 2);
    notePacket(marks, packet("out", "f180", Buffer.from([2])), 3);
    assert.equal(marks.relayRequests.size, 2);
  });
});

describe("traceEntry", () => {
  it("masks the device id in what it keeps", () => {
    const did = Buffer.from(didAsHex(DID), "hex");
    const entry = traceEntry(packet("in", "f184", Buffer.concat([Buffer.from([0xaa]), did])));
    assert.equal(entry?.hex, "aa<did>");
  });

  it("never keeps a lookup's payload, which holds the account's lookup key", () => {
    const entry = traceEntry(packet("out", "f126", Buffer.from("the-lookup-key")));
    assert.equal(entry?.hex, undefined);
    assert.equal(JSON.stringify(entry).includes("the-lookup-key"), false);
    assert.equal(entry?.len, 14);
  });

  it("drops video traffic altogether", () => {
    assert.equal(traceEntry(packet("in", "f1d0", Buffer.alloc(1000))), null);
    assert.equal(traceEntry(packet("out", "f1d1")), null);
  });
});

describe("didAsHex", () => {
  it("lays a device id out as it appears in packets", () => {
    assert.equal(didAsHex("AB-000258-CD"), `${Buffer.from("AB").toString("hex")}000000000000${"00000102"}${Buffer.from("CD").toString("hex")}000000000000`);
  });
});
