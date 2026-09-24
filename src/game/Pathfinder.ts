/**
 * ============================================================================
 *  Pathfinder.ts — Grid navigation for the Nextbot (wall-collision mode).
 * ============================================================================
 *  The bot used to phase straight through walls, which made escaping
 *  impossible. It now obeys walls, so it needs to FIND the player:
 *
 *    • findPath()    — A* over the maze's wall grid (walls live on cell
 *                      edges, exactly like MazeGenerator writes them).
 *                      Pillar cells are treated as obstacles; if a route
 *                      still exists with pillars allowed, we use it as a
 *                      fallback so the bot can never hard-fail.
 *                      The raw cell path is then SMOOTHED with string-
 *                      pulling, so the bot walks natural diagonal lines
 *                      across open halls instead of a staircase.
 *
 *    • lineOfSight() — exact segment-vs-walls test using grid traversal
 *                      (Amanatides & Woo). The bot charges STRAIGHT at the
 *                      player whenever it can see them, and only falls back
 *                      to path-following around walls when it cannot.
 *
 *  The grid is tiny (25x25 = 625 cells) so A* with a linear-scan open list
 *  is more than fast enough at 2-3 replans per second.
 * ============================================================================
 */

import { WORLD } from './constants';
import type { MazeData } from './MazeGenerator';

export interface Waypoint {
  x: number;
  z: number;
}

interface Cell {
  x: number;
  z: number;
}

export class Pathfinder {
  private readonly N: number;
  /** Pillar cells — obstacles for pathing (with fallback) and sight. */
  private readonly blocked: boolean[][];

  constructor(private readonly maze: MazeData) {
    this.N = maze.N;
    this.blocked = Array.from({ length: this.N }, () => Array<boolean>(this.N).fill(false));
    for (const p of maze.pillars) this.blocked[p.z][p.x] = true;
  }

  /** World position -> containing cell (clamped to the map). */
  worldToCell(x: number, z: number): Cell {
    const half = (this.N * WORLD.CELL) / 2;
    return {
      x: Math.min(this.N - 1, Math.max(0, Math.floor((x + half) / WORLD.CELL))),
      z: Math.min(this.N - 1, Math.max(0, Math.floor((z + half) / WORLD.CELL))),
    };
  }

  /** Cell -> world-space center of that cell. */
  cellCenter(c: Cell): Waypoint {
    return this.maze.cellToWorld(c);
  }

  /**
   * A* route from world position (fx,fz) to (tx,tz).
   * Returns smoothed world-space waypoints (the first cell AFTER the start
   * cell through the goal cell). Empty array = no route found.
   */
  findPath(fx: number, fz: number, tx: number, tz: number): Waypoint[] {
    const s = this.worldToCell(fx, fz);
    const g = this.worldToCell(tx, tz);

    // Same cell => no wall can be between us; steer straight at the player.
    if (s.x === g.x && s.z === g.z) return [{ x: tx, z: tz }];

    const cells = this.astar(s, g, false) ?? this.astar(s, g, true);
    if (!cells) return []; // unreachable (should be impossible: BFS repair)

    const pts = cells.map((c) => this.cellCenter(c));
    return this.smooth(pts, fx, fz);
  }

