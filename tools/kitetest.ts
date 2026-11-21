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
if (process.env.BRAWL) TUNING.brawl = true
if (process.env.MEND) TUNING.mend = Number(process.env.MEND)
if (process.env.DROPRUN === "0") TUNING.dropRun = false
if (process.env.DROPAT) TUNING.dropAt = Number(process.env.DROPAT)
if (process.env.LOOK) TUNING.look = process.env.LOOK as typeof TUNING.look
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const msgs = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = msgs[0]
hello.map.dir = join(root, "kit/arena")
const base = msgs.find((m) => m.type === "obs")
const C = hello.config
const M = C.mech
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const TRACE = !!process.env.TRACE
const T0 = Number(process.env.T0 ?? 40) // match time the trial starts at (0 puts it inside the cautious opening)
const SWARM = !!process.env.SWARM // the last wave: hunters start 150-450 m away all round, in a wider circle; we have ten cubes
const HP0 = 2250 // our health going into it (ten cubes and one plate)
// HEALTH=1: our own health is kept (theirs is not: they are still dummies). Their hits are drawn shot by
// shot from the measured rates, ours likewise for the repair timer, and health comes back at the rulebook's
// rate after the rulebook's quiet time. The trial ends when we are down. This is what shows whether
// breaking off to mend pays while hunters keep coming (MEND=0 turns breaking off off).
const HEALTH = !!process.env.HEALTH
// DROP=1 (with HEALTH=1): a supply drop lands 60-180 m from us eight seconds in; four seconds alone in its
// ring are a full repair, as in the rulebook. DROPRUN=0 turns off the run for it when hurt.
// NANITES=n, PLATING=n, ARMOR=n (with HEALTH=1): that many of the survival upgrades, as the rulebook defines them
const NANITES = Number(process.env.NANITES ?? 0)
const PLATING = Number(process.env.PLATING ?? 0)
const ARMOR = Number(process.env.ARMOR ?? 0)
// BULLETS=1 (with HEALTH=1): their guns fire real bullets with the aiming error that reproduces their measured
// hit rates (see tools/bullettest.ts), and the bot is shown the ones in its view, as in a match. Without it gun
// hits are drawn from the hit-rate tables, which cannot credit the bot for stepping out of a bullet's line.
const BULLETS = !!process.env.BULLETS
const SIGMA = Number(process.env.SIGMA ?? (process.env.HARD ? 0.05 : process.env.EASY ? 0.085 : 0.067))
if (process.env.DODGE === "0") TUNING.dodge = false
const DROP = !!process.env.DROP
const GUNONLY = !!process.env.GUNONLY // no laser yet
const LIGHT = !!process.env.LIGHT // a lightning gun in the second slot instead of a laser
const CUBES = Number(process.env.CUBES ?? (process.env.SWARM ? 10 : 6))
const DROPT = Number(process.env.DROPT ?? 8) // seconds into the trial at which the drop lands
const SC = 1 + 0.05 * CUBES

