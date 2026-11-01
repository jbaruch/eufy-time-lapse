# eufy-time-lapse

Records a construction time-lapse from a solar-powered eufy 4G LTE Cam S330 (T86P2) on its built-in SIM.
The design lives in [`eufy_s330_timelapse_spec.md`](eufy_s330_timelapse_spec.md).

**Status: pre-production.** The probe and the capture service both run against the real camera. Not built
yet: the offsite S3 archive and the monthly preview render. Frames stay on local storage until the archive
exists, and nothing deletes them.

## Requirements

Docker with Compose on the capture host. For development: Node.js 24.5 or later, and FFmpeg with libx264
and libx265.

## Credentials

Eufy has no official API, so this speaks its reverse-engineered protocol and needs a real account login.

The client is [`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk), which uses the same backend as
the current eufy app. The spec's first choice, `eufy-security-client`, logged in but returned an empty device
list, and its maintainers say the API it depends on is being shut down. The SDK sits behind an adapter contract,
so a future client means one new adapter and a new probe run.

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
gateway, such as the alert webhook, belong in OneCLI.

## Run the probe

The probe has to run on the host that will run the service, because P2P behavior depends on the network.

1. Build the image:

   ```bash
   mkdir -p data
   docker compose build
   ```

2. Log in. This handles 2FA and captcha, stores the session, and shows the camera it found:

   ```bash
   docker compose run --rm timelapse login
   ```

3. Confirm in the eufy app that the camera is on its SIM, and record that in `.env`:

   ```bash
   TIMELAPSE_CAMERA_LINK=cellular
   TIMELAPSE_CELLULAR_OPERATOR=<your carrier>
   ```

4. Run three cold captures, 15 minutes apart. Each holds the stream until two keyframes at the required
   size arrive (default 3840x2160), or 60 seconds pass. A failed or undersized try gets one retry 30 seconds
   later, and the best frame wins. Keep the app's live view closed:

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
| `pause` / `resume` | Stop and restart new captures. `resume --battery-checked` overrides a low-battery pause |
| `render --from YYYY-MM-DD --to YYYY-MM-DD` | Builds an MP4 from stored frames, with a manifest. Never touches the camera |
| `export-manifest` | Every capture, one JSON object per line |
| `login` | Log in again when the service reports `auth_required`. A running service picks it up |

The service also answers on `127.0.0.1:8787`. `/status` has the full report. `/healthz` means only that the
process is alive, so check `/status` to know frames are arriving.

### Configuration

Settings live in `data/config.json`. Anything you leave out keeps its default, and a misspelled key is an
error. [`config.example.json`](config.example.json) lists them all. Restart the service after a change.

**Cadence** comes from battery tiers. A slot exists every `grid_minutes`, and the battery decides which ones
run. Skipped slots are recorded with the reason `battery_tier` and stay visible in `status`, so the capture
rate never changes silently. Below `pause_at_or_below_percent` capture stops until the battery reaches
`resume_at_or_above_percent`.

**Rendering** leaves out frames below the required size and lists them in the manifest, because one 720p frame
would otherwise pull a whole 4K video down to 720p. `--include-degraded` puts them back.

**Alerts** post to the webhook in `alerts.webhook_url_file`. Without one they only reach the service log.

## Development

```bash
npm ci
npm run verify
```
