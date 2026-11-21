/**
 * Aiming check: one target crossing in the open, our torso slewing at the real turn rate, and every
 * shot the bot takes traced to see whether it would hit. Tests the lead, the fire gate and the laser
 * hold/release logic end to end (sign conventions included). Nothing fights back.
 *   node tools/aimtest.ts
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
const C = hello.config
const M = C.mech
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

function run(dist: number, speed: number, second: string | null, weave: boolean, seconds = 20) {
  const b: any = new Brain({ ...hello, seed: 3 })
  const w = b.w
  let x = OPEN[0]
  let y = OPEN[1]
  let vx = 0
  let vy = 0
  let yaw = 0
  let pitch = 0
  let cmd = [0, 0]
  const bearing = OPEN[2]
  let tx = x + Math.cos(bearing) * dist
  let ty = y + Math.sin(bearing) * dist
  let tdir = bearing + Math.PI / 2
  let ammo = C.weapons.gun.mag
  let gunCd = 0
  let reload = 0
  let charge = 0
  let lasCd = 0
  let held = false
  let shots = 0
  let hits = 0
  let beams = 0
  let beamHits = 0
  let arcs = 0
  let t = 0
  const bullets: { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number }[] = []
  for (let k = 0; k < seconds * 10; k++) {
    const z = w.ground(x, y)
    const tz = w.ground(tx, ty)
    const tvx = Math.cos(tdir) * speed
    const tvy = Math.sin(tdir) * speed
    const weapons: any[] = [{ kind: "gun", cooldown: Math.max(0, gunCd), ammo, reload: Math.max(0, reload), stats: C.weapons.gun }]
    if (second === "laser") weapons.push({ kind: "laser", cooldown: Math.max(0, lasCd), charge, stats: C.weapons.laser })
    else if (second === "lightning") weapons.push({ kind: "lightning", cooldown: 0, stats: C.weapons.lightning })
    else weapons.push(null)
    const obs = {
      ...base, tick: k * 2, t, projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], events: [], drops: [], offer: null,
      self: { ...base.self, pos: [x, y, z], vel: [vx, vy, 0], aim: [yaw, pitch], grounded: true, hp: 1400, max_hp: 1400, energy: 100, max_energy: 100, cubes: 0, in_zone: true, weapons, stats: { ...M } },
      mechs: [{ id: 9, kind: "mech", pos: [tx, ty, tz], vel: [tvx, tvy, 0], aim: [bearing + Math.PI, 0], hp: 1400, max_hp: 1400, cubes: 0, weapons: ["gun"], charging: false }],
      zone: { center: [41, -73], radius: 560, next_center: [41, -73], next_radius: 380, shrink_start: 600, shrink_end: 650, dps: 20 },
    }
    const a = b.act(obs)
    cmd = a.aim
    for (let sub = 0; sub < 2; sub++) {
      const dt = 0.05
      // torso slews toward the commanded aim, then weapons fire along the actual aim
      const dy = wrap(cmd[0] - yaw)
      yaw = wrap(yaw + Math.max(-M.turn_rate * dt, Math.min(M.turn_rate * dt, dy)))
      const dp = cmd[1] - pitch
      pitch += Math.max(-M.pitch_rate * dt, Math.min(M.pitch_rate * dt, dp))
      // our legs
      const mvx = a.move[0] * M.walk_speed * (charge > 0 ? M.charge_move_mult : 1)
      const mvy = a.move[1] * M.walk_speed * (charge > 0 ? M.charge_move_mult : 1)
      const acc = M.ground_accel * dt
      const dvx = mvx - vx
      const dvy = mvy - vy
      const dv = Math.hypot(dvx, dvy)
      vx += dv <= acc ? dvx : (dvx / dv) * acc
      vy += dv <= acc ? dvy : (dvy / dv) * acc
      x += vx * dt
      y += vy * dt
      // the target walks its line, turning round every few seconds (or weaving at random)
      if (weave ? Math.random() < 0.08 : Math.round((t + sub * dt) * 20) % 80 === 79) tdir += Math.PI
      tx += Math.cos(tdir) * speed * dt
      ty += Math.sin(tdir) * speed * dt
      const dir = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)]
      const oz = w.ground(x, y) + M.muzzle_height
      gunCd -= dt
      lasCd -= dt
      if (reload > 0) {
        reload -= dt
        if (reload <= 0) ammo = C.weapons.gun.mag
      } else if (a.reload && ammo < C.weapons.gun.mag) reload = C.weapons.gun.reload
      if (a.fire[0] && gunCd <= 0 && ammo > 0 && reload <= 0) {
        gunCd = C.weapons.gun.cooldown
        ammo--
        if (ammo === 0) reload = C.weapons.gun.reload
        shots++
        bullets.push({ x: x + dir[0] * 3, y: y + dir[1] * 3, z: oz + dir[2] * 3, vx: dir[0] * C.weapons.gun.speed, vy: dir[1] * C.weapons.gun.speed, vz: dir[2] * C.weapons.gun.speed, life: C.weapons.gun.range / C.weapons.gun.speed })
      }
      if (second === "laser") {
        const want = a.fire[1]
        if (want && lasCd <= 0) {
          charge = Math.min(charge + dt, C.weapons.laser.charge + C.weapons.laser.hold_s)
          held = true
        }
        const auto = charge >= C.weapons.laser.charge + C.weapons.laser.hold_s
        if (held && (!want || auto) && charge >= C.weapons.laser.min_charge) {
          // hitscan along the actual aim: distance from the target's axis to the beam
          const rx = tx - x
          const ry = ty - y
          const along = rx * dir[0] + ry * dir[1]
          const hd = Math.hypot(dir[0], dir[1])
          const perp = Math.abs(rx * dir[1] - ry * dir[0]) / hd
          const bz = oz + (dir[2] * along) / (hd * hd)
          const tzz = w.ground(tx, ty)
          beams++
          if (along > 0 && perp <= M.radius && bz >= tzz && bz <= tzz + M.height && charge >= C.weapons.laser.charge - 1e-6) beamHits++
          charge = 0
          held = false
          lasCd = C.weapons.laser.cooldown
        }
      }
      if (second === "lightning" && a.fire[1]) arcs++
      // bullets fly in small steps against the moving target
      for (const p of bullets) {
        if (p.life <= 0) continue
        for (let q = 0; q < 25 && p.life > 0; q++) {
          const h = dt / 25
          p.x += p.vx * h
          p.y += p.vy * h
          p.z += p.vz * h
          p.life -= h
          const tzz = w.ground(tx, ty)
          if (Math.hypot(p.x - tx, p.y - ty) <= M.radius + 0.3 && p.z >= tzz && p.z <= tzz + M.height) {
            hits++
            p.life = 0
          }
        }
      }
    }
    t += 0.1
  }
  return { shots, hits, beams, beamHits, arcs, errors: b.errors as number }
}

// the most open ground on the map, and the bearing from it with the longest clear, level view
const OPEN = (() => {
  const b: any = new Brain({ ...hello, seed: 1 })
  const w = b.w
  let best = 0
  let bx = 0
  let by = 0
  for (let j = 0; j < w.ny; j += 4)
    for (let i = 0; i < w.nx; i += 4)
      if (w.dist[j * w.nx + i] > best && b.nav.inMain(w.minX + i, w.minY + j)) {
        best = w.dist[j * w.nx + i]
        bx = w.minX + i
        by = w.minY + j
      }
  let bearing = 0
  let far = 0
  for (let k = 0; k < 72; k++) {
    const a = (k * Math.PI) / 36
    let d = 0
    while (d < 300 && b.nav.free(bx + Math.cos(a) * (d + 5), by + Math.sin(a) * (d + 5), 8) && w.los(bx, by, w.ground(bx, by) + 7, bx + Math.cos(a) * (d + 5), by + Math.sin(a) * (d + 5), w.ground(bx + Math.cos(a) * (d + 5), by + Math.sin(a) * (d + 5)) + 4.5)) d += 5
    if (d > far) {
      far = d
      bearing = a
    }
  }
  console.log(`standing at ${bx},${by} (clearance ${best.toFixed(0)} m), target along bearing ${bearing.toFixed(2)} (clear for ${far} m)`)
  return [bx, by, bearing]
})()

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-")
console.log("target walks straight, turning round every 4 s; bullet spread not modelled")
for (const [d, v] of [[40, 0], [40, 11.7], [80, 11.7], [80, 19.5], [150, 11.7], [150, 19.5], [210, 11.7]] as number[][]) {
  const r = run(d, v, null, false)
  console.log(`  gun    ${String(d).padStart(3)} m, target ${String(v).padStart(4)} m/s: ${r.shots} shots, ${pct(r.hits, r.shots)} hit${r.errors ? "  ERRORS " + r.errors : ""}`)
}
for (const [d, v] of [[60, 11.7], [150, 11.7], [150, 19.5], [250, 11.7]] as number[][]) {
  const r = run(d, v, "laser", false)
  console.log(`  laser  ${String(d).padStart(3)} m, target ${String(v).padStart(4)} m/s: ${r.beams} beams, ${pct(r.beamHits, r.beams)} full-charge hits; gun alongside ${r.shots} shots, ${pct(r.hits, r.shots)} hit${r.errors ? "  ERRORS " + r.errors : ""}`)
}
{
  const r = run(30, 11.7, "lightning", false)
  console.log(`  lightning at the range the bot closes to: trigger held on ${r.arcs} of 400 sub-ticks; gun ${r.shots} shots, ${pct(r.hits, r.shots)} hit`)
}
console.log("target changes direction at random (a dodging opponent)")
for (const [d, v] of [[40, 11.7], [80, 11.7], [150, 11.7]] as number[][]) {
  const r = run(d, v, "laser", true)
  console.log(`  ${String(d).padStart(3)} m: gun ${r.shots} shots, ${pct(r.hits, r.shots)} hit; laser ${r.beams} beams, ${pct(r.beamHits, r.beams)} hit`)
}
