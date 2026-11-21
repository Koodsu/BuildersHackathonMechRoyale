/**
 * Path-following check: drives only the bot's legs (no enemies, no weapons) through a rough copy of
 * the movement rules in protocol.md §7, to see that travel reaches its goal across the real map:
 * around buildings, off roofs, and over walls with jump + jets.
 *   node tools/walk.ts
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Brain } from "../src/bot.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const msgs = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = msgs[0]
hello.map.dir = join(root, "kit/arena")
const base = msgs.find((m) => m.type === "obs")
const M = hello.config.mech

function walk(sx: number, sy: number, onRoof: boolean, gx: number, gy: number, maxS: number, cubes = 0, trace = 0) {
  const b: any = new Brain({ ...hello, seed: 5 })
  const w = b.w
  const R = M.radius * (1 + 0.05 * cubes)
  let x = sx
  let y = sy
  let z = onRoof ? w.surface(x, y) : w.ground(x, y)
  let vx = 0
  let vy = 0
  let vz = 0
  let grounded = true
  let energy = M.energy
  let sinceSpend = 9
  let t = 0
  let jumps = 0
  let unstuck = 0
  let unstuck_prev = false
  let lastMove = ""
  // A wall is anything under the mech's footprint more than a step above its feet. Returns the
  // direction (unit vector) the walls push us in, or null when the spot is free.
  const push = (px: number, py: number, feet: number): number[] | null => {
    let ax = 0
    let ay = 0
    let hit = false
    for (let ring = 1; ring <= 2; ring++)
      for (let k = 0; k < 12; k++) {
        const a = (k * Math.PI) / 6
        const qx = px + (Math.cos(a) * R * ring) / 2
        const qy = py + (Math.sin(a) * R * ring) / 2
        const f = w.idx(qx, qy)
        if ((w.surf[f] - w.terr[f] > M.step_up && w.surf[f] > feet + M.step_up) || qx < w.bMinX || qx > w.bMaxX || qy < w.bMinY || qy > w.bMaxY) {
          ax -= Math.cos(a)
          ay -= Math.sin(a)
          hit = true
        }
      }
    if (!hit && w.surface(px, py) > feet + M.step_up) {
      // a terrain step or bank straight ahead: stop the move, no sideways push
      return [0, 0]
    }
    if (!hit) return null
    const l = Math.hypot(ax, ay)
    return l > 1e-6 ? [ax / l, ay / l] : [1, 0]
  }
  while (t < maxS) {
    const far = 100000
    const obs = {
      ...base, tick: Math.round(t * 20), t, mechs: [], projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], events: [], drops: [], offer: null,
      self: { ...base.self, pos: [x, y, z], vel: [vx, vy, vz], grounded, energy, max_energy: M.energy, hp: 1400, max_hp: 1400, cubes, in_zone: false, stats: { ...M, radius: R, height: M.height * (1 + 0.05 * cubes), eye_height: 8, muzzle_height: 7 } },
      // a tiny far-future circle on the goal makes "get into the zone" the only thing to do
      zone: { center: [gx, gy], radius: 3, next_center: [gx, gy], next_radius: 0, shrink_start: far, shrink_end: far + 1, dps: 0 },
    }
    const a = b.act(obs)
    if (b.label === "unstuck") {
      if (process.env.STUCK && !unstuck_prev) console.log(`    stuck at t=${t.toFixed(1)} pos ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)} clearance ${w.clearance(x, y).toFixed(1)} (R ${R}) surf ${w.surface(x, y).toFixed(1)} terr ${w.ground(x, y).toFixed(1)} grounded ${grounded} path ${b.path ? "yes i=" + b.pathI + "/" + b.path.length / 2 : "none"} goalLeft ${Math.hypot(gx - x, gy - y).toFixed(0)} lastMove ${lastMove}`)
      unstuck_prev = true
      unstuck++
    } else unstuck_prev = false
    lastMove = `${a.move} boost ${a.boost} label ${b.label}`
    if (trace && Math.round(t * 10) % Math.round(trace * 10) === 0) console.log(`    t=${t.toFixed(1)} pos ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)} ${grounded ? "ground" : "air   "} surf ${w.surface(x, y).toFixed(1)} terr ${w.ground(x, y).toFixed(1)} energy ${energy.toFixed(0)} ${b.label} move ${a.move} boost ${a.boost} jump ${a.jump} left ${Math.hypot(gx - x, gy - y).toFixed(0)}`)
    if (a.jump && grounded) jumps++
    for (let sub = 0; sub < 2; sub++) {
      const dt = 0.05
      const run = a.boost && grounded && energy > 0 && Math.hypot(a.move[0], a.move[1]) > 0.1
      const speed = run ? M.boost_speed : M.walk_speed
      const acc = (grounded ? M.ground_accel : M.air_accel) * dt
      const dvx = a.move[0] * speed - vx
      const dvy = a.move[1] * speed - vy
      const dv = Math.hypot(dvx, dvy)
      if (dv <= acc) {
        vx += dvx
        vy += dvy
      } else {
        vx += (dvx / dv) * acc
        vy += (dvy / dv) * acc
      }
      let spent = false
      if (run) {
        energy -= M.boost_drain * dt
        spent = true
      }
      if (a.jump && grounded && sub === 0) {
        vz = M.jump_speed
        grounded = false
      }
      if (!grounded) {
        if (a.boost && energy > 0) {
          vz = Math.min(M.max_rise_speed, vz + M.jet_accel * dt)
          energy -= M.jet_drain * dt
          spent = true
        }
        vz -= M.gravity * dt
      }
      sinceSpend = spent ? 0 : sinceSpend + dt
      if (sinceSpend > M.energy_regen_delay) energy = Math.min(M.energy, energy + M.energy_regen * dt)
      energy = Math.max(0, energy)
      // horizontal: full move, else keep only the part along the wall; if we overlap a wall
      // (came down beside one), be slid out of it like the server does
      const here = push(x, y, z)
      if (here && (here[0] !== 0 || here[1] !== 0)) {
        x += here[0] * 0.6
        y += here[1] * 0.6
      } else {
        const nx = x + vx * dt
        const ny = y + vy * dt
        const n = push(nx, ny, z)
        if (!n) {
          x = nx
          y = ny
        } else {
          const into = -(vx * n[0] + vy * n[1])
          if (into > 0) {
            vx += n[0] * into
            vy += n[1] * into
          }
          if (!push(x + vx * dt, y + vy * dt, z)) {
            x += vx * dt
            y += vy * dt
          } else {
            vx = 0
            vy = 0
          }
        }
      }
      const floor = w.surface(x, y)
      if (grounded) {
        if (floor > z - 0.3) z = floor // level ground or a step up
        else grounded = false // walked off an edge
      } else {
        z += vz * dt
        if (z <= floor) {
          z = floor
          vz = 0
          grounded = true
        }
      }
    }
    t += 0.1
    if (Math.hypot(gx - x, gy - y) < 3.5 && grounded) break
  }
  const left = Math.hypot(gx - x, gy - y)
  const straight = Math.hypot(gx - sx, gy - sy)
  return { ok: left < 3.5, t, left, straight, jumps, unstuck, errors: b.errors as number, args: [sx, sy, onRoof, gx, gy, maxS, cubes] as const }
}

const b0: any = new Brain({ ...hello, seed: 1 })
const nav = b0.nav
const w = b0.w
let seed = 4242
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
const cells: number[] = []
for (let c = 0; c < nav.walk.length; c++) if (nav.comp[c] === nav.mainComp) cells.push(c)
const roofs: number[][] = []
while (roofs.length < 400) {
  const x = w.bMinX + rnd() * (w.bMaxX - w.bMinX)
  const y = w.bMinY + rnd() * (w.bMaxY - w.bMinY)
  const h = w.surface(x, y) - w.ground(x, y)
  // a spot a mech could actually stand on: nothing taller within its footprint
  let clear = h > 4 && h < 45 && w.slabBase[w.idx(x, y)] === Infinity
  for (let k = 0; clear && k < 12; k++) if (w.surface(x + Math.cos(k * 0.5236) * 3.2, y + Math.sin(k * 0.5236) * 3.2) > w.surface(x, y) + 1) clear = false
  if (clear) roofs.push([x, y])
}

const report = (name: string, rs: ReturnType<typeof walk>[]) => {
  const ok = rs.filter((r) => r.ok)
  const ratio = ok.map((r) => (r.t * 11.7) / Math.max(20, r.straight)).sort((a, b) => a - b)
  const fails = rs.filter((r) => !r.ok)
  console.log(`${name}: reached ${ok.length}/${rs.length}; time vs a straight walk: median ${ratio.length ? ratio[ratio.length >> 1].toFixed(2) : "-"}x, worst ${ratio.length ? ratio[ratio.length - 1].toFixed(2) : "-"}x; hops ${rs.reduce((s, r) => s + r.jumps, 0)}, unstuck ticks ${rs.reduce((s, r) => s + r.unstuck, 0)}, think errors ${rs.reduce((s, r) => s + r.errors, 0)}` + (fails.length ? `; failures left ${fails.slice(0, 5).map((f) => f.left.toFixed(0) + " m").join(", ")} from the goal` : ""))
}

const N = Number(process.argv[2] ?? 60)
const TRACE = Number(process.argv[3] ?? 0)
const retrace = (rs: ReturnType<typeof walk>[]) => {
  if (!TRACE) return
  const f = rs.find((r) => !r.ok)
  if (!f) return
  console.log(`  trace of a failure: start ${f.args[0].toFixed(0)},${f.args[1].toFixed(0)} goal ${f.args[3].toFixed(0)},${f.args[4].toFixed(0)}`)
  walk(f.args[0], f.args[1], f.args[2], f.args[3], f.args[4], Math.min(f.args[5], 90), f.args[6], TRACE)
}
const ground: ReturnType<typeof walk>[] = []
for (let k = 0; k < N; k++) {
  const a = cells[Math.floor(rnd() * cells.length)]
  const c = cells[Math.floor(rnd() * cells.length)]
  ground.push(walk(nav.cx(a), nav.cy(a), false, nav.cx(c), nav.cy(c), 240))
}
report("ground to ground", ground)
retrace(ground)

const big: ReturnType<typeof walk>[] = []
for (let k = 0; k < N / 2; k++) {
  const a = cells[Math.floor(rnd() * cells.length)]
  const c = cells[Math.floor(rnd() * cells.length)]
  big.push(walk(nav.cx(a), nav.cy(a), false, nav.cx(c), nav.cy(c), 300, 10))
}
report("ground to ground at 10 cubes", big)

// start and goal taken from the ground a mech of that size can actually reach
nav.rebuild(M.radius * (1 + 0.05 * 21))
const bigCells: number[] = []
for (let c = 0; c < nav.walk.length; c++) if (nav.comp[c] === nav.mainComp) bigCells.push(c)
const bigPairs: number[][] = []
for (let k = 0; k < N / 2; k++) {
  const a = bigCells[Math.floor(rnd() * bigCells.length)]
  const c = bigCells[Math.floor(rnd() * bigCells.length)]
  bigPairs.push([nav.cx(a), nav.cy(a), nav.cx(c), nav.cy(c)])
}
console.log(`  (at 21 cubes ${Math.round((100 * bigCells.length) / cells.length)}% of the normally walkable ground is still reachable)`)
nav.rebuild(M.radius)
const huge: ReturnType<typeof walk>[] = []
for (const q of bigPairs) huge.push(walk(q[0], q[1], false, q[2], q[3], 320, 21))
report("ground to ground at 21 cubes (twice the size)", huge)
if (TRACE) {
  // the slowest of them, to see where the time went
  const slow = [...huge].sort((a, b) => (b.t * 11.7) / Math.max(20, b.straight) - (a.t * 11.7) / Math.max(20, a.straight))[0]
  console.log(`  slowest at 21 cubes: start ${slow.args[0].toFixed(0)},${slow.args[1].toFixed(0)} goal ${slow.args[3].toFixed(0)},${slow.args[4].toFixed(0)} took ${slow.t.toFixed(0)} s for ${slow.straight.toFixed(0)} m`)
  walk(slow.args[0], slow.args[1], slow.args[2], slow.args[3], slow.args[4], Math.min(slow.args[5], 120), slow.args[6], TRACE)
}

const off: ReturnType<typeof walk>[] = []
for (let k = 0; k < N / 2; k++) {
  const [x, y] = roofs[k]
  const c = cells[Math.floor(rnd() * cells.length)]
  off.push(walk(x, y, true, nav.cx(c), nav.cy(c), 260))
}
report("roof to ground", off)
retrace(off)

const st = JSON.parse(readFileSync(join(root, "kit/arena/v2/world.json"), "utf8")).stadium.center
const out: ReturnType<typeof walk>[] = []
const inn: ReturnType<typeof walk>[] = []
for (let k = 0; k < N / 4; k++) {
  const c = cells[Math.floor(rnd() * cells.length)]
  const fx = st[0] + (rnd() - 0.5) * 60
  const fy = st[1] + (rnd() - 0.5) * 80
  out.push(walk(fx, fy, false, nav.cx(c), nav.cy(c), 300))
  inn.push(walk(nav.cx(c), nav.cy(c), false, fx, fy, 300))
}
report("stadium field to outside", out)
retrace(out)
report("outside to stadium field", inn)
retrace(inn)

const up: ReturnType<typeof walk>[] = []
for (let k = 0; k < N / 4; k++) {
  const [x, y] = roofs[100 + k]
  const c = nav.snap(x, y, 60)
  if (c >= 0) up.push(walk(nav.cx(c), nav.cy(c), false, x, y, 120))
}
report("ground to a nearby roof", up)
