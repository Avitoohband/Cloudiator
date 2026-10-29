/**
 * A Rest's words (`restHint`, `restingGainText`) with the gain ("+30") emphasised, as the approved mockup shows it. The text read out
 * and copied is the words themselves, unchanged: only the number is wrapped.
 */
export function RestGainText({ text }: { text: string }) {
  return <>{text.split(/(\+\d+)/).map((part, index) => index % 2 === 1 ? <b key={index}>{part}</b> : part)}</>;
}
