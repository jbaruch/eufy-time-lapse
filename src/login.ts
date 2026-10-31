import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CaptureFailure } from "./adapters/adapter.ts";
import type { AuthInput, CameraAdapter } from "./adapters/adapter.ts";
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
  camera: { model: string; firmware: string | null; serial_masked: string; battery_percent: number | null; telemetry: Record<string, string | number | boolean> };
}

/** Walks the interactive login until the session is stored, then proves the account can see the camera. */
export async function runLogin(options: LoginOptions): Promise<LoginResult> {
  let input: AuthInput | undefined;
  for (let step = 0; step < MAX_LOGIN_STEPS; step += 1) {
    const state = await options.adapter.authenticate(input);
    if (state.status === "authenticated") {
      const camera = await options.adapter.discoverCamera(options.cameraSerial);
      return {
        status: "authenticated",
        camera: {
          model: camera.model,
          firmware: camera.firmware,
          serial_masked: maskSerial(camera.key),
          battery_percent: camera.battery.percent,
          telemetry: camera.telemetry,
        },
      };
    }
    if (state.status === "tfa_required") {
      const code = await options.prompt("Eufy sent you a verification code. Enter it: ");
      input = { verifyCode: code.trim() };
    } else {
      const imagePath = join(options.dataDir, "captcha.png");
      const base64 = state.captchaImage.replace(/^data:image\/\w+;base64,/, "");
      await writeFile(imagePath, Buffer.from(base64, "base64"));
      options.log(`Captcha saved to ${imagePath}`);
      const code = await options.prompt("Open the image and type what it shows: ");
      input = { captcha: { id: state.captchaId, code: code.trim() } };
    }
  }
  throw new CaptureFailure("auth_required", "auth", `Login still needs another step after ${MAX_LOGIN_STEPS} tries. Stopping so the account doesn't get locked. Wait a few minutes and run it again.`);
}
