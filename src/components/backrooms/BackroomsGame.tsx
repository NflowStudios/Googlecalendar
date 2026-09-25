'use client';

/**
 * ============================================================================
 *  BackroomsGame.tsx — React shell around the GameEngine.
 * ============================================================================
 *  React handles ONLY the UI overlays (menu, HUD, pause, jumpscare/death);
 *  all 3D work lives in /src/game/* modules, completely framework-agnostic —
 *  you could drop them into any other setup (Vite, plain TS, etc.).
 *
 *  Performance rule: the engine calls `onFrame` 60x/s. That callback ONLY
 *  writes to DOM refs (stamina bar width, proximity values) — it never calls
 *  setState, so React never re-renders during gameplay.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { GameEngine } from '@/game/GameEngine';
import type { VolumeSettings } from '@/game/AudioManager';
import { LEVELS, DEFAULT_LEVEL_ID, getLevel } from '@/game/levels';
import { formatTime } from '@/game/utils';

type Phase = 'menu' | 'playing' | 'paused' | 'dead';

const TIPS = [
  'It hunts around walls now. Break its line of sight to buy time.',
  'Sprinting outruns it. Walking does not. Manage your stamina.',
  'Listen for its song. The louder it grows, the closer it is.',
  'It sounds sharper as it gains on you — the pitch bends when it closes in.',
  'Every thirty seconds another one appears. There is no limit.',
  'The buzzing lights are not the only thing watching.',
  'Distance is temporary. They always catch up.',
];

// ---- Volume settings (persisted in localStorage) -----------------------------
const VOLUME_KEY = 'backrooms-volumes';
const DEFAULT_VOLUMES: VolumeSettings = { master: 0.9, sounds: 1, music: 1 };

function loadVolumes(): VolumeSettings {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (!raw) return { ...DEFAULT_VOLUMES };
    const v = JSON.parse(raw) as Partial<VolumeSettings>;
    const num = (x: unknown, fallback: number) =>
      typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : fallback;
    return {
      master: num(v.master, DEFAULT_VOLUMES.master),
      sounds: num(v.sounds, DEFAULT_VOLUMES.sounds),
      music: num(v.music, DEFAULT_VOLUMES.music),
    };
  } catch {
    return { ...DEFAULT_VOLUMES };
  }
}

/**
 * LEVELS — the level browser. Each card shows the level's code, name and
 * a short description; clicking selects it (the PLAY button and the menu
 * backdrop react immediately). The selected card is highlighted.
 */
