#!/usr/bin/env node
/**
 * Measurement rig, not part of the service: fires captures at the real camera back to back, rotating through
 * connect policies, and writes a packet trace per try. Its output is read by a person. See lab/README.md.
 */
import { appendFileSync, createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createMegaClient, MegaAdapter } from "../src/adapters/mega.ts";
import { CELLULAR_POLICY, SDK_POLICY, setConnectPolicy, setPacketListener } from "../src/adapters/p2p-policy.ts";
import type { ConnectPolicy, PacketEvent } from "../src/adapters/p2p-policy.ts";
import { acquireFrame } from "../src/capture/acquire.ts";
import { loadConfig } from "../src/config.ts";
import { withCameraLock } from "../src/lock.ts";
import { createRedactingLogger, Redactor } from "../src/logging.ts";
import { blankMilestones, classifyOutcome, notePacket, traceEntry } from "./classify.ts";
import type { Milestones } from "./classify.ts";

const VARIANTS: Record<string, ConnectPolicy> = {
  sdk: SDK_POLICY,
  cellular: CELLULAR_POLICY,
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      variants: { type: "string", default: "sdk,cellular" },
      rounds: { type: "string", default: "20" },
      gap: { type: "string", default: "0" },
      name: { type: "string", default: "run" },
    },
  });
  const variantNames = values.variants.split(",");
  for (const name of variantNames) {
    if (VARIANTS[name] === undefined) throw new Error(`Unknown variant "${name}". Known: ${Object.keys(VARIANTS).join(", ")}`);
  }
  const rounds = Number(values.rounds);
  const gapMs = Number(values.gap) * 1000;

  const config = loadConfig(process.env);
  const dataDir = process.env.TIMELAPSE_DATA_DIR ?? "/data";
  const runDir = join(dataDir, "lab", `${values.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(runDir, { recursive: true });
  const resultsPath = join(runDir, "results.jsonl");

  let startedAt = 0;
  let events: ReturnType<typeof createWriteStream> | null = null;
  let marks: Milestones = blankMilestones();

  function record(line: Record<string, unknown>): void {
    events?.write(`${JSON.stringify({ t: Date.now() - startedAt, ...line })}\n`);
  }

  setPacketListener((packet: PacketEvent) => {
    notePacket(marks, packet, Date.now() - startedAt);
    const entry = traceEntry(packet);
    if (entry !== null) record({ ...entry });
  });

  const redactor = new Redactor([config.password, config.email, ...(config.cameraSerial ? [config.cameraSerial] : [])]);
  const logger = createRedactingLogger(redactor, () => {});
  let relayNote = (): void => {};
  const sdkLogger = {
    ...logger,
    debug: (message: unknown, ...args: unknown[]): void => {
      if (typeof message !== "string") return;
      if (message.includes("relay ->")) relayNote();
      if (message.includes("start trace")) {
        const phase = (args[0] as { phase?: string } | undefined)?.phase;
        if (phase === "first-keyframe") marks.firstKeyframe ??= Date.now() - startedAt;
        record({ phase });
      }
    },
  };
  const client = createMegaClient({ email: config.email, password: config.password, country: config.country, sessionDir: join(dataDir, "session"), logger: sdkLogger });
  const adapter = new MegaAdapter(client, (message) => process.stderr.write(`${message}\n`), (value) => redactor.addLiteral(value));
  relayNote = () => adapter.noteRelayUsed();

  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) process.on(name, () => controller.abort("terminated"));

  await withCameraLock(join(dataDir, "camera-lock.sqlite"), async (lockLost) => {
    const authenticated = await adapter.authenticate();
    if (authenticated.status !== "authenticated") throw new Error(`Eufy wants a manual login step: ${authenticated.status}. Run the login command.`);
    const camera = await adapter.discoverCamera(config.cameraSerial);

    let attempt = 0;
    for (let round = 0; round < rounds && !controller.signal.aborted; round += 1) {
      for (const variant of variantNames) {
        if (controller.signal.aborted) break;
        attempt += 1;
        const tryId = `${String(attempt).padStart(4, "0")}-${variant}`;
        setConnectPolicy(VARIANTS[variant] as ConnectPolicy);
        marks = blankMilestones();
        startedAt = Date.now();
        events = createWriteStream(join(runDir, `${tryId}.trace.jsonl`));
        const result = await acquireFrame({
          adapter,
          cameraKey: camera.key,
          outputDir: join(runDir, tryId),
          acquisitionTimeoutMs: 60_000,
          cleanupTimeoutMs: 10_000,
          targetKeyframes: 2,
          minWidth: config.minWidth,
          minHeight: config.minHeight,
          signal: AbortSignal.any([controller.signal, lockLost]),
        });
        events.end();
        const outcome = classifyOutcome(result, marks);
        const summary = { try: tryId, variant, outcome, at: new Date(startedAt).toISOString(), session_ms: result.timing.session_ms, connect_ms: result.timing.connect_ms, width: result.frame?.width ?? null, stop: result.stream_stop, failure: result.failure?.message ?? null, cleanup: result.cleanup.status, video_bytes: result.traffic.video_bytes, ...marks, relayRequests: marks.relayRequests.size };
        appendFileSync(resultsPath, `${JSON.stringify(summary)}\n`);
        process.stdout.write(`${tryId.padEnd(14)} ${outcome.padEnd(10)} ${(result.timing.session_ms / 1000).toFixed(1).padStart(5)}s addr=${marks.address ?? "-"} list=${marks.relayList ?? "-"} port=${marks.relayPort ?? "-"} rdy=${marks.ready ?? "-"} kf=${marks.firstKeyframe ?? "-"} close=${marks.closed ?? "-"} relay=${marks.relay ?? "-"} rolls=${marks.relayRequests.size} lists=${marks.listRequests / 3} data=${marks.dataIn}\n`);
        if (gapMs > 0) await delay(gapMs);
      }
    }
  });
  await adapter.shutdown();
  process.stdout.write(`done: ${resultsPath}\n`);
}

if (import.meta.main) {
  await main();
}
