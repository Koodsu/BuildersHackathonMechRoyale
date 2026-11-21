/**
 * Dodge check, the mirror of aimtest: a gun that keeps a fixed distance fires at the bot at the real
 * cadence, and we count how many bullets hit while the bot moves the way it does in a fight. The gun
 * aims either at where the bot is, or with a full lead. Lasers are not modelled (they cannot be dodged).
 *   node tools/dodgetest.ts [dir holding src/bot.ts]
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const dir = process.argv[2] ? resolve(process.argv[2]) : root
const { Brain } = await import(pathToFileURL(join(dir, "src/bot.ts")).href)
const msgs = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l))
const hello = msgs[0]
hello.map.dir = join(root, "kit/arena")
const base = msgs.find((m: any) => m.type === "obs")
const C = hello.config
const M = C.mech

function run(dist: number, lead: number, second: string | null, seconds: number, seed: number) {
  const b: any = new Brain({ ...hello, seed })
  const w = b.w
  // the most open ground on the map, found by the aim test: -329,-142
  let x = -329
  let y = -142
  let vx = 0
  let vy = 0
  let yaw = 0
  let energy = 100
  let since = 9
  let ex = x + dist
  let ey = y
  let cd = 0
  let ammo = 12
  let reload = 0
  let shots = 0
  let hits = 0
  let path = 0
  const bullets: { x: number; y: number; vx: number; vy: number; life: number }[] = []
  for (let k = 0; k < seconds * 10; k++) {
    const t = 20 + k * 0.1
    const z = w.ground(x, y)
    const weapons: any[] = [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: C.weapons.gun }, second ? { kind: second, cooldown: 0, charge: 0, stats: C.weapons[second] } : null]
    const obs = {
      ...base, tick: Math.round(t * 20), t, projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], drops: [], offer: null,
      events: k % 10 === 0 ? [{ type: "damaged", amount: 1, weapon: "gun", bearing: Math.atan2(ey - y, ex - x), by: 9 }] : [],
      self: { ...base.self, pos: [x, y, z], vel: [vx, vy, 0], aim: [yaw, 0], grounded: true, hp: 1400, max_hp: 1400, energy, max_energy: 100, cubes: 0, in_zone: true, weapons, stats: { ...M } },
      mechs: [{ id: 9, kind: "mech", pos: [ex, ey, w.ground(ex, ey)], vel: [vx, vy, 0], aim: [Math.atan2(y - ey, x - ex), 0], hp: 1400, max_hp: 1400, cubes: 0, weapons: ["gun"], charging: false }],
      zone: { center: [41, -73], radius: 560, next_center: [41, -73], next_radius: 380, shrink_start: 600, shrink_end: 650, dps: 20 },
    }
    const a = b.act(obs)
    yaw = a.aim[0]
    for (let sub = 0; sub < 2; sub++) {
      const dt = 0.05
      const run = a.boost && energy > 0 && Math.hypot(a.move[0], a.move[1]) > 0.1
      const sp = run ? M.boost_speed : M.walk_speed
      if (run) {
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
      x += vx * dt
      y += vy * dt
      path += Math.hypot(vx, vy) * dt
      // the gun stays `dist` away on the same bearing, as an enemy holding its range would
      const bx = ex - x
      const by = ey - y
      const bl = Math.hypot(bx, by) || 1
      ex = x + (bx / bl) * dist
      ey = y + (by / bl) * dist
      cd -= dt
      if (reload > 0) {
        reload -= dt
        if (reload <= 0) ammo = 12
      } else if (cd <= 0) {
        cd = C.weapons.gun.cooldown
        if (--ammo === 0) reload = C.weapons.gun.reload
        shots++
        const tf = (dist / C.weapons.gun.speed) * lead
        const ax = x + vx * tf - ex
        const ay = y + vy * tf - ey
        const al = Math.hypot(ax, ay)
        bullets.push({ x: ex, y: ey, vx: (ax / al) * C.weapons.gun.speed, vy: (ay / al) * C.weapons.gun.speed, life: 1 })
      }
      for (const p of bullets) {
        if (p.life <= 0) continue
        for (let q = 0; q < 20 && p.life > 0; q++) {
          p.x += (p.vx * dt) / 20
          p.y += (p.vy * dt) / 20
          p.life -= dt / 20
          if (Math.hypot(p.x - x, p.y - y) <= M.radius + 0.3) {
            hits++
            p.life = 0
          }
        }
      }
    }
  }
  return { shots, hits, speed: path / seconds, label: b.label as string }
}

console.log(`bot: ${dir === root ? "working tree" : dir}`)
for (const lead of [0, 1])
  for (const d of [30, 45, 60, 90, 120]) {
    let shots = 0
    let hits = 0
    let speed = 0
    const N = 6
    for (let s = 0; s < N; s++) {
      const r = run(d, lead, null, 30, s + 1)
      shots += r.shots
      hits += r.hits
      speed += r.speed / N
    }
    console.log(`  gun ${lead ? "with full lead" : "aimed at where we are"}, held at ${String(d).padStart(3)} m: hit by ${String(Math.round((100 * hits) / shots)).padStart(3)}% of ${shots} bullets; our average speed ${speed.toFixed(1)} m/s`)
  }
