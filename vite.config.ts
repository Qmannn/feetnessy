import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Feetnessy — дневник тренировок',
        short_name: 'Feetnessy',
        description: 'Личный дневник тренировок с локальным хранением и работой без сети.',
        lang: 'ru',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#10251f',
        theme_color: '#10251f',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{html,js,css,png,svg,ico,woff,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        skipWaiting: false,
        clientsClaim: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  preview: { host: '0.0.0.0', port: 4173, strictPort: true },
  test: { include: ['src/**/*.test.ts'] },
});
