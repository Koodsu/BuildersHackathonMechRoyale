/**
 * The pilot. One decision per observation:
 *   1. update what we know (enemy tracks, remembered loot, damage both ways, zone)
 *   2. pick the enemy to deal with, and whether to fight, hide or travel
 *   3. legs: scored local positions in a fight, A* paths otherwise, hops over walls when off the grid
 *   4. torso: lead the gun, hold/release the laser, arc lightning; scan when nothing is in sight
 */
import { log } from "../mechfight.ts"
import { Nav } from "./nav.ts"
import { STEP_UP, World } from "./world.ts"

const TAU = Math.PI * 2
const hyp = Math.hypot
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}

/** Upgrade preference, best first. Survival first, then the weapons we actually use. */
const UPGRADES = [
  "plating", "nanites", "armor", "gun_damage", "laser_damage", "servos", "gun_rate", "laser_charge",
  "lightning_efficiency", "capacitor", "reactor", "gyros", "gun_mag", "gun_velocity", "jets",
  "lightning_range", "lightning_chain", "sensors", "laser_pierce", "mortar_reload", "mortar_splash", "mortar_velocity",
]
/** Second-slot weapons we pick up, best first. */
const WANT = ["laser", "lightning"]
/** Stop seeking cubes here: HP and damage bonuses cap at 10, size keeps growing. */
const CUBE_TARGET = 10

interface Track {
  id: number
  npc: boolean
  ghost: boolean
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  aimYaw: number
  hp: number
  maxHp: number
  cubes: number
  weapons: string[]
  charging: boolean
  t: number
}

interface Enemy {
  tr: Track
  x: number
  y: number
  z: number
  d: number
  yaw: number
  rad: number
  hgt: number
  cz: number
  mz: number
  shootable: boolean
  seesMe: boolean
  attacked: boolean
  closing: number
}

interface Item {
  id: number
  x: number
  y: number
  z: number
  kind: string
  hp: number
  seen: number
}

interface Move {
  x: number
  y: number
  boost: boolean
  jump: boolean
}

interface Goal {
  x: number
  y: number
  stop: number
  boost: boolean
  kind: string
}

interface Sol {
  yaw: number
  pitch: number
  d: number
}

/** Smallest positive t with |r + v t| = s t, or -1. */
function intercept(rx: number, ry: number, rz: number, vx: number, vy: number, vz: number, s: number): number {
  const a = vx * vx + vy * vy + vz * vz - s * s
  const b = 2 * (rx * vx + ry * vy + rz * vz)
  const c = rx * rx + ry * ry + rz * rz
  if (Math.abs(a) < 1e-9) return b < 0 ? -c / b : -1
  const disc = b * b - 4 * a * c
  if (disc < 0) return -1
  const sq = Math.sqrt(disc)
  const t1 = (-b - sq) / (2 * a)
  const t2 = (-b + sq) / (2 * a)
  if (t1 > 0 && t2 > 0) return Math.min(t1, t2)
  return t1 > 0 ? t1 : t2 > 0 ? t2 : -1
}

export class Brain {
  name = "oval-ronin"
  private cfg: any
  private w!: World
  private nav!: Nav
  private mapOk = false
  private rnd: () => number

  // per-tick view of ourselves
  private me: any = null
  private obs: any = null
  private t = 0
  private R = 2.5
  private H = 9
  private eyeH = 8
  private muzH = 7
  private gun = -1
  private laser = -1
  private light = -1

  // memory
  private tracks = new Map<number, Track>()
  private attackT = new Map<number, number>()
  private pickups = new Map<number, Item>()
  private crates = new Map<number, Item>()
  private cubes = new Map<number, Item>()
  private ignore = new Set<number>()
  private dmgIn: { t: number; a: number }[] = []
  private dmgOut: { t: number; a: number; to: number }[] = []
  private lastHurtT = -99
  private lastHurtYaw = 0

  // control state
  private cmdYaw = 0
  private cmdPitch = 0
  private laserHold = false
  private strafe = 1
  private strafeFlipT = 0
  private retreat = false
  private retreatT = 0
  private primaryId = -1
  private lastShotT = -99
  private path: number[] | null = null
  private pathI = 0
  private pathT = -99
  private pathGX = 0
  private pathGY = 0
  private hist: { t: number; x: number; y: number }[] = []
  private hop: { x: number; y: number } | null = null
  /** What the legs are doing this tick (for tests and debugging). */
  label = ""
  /** Ticks where think() threw and the fallback answered instead. */
  errors = 0
  private unstuckT = -99
  private unstuckX = 0
  private unstuckY = 0
  private zoneKey = ""
  private zFrom = { x: 0, y: 0, r: 1e9 }
  private explore: { x: number; y: number; until: number } | null = null
  private cover: { x: number; y: number; until: number } | null = null

  constructor(hello: any) {
    this.cfg = hello.config
    // Mixed with the clock on purpose: two runs of the same build are then two different samples.
    let s = ((hello.seed ?? 1) ^ (Date.now() & 0x7fffffff) ^ ((hello.slot ?? 0) * 7919)) >>> 0
    this.rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0
      let x = Math.imul(s ^ (s >>> 15), 1 | s)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
    try {
      this.w = new World(hello.map?.dir ?? "/arena", hello.map?.files)
      this.nav = new Nav(this.w)
      // one walkable grid per size we can grow to, built now so that picking up a cube costs nothing later
      const per = this.cfg.cubes?.size_per_cube ?? 0.05
      for (let c = 14; c >= 0; c--) this.nav.rebuild(this.cfg.mech.radius * (1 + per * c))
      this.mapOk = true
    } catch (e) {
      log("map load failed, running without it:", e)
    }
  }

  act(obs: any): any {
    let a: any
    try {
      a = this.mapOk ? this.think(obs) : this.fallback(obs)
    } catch (e) {
      this.errors++
      if (this.errors <= 5 || this.errors % 200 === 0) log("think failed at tick", obs?.tick, e)
      a = this.fallback(obs)
    }
    return this.sanitize(a)
  }

  // ------------------------------------------------------------------ safety nets

