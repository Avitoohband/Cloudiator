import Link from 'next/link';

export default function Home() {
  return <main id="main" className="landing">
    <div className="brand">CLOUDIATOR <span>CHRONICLES OF THE ARENA</span></div>
    <p className="eyebrow">ONE GLADIATOR. A WORLD OF POSSIBILITIES.</p>
    <h1>A life beyond<br /><em>the arena.</em></h1>
    <p className="lead">Plan your days. Forge your fighter. Follow a shared fantasy world, one adventure at a time.</p>
    <Link className="primary-link" href="/game/">Enter the camp <span aria-hidden="true">→</span></Link>
    <p className="muted">Sign in with Google and create your gladiator. The shared camp is under construction.</p>
    <div className="landing-cards">
      <article><span className="card-number">01</span><h2>Choose your path</h2><p>A berserker, guardian, or duelist. Your weapon. Your style.</p></article>
      <article><span className="card-number">02</span><h2>Make every day count</h2><p>Training, expeditions, arena battles, and well-earned rest.</p></article>
      <article><span className="card-number">03</span><h2>Build your legend</h2><p>A shared camp, rival fighters, and a place in the standings.</p></article>
    </div>
  </main>;
}