  /**
   * True when the straight segment (fx,fz) -> (tx,tz) crosses no wall edge
   * and passes through no pillar cell (both endpoint cells are exempt, so
   * standing NEXT to a pillar doesn't blind the bot).
   */
  lineOfSight(fx: number, fz: number, tx: number, tz: number): boolean {
    const half = (this.N * WORLD.CELL) / 2;
    const { hWall, vWall } = this.maze;

    // Work in fractional grid coordinates.
    const gx = (fx + half) / WORLD.CELL;
    const gz = (fz + half) / WORLD.CELL;
    const ex = (tx + half) / WORLD.CELL;
    const ez = (tz + half) / WORLD.CELL;

    let cx = Math.floor(gx);
    let cz = Math.floor(gz);
    const ecx = Math.floor(ex);
    const ecz = Math.floor(ez);

    const dx = ex - gx;
    const dz = ez - gz;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    // Ray parameters where we cross the next vertical / horizontal grid line.
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = stepX !== 0 ? (stepX > 0 ? cx + 1 - gx : gx - cx) * tDeltaX : Infinity;
    let tMaxZ = stepZ !== 0 ? (stepZ > 0 ? cz + 1 - gz : gz - cz) * tDeltaZ : Infinity;

    // Walk cell to cell until we reach the endpoint cell.
    let guard = this.N * 4;
    while ((cx !== ecx || cz !== ecz) && guard-- > 0) {
      if (tMaxX < tMaxZ) {
        // Cross the vertical edge between (cx,cz) and (cx+stepX,cz).
        const wallCol = stepX > 0 ? cx + 1 : cx;
        if (vWall[cz]?.[wallCol]) return false;
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        // Cross the horizontal edge between (cx,cz) and (cx,cz+stepZ).
        const wallRow = stepZ > 0 ? cz + 1 : cz;
        if (hWall[wallRow]?.[cx]) return false;
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
      // A pillar cell strictly between the endpoints breaks sight.
      if ((cx !== ecx || cz !== ecz) && this.blocked[cz]?.[cx]) return false;
    }
    return true;
  }

  // ===========================================================================
  //  Internals
  // ===========================================================================

  /** Classic A* over the 4-connected wall grid. `allowPillars` is the fallback. */
  private astar(s: Cell, g: Cell, allowPillars: boolean): Cell[] | null {
    const N = this.N;
    const { hWall, vWall } = this.maze;
    const size = N * N;
    const idx = (x: number, z: number) => z * N + x;

    const gScore = new Float32Array(size).fill(Infinity);
    const fScore = new Float32Array(size).fill(Infinity);
    const cameFrom = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);
    const open: number[] = [];

    const start = idx(s.x, s.z);
    const goal = idx(g.x, g.z);
    const heur = (x: number, z: number) => Math.abs(x - g.x) + Math.abs(z - g.z);

    gScore[start] = 0;
    fScore[start] = heur(s.x, s.z);
    open.push(start);

    /** Neighbor passable = in bounds, and not a pillar (goal cell exempt). */
    const passable = (x: number, z: number) => {
      if (x < 0 || z < 0 || x >= N || z >= N) return false;
      if (!allowPillars && this.blocked[z][x] && idx(x, z) !== goal) return false;
      return true;
    };

    while (open.length) {
      // Linear min-f scan — the grid is tiny, no heap needed.
      let best = 0;
      for (let i = 1; i < open.length; i++) if (fScore[open[i]] < fScore[open[best]]) best = i;
      const cur = open.splice(best, 1)[0];
      if (cur === goal) return this.reconstruct(cameFrom, goal);
      if (closed[cur]) continue;
      closed[cur] = 1;

      const cx = cur % N;
      const cz = (cur / N) | 0;

      // 4 neighbors; walls live on the shared EDGES (see MazeGenerator).
      const neighbors: Array<[number, number]> = [];
      if (!hWall[cz][cx] && cz > 0) neighbors.push([cx, cz - 1]); // north
      if (!hWall[cz + 1][cx] && cz < N - 1) neighbors.push([cx, cz + 1]); // south
      if (!vWall[cz][cx] && cx > 0) neighbors.push([cx - 1, cz]); // west
      if (!vWall[cz][cx + 1] && cx < N - 1) neighbors.push([cx + 1, cz]); // east

      for (const [nx, nz] of neighbors) {
        if (!passable(nx, nz)) continue;
        const ni = idx(nx, nz);
        if (closed[ni]) continue;
        const ng = gScore[cur] + 1;
        if (ng < gScore[ni]) {
          gScore[ni] = ng;
          fScore[ni] = ng + heur(nx, nz);
          cameFrom[ni] = cur;
          open.push(ni);
        }
      }
    }
    return null;
  }

  /** Walk `cameFrom` links back from the goal; drop the start cell. */
  private reconstruct(cameFrom: Int32Array, goal: number): Cell[] {
    const N = this.N;
    const out: Cell[] = [];
    let cur = goal;
    while (cur !== -1) {
      out.push({ x: cur % N, z: (cur / N) | 0 });
      cur = cameFrom[cur];
    }
    out.pop(); // remove the start cell
    out.reverse();
    return out;
  }

  /**
   * String-pulling smoother: keep only the waypoints needed so that every
   * consecutive pair has direct line of sight — the bot cuts natural
   * diagonals across open halls instead of hugging cell centers.
   */
  private smooth(pts: Waypoint[], fromX: number, fromZ: number): Waypoint[] {
    if (pts.length <= 1) return pts;
    const out: Waypoint[] = [];
    let ax = fromX;
    let az = fromZ;
    let i = 0;
    while (i < pts.length) {
      // Furthest waypoint still visible from the current anchor.
      let far = i;
      for (let j = pts.length - 1; j > i; j--) {
        if (this.lineOfSight(ax, az, pts[j].x, pts[j].z)) {
          far = j;
          break;
        }
      }
      out.push(pts[far]);
      ax = pts[far].x;
      az = pts[far].z;
      i = far + 1;
    }
    return out;
  }
}
