// Words for the titles: names, a locked title's progress, and a season place. The rules and thresholds are the shared catalog's
// (@domain/titles); the counts come from the owner's reads (OwnerState.titleProgress). Nothing here decides who has earned what.
import type { LeagueId } from '@contracts/commands';
import type { PrestigeAward } from '@contracts/reads';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { titleById, type TitleDefinition } from '@domain/titles';
import { titleText } from '../seasons/season-text';

export type TitleProgress = Readonly<Record<string, number>>;

/** The picker's and the menus' words for wearing nothing. */
export const NO_TITLE = 'No title';

export function titleName(id: unknown): string | null {
  return titleById(id)?.name ?? null;
}

/** A fighter's shown title (its name, as the lists show it) by gladiator id; null for none or one this client does not know. */
export type TitleLookup = (gladiatorId: string) => string | null;

/** A lookup over actors that carry a worn title id (the camp's world actors, or a read's answer by id): unknown ids and junk show nothing. */
export function titleLookupOf(source: readonly { gladiatorId: string; title?: unknown }[] | Readonly<Record<string, unknown>> | null | undefined): TitleLookup {
  const byId = new Map<string, string | null>();
  if (Array.isArray(source)) for (const actor of source) byId.set(actor.gladiatorId, titleName(actor.title));
  else if (source) for (const [id, title] of Object.entries(source)) byId.set(id, titleName(title));
  return id => byId.get(id) ?? null;
}

/**
 * The worn title as the profile card words it: null for none or an id this client does not know; Champion names the latest first place of
 * the profile's prestige ("Champion · Season 2 Gold") when it has one, else the plain name. The lists and the camp carry no prestige and
 * show `titleName`.
 */
export function wornTitleText(id: unknown, prestige: readonly PrestigeAward[]): string | null {
  const name = titleName(id);
  if (name === null) return null;
  if (id === 'champion') {
    const latest = [...prestige].filter(award => award.title === 'champion').sort((p, q) => Number(q.seasonId) - Number(p.seasonId))[0];
    if (latest) return titleText(latest);
  }
  return name;
}

const count = (n: number) => n.toLocaleString('en-US');

/** The expedition trips a title counts, with the level each opens at (the catalog's required levels). */
const TRIP_LEVEL: Partial<Record<TitleDefinition['measure'], number>> = {
  'woodland-won': CATALOG_V1.expeditions.woodland.requiredLevel,
  'outpost-won': CATALOG_V1.expeditions.outpost.requiredLevel,
  'mountain-won': CATALOG_V1.expeditions.mountain.requiredLevel,
};

/** A locked title's progress line in the picker: "34 of 50", "Best run 3 of 5", "Opens at level 5". */
export function progressText(title: TitleDefinition, progress: TitleProgress, level: number): string {
  const value = progress[title.measure] ?? 0;
  const opens = TRIP_LEVEL[title.measure];
  if (opens !== undefined && value === 0 && level < opens) return `Opens at level ${opens}`;
  switch (title.measure) {
    case 'arena-best-streak': return `Best run ${count(value)} of ${count(title.threshold)}`;
    case 'tiers-of-one': return `Best item: ${count(value)} of ${count(title.threshold)} tiers`;
    case 'rarities-of-one': return `Best item: ${count(value)} of ${count(title.threshold)} rarities`;
    case 'days-in-camp': return `${count(value)} of ${count(title.threshold)} days`;
    case 'banner': return `Renown shop · ${count(CATALOG_V1.cosmetics.banner.renownPrice)} renown`;
    case 'founder': return 'Only gladiators made in Season 1';
    default: return `${count(value)} of ${count(title.threshold)}`;
  }
}

/** How full the progress bar is: value ÷ threshold, at most 1. */
export function progressShare(title: TitleDefinition, progress: TitleProgress): number {
  return Math.min(1, (progress[title.measure] ?? 0) / title.threshold);
}

const ORDINAL = { 1: '1st', 2: '2nd', 3: '3rd' } as const;

/** A season title's small line in a notice: "3rd in Season 1 · Bronze" (the season index counts from 0). */
export function placeInSeasonText(detail: { seasonIndex: number; league: LeagueId; place: 1 | 2 | 3 }): string {
  const league = detail.league.charAt(0).toUpperCase() + detail.league.slice(1);
  return `${ORDINAL[detail.place]} in Season ${detail.seasonIndex + 1} · ${league}`;
}
