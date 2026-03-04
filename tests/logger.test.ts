import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger } from '../src/logger/index.js';
import { readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

const TEST_LOG_DIR = 'logs/test';

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    mkdirSync(TEST_LOG_DIR, { recursive: true });
    logger = new Logger(TEST_LOG_DIR);
  });

  afterEach(() => {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  });

  it('logs a decision to decisions.jsonl', () => {
    const entry = { pair: 'BTCUSDT', action: 'LONG', reasoning: 'test' };
    logger.logDecision(entry);

    const content = readFileSync(`${TEST_LOG_DIR}/decisions.jsonl`, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.pair).toBe('BTCUSDT');
    expect(parsed.action).toBe('LONG');
    expect(parsed.timestamp).toBeDefined();
  });

  it('logs a trade to trades.jsonl', () => {
    const entry = { pair: 'BTCUSDT', side: 'BUY', size: 0.001, price: 50000 };
    logger.logTrade(entry);

    const content = readFileSync(`${TEST_LOG_DIR}/trades.jsonl`, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.pair).toBe('BTCUSDT');
    expect(parsed.side).toBe('BUY');
    expect(parsed.timestamp).toBeDefined();
  });

  it('logs an error to errors.jsonl', () => {
    logger.logError('API_FAIL', 'Connection refused');

    const content = readFileSync(`${TEST_LOG_DIR}/errors.jsonl`, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.code).toBe('API_FAIL');
    expect(parsed.message).toBe('Connection refused');
    expect(parsed.timestamp).toBeDefined();
  });

  it('appends multiple entries to the same file', () => {
    logger.logTrade({ pair: 'BTCUSDT', side: 'BUY', size: 0.001, price: 50000 });
    logger.logTrade({ pair: 'ETHUSDT', side: 'SELL', size: 0.01, price: 3000 });

    const lines = readFileSync(`${TEST_LOG_DIR}/trades.jsonl`, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).pair).toBe('BTCUSDT');
    expect(JSON.parse(lines[1]).pair).toBe('ETHUSDT');
  });

  it('logs a performance snapshot to performance.jsonl', () => {
    logger.logPerformance({ balance: 5100, openPositions: 2, sessionPnl: 100, cycleCount: 10 });
    const content = readFileSync(join(TEST_LOG_DIR, 'performance.jsonl'), 'utf-8');
    expect(content).toContain('5100');
    expect(content).toContain('cycleCount');
  });
});
