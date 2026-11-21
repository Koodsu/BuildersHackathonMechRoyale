/**
 * Stance check: puts the bot beside a building with one enemy in view and reports what its legs
 * decide and whether it ends up out of the enemy's sight. The enemy stands still and never shoots.
 *   node tools/tactics.ts
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Brain, TUNING } from "../src/bot.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const msgs = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l))
const hello = msgs[0]
hello.map.dir = join(root, "kit/arena")
const base = msgs.find((m: any) => m.type === "obs")
const C = hello.config
const M = C.mech

let seed = 2024
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
const probe: any = new Brain({ ...hello, seed: 1 })
const W = probe.w
const NAV = probe.nav

/** A spot 6-9 m from a wall, and an enemy position `dist` away that can see it. */
function setup(dist: number): number[] | null {
  for (let tries = 0; tries < 4000; tries++) {
    const x = W.bMinX + 40 + rnd() * (W.bMaxX - W.bMinX - 80)
    const y = W.bMinY + 40 + rnd() * (W.bMaxY - W.bMinY - 80)
    const c = W.clearance(x, y)
    if (c < 6 || c > 9 || !NAV.inMain(x, y) || !NAV.free(x, y, 1)) continue
    const a = rnd() * 6.283
    const ex = x + Math.cos(a) * dist
    const ey = y + Math.sin(a) * dist
    if (!NAV.inMain(ex, ey) || !NAV.free(ex, ey, 1)) continue
    if (!W.los(ex, ey, W.ground(ex, ey) + 7, x, y, W.ground(x, y) + 4.5)) continue
    return [x, y, ex, ey]
  }
  return null
}

interface Case {
  t0?: number // match time the scenario starts at (default 30 s, after the cautious opening)
  away?: boolean // the other mech is not facing us
  walking?: boolean // the other mech is walking at us
  theirHp?: number // the other mech's health as a fraction (default full)
  fleeing?: boolean // the other mech is walking away from us
  name: string
  dist: number
  mine: string | null
  theirs: string[]
  hp: number
  charging: boolean
  drop?: boolean
  /** Put the bot in free-for-all mode before the scenario starts. */
  ffa?: boolean
  /** The enemy's shots are landing on us (one damage event a second). */
  attacking?: boolean
  /** Laser fire from this far away, from an enemy that is never listed (beyond our sight). */
  sniper?: number
}

