// Avi's disclaimer for changing a look (spec Goal 4), said by the look patch note and by the change-look dialog: the one place the words live.

/** "Free for now, as often as you like. This is temporary: changing your look will cost something in the future." */
export function LookDisclaimer({ id, className }: { id?: string; className?: string }) {
  return <p id={id} className={className}><strong>Free for now</strong>, as often as you like. This is temporary: changing your look will cost something in the future.</p>;
}
