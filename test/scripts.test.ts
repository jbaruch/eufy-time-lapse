import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

  it("leaves nothing behind but the two files", async () => {
    const secrets = join(dir.path, "tidy");
    assert.equal((await bash([script], { env: { TIMELAPSE_SECRETS_DIR: secrets }, input: "me@example.com\nhunter2\n" })).code, 0);
    assert.deepEqual((await readdir(secrets)).sort(), ["eufy_email", "eufy_password"]);
  });

  for (const name of ["eufy_email", "eufy_password"]) {
    it(`refuses a symlink at ${name}, and writes nothing through it`, async () => {
      const secrets = join(dir.path, `linked-${name}`);
      const outside = join(dir.path, `outside-${name}`);
      await mkdir(secrets);
      await writeFile(outside, "keep me");
      await symlink(outside, join(secrets, name));
      const result = await bash([script], { env: { TIMELAPSE_SECRETS_DIR: secrets }, input: "me@example.com\nhunter2\n" });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /isn't a regular file/);
      assert.equal(await readFile(outside, "utf8"), "keep me");
      assert.deepEqual(await readdir(secrets), [name]);
    });
  }

  it("refuses a directory in place of a credential file", async () => {
    const secrets = join(dir.path, "directory-there");
    await mkdir(join(secrets, "eufy_password"), { recursive: true });
    const result = await bash([script], { env: { TIMELAPSE_SECRETS_DIR: secrets }, input: "me@example.com\nhunter2\n" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /isn't a regular file/);
    assert.deepEqual((await readdir(secrets)).sort(), ["eufy_password"]);
  });

  for (const [name, suffix] of [["a symlinked secrets directory", ""], ["one given with a trailing slash", "/"]] as const) {
    it(`refuses ${name}, and writes nothing through it`, async () => {
      const outside = join(dir.path, `outside-dir-${suffix.length}`);
      const link = join(dir.path, `linked-dir-${suffix.length}`);
      await mkdir(outside);
      await symlink(outside, link);
      const result = await bash([script], { env: { TIMELAPSE_SECRETS_DIR: `${link}${suffix}` }, input: "me@example.com\nhunter2\n" });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /is a symlink/);
      assert.deepEqual(await readdir(outside), []);
    });
  }

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

  const HEADER = "# eufy-time-lapse deployed files, schema_version=2";
  const entry = (path: string, content: string): string => `${createHash("sha256").update(content).digest("hex")}  ${path}`;

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
    // The real sort, until a test says which call should fail.
    await executable(join(stubs, "sort"), `calls=0\nif [ -f '${base}/sort-calls' ]; then calls="$(cat '${base}/sort-calls')"; fi\ncalls=$((calls + 1))\necho "$calls" > '${base}/sort-calls'\nif [ "\${SORT_FAILS_ON_CALL:-0}" -eq "$calls" ]; then echo "sort broke" >&2; exit 2; fi\nPATH='${process.env.PATH ?? ""}' exec sort "$@"`);
    // The real tar, then whatever a test wants to go wrong right after it.
    await executable(join(stubs, "tar"), `PATH='${process.env.PATH ?? ""}' tar "$@"\nif [ -n "\${AFTER_TAR:-}" ]; then eval "$AFTER_TAR"; fi`);
    // Which locales a machine has installed varies, so every deploy test checks the one comm's input is sorted in.
    await executable(join(stubs, "comm"), `if [ "\${LC_ALL:-}" != "C" ]; then echo "comm ran outside the locale its input is sorted in" >&2; exit 1; fi\nPATH='${process.env.PATH ?? ""}' exec comm "$@"`);
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

  it("refuses a file the last deploy didn't ship, names it, and changes nothing", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(host, "surprise.txt"), "?");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /surprise\.txt/);
    assert.deepEqual(await readdir(host), ["surprise.txt"]);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("refuses a file nested in a code directory, and neither loses it nor ships anything", async () => {
    const { repo, host, log, env } = await world();
    assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env })).code, 0);
    await mkdir(join(host, "src", "notes"));
    await writeFile(join(host, "src", "notes", "mine.txt"), "keep me");
    await writeFile(join(repo, "src", "cli.ts"), "// changed\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "change");
    const calls = await readFile(log, "utf8");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /src\/notes\/mine\.txt/);
    assert.equal(await readFile(join(host, "src", "notes", "mine.txt"), "utf8"), "keep me");
    assert.equal(await readFile(join(host, "src", "cli.ts"), "utf8"), "// code\n");
    assert.equal(await readFile(log, "utf8"), calls);
  });

  it("refuses to overwrite a file at a shipped path that the last deploy didn't ship", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(host, "compose.yaml"), "edited by hand\n");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /compose\.yaml/);
    assert.equal(await readFile(join(host, "compose.yaml"), "utf8"), "edited by hand\n");
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("doesn't restart when a file turns up during the deploy, and names it", async () => {
    const { repo, log, env } = await world();
    const result = await bash([script, "somehost", "app"], { cwd: repo, env: { ...env, AFTER_TAR: 'echo "?" > arrived-late.txt' } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /arrived-late\.txt/);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("can run again after dying partway through unpacking", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(repo, "going-away.txt"), "old\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add");
    assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env })).code, 0);
    await rm(join(repo, "going-away.txt"));
    await writeFile(join(repo, "arriving.txt"), "new\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "swap");

    const interrupted = await bash([script, "somehost", "app"], { cwd: repo, env: { ...env, AFTER_TAR: 'echo "the connection dropped" >&2; exit 1' } });
    assert.notEqual(interrupted.code, 0);
    assert.equal(await readFile(join(host, "arriving.txt"), "utf8"), "new\n", "unpacked before it died");

    await writeFile(log, "");
    const retried = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal((await readdir(host)).includes("going-away.txt"), false);
    assert.equal(await readFile(join(host, ".deployed-files"), "utf8"), `${HEADER}\n${entry("arriving.txt", "new\n")}\n${entry("compose.yaml", "services: {}\n")}\n${entry("src/cli.ts", "// code\n")}\n`);
    assert.match(await readFile(log, "utf8"), /compose up -d/);
  });

  it("names a file cut short by a dying unpack, and goes through once it's removed", async () => {
    const { repo, host, env } = await world();
    const interrupted = await bash([script, "somehost", "app"], { cwd: repo, env: { ...env, AFTER_TAR: 'printf "half" > src/cli.ts; exit 1' } });
    assert.notEqual(interrupted.code, 0);
    const refused = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /src\/cli\.ts/);
    await rm(join(host, "src", "cli.ts"));
    const retried = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(await readFile(join(host, "src", "cli.ts"), "utf8"), "// code\n");
  });

  it("refuses a shipped file edited on the host, and keeps the edit", async () => {
    const { repo, host, log, env } = await world();
    assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env })).code, 0);
    await writeFile(join(host, "src", "cli.ts"), "// fixed by hand at 3am\n");
    await writeFile(join(repo, "compose.yaml"), "services: { new: {} }\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "change");
    const calls = await readFile(log, "utf8");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /changed since/);
    assert.match(result.stderr, /src\/cli\.ts/);
    assert.equal(await readFile(join(host, "src", "cli.ts"), "utf8"), "// fixed by hand at 3am\n");
    assert.equal(await readFile(join(host, "compose.yaml"), "utf8"), "services: {}\n");
    assert.equal(await readFile(log, "utf8"), calls);
  });

  it("refuses to delete a file edited on the host that this commit dropped", async () => {
    const { repo, host, env } = await world();
    await writeFile(join(repo, "going-away.txt"), "old\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add");
    assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env })).code, 0);
    await writeFile(join(host, "going-away.txt"), "edited\n");
    await rm(join(repo, "going-away.txt"));
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "remove");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /going-away\.txt/);
    assert.equal(await readFile(join(host, "going-away.txt"), "utf8"), "edited\n");
  });

  it("refuses a version 1 manifest, which can't show that a file is what was shipped, and changes nothing", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(host, "compose.yaml"), "edited by hand\n");
    const manifest = "# eufy-time-lapse deployed files, schema_version=1\ncompose.yaml\n";
    await writeFile(join(host, ".deployed-files"), manifest);
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /doesn't understand/);
    assert.equal(await readFile(join(host, "compose.yaml"), "utf8"), "edited by hand\n");
    assert.equal(await readFile(join(host, ".deployed-files"), "utf8"), manifest);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("refuses a manifest line with no hash, and changes nothing", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(host, ".deployed-files"), `${HEADER}\ncompose.yaml\n`);
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /doesn't understand/);
    assert.deepEqual(await readdir(host), [".deployed-files"]);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("removes a directory the removed files leave empty, and keeps one still in use", async () => {
    const { repo, host, env } = await world();
    await mkdir(join(repo, "src", "gone", "deeper"), { recursive: true });
    await writeFile(join(repo, "src", "gone", "deeper", "old.ts"), "// old\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add");
    assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env })).code, 0);
    await rm(join(repo, "src", "gone"), { recursive: true });
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "remove");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readdir(join(host, "src")), ["cli.ts"]);
  });

  it("refuses a stray symlink, names it, and changes nothing", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(host, "..", "override.yaml"), "services: {}\n");
    await symlink(join(host, "..", "override.yaml"), join(host, "compose.override.yaml"));
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /compose\.override\.yaml/);
    assert.deepEqual(await readdir(host), ["compose.override.yaml"]);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("refuses a commit that tracks a symlink, before reaching the host", async () => {
    const { repo, host, log, env } = await world();
    await symlink("compose.yaml", join(repo, "shortcut.yaml"));
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "link");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /shortcut\.yaml/);
    assert.deepEqual(await readdir(host), []);
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
    assert.equal(await readFile(join(host, ".deployed-files"), "utf8"), `${HEADER}\n${entry("compose.yaml", "services: {}\n")}\n${entry("src/cli.ts", "// code\n")}\n`);
  });

  it("refuses a manifest it doesn't understand, and touches nothing", async () => {
    const { repo, host, log, env } = await world();
    await writeFile(join(host, ".deployed-files"), "# eufy-time-lapse deployed files, schema_version=3\ncompose.yaml\n");
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /doesn't understand/);
    assert.deepEqual(await readdir(host), [".deployed-files"]);
    assert.equal(await readFile(log, "utf8"), "");
  });

  for (const [name, entries] of [["an entry that leads through it", ["link/keep.txt"]], ["the link itself and a path through it", ["link", "link/keep.txt"]]] as const) {
    it(`refuses a symlink even when the manifest lists ${name}, and leaves what it points at`, async () => {
      const { repo, host, log, env } = await world();
      const outside = join(host, "..", "elsewhere");
      await mkdir(outside);
      await writeFile(join(outside, "keep.txt"), "keep me");
      await symlink(outside, join(host, "link"));
      await writeFile(join(host, ".deployed-files"), `${HEADER}\n${entries.map((path) => entry(path, "keep me")).join("\n")}\n`);
      const result = await bash([script, "somehost", "app"], { cwd: repo, env });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /symlinks or special files/);
      assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep me");
      assert.deepEqual((await readdir(host)).sort(), [".deployed-files", "link"]);
      assert.equal(await readFile(log, "utf8"), "");
    });
  }

  it("refuses a manifest that's a symlink, and writes nothing through it", async () => {
    const { repo, host, log, env } = await world();
    const outside = join(host, "..", "someone-elses-file");
    await writeFile(outside, "keep me");
    await symlink(outside, join(host, ".deployed-files"));
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /isn't a regular file/);
    assert.equal(await readFile(outside, "utf8"), "keep me");
    assert.deepEqual(await readdir(host), [".deployed-files"]);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("refuses a manifest that's a symlink to nowhere", async () => {
    const { repo, host, log, env } = await world();
    await symlink(join(host, "..", "not-there"), join(host, ".deployed-files"));
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /isn't a regular file/);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("refuses a manifest that's a directory", async () => {
    const { repo, host, log, env } = await world();
    await mkdir(join(host, ".deployed-files"));
    const result = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /isn't a regular file/);
    assert.equal(await readFile(log, "utf8"), "");
  });

  for (const [name, path] of [["climbs out of the project", "../outside.txt"], ["reads as an option", "-rf"], ["is absolute", "/etc/hostname"], ["is in the data directory", "data/state.sqlite"], ["is the environment file", ".env"], ["is the manifest itself", ".deployed-files"], ["is the manifest's replacement", ".deployed-files.tmp"]] as const) {
    it(`refuses a manifest entry that ${name}, and touches nothing`, async () => {
      const { repo, host, log, env } = await world();
      const outside = join(host, "..", "outside.txt");
      await writeFile(outside, "keep me");
      await writeFile(join(host, ".deployed-files"), `${HEADER}\n${entry(path, "keep me")}\n`);
      const result = await bash([script, "somehost", "app"], { cwd: repo, env });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /unsafe path/);
      assert.equal(await readFile(outside, "utf8"), "keep me");
      assert.deepEqual(await readdir(host), [".deployed-files"]);
      assert.equal(await readFile(log, "utf8"), "");
    });
  }

  it("deploys a second time when the commit ships the example environment file", async () => {
    const { repo, host, env } = await world();
    await writeFile(join(repo, ".env.example"), "SETTING=\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "example");
    assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env })).code, 0);
    const again = await bash([script, "somehost", "app"], { cwd: repo, env });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(await readFile(join(host, ".env.example"), "utf8"), "SETTING=\n");
  });

  it("keeps files with mixed-case names when run from a locale that sorts them differently", async () => {
    const { repo, host, env } = await world();
    await writeFile(join(repo, "CHANGELOG.md"), "log\n");
    await writeFile(join(repo, "Dockerfile"), "FROM scratch\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "names");
    const localized = { ...env, LC_ALL: "en_US.UTF-8" };
    assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env: localized })).code, 0);
    const again = await bash([script, "somehost", "app"], { cwd: repo, env: localized });
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual((await readdir(host)).sort(), [".deployed-files", "CHANGELOG.md", "Dockerfile", "compose.yaml", "src"]);
  });

  for (const [name, directory] of [["spaces", "my app"], ["a quote", "it's mine"], ["shell metacharacters", "app$(touch ran-a); touch ran-b; 'x"], ["a leading dash", "-app"]] as const) {
    it(`ships into a directory with ${name}, and runs none of it`, async () => {
      const { repo, host, env } = await world();
      const home = join(host, "..");
      await mkdir(join(home, directory));
      const result = await bash([script, "somehost", directory], { cwd: repo, env });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await readFile(join(home, directory, "compose.yaml"), "utf8"), "services: {}\n");
      assert.deepEqual((await readdir(home)).sort(), [directory, "app"].sort(), "nothing ran, so nothing else turned up");
    });
  }

  // Eight sorts in a deploy with a file to remove. The first six come before anything on the host changes.
  for (const call of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`stops when sort fails on its call ${call}, and never restarts${call <= 6 ? " or changes anything" : ""}`, async () => {
      const { repo, host, log, env } = await world();
      await writeFile(join(repo, "going-away.txt"), "old\n");
      await git(repo, "add", "-A");
      await git(repo, "commit", "-q", "-m", "add");
      assert.equal((await bash([script, "somehost", "app"], { cwd: repo, env })).code, 0);
      await rm(join(repo, "going-away.txt"));
      await git(repo, "add", "-A");
      await git(repo, "commit", "-q", "-m", "remove");
      await rm(join(host, "..", "..", "sort-calls"));
      const calls = await readFile(log, "utf8");
      const manifest = await readFile(join(host, ".deployed-files"), "utf8");
      const result = await bash([script, "somehost", "app"], { cwd: repo, env: { ...env, SORT_FAILS_ON_CALL: String(call) } });
      assert.notEqual(result.code, 0);
      assert.equal(await readFile(log, "utf8"), calls);
      if (call <= 6) {
        assert.equal(await readFile(join(host, "going-away.txt"), "utf8"), "old\n");
        assert.equal(await readFile(join(host, ".deployed-files"), "utf8"), manifest);
      }
    });
  }

  it("refuses a host ssh would read as an option", async () => {
    const { repo, host, log, env } = await world();
    const result = await bash([script, "-oProxyCommand=touch ran", "app"], { cwd: repo, env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /can't start with a dash/);
    assert.deepEqual(await readdir(host), []);
    assert.equal(await readFile(log, "utf8"), "");
  });

  it("does nothing when only sourced", async () => {
    const { repo, host, env } = await world();
    const result = await bash(["-c", `source '${script}'; echo sourced`], { cwd: repo, env });
    assert.equal(result.stdout, "sourced\n");
    assert.deepEqual(await readdir(host), []);
  });
});
