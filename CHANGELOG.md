# Changelog

## Unreleased

First version of the service, proven against the real camera on its built-in SIM.

- Captures 4K frames on a site-local slot grid, thinned by battery tiers, and publishes each with immutable metadata.
- Connects through the relay with this project's own policy on top of the SDK: 98 of 100 back-to-back tries at 4K, against 3 of 13 with the SDK's own connect, in about a quarter of the session time.
- Passes the formal three-attempt probe, and got 46 of 47 slots at 4K over a night at 5 minutes on cable.
- Recovers from restarts, tracks camera-contact and data budgets, and alerts on repeated misses, first-try drift, low battery, and logins that need a person.
- Restarts itself with an alert if the capture loop stops making progress, instead of staying up and silent.
- Finishes a capture that a crash interrupted from what's already on disk, and audits stored frames in the background after each start.
- Renews its 30-day Eufy login a week before it ends. If Eufy asks for a code, the old login keeps working and an alert gives a person the date.
- The `login` command adds the service to the account's trusted devices, through the older of Eufy's two login systems, since only its codes can do that. After that, renewing the login takes no code.
- Renders MP4s from stored frames without touching the camera.
- Sends a daily report after the capture window closes: the day's frames, the battery and its change, when charging was last seen, and the battery's temperature.
- Keeps the camera on target when people also use it as a camera: `framing set` saves the view, frames that drift are flagged and left out of renders, and the camera goes back if it stays off for two slots.
- `probe` uses the service's capture settings, and with `--attempts 10 --interval-minutes 0.05` is a 4-minute check for mount day. The README's "Going live" has the order.
- Sends alerts to Telegram through the OneCLI gateway, so the service never holds the bot token. An alert that can't be delivered is tried again at the next slot.
- Not built yet: the offsite S3 archive and the monthly preview render.
