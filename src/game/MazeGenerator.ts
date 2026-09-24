/**
 * ============================================================================
 *  MazeGenerator.ts — Procedural "Backrooms Level 0" layout generator.
 * ============================================================================
 *  The Backrooms is NOT a classic perfect maze — it is an open-plan office
 *  labyrinth: long partition walls, random doorways, lonely pillars and
 *  wide looping corridors. We mimic that by:
 *
 *    1. Starting from an EMPTY open floor (no internal walls at all).
 *    2. Stamping random straight WALL RUNS (2-7 cells long) on the grid.
 *    3. Punching random DOORWAY GAPS into walls.
 *    4. Sprinkling square PILLARS into fully open intersections.
 *    5. Running a BFS connectivity pass that carves walls until every
 *       cell is reachable from the spawn point (no sealed rooms).
 *
 *  Walls live on the EDGES between cells, so corridors are full 4m wide
 *  and the walls themselves stay thin (0.42m) like real drywall partitions.
 * ============================================================================
 */

import { WORLD, BOT } from './constants';
import { clamp, mulberry32, randInt } from './utils';

export interface Cell {
  x: number;
  z: number;
}

export interface MazeData {
  /** Cells per side. */
  N: number;
  /**
   * hWall[z][x] — wall on the NORTH edge of cell (x, z).
   * z ranges 0..N (rows 0 and N are the outer border), x ranges 0..N-1.
   */
  hWall: boolean[][];
  /**
   * vWall[z][x] — wall on the WEST edge of cell (x, z).
   * x ranges 0..N (cols 0 and N are the outer border), z ranges 0..N-1.
   */
  vWall: boolean[][];
  /** Pillars: cells containing a square column at their center. */
  pillars: Cell[];
  /** Where the player spawns (map center area). */
  spawnCell: Cell;
  /**
   * Bot spawn FALLBACK cell (farthest reachable cell from the player's
   * spawn). The engine normally spawns the bot NEAR the player's CURRENT
   * position instead — see pickBotSpawnNear().
   */
  botSpawnCell: Cell;
  /** World-space center of a cell. */
  cellToWorld: (c: Cell) => { x: number; z: number };
  /** Cell containing a world-space point. */
  worldToCell: (x: number, z: number) => Cell;
}

export function generateMaze(seed: number): MazeData {
  const N = WORLD.GRID_CELLS;
  const M = WORLD.MAZE;
  const rng = mulberry32(seed);

  // ---- 1. Empty floor, solid outer border ---------------------------------
  const hWall: boolean[][] = Array.from({ length: N + 1 }, () => Array<boolean>(N).fill(false));
  const vWall: boolean[][] = Array.from({ length: N }, () => Array<boolean>(N + 1).fill(false));
  for (let x = 0; x < N; x++) {
    hWall[0][x] = true; // north border
    hWall[N][x] = true; // south border
  }
  for (let z = 0; z < N; z++) {
    vWall[z][0] = true; // west border
    vWall[z][N] = true; // east border
  }

  // ---- 2. Stamp random wall runs ------------------------------------------
  const segments = Math.round(N * N * M.SEGMENTS_PER_CELL);
  for (let s = 0; s < segments; s++) {
    const len = randInt(rng, M.SEGMENT_MIN, M.SEGMENT_MAX);
    if (rng() < 0.5) {
      // Horizontal run along an internal wall ROW.
      const z = randInt(rng, 1, N - 1);
      const x0 = randInt(rng, 0, N - 1);
      for (let i = 0; i < len; i++) {
        const x = x0 + i;
        if (x < N) hWall[z][x] = true;
      }
    } else {
      // Vertical run along an internal wall COLUMN.
      const x = randInt(rng, 1, N - 1);
      const z0 = randInt(rng, 0, N - 1);
      for (let i = 0; i < len; i++) {
        const z = z0 + i;
        if (z < N) vWall[z][x] = true;
      }
    }
  }

  // ---- 3. Random doorways ---------------------------------------------------
  for (let z = 1; z < N; z++)
    for (let x = 0; x < N; x++) if (hWall[z][x] && rng() < M.DOORWAY_CHANCE) hWall[z][x] = false;
  for (let z = 0; z < N; z++)
    for (let x = 1; x < N; x++) if (vWall[z][x] && rng() < M.DOORWAY_CHANCE) vWall[z][x] = false;

  // ---- 4. Pillars at open intersections ------------------------------------
  const pillars: Cell[] = [];
  const half = N >> 1;
  const spawnCell: Cell = { x: half, z: half };
  for (let z = 1; z < N - 1; z++) {
    for (let x = 1; x < N - 1; x++) {
      const openOnAllSides =
        !hWall[z][x] && !hWall[z + 1][x] && !vWall[z][x] && !vWall[z][x + 1];
      // Keep the spawn neighborhood pillar-free.
      const nearSpawn = Math.abs(x - spawnCell.x) <= 1 && Math.abs(z - spawnCell.z) <= 1;
      if (openOnAllSides && !nearSpawn && rng() < M.PILLAR_CHANCE) {
        pillars.push({ x, z });
      }
    }
  }

  // ---- 5. Connectivity repair (BFS) ----------------------------------------
  const cellToWorld = (c: Cell) => ({
    x: (c.x + 0.5) * WORLD.CELL - (N * WORLD.CELL) / 2,
    z: (c.z + 0.5) * WORLD.CELL - (N * WORLD.CELL) / 2,
  });
  const worldToCell = (x: number, z: number): Cell => ({
    x: clamp(Math.floor((x + (N * WORLD.CELL) / 2) / WORLD.CELL), 0, N - 1),
    z: clamp(Math.floor((z + (N * WORLD.CELL) / 2) / WORLD.CELL), 0, N - 1),
  });

  // Carve walls until every cell is reachable from spawn.
  for (;;) {
    const dist = bfsDistances(N, hWall, vWall, spawnCell);
    // Collect edges that separate a reached cell from an unreached one.
    const frontier: Array<() => void> = [];
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        if (dist[z][x] !== Infinity) continue;
        if (dist[z - 1]?.[x] !== undefined && dist[z - 1][x] !== Infinity)
          frontier.push(() => (hWall[z][x] = false));
        if (dist[z + 1]?.[x] !== undefined && dist[z + 1][x] !== Infinity)
          frontier.push(() => (hWall[z + 1][x] = false));
        if (dist[z][x - 1] !== undefined && dist[z][x - 1] !== Infinity)
          frontier.push(() => (vWall[z][x] = false));
        if (dist[z][x + 1] !== undefined && dist[z][x + 1] !== Infinity)
          frontier.push(() => (vWall[z][x + 1] = false));
      }
    }
    if (frontier.length === 0) break; // fully connected
    frontier[Math.floor(rng() * frontier.length)](); // open one random edge
  }

  // ---- 6. Bot spawn fallback cell (farthest reachable) ----------------------
  // The engine normally picks a NEAR cell at spawn time (pickBotSpawnNear);
  // this farthest cell is only the last-resort fallback.
  const dist = bfsDistances(N, hWall, vWall, spawnCell);
  let botSpawnCell: Cell = { x: 0, z: 0 };
  let best = -1;
  for (let z = 0; z < N; z++)
    for (let x = 0; x < N; x++)
      if (dist[z][x] < Infinity && dist[z][x] > best) {
        best = dist[z][x];
        botSpawnCell = { x, z };
      }

  return { N, hWall, vWall, pillars, spawnCell, botSpawnCell, cellToWorld, worldToCell };
}

