# Changelog

## Unreleased

First version of the service, proven against the real camera on its built-in SIM.

- Captures 4K frames on a site-local slot grid, thinned by battery tiers, and publishes each with immutable metadata.
- Connects through the relay with this project's own policy on top of the SDK: 98 of 100 back-to-back tries at 4K, against 3 of 13 with the SDK's own connect, in about a quarter of the session time.
- Recovers from restarts, tracks camera-contact and data budgets, and alerts on repeated misses, first-try drift, low battery, and logins that need a person.
- Renders MP4s from stored frames without touching the camera.
- Not built yet: the offsite S3 archive and the monthly preview render.
