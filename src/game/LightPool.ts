/**
 * ============================================================================
 *  LightPool.ts — Dynamic fluorescent lighting on a budget.
 * ============================================================================
 *  A real Backrooms map has HUNDREDS of ceiling lights — but hundreds of
 *  dynamic THREE.PointLights would kill the framerate. Instead we use the
 *  classic "light pool" trick:
 *
 *    • The ceiling is covered in emissive light PANELS (cheap, always lit).
 *    • Only ATMOS.LIGHT_POOL_SIZE real PointLights exist. Every frame they
 *      snap to the panels NEAREST the player, so wherever you walk, the
 *      corridors around you are always "really" lit.
 *    • Faulty panels (and any pool light sitting on one) flicker.
 *
 *  The result reads as a fully-lit office floor for the cost of 5 lights.
 * ============================================================================
 */

import * as THREE from 'three';
import { ATMOS, WORLD } from './constants';
import { clamp } from './utils';
import type { LightPanel } from './LevelBuilder';

export class LightPool {
  private lights: THREE.PointLight[] = [];
  private assignTimer = 0;
  private assigned: LightPanel[] = [];
  /** Brightness of the pool lights (buildRun() scales it per level). */
  private baseIntensity = 34;
  /** 0..1 flicker amount of the nearest faulty panel (drives audio buzz). */
  public nearestFaultyBuzz = 0;

  constructor(private scene: THREE.Scene) {
    for (let i = 0; i < ATMOS.LIGHT_POOL_SIZE; i++) {
      // Warm fluorescent default — buildRun() retints per level.
      const light = new THREE.PointLight(0xffe6ad, 34, 11, 2);
      scene.add(light);
      this.lights.push(light);
    }
  }

  /** Re-tint (and re-scale) every pool light for the level being built. */
  setLightColor(color: number, intensityScale = 1): void {
    this.baseIntensity = 34 * intensityScale;
    for (const light of this.lights) {
      light.color.setHex(color);
      light.intensity = this.baseIntensity;
    }
  }

  /**
   * @param t     elapsed time (s)
   * @param dt    frame delta (s)
   * @param camX  player camera position
   * @param camZ
   * @param panels all ceiling panels from the level
   */
  update(t: number, dt: number, camX: number, camZ: number, panels: LightPanel[]): void {
    this.assignTimer -= dt;

    // Re-assign pool lights to nearest panels a few times per second.
    if (this.assignTimer <= 0) {
      this.assignTimer = 0.2;
      const byDist = panels
        .map((p) => ({ p, d: (p.x - camX) ** 2 + (p.z - camZ) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, this.lights.length)
        .map((e) => e.p);
      this.assigned = byDist;
      this.lights.forEach((light, i) => {
        const p = byDist[i];
        if (p) light.position.set(p.x, WORLD.WALL_H - 0.25, p.z);
      });
    }

    // ---- Flicker logic -----------------------------------------------------
    let nearestFaultyDist = Infinity;

    for (const p of panels) {
      if (!p.faulty || !p.material) continue;
      const d = Math.hypot(p.x - camX, p.z - camZ);
      if (d < nearestFaultyDist) nearestFaultyDist = d;

      // Random telegraph flicker: mostly on, briefly dark, occasionally dead.
      const n = Math.sin(t * 13.7 + p.phase) * Math.sin(t * 47.3 + p.phase * 2);
      const on = n > -0.55 ? (Math.random() < 0.02 ? 0.05 : 1) : 0.12;
      p.material.color.setScalar(0.25 + on * 0.85);
    }

    // Point lights gently shimmer; lights sitting on faulty panels stutter.
    this.lights.forEach((light, i) => {
      const p = this.assigned[i];
      let intensity = this.baseIntensity * (0.94 + 0.06 * Math.sin(t * 40 + i * 2.1));
      if (p?.faulty && p.material) {
        intensity *= clamp(p.material.color.r, 0, 1) * 0.9 + 0.1;
      }
      light.intensity = intensity;
    });

    // How loud the electric buzz should be (1 = right under a faulty panel).
    this.nearestFaultyBuzz = clamp(1 - nearestFaultyDist / 9, 0, 1);
  }

  dispose(): void {
    this.lights.forEach((l) => this.scene.remove(l));
    this.lights = [];
  }
}
