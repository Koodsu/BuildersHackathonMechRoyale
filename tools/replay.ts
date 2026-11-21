/**
 * Runs the bot over the kit's recorded match (the observations do not react) and over randomised
 * variations of it, to catch crashes, invalid actions and slow ticks.
 *   node tools/replay.ts
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
const obs = msgs.filter((m) => m.type === "obs")

const bad = (a: any): string | null => {
  const fin = (v: any) => typeof v === "number" && Number.isFinite(v)
  if (!Array.isArray(a.move) || a.move.length !== 2 || !a.move.every(fin) || Math.hypot(a.move[0], a.move[1]) > 1.0001) return "move"
  if (!Array.isArray(a.aim) || a.aim.length !== 2 || !a.aim.every(fin)) return "aim"
  if (!Array.isArray(a.fire) || a.fire.length !== 2 || a.fire.some((f: any) => typeof f !== "boolean")) return "fire"
  if (typeof a.boost !== "boolean" || typeof a.jump !== "boolean") return "boost/jump"
  return null
}
const q = (a: number[], f: number) => a[Math.min(a.length - 1, Math.floor(f * a.length))]

// ---- 1. the recorded match as it is
{
  const t0 = performance.now()
  const b = new Brain(hello)
  console.log(`startup ${(performance.now() - t0).toFixed(0)} ms`)
  const times: number[] = []
  const labels = new Map<string, number>()
  let gunTicks = 0
  let seenTicks = 0
  for (const o of obs) {
    const t = performance.now()
    const a = b.act(o)
    times.push(performance.now() - t)
    const why = bad(a)
    if (why) throw new Error(`invalid ${why} at tick ${o.tick}: ${JSON.stringify(a)}`)
    labels.set(b.label, (labels.get(b.label) ?? 0) + 1)
    if (a.fire[0]) gunTicks++
    if (o.mechs.length) seenTicks++
  }
  times.sort((x, y) => x - y)
  console.log(`recorded match: ${obs.length} ticks, errors ${b.errors}, ms p50 ${q(times, 0.5).toFixed(2)} p99 ${q(times, 0.99).toFixed(2)} max ${q(times, 1).toFixed(2)}`)
  console.log(`  legs: ${[...labels].map(([k, v]) => `${k} ${v}`).join(", ")}`)
  console.log(`  enemy listed on ${seenTicks} ticks; trigger pulled on ${gunTicks} (the recorded torso is not ours, so the aim rarely lines up)`)
}

// ---- 2. randomised variations: every code path should survive odd inputs
{
  let seed = 99
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]
  const kinds = ["gun", "mortar", "laser", "lightning"]
  const cfg = hello.config
  const spots: number[][] = [[320, -280], [-276, 128], [-250, 60], [0, 0], [41, -73], [-400, 300], [500, -300], [100, 200], [-100, -30], [250, -260]]
  const times: number[] = []
  const cpu: number[] = []
  let errors = 0
  let ticks = 0
  const labels = new Map<string, number>()
  for (let run = 0; run < 12; run++) {
    const b = new Brain({ ...hello, seed: run, slot: run % 16 })
    let [x, y] = pick(spots)
    x += (rnd() - 0.5) * 80
    y += (rnd() - 0.5) * 80
    let t = rnd() * 400
    const phase = Math.floor(rnd() * 6)
    const radii = [560, 380, 240, 140, 70, 25, 0]
    const second = pick([null, "laser", "lightning", "mortar"])
    let charge = 0
    let cubes = Math.floor(rnd() * 14)
    for (let k = 0; k < 2000; k++) {
      t += 0.1
      x += (rnd() - 0.5) * 3
      y += (rnd() - 0.5) * 3
      const w: any = (b as any).w
      const onRoof = rnd() < 0.5
      const z = (onRoof ? w.surface(x, y) : w.ground(x, y)) + (rnd() < 0.1 ? rnd() * 20 : 0)
      const grounded = rnd() < 0.9
      const sc = 1 + 0.05 * cubes
      const weapons: any[] = [{ kind: "gun", cooldown: rnd() * 0.24, ammo: Math.floor(rnd() * 13), reload: rnd() < 0.2 ? rnd() * 2.4 : 0, stats: cfg.weapons.gun }]
      if (second) {
        const wv: any = { kind: second, cooldown: rnd() < 0.5 ? 0 : rnd() * 2, stats: cfg.weapons[second] }
        if (second === "laser") {
          charge = rnd() < 0.3 ? 0 : Math.min(2.7, charge + 0.1)
          wv.charge = charge
        }
        weapons.push(wv)
      } else weapons.push(null)
      const mechs: any[] = []
      const nm = Math.floor(rnd() * 5)
      for (let i = 0; i < nm; i++) {
        const a = rnd() * 6.283
        const d = 5 + rnd() * 250
        const ex = x + Math.cos(a) * d
        const ey = y + Math.sin(a) * d
        if (rnd() < 0.25) mechs.push({ id: 100 + i, kind: "npc", pos: [ex, ey, w.ground(ex, ey)], vel: [rnd() * 5, 0, 0], aim: [0, 0], hp: 350, max_hp: 350 })
        else mechs.push({ id: i === 3 ? 3 : i + 4, kind: "mech", pos: [ex, ey, w.surface(ex, ey) + (rnd() < 0.1 ? 10 : 0)], vel: [(rnd() - 0.5) * 30, (rnd() - 0.5) * 30, (rnd() - 0.5) * 20], aim: [rnd() * 6 - 3, 0], hp: rnd() * 1400, max_hp: 1400, cubes: Math.floor(rnd() * 12), weapons: ["gun", pick(kinds)], charging: rnd() < 0.3 })
      }
      const near = (n: number, base: number, extra: () => any) => Array.from({ length: Math.floor(rnd() * n) }, (_, i) => ({ id: base + Math.floor(rnd() * 20), pos: [x + (rnd() - 0.5) * 120, y + (rnd() - 0.5) * 120, z + (rnd() < 0.2 ? 15 : 0)], ...extra() }))
      const events: any[] = []
      if (rnd() < 0.2) events.push({ type: "damaged", amount: 45, weapon: pick([...kinds, "npc", "zone"]), bearing: rnd() < 0.9 ? rnd() * 6 - 3 : null, by: pick([null, 1, 2, 5, 9, 104]), rear: rnd() < 0.5 })
      if (rnd() < 0.2) events.push({ type: "hit", target: pick([4, 5, 6, 1003, 102]), amount: 45, weapon: "gun" })
      if (rnd() < 0.02) events.push({ type: "kill", target: pick([4, 5, 6]) })
      if (rnd() < 0.02) events.push({ type: "take_failed", id: 8000 + Math.floor(rnd() * 20), reason: pick(["gone", "range", "have", "full", "busy"]) })
      if (rnd() < 0.02) events.push({ type: "took", id: 8000 + Math.floor(rnd() * 20), kind: "laser", slot: 1 })
      if (rnd() < 0.02) events.push({ type: "dropped", id: 8000 + Math.floor(rnd() * 20), kind: "laser", slot: 1 })
      const o: any = {
        type: "obs", tick: Math.round(t * 20), t, alive: 10,
        self: { id: 3, pos: [x, y, z], vel: [(rnd() - 0.5) * 20, (rnd() - 0.5) * 20, grounded ? 0 : (rnd() - 0.5) * 30], aim: [rnd() * 6 - 3, rnd() - 0.5], hp: 50 + rnd() * 1900, max_hp: 1960, energy: rnd() * 100, max_energy: 100, grounded, cubes, upgrades: [], in_zone: rnd() < 0.85, weapons, stats: { ...cfg.mech, radius: 2.5 * sc, height: 9 * sc, eye_height: 8 * sc, muzzle_height: 7 * sc } },
        mechs,
        projectiles: Array.from({ length: Math.floor(rnd() * 3) }, (_, i) => ({ id: 200 + i, kind: pick(["gun", "mortar", "npc"]), pos: [x + (rnd() - 0.5) * 100, y + (rnd() - 0.5) * 100, z + rnd() * 40], vel: [(rnd() - 0.5) * 100, (rnd() - 0.5) * 100, (rnd() - 0.5) * 60] })),
        crates: near(4, 1000, () => ({ hp: 300 })),
        cubes: near(4, 5000, () => ({})),
        pickups: near(5, 8000, () => ({ kind: pick(kinds.slice(1)) })),
        sounds: [], beams: [], events,
        drops: rnd() < 0.3 ? [{ id: 20000, pos: [x + 40, y, z], radius: 8, lands_in: rnd() * 20, capture_s: 4, progress: 0, holder: null }] : [],
        zone: { center: [41.3 + phase * 5, -72.8], radius: radii[phase] + rnd() * 5, next_center: [41.3 + phase * 5 + (rnd() - 0.5) * 60, -72.8 + (rnd() - 0.5) * 60], next_radius: radii[phase + 1], shrink_start: t + 30 - k * 0.1, shrink_end: t + 60 - k * 0.1, dps: 20 },
        offer: rnd() < 0.1 ? { id: 1, expires: t + 5, choices: [0, 1, 2].map(() => pick(cfg.upgrades as any[])) } : null,
      }
      const ts = performance.now()
      const c0 = process.cpuUsage()
      const a = b.act(o)
      times.push(performance.now() - ts)
      const c1 = process.cpuUsage(c0)
      cpu.push((c1.user + c1.system) / 1000)
      const why = bad(a)
      if (why) throw new Error(`invalid ${why}: ${JSON.stringify(a)}`)
      labels.set(b.label, (labels.get(b.label) ?? 0) + 1)
      ticks++
      if (rnd() < 0.02) cubes++
    }
    errors += b.errors
  }
  times.sort((x, y) => x - y)
  cpu.sort((x, y) => x - y)
  console.log(`randomised: ${ticks} ticks over 12 bots, errors ${errors}, ms p50 ${q(times, 0.5).toFixed(2)} p99 ${q(times, 0.99).toFixed(2)} p99.9 ${q(times, 0.999).toFixed(2)} max ${q(times, 1).toFixed(2)}`)
  console.log(`  CPU time of the whole process per tick (includes the runtime's own threads; unaffected by other programs): ms p99 ${q(cpu, 0.99).toFixed(2)} p99.9 ${q(cpu, 0.999).toFixed(2)} max ${q(cpu, 1).toFixed(2)}`)
  console.log(`  legs: ${[...labels].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`)
  if (errors) process.exit(1)
}