/** BFS flood-fill: path distance (in cells) from `start` to every cell.
 *  Sealed cells stay at Infinity (can't happen after the repair pass). */
function bfsDistances(N: number, hWall: boolean[][], vWall: boolean[][], start: Cell): number[][] {
  const dist: number[][] = Array.from({ length: N }, () => Array<number>(N).fill(Infinity));
  const queue: Cell[] = [start];
  dist[start.z][start.x] = 0;
  while (queue.length) {
    const c = queue.shift()!;
    const d = dist[c.z][c.x];
    // north / south / west / east, if the shared edge is open.
    if (!hWall[c.z][c.x] && dist[c.z - 1]?.[c.x] === Infinity) {
      dist[c.z - 1][c.x] = d + 1;
      queue.push({ x: c.x, z: c.z - 1 });
    }
    if (!hWall[c.z + 1][c.x] && dist[c.z + 1]?.[c.x] === Infinity) {
      dist[c.z + 1][c.x] = d + 1;
      queue.push({ x: c.x, z: c.z + 1 });
    }
    if (!vWall[c.z][c.x] && dist[c.z][c.x - 1] === Infinity) {
      dist[c.z][c.x - 1] = d + 1;
      queue.push({ x: c.x - 1, z: c.z });
    }
    if (!vWall[c.z][c.x + 1] && dist[c.z][c.x + 1] === Infinity) {
      dist[c.z][c.x + 1] = d + 1;
      queue.push({ x: c.x + 1, z: c.z });
    }
  }
  return dist;
}

/**
 * Pick the bot's spawn cell a SHORT path-distance from `from` (the
 * player's cell at spawn time), so the hunt starts within seconds instead
 * of after a cross-map march (BOT.SPAWN_DIST_MIN..MAX in meters). Prefers
 * non-pillar cells; falls back to the farthest reachable cell when the
 * map is too cramped to offer a candidate.
 */
export function pickBotSpawnNear(maze: MazeData, from: Cell): Cell {
  const { N, hWall, vWall, pillars } = maze;
  const dist = bfsDistances(N, hWall, vWall, from);
  const minC = Math.max(1, Math.ceil(BOT.SPAWN_DIST_MIN / WORLD.CELL));
  const maxC = Math.max(minC, Math.ceil(BOT.SPAWN_DIST_MAX / WORLD.CELL));
  const isPillar = (x: number, z: number) => pillars.some((p) => p.x === x && p.z === z);

  const candidates: Cell[] = [];
  let farthest: Cell = from;
  let best = -1;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const d = dist[z][x];
      if (!Number.isFinite(d)) continue;
      if (d > best) {
        best = d;
        farthest = { x, z };
      }
      if (d >= minC && d <= maxC && !isPillar(x, z)) candidates.push({ x, z });
    }
  }
  if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];
  return farthest;
}