function run(c: Case, trials: number) {
  const labels = new Map<string, number>()
  let hiddenEnd = 0
  let rangeEnd = 0
  let fired = 0
  let done = 0
  let errors = 0
  for (let n = 0; n < trials; n++) {
    const s = setup(c.dist)
    if (!s) continue
    done++
    let [x, y] = s
    const [, , ex, ey] = s
    const b: any = new Brain({ ...hello, seed: n })
    if (c.ffa) b.ffa = true
    let vx = 0
    let vy = 0
    let yaw = Math.atan2(ey - y, ex - x)
    let pitch = 0
    let shot = false
    for (let k = 0; k < 40; k++) {
      const t = (c.t0 ?? 30) + k * 0.1
      const z = W.ground(x, y)
      const weapons: any[] = [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: C.weapons.gun }]
      weapons.push(c.mine ? { kind: c.mine, cooldown: 0, charge: 0, stats: C.weapons[c.mine] } : null)
      const obs = {
        ...base, tick: Math.round(t * 20), t, projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], offer: null,
        events: (c.attacking || c.sniper) && k % 10 === 0 ? [{ type: "damaged", amount: c.sniper ? 315 : 45, weapon: c.sniper ? "laser" : "gun", bearing: Math.atan2(ey - y, ex - x), by: 9 }] : [],
        drops: c.drop ? [{ id: 20000, pos: [x + 30, y, W.ground(x + 30, y)], radius: 8, lands_in: 0, capture_s: 4, progress: 0, holder: null }] : [],
        self: { ...base.self, pos: [x, y, z], vel: [vx, vy, 0], aim: [yaw, pitch], grounded: true, hp: 1400 * c.hp, max_hp: 1400, energy: 100, max_energy: 100, cubes: 0, in_zone: true, weapons, stats: { ...M } },
        // listed every tick, as the 5 s memory would: the bot must work out the line of sight itself
        mechs: c.sniper ? [] : [{ id: 9, kind: "mech", pos: [ex, ey, W.ground(ex, ey)], vel: c.walking ? [((x - ex) / Math.hypot(x - ex, y - ey)) * 8, ((y - ey) / Math.hypot(x - ex, y - ey)) * 8, 0] : c.fleeing ? [((ex - x) / Math.hypot(x - ex, y - ey)) * 6, ((ey - y) / Math.hypot(x - ex, y - ey)) * 6, 0] : [0, 0, 0], aim: [Math.atan2(y - ey, x - ex) + (c.away ? 2 : 0), 0], hp: 1400 * (c.theirHp ?? 1), max_hp: 1400, cubes: 0, weapons: c.theirs, charging: c.charging }],
        zone: { center: [41, -73], radius: 560, next_center: [41, -73], next_radius: 380, shrink_start: 600, shrink_end: 650, dps: 20 },
      }
      const a = b.act(obs)
      if (process.env.TRACE && c.name.includes(process.env.TRACE) && n === 0 && k % 5 === 0) console.log(`      k=${k} pos ${x.toFixed(0)},${y.toFixed(0)} d ${Math.hypot(ex - x, ey - y).toFixed(0)} label ${b.label} move ${a.move} boost ${a.boost} fire ${a.fire} finishing ${b.finishing} rangeNow ${b.rangeNow} kiteGain ${b.kiteGain?.toFixed?.(1)}`)
      labels.set(b.label, (labels.get(b.label) ?? 0) + 1)
      if (a.fire[0] || a.fire[1]) shot = true
      yaw = a.aim[0]
      pitch = a.aim[1]
      for (let sub = 0; sub < 2; sub++) {
        const acc = M.ground_accel * 0.05
        const dvx = a.move[0] * M.walk_speed - vx
        const dvy = a.move[1] * M.walk_speed - vy
        const dv = Math.hypot(dvx, dvy)
        vx += dv <= acc ? dvx : (dvx / dv) * acc
        vy += dv <= acc ? dvy : (dvy / dv) * acc
        if (NAV.free(x + vx * 0.05, y + vy * 0.05, -0.5)) {
          x += vx * 0.05
          y += vy * 0.05
        } else {
          vx = 0
          vy = 0
        }
      }
    }
    const z = W.ground(x, y)
    const ez = W.ground(ex, ey)
    if (!W.los(ex, ey, ez + 7, x, y, z + 4.5) && !W.los(ex, ey, ez + 7, x, y, z + 8.3)) hiddenEnd++
    if (shot) fired++
    rangeEnd += Math.hypot(ex - x, ey - y)
    errors += b.errors
  }
  const top = [...labels].sort((p, q) => q[1] - p[1]).map(([k, v]) => `${k} ${Math.round((100 * v) / (done * 40))}%`).join(", ")
  console.log(`${c.name}\n    legs: ${top}\n    out of sight after 4 s: ${hiddenEnd}/${done}; range after 4 s: ${done ? Math.round(rangeEnd / done) : "-"} m; pulled a trigger in ${fired}/${done}${errors ? "; ERRORS " + errors : ""}`)
}

