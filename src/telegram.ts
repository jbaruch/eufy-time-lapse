import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { ConfigError } from "./config.ts";

const API_HOST = "api.telegram.org";
const TIMEOUT_MS = 15_000;
/** Telegram's limit is 4096. An alert should never get close, and a longer one would otherwise be refused outright. */
const MAX_MESSAGE_LENGTH = 4_000;
/** What the OneCLI gateway swaps for the real bot token on the way through. This service never holds the token. */
const TOKEN_PLACEHOLDER = "onecli-managed";

/** A message that didn't arrive. Its text names a stage and a code, never a URL: the route's URL holds a credential. */
export class TelegramDeliveryError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(`Telegram delivery failed: ${detail}`, options);
    this.name = "TelegramDeliveryError";
  }
}

export interface TelegramRoute {
  botId: string;
  chatId: string;
  /** The gateway, with this service's proxy credential in it. */
  proxyUrl: string;
  /** PEM certificates to trust, which must include the gateway's. It re-signs the traffic to inject the token. */
  ca: string;
}

function decodes(text: string): boolean {
  try {
    decodeURIComponent(text);
    return true;
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return false;
  }
}

/** Checked at startup, so a bad file stops the service now instead of losing the first alert. Never quotes the URL. */
export function checkRoute(route: TelegramRoute): void {
  const proxy = URL.canParse(route.proxyUrl) ? new URL(route.proxyUrl) : null;
  if (proxy === null || proxy.protocol !== "http:" || proxy.hostname === "" || proxy.password === "" || !decodes(proxy.username) || !decodes(proxy.password)) {
    throw new ConfigError(`alerts.telegram.proxy_url_file doesn't hold the gateway's http URL with its credential. See "Alerts" in the README.`);
  }
  if (!route.ca.includes("BEGIN CERTIFICATE")) {
    throw new ConfigError(`alerts.telegram.ca_file doesn't hold a PEM certificate. See "Alerts" in the README.`);
  }
}

/** An outage carries a code, the network's or TLS's. A bug that reaches this far isn't an outage, and stays what it is. */
export function failure(stage: string, error: NodeJS.ErrnoException): Error {
  if (error instanceof TelegramDeliveryError || error instanceof TypeError || error instanceof RangeError || error.code === undefined) return error;
  return new TelegramDeliveryError(`${stage}: ${error.code}`, { cause: error });
}

function openTunnel(route: TelegramRoute): Promise<Socket> {
  const proxy = new URL(route.proxyUrl);
  const credential = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
  return new Promise((resolve, reject) => {
    const connect = httpRequest({
      host: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: `${API_HOST}:443`,
      headers: { host: `${API_HOST}:443`, "proxy-authorization": `Basic ${credential}` },
      timeout: TIMEOUT_MS,
    });
    connect.once("connect", (response, socket) => {
      if (response.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket.destroy();
      reject(new TelegramDeliveryError(`the gateway answered ${response.statusCode} when asked for a tunnel. Check this service's OneCLI identity and token`));
    });
    connect.once("timeout", () => connect.destroy(new TelegramDeliveryError("the gateway didn't answer in time")));
    connect.once("error", (error: NodeJS.ErrnoException) => reject(failure("reaching the gateway", error)));
    connect.end();
  });
}

/** Sends one message through the OneCLI gateway. Telegram's answer isn't quoted back, only its status. */
export async function sendTelegram(route: TelegramRoute, text: string, timeoutMs: number = TIMEOUT_MS): Promise<void> {
  const tunnel = await openTunnel(route);
  const body = JSON.stringify({ chat_id: route.chatId, text: text.slice(0, MAX_MESSAGE_LENGTH) });
  let deadline: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    const secured = tlsConnect({ socket: tunnel, servername: API_HOST, ca: route.ca });
    // The whole exchange, handshake included. A gateway can open the tunnel and then stall, which nothing below would notice.
    deadline = setTimeout(() => secured.destroy(new TelegramDeliveryError("Telegram didn't answer in time")), timeoutMs);
    const request = httpsRequest(
      {
        host: API_HOST,
        method: "POST",
        path: `/bot${route.botId}:${TOKEN_PLACEHOLDER}/sendMessage`,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" },
        // With an agent option set, even `agent: false`, Node ignores this and connects straight to Telegram.
        createConnection: () => secured,
        timeout: TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          if (response.statusCode === 200) resolve();
          else reject(new TelegramDeliveryError(`Telegram answered HTTP ${response.statusCode}. Check the chat id, and that the bot is in that chat`));
        });
        response.once("error", (error: NodeJS.ErrnoException) => reject(failure("reading Telegram's answer", error)));
      },
    );
    request.once("timeout", () => request.destroy(new TelegramDeliveryError("Telegram didn't answer in time")));
    request.once("error", (error: NodeJS.ErrnoException) => reject(failure("talking to Telegram", error)));
    request.end(body);
  }).finally(() => clearTimeout(deadline));
}
