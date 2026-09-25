/**
 * ============================================================================
 *  GameEngine.ts — Orchestrator: owns the renderer, the game loop and all
 *  subsystems, and exposes a tiny imperative API to the React UI layer.
 * ============================================================================
 *  FLOW
 *    GameEngine.create(container)   async factory (loads ALL levels' assets)
 *    engine.beginPlay(levelId?)      menu -> playing (builds/resets the maze)
 *    engine.resume()                 paused -> playing (re-locks the pointer)
 *    engine.returnToMenu()           any -> menu (retires the horde, backdrop
 *                                      becomes the level you just played)
 *    engine.dispose()                full teardown
 *
 *  The engine talks back through callbacks:
 *    onDeath(survivedMs)  -> React shows the jumpscare + game-over card
 *    onBotSpawned()       -> React flashes the "RUN." warning (EVERY spawn)
 *    onMenu()             -> React returns to the main menu
 *    onPause()            -> React shows the pause overlay
 *    onFrame(st,prox,n)   -> HUD updates (stamina bar / danger vignette /
 *                            horde counter), throttled DOM writes via refs,
 *                            NOT React state
 * ============================================================================
 */

import * as THREE from 'three';
import { BOT, PLAYER, WORLD } from './constants';
import { clamp } from './utils';
import { generateMaze, pickBotSpawnNear, type MazeData } from './MazeGenerator';
import {
  buildLevel,
  loadTextures,
  disposeTextures,
  type LevelBuild,
  type TextureBundle,
} from './LevelBuilder';
import { LightPool } from './LightPool';
import { PlayerController } from './PlayerController';
import { Nextbot, loadMonsterTexture, disposeMonsterTextures } from './Nextbot';
import { AudioManager } from './AudioManager';
import { LEVELS, getLevel, DEFAULT_LEVEL_ID, type LevelDef } from './levels';

export type EnginePhase = 'menu' | 'playing' | 'paused' | 'dead';

export interface EngineCallbacks {
  onDeath: (survivedMs: number) => void;
  onBotSpawned: () => void;
  /** Engine returned to the menu (RETURN TO MENU button). */
  onMenu: () => void;
  onPause: () => void;
  /** Called every rendered frame while playing (use refs, not setState!). */
  onFrame: (stamina01: number, proximity01: number, botCount: number) => void;
}

export class GameEngine {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;

  private textures!: TextureBundle;
  private monsterTexture!: THREE.Texture;
  /** Every level's texture bundle, preloaded at init (keyed by level id). */
  private readonly texturesByLevel = new Map<string, TextureBundle>();
  /** Every level's monster sprite texture, preloaded at init. */
  private readonly monsterTextures = new Map<string, THREE.Texture>();
  /** The level currently built/being played. */
  private levelDef: LevelDef = getLevel(DEFAULT_LEVEL_ID);
  private maze!: MazeData;
  private level: LevelBuild | null = null;
  private lightPool!: LightPool;
  private player!: PlayerController;
  /**
   * THE HORDE: every natural spawn pushes another Nextbot here. The first
   * arrives after BOT.SPAWN_DELAY; from then on one more materializes every
   * BOT.SPAWN_INTERVAL seconds — there is NO CAP.
   */
  private bots: Nextbot[] = [];
  /** Game-time clock at which the next natural spawn fires. */
  private nextBotSpawnAt: number = BOT.SPAWN_DELAY;
  readonly audio = new AudioManager();

  private phase: EnginePhase = 'menu';
  private raf = 0;
  private lastTime = 0;
  private elapsedPlay = 0;
  private menuYaw = 0;
  /** Scratch vector for the per-frame camera direction (no per-frame GC). */
  private tmpDir = new THREE.Vector3();

  private constructor(
    private container: HTMLElement,
    private callbacks: EngineCallbacks
  ) {}

  /** The level that is currently built (menu backdrop or active hunt). */
  get currentLevel(): LevelDef {
    return this.levelDef;
  }

  /** Async factory — loads ALL levels' assets exactly once. */
  static async create(container: HTMLElement, callbacks: EngineCallbacks): Promise<GameEngine> {
    const engine = new GameEngine(container, callbacks);
    await engine.init();
    return engine;
  }