  /** The kit example's behaviour: used when the map is missing or think() throws. */
  private fallback(obs: any): any {
    const me = obs.self
    const [x, y, z] = me.pos
    const g = obs.zone.next_center
    const yaw = Math.atan2(g[1] - y, g[0] - x)
    const a: any = { move: [Math.cos(yaw), Math.sin(yaw)], aim: [yaw, 0], boost: !me.in_zone, jump: obs.tick % 40 === 0 }
    if (obs.offer) a.pick = 0
    let best: any = null
    let bd = Infinity
    for (const m of obs.mechs) {
      if (m.kind !== "mech") continue
      const d = hyp(m.pos[0] - x, m.pos[1] - y)
      if (d < bd) {
        bd = d
        best = m
      }
    }
    if (best) {
      a.aim = [Math.atan2(best.pos[1] - y, best.pos[0] - x), Math.atan2(best.pos[2] - z - 2.5, bd)]
      a.fire = [true, true]
    }
    return a
  }

  private sanitize(a: any): any {
    const out: any = {}
    const num = (v: any, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d)
    let mx = num(a.move?.[0], 0)
    let my = num(a.move?.[1], 0)
    const ml = hyp(mx, my)
    if (ml > 0.998) {
      // a hair under 1 so rounding to three decimals cannot push the length over it
      mx *= 0.998 / ml
      my *= 0.998 / ml
    }
    out.move = [Math.round(mx * 1000) / 1000, Math.round(my * 1000) / 1000]
    const yaw = wrap(num(a.aim?.[0], this.cmdYaw))
    const lo = this.cfg?.mech?.min_pitch ?? -0.7
    const hi = this.cfg?.mech?.max_pitch ?? 1.3
    const pitch = clamp(num(a.aim?.[1], 0), lo, hi)
    out.aim = [Math.round(yaw * 10000) / 10000, Math.round(pitch * 10000) / 10000]
    this.cmdYaw = yaw
    this.cmdPitch = pitch
    out.boost = !!a.boost
    out.jump = !!a.jump
    out.fire = [!!a.fire?.[0], !!a.fire?.[1]]
    if (a.reload) out.reload = true
    if (Number.isInteger(a.pick)) out.pick = a.pick
    if (Number.isInteger(a.take)) out.take = a.take
    if (a.drop === 0 || a.drop === 1) out.drop = a.drop
    return out
  }

  // ------------------------------------------------------------------ the decision

  private think(obs: any): any {
    const me = (this.me = obs.self)
    this.obs = obs
    const t = (this.t = obs.t)
    const cfg = this.cfg
    const st = me.stats ?? {}
    const sc = 1 + (cfg.cubes?.size_per_cube ?? 0.05) * (me.cubes ?? 0)
    this.R = Math.max(st.radius ?? 0, cfg.mech.radius * sc)
    this.H = Math.max(st.height ?? 0, cfg.mech.height * sc)
    this.eyeH = st.eye_height ?? cfg.mech.eye_height * sc
    this.muzH = st.muzzle_height ?? cfg.mech.muzzle_height * sc
    if (Math.abs(this.R - this.nav.radius) > 0.06) {
      this.nav.rebuild(this.R)
      this.path = null
    }
    this.gun = this.laser = this.light = -1
    for (let i = 0; i < me.weapons.length; i++) {
      const k = me.weapons[i]?.kind
      if (k === "gun") this.gun = i
      else if (k === "laser") this.laser = i
      else if (k === "lightning") this.light = i
    }
    const [mx, my, mz] = me.pos as number[]
    const hpFrac = me.hp / Math.max(1, me.max_hp)
    const act: any = { fire: [false, false] }

    this.remember(obs)
    if (obs.offer?.choices?.length) act.pick = this.pickUpgrade(obs.offer.choices)
    const zone = this.zoneInfo(obs)

    // --- who matters
    const enemies = this.assess()
    const threats = enemies.filter((e) => !e.tr.ghost).slice(0, 4)
    let primary: Enemy | null = null
    let bestScore = Infinity
    for (const e of enemies) {
      let s = e.tr.hp / this.myDps(e)
      if (e.attacked) s *= 0.7
      if (e.tr.id === this.primaryId) s *= 0.8
      if (!e.shootable) s += 100
      if (e.tr.ghost) s += 200
      if (s < bestScore) {
        bestScore = s
        primary = e
      }
    }
    this.primaryId = primary ? primary.tr.id : -1
    if (primary && !primary.tr.ghost && !threats.includes(primary)) threats[threats.length >= 4 ? 3 : threats.length] = primary
    if (primary?.shootable) this.lastShotT = t

    // --- fight / hide / travel
    const cut = t - 4
    while (this.dmgIn.length && this.dmgIn[0].t < cut) this.dmgIn.shift()
    while (this.dmgOut.length && this.dmgOut[0].t < cut) this.dmgOut.shift()
    let inDps = 0
    for (const d of this.dmgIn) inDps += d.a
    inDps /= 4
    let outDps = 0
    if (primary) for (const d of this.dmgOut) if (d.to === primary.tr.id) outDps += d.a
    outDps /= 4
    if (this.retreat) {
      if (hpFrac > 0.85 || t - this.retreatT > 25 || !primary) this.retreat = false
    } else if (primary && hpFrac < 0.45) {
      const mine = me.hp / Math.max(inDps, 40)
      const theirs = primary.tr.hp / Math.max(outDps, 40)
      if (mine < theirs * 0.9) {
        this.retreat = true
        this.retreatT = t
      }
    }

    const shells = this.shells(obs)
    const gw = this.gun >= 0 ? me.weapons[this.gun] : null
    const lw = this.laser >= 0 ? me.weapons[this.laser] : null
    const tw = this.light >= 0 ? me.weapons[this.light] : null
    const gunDown = !gw || gw.ammo <= 0 || gw.reload > 0.6
    const laserDown = !lw || (lw.cooldown > 0.6 && !(lw.charge > 0))
    const lightUp = !!tw && !!primary && primary.d < tw.stats.range * 0.9 && me.energy > 10
    const lasered = threats.some((e) => e.tr.charging && e.seesMe && Math.abs(wrap(e.tr.aimYaw - (e.yaw + Math.PI))) < 0.2)

    let mv: Move = { x: 0, y: 0, boost: false, jump: false }
    let label = "idle"
    const danger = shells.find((s) => hyp(mx - s.x, my - s.y) < s.r && s.tti < 3)
    if (t < this.unstuckT) {
      mv = { x: this.unstuckX, y: this.unstuckY, boost: false, jump: false }
      label = "unstuck"
    } else if (zone.urgent) {
      mv = this.travel({ x: zone.gx, y: zone.gy, stop: 2, boost: !me.in_zone || zone.tight, kind: "zone" })
      label = "zone"
    } else if (danger && !primary) {
      const d = hyp(mx - danger.x, my - danger.y) || 1
      mv = { x: (mx - danger.x) / d, y: (my - danger.y) / d, boost: true, jump: false }
      label = "dodge"
    } else if (primary && primary.tr.ghost) {
      // being hit by someone we cannot see: sidestep across their line of fire while the torso looks for them
      this.flipStrafe(0.5)
      const px = -Math.sin(primary.yaw) * this.strafe
      const py = Math.cos(primary.yaw) * this.strafe
      mv = this.nav.lineWalkable(mx, my, mx + px * 6, my + py * 6, 0.3) ? { x: px, y: py, boost: false, jump: false } : { x: -px, y: -py, boost: false, jump: false }
      label = "ghost"
    } else if (primary) {
      const recent = primary.shootable || t - this.lastShotT < 1
      if (this.retreat || (!recent && hpFrac <= 0.55)) {
        mv = this.hide(primary, threats, shells, zone, true)
        label = "hide"
      } else if (recent) {
        this.flipStrafe(clamp(primary.d / 252 + 0.15, 0.3, 0.9))
        let done = false
        if (lasered || (gunDown && laserDown && !lightUp)) {
          const c = this.local("hide", primary, threats, 0, shells, zone)
          if (c && c.hidden) {
            mv = this.toward(c.x, c.y, me.energy > 8)
            label = "duck"
            done = true
          }
        }
        if (!done) {
          const pref = this.prefRange(primary)
          const c = this.local("fight", primary, threats, pref, shells, zone)
          mv = c ? this.toward(c.x, c.y, primary.d > pref + 50 && me.energy > 40) : { x: 0, y: 0, boost: false, jump: false }
          label = "fight"
        }
      } else if (primary.attacked || primary.tr.hp < primary.tr.maxHp * 0.6) {
        // lost sight of someone worth finishing, and we are healthy: go and find them
        mv = this.travel({ x: primary.x, y: primary.y, stop: 25, boost: false, kind: "hunt" })
        label = "hunt"
      } else {
        const g = this.chooseGoal(zone, hpFrac)
        mv = this.travel(g)
        label = g.kind
      }
    } else {
      const g = this.chooseGoal(zone, hpFrac)
      mv = this.travel(g)
      label = g.kind
    }
    this.watchStuck(mv, label)

    // --- torso and triggers
    const aim = this.aimAndFire(act, primary, enemies, hpFrac, label)
    act.move = [mv.x, mv.y]
    act.boost = mv.boost
    act.jump = mv.jump
    act.aim = aim

    // --- pick up a second weapon when standing on one
    if (me.weapons.some((x: any) => !x)) {
      const reach = (cfg.loot?.pickup_radius ?? 4) * 0.95
      let bestRank = 99
      for (const p of obs.pickups) {
        const rank = WANT.indexOf(p.kind)
        if (rank < 0 || rank >= bestRank || this.ignore.has(p.id)) continue
        if (hyp(p.pos[0] - mx, p.pos[1] - my) <= reach && Math.abs(p.pos[2] - mz) <= 3.8) {
          bestRank = rank
          act.take = p.id
        }
      }
    }
    return act
  }

