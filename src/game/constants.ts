/**
 * ============================================================================
 *  constants.ts — Central tuning table for the whole game.
 * ============================================================================
 *  Every important gameplay number lives here so you can rebalance the
 *  experience (speeds, fog, catch radius, grace period...) without touching
 *  any other file. Values are in METERS / SECONDS.
 * ============================================================================
 */

/** ---------- WORLD ---------- */
export const WORLD = {
  /** Number of maze cells per side of the map. 25 * 6m = 150m x 150m. */
  GRID_CELLS: 25,
  /** Size of one cell in meters (corridor width = cell size). 6m = wide
   *  open-plan halls — you can sprint side-to-side and SEE the Nextbot
   *  coming from far away instead of bumping elbows with the walls. */
  CELL: 6,
  /** Wall height in meters — raised for an airy hall feel. */
  WALL_H: 3.6,
  /** Wall thickness in meters (Backrooms partition walls are thin). */
  WALL_T: 0.42,
  /** Square pillar footprint (m) — chunky columns furnish the wide halls
   *  (break up sightlines aesthetically) without blocking your running lines. */
  PILLAR_SIZE: 1.2,
  /** Probability quirks for the maze generator.
   *  TUNED FOR OPEN PLAN: low wall density + heavy doorways = wide looping
   *  halls with long sightlines, not a tight claustrophobic maze. */
  MAZE: {
    /** Wall segments placed per cell (density of the labyrinth). */
    SEGMENTS_PER_CELL: 0.34,
    /** Min / max length of a generated wall run, in cells. */
    SEGMENT_MIN: 1,
    SEGMENT_MAX: 5,
    /** % of internal walls randomly removed => doorways / gaps. */
    DOORWAY_CHANCE: 0.32,
    /** % chance a lone open cell gets a square pillar. */
    PILLAR_CHANCE: 0.12,
  },
} as const;

/** ---------- PLAYER ---------- */
export const PLAYER = {
  /** Eye height (m). */
  EYE_HEIGHT: 1.68,
  /** Capsule radius used for wall collision (m). */
  RADIUS: 0.34,
  /** Walk speed (m/s) — must be SLOWER than the bot or you can never escape. */
  WALK_SPEED: 4.3,
  /** Sprint speed (m/s) — faster than the bot base speed; the open halls
   *  give you room to actually USE it. */
  SPRINT_SPEED: 8.4,
  /** How snappily velocity changes (higher = more arcade, lower = heavier). */
  ACCEL: 11,
  /** Stamina system (0..100). Sprinting drains, standing regens.
   *  GENEROUS tuning: a full bar sustains ~9s of sprinting and refills
   *  from empty in under 4s — long escapes with quick recovery breaks. */
  STAMINA_MAX: 100,
  STAMINA_DRAIN: 11, // per second while sprinting (~9s of full sprint)
  STAMINA_REGEN: 26, // per second while not sprinting (empty->full in ~3.8s)
  STAMINA_MIN_TO_SPRINT: 4, // below this, sprint is disabled until 12 regens
  /** Head-bob amplitude (m) & footstep timing derive from move speed. */
  BOB_WALK: 0.032,
  BOB_RUN: 0.052,
  /** Base FOV; +kick while sprinting, +fear when the bot is close. */
  FOV: 75,
  FOV_SPRINT_KICK: 7,
  FOV_FEAR_KICK: 5,
} as const;

