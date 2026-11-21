/**
 * Bullet check: guns that aim the way house bots do (a full lead on our velocity, plus an aiming error
 * that reproduces their measured hit rates by range and by our size) fire at the bot at the real
 * cadence, and the bot is shown every bullet in its view, as in a match. We count how many hit, with
 * and without the bot's stepping out of their lines (DODGE=0).
 *   node tools/bullettest.ts [trials] [seconds]
 *   CUBES=n   our size (default 6)        SIGMA=rad  their aiming error (default 0.067, see below)
 *   BURST=1   the error is drawn once per magazine instead of once per shot
 *   LAG=n     our answers take hold n decisions late (0.1 s each), for a scorer slower than assumed
 *   FFA=1     the bot in free-for-all mode (SIGMA=0.035 is about what the top teams' guns do at range)
 * The error: one Gaussian in yaw and one in pitch of 0.067 rad gives, against a bare mech, about 41% of
 * shots at 60 m, 18% at 100 m and 8% at 150 m, and against a twelve-cube one 67%, 34% and 18%; the
 * match feed has 49 / 23 / 9% and 70 / 51 / 23%.
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Brain, TUNING } from "../src/bot.ts"

if (process.env.DODGE === "0") TUNING.dodge = false
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const msgs = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = msgs[0]
hello.map.dir = join(root, "kit/arena")
const base = msgs.find((m) => m.type === "obs")
const C = hello.config
const M = C.mech
const G = C.weapons.gun
const CUBES = Number(process.env.CUBES ?? 6)
const SC = 1 + 0.05 * CUBES
const SIGMA = Number(process.env.SIGMA ?? 0.067)
const BURST = !!process.env.BURST
const LAG = Number(process.env.LAG ?? 0)
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

function run(dist: number, nGuns: number, seconds: number, seed: number) {
  let s = seed * 7919 + 17
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd() || 1e-9)) * Math.cos(6.2831853 * rnd())
  const b: any = new Brain({ ...hello, seed, entropy: 11 })
  if (process.env.FFA) b.ffa = true // free-for-all mode: the guns are rivals, and the bot leaves while shooting back
  const w = b.w
  // the most open ground on the map and its longest clear bearing (found by the aim test)
  let x = -329
  let y = -142
  const bearing = 0.61
  let vx = 0
  let vy = 0
  let yaw = bearing
  let pitch = 0
  let energy = 100
  let since = 9
  let charge = 0
  let lasCd = 0
  let ammo = G.mag
  let reload = 0
  let gunCd = 0
  const guns = Array.from({ length: nGuns }, (_, i) => ({ id: 9 + i, off: (i - (nGuns - 1) / 2) * 0.16, x: 0, y: 0, cd: rnd() * 0.24, ammo: G.mag as number, reload: rnd() * 2.4, ey: 0, ep: 0 }))
  const place = () => {
    for (const g of guns) {
      g.x = x + Math.cos(bearing + g.off) * dist
      g.y = y + Math.sin(bearing + g.off) * dist
    }
  }
  place()
  const bullets: { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; by: number }[] = []
  let nextId = 300
  let shots = 0
  let hits = 0
  let path = 0
  let pending: any[] = []
  const labels = new Map<string, number>()
  const queue: any[] = []
  const R = M.radius * SC
  const H = M.height * SC
  for (let k = 0; k < seconds * 10; k++) {
    const t = 40 + k * 0.1
    const z = w.ground(x, y)
    const weapons: any[] = [
      { kind: "gun", cooldown: Math.max(0, gunCd), ammo, reload: Math.max(0, reload), stats: G },
      { kind: "laser", cooldown: Math.max(0, lasCd), charge, stats: C.weapons.laser },
    ]
    const projectiles: any[] = []
    for (const p of bullets) {
      if (p.life <= 0) continue
      const d = Math.hypot(p.x - x, p.y - y)
      if (d <= 45 || (d <= 200 && Math.abs(wrap(Math.atan2(p.y - y, p.x - x) - yaw)) <= Math.PI / 3)) projectiles.push({ id: p.id, kind: "gun", pos: [p.x, p.y, p.z], vel: [p.vx, p.vy, p.vz] })
    }
    const events = pending
    pending = []
    const obs = {
      ...base, tick: Math.round(t * 20), t, alive: 16, projectiles, crates: [], cubes: [], pickups: [], sounds: [], beams: [], drops: [], offer: null, events,
      self: { ...base.self, pos: [x, y, z], vel: [vx, vy, 0], aim: [yaw, pitch], grounded: true, hp: 1400 * (1 + 0.04 * Math.min(CUBES, 10)), max_hp: 1400 * (1 + 0.04 * Math.min(CUBES, 10)), energy, max_energy: 100, cubes: CUBES, upgrades: [], in_zone: true, weapons, stats: { ...M, radius: R, height: H, eye_height: M.eye_height * SC, muzzle_height: M.muzzle_height * SC } },
      mechs: guns.map((g) => ({ id: g.id, kind: "mech", pos: [g.x, g.y, w.ground(g.x, g.y)], vel: [vx, vy, 0], aim: [Math.atan2(y - g.y, x - g.x), 0], hp: 1700, max_hp: 1700, cubes: 3, weapons: ["gun"], charging: false })),
      zone: { center: [x, y], radius: 560, next_center: [x, y], next_radius: 540, shrink_start: 900, shrink_end: 950, dps: 20 },
    }
    queue.push(b.act(obs))
    const a = queue.length > LAG ? queue.shift() : { move: [0, 0], aim: [yaw, pitch], fire: [false, false], boost: false }
    labels.set(b.label, (labels.get(b.label) ?? 0) + 1)
    for (let sub = 0; sub < 2; sub++) {
      const dt = 0.05
      yaw = wrap(yaw + Math.max(-M.turn_rate * dt, Math.min(M.turn_rate * dt, wrap(a.aim[0] - yaw))))
      pitch += Math.max(-M.pitch_rate * dt, Math.min(M.pitch_rate * dt, a.aim[1] - pitch))
      // our own weapons, just enough for the bot's timing (a charging laser halves our speed)
      gunCd -= dt
      lasCd -= dt
      if (reload > 0) {
        reload -= dt
        if (reload <= 0) ammo = G.mag
      } else if (a.reload && ammo < G.mag) reload = G.reload
      else if (a.fire[0] && gunCd <= 0 && ammo > 0) {
        gunCd = G.cooldown
        if (--ammo === 0) reload = G.reload
      }
      if (a.fire[1] && lasCd <= 0) charge = Math.min(charge + dt, C.weapons.laser.charge + C.weapons.laser.hold_s)
      if (charge > 0 && (!a.fire[1] || charge >= C.weapons.laser.charge + C.weapons.laser.hold_s)) {
        charge = 0
        lasCd = C.weapons.laser.cooldown
      }
      const runB = a.boost && energy > 0 && Math.hypot(a.move[0], a.move[1]) > 0.1
      const sp = (runB ? M.boost_speed : M.walk_speed) * (charge > 0 ? M.charge_move_mult : 1)
      if (runB) {
        energy = Math.max(0, energy - M.boost_drain * dt)
        since = 0
      } else since += dt
      if (since > M.energy_regen_delay) energy = Math.min(100, energy + M.energy_regen * dt)
      const acc = M.ground_accel * dt
      const dvx = a.move[0] * sp - vx
      const dvy = a.move[1] * sp - vy
      const dv = Math.hypot(dvx, dvy)
      vx += dv <= acc ? dvx : (dvx / dv) * acc
      vy += dv <= acc ? dvy : (dvy / dv) * acc
      if (b.nav.free(x + vx * dt, y + vy * dt, -0.5)) {
        x += vx * dt
        y += vy * dt
      } else {
        vx = 0
        vy = 0
      }
      path += Math.hypot(vx, vy) * dt
      place() // the guns hold their distance, as an enemy keeping its range would
      const fz = w.ground(x, y)
      for (const g of guns) {
        g.cd -= dt
        if (g.reload > 0) {
          g.reload -= dt
          if (g.reload <= 0) {
            g.ammo = G.mag
            g.ey = gauss() * SIGMA
            g.ep = gauss() * SIGMA
          }
          continue
        }
        if (g.cd > 0) continue
        g.cd = G.cooldown
        if (--g.ammo === 0) g.reload = G.reload
        shots++
        // a full lead on our velocity, at our middle, plus the aiming error
        const gz = w.ground(g.x, g.y) + M.muzzle_height
        const tf = dist / G.speed
        const ax = x + vx * tf - g.x
        const ay = y + vy * tf - g.y
        const az = fz + H / 2 - gz
        const spread = ((G.spread_deg ?? 0.6) * Math.PI) / 180
        const yw = Math.atan2(ay, ax) + (BURST ? g.ey + gauss() * spread : gauss() * SIGMA)
        const pt = Math.atan2(az, Math.hypot(ax, ay)) + (BURST ? g.ep + gauss() * spread : gauss() * SIGMA)
        bullets.push({ id: nextId++, x: g.x, y: g.y, z: gz, vx: Math.cos(pt) * Math.cos(yw) * G.speed, vy: Math.cos(pt) * Math.sin(yw) * G.speed, vz: Math.sin(pt) * G.speed, life: G.range / G.speed, by: g.id })
      }
      for (const p of bullets) {
        if (p.life <= 0) continue
        for (let q = 0; q < 25 && p.life > 0; q++) {
          const h = dt / 25
          p.x += p.vx * h
          p.y += p.vy * h
          p.z += p.vz * h
          p.life -= h
          if (p.z < w.ground(p.x, p.y)) p.life = 0
          else if (Math.hypot(p.x - x, p.y - y) <= R + 0.3 && p.z >= fz && p.z <= fz + H) {
            hits++
            p.life = 0
            pending.push({ type: "damaged", amount: G.damage, weapon: "gun", bearing: Math.atan2(p.y - y, p.x - x), by: p.by, rear: false })
          }
        }
      }
    }
  }
  const top = [...labels].sort((p, q) => q[1] - p[1]).slice(0, 3).map(([k, v]) => `${k} ${Math.round((100 * v) / (seconds * 10))}%`).join(", ")
  return { shots, hits, speed: path / seconds, top, errors: b.errors as number }
}

const N = Number(process.argv[2] ?? 6)
const SEC = Number(process.argv[3] ?? 60)
console.log(`${TUNING.dodge ? "stepping out of bullets' lines" : "no bullet dodging"}; ${CUBES} cubes; aiming error ${SIGMA} rad ${BURST ? "per magazine" : "per shot"}; ${N} trials of ${SEC} s`)
for (const nGuns of [1, 3])
  for (const d of [60, 100, 140, 172, 195]) {
    let shots = 0
    let hits = 0
    let speed = 0
    let top = ""
    let errors = 0
    for (let sd = 1; sd <= N; sd++) {
      const r = run(d, nGuns, SEC, sd)
      shots += r.shots
      hits += r.hits
      speed += r.speed / N
      top = r.top
      errors += r.errors
    }
    console.log(`  ${nGuns} gun${nGuns > 1 ? "s" : " "} held at ${String(d).padStart(3)} m: hit by ${((100 * hits) / shots).toFixed(1).padStart(5)}% of ${shots} bullets (${((hits * G.damage) / (N * SEC)).toFixed(0)} health a second); our average speed ${speed.toFixed(1)} m/s; legs: ${top}${errors ? "  THINK ERRORS " + errors : ""}`)
  }
