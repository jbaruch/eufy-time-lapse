import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CaptureFailure } from "./adapters/adapter.ts";
import type { AuthChallenge, AuthInput, CameraAdapter } from "./adapters/adapter.ts";
import { maskSerial } from "./probe/report.ts";

const MAX_LOGIN_STEPS = 5;

export interface LoginOptions {
  adapter: CameraAdapter;
  dataDir: string;
  cameraSerial?: string;
  prompt: (question: string) => Promise<string>;
  log: (message: string) => void;
}

export interface LoginResult {
  status: "authenticated";
  /** Null when Eufy can't say, or when it asked for no code to earn trust with. */
  device_trusted: boolean | null;
  camera: { model: string; firmware: string | null; serial_masked: string; battery_percent: number | null; telemetry: Record<string, string | number | boolean> };
}

async function answerChallenge(options: LoginOptions, challenge: AuthChallenge): Promise<AuthInput> {
  if (challenge.status === "tfa_required") {
    const code = await options.prompt("Eufy sent you a verification code. Enter it: ");
    return { verifyCode: code.trim() };
  }
  const imagePath = join(options.dataDir, "captcha.png");
  const base64 = challenge.captchaImage.replace(/^data:image\/\w+;base64,/, "");
  await writeFile(imagePath, Buffer.from(base64, "base64"));
  options.log(`Captcha saved to ${imagePath}`);
  const code = await options.prompt("Open the image and type what it shows: ");
  return { captcha: { id: challenge.captchaId, code: code.trim() } };
}

/** Eufy asks an untrusted device for a code at every login. Trust takes a code, and a login restored from disk didn't use one. */
async function settleTrust(options: LoginOptions, input: AuthInput | undefined): Promise<boolean | null> {
  if (input !== undefined && "verifyCode" in input) return options.adapter.trustDevice(input.verifyCode);
  const trusted = await options.adapter.isDeviceTrusted();
  if (trusted !== false) return trusted;
  options.log("Eufy doesn't trust this device yet, so renewing its login would take a code every month. Logging in again to fix that.");
  const renewal = await options.adapter.renewLogin((challenge) => answerChallenge(options, challenge));
  return renewal.status === "renewed" ? renewal.trusted : false;
}

/** Walks the interactive login until the session is stored, then proves the account can see the camera. */
export async function runLogin(options: LoginOptions): Promise<LoginResult> {
  let input: AuthInput | undefined;
  for (let step = 0; step < MAX_LOGIN_STEPS; step += 1) {
    const state = await options.adapter.authenticate(input);
    if (state.status === "authenticated") {
      const deviceTrusted = await settleTrust(options, input);
      const camera = await options.adapter.discoverCamera(options.cameraSerial);
      return {
        status: "authenticated",
        device_trusted: deviceTrusted,
        camera: {
          model: camera.model,
          firmware: camera.firmware,
          serial_masked: maskSerial(camera.key),
          battery_percent: camera.battery.percent,
          telemetry: camera.telemetry,
        },
      };
    }
    input = await answerChallenge(options, state);
  }
  throw new CaptureFailure("auth_required", "auth", `Login still needs another step after ${MAX_LOGIN_STEPS} tries. Stopping so the account doesn't get locked. Wait a few minutes and run it again.`);
}
