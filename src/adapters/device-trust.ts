import { createCipheriv, createECDH, createHash } from "node:crypto";
import { MegaApiError } from "@mega-yfue/eufy-sdk";
import type { AuthChallenge, AuthInput } from "./adapter.ts";

/** The older login system's key, from bropat/eufy-security-client. */
const SERVER_PUBLIC_KEY = "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";
const REQUEST_TIMEOUT_MS = 20_000;
/** Room for a captcha and a code with one mistake on each, and few enough logins not to worry the account. */
const MAX_LOGINS = 8;

const OK = 0;
const WRONG_CODE = 26050;
const EXPIRED_CODE = 26051;
const NEED_CODE = 26052;
const NEED_CAPTCHA = 100032;
const WRONG_CAPTCHA = 100033;
const EMAIL = 2;

const LOGIN_PATH = "v2/passport/login_sec";
const SEND_CODE_PATH = "v1/sms/send/verify_code";
const ADD_TRUST_PATH = "v1/app/trust_device/add";

export interface OlderLoginAccount {
  host: string;
  email: string;
  password: string;
  country: string;
  deviceId: string;
  phoneModel: string;
}

interface OlderReply {
  code?: number;
  data?: { auth_token?: string; user_id?: string; captcha_id?: string; item?: string } | null;
}

export function encryptPassword(password: string, serverPublicKey: string = SERVER_PUBLIC_KEY): { encrypted: string; publicKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const key = ecdh.computeSecret(Buffer.from(serverPublicKey, "hex"));
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  return { encrypted: cipher.update(password, "utf8", "base64") + cipher.final("base64"), publicKey: ecdh.getPublicKey("hex") };
}

/** This login answers 10000, invalid input, to the SDK's headers. The device id and model are what make the trust ours. */
function deviceHeaders(account: OlderLoginAccount): Record<string, string> {
  return {
    "Content-Type": "application/json",
    App_version: "v4.6.0_1630",
    Os_type: "android",
    Os_version: "31",
    Phone_model: account.phoneModel,
    Country: account.country,
    Language: "en",
    Openudid: account.deviceId,
    Net_type: "wifi",
    Mnc: "02",
    Mcc: "262",
    Sn: "75814221ee75",
    Model_type: "PHONE",
    Timezone: "GMT+00:00",
    "Cache-Control": "no-cache",
  };
}

function tokenHeaders(path: string, reply: OlderReply): Record<string, string> {
  const token = reply.data?.auth_token;
  const userId = reply.data?.user_id;
  if (token === undefined || userId === undefined) throw new MegaApiError(`${path} gave no token to go on with`, reply.code, 200);
  return { "x-auth-token": token, gtoken: createHash("md5").update(userId).digest("hex") };
}

async function post(account: OlderLoginAccount, path: string, headers: Record<string, string>, body: Record<string, unknown>, fetchOlder: typeof fetch): Promise<OlderReply> {
  const response = await fetchOlder(`https://${account.host}/${path}`, {
    method: "POST",
    headers: { ...deviceHeaders(account), ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let reply: OlderReply;
  try {
    reply = JSON.parse(await response.text()) as OlderReply;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new MegaApiError(`${path} didn't answer in JSON`, undefined, response.status);
  }
  if (response.status !== 200) throw new MegaApiError(`${path} failed (${response.status}/${reply.code})`, reply.code, response.status);
  return reply;
}

async function postAccepted(account: OlderLoginAccount, path: string, headers: Record<string, string>, body: Record<string, unknown>, fetchOlder: typeof fetch): Promise<void> {
  const reply = await post(account, path, headers, body, fetchOlder);
  if (reply.code !== OK) throw new MegaApiError(`${path} failed (200/${reply.code})`, reply.code, 200);
}

function loginBody(account: OlderLoginAccount, input: AuthInput | undefined): Record<string, unknown> {
  const { encrypted, publicKey } = encryptPassword(account.password);
  const answer = input === undefined ? {} : "verifyCode" in input ? { verify_code: input.verifyCode } : { captcha_id: input.captcha.id, answer: input.captcha.code };
  return {
    ab: account.country,
    client_secret_info: { public_key: publicKey },
    enc: 0,
    email: account.email,
    password: encrypted,
    time_zone: -new Date().getTimezoneOffset() * 60_000,
    transaction: `${Date.now()}`,
    ...answer,
  };
}

/**
 * Eufy runs two login systems, each emailing its own codes. The SDK uses the newer one, but trust_device/add answers
 * 26050 to its codes, used or not. It takes a code from the older system, and the newer login then stops asking.
 */
export async function earnDeviceTrust(account: OlderLoginAccount, answer: (challenge: AuthChallenge) => Promise<AuthInput>, fetchOlder: typeof fetch = fetch): Promise<void> {
  let held: Record<string, string> = {};
  let input: AuthInput | undefined;
  for (let login = 0; login < MAX_LOGINS; login += 1) {
    const reply = await post(account, LOGIN_PATH, held, loginBody(account, input), fetchOlder);
    if (reply.code === OK) {
      if (input !== undefined && "verifyCode" in input) await postAccepted(account, ADD_TRUST_PATH, tokenHeaders(LOGIN_PATH, reply), { verify_code: input.verifyCode, transaction: `${Date.now()}` }, fetchOlder);
      return;
    }
    if (reply.code === NEED_CODE) {
      held = tokenHeaders(LOGIN_PATH, reply);
      await postAccepted(account, SEND_CODE_PATH, held, { message_type: EMAIL, transaction: `${Date.now()}` }, fetchOlder);
      input = await answer({ status: "tfa_required" });
    } else if (reply.code === NEED_CAPTCHA || reply.code === WRONG_CAPTCHA) {
      input = await answer({ status: "captcha_required", captchaId: reply.data?.captcha_id ?? "", captchaImage: reply.data?.item ?? "" });
    } else if (reply.code === WRONG_CODE || reply.code === EXPIRED_CODE) {
      // A code lasts 5 minutes, and a late one shouldn't cost the person the whole command.
      held = {};
      input = undefined;
    } else {
      throw new MegaApiError(`${LOGIN_PATH} failed (200/${reply.code})`, reply.code, 200);
    }
  }
  throw new MegaApiError(`Eufy's older login still wanted another step after ${MAX_LOGINS} tries. Stopping so the account doesn't get locked. Wait a few minutes and run login again.`, undefined, 200);
}
