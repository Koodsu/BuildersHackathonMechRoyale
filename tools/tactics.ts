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
  name: string
  dist: number
  mine: string | null
  theirs: string[]
  hp: number
  charging: boolean
  drop?: boolean
}

function run(c: Case, trials: number) {
  const labels = new Map<string, number>()
  let hiddenEnd = 0
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
    let vx = 0
    let vy = 0
    let yaw = Math.atan2(ey - y, ex - x)
    let shot = false
    for (let k = 0; k < 40; k++) {
      const t = 30 + k * 0.1
      const z = W.ground(x, y)
      const weapons: any[] = [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: C.weapons.gun }]
      weapons.push(c.mine ? { kind: c.mine, cooldown: 0, charge: 0, stats: C.weapons[c.mine] } : null)
      const obs = {
        ...base, tick: Math.round(t * 20), t, projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], events: [], offer: null,
        drops: c.drop ? [{ id: 20000, pos: [x + 30, y, W.ground(x + 30, y)], radius: 8, lands_in: 0, capture_s: 4, progress: 0, holder: null }] : [],
        self: { ...base.self, pos: [x, y, z], vel: [vx, vy, 0], aim: [yaw, 0], grounded: true, hp: 1400 * c.hp, max_hp: 1400, energy: 100, max_energy: 100, cubes: 0, in_zone: true, weapons, stats: { ...M } },
        // listed every tick, as the 5 s memory would: the bot must work out the line of sight itself
        mechs: [{ id: 9, kind: "mech", pos: [ex, ey, W.ground(ex, ey)], vel: [0, 0, 0], aim: [Math.atan2(y - ey, x - ex), 0], hp: 1400, max_hp: 1400, cubes: 0, weapons: c.theirs, charging: c.charging }],
        zone: { center: [41, -73], radius: 560, next_center: [41, -73], next_radius: 380, shrink_start: 600, shrink_end: 650, dps: 20 },
      }
      const a = b.act(obs)
      labels.set(b.label, (labels.get(b.label) ?? 0) + 1)
      if (a.fire[0] || a.fire[1]) shot = true
      yaw = a.aim[0]
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
    errors += b.errors
  }
  const top = [...labels].sort((p, q) => q[1] - p[1]).map(([k, v]) => `${k} ${Math.round((100 * v) / (done * 40))}%`).join(", ")
  console.log(`${c.name}\n    legs: ${top}\n    out of sight after 4 s: ${hiddenEnd}/${done}; pulled a trigger in ${fired}/${done}${errors ? "; ERRORS " + errors : ""}`)
}

const cases: Case[] = [
  { name: "gun vs gun at 150 m, full health (expect: fight)", dist: 150, mine: null, theirs: ["gun"], hp: 1, charging: false },
  { name: "gun vs gun+laser at 150 m (expect: ambush, out of sight)", dist: 150, mine: null, theirs: ["gun", "laser"], hp: 1, charging: false },
  { name: "gun+laser vs gun at 150 m (expect: fight)", dist: 150, mine: "laser", theirs: ["gun"], hp: 1, charging: false },
  { name: "gun+lightning vs gun+laser at 120 m (expect: ambush)", dist: 120, mine: "lightning", theirs: ["gun", "laser"], hp: 1, charging: false },
  { name: "half health, enemy with gun at 120 m (expect: heal, out of sight)", dist: 120, mine: null, theirs: ["gun"], hp: 0.5, charging: false },
  { name: "half health, enemy at 35 m (expect: fight, they are on us)", dist: 35, mine: null, theirs: ["gun"], hp: 0.5, charging: false },
  { name: "gun+laser vs gun+laser at 90 m, theirs charging on us (expect: laser duck where cover is within a step)", dist: 90, mine: "laser", theirs: ["gun", "laser"], hp: 1, charging: true },
  { name: "gun vs gun+laser at 35 m (expect: fight, a step from cover)", dist: 35, mine: null, theirs: ["gun", "laser"], hp: 1, charging: false },
]
for (const c of cases) run(c, 40)
TUNING.drops = true
run({ name: "drops on: half health, landed drop 30 m away, enemy with gun at 150 m (expect: drop or heal)", dist: 150, mine: null, theirs: ["gun"], hp: 0.5, charging: false, drop: true }, 40)
