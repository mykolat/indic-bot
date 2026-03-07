/**
 * debug-decisions.ts — show recent LLM decisions from logs
 * Usage: npx tsx scripts/debug-decisions.ts [count=20]
 * Runs locally — reads from logs/ directory
 */
import { readFileSync } from 'fs';

const count = parseInt(process.argv[2] || '20', 10);
const logFile = 'logs/decisions.jsonl';

let lines: string[];
try {
  lines = readFileSync(logFile, 'utf-8').trim().split('\n');
} catch {
  console.log('No decisions log found at', logFile);
  process.exit(0);
}

const recent = lines.slice(-count);
console.log(`\n  Last ${recent.length} LLM Decisions`);
console.log('─'.repeat(100));

for (const line of recent) {
  try {
    const d = JSON.parse(line);
    const time = d.timestamp?.slice(0, 19)?.replace('T', ' ') ?? '?';
    const action = d.action || d.type || '?';
    const pair = d.pair || '?';
    const conf = d.confidence ?? '?';
    const reason = (d.reasoning || '').slice(0, 80);
    const marker = action === 'HOLD' ? '  ' : action === 'LONG' ? '▲ ' : action === 'SHORT' ? '▼ ' : action === 'CLOSE' ? '✗ ' : d.type === 'RISK_REJECTED' ? '⛔' : '  ';
    const extra = action !== 'HOLD' ? ` | size:${d.size_pct}% lev:${d.leverage}x sl:${d.stop_loss_pct}%` : '';
    console.log(`  ${time}  ${marker}${pair.padEnd(10)} ${action.padEnd(6)} conf:${String(conf).padEnd(3)}${extra}`);
    if (reason) console.log(`    ${reason}`);
  } catch {}
}
