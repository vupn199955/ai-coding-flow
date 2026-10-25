import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Flow · Coding workflows',
  description: 'A local workspace for coding agents, independent reviews, and verified progress.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
