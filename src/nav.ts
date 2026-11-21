/**
 * Ground navigation: a 2 m grid over the World, walkable where a mech of the current radius fits,
 * with A* between cells. Only ground a mech can walk (no drops, no jets) is connected, so a path
 * never needs energy. Roofs and pits are simply "off the grid": the bot handles those separately.
 */
import { STEP_UP, type World } from "./world.ts"

const DI = [1, 1, 0, -1, -1, -1, 0, 1]
const DJ = [0, 1, 1, 1, 0, -1, -1, -1]
const SQ2 = Math.SQRT2
const DC = [1, SQ2, 1, SQ2, 1, SQ2, 1, SQ2]
export const CS = 2

export class Nav {
  w: World
  gw: number
  gh: number
  walk: Uint8Array
  edges: Uint8Array
  comp: Int32Array
  mainComp = -1
  radius = -1
  expanded = 0

  private g: Float32Array
  private parent: Int32Array
  private seen: Uint32Array
  private closed: Uint32Array
  private stamp = 0
  private heap: Int32Array
  private heapF: Float32Array
  private hn = 0

  constructor(w: World) {
    this.w = w
    this.gw = Math.floor((w.nx - 1) / CS) + 1
    this.gh = Math.floor((w.ny - 1) / CS) + 1
    const n = this.gw * this.gh
    this.walk = new Uint8Array(0)
    this.edges = new Uint8Array(0)
    this.comp = new Int32Array(0)
    this.g = new Float32Array(n)
    this.parent = new Int32Array(n)
    this.seen = new Uint32Array(n)
    this.closed = new Uint32Array(n)
    this.heap = new Int32Array(1 << 18)
    this.heapF = new Float32Array(1 << 18)
  }

  private levels = new Map<number, { walk: Uint8Array; edges: Uint8Array; comp: Int32Array; mainComp: number }>()

  /**
   * Switch to the walkable mask, edges and connected components for a mech of this radius. Each
   * radius is built once and kept (a build costs ~10 ms, too much to repeat inside a tick).
   */
  rebuild(radius: number) {
    const key = Math.round(radius * 20)
    let L = this.levels.get(key)
    if (!L) {
      const n = this.gw * this.gh
      this.walk = new Uint8Array(n)
      this.edges = new Uint8Array(n)
      this.comp = new Int32Array(n)
      this.build(radius)
      L = { walk: this.walk, edges: this.edges, comp: this.comp, mainComp: this.mainComp }
      this.levels.set(key, L)
    }
    this.walk = L.walk
    this.edges = L.edges
    this.comp = L.comp
    this.mainComp = L.mainComp
    this.radius = radius
  }

  private build(radius: number) {
    const { w, gw, gh, walk, edges, comp } = this
    const { nx, bld, dist, surf } = w
    const need = radius + 1.0
    const needMid = radius + 0.5
    for (let J = 0; J < gh; J++)
      for (let I = 0; I < gw; I++) {
        const f = J * CS * nx + I * CS
        walk[J * gw + I] = !bld[f] && dist[f] >= need ? 1 : 0
      }
    for (let J = 0; J < gh; J++)
      for (let I = 0; I < gw; I++) {
        const c = J * gw + I
        let m = 0
        if (walk[c]) {
          const f = J * CS * nx + I * CS
          const s0 = surf[f]
          for (let d = 0; d < 8; d++) {
            const nI = I + DI[d]
            const nJ = J + DJ[d]
            if (nI < 0 || nJ < 0 || nI >= gw || nJ >= gh) continue
            if (!walk[nJ * gw + nI]) continue
            if (d & 1 && !(walk[J * gw + nI] && walk[nJ * gw + I])) continue
            const mid = (J * CS + DJ[d]) * nx + I * CS + DI[d]
            if (bld[mid] || dist[mid] < needMid) continue
            const sm = surf[mid]
            const s1 = surf[nJ * CS * nx + nI * CS]
            if (Math.abs(sm - s0) > STEP_UP || Math.abs(s1 - sm) > STEP_UP) continue
            m |= 1 << d
          }
        }
        edges[c] = m
      }
    // connected components (edges are symmetric by construction)
    comp.fill(-1)
    const queue = this.parent // scratch
    let best = -1
    let bestSize = 0
    let id = 0
    for (let c0 = 0; c0 < walk.length; c0++) {
      if (!walk[c0] || comp[c0] >= 0) continue
      let head = 0
      let tail = 0
      queue[tail++] = c0
      comp[c0] = id
      while (head < tail) {
        const c = queue[head++]
        const m = edges[c]
        const I = c % gw
        const J = (c - I) / gw
        for (let d = 0; d < 8; d++) {
          if (!(m & (1 << d))) continue
          const nc = (J + DJ[d]) * gw + I + DI[d]
          if (comp[nc] < 0) {
            comp[nc] = id
            queue[tail++] = nc
          }
        }
      }
      if (tail > bestSize) {
        bestSize = tail
        best = id
      }
      id++
    }
    this.mainComp = best
  }

