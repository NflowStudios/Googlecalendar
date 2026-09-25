/**
 * ============================================================================
 *  Nextbot.ts — The 2D static image that hunts you forever.
 * ============================================================================
 *  BEHAVIOR (rebalanced: the bot now OBEYS WALLS):
 *    • It is a flat 2D image (Monster.PNG) rendered as a THREE.Sprite, so it
 *      always turns to face the camera — the uncanny "cardboard cutout" look.
 *    • It COLLIDES with walls (circle vs AABB, slides along them) and uses
 *      A* pathfinding (see Pathfinder.ts) to navigate around them. You can
 *      genuinely lose it for a while by breaking line of sight — but it
 *      keeps coming, and the rubber-band keeps the pressure on.
 *    • Whenever it has direct line of sight it charges STRAIGHT at you.
 *    • Speed model:
 *        - BASE_SPEED  : cruise — slower than sprinting, faster than walking.
 *        - CATCHUP     : rubber-band boost when it fell far behind (>34m),
 *                        so it can never be permanently escaped.
 *        - LUNGE       : tiny extra speed inside 8m for the kill pressure.
 *        - SPAWN_RAMP  : accelerates from a standstill over ~3.5s.
 *    • "Caught" requires BOTH the catch radius AND line of sight — it can
 *      never grab you through a wall.
 *    • Safety nets: spawn depenetration (never spawns inside a wall) and a
 *      stuck guard (unsticks itself after ~1.5s of grinding a corner).
 *
 *  Small "alive" touches on the static image: vertical bob, scale pulse and
 *  a micro rotation jitter — the image is static, but it never feels calm.
 * ============================================================================
 */

import * as THREE from 'three';
import { BOT } from './constants';
import { clamp, lerp } from './utils';
import type { AABB } from './LevelBuilder';
import type { MazeData } from './MazeGenerator';
import { Pathfinder, type Waypoint } from './Pathfinder';

export type BotState = 'dormant' | 'hunting';

export class Nextbot {
  readonly sprite: THREE.Sprite;
  state: BotState = 'dormant';
  /** Current horizontal distance to the player (updated each frame). */
  distance = Infinity;

  private baseY = BOT.HEIGHT / 2;
  private huntTime = 0;
  private readonly aspect: number;

  // ---- Navigation state (wall-collision mode) ------------------------------
  private nav: Pathfinder | null = null;
  private queryColliders: ((x: number, z: number) => AABB[]) | null = null;
  private path: Waypoint[] = [];
  private pathIdx = 0;
  private replanTimer = 0;
  private lastPlayerCell = { x: -1, z: -1 };
  private stuckTimer = 0;

