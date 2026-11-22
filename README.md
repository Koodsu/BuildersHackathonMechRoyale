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
node tools/aimtest.ts            # shots land on a moving target (gun, laser with and without the faster-capacitor upgrade, mortar)
node tools/mortartest.ts         # the mortar's tube angle flown as a shell: where it comes down
node tools/dodgetest.ts          # how often a gun hits the bot's fight movement (pass a directory to test an older build)
node tools/bullettest.ts         # guns that aim like house bots fire at the bot, which is shown the bullets: how many hit, with and without stepping out of their lines (DODGE=0)
node tools/tactics.ts            # stances: stand off and give ground, heal first, duck a charging laser, free-for-all
node tools/kitetest.ts           # dummies walk at the bot on the real map: does the retreat hold its range and a line of fire (STANDOFF=0 for the old movement; HEALTH=1 keeps our own health, MEND=0 then turns off breaking off to mend, DROP=1 lands a supply drop near by, NANITES / PLATING / ARMOR=n give us that many of those upgrades, BULLETS=1 has their guns fire real bullets that the bot can see and dodge)
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

**Opening (first 26 s, or until our first kill).** The kind of match is not known yet: collect a second weapon and cubes, fire at nobody who is not on us, and keep away from mechs that are close or facing us. Someone who fires at us, or walks at us with guns on us, is fought the long-range way at once.

