import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { createStatusServer } from "../src/http.ts";

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

  it("answers 500 when the report can't be serialized", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const base = await serve(async () => circular);
    assert.equal((await fetch(`${base}/status`)).status, 500);
  });

  it("knows nothing else", async () => {
    const base = await serve(async () => ({}));
    assert.equal((await fetch(`${base}/frames`)).status, 404);
  });
});
