import type { Metadata } from 'next';
import './globals.css';
import Image from 'next/image';
import Link from 'next/link';
import { NavLink } from './_components/NavLink';

export const metadata: Metadata = {
  title: 'De Paseo en Fincas · Ops Console',
  description: 'Agent dashboard',
};

const NAV = [
  { href: '/', label: 'Health' },
  { href: '/conversations', label: 'Conversations' },
  { href: '/kanban', label: 'Pipeline' },
  { href: '/traces', label: 'Traces' },
  { href: '/fallbacks', label: 'Fallbacks' },
  { href: '/transcribe-test', label: 'Transcribe' },
  { href: '/settings', label: 'Settings' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <div className="workspace-shell">
          <header className="kb-header">
            <div className="kb-header__left">
              <Link href="/">
                <Image
                  src="/depaseoenfincas-logo.png"
                  alt="De Paseo en Fincas"
                  width={84}
                  height={42}
                  className="kb-logo"
                  priority
                />
              </Link>
              <div>
                <p className="kb-eyebrow">De Paseo en Fincas</p>
                <h1 className="kb-title">Ops Console</h1>
              </div>
            </div>
            <div className="kb-header__right">
              <nav className="kb-nav">
                {NAV.map((item) => (
                  <NavLink key={item.href} href={item.href} label={item.label} />
                ))}
              </nav>
            </div>
          </header>

          <div className="kb-status-bar">
            <div className="chat-panel__badge">v2 — agent rewrite</div>
            <div className="chat-panel__badge">Render · Vercel · Supabase</div>
            <div className="chat-panel__badge">Gemini Flash</div>
          </div>

          <main className="workspace-content">{children}</main>
        </div>
      </body>
    </html>
  );
}
