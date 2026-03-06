import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenLogger } from '../../src/llm/token-logger.js';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_DIR = '/tmp/indic-test-tokens';
const LOG_FILE = join(TEST_DIR, 'tokens.jsonl');

describe('TokenLogger', () => {
  let logger: TokenLogger;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    logger = new TokenLogger(LOG_FILE);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('appends a JSONL entry', () => {
    logger.log({ method: 'analyze', tokensIn: 1000, tokensOut: 200, model: 'gpt-5.4', cycle: 1 });
    const lines = readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.method).toBe('analyze');
    expect(entry.tokens_in).toBe(1000);
    expect(entry.tokens_out).toBe(200);
    expect(entry.ts).toBeDefined();
  });

  it('appends multiple entries', () => {
    logger.log({ method: 'call', label: 'news', tokensIn: 500, tokensOut: 100, model: 'gpt-5.4', cycle: 1 });
    logger.log({ method: 'call', label: 'macro', tokensIn: 400, tokensOut: 80, model: 'gpt-5.4', cycle: 1 });
    const lines = readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});