  // ------------------------------------------------------------------ memory

  private remember(obs: any) {
    const t = this.t
    const me = this.me
    const [mx, my, mz] = me.pos as number[]
    for (const m of obs.mechs) {
      let tr = this.tracks.get(m.id)
      if (!tr) {
        tr = { id: m.id, npc: false, ghost: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, aimYaw: 0, hp: 1400, maxHp: 1400, cubes: 0, weapons: [], charging: false, t }
        this.tracks.set(m.id, tr)
      }
      tr.npc = m.kind === "npc"
      tr.ghost = false
      tr.x = m.pos[0]
      tr.y = m.pos[1]
      tr.z = m.pos[2]
      tr.vx = m.vel?.[0] ?? 0
      tr.vy = m.vel?.[1] ?? 0
      tr.vz = m.vel?.[2] ?? 0
      tr.aimYaw = m.aim?.[0] ?? 0
      if (typeof m.hp === "number") tr.hp = m.hp
      if (typeof m.max_hp === "number") tr.maxHp = m.max_hp
      tr.cubes = m.cubes ?? 0
      tr.weapons = m.weapons ?? tr.weapons
      tr.charging = !!m.charging
      tr.t = t
    }
    for (const [id, tr] of this.tracks) if (t - tr.t > (tr.npc ? 4 : tr.ghost ? 6 : 15)) this.tracks.delete(id)

    this.sync(this.pickups, obs.pickups)
    this.sync(this.crates, obs.crates)
    this.sync(this.cubes, obs.cubes)

    for (const e of obs.events) {
      if (e.type === "damaged") {
        this.dmgIn.push({ t, a: e.amount ?? 0 })
        if (typeof e.by === "number" && e.by < 100) {
          this.attackT.set(e.by, t)
          this.lastHurtT = t
          if (typeof e.bearing === "number") this.lastHurtYaw = e.bearing
          const tr = this.tracks.get(e.by)
          if ((!tr || t - tr.t > 1.5) && typeof e.bearing === "number") {
            const guess = e.weapon === "lightning" ? 30 : e.weapon === "gun" ? 90 : e.weapon === "mortar" ? 80 : 130
            this.tracks.set(e.by, {
              id: e.by, npc: false, ghost: true,
              x: mx + Math.cos(e.bearing) * guess, y: my + Math.sin(e.bearing) * guess, z: mz,
              vx: 0, vy: 0, vz: 0, aimYaw: e.bearing + Math.PI,
              hp: tr?.hp ?? 1400, maxHp: tr?.maxHp ?? 1400, cubes: tr?.cubes ?? 0,
              weapons: tr?.weapons ?? [e.weapon], charging: false, t,
            })
          }
        }
      } else if (e.type === "hit") this.dmgOut.push({ t, a: e.amount ?? 0, to: e.target })
      else if (e.type === "kill") {
        this.tracks.delete(e.target)
        this.attackT.delete(e.target)
      } else if (e.type === "took") this.pickups.delete(e.id)
      else if (e.type === "dropped") this.ignore.add(e.id)
      else if (e.type === "take_failed") {
        if (e.reason === "gone") this.pickups.delete(e.id)
        else if (e.reason !== "range") this.ignore.add(e.id)
      }
    }
  }

