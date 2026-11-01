import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { CommandType, Device, EufySecurity, PropertyName, Station, VideoCodec } from "eufy-security-client";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import { LegacyAdapter } from "../src/adapters/legacy.ts";
import type { LegacyClient, LegacyDevice, LegacyStation } from "../src/adapters/legacy.ts";

const SERIAL = "T86P2FULLSERIAL1234";

function fakeDevice(overrides: Partial<LegacyDevice> & { properties?: Record<string, unknown> } = {}): LegacyDevice {
  const properties = overrides.properties ?? {
    [PropertyName.DeviceBattery]: 77,
    [PropertyName.DeviceCellularRSSI]: -91,
    [PropertyName.DeviceCellularIMEI]: "SECRET-IMEI",
    [PropertyName.DeviceCellularICCID]: "SECRET-ICCID",
  };
  return {
    getSerial: () => SERIAL,
    getStationSerial: () => SERIAL,
    getModel: () => "T86P2321",
    getSoftwareVersion: () => "3.4.5",
    hasProperty: (name) => name in properties,
    getPropertyValue: (name) => properties[name],
    getRawDevice: () => ({ params: [{ param_type: CommandType.CMD_GET_BATTERY, update_time: 1_767_323_045 }] }),
    ...overrides,
  };
}

class FakeStation implements LegacyStation {
  connected = false;
  streaming = false;
  closes = 0;
  closeStaysConnected = false;

  getSerial(): string {
    return SERIAL;
  }
  isConnected(): boolean {
    return this.connected;
  }
  isEnergySavingDevice(): boolean {
    return true;
  }
  isLiveStreaming(): boolean {
    return this.streaming;
  }
  close(): void {
    this.closes += 1;
    if (!this.closeStaysConnected) this.connected = false;
  }
}

class FakeClient extends EventEmitter implements LegacyClient {
  station = new FakeStation();
  devices: LegacyDevice[] = [fakeDevice()];
  commands: string[] = [];
  connectOptions: unknown[] = [];
  apiConnected = false;
  onConnectCall: (() => void) | undefined;
  onConnectToStation: (() => void) | undefined;
  onStartLivestream: (() => void) | undefined;
  stopFails = false;

  isConnected(): boolean {
    return this.apiConnected;
  }
  async connect(options: unknown): Promise<void> {
    this.connectOptions.push(options);
    this.onConnectCall?.();
  }
  async refreshCloudData(): Promise<void> {}
  async getDevices(): Promise<LegacyDevice[]> {
    return this.devices;
  }
  async getDevice(): Promise<LegacyDevice> {
    return fakeDevice();
  }
  async getStation(): Promise<LegacyStation> {
    return this.station;
  }
  async connectToStation(): Promise<void> {
    this.commands.push("connect");
    this.onConnectToStation?.();
  }
  async startStationLivestream(): Promise<void> {
    this.commands.push("start");
    this.onStartLivestream?.();
  }
  async stopStationLivestream(): Promise<void> {
    this.commands.push("stop");
    if (this.stopFails) throw new Error("stop refused");
    this.station.streaming = false;
  }
  setCameraMaxLivestreamDuration(): void {}
  close(): void {
    this.commands.push("client-close");
  }

  /** The camera connects, then starts streaming, the moment it is asked to. */
  answerEverything(videoCodec: VideoCodec = VideoCodec.H265): void {
    this.onConnectToStation = () => {
      this.station.connected = true;
      this.emit("station connect", this.station);
    };
    this.onStartLivestream = () => {
      this.station.streaming = true;
      this.emit(
        "station livestream start",
        this.station,
        fakeDevice(),
        { videoCodec, videoFPS: 15, videoWidth: 1920, videoHeight: 1080, audioCodec: 0 },
        new PassThrough(),
        new PassThrough(),
      );
    };
  }
}

