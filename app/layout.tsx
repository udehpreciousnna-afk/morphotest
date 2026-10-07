import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mantle Mining',
  description: 'Tap to mine MANTLE tokens. Earn crypto rewards daily!',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
  },
  openGraph: {
    title: 'Mantle Mining',
    description: 'Tap to mine MANTLE tokens. Earn crypto rewards daily!',
    images: ['/og-image.png'],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script src="https://apps.abacus.ai/chatllm/appllm-lib.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}