// what a house bot lands on us per second from range d, by what it carries (measured hit rates)
const step = (d: number, v: number[]) => (d < 40 ? v[0] : d < 80 ? v[1] : d < 120 ? v[2] : d < 160 ? v[3] : d < 200 ? v[4] : 0)
const gunS = (C.weapons.gun.damage * C.weapons.gun.mag) / (C.weapons.gun.mag * C.weapons.gun.cooldown + C.weapons.gun.reload)
const lasS = C.weapons.laser.damage / (C.weapons.laser.charge + C.weapons.laser.cooldown)
// Our size. House bots hit a bigger mech far more often (10 human matches on the feed, about 5600 gun
// shots): against 0-2 cubes they land 49% at 40-80 m, 23% at 80-120 m, 9% at 120-200 m; against 10-14
// cubes 70%, 51% and 23%. That fits (size / 1.05) to the power 0.9, 1.9 and 2.2 in those three bands,
// which is what is applied here to the small-target rates. SIZE=0 prices us as a small target whatever
// we carry (how this check ran before 2026-11-21 evening).
const sizeMul = (d: number) => (process.env.SIZE === "0" || d < 40 ? 1 : Math.pow(SC / 1.05, d < 80 ? 0.9 : d < 120 ? 1.9 : 2.2))
const gunTab = () => (process.env.EASY ? [1, 0.51, 0.14, 0.02, 0.03] : process.env.HARD ? [1, 0.7, 0.3, 0.3, 0.1] : process.env.SIZE === "0" ? [1, 0.57, 0.23, 0.18, 0.09] : [0.92, 0.5, 0.23, 0.12, 0.05])
const lasTab = () => (process.env.EASY ? [0.65, 0.4, 0.15, 0, 0] : process.env.HARD ? [0.7, 0.75, 0.47, 0.05, 0] : [0.65, 0.61, 0.39, 0.03, 0])
const theirDps = (d: number, kind: string) => {
  // EASY=1: the squad's weakest kind (Astra on the feed), which is what hunts first
  // HARD=1: the three best-shooting kinds on the feed (Expert, Crimson, Red), with ten cubes' worth of damage
  const hard = !!process.env.HARD
  let v = gunS * Math.min(1, step(d, gunTab()) * sizeMul(d))
  if (kind === "laser") v += lasS * Math.min(1, step(d, lasTab()) * sizeMul(d))
  if (hard) v *= 1.4
  if (kind === "lightning" && d < C.weapons.lightning.range) v += (C.weapons.lightning.damage / C.weapons.lightning.cooldown) * 0.85
  return v
}
// what we land on it (a gun led on current velocity against recorded house-bot movement; laser hitscan)
const ourGunAcc = (d: number) => (d > 223 ? 0 : d < 60 ? 0.92 : d < 100 ? 0.85 : d < 140 ? 0.75 : d < 180 ? 0.66 : 0.58)

