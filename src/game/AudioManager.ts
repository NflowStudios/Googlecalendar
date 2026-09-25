/**
 * ============================================================================
 *  AudioManager.ts — Horror audio via the Web Audio API.
 * ============================================================================
 *  Three volume sliders, two buses, one monster:
 *
 *      SOUNDS bus ("sounds")            MUSIC bus ("music")
 *        fluorescent hum                  THE MONSTER'S SONG — the chase
 *        room drone                       loop (public/audio/monster-loop.mp3)
 *        faulty-light buzz                  • LOUDNESS falls with distance
 *        player footsteps                   • PITCH bends with closing speed
 *              \                            • PAN puts it left/right
 *               \                           • LOWPASS muffle, extra behind
 *                +---- MASTER ("master") --> compressor --> speakers
 *
 *  The monster produces exactly ONE continuous sound: its song. The loop
 *  fades in when the hunt begins, stalks you by doppler, and cuts dead the
 *  instant you are caught — then the JUMPSCARE SCREAM hits (the one old
 *  layer that survived the purge: sub drop + descending saw cluster +
 *  noise blast) while the room ducks out for a beat. (The old growl /
 *  heartbeat / riser / spawn stinger layers were removed.)
 *  Bus map:
 *      ambBus (room beds, ducked on catch)  ┐
 *      footsteps                            ├→ sfxBus  → master → comp
 *      jumpscare scream                     ┘              → speakers
 *      monster song chain ──────────────────→ musicBus ──┘
 * ============================================================================
 */

import { MONSTER_AUDIO as MA } from './constants';
import { clamp, lerp } from './utils';

export interface AudioUpdateOpts {
  botDist: number;
  /** 0..1 — proximity to a flickering light panel (drives the buzz). */
  buzz: number;
  // ---- Monster-voice spatial data (worldspace, XZ plane) --------------------
  /** Bot world position. */
  botX: number;
  botZ: number;
  /** Player (camera) world position. */
  playerX: number;
  playerZ: number;
  /** Camera horizontal forward vector (normalized enough for our math). */
  fwdX: number;
  fwdZ: number;
}

/** The three mixer sliders exposed in the settings UI (each 0..1). */
export interface VolumeSettings {
  /** Final output level, before the compressor. */
  master: number;
  /** Ambience (hum / drone / light buzz) + player footsteps. */
  sounds: number;
  /** The monster's chase loop. */
  music: number;
}

