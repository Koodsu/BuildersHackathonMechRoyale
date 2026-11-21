# BuildersHackathonMechRoyale

Bot for the Builders Buildathon "Mech Royale" track (protocol `mechfight/1`). TypeScript, run directly by Node 24, no dependencies.

## Layout

| Path | What it is |
| --- | --- |
| `Dockerfile` | The submission image (Node 24, pinned by digest). |
| `main.ts` | Entry point: hands the bot to the kit wrapper. |
| `mechfight.ts` | The kit's wrapper (stdin/stdout loop), unchanged. |
| `src/world.ts` | Map model: terrain, building footprints, clearance, line of sight. |
| `src/nav.ts` | 2 m walkable grid and A* path search. |
| `src/bot.ts` | The pilot: memory, target choice, legs, aiming and triggers. |
| `tools/` | Checks that run without a match (see below). |
| `kit/` | The organisers' kit: rulebook, schema, conformance check, map. |

## Checks

```sh
node tools/maptest.ts            # map model against the kit's recorded match
node tools/walk.ts               # legs reach their goal across the map (ground, roofs, stadium)
node tools/aimtest.ts            # shots land on a moving target
node tools/tactics.ts            # stances: fight, wait behind cover, heal first, duck a charging laser
node tools/replay.ts             # no crashes, invalid actions or slow ticks on recorded and random input
python3 kit/check/check.py -- node main.ts
```

The scorer's own check, on the image it will build:

```sh
docker build --platform linux/amd64 -t mech-bot .
cd kit && python3 check/check.py --map-dir /arena -- docker run --rm -i --platform linux/amd64 --network none --cpus 1 --memory 512m --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/arena:/arena:ro" mech-bot
```

None of these is a match: nothing fights back. Practice scores come only from submitting.