  private async init(): Promise<void> {
    // ---- Renderer ------------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setClearColor(this.levelDef.palette.fogColor);
    this.container.appendChild(this.renderer.domElement);

    // ---- Scene + camera --------------------------------------------------------
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(this.levelDef.palette.fogColor, this.levelDef.palette.fogDensity);
    this.camera = new THREE.PerspectiveCamera(PLAYER.FOV, 1, 0.1, 60);

    // Cheap global light bed so nothing is ever pitch black; the LightPool's
    // point lights do the actual "fixture" work on top of this. Colors are
    // per-level — buildRun() retints them every time a level is built.
    this.ambientLight = new THREE.AmbientLight(this.levelDef.palette.ambientColor, this.levelDef.palette.ambientIntensity);
    this.hemiLight = new THREE.HemisphereLight(
      this.levelDef.palette.hemiSky,
      this.levelDef.palette.hemiGround,
      this.levelDef.palette.hemiIntensity
    );
    this.scene.add(this.ambientLight, this.hemiLight);

    // ---- Assets (EVERY level, so switching levels is instant) ------------------
    await Promise.all(
      LEVELS.map(async (def) => {
        const [bundle, monster] = await Promise.all([
          loadTextures(def),
          loadMonsterTexture(def.monster),
        ]);
        this.texturesByLevel.set(def.id, bundle);
        this.monsterTextures.set(def.id, monster);
      })
    );
    this.textures = this.texturesByLevel.get(DEFAULT_LEVEL_ID)!;
    this.monsterTexture = this.monsterTextures.get(DEFAULT_LEVEL_ID)!;

    // ---- Subsystems -----------------------------------------------------------------
    this.lightPool = new LightPool(this.scene);
    this.player = new PlayerController(
      this.camera,
      this.renderer.domElement,
      (x, z) => this.level?.queryColliders(x, z) ?? [],
      { onFootstep: (running) => this.audio.footstep(running) }
    );
    this.player.connect();
    this.player.controls.addEventListener('unlock', this.onPointerUnlock);

    // ---- First maze (also serves as the animated menu backdrop) ---------------------
    this.buildRun();
    this.menuYaw = Math.random() * Math.PI * 2;

    // ---- Loop + resize -----------------------------------------------------------------
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.container);
    this.onResize();

