/** Player-facing reasons for a refused build command. */
export function buildRefusal(code: string): string {
  return code === 'processing' ? 'The world is processing previous results. Retry shortly.'
    : code === 'conflict' ? 'Your build changed. The latest state has been loaded; review and try again.'
      : code === 'invalid' ? 'That build change is no longer possible. Your build has been reloaded.'
        : code === 'unavailable' ? 'This change could not be confirmed. Retry to confirm the same request.'
          : code === 'insufficient-funds' ? 'Not enough available money for this reservation.' : `Build change rejected: ${code}.`;
}
