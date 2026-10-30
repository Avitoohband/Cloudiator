'use client';

// The profile card's portrait (Task 11c; Patch A spec, "A richer profile card"): the gladiator as the camp draws it, gear included
// (`actorLayers`, so the legacy look too), drawn as the creation preview draws its look: a DOM sprite of the gladiator atlas, the idle
// loop facing south-east (a still frame under reduced motion), on the preview's green ground, at scale 2. Decorative: the name and
// the class line say who it is.
import { useEffect, useState } from 'react';
import type { PublicActor } from '@contracts/reads';
import { PREVIEW_ANCHOR, PREVIEW_FRAME_MS, actorLayers, frameId, hexColour, layerStyle, nextFrame } from './look-picker';
import { ATLAS_IMAGE, loadAtlas, type Atlas } from './look-atlas';
import { useReducedMotion } from './LookPreview';
import styles from './ProfileCard.module.css';

/** Art pixels to screen pixels in the portrait. */
const SCALE = 2;

export function ActorPortrait({ actor }: { actor: Pick<PublicActor, 'gladiatorId' | 'appearance' | 'equipmentSilhouettes'> }) {
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [frame, setFrame] = useState(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    let live = true;
    loadAtlas().then(table => { if (live) setAtlas(table); }, () => { /* The art did not load: the ground stays. */ });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    setFrame(0);
    if (reduced) return;
    const timer = setInterval(() => setFrame(current => nextFrame(current, false)), PREVIEW_FRAME_MS);
    return () => clearInterval(timer);
  }, [reduced]);
  const layers = actorLayers(actor.appearance ?? null, actor.gladiatorId, actor.equipmentSilhouettes);
  return <div className={styles.look} data-testid="profile-look" data-frame={frame} aria-hidden="true">
    <div className={styles.lookSprite} style={{ marginLeft: -PREVIEW_ANCHOR.x * SCALE, marginTop: -PREVIEW_ANCHOR.y * SCALE }}>
      {atlas && layers.map(layer => {
        const rect = atlas.frames[frameId(layer.id, frame)]?.frame;
        if (!rect) return null;
        return <span key={layer.id} className={styles.lookLayer} data-layer={layer.id} data-tint={layer.tint === null ? undefined : hexColour(layer.tint)}
          style={layerStyle(layer, rect, atlas.meta.size, ATLAS_IMAGE, SCALE)} />;
      })}
    </div>
  </div>;
}