    // ---- DEV HOOK -------------------------------------------------------------
    // Exposes the engine on window.__backrooms in dev builds only, so the
    // chase can be tested/tuned from the browser console, e.g.:
    //   __backrooms.debugForceSpawn()   // add one more bot right in front of you
    //   __backrooms.debugBotCount       // how many are hunting right now
    if (process.env.NODE_ENV === 'development') {
      (window as unknown as { __backrooms?: GameEngine }).__backrooms = this;
    }
  }

  private ro!: ResizeObserver;
  private ambientLight!: THREE.AmbientLight;
  private hemiLight!: THREE.HemisphereLight;

  // ===========================================================================
  //  Public API (called by React)
  // ===========================================================================

  /**
   * Menu "PLAY" (or death-screen "TRY AGAIN") — must be a user gesture.
   * Pass a level id to play that level; without one, the current level is
   * rebuilt (TRY AGAIN behavior).
   */
  beginPlay(levelId?: string): void {
    if (levelId) this.levelDef = getLevel(levelId);
    this.audio.init();
    this.audio.resume();
    this.buildRun(); // fresh maze every run
    this.phase = 'playing';
    this.player.controls.lock(); // if the browser refuses, we still play
  }

  /**
   * RETURN TO MENU (pause screen / death screen): retire the horde, rebuild
   * the current level as the animated menu backdrop, and hand control back
   * to the main menu UI.
   */
  returnToMenu(): void {
    if (this.phase === 'menu') return;
    // Set the phase BEFORE unlocking the pointer — onPointerUnlock only
    // triggers the pause overlay while phase === 'playing'.
    this.phase = 'menu';
    this.player.freeze();
    this.player.controls.unlock(); // releases the mouse for the menu
    this.audio.resume(); // keep the room beds murmuring under the menu
    this.buildRun();
    this.menuYaw = Math.random() * Math.PI * 2;
    this.callbacks.onMenu();
  }

  /**
   * Level-browser select (menu only): rebuild the chosen level as the
   * animated menu backdrop. Starting a run is still PLAY's job — this just
   * lets you SEE the level you picked before you dive in.
   */
  previewLevel(levelId: string): void {
    if (this.phase !== 'menu') return;
    if (this.levelDef.id === levelId) return;
    this.levelDef = getLevel(levelId);
    this.buildRun();
  }

  /** Pause overlay click — re-capture the pointer. */
  resume(): void {
    if (this.phase !== 'paused') return;
    this.player.controls.lock();
    // Optimistic resume; if the lock is denied, 'unlock' logic keeps us safe.
    this.phase = 'playing';
    this.audio.resume();
  }

  get currentPhase(): EnginePhase {
    return this.phase;
  }

  /**
   * DEV-ONLY: skip the grace period and spawn the bot `dist` meters in front
   * of the player. Used for testing the chase / catch / restart flow without
   * waiting BOT.SPAWN_DELAY seconds.
   */
  debugForceSpawn(dist = 10): void {
    if (this.phase !== 'playing') return;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const p = this.camera.position.clone().addScaledVector(dir, dist);
    this.addBot(p.x, p.z);
    this.consumeFirstSpawnSlot();
    this.callbacks.onBotSpawned();
  }

  /**
   * DEV-ONLY: run the REAL natural spawn logic right now (bot materializes
   * SPAWN_DIST_MIN..MAX meters from the player's current position) — same
   * code path the SPAWN_DELAY timer uses, so it can be tested without
   * waiting through the grace period.
   */
  debugNaturalSpawn(): void {
    if (this.phase !== 'playing') return;
    this.spawnBotNaturally();
    this.consumeFirstSpawnSlot();
  }

  /** NEAREST bot distance (Infinity while none hunt) — console tuning aid. */
  get debugBotDistance(): number {
    let d = Infinity;
    for (const b of this.bots) d = Math.min(d, b.distance);
    return d;
  }

  /** DEV: how many monsters are hunting right now. */
  get debugBotCount(): number {
    return this.bots.length;
  }

  /** DEV: NEAREST bot world position (null while none hunt). */
  get debugBotPos(): { x: number; z: number } | null {
    let best: Nextbot | null = null;
    for (const b of this.bots) if (!best || b.distance < best.distance) best = b;
    if (!best) return null;
    const p = best.sprite.position;
    return { x: p.x, z: p.z };
  }

  /** DEV: is ANY bot currently overlapping a wall collider? (should stay false) */
  get debugBotPenetrating(): boolean {
    const r = BOT.RADIUS;
    for (const bot of this.bots) {
      const p = bot.sprite.position;
      const boxes = this.level?.queryColliders(p.x, p.z) ?? [];
      if (
        boxes.some((b) => {
          const cx = clamp(p.x, b.minX, b.maxX);
          const cz = clamp(p.z, b.minZ, b.maxZ);
          return (p.x - cx) ** 2 + (p.z - cz) ** 2 < r * r;
        })
      ) {
        return true;
      }
    }
    return false;
  }

  /** DEV: monster-voice snapshot (doppler verification without ears). */
  get debugAudio(): {
    fileLoaded: boolean;
    active: boolean;
    gain: number;
    pan: number;
    rate: number;
    trim: number;
    loopStart: number;
    loopEnd: number;
  } {
    return this.audio.debugMonster;
  }

  /** DEV: which level is currently built. */
  get debugLevelId(): string {
    return this.levelDef.id;
  }

  /** DEV: mixer snapshot (master / sounds / music bus gains). */
  get debugVolumes(): AudioManager['debugVolumes'] {
    return this.audio.debugVolumes;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.player?.controls.removeEventListener('unlock', this.onPointerUnlock);
    this.player?.disconnect();
    this.level?.dispose();
    this.lightPool?.dispose();
    for (const b of this.bots) b.dispose(this.scene);
    this.bots = [];
    this.audio.dispose();
    disposeTextures();
    disposeMonsterTextures();
    this.renderer?.dispose();
    if (this.renderer?.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  // ===========================================================================
  //  Internals
  // ===========================================================================

  /**
   * Generate a new maze + level and reset player/horde/timers. Builds the
   * CURRENT level (this.levelDef) — beginPlay() picks it first.
   */
  private buildRun(): void {
    this.level?.dispose();
    // Retire the whole horde — a fresh run always starts with zero monsters.
    for (const b of this.bots) b.dispose(this.scene);
    this.bots = [];

    // ---- Per-level skin: assets, fog, lights --------------------------------
    const def = this.levelDef;
    this.textures = this.texturesByLevel.get(def.id)!;
    this.monsterTexture = this.monsterTextures.get(def.id)!;
    this.renderer.setClearColor(def.palette.fogColor);
    this.scene.fog = new THREE.FogExp2(def.palette.fogColor, def.palette.fogDensity);
    this.ambientLight.color.setHex(def.palette.ambientColor);
    this.ambientLight.intensity = def.palette.ambientIntensity;
    this.hemiLight.color.setHex(def.palette.hemiSky);
    this.hemiLight.groundColor.setHex(def.palette.hemiGround);
    this.hemiLight.intensity = def.palette.hemiIntensity;
    this.lightPool.setLightColor(def.palette.lightColor, def.palette.lightIntensity);

    this.maze = generateMaze((Math.random() * 1e9) | 0);
    this.level = buildLevel(this.scene, this.maze, this.textures, def);
    // Spawn near the center facing the longest open sightline.
    const spawnCell = this.pickSpawn();
    const spawn = this.maze.cellToWorld(spawnCell);
    this.player.spawn(spawn.x, spawn.z, spawnCell.yaw);
    // The monster's song is per-level — swap it and guarantee no voice
    // from the previous level survives the switch.
    this.audio.setMonsterLoop(def.monsterLoop);
    this.audio.resetMonster();
    this.elapsedPlay = 0;
    this.nextBotSpawnAt = BOT.SPAWN_DELAY;
  }

  /**
   * The natural spawn: pick a cell a SHORT distance (BOT.SPAWN_DIST_MIN..
   * MAX) from the player's CURRENT position, so each new hunter arrives
   * within seconds — no cross-map marches. Fires for the FIRST monster
   * after SPAWN_DELAY and for every additional one each SPAWN_INTERVAL.
   */
  private spawnBotNaturally(): void {
    const pc = this.maze.worldToCell(this.camera.position.x, this.camera.position.z);
    const cell = pickBotSpawnNear(this.maze, pc);
    const p = this.maze.cellToWorld(cell);
    this.addBot(p.x, p.z);
  }

  /**
   * Create, wire up and unleash one more Nextbot at a world position.
   * Bots are cheap (a sprite + a pathfinder each); there is no cap on
   * how many can hunt at once.
   */
  private addBot(x: number, z: number): Nextbot {
    // The CURRENT level's monster texture (monster.png / monster2.png / ...).
    const bot = new Nextbot(this.scene, this.monsterTexture);
    // Hand it the CURRENT maze + wall colliders (it navigates around walls).
    bot.setNav(this.maze, (bx, bz) => this.level?.queryColliders(bx, bz) ?? []);
    bot.spawnAt(x, z);
    this.bots.push(bot);
    // The monster's song starts with the FIRST hunter; from the second one
    // on, the single voice simply tracks whichever is closest (see loop).
    if (this.bots.length === 1) this.audio.startMonsterLoop();
    this.callbacks.onBotSpawned();
    return bot;
  }

  /**
   * DEV-ONLY spawn helpers "steal" the first natural slot when they fire
   * before SPAWN_DELAY, so the real scheduler doesn't double-spawn on top.
   */
  private consumeFirstSpawnSlot(): void {
    if (this.bots.length === 1 && this.nextBotSpawnAt === BOT.SPAWN_DELAY) {
      this.nextBotSpawnAt = this.elapsedPlay + BOT.SPAWN_INTERVAL;
    }
  }

  private onPointerUnlock = (): void => {
    if (this.phase === 'playing') {
      this.phase = 'paused';
      this.player.freeze();
      this.audio.suspend();
      this.callbacks.onPause();
    }
  };

  /**
   * Pick spawn cell + yaw near the map center with the longest open
   * sightline (up to 5 cells deep), so the run always opens on a proper
   * Backrooms corridor view instead of a dead-end pocket.
   * three.js yaw: 0 = -Z, PI/2 = -X, PI = +Z, -PI/2 = +X.
   */
  private pickSpawn(): { x: number; z: number; yaw: number } {
    const { hWall, vWall, N, pillars } = this.maze;
    const c0 = N >> 1;
    const inBounds = (x: number, z: number) => x >= 0 && x < N && z >= 0 && z < N;

    /** Open cells visible in a straight line from (x, z) toward (dx, dz). */
    const sight = (x: number, z: number, dx: number, dz: number): number => {
      let steps = 0;
      while (steps < 5 && inBounds(x + dx, z + dz)) {
        const blocked =
          dz === -1 ? hWall[z][x] : dz === 1 ? hWall[z + 1][x] : dx === -1 ? vWall[z][x] : vWall[z][x + 1];
        if (blocked) break;
        x += dx;
        z += dz;
        steps++;
      }
      return steps;
    };

    const hasPillar = (x: number, z: number) => pillars.some((p) => p.x === x && p.z === z);

    let best = { x: c0, z: c0, yaw: 0, score: -1 };
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = c0 + dx;
        const z = c0 + dz;
        if (x < 1 || x >= N - 1 || z < 1 || z >= N - 1 || hasPillar(x, z)) continue;
        const dirs = [
          { yaw: 0, s: sight(x, z, 0, -1) }, // north (-Z)
          { yaw: Math.PI, s: sight(x, z, 0, 1) }, // south (+Z)
          { yaw: Math.PI / 2, s: sight(x, z, -1, 0) }, // west (-X)
          { yaw: -Math.PI / 2, s: sight(x, z, 1, 0) }, // east (+X)
        ].sort((a, b) => b.s - a.s);
        // Longest sightline wins; tiny penalty keeps the spawn near center.
        const score = dirs[0].s - (Math.abs(dx) + Math.abs(dz)) * 0.05;
        if (score > best.score) {
          best = { x, z, yaw: dirs[0].yaw, score };
        }
      }
    }
    // Small random offset so runs don't all start perfectly axis-aligned.
    return { x: best.x, z: best.z, yaw: best.yaw + (Math.random() - 0.5) * 0.2 };
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = clamp((now - this.lastTime) / 1000, 0, 0.05);
    this.lastTime = now;
    const t = now / 1000;

    // ---- Poolrooms water: slow caustics drift (menu + playing) -----------------
    if (this.level?.water) {
      this.level.water.texture.offset.set(t * 0.008, t * 0.011);
    }

    if (this.phase === 'playing') {
      this.elapsedPlay += dt;

      // ---- THE HORDE: first hunter after SPAWN_DELAY, then one more every
      //      SPAWN_INTERVAL seconds — forever, with no cap. ----------------------
      if (this.elapsedPlay >= this.nextBotSpawnAt) {
        this.spawnBotNaturally();
        this.nextBotSpawnAt += BOT.SPAWN_INTERVAL;
      }

      // ---- Player -------------------------------------------------------------
      const state = this.player.update(dt);

      // ---- Bots: update every hunter, track the NEAREST threat ----------------
      let proximity = 0;
      let nearest: Nextbot | null = null;
      let caughtByAny = false;
      for (const b of this.bots) {
        if (b.update(dt, this.camera.position)) caughtByAny = true;
        if (!nearest || b.distance < nearest.distance) nearest = b;
      }
      if (nearest) {
        proximity = clamp(1 - nearest.distance / BOT.TENSION_RANGE, 0, 1);
        this.player.setFear(proximity);
      }
      if (caughtByAny) {
        this.die();
      }

      // ---- Atmosphere systems ----------------------------------------------------
      this.lightPool.update(t, dt, this.camera.position.x, this.camera.position.z, this.level!.panels);
      // Spatial data for the monster voice (doppler loudness / pan / muffle).
      // The single song always tracks the NEAREST hunter — with a horde
      // coming, the closest one is the one about to kill you.
      this.camera.getWorldDirection(this.tmpDir);
      const bp = nearest ? nearest.sprite.position : null;
      this.audio.update({
        botDist: nearest ? nearest.distance : Infinity,
        buzz: this.lightPool.nearestFaultyBuzz,
        botX: bp ? bp.x : 0,
        botZ: bp ? bp.z : 0,
        playerX: this.camera.position.x,
        playerZ: this.camera.position.z,
        fwdX: this.tmpDir.x,
        fwdZ: this.tmpDir.z,
      });

      this.callbacks.onFrame(state.stamina01, proximity, this.bots.length);
    } else if (this.phase === 'menu') {
      // Idle menu backdrop: slow ghost-drift through the spawn corridor.
      this.menuYaw += dt * 0.06;
      const spawn = this.maze.cellToWorld(this.maze.spawnCell);
      this.camera.position.set(
        spawn.x,
        PLAYER.EYE_HEIGHT + Math.sin(t * 0.7) * 0.03,
        spawn.z
      );
      this.camera.rotation.set(0, this.menuYaw, 0, 'YXZ');
      this.lightPool.update(t, dt, spawn.x, spawn.z, this.level!.panels);
      this.audio.update({
        botDist: Infinity,
        buzz: 0,
        botX: 0,
        botZ: 0,
        playerX: spawn.x,
        playerZ: spawn.z,
        fwdX: 0,
        fwdZ: -1,
      });
    }
    // 'paused' and 'dead': freeze the world, keep rendering the last frame.

    this.renderer.render(this.scene, this.camera);
  };

  private die(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'dead';
    this.audio.caught(); // song cuts dead + the jumpscare scream hits
    this.player.freeze();
    this.player.controls.unlock(); // releases the mouse for the death screen
    this.callbacks.onDeath(Math.round(this.elapsedPlay * 1000));
  }
}

/** Exposed so the UI can show the map's real corridor width in the menu. */
export const MAP_SIZE_METERS = WORLD.GRID_CELLS * WORLD.CELL;
