/**
 * Static map model built once at startup from v2/world.json + v2/terrain.i16.
 *
 * Everything is rasterised onto the terrain's own 1 m vertex grid:
 *   terr  ground height
 *   surf  top of whatever is solid there (ground, or the roof of a prism standing on the ground)
 *   bld   1 where a mech walking on the ground cannot be (building, low overhang, outside the map)
 *   dist  distance in metres to the nearest `bld` cell
 *   slab  prisms with air underneath (bridges, overhangs): solid only between slabBase and slabTop
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const STEP_UP = 1.2
/**
 * Overhangs lower than this above the ground are treated as walls for walking. The map's five
 * bridges clear the ground by 5 to 11.5 m; a mech is 9 m tall and grows 5% with every cube, so
 * none of them can be relied on to pass under.
 */
const HEADROOM = 12

export class World {
  nx = 0
  ny = 0
  minX = 0
  minY = 0
  bMinX = 0
  bMaxX = 0
  bMinY = 0
  bMaxY = 0
  terr: Float32Array = new Float32Array(0)
  surf: Float32Array = new Float32Array(0)
  bld: Uint8Array = new Uint8Array(0)
  dist: Float32Array = new Float32Array(0)
  slabBase: Float32Array = new Float32Array(0)
  slabTop: Float32Array = new Float32Array(0)

