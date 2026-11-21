/**
 * Loot check: the bot alone on the map with weapons and crates scattered as the config describes
 * (a quarter on roofs), shown to it only when its eyes or proximity sensors would see them. Same
 * rough movement rules as tools/walk.ts; crates take damage when the gun is fired on line. Reports
 * how soon it holds a second weapon, how many cubes it gathers, and what the zone costs it.
 * The twelve drones are there too (they shoot whoever comes within 45 m or attacks them, 25 damage a
 * second, and drop two cubes), and health repairs by the documented rule. No mechs.
 *   node tools/loottest.ts [matches]
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Brain, TUNING } from "../src/bot.ts"

// DROPS=1 switches the bot's supply-drop behaviour on and makes the three drops fall
if (process.env.DROPS) TUNING.drops = true

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const msgs = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l))
const hello = msgs[0]
hello.map.dir = join(root, "kit/arena")
const base = msgs.find((m: any) => m.type === "obs")
const C = hello.config
const M = C.mech

const stuckBy = new Map<string, number>()
const cpuMs: number[] = []
const slow: string[] = []
const TRACE = process.argv[3] !== undefined ? 100 + Number(process.argv[3]) : -1

function tour(seed: number) {
  let s = seed >>> 0
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
  const b: any = new Brain({ ...hello, seed, entropy: 7 })
  if (process.env.FFA) b.ffa = true // free-for-all mode from the first tick
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
  // --- loot, placed like the config says
  const openPoint = (): number[] => {
    for (;;) {
      const px = w.bMinX + 5 + rnd() * (w.bMaxX - w.bMinX - 10)
      const py = w.bMinY + 5 + rnd() * (w.bMaxY - w.bMinY - 10)
      if (nav.free(px, py, 1) && nav.inMain(px, py)) return [px, py, w.ground(px, py)]
    }
  }
  const roofPoint = (): number[] => {
    for (;;) {
      const px = w.bMinX + rnd() * (w.bMaxX - w.bMinX)
      const py = w.bMinY + rnd() * (w.bMaxY - w.bMinY)
      const f = w.idx(px, py)
      const h = w.surf[f] - w.terr[f]
      if (h < 4 || h > 55) continue
      let flat = true
      for (let q = 0; flat && q < 8; q++) if (Math.abs(w.surface(px + Math.cos(q * 0.785) * 3, py + Math.sin(q * 0.785) * 3) - w.surf[f]) > 0.5) flat = false
      if (flat) return [px, py, w.surf[f]]
    }
  }
  const kinds = ["mortar", "laser", "lightning"]
  let nextPick = 8000
  let nextCube = 5000
  const pickups: { id: number; kind: string; x: number; y: number; z: number }[] = []
  for (let i = 0; i < C.loot.floor_count; i++) {
    const q = rnd() < C.loot.floor_roof_fraction ? roofPoint() : openPoint()
    pickups.push({ id: nextPick++, kind: kinds[Math.floor(rnd() * 3)], x: q[0], y: q[1], z: q[2] })
  }
  const crates: { id: number; x: number; y: number; z: number; hp: number }[] = []
  for (let i = 0; i < C.crates.count; i++) {
    const q = rnd() < C.crates.roof_fraction ? roofPoint() : openPoint()
    crates.push({ id: 1000 + i, x: q[0], y: q[1], z: q[2], hp: C.crates.hp })
  }
  const cubesOnGround: { id: number; x: number; y: number; z: number }[] = []
  const drones: { id: number; x: number; y: number; z: number; hp: number; cd: number; angry: boolean }[] = []
  for (let i = 0; i < C.npc.count; i++) {
    const q = openPoint()
    drones.push({ id: 100 + i, x: q[0], y: q[1], z: q[2], hp: C.npc.hp, cd: 0, angry: false })
  }
  let hp = M.hp
  let maxHp = M.hp
  let quietT = -99 // last time we dealt or took damage
  let minHp = M.hp
  let droneDmg = 0
  let dronesKilled = 0
  let hurtSec = 0
  let yaw = 0
  let pitch = 0
  let second: string | null = null
  let secondT = -1
  let swaps = 0
  let laserT = -1
  let secondRoof = false
  let cubes = 0
  let ammo = C.weapons.gun.mag
  let gunCd = 0
  let reload = 0
  let offer: any = null
  const cubesAt: number[] = []
  let cratesDone = 0
  let roofSec = 0
  let events: any[] = []
  const sees = (ix: number, iy: number, iz: number) => {
    const dx = ix - x
    const dy = iy - y
    const dd = Math.hypot(dx, dy)
    if (dd > C.vision.near_range) {
      if (dd > C.vision.range) return false
      let da = Math.atan2(dy, dx) - yaw
      da = Math.atan2(Math.sin(da), Math.cos(da))
      if (Math.abs(da) > (C.vision.fov_deg * Math.PI) / 360) return false
    }
    return w.los(x, y, z + 8, ix, iy, iz + 1)
  }
  const drops: { id: number; x: number; y: number; z: number; landT: number; progress: number }[] = []
  let dropsCalled = 0
  let captured = 0
  let lost = 0
  let lostBy: number[] = [0, 0, 0, 0, 0, 0, 0]
  let outSec = 0
  const labels = new Map<string, number>()
  let prevLabel = ""
  let prevMove = ""
  let t = 0
  // stop when the last circle starts closing to nothing: after that everyone is outside
  const endT = C.zone.phases.slice(0, 5).reduce((q: number, p: any) => q + p.hold_s + p.shrink_s, 0) + C.zone.phases[5].hold_s
  while (t < endT) {
    const inZone = Math.hypot(x - zc[0], y - zc[1]) <= zr
    const weapons: any[] = [{ kind: "gun", cooldown: Math.max(0, gunCd), ammo, reload: Math.max(0, reload), stats: C.weapons.gun }, second ? { kind: second, cooldown: 0, charge: 0, stats: C.weapons[second] } : null]
    const obs = {
      ...base, tick: Math.round(t * 20), t, projectiles: [], sounds: [], beams: [], offer,
      mechs: drones.filter((d) => sees(d.x, d.y, d.z + 1)).map((d) => ({ id: d.id, kind: "npc", pos: [d.x, d.y, d.z], vel: [0, 0, 0], aim: [0, 0], hp: d.hp, max_hp: C.npc.hp })),
      drops: drops.map((d) => ({ id: d.id, pos: [d.x, d.y, d.z], radius: C.drops.radius, lands_in: Math.max(0, d.landT - t), capture_s: C.drops.capture_s, progress: d.progress, holder: d.progress > 0 ? 3 : null })),
      crates: crates.filter((c) => sees(c.x, c.y, c.z)).map((c) => ({ id: c.id, pos: [c.x, c.y, c.z], hp: c.hp })),
      cubes: cubesOnGround.filter((c) => sees(c.x, c.y, c.z)).map((c) => ({ id: c.id, pos: [c.x, c.y, c.z] })),
      pickups: pickups.filter((c) => sees(c.x, c.y, c.z)).map((c) => ({ id: c.id, kind: c.kind, pos: [c.x, c.y, c.z] })),
      events,
      self: { ...base.self, pos: [x, y, z], vel: [vx, vy, vz], aim: [yaw, pitch], grounded, energy, max_energy: M.energy, hp, max_hp: maxHp, cubes, in_zone: inZone, weapons, stats: { ...M, radius: M.radius * (1 + 0.05 * cubes), height: M.height * (1 + 0.05 * cubes) } },
      zone: { center: [zc[0], zc[1]], radius: zr, next_center: [next.x, next.y], next_radius: next.r, shrink_start: zs, shrink_end: ze, dps },
    }
    const c0 = process.cpuUsage()
    const a = b.act(obs)
    const c1 = process.cpuUsage(c0)
    cpuMs.push((c1.user + c1.system) / 1000)
    if ((c1.user + c1.system) / 1000 > 8) slow.push(`${((c1.user + c1.system) / 1000).toFixed(1)} ms at t=${t.toFixed(1)} label ${b.label} cubes ${cubes} A* expanded ${nav.expanded} levels ${nav.levels?.size} pathAge ${(t - b.pathT).toFixed(1)}`)
    labels.set(b.label, (labels.get(b.label) ?? 0) + 1)
    if (b.label === "unstuck" && prevLabel !== "unstuck") {
      stuckBy.set(prevLabel, (stuckBy.get(prevLabel) ?? 0) + 1)
      if (process.env.STUCK && stuckBy.get(prevLabel)! <= 3) console.log(`    stuck t=${t.toFixed(0)} while "${prevLabel}" at ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)} clearance ${w.clearance(x, y).toFixed(1)} roof ${(w.surface(x, y) - w.ground(x, y)).toFixed(1)} grounded ${grounded} lastMove ${prevMove} goal ${b.explore ? b.explore.x.toFixed(0) + "," + b.explore.y.toFixed(0) : "-"} path ${b.path ? b.pathI + "/" + b.path.length / 2 : "none"}`)
    }
    prevLabel = b.label
    prevMove = `${a.move}`
    events = []
    if (offer && Number.isInteger(a.pick)) {
      events.push({ type: "upgrade", id: offer.choices[a.pick]?.id })
      offer = null
    }
    if (Number.isInteger(a.take)) {
      const pk = pickups.find((q) => q.id === a.take)
      if (!pk) events.push({ type: "take_failed", id: a.take, reason: "gone" })
      else if (Math.hypot(pk.x - x, pk.y - y) > C.loot.pickup_radius || Math.abs(pk.z - z) > 4) events.push({ type: "take_failed", id: a.take, reason: "range" })
      else if (second && second === pk.kind) events.push({ type: "take_failed", id: a.take, reason: "have" })
      else if (second && a.drop !== 1) events.push({ type: "take_failed", id: a.take, reason: "full" })
      else {
        if (second) {
          // a swap: the old weapon stays on the ground at our feet as a new pickup
          const old = { id: nextPick++, kind: second, x, y, z }
          pickups.push(old)
          events.push({ type: "dropped", id: old.id, kind: second, slot: 1 })
          swaps++
        } else secondT = t
        second = pk.kind
        if (second === "laser" && laserT < 0) laserT = t
        if (secondT === t) secondRoof = pk.z - w.ground(pk.x, pk.y) > 2.5
        pickups.splice(pickups.indexOf(pk), 1)
        events.push({ type: "took", id: pk.id, kind: pk.kind, slot: 1 })
      }
    }
    if (process.env.DROPS && dropsCalled < C.drops.times.length && t >= C.drops.times[dropsCalled]) {
      dropsCalled++
      for (;;) {
        const a2 = rnd() * 6.283
        const d2 = Math.sqrt(rnd()) * next.r * C.drops.spread
        const dx = next.x + Math.cos(a2) * d2
        const dy = next.y + Math.sin(a2) * d2
        if (nav.free(dx, dy, 1) && nav.inMain(dx, dy)) {
          drops.push({ id: 20000 + dropsCalled, x: dx, y: dy, z: w.ground(dx, dy), landT: t + C.drops.fall_s, progress: 0 })
          break
        }
      }
    }
    for (const d of [...drops]) {
      if (t < d.landT) continue
      if (Math.hypot(d.x - x, d.y - y) <= C.drops.radius) {
        d.progress += 0.1
        if (d.progress >= C.drops.capture_s) {
          drops.splice(drops.indexOf(d), 1)
          captured++
          cubes += C.drops.cubes
          events.push({ type: "drop", id: d.id, cubes })
        }
      } else d.progress = 0
    }
    if (z - w.ground(x, y) > 2.5 && grounded) roofSec += 0.1
    if (Math.round(t * 10) % 600 === 0) cubesAt.push(cubes)
    if (TRACE === seed && t > Number(process.argv[4] ?? 300) && Math.round(t * 10) % Number(process.argv[5] ?? 20) === 0) {
      const f = w.idx(next.x, next.y)
      console.log(`    t=${t.toFixed(0)} pos ${x.toFixed(0)},${y.toFixed(0)},${z.toFixed(1)} ${grounded ? "gnd" : "air"} e=${energy.toFixed(0)} ${b.label.padEnd(8)} move ${a.move} b=${a.boost ? 1 : 0} j=${a.jump ? 1 : 0} | circle r=${zr.toFixed(0)} dist ${Math.hypot(x - zc[0], y - zc[1]).toFixed(0)} ${inZone ? "in " : "OUT"} | next r=${next.r} at ${next.x.toFixed(0)},${next.y.toFixed(0)} dist ${Math.hypot(x - next.x, y - next.y).toFixed(0)} roof there ${(w.surf[f] - w.terr[f]).toFixed(0)} m, clearance ${w.dist[f].toFixed(0)} m | goal ${b.zoneNow ? b.zoneNow.gx.toFixed(0) + "," + b.zoneNow.gy.toFixed(0) : "-"} urgent ${b.zoneNow?.urgent ? 1 : 0} overTop ${b.overTop ? 1 : 0} noHop ${(b.noHopUntil - t).toFixed(0)} path ${b.path ? b.path.length / 2 : 0}`)
    }
    for (let sub = 0; sub < 2; sub++) {
      const dt = 0.05
      // torso and gun: a shot fired on line with a crate, with nothing in the way, hits it
      let dyaw = a.aim[0] - yaw
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw))
      yaw += Math.max(-M.turn_rate * dt, Math.min(M.turn_rate * dt, dyaw))
      pitch += Math.max(-M.pitch_rate * dt, Math.min(M.pitch_rate * dt, a.aim[1] - pitch))
      gunCd -= dt
      if (reload > 0) {
        reload -= dt
        if (reload <= 0) ammo = C.weapons.gun.mag
      } else if (a.reload && ammo < C.weapons.gun.mag) reload = C.weapons.gun.reload
      else if (a.fire[0] && gunCd <= 0 && ammo > 0) {
        gunCd = C.weapons.gun.cooldown
        if (--ammo === 0) reload = C.weapons.gun.reload
        const dirx = Math.cos(pitch) * Math.cos(yaw)
        const diry = Math.cos(pitch) * Math.sin(yaw)
        const dirz = Math.sin(pitch)
        let hitC: (typeof crates)[number] | null = null
        let hd = C.weapons.gun.range
        for (const c of crates) {
          const rx = c.x - x
          const ry = c.y - y
          const rz = c.z + 1.2 - (z + 7)
          const along = rx * dirx + ry * diry + rz * dirz
          if (along <= 0 || along > hd) continue
          const off = Math.hypot(rx - dirx * along, ry - diry * along, rz - dirz * along)
          if (off <= C.crates.radius + 0.3 && w.los(x, y, z + 7, c.x, c.y, c.z + 1.2, 1)) {
            hd = along
            hitC = c
          }
        }
        let hitD: (typeof drones)[number] | null = null
        for (const d of drones) {
          const rx = d.x - x
          const ry = d.y - y
          const rz = d.z + 1.75 - (z + 7)
          const along = rx * dirx + ry * diry + rz * dirz
          if (along <= 0 || along > hd) continue
          const off = Math.hypot(rx - dirx * along, ry - diry * along, rz - dirz * along)
          if (off <= C.npc.radius + 0.3 && w.los(x, y, z + 7, d.x, d.y, d.z + 1.75, 1)) {
            hd = along
            hitD = d
            hitC = null
          }
        }
        if (hitD) {
          hitD.hp -= C.weapons.gun.damage * (1 + 0.04 * Math.min(cubes, 10))
          hitD.angry = true
          quietT = t
          events.push({ type: "hit", target: hitD.id, amount: C.weapons.gun.damage, weapon: "gun" })
          if (hitD.hp <= 0) {
            drones.splice(drones.indexOf(hitD), 1)
            dronesKilled++
            for (let q = 0; q < C.npc.cubes; q++) cubesOnGround.push({ id: nextCube++, x: hitD.x + q, y: hitD.y, z: hitD.z })
          }
        }
        if (hitC) {
          quietT = t
          hitC.hp -= C.weapons.gun.damage * (1 + 0.04 * Math.min(cubes, 10))
          events.push({ type: "hit", target: hitC.id, amount: C.weapons.gun.damage, weapon: "gun" })
          if (hitC.hp <= 0) {
            crates.splice(crates.indexOf(hitC), 1)
            cratesDone++
            cubesOnGround.push({ id: nextCube++, x: hitC.x, y: hitC.y, z: hitC.z })
            if (rnd() < C.loot.crate_weapon_chance) pickups.push({ id: nextPick++, kind: kinds[Math.floor(rnd() * 3)], x: hitC.x + 1, y: hitC.y, z: hitC.z })
          }
        }
      }
      for (const c of [...cubesOnGround])
        if (Math.hypot(c.x - x, c.y - y) <= C.cubes.pickup_radius && Math.abs(c.z - z) <= 4) {
          cubesOnGround.splice(cubesOnGround.indexOf(c), 1)
          cubes++
          if (cubes <= 10) {
            maxHp += M.hp * 0.04
            hp += M.hp * 0.04
          }
          events.push({ type: "pickup", cubes })
          if (C.cubes.upgrade_thresholds.includes(cubes) && !offer) offer = { id: cubes, expires: t + 5, choices: [0, 1, 2].map((q) => C.upgrades[(cubes * 3 + q * 5) % 9]) }
        }
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
      for (const d of drones) {
        d.cd -= dt
        const dd = Math.hypot(d.x - x, d.y - y)
        if ((dd <= C.npc.aggro_range || (d.angry && dd <= C.npc.deaggro_range)) && d.cd <= 0 && w.los(d.x, d.y, d.z + 2, x, y, z + 4.5)) {
          d.cd = C.npc.cooldown
          // 2.5 degrees of spread against a 2.5 m wide target
          const sigma = dd * 0.0436
          if (Math.abs(sigma * Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(6.283 * rnd())) <= 2.8) {
            hp -= C.npc.damage
            droneDmg += C.npc.damage
            quietT = t
            events.push({ type: "damaged", amount: C.npc.damage, weapon: "npc", bearing: Math.atan2(d.y - y, d.x - x), by: d.id })
          }
        }
      }
      if (Math.hypot(x - zc[0], y - zc[1]) > zr) quietT = t
      else if (t - quietT >= M.regen_delay) hp = Math.min(maxHp, hp + M.regen_per_s * dt)
      if (hp < minHp) minHp = hp
      if (hp < 0.75 * maxHp) hurtSec += dt
      if (Math.hypot(x - zc[0], y - zc[1]) > zr) {
        lost += dps * dt
        lostBy[phase] += dps * dt
        outSec += dt
      }
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
  return { lost, outSec, lostBy, errors: b.errors as number, labels, endDist: Math.hypot(x - zc[0], y - zc[1]), zr, second, secondT, secondRoof, swaps, laserT, cubes, cubesAt, cratesDone, roofSec, captured, minHp, droneDmg, dronesKilled, hurtSec }
}

const N = Number(process.argv[2] ?? 12)
const ONLY = process.argv[3] !== undefined ? Number(process.argv[3]) : -1
let worst = 0
let total = 0
let bad = 0
const byPhase = [0, 0, 0, 0, 0, 0, 0]
let errors = 0
const lab = new Map<string, number>()
const got: number[] = []
let none = 0
let roofTaken = 0
const kindsGot = new Map<string, number>()
let swapRuns = 0
const laserTs: number[] = []
const cubeSum = [0, 0, 0, 0, 0, 0, 0]
let crateSum = 0
let dropSum = 0
let droneKillSum = 0
let droneDmgSum = 0
let hurtSum = 0
let lowest = 1e9
let roofSecSum = 0
let ran = 0
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
  ran++
  if (r.second) {
    got.push(r.secondT)
    kindsGot.set(r.second, (kindsGot.get(r.second) ?? 0) + 1)
    if (r.secondRoof) roofTaken++
    if (r.swaps) swapRuns++
    if (r.laserT >= 0) laserTs.push(r.laserT)
  } else none++
  r.cubesAt.forEach((v: number, k: number) => (cubeSum[k] += v))
  crateSum += r.cratesDone
  dropSum += r.captured
  droneKillSum += r.dronesKilled
  droneDmgSum += r.droneDmg
  hurtSum += r.hurtSec
  lowest = Math.min(lowest, r.minHp)
  roofSecSum += r.roofSec
  errors += r.errors
  for (const [k, v] of r.labels) lab.set(k, (lab.get(k) ?? 0) + v)
}
got.sort((p, q) => p - q)
const pc = (f: number) => (got.length ? got[Math.min(got.length - 1, Math.floor(f * got.length))].toFixed(0) : "-")
console.log(`second weapon: held in ${got.length}/${ran} runs (never in ${none}); picked up after ${pc(0.25)} s / ${pc(0.5)} s / ${pc(0.9)} s (quartile / median / 90th percentile); ${roofTaken} came from a roof; kinds held at the end ${[...kindsGot].map(([k, v]) => `${k} ${v}`).join(", ")}; swapped for a laser in ${swapRuns} runs; laser in hand after ${laserTs.length ? [...laserTs].sort((a, b) => a - b).filter((_, i, v) => i === (v.length >> 1) || i === Math.floor(v.length * 0.9)).map((v) => v.toFixed(0) + " s").join(" / ") : "-"} (median / 90th percentile, ${laserTs.length} runs)`)
console.log(`cubes held at 60/120/180/240 s: ${[1, 2, 3, 4].map((k) => (cubeSum[k] / ran).toFixed(1)).join(" / ")}; crates destroyed per run ${(crateSum / ran).toFixed(1)}; seconds spent on roofs per run ${(roofSecSum / ran).toFixed(0)}${process.env.DROPS ? `; supply drops captured per run ${(dropSum / ran).toFixed(2)} of 3` : ""}`)
console.log(`drones: killed ${(droneKillSum / ran).toFixed(1)} of 12 per run, their fire cost ${(droneDmgSum / ran).toFixed(0)} HP per run; time below three-quarter health ${(hurtSum / ran).toFixed(0)} s per run; lowest health seen ${lowest.toFixed(0)}`)
console.log(`${N} matches alone, up to the last circle's collapse: average ${(total / N).toFixed(0)} HP lost to the zone, worst ${worst.toFixed(0)}, matches losing over 50 HP: ${bad}; think errors ${errors}`)
console.log(`  lost per circle (sum): ${byPhase.slice(0, 6).map((v) => v.toFixed(0)).join(" / ")}`)
console.log(`  got stuck while: ${[...stuckBy].map(([k, v]) => `${k} ${v}`).join(", ")}`)
console.log("  ticks over 8 ms:\n    " + slow.slice(0, 14).join("\n    "))
cpuMs.sort((p, q) => p - q)
console.log(`  CPU per decision over ${cpuMs.length} ticks: median ${cpuMs[cpuMs.length >> 1].toFixed(2)} ms, 99th percentile ${cpuMs[Math.floor(cpuMs.length * 0.99)].toFixed(2)} ms, 99.9th ${cpuMs[Math.floor(cpuMs.length * 0.999)].toFixed(2)} ms, worst ${cpuMs[cpuMs.length - 1].toFixed(2)} ms (limit 50 ms wall)`)
console.log(`  legs: ${[...lab].sort((p, q) => q[1] - p[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(", ")}`)
