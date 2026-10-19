'use client';

// The page's first stop for the keyboard (Task 23.5): "Skip to content" moves the focus to the page's main landmark
// (`#main`, which takes the focus with tabIndex -1), past the camp's rail and corner chip. It moves the focus itself
// instead of following the fragment, so it adds no history entry: a `#main` entry would be one the App Router does not
// know, and a scene's Back to camp walks the camp's own history entries (plan Decision 4).
export function SkipLink() {
  return <a className="skip-link" href="#main" onClick={event => {
    const main = document.getElementById('main');
    if (!main) return;
    event.preventDefault();
    main.focus({ preventScroll: true });
  }}>Skip to content</a>;
}