  private sync(map: Map<number, Item>, list: any[]) {
    const t = this.t
    const [mx, my, mz] = this.me.pos as number[]
    const now = new Set<number>()
    for (const it of list) {
      now.add(it.id)
      map.set(it.id, { id: it.id, x: it.pos[0], y: it.pos[1], z: it.pos[2], kind: it.kind ?? "", hp: it.hp ?? 0, seen: t })
    }
    // anything close with a clear line that is no longer listed has been taken or destroyed
    const near = ((this.cfg.vision?.near_range ?? 45) + (this.me.stats?.near_range_bonus ?? 0)) * 0.75
    for (const [id, e] of map) {
      if (now.has(id)) continue
      if (hyp(e.x - mx, e.y - my) < near && this.w.los(mx, my, mz + this.eyeH, e.x, e.y, e.z + 1, 1)) map.delete(id)
    }
  }

  private pickUpgrade(choices: any[]): number {
    let best = 0
    let rank = 999
    for (let i = 0; i < choices.length; i++) {
      const r = UPGRADES.indexOf(choices[i]?.id)
      if (r >= 0 && r < rank) {
        rank = r
        best = i
      }
    }
    return best
  }

  // ------------------------------------------------------------------ zone

  private zoneInfo(obs: any) {
    const z = obs.zone
    const me = this.me
    const t = this.t
    const [mx, my] = me.pos as number[]
    const key = z.shrink_start + ":" + z.next_radius
    if (key !== this.zoneKey) {
      this.zoneKey = key
      this.zFrom = { x: z.center[0], y: z.center[1], r: z.radius }
    }
    const nx = z.next_center[0]
    const ny = z.next_center[1]
    const nr = z.next_radius
    const span = Math.max(0.001, z.shrink_end - z.shrink_start)
    const at = (tau: number) => {
      const f = clamp((tau - z.shrink_start) / span, 0, 1)
      return { x: this.zFrom.x + (nx - this.zFrom.x) * f, y: this.zFrom.y + (ny - this.zFrom.y) * f, r: this.zFrom.r + (nr - this.zFrom.r) * f }
    }
    const soon = at(t + 5)
    const walk = (me.stats?.walk_speed ?? 11.7) * 0.7
    const inner = Math.max(0, nr - Math.min(40, nr * 0.6))
    const dn = hyp(mx - nx, my - ny)
    const outside = dn - Math.max(0, nr - Math.min(25, nr * 0.5))
    const late = outside > 0 && t + outside / walk + 8 >= z.shrink_end
    const edge = hyp(mx - soon.x, my - soon.y) > Math.min(soon.r, z.radius) - 15
    const urgent = !me.in_zone || late || edge
    // nearest point of the inner disk of the next circle
    let gx = nx
    let gy = ny
    if (dn > 1e-6 && inner > 0) {
      const k = Math.min(1, inner / dn)
      gx = nx + (mx - nx) * k
      gy = ny + (my - ny) * k
    }
    return { urgent, tight: hyp(mx - soon.x, my - soon.y) > soon.r - 5, gx, gy, nx, ny, nr, inner, cx: soon.x, cy: soon.y, cr: Math.min(soon.r, z.radius), shrinkStart: z.shrink_start, curX: z.center[0], curY: z.center[1], curR: z.radius }
  }

  /** Will this spot still be inside the zone if we walk there now? */
  private zoneOk(zone: any, x: number, y: number): boolean {
    if (hyp(x - zone.nx, y - zone.ny) <= zone.nr - 5) return true
    const [mx, my] = this.me.pos as number[]
    const eta = hyp(x - mx, y - my) / 8
    return this.t + eta + 20 < zone.shrinkStart && hyp(x - zone.curX, y - zone.curY) <= zone.curR - 10
  }

  // ------------------------------------------------------------------ enemies

  private assess(): Enemy[] {
    const me = this.me
    const t = this.t
    const cfg = this.cfg
    const [mx, my, mz] = me.pos as number[]
    const out: Enemy[] = []
    const maxRange = Math.max(this.gun >= 0 ? me.weapons[this.gun].stats.range : 0, this.laser >= 0 ? me.weapons[this.laser].stats.range : 0, 60)
    for (const tr of this.tracks.values()) {
      if (tr.npc) continue
      const age = t - tr.t
      if (age > 6) continue
      const lead = Math.min(age, 1)
      const x = tr.x + tr.vx * lead
      const y = tr.y + tr.vy * lead
      const z = tr.z
      const dx = x - mx
      const dy = y - my
      const d = hyp(dx, dy)
      const sc = 1 + (cfg.cubes?.size_per_cube ?? 0.05) * tr.cubes
      const hgt = cfg.mech.height * sc
      const cz = z + hgt / 2
      const emz = z + cfg.mech.muzzle_height * sc
      const attacked = t - (this.attackT.get(tr.id) ?? -99) < 12
      const closing = d > 1 ? -((tr.vx - me.vel[0]) * dx + (tr.vy - me.vel[1]) * dy) / d : 0
      const pointing = Math.abs(wrap(tr.aimYaw - Math.atan2(-dy, -dx))) < 0.25
      if (!(attacked || d <= 120 || (d <= 280 && (closing > 3 || pointing)))) continue
      const fresh = !tr.ghost && age <= 0.15
      const shootable = fresh && d <= maxRange && this.w.los(mx, my, mz + this.muzH, x, y, cz)
      const seesMe = fresh && this.w.los(x, y, emz, mx, my, mz + this.H / 2)
      out.push({ tr, x, y, z, d, yaw: Math.atan2(dy, dx), rad: cfg.mech.radius * sc, hgt, cz, mz: emz, shootable, seesMe, attacked, closing })
    }
    out.sort((a, b) => a.d - b.d)
    return out
  }

  /** Rough damage per second we can put on this enemy at its current range. */
  private myDps(e: Enemy): number {
    const me = this.me
    let dps = 20
    if (this.gun >= 0) {
      const s = me.weapons[this.gun].stats
      if (e.d <= s.range) dps += (s.damage / s.cooldown) * clamp(1.2 - e.d / 200, 0.3, 1)
    }
    if (this.laser >= 0) {
      const s = me.weapons[this.laser].stats
      if (e.d <= s.range) dps += (s.damage / (s.charge + s.cooldown)) * (e.tr.weapons.includes("mortar") ? 1.6 : 1)
    }
    if (this.light >= 0) {
      const s = me.weapons[this.light].stats
      if (e.d <= s.range) dps += s.damage / s.cooldown
    }
    return dps
  }