  constructor(dir: string, files?: string[]) {
    const worldRel = files?.find((f) => f.endsWith("world.json")) ?? "v2/world.json"
    const w = JSON.parse(readFileSync(join(dir, worldRel), "utf8"))
    const T = w.terrain
    const terrRel = files?.find((f) => f.endsWith(".i16")) ?? worldRel.replace(/[^/]*$/, T.file ?? "terrain.i16")
    const raw = readFileSync(join(dir, terrRel))
    const nx = (this.nx = T.nx)
    const ny = (this.ny = T.ny)
    this.minX = T.minX
    this.minY = T.minY
    const step = T.step ?? 1
    if (step !== 1) throw new Error("terrain step " + step + " not supported")
    const scale = T.scale ?? 0.01
    const n = nx * ny
    if (raw.length < n * 2) throw new Error("terrain file too short")
    const terr = (this.terr = new Float32Array(n))
    for (let k = 0; k < n; k++) terr[k] = raw.readInt16LE(k * 2) * scale
    const surf = (this.surf = Float32Array.from(terr))
    const bld = (this.bld = new Uint8Array(n))
    const slabBase = (this.slabBase = new Float32Array(n).fill(Infinity))
    const slabTop = (this.slabTop = new Float32Array(n).fill(-Infinity))
    const B = w.bounds
    this.bMinX = B.minX
    this.bMaxX = B.maxX
    this.bMinY = B.minY
    this.bMaxY = B.maxY

    // --- rasterise prisms (even-odd scanline; hole edges go in the same edge list)
    const xs: number[] = []
    for (const p of w.prisms as any[]) {
      const rings: number[][] = [p.ring, ...(p.holes ?? [])]
      let y0 = Infinity
      let y1 = -Infinity
      for (let k = 1; k < p.ring.length; k += 2) {
        if (p.ring[k] < y0) y0 = p.ring[k]
        if (p.ring[k] > y1) y1 = p.ring[k]
      }
      const j0 = Math.max(0, Math.ceil(y0 - this.minY))
      const j1 = Math.min(ny - 1, Math.floor(y1 - this.minY))
      for (let j = j0; j <= j1; j++) {
        const y = this.minY + j
        xs.length = 0
        for (const r of rings) {
          const m = r.length
          for (let a = 0; a < m; a += 2) {
            const ax = r[a]
            const ay = r[a + 1]
            const bx = r[(a + 2) % m]
            const by = r[(a + 3) % m]
            if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay))
          }
        }
        xs.sort((a, b) => a - b)
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const i0 = Math.max(0, Math.ceil(xs[q] - this.minX))
          const i1 = Math.min(nx - 1, Math.floor(xs[q + 1] - this.minX))
          for (let i = i0; i <= i1; i++) {
            const idx = j * nx + i
            const g = terr[idx]
            if (p.top <= g + 0.05) continue // buried
            if (p.base - g > 4.5) {
              // real air underneath (a bridge, an overhang): a slab. A building whose base sits a
              // little above dipping ground is just a building: its roof is a roof.
              if (p.base < slabBase[idx]) slabBase[idx] = p.base
              if (p.top > slabTop[idx]) slabTop[idx] = p.top
            } else if (p.top > surf[idx]) surf[idx] = p.top
          }
        }
      }
    }

    // --- cells a ground-walking mech can never be centred on
    for (let j = 0; j < ny; j++) {
      const y = this.minY + j
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i
        const x = this.minX + i
        if (x < B.minX || x > B.maxX || y < B.minY || y > B.maxY) bld[idx] = 1
        else if (surf[idx] - terr[idx] > STEP_UP) bld[idx] = 1
        else if (slabBase[idx] - surf[idx] < HEADROOM) bld[idx] = 1
      }
    }
    this.dist = edt(bld, nx, ny)
  }

  inGrid(x: number, y: number): boolean {
    const i = Math.round(x - this.minX)
    const j = Math.round(y - this.minY)
    return i >= 0 && j >= 0 && i < this.nx && j < this.ny
  }

  /** Nearest-vertex index, clamped to the grid. */
  idx(x: number, y: number): number {
    let i = Math.round(x - this.minX)
    let j = Math.round(y - this.minY)
    if (i < 0) i = 0
    else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0
    else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }

  ground(x: number, y: number): number {
    return this.terr[this.idx(x, y)]
  }

  surface(x: number, y: number): number {
    return this.surf[this.idx(x, y)]
  }

  /** Height of whatever must be cleared to pass over this spot: the roof, or the deck of a bridge. */
  over(x: number, y: number): number {
    const k = this.idx(x, y)
    const s = this.slabTop[k]
    return s > this.surf[k] ? s : this.surf[k]
  }

  clearance(x: number, y: number): number {
    return this.dist[this.idx(x, y)]
  }

  /**
   * True when the straight segment a→b passes through no terrain or building. Trees are ignored
   * (they stop sight but not shots). Samples within `skip` metres of either end are not tested, so
   * an endpoint standing right against a wall does not block itself.
   */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number, skip = 1.5): boolean {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const L = Math.hypot(dx, dy)
    if (L < 2 * skip + 1) return true
    const n = Math.ceil(L)
    const { nx, ny, minX, minY, surf, slabBase, slabTop } = this
    const k0 = Math.ceil((skip / L) * n)
    const k1 = n - k0
    for (let k = k0; k <= k1; k++) {
      const s = k / n
      const i = Math.round(ax + dx * s - minX)
      const j = Math.round(ay + dy * s - minY)
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue
      const idx = j * nx + i
      const z = az + dz * s
      if (z < surf[idx] - 0.3) return false
      if (z > slabBase[idx] && z < slabTop[idx]) return false
    }
    return true
  }
}

/** Exact Euclidean distance transform (Felzenszwalb & Huttenlocher): metres to the nearest set cell. */
function edt(mask: Uint8Array, nx: number, ny: number): Float32Array {
  const INF = 1e12
  const out = new Float32Array(nx * ny)
  const m = Math.max(nx, ny)
  const f = new Float64Array(m)
  const d = new Float64Array(m)
  const v = new Int32Array(m)
  const z = new Float64Array(m + 1)
  const pass = (n: number) => {
    let k = 0
    v[0] = 0
    z[0] = -Infinity
    z[1] = Infinity
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k--
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = Infinity
    }
    k = 0
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
    }
  }
  const tmp = new Float64Array(nx * ny)
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = mask[j * nx + i] ? 0 : INF
    pass(ny)
    for (let j = 0; j < ny; j++) tmp[j * nx + i] = d[j]
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = tmp[j * nx + i]
    pass(nx)
    for (let i = 0; i < nx; i++) out[j * nx + i] = Math.sqrt(d[i])
  }
  return out
}