/** ---------- NEXTBOT ---------- */
export const BOT = {
  /** Sprite height in meters — taller so it reads clearly across open halls. */
  HEIGHT: 2.55,
  /**
   * Cruising speed (m/s) — REBALANCED: slower than before (was 7.1) and the
   * bot now collides with walls, so sprinting (8.4) genuinely outruns it.
   * Escaping is a matter of stamina and smart cornering.
   */
  BASE_SPEED: 6.2,
  /** Rubber-band speed when the bot fell far behind (m/s) — gentler now. */
  CATCHUP_SPEED: 10.0,
  /** Distance (m) beyond which the rubber-band acceleration kicks in. */
  CATCHUP_DIST: 34,
  /** Small speed boost for the final lunge when very close (m/s). */
  LUNGE_BOOST: 0.7,
  LUNGE_DIST: 8,
  /** Collision radius (m) — the bot can no longer phase through walls. */
  RADIUS: 0.6,
  /** Seconds between A* replans while the player is out of sight. */
  PATH_REPLAN: 0.4,
  /** Distance (m) to a path waypoint before advancing to the next one. */
  WAYPOINT_REACH: 1.0,
  /** Horizontal distance (m) that counts as "caught" (needs line of sight). */
  CATCH_RADIUS: 1.15,
  /** Grace period (s) before the bot spawns — pure exploration time.
   *  Shortened to 10s so the hunt starts roughly twice as fast. */
  SPAWN_DELAY: 10,
  /**
   * THE HORDE: seconds between each NEW monster after the first one.
   * The first hunter arrives after SPAWN_DELAY; from then on one more
   * materializes every SPAWN_INTERVAL seconds. There is NO CAP — the
   * Backrooms keep manufacturing Nextbots until you are caught.
   */
  SPAWN_INTERVAL: 30,
  /**
   * Spawn NEARNESS (meters, BFS path distance from the player's CURRENT
   * position at spawn time): the bot materializes 18-36m away instead of
   * at the far side of the map, so the hunt begins within seconds — you
   * hear its loop almost immediately and it arrives quickly.
   */
  SPAWN_DIST_MIN: 18,
  SPAWN_DIST_MAX: 36,
  /** Seconds the bot takes to reach full speed after spawning. */
  SPAWN_RAMP: 3.5,
  /** Distance (m) at which audio/visual tension starts ramping up — raised
   *  to match the longer sightlines of the open layout. */
  TENSION_RANGE: 30,
} as const;

/** ---------- MONSTER AUDIO (the chase loop + doppler) ----------
 *  Per-level values (which FILE each level's monster sings) live in
 *  levels.ts — these are the shared mechanics of the voice itself. */
export const MONSTER_AUDIO = {
  /** Distance (m) at which the loop becomes inaudible. Large on purpose:
   *  the sound IS the radar — you should faintly hear it stalking far away. */
  HEAR_DIST: 55,
  /** Distance (m) inside which the loop plays at full volume. */
  FULL_DIST: 4,
  /** Peak output level of the monster voice. */
  GAIN_MAX: 0.62,
  /**
   * TRUE DOPPLER: playbackRate = 1 + closingSpeed * DOPPLER_RATE.
   * closingSpeed (m/s) > 0 means the distance is shrinking (it's gaining).
   * Chasing you at normal pace ≈ +2 m/s => subtle sharpening; a head-on
   * sprint close ≈ +14 m/s => clamped to a clear, rising pitch.
   */
  DOPPLER_RATE: 0.012,
  /** Pitch bend limits (keeps the loop musical, never chipmunk/slayer). */
  RATE_MIN: 0.88,
  RATE_MAX: 1.12,
  /** Stereo pan limit (1 = hard right/left). 0.85 keeps a bit of body. */
  PAN_MAX: 0.85,
  /** Lowpass cutoffs (Hz): air/wall absorption sells the distance.
   *  FAR = muffled rumble, NEAR = full-brightness loop. */
  FAR_CUTOFF: 700,
  NEAR_CUTOFF: 14000,
  /** Extra muffling multiplier when the monster is BEHIND you (stereo
   *  can't do front/back — a darker tone behind is the ear's best cue). */
  BEHIND_CUTOFF: 0.3,
  /** Loop fade-in on spawn / fade-out when caught (s). */
  FADE_IN: 1.8,
  FADE_OUT: 0.3,
  /** How many times we re-try fetching the loop file across a session. */
  LOAD_RETRIES: 3,
} as const;

/** ---------- ATMOSPHERE ----------
 *  Per-level mood (fog color/density, light color, flicker ratio) lives in
 *  levels.ts — only the light-pool SIZE is global. */
export const ATMOS = {
  /** How many roaming PointLights follow the player between ceiling panels. */
  LIGHT_POOL_SIZE: 5,
} as const;
