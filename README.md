# eufy-time-lapse

Records a construction time-lapse from a solar-powered eufy 4G LTE Cam S330 (T86P2) on its built-in SIM.
The design lives in [`eufy_s330_timelapse_spec.md`](eufy_s330_timelapse_spec.md).

**Status:** the service runs against the real camera on its SIM, at about 98% of first tries in 4K. Still open:
battery behavior on solar, which sets the sustainable cadence. Not built yet: the offsite S3 archive and the
monthly preview render. Frames stay on local storage until the archive exists, and nothing deletes them.

## Requirements

Docker with Compose on the capture host. For development: Node.js 24.5 or later, and FFmpeg with libx264
and libx265.

## Credentials

Eufy has no official API, so this speaks its reverse-engineered protocol and needs a real account login.

The client is [`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk), which uses the same backend as
the current eufy app. The spec's first choice, `eufy-security-client`, logged in but returned an empty device
list, and its maintainers say the API it depends on is being shut down. The SDK sits behind an adapter contract,
so a future client means one new adapter and a new probe run. How it connects is this project's own, covered in
[How it reaches the camera](#how-it-reaches-the-camera).

Use a separate Eufy account and share the camera to it from the owner account, then accept the invitation
in the eufy app while logged in as that account. Store its login on the capture host:

```bash
scripts/set-credentials.sh
```

The files land in `~/.config/eufy-time-lapse/`, readable only by you, and reach the container as Docker
secrets. SDK logs are redacted before they reach disk, and login runs drop debug output entirely.

**Why not OneCLI?** The client encrypts the password into the request body with a key it negotiates with
Eufy, and the newer API encrypts and signs every body. The gateway writes only headers and query
parameters, and P2P is UDP. Nothing in that traffic can carry a placeholder. Credentials that do fit the
gateway belong in OneCLI, and the Telegram bot token for alerts lives there.

## Run the probe

The probe has to run on the host that will run the service, because P2P behavior depends on the network.

1. Build the image:

   ```bash
   mkdir -p data
   docker compose build
   ```

2. Log in. This handles 2FA and captcha, stores the session, adds this service to the account's trusted devices, and
   shows the camera it found. Eufy runs two login systems, so a first login can email two codes and show a captcha, and
   each code lasts 5 minutes. Without that trust, Eufy asks for a code every time the 30-day login is renewed:

   ```bash
   docker compose run --rm timelapse login
   ```

3. Confirm in the eufy app that the camera is on its SIM, and record that in `.env`:

   ```bash
   TIMELAPSE_CAMERA_LINK=cellular
   TIMELAPSE_CELLULAR_OPERATOR=<your carrier>
   ```

4. Run three cold captures, 15 minutes apart. Each holds the stream until two keyframes at the required
   size arrive (default 3840x2160), or 30 seconds pass. A failed or undersized try gets up to two more, 5 seconds
   apart, and the best frame wins. Keep the app's live view closed:

   ```bash
   docker compose run --rm timelapse probe
   ```

Each run writes to `data/probe/<run-id>/`. A retry's files go in `attempt-N-retry-1/`:

| File | Contents |
| --- | --- |
| `report.json` | Timings, codec, resolution, traffic, battery, cleanup, every try, first-try success count, verdict, and the next experiment if it failed |
| `attempt-N/frame.jpg` | The selected frame |
| `attempt-N/keyframe-*.jpg` | Every keyframe, for judging quality after a cold start |
| `attempt-N/stream.bin` | The raw video |
| `library.log` | Redacted library log at debug level, including the P2P lookup and relay steps |

Exit code 0 means the probe passed. Anything else: read `verdict` in the report.

## Run the service

```bash
docker compose up -d
```

It captures on the slot grid in the site's time zone, publishes each frame atomically to
`data/spool/<project>/<camera>/YYYY/MM/DD/<capture-id>/` with an immutable `metadata.json`, and tracks
everything in `data/state.sqlite`. A restart resumes safely: past slots stay missed rather than being made
up, and a frame saved just before a crash isn't captured again.

Run anything else alongside it with `docker compose run --rm timelapse <command>`:

| Command | Does |
| --- | --- |
| `status [--json]` | Last frame, next slot, completeness, battery, pauses, budgets, reliability by connection path |
| `calibration [--hours N]` | Battery, solar input and capture load, hour by hour |
| `capture` | One manual frame now. Never counts toward completeness |
| `framing set` / `framing off` | Keep the camera on target, or stop. See "Using it as a camera too" |
| `pause` / `resume` | Stop and restart new captures. `resume --battery-checked` overrides a low-battery pause |
| `render --from YYYY-MM-DD --to YYYY-MM-DD` | Builds an MP4 from stored frames, with a manifest. Never touches the camera |
| `export-manifest` | Every capture, one JSON object per line |
| `notify-test` | Sends one test message to the alert destination |
| `login` | Log in again when the service reports `auth_required` or `login_renewal`, or to make this device trusted. A running service picks it up |

## Going live

In this order, and nothing waits for a slot:

1. **Off cable: stop.** `docker compose run --rm timelapse pause`. The service stays up and no slot wakes the camera.
   Telegram reminds you once a day that it's paused.
2. **Mounted: a quick, intensive check.** About 4 minutes, using the service's own capture settings:

   ```bash
   docker compose run --rm timelapse probe --attempts 10 --interval-minutes 0.05
   ```

   Each try's `frame.jpg` shows the framing. Turn motion tracking off in the app while someone is still up there.
   Compare the timings with the quick check in the spec's section 3.1.
3. **All set: production pace.** Take the test overrides out of `data/config.json`, restart, then
   `docker compose run --rm timelapse resume`. The defaults are 08:00 to 18:00 daily, every 5 minutes at 60% battery or
   more, every 15 at 40%, hourly below that, and a pause at 25%.

## Using it as a camera too

You can watch and pan in the app at any time. A slot that fires during live view still gets its frame, and the picture
flickers once. To keep frames on target while people do that:

```bash
docker compose run --rm timelapse framing set
```

This saves where the camera points now, in the first empty saved-position slot. It shows in the app, so leave it there.
From then on, each frame is compared with the last good one:

- One frame off target is flagged, and renders leave it out. `render --include-off-target` keeps it.
- If the next slot is off target too, the camera goes back to the saved position, so you get about 5 to 10 minutes of
  looking around. The first frame after that is the next slot's.
- It lands 10 to 18 pixels from where it was, which is close enough to count as on target.
- A return runs at most every 30 minutes and 6 times in 24 hours. If going back doesn't fix it, an alert says so.
- Fog, darkness or a frame it can't judge count as unsure, and unsure never moves the camera.

If you meant to change the view, run `framing set` again. `framing off` stops all of it. `"framing": { "return_enabled": false }`
in `data/config.json` keeps the flags and the verdicts in `status`, but never moves the camera.

The service also answers on `127.0.0.1:8787`. `/status` has the full report. `/healthz` means only that the
process is alive, so check `/status` to know frames are arriving. If the capture loop makes no progress for 15 minutes,
the service alerts and restarts itself.

### Configuration

Settings live in `data/config.json`. Anything you leave out keeps its default, and a misspelled key is an
error. [`config.example.json`](config.example.json) lists them all. Restart the service after a change.

**Cadence** comes from battery tiers. A slot exists every `grid_minutes`, and the battery decides which ones
run. Skipped slots are recorded with the reason `battery_tier` and stay visible in `status`, so the capture
rate never changes silently. Below `pause_at_or_below_percent` capture stops until the battery reaches
`resume_at_or_above_percent`. If a read from Eufy's cloud fails, the last reading stays in force until it's older
than `reading_max_age_hours`. After that the rate drops to `unknown_battery_every_minutes`, skips are recorded as
`battery_unknown`, and an alert says so.

**Rendering** leaves out frames below the required size and lists them in the manifest, because one 720p frame
would otherwise pull a whole 4K video down to 720p. `--include-degraded` puts them back.

**Alerts** go to the service log, and to Telegram when `alerts.telegram` is set. Besides repeated misses, they cover
first-try success falling below `first_try_warn_percent`, since retries get the frame but spend battery where no slot
count would show it. An alert that can't be delivered, as is likely during an outage, is tried again at the next slot.

This service never holds the bot token. The OneCLI gateway does, and swaps it in for the placeholder on the way to
Telegram, so the setup is an identity on the gateway plus two files:

1. Create a OneCLI identity for the service, remove the grants it inherits, and attach only the bot's secret. The
   secret's path injection follows `^(/file)?/bot<ID>:onecli-managed/`, as in nanoclaw's `docs/TELEGRAM-VAULT.md`.
2. Store its route where the container can read it, without printing it:

   ```bash
   onecli run --agent eufy-time-lapse --gateway <gateway-host> -- bash -c 'umask 077
     printf "%s\n" "$HTTPS_PROXY" > ~/.config/eufy-time-lapse/onecli_proxy_url
     cat "$NODE_EXTRA_CA_CERTS" > ~/.config/eufy-time-lapse/onecli_ca.pem'
   ```

3. Name the destination in `data/config.json`. The bot id is the part of its token before the colon, and isn't secret:

   ```json
   "alerts": { "telegram": { "bot_id": "<digits>", "chat_id": "<chat id>", "proxy_url_file": "/run/timelapse-secrets/onecli_proxy_url", "ca_file": "/run/timelapse-secrets/onecli_ca.pem" } }
   ```

4. Restart the service, then run `docker compose run --rm timelapse notify-test`, which sends one message.

### Deploy

`scripts/deploy.sh [ssh-host] [remote-directory]` ships the committed tree, proves the copy by checksum, rebuilds,
restarts, and waits for the host to report the new revision. `status` shows the running revision at any time. Before
it changes anything, it refuses any file on the host the last deploy didn't ship, and names it.

## How it reaches the camera

The camera sits behind carrier NAT, so every 4K frame comes through a relay. The SDK's own connect was unreliable
here: 3 of 13 back-to-back tries reached 4K, in sessions of about 33 seconds. `src/adapters/p2p-policy.ts` replaces
that behavior by wrapping private methods of the SDK's session class:

- It asks for the relay almost at once, and asks again after a 2-second stall. The SDK asks once, so one lost
  message used to mean sitting dead until its 45-second timeout.
- It sends no hole-punch bursts and uses one socket, because carrier NAT defeats the punch anyway.
- It starts the stream once. The SDK starts a running stream again when the level-2 key arrives, and the camera
  often closed the session right after.

That got 98 of 100 tries to 4K, with a median session of 9.4 seconds, and about 13 seconds when the camera has
to wake. [`lab/`](lab/README.md) holds the rig that measured it, and section 3.1 of the spec has the findings.

The wrapping depends on SDK internals, so the SDK is pinned exactly and `test/p2p-policy.test.ts` runs against the
real class. A Dependabot bump that moves those internals fails CI. One that doesn't still needs a run of the rig
before it reaches the camera.

## Development

```bash
npm ci
npm run verify
```

CI runs the same checks with the production FFmpeg, lints the scripts, scans the history for secrets, and builds
the image.