const cases: Case[] = [
  { name: "gun vs gun at 150 m, full health (expect: fight)", dist: 150, mine: null, theirs: ["gun"], hp: 1, charging: false },
  { name: "gun vs gun+laser at 150 m (expect: fight: a house bot's laser lands 1 beam in 20 from there)", dist: 150, mine: null, theirs: ["gun", "laser"], hp: 1, charging: false },
  { name: "gun+laser vs gun at 150 m (expect: fight)", dist: 150, mine: "laser", theirs: ["gun"], hp: 1, charging: false },
  { name: "gun+laser vs gun+laser at 190 m, not attacked (expect: fight, trigger pulled: free shots)", dist: 190, mine: "laser", theirs: ["gun", "laser"], hp: 1, charging: false },
  { name: "gun+laser vs gun+laser at 70 m (expect: fight, range opening)", dist: 70, mine: "laser", theirs: ["gun", "laser"], hp: 1, charging: false },
  { name: "gun+lightning vs gun+laser at 120 m (expect: fight, range held or opening)", dist: 120, mine: "lightning", theirs: ["gun", "laser"], hp: 1, charging: false },
  { name: "60% health, enemy with gun at 120 m (expect: fight on: half health is the line)", dist: 120, mine: "laser", theirs: ["gun"], hp: 0.6, charging: false },
  { name: "45% health, enemy with gun at 120 m (expect: heal or away, out of sight or range opening)", dist: 120, mine: null, theirs: ["gun"], hp: 0.45, charging: false },
  { name: "gun+laser vs a gun at 150 m that is down to 25% health (expect: fight, closing in to finish)", dist: 150, mine: "laser", theirs: ["gun"], hp: 1, charging: false, theirHp: 0.25, fleeing: true },
  { name: "half health, enemy at 35 m (expect: fight, they are on us)", dist: 35, mine: null, theirs: ["gun"], hp: 0.5, charging: false },
  { name: "gun+laser vs gun+laser at 90 m, theirs charging on us (expect: laser duck where cover is within a step)", dist: 90, mine: "laser", theirs: ["gun", "laser"], hp: 1, charging: true },
  { name: "gun+laser vs gun+laser at 150 m, theirs charging on us (expect: fight, no duck)", dist: 150, mine: "laser", theirs: ["gun", "laser"], hp: 1, charging: true },
  { name: "gun vs gun+laser at 35 m (expect: fight, a step from cover)", dist: 35, mine: null, theirs: ["gun", "laser"], hp: 1, charging: false },
]
const TRIALS = Number(process.env.TRIALS ?? 40)
for (const c of cases) run(c, TRIALS)
console.log("--- an attacker beyond our sight")
run({ name: "laser hits from 200 m, shooter never visible (expect: unseen, out of its line)", dist: 200, mine: null, theirs: ["gun", "laser"], hp: 0.8, charging: false, sniper: 200 }, TRIALS)
console.log("--- the opening, before the kind of match is known (5 s in)")
run({ name: "mech at 150 m, not facing us, standing (expect: carry on looting, no trigger pulled)", dist: 150, mine: null, theirs: ["gun"], hp: 1, charging: false, t0: 5, away: true }, TRIALS)
run({ name: "mech at 90 m, not facing us (expect: evade, no trigger pulled)", dist: 90, mine: null, theirs: ["gun"], hp: 1, charging: false, t0: 5, away: true }, TRIALS)
run({ name: "mech at 150 m walking at us, guns on us (expect: fight from range)", dist: 150, mine: null, theirs: ["gun"], hp: 1, charging: false, t0: 5, walking: true }, TRIALS)
run({ name: "shot at from 120 m (expect: fight from range)", dist: 120, mine: null, theirs: ["gun"], hp: 1, charging: false, t0: 5, attacking: true }, TRIALS)
console.log("--- free-for-all mode")
run({ name: "passer-by with a gun at 150 m, not shooting (expect: evade, no trigger pulled)", dist: 150, mine: "laser", theirs: ["gun"], hp: 1, charging: false, ffa: true }, TRIALS)
run({ name: "shot at from 150 m (expect: evade, shooting back while leaving)", dist: 150, mine: "laser", theirs: ["gun"], hp: 1, charging: false, ffa: true, attacking: true }, TRIALS)
run({ name: "shot at from 40 m (expect: fight)", dist: 40, mine: "laser", theirs: ["gun"], hp: 1, charging: false, ffa: true, attacking: true }, TRIALS)
TUNING.drops = true
run({ name: "drops on: half health, landed drop 30 m away, enemy with gun at 150 m (expect: drop or heal)", dist: 150, mine: null, theirs: ["gun"], hp: 0.5, charging: false, drop: true }, TRIALS)