  private prefRange(e: Enemy): number {
    const me = this.me
    const theyLaser = e.tr.weapons.includes("laser")
    const theyLight = e.tr.weapons.includes("lightning")
    if (this.light >= 0 && me.energy > 15) return 28
    if (theyLight) return this.laser >= 0 ? 110 : 80
    if (this.laser >= 0 && !theyLaser) return 100
    if (theyLaser && this.laser < 0) return 40
    return 60
  }

  private flipStrafe(every: number) {
    if (this.t >= this.strafeFlipT) {
      this.strafe = -this.strafe
      this.strafeFlipT = this.t + every * (0.6 + this.rnd() * 0.9)
    }
  }

  /** Where visible mortar shells will land, with the radius to stay out of. */
  private shells(obs: any): { x: number; y: number; r: number; tti: number }[] {
    const out: { x: number; y: number; r: number; tti: number }[] = []
    const mc = this.cfg.weapons?.mortar
    if (!mc) return out
    const [mx, my] = this.me.pos as number[]
    for (const p of obs.projectiles) {
      if (p.kind !== "mortar") continue
      let x = p.pos[0]
      let y = p.pos[1]
      let z = p.pos[2]
      let vz = p.vel[2]
      const dt = 0.05
      let tti = 0
      for (let k = 0; k < 160; k++) {
        x += p.vel[0] * dt
        y += p.vel[1] * dt
        vz -= mc.gravity * dt
        z += vz * dt
        tti += dt
        if (!this.w.inGrid(x, y) || z <= this.w.surface(x, y)) break
      }
      if (hyp(x - mx, y - my) < 45) out.push({ x, y, r: mc.splash_radius * 1.7 + this.R + 2, tti })
    }
    return out
  }

  // ------------------------------------------------------------------ legs

  private toward(x: number, y: number, boost: boolean): Move {
    const [mx, my] = this.me.pos as number[]
    const d = hyp(x - mx, y - my)
    if (d < 0.3) return { x: 0, y: 0, boost: false, jump: false }
    return { x: (x - mx) / d, y: (y - my) / d, boost, jump: false }
  }

  /**
   * Score positions we can reach in the next second and return the best.
   * "fight": keep the enemy in view at the preferred range while sliding sideways.
   * "hide": get out of every known enemy's line of fire.
   */
  private local(mode: "fight" | "hide", primary: Enemy, threats: Enemy[], pref: number, shells: { x: number; y: number; r: number }[], zone: any): { x: number; y: number; hidden: boolean } | null {
    const [mx, my] = this.me.pos as number[]
    const w = this.w
    const pd = Math.max(1, primary.d)
    const perpX = (-(primary.y - my) / pd) * this.strafe
    const perpY = ((primary.x - mx) / pd) * this.strafe
    const phase = this.rnd() * (TAU / 16)
    let best: { x: number; y: number; hidden: boolean } | null = null
    let bestS = -Infinity
    for (let k = -1; k < 32; k++) {
      let cx = mx
      let cy = my
      if (k >= 0) {
        const ang = (k % 16) * (TAU / 16) + phase
        const r = k < 16 ? 5 : 10
        cx = mx + Math.cos(ang) * r
        cy = my + Math.sin(ang) * r
        if (!this.nav.lineWalkable(mx, my, cx, cy, 0.3)) continue
      }
      const cz = w.surface(cx, cy)
      let expP = false
      let expO = 0
      for (const e of threats) {
        const vis = w.los(e.x, e.y, e.mz, cx, cy, cz + this.H * 0.5) || w.los(e.x, e.y, e.mz, cx, cy, cz + this.H * 0.92)
        if (e === primary) expP = vis
        else if (vis) expO++
      }
      const dP = hyp(primary.x - cx, primary.y - cy)
      let s = 0
      if (mode === "fight") {
        if (expP) s += 3
        s -= 2 * expO
        s -= Math.abs(dP - pref) / 10
        s += (1.5 * ((cx - mx) * perpX + (cy - my) * perpY)) / 10
      } else {
        s -= 6 * ((expP ? 1 : 0) + expO)
        s += 0.03 * dP
        s -= 0.05 * hyp(cx - mx, cy - my)
      }
      for (const sh of shells) if (hyp(cx - sh.x, cy - sh.y) < sh.r) s -= 8
      const out = hyp(cx - zone.cx, cy - zone.cy) - (zone.cr - 8)
      if (out > 0) s -= 0.5 + out / 5
      if (w.clearance(cx, cy) < this.R + 1.5) s -= 0.5
      if (s > bestS) {
        bestS = s
        best = { x: cx, y: cy, hidden: !expP && expO === 0 }
      }
    }
    return best
  }

  /** Break line of sight: a hidden spot within a step or two if there is one, else the nearest cover. */
  private hide(primary: Enemy, threats: Enemy[], shells: { x: number; y: number; r: number }[], zone: any, boost: boolean): Move {
    const me = this.me
    const [mx, my] = me.pos as number[]
    const w = this.w
    const b = boost && me.energy > 8
    if (!threats.length) return this.travel({ x: zone.gx, y: zone.gy, stop: 5, boost: false, kind: "zone" })
    const near = this.local("hide", primary, threats, 0, shells, zone)
    if (near && near.hidden) {
      this.cover = null
      return this.toward(near.x, near.y, b)
    }
    if (!this.cover || this.t > this.cover.until) {
      let best: { x: number; y: number } | null = null
      let bestS = Infinity
      for (const r of [16, 24, 34, 46, 60])
        for (let k = 0; k < 20; k++) {
          const ang = (k * TAU) / 20
          const cx = mx + Math.cos(ang) * r
          const cy = my + Math.sin(ang) * r
          if (!this.nav.free(cx, cy, 1) || !this.nav.inMain(cx, cy)) continue
          if (hyp(cx - zone.cx, cy - zone.cy) > zone.cr - 10) continue
          const cz = w.surface(cx, cy)
          let seen = false
          for (const e of threats)
            if (w.los(e.x, e.y, e.mz, cx, cy, cz + this.H * 0.5) || w.los(e.x, e.y, e.mz, cx, cy, cz + this.H * 0.92)) {
              seen = true
              break
            }
          if (seen) continue
          // closer is better, and not by walking toward the enemy
          const s = r + 0.4 * Math.max(0, primary.d - hyp(cx - primary.x, cy - primary.y))
          if (s < bestS) {
            bestS = s
            best = { x: cx, y: cy }
          }
        }
      this.cover = best ? { ...best, until: this.t + 1 } : null
    }
    if (this.cover) return this.travel({ x: this.cover.x, y: this.cover.y, stop: 1, boost: b, kind: "cover" })
    // nowhere to hide: back away while fighting
    const c = this.local("fight", primary, threats, primary.d + 40, shells, zone)
    return c ? this.toward(c.x, c.y, b) : { x: 0, y: 0, boost: false, jump: false }
  }

