// Deterministic grid pathfinding over a map's walkable tiles (8 directions, no corner cutting).
import type { MapData, TilePoint } from './assets';

export type Grid = { width: number; height: number; walkable(x: number, y: number): boolean };

export function gridFromMap(map: Pick<MapData, 'width' | 'height' | 'walkable'>): Grid {
  return {
    width: map.width,
    height: map.height,
    walkable: (x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height && map.walkable[y][x] === '1',
  };
}

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** A* from `from` to `to`; null when either end is blocked or no route exists. */
export function findPath(grid: Grid, from: TilePoint, to: TilePoint): TilePoint[] | null {
  if (!grid.walkable(from.x, from.y) || !grid.walkable(to.x, to.y)) return null;
  const key = (x: number, y: number) => y * grid.width + x;
  const goal = key(to.x, to.y);
  const g = new Map<number, number>([[key(from.x, from.y), 0]]);
  const parent = new Map<number, number>();
  const open: { k: number; f: number; h: number }[] = [];
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - to.x);
    const dy = Math.abs(y - to.y);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const push = (k: number, f: number, hv: number) => {
    open.push({ k, f, h: hv });
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (open[p].f < f || (open[p].f === f && open[p].h <= hv)) break;
      [open[p], open[i]] = [open[i], open[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = open[0];
    const last = open.pop()!;
    if (open.length) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        const less = (a: number, b: number) => open[a].f < open[b].f || (open[a].f === open[b].f && open[a].h < open[b].h);
        if (l < open.length && less(l, m)) m = l;
        if (r < open.length && less(r, m)) m = r;
        if (m === i) break;
        [open[m], open[i]] = [open[i], open[m]];
        i = m;
      }
    }
    return top;
  };
  push(key(from.x, from.y), h(from.x, from.y), h(from.x, from.y));
  const closed = new Set<number>();
  while (open.length) {
    const { k } = pop();
    if (closed.has(k)) continue;
    if (k === goal) {
      const path: TilePoint[] = [];
      for (let c: number | undefined = k; c !== undefined; c = parent.get(c)) path.push({ x: c % grid.width, y: Math.floor(c / grid.width) });
      return path.reverse();
    }
    closed.add(k);
    const x = k % grid.width;
    const y = Math.floor(k / grid.width);
    for (const [dx, dy, cost] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!grid.walkable(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!grid.walkable(x + dx, y) || !grid.walkable(x, y + dy))) continue;
      const nk = key(nx, ny);
      const ng = (g.get(k) ?? 0) + cost;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        parent.set(nk, k);
        const hv = h(nx, ny);
        push(nk, ng + hv, hv);
      }
    }
  }
  return null;
}

/** Total length of a tile path in tiles. */
export function pathLength(path: TilePoint[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return total;
}

/** Position along a path after walking `distance` tiles, at tile centres. */
export function pointAlong(path: TilePoint[], distance: number): { x: number; y: number; dx: number; dy: number; done: boolean } {
  if (path.length === 1) return { x: path[0].x + 0.5, y: path[0].y + 0.5, dx: 0, dy: 0, done: true };
  let left = Math.max(0, distance);
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len) {
      const t = left / len;
      return { x: a.x + (b.x - a.x) * t + 0.5, y: a.y + (b.y - a.y) * t + 0.5, dx: b.x - a.x, dy: b.y - a.y, done: false };
    }
    left -= len;
  }
  const end = path[path.length - 1];
  const prev = path[path.length - 2];
  return { x: end.x + 0.5, y: end.y + 0.5, dx: end.x - prev.x, dy: end.y - prev.y, done: true };
}
