/**
 * ============================================================================
 *  levels.ts — The level catalog.
 * ============================================================================
 *  Each level is a self-contained definition: which textures it uses, which
 *  monster hunts in it, which song the monster sings, and the palette that
 *  gives the level its mood (fog, lights, floor, water).
 *
 *  The ENGINE mechanics (movement, stamina, the horde's 30-second spawn
 *  schedule, the doppler song, the catch) are IDENTICAL in every level —
 *  levels only swap the SKIN. Adding a level = adding one entry here plus
 *  the asset files it references.
 * ============================================================================
 */

import { asset } from './utils';
import { WORLD } from './constants';

/** Visual/audio skin of a level (the "mood"). */
export interface LevelPalette {
  /** Fog + renderer clear color. */
  fogColor: number;
  /** Exponential fog density (lower = longer sightlines). */
  fogDensity: number;
  /** Color of the point lights and ceiling panels. */
  lightColor: number;
  /**
   * Brightness of the roaming point lights relative to the default (1).
   * The Basement runs ~0.55 — visibly dimmer than the levels above.
   */
  lightIntensity: number;
  /** Cheap global ambient light bed. */
  ambientColor: number;
  ambientIntensity: number;
  /** Hemisphere light (sky / ground tints). */
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Fraction of ceiling panels that are faulty / flicker. */
  flickerRatio: number;
  /** Floor construction: moist carpet (Level 0) or a custom textured floor. */
  floorStyle: 'carpet' | 'tile';
  /** World meters covered by one repeat of the floor texture. */
  floorRepeatMeters: number;
  /** Floor surface finish (carpet 1.0, wet tiles 0.32, concrete ~0.85). */
  floorRoughness: number;
  /** Floor metalness (0 for organic floors, faint for wet concrete). */
  floorMetalness: number;
  /** Ceiling construction: office tiles, plain white, or bare concrete. */
  ceilingStyle: 'office' | 'plain' | 'concrete';
  /** Meters of wall one horizontal copy of the wall texture covers. */
  wallTextureW: number;
  /**
   * Meters of wall one VERTICAL copy of the wall texture covers.
   * Level 0 uses the full wall height (3.6m) so the wallpaper's horizontal
   * banding maps exactly once and stays intact; the Poolrooms uses the same
   * value as wallTextureW so its tiles stay SQUARE (and slightly smaller
   * than the floor's, so wall and floor read as different surfaces).
   */
  wallTextureH: number;
  /** Wall surface finish: 0.94 = matte wallpaper, ~0.35 = glossy tiles. */
  wallRoughness: number;
  /** Shallow water plane over the floor (null = dry level). */
  water: { color: number; opacity: number } | null;
}

/** One playable level. */
export interface LevelDef {
  id: string;
  /** Short code shown on buttons ("LEVEL 0", "LEVEL 37"). */
  code: string;
  /** Display name. */
  name: string;
  /** One-line hook for the level browser. */
  tagline: string;
  /** Short description for the level browser. */
  blurb: string;
  /** Wall texture (public/textures/...). */
  wallpaper: string;
  /**
   * Optional dedicated FLOOR texture (public/textures/...). Tile floors
   * use this instead of the wall texture when set — the Poolrooms keeps
   * its tiles on the floor while the walls are a simple painted white.
   * Falls back to `wallpaper` when omitted.
   */
  floorTexture?: string;
  /** The Nextbot's sprite image. */
  monster: string;
  /** Brightened monster image for the jumpscare flash. */
  monsterBright: string;
  /** The monster's chase song (public/audio/...). */
  monsterLoop: string;
  palette: LevelPalette;
}

