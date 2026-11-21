/**
 * Checks the map model against the kit's recorded match and draws it.
 *   node tools/maptest.ts [out.png]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { crc32, deflateSync, gunzipSync } from "node:zlib"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { World } from "../src/world.ts"
import { CS, Nav } from "../src/nav.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
let t0 = performance.now()
const w = new World(join(root, "kit/arena"))
console.log(`world built in ${(performance.now() - t0).toFixed(0)} ms: ${w.nx}x${w.ny}`)
t0 = performance.now()
const nav = new Nav(w)
nav.rebuild(2.5)
console.log(`nav built in ${(performance.now() - t0).toFixed(0)} ms: ${nav.gw}x${nav.gh}`)

let walk = 0
let main = 0
const sizes = new Map<number, number>()
for (let c = 0; c < nav.walk.length; c++) {
  if (!nav.walk[c]) continue
  walk++
  if (nav.comp[c] === nav.mainComp) main++
  sizes.set(nav.comp[c], (sizes.get(nav.comp[c]) ?? 0) + 1)
}
const top = [...sizes.values()].sort((a, b) => b - a).slice(0, 8)
let bldN = 0
for (let k = 0; k < w.bld.length; k++) bldN += w.bld[k]
console.log(`building cells ${((100 * bldN) / w.bld.length).toFixed(1)}%  walkable nav cells ${walk} (${((100 * walk) / nav.walk.length).toFixed(1)}%)  main component ${((100 * main) / walk).toFixed(1)}% of walkable  components ${sizes.size}  largest ${top.join(", ")}`)

// --- recorded match: where the recorded mech stood must be consistent with the model
const lines = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean)
const obs = lines.map((l) => JSON.parse(l)).filter((m) => m.type === "obs")
let onGround = 0
let onRoof = 0
let inBld = 0
let offMain = 0
let maxErr = 0
const track: number[][] = []
for (const o of obs) {
  const [x, y, z] = o.self.pos
  track.push([x, y])
  if (!o.self.grounded) continue
  const f = w.idx(x, y)
  const dzSurf = z - w.surf[f]
  const dzTerr = z - w.terr[f]
  if (Math.abs(dzTerr) < 0.6) {
    onGround++
    maxErr = Math.max(maxErr, Math.abs(dzTerr))
    if (w.bld[f]) inBld++
    if (nav.snap(x, y, 2) < 0) offMain++
  } else if (Math.abs(dzSurf) < 0.6) onRoof++
  else console.log(`  unexplained height at t=${o.t}: pos ${x},${y},${z} terr ${w.terr[f].toFixed(2)} surf ${w.surf[f].toFixed(2)} slab ${w.slabBase[f]}..${w.slabTop[f]}`)
}
console.log(`recorded grounded samples: on ground ${onGround} (max height error ${maxErr.toFixed(2)} m, ${inBld} inside a building cell, ${offMain} not within 4 m of the walkable grid), on a roof ${onRoof}`)

// --- recorded sightings and beams against line of sight
let seenClear = 0
let seenBlocked = 0
for (const o of obs) {
  const [x, y, z] = o.self.pos
  for (const m of o.mechs) {
    const ok = w.los(x, y, z + 8, m.pos[0], m.pos[1], m.pos[2] + 4.5) || w.los(x, y, z + 8, m.pos[0], m.pos[1], m.pos[2] + 9)
    if (ok) seenClear++
    else seenBlocked++
  }
  for (const b of o.beams) {
    const [a, e] = b.path
    const len = Math.hypot(e[0] - a[0], e[1] - a[1], e[2] - a[2])
    const u = [(e[0] - a[0]) / len, (e[1] - a[1]) / len, (e[2] - a[2]) / len]
    // clear up to just short of where it ended
    const clear = w.los(a[0], a[1], a[2], e[0] - u[0] * 3, e[1] - u[1] * 3, e[2] - u[2] * 3, 0.5)
    console.log(`  beam t=${o.t} len ${len.toFixed(1)} m: model says ${clear ? "clear" : "BLOCKED"} up to its end`)
  }
}
console.log(`mechs listed in obs: line of sight clear ${seenClear}, blocked ${seenBlocked} (blocked ones are the 5 s memory or model error)`)

// --- A* timing on random pairs in the main component
let seed = 12345
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
const cells: number[] = []
for (let c = 0; c < nav.walk.length; c++) if (nav.comp[c] === nav.mainComp) cells.push(c)
const times: number[] = []
const exps: number[] = []
let partial = 0
let sample: number[] | null = null
for (let k = 0; k < 400; k++) {
  const a = cells[Math.floor(rnd() * cells.length)]
  const b = cells[Math.floor(rnd() * cells.length)]
  const t = performance.now()
  const p = nav.findPath(nav.cx(a), nav.cy(a), nav.cx(b), nav.cy(b))
  times.push(performance.now() - t)
  exps.push(nav.expanded)
  if (!p) throw new Error("no path inside the main component")
  if (Math.hypot(p[p.length - 2] - nav.cx(b), p[p.length - 1] - nav.cy(b)) > 0.01) partial++
  if (k === 7) sample = p
}
times.sort((a, b) => a - b)
exps.sort((a, b) => a - b)
const q = (a: number[], f: number) => a[Math.min(a.length - 1, Math.floor(f * a.length))]
console.log(`A* over 400 random pairs: ms p50 ${q(times, 0.5).toFixed(2)} p90 ${q(times, 0.9).toFixed(2)} p99 ${q(times, 0.99).toFixed(2)} max ${q(times, 1).toFixed(2)}; expansions p50 ${q(exps, 0.5)} max ${q(exps, 1)}; hit the budget (partial path) ${partial}`)

// --- line-of-sight timing
t0 = performance.now()
let clearN = 0
const N = 20000
for (let k = 0; k < N; k++) {
  const a = cells[Math.floor(rnd() * cells.length)]
  const ang = rnd() * 6.283
  const d = 40 + rnd() * 160
  const ax = nav.cx(a)
  const ay = nav.cy(a)
  const bx = ax + Math.cos(ang) * d
  const by = ay + Math.sin(ang) * d
  if (w.los(ax, ay, w.surface(ax, ay) + 8, bx, by, w.surface(bx, by) + 4.5)) clearN++
}
console.log(`line of sight: ${(((performance.now() - t0) * 1000) / N).toFixed(2)} us per ray, ${((100 * clearN) / N).toFixed(0)}% clear at 40-200 m`)

// --- picture: dark = building, grey = unreachable ground, light = walkable; red = recorded track, blue = a sample path
const out = process.argv[2]
if (out) {
  const W = w.nx
  const H = w.ny
  const px = new Uint8Array(W * H * 3)
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    const i = Math.round(x - w.minX)
    const j = H - 1 - Math.round(y - w.minY)
    if (i < 0 || j < 0 || i >= W || j >= H) return
    px.set([r, g, b], (j * W + i) * 3)
  }
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const f = j * W + i
      const c = Math.floor(j / CS) * nav.gw + Math.floor(i / CS)
      const x = w.minX + i
      const y = w.minY + j
      if (w.slabBase[f] < Infinity) set(x, y, 150, 90, 200)
      else if (w.bld[f]) {
        const hgt = Math.min(1, (w.surf[f] - w.terr[f]) / 40)
        set(x, y, 40 + 60 * hgt, 40 + 30 * hgt, 40)
      } else if (nav.comp[c] === nav.mainComp) {
        const v = 200 + Math.max(-40, Math.min(40, w.terr[f] * 4))
        set(x, y, v, v, v)
      } else if (nav.walk[c]) set(x, y, 240, 200, 90)
      else set(x, y, 150, 150, 150)
    }
  if (sample) for (let k = 0; k + 3 < sample.length; k += 2) for (let s = 0; s <= 1; s += 0.25) set(sample[k] + (sample[k + 2] - sample[k]) * s, sample[k + 1] + (sample[k + 3] - sample[k + 1]) * s, 30, 80, 255)
  for (const [x, y] of track) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) set(x + a, y + b, 255, 30, 30)
  const rawPx = Buffer.alloc((W * 3 + 1) * H)
  for (let j = 0; j < H; j++) Buffer.from(px.buffer, j * W * 3, W * 3).copy(rawPx, j * (W * 3 + 1) + 1)
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, "ascii")
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
    return Buffer.concat([head, data, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rawPx)), chunk("IEND", Buffer.alloc(0))]))
  console.log("wrote", out)
}
