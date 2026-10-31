# eufy-time-lapse

Records a construction time-lapse from a solar-powered eufy 4G LTE Cam S330 (T86P2) on its built-in SIM.
The design lives in [`eufy_s330_timelapse_spec.md`](eufy_s330_timelapse_spec.md).

**Status: Phase 1.** Only the native-LTE feasibility probe exists. The continuous service stays blocked
until the probe passes on the real camera, from the host that will run it.

## Requirements

Docker with Compose on the capture host. For development: Node.js 24.5 or later, and FFmpeg with libx264
and libx265.

## Credentials

Eufy has no official API, so this speaks its reverse-engineered protocol and needs a real account login.

Use a separate Eufy account and share the camera to it from the owner account. Store its login on the
capture host:

```bash
scripts/set-credentials.sh
```

The files land in `~/.config/eufy-time-lapse/`, readable only by you, and reach the container as Docker
secrets. Debug output from the Eufy library contains tokens, so the service leaves those logs off and
redacts what it does log.

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

4. Run three cold captures, 15 minutes apart. Keep the app's live view closed:

   ```bash
   docker compose run --rm timelapse probe
   ```

Each run writes to `data/probe/<run-id>/`:

| File | Contents |
| --- | --- |
| `report.json` | Timings, codec, resolution, traffic, battery, cleanup, verdict, and the next experiment if it failed |
| `attempt-N/frame.jpg` | The selected frame |
| `attempt-N/keyframe-*.jpg` | Every keyframe, for judging quality after a cold start |
| `attempt-N/stream.bin` | The raw video |
| `library.log` | Redacted library log, with P2P at debug level |

Exit code 0 means the probe passed. Anything else means Phase 2 stays blocked: read `verdict` in the report.

## Development

```bash
npm ci
npm run verify
```
