import type { Metadata } from 'next';
import { DM_Sans } from 'next/font/google';
import './globals.css';

const font = DM_Sans({ subsets: ['latin'], variable: '--font' });

export const metadata: Metadata = {
  title: 'Meeting Master',
  description: 'Live meeting notes and refined to-dos from your microphone',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={font.variable}>
      <body>{children}</body>
    </html>
  );
}
