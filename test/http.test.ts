import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { createStatusServer, listenForStatus } from "../src/http.ts";

describe("the status server", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
  });

  async function serve(report: () => Promise<unknown>): Promise<string> {
    server = createStatusServer(report);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("says only that it's alive on /healthz, without building a report", async () => {
    const base = await serve(async () => {
      throw new Error("not this path");
    });
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "alive\n");
  });

  it("serves the report on /status", async () => {
    const base = await serve(async () => ({ revision: "abc" }));
    const response = await fetch(`${base}/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { revision: "abc" });
  });

  it("answers 500 when the report fails, and keeps serving", async () => {
    let failing = true;
    const base = await serve(async () => {
      if (failing) throw new Error("database is locked");
      return { ok: true };
    });
    const failed = await fetch(`${base}/status`);
    assert.equal(failed.status, 500);
    assert.equal(await failed.text(), "database is locked\n");
    failing = false;
    assert.equal((await fetch(`${base}/status`)).status, 200);
  });

  for (const rejection of [null, "database is locked"]) {
    it(`answers 500 when the report rejects with ${JSON.stringify(rejection)} rather than an Error, and keeps serving`, async () => {
      let failing = true;
      const base = await serve(() => (failing ? Promise.reject(rejection) : Promise.resolve({ ok: true })));
      const failed = await fetch(`${base}/status`);
      assert.equal(failed.status, 500);
      assert.equal(await failed.text(), `${String(rejection)}\n`);
      failing = false;
      assert.equal((await fetch(`${base}/status`)).status, 200);
    });
  }

  it("answers 500 when the report can't be serialized", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const base = await serve(async () => circular);
    assert.equal((await fetch(`${base}/status`)).status, 500);
  });

  it("reports a port someone else holds, and doesn't take the service down", async () => {
    const holder = createStatusServer(async () => ({}));
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const { port } = holder.address() as AddressInfo;
    server = createStatusServer(async () => ({}));
    const logged: string[] = [];
    listenForStatus(server, port, "127.0.0.1", (message) => logged.push(message));
    while (logged.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.match(logged[0] ?? "", /EADDRINUSE.*capture carries on/);
    holder.close();
  });

  it("knows nothing else", async () => {
    const base = await serve(async () => ({}));
    assert.equal((await fetch(`${base}/frames`)).status, 404);
  });
});
