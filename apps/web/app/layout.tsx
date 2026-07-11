import type { Metadata } from 'next';
import { Providers } from '@/lib/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'HotelOS',
  description: 'Hotel property management system',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
