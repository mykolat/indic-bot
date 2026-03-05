import { join } from 'path';
import { SoulKeeper } from '../src/memory/soul-keeper.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('Usage: npm run soul:insight "your insight text here"');
  process.exit(1);
}

const source = process.argv[2] === '--audit' ? 'audit' : 'manual';
const insightText = source === 'audit' ? process.argv.slice(3).join(' ').trim() : text;

const soulKeeper = new SoulKeeper(join(process.env.HOME || '.', '.indic-bot'));
soulKeeper.addExternalInsight({
  source,
  text: insightText,
  timestamp: new Date().toISOString(),
});

console.log(`[Soul] External insight added (${source}): ${insightText.slice(0, 80)}...`);
