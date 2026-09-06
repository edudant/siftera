/**
 * Build veřejné ukázky pro GitHub Pages (ADR-018): statické UI bez backendu, které čte sanitizovaný snapshot.
 * BASE_PATH musí odpovídat podcestě repozitáře, jinak se na Pages nenačtou assety.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const base = process.env.BASE_PATH ?? '/siftera/';
if (!existsSync('apps/web/public/demo-feed.json')) {
  console.error('Chybí apps/web/public/demo-feed.json — bez ukázkových dat by byl web prázdný.');
  process.exit(1);
}
const result = spawnSync('pnpm', ['--filter', '@siftera/web', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, BASE_PATH: base, VITE_DEMO: '1' },
});
if (result.status !== 0) process.exit(result.status ?? 1);

rmSync('dist/pages', { recursive: true, force: true });
// cpSync místo shellu: vytvoří i chybějící rodičovský dist/ a chová se stejně na všech platformách.
mkdirSync('dist/pages', { recursive: true });
cpSync('apps/web/dist', 'dist/pages', { recursive: true });
// Pages nemá SPA fallback; kopie index.html pod 404.html zajistí, že přímý odkaz do aplikace nespadne.
copyFileSync('dist/pages/index.html', 'dist/pages/404.html');
// Bez .nojekyll Pages zahodí soubory a složky začínající podtržítkem.
writeFileSync('dist/pages/.nojekyll', '');
console.log(`Hotovo: dist/pages (base ${base})`);
