import type { ItemInstance } from '@contracts/reads';
import { itemAtlas, itemIconFrame, itemStatLines } from './item-presentation';
import styles from './ItemPresentation.module.css';

export function ItemIcon({ catalogId, size = 32 }: { catalogId: string; size?: number }) {
  const frame = itemIconFrame(catalogId);
  if (!frame) {
    return <span aria-hidden="true" data-item-icon="unknown" className={styles.fallback} style={{ width: size, height: size }}>◇</span>;
  }
  const scale = size / frame.w;
  return <span aria-hidden="true" data-item-icon={frame.name} className={styles.sprite} style={{
    width: size,
    height: frame.h * scale,
    backgroundImage: `url(${itemAtlas.url})`,
    backgroundPosition: `${-frame.x * scale}px ${-frame.y * scale}px`,
    backgroundSize: `${itemAtlas.width * scale}px ${itemAtlas.height * scale}px`,
  }} />;
}

export function ItemStats({ item }: { item: Pick<ItemInstance, 'catalogId' | 'stats'> }) {
  return <dl className={styles.stats} data-item-stats="">
    {itemStatLines(item).map(([label, value]) => <div key={label} className={label === 'Weight' ? styles.weight : undefined}>
      <dt>{label}</dt><dd>{value}</dd>
    </div>)}
  </dl>;
}
