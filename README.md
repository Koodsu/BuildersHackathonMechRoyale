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
node tools/zonetest.ts 80        # alone through whole zone schedules: health lost to the zone, and the final collapse
node tools/loottest.ts 24        # alone with loot scattered: time to a second weapon, cubes gathered (DROPS=1 adds supply drops)
node tools/aimtest.ts            # shots land on a moving target
node tools/dodgetest.ts          # how often a gun hits the bot's fight movement (pass a directory to test an older build)
node tools/tactics.ts            # stances: stand off and give ground, heal first, duck a charging laser, free-for-all
node tools/kitetest.ts           # dummies walk at the bot on the real map: does the retreat hold its range and a line of fire (STANDOFF=0 for the old movement)
node tools/replay.ts             # no crashes, invalid actions or slow ticks on recorded and random input
python3 kit/check/check.py -- node main.ts
```

The scorer's own check, on the image it will build:

```sh
docker build --platform linux/amd64 -t mech-bot .
cd kit && python3 check/check.py --map-dir /arena -- docker run --rm -i --platform linux/amd64 --network none --cpus 1 --memory 512m --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/arena:/arena:ro" mech-bot
```

None of these is a match: nothing fights back. Practice scores come only from submitting.

## How it plays

The bot cannot see who its opponents are, so it works out which kind of match it is in from what happens.

**Opening (first 22 s, or until our first kill).** Played as if it were a free-for-all: collect a second weapon and cubes and stay out of sight. Someone who fires at us, or walks at us with guns on us, is fought the long-range way.

**Against house bots (practice).** Nobody but us kills a house bot, so a match with no other deaths is this one. The squad shares vision and sends its hunters weakest first (one early, more as we thin them out, all of them late), so the score is the number of kills made before the whole squad arrives. Measured on the public match feed (`wss://watch.joinbuilders.org/live`), house bots land every gun shot inside 40 m, 57% at 40-80 m, 23% at 80-120 m, 18% at 120-160 m and 9% beyond; their lasers land 1 beam in 39 past 120 m; and in their own matches most of their kills are made by running in with the 45 m lightning gun. Our aim leads its target properly, so the plan is distance:

- fight from about 170 m (`STANDOFF` in `src/bot.ts`; 140 m against a lone early hunter, the squad's weakest), opening fire on anything in sight, standing still to shoot when the range is right;
- when one of them gets inside that range, retreat by a planned route to a spot far from all of them that keeps a line of fire and room inside the circle, with the jets if one is still gaining;
- break off at half health and leave for somewhere far from all of them to mend (45 HP/s after 5 quiet seconds);
- with nothing in sight, go to where a mech was last seen or gunfire was heard; failing that, hold an open look-out with long lines of sight and move to another every 20 s;
- stop collecting cubes at 10: the health and damage bonuses stop there, and every cube makes the mech 5% wider, which at long range is 5% more hits taken. A laser replaces a lightning gun when one is within reach.

**Free-for-all (the final).** Detected when a mech dies that we did not kill, or when we watch others hitting each other early. Other teams' lasers land about 72% at any range and their guns 40% at 120-160 m, so there the plan is not to be seen: keep away from everyone, fight only an attacker or a nearly dead mech, wait in a walled-in spot, and take supply drops only when hurt or still short of cubes.

In both: the zone comes first (routes that stay inside the circle, hops over low buildings and the map's bridges when walking round would leave it).