export const LEVELS: readonly LevelDef[] = [
  {
    id: 'backrooms',
    code: 'LEVEL 0',
    name: 'THE BACKROOMS',
    tagline: 'The yellow. The hum. The carpet.',
    blurb:
      'Endless office halls drenched in buzzing fluorescent yellow. You noclipped out of reality — and something in here never stops hunting.',
    wallpaper: asset('/textures/wallpaper.jpg'),
    monster: asset('/textures/monster.png'),
    monsterBright: asset('/textures/monster_bright.png'),
    monsterLoop: asset('/audio/monster-loop.mp3'),
    palette: {
      fogColor: 0x8a7b45,
      fogDensity: 0.032,
      lightColor: 0xffe6ad,
      lightIntensity: 1,
      ambientColor: 0x8a7d55,
      ambientIntensity: 0.55,
      hemiSky: 0x9a8b55,
      hemiGround: 0x35301f,
      hemiIntensity: 0.5,
      flickerRatio: 0.16,
      floorStyle: 'carpet',
      floorRepeatMeters: 1.6,
      floorRoughness: 1,
      floorMetalness: 0,
      ceilingStyle: 'office',
      wallTextureW: 3.2,
      wallTextureH: WORLD.WALL_H,
      wallRoughness: 0.94,
      water: null,
    },
  },
  {
    id: 'poolrooms',
    code: 'LEVEL 37',
    name: 'THE POOLROOMS',
    tagline: 'White tiles. Warm water. No exit.',
    blurb:
      'Sunlit corridors of white tile and still, shallow water. Calm on the surface — but the same hunt happens here, and the water carries every sound.',
    wallpaper: asset('/textures/poolwall.jpg'),
    floorTexture: asset('/textures/pooltiles.jpg'),
    monster: asset('/textures/monster2.png'),
    monsterBright: asset('/textures/monster2_bright.png'),
    monsterLoop: asset('/audio/poolrooms-loop.mp3'),
    palette: {
      fogColor: 0xbfe3e6,
      fogDensity: 0.02,
      lightColor: 0xeafcff,
      lightIntensity: 1,
      ambientColor: 0x9fc4cc,
      ambientIntensity: 0.8,
      hemiSky: 0xd6f0f4,
      hemiGround: 0x40707a,
      hemiIntensity: 0.7,
      flickerRatio: 0.05,
      floorStyle: 'tile',
      floorRepeatMeters: 2.4,
      floorRoughness: 0.32,
      floorMetalness: 0.06,
      ceilingStyle: 'plain',
      // Walls are a simple painted white — no tiles, no pattern, so the UV
      // scale only controls the size of the texture's subtle mottling.
      wallTextureW: 2.0,
      wallTextureH: 2.0,
      wallRoughness: 0.5,
      water: { color: 0x7fd8e2, opacity: 0.24 },
    },
  },
  {
    id: 'basement',
    code: 'LEVEL 6',
    name: 'THE BASEMENT',
    tagline: 'Old concrete. Dying bulbs. No way up.',
    blurb:
      'A forgotten sub-level of stained concrete and guttering light. The dark swallows your footsteps here — and it hears everything.',
    wallpaper: asset('/textures/concrete.jpg'),
    floorTexture: asset('/textures/concrete_floor.jpg'),
    monster: asset('/textures/monster3.png'),
    monsterBright: asset('/textures/monster3_bright.png'),
    monsterLoop: asset('/audio/basement-loop.mp3'),
    palette: {
      fogColor: 0x0a0c0e,
      fogDensity: 0.055,
      lightColor: 0xd9a86a,
      lightIntensity: 0.55,
      ambientColor: 0x30333a,
      ambientIntensity: 0.3,
      hemiSky: 0x3a3e46,
      hemiGround: 0x101215,
      hemiIntensity: 0.28,
      flickerRatio: 0.34,
      floorStyle: 'tile',
      floorRepeatMeters: 2.4,
      floorRoughness: 0.85,
      floorMetalness: 0.02,
      ceilingStyle: 'concrete',
      wallTextureW: 2.0,
      wallTextureH: 2.0,
      wallRoughness: 0.92,
      water: null,
    },
  },
];

export const DEFAULT_LEVEL_ID = 'backrooms';

/** Look a level up by id (falls back to Level 0 if unknown). */
export function getLevel(id: string): LevelDef {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}