**Build 11 (2026-11-22; switch `lateHide` in `TUNING`).** On build 8 (rolls 5.28, 5.04, 5.05; build 10's change is out). A different idea from the fight changes before it: the score is house bots dead before we are, so once the next circle is 140 m or smaller (195 s into a practice match) the bot stops trading with the whole squad and plays survive-only, to outlast the ones the closing circle and the fight have already hurt.

**Build 10 (2026-11-22; switch `stay` in `TUNING`).** On build 8 (5.28 and 5.04; build 9's changes are out). The two builds that gained both removed reasons to stop shooting, so this removes the rest in the mid-range fight: no leaving for cover to reload, no ducking from any charging beam, and no hide behind a building when hit by someone unseen (the bot keeps sidestepping and looking for them).

**Build 9 (2026-11-22; switches `focus`, `dropPro`, `ring4` in `TUNING`; scored 4.92 against build 8's 5.28, so all three are off again).** On build 8 (5.28). The report's table was used up, so this block follows its reasoning instead: kills must come faster and health must come in. Fire stays on one target until it dies (a nearly dead one we can shoot comes first, the current one is kept, and it is closed on from 30% of our own health up unless another mech is within 60 m); a supply drop we reach well before any of them is run for from 70% health in the mid-range fight too; and fight spots are searched on a fourth ring at 24 m for a place only the target can see.

**Build 8 (2026-11-22; switches `plate`, `duel`, `search` in `TUNING`).** On build 7, which scored 5.16 against about 4.4 for everything before it. Three more blocks, scored together: plating and armour are taken ahead of self-repair upgrades, since a committed fight leaves no quiet seconds to mend in; with a laser in hand the bot no longer ducks from its own target's charging beam (it still ducks from anyone else's, and to reload); and with the second slot still empty after 20 s and no weapon known, it walks to the ground it has seen least of instead of to random points.

**Build 7 (2026-11-22; switches `commit`, `noGlance`, `iso`, `fightLoot`, `ffaFrom` in `TUNING`).** On build 6's mid-range fight. Three probes that stop firing after one, two and four kills showed a first and a second kill in every practice match, so the opening is sound and what is missing is how we stand when several hunters come at once. Four blocks, scored together because one practice score cannot show a gain under about half a point:

- Committed: the fight is not left to mend, to heal behind a wall or to wait in ambush, and there is no resting between fights. The step behind cover while both weapons reload stays, and so does ducking a charging laser.
- The torso stays on the target when something we cannot see hits us.
- Fight spots are scored against every mech seen in the last 8 s within 170 m (before: the four nearest we track), and searched on a third ring 16 m out.
- A second weapon within 60 m, or a cube within 35 m, is walked onto in mid-fight with the torso still firing.

Also: the mortar aim is given up after 0.7 s on a target that will not line up, so the gun is not kept silent; and a match played after the practice cutoff is played survive-only from the first tick (`ffaFrom`).

**Build 6 (2026-11-22; switches `mortar`, `dodgeBoost`, `farmR`, `idleStay` in `TUNING`).** Four changes on top of build 5, each one something other teams' published notes report as measured on the practice scorer; none has a score of ours yet. Two commits carry them: one with build 5's mid-range fight (`rush: 0`), one with probe Q's fight (`rush: 25`, close to 25 m and never break off: our best score so far, 4.60).

- The laser is let go when it is full, also after the faster-capacitor upgrade. The charge we are shown is rounded to two decimals (0.56 for a full 0.5625 s), which the old comparison never passed, so the beam stayed held until it fired by itself two seconds later, at half walking speed all the while. `tools/aimtest.ts` now shows it: 5 beams in 20 s before, 9 after.
- A mortar is taken when no laser or lightning gun is known (within 80 m), and fired: the flat arc, aimed 4 m beyond the mech and led by most of its walk, so the shell passes through it on the way down (`lob()`, `tools/mortartest.ts`). It is swapped for a laser or a lightning gun when one is underfoot.
- A bullet that a sidestep at a walk does not clear is sidestepped on the jets.
- No walks of more than 120 m for crates against house bots (220 m before), and with a laser in hand and nothing known to fetch or go after, the bot stays where it is instead of wandering the circle.

**Build 5 (the fight these build on: `pro: true`, `standoff: false`, `brawl: false`, `wary: 0`, `fixedSeed: true`).** Practice scores so far: build 2 (mid-range, from cover) 4.42, build 3b (long range) 4.00, build 4 (stand at 85 m) 3.44. Build 5 goes back to build 2's mid-range cover fighting and adds what good battle-royale players do around a fight:

- take the fights we are favoured in (health times firepower, 1.6 to 1 or better) and whoever comes for us, from cover, ducking behind it while reloading or while a laser charges on us;
- finish them: a mech under 40% health that backs off is closed on to inside 40 m (28 m with a lightning gun) and followed round buildings, since it mends at 45 HP/s once left alone;
- reset between fights: with nobody in sight and under 80% health, stand quiet and mend, fetching only cubes and weapons within 80 m (a cube is 4% of our health back at once); a supply drop is taken from 85% health down;
- no idle time while whole: at 80% or more with both weapons, after the first 25 s, go to where a mech was last seen;
- never trade with two at once while hurt: under 60% health with two of them holding a line on us inside 150 m, break their lines and mend;
- free-for-all mode (the final) is unchanged: stay unseen, fight only an attacker or a nearly dead mech.

Random choices now come from the match's seed alone (`fixedSeed`), so on the scorer's fixed matches one build should score nearly the same every time and two builds can be compared; turn it off to make every submission a fresh draw. The image is back to the plain `node` command builds 1 to 3b were scored with. To score build 5's additions on their own, submit the same commit with `pro: false` (build 2's play on the current code). None of this has been scored yet.

**Build 4 (`brawl: true`, `wary: 0`; scored 3.44).** The long-range game below scored 4.00 in practice against 4.42 for the mid-range build before it, so build 4 set `brawl: true` and `wary: 0`: no cautious opening (fire from the first second), close to about 85 m and stand still to shoot while the range is within 30 m of that, lightning gun inside 60 m, no backing off. That is how the bots tied at 6.19 on the practice board play on the match feed (37 showdowns: median gun range 84 m, standing 40% of the time, first shot 4 s in). The long-range description that follows is what `brawl: false, wary: 26` gives. Free-for-all mode is unchanged. The image now runs Node on one thread (`--single-threaded`), since the match gives one CPU.

**Against house bots (practice).** Nobody but us kills a house bot, so a match with no other deaths is this one. The squad shares vision and sends its hunters weakest first (one early, more as we thin them out, all of them late), so the score is the number of kills made before the whole squad arrives. Measured on the public match feed (`wss://watch.joinbuilders.org/live`), house bots land every gun shot inside 40 m, 57% at 40-80 m, 23% at 80-120 m, 18% at 120-160 m and 9% beyond; their lasers land 1 beam in 39 past 120 m; and in their own matches most of their kills are made by running in with the 45 m lightning gun. Our aim leads its target properly, so the plan is distance:

- fight from about 170 m (`STANDOFF` in `src/bot.ts`; 100 m only against the one early hunter while neither side has a laser), opening fire on anything in sight, standing still to shoot when the range is right;
- step out of the line of every bullet in view: a bullet takes two thirds of a second to cross that distance and the bot is told where each one is, so at 170 m about one shot in ten would hit a standing mech and one in fifty hits a stepping one (measured in `tools/bullettest.ts`; with our answers taking hold a tenth of a second later than assumed, one in twenty-five);
- when one of them gets inside that range, retreat by a planned route to a spot far from all of them that keeps a line of fire and room inside the circle, with the jets if one is still gaining;
- break off at half health and leave for somewhere far from all of them to mend (45 HP/s after 5 quiet seconds), or, from 70% down, run for a supply drop that we reach well before any of them: four seconds alone in its ring are a full repair, and once in the ring the bot stays in it until it has it;
- with nothing in sight, go to where a mech was last seen or gunfire was heard; failing that, hold an open look-out with long lines of sight and move to another every 20 s;
- below two thirds of health, mend before starting anything new: no shots at bystanders and no seeking (repair needs 5 s of neither taking nor dealing damage), walking meanwhile to an open look-out rather than hiding in place, or to a landed supply drop; crates wait until 90%;
- the kills have to come in the first three minutes: the circle is 240 m in radius by 195 s and 140 m by 265 s, and after that there is no room to stand off in;
- upgrades are picked by what they add to the damage dealt before going down: laser damage and the bigger magazine first (about +11% each), then repair nanites, plating, gun damage; a second nanites ahead of everything (repair then starts after two quiet seconds, which hunters do leave, and it was worth +12 to +17% in the walk-at-us check with our health kept);
- stop collecting cubes at 10: the health and damage bonuses stop there, and every cube makes the mech 5% wider, which at long range is 5% more hits taken. A laser replaces a lightning gun when one is within reach.

Switches for comparison scores are in `TUNING` at the top of `src/bot.ts`: `standoff` (the long-range game; off gives the older mid-range movement), `brawl` (close in and out-shoot them, the way the bots tied near the top of the practice board play; on by default since build 4), `seek`, `wary` (length of the opening in seconds), `dropRun` and `dropAt` (the run for a drop when hurt, and the share of health it starts at), `dodge` (stepping out of bullets' lines), `look` (where the torso looks while both weapons are down: to the sides, right round, or nowhere), and `mend` (the share of health below which the bot breaks off to mend; 0 fights on. With our own health kept in the walk-at-us check, 0.5, 0.3 and 0 came out within a few percent of each other: hunters that keep following leave almost no quiet time to mend in).

**Free-for-all (the final).** Detected when a mech dies that we did not kill, or when we watch others hitting each other early. Other teams' lasers land about 72% at any range and their guns 40% at 120-160 m, so there the plan is not to be seen: keep away from everyone, fight only an attacker or a nearly dead mech, wait in a walled-in spot, and take supply drops only when hurt or still short of cubes.

In both: the zone comes first (routes that stay inside the circle, hops over low buildings and the map's bridges when walking round would leave it).
