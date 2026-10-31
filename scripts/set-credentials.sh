#!/usr/bin/env bash
# Stores the Eufy login as Docker secret files on this host. Prompts, so nothing lands in shell history.
# OneCLI can't hold these: the client encrypts the password into the request body, and the gateway
# only writes headers and query parameters. See the README.
set -euo pipefail

secrets_dir="${TIMELAPSE_SECRETS_DIR:-$HOME/.config/eufy-time-lapse}"

read -r -p "Eufy account email: " email
read -r -s -p "Eufy account password (not shown): " password
echo

if [[ -z "$email" || -z "$password" ]]; then
  echo "Both the email and the password are required. Nothing was changed." >&2
  exit 1
fi

umask 077
mkdir -p "$secrets_dir"
chmod 700 "$secrets_dir"
printf '%s\n' "$email" > "$secrets_dir/eufy_email"
printf '%s\n' "$password" > "$secrets_dir/eufy_password"
chmod 600 "$secrets_dir/eufy_email" "$secrets_dir/eufy_password"

echo "Saved to $secrets_dir"
