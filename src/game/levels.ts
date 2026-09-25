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

/** Visual/audio skin of a level (the "mood"). */
export interface LevelPalette {
  /** Fog + renderer clear color. */
  fogColor: number;
  /** Exponential fog density (lower = longer sightlines). */
  fogDensity: number;
  /** Color of the point lights and ceiling panels. */
  lightColor: number;
  /** Cheap global ambient light bed. */
  ambientColor: number;
  ambientIntensity: number;
  /** Hemisphere light (sky / ground tints). */
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Fraction of ceiling panels that are faulty / flicker. */
  flickerRatio: number;
  /** Floor construction: moist carpet (Level 0) or glossy tiles. */
  floorStyle: 'carpet' | 'tile';
  /** World meters covered by one repeat of the floor texture. */
  floorRepeatMeters: number;
  /** Ceiling construction: office tiles or plain white. */
  ceilingStyle: 'office' | 'plain';
  /** Meters of wall one horizontal copy of the wall texture covers. */
  wallTextureW: number;
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
      ambientColor: 0x8a7d55,
      ambientIntensity: 0.55,
      hemiSky: 0x9a8b55,
      hemiGround: 0x35301f,
      hemiIntensity: 0.5,
      flickerRatio: 0.16,
      floorStyle: 'carpet',
      floorRepeatMeters: 1.6,
      ceilingStyle: 'office',
      wallTextureW: 3.2,
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
    wallpaper: asset('/textures/pooltiles.jpg'),
    monster: asset('/textures/monster2.png'),
    monsterBright: asset('/textures/monster2_bright.png'),
    monsterLoop: asset('/audio/poolrooms-loop.mp3'),
    palette: {
      fogColor: 0xbfe3e6,
      fogDensity: 0.02,
      lightColor: 0xeafcff,
      ambientColor: 0x9fc4cc,
      ambientIntensity: 0.8,
      hemiSky: 0xd6f0f4,
      hemiGround: 0x40707a,
      hemiIntensity: 0.7,
      flickerRatio: 0.05,
      floorStyle: 'tile',
      floorRepeatMeters: 2.4,
      ceilingStyle: 'plain',
      wallTextureW: 2.4,
      wallRoughness: 0.35,
      water: { color: 0x7fd8e2, opacity: 0.24 },
    },
  },
];

export const DEFAULT_LEVEL_ID = 'backrooms';

/** Look a level up by id (falls back to Level 0 if unknown). */
export function getLevel(id: string): LevelDef {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}