  private reachable(e: Item): boolean {
    return e.z - this.w.ground(e.x, e.y) < 2.5 && this.nav.snap(e.x, e.y, 2) >= 0
  }

  private chooseGoal(zone: any, hpFrac: number): Goal {
    const me = this.me
    const [mx, my, mz] = me.pos as number[]
    const t = this.t
    // 1. a second weapon
    if (me.weapons.some((x: any) => !x)) {
      let best: Item | null = null
      let bestS = Infinity
      for (const p of this.pickups.values()) {
        const rank = WANT.indexOf(p.kind)
        if (rank < 0 || this.ignore.has(p.id)) continue
        const d = hyp(p.x - mx, p.y - my)
        if (d > 260 || !this.reachable(p) || !this.zoneOk(zone, p.x, p.y)) continue
        const s = d + rank * 40
        if (s < bestS) {
          bestS = s
          best = p
        }
      }
      if (best) return { x: best.x, y: best.y, stop: 1.5, boost: me.energy > 30, kind: "weapon" }
    }
    // 2. cubes lying around
    if ((me.cubes ?? 0) < CUBE_TARGET) {
      let best: Item | null = null
      let bd = 80
      for (const c of this.cubes.values()) {
        const d = hyp(c.x - mx, c.y - my)
        if (d < bd && this.reachable(c) && this.zoneOk(zone, c.x, c.y)) {
          bd = d
          best = c
        }
      }
      if (best) return { x: best.x, y: best.y, stop: 0.5, boost: false, kind: "cube" }
    }
    // 3. crates, when healthy enough that shooting does not cost us healing
    if (hpFrac >= 0.75 && (me.cubes ?? 0) < CUBE_TARGET) {
      let best: Item | null = null
      let bd = 220
      for (const c of this.crates.values()) {
        const d = hyp(c.x - mx, c.y - my)
        if (d < bd && this.reachable(c) && this.zoneOk(zone, c.x, c.y)) {
          bd = d
          best = c
        }
      }
      if (best) {
        const clear = bd < 45 && this.w.los(mx, my, mz + this.muzH, best.x, best.y, best.z + 1.2)
        return { x: best.x, y: best.y, stop: clear ? 20 : 3, boost: false, kind: "crate" }
      }
    }
    // 4. nothing known: get inside the next circle, then wander it looking for loot
    if (hyp(mx - zone.nx, my - zone.ny) > zone.inner + 5) return { x: zone.gx, y: zone.gy, stop: 3, boost: false, kind: "rotate" }
    if (!this.explore || t > this.explore.until || hyp(this.explore.x - mx, this.explore.y - my) < 6 || hyp(this.explore.x - zone.nx, this.explore.y - zone.ny) > zone.inner + 5) {
      this.explore = null
      for (let k = 0; k < 12 && !this.explore; k++) {
        const ang = this.rnd() * TAU
        const r = Math.sqrt(this.rnd()) * Math.max(10, zone.inner)
        const x = zone.nx + Math.cos(ang) * r
        const y = zone.ny + Math.sin(ang) * r
        if (hyp(x - mx, y - my) < 220 && this.nav.free(x, y, 1) && this.nav.inMain(x, y)) this.explore = { x, y, until: t + 18 }
      }
    }
    if (this.explore) return { x: this.explore.x, y: this.explore.y, stop: 4, boost: false, kind: "explore" }
    return { x: zone.gx, y: zone.gy, stop: 3, boost: false, kind: "rotate" }
  }

  /** Walk to a goal: straight if the way is clear, along an A* path otherwise, hopping walls off the grid. */
  private travel(g: Goal): Move {
    const me = this.me
    const [mx, my, mz] = me.pos as number[]
    const nav = this.nav
    const dGoal = hyp(g.x - mx, g.y - my)
    if (dGoal <= g.stop) return { x: 0, y: 0, boost: false, jump: false }
    const onNav = me.grounded && Math.abs(mz - this.w.surface(mx, my)) < 2.5 && nav.snap(mx, my, 2) >= 0
    if (!onNav) {
      // on a roof, in a pit, or in the air: head for the goal if it is off the grid too, else for the
      // nearest walkable ground. One target per hop, so we do not change our mind in mid-air.
      if (!me.grounded && this.hop) return this.direct(this.hop.x, this.hop.y, g.kind === "zone")
      let tx = g.x
      let ty = g.y
      if (nav.snap(g.x, g.y, 3) >= 0) {
        const c = nav.snap(mx, my, 60)
        if (c >= 0) {
          tx = nav.cx(c)
          ty = nav.cy(c)
        }
      }
      this.hop = { x: tx, y: ty }
      return this.direct(tx, ty, g.kind === "zone")
    }
    this.hop = null
    const boost = g.boost && me.energy > 5
    // margin 1 m: with the grid's rounding that keeps the real wall at least a radius away, so we never scrape
    if (dGoal < 150 && nav.lineWalkable(mx, my, g.x, g.y, 1)) return { x: (g.x - mx) / dGoal, y: (g.y - my) / dGoal, boost, jump: false }
    if (!this.path || hyp(g.x - this.pathGX, g.y - this.pathGY) > 4 || this.t - this.pathT > 2) {
      this.path = nav.findPath(mx, my, g.x, g.y)
      this.pathI = 0
      this.pathT = this.t
      this.pathGX = g.x
      this.pathGY = g.y
    }
    const p = this.path
    if (!p || p.length < 2) return this.direct(g.x, g.y, g.kind === "zone")
    const n = p.length / 2
    const ex = p[2 * n - 2]
    const ey = p[2 * n - 1]
    if (hyp(ex - mx, ey - my) < 5) {
      // end of the walkable path but not at the goal: the goal is off the grid (roof, pit)
      if (hyp(g.x - ex, g.y - ey) > Math.max(3, g.stop)) {
        this.hop = { x: g.x, y: g.y }
        return this.direct(g.x, g.y, g.kind === "zone")
      }
      return { x: (g.x - mx) / dGoal, y: (g.y - my) / dGoal, boost, jump: false }
    }
    let k = Math.min(n - 1, this.pathI + 16)
    for (; k > this.pathI; k--) if (nav.lineWalkable(mx, my, p[2 * k], p[2 * k + 1], 1)) break
    this.pathI = k
    const tx = p[2 * k]
    const ty = p[2 * k + 1]
    const d = hyp(tx - mx, ty - my)
    if (d < 1.5 && k < n - 1) {
      this.pathI = k + 1
      return this.travel(g)
    }
    return d > 1e-6 ? { x: (tx - mx) / d, y: (ty - my) / d, boost, jump: false } : { x: 0, y: 0, boost: false, jump: false }
  }