function run(seed: number, nWalk: number, fast: boolean, seconds: number) {
  let s = seed * 7919 + 13
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
  const b: any = new Brain({ ...hello, seed, entropy: 7 })
  if (process.env.FFA) b.ffa = true // free-for-all mode: the dummies are rivals; the figure that matters is how long one has a line on us
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
  const zr = process.env.ZR ? Number(process.env.ZR) : SWARM ? 320 : 260 // ZR=120: a late, small circle
  const kinds = ["gun", "laser", "lightning"]
  const walkers: { id: number; x: number; y: number; kind: string; path: number[] | null; pi: number; planT: number; seenT: number; firstT: number }[] = []
  for (let k = 0; k < nWalk; k++) {
    for (let q = 0; q < 2000; q++) {
      const c = cells[Math.floor(rnd() * cells.length)]
      const wx = nav.cx(c)
      const wy = nav.cy(c)
      const d = Math.hypot(wx - x, wy - y)
      if (d > (process.env.ZR ? 60 : SWARM ? 150 : 180) && d < (process.env.ZR ? Number(process.env.ZR) * 1.6 : SWARM ? 450 : 320) && wnav.snap(wx, wy, 1) >= 0) {
        walkers.push({ id: 9 + k, x: wx, y: wy, kind: kinds[Math.floor(rnd() * 3)], path: null, pi: 0, planT: -9, seenT: -99, firstT: -1 })
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
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd2() || 1e-9)) * Math.cos(6.2831853 * rnd2())
  const guns = new Map<number, { cd: number; ammo: number; reload: number }>()
  const bullets: { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; by: number; d0: number }[] = []
  let nextBullet = 300
  const out: any = { ticks: 0, near45: 0, near80: 0, near120: 0, far150: 0, sumNear: 0, los: 0, fire: 0, dealt: 0, taken: 0, outZone: 0, errors: 0, labels: new Map<string, number>(), by: new Map<string, number>(), minNear: 1e9, dealt20: 0, taken20: 0, sec20: 0, deadT: -1, dealtAtDeath: 0 }
  let firstSight = -1
  const MAXHP = (SWARM ? HP0 : 1400 * (1 + 0.04 * Math.min(CUBES, 10))) * Math.pow(1.15, PLATING)
  const regenDelay = M.regen_delay - 1.5 * NANITES
  const regenPer = M.regen_per_s * Math.pow(1.6, NANITES)
  let hp = MAXHP
  let quiet = 9
  let pending: any[] = []
  let s2 = seed * 104729 + 7
  const rnd2 = () => ((s2 = (Math.imul(s2, 1664525) + 1013904223) >>> 0) / 4294967296)
  out.mended = 0
  out.lowT = 0
  out.captured = 0
  let drop: { x: number; y: number; z: number; progress: number } | null = null
  if (DROP) {
    for (let q = 0; q < 2000 && !drop; q++) {
      const c = cells[Math.floor(rnd2() * cells.length)]
      const dx = nav.cx(c)
      const dy = nav.cy(c)
      const d = Math.hypot(dx - x, dy - y)
      if (d > 60 && d < 180 && Math.hypot(dx - zc[0], dy - zc[1]) < zr - 30 && wnav.snap(dx, dy, 1) >= 0) drop = { x: dx, y: dy, z: w.ground(dx, dy), progress: 0 }
    }
  }
  for (let k = 0; k < seconds * 10; k++) {
    const t = T0 + k * 0.1
    const z = w.ground(x, y)
    const eye = z + M.eye_height * SC
    const mechs: any[] = []
    const events: any[] = pending
    pending = []
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
        const rear = Math.abs(wrap(Math.atan2(q.y - y, q.x - x) - yaw)) > Math.PI / 2 ? (M.rear_mult ?? 1.5) : 1
        let dmg = theirDps(d, q.kind) * 0.1 * rear
        if (HEALTH) {
          // shot by shot
          const mult = process.env.HARD ? 1.4 : 1
          const bearing = Math.atan2(q.y - y, q.x - x)
          dmg = 0
          const G = C.weapons.gun
          if (!BULLETS && rnd2() < (G.mag / (G.mag * G.cooldown + G.reload)) * Math.min(1, step(d, gunTab()) * sizeMul(d)) * 0.1) {
            dmg += G.damage * mult
            events.push({ type: "damaged", amount: G.damage * mult, weapon: "gun", bearing, by: q.id })
          }
          const L = C.weapons.laser
          if (q.kind === "laser" && rnd2() < (Math.min(1, step(d, lasTab()) * sizeMul(d)) / (L.charge + L.cooldown)) * 0.1) {
            dmg += L.damage * mult
            events.push({ type: "damaged", amount: L.damage * mult, weapon: "laser", bearing, by: q.id })
          }
          const Z = C.weapons.lightning
          if (q.kind === "lightning" && d < Z.range) {
            const zd = (Z.damage / Z.cooldown) * 0.85 * 0.1 * mult
            dmg += zd
            events.push({ type: "damaged", amount: zd, weapon: "lightning", bearing, by: q.id })
          }
          dmg *= rear * (1 - 0.08 * ARMOR)
          if (dmg > 0) quiet = 0
          hp -= dmg
        }
        out.taken += dmg
        // where the damage comes from: by range, and from one we knew of or not, early or late in its approach
        // (a hit from outside the front half-circle of our torso does half as much again: rulebook rear_mult)
        if (Math.abs(wrap(Math.atan2(q.y - y, q.x - x) - yaw)) > Math.PI / 2) out.by.set("from behind", (out.by.get("from behind") ?? 0) + dmg)
        const bk = d < 45 ? "under 45 m" : d < 80 ? "45-80 m" : d < 120 ? "80-120 m" : "over 120 m"
        out.by.set(bk, (out.by.get(bk) ?? 0) + dmg)
        const listed = t - q.seenT <= 5
        if (q.firstT < 0 && listed) q.firstT = t
        const ph = !listed ? "from one not in our sight or memory" : t - q.firstT < 6 ? "in the 6 s after we first saw it" : "later"
        out.by.set(ph, (out.by.get(ph) ?? 0) + dmg)
        // a hit now and then tells the bot it is being shot at, and from where
        if (!HEALTH && rnd() < Math.min(0.9, theirDps(d, q.kind) / 450)) events.push({ type: "damaged", amount: 45, weapon: "gun", bearing: Math.atan2(q.y - y, q.x - x), by: q.id })
      }
      if (t - q.seenT <= 5) {
        const tv = q.path && q.pi < q.path.length / 2 ? 1 : 0
        mechs.push({ id: q.id, kind: "mech", pos: [q.x, q.y, qz], vel: [tv * (x - q.x) / Math.max(1, d) * 6, tv * (y - q.y) / Math.max(1, d) * 6, 0], aim: [Math.atan2(y - q.y, x - q.x), 0], hp: 1700, max_hp: 1700, cubes: 3, weapons: q.kind === "gun" ? ["gun"] : ["gun", q.kind], charging: false })
      }
    }
    const weapons: any[] = [
      { kind: "gun", cooldown: Math.max(0, gunCd), ammo, reload: Math.max(0, reload), stats: C.weapons.gun },
      GUNONLY ? null : LIGHT ? { kind: "lightning", cooldown: 0, stats: C.weapons.lightning } : { kind: "laser", cooldown: Math.max(0, lasCd), charge, stats: C.weapons.laser },
    ]
    const inZone = Math.hypot(x - zc[0], y - zc[1]) <= zr
    const obs = {
      ...base, tick: Math.round(t * 20), t, alive: 16, projectiles: bullets.filter((p) => p.life > 0 && (Math.hypot(p.x - x, p.y - y) <= 45 || (Math.hypot(p.x - x, p.y - y) <= 200 && Math.abs(wrap(Math.atan2(p.y - y, p.x - x) - yaw)) <= Math.PI / 3))).map((p) => ({ id: p.id, kind: "gun", pos: [p.x, p.y, p.z], vel: [p.vx, p.vy, p.vz] })), crates: [], cubes: [], pickups: [], sounds: [], beams: [], drops: drop ? [{ id: 20000, pos: [drop.x, drop.y, drop.z], radius: 8, lands_in: Math.max(0, DROPT - (t - T0)), capture_s: 4, progress: drop.progress, holder: null }] : [], offer: null, events,
      self: { ...base.self, pos: [x, y, z], vel: [vx, vy, 0], aim: [yaw, pitch], grounded: true, hp: HEALTH ? Math.max(1, hp) : 1400 * 1.24, max_hp: HEALTH ? MAXHP : 1400 * 1.24, energy, max_energy: 100, cubes: CUBES, in_zone: inZone, weapons, stats: { ...M, radius: M.radius * SC, height: M.height * SC, eye_height: M.eye_height * SC, muzzle_height: M.muzzle_height * SC } },
      mechs,
      zone: { center: zc, radius: zr, next_center: zc, next_radius: zr - 20, shrink_start: 900, shrink_end: 950, dps: 35 },
    }
    const a = b.act(obs)
    out.errors = b.errors
    if (firstSight < 0 && mechs.length) firstSight = t
    const early = firstSight >= 0 && t - firstSight < 20
    const d0 = out.dealt
    if (early) out.sec20 += 0.1
    if (process.env.DEEP && k >= Number(process.env.DEEP) * 10 && k < Number(process.env.DEEP) * 10 + 12) {
      const kt = b.kite
      const pth = b.path
      const nx = pth ? pth[2 * b.pathI] : NaN
      const ny = pth ? pth[2 * b.pathI + 1] : NaN
      console.log(`      k=${k} pos ${x.toFixed(1)},${y.toFixed(1)} vel ${vx.toFixed(1)},${vy.toFixed(1)} label ${b.label} move ${a.move} kite ${kt ? kt.x.toFixed(0) + "," + kt.y.toFixed(0) : "-"} path ${pth ? pth.length / 2 : 0} i=${b.pathI} next ${nx.toFixed(1)},${ny.toFixed(1)} botFree ${b.nav.free(x, y, 0)} testFree ${nav.free(x, y, -0.5)} clr ${w.clearance(x, y).toFixed(1)} snap ${b.nav.snap(x, y, 2)} unstuckT ${(b.unstuckT - t).toFixed(1)} rangeNow ${b.rangeNow} kiteGain ${b.kiteGain.toFixed(1)}`)
    }
    if (TRACE && k % 10 === 0) console.log(`    t=${(t - T0).toFixed(0).padStart(2)} pos ${x.toFixed(0)},${y.toFixed(0)} nearest ${near.toFixed(0)} m ${anyLos ? "LOS" : "   "} listed ${mechs.length} ${String(b.label).padEnd(7)} move ${a.move[0].toFixed(2)},${a.move[1].toFixed(2)} boost ${a.boost ? 1 : 0} e=${energy.toFixed(0)} fire ${a.fire[0] ? "G" : "-"}${a.fire[1] ? "L" : "-"} | ${walkers.map((q) => `${q.kind[0]}@${q.x.toFixed(0)},${q.y.toFixed(0)} d${Math.hypot(q.x - x, q.y - y).toFixed(0)}`).join(" ")}`)
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
    const cm = 1 + 0.04 * Math.min(CUBES, 10)
    const takenNow = out.taken
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
        if (HEALTH && tgt && rnd2() < ourGunAcc(tgtD)) {
          quiet = 0
          pending.push({ type: "hit", target: tgt.id, amount: C.weapons.gun.damage * cm, weapon: "gun" })
        }
      }
      if (LIGHT) {
        // lightning: no aim beyond the cone, 60 damage every quarter second while a target is in reach and the tank lasts
        if (a.fire[1] && energy >= 3 && tgt && tgtD <= C.weapons.lightning.range) {
          out.dealt += (C.weapons.lightning.damage / C.weapons.lightning.cooldown) * dt * cm
          energy = Math.max(0, energy - (C.weapons.lightning.energy / C.weapons.lightning.cooldown) * dt)
          since = 0
        }
      } else if (a.fire[1] && lasCd <= 0) charge = Math.min(charge + dt, C.weapons.laser.charge + C.weapons.laser.hold_s)
      if (charge > 0 && (!a.fire[1] || charge >= C.weapons.laser.charge + C.weapons.laser.hold_s)) {
        // one beam, at whatever charge it had, if it was let go on a target
        if (tgt && tgtD <= 280) out.dealt += C.weapons.laser.damage * (0.35 + 0.65 * Math.min(1, charge / C.weapons.laser.charge)) * 0.95 * cm
        if (HEALTH && tgt && tgtD <= 280 && rnd2() < 0.95) {
          quiet = 0
          pending.push({ type: "hit", target: tgt.id, amount: C.weapons.laser.damage * (0.35 + 0.65 * Math.min(1, charge / C.weapons.laser.charge)) * cm, weapon: "laser" })
        }
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
        if (BULLETS) {
          // its gun: the real cadence, a full lead on our velocity, and the aiming error
          const G = C.weapons.gun
          let g = guns.get(q.id)
          if (!g) guns.set(q.id, (g = { cd: rnd2() * G.cooldown, ammo: G.mag, reload: 0 }))
          g.cd -= dt
          if (g.reload > 0) {
            g.reload -= dt
            if (g.reload <= 0) g.ammo = G.mag
          } else if (los && g.cd <= 0) {
            g.cd = G.cooldown
            if (--g.ammo === 0) g.reload = G.reload
            const gz = qz + M.muzzle_height
            const tf = d / G.speed
            const ax = x + vx * tf - q.x
            const ay = y + vy * tf - q.y
            const az = w.ground(x, y) + (M.height * SC) / 2 - gz
            const yw = Math.atan2(ay, ax) + gauss() * SIGMA
            const pt = Math.atan2(az, Math.hypot(ax, ay)) + gauss() * SIGMA
            bullets.push({ id: nextBullet++, x: q.x, y: q.y, z: gz, vx: Math.cos(pt) * Math.cos(yw) * G.speed, vy: Math.cos(pt) * Math.sin(yw) * G.speed, vz: Math.sin(pt) * G.speed, life: G.range / G.speed, by: q.id, d0: d })
          }
        }
        if (los && d <= 50) continue
        const tt = T0 + k * 0.1 + sub * dt
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
    if (BULLETS) {
      // bullets fly on in small steps; walls and the ground stop them, our body takes them
      const fz = w.ground(x, y)
      const R = M.radius * SC + 0.3
      for (const p of bullets) {
        if (p.life <= 0) continue
        for (let qq = 0; qq < 50 && p.life > 0; qq++) {
          const h = 0.1 / 50
          p.x += p.vx * h
          p.y += p.vy * h
          p.z += p.vz * h
          p.life -= h
          if (!w.inGrid(p.x, p.y) || p.z < w.surface(p.x, p.y)) p.life = 0
          else if (Math.hypot(p.x - x, p.y - y) <= R && p.z >= fz && p.z <= fz + M.height * SC) {
            p.life = 0
            const bearing = Math.atan2(-p.vy, -p.vx)
            const rear = Math.abs(wrap(bearing - yaw)) > Math.PI / 2 ? (M.rear_mult ?? 1.5) : 1
            const dmg = C.weapons.gun.damage * (process.env.HARD ? 1.4 : 1) * rear * (1 - 0.08 * ARMOR)
            hp -= dmg
            quiet = 0
            out.taken += dmg
            if (rear > 1) out.by.set("from behind", (out.by.get("from behind") ?? 0) + dmg)
            const bk = p.d0 < 45 ? "under 45 m" : p.d0 < 80 ? "45-80 m" : p.d0 < 120 ? "80-120 m" : "over 120 m"
            out.by.set(bk, (out.by.get(bk) ?? 0) + dmg)
            pending.push({ type: "damaged", amount: dmg, weapon: "gun", bearing, by: p.by, rear: rear > 1 })
          }
        }
      }
      for (let i = bullets.length - 1; i >= 0; i--) if (bullets[i].life <= 0) bullets.splice(i, 1)
    }
    if (drop && t - T0 >= DROPT) {
      // alone in the ring for four seconds: whole again
      const inRing = Math.hypot(x - drop.x, y - drop.y) <= 8
      const crowd = walkers.some((q) => Math.hypot(q.x - drop!.x, q.y - drop!.y) <= 8)
      if (!inRing) drop.progress = 0
      else if (!crowd) drop.progress += 0.1
      if (drop.progress >= 4) {
        hp = MAXHP
        energy = 100
        out.captured = 1
        drop = null
      }
    }
    if (HEALTH) {
      quiet += 0.1
      if (quiet >= regenDelay && inZone && hp < MAXHP) {
        const up = Math.min(MAXHP - hp, regenPer * 0.1)
        hp += up
        out.mended += up
      }
      if (hp < 0.5 * MAXHP) out.lowT += 0.1
      if (hp <= 0) {
        out.deadT = t - T0
        out.dealtAtDeath = out.dealt
        break
      }
    } else if (out.deadT < 0 && out.taken >= HP0) {
      out.deadT = t - T0
      out.dealtAtDeath = out.dealt
    }
    if (early) {
      out.dealt20 += out.dealt - d0
      out.taken20 += takenNow - (out.takenPrev ?? 0)
    }
    out.takenPrev = takenNow
  }
  return out
}

