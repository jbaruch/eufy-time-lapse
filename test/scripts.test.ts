import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempDir } from "./helpers/fixtures.ts";

const run = promisify(execFile);
const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function bash(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<Outcome> {
  const child = run("bash", args, { cwd: options.cwd, env: { ...process.env, ...options.env } });
  // A script may exit without reading its input. Its exit code is the outcome; a closed pipe isn't one.
  child.child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  child.child.stdin?.end(options.input ?? "");
  try {
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe("the bash helper", () => {
  it("reports the script's result when the script never reads its input", async () => {
    // More than a pipe holds, so the write is still pending when the script exits.
    const result = await bash(["-c", "exit 0"], { input: "x".repeat(4 * 1024 * 1024) });
    assert.equal(result.code, 0);
  });
});

describe("scripts/set-credentials.sh", () => {
  const script = join(SCRIPTS, "set-credentials.sh");
  let dir: { path: string; remove: () => Promise<void> };

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  it("stores both values readable only by their owner", async () => {
    const secrets = join(dir.path, "stored");
    const result = await bash([script], { env: { TIMELAPSE_SECRETS_DIR: secrets }, input: "me@example.com\nhunter2\n" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(secrets, "eufy_email"), "utf8"), "me@example.com\n");
    assert.equal(await readFile(join(secrets, "eufy_password"), "utf8"), "hunter2\n");
    assert.equal((await stat(join(secrets, "eufy_password"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(secrets, "eufy_email"))).mode & 0o777, 0o600);
    assert.equal((await stat(secrets)).mode & 0o777, 0o700);
    assert.equal((result.stdout + result.stderr).includes("hunter2"), false, "the password never reaches the terminal");
  });

  it("replaces an earlier login when run again", async () => {
    const secrets = join(dir.path, "again");
    await bash([script], { env: { TIMELAPSE_SECRETS_DIR: secrets }, input: "first@example.com\nold\n" });
    const result = await bash([script], { env: { TIMELAPSE_SECRETS_DIR: secrets }, input: "second@example.com\nnew\n" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(secrets, "eufy_password"), "utf8"), "new\n");
  });

  it("refuses an empty value, and changes nothing", async () => {
    const secrets = join(dir.path, "empty");
    const result = await bash([script], { env: { TIMELAPSE_SECRETS_DIR: secrets }, input: "me@example.com\n\n" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Both the email and the password are required/);
    await assert.rejects(stat(secrets), { code: "ENOENT" });
  });

  it("fails visibly when it can't write", async () => {
    const blocker = join(dir.path, "a-file");
    await writeFile(blocker, "");
    const result = await bash([script], { env: { TIMELAPSE_SECRETS_DIR: join(blocker, "inside") }, input: "me@example.com\nhunter2\n" });
    assert.notEqual(result.code, 0);
  });

  it("does nothing when only sourced", async () => {
    const result = await bash(["-c", `source '${script}'; echo sourced`], { input: "" });
    assert.equal(result.stdout, "sourced\n");
  });
});

describe("scripts/deploy.sh", () => {
  const script = join(SCRIPTS, "deploy.sh");
  let root: { path: string; remove: () => Promise<void> };
  let scenario = 0;

  before(async () => {
    root = await tempDir();
  });
  after(async () => {
    await root.remove();
  });

  async function executable(path: string, body: string): Promise<void> {
    await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    await chmod(path, 0o755);
  }

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd });
    return stdout.trim();
  }

  /** A repo with a commit, a directory standing in for the host, and stand-ins for ssh and docker that keep a log. */
  async function world(options: { reports?: boolean; corrupt?: boolean } = {}): Promise<{ repo: string; host: string; log: string; env: NodeJS.ProcessEnv; revision: string }> {
    scenario += 1;
    const base = join(root.path, `scenario-${scenario}`);
    const repo = join(base, "repo");
    const home = join(base, "home");
    const host = join(home, "app");
    const stubs = join(base, "stubs");
    const log = join(base, "calls.log");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(host, { recursive: true });
    await mkdir(stubs, { recursive: true });
    await writeFile(log, "");
    await writeFile(join(repo, "compose.yaml"), "services: {}\n");
    await writeFile(join(repo, "src", "cli.ts"), "// code\n");
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "first");
    const revision = await git(repo, "rev-parse", "--short", "HEAD");
    await executable(join(stubs, "ssh"), `shift\ncd '${home}'\nexec bash -c "$1"`);
    await executable(join(stubs, "docker"), `echo "docker $*" >> '${log}'\nif [ "$2" = "exec" ]; then ${options.reports === false ? 'echo "{}"' : `echo "\\"revision\\": \\"$(git -C '${repo}' rev-parse --short HEAD)\\""`}; fi`);
    // The retry wait, so a test of it takes no real time.
    await executable(join(stubs, "sleep"), "exit 0");
    await executable(join(stubs, "sha256sum"), options.corrupt === true ? 'echo "0000  $1"' : 'exec shasum -a 256 "$@"');
    return { repo, host, log, env: { PATH: `${stubs}:${process.env.PATH ?? ""}`, DEPLOY_WAIT_SECONDS: "2" }, revision };
  }

  it("ships the commit, restarts the service, and waits for it to report the revision", async () => {
    const { repo, host, log, env, revision } = await world();
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`somehost is running ${revision}`));
    assert.equal(await readFile(join(host, "src", "cli.ts"), "utf8"), "// code\n");
    const calls = await readFile(log, "utf8");
    assert.match(calls, /compose build/);
    assert.match(calls, /compose up -d/);
  });

  it("removes a file the repo no longer has, including at the root", async () => {
    const { repo, host, env } = await world();
    await writeFile(join(repo, "old-root-file.txt"), "old\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add");
    assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env })).code, 0);
    assert.ok((await readdir(host)).includes("old-root-file.txt"));
    await rm(join(repo, "old-root-file.txt"));
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "remove");
    assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env })).code, 0);
    assert.equal((await readdir(host)).includes("old-root-file.txt"), false);
  });

  it("leaves the data directory and .env alone", async () => {
    const { repo, host, env } = await world();
    await mkdir(join(host, "data"), { recursive: true });
    await writeFile(join(host, "data", "state.sqlite"), "precious");
    await writeFile(join(host, ".env"), "SETTING=1\n");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(host, "data", "state.sqlite"), "utf8"), "precious");
    assert.equal(await readFile(join(host, ".env"), "utf8"), "SETTING=1\n");
  });

  it("refuses uncommitted changes, and touches nothing", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(repo, "compose.yaml"), "changed\n");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Uncommitted changes/);
    assert.deepEqual(await readdir(host), []);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("doesn't restart when the host's copy doesn't match", async () => {
    const { repo, log, env } = await world({ corrupt: true });
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /don't match this commit/);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("doesn't restart when the host has a file it can't account for, and names it", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(host, "surprise.txt"), "?");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /surprise\.txt/);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("doesn't restart when the host has a stray symlink, and names it", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(host, "..", "override.yaml"), "services: {}\n");
    await symlink(join(host, "..", "override.yaml"), join(host, "compose.override.yaml"));
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /compose\.override\.yaml/);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("fails, and says where to look, when the host never reports the new revision", async () => {
    const { repo, env } = await world({ reports: false });
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /didn't report revision/);
  });

  it("records what it shipped under a versioned header", async () => {
    const { repo, host, env } = await world();
    assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env })).code, 0);
    assert.equal(await readFile(join(host, ".deployed-files"), "utf8"), "# eufy-time-lapse deployed files, schema_version=1\ncompose.yaml\nsrc/cli.ts\n");
  });

  it("refuses a manifest it doesn't understand, and touches nothing", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(host, ".deployed-files"), "# eufy-time-lapse deployed files, schema_version=2\ncompose.yaml\n");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /doesn't understand/);
    assert.deepEqual(await readdir(host), [".deployed-files"]);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("refuses a manifest entry that leads out through a symlink, and leaves what it points at", async () => {
    const { repo, host, log, env } = await world();
    const outside = join(host, "..", "elsewhere");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep me");
    await symlink(outside, join(host, "link"));
    await writeFile(join(host, ".deployed-files"), "# eufy-time-lapse deployed files, schema_version=1\nlink/keep.txt\n");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /leads outside the project/);
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep me");
    assert.equal(await readFile(log, "utf8"), "");
  });

  for (const [name, entry] of [["climbs out of the project", "../outside.txt"], ["reads as an option", "-rf"], ["is absolute", "/etc/hostname"], ["is in the data directory", "data/state.sqlite"], ["is the environment file", ".env"], ["is the manifest itself", ".deployed-files"]] as const) {
    it(`refuses a manifest entry that ${name}, and touches nothing`, async () => {
      const { repo, host, log, env } = await world();
      const outside = join(host, "..", "outside.txt");
      await writeFile(outside, "keep me");
      await writeFile(join(host, ".deployed-files"), `# eufy-time-lapse deployed files, schema_version=1\n${entry}\n`);
      const result = await bash([script, "somehost", "app"], { cwd: repo, env });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /unsafe path/);
      assert.equal(await readFile(outside, "utf8"), "keep me");
      assert.deepEqual(await readdir(host), [".deployed-files"]);
      assert.equal(await readFile(log, "utf8"), "");
    });
  }

  it("does nothing when only sourced", async () => {
    const { repo, host, env } = await world();
    const result = await bash(["-c", `source '${script}'; echo sourced`], { cwd: repo, env });
    assert.equal(result.stdout, "sourced\n");
    assert.deepEqual(await readdir(host), []);
  });
});
