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

/**
 * Upgrade preference, best first, by what each adds to the damage we deal before going down.
 * Worked out from the rulebook's numbers at the range we fight from (the laser is about two thirds
 * of what we land, the gun a third): laser_damage +18% of the laser is +12% overall; gun_mag (20
 * rounds and a reload a fifth shorter) is +31% sustained gun fire, +11% overall; gun_damage +5%;
 * laser_charge +5%; gun_rate +3%. Measured in the walk-at-us check with our own health kept, two to
 * four hunters: plating +5 to +9%, armor +2 to +5%, one nanites +5 to +7%, and the second nanites
 * +12 to +17% on top (repair then starts after two quiet seconds at 115 HP/s, which hunters do
 * leave us), so a second one is taken ahead of everything (see pickUpgrade).
 */
const UPGRADES = [
  "laser_damage", "gun_mag", "nanites", "plating", "gun_damage", "laser_charge", "armor", "gun_velocity", "gun_rate", "servos",
  "lightning_efficiency", "capacitor", "reactor", "gyros", "jets",
  "lightning_range", "lightning_chain", "sensors", "laser_pierce", "mortar_reload", "mortar_splash", "mortar_velocity",
]
/** Second-slot weapons we pick up, best first. */
let WANT = ["laser", "lightning"]
/**
 * Stop seeking cubes here. The HP and damage bonuses cap at 10, and every cube makes us 5% bigger
 * with no cap. Past 10 the only gain is one upgrade per 5 to 7 cubes (about +15% of one thing),
 * paid for with a target a sixth wider each time: at long range, where shots miss by metres, hits
 * taken grow in step with our width. A wider mech also no longer fits some alleys (a tenth of the
 * ground is out of reach at 21 cubes) and stands taller than the buildings it hides behind.
 */
const CUBE_TARGET = 10
/** Walkable grids are prepared for sizes up to this many cubes; beyond it the last one is used. */
const NAV_CUBES = 30
/**
 * Range we fight house bots from. Measured on the public match feed (three matches, 2100 gun shots
 * and 100 beams of theirs), their guns land 100% of shots inside 40 m, 57% at 40-80 m, 23% at
 * 80-120 m, 18% at 120-160 m (the best two kinds 30%), 9% at 160-200 m and none beyond; their
 * lasers 61% at 40-80 m, 39% at 80-120 m and 1 beam in 39 beyond 120 m. Most of their kills on each
 * other are made by running in with the 45 m lightning gun. They follow a target that backs away at
 * about 6 m/s while firing. Our aim leads properly, so distance costs us far less than it costs them.
 * (The practice squad shares vision and sends its hunters weakest first: one early, more as we thin
 * them out, all of them late. So the score is the kills we make before the whole squad arrives.)
 */
const STANDOFF = 170
/** Switches for behaviours we may want to score separately. */
/**
 * Build 5 (`pro`): play it the way good battle-royale players do, on top of the mid-range cover
 * fighting of build 2 (the best practice score so far), with the long-range and stand-still games off.
 *   - take the fights we are favoured in, from cover, and finish them: a mech that walks off nearly
 *     dead comes back mended, so it is closed on and followed;
 *   - reset between fights: no new fight below 80% health, and the kill's cubes first (each is health);
 *   - no idle time while whole: go to where a mech was last seen instead of waiting for it;
 *   - never trade with two at once while hurt: break their lines and mend.
 * `fixedSeed`: random choices come from the match's own seed, so one build scores the same on the
 * scorer's fixed matches every time and two builds can be compared (off = mixed with the clock).
 */
/**
 * Probes, to learn from one practice score each what the house squad's deaths depend on:
 *   `survive`   free-for-all play from the first tick (stay unseen, fight only an attacker or a
 *               nearly dead mech): what staying alive is worth against the squad;
 *   `pacifist`  the same and never a trigger pulled: how many house bots die without us.
 *   `noFfa`      never switch to free-for-all play: with the fixed seed, any change in the score is
 *                the switch going off in practice matches, where it never should;
 *   `ceaseAt`    no trigger pulled after this many seconds (0 = off): the score is then the kills made
 *                by that time, which shows when our kills come and when they stop;
 *   `lightFirst` the lightning gun wanted ahead of the laser;
 *   `noDuck`     no leaving the fight for cover while our weapons reload.
 */
