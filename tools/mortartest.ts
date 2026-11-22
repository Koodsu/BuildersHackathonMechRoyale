/**
 * Mortar check: the tube angle the bot picks, flown as a shell (three ways of stepping the fall, as
 * we do not know which the server uses), against a mech standing, walking across and walking at us.
 * Prints how far from the mech's feet each shell comes down. Nothing fights back.
 *   node tools/mortartest.ts
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
const C = hello.config
const st = C.weapons.mortar
const b: any = new Brain({ ...hello, seed: 3 })
const w = b.w
// open ground: the first spot from which a 140 m line east is walkable
let ox = 0
let oy = 0
outer: for (let y = -300; y < 200; y += 10) for (let x = -300; x < 300; x += 10) if (b.nav.free(x, y, 1) && b.nav.lineWalkable(x, y, x + 140, y, 0.3) && Math.abs(w.ground(x, y) - w.ground(x + 140, y)) < 3) { ox = x; oy = y; break outer }
let worst = 0
let direct = 0
let shells = 0
let fails = 0
for (const cubes of [0, 10]) {
  const sc = 1 + 0.05 * cubes
  b.R = C.mech.radius * sc
  b.H = C.mech.height * sc
  for (const dist of [20, 40, 70, 100, 130]) {
    for (const [name, vx, vy] of [["still", 0, 0], ["across", 0, 6], ["at us", -6, 0]] as [string, number, number][]) {
      const mz = w.ground(ox, oy)
      b.me = { pos: [ox, oy, mz], vel: [0, 0, 0] }
      const ex = ox + dist
      const ez = w.ground(ex, oy)
      const e: any = { x: ex, y: oy, z: ez, tr: { vx, vy } }
      const sol = b.lob(e, st)
      if (!sol) { console.log(`cubes ${cubes} ${dist} m ${name}: no solution`); if (dist >= 20 && dist <= 130) fails++; continue }
      const row: string[] = []
      for (const mode of ["exact", "semi", "explicit"]) {
        const out = b.R + 0.5
        let x = ox + Math.cos(sol.yaw) * Math.cos(sol.pitch) * out
        let y = oy + Math.sin(sol.yaw) * Math.cos(sol.pitch) * out
        let z = mz + b.H + 0.5 + Math.sin(sol.pitch) * out
        const hvx = Math.cos(sol.yaw) * Math.cos(sol.pitch) * st.speed
        const hvy = Math.sin(sol.yaw) * Math.cos(sol.pitch) * st.speed
        let vz = Math.sin(sol.pitch) * st.speed
        const dt = 0.05
        let t = 0
        let res = ""
        fly: while (t < 7) {
          if (mode === "semi") vz -= st.gravity * dt
          const nx = x + hvx * dt
          const ny = y + hvy * dt
          const nz = z + (mode === "exact" ? vz * dt - 0.5 * st.gravity * dt * dt : vz * dt)
          if (mode !== "semi") vz -= st.gravity * dt
          // the step, swept in twentieths: the mech's body first, then the ground
          for (let k = 1; k <= 20; k++) {
            const u = k / 20
            const px = x + (nx - x) * u
            const py = y + (ny - y) * u
            const pz = z + (nz - z) * u
            const tt = t + dt * u
            const fx = ex + vx * tt
            const fy = oy + vy * tt
            const fz = w.ground(fx, fy)
            if (Math.hypot(px - fx, py - fy) <= 2.5 && pz >= fz && pz <= fz + 9) { res = "direct"; direct++; break fly }
            if (pz <= w.ground(px, py)) {
              const miss = Math.hypot(px - fx, py - fy)
              res = `${miss.toFixed(1)} m`
              if (name === "still") { worst = Math.max(worst, miss); if (miss > 5) fails++ }
              break fly
            }
          }
          x = nx
          y = ny
          z = nz
          t += dt
        }
        shells++
        row.push(`${mode} ${res}`)
      }
      console.log(`cubes ${cubes} ${String(dist).padStart(3)} m ${name.padEnd(6)} pitch ${sol.pitch.toFixed(3)} tol ${sol.pitchTol.toFixed(4)}: ${row.join(", ")}`)
    }
  }
}
// too close: no shell that would also reach us
b.me = { pos: [ox, oy, w.ground(ox, oy)], vel: [0, 0, 0] }
if (b.lob({ x: ox + 10, y: oy, z: w.ground(ox + 10, oy), tr: { vx: 0, vy: 0 } }, st)) { console.log("FAIL: fires at 10 m"); fails++ }
console.log(`${direct} of ${shells} shells pass through the mech; worst burst from a standing one ${worst.toFixed(1)} m (blast radius ${st.splash_radius} m)`)
console.log(fails ? `FAIL (${fails})` : "ok")
process.exit(fails ? 1 : 0)
