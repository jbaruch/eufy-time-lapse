#!/usr/bin/env bash
# Ships the committed tree to a capture host over SSH, restarts the service, and waits until it reports the new
# revision. Usage: scripts/deploy.sh [ssh-host] [remote-directory]
# Run it just after a capture if you can: a restart mid-capture marks that slot missed. The data directory and .env
# aren't in the tree, so this never touches them. It checks the whole host before changing anything, changes only what
# the last deploy shipped, and refuses to restart unless the host holds exactly this commit.
set -euo pipefail

# Owned by this script, the only reader and writer: what the last deploy shipped, one path per line after the header.
# A new shape means a new schema_version and a migration here. Anything else on the host gets refused, not guessed at.
readonly MANIFEST=".deployed-files"
readonly MANIFEST_HEADER="# eufy-time-lapse deployed files, schema_version=1"

on_host() {
  # shellcheck disable=SC2029 # The directory is meant to expand here, on this side of the connection.
  ssh "$host" "cd '$directory' && $1"
}

# The lines of the first list that aren't in the second. comm needs input sorted in its own locale, so both use one.
lines_only_in() {
  LC_ALL=C comm -23 <(printf '%s\n' "$1" | LC_ALL=C sort) <(printf '%s\n' "$2" | LC_ALL=C sort)
}

# What the host holds outside the data directory, .env and the manifest, matching a find test. find doesn't follow a
# symlink. Its paths are trimmed on this side, so a find that fails partway fails the deploy instead of shortening the list.
inventory() {
  on_host "find . \( -path ./data -o -path ./.env -o -path './$MANIFEST' -o -path './$MANIFEST.tmp' \) -prune -o $1 -print" | sed 's|^\./||'
}

# Replaced whole, so a dropped connection leaves the old list or the new one, never part of either.
write_manifest() {
  printf '%s\n%s\n' "$MANIFEST_HEADER" "$1" | on_host "rm -f '$MANIFEST.tmp' && cat > '$MANIFEST.tmp' && mv -f '$MANIFEST.tmp' '$MANIFEST'"
}

main() {
  host="${1:-nas}"
  directory="${2:-eufy-time-lapse}"
  local wait_seconds="${DEPLOY_WAIT_SECONDS:-60}"

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Uncommitted changes wouldn't ship, so nothing was deployed. Commit or stash them first." >&2
    exit 1
  fi
  local revision tracked links
  revision="$(git rev-parse --short HEAD)"
  tracked="$(git ls-files | LC_ALL=C sort)"
  links="$(git ls-files -s | awk -F'\t' '$1 ~ /^120000 / { print $2 }')"
  if [[ -n "$links" ]]; then
    echo "This commit tracks symlinks, which could lead anywhere on the host, so nothing was deployed. Replace them with files:" >&2
    printf '%s\n' "$links" >&2
    exit 1
  fi

  # From here to the first write_manifest, this only reads the host.
  local manifest_state previous
  manifest_state="$(on_host "if [ -L '$MANIFEST' ] || { [ -e '$MANIFEST' ] && [ ! -f '$MANIFEST' ]; }; then echo refuse; fi")"
  if [[ -n "$manifest_state" ]]; then
    echo "$host's $MANIFEST isn't a regular file, so nothing was deployed. Look at it, then remove it." >&2
    exit 1
  fi
  previous="$(on_host "if [ -f '$MANIFEST' ]; then cat '$MANIFEST'; fi")"
  if [[ -n "$previous" ]]; then
    if [[ "${previous%%$'\n'*}" != "$MANIFEST_HEADER" ]]; then
      echo "$host has a $MANIFEST this version doesn't understand, so nothing was deployed. Check it, and remove it if it's stale." >&2
      exit 1
    fi
    previous="${previous#"$MANIFEST_HEADER"}"
    previous="${previous#$'\n'}"
  fi
  if [[ -n "$previous" ]]; then
    local entry
    while IFS= read -r entry; do
      case "$entry" in
        .env.example) ;; # Tracked, and it holds no values.
        "" | /* | -* | *..* | data | data/* | .env | .env.* | "$MANIFEST" | "$MANIFEST.tmp")
          echo "$host's $MANIFEST lists an unsafe path, so nothing was deployed. Check it, and remove it if it's stale: $entry" >&2
          exit 1
          ;;
      esac
    done <<< "$previous"
  fi

  local unverifiable present extras stale
  unverifiable="$(inventory '! -type d ! -type f')"
  if [[ -n "$unverifiable" ]]; then
    echo "$host has symlinks or special files, which could lead anywhere, so nothing was deployed. Look at them, then remove them:" >&2
    printf '%s\n' "$unverifiable" >&2
    exit 1
  fi
  present="$(inventory '-type f')"
  extras="$(lines_only_in "$present" "$previous")"
  if [[ -n "$extras" ]]; then
    echo "$host has files the last deploy didn't ship, so nothing was deployed. Look at them, then remove them:" >&2
    printf '%s\n' "$extras" >&2
    exit 1
  fi
  # Every file on the host is now known to be the last deploy's, so these are safe to remove.
  stale="$(lines_only_in "$present" "$tracked")"

  # Claimed before anything lands, so a deploy that dies halfway can be run again: what it left is already owned.
  write_manifest "$(printf '%s\n%s\n' "$previous" "$tracked" | LC_ALL=C sort -u | sed '/^$/d')"
  if [[ -n "$stale" ]]; then
    # shellcheck disable=SC2016 # These expand on the host.
    printf '%s\n' "$stale" | on_host 'set -e; while IFS= read -r file; do
      rm -f -- "$file"
      parent="$(dirname -- "$file")"
      while [ "$parent" != . ] && [ -z "$(ls -A -- "$parent")" ]; do
        rmdir -- "$parent"
        parent="$(dirname -- "$parent")"
      done
    done'
  fi
  git archive HEAD | on_host "tar -xf -"
  write_manifest "$tracked"

  local local_hashes remote_hashes
  local_hashes="$(printf '%s\n' "$tracked" | while IFS= read -r file; do shasum -a 256 "$file"; done)"
  # shellcheck disable=SC2016 # These expand on the host.
  remote_hashes="$(printf '%s\n' "$tracked" | on_host 'while IFS= read -r file; do sha256sum "$file"; done')"
  if [[ "$local_hashes" != "$remote_hashes" ]]; then
    echo "The files on $host don't match this commit, so the service wasn't restarted:" >&2
    diff <(printf '%s\n' "$local_hashes") <(printf '%s\n' "$remote_hashes") >&2
    exit 1
  fi

  local after
  # Everything but directories: a stray symlink such as compose.override.yaml would change the deployment just as well.
  after="$(inventory '! -type d')"
  extras="$(lines_only_in "$after" "$tracked")"
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
