# Changelog

## Unreleased

- Turns AI tracking back on over the frame's own connection, before closing it, instead of connecting again afterwards. That's one camera wake per slot instead of two, and it avoids the reconnect the camera sometimes dropped, which left tracking off until the next try between slots.
- Checks the framing of a frame it finishes after a crash, as it does any other, and at each start checks any frame a crash left between being stored and being checked. Before, such a frame skipped the check, so one shot off target went into renders unflagged.
- A reset that runs out of time now says which step it was stuck on, and what each step before it took, so a slow connection and a camera that didn't answer read differently in the log.
- A reset, `framing set` or `framing off` that runs out of time stops before its next camera command, instead of moving, saving or deleting after it was reported as failed, and its message says what's safe to do next.
- No longer crashes when a frame's connection is closed while its "tracking on" is still waiting. The SDK reports that as a superseded session, which the service took for a bug, and restarted itself over, twice in the first week.

## 0.1.0 — 2026-11-03

First version of the service, proven against the real camera on its built-in SIM.

- Captures 4K frames on a site-local slot grid, thinned by battery tiers, and publishes each with immutable metadata.
- Connects through the relay with this project's own policy on top of the SDK: 98 of 100 back-to-back tries at 4K, against 3 of 13 with the SDK's own connect, in about a quarter of the session time.
- Passes the formal three-attempt probe, and got 46 of 47 slots at 4K over a night at 5 minutes on cable.
- Recovers from restarts, tracks camera-contact and data budgets, and alerts on repeated misses, first-try drift, low battery, and logins that need a person.
- Restarts itself with an alert if the capture loop stops making progress, instead of staying up and silent.
- Records a stream that ends with no video as `stream_lost`, not `capture_timeout`, so the failures in `status` say whether the camera hung up or time ran out.
- Finishes a capture that a crash interrupted from what's already on disk, and audits stored frames in the background after each start.
- Renews its 30-day Eufy login a week before it ends. If Eufy asks for a code, the old login keeps working and an alert gives a person the date.
- The `login` command adds the service to the account's trusted devices, through the older of Eufy's two login systems, since only its codes can do that. After that, renewing the login takes no code.
- Renders MP4s from stored frames without touching the camera.
- Sends a daily report after the capture window closes: the day's frames, how many took a second try, when any were missed, the battery against the day before, how long it charged and what it reached, and the battery's temperature.
- Keeps every frame on target when people also use it as a camera, and when it follows what it detects: `framing set` saves the view, and each slot turns AI tracking off, sends the camera back, takes the frame, retakes it if it's off target, and turns tracking back on. Frames still off target are flagged and left out of renders, and an alert says so if it keeps happening. Failures at any step retry, and none of them costs the frame.
- `probe` uses the service's capture settings, and with `--attempts 10 --interval-minutes 0.05` is a 4-minute check for mount day. The README's "Going live" has the order.
- Sends alerts to Telegram through the OneCLI gateway, so the service never holds the bot token. An alert that can't be delivered is tried again at the next slot.
- Not built yet: the offsite S3 archive and the monthly preview render.