function setup(): { client: FakeClient; adapter: LegacyAdapter; warnings: string[] } {
  const client = new FakeClient();
  const warnings: string[] = [];
  const adapter = new LegacyAdapter(async () => client, (message) => warnings.push(message));
  return { client, adapter, warnings };
}

function deadlineSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort("deadline"), ms);
  return controller.signal;
}

describe("LegacyAdapter authentication", () => {
  it("reports each state the login can land in", async () => {
    const { client, adapter } = setup();

    client.onConnectCall = () => client.emit("tfa request");
    assert.deepEqual(await adapter.authenticate(), { status: "tfa_required" });

    client.onConnectCall = () => client.emit("captcha request", "id-1", "data:image/png;base64,AAAA");
    assert.deepEqual(await adapter.authenticate({ verifyCode: "123456" }), {
      status: "captcha_required",
      captchaId: "id-1",
      captchaImage: "data:image/png;base64,AAAA",
    });

    client.onConnectCall = () => client.emit("connect");
    assert.deepEqual(await adapter.authenticate({ captcha: { id: "id-1", code: "xyz" } }), { status: "authenticated" });

    assert.deepEqual(client.connectOptions, [
      { force: false },
      { force: false, verifyCode: "123456" },
      { force: false, captcha: { captchaId: "id-1", captchaCode: "xyz" } },
    ]);
  });

  it("turns a login error into an auth failure that says what to do", async () => {
    const { client, adapter } = setup();
    client.onConnectCall = () => client.emit("connection error", new Error("bad password"));
    await assert.rejects(adapter.authenticate(), (error: CaptureFailure) => {
      assert.equal(error.reason, "auth_required");
      assert.match(error.message, /bad password/);
      assert.match(error.message, /login command/);
      return true;
    });
  });

  it("keeps going when only the legacy backend errors, as the library does", async () => {
    const { client, adapter } = setup();
    client.onConnectCall = () => {
      client.emit("connection error", new Error("Invalid passport profile response"));
      client.emit("connect");
    };
    assert.deepEqual(await adapter.authenticate(), { status: "authenticated" });
  });

  it("fails when connect() finishes with no outcome and no error", async () => {
    const { adapter } = setup();
    await assert.rejects(adapter.authenticate(), /finished without a result/);
  });

  it("skips the login when the cloud session is already up", async () => {
    const { client, adapter } = setup();
    client.apiConnected = true;
    assert.deepEqual(await adapter.authenticate(), { status: "authenticated" });
    assert.deepEqual(client.connectOptions, []);
  });
});

describe("LegacyAdapter discovery", () => {
  it("finds the camera and reads its battery with the reading's age", async () => {
    const { adapter } = setup();
    const camera = await adapter.discoverCamera();
    assert.equal(camera.key, SERIAL);
    assert.equal(camera.model, "T86P2321");
    assert.equal(camera.firmware, "3.4.5");
    assert.deepEqual(camera.battery, { percent: 77, observedAt: "2026-01-02T03:04:05.000Z", note: null });
  });

  it("reports an unknown battery as unknown, never zero", async () => {
    const { client, adapter } = setup();
    client.devices = [fakeDevice({ properties: {} })];
    const camera = await adapter.discoverCamera();
    assert.equal(camera.battery.percent, null);
    assert.equal(camera.battery.observedAt, null);
    assert.ok(camera.battery.note !== null);
  });

  it("does not collect the SIM's identifiers", async () => {
    const { adapter } = setup();
    const camera = await adapter.discoverCamera();
    assert.deepEqual(camera.telemetry, { [PropertyName.DeviceCellularRSSI]: -91 });
    assert.doesNotMatch(JSON.stringify(camera), /SECRET-/);
  });

  it("names what the account can see when the camera isn't there", async () => {
    const { client, adapter } = setup();
    client.devices = [fakeDevice({ getModel: () => "T8160" })];
    await assert.rejects(adapter.discoverCamera(), (error: CaptureFailure) => {
      assert.equal(error.reason, "camera_not_found");
      assert.match(error.message, /T8160/);
      assert.match(error.message, /share the camera/);
      return true;
    });
  });

  it("refuses to guess between two cameras", async () => {
    const { client, adapter } = setup();
    client.devices = [fakeDevice(), fakeDevice({ getSerial: () => "T86P2OTHER" })];
    await assert.rejects(adapter.discoverCamera(), /EUFY_CAMERA_SERIAL/);
  });
});