export const PROBE = { survive: false, pacifist: false, noFfa: false, ceaseAt: 75, lightFirst: false, noDuck: false }
export const TUNING = { drops: true, standoff: false, wary: 0, seek: true, brawl: false, pro: true, fixedSeed: true, mend: 0.5, dropRun: true, dropAt: 0.7, look: "side" as "back" | "side" | "none", dodge: true }

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
  /** When its laser started charging, or -1. */
  chargeT: number
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
  /** A mech we clearly out-match: worth going after when kills are what scores. */
  prey: boolean
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
  private hitT = new Map<number, number>()
  private pickups = new Map<number, Item>()
  private crates = new Map<number, Item>()
  private cubes = new Map<number, Item>()
  private ignore = new Set<number>()
  private dmgIn: { t: number; a: number }[] = []
  private dmgOut: { t: number; a: number; to: number }[] = []
  private lastHurtT = -99
  private lastHurtYaw = 0
  private heardT = -99
  private heardYaw = 0

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
  private healing = false
  private sprint = false
  private ghostT = 0
  private zoneNow: any = null
  private safe: { x: number; y: number; until: number; stay: boolean } | null = null
  private overTop = false
  private pathOut = 0
  private pathAlt = false
  private navCubes = 0
  private pathZone = false
  private kiteGain = 0
  private watch: { x: number; y: number; best: number; t: number; seen: number } | null = null
  private bars: { x: number; y: number; until: number }[] = []
  private finishing = false
  private nearFoeD = Infinity
  private mortarFoe = false
  private rangeNow = STANDOFF
  private kite: { x: number; y: number; until: number } | null = null
  private orbitT = -99
  private orbitDir = 1
  private lastHurtBy = -1
  private strangerT = -99
  private strangerYaw = 0
  private glanceUntil = -99
  private glanceYaw = 0
  private glanceNextT = -99
  private lookT = -99
  private lookSide = 1
  private lastGlanceEnd = -99
  private lastSeen = new Map<number, { x: number; y: number; z: number; t: number; low: boolean; coming: boolean }>()
  private farHeardT = -99
  private farHeardYaw = 0
  private hopLookT = -99
  private post: { x: number; y: number; until: number; key: string } | null = null
  private pathLost = false
  private pathPartial = false
  private slowT = -1
  private noHopUntil = -99
  /**
   * Free-for-all detected: mechs are dying that we did not kill, so the others are fighting each
   * other (in practice the 15 house bots never do). Placement is all that scores, so from then on
   * we stay out of sight and only shoot back.
   */
  ffa = false
  private wary = false
  private nearFoes = 0
  private killCount = 0
  private foreignHits = 0
  private ffaSince = -1
  private lastMechT = -99
  private ambush = false
  private holdUntil = -99
  private npcHurtT = -99
  private ring: { x: number; y: number; r: number } | null = null
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
    WANT = PROBE.lightFirst ? ["lightning", "laser"] : ["laser", "lightning"]
    // Mixed with the clock on purpose: two runs of the same build are then two different samples.
    // (tests pass `entropy` to get the same match twice)
    // (`fixedSeed`: nothing from the clock, so a build can be scored against another on the same matches)
    let s = ((hello.seed ?? 1) ^ ((hello.entropy ?? (TUNING.fixedSeed ? 0x2545f491 : Date.now())) & 0x7fffffff) ^ ((hello.slot ?? 0) * 7919)) >>> 0
    this.rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0
      let x = Math.imul(s ^ (s >>> 15), 1 | s)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
    try {
      this.w = new World(hello.map?.dir ?? "/arena", hello.map?.files)
      this.nav = new Nav(this.w)
      // One walkable grid per size we can grow to, built now so that picking up a cube costs nothing
      // later. Smallest first, and only for as long as start-up can spare (the hello budget is 20 s and
      // covers the container starting): whatever size is not ready uses the largest grid that is.
      const per = this.cfg.cubes?.size_per_cube ?? 0.05
      const r0 = this.cfg.mech.radius
      const began = Date.now()
      for (let c = 0; c <= NAV_CUBES && (c === 0 || Date.now() - began < (c <= CUBE_TARGET ? 9000 : 4000)); c++) {
        this.nav.rebuild(r0 * (1 + per * c))
        this.navCubes = c
      }
      // run the route search and the sight line a few hundred times so they are compiled before the first tick
      const nav = this.nav
      const w = this.w
      let seed = 12345
      const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296)
      for (let k = 0; k < 40 && Date.now() - began < 6000; k++) {
        const ax = w.bMinX + rnd() * (w.bMaxX - w.bMinX)
        const ay = w.bMinY + rnd() * (w.bMaxY - w.bMinY)
        const bx = ax + (rnd() - 0.5) * 300
        const by = ay + (rnd() - 0.5) * 300
        nav.rebuild(r0 * (1 + per * (k % 3) * 5))
        nav.findPath(ax, ay, bx, by, 6000, k % 2 ? { x: ax, y: ay, r: 120, pen: 5 } : undefined, k % 5 === 4 ? 30 : 0)
        for (let q = 0; q < 60; q++) w.los(ax, ay, w.ground(ax, ay) + 8, ax + (rnd() - 0.5) * 400, ay + (rnd() - 0.5) * 400, 5)
      }
      nav.rebuild(r0)
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
    // (no new grid in mid-match for a size we did not prepare: building one takes a whole tick's budget)
    const navR = Math.min(this.R, cfg.mech.radius * (1 + (cfg.cubes?.size_per_cube ?? 0.05) * this.navCubes))
    if (Math.abs(navR - this.nav.radius) > 0.06) {
      this.nav.rebuild(navR)
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
    const zone = (this.zoneNow = this.zoneInfo(obs))

    // --- who matters
    const enemies = this.assess()
    const threats = enemies.filter((e) => !e.tr.ghost).slice(0, 4)
    let primary: Enemy | null = null
    let bestScore = Infinity
    for (const e of enemies) {
      let s = e.tr.hp / Math.max(20, this.myDpsAt(e, e.d))
      // against house bots the near one is the one that hurts: their aim falls apart with distance
      if (this.far()) {
        // (but a kill in the hand first: one we can shoot that is down to a third of its health is
        // finished before anything else, however far it is. Damage spread over three of them is no
        // points; the same damage on one is a point.)
        const low = e.shootable && e.tr.hp < 0.35 * e.tr.maxHp
        s *= low ? 0.5 : clamp(e.d / STANDOFF, 0.5, 1.3)
      }
      if (e.attacked) s *= 0.7
      if (e.tr.id === this.primaryId) s *= 0.8
      if (!e.shootable) s += 100
      if (e.tr.ghost) s += 200
      if (s < bestScore) {
        bestScore = s
        primary = e
      }
    }
    // free-for-all: everyone nearby is something to stay away from, and we only shoot at whoever is
    // shooting us or is one hit from dead
    // (two deaths that are not ours, standing for a full second so a late kill credit cannot trip it)
    if (PROBE.survive || PROBE.pacifist) this.ffa = true
    if (!this.ffa && !PROBE.noFfa) {
      // (in the first 45 s one is enough: in the recorded top-16 match three bots were dead by 14 s,
      // while a house bot can only die that early by our hand)
      // (with three kills of our own and no other death so far this is a practice match; a stray
      // death there, a house bot caught by the zone or its own mortar, should not switch us over)
      if ((cfg.match?.mechs ?? 16) - obs.alive - this.killCount >= (this.killCount >= 3 ? 3 : t < 45 ? 1 : 2)) {
        if (this.ffaSince < 0) this.ffaSince = t
        if (t - this.ffaSince >= 1) this.ffa = true
      } else this.ffaSince = -1
      // In a real free-for-all the shooting starts at once (half the field can be dead in a minute):
      // three hits we saw land on others in the opening 90 s settle it without waiting for deaths.
      if (t < 90 && this.foreignHits >= 3) this.ffa = true
    }
    // The opening: in a free-for-all the nearest neighbours open fire within two seconds of the
    // start, and the first death (8 s in one recorded top-16 match, 26 s in the next) comes too late
    // to warn us. So for the first 30 s we play it as one: out of sight, no first shots, fighting
    // only someone who is on top of us. Against house bots that costs one slow start.
    // (A shortcut out of it, "two mechs in view of each other are not shooting, so they must be house
    // bots", was tried against the recorded top-16 matches and would have fired wrongly from 22% of
    // viewpoints: real bots do not always notice each other. So the opening simply runs its course.)
    // How long: in fifteen recorded top-16 matches the first death came at 8-16 s in ten, at 20-24 s
    // in four and at 26 s in one, and one death that is not ours settles it. Against house bots the
    // opening costs little now (whoever comes for us is fought at once, and looting goes on), so it
    // runs to 26 s.
    // (one hit seen landing on somebody else is not proof of a free-for-all, three are, but it is
    // reason enough to stay careful a while longer: house bots never hit each other)
    this.wary = this.ffa || (t < (this.foreignHits > 0 ? TUNING.wary + 20 : TUNING.wary) && this.killCount === 0)
    let evade: Enemy[] = []
    let holdFire = false
    if (this.wary) {
      const around = this.assess(true).filter((e) => !e.tr.ghost)
      const attacker = enemies.find((e) => t - (this.attackT.get(e.tr.id) ?? -99) < 8) ?? null
      const finish = around.find((e) => e.shootable && e.d < 120 && e.tr.hp < 0.3 * e.tr.maxHp) ?? null
      // While we do not know what kind of match this is: someone walking at us with their guns on us
      // is coming for us whichever it is (a house bot hunting, or a rival who has picked us). The
      // first shots at long range are ours to take, still backing away.
      const incoming = this.ffa ? null : (around.find((e) => e.shootable && e.d <= 215 && e.closing > 3 && Math.abs(wrap(e.tr.aimYaw - (e.yaw + Math.PI))) < 0.25) ?? null)
      const pressed = !!attacker && (attacker.tr.ghost || attacker.d < 80)
      // in the last small circles there is nowhere left to avoid anyone: fight normally
      this.nearFoes = around.length
      this.nearFoeD = around.length ? around[0].d : Infinity
      if (!this.ffa && (attacker || incoming)) {
        // The kind of match is not settled yet and someone is on us. If it is a house bot it knows
        // where we are whatever we do (the squad shares vision), and hiding only gives its friends
        // time to grow: fight it the long-range way, giving ground. If it is a rival, the first death
        // elsewhere (8-16 s in most recorded matches) turns the caution back on.
        primary = attacker ?? incoming
      } else if (!pressed && zone.nr > 30) {
        // Get away from anyone inside sight range or with a line on us. Someone further off who has
        // not noticed us is no reason to stop collecting weapons and cubes: the bots that win these
        // matches are the ones that arrive at the end with the most health.
        // (Before we know what kind of match it is, only from those who are close, or facing us or
        // walking at us: a few house bots usually start within sight without being after us, and
        // running from them for the whole opening costs us the laser we should be fetching.)
        const onUs = (e: Enemy) => e.closing > 3 || Math.abs(wrap(e.tr.aimYaw - (e.yaw + Math.PI))) < 0.25
        evade = around.filter((e) => (this.ffa ? e.d < 205 || (e.seesMe && e.d < 270) : e.d < 110 || ((e.d < 205 || (e.seesMe && e.d < 270)) && onUs(e)))).slice(0, 5)
        primary = attacker ?? finish
        holdFire = !primary
      } else if (pressed) primary = attacker // cornered: deal with the one who is on us, not a bystander
    } else {
      this.nearFoes = 0
      this.nearFoeD = Infinity
    }
    // The range we fight from. With a laser on either side, the full distance always: against a lone
    // early hunter 140 m was tried first (our gun lands a little more from there), but with our own
    // size priced in (house bots hit a ten-cube mech two and a half times as often as a bare one) the
    // walk-at-us check has a kill from 170 m costing 4-16% less health than one from 140 m, at every
    // size, for about 5% more time.
    // (Closer, 100 m, only while neither of us has a laser and it is the one early hunter: the gun is
    // all we have then, a kill takes over twenty seconds from anywhere, and from 170 m longer still.)
    const theirLaser = (!!primary && primary.tr.weapons.includes("laser")) || threats.some((e) => e.tr.weapons.includes("laser"))
    this.rangeNow = threats.length <= 1 && this.killCount < 4 && this.laser < 0 && !theirLaser ? STANDOFF - 70 : STANDOFF
    // Finishing. A house bot under about a third of its health backs away from whoever is hitting it
    // (45% of the time on the match feed) and a quarter of those get back above 60%: 45 HP/s returns
    // after 5 quiet seconds. A kill that walks off behind a building is not a kill, so a nearly dead
    // one is closed on and followed, while we are healthy and none of its friends is near.
    this.finishing = (this.far() || this.pro()) && !!primary && !primary.tr.ghost && primary.tr.hp < 0.4 * primary.tr.maxHp && hpFrac >= 0.5 && !threats.some((e) => e !== primary && e.d < 110)
    if (this.finishing) this.rangeNow = 85
    this.primaryId = primary ? primary.tr.id : -1
    // how long the enemy we are dealing with has been one we cannot see
    if (!primary || !primary.tr.ghost) this.ghostT = t
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
    } else if (primary && hpFrac < 0.6 && this.pro() && !this.finishing && threats.filter((e) => e.seesMe && e.d < 150).length >= 2) {
      // two or more with a line on us and we are already hurt: that trade is lost however it is
      // played, so break their lines and mend rather than stand in it
      this.retreat = true
      this.retreatT = t
    } else if (primary && hpFrac < 0.45 && !this.brawling() && !(this.far() && TUNING.mend <= 0)) {
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
    const drop = this.dropPlan(zone, hpFrac)
    // standing in a landed drop's ring: stay in it, the repair is worth more than any cover
    // (against house bots, not with one of them in the ring or about to be: the capture clock stops
    // while two stand in it, and at that distance every shot of theirs lands)
    const dropCrowded = this.far() && !!drop && threats.some((e) => hyp(e.x - drop.x, e.y - drop.y) < drop.r + 10)
    this.ring = drop && drop.inRing && drop.lands <= 1 && !dropCrowded ? { x: drop.x, y: drop.y, r: drop.r } : null
    const still: Move = { x: 0, y: 0, boost: false, jump: false }

    let mv: Move = still
    let label = "idle"
    const danger = shells.find((s) => hyp(mx - s.x, my - s.y) < s.r && s.tti < 3)
    if (t < this.unstuckT) {
      mv = { x: this.unstuckX, y: this.unstuckY, boost: false, jump: false }
      label = "unstuck"
    } else if (zone.urgent) {
      // (the last circle closes on a point: every metre off it is seconds outside at the very end, so
      // walk right onto it, slowing over the last steps so as not to run past)
      const last = zone.nr <= 1
      mv = this.travel({ x: zone.gx, y: zone.gy, stop: last ? 0.3 : 2, boost: !me.in_zone || zone.tight, kind: "zone" })
      const left = hyp(zone.gx - mx, zone.gy - my)
      if (last && left < 3 && me.grounded) {
        const k = clamp(left / 3, 0.12, 1)
        mv = { x: mv.x * k, y: mv.y * k, boost: false, jump: mv.jump }
      }
      label = "zone"
    } else if (danger && !primary) {
      const d = hyp(mx - danger.x, my - danger.y) || 1
      mv = { x: (mx - danger.x) / d, y: (my - danger.y) / d, boost: true, jump: false }
      label = "dodge"
    } else if (primary && primary.tr.ghost) {
      // being hit by someone we cannot see: sidestep across their line of fire while the torso looks for them
      // If turning to look has not found them within a second they are beyond our sight (a laser
      // out-ranges our eyes): put a building between us and that bearing.
      const unseen = t - this.ghostT > 1 ? this.hide(primary, [primary], shells, zone, true, 140, 10.5) : null
      if (unseen) {
        mv = unseen
        label = "unseen"
        this.holdUntil = t + 10 // stay put for a while once the firing stops, instead of walking back into it
      } else {
        this.flipStrafe(100)
        const px = -Math.sin(primary.yaw) * this.strafe
        const py = Math.cos(primary.yaw) * this.strafe
        mv = this.nav.lineWalkable(mx, my, mx + px * 6, my + py * 6, 0.3) ? { x: px, y: py, boost: me.energy > 30, jump: false } : { x: -px, y: -py, boost: me.energy > 30, jump: false }
        label = "ghost"
      }
    } else if (evade.length) {
      // Free-for-all. Someone has a line on us: break it first. Otherwise put distance between us
      // and everyone we know of (out of sight range nobody can start on us at all).
      const near = evade[0]
      const watched = evade.some((e) => e.seesMe && e.d < 260)
      let got: Move | null = watched ? this.hide(near, evade, shells, zone, near.d < 150, 60, 10.5) : null
      if (!got) {
        const sp = this.safeSpot(zone)
        if (sp) got = this.travel({ x: sp.x, y: sp.y, stop: 4, boost: watched && me.energy > 20, kind: "away" })
      }
      if (!got) {
        const c = this.local("hide", near, evade, 0, shells, zone, 10.5)
        got = c ? this.toward(c.x, c.y, me.energy > 30 && near.d < 100) : still
      }
      mv = got
      this.holdUntil = t + 4
      label = "evade"
    } else if (primary) {
      const recent = primary.shootable || t - this.lastShotT < 1
      const close = primary.d < 60 && t - primary.tr.t <= 2
      const why = this.ring ? "" : this.coverReason(primary, threats, hpFrac, gunDown && laserDown && !lightUp && recent, recent)
      let got: Move | null = null
      let repair = !!drop && !this.ring && !dropCrowded && hpFrac < 0.6 && drop.d < 70 && drop.lands < 4
      // Against house bots, once we are down to 70%: a drop is the one repair that works with hunters
      // on us (walking it off needs five quiet seconds, and they do not give us those), so make for
      // one that we reach well before any of them does, even if it is a long run.
      // (With a drop landing 25 s into the walk-at-us check: captured in 8 of 40 trials at 50%, 11 at
      // 70%, 14 at 85%, and 3-4% more dealt before going down at 70% than at 50%.)
      // (house bots go for drops too, 15 of 21 in the recorded human games: not one with a mech we
      // know of anywhere near it)
      if (!repair && TUNING.dropRun && this.far() && drop && !this.ring && !dropCrowded && drop.crowd === 0 && hpFrac < TUNING.dropAt && drop.d < 230 && drop.lands < drop.d / 12 + 2) {
        repair = true
        for (const e of threats) if (hyp(e.x - drop.x, e.y - drop.y) < drop.d * 0.75 + 45) repair = false
        if (hyp(primary.x - drop.x, primary.y - drop.y) < drop.d * 0.75 + 45) repair = false
      }
      if (repair && drop) {
        // a landed drop close by repairs us fully in 4 s: better than any amount of hiding
        got = this.travel({ x: drop.x, y: drop.y, stop: 1.5, boost: me.energy > 15, kind: "drop" })
        label = "drop"
        this.healing = false
      } else if (this.retreat && !this.ring) {
        // against house bots distance is as good as a wall and they do not get to walk up to us
        if (this.far()) got = this.runOff(zone)
        if (!got) got = this.hide(primary, threats, shells, zone, true, 140, 10.5)
        if (!got) {
          // nowhere to hide: back away while fighting
          const c = this.local("fight", primary, threats, primary.d + 40, shells, zone, 10.5)
          got = c ? this.toward(c.x, c.y, me.energy > 8) : still
        }
        label = "hide"
      } else if (why) {
        const quick = why === "laser" || why === "reload"
        // (house bots: out-gunned or hurt, the answer is distance, not a wall they can walk round)
        if ((why === "heal" || why === "ambush") && this.far()) got = this.runOff(zone)
        if (!got) got = this.hide(primary, threats, shells, zone, why !== "reload", quick ? 0 : 140, quick ? 6.5 : 10.5)
        if (got) {
          label = why
          // if they drop out of our memory while we wait, keep waiting about as long as their walk here takes
          if (!quick) this.holdUntil = t + clamp(primary.d / 9 + 5, 6, 20)
        }
      }
      // (house bots: tracked is enough. They know where we are and keep coming while a building
      // hides them, half again as fast as when they are shooting: standing still to wait gave up
      // 50 m in 5 s in the walk-at-us check.)
      const tracked = this.far() && !primary.tr.ghost && t - primary.tr.t <= 0.3 && primary.d < 240
      if (got) mv = got
      else if (recent || close || this.ring || tracked) {
        // (someone with a mortar in view: long sweeps one way, so that we are 7 m from where the
        // shell was sent by the time it lands; a quick back-and-forth ends up where it started)
        // (The same against a laser. On the match feed house bots' beams landed on 67% of targets
        // moving at 2-7 m/s and 29% of those moving faster inside 100 m, 38% against 16% beyond: their
        // aim trails a fast mover. Their guns showed no such difference. So with a laser in view we
        // keep our speed, sideways, instead of standing to shoot.)
        // (Only against house bots: the top teams' lasers and guns land about equally whatever the
        // target's sideways speed, and there quick reversals remain the better answer to a led gun.)
        const sweepFor = (ws: string[]) => ws.includes("mortar") || (this.far() && ws.includes("laser"))
        this.mortarFoe = threats.some((e) => sweepFor(e.tr.weapons)) || sweepFor(primary.tr.weapons)
        this.flipStrafe(this.mortarFoe ? 30 : primary.d)
        // If they are coming to us there is nothing to gain by meeting them half way: keep all our
        // speed sideways and let the range close by itself, down to the one we want.
        const want = this.prefRange(primary)
        const pref = primary.closing > 2 && primary.d > want ? Math.max(want, primary.d - 18) : want
        const c = this.local("fight", primary, threats, pref, shells, zone, 10.5)
        // out-gunned at range with no cover to wait behind: close the distance fast
        const rush = this.finishing ? primary.d > pref + 20 && me.energy > 25 : why === "ambush" || why === "heal" ? primary.d > pref + 15 && me.energy > 15 : primary.d > pref + 50 && me.energy > 40
        // run while sidestepping when the jets can spare it: a faster target is a harder one. Not
        // when our own lightning needs the energy, and always when theirs is closing on us.
        if (me.energy > 60) this.sprint = true
        else if (me.energy < 25) this.sprint = false
        const kite = primary.tr.weapons.includes("lightning") && this.light < 0 && primary.d < 75 && me.energy > 8
        const zap = this.light >= 0 && primary.d < 60
        // standing off: run when one of them gets well inside the range we want. No running just to be
        // a faster target: against house bots sideways speed made no difference to how often they hit.
        const far = this.far()
        let nearT = primary.d
        for (const e of threats) nearT = Math.min(nearT, e.d)
        let closing = 0
        for (const e of threats) if (e.d < this.rangeNow - 45) closing = Math.max(closing, e.closing)
        const back = far && me.energy > 15 && (nearT < 70 || (nearT < this.rangeNow - 45 && closing > 2))
        mv = c ? this.toward(c.x, c.y, rush || kite || back || (this.sprint && !far && !zap && primary.d > 25)) : still
        if (far) {
          // Against house bots the legs have one job, the range. Too close: make for a spot well
          // away from all of them, by a route (a step-by-step retreat dithers and walks into dead
          // ends; measured with dummies walking at us). At range with a line of fire: stand still
          // and shoot (their aim does not care whether we move). No line of fire: the step above
          // finds one.
          // (not out of a drop's ring: four seconds in it are a full repair)
          if (nearT < this.rangeNow - 5 && !this.ring) {
            const sp = this.kiteSpot(primary, threats, zone)
            if (sp) mv = this.travel({ x: sp.x, y: sp.y, stop: 2, boost: back, kind: "kite" })
            else {
              // Nowhere within reach is further from them than here: hemmed in. Break as many of
              // their lines as a wall will, and fight from there. (Two escape plans taking turns
              // tick by tick left the bot standing in the open in the walk-at-us check.)
              const cov = this.hide(primary, threats, shells, zone, back, 60, 10.5)
              if (cov) mv = cov
            }
          } else if (primary.shootable && primary.d <= pref + 25 && !this.mortarFoe && !shells.some((sh) => hyp(mx - sh.x, my - sh.y) < sh.r + 3)) mv = still
        }
        if (this.brawling() && primary.shootable && Math.abs(primary.d - pref) < 30 && !shells.some((sh) => hyp(mx - sh.x, my - sh.y) < sh.r + 3)) mv = still
        label = "fight"
        // it has gone behind something: go round after it rather than wait for it to come back mended
        if (this.finishing && !this.ring && !primary.shootable && t - this.lastShotT > 0.6) {
          mv = this.travel({ x: primary.x, y: primary.y, stop: 30, boost: me.energy > 30, kind: "hunt" })
          label = "hunt"
        }
        // Still without a laser, one lying within reach, and nobody close: fetch it now, shooting as
        // we go. From this range it triples what we deal.
        if (far && this.laser < 0 && nearT > 80 && !this.ring) {
          const lz = this.laserNear(zone, 130)
          // (not one that lies at their feet)
          if (lz && !threats.some((e) => hyp(e.x - lz.x, e.y - lz.y) < 90) && hyp(primary.x - lz.x, primary.y - lz.y) >= 90) {
            mv = this.travel(lz)
            label = "weapon"
          }
        }
      } else if ((!this.far() || this.finishing) && (this.brawling() || this.finishing || primary.attacked || primary.prey || primary.tr.hp < primary.tr.maxHp * 0.6)) {
        // lost sight of someone worth finishing, and we are healthy: go and find them
        mv = this.travel({ x: primary.x, y: primary.y, stop: 25, boost: this.finishing && me.energy > 30, kind: "hunt" })
        label = "hunt"
      } else {
        const g = this.chooseGoal(zone, hpFrac)
        mv = this.travel(g)
        label = g.kind
      }
    } else {
      this.ambush = false
      // (a laser we know of comes before a drop's three cubes: it is most of what we deal from range)
      // (and against house bots a drop is the quick way to be whole again between waves: four seconds
      // in its ring against twenty of walking it off)
      if (drop && (hpFrac < (this.far() || this.pro() ? 0.85 : 0.6) || ((me.cubes ?? 0) < CUBE_TARGET && !(this.laser < 0 && this.laserNear(zone, 260))))) {
        mv = this.travel({ x: drop.x, y: drop.y, stop: 1.5, boost: drop.d / 9 > drop.lands && me.energy > 30, kind: "drop" })
        label = "drop"
      } else if (t < this.holdUntil && !this.far() && !this.brawling()) {
        label = "hold" // the hunter we hid from is on its way: stay behind cover, heal, and watch
      } else if (hpFrac < (this.pro() ? 0.8 : 0.6) && t - this.npcHurtT > 4 && !this.far() && !this.brawling()) {
        // (`pro`: the reset between fights. The next fight is started whole or not at all, and the
        // cubes a kill left are fetched from further off: each one is 4% of our health back at once.)
        // (Not against house bots: they know where we are and come to us, so a hiding place is where
        // they turn up at arm's length. There we keep walking, which costs the repair nothing, to an
        // open look-out away from where they were last seen, and meet them at range again.)
        // Badly hurt with nobody in sight: 45 HP/s comes back after 5 quiet seconds, and standing
        // still makes no sound. Walking on at this health only finds the next fight sooner. Cubes
        // and a weapon within a few steps are still worth the walk (a cube is health too).
        const g = this.chooseGoal(zone, hpFrac)
        if ((g.kind === "cube" || g.kind === "weapon") && hyp(g.x - mx, g.y - my) < (this.pro() ? 80 : 45)) {
          mv = this.travel(g)
          label = g.kind
        } else label = "rest"
      } else {
        const g = this.chooseGoal(zone, hpFrac)
        mv = this.travel(g)
        label = g.kind
      }
    }
    this.watchStuck(mv, label)
    // bullets in the air that we can see: step out of their lines (not while racing the circle, and
    // not off a roof)
    if (TUNING.dodge && me.grounded && label !== "unstuck" && !(label === "zone" && (!me.in_zone || zone.tight))) mv = this.dodge(mv, obs, zone)

    // --- torso and triggers
    const aim = this.aimAndFire(act, primary, enemies, hpFrac, label, holdFire)
    if (PROBE.pacifist || (PROBE.ceaseAt > 0 && t >= PROBE.ceaseAt)) {
      act.fire = [false, false]
      this.laserHold = false
    }
    act.move = [mv.x, mv.y]
    act.boost = mv.boost
    act.jump = mv.jump
    act.aim = aim

    // --- pick up a second weapon when standing on one (a laser also in place of anything but the gun)
    const empty = me.weapons.some((x: any) => !x)
    const swap = empty || (WANT[0] === "laser" ? this.laser : this.light) >= 0 ? -1 : me.weapons.findIndex((x: any) => x && x.kind !== "gun")
    if (empty || swap >= 0) {
      const reach = (cfg.loot?.pickup_radius ?? 4) * 0.95
      let bestRank = empty ? 99 : 1
      for (const p of obs.pickups) {
        const rank = WANT.indexOf(p.kind)
        if (rank < 0 || rank >= bestRank || this.ignore.has(p.id)) continue
        if (hyp(p.pos[0] - mx, p.pos[1] - my) <= reach && Math.abs(p.pos[2] - mz) <= 3.8) {
          bestRank = rank
          act.take = p.id
          if (!empty) act.drop = swap
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
    const ours = new Set<number>()
    for (const e of obs.events) if (e.type === "hit" && typeof e.target === "number") ours.add(e.target)
    for (const m of obs.mechs) {
      let tr = this.tracks.get(m.id)
      // A mech in view losing a gun shot's worth of health (40+; a drone does 25, the zone less) in
      // one tick, when we did not hit it: somebody else did. House bots never fight each other.
      if (tr && !tr.npc && !tr.ghost && m.kind !== "npc" && typeof m.hp === "number" && t - tr.t <= 0.25 && tr.hp - m.hp >= 40 && !ours.has(m.id) && t - (this.hitT.get(m.id) ?? -99) > 0.3) this.foreignHits++
      if (!tr) {
        tr = { id: m.id, npc: false, ghost: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, aimYaw: 0, hp: 1400, maxHp: 1400, cubes: 0, weapons: [], charging: false, chargeT: -1, t }
        this.tracks.set(m.id, tr)
      }
      tr.npc = m.kind === "npc"
      if (!tr.npc) {
        this.lastMechT = t
        // (coming: it was closing on us at more than 2 m/s when last seen, as a hunter does)
        const ddx = m.pos[0] - (obs.self.pos[0] as number)
        const ddy = m.pos[1] - (obs.self.pos[1] as number)
        const dd = hyp(ddx, ddy) || 1
        const coming = -((m.vel?.[0] ?? 0) * ddx + (m.vel?.[1] ?? 0) * ddy) / dd > 2
        this.lastSeen.set(m.id, { x: m.pos[0], y: m.pos[1], z: m.pos[2], t, low: typeof m.hp === "number" && typeof m.max_hp === "number" && m.hp < 0.4 * m.max_hp, coming })
      }
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
      if (!tr.charging) tr.chargeT = -1
      else if (tr.chargeT < 0) tr.chargeT = t
      tr.t = t
    }
    for (const [id, tr] of this.tracks) if (t - tr.t > (tr.npc ? 4 : tr.ghost ? 6 : 15)) this.tracks.delete(id)

    this.sync(this.pickups, obs.pickups)
    this.sync(this.crates, obs.crates)
    this.sync(this.cubes, obs.cubes)

    // A beam we saw starts at its shooter's muzzle: that pins down someone firing from beyond our
    // sight (a laser reaches 280 m, our eyes 200) far better than the bearing of the hit.
    for (const b of obs.beams ?? []) {
      const p0 = b.path?.[0]
      const p1 = b.path?.[1]
      if (typeof b.by !== "number" || b.by >= 100 || !p0 || !p1) continue
      const old = this.tracks.get(b.by)
      if (old && !old.ghost && t - old.t < 0.5) continue
      const floor = this.w.surface(p0[0], p0[1])
      this.tracks.set(b.by, {
        id: b.by, npc: false, ghost: true, x: p0[0], y: p0[1], z: Math.max(floor, p0[2] - this.cfg.mech.muzzle_height * 1.5),
        vx: 0, vy: 0, vz: 0, aimYaw: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]),
        hp: old?.hp ?? 1400, maxHp: old?.maxHp ?? 1400, cubes: old?.cubes ?? 0,
        weapons: old?.weapons?.includes(b.kind) ? old.weapons : [...(old?.weapons ?? ["gun"]), b.kind], charging: false, chargeT: -1, t,
      })
    }
    // Sounds: something close that we may not see yet is worth a look (and, in a free-for-all, is
    // company: keep quiet).
    for (const sd of obs.sounds ?? []) {
      if (typeof sd.bearing !== "number" || sd.kind === "npc_gun" || sd.kind === "crate" || sd.kind === "drop" || sd.kind === "death" || sd.kind === "explosion") continue
      if (sd.dist === "near") {
        this.lastMechT = Math.max(this.lastMechT, t)
        if (t - this.heardT > 3) {
          this.heardT = t
          this.heardYaw = sd.bearing
        }
      } else if (sd.dist === "mid") this.lastMechT = Math.max(this.lastMechT, t - 6)
      // Movement or a charging laser where we know of nobody: someone is coming that we are not
      // looking at (we see 120 degrees; a fight keeps our eyes on one of them).
      if (sd.dist === "near" || (sd.dist === "mid" && (sd.kind === "boost" || sd.kind === "jet" || sd.kind === "laser_charge"))) {
        let known = false
        for (const tr of this.tracks.values()) {
          if (tr.npc || tr.ghost || t - tr.t > 2) continue
          if (Math.abs(wrap(Math.atan2(tr.y - me.pos[1], tr.x - me.pos[0]) - sd.bearing)) < 0.45) known = true
        }
        if (!known) {
          this.strangerT = t
          this.strangerYaw = sd.bearing
        }
      }
      // weapons fire further off: where the others are, for when we go looking for them
      if (sd.dist !== "near" && (sd.kind === "gun" || sd.kind === "laser" || sd.kind === "lightning")) {
        this.farHeardT = t
        this.farHeardYaw = sd.bearing
      }
    }

    for (const e of obs.events) {
      if (e.type === "damaged") {
        this.dmgIn.push({ t, a: e.amount ?? 0 })
        if (e.weapon === "npc") this.npcHurtT = t
        if (typeof e.by === "number" && e.by < 100) {
          this.attackT.set(e.by, t)
          this.lastHurtT = t
          this.lastHurtBy = e.by
          if (typeof e.bearing === "number") this.lastHurtYaw = e.bearing
          const tr = this.tracks.get(e.by)
          if ((!tr || t - tr.t > 1.5) && typeof e.bearing === "number") {
            // Somewhere along that bearing, with a clear line to us. Put it at the far end of the
            // clear stretch: hiding from there hides us from anything nearer on the same line.
            const reach = e.weapon === "lightning" ? 45 : e.weapon === "gun" ? 230 : e.weapon === "mortar" ? 120 : 280
            let guess = 20
            for (let q = 30; q <= reach; q += 10) {
              const qx = mx + Math.cos(e.bearing) * q
              const qy = my + Math.sin(e.bearing) * q
              if (!this.w.inGrid(qx, qy) || !this.w.los(qx, qy, this.w.surface(qx, qy) + 7, mx, my, mz + this.H / 2)) break
              guess = q
            }
            this.tracks.set(e.by, {
              id: e.by, npc: false, ghost: true,
              x: mx + Math.cos(e.bearing) * guess, y: my + Math.sin(e.bearing) * guess, z: this.w.surface(mx + Math.cos(e.bearing) * guess, my + Math.sin(e.bearing) * guess),
              vx: 0, vy: 0, vz: 0, aimYaw: e.bearing + Math.PI,
              hp: tr?.hp ?? 1400, maxHp: tr?.maxHp ?? 1400, cubes: tr?.cubes ?? 0,
              weapons: tr?.weapons ?? [e.weapon], charging: false, chargeT: -1, t,
            })
          }
        }
      } else if (e.type === "hit") {
        this.dmgOut.push({ t, a: e.amount ?? 0, to: e.target })
        if (typeof e.target === "number" && e.target < 100) this.hitT.set(e.target, t)
      }
      else if (e.type === "kill") {
        this.killCount++
        this.lastSeen.delete(e.target)
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
    const held: any[] = Array.isArray(this.me?.upgrades) ? this.me.upgrades : []
    const haveNanites = held.some((u) => u === "nanites" || u?.id === "nanites")
    for (let i = 0; i < choices.length; i++) {
      let r = UPGRADES.indexOf(choices[i]?.id)
      // the second nanites is worth more than anything else on the list
      if (r >= 0 && choices[i]?.id === "nanites" && haveNanites) r = -1
      if (r >= -1 && UPGRADES.includes(choices[i]?.id) && r < rank) {
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
    const soon = at(t + 6)
    const walk = (me.stats?.walk_speed ?? 11.7) * 0.7
    const inner = Math.max(0, nr - Math.min(40, nr * 0.6))
    const dn = hyp(mx - nx, my - ny)
    const outside = dn - Math.max(0, nr - Math.min(25, nr * 0.5))
    const late = outside > 0 && t + outside / walk + 8 >= z.shrink_end
    const edge = hyp(mx - soon.x, my - soon.y) > Math.min(soon.r, z.radius) - 18
    // Small circles hurt (100 HP/s and up) and the walk in can be a long way round: go as soon as the
    // next one is announced instead of racing its edge.
    // The very last point (radius 0) is always a few steps away inside a 25 m circle, so that one can
    // wait until the shrink is about to start; until then we are free to fight.
    const endgame = ((z.dps ?? 0) >= 100 || nr <= 70) && dn > inner + 3 && (nr > 1 || t + dn / walk + 8 >= z.shrink_start)
    const urgent = !me.in_zone || late || edge || endgame
    // Stay inside the circle as it is now and as it will be in a few seconds, with a margin: the next
    // centre can sit right on the present edge (the last one, of radius 0, often does).
    const inside = (x: number, y: number) => hyp(x - z.center[0], y - z.center[1]) <= z.radius - 5 && hyp(x - soon.x, y - soon.y) <= soon.r - 5
    const g = this.zonePoint(nx, ny, nr, inner, inside, soon)
    // a circle can close on a point off the edge of the map: the nearest we can stand is the edge
    g.x = clamp(g.x, this.w.bMinX + this.R + 1.5, this.w.bMaxX - this.R - 1.5)
    g.y = clamp(g.y, this.w.bMinY + this.R + 1.5, this.w.bMaxY - this.R - 1.5)
    return { urgent, dps: z.dps ?? 0, tight: hyp(mx - soon.x, my - soon.y) > soon.r - 5, gx: g.x, gy: g.y, nx, ny, nr, inner, cx: soon.x, cy: soon.y, cr: Math.min(soon.r, z.radius), shrinkStart: z.shrink_start, curX: z.center[0], curY: z.center[1], curR: z.radius }
  }

  /**
   * Where to stand inside the next circle: the nearest point of its inner disk if that is open
   * ground, else the nearest open ground inside it, else (the circle is all buildings) a roof low
   * enough to jet onto. The zone is a circle on the map, so a roof inside it counts.
   */
  private zonePoint(nx: number, ny: number, nr: number, inner: number, inside: (x: number, y: number) => boolean, soon: { x: number; y: number; r: number }): { x: number; y: number } {
    const [mx, my] = this.me.pos as number[]
    const nav = this.nav
    const w = this.w
    const dn = hyp(mx - nx, my - ny)
    let px = nx
    let py = ny
    if (dn > 1e-6 && inner > 0) {
      const k = Math.min(1, inner / dn)
      px = nx + (mx - nx) * k
      py = ny + (my - ny) * k
    }
    const ground = (x: number, y: number) => inside(x, y) && nav.free(x, y, 0.5) && nav.snap(x, y, 1) >= 0
    if (ground(px, py)) return { x: px, y: py }
    // late on, being near the next centre matters more than a short walk
    const pull = nr <= 25 ? 1 : 0.3
    let best: { x: number; y: number } | null = null
    let bd = Infinity
    const scan = (cx: number, cy: number, lim: number, ok: (x: number, y: number) => boolean) => {
      const step = Math.max(3, lim / 8)
      for (let r = 0; r <= lim + 0.01; r += step)
        for (let k = 0; k < (r === 0 ? 1 : 16); k++) {
          const x = cx + Math.cos((k * TAU) / 16) * r
          const y = cy + Math.sin((k * TAU) / 16) * r
          if (!ok(x, y)) continue
          const d = hyp(x - mx, y - my) + hyp(x - nx, y - ny) * pull
          if (d < bd) {
            bd = d
            best = { x, y }
          }
        }
    }
    const roof = (x: number, y: number) => {
      if (!inside(x, y) || !w.inGrid(x, y)) return false
      const f = w.idx(x, y)
      const h = w.surf[f] - w.terr[f]
      if (h <= STEP_UP || h > 45 || w.slabBase[f] < Infinity) return false
      for (let q = 0; q < 8; q++) if (Math.abs(w.surface(x + Math.cos(q * 0.7854) * this.R, y + Math.sin(q * 0.7854) * this.R) - w.surf[f]) > STEP_UP) return false
      return true
    }
    // the next centre pulled inside what is safe right now
    let qx = nx
    let qy = ny
    const ds = hyp(nx - soon.x, ny - soon.y)
    if (ds > Math.max(0, soon.r - 6)) {
      const k = Math.max(0, soon.r - 6) / (ds || 1)
      qx = soon.x + (nx - soon.x) * k
      qy = soon.y + (ny - soon.y) * k
    }
    scan(nx, ny, inner, ground)
    if (!best) scan(nx, ny, Math.max(0, nr - 4), ground)
    if (!best) scan(qx, qy, 16, ground)
    if (!best) scan(nx, ny, inner, roof)
    if (!best) scan(qx, qy, 16, roof)
    return best ?? { x: qx, y: qy }
  }

  /** Will this spot still be inside the zone if we walk there now? */
  private zoneOk(zone: any, x: number, y: number): boolean {
    if (hyp(x - zone.nx, y - zone.ny) <= zone.nr - 5) return true
    const [mx, my] = this.me.pos as number[]
    const eta = hyp(x - mx, y - my) / 8
    return this.t + eta + 20 < zone.shrinkStart && hyp(x - zone.curX, y - zone.curY) <= zone.curR - 10
  }

  // ------------------------------------------------------------------ enemies

  private assess(all = false): Enemy[] {
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
      const fighting = t - (this.hitT.get(tr.id) ?? -99) < 8
      const closing = d > 1 ? -((tr.vx - me.vel[0]) * dx + (tr.vy - me.vel[1]) * dy) / d : 0
      const pointing = Math.abs(wrap(tr.aimYaw - Math.atan2(-dy, -dx))) < 0.25
      // (their health times their firepower against ours: 1.6 to 1 in our favour is worth starting)
      const prey = !this.wary && !tr.ghost && age <= 5 && d <= 230 && this.outmatch(tr) >= 1.6
      // house bots: anyone we can see is worth shooting at from out here, where they cannot answer
      // (not while hurt: health comes back at 45 a second only after 5 s of neither taking nor dealing
      // damage, and the next wave of hunters is on its way whether we shoot at this one or not)
      // (and not before we hold a laser or half our cubes: with the gun alone from range a fight we
      // start takes three times as long, and every kill brings more of them)
      // (The line is two thirds of our health, not more: the circle is 240 m across the radius by
      // 195 s and 140 m by 265 s, after which there is no room to stand off in, so the kills have to
      // be made in the first three minutes and waiting to be whole costs more than it saves.)
      const target = (this.far() ? this.me.hp >= 0.65 * this.me.max_hp && (this.laser >= 0 || (this.me.cubes ?? 0) >= 5) : this.brawling()) && !this.wary && !tr.ghost && age <= 2 && d <= 215
      if (all ? d > 280 : !(attacked || fighting || prey || target || d <= 120 || (d <= 280 && (closing > 3 || pointing)))) continue
      const fresh = !tr.ghost && age <= 0.15
      const shootable = fresh && d <= maxRange && this.w.los(mx, my, mz + this.muzH, x, y, cz)
      const seesMe = fresh && this.w.los(x, y, emz, mx, my, mz + this.H / 2)
      out.push({ tr, x, y, z, d, yaw: Math.atan2(dy, dx), rad: cfg.mech.radius * sc, hgt, cz, mz: emz, shootable, seesMe, attacked, closing, prey })
    }
    out.sort((a, b) => a.d - b.d)
    return out
  }

  /**
   * How a straight fight with this mech would go: (our health x our firepower) over (theirs x
   * theirs), all from what we can see of them. Above 1 we win it; we only start one well above.
   */
  private outmatch(tr: Track): number {
    const me = this.me
    const cfg = this.cfg
    const W = cfg.weapons
    if (me.hp < 0.7 * me.max_hp || me.weapons.some((x: any) => !x)) return 0 // not hurt, and with both weapons
    const cap = cfg.cubes?.stat_cap ?? 10
    const per = cfg.cubes?.damage_per_cube ?? 0.04
    const gunS = (W.gun.damage * W.gun.mag) / (W.gun.mag * W.gun.cooldown + W.gun.reload)
    const power = (ws: string[], cubes: number, gunAcc: number, beamAcc: number) => {
      let p = 0
      if (ws.includes("gun")) p += gunS * gunAcc
      if (ws.includes("laser")) p += (W.laser.damage / (W.laser.charge + W.laser.cooldown)) * beamAcc
      if (ws.includes("lightning")) p += (W.lightning.damage / W.lightning.cooldown) * 0.5
      if (ws.includes("mortar")) p += 40
      return Math.max(20, p) * (1 + per * Math.min(cubes, cap))
    }
    // (ours: the best team bots on the feed land about 60% of gun shots and 65-75% of beams on each other)
    const mine = power(me.weapons.map((x: any) => x?.kind ?? ""), me.cubes ?? 0, 0.6, 0.75)
    const theirs = power(tr.weapons.length ? tr.weapons : ["gun"], tr.cubes, 0.5, 0.4)
    // their upgrades are invisible except through max_hp; assume one armour upgrade per five cubes
    const theirHp = tr.hp / Math.max(0.6, 1 - 0.04 * Math.floor(tr.cubes / 5))
    return (me.hp * mine) / Math.max(1, theirHp * theirs)
  }

  /** Sustained damage per second we expect to land on this enemy from range d. */
  private myDpsAt(e: Enemy, d: number): number {
    const me = this.me
    const cfg = this.cfg
    const cm = 1 + (cfg.cubes?.damage_per_cube ?? 0.04) * Math.min(me.cubes ?? 0, cfg.cubes?.stat_cap ?? 10)
    let dps = 0
    if (this.gun >= 0) {
      const s = me.weapons[this.gun].stats
      if (d <= s.range) dps += ((s.damage * s.mag) / (s.mag * s.cooldown + s.reload)) * clamp(1.1 - d / 400, 0.55, 0.85)
    }
    if (this.laser >= 0) {
      const s = me.weapons[this.laser].stats
      if (d <= s.range) dps += (s.damage / (s.charge + s.cooldown)) * (e.tr.weapons.includes("mortar") ? 1 + (s.cookoff ?? 0.6) : 1)
    }
    if (this.light >= 0) {
      const s = me.weapons[this.light].stats
      if (d <= s.range * 0.9) dps += (s.damage / s.cooldown) * 0.85
    }
    return dps * cm
  }

  /**
   * The same for them against us, from the base weapon numbers (their upgrades are not visible).
   */
  private theirDpsAt(e: Enemy, d: number): number {
    const cfg = this.cfg
    const W = cfg.weapons
    const cm = 1 + (cfg.cubes?.damage_per_cube ?? 0.04) * Math.min(e.tr.cubes, cfg.cubes?.stat_cap ?? 10)
    const has = (k: string) => e.tr.weapons.includes(k)
    let dps = 0
    // Share of shots that land by range, measured on the public match feed. House bots: guns 100%
    // inside 40 m, 57% to 80 m, 23% to 120 m, 18% to 160 m, 9% beyond; lasers 61% to 80 m, 39% to
    // 120 m, 3% beyond. The top teams' bots (six matches): guns 100 / 83 / 55 / 40 / 33%, lasers
    // about 72% at any range.
    const step = (v: number[]) => (d < 40 ? v[0] : d < 80 ? v[1] : d < 120 ? v[2] : d < 160 ? v[3] : v[4])
    const gunAcc = this.ffa ? step([1, 0.83, 0.55, 0.4, 0.33]) : step([1, 0.57, 0.25, 0.2, 0.1])
    const beamAcc = this.ffa ? 0.72 : step([0.65, 0.6, 0.4, 0.05, 0.03])
    if (has("gun") || !e.tr.weapons.length) {
      const g = W.gun
      if (d <= g.range) dps += ((g.damage * g.mag) / (g.mag * g.cooldown + g.reload)) * gunAcc
    }
    if (has("laser") && d <= W.laser.range) dps += (W.laser.damage / (W.laser.charge + W.laser.cooldown)) * beamAcc
    if (has("lightning") && d <= W.lightning.range) dps += (W.lightning.damage / W.lightning.cooldown) * 0.85
    if (has("mortar") && d > 12 && d < 200) dps += 40
    return dps * cm
  }

  /**
   * Why we should be out of this enemy's sight right now, or "" to stand and fight.
   *   laser   one is charging on us: it cannot be dodged, only blocked
   *   reload  nothing of ours can fire for a moment
   *   heal    we are hurt and they are not on top of us yet: 45 HP/s comes back after 5 quiet seconds
   *   ambush  they out-damage us at this range (typically their laser against our gun): they are
   *           hunting us, so let them walk into a short-range fight instead
   */
  private coverReason(primary: Enemy, threats: Enemy[], hpFrac: number, weaponsDown: boolean, recent: boolean): string {
    const t = this.t
    if (this.brawling()) return ""
    // (a house bot's beam from beyond 110 m misses nine times in ten: not worth breaking off our own fire for)
    const far = this.far()
    for (const e of threats) {
      if (e.tr.chargeT < 0 || t - e.tr.t > 0.15 || t - e.tr.chargeT < 0.1) continue
      if (far && e.d > 110) continue
      if (e.seesMe ? Math.abs(wrap(e.tr.aimYaw - (e.yaw + Math.PI))) < 0.3 : e === primary) return "laser"
    }
    if (weaponsDown && !PROBE.noDuck && !(far && primary.d > 110)) return "reload"
    let nearest = Infinity
    for (const e of threats) nearest = Math.min(nearest, e.d)
    // (standing off we take little: keep shooting until half health before breaking off to mend)
    if (this.healing) {
      if (hpFrac >= 0.9 || nearest < 45) this.healing = false
    } else if (hpFrac < (far ? TUNING.mend : 0.65) && nearest > 75) this.healing = true
    if (this.healing || (hpFrac <= (far ? TUNING.mend + 0.05 : 0.55) && !recent)) return "heal"
    const mine = this.myDpsAt(primary, primary.d)
    const theirs = this.theirDpsAt(primary, primary.d)
    // (also when our edge is a lightning gun, useless until 45 m, and they are walking into it)
    // (not against house bots: there we never want them close, lightning or no lightning)
    const zapper = !far && this.light >= 0 && this.me.energy > 30 && primary.closing > 2
    if (this.ambush) {
      if (primary.d < 45 || (mine >= theirs && !zapper)) this.ambush = false
    } else if (primary.d > 60 && (mine < theirs * 0.75 || zapper)) this.ambush = true
    return this.ambush ? "ambush" : ""
  }

  /** The supply drop worth walking to now, if any: 3 cubes and a full repair for 4 s alone in its ring. */
  private dropPlan(zone: any, hpFrac: number): { x: number; y: number; r: number; lands: number; d: number; inRing: boolean; crowd: number } | null {
    // Against house bots this is a switch we score separately. In a free-for-all a drop is where the
    // strongest bots go (the best team on the feed took 5 in 2 matches), so only an unattended one.
    if (!TUNING.drops && !this.ffa) return null
    const [mx, my] = this.me.pos as number[]
    let best: { x: number; y: number; r: number; lands: number; d: number; inRing: boolean; crowd: number } | null = null
    for (const dr of this.obs.drops ?? []) {
      const x = dr.pos[0]
      const y = dr.pos[1]
      const d = hyp(x - mx, y - my)
      const lands = dr.lands_in ?? 0
      const r = dr.radius ?? this.cfg.drops?.radius ?? 8
      if (d > 320 || d / 9 > lands + 20) continue // too far: someone else will have it first
      if (!this.zoneOk(zone, x, y) || this.nav.snap(x, y, 3) < 0) continue
      let crowd = 0
      for (const tr of this.tracks.values()) if (!tr.npc && !tr.ghost && this.t - tr.t < 6 && hyp(tr.x - x, tr.y - y) < 60) crowd++
      if (crowd >= 2 || (crowd === 1 && hpFrac < 0.5 && d > r)) continue
      if (this.ffa) {
        let near = false
        for (const tr of this.tracks.values()) if (!tr.npc && this.t - tr.t < 20 && hyp(tr.x - x, tr.y - y) < 220) near = true
        if (near || this.nearFoes > 0) continue
      }
      if (!best || d < best.d) best = { x, y, r, lands, d, inRing: d <= r - 1, crowd }
    }
    return best
  }

  /** Playing the long-range game: against house bots, which is everything that is not a free-for-all. */
  private far(): boolean {
    return TUNING.standoff && !TUNING.brawl && !this.ffa
  }

  /**
   * The other way to play house bots, kept behind a switch for a comparison score: close in and
   * out-shoot them, as the bots tied near the top of the practice board do (median gun range
   * 30-85 m on the match feed). No cover, no breaking off to mend, everything in sight is a target.
   */
  private brawling(): boolean {
    return TUNING.brawl && !this.ffa
  }

  /** Build 5's battle-royale play (see TUNING): the mid-range cover fight, plus finishing, resets and seeking. */
  private pro(): boolean {
    return TUNING.pro && !TUNING.standoff && !TUNING.brawl && !this.ffa
  }

  private prefRange(e: Enemy): number {
    const me = this.me
    const theyLaser = e.tr.weapons.includes("laser")
    const theyLight = e.tr.weapons.includes("lightning")
    if (this.far()) return this.rangeNow
    // finishing one that is nearly dead and backing off: close enough that every gun shot lands
    // (inside 40 m; 28 m with a lightning gun, which needs no aim at all)
    if (this.pro() && this.finishing) return this.light >= 0 && me.energy > 15 ? 28 : 38
    // (85 m, standing: what the teams tied at 6.19 do on the match feed, 37 showdowns: median gun
    // range 84 m, standing still 40% of the time, first shot 4 s into the match, no backing off)
    if (this.brawling()) return this.light >= 0 && me.energy > 15 && e.d < 60 ? 28 : 85
    if (this.light >= 0 && me.energy > 15) return 28
    if (theyLight) return this.laser >= 0 ? 110 : 90
    if (this.laser >= 0 && !theyLaser) return 165 // the top bots' guns land 55% at 80-120 m, 40% at 120-160, 33% beyond
    if (theyLaser && this.laser < 0) return 40
    return 95
  }

  /**
   * Which way we sidestep. Reversing takes 0.4 s at full acceleration, so flipping more often than
   * that leaves us nearly standing still. Up close, where a bullet arrives before any change of
   * direction can matter, speed is the only defence (a gun aimed at where we are misses a fast
   * target): long sweeps. At range, a reversal about once a second also beats a gun that leads us.
   */
  private flipStrafe(d: number) {
    if (this.t >= this.strafeFlipT) {
      this.strafe = -this.strafe
      this.strafeFlipT = this.t + (d < 70 ? 1.6 + this.rnd() * 2.4 : 0.6 + this.rnd() * 0.6)
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
   * Score positions we can reach in the next second (a ring at 5 m, another at 10 m when `maxR`
   * allows, and standing still) and return the best.
   * "fight": keep the enemy in view at the preferred range, a step from cover, sliding sideways.
   * "hide": get out of every known enemy's line of fire.
   */
  private local(mode: "fight" | "hide", primary: Enemy, threats: Enemy[], pref: number, shells: { x: number; y: number; r: number }[], zone: any, maxR: number): { x: number; y: number; hidden: boolean } | null {
    const [mx, my] = this.me.pos as number[]
    const w = this.w
    const pd = Math.max(1, primary.d)
    const perpX = (-(primary.y - my) / pd) * this.strafe
    const perpY = ((primary.x - mx) / pd) * this.strafe
    const phase = this.rnd() * (TAU / 16)
    const X: number[] = []
    const Y: number[] = []
    const EP: boolean[] = []
    const EO: number[] = []
    const last = maxR >= 10 ? 32 : 16
    // standing on a roof (or anything else off the walkable grid): move along the same level
    const onRoof = w.bld[w.idx(mx, my)] === 1 && Math.abs(this.me.pos[2] - w.surface(mx, my)) < 1.5
    let open = 0
    for (let k = -1; k < last; k++) {
      let cx = mx
      let cy = my
      if (k >= 0) {
        const ang = (k % 16) * (TAU / 16) + phase
        const r = k < 16 ? 5 : 10
        cx = mx + Math.cos(ang) * r
        cy = my + Math.sin(ang) * r
        if (onRoof ? !this.levelLine(mx, my, cx, cy) : !this.nav.lineWalkable(mx, my, cx, cy, 0.3)) continue
        if ((cx - mx) * perpX + (cy - my) * perpY > 3) open++
      }
      const cz = w.surface(cx, cy)
      let expP = false
      let expO = 0
      for (const e of threats) {
        const vis = w.los(e.x, e.y, e.mz, cx, cy, cz + this.H * 0.5) || w.los(e.x, e.y, e.mz, cx, cy, cz + this.H * 0.92)
        if (e === primary) expP = vis
        else if (vis) expO++
      }
      X.push(cx)
      Y.push(cy)
      EP.push(expP)
      EO.push(expO)
    }
    // nowhere to go the way we were sidestepping: turn round now
    if (mode === "fight" && open === 0) this.strafeFlipT = 0
    const laserFoe = primary.tr.weapons.includes("laser")
    const ring = this.ring
    const far = this.far()
    const rm = hyp(mx - zone.cx, my - zone.cy)
    const orbit = far && mode === "fight" && zone.cr > 150 && rm > 0.65 * zone.cr
    let orbX = 0
    let orbY = 0
    if (orbit) {
      if (this.t > this.orbitT) {
        // the way round that leads away from the nearest of them
        let nx = primary.x
        let ny = primary.y
        let nd = primary.d
        for (const e of threats) if (e.d < nd) ((nd = e.d), (nx = e.x), (ny = e.y))
        const tx = -(my - zone.cy) / rm
        const ty = (mx - zone.cx) / rm
        this.orbitDir = tx * (mx - nx) + ty * (my - ny) >= 0 ? 1 : -1
        this.orbitT = this.t + 8
      }
      orbX = (-(my - zone.cy) / rm) * this.orbitDir
      orbY = ((mx - zone.cx) / rm) * this.orbitDir
    }
    const NEAR: number[] = []
    let bestI = 0
    let best: { x: number; y: number; hidden: boolean } | null = null
    let bestS = -Infinity
    for (let i = 0; i < X.length; i++) {
      const cx = X[i]
      const cy = Y[i]
      const dP = hyp(primary.x - cx, primary.y - cy)
      let s = 0
      if (mode === "fight") {
        if (EP[i]) s += 3
        s -= 2 * EO[i]
        const band = Math.min(20, pref * 0.3)
        let near = dP
        if (far) for (const e of threats) near = Math.min(near, hyp(e.x - cx, e.y - cy))
        NEAR[i] = near
        // standing off: every metre the nearest of them gains on us counts, more than a sidestep does
        if (far && near < pref - band) s -= (pref - band - near) / 3
        else s -= Math.max(0, Math.abs(dP - pref) - band) / 10
        // (sidestepping: against house bots sideways speed made no difference to how often they hit,
        // and it eats the speed we need to keep the range)
        s += ((far && !this.mortarFoe ? 0.3 : 1.5) * ((cx - mx) * perpX + (cy - my) * perpY)) / 10
        if (far && !this.finishing) {
          // Room: a step toward the edge of the circle is worth less the nearer the edge is, and
          // close to it the way to keep a distance is round, not out. One way round, kept.
          s -= Math.max(0, hyp(cx - zone.cx, cy - zone.cy) - 0.6 * zone.cr) / 6
          if (orbit) s += (2.2 * ((cx - mx) * orbX + (cy - my) * orbY)) / 10
        }
        // a step from cover: somewhere to go when their laser charges or our magazine runs dry
        let cover = false
        for (let j = 0; !cover && j < X.length; j++) if (!EP[j] && EO[j] === 0 && hyp(X[j] - cx, Y[j] - cy) <= 6.2) cover = true
        if (cover) s += laserFoe ? 2 : 0.8
      } else {
        s -= 6 * ((EP[i] ? 1 : 0) + EO[i])
        s += 0.03 * dP
        s -= 0.05 * hyp(cx - mx, cy - my)
      }
      for (const sh of shells) if (hyp(cx - sh.x, cy - sh.y) < sh.r) s -= 8
      const out = hyp(cx - zone.cx, cy - zone.cy) - (zone.cr - 8)
      if (out > 0) s -= 0.5 + out / 5
      if (w.clearance(cx, cy) < this.R + 1.5) s -= 0.5
      if (ring && hyp(cx - ring.x, cy - ring.y) > ring.r - 1.5) s -= 5
      if (s > bestS) {
        bestS = s
        bestI = i
        best = { x: cx, y: cy, hidden: !EP[i] && EO[i] === 0 }
      }
    }
    // how much room the chosen step puts between us and the nearest of them (the first candidate is "stay")
    this.kiteGain = mode === "fight" && X.length ? (NEAR[bestI] ?? 0) - (NEAR[0] ?? 0) : 0
    return best
  }

  /**
   * Free-for-all: the standable spot inside the zone that is farthest from every mech we have seen
   * lately, preferring ones out of their sight and not too long a walk. Null when where we stand is
   * already about as good as it gets.
   */
  private safeSpot(zone: any): { x: number; y: number } | null {
    const t = this.t
    if (this.safe && t < this.safe.until) return this.safe.stay ? null : this.safe
    const [mx, my] = this.me.pos as number[]
    const w = this.w
    const foes: { x: number; y: number; fresh: boolean; mz: number }[] = []
    for (const tr of this.tracks.values()) {
      if (tr.npc || t - tr.t > 25) continue
      const lead = Math.min(t - tr.t, 1)
      foes.push({ x: tr.x + tr.vx * lead, y: tr.y + tr.vy * lead, fresh: !tr.ghost && t - tr.t <= 5, mz: tr.z + this.cfg.mech.muzzle_height })
    }
    // (a drop draws company: in a free-for-all that is a reason to keep away from it)
    if (this.ffa) for (const d of this.obs.drops ?? []) if ((d.lands_in ?? 0) < 30) foes.push({ x: d.pos[0], y: d.pos[1], fresh: false, mz: 0 })
    if (!foes.length) return null
    const score = (x: number, y: number) => {
      let near = 280
      for (const f of foes) near = Math.min(near, hyp(f.x - x, f.y - y))
      let s = near - 0.35 * hyp(x - mx, y - my)
      const cz = w.surface(x, y)
      let seen = false
      for (const f of foes) if (f.fresh && hyp(f.x - x, f.y - y) < 260 && w.los(f.x, f.y, f.mz, x, y, cz + this.H * 0.6)) seen = true
      if (!seen) s += 70
      return s
    }
    const stay = score(mx, my)
    let best: { x: number; y: number } | null = null
    let bs = stay + 25 // only worth moving for a clear gain
    for (const r of [25, 50, 80, 120, 170, 230])
      for (let k = 0; k < 16; k++) {
        const x = mx + Math.cos((k * TAU) / 16) * r
        const y = my + Math.sin((k * TAU) / 16) * r
        if (!this.nav.free(x, y, 1) || !this.nav.inMain(x, y)) continue
        if (hyp(x - zone.cx, y - zone.cy) > zone.cr - 20 || !this.zoneOk(zone, x, y)) continue
        const sc = score(x, y)
        if (sc > bs) {
          bs = sc
          best = { x, y }
        }
      }
    this.safe = best ? { ...best, until: t + 2.5, stay: false } : { x: mx, y: my, until: t + 1.5, stay: true }
    return best
  }

  /** A straight walk that stays on one level: no step over STEP_UP either way (so it never leaves a roof). */
  private levelLine(x0: number, y0: number, x1: number, y1: number): boolean {
    const w = this.w
    const dx = x1 - x0
    const dy = y1 - y0
    const n = Math.max(1, Math.ceil(hyp(dx, dy)))
    let prev = this.me.pos[2] as number
    for (let k = 1; k <= n; k++) {
      const x = x0 + (dx * k) / n
      const y = y0 + (dy * k) / n
      if (!w.inGrid(x, y)) return false
      const sf = w.surface(x, y)
      if (Math.abs(sf - prev) > STEP_UP) return false
      prev = sf
    }
    // keep the whole footprint on the roof at the far end
    for (let q = 0; q < 8; q++) if (Math.abs(w.surface(x1 + Math.cos(q * 0.7854) * this.R, y1 + Math.sin(q * 0.7854) * this.R) - prev) > STEP_UP) return false
    return true
  }

  /**
   * Break line of sight: a hidden spot within `nearR` if there is one; else, when `farR` > 0, the
   * nearest cover within that distance. Null when there is nowhere to hide.
   */
  private hide(primary: Enemy, threats: Enemy[], shells: { x: number; y: number; r: number }[], zone: any, boost: boolean, farR: number, nearR: number): Move | null {
    const me = this.me
    const [mx, my] = me.pos as number[]
    const w = this.w
    const b = boost && me.energy > 8
    if (!threats.length) return null
    const near = this.local("hide", primary, threats, 0, shells, zone, nearR)
    if (near && near.hidden) {
      this.cover = null
      return this.toward(near.x, near.y, b)
    }
    if (farR <= 0) return null
    if (!this.cover || this.t > this.cover.until) {
      let best: { x: number; y: number } | null = null
      let bestS = Infinity
      for (const r of [16, 24, 34, 46, 60, 80, 100, 120, 140]) {
        if (r > farR) break
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
        if (best && bestS < r) break // nothing in a wider ring can beat it
      }
      this.cover = best ? { ...best, until: this.t + 1 } : null
    }
    if (this.cover) return this.travel({ x: this.cover.x, y: this.cover.y, stop: 1, boost: b, kind: "cover" })
    return null
  }

  /** Can we walk to it? With `roofOk`, also: is it on a roof low enough to jet onto from walkable ground? */
  private reachable(e: Item, roofOk = false): boolean {
    const h = e.z - this.w.ground(e.x, e.y)
    if (h < 2.5) return this.nav.snap(e.x, e.y, 3) >= 0
    if (!roofOk || h > 40) return false
    return Math.abs(e.z - this.w.surface(e.x, e.y)) < 2 && this.nav.snap(e.x, e.y, 25) >= 0
  }

  /** A spot we gave up walking to a moment ago. */
  private barred(x: number, y: number): boolean {
    for (const b of this.bars) if (this.t < b.until && hyp(b.x - x, b.y - y) < 6) return true
    return false
  }

  /**
   * The goal to walk to, with a watch on progress: something we are fetching (a weapon, a cube, a
   * crate, a mech last seen somewhere) that gets no nearer for 14 s is given up for a minute. The
   * map has corners the legs cannot solve, and a match is too short to spend one in them.
   */
  private chooseGoal(zone: any, hpFrac: number): Goal {
    let g = this.pickGoal(zone, hpFrac)
    if (g.kind === "weapon" || g.kind === "cube" || g.kind === "crate" || g.kind === "seek") {
      const [mx, my] = this.me.pos as number[]
      const d = hyp(g.x - mx, g.y - my)
      const wt = this.watch
      // (the watch runs only while we are actually walking there: a fight in between, which takes us
      // elsewhere for half a minute, is not a walk that got nowhere)
      if (!wt || hyp(g.x - wt.x, g.y - wt.y) > 6 || this.t - wt.seen > 1) this.watch = { x: g.x, y: g.y, best: d, t: this.t, seen: this.t }
      else if (d < wt.best - 8) {
        wt.best = d
        wt.t = wt.seen = this.t
      } else if (this.t - wt.t > 14 && d > g.stop + 6) {
        this.bars = this.bars.filter((b) => this.t < b.until)
        this.bars.push({ x: g.x, y: g.y, until: this.t + 60 })
        this.watch = null
        this.path = null
        g = this.pickGoal(zone, hpFrac)
      } else wt.seen = this.t
    }
    return g
  }

  private pickGoal(zone: any, hpFrac: number): Goal {
    const me = this.me
    const [mx, my, mz] = me.pos as number[]
    const t = this.t
    const quiet = true
    // 1. a second weapon
    // (the laser is the one that kills at range: go and trade a lightning gun for one seen nearby)
    const empty = me.weapons.some((x: any) => !x)
    if (quiet && (empty || (WANT[0] === "laser" ? this.laser : this.light) < 0)) {
      let best: Item | null = null
      let bestS = Infinity
      for (const p of this.pickups.values()) {
        const rank = WANT.indexOf(p.kind)
        if (rank < 0 || this.ignore.has(p.id) || (!empty && rank > 0) || this.barred(p.x, p.y)) continue
        const d = hyp(p.x - mx, p.y - my)
        if (d > 260 || !this.reachable(p, true) || !this.zoneOk(zone, p.x, p.y)) continue
        // a roof costs a climb (energy and time): worth about 70 m of walking
        const roof = p.z - this.w.ground(p.x, p.y) >= 2.5
        // (a laser is worth a long walk: at the range we fight from it is two thirds of our damage,
        // and a lightning gun none of it)
        const s = d + rank * 250 + (roof ? 70 : 0)
        if (s < bestS) {
          bestS = s
          best = p
        }
      }
      if (best) return { x: best.x, y: best.y, stop: 1.5, boost: me.energy > 30 && best.z - this.w.ground(best.x, best.y) < 2.5, kind: "weapon" }
    }
    // 2. cubes lying around (more of them in a free-for-all: every fifth or so is another upgrade,
    // and against lasers, which never miss, being a bigger target costs little)
    const cubeGoal = CUBE_TARGET
    if (quiet && (me.cubes ?? 0) < cubeGoal) {
      let best: Item | null = null
      // (against house bots a kill made from 170 m leaves its cubes, all of theirs plus two, that far away)
      let bd = this.far() && !this.wary ? 230 : 80
      for (const c of this.cubes.values()) {
        const d = hyp(c.x - mx, c.y - my)
        if (d < bd && this.reachable(c) && this.zoneOk(zone, c.x, c.y) && !this.barred(c.x, c.y)) {
          bd = d
          best = c
        }
      }
      if (best) return { x: best.x, y: best.y, stop: 0.5, boost: false, kind: "cube" }
    }
    // 3. Against house bots the clock is theirs (the whole squad comes late on, grown): with nobody
    // in sight, healthy and armed, go to where one was last seen rather than wait for it. A kill is a
    // point and at least two cubes, so this comes before crates.
    // (`pro`: whole, with both weapons in hand, and past the opening half minute, which is for looting
    // and in a free-for-all is when the first death tells us what kind of match this is)
    const proSeek = this.pro() && hpFrac >= 0.8 && !empty && (t > 25 || this.killCount > 0)
    if (TUNING.seek && !this.wary && (proSeek || (this.brawling() ? hpFrac >= 0.5 : this.far() && hpFrac >= 0.7 && (this.laser >= 0 || (me.cubes ?? 0) >= 4)))) {
      const q = this.quarry(zone)
      if (q) return { x: q.x, y: q.y, stop: this.brawling() || (q as any).low ? 40 : proSeek ? 70 : STANDOFF - 10, boost: false, kind: "seek" }
    }
    // 4. crates, when healthy enough that shooting does not cost us healing
    if (hpFrac >= 0.9 && (me.cubes ?? 0) < cubeGoal && (!this.wary || this.nearFoes === 0 || (!this.ffa && this.nearFoeD >= 150))) {
      let best: Item | null = null
      let bd = this.wary ? 120 : 220
      for (const c of this.crates.values()) {
        const d = hyp(c.x - mx, c.y - my)
        if (d < bd && this.reachable(c) && this.zoneOk(zone, c.x, c.y) && !this.barred(c.x, c.y)) {
          bd = d
          best = c
        }
      }
      if (best) {
        const clear = bd < 45 && this.w.los(mx, my, mz + this.muzH, best.x, best.y, best.z + 1.2)
        return { x: best.x, y: best.y, stop: clear ? 20 : 3, boost: false, kind: "crate" }
      }
    }
    // 5. nothing known: get inside the next circle, then wander it looking for loot
    if (hyp(mx - zone.nx, my - zone.ny) > zone.inner + 5) return { x: zone.gx, y: zone.gy, stop: 3, boost: false, kind: "rotate" }
    // free-for-all: with someone within earshot of our footsteps' range of interest, stand still
    // (silent) and watch; otherwise go looking for loot (cubes are health for the end)
    // (before the kind of match is known, only with one of them nearer than 150 m: otherwise the
    // opening is for finding a laser)
    if (this.wary && this.nearFoes > 0 && (this.ffa || this.nearFoeD < 150)) return { x: mx, y: my, stop: 5, boost: false, kind: "post" }
    // (with nothing known to go after: an open look-out, below)
    // Nothing left to gain by walking about (both slots full and all the cubes we want), or the
    // circle is small enough that everyone left is near: pick a spot few places can see, go there
    // and stand still. A mech pacing the middle of the last circles is seen and heard by all.
    // (also, against house bots, while we are mending: an open look-out is where to be found)
    if (zone.nr <= 70 || ((me.cubes ?? 0) >= cubeGoal && !me.weapons.some((x: any) => !x)) || (this.far() && !this.wary && hpFrac < 0.7)) {
      const p = this.postSpot(zone)
      if (p) return { x: p.x, y: p.y, stop: 2.5, boost: false, kind: "post" }
    }
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

  /**
   * Where to retreat to against house bots: a walkable spot within 130 m that is far from every one
   * of them, keeps a line of fire on the one we are shooting, leaves room inside the circle, and is
   * not reached by walking toward any of them. Null when nowhere is better than here.
   */
  private kiteSpot(primary: Enemy, threats: Enemy[], zone: any): { x: number; y: number } | null {
    const t = this.t
    const [mx, my] = this.me.pos as number[]
    const w = this.w
    const nav = this.nav
    const all = threats.includes(primary) ? threats : [primary, ...threats]
    const k0 = this.kite
    if (k0 && t < k0.until && hyp(k0.x - mx, k0.y - my) > 6) {
      // keep going while it still leads away from the nearest of them
      let ok = true
      for (const e of all) if (hyp(e.x - k0.x, e.y - k0.y) < e.d - 5) ok = false
      if (ok) return k0
    }
    const score = (x: number, y: number, walk: number) => {
      let near = 260
      for (const e of all) near = Math.min(near, hyp(e.x - x, e.y - y) - Math.max(0, e.closing) * (walk / 10))
      let sc = near - 0.45 * walk
      const cz = w.surface(x, y)
      if (w.los(x, y, cz + this.muzH, primary.x, primary.y, primary.cz)) sc += all.length <= 1 ? 60 : 40
      sc -= Math.max(0, hyp(x - zone.cx, y - zone.cy) - 0.7 * zone.cr) * 0.8
      return sc
    }
    let best: { x: number; y: number } | null = null
    // staying, priced the same way: where they will be three seconds from now
    let bs = score(mx, my, 30) + 0.45 * 30 + 6
    const phase = this.rnd() * 0.39
    for (const r of [30, 60, 95, 130])
      for (let k = 0; k < 16; k++) {
        const x = mx + Math.cos((k * TAU) / 16 + phase) * r
        const y = my + Math.sin((k * TAU) / 16 + phase) * r
        if (!nav.free(x, y, 1) || !nav.inMain(x, y)) continue
        if (hyp(x - zone.cx, y - zone.cy) > zone.cr - 20 || !this.zoneOk(zone, x, y)) continue
        // not by way of them: the first third of the straight line must not close on anyone
        let toward = false
        for (const e of all) if (hyp(e.x - (mx + (x - mx) / 3), e.y - (my + (y - my) / 3)) < e.d - 3) toward = true
        if (toward) continue
        // a spot behind a long detour is not 60 m away: charge the straight line when it is walkable, half again when not
        const sc = score(x, y, nav.lineWalkable(mx, my, x, y, 1) ? r : r * 1.6)
        if (sc > bs) {
          bs = sc
          best = { x, y }
        }
      }
    this.kite = best ? { ...best, until: t + 2.5 } : null
    return this.kite
  }

  /** A laser on the ground within `maxD` that we can walk to. */
  private laserNear(zone: any, maxD: number): Goal | null {
    const [mx, my] = this.me.pos as number[]
    let best: Item | null = null
    let bd = maxD
    for (const p of this.pickups.values()) {
      if (p.kind !== "laser" || this.ignore.has(p.id)) continue
      const d = hyp(p.x - mx, p.y - my)
      if (d < bd && this.reachable(p) && this.zoneOk(zone, p.x, p.y)) {
        bd = d
        best = p
      }
    }
    return best ? { x: best.x, y: best.y, stop: 1.5, boost: this.me.energy > 30, kind: "weapon" } : null
  }

  /** Where the nearest mech we know of was last seen (or, failing that, where gunfire was heard). */
  private quarry(zone: any): { x: number; y: number } | null {
    const t = this.t
    const [mx, my, mz] = this.me.pos as number[]
    let best: { x: number; y: number } | null = null
    let bd = 480
    for (const [id, q] of this.lastSeen) {
      if (t - q.t > 50) {
        this.lastSeen.delete(id)
        continue
      }
      const d = hyp(q.x - mx, q.y - my)
      // Lost a moment ago, near, and it was walking at us: a hunter on its way (they share vision).
      // Let it come. One that was not coming will not: go to it. And one that left nearly dead is
      // mending, so every second counts.
      if (t - q.t < 15 && d < 260 && !this.brawling() && !q.low && q.coming) continue
      // we are looking at the place and nobody is there: gone
      if (t - q.t > 3 && d < 190 && this.w.los(mx, my, mz + this.eyeH, q.x, q.y, q.z + 4.5)) {
        this.lastSeen.delete(id)
        continue
      }
      if (d < bd && this.zoneOk(zone, q.x, q.y) && !this.barred(q.x, q.y)) {
        bd = d
        best = q
      }
    }
    if (best) return best
    if (t - this.farHeardT < 12) {
      const x = mx + Math.cos(this.farHeardYaw) * 150
      const y = my + Math.sin(this.farHeardYaw) * 150
      if (this.w.inGrid(x, y) && this.zoneOk(zone, x, y) && this.nav.snap(x, y, 30) >= 0) return { x, y }
    }
    return null
  }

  /** Leave for the spot farthest from everyone we know of, out of their sight if there is one. */
  private runOff(zone: any): Move | null {
    const sp = this.safeSpot(zone)
    return sp ? this.travel({ x: sp.x, y: sp.y, stop: 4, boost: this.me.energy > 20, kind: "away" }) : null
  }

  /**
   * Where to wait when there is nothing to fetch. In a free-for-all: a standable spot inside the next
   * circle's inner disk with walls on as many sides as possible. Against house bots the opposite:
   * the most open one, so that whoever comes is seen, and shot at, from as far away as possible.
   */
  private postSpot(zone: any): { x: number; y: number } | null {
    const t = this.t
    const [mx, my] = this.me.pos as number[]
    const lim = Math.max(6, zone.inner)
    const ok = (x: number, y: number) => hyp(x - zone.nx, y - zone.ny) <= lim && this.zoneOk(zone, x, y)
    if (this.post && t < this.post.until && this.post.key === this.zoneKey && ok(this.post.x, this.post.y)) return this.post
    // Against house bots a post is held for 20 s; with nobody come by then, the next one is somewhere
    // else, toward the last gunfire we heard: a round of look-outs rather than one.
    const old = this.far() && this.post && this.post.key === this.zoneKey ? this.post : null
    const w = this.w
    const nav = this.nav
    const eye = this.eyeH
    const open = this.far()
    const walls = (x: number, y: number) => {
      const z = w.ground(x, y) + eye
      let n = 0
      for (let k = 0; k < 16; k++) {
        const cx = Math.cos((k * TAU) / 16)
        const cy = Math.sin((k * TAU) / 16)
        if (open) {
          // how far we can see that way, in quarters of sight range
          for (const r of [50, 100, 150, 200]) {
            if (!w.los(x, y, z, x + cx * r, y + cy * r, w.ground(x + cx * r, y + cy * r) + eye * 0.6)) break
            n += 0.25
          }
        } else if (!w.los(x, y, z, x + cx * 60, y + cy * 60, w.ground(x + cx * 60, y + cy * 60) + eye * 0.6)) n++
      }
      return n
    }
    // around us while the circle is large, around its centre once it is small
    const far = Math.min(lim, 110)
    const ox = zone.nr <= 140 ? zone.nx : mx
    const oy = zone.nr <= 140 ? zone.ny : my
    let best: { x: number; y: number } | null = null
    let bs = -Infinity
    for (let k = 0; k < 56; k++) {
      const ang = this.rnd() * TAU
      const r = Math.sqrt(this.rnd()) * far
      const x = k === 0 ? mx : ox + Math.cos(ang) * r
      const y = k === 0 ? my : oy + Math.sin(ang) * r
      if (!ok(x, y) || !nav.free(x, y, 1) || !nav.inMain(x, y)) continue
      // a wall on each side is worth 25 m of walking; late on, nearer the centre is where the circle goes
      let sc = walls(x, y) - hyp(x - mx, y - my) / 25 - (zone.nr <= 140 ? (hyp(x - zone.nx, y - zone.ny) / Math.max(10, zone.nr)) * 4 : 0) + (k === 0 && !old ? 1.5 : 0)
      if (old && hyp(x - old.x, y - old.y) < 60) sc -= 4
      // (not where the one we just lost sight of will come out)
      if (open) for (const q of this.lastSeen.values()) if (t - q.t < 15) sc -= Math.max(0, 150 - hyp(x - q.x, y - q.y)) / 20
      if (open && t - this.farHeardT < 20 && hyp(x - mx, y - my) > 20) sc += 2 * Math.cos(wrap(Math.atan2(y - my, x - mx) - this.farHeardYaw))
      if (sc > bs) {
        bs = sc
        best = { x, y }
      }
    }
    this.post = best ? { ...best, until: t + (open ? 20 + hyp(best.x - mx, best.y - my) / 9 : 45), key: this.zoneKey } : null
    return this.post
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
      // Keep going toward the goal over whatever we are standing on. Only when something a jet
      // cannot climb stands in that direction do we make for the nearest walkable ground instead
      // (which may be back the way we came).
      if (nav.snap(g.x, g.y, 3) >= 0 && !this.canHop(g.x, g.y, 70)) {
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
    const zn = this.zoneNow
    // Plan when the goal moves or the route is lost, not on a timer: two routes of nearly equal
    // length would otherwise take turns and walk us back and forth.
    // (also when the same spot turns from somewhere to stroll to into somewhere to be before the
    // circle closes: only that kind of route is checked against the circle and for a way over the top)
    if (!this.path || hyp(g.x - this.pathGX, g.y - this.pathGY) > 4 || this.pathLost || (g.kind === "zone") !== this.pathZone) {
      this.pathLost = false
      this.pathZone = g.kind === "zone"
      // Outside ground costs extra only while we are inside (so we do not leave); once outside,
      // everything around us is outside and the shortest way back in is what we want.
      const keepIn = zn && zn.cr > 12 && hyp(mx - zn.cx, my - zn.cy) < zn.cr - 6
      this.path = nav.findPath(mx, my, g.x, g.y, 18000, keepIn ? { x: zn.cx, y: zn.cy, r: zn.cr - 6, pen: 5 } : undefined)
      this.pathI = 0
      this.pathT = this.t
      this.pathGX = g.x
      this.pathGY = g.y
      // Racing the zone: if the way round is long, or leaves the circle, and nothing taller than a
      // jet can climb stands in the straight line, go over the top instead.
      this.overTop = false
      this.pathOut = 0
      const q = this.path
      const gc = nav.snap(g.x, g.y, 160)
      this.pathPartial = !!q && q.length >= 2 && gc >= 0 && hyp(q[q.length - 2] - nav.cx(gc), q[q.length - 1] - nav.cy(gc)) > 3
      if (g.kind === "zone" && q && q.length >= 4 && zn) {
        let len = 0
        let leaves = false
        for (let k = 2; k < q.length; k += 2) {
          const seg = hyp(q[k] - q[k - 2], q[k + 1] - q[k - 1])
          len += seg
          // (a path that only touches the edge counts: the hop off its far end, our own width and
          // a tick of delay are each worth a couple of metres)
          if (hyp(q[k] - zn.cx, q[k + 1] - zn.cy) > zn.cr - Math.min(2, zn.cr * 0.1)) {
            leaves = true
            this.pathOut += seg
          }
        }
        if (dGoal < 160 && this.t > this.noHopUntil && (len > 1.5 * dGoal + 25 || (leaves && hyp(g.x - zn.cx, g.y - zn.cy) <= zn.cr)) && this.canHop(g.x, g.y)) this.overTop = true
      }
      // That exact point cannot be walked to without leaving the circle (or at all, within the
      // search's budget), and not hopped to either. Any ground well inside the next circle will do:
      // take the shortest walk that reaches some, and wait there.
      this.pathAlt = false
      if (g.kind === "zone" && zn && q && !this.overTop && (this.pathOut > 0 || this.pathPartial)) {
        const rr = zn.nr - clamp(zn.nr * 0.25, 4, 15)
        if (rr > 3 && hyp(mx - zn.nx, my - zn.ny) > rr) {
          const alt = nav.findPath(mx, my, zn.nx, zn.ny, 18000, keepIn ? { x: zn.cx, y: zn.cy, r: zn.cr - 6, pen: 5 } : undefined, rr)
          if (alt && alt.length >= 4) {
            let out = 0
            for (let k = 2; k < alt.length; k += 2) if (hyp(alt[k] - zn.cx, alt[k + 1] - zn.cy) > zn.cr - Math.min(2, zn.cr * 0.1)) out += hyp(alt[k] - alt[k - 2], alt[k + 1] - alt[k - 1])
            const reached = hyp(alt[alt.length - 2] - zn.nx, alt[alt.length - 1] - zn.ny) <= rr + 2
            if (reached && (this.pathPartial || out < this.pathOut - 1)) {
              this.path = alt
              this.pathOut = out
              this.pathPartial = false
              this.pathAlt = true
            }
          }
        }
      }
    }
    // A walk that leaves the circle was the best there was from where we planned it. Further along,
    // the straight line over the roofs may have opened up: look again every half second.
    if (g.kind === "zone" && this.pathOut > 0 && !this.overTop && !this.pathAlt && this.t > this.noHopUntil && this.t - this.hopLookT > 0.45) {
      this.hopLookT = this.t
      if (dGoal < 160 && zn && hyp(mx - zn.cx, my - zn.cy) <= zn.cr && this.canHop(g.x, g.y)) this.overTop = true
    }
    if (this.overTop && g.kind === "zone" && this.t > this.noHopUntil) {
      this.hop = { x: g.x, y: g.y }
      return this.direct(g.x, g.y, true)
    }
    const p = this.path
    if (!p || p.length < 2) return this.direct(g.x, g.y, g.kind === "zone")
    const n = p.length / 2
    const ex = p[2 * n - 2]
    const ey = p[2 * n - 1]
    // a long route can come back unfinished (the search has a budget): plan the rest before we run out of it
    if (this.pathPartial && hyp(ex - mx, ey - my) < 30 && this.t - this.pathT > 0.5) this.pathLost = true
    if (hyp(ex - mx, ey - my) < 5 && !this.pathPartial) {
      if (this.pathAlt) return { x: 0, y: 0, boost: false, jump: false } // as far in as walking gets us
      // end of the walkable path but not at the goal: the goal is off the grid (roof, pit)
      if (hyp(g.x - ex, g.y - ey) > Math.max(3, g.stop)) {
        this.hop = { x: g.x, y: g.y }
        return this.direct(g.x, g.y, g.kind === "zone")
      }
      return { x: (g.x - mx) / dGoal, y: (g.y - my) / dGoal, boost, jump: false }
    }
    let k = Math.min(n - 1, this.pathI + 16)
    // The walking route leaves a circle that hurts. Costing a quarter of our health while we are
    // already inside the next circle: this is the place to stay. Costing all of it: go as far along
    // it as stays inside and wait (alive a little longer, and a way over the roofs may yet open).
    // Anything in between we walk now: the circle only closes, and the way round only gets longer.
    if (g.kind === "zone" && zn && this.pathOut > 0 && hyp(mx - zn.cx, my - zn.cy) <= zn.cr - 1) {
      const cost = (this.pathOut / 10) * zn.dps
      if (cost > 0.25 * me.hp && hyp(mx - zn.nx, my - zn.ny) <= zn.nr - clamp(zn.nr * 0.25, 4, 15)) return { x: 0, y: 0, boost: false, jump: false }
      if (cost > 0.9 * me.hp) {
        let lastIn = this.pathI
        while (lastIn + 1 < n && hyp(p[2 * lastIn + 2] - zn.cx, p[2 * lastIn + 3] - zn.cy) <= zn.cr - 3) lastIn++
        if (lastIn < n - 1) {
          if (hyp(p[2 * lastIn] - zn.cx, p[2 * lastIn + 1] - zn.cy) > zn.cr - 3) return { x: 0, y: 0, boost: false, jump: false }
          k = Math.min(k, lastIn)
          if (hyp(p[2 * k] - mx, p[2 * k + 1] - my) < 2) return { x: 0, y: 0, boost: false, jump: false }
        }
      }
    }
    for (; k > this.pathI; k--) if (nav.lineWalkable(mx, my, p[2 * k], p[2 * k + 1], 1)) break
    // drifted off the route (a fight, a shove): nothing on it is reachable in a straight line any more
    if (k === this.pathI && this.t - this.pathT > 0.7 && hyp(p[2 * k] - mx, p[2 * k + 1] - my) > 6 && !nav.lineWalkable(mx, my, p[2 * k], p[2 * k + 1], 0.3)) this.pathLost = true
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

  /** The straight line to a point crosses only walls a jet can climb (and does not leave the map). */
  private canHop(tx: number, ty: number, maxLen = 1e9): boolean {
    const w = this.w
    const [mx, my, mz] = this.me.pos as number[]
    const d = hyp(tx - mx, ty - my)
    if (d < 4) return true
    let cur = mz
    let climb = 0
    for (let s = 1; s <= Math.min(d, maxLen); s += 1) {
      const x = mx + ((tx - mx) * s) / d
      const y = my + ((ty - my) * s) / d
      if (!w.inGrid(x, y) || x < w.bMinX || x > w.bMaxX || y < w.bMinY || y > w.bMaxY) return false
      const sf = w.over(x, y) // a bridge is crossed over its deck
      if (sf - cur > STEP_UP) {
        if (sf - cur > 35) return false
        climb += sf - cur
      }
      cur = sf
    }
    return climb <= 70
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
    // The first wall on the way: a rise of more than one step between consecutive metres, anywhere
    // across our width. A slope, however long, is walked. `need` is the height our feet must reach.
    const look = Math.min(d + this.R, this.R + 9)
    let wallAt = -1
    let need = -Infinity
    for (const o of [0, 0.9, -0.9]) {
      const sx = mx - uy * this.R * o
      const sy = my + ux * this.R * o
      let cur = Math.max(mz, o === 0 ? -Infinity : w.over(sx, sy))
      for (let q = 1; q <= look; q += 1) {
        const sf = w.over(sx + ux * q, sy + uy * q)
        if (sf - cur > STEP_UP) {
          if (wallAt < 0 || q < wallAt) wallAt = q
          for (let e = q; e <= q + 2 * this.R + 2; e += 1) need = Math.max(need, w.over(sx + ux * e, sy + uy * e))
          break
        }
        cur = me.grounded ? sf : Math.max(sf, mz)
      }
    }
    if (!me.grounded) {
      let boost = wallAt >= 0 && wallAt <= this.R + 5 && mz < need + 1.5
      // Level with the top is not over it: a wide mech that stops its jets there drops back before
      // its middle has crossed the edge. Hold height while something taller than what is under our
      // middle still lies under our leading half.
      const here = w.over(mx, my)
      let ahead = -Infinity
      for (const o of [0, 0.9, -0.9]) for (let q = 1; q <= this.R + 2; q += 1) ahead = Math.max(ahead, w.over(mx - uy * this.R * o + ux * q, my + ux * this.R * o + uy * q))
      if (ahead > here + STEP_UP && mz < ahead + 0.8 && ahead - mz < 36) boost = true
      return { x: ux, y: uy, boost: boost && me.energy > 0.5, jump: false }
    }
    if (wallAt < 0 || wallAt > this.R + 5) return { x: ux, y: uy, boost: false, jump: false }
    // On the ground at the foot of it: only start a climb we have the energy to finish.
    const rise = need - mz
    const maxE = me.max_energy ?? 100
    // (the climb, plus staying up while our whole width crosses the edge: a bigger mech needs longer)
    const cost = ((rise + 3) / 8.9 + (2 * this.R + 2) / 14) * (me.stats?.jet_drain ?? 15) + 3
    if (cost > maxE * 0.97) return { x: -uy, y: ux, boost: false, jump: false } // too tall: feel along it
    if (me.energy >= cost) return { x: ux, y: uy, boost: true, jump: true }
    return { x: 0, y: 0, boost: false, jump: false } // wait for the jets to recharge
  }

  /**
   * Bullets take two thirds of a second to cross the range we fight from, and we are told where
   * every one in view is and how fast it flies. So: which of them would hit us if we carried on as
   * planned, and is there a way of moving for the next moment that fewer of them hit? The planned
   * move is kept whenever nothing would hit it.
   */
  private dodge(want: Move, obs: any, zone: any): Move {
    const list = obs.projectiles
    if (!list || !list.length) return want
    const me = this.me
    const cfg = this.cfg
    const [mx, my, mz] = me.pos as number[]
    if (this.nav.snap(mx, my, 2) < 0 || Math.abs(mz - this.w.surface(mx, my)) > 2.5) return want
    const R = this.R + (cfg.projectile?.gun_radius ?? 0.3) + 0.5
    const foot = mz - 0.6
    const top = mz + this.H + 0.6
    // the ones on their way to us: position, velocity, and when they pass closest to where we stand
    const B: number[] = []
    let tmax = 0
    for (const p of list) {
      if (p.kind !== "gun" && p.kind !== "npc") continue
      const vx = p.vel[0]
      const vy = p.vel[1]
      const v2 = vx * vx + vy * vy
      if (v2 < 100) continue
      const rx = mx - p.pos[0]
      const ry = my - p.pos[1]
      const t0 = (rx * vx + ry * vy) / v2
      if (t0 <= 0.02 || t0 > 1.1) continue
      // a line that passes further off than we could walk into it is no concern of ours
      if (Math.abs(rx * vy - ry * vx) / Math.sqrt(v2) > R + 20 * t0 + 1) continue
      B.push(p.pos[0], p.pos[1], p.pos[2], vx, vy, p.vel[2], t0)
      if (t0 > tmax) tmax = t0
      if (B.length >= 7 * 40) break
    }
    if (!B.length) return want
    const st = me.stats ?? {}
    const charging = this.laser >= 0 && (me.weapons[this.laser]?.charge ?? 0) > 0
    const slow = charging ? (cfg.mech.charge_move_mult ?? 0.5) : 1
    const walk = (st.walk_speed ?? cfg.mech.walk_speed) * slow
    const run = (st.boost_speed ?? cfg.mech.boost_speed) * slow
    const acc = cfg.mech.ground_accel ?? 58.5
    const dt = 0.025
    const n = Math.min(48, Math.ceil((tmax + 0.1) / dt))
    const lat = 0.05 // our answer takes hold a tick after what we saw
    const PX = new Float64Array(n + 1)
    const PY = new Float64Array(n + 1)
    const ring = this.ring
    const outside = hyp(mx - zone.cx, my - zone.cy) > zone.cr - 4
    /** Bullets that would hit if we commanded (cx, cy) at `speed` from now on; -1 if we may not go there. */
    const hitsFor = (cx: number, cy: number, speed: number): { hits: number; clear: number } => {
      let x = mx
      let y = my
      let vx = me.vel[0] as number
      let vy = me.vel[1] as number
      PX[0] = x
      PY[0] = y
      for (let k = 1; k <= n; k++) {
        if (k * dt > lat) {
          const dvx = cx * speed - vx
          const dvy = cy * speed - vy
          const dv = hyp(dvx, dvy)
          const a = acc * dt
          if (dv <= a) {
            vx = cx * speed
            vy = cy * speed
          } else {
            vx += (dvx / dv) * a
            vy += (dvy / dv) * a
          }
        }
        x += vx * dt
        y += vy * dt
        PX[k] = x
        PY[k] = y
      }
      if (ring && hyp(PX[n] - ring.x, PY[n] - ring.y) > ring.r - 1.5) return { hits: -1, clear: 0 }
      if (!outside && hyp(PX[n] - zone.cx, PY[n] - zone.cy) > zone.cr - 4) return { hits: -1, clear: 0 }
      const at = (t: number, out: number[]) => {
        const f = clamp(t / dt, 0, n)
        const i = Math.min(n - 1, Math.floor(f))
        const u = f - i
        out[0] = PX[i] + (PX[i + 1] - PX[i]) * u
        out[1] = PY[i] + (PY[i + 1] - PY[i]) * u
      }
      const q = [0, 0]
      let hits = 0
      let clear = 0
      for (let b = 0; b < B.length; b += 7) {
        const bx = B[b]
        const by = B[b + 1]
        const bvx = B[b + 3]
        const bvy = B[b + 4]
        const v2 = bvx * bvx + bvy * bvy
        let tc = B[b + 6]
        // where we will be when it gets there, twice over (our own movement shifts that moment a little)
        for (let it = 0; it < 2; it++) {
          at(tc, q)
          tc = ((q[0] - bx) * bvx + (q[1] - by) * bvy) / v2
        }
        at(tc, q)
        const off = Math.abs((q[0] - bx) * bvy - (q[1] - by) * bvx) / Math.sqrt(v2)
        const bz = B[b + 2] + B[b + 5] * tc
        if (off < R && bz > foot && bz < top) hits++
        clear += Math.min(3, off - R)
      }
      return { hits, clear }
    }
    const wl = hyp(want.x, want.y)
    const base = hitsFor(wl > 1e-6 ? want.x / Math.max(1, wl) : 0, wl > 1e-6 ? want.y / Math.max(1, wl) : 0, want.boost ? run : walk)
    if (base.hits <= 0) return want
    let best: Move = want
    let bestHits = base.hits
    let bestClear = base.clear
    const speed = want.boost && me.energy > 10 ? run : walk
    for (let k = -1; k < 12; k++) {
      let cx = 0
      let cy = 0
      if (k >= 0) {
        cx = Math.cos((k * TAU) / 12)
        cy = Math.sin((k * TAU) / 12)
        if (!this.nav.lineWalkable(mx, my, mx + cx * 5, my + cy * 5, 0.3)) continue
      }
      const r = hitsFor(cx, cy, speed)
      if (r.hits < 0) continue
      if (r.hits < bestHits || (r.hits === bestHits && best !== want && r.clear > bestClear + 0.5)) {
        bestHits = r.hits
        bestClear = r.clear
        best = { x: cx, y: cy, boost: k >= 0 && want.boost && me.energy > 10, jump: false }
      }
    }
    return best
  }

  private watchStuck(mv: Move, label: string) {
    const me = this.me
    const t = this.t
    this.label = label
    const travelling = !(label === "fight" || label === "duck" || label === "ghost" || label === "dodge" || label === "unstuck")
    const speed = hyp(me.vel[0], me.vel[1])
    if (!travelling || hyp(mv.x, mv.y) <= 0.5 || !me.grounded || speed > 1.5) {
      this.slowT = -1
      return
    }
    if (this.slowT < 0) this.slowT = t
    if (t - this.slowT >= 0.9) {
      // pushing and going nowhere for most of a second: sidestep, jump, and plan again
      const side = this.rnd() < 0.5 ? 1 : -1
      const back = 0.4
      const ux = -mv.y * side - mv.x * back
      const uy = mv.x * side - mv.y * back
      const l = hyp(ux, uy) || 1
      this.unstuckX = ux / l
      this.unstuckY = uy / l
      this.unstuckT = t + 0.7
      this.overTop = false
      this.noHopUntil = t + 12 // going over the top got us wedged: walk for a while
      this.path = null
      this.cover = null
      this.explore = null
      this.slowT = -1
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

  private aimAndFire(act: any, primary: Enemy | null, enemies: Enemy[], hpFrac: number, label: string, holdFire: boolean): number[] {
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
    if (!holdFire && tw && tw.cooldown <= 0.1 && me.energy >= (tw.stats.energy ?? 3) + 1) {
      const half = (((tw.stats.cone_deg ?? 30) * Math.PI) / 180) * 0.45
      for (const e of enemies)
        if (!e.tr.ghost && t - e.tr.t <= 0.15 && e.d <= tw.stats.range * 0.93 && Math.abs(wrap(e.yaw - me.aim[0])) <= half && this.w.los(mx, my, mz + this.muzH, e.x, e.y, e.cz)) {
          act.fire[this.light] = true
          break
        }
    }

    if (primary && !primary.tr.ghost) {
      // Hit by someone we have no fresh sight of, or heard someone close where we know of nobody:
      // turn and look, once every few seconds. The retreat can only keep away from those we know
      // of, and a hit from behind does half as much again.
      if (t >= this.glanceNextT && !this.ffa) {
        let yaw: number | null = null
        const by = this.tracks.get(this.lastHurtBy)
        if (t - this.lastHurtT < 0.6 && this.lastHurtBy !== primary.tr.id && (!by || by.ghost || t - by.t > 1.5)) yaw = this.lastHurtYaw
        else if (t - this.strangerT < 0.6) yaw = this.strangerYaw
        if (yaw !== null && Math.abs(wrap(yaw - me.aim[0])) > 0.9) {
          this.glanceUntil = t + 0.3 + Math.abs(wrap(yaw - me.aim[0])) / Math.max(1, me.stats?.turn_rate ?? 4)
          this.glanceYaw = yaw
          this.glanceNextT = t + 5
        }
      }
      // Nothing can fire for a second or more (magazine going in, laser cooling): the free moment to
      // look where we are going, or behind us. Hunters come from every side and we only see what
      // the torso faces; fleeing one of them into another we had not seen is how the retreat fails.
      if (this.far() && TUNING.look !== "none" && t >= this.glanceUntil && t - this.lookT > 4 && t - this.lastGlanceEnd > 1.2) {
        const gunBusy = !gw || gw.reload > 1.2 || gw.ammo <= 0
        const lasBusy = !lw || (lw.cooldown > 1.2 && !((lw.charge ?? 0) > 0))
        if (gunBusy && lasBusy) {
          const sp = hyp(me.vel[0], me.vel[1])
          let yaw = sp > 3 ? Math.atan2(me.vel[1], me.vel[0]) : wrap(me.aim[0] + Math.PI)
          // already looking that way: then behind us instead
          if (Math.abs(wrap(yaw - me.aim[0])) < 0.9) yaw = wrap(me.aim[0] + Math.PI)
          if (TUNING.look === "side") {
            // To one side and then the other, never past a quarter turn: the one we are fighting stays
            // inside our front half, where its hits do not get the rear bonus (half as much again).
            // (Looking right round, as this did at first, put 17-21% of the damage we took in the
            // walk-at-us check behind our torso; side looks 1-6%, with as little taken from hunters
            // we had not seen.)
            this.lookSide = -this.lookSide
            yaw = wrap(me.aim[0] + this.lookSide * 1.4)
          }
          const turn = Math.abs(wrap(yaw - me.aim[0])) / Math.max(1, me.stats?.turn_rate ?? 4)
          const spare = Math.min(gw ? Math.max(gw.reload, gw.ammo <= 0 ? 1.5 : 0) : 9, lw ? lw.cooldown : 9)
          // there and back inside the time nothing can fire anyway
          if (2 * turn + 0.15 <= spare + 0.3) {
            this.glanceUntil = t + turn + 0.15
            this.glanceYaw = yaw
            this.lookT = t
          }
        }
      }
      if (t < this.glanceUntil) {
        this.lastGlanceEnd = this.glanceUntil
        if (lw) {
          const hold = (lw.charge ?? 0) > 0 && this.laserHold
          act.fire[this.laser] = hold
          this.laserHold = hold
        }
        return [this.glanceYaw, 0]
      }
      const tr = primary.tr
      const floor = this.w.surface(primary.x, primary.y) + primary.hgt * 0.3
      const gunOk = !!gw && gw.ammo > 0 && !(gw.reload > 0) && primary.d <= gw.stats.range * 0.97
      // (Half of the target's vertical speed: a mech in the air is a third of the time, and it neither
      // keeps rising nor simply falls. Against recorded house-bot movement at 170 m that lands 58% of
      // shots, full vertical speed 52%, none 57%; on targets in the air 54% against 37%.)
      const gvz = tr.vz * 0.5
      const gsol = gw ? this.solve(primary.x, primary.y, primary.cz, tr.vx, tr.vy, gvz, gw.stats.speed, floor, 0.1) : null
      const lsol = this.solve(primary.x, primary.y, primary.cz, tr.vx, tr.vy, tr.vz, 0, floor, 0.1)
      const gnow = gw ? this.solve(primary.x, primary.y, primary.cz, tr.vx, tr.vy, gvz, gw.stats.speed, floor, 0) : null
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
      if (gw && !act.fire[this.gun] && !(gw.reload > 0) && gw.ammo < gw.stats.mag && t - this.lastShotT > 1.5 && (gw.ammo <= gw.stats.mag * 0.5 || primary.d > 60)) act.reload = true
      // out of our memory for a while: they could come from anywhere, so sweep instead of staring at a wall
      if (t - tr.t > 1.5) return [wrap(this.cmdYaw + 0.24), 0]
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

    // farm crates and drones while healthy and alone; a drone that is shooting us dies regardless,
    // because its fire keeps resetting our repair timer
    // (in a free-for-all gunfire draws company, so only when nobody has been around for a while)
    // (crate hits count as dealing damage, which holds off our repair: mend first, farm after)
    const farm = hpFrac >= 0.9 && (me.cubes ?? 0) < CUBE_TARGET && (!this.wary || this.nearFoes === 0 || (!this.ffa && this.nearFoeD >= 150))
    const pest = t - this.npcHurtT < 4
    if ((farm || pest) && gw && label !== "zone") {
      let best: { x: number; y: number; z: number; vx: number; vy: number; rad: number; hgt: number; d: number } | null = null
      if (farm) for (const c of this.crates.values()) {
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
    if (t - this.heardT < 1.2) return [this.heardYaw, 0] // footsteps or a shot close by: look that way
    // sweep the torso: a full turn every ~2.6 s keeps everything within sight range in the 5 s memory
    const dt = 0.1
    return [wrap(this.cmdYaw + 2.4 * dt), 0]
  }
}
