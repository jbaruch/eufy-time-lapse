#!/usr/bin/env bash
# Ships the committed tree to a capture host over SSH, restarts the service, and waits until it reports the new
# revision. Usage: scripts/deploy.sh [ssh-host] [remote-directory]
# Run it just after a capture if you can: a restart mid-capture marks that slot missed. The data directory and .env
# aren't in the tree, so this never touches them. Refuses to restart unless the host holds exactly this commit.
set -euo pipefail

# Owned by this script, the only reader and writer: what the last deploy shipped, one path per line after the header.
# A new shape means a new schema_version and a migration here. Anything else on the host gets refused, not guessed at.
readonly MANIFEST=".deployed-files"
readonly MANIFEST_HEADER="# eufy-time-lapse deployed files, schema_version=1"

on_host() {
  # shellcheck disable=SC2029 # The directory is meant to expand here, on this side of the connection.
  ssh "$host" "cd '$directory' && $1"
}

main() {
  host="${1:-nas}"
  directory="${2:-eufy-time-lapse}"
  local wait_seconds="${DEPLOY_WAIT_SECONDS:-60}"

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Uncommitted changes wouldn't ship, so nothing was deployed. Commit or stash them first." >&2
    exit 1
  fi
  local revision tracked previous stale
  revision="$(git rev-parse --short HEAD)"
  tracked="$(git ls-files | LC_ALL=C sort)"

  # What the last deploy shipped and this commit no longer has. The code directories go wholesale, for the same reason.
  previous="$(on_host "if [ -f '$MANIFEST' ]; then cat '$MANIFEST'; fi")"
  if [[ -n "$previous" ]]; then
    if [[ "${previous%%$'\n'*}" != "$MANIFEST_HEADER" ]]; then
      echo "$host has a $MANIFEST this version doesn't understand, so nothing was deployed. Check it, and remove it if it's stale." >&2
      exit 1
    fi
    previous="${previous#*$'\n'}"
    local entry
    while IFS= read -r entry; do
      case "$entry" in
        "" | /* | -* | *..* | data | data/* | .env | .env.* | "$MANIFEST")
          echo "$host's $MANIFEST lists an unsafe path, so nothing was deployed. Check it, and remove it if it's stale: $entry" >&2
          exit 1
          ;;
      esac
    done <<< "$previous"
  fi
  stale="$(comm -23 <(printf '%s\n' "$previous" | LC_ALL=C sort) <(printf '%s\n' "$tracked"))"
  if [[ -n "$stale" ]]; then
    # A directory that's a symlink could lead anywhere, so each file's real location has to be inside the project.
    # shellcheck disable=SC2016 # These expand on the host.
    printf '%s\n' "$stale" | on_host 'set -e; project="$(pwd -P)"; while IFS= read -r file; do
      parent="$(dirname -- "$file")"
      if [ ! -d "$parent" ]; then continue; fi
      case "$(cd -- "$parent" && pwd -P)" in
        "$project" | "$project"/*) rm -f -- "$file" ;;
        *) echo "refusing a path that leads outside the project: $file" >&2; exit 1 ;;
      esac
    done'
  fi
  on_host "rm -rf src lab test scripts .github"
  git archive HEAD | on_host "tar -xf -"
  printf '%s\n%s\n' "$MANIFEST_HEADER" "$tracked" | on_host "cat > '$MANIFEST'"

  local local_hashes remote_hashes
  local_hashes="$(printf '%s\n' "$tracked" | while IFS= read -r file; do shasum -a 256 "$file"; done)"
  # shellcheck disable=SC2016 # These expand on the host.
  remote_hashes="$(printf '%s\n' "$tracked" | on_host 'while IFS= read -r file; do sha256sum "$file"; done')"
  if [[ "$local_hashes" != "$remote_hashes" ]]; then
    echo "The files on $host don't match this commit, so the service wasn't restarted:" >&2
    diff <(printf '%s\n' "$local_hashes") <(printf '%s\n' "$remote_hashes") >&2
    exit 1
  fi

  local present extras
  # Everything but directories: a stray symlink such as compose.override.yaml would change the deployment just as well.
  present="$(on_host "find . \( -path ./data -o -path ./.env -o -path './$MANIFEST' \) -prune -o ! -type d -print | sed 's|^\./||' | LC_ALL=C sort")"
  extras="$(comm -13 <(printf '%s\n' "$tracked") <(printf '%s\n' "$present"))"
  if [[ -n "$extras" ]]; then
    echo "$host has files this commit doesn't, so the service wasn't restarted. Look at them, then remove them:" >&2
    printf '%s\n' "$extras" >&2
    exit 1
  fi

  on_host "TIMELAPSE_REVISION='$revision' docker compose build --quiet timelapse && docker compose up -d timelapse"

  local waited status
  for ((waited = 0; waited < wait_seconds; waited += 2)); do
    # Read in full first: grep -q stops at its match, and under pipefail that closed pipe would read as a failed deploy.
    # A failed read is expected while the container restarts, so it just means another try.
    if status="$(on_host "docker compose exec -T timelapse node src/cli.ts status --json")" && [[ "$status" == *"\"revision\": \"$revision\""* ]]; then
      echo "$host is running $revision."
      return 0
    fi
    sleep 2
  done
  echo "$host didn't report revision $revision within ${wait_seconds}s. Check: ssh $host 'cd $directory && docker compose logs --tail 50 timelapse'" >&2
  exit 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
