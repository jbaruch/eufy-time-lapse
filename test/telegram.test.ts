import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as HttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { ConfigError } from "../src/config.ts";
import { checkRoute, failure, sendTelegram, TelegramDeliveryError } from "../src/telegram.ts";
import type { TelegramRoute } from "../src/telegram.ts";
import { tempDir } from "./helpers/fixtures.ts";

const run = promisify(execFile);
const CREDENTIAL = { user: "x", password: "proxy-secret" };

describe("sendTelegram, through a stand-in gateway", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let ca: string;
  let telegram: HttpsServer;
  let gateway: HttpServer;
  let gatewayPort = 0;
  let received: Array<{ method: string | undefined; url: string | undefined; body: string }>;
  let tunnels: Array<{ target: string | undefined; authorization: string | undefined }>;
  let telegramStatus: number;
  let gatewayStatus: number;

  /** A certificate for Telegram's host name, so the real name checks run against a local server. */
  async function certificate(name: string): Promise<{ key: string; cert: string }> {
    const keyPath = join(dir.path, `${name}.key`);
    const certPath = join(dir.path, `${name}.pem`);
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=api.telegram.org", "-addext", "subjectAltName=DNS:api.telegram.org"]);
    return { key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8") };
  }

  function bodyOf(request: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => resolve(body));
    });
  }

  before(async () => {
    dir = await tempDir();
    const { key, cert } = await certificate("telegram");
    ca = cert;
    telegram = createHttpsServer({ key, cert }, (request, response) => {
      void bodyOf(request).then((body) => {
        received.push({ method: request.method, url: request.url, body });
        response.writeHead(telegramStatus, { "content-type": "application/json" }).end('{"ok":true,"description":"private text from Telegram"}');
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, "127.0.0.1", resolve));
    const telegramPort = (telegram.address() as AddressInfo).port;
    gateway = createHttpServer();
    gateway.on("connect", (request, client, head) => {
      tunnels.push({ target: request.url, authorization: request.headers["proxy-authorization"] });
      if (gatewayStatus !== 200) {
        client.end(`HTTP/1.1 ${gatewayStatus} Refused\r\n\r\n`);
        return;
      }
      const upstream = netConnect(telegramPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    gatewayPort = (gateway.address() as AddressInfo).port;
  });

  after(async () => {
    telegram.closeAllConnections();
    telegram.close();
    gateway.closeAllConnections();
    gateway.close();
    await dir.remove();
  });

  beforeEach(() => {
    received = [];
    tunnels = [];
    telegramStatus = 200;
    gatewayStatus = 200;
  });

  const route = (overrides: Partial<TelegramRoute> = {}): TelegramRoute => ({
    botId: "123456",
    chatId: "-100200300",
    proxyUrl: `http://${CREDENTIAL.user}:${CREDENTIAL.password}@127.0.0.1:${gatewayPort}`,
    ca,
    ...overrides,
  });

  it("asks the gateway for a tunnel with its credential, and sends the placeholder rather than a token", async () => {
    await sendTelegram(route(), "battery is at 20%");
    assert.deepEqual(tunnels, [{ target: "api.telegram.org:443", authorization: `Basic ${Buffer.from(`${CREDENTIAL.user}:${CREDENTIAL.password}`).toString("base64")}` }]);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.method, "POST");
    assert.equal(received[0]?.url, "/bot123456:onecli-managed/sendMessage");
    assert.deepEqual(JSON.parse(received[0]?.body ?? ""), { chat_id: "-100200300", text: "battery is at 20%" });
  });

  it("cuts a message that Telegram would refuse for its length", async () => {
    await sendTelegram(route(), "x".repeat(5_000));
    assert.equal((JSON.parse(received[0]?.body ?? "") as { text: string }).text.length, 4_000);
  });

  function refusedWithout(secret: string, pattern: RegExp) {
    return (error: Error): boolean => {
      assert.ok(error instanceof TelegramDeliveryError, `${error.name}: ${error.message}`);
      assert.match(error.message, pattern);
      assert.equal(error.message.includes(secret), false, "no credential in the message");
      return true;
    };
  }

  it("reports a refusal from Telegram by status, without quoting its answer", async () => {
    telegramStatus = 403;
    await assert.rejects(sendTelegram(route(), "hello"), (error: Error) => {
      refusedWithout(CREDENTIAL.password, /HTTP 403/)(error);
      assert.equal(error.message.includes("private text"), false);
      return true;
    });
  });

  it("reports a gateway that refuses the tunnel, and points at the identity", async () => {
    gatewayStatus = 407;
    await assert.rejects(sendTelegram(route(), "hello"), refusedWithout(CREDENTIAL.password, /407.*OneCLI identity/));
    assert.deepEqual(received, []);
  });

  it("reports an unreachable gateway without quoting its URL, which holds the credential", async () => {
    await assert.rejects(sendTelegram(route({ proxyUrl: `http://${CREDENTIAL.user}:${CREDENTIAL.password}@127.0.0.1:1` }), "hello"), refusedWithout(CREDENTIAL.password, /reaching the gateway: ECONNREFUSED/));
  });

  it("refuses to talk to anything but what the given certificates vouch for", async () => {
    const other = await certificate("other");
    await assert.rejects(sendTelegram(route({ ca: other.cert }), "hello"), refusedWithout(CREDENTIAL.password, /talking to Telegram/));
    assert.deepEqual(received, [], "nothing was sent to an untrusted server");
  });
});

describe("checkRoute", () => {
  const good: TelegramRoute = { botId: "1", chatId: "-2", proxyUrl: "http://x:proxy-secret@172.17.0.1:10255", ca: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n" };

  it("accepts a gateway URL with its credential, and a certificate", () => {
    checkRoute(good);
  });

  for (const [name, proxyUrl] of [["isn't a URL", "proxy-secret"], ["has a bad escape in its password", "http://x:proxy%zzsecret@172.17.0.1:10255"], ["has a bad escape in its user", "http://x%zz:proxy-secret@172.17.0.1:10255"], ["has no credential", "http://172.17.0.1:10255"], ["is empty", ""], ["isn't http", "ftp://x:proxy-secret@172.17.0.1:10255"]] as const) {
    it(`refuses a proxy URL that ${name}, without quoting it`, () => {
      assert.throws(() => checkRoute({ ...good, proxyUrl }), (error: Error) => error instanceof ConfigError && /proxy_url_file/.test(error.message) && !error.message.includes("proxy-secret"));
    });
  }

  it("refuses a certificate file with no certificate in it", () => {
    assert.throws(() => checkRoute({ ...good, ca: "" }), (error: Error) => error instanceof ConfigError && /ca_file/.test(error.message));
  });
});

describe("failure", () => {
  const coded = (error: Error, code: string): NodeJS.ErrnoException => Object.assign(error, { code });

  for (const [name, error] of [["a system error", coded(new Error("connect failed"), "ECONNRESET")], ["a TLS error", coded(new Error("bad certificate"), "DEPTH_ZERO_SELF_SIGNED_CERT")], ["every address failing", coded(new AggregateError([], "all failed"), "ECONNREFUSED")]] as const) {
    it(`calls ${name} a delivery failure, by its code alone`, () => {
      const result = failure("talking to Telegram", error);
      assert.ok(result instanceof TelegramDeliveryError);
      assert.equal(result.message, `Telegram delivery failed: talking to Telegram: ${error.code}`);
    });
  }

  for (const [name, error] of [["a TypeError", new TypeError("x is not a function")], ["a TypeError with a code", coded(new TypeError("bad argument"), "ERR_INVALID_ARG_TYPE")], ["a RangeError", new RangeError("too big")], ["an error with no code", new Error("what happened")]] as const) {
    it(`leaves ${name} as it is`, () => {
      assert.equal(failure("talking to Telegram", error), error);
    });
  }

  it("leaves a delivery failure as it is", () => {
    const error = new TelegramDeliveryError("already explained");
    assert.equal(failure("talking to Telegram", error), error);
  });
});