describe("LegacyAdapter live sessions", () => {
  it("opens a cold session, connecting before asking for the stream", async () => {
    const { client, adapter } = setup();
    client.answerEverything();
    const session = await adapter.openLiveSession(SERIAL, new AbortController().signal);
    assert.deepEqual(client.commands, ["connect", "start"]);
    assert.equal(session.coldConnection, true);
    assert.equal(session.codec, "h265");
    assert.deepEqual([session.reportedWidth, session.reportedHeight, session.reportedFps], [1920, 1080, 15]);
  });

  it("flags a session that reused an open connection as not cold", async () => {
    const { client, adapter } = setup();
    client.answerEverything(VideoCodec.H264);
    client.station.connected = true;
    const session = await adapter.openLiveSession(SERIAL, new AbortController().signal);
    assert.equal(session.coldConnection, false);
    assert.equal(session.codec, "h264");
    assert.deepEqual(client.commands, ["start"]);
  });

  it("refuses a stream left over from an earlier session", async () => {
    const { client, adapter } = setup();
    client.station.streaming = true;
    await assert.rejects(adapter.openLiveSession(SERIAL, new AbortController().signal), (error: CaptureFailure) => {
      assert.equal(error.reason, "stale_source");
      return true;
    });
    assert.deepEqual(client.commands, []);
  });

  it("counts the library's retries and reports the camera unreachable at the deadline", async () => {
    const { client, adapter } = setup();
    client.onConnectToStation = () => client.emit("station connection error", client.station, new Error("timeout"));
    await assert.rejects(adapter.openLiveSession(SERIAL, deadlineSignal(10)), (error: CaptureFailure) => {
      assert.equal(error.reason, "camera_unreachable");
      assert.equal(error.phase, "connect");
      assert.match(error.message, /1 retries/);
      return true;
    });
  });

  it("reports a stream that never starts as a timeout, in the right phase", async () => {
    const { client, adapter } = setup();
    client.onConnectToStation = () => {
      client.station.connected = true;
      client.emit("station connect", client.station);
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, deadlineSignal(10)), (error: CaptureFailure) => {
      assert.equal(error.reason, "capture_timeout");
      assert.equal(error.phase, "stream_start");
      return true;
    });
  });

  it("fails fast when the connection drops before the stream starts", async () => {
    const { client, adapter } = setup();
    client.onConnectToStation = () => {
      client.emit("station connect", client.station);
      client.emit("station close", client.station);
    };
    await assert.rejects(adapter.openLiveSession(SERIAL, new AbortController().signal), (error: CaptureFailure) => {
      assert.equal(error.reason, "camera_unreachable");
      assert.equal(error.phase, "stream_start");
      return true;
    });
  });

  it("stops on a termination signal", async () => {
    const { adapter } = setup();
    const controller = new AbortController();
    const opening = adapter.openLiveSession(SERIAL, controller.signal);
    await delay(1);
    controller.abort("terminated");
    await assert.rejects(opening, (error: CaptureFailure) => {
      assert.equal(error.reason, "aborted");
      return true;
    });
  });
});