  cellOf(x: number, y: number): number {
    let I = Math.round((x - this.w.minX) / CS)
    let J = Math.round((y - this.w.minY) / CS)
    if (I < 0) I = 0
    else if (I >= this.gw) I = this.gw - 1
    if (J < 0) J = 0
    else if (J >= this.gh) J = this.gh - 1
    return J * this.gw + I
  }

  cx(c: number): number {
    return this.w.minX + (c % this.gw) * CS
  }

  cy(c: number): number {
    return this.w.minY + Math.floor(c / this.gw) * CS
  }

  inMain(x: number, y: number): boolean {
    return this.comp[this.cellOf(x, y)] === this.mainComp
  }

  /** Nearest cell of the main component within `maxRing` cells, or -1. */
  snap(x: number, y: number, maxRing: number): number {
    const { gw, gh, comp, mainComp } = this
    const c0 = this.cellOf(x, y)
    if (comp[c0] === mainComp) return c0
    const I0 = c0 % gw
    const J0 = (c0 - I0) / gw
    const fx = (x - this.w.minX) / CS
    const fy = (y - this.w.minY) / CS
    let best = -1
    let bestD = Infinity
    for (let r = 1; r <= maxRing; r++) {
      if (best >= 0 && r > Math.sqrt(bestD) + 1) break
      for (let k = -r; k <= r; k++) {
        for (let side = 0; side < 4; side++) {
          const I = side === 0 ? I0 + k : side === 1 ? I0 + k : side === 2 ? I0 - r : I0 + r
          const J = side === 0 ? J0 - r : side === 1 ? J0 + r : side === 2 ? J0 + k : J0 + k
          if (I < 0 || J < 0 || I >= gw || J >= gh) continue
          if (comp[J * gw + I] !== mainComp) continue
          const d = (I - fx) * (I - fx) + (J - fy) * (J - fy)
          if (d < bestD) {
            bestD = d
            best = J * gw + I
          }
        }
      }
    }
    return best
  }

  /** A mech of the current radius (plus `margin`) can stand centred here on the ground. */
  free(x: number, y: number, margin: number): boolean {
    const w = this.w
    if (!w.inGrid(x, y)) return false
    const f = w.idx(x, y)
    return !w.bld[f] && w.dist[f] >= this.radius + margin
  }

  /** Straight walk a→b stays on walkable ground with no step over STEP_UP. */
  lineWalkable(x0: number, y0: number, x1: number, y1: number, margin: number): boolean {
    const w = this.w
    const dx = x1 - x0
    const dy = y1 - y0
    const L = Math.hypot(dx, dy)
    const n = Math.max(1, Math.ceil(L))
    const need = this.radius + margin
    if (!w.inGrid(x1, y1)) return false
    let prev = w.surf[w.idx(x0, y0)]
    for (let k = 1; k <= n; k++) {
      const s = k / n
      const f = w.idx(x0 + dx * s, y0 + dy * s)
      if (w.bld[f]) return false
      // the first metres are exempt: we may already be standing closer to a wall than the margin
      if (s * L > 2 && w.dist[f] < need) return false
      const sf = w.surf[f]
      if (Math.abs(sf - prev) > STEP_UP) return false
      prev = sf
    }
    return true
  }