function LevelBrowser({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="w-[26rem] space-y-3 border border-amber-500/25 bg-black/70 px-6 py-6 backdrop-blur-sm">
      <p className="text-center text-[10px] tracking-[0.4em] text-amber-100/40">LEVELS</p>
      {LEVELS.map((l) => {
        const selected = l.id === selectedId;
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => onSelect(l.id)}
            className={`block w-full border px-5 py-4 text-left transition-colors ${
              selected
                ? 'border-amber-400/70 bg-amber-500/15'
                : 'border-amber-500/20 bg-transparent hover:border-amber-500/45 hover:bg-amber-500/5'
            }`}
          >
            <div className="flex items-baseline justify-between">
              <span
                className={`text-[11px] font-bold tracking-[0.3em] ${
                  selected ? 'text-amber-200' : 'text-amber-100/70'
                }`}
              >
                {l.code}
              </span>
              {selected && (
                <span className="text-[9px] tracking-[0.3em] text-amber-300/80">SELECTED</span>
              )}
            </div>
            <span
              className={`mt-1 block text-sm font-black tracking-[0.15em] ${
                selected ? 'text-amber-100' : 'text-amber-100/60'
              }`}
            >
              {l.name}
            </span>
            <span className="mt-1.5 block text-[11px] leading-relaxed text-amber-100/40">
              {l.blurb}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The three-slider sound mixer. Lives on the home screen (behind the
 * SETTINGS toggle) and on the pause screen:
 *   MASTER — everything you hear
 *   SOUNDS — the room: fluorescent hum, drone, buzzing lights, your footsteps
 *   MUSIC  — the monster's song (its looped chase sound)
 */
function VolumePanel({
  volumes,
  onChange,
}: {
  volumes: VolumeSettings;
  onChange: (v: VolumeSettings) => void;
}) {
  const rows: { key: keyof VolumeSettings; label: string; hint: string }[] = [
    { key: 'master', label: 'MASTER', hint: 'everything you hear' },
    { key: 'sounds', label: 'SOUNDS', hint: 'room hum · footsteps' },
    { key: 'music', label: 'MUSIC', hint: 'the monster\u2019s song' },
  ];
  return (
    <div className="w-80 space-y-4 border border-amber-500/25 bg-black/60 px-7 py-6 backdrop-blur-sm">
      <p className="text-center text-[10px] tracking-[0.4em] text-amber-100/40">SOUND</p>
      {rows.map(({ key, label, hint }) => (
        <div key={key}>
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] tracking-[0.3em] text-amber-200/80">{label}</span>
            <span className="text-[10px] tabular-nums text-amber-100/50">
              {Math.round(volumes[key] * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volumes[key]}
            aria-label={`${label} volume`}
            onChange={(e) => onChange({ ...volumes, [key]: Number(e.target.value) })}
            className="mt-2 w-full accent-amber-400"
          />
          <p className="mt-1 text-[9px] tracking-[0.2em] text-amber-100/30">{hint.toUpperCase()}</p>
        </div>
      ))}
    </div>
  );
}

export default function BackroomsGame() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const staminaRef = useRef<HTMLDivElement>(null);
  const vignetteRef = useRef<HTMLDivElement>(null);
  const threatRef = useRef<HTMLParagraphElement>(null);

  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<Phase>('menu');
  const [survivedMs, setSurvivedMs] = useState(0);
  const [showCard, setShowCard] = useState(false);
  const [runFlash, setRunFlash] = useState(false);
  const [hint, setHint] = useState(false);
  const [tip, setTip] = useState(TIPS[0]);
  /** Home-screen settings panel toggle. */
  const [showSettings, setShowSettings] = useState(false);
  /** Home-screen level browser toggle. */
  const [showLevels, setShowLevels] = useState(false);
  /** The level the PLAY button will enter (defaults to Level 0). */
  const [levelId, setLevelId] = useState(DEFAULT_LEVEL_ID);
  /** The three mixer sliders (master / sounds / music). */
  const [volumes, setVolumesState] = useState<VolumeSettings>({ ...DEFAULT_VOLUMES });
  /** Mirror of `volumes` readable from the engine-mount effect without deps. */
  const volumesRef = useRef<VolumeSettings>({ ...DEFAULT_VOLUMES });

  /** The level selected in the browser (drives button text + jumpscare img). */
  const level = getLevel(levelId);

  // ---- Mount / unmount the engine --------------------------------------------
  useEffect(() => {
    let disposed = false;
    let engine: GameEngine | null = null;

    (async () => {
      // Dynamic import keeps three.js out of the server bundle.
      const { GameEngine: GE } = await import('@/game/GameEngine');
      if (disposed || !containerRef.current) return;
      engine = await GE.create(containerRef.current, {
        onDeath: (ms) => {
          setSurvivedMs(ms);
          setTip(TIPS[Math.floor(Math.random() * TIPS.length)]);
          setShowCard(false);
          setPhase('dead');
        },
        onBotSpawned: () => {
          setRunFlash(true);
          window.setTimeout(() => setRunFlash(false), 2600);
        },
        onPause: () => setPhase('paused'),
        onMenu: () => {
          setPhase('menu');
          setShowCard(false);
          setRunFlash(false);
          setHint(false);
        },
        onFrame: (stamina01, proximity01, botCount) => {
          const el = staminaRef.current;
          if (el) {
            el.style.width = `${Math.max(3, stamina01 * 100)}%`;
            el.style.opacity = stamina01 > 0.999 ? '0.35' : '1';
          }
          // Horde counter — how many are hunting right now (blank during
          // the grace period, before the first one materializes).
          const th = threatRef.current;
          if (th) {
            const label = botCount > 0 ? `${botCount} HUNTING` : '';
            if (th.textContent !== label) th.textContent = label;
          }
          // Red danger vignette — SUBTLE on purpose: edges only, the center
          // of your vision stays perfectly clear so you can always see the
          // bot coming.
          const v = vignetteRef.current;
          if (v) v.style.opacity = String(proximity01 * 0.55);
        },
      });
      engineRef.current = engine;
      // Apply whatever volumes were restored from localStorage below.
      engine.audio.setVolumes(volumesRef.current);
      setReady(true);
    })();

    return () => {
      disposed = true;
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  // ---- Restore persisted volume settings (post-mount: localStorage is
  //      unavailable during SSR prerendering) -----------------------------------
  useEffect(() => {
    const v = loadVolumes();
    volumesRef.current = v;
    setVolumesState(v);
    engineRef.current?.audio.setVolumes(v);
  }, []);

  // ---- Jumpscare -> death card timing -----------------------------------------
  useEffect(() => {
    if (phase === 'dead' && !showCard) {
      const id = window.setTimeout(() => setShowCard(true), 1250);
      return () => window.clearTimeout(id);
    }
  }, [phase, showCard]);

  // ---- Actions --------------------------------------------------------------------
  const play = useCallback(() => {
    engineRef.current?.beginPlay(levelId);
    setPhase('playing');
    setShowCard(false);
    setHint(true);
    window.setTimeout(() => setHint(false), 12000);
  }, [levelId]);

  /** Pause / death screen "back to the main menu" button. */
  const toMenu = useCallback(() => {
    engineRef.current?.returnToMenu();
  }, []);

  const resume = useCallback(() => {
    engineRef.current?.resume();
    setPhase('playing');
  }, []);

  /** Any slider moved: apply live, remember it, persist it. */
  const applyVolumes = useCallback((v: VolumeSettings) => {
    volumesRef.current = v;
    setVolumesState(v);
    engineRef.current?.audio.setVolumes(v);
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify(v));
    } catch {
      // Private mode / storage full — settings just won't persist.
    }
  }, []);

  return (
    <main
      className={`relative h-screen w-screen select-none overflow-hidden bg-black ${
        phase === 'playing' ? 'cursor-none' : ''
      }`}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 3D canvas mounts here */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Red danger vignette (edges only — center vision stays clear) */}
      <div
        ref={vignetteRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 52%, rgba(130, 0, 0, 0.5) 100%)',
        }}
      />

      {/* ======================= IN-GAME HUD ======================= */}
      {phase === 'playing' && (
        <div className="pointer-events-none absolute inset-0 z-10">
          {/* Horde counter (how many monsters are hunting you) */}
          <p
            ref={threatRef}
            aria-live="polite"
            className="absolute top-5 left-1/2 -translate-x-1/2 text-[10px] font-bold tracking-[0.35em] text-red-400/80"
          />

          {/* Stamina bar */}
          <div className="absolute bottom-6 left-1/2 w-60 -translate-x-1/2">
            <div className="h-1.5 w-full overflow-hidden rounded-full border border-amber-900/50 bg-black/60">
              <div
                ref={staminaRef}
                className="h-full rounded-full bg-amber-400/90"
                style={{ width: '100%' }}
              />
            </div>
          </div>

          {/* Controls hint (first seconds of a run) */}
          {hint && (
            <p className="absolute bottom-12 left-1/2 -translate-x-1/2 animate-pulse text-[11px] tracking-[0.3em] text-amber-200/50">
              WASD MOVE &middot; SHIFT SPRINT &middot; MOUSE LOOK &middot; ESC PAUSE
            </p>
          )}

          {/* "RUN." flash when the bot spawns */}
          {runFlash && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="run-flash text-7xl font-black tracking-[0.35em] text-red-600 drop-shadow-[0_0_25px_rgba(255,0,0,0.6)]">
                RUN
              </span>
            </div>
          )}
        </div>
      )}

      {/* ============================ MENU ============================ */}
      {phase === 'menu' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gradient-to-b from-black/85 via-black/55 to-black/90 px-6 text-center">
          <p className="text-[11px] tracking-[0.55em] text-amber-300/70">A NEXTBOTS EXPERIENCE</p>
          <h1
            className="title-flicker mt-3 text-6xl font-black tracking-tight text-amber-100 md:text-8xl"
            style={{ textShadow: '0 0 35px rgba(255, 200, 80, 0.35)' }}
          >
            THE BACKROOMS
          </h1>
          <p className="mt-2 text-[10px] tracking-[0.45em] text-amber-100/40">
            {level.code} &mdash; {level.name} SELECTED
          </p>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-amber-100/60">
            You noclipped out of reality. The hum. The yellow. Something else
            is in here with you &mdash; and it never stops hunting.
          </p>

          <Button
            size="lg"
            disabled={!ready}
            onClick={play}
            className="mt-10 border border-amber-500/40 bg-amber-500/10 text-amber-200 tracking-[0.3em] hover:bg-amber-500/25"
          >
            {ready ? `ENTER ${level.code}` : 'LOADING\u2026'}
          </Button>

          {/* Level browser + sound settings toggles */}
          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setShowLevels((s) => !s);
                setShowSettings(false);
              }}
              className={`border px-5 py-1.5 text-[10px] tracking-[0.3em] transition-colors ${
                showLevels
                  ? 'border-amber-400/60 text-amber-200'
                  : 'border-amber-500/25 bg-transparent text-amber-100/50 hover:border-amber-500/50 hover:text-amber-100/85'
              }`}
            >
              {showLevels ? 'HIDE LEVELS' : 'LEVELS'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowSettings((s) => !s);
                setShowLevels(false);
              }}
              className={`border px-5 py-1.5 text-[10px] tracking-[0.3em] transition-colors ${
                showSettings
                  ? 'border-amber-400/60 text-amber-200'
                  : 'border-amber-500/25 bg-transparent text-amber-100/50 hover:border-amber-500/50 hover:text-amber-100/85'
              }`}
            >
              {showSettings ? 'HIDE SETTINGS' : 'SETTINGS'}
            </button>
          </div>
          {showLevels && (
            <div className="mt-4">
              <LevelBrowser
                selectedId={levelId}
                onSelect={(id) => {
                  setLevelId(id);
                  // Preview the selected level's maze as the new menu backdrop.
                  engineRef.current?.previewLevel(id);
                }}
              />
            </div>
          )}
          {showSettings && (
            <div className="mt-4">
              <VolumePanel volumes={volumes} onChange={applyVolumes} />
            </div>
          )}

          <div className="mt-9 grid grid-cols-3 gap-x-8 text-[11px] tracking-widest text-amber-100/45">
            <span>WASD &mdash; MOVE</span>
            <span>SHIFT &mdash; SPRINT</span>
            <span>MOUSE &mdash; LOOK</span>
          </div>

          <p className="mt-7 text-[10px] tracking-[0.3em] text-amber-100/30">
            HEADPHONES RECOMMENDED &middot; DESKTOP &amp; MOUSE REQUIRED
          </p>
        </div>
      )}

      {/* =========================== PAUSED =========================== */}
      {phase === 'paused' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 px-6 text-center">
          <h2 className="text-4xl font-black tracking-[0.35em] text-amber-100">PAUSED</h2>
          <p className="mt-3 text-[10px] tracking-[0.3em] text-amber-100/40">
            IT IS STILL OUT THERE
          </p>

          {/* Mixer stays reachable mid-hunt — retune and dive back in. */}
          <div className="mt-7">
            <VolumePanel volumes={volumes} onChange={applyVolumes} />
          </div>

          <Button
            size="lg"
            onClick={resume}
            className="mt-8 border border-amber-500/40 bg-amber-500/10 tracking-[0.3em] text-amber-200 hover:bg-amber-500/25"
          >
            RESUME
          </Button>

          <button
            type="button"
            onClick={toMenu}
            className="mt-4 border border-amber-500/25 bg-transparent px-5 py-1.5 text-[10px] tracking-[0.3em] text-amber-100/50 transition-colors hover:border-amber-500/50 hover:text-amber-100/85"
          >
            RETURN TO MENU
          </button>
        </div>
      )}

      {/* ======================= CAUGHT / DEATH ======================= */}
      {phase === 'dead' && !showCard && (
        <div className="absolute inset-0 z-30 overflow-hidden bg-black">
          {/* NOTE: no Tailwind -translate-x/-y classes here! Tailwind v4 uses
              the standalone `translate` CSS property, which STACKS with the
              `transform` in the jumpscare keyframes — the double offset used
              to shove the monster halfway off the top-left of the screen.
              The keyframes themselves handle the centering (translate(-50%,
              -50%) in every frame), and the inline transform below is a
              fallback in case the animation ever fails to apply. */}
          <img
            src={level.monsterBright}
            alt="The Nextbot got you"
            className="jumpscare absolute left-1/2 top-1/2 h-[115vh] w-auto object-contain"
            style={{ transform: 'translate(-50%, -50%)' }}
          />
          <div className="absolute inset-0 bg-red-800/25 mix-blend-screen" />
        </div>
      )}

      {phase === 'dead' && showCard && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/95 px-6 text-center">
          <h2
            className="text-5xl font-black tracking-[0.2em] text-red-600 md:text-6xl"
            style={{ textShadow: '0 0 30px rgba(200, 0, 0, 0.5)' }}
          >
            IT CAUGHT YOU
          </h2>
          <p className="mt-5 text-sm tracking-[0.25em] text-amber-100/70">
            YOU SURVIVED {formatTime(survivedMs)}
          </p>
          <p className="mt-6 max-w-sm text-xs italic leading-relaxed text-amber-100/40">
            &ldquo;{tip}&rdquo;
          </p>
          <Button
            size="lg"
            onClick={play}
            className="mt-10 border border-red-700/50 bg-red-800/20 tracking-[0.3em] text-red-200 hover:bg-red-800/40"
          >
            TRY AGAIN
          </Button>

          <button
            type="button"
            onClick={toMenu}
            className="mt-4 border border-amber-500/25 bg-transparent px-5 py-1.5 text-[10px] tracking-[0.3em] text-amber-100/50 transition-colors hover:border-amber-500/50 hover:text-amber-100/85"
          >
            RETURN TO MENU
          </button>
        </div>
      )}
    </main>
  );
}
