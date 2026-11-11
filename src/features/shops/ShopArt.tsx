import type { CSSProperties } from 'react';
import atlas from '../../../public/assets/ui/icons.json';
import { itemAtlas } from '../inventory/item-presentation';
import type { ShopCurrency } from './shop-offers';
import styles from './ShopPanel.module.css';

/** The atlas coin (gold) or laurel (renown) beside a price. */
export function CurrencyIcon({ currency, size = 12 }: { currency: ShopCurrency; size?: number }) {
  const frame = atlas.frames[currency].frame, scale = size / frame.w;
  return <span aria-hidden="true" data-currency-icon={currency} className={styles.coin} style={{
    width: size,
    height: frame.h * scale,
    backgroundImage: `url(${itemAtlas.url})`,
    backgroundPosition: `${-frame.x * scale}px ${-frame.y * scale}px`,
    backgroundSize: `${itemAtlas.width * scale}px ${itemAtlas.height * scale}px`,
  }} />;
}

/** The Arena banner's picture. The icon atlas has no banner frame, so it is drawn in CSS (no new art file). */
export function BannerArt({ size = 32 }: { size?: number }) {
  return <span aria-hidden="true" data-item-icon="banner" className={styles.bannerArt} style={{ '--banner-size': `${size}px` } as CSSProperties} />;
}
