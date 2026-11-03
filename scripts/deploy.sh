#!/usr/bin/env bash
# Ships the committed tree to a capture host over SSH, restarts the service, and waits until it reports the new
# revision. Usage: scripts/deploy.sh [ssh-host] [remote-directory]
# Run it just after a capture if you can: a restart mid-capture marks that slot missed. The data directory and .env
# aren't in the tree, so this never touches them. It checks the whole host before changing anything, changes only files
# still exactly as the last deploy shipped them, and refuses to restart unless the host holds exactly this commit.
set -euo pipefail

# Owned by this script, the only reader and writer: what the last deploy shipped, one "<sha256>  <path>" per line after the
# header. A new shape means a new schema_version and a migration here. Anything else on the host gets refused, not guessed
# at, including version 1: it held paths alone, which can't show that a file is still what was shipped.
readonly MANIFEST=".deployed-files"
readonly MANIFEST_HEADER="# eufy-time-lapse deployed files, schema_version=2"

on_host() {
  # shellcheck disable=SC2029 # The directory is meant to expand here, on this side of the connection.
  ssh "$host" "cd -- $remote_directory && $1"
}

# The lines of the first list that aren't in the second. comm needs input sorted in its own locale, so both use one.
# Sorted here rather than in process substitutions, where a failing sort would look like an empty list, and an empty list
# of what to keep is how files get deleted.
lines_only_in() {
  local first second
  first="$(printf '%s\n' "$1" | LC_ALL=C sort)" || return 1
  second="$(printf '%s\n' "$2" | LC_ALL=C sort)" || return 1
  LC_ALL=C comm -23 <(printf '%s\n' "$first") <(printf '%s\n' "$second")
}

# What the host holds outside the data directory, .env and the manifest, matching a find test. find doesn't follow a
# symlink. Its paths are trimmed on this side, so a find that fails partway fails the deploy instead of shortening the list.
inventory() {
  on_host "find . \( -path ./data -o -path ./.env -o -path './$MANIFEST' -o -path './$MANIFEST.tmp' \) -prune -o $1 -print" | sed 's|^\./||'
}

# What the host holds, as "<sha256>  <path>". The same scope and the same reasoning as inventory.
hashed_inventory() {
  on_host "find . \( -path ./data -o -path ./.env -o -path './$MANIFEST' -o -path './$MANIFEST.tmp' \) -prune -o -type f -exec sha256sum {} +" | sed 's|  \./|  |'
}

paths_of() {
  # shellcheck disable=SC2001 # This is a list: parameter expansion can't anchor to the start of each line.
  sed 's/^[^ ]*  //' <<< "$1"
}

# Replaced whole, so a dropped connection leaves the old list or the new one, never part of either.
write_manifest() {
  printf '%s\n%s\n' "$MANIFEST_HEADER" "$1" | on_host "rm -f '$MANIFEST.tmp' && cat > '$MANIFEST.tmp' && mv -f '$MANIFEST.tmp' '$MANIFEST'"
}

main() {
  host="${1:-nas}"
  directory="${2:-eufy-time-lapse}"
  local wait_seconds="${DEPLOY_WAIT_SECONDS:-60}"
  if [[ "$host" == -* ]]; then
    echo "The host can't start with a dash, because ssh would read it as an option: $host. Nothing was deployed." >&2
    exit 1
  fi
  # Quoted for the host's shell: this is a value, and nothing in it should run there.
  printf -v remote_directory '%q' "$directory"

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Uncommitted changes wouldn't ship, so nothing was deployed. Commit or stash them first." >&2
    exit 1
  fi
  local revision tracked links shipping
  revision="$(git rev-parse --short HEAD)"
  tracked="$(git ls-files | LC_ALL=C sort)"
  links="$(git ls-files -s | awk -F'\t' '$1 ~ /^120000 / { print $2 }')"
  if [[ -n "$links" ]]; then
    echo "This commit tracks symlinks, which could lead anywhere on the host, so nothing was deployed. Replace them with files:" >&2
    printf '%s\n' "$links" >&2
    exit 1
  fi
  # One shasum over every file, so a file that can't be read fails the whole list. A loop would answer for its last file only.
  if ! shipping="$(printf '%s\n' "$tracked" | tr '\n' '\0' | xargs -0 shasum -a 256)"; then
    echo "Couldn't hash this commit's files, so nothing was deployed. The error above names the file." >&2
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
    local entry path
    while IFS= read -r entry; do
      if [[ ! "$entry" =~ ^[0-9a-f]{64}\ \ (.*)$ ]]; then
        echo "$host has a $MANIFEST with a line this version doesn't understand, so nothing was deployed. Check it, and remove it if it's stale: $entry" >&2
        exit 1
      fi
      path="${BASH_REMATCH[1]}"
      case "$path" in
        .env.example) ;; # Tracked, and it holds no values.
        "" | /* | -* | *..* | data | data/* | .env | .env.* | "$MANIFEST" | "$MANIFEST.tmp")
          echo "$host's $MANIFEST lists an unsafe path, so nothing was deployed. Check it, and remove it if it's stale: $path" >&2
          exit 1
          ;;
      esac
    done <<< "$previous"
  fi

  local unverifiable present present_paths changed extras stale claimed
  unverifiable="$(inventory '! -type d ! -type f')"
  if [[ -n "$unverifiable" ]]; then
    echo "$host has symlinks or special files, which could lead anywhere, so nothing was deployed. Look at them, then remove them:" >&2
    printf '%s\n' "$unverifiable" >&2
    exit 1
  fi
  present="$(hashed_inventory)"
  # One step at a time throughout: set -e can't see a failure inside a substitution that's an argument to something else.
  changed="$(lines_only_in "$present" "$previous")"
  extras="$(paths_of "$changed")"
  if [[ -n "$extras" ]]; then
    echo "$host has files the last deploy didn't ship, or that changed since, so nothing was deployed. Look at them, then remove them:" >&2
    printf '%s\n' "$extras" >&2
    exit 1
  fi
  # Every file on the host is now known to be exactly what the last deploy shipped, so these are safe to remove.
  present_paths="$(paths_of "$present")"
  stale="$(lines_only_in "$present_paths" "$tracked")"

  # Claimed before anything lands, so a deploy that dies halfway can be run again: what it left is already owned.
  claimed="$(printf '%s\n%s\n' "$previous" "$shipping" | LC_ALL=C sort -u | sed '/^$/d')"
  write_manifest "$claimed"
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
  write_manifest "$shipping"

  local remote_hashes
  # shellcheck disable=SC2016 # These expand on the host.
  if ! remote_hashes="$(printf '%s\n' "$tracked" | on_host 'tr "\n" "\0" | xargs -0 sha256sum')"; then
    echo "Couldn't hash the files on $host, so the service wasn't restarted. The error above names the file." >&2
    exit 1
  fi
  if [[ "$shipping" != "$remote_hashes" ]]; then
    echo "The files on $host don't match this commit, so the service wasn't restarted:" >&2
    diff <(printf '%s\n' "$shipping") <(printf '%s\n' "$remote_hashes") >&2
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
