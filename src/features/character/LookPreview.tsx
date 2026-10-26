'use client';

// The live preview of the creation dialog's look step: the gladiator as the camp draws it with no gear, on a small green
// ground with its name above. A DOM sprite, no Phaser: one element per layer, each cropped from the gladiator atlas by its
// frame rectangle and tinted by multiply (see `layerStyle`). Decorative: the look is said in words by `LookPicker`.
// The idle animation loops four frames at 260 ms; under `prefers-reduced-motion` it is one still frame.
import { useEffect, useState } from 'react';
import type { Appearance } from '@domain/appearance';
import rawManifest from '../../../public/assets/manifest.json';
import {
  PREVIEW_ANCHOR, PREVIEW_FRAME_MS, PREVIEW_SCALE, frameId, hexColour, layerStyle, nextFrame, previewLayers,
} from './look-picker';
import styles from './LookPicker.module.css';

type Atlas = { frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>; meta: { size: { w: number; h: number } } };
/** The atlas image, served as the game serves it (`assetBase` '/assets/'). */
const IMAGE = `/assets/${(rawManifest as unknown as { atlases: { gladiators: { image: string } } }).atlases.gladiators.image}`;
/** Where the feet stand on the ground, from the top of the stage, in screen pixels. */
const FEET_Y = 150;

let atlasLoad: Promise<Atlas> | null = null;
/** The frame table, loaded once when the first dialog opens (a separate chunk, so the camp does not carry it). */
function loadAtlas(): Promise<Atlas> {
  atlasLoad ??= import('../../../public/assets/actors/gladiators.json').then(module => module.default as unknown as Atlas)
    .catch(error => { atlasLoad = null; throw error; });
  return atlasLoad;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function LookPreview({ look, name }: { look: Appearance; name: string }) {
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [frame, setFrame] = useState(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    let live = true;
    loadAtlas().then(table => { if (live) setAtlas(table); }, () => { /* The art did not load: the ground and the name stay. */ });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    setFrame(0);
    if (reduced) return;
    const timer = setInterval(() => setFrame(current => nextFrame(current, false)), PREVIEW_FRAME_MS);
    return () => clearInterval(timer);
  }, [reduced]);
  const label = name.trim() || 'Your gladiator';
  return <div className={styles.stage} data-testid="look-preview" data-frame={frame} data-motion={reduced ? 'still' : 'animated'} aria-hidden="true">
    <span className={styles.stageName}>{label}</span>
    <div className={styles.sprite} style={{ top: FEET_Y - PREVIEW_ANCHOR.y * PREVIEW_SCALE, marginLeft: -PREVIEW_ANCHOR.x * PREVIEW_SCALE }}>
      {atlas && previewLayers(look).map(layer => {
        const rect = atlas.frames[frameId(layer.id, frame)]?.frame;
        if (!rect) return null;
        return <span key={layer.id} className={styles.layer} data-layer={layer.id} data-tint={layer.tint === null ? undefined : hexColour(layer.tint)}
          style={layerStyle(layer, rect, atlas.meta.size, IMAGE)} />;
      })}
    </div>
  </div>;
}
