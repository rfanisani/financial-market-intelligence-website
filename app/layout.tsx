import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'رصد بازار | Market Radar',
  description:
    'قیمت‌های کلیدی بازارهای جهانی و ایران — Key global and Iranian market prices. Static, lightweight, under 1 MB.',
  icons: { icon: '/favicon.svg', type: 'image/svg+xml' },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f5' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1116' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  )
}
