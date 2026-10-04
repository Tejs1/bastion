// Quick browser smoke test: loads the game, plays a little, saves screenshots.
//   node tools/smoke.mjs [outDir]
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'shots');
const url = 'file://' + path.join(root, 'index.html');
const vw = +(process.env.VW || 1440), vh = +(process.env.VH || 900);

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: +(process.env.DPR || 1) });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
await page.goto(url);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, 'menu.png') });
console.log('backend:', await page.evaluate(() => window.__td.renderer.backend));
await page.click('#bPlay');
await page.waitForTimeout(500);
// place towers via the game API at tiles the bot rates highly, then via real clicks
const placed = await page.evaluate(() => {
  const g = window.__td, b = new TD.Bot(g.sim);
  const spots = b.spots.sort((a, c) => c.mid - a.mid).slice(0, 4);
  return spots.map(s => {
    const w = { x: (s.col + 0.5) * 40, y: (s.row + 0.5) * 40 };
    return { sx: (w.x - g.cam.x) * g.cam.zoom + g.cssW / 2, sy: (w.y - g.cam.y) * g.cam.zoom + g.cssH / 2 };
  });
});
for (let i = 0; i < placed.length; i++) {
  await page.keyboard.press(String(1 + (i % 2)));
  await page.mouse.move(placed[i].sx, placed[i].sy);
  await page.mouse.click(placed[i].sx, placed[i].sy);
}
await page.mouse.move(placed[0].sx, placed[0].sy);
await page.keyboard.press('3');
await page.mouse.move(placed[0].sx + 40 * 0.9, placed[0].sy + 40);
await page.screenshot({ path: path.join(out, 'placing.png') });
await page.keyboard.press('Escape');
console.log('towers after clicks:', await page.evaluate(() => window.__td.sim.towers.length));
await page.click('#bNext');
await page.waitForTimeout(400);
await page.click('#speedSeg button[data-speed="4"]');
await page.waitForTimeout(9000);
await page.mouse.click(placed[0].sx, placed[0].sy);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, 'battle.png') });
const st = await page.evaluate(() => { const s = window.__td.sim; return { wave: s.wave, lives: s.lives, gold: s.gold, enemies: s.eCount, kills: s.kills, state: s.state }; });
console.log('state:', JSON.stringify(st));
// late-game look: jump a demo sim forward
await page.evaluate(() => { const g = window.__td; g.newGame(1, 'normal', 'demo'); g.speed = 16; g.loop.maxSteps = 64; });
await page.waitForTimeout(14000);
await page.evaluate(() => { window.__td.setSpeed(1); });
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(out, 'demo.png') });
console.log('demo:', await page.evaluate(() => { const s = window.__td.sim; return `wave ${s.wave} towers ${s.towers.length} enemies ${s.eCount}`; }));
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