  constructor(scene: THREE.Scene, texture: THREE.Texture) {
    // Keep the source image's aspect ratio; height drives the scale.
    const img = texture.image as HTMLImageElement;
    this.aspect = img.width / img.height;
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.4, // crisp alpha cutout of the monster figure
      // The bot IGNORES the fog on purpose: walls and ceiling dissolve into
      // the yellow haze, but the monster stays razor-sharp at ANY distance.
      // In the open halls you can watch it gliding at you from 40m+ away —
      // the classic Nextbot "it sees you" moment. (Walls still occlude it
      // normally; it just never fades into the murk while in view.)
      fog: false,
    });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.scale.set(BOT.HEIGHT * this.aspect, BOT.HEIGHT, 1);
    this.sprite.visible = false; // dormant until the grace period ends
    this.sprite.renderOrder = 2;
    scene.add(this.sprite);
  }

  /**
   * Give the bot the maze + collider query for the CURRENT level.
   * Called by the engine every time a fresh maze is built.
   */
  setNav(maze: MazeData, queryColliders: (x: number, z: number) => AABB[]): void {
    this.nav = new Pathfinder(maze);
    this.queryColliders = queryColliders;
    this.path = [];
    this.pathIdx = 0;
    this.replanTimer = 0;
    this.stuckTimer = 0;
  }

  /** Begin the hunt from a world position (the maze's farthest cell). */
  spawnAt(x: number, z: number): void {
    this.sprite.position.set(x, this.baseY, z);
    this.depenetrate(); // debug spawns may land inside a wall — push out
    this.sprite.visible = true;
    this.state = 'hunting';
    this.huntTime = 0;
    this.distance = Infinity;
    this.path = [];
    this.pathIdx = 0;
    this.replanTimer = 0;
    this.stuckTimer = 0;
  }

  hide(): void {
    this.sprite.visible = false;
    this.state = 'dormant';
    this.distance = Infinity;
    this.path = [];
    this.pathIdx = 0;
  }

  /**
   * @returns true if the player was caught this frame.
   */
  update(dt: number, playerPos: THREE.Vector3): boolean {
    if (this.state !== 'hunting') return false;
    this.huntTime += dt;

    const p = this.sprite.position;
    let dx = playerPos.x - p.x;
    let dz = playerPos.z - p.z;
    const dist = Math.hypot(dx, dz);
    this.distance = dist;

    // ---------- Speed model (see header) ---------------------------------
    let speed: number = BOT.BASE_SPEED;
    if (dist > BOT.CATCHUP_DIST) {
      // Rubber-band: blend toward catchup speed the further ahead you are.
      const t = clamp((dist - BOT.CATCHUP_DIST) / 30, 0, 1);
      speed = lerp(BOT.BASE_SPEED, BOT.CATCHUP_SPEED, t);
    }
    if (dist < BOT.LUNGE_DIST) speed += BOT.LUNGE_BOOST * (1 - dist / BOT.LUNGE_DIST);
    // Spawn ramp: 0 -> full speed over SPAWN_RAMP seconds.
    speed *= clamp(this.huntTime / BOT.SPAWN_RAMP, 0, 1);
    // ±3% organic wobble so the closing speed isn't metronome-flat.
    speed *= 1 + Math.sin(this.huntTime * 1.7) * 0.03;

    // ---------- Steering: straight if visible, path otherwise -------------
    let tx = playerPos.x;
    let tz = playerPos.z;
    let hasLOS = true;
    if (this.nav) {
      hasLOS = this.nav.lineOfSight(p.x, p.z, playerPos.x, playerPos.z);
      if (hasLOS) {
        // Direct charge — drop any stale path.
        this.path = [];
        this.pathIdx = 0;
      } else {
        // Out of sight: follow (and periodically replan) an A* route.
        const pc = this.nav.worldToCell(playerPos.x, playerPos.z);
        this.replanTimer -= dt;
        const needReplan =
          this.replanTimer <= 0 ||
          this.pathIdx >= this.path.length ||
          pc.x !== this.lastPlayerCell.x ||
          pc.z !== this.lastPlayerCell.z;
        if (needReplan) {
          this.replanTimer = BOT.PATH_REPLAN;
          this.lastPlayerCell = pc;
          this.path = this.nav.findPath(p.x, p.z, playerPos.x, playerPos.z);
          this.pathIdx = 0;
        }
        // Advance through waypoints we've already reached.
        while (this.pathIdx < this.path.length - 1) {
          const w = this.path[this.pathIdx];
          if (Math.hypot(w.x - p.x, w.z - p.z) < BOT.WAYPOINT_REACH) this.pathIdx++;
          else break;
        }
        const wpt = this.path[this.pathIdx];
        if (wpt) {
          tx = wpt.x;
          tz = wpt.z;
        }
        // (empty path = A* failed — fall through to a straight beeline,
        //  the collision resolver below will stop it from clipping walls)
      }
    }

    // ---------- Move + collide with walls ----------------------------------
    let mx = tx - p.x;
    let mz = tz - p.z;
    const md = Math.hypot(mx, mz);
    if (md > 1e-4) {
      mx /= md;
      mz /= md;
    }
    const step = speed * dt;
    const beforeX = p.x;
    const beforeZ = p.z;
    p.x += mx * step;
    p.z += mz * step;
    if (this.queryColliders) this.resolveCollisions();

    // ---------- Stuck guard -------------------------------------------------
    // Grinding a corner for >1.5s? Snap to the current cell center (always
    // wall-free) and force a fresh plan. The bot can never wedge permanently.
    const moved = Math.hypot(p.x - beforeX, p.z - beforeZ);
    if (this.nav && step > 1e-4 && moved < step * 0.25) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.5) {
        this.stuckTimer = 0;
        const center = this.nav.cellCenter(this.nav.worldToCell(p.x, p.z));
        p.x = center.x;
        p.z = center.z;
        this.depenetrate();
        this.path = [];
        this.pathIdx = 0;
        this.replanTimer = 0;
      }
    } else {
      this.stuckTimer = 0;
    }

    // ---------- "Alive" idle animation of the static image -----------------
    const t = this.huntTime;
    p.y = this.baseY + Math.sin(t * 2.6) * 0.06;
    this.sprite.scale.set(
      BOT.HEIGHT * this.aspect * (1 + Math.sin(t * 9) * 0.012),
      BOT.HEIGHT * (1 + Math.sin(t * 9) * 0.012),
      1
    );
    this.sprite.material.rotation = Math.sin(t * 11) * 0.015;

    // ---------- Caught? (needs line of sight — never through a wall) -------
    return dist < BOT.CATCH_RADIUS && hasLOS;
  }

  // ===========================================================================
  //  Collision helpers (same math as the player controller, minus velocity)
  // ===========================================================================

  /**
   * Circle-vs-AABB resolution: push the bot out of every nearby wall box.
   * Running it twice handles inner corners; sliding emerges naturally because
   * only the into-wall component of the movement gets cancelled each frame.
   */
  private resolveCollisions(): void {
    const p = this.sprite.position;
    const r = BOT.RADIUS;
    for (let iter = 0; iter < 2; iter++) {
      const boxes = this.queryColliders!(p.x, p.z);
      for (const b of boxes) {
        const cx = clamp(p.x, b.minX, b.maxX);
        const cz = clamp(p.z, b.minZ, b.maxZ);
        let dx = p.x - cx;
        let dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;

        if (d2 < 1e-9) {
          // Dead-center inside the box — push out along the shallowest axis.
          const pushL = p.x - b.minX,
            pushR = b.maxX - p.x,
            pushU = p.z - b.minZ,
            pushD = b.maxZ - p.z;
          const m = Math.min(pushL, pushR, pushU, pushD);
          if (m === pushL) p.x = b.minX - r;
          else if (m === pushR) p.x = b.maxX + r;
          else if (m === pushU) p.z = b.minZ - r;
          else p.z = b.maxZ + r;
          continue;
        }

        const d = Math.sqrt(d2);
        dx /= d;
        dz /= d;
        const push = r - d;
        p.x += dx * push;
        p.z += dz * push;
      }
    }
  }

  /** Push the bot fully out of any wall it overlaps (used after teleports). */
  private depenetrate(): void {
    if (!this.queryColliders) return;
    const p = this.sprite.position;
    const r = BOT.RADIUS;
    for (let iter = 0; iter < 4; iter++) {
      const boxes = this.queryColliders(p.x, p.z);
      let hit = false;
      for (const b of boxes) {
        const cx = clamp(p.x, b.minX, b.maxX);
        const cz = clamp(p.z, b.minZ, b.maxZ);
        const dx = p.x - cx;
        const dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        hit = true;
        if (d2 < 1e-9) {
          const pushL = p.x - b.minX,
            pushR = b.maxX - p.x,
            pushU = p.z - b.minZ,
            pushD = b.maxZ - p.z;
          const m = Math.min(pushL, pushR, pushU, pushD);
          if (m === pushL) p.x = b.minX - r;
          else if (m === pushR) p.x = b.maxX + r;
          else if (m === pushU) p.z = b.minZ - r;
          else p.z = b.maxZ + r;
        } else {
          const d = Math.sqrt(d2);
          p.x += (dx / d) * (r - d);
          p.z += (dz / d) * (r - d);
        }
      }
      if (!hit) break; // fully clear
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.sprite);
    this.sprite.material.dispose();
  }
}

/** Load + cache a monster texture, one per level
 *  (public/textures/monster.png, monster2.png, ...). */
const monsterTexCache = new Map<string, THREE.Texture>();
export async function loadMonsterTexture(url: string): Promise<THREE.Texture> {
  const cached = monsterTexCache.get(url);
  if (cached) return cached;
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  monsterTexCache.set(url, tex);
  return tex;
}

/** Dispose every cached monster texture (only on full engine teardown). */
export function disposeMonsterTextures(): void {
  for (const tex of monsterTexCache.values()) tex.dispose();
  monsterTexCache.clear();
}
