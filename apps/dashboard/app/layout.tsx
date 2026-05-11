import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'HarnessOS Orchestration Dashboard',
  description:
    'Linear-like control surface for HarnessOS Symphony orchestration campaigns, leases, evidence, and CSQR scorecards.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
