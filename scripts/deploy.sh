#!/usr/bin/env bash
# Ships the committed tree to a capture host over SSH, restarts the service, and waits until it reports the new
# revision. Usage: scripts/deploy.sh [ssh-host] [remote-directory]
# Stop before a capture is due if you can: a restart mid-capture marks that slot missed. The data directory, .env
# and the secrets aren't in the tree, so this never touches them.
set -euo pipefail

host="${1:-nas}"
directory="${2:-eufy-time-lapse}"
wait_seconds=60

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Uncommitted changes wouldn't ship, so nothing was deployed. Commit or stash them first." >&2
  exit 1
fi
revision="$(git rev-parse --short HEAD)"

on_host() {
  # shellcheck disable=SC2029 # The directory is meant to expand here, on this side of the connection.
  ssh "$host" "cd '$directory' && $1"
}

# Replaced wholesale, so a file deleted from the repo can't linger on the host.
on_host "rm -rf src lab test scripts .github"
git archive HEAD | on_host "tar -xf -"

local_hashes="$(git ls-files | LC_ALL=C sort | while read -r file; do shasum -a 256 "$file"; done)"
remote_hashes="$(git ls-files | LC_ALL=C sort | on_host "xargs -d '\\n' sha256sum")"
if [[ "$local_hashes" != "$remote_hashes" ]]; then
  echo "The files on $host don't match this commit, so the service wasn't restarted:" >&2
  diff <(printf '%s\n' "$local_hashes") <(printf '%s\n' "$remote_hashes") >&2
  exit 1
fi

on_host "TIMELAPSE_REVISION='$revision' docker compose build --quiet timelapse && docker compose up -d timelapse"

for ((waited = 0; waited < wait_seconds; waited += 2)); do
  if on_host "docker compose exec -T timelapse node src/cli.ts status --json" | grep -q "\"revision\": \"$revision\""; then
    echo "$host is running $revision."
    exit 0
  fi
  sleep 2
done
echo "$host didn't report revision $revision within ${wait_seconds}s. Check: ssh $host 'cd $directory && docker compose logs --tail 50 timelapse'" >&2
exit 1
