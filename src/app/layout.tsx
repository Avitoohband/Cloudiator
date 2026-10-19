import type { Metadata } from 'next';
import { SkipLink } from '../features/shell/SkipLink';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cloudiator — A life in the arena',
  description: 'Manage your gladiator, plan a day, and follow a shared fantasy world.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><SkipLink />{children}</body></html>;
}
