#!/usr/bin/env bash
# Stores the Eufy login as Docker secret files on this host. Prompts, so nothing lands in shell history.
# OneCLI can't hold these: the client encrypts the password into the request body, and the gateway
# only writes headers and query parameters. See the README.
set -euo pipefail

# mktemp makes the file owner-only, and the rename means nothing ever reads half a secret or follows a link to write one.
replace_file() {
  local temporary
  temporary="$(mktemp "$1.XXXXXX")"
  if ! { printf '%s\n' "$2" > "$temporary" && mv -f "$temporary" "$1"; }; then
    rm -f "$temporary"
    echo "Couldn't write $1, so it wasn't changed. Check the disk, then run this again." >&2
    exit 1
  fi
}

main() {
  local secrets_dir="${TIMELAPSE_SECRETS_DIR:-$HOME/.config/eufy-time-lapse}"
  secrets_dir="${secrets_dir%/}"
  local email_file="$secrets_dir/eufy_email" password_file="$secrets_dir/eufy_password"
  local email password

  read -r -p "Eufy account email: " email
  read -r -s -p "Eufy account password (not shown): " password
  echo

  if [[ -z "$email" || -z "$password" ]]; then
    echo "Both the email and the password are required. Nothing was changed." >&2
    exit 1
  fi

  # A symlink here would send the password wherever it points, outside the protected directory.
  if [[ -L "$secrets_dir" ]]; then
    echo "$secrets_dir is a symlink, so nothing was changed. Point TIMELAPSE_SECRETS_DIR at a real directory, or remove the link." >&2
    exit 1
  fi
  local file
  for file in "$email_file" "$password_file"; do
    if [[ -L "$file" || (-e "$file" && ! -f "$file") ]]; then
      echo "$file isn't a regular file, so nothing was changed. Look at it, then remove it." >&2
      exit 1
    fi
  done

  umask 077
  mkdir -p "$secrets_dir"
  chmod 700 "$secrets_dir"
  replace_file "$email_file" "$email"
  replace_file "$password_file" "$password"

  echo "Saved to $secrets_dir"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
