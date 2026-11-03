import assert from "node:assert/strict";
import { createDecipheriv, createECDH } from "node:crypto";
import { describe, it } from "node:test";
import { MegaApiError } from "@mega-yfue/eufy-sdk";
import type { AuthChallenge, AuthInput } from "../src/adapters/adapter.ts";
import { earnDeviceTrust, encryptPassword } from "../src/adapters/device-trust.ts";

const PASSWORD = "correct horse";
const ACCOUNT = { host: "security-app.example", email: "owner@example.com", password: PASSWORD, country: "US", deviceId: "device-id", phoneModel: "Pixel" };

/** The replies Eufy gave on the real account on 2026-11-01, trimmed to the fields this code reads. */
const NEED_CODE = { code: 26052, msg: "need validate code", data: { auth_token: "provisional", user_id: "user" } };
const SENT = { code: 0, msg: "Succeed." };
const LOGGED_IN = { code: 0, msg: "Succeed.", data: { auth_token: "final", user_id: "user" } };
const ADDED = { code: 0, msg: "Succeed." };
const CAPTCHA = { code: 100032, msg: "Failed to request.", data: { captcha_id: "captcha-1", item: "data:image/png;base64,QUJD" } };

interface Call {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: unknown;
}

function scripted(replies: Array<{ status?: number; text?: string } | Record<string, unknown>>): { calls: Call[]; fetchOlder: typeof fetch } {
  const calls: Call[] = [];
  const fetchOlder = (async (url: string, init: RequestInit) => {
    calls.push({
      path: url.replace("https://security-app.example/", ""),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      signal: init.signal,
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`nothing scripted for ${url}`);
    if ("text" in reply) return new Response(String(reply.text), { status: Number(reply.status ?? 200) });
    return new Response(JSON.stringify(reply), { status: Number(reply.status ?? 200) });
  }) as unknown as typeof fetch;
  return { calls, fetchOlder };
}

function answering(...answers: AuthInput[]): { asked: AuthChallenge[]; answer: (challenge: AuthChallenge) => Promise<AuthInput> } {
  const asked: AuthChallenge[] = [];
  return {
    asked,
    answer: async (challenge) => {
      asked.push(challenge);
      const next = answers.shift();
      if (next === undefined) throw new Error("asked a person more than this test expected");
      return next;
    },
  };
}

const paths = (calls: Call[]): string[] => calls.map((call) => call.path);
const LOGIN = "v2/passport/login_sec";
const SEND = "v1/sms/send/verify_code";
const ADD = "v1/app/trust_device/add";

describe("earnDeviceTrust", () => {
  it("logs in on the older system, asks for its emailed code, and adds the device with it", async () => {
    const { calls, fetchOlder } = scripted([NEED_CODE, SENT, LOGGED_IN, ADDED]);
    const { asked, answer } = answering({ verifyCode: "123456" });
    await earnDeviceTrust(ACCOUNT, answer, fetchOlder);
    assert.deepEqual(paths(calls), [LOGIN, SEND, LOGIN, ADD]);
    assert.deepEqual(asked, [{ status: "tfa_required" }]);
    const [first, send, second, add] = calls as [Call, Call, Call, Call];
    assert.equal(first.headers["x-auth-token"], undefined);
    assert.equal(send.body.message_type, 2, "email");
    assert.equal(send.headers["x-auth-token"], "provisional");
    assert.equal(send.headers.gtoken, "ee11cbb19052e40b07aac0ca060c23ee", "md5 of the user id");
    assert.equal(second.body.verify_code, "123456");
    assert.equal(second.headers["x-auth-token"], "provisional");
    assert.equal(add.body.verify_code, "123456", "the same code, after the login that used it");
    assert.equal(add.headers["x-auth-token"], "final");
  });

  it("does all of it as this service's device, or the trust lands on a stranger", async () => {
    const { calls, fetchOlder } = scripted([NEED_CODE, SENT, LOGGED_IN, ADDED]);
    await earnDeviceTrust(ACCOUNT, answering({ verifyCode: "123456" }).answer, fetchOlder);
    for (const call of calls) {
      assert.equal(call.headers.Openudid, "device-id");
      assert.equal(call.headers.Phone_model, "Pixel");
      assert.equal(call.headers.Country, "US");
      assert.ok(call.signal instanceof AbortSignal, `${call.path} can't hang forever`);
    }
  });

  it("hands a captcha to the person and carries the answer back", async () => {
    const { calls, fetchOlder } = scripted([CAPTCHA, NEED_CODE, SENT, LOGGED_IN, ADDED]);
    const { asked, answer } = answering({ captcha: { id: "captcha-1", code: "5cwe" } }, { verifyCode: "123456" });
    await earnDeviceTrust(ACCOUNT, answer, fetchOlder);
    assert.deepEqual(asked, [{ status: "captcha_required", captchaId: "captcha-1", captchaImage: "data:image/png;base64,QUJD" }, { status: "tfa_required" }]);
    assert.equal(calls[1]?.body.captcha_id, "captcha-1");
    assert.equal(calls[1]?.body.answer, "5cwe");
    assert.equal(calls[1]?.body.verify_code, undefined);
  });

  it("asks again after a wrong captcha", async () => {
    const { fetchOlder, calls } = scripted([CAPTCHA, { ...CAPTCHA, code: 100033 }, NEED_CODE, SENT, LOGGED_IN, ADDED]);
    const { asked, answer } = answering({ captcha: { id: "captcha-1", code: "nope" } }, { captcha: { id: "captcha-1", code: "5cwe" } }, { verifyCode: "123456" });
    await earnDeviceTrust(ACCOUNT, answer, fetchOlder);
    assert.equal(asked.length, 3);
    assert.equal(calls.at(-1)?.path, ADD);
  });

  for (const [name, code] of [
    ["mistyped", 26050],
    ["expired", 26051],
  ] as const) {
    it(`gets a new code after an ${name} one, rather than sending the person back to the start`, async () => {
      const { calls, fetchOlder } = scripted([NEED_CODE, SENT, { code, msg: "Failed to request.", data: {} }, NEED_CODE, SENT, LOGGED_IN, ADDED]);
      await earnDeviceTrust(ACCOUNT, answering({ verifyCode: "111111" }, { verifyCode: "222222" }).answer, fetchOlder);
      assert.deepEqual(paths(calls), [LOGIN, SEND, LOGIN, LOGIN, SEND, LOGIN, ADD]);
      assert.equal(calls[3]?.body.verify_code, undefined, "the bad code isn't sent twice");
      assert.equal(calls[3]?.headers["x-auth-token"], undefined, "and the login starts clean");
      assert.equal(calls[6]?.body.verify_code, "222222");
    });
  }

  it("adds nothing when the older system wants no code at all", async () => {
    const { calls, fetchOlder } = scripted([LOGGED_IN]);
    const { asked, answer } = answering();
    await earnDeviceTrust(ACCOUNT, answer, fetchOlder);
    assert.deepEqual(paths(calls), [LOGIN]);
    assert.deepEqual(asked, []);
  });

  it("adds nothing when a captcha was the only thing it wanted", async () => {
    const { calls, fetchOlder } = scripted([CAPTCHA, LOGGED_IN]);
    await earnDeviceTrust(ACCOUNT, answering({ captcha: { id: "captcha-1", code: "5cwe" } }).answer, fetchOlder);
    assert.deepEqual(paths(calls), [LOGIN, LOGIN]);
  });

  it("stops at a refusal, because retrying a wrong password locks accounts", async () => {
    const { calls, fetchOlder } = scripted([{ code: 26006, msg: "bad" }]);
    await assert.rejects(earnDeviceTrust(ACCOUNT, answering().answer, fetchOlder), (error: MegaApiError) => error instanceof MegaApiError && error.code === 26006);
    assert.equal(calls.length, 1);
  });

  it("gives up after a bounded number of logins", async () => {
    const { calls, fetchOlder } = scripted(Array.from({ length: 50 }, () => ({ ...CAPTCHA, code: 100033 })));
    const answers = Array.from({ length: 50 }, () => ({ captcha: { id: "captcha-1", code: "nope" } }));
    await assert.rejects(earnDeviceTrust(ACCOUNT, answering(...answers).answer, fetchOlder), /run login again/i);
    assert.equal(calls.length, 8);
  });

  it("calls a refused code request a failure", async () => {
    const { calls, fetchOlder } = scripted([NEED_CODE, { code: 10000, msg: "bad" }]);
    await assert.rejects(earnDeviceTrust(ACCOUNT, answering().answer, fetchOlder), MegaApiError);
    assert.equal(calls.length, 2, "nobody is asked for a code that never went out");
  });

  it("calls a refused add a failure", async () => {
    const { fetchOlder } = scripted([NEED_CODE, SENT, LOGGED_IN, { code: 26050, msg: "Failed to request." }]);
    await assert.rejects(earnDeviceTrust(ACCOUNT, answering({ verifyCode: "123456" }).answer, fetchOlder), (error: MegaApiError) => error instanceof MegaApiError && error.code === 26050);
  });

  it("calls a garbled or non-200 answer a failure", async () => {
    await assert.rejects(earnDeviceTrust(ACCOUNT, answering().answer, scripted([{ status: 502, text: "<html>bad gateway</html>" }]).fetchOlder), MegaApiError);
    await assert.rejects(earnDeviceTrust(ACCOUNT, answering().answer, scripted([{ status: 401, code: 26000 }]).fetchOlder), MegaApiError);
  });

  it("calls a code demand with no token to send it under a failure", async () => {
    await assert.rejects(earnDeviceTrust(ACCOUNT, answering().answer, scripted([{ code: 26052, data: {} }]).fetchOlder), MegaApiError);
  });

  it("keeps the password out of the request and out of every error", async () => {
    const { calls, fetchOlder } = scripted([{ code: 26006, msg: "bad" }]);
    await assert.rejects(earnDeviceTrust(ACCOUNT, answering().answer, fetchOlder), (error: Error) => !error.message.includes(PASSWORD));
    assert.equal(JSON.stringify(calls[0]?.body).includes(PASSWORD), false);
    assert.equal(calls[0]?.body.email, ACCOUNT.email);
    assert.equal(calls[0]?.body.ab, "US");
    assert.equal(calls[0]?.body.enc, 0);
  });
});

describe("encryptPassword", () => {
  it("is what the server's half of the key exchange can read back", () => {
    const server = createECDH("prime256v1");
    server.setPrivateKey(Buffer.from("01".repeat(32), "hex"));
    const { encrypted, publicKey } = encryptPassword(PASSWORD, server.getPublicKey("hex"));
    const key = server.computeSecret(Buffer.from(publicKey, "hex"));
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    assert.equal(decipher.update(encrypted, "base64", "utf8") + decipher.final("utf8"), PASSWORD);
  });

  it("works against Eufy's own key, which has to be a valid curve point", () => {
    assert.match(encryptPassword(PASSWORD).publicKey, /^04[0-9a-f]{128}$/);
  });
});
