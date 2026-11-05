import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// One codebase and design system, three independent builds: the OnSite web app, and the dashboards that the
// simulator and Central each serve themselves. `npm run dev` proxies to the real services.
const targets: Record<string, { html: string; proxy: Record<string, string> }> = {
  web: { html: 'web.html', proxy: { '/api': 'http://localhost:4000' } },
  legacy: { html: 'legacy.html', proxy: { '/ui-api': 'http://localhost:5000' } },
  central: {
    html: 'central.html',
    proxy: Object.fromEntries(['/auth', '/dashboard', '/events', '/countries', '/admin', '/health'].map((p) => [p, 'http://localhost:6001'])),
  },
};

export default defineConfig(({ mode }) => {
  const target = targets[mode] ?? targets.web!;
  return {
    plugins: [react()],
    server: { port: 3000, proxy: target.proxy, open: `/${target.html}` },
    build: {
      outDir: `dist/${targets[mode] ? mode : 'web'}`,
      emptyOutDir: true,
      rollupOptions: { input: target.html },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['test/setup.ts'],
      include: ['test/**/*.test.{ts,tsx}'],
      restoreMocks: true,
    },
  };
});