  /** Straight at a point, jumping and jetting over whatever wall is in the way. */
  private direct(tx: number, ty: number, urgent: boolean): Move {
    const me = this.me
    const w = this.w
    const [mx, my, mz] = me.pos as number[]
    const d = hyp(tx - mx, ty - my)
    if (d < 0.5) return { x: 0, y: 0, boost: false, jump: false }
    const ux = (tx - mx) / d
    const uy = (ty - my) / d
    // The first wall on the way: a rise of more than one step between consecutive metres. A slope,
    // however long, is walked. `need` is the height our feet must reach to get over it.
    const look = Math.min(d + this.R, this.R + 9)
    let cur = mz
    let wallAt = -1
    let need = -Infinity
    for (let s = 1; s <= look; s += 1) {
      const sf = w.surface(mx + ux * s, my + uy * s)
      if (sf - cur > STEP_UP) {
        wallAt = s
        for (let q = s; q <= s + 2 * this.R + 2; q += 1) need = Math.max(need, w.surface(mx + ux * q, my + uy * q))
        break
      }
      cur = me.grounded ? sf : Math.max(sf, mz)
    }
    if (wallAt < 0 || wallAt > this.R + 5) return { x: ux, y: uy, boost: false, jump: false }
    if (!me.grounded) return { x: ux, y: uy, boost: me.energy > 0.5 && mz < need + 1.5, jump: false }
    // On the ground at the foot of it: only start a climb we have the energy to finish.
    const rise = need - mz
    const maxE = me.max_energy ?? 100
    const cost = ((rise + 3) / 8.9) * (me.stats?.jet_drain ?? 15) + 8
    if (cost > maxE * 0.97) return { x: -uy, y: ux, boost: false, jump: false } // too tall: feel along it
    if (me.energy >= cost) return { x: ux, y: uy, boost: true, jump: true }
    return { x: 0, y: 0, boost: false, jump: false } // wait for the jets to recharge
  }

  private watchStuck(mv: Move, label: string) {
    const [mx, my] = this.me.pos as number[]
    const t = this.t
    this.label = label
    const travelling = !(label === "fight" || label === "duck" || label === "ghost" || label === "dodge" || label === "unstuck")
    if (!travelling || hyp(mv.x, mv.y) <= 0.5 || !this.me.grounded) {
      this.hist.length = 0
      return
    }
    this.hist.push({ t, x: mx, y: my })
    while (this.hist.length && this.hist[0].t < t - 1.3) this.hist.shift()
    const h = this.hist[0]
    if (t - h.t >= 1.2 && hyp(mx - h.x, my - h.y) < 0.8) {
      // pushed against something for over a second: sidestep, jump, and plan again
      const side = this.rnd() < 0.5 ? 1 : -1
      const back = 0.4
      const ux = -mv.y * side - mv.x * back
      const uy = mv.x * side - mv.y * back
      const l = hyp(ux, uy) || 1
      this.unstuckX = ux / l
      this.unstuckY = uy / l
      this.unstuckT = t + 0.7
      this.path = null
      this.cover = null
      this.explore = null
      this.hist.length = 0
      mv.jump = true
    }
  }

  // ------------------------------------------------------------------ torso

  /**
   * Aim that hits a target moving at constant velocity, for a shot leaving `lat` seconds from now.
   * We command lat = 0.1 (the middle of the two ticks an action covers) and gate the trigger on
   * lat = 0: a torso that has been following last tick's command points exactly there, whichever
   * order the server slews and fires in, and the shot is then at most 0.05 s of target motion off.
   */
  private solve(tx: number, ty: number, tz: number, vx: number, vy: number, vz: number, speed: number, floorZ: number, lat: number): Sol {
    const me = this.me
    const ox = me.pos[0] + me.vel[0] * lat
    const oy = me.pos[1] + me.vel[1] * lat
    const oz = me.pos[2] + me.vel[2] * lat + this.muzH
    vz = clamp(vz, -12, 12)
    let px = tx + vx * lat
    let py = ty + vy * lat
    let pz = tz + vz * lat
    if (speed > 0) {
      const tf = intercept(px - ox, py - oy, pz - oz, vx, vy, vz, speed)
      if (tf > 0 && tf < 3) {
        px += vx * tf
        py += vy * tf
        pz += vz * tf
      }
    }
    if (pz < floorZ) pz = floorZ
    const dx = px - ox
    const dy = py - oy
    const dz = pz - oz
    return { yaw: Math.atan2(dy, dx), pitch: Math.atan2(dz, hyp(dx, dy)), d: hyp(dx, dy, dz) }
  }

  private aligned(sol: Sol, rad: number, hgt: number): boolean {
    const me = this.me
    const yawTol = Math.atan2(rad, sol.d) * 0.5
    const pitchTol = Math.atan2(hgt * 0.5, sol.d) * 0.6
    return Math.abs(wrap(me.aim[0] - sol.yaw)) <= yawTol && Math.abs(me.aim[1] - sol.pitch) <= pitchTol
  }

