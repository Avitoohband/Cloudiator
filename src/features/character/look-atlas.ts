// The gladiator atlas for the DOM sprites (the creation dialog's look preview and the profile card's portrait): its frame table, loaded
// once on first use as a separate chunk (so the camp does not carry it), and the image served as the game serves it.
import rawManifest from '../../../public/assets/manifest.json';

export type Atlas = { frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>; meta: { size: { w: number; h: number } } };
/** The atlas image, served as the game serves it (`assetBase` '/assets/'). */
export const ATLAS_IMAGE = `/assets/${(rawManifest as unknown as { atlases: { gladiators: { image: string } } }).atlases.gladiators.image}`;

let atlasLoad: Promise<Atlas> | null = null;
/** The frame table, loaded once (a failed load is asked again next time). */
export function loadAtlas(): Promise<Atlas> {
  atlasLoad ??= import('../../../public/assets/actors/gladiators.json').then(module => module.default as unknown as Atlas)
    .catch(error => { atlasLoad = null; throw error; });
  return atlasLoad;
}
