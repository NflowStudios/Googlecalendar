/**
 * ============================================================================
 *  PlayerController.ts — First-person movement system.
 * ============================================================================
 *  FEATURES
 *    • Mouse-look via THREE's PointerLockControls (click to capture, ESC to
 *      release — the browser handles the pointer lock UX for us).
 *    • WASD / arrow-key walking + SHIFT sprint with a STAMINA bar.
 *    • Circle-vs-AABB wall collision resolved against the level's spatial
 *      hash, so you slide smoothly along walls instead of sticking.
 *    • Procedural head-bob + footstep callbacks (synced to the bob cycle)
 *      and a subtle FOV kick while sprinting / when the bot is near.
 *
 *  The controller only owns the CAMERA — there is no visible player mesh.
 * ============================================================================
 */

import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { PLAYER } from './constants';
import { clamp, damp } from './utils';
import type { AABB } from './LevelBuilder';

export interface PlayerState {
  stamina01: number; // 0..1 for the HUD bar
  sprinting: boolean;
  speed: number; // current horizontal speed (m/s)
}

export class PlayerController {
  readonly controls: PointerLockControls;
  private keys = new Set<string>();
  private velocity = new THREE.Vector3();
  private bobPhase = 0;
  private lastStepBucket = 0;
  private stamina: number = PLAYER.STAMINA_MAX;
  private sprintLocked = false;
  private currentFov: number = PLAYER.FOV;
  private fear01 = 0; // 0..1 — set by the engine when the bot is close

  constructor(
    private camera: THREE.PerspectiveCamera,
    private domElement: HTMLElement,
    private queryColliders: (x: number, z: number) => AABB[],
    private callbacks: {
      onFootstep?: (running: boolean) => void;
    } = {}
  ) {
    this.controls = new PointerLockControls(camera, domElement);
  }

  /** Teleport to a world position (used on spawn / restart). */
  spawn(x: number, z: number, yaw: number): void {
    this.camera.position.set(x, PLAYER.EYE_HEIGHT, z);
    this.camera.rotation.set(0, yaw, 0, 'YXZ');
    this.velocity.set(0, 0, 0);
    this.stamina = PLAYER.STAMINA_MAX;
    this.bobPhase = 0;
    this.keys.clear();
  }

  /** 0..1 fear factor — widens FOV slightly when death is near. */
  setFear(v: number): void {
    this.fear01 = clamp(v, 0, 1);
  }

  /** Called when the pointer lock is released — stop accepting input. */
  freeze(): void {
    this.keys.clear();
  }

  update(dt: number): PlayerState {
    const locked = this.controls.isLocked;

    // ---- 1. Read intent -----------------------------------------------------
    // (Keyboard state is only read while pointer-locked; paused players
    //  glide to a halt instead of ghost-walking.)
    let ix = 0;
    let iz = 0;
    if (locked) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) iz -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) iz += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) ix -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) ix += 1;
    }
    const moving = ix !== 0 || iz !== 0;
    if (moving) {
      const inv = 1 / Math.hypot(ix, iz);
      ix *= inv;
      iz *= inv;
    }

    // ---- 2. Stamina & sprint ------------------------------------------------
    const wantSprint = locked && this.keys.has('ShiftLeft') && moving && iz < 0.1;
    // Sprint disables at 0 and only re-enables once stamina recovers a bit.
    if (this.stamina <= 0.01) this.sprintLocked = true;
    if (this.sprintLocked && this.stamina > PLAYER.STAMINA_MIN_TO_SPRINT + 8) this.sprintLocked = false;
    const sprinting = wantSprint && !this.sprintLocked;

    if (sprinting) this.stamina = Math.max(0, this.stamina - PLAYER.STAMINA_DRAIN * dt);
    else this.stamina = Math.min(PLAYER.STAMINA_MAX, this.stamina + PLAYER.STAMINA_REGEN * dt);

    // ---- 3. Accelerate toward the desired velocity ---------------------------
    const speed = sprinting ? PLAYER.SPRINT_SPEED : PLAYER.WALK_SPEED;
    // Build the wish-direction in camera-yaw space.
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    const wish = new THREE.Vector3()
      .addScaledVector(forward, -iz)
      .addScaledVector(right, ix);
    if (moving) wish.normalize().multiplyScalar(speed);

    // Exponential approach => smooth start/stop that is framerate-independent.
    this.velocity.x = damp(this.velocity.x, wish.x, PLAYER.ACCEL, dt);
    this.velocity.z = damp(this.velocity.z, wish.z, PLAYER.ACCEL, dt);

    // ---- 4. Move + collide ----------------------------------------------------
    this.camera.position.x += this.velocity.x * dt;
    this.camera.position.z += this.velocity.z * dt;
    this.resolveCollisions();

    // ---- 5. Head bob & footsteps ----------------------------------------------
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (hSpeed > 0.4) {
      const prev = this.bobPhase;
      this.bobPhase += hSpeed * 1.85 * dt; // faster bob when running
      // Footstep every half bob-cycle (each foot).
      const bucket = Math.floor(this.bobPhase / Math.PI);
      if (bucket !== this.lastStepBucket) {
        this.lastStepBucket = bucket;
        this.callbacks.onFootstep?.(sprinting);
      }
    }
    const amp = (sprinting ? PLAYER.BOB_RUN : PLAYER.BOB_WALK) * clamp(hSpeed / PLAYER.WALK_SPEED, 0, 1);
    this.camera.position.y =
      PLAYER.EYE_HEIGHT + Math.sin(this.bobPhase) * amp + Math.cos(this.bobPhase * 0.5) * amp * 0.35;

    // ---- 6. FOV: sprint kick + fear kick ---------------------------------------
    const targetFov =
      PLAYER.FOV +
      (sprinting ? PLAYER.FOV_SPRINT_KICK : 0) * clamp(hSpeed / PLAYER.SPRINT_SPEED, 0, 1) +
      this.fear01 * PLAYER.FOV_FEAR_KICK;
    this.currentFov = damp(this.currentFov, targetFov, 6, dt);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    return { stamina01: this.stamina / PLAYER.STAMINA_MAX, sprinting, speed: hSpeed };
  }

  /**
   * Circle-vs-AABB resolution: for every wall box near the player, find the
   * closest point on the box to the player; if it's closer than the player
   * radius, push the player out along that direction. Running it twice
   * handles inner corners cleanly.
   */
  private resolveCollisions(): void {
    const p = this.camera.position;
    const r = PLAYER.RADIUS;
    for (let iter = 0; iter < 2; iter++) {
      const boxes = this.queryColliders(p.x, p.z);
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
        // Kill velocity into the wall so we slide instead of vibrating.
        const vn = this.velocity.x * dx + this.velocity.z * dz;
        if (vn < 0) {
          this.velocity.x -= vn * dx;
          this.velocity.z -= vn * dz;
        }
      }
    }
  }

  /** Wire keyboard events (call once after construction). */
  connect(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // Release SHIFT etc. if the window loses focus (prevents "stuck" keys).
    window.addEventListener('blur', this.onBlur);
  }

  disconnect(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.controls.disconnect();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onBlur = () => this.keys.clear();
}
