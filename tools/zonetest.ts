/**
 * Zone check: the bot alone on the map through a whole zone schedule (six shrinking circles with
 * random centres, as in the config), using the same rough movement rules as tools/walk.ts. Reports
 * how much health the zone takes before the final collapse, which should be none.
 *   node tools/zonetest.ts [matches]
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Brain } from "../src/bot.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const msgs = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l))
const hello = msgs[0]
hello.map.dir = join(root, "kit/arena")
const base = msgs.find((m: any) => m.type === "obs")
const C = hello.config
const M = C.mech

const stuckBy = new Map<string, number>()
const TRACE = process.argv[3] !== undefined ? 100 + Number(process.argv[3]) : -1

function tour(seed: number) {
  let s = seed >>> 0
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
  const b: any = new Brain({ ...hello, seed, entropy: 7 })
  const w = b.w
  const nav = b.nav
  const R = M.radius
  // spawn somewhere walkable inside 80% of the first circle
  let x = 0
  let y = 0
  for (;;) {
    const a = rnd() * 6.283
    const d = Math.sqrt(rnd()) * C.zone.start_radius * 0.8
    x = C.zone.start_center[0] + Math.cos(a) * d
    y = C.zone.start_center[1] + Math.sin(a) * d
    if (nav.free(x, y, 1) && nav.inMain(x, y)) break
  }
  let z = w.ground(x, y)
  let vx = 0
  let vy = 0
  let vz = 0
  let grounded = true
  let energy = M.energy
  let since = 9
  let zc = [...C.zone.start_center]
  let zr = C.zone.start_radius
  let from = { x: zc[0], y: zc[1], r: zr }
  let next = { x: zc[0], y: zc[1], r: zr }
  let zs = 0
  let ze = 0
  let dps = 0
  let phase = -1
  const advance = (t: number) => {
    phase++
    const p = C.zone.phases[phase]
    if (!p) {
      zs = ze = 1e9
      return
    }
    from = { x: zc[0], y: zc[1], r: zr }
    const a = rnd() * 6.283
    const d = Math.sqrt(rnd()) * Math.max(0, zr - p.radius)
    next = { x: zc[0] + Math.cos(a) * d, y: zc[1] + Math.sin(a) * d, r: p.radius }
    zs = t + p.hold_s
    ze = zs + p.shrink_s
    dps = p.dps
  }
  advance(0)
  const push = (px: number, py: number, feet: number): number[] | null => {
    let ax = 0
    let ay = 0
    let hit = false
    for (let ring = 1; ring <= 2; ring++)
      for (let k = 0; k < 12; k++) {
        const a = k * 0.5236
        const qx = px + (Math.cos(a) * R * ring) / 2
        const qy = py + (Math.sin(a) * R * ring) / 2
        const f = w.idx(qx, qy)
        if ((w.surf[f] - w.terr[f] > M.step_up && w.surf[f] > feet + M.step_up) || qx < w.bMinX || qx > w.bMaxX || qy < w.bMinY || qy > w.bMaxY) {
          ax -= Math.cos(a)
          ay -= Math.sin(a)
          hit = true
        }
      }
    if (!hit) return w.surface(px, py) > feet + M.step_up ? [0, 0] : null
    const l = Math.hypot(ax, ay)
    return l > 1e-6 ? [ax / l, ay / l] : [1, 0]
  }
  let lost = 0
  let lostBy: number[] = [0, 0, 0, 0, 0, 0, 0]
  let outSec = 0
  const labels = new Map<string, number>()
  let prevLabel = ""
  let prevMove = ""
  let t = 0
  // stop when the last circle starts closing to nothing: after that everyone is outside
  const endT = C.zone.phases.slice(0, 5).reduce((q: number, p: any) => q + p.hold_s + p.shrink_s, 0) + C.zone.phases[5].hold_s
  let insideUntil = 0
  const closeT = endT + C.zone.phases[5].shrink_s
  while (t < closeT) {
    const inZone = Math.hypot(x - zc[0], y - zc[1]) <= zr
    const obs = {
      ...base, tick: Math.round(t * 20), t, mechs: [], projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], events: [], drops: [], offer: null,
      self: { ...base.self, pos: [x, y, z], vel: [vx, vy, vz], grounded, energy, max_energy: M.energy, hp: 1400, max_hp: 1400, cubes: 0, in_zone: inZone, stats: { ...M } },
      zone: { center: [zc[0], zc[1]], radius: zr, next_center: [next.x, next.y], next_radius: next.r, shrink_start: zs, shrink_end: ze, dps },
    }
    const a = b.act(obs)
    labels.set(b.label, (labels.get(b.label) ?? 0) + 1)
    if (b.label === "unstuck" && prevLabel !== "unstuck") {
      stuckBy.set(prevLabel, (stuckBy.get(prevLabel) ?? 0) + 1)
      if (process.env.STUCK && stuckBy.get(prevLabel)! <= 3) console.log(`    stuck t=${t.toFixed(0)} while "${prevLabel}" at ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)} clearance ${w.clearance(x, y).toFixed(1)} roof ${(w.surface(x, y) - w.ground(x, y)).toFixed(1)} grounded ${grounded} lastMove ${prevMove} goal ${b.explore ? b.explore.x.toFixed(0) + "," + b.explore.y.toFixed(0) : "-"} path ${b.path ? b.pathI + "/" + b.path.length / 2 : "none"}`)
    }
    prevLabel = b.label
    prevMove = `${a.move}`
    if (TRACE === seed && t > Number(process.argv[4] ?? 300) && Math.round(t * 10) % Number(process.argv[5] ?? 20) === 0) {
      const f = w.idx(next.x, next.y)
      console.log(`    t=${t.toFixed(0)} pos ${x.toFixed(0)},${y.toFixed(0)},${z.toFixed(1)} ${grounded ? "gnd" : "air"} e=${energy.toFixed(0)} ${b.label.padEnd(8)} move ${a.move} b=${a.boost ? 1 : 0} j=${a.jump ? 1 : 0} | circle r=${zr.toFixed(0)} dist ${Math.hypot(x - zc[0], y - zc[1]).toFixed(0)} ${inZone ? "in " : "OUT"} | next r=${next.r} at ${next.x.toFixed(0)},${next.y.toFixed(0)} dist ${Math.hypot(x - next.x, y - next.y).toFixed(0)} roof there ${(w.surf[f] - w.terr[f]).toFixed(0)} m, clearance ${w.dist[f].toFixed(0)} m | goal ${b.zoneNow ? b.zoneNow.gx.toFixed(0) + "," + b.zoneNow.gy.toFixed(0) : "-"} urgent ${b.zoneNow?.urgent ? 1 : 0} overTop ${b.overTop ? 1 : 0} noHop ${(b.noHopUntil - t).toFixed(0)} path ${b.path ? b.path.length / 2 : 0}`)
    }
    for (let sub = 0; sub < 2; sub++) {
      const dt = 0.05
      const run = a.boost && grounded && energy > 0 && Math.hypot(a.move[0], a.move[1]) > 0.1
      const acc = (grounded ? M.ground_accel : M.air_accel) * dt
      const sp = run ? M.boost_speed : M.walk_speed
      const dvx = a.move[0] * sp - vx
      const dvy = a.move[1] * sp - vy
      const dv = Math.hypot(dvx, dvy)
      vx += dv <= acc ? dvx : (dvx / dv) * acc
      vy += dv <= acc ? dvy : (dvy / dv) * acc
      let spent = run
      if (run) energy -= M.boost_drain * dt
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
      since = spent ? 0 : since + dt
      if (since > M.energy_regen_delay) energy = Math.min(M.energy, energy + M.energy_regen * dt)
      energy = Math.max(0, energy)
      const here = push(x, y, z)
      if (here && (here[0] !== 0 || here[1] !== 0)) {
        x += here[0] * 0.6
        y += here[1] * 0.6
      } else {
        const n = push(x + vx * dt, y + vy * dt, z)
        if (!n) {
          x += vx * dt
          y += vy * dt
        } else {
          const into = -(vx * n[0] + vy * n[1])
          if (into > 0) {
            vx += n[0] * into
            vy += n[1] * into
          }
          if ((n[0] !== 0 || n[1] !== 0) && !push(x + vx * dt, y + vy * dt, z)) {
            x += vx * dt
            y += vy * dt
          } else vx = vy = 0
        }
      }
      const floor = w.surface(x, y)
      if (grounded) {
        if (floor > z - 0.3) z = floor
        else grounded = false
      } else {
        z += vz * dt
        if (z <= floor) {
          z = floor
          vz = 0
          grounded = true
        }
      }
      if (Math.hypot(x - zc[0], y - zc[1]) > zr) {
        if (t < endT) {
          lost += dps * dt
          lostBy[phase] += dps * dt
          outSec += dt
        }
      } else insideUntil = t
      t += dt
      if (t >= ze) {
        zc = [next.x, next.y]
        zr = next.r
        advance(t)
      } else if (t > zs) {
        const f = (t - zs) / (ze - zs)
        zc = [from.x + (next.x - from.x) * f, from.y + (next.y - from.y) * f]
        zr = from.r + (next.r - from.r) * f
      }
    }
  }
  return { lost, outSec, lostBy, errors: b.errors as number, labels, endDist: Math.hypot(x - zc[0], y - zc[1]), zr, lastSec: closeT - insideUntil }
}

const N = Number(process.argv[2] ?? 12)
const ONLY = process.argv[3] !== undefined ? Number(process.argv[3]) : -1
let worst = 0
let total = 0
let bad = 0
const byPhase = [0, 0, 0, 0, 0, 0, 0]
let errors = 0
const lab = new Map<string, number>()
const lastSecs: number[] = []
for (let i = 0; i < N; i++) {
  if (ONLY >= 0 && i !== ONLY) continue
  const r = tour(100 + i)
  total += r.lost
  worst = Math.max(worst, r.lost)
  if (r.lost > 50) {
    bad++
    console.log(`  match ${i}: lost ${r.lost.toFixed(0)} HP to the zone over ${r.outSec.toFixed(1)} s outside; by circle ${r.lostBy.map((v) => v.toFixed(0)).join("/")}; ended ${r.endDist.toFixed(0)} m from the centre of a ${r.zr.toFixed(0)} m circle`)
  }
  r.lostBy.forEach((v, k) => (byPhase[k] += v))
  lastSecs.push(r.lastSec)
  if (r.lastSec > 3) console.log(`  match ${i}: pushed outside ${r.lastSec.toFixed(1)} s before the end; finished ${r.endDist.toFixed(0)} m from the final point`)
  errors += r.errors
  for (const [k, v] of r.labels) lab.set(k, (lab.get(k) ?? 0) + v)
}
console.log(`${N} matches alone, up to the last circle's collapse: average ${(total / N).toFixed(0)} HP lost to the zone, worst ${worst.toFixed(0)}, matches losing over 50 HP: ${bad}; think errors ${errors}`)
lastSecs.sort((p, q) => p - q)
console.log(`  final collapse (25 m to nothing over 25 s): pushed outside ${lastSecs[lastSecs.length >> 1].toFixed(1)} s before the end on median, ${lastSecs[Math.floor(lastSecs.length * 0.9)].toFixed(1)} s at the 90th percentile, worst ${lastSecs[lastSecs.length - 1].toFixed(1)} s (0 would be standing on the final point)`)
console.log(`  lost per circle (sum): ${byPhase.slice(0, 6).map((v) => v.toFixed(0)).join(" / ")}`)
console.log(`  got stuck while: ${[...stuckBy].map(([k, v]) => `${k} ${v}`).join(", ")}`)
console.log(`  legs: ${[...lab].sort((p, q) => q[1] - p[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(", ")}`)