  private aimAndFire(act: any, primary: Enemy | null, enemies: Enemy[], hpFrac: number, label: string): number[] {
    const me = this.me
    const cfg = this.cfg
    const t = this.t
    const [mx, my, mz] = me.pos as number[]
    const gw = this.gun >= 0 ? me.weapons[this.gun] : null
    const lw = this.laser >= 0 ? me.weapons[this.laser] : null
    const tw = this.light >= 0 ? me.weapons[this.light] : null
    const cubeMul = 1 + (cfg.cubes?.damage_per_cube ?? 0.04) * Math.min(me.cubes ?? 0, cfg.cubes?.stat_cap ?? 10)
    let aim: number[] | null = null

    // lightning needs no aim beyond the cone: fire whenever a mech is inside it
    if (tw && tw.cooldown <= 0.1 && me.energy >= (tw.stats.energy ?? 3) + 1) {
      const half = (((tw.stats.cone_deg ?? 30) * Math.PI) / 180) * 0.45
      for (const e of enemies)
        if (!e.tr.ghost && t - e.tr.t <= 0.15 && e.d <= tw.stats.range * 0.93 && Math.abs(wrap(e.yaw - me.aim[0])) <= half && this.w.los(mx, my, mz + this.muzH, e.x, e.y, e.cz)) {
          act.fire[this.light] = true
          break
        }
    }

    if (primary && !primary.tr.ghost) {
      const tr = primary.tr
      const floor = this.w.surface(primary.x, primary.y) + primary.hgt * 0.3
      const gunOk = !!gw && gw.ammo > 0 && !(gw.reload > 0) && primary.d <= gw.stats.range * 0.97
      const gsol = gw ? this.solve(primary.x, primary.y, primary.cz, tr.vx, tr.vy, tr.vz, gw.stats.speed, floor, 0.1) : null
      const lsol = this.solve(primary.x, primary.y, primary.cz, tr.vx, tr.vy, tr.vz, 0, floor, 0.1)
      const gnow = gw ? this.solve(primary.x, primary.y, primary.cz, tr.vx, tr.vy, tr.vz, gw.stats.speed, floor, 0) : null
      const lnow = this.solve(primary.x, primary.y, primary.cz, tr.vx, tr.vy, tr.vz, 0, floor, 0)
      let useLaser = false
      if (lw) {
        const full = lw.stats.charge ?? 0.75
        const ch = lw.charge ?? 0
        const inRange = primary.d <= lw.stats.range * 0.97
        let hold = false
        if (ch > 0 || this.laserHold) {
          const minFrac = cfg.weapons?.laser?.min_frac ?? 0.35
          const frac = clamp(ch / full, 0, 1)
          const dmg = lw.stats.damage * (minFrac + (1 - minFrac) * frac) * cubeMul * (tr.weapons.includes("mortar") ? 1 + (lw.stats.cookoff ?? 0.6) : 1)
          const charged = ch >= full - 1e-3
          const lethal = ch >= (cfg.weapons?.laser?.min_charge ?? 0.15) && tr.hp <= dmg * 0.95
          useLaser = ch + 0.1 >= full - 1e-3 || lethal || !gunOk
          // let go only with the beam on the target; otherwise keep holding (it fires by itself after hold_s)
          hold = !(primary.shootable && inRange && (charged || lethal) && this.aligned(lnow, primary.rad, primary.hgt))
        } else if (lw.cooldown <= 0.05 && primary.shootable && inRange) {
          hold = true
          useLaser = !gunOk
        }
        act.fire[this.laser] = hold
        this.laserHold = hold
      }
      const sol = useLaser || !gsol ? lsol : gsol
      aim = [sol.yaw, sol.pitch]
      if (gw && gnow && gunOk && primary.shootable && this.aligned(gnow, primary.rad + 0.3, primary.hgt)) act.fire[this.gun] = true
      if (gw && !act.fire[this.gun] && !(gw.reload > 0) && gw.ammo < gw.stats.mag && t - this.lastShotT > 1.5 && gw.ammo <= gw.stats.mag * 0.5) act.reload = true
      return aim
    }

    // nobody to shoot: keep a charging laser held (releasing would fire it into nothing a tick later anyway)
    if (lw) {
      const hold = (lw.charge ?? 0) > 0 && this.laserHold
      act.fire[this.laser] = hold
      this.laserHold = hold
    }
    const topUp = !!gw && !(gw.reload > 0) && gw.ammo < gw.stats.mag && (enemies.length === 0 || gw.ammo <= gw.stats.mag * 0.5)

    if (primary) {
      if (topUp) act.reload = true
      return [primary.yaw, 0] // an attacker we have not seen yet: look their way
    }

    // farm crates and drones while healthy and alone
    if (hpFrac >= 0.75 && (me.cubes ?? 0) < CUBE_TARGET && gw && label !== "zone") {
      let best: { x: number; y: number; z: number; vx: number; vy: number; rad: number; hgt: number; d: number } | null = null
      for (const c of this.crates.values()) {
        const d = hyp(c.x - mx, c.y - my)
        if (t - c.seen <= 0.15 && d < 60 && (!best || d < best.d)) best = { x: c.x, y: c.y, z: c.z + (cfg.crates?.height ?? 2.4) / 2, vx: 0, vy: 0, rad: cfg.crates?.radius ?? 1.4, hgt: cfg.crates?.height ?? 2.4, d }
      }
      if (!best)
        for (const tr of this.tracks.values()) {
          if (!tr.npc || t - tr.t > 0.15) continue
          const d = hyp(tr.x - mx, tr.y - my)
          if (d < 90 && (!best || d < best.d)) best = { x: tr.x, y: tr.y, z: tr.z + (cfg.npc?.height ?? 3.5) / 2, vx: tr.vx, vy: tr.vy, rad: cfg.npc?.radius ?? 1.8, hgt: cfg.npc?.height ?? 3.5, d }
        }
      if (best && this.w.los(mx, my, mz + this.muzH, best.x, best.y, best.z, 1)) {
        const sol = this.solve(best.x, best.y, best.z, best.vx, best.vy, 0, gw.stats.speed, -1e9, 0.1)
        const now = this.solve(best.x, best.y, best.z, best.vx, best.vy, 0, gw.stats.speed, -1e9, 0)
        if (gw.ammo > 0 && !(gw.reload > 0) && this.aligned(now, best.rad, best.hgt)) act.fire[this.gun] = true
        if (tw && tw.cooldown <= 0.1 && me.energy > 40 && best.d <= tw.stats.range * 0.9 && Math.abs(wrap(sol.yaw - me.aim[0])) < 0.2) act.fire[this.light] = true
        return [sol.yaw, sol.pitch]
      }
    }
    if (topUp) act.reload = true
    if (t - this.lastHurtT < 2.5) return [this.lastHurtYaw, 0]
    // sweep the torso: a full turn every ~2.6 s keeps everything within sight range in the 5 s memory
    const dt = 0.1
    return [wrap(this.cmdYaw + 2.4 * dt), 0]
  }
}
