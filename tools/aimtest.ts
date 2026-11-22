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

function run(dist: number, speed: number, second: string | null, weave: boolean, seconds = 20, full = C.weapons.laser.charge as number) {
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
  let autoFired = 0
  let morCd = 0
  let shellsOut = 0
  let shellDirect = 0
  let shellNear = 0
  const shells: { x: number; y: number; z: number; vx: number; vy: number; vz: number; live: boolean }[] = []
  let shots = 0
  let hits = 0
  let beams = 0
  let beamHits = 0
  let arcs = 0
  let t = 40 // past the cautious opening, in which the bot fires at nobody who is not shooting at it
  const bullets: { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number }[] = []
  const labels = new Map<string, number>()
  let blocked = 0
  for (let k = 0; k < seconds * 10; k++) {
    const z = w.ground(x, y)
    const tz = w.ground(tx, ty)
    const tvx = Math.cos(tdir) * speed
    const tvy = Math.sin(tdir) * speed
    const weapons: any[] = [{ kind: "gun", cooldown: Math.max(0, gunCd), ammo, reload: Math.max(0, reload), stats: C.weapons.gun }]
    // (the charge as the server shows it: rounded to two decimals)
    if (second === "laser") weapons.push({ kind: "laser", cooldown: Math.max(0, lasCd), charge: Math.round(Math.min(charge, full) * 100) / 100, stats: { ...C.weapons.laser, charge: full } })
    else if (second === "mortar") weapons.push({ kind: "mortar", cooldown: Math.max(0, morCd), stats: C.weapons.mortar })
    else if (second === "lightning") weapons.push({ kind: "lightning", cooldown: 0, stats: C.weapons.lightning })
    else weapons.push(null)
    const obs = {
      ...base, tick: k * 2, t, projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], events: [], drops: [], offer: null,
      self: { ...base.self, pos: [x, y, z], vel: [vx, vy, 0], aim: [yaw, pitch], grounded: true, hp: 1400, max_hp: 1400, energy: 100, max_energy: 100, cubes: 0, in_zone: true, weapons, stats: { ...M } },
      mechs: [{ id: 9, kind: "mech", pos: [tx, ty, tz], vel: [tvx, tvy, 0], aim: [bearing + Math.PI, 0], hp: 1400, max_hp: 1400, cubes: 0, weapons: ["gun"], charging: false }],
      zone: { center: [41, -73], radius: 560, next_center: [41, -73], next_radius: 380, shrink_start: 600, shrink_end: 650, dps: 20 },
    }
    const a = b.act(obs)
    labels.set(b.label, (labels.get(b.label) ?? 0) + 1)
    if (!b.w.los(x, y, z + 7, tx, ty, tz + 4.5)) blocked++
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
          charge = Math.min(charge + dt, full + C.weapons.laser.hold_s)
          held = true
        }
        const auto = charge >= full + C.weapons.laser.hold_s
        if (held && auto) autoFired++
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
          if (along > 0 && perp <= M.radius && bz >= tzz && bz <= tzz + M.height && charge >= full - 1e-6) beamHits++
          charge = 0
          held = false
          lasCd = C.weapons.laser.cooldown
        }
      }
      if (second === "lightning" && a.fire[1]) arcs++
      morCd -= dt
      if (second === "mortar") {
        if (a.fire[1] && morCd <= 0) {
          morCd = C.weapons.mortar.cooldown
          shellsOut++
          const tube = w.ground(x, y) + M.height + 0.5
          shells.push({ x: x + dir[0] * 3, y: y + dir[1] * 3, z: tube + dir[2] * 3, vx: dir[0] * C.weapons.mortar.speed, vy: dir[1] * C.weapons.mortar.speed, vz: dir[2] * C.weapons.mortar.speed, live: true })
        }
        for (const sh of shells) {
          if (!sh.live) continue
          sh.vz -= C.weapons.mortar.gravity * dt
          for (let q = 1; q <= 20 && sh.live; q++) {
            const h = dt / 20
            sh.x += sh.vx * h
            sh.y += sh.vy * h
            sh.z += sh.vz * h
            const tzz = w.ground(tx, ty)
            const off = Math.hypot(sh.x - tx, sh.y - ty)
            if (off <= M.radius && sh.z >= tzz && sh.z <= tzz + M.height) {
              shellDirect++
              sh.live = false
            } else if (sh.z <= w.ground(sh.x, sh.y)) {
              if (off <= C.weapons.mortar.splash_radius + M.radius) shellNear++
              sh.live = false
            }
          }
        }
      }
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
  const legs = [...labels].sort((p, q) => q[1] - p[1]).map(([k, v]) => `${k} ${v}`).join(", ") + (blocked ? `; no clear line on ${blocked} ticks` : "")
  return { shots, hits, beams, beamHits, arcs, autoFired, shellsOut, shellDirect, shellNear, errors: b.errors as number, legs }
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
  console.log(`  laser  ${String(d).padStart(3)} m, target ${String(v).padStart(4)} m/s: ${r.beams} beams, ${pct(r.beamHits, r.beams)} full-charge hits; gun alongside ${r.shots} shots, ${pct(r.hits, r.shots)} hit${r.errors ? "  ERRORS " + r.errors : ""}  [${r.legs}]`)
}
{
  const r = run(30, 11.7, "lightning", false)
  console.log(`  lightning at the range the bot closes to: trigger held on ${r.arcs} of 400 sub-ticks; gun ${r.shots} shots, ${pct(r.hits, r.shots)} hit  [${r.legs}]`)
}
console.log("target changes direction at random (a dodging opponent)")
for (const [d, v] of [[40, 11.7], [80, 11.7], [150, 11.7]] as number[][]) {
  const r = run(d, v, "laser", true)
  console.log(`  ${String(d).padStart(3)} m: gun ${r.shots} shots, ${pct(r.hits, r.shots)} hit; laser ${r.beams} beams, ${pct(r.beamHits, r.beams)} hit`)
}
console.log("laser with the faster-capacitor upgrade (full charge 0.5625 s, shown to us as 0.56)")
let bad = 0
for (const full of [0.5625, 0.421875]) {
  const r = run(100, 11.7, "laser", false, 20, full)
  const ok = r.autoFired === 0 && r.beams >= 8
  if (!ok) bad++
  console.log(`  full ${full}: ${r.beams} beams in 20 s, ${pct(r.beamHits, r.beams)} hit, ${r.autoFired} fired by the hold running out${ok ? "" : "  FAIL"}${r.errors ? "  ERRORS " + r.errors : ""}`)
}
console.log("mortar in the second slot (shells stepped at the tick rate, swept against the target)")
for (const [d, v, wv] of [[30, 11.7, 0], [60, 0, 0], [60, 6, 0], [60, 11.7, 1], [100, 6, 0], [100, 11.7, 1]] as number[][]) {
  const r = run(d, v, "mortar", !!wv)
  if (r.errors) bad++
  console.log(`  ${String(d).padStart(3)} m, target ${String(v).padStart(4)} m/s${wv ? " weaving" : ""}: ${r.shellsOut} shells, ${r.shellDirect} direct, ${r.shellNear} more within the blast; gun alongside ${r.shots} shots, ${pct(r.hits, r.shots)} hit${r.errors ? "  ERRORS " + r.errors : ""}  [${r.legs}]`)
}
if (bad) process.exit(1)