  private push(c: number, f: number) {
    const { heap, heapF } = this
    let i = this.hn++
    if (i >= heap.length) {
      this.hn--
      return
    }
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heapF[p] <= f) break
      heap[i] = heap[p]
      heapF[i] = heapF[p]
      i = p
    }
    heap[i] = c
    heapF[i] = f
  }

  private pop(): number {
    const { heap, heapF } = this
    const top = heap[0]
    const n = --this.hn
    if (n > 0) {
      const c = heap[n]
      const f = heapF[n]
      let i = 0
      for (;;) {
        let k = 2 * i + 1
        if (k >= n) break
        if (k + 1 < n && heapF[k + 1] < heapF[k]) k++
        if (heapF[k] >= f) break
        heap[i] = heap[k]
        heapF[i] = heapF[k]
        i = k
      }
      heap[i] = c
      heapF[i] = f
    }
    return top
  }

  /**
   * Path as flat [x0,y0,x1,y1,...] from the cell nearest the start to the cell nearest the goal
   * (both snapped onto the main component). When the search budget runs out, the path leads to the
   * explored cell closest to the goal. Null when either end is nowhere near walkable ground.
   */
  findPath(sx: number, sy: number, tx: number, ty: number, maxExp = 18000): number[] | null {
    const s = this.snap(sx, sy, 15)
    const goal = this.snap(tx, ty, 160)
    this.expanded = 0
    if (s < 0 || goal < 0) return null
    if (s === goal) return [this.cx(s), this.cy(s)]
    const { gw, g, parent, seen, closed, edges } = this
    const { nx, dist } = this.w
    const stamp = ++this.stamp
    const gI = goal % gw
    const gJ = (goal - gI) / gw
    const W = 1.3
    const nearWall = this.radius + 2.5
    const h = (c: number) => {
      const a = Math.abs((c % gw) - gI)
      const b = Math.abs(Math.floor(c / gw) - gJ)
      return (a > b ? a + 0.4142 * b : b + 0.4142 * a) * CS
    }
    this.hn = 0
    g[s] = 0
    parent[s] = -1
    seen[s] = stamp
    this.push(s, h(s) * W)
    let bestC = s
    let bestH = h(s)
    let found = false
    while (this.hn > 0) {
      const c = this.pop()
      if (closed[c] === stamp) continue
      closed[c] = stamp
      if (c === goal) {
        found = true
        break
      }
      if (++this.expanded > maxExp) break
      const hc = h(c)
      if (hc < bestH) {
        bestH = hc
        bestC = c
      }
      const m = edges[c]
      const I = c % gw
      const J = (c - I) / gw
      const gc = g[c]
      for (let d = 0; d < 8; d++) {
        if (!(m & (1 << d))) continue
        const nI = I + DI[d]
        const nJ = J + DJ[d]
        const nc = nJ * gw + nI
        if (closed[nc] === stamp) continue
        const pen = dist[nJ * CS * nx + nI * CS] < nearWall ? 1.3 : 1
        const ng = gc + DC[d] * CS * pen
        if (seen[nc] !== stamp || ng < g[nc]) {
          seen[nc] = stamp
          g[nc] = ng
          parent[nc] = c
          this.push(nc, ng + h(nc) * W)
        }
      }
    }
    const out: number[] = []
    let c = found ? goal : bestC
    let guard = 0
    while (c >= 0 && guard++ < 100000) {
      out.push(this.cy(c), this.cx(c))
      c = parent[c]
    }
    out.reverse()
    return out
  }
}