describe("LegacyAdapter connection guard", () => {
  it("closes and counts a camera connection that opens outside an attempt", async () => {
    const { client, adapter, warnings } = setup();
    await adapter.discoverCamera();
    client.station.connected = true;
    client.emit("station connect", client.station);
    assert.equal(client.station.closes, 1);
    assert.equal(client.station.connected, false);
    assert.equal(adapter.unexpectedConnectionCount(), 1);
    assert.equal(warnings.length, 1);
  });

  it("leaves the attempt's own connection alone", async () => {
    const { client, adapter } = setup();
    client.answerEverything();
    await adapter.openLiveSession(SERIAL, new AbortController().signal);
    assert.equal(client.station.closes, 0);
    assert.equal(adapter.unexpectedConnectionCount(), 0);
  });

  it("clears the reconnect the library schedules after a failed connect, once the attempt is over", async () => {
    const { client, adapter } = setup();
    await adapter.discoverCamera();

    // Station.onTimeout emits first and schedules its reconnect after, so close() has to run later.
    let reconnectScheduled = false;
    let closedAfterSchedule = false;
    client.on("station connection error", () => {
      reconnectScheduled = true;
    });
    const originalClose = client.station.close.bind(client.station);
    client.station.close = () => {
      closedAfterSchedule = reconnectScheduled;
      originalClose();
    };

    client.emit("station connection error", client.station, new Error("timeout"));
    await delay(5);
    assert.equal(closedAfterSchedule, true);
  });

  it("catches a connect that lands after teardown", async () => {
    const { client, adapter } = setup();
    client.answerEverything();
    await adapter.openLiveSession(SERIAL, new AbortController().signal);
    await adapter.teardown(SERIAL, 50);

    client.station.connected = true;
    client.emit("station connect", client.station);
    assert.equal(client.station.connected, false);
    assert.equal(adapter.unexpectedConnectionCount(), 1);
  });
});

describe("LegacyAdapter teardown", () => {
  it("stops the stream and closes the connection", async () => {
    const { client, adapter } = setup();
    client.answerEverything();
    await adapter.openLiveSession(SERIAL, new AbortController().signal);
    assert.deepEqual(await adapter.teardown(SERIAL, 50), { status: "ok", detail: null });
    assert.deepEqual(client.commands, ["connect", "start", "stop"]);
    assert.equal(client.station.isConnected(), false);
  });

  it("reports a connection that won't close", async () => {
    const { client, adapter } = setup();
    client.station.connected = true;
    client.station.closeStaysConnected = true;
    const result = await adapter.teardown(SERIAL, 20);
    assert.equal(result.status, "timeout");
    assert.match(result.detail ?? "", /still open/);
  });

  it("still closes the connection when stopping the stream fails, and reports it", async () => {
    const { client, adapter } = setup();
    client.stopFails = true;
    client.station.connected = true;
    client.station.streaming = true;
    const result = await adapter.teardown(SERIAL, 20);
    assert.equal(result.status, "error");
    assert.match(result.detail ?? "", /stop refused/);
    assert.equal(client.station.isConnected(), false);
  });
});

describe("the pinned library still has what the adapter calls", () => {
  it("EufySecurity", () => {
    for (const method of ["on", "off", "isConnected", "connect", "refreshCloudData", "getDevices", "getDevice", "getStation", "connectToStation", "startStationLivestream", "stopStationLivestream", "setCameraMaxLivestreamDuration", "close"]) {
      assert.equal(typeof (EufySecurity.prototype as unknown as Record<string, unknown>)[method], "function", method);
    }
  });

  it("Station and Device", () => {
    for (const method of ["getSerial", "isConnected", "isEnergySavingDevice", "isLiveStreaming", "close"]) {
      assert.equal(typeof (Station.prototype as unknown as Record<string, unknown>)[method], "function", `Station.${method}`);
    }
    for (const method of ["getSerial", "getStationSerial", "getModel", "getSoftwareVersion", "hasProperty", "getPropertyValue", "getRawDevice"]) {
      assert.equal(typeof (Device.prototype as unknown as Record<string, unknown>)[method], "function", `Device.${method}`);
    }
  });

  it("classifies the T86P2 as a battery device, so cloud refreshes don't auto-connect to it", async () => {
    const { DeviceType } = await import("eufy-security-client");
    assert.equal(Device.hasBattery(DeviceType.CAMERA_4G_S330), true);
  });
});
