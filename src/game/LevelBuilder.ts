/**
 * ============================================================================
 *  LevelBuilder.ts — Turns a MazeData layout into 3D geometry.
 * ============================================================================
 *  RESPONSIBILITIES
 *    • Builds the floor (procedural moist-carpet for Level 0, or the wall
 *      tile texture for the Poolrooms' glossy tiled floor)
 *    • Builds the ceiling (office tiles for Level 0, plain white for the
 *      Poolrooms)
 *    • Builds all walls as ONE merged mesh using the LEVEL's wallpaper
 *      texture, with UVs scaled per-face so the pattern density stays
 *      uniform no matter how long a wall run is.
 *    • Places light panels in the ceiling (some faulty/flickery).
 *    • Poolrooms levels get a shallow animated WATER plane over the floor.
 *    • Produces the AABB collision grid used by the player controller.
 *
 *  PERFORMANCE NOTES
 *    • All static walls merge into a single draw call (mergeGeometries).
 *    • Ceiling panels merge into one draw call; only the faulty panels
 *      stay as individual meshes so each can flicker independently.
 *    • Textures are generated once per LEVEL on a <canvas> and cached,
 *      so restarting a level costs nothing.
 * ============================================================================
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WORLD } from './constants';
import type { MazeData } from './MazeGenerator';
import { mulberry32 } from './utils';
import type { LevelDef } from './levels';

/** Axis-aligned bounding box (walls are full-height, so Y is ignored). */
export interface AABB {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface LightPanel {
  x: number;
  z: number;
  faulty: boolean;
  /** Material reference — only faulty panels have their own material. */
  material?: THREE.MeshBasicMaterial;
  phase: number;
}

export interface LevelBuild {
  group: THREE.Group;
  /** Returns all wall AABBs near a world position (spatial hash query). */
  queryColliders: (x: number, z: number) => AABB[];
  panels: LightPanel[];
  /** Shallow animated water plane (Poolrooms) — null on dry levels. */
  water: { mesh: THREE.Mesh; texture: THREE.Texture } | null;
  dispose: () => void;
}

/** ----------------------------------------------------------------------------
 *  Procedural textures — carpet, ceiling & water drawn on a canvas.
 * -------------------------------------------------------------------------- */
function makeCarpetTexture(): THREE.CanvasTexture {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;

  // Dull, moist yellow-brown carpet base.
  ctx.fillStyle = '#8a7b4e';
  ctx.fillRect(0, 0, S, S);

  // Fine fiber speckle (uncorrelated noise tiles perfectly).
  for (let i = 0; i < 26000; i++) {
    const v = Math.random() * 0.24 - 0.12;
    ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 250 : 0},${v > 0 ? 200 : 0},${Math.abs(v)})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1.4, 1.4);
  }

  // Dark moisture stains (kept away from edges so the texture still tiles).
  for (let i = 0; i < 7; i++) {
    const r = 36 + Math.random() * 70;
    const cx = r + Math.random() * (S - 2 * r);
    const cy = r + Math.random() * (S - 2 * r);
    const g = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
    g.addColorStop(0, 'rgba(58, 48, 22, 0.28)');
    g.addColorStop(1, 'rgba(58, 48, 22, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeCeilingTexture(): THREE.CanvasTexture {
  const S = 512; // represents 2x2 acoustic tiles => one tile = 128px = 0.6m
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;

  ctx.fillStyle = '#d8d1b8';
  ctx.fillRect(0, 0, S, S);

  // Per-tile brightness variation + speckle (acoustic texture).
  for (let tz = 0; tz < 2; tz++) {
    for (let tx = 0; tx < 2; tx++) {
      const shade = 0.92 + Math.random() * 0.1;
      ctx.fillStyle = `rgba(255,244,205,${(shade - 1) * 1.6})`;
      ctx.fillRect(tx * 256, tz * 256, 256, 256);
      for (let i = 0; i < 3000; i++) {
        ctx.fillStyle = 'rgba(90,80,55,0.10)';
        ctx.fillRect(tx * 256 + Math.random() * 256, tz * 256 + Math.random() * 256, 1.5, 1.5);
      }
    }
  }

  // Tile grooves (drawn at 0 / 256 / 512 so the pattern tiles seamlessly).
  ctx.strokeStyle = '#5a5340';
  ctx.lineWidth = 7;
  for (const p of [0, 256, 512]) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(S, p);
    ctx.stroke();
  }

  // Water stains near random grooves.
  for (let i = 0; i < 5; i++) {
    const cx = Math.random() * S;
    const cy = Math.random() * S;
    const r = 24 + Math.random() * 46;
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, r);
    g.addColorStop(0, 'rgba(120, 90, 40, 0.22)');
    g.addColorStop(1, 'rgba(120, 90, 40, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Plain white ceiling for the Poolrooms — soft, bright, almost skylit. */
function makePlainCeilingTexture(): THREE.CanvasTexture {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;

  ctx.fillStyle = '#eef6f7';
  ctx.fillRect(0, 0, S, S);

  // Very subtle cool speckle so it never reads as flat RGB white.
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = 'rgba(160,190,196,0.06)';
    ctx.fillRect(Math.random() * S, Math.random() * S, 2, 2);
  }
  // Faint wide panel grooves (real poolrooms have big ceiling panels).
  ctx.strokeStyle = 'rgba(140,170,176,0.35)';
  ctx.lineWidth = 3;
  for (const p of [0, 256, 512]) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(S, p);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** ----------------------------------------------------------------------------
 *  Animated caustics texture for the Poolrooms water plane (light ripples).
 * -------------------------------------------------------------------------- */
function makeCausticsTexture(): THREE.CanvasTexture {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;

  // Transparent base — the water tint comes from the material color.
  ctx.clearRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  // Wavy bright ribbons = refracted sunlight lines.
  for (let i = 0; i < 26; i++) {
    ctx.beginPath();
    let x = Math.random() * S;
    let y = Math.random() * S;
    ctx.moveTo(x, y);
    const segs = 6 + Math.floor(Math.random() * 5);
    for (let s = 0; s < segs; s++) {
      x += (Math.random() - 0.5) * 120;
      y += (Math.random() - 0.5) * 120;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.09})`;
    ctx.lineWidth = 3 + Math.random() * 10;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  // Soft glow blobs on top.
  for (let i = 0; i < 18; i++) {
    const cx = Math.random() * S;
    const cy = Math.random() * S;
    const r = 18 + Math.random() * 42;
    const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** ----------------------------------------------------------------------------
 *  Texture bundle — loaded/generated once per LEVEL, cached for the session.
 * -------------------------------------------------------------------------- */
export interface TextureBundle {
  wallpaper: THREE.Texture;
  carpet: THREE.Texture;
  ceiling: THREE.Texture;
}

const textureCache = new Map<string, TextureBundle>();

export async function loadTextures(def: LevelDef): Promise<TextureBundle> {
  const cached = textureCache.get(def.id);
  if (cached) return cached;
  const loader = new THREE.TextureLoader();

  // The level's wall texture (public/textures/...).
  const wallpaper = await loader.loadAsync(def.wallpaper);
  wallpaper.colorSpace = THREE.SRGBColorSpace;
  wallpaper.wrapS = wallpaper.wrapT = THREE.RepeatWrapping;
  wallpaper.anisotropy = 8;

  // Floor texture: moist carpet for Level 0; the tile texture itself for
  // the Poolrooms (walls and floor share the same tiling, at different
  // scales — the floor uses texture.repeat, the walls use scaled UVs, so
  // one THREE.Texture instance safely serves both).
  const carpet =
    def.palette.floorStyle === 'tile'
      ? wallpaper
      : makeCarpetTexture();
  carpet.wrapS = carpet.wrapT = THREE.RepeatWrapping;
  carpet.anisotropy = 8;

  const ceiling =
    def.palette.ceilingStyle === 'plain' ? makePlainCeilingTexture() : makeCeilingTexture();
  ceiling.wrapS = ceiling.wrapT = THREE.RepeatWrapping;
  ceiling.anisotropy = 8;

  const bundle: TextureBundle = { wallpaper, carpet, ceiling };
  textureCache.set(def.id, bundle);
  return bundle;
}

/** Dispose every cached level texture (only on full engine teardown). */
export function disposeTextures(): void {
  for (const bundle of textureCache.values()) {
    Object.values(bundle).forEach((t) => t.dispose());
  }
  textureCache.clear();
}

/** ----------------------------------------------------------------------------
 *  UV helper — scale a BoxGeometry's UVs so the wallpaper keeps a constant
 *  world-space density on every face (u repeats every texW meters, v maps
 *  once across the wall height so any horizontal banding stays intact).
 * -------------------------------------------------------------------------- */
function scaleBoxUVs(geo: THREE.BoxGeometry, w: number, h: number, d: number, texW: number, texH: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  // three.js BoxGeometry vertex order: +x, -x, +y, -y, +z, -z (4 verts each).
  const faceScales: Array<[number, number]> = [
    [d, h], // +x : u follows depth, v follows height
    [d, h], // -x
    [w, d], // +y : roof of the wall (barely visible)
    [w, d], // -y
    [w, h], // +z : the faces you actually see
    [w, h], // -z
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = faceScales[f];
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, (uv.getX(idx) * su) / texW, (uv.getY(idx) * sv) / texH);
    }
  }
  uv.needsUpdate = true;
}

/** ----------------------------------------------------------------------------
 *  Spatial hash — buckets AABBs into CELL-sized grid cells so the player
 *  controller only tests the handful of walls immediately around it.
 * -------------------------------------------------------------------------- */
class ColliderGrid {
  private buckets = new Map<string, AABB[]>();

  insert(box: AABB): void {
    const { CELL } = WORLD;
    const N = this.worldSize / CELL;
    const gx0 = Math.max(0, Math.floor((box.minX + this.worldSize / 2) / CELL));
    const gx1 = Math.min(N - 1, Math.floor((box.maxX + this.worldSize / 2) / CELL));
    const gz0 = Math.max(0, Math.floor((box.minZ + this.worldSize / 2) / CELL));
    const gz1 = Math.min(N - 1, Math.floor((box.maxZ + this.worldSize / 2) / CELL));
    for (let gz = gz0; gz <= gz1; gz++)
      for (let gx = gx0; gx <= gx1; gx++) {
        const key = `${gx},${gz}`;
        const arr = this.buckets.get(key) ?? [];
        arr.push(box);
        this.buckets.set(key, arr);
      }
  }

  constructor(private worldSize: number) {}

  query(x: number, z: number): AABB[] {
    const { CELL } = WORLD;
    const gx = Math.floor((x + this.worldSize / 2) / CELL);
    const gz = Math.floor((z + this.worldSize / 2) / CELL);
    const out: AABB[] = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.buckets.get(`${gx + dx},${gz + dz}`);
        if (arr) out.push(...arr);
      }
    return out;
  }
}

/** ----------------------------------------------------------------------------
 *  buildLevel — the main entry point.
 * -------------------------------------------------------------------------- */
export function buildLevel(
  scene: THREE.Scene,
  maze: MazeData,
  textures: TextureBundle,
  def: LevelDef
): LevelBuild {
  const { CELL, WALL_H, WALL_T, GRID_CELLS: N } = WORLD;
  const W = N * CELL; // world size in meters
  const group = new THREE.Group();
  scene.add(group);

  const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  // ===== FLOOR ==============================================================
  {
    const geo = new THREE.PlaneGeometry(W, W);
    geo.rotateX(-Math.PI / 2);
    textures.carpet.repeat.set(W / def.palette.floorRepeatMeters, W / def.palette.floorRepeatMeters);
    // Carpet is dead matte; wet pool tiles carry a sheen.
    const mat = new THREE.MeshStandardMaterial({
      map: textures.carpet,
      roughness: def.palette.floorStyle === 'tile' ? 0.32 : 1,
      metalness: def.palette.floorStyle === 'tile' ? 0.06 : 0,
    });
    group.add(new THREE.Mesh(geo, mat));
    disposables.push(geo, mat);
  }

  // ===== CEILING ===========================================================
  {
    const geo = new THREE.PlaneGeometry(W, W);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, WALL_H, 0);
    textures.ceiling.repeat.set(W / 2.4, W / 2.4); // 2x2 tiles per 2.4m
    const mat = new THREE.MeshStandardMaterial({ map: textures.ceiling, roughness: 0.95 });
    group.add(new THREE.Mesh(geo, mat));
    disposables.push(geo, mat);
  }
  // ===== WALLS (merged into a single mesh) =================================
  const colliders = new ColliderGrid(W);
  {
    const boxes: THREE.BoxGeometry[] = [];
    const T = WALL_T;

    /** Emit one wall box; also registers its collider. */
    const addBox = (cx: number, cz: number, w: number, h: number, d: number) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      scaleBoxUVs(geo, w, h, d, def.palette.wallTextureW, WALL_H);
      geo.translate(cx, WALL_H / 2, cz);
      boxes.push(geo);
      colliders.insert({
        minX: cx - w / 2,
        maxX: cx + w / 2,
        minZ: cz - d / 2,
        maxZ: cz + d / 2,
      });
    };

    // Merge consecutive horizontal wall edges into long boxes (fewer
    // polygons + seamless wallpaper across the whole run).
    for (let z = 0; z <= N; z++) {
      let x = 0;
      while (x < N) {
        if (!maze.hWall[z]?.[x]) {
          x++;
          continue;
        }
        let x1 = x;
        while (x1 + 1 < N && maze.hWall[z][x1 + 1]) x1++;
        const len = (x1 - x + 1) * CELL + T; // +T overlaps corners
        const cx = ((x + x1 + 1) / 2) * CELL - W / 2;
        const cz = z * CELL - W / 2;
        addBox(cx, cz, len, WALL_H, T);
        x = x1 + 1;
      }
    }

    // Same for vertical wall runs.
    for (let x = 0; x <= N; x++) {
      let z = 0;
      while (z < N) {
        if (!maze.vWall[z]?.[x]) {
          z++;
          continue;
        }
        let z1 = z;
        while (z1 + 1 < N && maze.vWall[z1 + 1][x]) z1++;
        const len = (z1 - z + 1) * CELL + T;
        const cx = x * CELL - W / 2;
        const cz = ((z + z1 + 1) / 2) * CELL - W / 2;
        addBox(cx, cz, T, WALL_H, len);
        z = z1 + 1;
      }
    }

    // Square pillars at open intersections — sized from constants so they
    // scale with the hall width (chunky columns in the wide open plan).
    for (const p of maze.pillars) {
      const { x: cx, z: cz } = maze.cellToWorld(p);
      addBox(cx, cz, WORLD.PILLAR_SIZE, WALL_H, WORLD.PILLAR_SIZE);
    }

    const merged = mergeGeometries(boxes)!;
    boxes.forEach((b) => b.dispose());
    const mat = new THREE.MeshStandardMaterial({
      map: textures.wallpaper,
      roughness: def.palette.wallRoughness,
    });
    group.add(new THREE.Mesh(merged, mat));
    disposables.push(merged, mat);
  }

  // ===== LIGHT PANELS =====================================================
  const panels: LightPanel[] = [];
  const steadyGeos: THREE.PlaneGeometry[] = [];
  {
    const PANEL_W = 2.0;
    const PANEL_D = 1.0;
    const rng = mulberry32(seedFromMaze(maze));
    const panelColor = def.palette.lightColor;

    // Panel grid spacing is defined in METERS (not cells) so the ceiling
    // stays evenly lit no matter how wide the halls are: with 6m cells this
    // places a light panel every cell (~6m), like a real building floor.
    const PANEL_STEP = Math.max(1, Math.round(7 / CELL));

    for (let cz = 0; cz < N; cz += PANEL_STEP) {
      for (let cx = 0; cx < N; cx += PANEL_STEP) {
        if (rng() < 0.22) continue; // randomly missing panels
        const { x, z } = maze.cellToWorld({ x: cx, z: cz });
        const rotate = ((cx + cz) / 2) % 2 === 0;
        const geo = new THREE.PlaneGeometry(
          rotate ? PANEL_W : PANEL_D,
          rotate ? PANEL_D : PANEL_W
        );
        geo.rotateX(Math.PI / 2); // face down
        geo.translate(x, WALL_H - 0.03, z);

        const faulty = rng() < def.palette.flickerRatio;
        if (faulty) {
          // Individual mesh + material so it can flicker on its own.
          const mat = new THREE.MeshBasicMaterial({ color: panelColor, fog: true });
          group.add(new THREE.Mesh(geo, mat));
          disposables.push(geo, mat);
          panels.push({ x, z, faulty: true, material: mat, phase: rng() * 10 });
        } else {
          steadyGeos.push(geo);
          panels.push({ x, z, faulty: false, phase: 0 });
        }
      }
    }

    if (steadyGeos.length) {
      const merged = mergeGeometries(steadyGeos)!;
      steadyGeos.forEach((g) => g.dispose());
      const mat = new THREE.MeshBasicMaterial({ color: panelColor, fog: true });
      group.add(new THREE.Mesh(merged, mat));
      disposables.push(merged, mat);
    }
  }

  // ===== SHALLOW WATER (Poolrooms) ========================================
  let water: LevelBuild['water'] = null;
  if (def.palette.water) {
    const geo = new THREE.PlaneGeometry(W, W);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0.05, 0); // a few centimeters over the tiles
    const caustics = makeCausticsTexture();
    caustics.repeat.set(W / 3, W / 3);
    const mat = new THREE.MeshStandardMaterial({
      color: def.palette.water.color,
      map: caustics,
      transparent: true,
      opacity: def.palette.water.opacity,
      roughness: 0.12,
      metalness: 0.1,
      depthWrite: false, // never fight the floor for z-order
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1; // draw after the floor, before the monster sprite
    group.add(mesh);
    disposables.push(geo, mat);
    water = { mesh, texture: caustics };
  }

  return {
    group,
    queryColliders: (x, z) => colliders.query(x, z),
    panels,
    water,
    dispose: () => {
      scene.remove(group);
      disposables.forEach((d) => d.dispose());
      if (water) water.texture.dispose();
    },
  };
}

/** Deterministic per-maze seed for panel placement. */
function seedFromMaze(maze: MazeData): number {
  return maze.pillars.length * 7919 + maze.spawnCell.x * 31 + maze.botSpawnCell.z;
}
