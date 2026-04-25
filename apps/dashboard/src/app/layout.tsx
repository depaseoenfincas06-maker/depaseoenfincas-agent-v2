import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'De Paseo en Fincas — Admin',
  description: 'Agent dashboard',
};

const NAV = [
  { href: '/', label: 'Health' },
  { href: '/conversations', label: 'Conversations' },
  { href: '/kanban', label: 'Kanban' },
  { href: '/traces', label: 'Traces' },
  { href: '/fallbacks', label: 'Fallbacks' },
  { href: '/settings', label: 'Settings' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <header className="topbar">
          <div className="brand">De Paseo en Fincas — Admin</div>
          <nav>
            {NAV.map((item) => (
              <Link key={item.href} href={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