const N = Number(process.argv[2] ?? 12)
const SEC = Number(process.argv[3] ?? 60)
console.log(`${TUNING.brawl ? "brawler switch" : TUNING.standoff ? "stand-off movement" : "old close-range movement"}; ${N} trials of ${SEC} s per row; dummies start 180-320 m away`)
const ROWS = (process.env.ROWS ? process.env.ROWS.split(",").map((r) => [Number(r.slice(0, -1)), r.endsWith("f")]) : [[1, false], [1, true], [2, false], [3, false], [3, true]]) as [number, boolean][]
const FIRST = Number(process.env.FIRST ?? 1)
for (const [nWalk, fast] of ROWS) {
  const tot = { ticks: 0, near45: 0, near80: 0, near120: 0, far150: 0, sumNear: 0, los: 0, fire: 0, dealt: 0, taken: 0, outZone: 0, errors: 0, minNear: 0, dealt20: 0, taken20: 0, sec20: 0 }
  const labels = new Map<string, number>()
  const by = new Map<string, number>()
  const deadTs: number[] = []
  const dealtBy: number[] = []
  let mended = 0
  let lowT = 0
  let downs = 0
  let captured = 0
  const capDealt: number[] = []
  const missDealt: number[] = []
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((p, q) => p + q, 0) / a.length) : 0)
  for (let sd = FIRST; sd < FIRST + N; sd++) {
    const r = run(sd, nWalk, fast, SEC)
    for (const [k, v] of r.by) by.set(k, (by.get(k) ?? 0) + v)
    captured += r.captured
    ;(r.captured ? capDealt : missDealt).push(r.deadT < 0 ? r.dealt : r.dealtAtDeath)
    mended += r.mended / N
    lowT += r.lowT / N
    if (r.deadT >= 0) downs++
    deadTs.push(r.deadT < 0 ? SEC : r.deadT)
    dealtBy.push(r.deadT < 0 ? r.dealt : r.dealtAtDeath)
    for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += k === "minNear" ? r.minNear / N : (r as any)[k]
    for (const [k, v] of r.labels) labels.set(k, (labels.get(k) ?? 0) + v)
  }
  const pct = (v: number) => `${Math.round((100 * v) / tot.ticks)}%`
  const top = [...labels].sort((p, q) => q[1] - p[1]).slice(0, 5).map(([k, v]) => `${k} ${Math.round((100 * v) / tot.ticks)}%`).join(", ")
  console.log(
    `${nWalk} ${fast ? "fast" : "slow"} dummy${nWalk > 1 ? "s" : ""}: nearest on average ${Math.round(tot.sumNear / tot.ticks)} m (closest it got, mean over trials: ${Math.round(tot.minNear)} m); time with one inside 45 m ${pct(tot.near45)}, inside 80 m ${pct(tot.near80)}, inside 120 m ${pct(tot.near120)}, all beyond 150 m ${pct(tot.far150)}; a line of fire ${pct(tot.los)} of the time, firing on target ${pct(tot.fire)}; outside the circle ${pct(tot.outZone)}` +
      `\n    exchange at measured hit rates: we deal ${Math.round((tot.dealt / tot.ticks) * 10)} per second and take ${Math.round((tot.taken / tot.ticks) * 10)}: ${(tot.dealt / Math.max(1, tot.taken)).toFixed(1)} to 1${tot.errors ? "; THINK ERRORS " + tot.errors : ""}; by the time ${HP0} had been taken (median ${[...deadTs].sort((p, q) => p - q)[deadTs.length >> 1].toFixed(0)} s in): dealt ${Math.round(dealtBy.reduce((p, q) => p + q, 0) / dealtBy.length)} on average; in the 20 s after first sight: deal ${Math.round(tot.dealt20 / Math.max(1, tot.sec20))} per second, take ${Math.round(tot.taken20 / Math.max(1, tot.sec20))}\n    damage taken, by range: ${["under 45 m", "45-80 m", "80-120 m", "over 120 m"].map((k) => `${k} ${Math.round((100 * (by.get(k) ?? 0)) / Math.max(1, tot.taken))}%`).join(", ")}; from behind our torso ${Math.round((100 * (by.get("from behind") ?? 0)) / Math.max(1, tot.taken))}%; by when: ${["from one not in our sight or memory", "in the 6 s after we first saw it", "later"].map((k) => `${k} ${Math.round((100 * (by.get(k) ?? 0)) / Math.max(1, tot.taken))}%`).join(", ")}\n    legs: ${top}` +
      (HEALTH ? `\n    WITH HEALTH (mend at ${TUNING.mend}): down in ${downs} of ${N} trials, median time alive ${[...deadTs].sort((p, q) => p - q)[deadTs.length >> 1].toFixed(0)} s; dealt before going down or the end ${Math.round(dealtBy.reduce((p, q) => p + q, 0) / dealtBy.length)}; mended ${Math.round(mended)} health per trial; ${lowT.toFixed(0)} s per trial under half health${DROP ? `; drop captured in ${captured} of ${N} (dealt ${avg(capDealt)} with it, ${avg(missDealt)} without)` : ""}` : ""),
  )
}
