# Lab

A measurement rig, not part of the service: nothing in `src` imports it, and `.dockerignore` keeps it out of the image.

`hammer.ts` fires captures at the real camera back to back, rotating through connect policies so they share the same conditions. It takes the camera lock, so stop the service first.

```sh
docker compose stop timelapse
docker compose run -d --name eufy-lab --no-deps \
  -v "$PWD/src:/app/src:ro" -v "$PWD/lab:/app/lab:ro" \
  --entrypoint node timelapse lab/hammer.ts --variants sdk,quiet --rounds 20 --name compare
docker logs -f eufy-lab
```

Each run writes `data/lab/<name>-<time>/`: `results.jsonl` with one summary per try, and a `.trace.jsonl` per try with the protocol packets. Traces mask the device id and never keep lookup payloads, which carry the account's lookup key.

## Packet types

Names follow the SDK where it has them. `f1` is the protocol's magic byte.

| Type | Meaning |
| --- | --- |
| `f126` | Lookup: asks the lookup servers for a P2P session with the camera |
| `f121` | Lookup server's acknowledgement |
| `f140` | Lookup server names an address the camera is using |
| `f16a` / `f169` | Asks for the relay list / the list |
| `f170` / `f171` | Hello to a relay / its acknowledgement |
| `f172` / `f173` | Asks a relay for a session port / the port and a mark |
| `f180` / `f181` | Asks the lookup servers to send the camera to that relay / acknowledgement |
| `f182` | A relay endpoint to register with, and a mark |
| `f183` | Registers at a relay with a mark. The camera's arrives here through the relay, 23 copies whether answered or not |
| `f184` | Ready: the camera has joined the relay session |
| `f1e0` / `f1e1` | Ping / pong |
| `f1d0` / `f1d1` | Data / its acknowledgement |
| `f1f0` | Close |
| `f128` | Unknown. Some relays send it twice a second during a session |
