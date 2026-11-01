# Changelog

## Unreleased

First version of the service, proven against the real camera on its built-in SIM.

- Captures 4K frames on a site-local slot grid, thinned by battery tiers, and publishes each with immutable metadata.
- Connects through the relay with this project's own policy on top of the SDK: 98 of 100 back-to-back tries at 4K, against 3 of 13 with the SDK's own connect, in about a quarter of the session time.
- Passes the formal three-attempt probe, and got 46 of 47 slots at 4K over a night at 5 minutes on cable.
- Recovers from restarts, tracks camera-contact and data budgets, and alerts on repeated misses, first-try drift, low battery, and logins that need a person.
- Finishes a capture that a crash interrupted from what's already on disk, and audits stored frames in the background after each start.
- Renews its 30-day Eufy login a week before it ends. If Eufy asks for a code, the old login keeps working and an alert gives a person the date.
- The `login` command adds the service to the account's trusted devices, since Eufy otherwise asks for a code at every login.
- Renders MP4s from stored frames without touching the camera.
- Sends alerts to Telegram through the OneCLI gateway, so the service never holds the bot token. An alert that can't be delivered is tried again at the next slot.
- Not built yet: the offsite S3 archive and the monthly preview render.
