import Link from 'next/link';

export default function AuthCallbackPage() {
  return <main id="main" className="callback"><p className="eyebrow">CLOUDIATOR</p><h1>Sign-in is not connected yet.</h1><p>This build cannot complete Google authentication or save online progress.</p><Link className="primary-link" href="/game/">Return to the camp</Link></main>;
}
