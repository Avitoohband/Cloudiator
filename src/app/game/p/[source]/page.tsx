import { GameEntry } from '../../GameEntry';
import { PROMO_SOURCES, type PromoSource } from '../../../../features/promo/source';

export const dynamicParams = false;

export function generateStaticParams() {
  return PROMO_SOURCES.map(source => ({ source }));
}

export default async function PromoPage({ params }: { params: Promise<{ source: PromoSource }> }) {
  const { source } = await params;
  return <GameEntry source={source} />;
}