const DEFAULT_VOLUMES: VolumeSettings = { master: 0.9, sounds: 1, music: 1 };

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuffer!: AudioBuffer;

  // ---- Volume buses ---------------------------------------------------------
  /** Room + player sounds (hum, drone, buzz, footsteps). */
  private sfxBus!: GainNode;
  /** The monster's song (its own bus so the MUSIC slider only touches it). */
  private musicBus!: GainNode;
  /** Current slider values — applied at init() and on every change. */
  private vol: VolumeSettings = { ...DEFAULT_VOLUMES };

  // ---- Ambient beds ----------------------------------------------------------
  private humGain!: GainNode;
  private droneGain!: GainNode;
  private buzzGain!: GainNode;
  /** Room-bed bus (hum/drone/buzz) — ducked to silence during the scream. */
  private ambBus!: GainNode;

  // ---- Monster voice (the chase loop, positional + doppler) -----------------
  /** Shared spatial chain: source -> filter -> panner -> gain -> musicBus. */
  private monsterFilter!: BiquadFilterNode;
  private monsterPan!: StereoPannerNode;
  private monsterGain!: GainNode;
  /** The song file for the level being played (levels.ts supplies it). */
  private monsterUrl: string | null = null;
  /** Decoded-and-analyzed loop files, keyed by URL (one per level). */
  private readonly loopCache = new Map<
    string,
    { buffer: AudioBuffer; trim: number; loopStart: number; loopEnd: number }
  >();
  /** Decoded loop file for the CURRENT level (null until fetch+decode). */
  private monsterBuffer: AudioBuffer | null = null;
  /** The file-backed voice, once playing. */
  private monsterSrc: AudioBufferSourceNode | null = null;
  /** Is the monster voice currently sounding (bot spawned, not caught)? */
  private monsterOn = false;
  /** Last applied playbackRate (doppler) — exposed for debugging. */
  private monsterRate = 1;
  /** Peak-normalization multiplier for the loaded file (target 0.9). */
  private monsterTrim = 1;
  /** Seamless-loop window inside the decoded file (seconds). */
  private monsterLoopStart = 0;
  private monsterLoopEnd = 0;
  private loadAttempts = 0;
  private loading = false;

  /** Doppler state: previous distance/time of the bot, for closing speed. */
  private prevDist = NaN;
  private prevNow = NaN;
  private closingSmooth = 0;

  get ready(): boolean {
    return this.ctx !== null;
  }

  /** MUST be called from a user gesture (the Play button click). */
  init(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    // ---- Master chain: [sfx + music] -> master gain -> compressor -> out ----
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 8;
    this.master = ctx.createGain();
    this.master.gain.value = this.vol.master;
    this.master.connect(comp).connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.vol.sounds;
    this.sfxBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.vol.music;
    this.musicBus.connect(this.master);
    // Room beds get their own sub-bus so the catch-duck can silence them
    // WITHOUT touching the scream / footsteps that share the SOUNDS bus.
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 1;
    this.ambBus.connect(this.sfxBus);

    // ---- Shared white-noise buffer (2s) --------------------------------------
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // ---- Fluorescent hum ------------------------------------------------------
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0.85;
    this.humGain.connect(this.ambBus);
    for (const [freq, g] of [
      [118, 0.028],
      [236, 0.011],
      [472, 0.004],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const og = ctx.createGain();
      og.gain.value = g;
      osc.connect(og).connect(this.humGain);
      osc.start();
    }
    // Buzzing noise bed under the hum.
    const humNoise = this.loopNoise();
    const humLp = ctx.createBiquadFilter();
    humLp.type = 'lowpass';
    humLp.frequency.value = 280;
    const humNg = ctx.createGain();
    humNg.gain.value = 0.016;
    humNoise.connect(humLp).connect(humNg).connect(this.humGain);
    // Slow amplitude wobble.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.21;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.12;
    lfo.connect(lfoG).connect(this.humGain.gain);
    lfo.start();

    // ---- Sub drone (two detuned sines beating against each other) -------------
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.6;
    this.droneGain.connect(this.ambBus);
    for (const f of [52, 52.6]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = 0.026;
      osc.connect(og).connect(this.droneGain);
      osc.start();
    }

    // ---- Faulty light buzz ---------------------------------------------------------
    this.buzzGain = ctx.createGain();
    this.buzzGain.gain.value = 0;
    this.buzzGain.connect(this.ambBus);
    const buzzOsc = ctx.createOscillator();
    buzzOsc.type = 'square';
    buzzOsc.frequency.value = 119;
    const buzzHp = ctx.createBiquadFilter();
    buzzHp.type = 'highpass';
    buzzHp.frequency.value = 420;
    buzzOsc.connect(buzzHp).connect(this.buzzGain);
    buzzOsc.start();

    // ---- MONSTER VOICE spatial chain ---------------------------------------------
    //   (loop file) -> lowpass -> stereo pan -> distance gain -> musicBus
    // The filter muffles it with distance (and extra when behind you), the
    // panner puts it left/right, and the gain is the doppler loudness curve:
    // quiet when it's far, loud when it's close.
    this.monsterFilter = ctx.createBiquadFilter();
    this.monsterFilter.type = 'lowpass';
    this.monsterFilter.frequency.value = MA.NEAR_CUTOFF;
    this.monsterFilter.Q.value = 0.4;
    this.monsterPan = ctx.createStereoPanner();
    this.monsterGain = ctx.createGain();
    this.monsterGain.gain.value = 0;
    this.monsterFilter.connect(this.monsterPan).connect(this.monsterGain).connect(this.musicBus);
  }

  /**
   * Point the monster's voice at the CURRENT level's song and start loading
   * it. Called by the engine on every beginPlay / returnToMenu. Cached files
   * (a level played earlier in the same session) apply instantly.
   */
  setMonsterLoop(url: string): void {
    if (this.monsterUrl === url) return;
    this.stopMonsterLoop();
    this.monsterUrl = url;
    this.loadAttempts = 0;
    const cached = this.loopCache.get(url);
    if (cached) {
      this.applyLoopEntry(cached);
    } else {
      this.monsterBuffer = null;
      this.monsterTrim = 1;
      this.monsterLoopStart = 0;
      this.monsterLoopEnd = 0;
      void this.ensureMonsterBuffer();
    }
  }

  /** Make a cache entry the CURRENT voice (no re-decode needed). */
  private applyLoopEntry(e: { buffer: AudioBuffer; trim: number; loopStart: number; loopEnd: number }): void {
    this.monsterBuffer = e.buffer;
    this.monsterTrim = e.trim;
    this.monsterLoopStart = e.loopStart;
    this.monsterLoopEnd = e.loopEnd;
    // Late landing while a hunt is already underway (level switched back)?
    // Only relevant if the voice should be sounding.
    if (this.monsterOn && !this.monsterSrc) this.startFileVoice();
  }

  // ===========================================================================
  //  Volume mixer (settings UI hooks)
  // ===========================================================================

  /**
   * Apply the three mixer sliders. Safe to call before init() (the values
   * are stored and used when the AudioContext is created) and while the
   * context is suspended (applied on resume). Values are clamped to 0..1.
   */
  setVolumes(v: VolumeSettings): void {
    this.vol = {
      master: clamp(v.master, 0, 1),
      sounds: clamp(v.sounds, 0, 1),
      music: clamp(v.music, 0, 1),
    };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const apply = (node: GainNode, value: number) => {
      node.gain.cancelScheduledValues(t);
      node.gain.setTargetAtTime(value, t, 0.04);
    };
    apply(this.master, this.vol.master);
    apply(this.sfxBus, this.vol.sounds);
    apply(this.musicBus, this.vol.music);
  }

  getVolumes(): VolumeSettings {
    return { ...this.vol };
  }

  /** DEV/verification snapshot of the mixer state. */
  get debugVolumes(): {
    setting: VolumeSettings;
    masterGain: number;
    sfxGain: number;
    musicGain: number;
  } {
    return {
      setting: { ...this.vol },
      masterGain: this.ctx ? this.master.gain.value : -1,
      sfxGain: this.ctx ? this.sfxBus.gain.value : -1,
      musicGain: this.ctx ? this.musicBus.gain.value : -1,
    };
  }

  // ===========================================================================
  //  Monster voice — the shipped loop file, positional + doppler
  // ===========================================================================

  /** Looping white-noise source. */
  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.start();
    return src;
  }

  /**
   * Fetch + decode the current level's loop file. Retries a couple of times
   * across the session (e.g. dev server was still bundling on the first try).
   */
  private async ensureMonsterBuffer(): Promise<boolean> {
    if (!this.ctx || !this.monsterUrl) return false;
    if (this.monsterBuffer) return true;
    if (this.loading || this.loadAttempts >= MA.LOAD_RETRIES) return false;
    this.loading = true;
    this.loadAttempts++;
    const url = this.monsterUrl;
    try {
      // 'no-cache': always revalidate with the server, so a freshly shipped
      // loop file is picked up instead of a stale HTTP cache entry.
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      // decodeMonster (not a raw decodeAudioData) so the shipped file gets
      // peak normalization + the seamless-loop window trim, and so a hunt
      // already underway hot-swaps to it.
      return await this.decodeMonster(bytes, url);
    } catch {
      // Missing file is an EXPECTED state — the monster then hunts in
      // silence, which is its own kind of terrifying.
      if (process.env.NODE_ENV === 'development') {
        console.info(
          `[audio] ${url} not available (attempt ${this.loadAttempts}/${MA.LOAD_RETRIES}) — the monster will hunt in silence.`
        );
      }
      return false;
    } finally {
      this.loading = false;
    }
  }

  /** Decode + analyze the monster-voice file, then hot-swap it in. */
  private async decodeMonster(data: ArrayBuffer, url: string): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx) return false;
    try {
      // slice(0): decodeAudioData DETACHES the buffer it is given, and we
      // want the bytes to stay reusable.
      const buf = await ctx.decodeAudioData(data.slice(0));

      // --- Analyze channel 0: peak level + leading/trailing silence ------
      const ch = buf.getChannelData(0);
      const n = ch.length;
      let peak = 0;
      for (let i = 0; i < n; i += 16) {
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
      }
      // Normalize so the loop is always present in the mix.
      const trim = peak > 0.002 ? clamp(0.9 / peak, 0.25, 6) : 1;
      // Trim edge silence => the loop cycles without a dead gap.
      const thr = 0.012;
      let s = 0;
      let e = n - 1;
      while (s < n && Math.abs(ch[s]) < thr) s += 64;
      while (e > s && Math.abs(ch[e]) < thr) e -= 64;
      s = Math.max(0, s - 64);
      e = Math.min(n - 1, e + 64);
      const loopStart = s / buf.sampleRate;
      const loopEnd = e + 1 < n ? (e + 1) / buf.sampleRate : 0; // 0 = full

      const entry = { buffer: buf, trim, loopStart, loopEnd };
      this.loopCache.set(url, entry);
      // Only swap the CURRENT voice if this decode is still the active song.
      if (url === this.monsterUrl) this.applyLoopEntry(entry);
      return true;
    } catch {
      if (url === this.monsterUrl) {
        this.monsterTrim = 1;
        this.monsterLoopStart = 0;
        this.monsterLoopEnd = 0;
      }
      return false;
    }
  }

  /**
   * The bot has spawned: start its voice with a slow fade-in. If the file
   * is still decoding, it takes over the moment it lands.
   */
  startMonsterLoop(): void {
    if (!this.ctx || this.monsterOn) return;
    if (this.monsterBuffer) {
      this.beginVoice();
    } else {
      // Maybe the file just wasn't ready earlier — one more shot; if it
      // lands, the voice fades in a beat later.
      void this.ensureMonsterBuffer().then((ok) => {
        if (ok) this.beginVoice();
      });
    }
  }

  /** Actually start the voice (file decoded, hunt underway). */
  private beginVoice(): void {
    if (!this.ctx || this.monsterOn) return;
    this.monsterOn = true;
    this.prevDist = NaN; // doppler needs two samples before it bends
    this.closingSmooth = 0;
    this.monsterRate = 1;
    const now = this.ctx.currentTime;
    this.startFileVoice();
    // Fade the voice in from silence; the per-frame setTargetAtTime in
    // update() then converges to the distance-based level naturally.
    this.monsterGain.gain.cancelScheduledValues(now);
    this.monsterGain.gain.setValueAtTime(0.0001, now);
    this.monsterPan.pan.setValueAtTime(0, now); // don't leak last run's pan
  }

  /** Wire the decoded loop file into the spatial chain. */
  private startFileVoice(): void {
    const ctx = this.ctx;
    if (!ctx || !this.monsterBuffer || this.monsterSrc) return;
    const src = ctx.createBufferSource();
    src.buffer = this.monsterBuffer;
    src.loop = true;
    // Seamless loop window (silence-trimmed) when one was computed.
    if (this.monsterLoopEnd > this.monsterLoopStart) {
      src.loopStart = this.monsterLoopStart;
      src.loopEnd = this.monsterLoopEnd;
    }
    src.playbackRate.value = this.monsterRate;
    src.connect(this.monsterFilter);
    src.start();
    this.monsterSrc = src;
  }

  /** Stop the monster voice (caught / restart). */
  stopMonsterLoop(): void {
    const ctx = this.ctx;
    this.monsterOn = false;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.monsterGain.gain.cancelScheduledValues(t);
    this.monsterGain.gain.setTargetAtTime(0, t, MA.FADE_OUT / 3);
    if (this.monsterSrc) {
      const src = this.monsterSrc;
      this.monsterSrc = null;
      src.stop(t + MA.FADE_OUT + 0.1);
    }
  }

  /** Full reset (fresh run): guarantees no voice survives a restart. */
  resetMonster(): void {
    this.stopMonsterLoop();
  }

  // ===========================================================================
  //  Per-frame update
  // ===========================================================================

  update(opts: AudioUpdateOpts): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // ---- MONSTER VOICE: doppler loudness + pan + muffle + pitch ----------
    this.updateMonsterVoice(opts, now);

    // ---- Faulty-light buzz ------------------------------------------------
    this.buzzGain.gain.setTargetAtTime(opts.buzz * 0.045, now, 0.2);
  }

  /**
   * The heart of the request: positional doppler for the monster's song.
   *   • LOUDNESS falls off with distance (quiet far away, loud up close)
   *   • PITCH rises while it closes in and drops while it falls behind
   *   • PAN puts it left/right relative to where you're looking
   *   • LOWPASS muffles it with distance (extra when it's behind you)
   */
  private updateMonsterVoice(opts: AudioUpdateOpts, now: number): void {
    if (!this.monsterOn) {
      if (this.monsterGain) this.monsterGain.gain.setTargetAtTime(0, now, 0.1);
      return;
    }

    const dist = opts.botDist;

    // ---- True doppler: pitch = f(closing speed) ----------------------------
    // (Guard against non-finite distances — the bot reports Infinity on its
    //  very first frames and after teleports, which would poison the filter.)
    if (
      Number.isFinite(this.prevDist) &&
      Number.isFinite(dist) &&
      !Number.isNaN(this.prevNow) &&
      now > this.prevNow
    ) {
      const dt = now - this.prevNow;
      const closing = clamp((this.prevDist - dist) / dt, -30, 30); // + = it's gaining
      this.closingSmooth = lerp(this.closingSmooth, closing, 0.12);
    }
    this.prevDist = Number.isFinite(dist) ? dist : NaN;
    this.prevNow = now;
    this.monsterRate = clamp(1 + this.closingSmooth * MA.DOPPLER_RATE, MA.RATE_MIN, MA.RATE_MAX);
    if (this.monsterSrc) {
      this.monsterSrc.playbackRate.setTargetAtTime(this.monsterRate, now, 0.25);
    }

    // ---- Doppler loudness: 0 at HEAR_DIST -> GAIN_MAX at FULL_DIST ---------
    const d01 = clamp((MA.HEAR_DIST - dist) / (MA.HEAR_DIST - MA.FULL_DIST), 0, 1);
    // Extra punch in the last meters — it should feel like it's IN your ears.
    // monsterTrim peak-normalizes the file.
    const vol = (Math.pow(d01, 1.35) * 0.82 + Math.pow(d01, 6) * 0.18) * MA.GAIN_MAX * this.monsterTrim;
    this.monsterGain.gain.setTargetAtTime(vol, now, 0.1);

    // ---- Direction: pan left/right + behind-muffling -------------------------
    let pan = 0;
    let behind = false;
    const toX = opts.botX - opts.playerX;
    const toZ = opts.botZ - opts.playerZ;
    const len = Math.hypot(toX, toZ);
    if (len > 1e-4) {
      const ux = toX / len;
      const uz = toZ / len;
      // Camera-space: forward = (fwdX, fwdZ); right = (-fwdZ, fwdX) on XZ.
      const fwdX = opts.fwdX,
        fwdZ = opts.fwdZ;
      const fl = Math.hypot(fwdX, fwdZ) || 1;
      const fx = fwdX / fl,
        fz = fwdZ / fl;
      pan = clamp(ux * -fz + uz * fx, -1, 1) * MA.PAN_MAX;
      behind = ux * fx + uz * fz < 0;
    }
    this.monsterPan.pan.setTargetAtTime(pan, now, 0.08);

    // ---- Distance muffling (+extra behind): far rumble -> near brightness ----
    const cutoff = lerp(MA.FAR_CUTOFF, MA.NEAR_CUTOFF, d01) * (behind ? MA.BEHIND_CUTOFF : 1);
    this.monsterFilter.frequency.setTargetAtTime(clamp(cutoff, 200, 16000), now, 0.12);
  }

  /** DEV/verification snapshot of the monster voice state. */
  get debugMonster(): {
    fileLoaded: boolean;
    active: boolean;
    gain: number;
    pan: number;
    rate: number;
    trim: number;
    loopStart: number;
    loopEnd: number;
  } {
    return {
      fileLoaded: this.monsterBuffer !== null,
      active: this.monsterOn,
      gain: this.monsterGain?.gain.value ?? 0,
      pan: this.monsterPan?.pan.value ?? 0,
      rate: this.monsterRate,
      trim: this.monsterTrim,
      loopStart: this.monsterLoopStart,
      loopEnd: this.monsterLoopEnd,
    };
  }

  // ===========================================================================
  //  One-shots
  // ===========================================================================

  /** Footstep: short, muffled carpet thud (SOUNDS bus). */
  footstep(running: boolean): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 140 + Math.random() * 120;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    const peak = running ? 0.3 : 0.15;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.1);
  }

  /**
   * CAUGHT — the monster's song cuts dead mid-note, the room ducks out, and
   * the JUMPSCARE SCREAM hits: sub drop + hard-clipped descending saws +
   * noise blast (kept from the old sound set by request; everything else
   * from the old set is gone). The scream rides the SOUNDS bus; the duck
   * only touches the room beds, and — unlike the old version — the room
   * bleeds back in on its own afterwards.
   */
  caught(): void {
    this.stopMonsterLoop();
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;

    // Duck the room beds (NOT the whole SOUNDS bus — the scream lives there
    // too). Base is always 1, so the restore needs no saved state.
    const from = this.ambBus.gain.value;
    this.ambBus.gain.cancelScheduledValues(t);
    this.ambBus.gain.setValueAtTime(from, t);
    this.ambBus.gain.linearRampToValueAtTime(0.02, t + 0.05);
    this.ambBus.gain.setValueAtTime(0.02, t + 1.1);
    this.ambBus.gain.linearRampToValueAtTime(1, t + 2.6);

    // Layer 1 — massive sub drop.
    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(130, t);
    boom.frequency.exponentialRampToValueAtTime(26, t + 1.1);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.85, t + 0.03);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    boom.connect(bg).connect(this.sfxBus);
    boom.start(t);
    boom.stop(t + 1.35);

    // Layer 2 — hard-clipped descending saw cluster (the "scream").
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(9);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, t);
    cg.gain.exponentialRampToValueAtTime(0.42, t + 0.02);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    shaper.connect(cg).connect(this.sfxBus);
    for (const detune of [1, 1.012, 0.503]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(740 * detune, t);
      osc.frequency.exponentialRampToValueAtTime(215 * detune, t + 0.85);
      osc.connect(shaper);
      osc.start(t);
      osc.stop(t + 0.95);
    }

    // Layer 3 — noise blast on top.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 240;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.7, t + 0.015);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    src.connect(hp).connect(ng).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.9);
  }

  /** Pause/resume (browser tab hidden, pause menu). */
  suspend(): void {
    void this.ctx?.suspend();
  }
  resume(): void {
    void this.ctx?.resume();
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}

/** Soft/hard clipping curve for the scream's distortion shaper. */
// Typed as Float32Array<ArrayBuffer> to match WaveShaperNode.curve in TS 5.7+.
function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}
