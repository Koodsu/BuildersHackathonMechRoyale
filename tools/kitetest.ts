/**
 * Stand-off check: dummies walk at the bot along the shortest route on the real map, the way a
 * house bot hunting us does (the squad shares vision, so they always know where we are), and we
 * measure whether the bot keeps its distance and a line of fire. The dummies have no health and no
 * brain: this tests the legs and the eyes, not a fight. The "exchange" figure prices the distances
 * that result with the hit rates measured on the public match feed; it is a yardstick for comparing
 * two ways of moving, not a prediction of a score.
 *   node tools/kitetest.ts [trials] [seconds]        STANDOFF=0 runs the old close-range movement
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Brain, TUNING } from "../src/bot.ts"
import { Nav } from "../src/nav.ts"

if (process.env.STANDOFF === "0") TUNING.standoff = false
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const msgs = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = msgs[0]
hello.map.dir = join(root, "kit/arena")
const base = msgs.find((m) => m.type === "obs")
const C = hello.config
const M = C.mech
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const TRACE = !!process.env.TRACE
const CUBES = 6
const SC = 1 + 0.05 * CUBES

// what a house bot lands on us per second from range d, by what it carries (measured hit rates)
const step = (d: number, v: number[]) => (d < 40 ? v[0] : d < 80 ? v[1] : d < 120 ? v[2] : d < 160 ? v[3] : d < 200 ? v[4] : 0)
const gunS = (C.weapons.gun.damage * C.weapons.gun.mag) / (C.weapons.gun.mag * C.weapons.gun.cooldown + C.weapons.gun.reload)
const lasS = C.weapons.laser.damage / (C.weapons.laser.charge + C.weapons.laser.cooldown)
const theirDps = (d: number, kind: string) => {
  let v = gunS * step(d, [1, 0.57, 0.23, 0.18, 0.09])
  if (kind === "laser") v += lasS * step(d, [0.65, 0.61, 0.39, 0.03, 0])
  if (kind === "lightning" && d < C.weapons.lightning.range) v += (C.weapons.lightning.damage / C.weapons.lightning.cooldown) * 0.85
  return v
}
// what we land on it (a gun led on current velocity against recorded house-bot movement; laser hitscan)
const ourGunAcc = (d: number) => (d > 223 ? 0 : d < 60 ? 0.92 : d < 100 ? 0.85 : d < 140 ? 0.75 : d < 180 ? 0.66 : 0.58)

function run(seed: number, nWalk: number, fast: boolean, seconds: number) {
  let s = seed * 7919 + 13
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
  const b: any = new Brain({ ...hello, seed, entropy: 7 })
  const w = b.w
  const nav: any = new Nav(w)
  nav.rebuild(M.radius * SC)
  const wnav: any = new Nav(w)
  wnav.rebuild(M.radius)
  const cells: number[] = []
  for (let c = 0; c < nav.walk.length; c++) if (nav.comp[c] === nav.mainComp) cells.push(c)
  // us somewhere within 200 m of the middle of the map; the dummies 180-320 m away
  let x = 0
  let y = 0
  for (let k = 0; k < 500; k++) {
    const c = cells[Math.floor(rnd() * cells.length)]
    x = nav.cx(c)
    y = nav.cy(c)
    if (Math.hypot(x - 20, y - 20) < 200) break
  }
  const zc = [x, y]
  const zr = 260
  const kinds = ["gun", "laser", "lightning"]
  const walkers: { id: number; x: number; y: number; kind: string; path: number[] | null; pi: number; planT: number; seenT: number }[] = []
  for (let k = 0; k < nWalk; k++) {
    for (let q = 0; q < 2000; q++) {
      const c = cells[Math.floor(rnd() * cells.length)]
      const wx = nav.cx(c)
      const wy = nav.cy(c)
      const d = Math.hypot(wx - x, wy - y)
      if (d > 180 && d < 320 && wnav.snap(wx, wy, 1) >= 0) {
        walkers.push({ id: 9 + k, x: wx, y: wy, kind: kinds[Math.floor(rnd() * 3)], path: null, pi: 0, planT: -9, seenT: -99 })
        break
      }
    }
  }
  let vx = 0
  let vy = 0
  let yaw = rnd() * 6.283
  let pitch = 0
  let energy = 100
  let since = 9
  let charge = 0
  let lasCd = 0
  let ammo = C.weapons.gun.mag
  let reload = 0
  let gunCd = 0
  const out = { ticks: 0, near45: 0, near80: 0, near120: 0, far150: 0, sumNear: 0, los: 0, fire: 0, dealt: 0, taken: 0, outZone: 0, errors: 0, labels: new Map<string, number>(), minNear: 1e9 }
  for (let k = 0; k < seconds * 10; k++) {
    const t = 40 + k * 0.1
    const z = w.ground(x, y)
    const eye = z + M.eye_height * SC
    const mechs: any[] = []
    const events: any[] = []
    let near = 1e9
    let anyLos = false
    for (const q of walkers) {
      const qz = w.ground(q.x, q.y)
      const d = Math.hypot(q.x - x, q.y - y)
      near = Math.min(near, d)
      const sight = w.los(x, y, eye, q.x, q.y, qz + 4.5) || w.los(x, y, eye, q.x, q.y, qz + 9)
      const inFov = Math.abs(wrap(Math.atan2(q.y - y, q.x - x) - yaw)) <= Math.PI / 3
      if (sight && (d <= 45 || (d <= 200 && inFov))) q.seenT = t
      const los = w.los(q.x, q.y, qz + 7, x, y, z + 4.5 * SC)
      if (los && d <= 230) {
        anyLos = true
        out.taken += theirDps(d, q.kind) * 0.1
        // a hit now and then tells the bot it is being shot at, and from where
        if (rnd() < Math.min(0.9, theirDps(d, q.kind) / 450)) events.push({ type: "damaged", amount: 45, weapon: "gun", bearing: Math.atan2(q.y - y, q.x - x), by: q.id })
      }
      if (t - q.seenT <= 5) {
        const tv = q.path && q.pi < q.path.length / 2 ? 1 : 0
        mechs.push({ id: q.id, kind: "mech", pos: [q.x, q.y, qz], vel: [tv * (x - q.x) / Math.max(1, d) * 6, tv * (y - q.y) / Math.max(1, d) * 6, 0], aim: [Math.atan2(y - q.y, x - q.x), 0], hp: 1700, max_hp: 1700, cubes: 3, weapons: q.kind === "gun" ? ["gun"] : ["gun", q.kind], charging: false })
      }
    }
    const weapons: any[] = [
      { kind: "gun", cooldown: Math.max(0, gunCd), ammo, reload: Math.max(0, reload), stats: C.weapons.gun },
      { kind: "laser", cooldown: Math.max(0, lasCd), charge, stats: C.weapons.laser },
    ]
    const inZone = Math.hypot(x - zc[0], y - zc[1]) <= zr
    const obs = {
      ...base, tick: Math.round(t * 20), t, alive: 16, projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], drops: [], offer: null, events,
      self: { ...base.self, pos: [x, y, z], vel: [vx, vy, 0], aim: [yaw, pitch], grounded: true, hp: 1400 * 1.24, max_hp: 1400 * 1.24, energy, max_energy: 100, cubes: CUBES, in_zone: inZone, weapons, stats: { ...M, radius: M.radius * SC, height: M.height * SC, eye_height: M.eye_height * SC, muzzle_height: M.muzzle_height * SC } },
      mechs,
      zone: { center: zc, radius: zr, next_center: zc, next_radius: zr - 20, shrink_start: 900, shrink_end: 950, dps: 35 },
    }
    const a = b.act(obs)
    out.errors = b.errors
    if (process.env.DEEP && k >= Number(process.env.DEEP) * 10 && k < Number(process.env.DEEP) * 10 + 12) {
      const kt = b.kite
      const pth = b.path
      const nx = pth ? pth[2 * b.pathI] : NaN
      const ny = pth ? pth[2 * b.pathI + 1] : NaN
      console.log(`      k=${k} pos ${x.toFixed(1)},${y.toFixed(1)} vel ${vx.toFixed(1)},${vy.toFixed(1)} label ${b.label} move ${a.move} kite ${kt ? kt.x.toFixed(0) + "," + kt.y.toFixed(0) : "-"} path ${pth ? pth.length / 2 : 0} i=${b.pathI} next ${nx.toFixed(1)},${ny.toFixed(1)} botFree ${b.nav.free(x, y, 0)} testFree ${nav.free(x, y, -0.5)} clr ${w.clearance(x, y).toFixed(1)} snap ${b.nav.snap(x, y, 2)} unstuckT ${(b.unstuckT - t).toFixed(1)} rangeNow ${b.rangeNow} kiteGain ${b.kiteGain.toFixed(1)}`)
    }
    if (TRACE && k % 10 === 0) console.log(`    t=${(t - 40).toFixed(0).padStart(2)} pos ${x.toFixed(0)},${y.toFixed(0)} nearest ${near.toFixed(0)} m ${anyLos ? "LOS" : "   "} listed ${mechs.length} ${String(b.label).padEnd(7)} move ${a.move[0].toFixed(2)},${a.move[1].toFixed(2)} boost ${a.boost ? 1 : 0} e=${energy.toFixed(0)} fire ${a.fire[0] ? "G" : "-"}${a.fire[1] ? "L" : "-"} | ${walkers.map((q) => `${q.kind[0]}@${q.x.toFixed(0)},${q.y.toFixed(0)} d${Math.hypot(q.x - x, q.y - y).toFixed(0)}`).join(" ")}`)
    out.labels.set(b.label, (out.labels.get(b.label) ?? 0) + 1)
    out.ticks++
    out.sumNear += Math.min(near, 300)
    out.minNear = Math.min(out.minNear, near)
    if (near < 45) out.near45++
    if (near < 80) out.near80++
    if (near < 120) out.near120++
    if (near >= 150) out.far150++
    if (!inZone) out.outZone++
    // the one we are aiming at, if we have a line to it
    let tgt: (typeof walkers)[number] | null = null
    for (const q of walkers) {
      const qz = w.ground(q.x, q.y)
      if (Math.abs(wrap(Math.atan2(q.y - y, q.x - x) - yaw)) < 0.08 && w.los(x, y, z + M.muzzle_height * SC, q.x, q.y, qz + 4.5)) tgt = q
    }
    if (anyLos) out.los++
    const gunFire = !!a.fire[0] && ammo > 0 && reload <= 0
    const lasFire = !!a.fire[1]
    if (tgt && (gunFire || lasFire)) out.fire++
    const tgtD = tgt ? Math.hypot(tgt.x - x, tgt.y - y) : 0
    const cm = 1 + 0.04 * CUBES
    for (let sub = 0; sub < 2; sub++) {
      const dt = 0.05
      yaw = wrap(yaw + Math.max(-M.turn_rate * dt, Math.min(M.turn_rate * dt, wrap(a.aim[0] - yaw))))
      pitch += Math.max(-M.pitch_rate * dt, Math.min(M.pitch_rate * dt, a.aim[1] - pitch))
      // weapons, just enough for the bot's own timing (a charging laser halves our speed)
      gunCd -= dt
      lasCd -= dt
      if (reload > 0) {
        reload -= dt
        if (reload <= 0) ammo = C.weapons.gun.mag
      } else if (a.reload && ammo < C.weapons.gun.mag) reload = C.weapons.gun.reload
      else if (a.fire[0] && gunCd <= 0 && ammo > 0) {
        gunCd = C.weapons.gun.cooldown
        if (--ammo === 0) reload = C.weapons.gun.reload
        if (tgt) out.dealt += C.weapons.gun.damage * ourGunAcc(tgtD) * cm // one bullet, on target
      }
      if (a.fire[1] && lasCd <= 0) charge = Math.min(charge + dt, C.weapons.laser.charge + C.weapons.laser.hold_s)
      if (charge > 0 && (!a.fire[1] || charge >= C.weapons.laser.charge + C.weapons.laser.hold_s)) {
        // one beam, at whatever charge it had, if it was let go on a target
        if (tgt && tgtD <= 280) out.dealt += C.weapons.laser.damage * (0.35 + 0.65 * Math.min(1, charge / C.weapons.laser.charge)) * 0.95 * cm
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
      if (nav.free(x + vx * dt, y + vy * dt, -0.5)) {
        x += vx * dt
        y += vy * dt
      } else if (nav.free(x + vx * dt, y, -0.5)) {
        x += vx * dt
        vy = 0
      } else if (nav.free(x, y + vy * dt, -0.5)) {
        y += vy * dt
        vx = 0
      } else {
        vx = 0
        vy = 0
      }
      // the dummies: along the shortest walk to where we are, slower while they have a line on us
      // (a house bot follows a target that backs away at about 6 m/s while firing), stopping at 50 m
      for (const q of walkers) {
        const d = Math.hypot(q.x - x, q.y - y)
        const qz = w.ground(q.x, q.y)
        const los = d <= 230 && w.los(q.x, q.y, qz + 7, x, y, w.ground(x, y) + 4.5 * SC)
        if (los && d <= 50) continue
        const tt = 40 + k * 0.1 + sub * dt
        if (!q.path || tt - q.planT > 1) {
          q.path = wnav.findPath(q.x, q.y, x, y, 12000)
          q.pi = 0
          q.planT = tt
        }
        const p = q.path
        if (!p || p.length < 4) continue
        let stepLeft = (los ? (fast ? 9 : 6) : fast ? 14 : M.walk_speed) * dt
        while (stepLeft > 0 && q.pi + 1 < p.length / 2) {
          const tx = p[2 * q.pi + 2]
          const ty = p[2 * q.pi + 3]
          const dd = Math.hypot(tx - q.x, ty - q.y)
          if (dd <= stepLeft) {
            q.x = tx
            q.y = ty
            q.pi++
            stepLeft -= dd
          } else {
            q.x += ((tx - q.x) / dd) * stepLeft
            q.y += ((ty - q.y) / dd) * stepLeft
            stepLeft = 0
          }
        }
      }
    }
  }
  return out
}

const N = Number(process.argv[2] ?? 12)
const SEC = Number(process.argv[3] ?? 60)
console.log(`${TUNING.standoff ? "stand-off movement" : "old close-range movement"}; ${N} trials of ${SEC} s per row; dummies start 180-320 m away`)
const ROWS = (process.env.ROWS ? process.env.ROWS.split(",").map((r) => [Number(r[0]), r[1] === "f"]) : [[1, false], [1, true], [2, false], [3, false], [3, true]]) as [number, boolean][]
const FIRST = Number(process.env.FIRST ?? 1)
for (const [nWalk, fast] of ROWS) {
  const tot = { ticks: 0, near45: 0, near80: 0, near120: 0, far150: 0, sumNear: 0, los: 0, fire: 0, dealt: 0, taken: 0, outZone: 0, errors: 0, minNear: 0 }
  const labels = new Map<string, number>()
  for (let sd = FIRST; sd < FIRST + N; sd++) {
    const r = run(sd, nWalk, fast, SEC)
    for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += k === "minNear" ? r.minNear / N : (r as any)[k]
    for (const [k, v] of r.labels) labels.set(k, (labels.get(k) ?? 0) + v)
  }
  const pct = (v: number) => `${Math.round((100 * v) / tot.ticks)}%`
  const top = [...labels].sort((p, q) => q[1] - p[1]).slice(0, 5).map(([k, v]) => `${k} ${Math.round((100 * v) / tot.ticks)}%`).join(", ")
  console.log(
    `${nWalk} ${fast ? "fast" : "slow"} dummy${nWalk > 1 ? "s" : ""}: nearest on average ${Math.round(tot.sumNear / tot.ticks)} m (closest it got, mean over trials: ${Math.round(tot.minNear)} m); time with one inside 45 m ${pct(tot.near45)}, inside 80 m ${pct(tot.near80)}, inside 120 m ${pct(tot.near120)}, all beyond 150 m ${pct(tot.far150)}; a line of fire ${pct(tot.los)} of the time, firing on target ${pct(tot.fire)}; outside the circle ${pct(tot.outZone)}` +
      `\n    exchange at measured hit rates: we deal ${Math.round((tot.dealt / tot.ticks) * 10)} per second and take ${Math.round((tot.taken / tot.ticks) * 10)}: ${(tot.dealt / Math.max(1, tot.taken)).toFixed(1)} to 1${tot.errors ? "; THINK ERRORS " + tot.errors : ""}\n    legs: ${top}`,
  )
}
