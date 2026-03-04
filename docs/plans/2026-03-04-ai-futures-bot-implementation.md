# AI Futures Trading Bot — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an MVP autonomous AI futures trading bot that uses GPT to analyze BTC/ETH/SOL market data + TradingView signals and execute trades on Binance Futures.

**Architecture:** Single Node.js process with a 5-minute trading loop and Express webhook receiver. LLM (OpenAI GPT) analyzes market data and TradingView signals, makes decisions, risk manager validates, Binance API executes.

**Tech Stack:** TypeScript, Node.js 22+, Vitest, Express, `binance` (tiagosiebler/USDMClient), `openai` SDK, `chalk` for console colors.

**Note on OpenAI Auth:** Design doc specifies OAuth via openclaw/pi-ai. For MVP speed, we use a direct API key (`openai` SDK). OAuth can be layered on later — the LLM client interface is abstracted so swapping auth is trivial.

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`

**Step 1: Initialize project**

```bash
npm init -y
```

**Step 2: Install dependencies**

```bash
npm install typescript @types/node vitest express @types/express binance openai chalk dotenv
npm install -D tsx
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 4: Create .env.example**

```
BINANCE_API_KEY=your_api_key
BINANCE_API_SECRET=your_api_secret
BINANCE_TESTNET=true
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL=gpt-4o
WEBHOOK_PORT=3000
WEBHOOK_SECRET=optional_secret_token
TRADING_PAIRS=BTCUSDT,ETHUSDT,SOLUSDT
MAX_LEVERAGE=10
LOOP_INTERVAL_MS=300000
MAX_LOSS_USD=5
```

**Step 5: Create .gitignore**

```
node_modules/
dist/
logs/
.env
*.log
```

**Step 6: Add scripts to package.json**

Add to `package.json`:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Step 7: Create directory structure**

```bash
mkdir -p src/llm src/binance src/webhook src/risk src/logger tests/llm tests/binance tests/webhook tests/risk logs
```

**Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold project with TypeScript, Vitest, dependencies"
```

---

## Task 2: Config Module

**Files:**
- Create: `src/config.ts`

**Step 1: Write the config module**

```typescript
import 'dotenv/config';

export interface Config {
  binance: {
    apiKey: string;
    apiSecret: string;
    testnet: boolean;
  };
  openai: {
    apiKey: string;
    model: string;
  };
  webhook: {
    port: number;
    secret: string | undefined;
  };
  trading: {
    pairs: string[];
    maxLeverage: number;
    loopIntervalMs: number;
    maxLossUsd: number;
    maxPositionPct: number;
    maxExposurePct: number;
    maxStopLossPct: number;
  };
}

function requiredEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export function loadConfig(): Config {
  return {
    binance: {
      apiKey: requiredEnv('BINANCE_API_KEY'),
      apiSecret: requiredEnv('BINANCE_API_SECRET'),
      testnet: process.env.BINANCE_TESTNET === 'true',
    },
    openai: {
      apiKey: requiredEnv('OPENAI_API_KEY'),
      model: process.env.OPENAI_MODEL || 'gpt-4o',
    },
    webhook: {
      port: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
      secret: process.env.WEBHOOK_SECRET,
    },
    trading: {
      pairs: (process.env.TRADING_PAIRS || 'BTCUSDT').split(','),
      maxLeverage: parseInt(process.env.MAX_LEVERAGE || '10', 10),
      loopIntervalMs: parseInt(process.env.LOOP_INTERVAL_MS || '300000', 10),
      maxLossUsd: parseFloat(process.env.MAX_LOSS_USD || '5'),
      maxPositionPct: 33,
      maxExposurePct: 50,
      maxStopLossPct: 3,
    },
  };
}
```

**Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat: add config module with env var loading"
```

---

## Task 3: Logger (TDD)

**Files:**
- Test: `tests/logger.test.ts`
- Create: `src/logger/index.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger } from '../src/logger/index.js';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'fs';

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
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/logger.test.ts
```

Expected: FAIL — cannot find module `../src/logger/index.js`

**Step 3: Write minimal implementation**

```typescript
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export class Logger {
  private dir: string;

  constructor(logDir: string = 'logs') {
    this.dir = logDir;
    mkdirSync(this.dir, { recursive: true });
  }

  logDecision(entry: Record<string, unknown>): void {
    this.append('decisions.jsonl', entry);
    const preview = JSON.stringify(entry).slice(0, 120);
    console.log(`[DECISION] ${preview}`);
  }

  logTrade(entry: Record<string, unknown>): void {
    this.append('trades.jsonl', entry);
    const preview = JSON.stringify(entry).slice(0, 120);
    console.log(`[TRADE] ${preview}`);
  }

  logError(code: string, message: string, details?: unknown): void {
    this.append('errors.jsonl', { code, message, details });
    console.error(`[ERROR] ${code}: ${message}`);
  }

  private append(file: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ ...data, timestamp: new Date().toISOString() });
    appendFileSync(join(this.dir, file), line + '\n', 'utf-8');
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/logger.test.ts
```

Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add tests/logger.test.ts src/logger/index.ts
git commit -m "feat: add JSONL logger with decisions, trades, errors"
```

---

## Task 4: Signal Buffer (TDD)

**Files:**
- Test: `tests/webhook/signal-buffer.test.ts`
- Create: `src/webhook/signal-buffer.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SignalBuffer, TradingViewSignal } from '../../src/webhook/signal-buffer.js';

describe('SignalBuffer', () => {
  let buffer: SignalBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new SignalBuffer({ maxSize: 5, ttlMs: 30 * 60 * 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds and retrieves signals', () => {
    const signal: TradingViewSignal = {
      signal: 'BUY',
      pair: 'BTCUSDT',
      indicator: 'RSI',
      value: 72,
      timeframe: '1h',
    };
    buffer.add(signal);

    const signals = buffer.getRecent();
    expect(signals).toHaveLength(1);
    expect(signals[0].pair).toBe('BTCUSDT');
  });

  it('enforces max size (circular buffer)', () => {
    for (let i = 0; i < 7; i++) {
      buffer.add({ signal: 'BUY', pair: `PAIR${i}`, indicator: 'RSI', value: i, timeframe: '1h' });
    }
    const signals = buffer.getRecent();
    expect(signals).toHaveLength(5);
    expect(signals[0].pair).toBe('PAIR2');
  });

  it('expires signals after TTL', () => {
    buffer.add({ signal: 'BUY', pair: 'BTCUSDT', indicator: 'RSI', value: 70, timeframe: '1h' });
    vi.advanceTimersByTime(31 * 60 * 1000);
    const signals = buffer.getRecent();
    expect(signals).toHaveLength(0);
  });

  it('clears all signals', () => {
    buffer.add({ signal: 'BUY', pair: 'BTCUSDT', indicator: 'RSI', value: 70, timeframe: '1h' });
    buffer.clear();
    expect(buffer.getRecent()).toHaveLength(0);
  });

  it('drains returns signals and clears buffer', () => {
    buffer.add({ signal: 'BUY', pair: 'BTCUSDT', indicator: 'RSI', value: 70, timeframe: '1h' });
    const drained = buffer.drain();
    expect(drained).toHaveLength(1);
    expect(buffer.getRecent()).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/webhook/signal-buffer.test.ts
```

Expected: FAIL — cannot find module

**Step 3: Write minimal implementation**

```typescript
export interface TradingViewSignal {
  signal: 'BUY' | 'SELL';
  pair: string;
  indicator: string;
  value: number;
  timeframe: string;
}

interface TimestampedSignal {
  data: TradingViewSignal;
  receivedAt: number;
}

interface SignalBufferOptions {
  maxSize: number;
  ttlMs: number;
}

export class SignalBuffer {
  private signals: TimestampedSignal[] = [];
  private maxSize: number;
  private ttlMs: number;

  constructor(opts: SignalBufferOptions) {
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs;
  }

  add(signal: TradingViewSignal): void {
    this.signals.push({ data: signal, receivedAt: Date.now() });
    if (this.signals.length > this.maxSize) {
      this.signals = this.signals.slice(-this.maxSize);
    }
  }

  getRecent(): TradingViewSignal[] {
    const cutoff = Date.now() - this.ttlMs;
    return this.signals
      .filter((s) => s.receivedAt > cutoff)
      .map((s) => s.data);
  }

  drain(): TradingViewSignal[] {
    const result = this.getRecent();
    this.signals = [];
    return result;
  }

  clear(): void {
    this.signals = [];
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/webhook/signal-buffer.test.ts
```

Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add tests/webhook/signal-buffer.test.ts src/webhook/signal-buffer.ts
git commit -m "feat: add signal buffer with TTL and circular overflow"
```

---

## Task 5: Risk Manager (TDD)

**Files:**
- Test: `tests/risk/manager.test.ts`
- Create: `src/risk/manager.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { RiskManager, TradeDecision, PortfolioState } from '../../src/risk/manager.js';

describe('RiskManager', () => {
  const config = {
    maxLeverage: 10,
    maxPositionPct: 33,
    maxExposurePct: 50,
    maxStopLossPct: 3,
    maxLossUsd: 5,
  };

  let rm: RiskManager;

  beforeEach(() => {
    rm = new RiskManager(config);
  });

  it('approves a valid trade', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT',
      action: 'LONG',
      size_pct: 20,
      leverage: 5,
      stop_loss_pct: 2,
      take_profit_pct: 4,
      reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 10,
      positions: [],
      sessionPnl: 0,
    };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(true);
  });

  it('rejects leverage above max', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 15, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('leverage');
  });

  it('rejects position exceeding max position pct', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 50,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('position');
  });

  it('rejects when total exposure would exceed max', () => {
    const decision: TradeDecision = {
      pair: 'ETHUSDT', action: 'LONG', size_pct: 30,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 10,
      positions: [{ pair: 'BTCUSDT', sizeUsd: 3, leverage: 5, side: 'LONG' }],
      sessionPnl: 0,
    };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('exposure');
  });

  it('rejects missing stop-loss', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 5, stop_loss_pct: 0, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('stop');
  });

  it('triggers shutdown when session loss exceeds max', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = { balanceUsd: 4, positions: [], sessionPnl: -6 };

    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('shutdown');
    expect(result.shutdown).toBe(true);
  });

  it('passes through HOLD and CLOSE without validation', () => {
    const hold: TradeDecision = {
      pair: 'BTCUSDT', action: 'HOLD', size_pct: 0,
      leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'wait',
    };
    const portfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };

    expect(rm.validate(hold, portfolio).approved).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/risk/manager.test.ts
```

Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
export interface TradeDecision {
  pair: string;
  action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD';
  size_pct: number;
  leverage: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  reasoning: string;
}

export interface Position {
  pair: string;
  sizeUsd: number;
  leverage: number;
  side: 'LONG' | 'SHORT';
}

export interface PortfolioState {
  balanceUsd: number;
  positions: Position[];
  sessionPnl: number;
}

export interface ValidationResult {
  approved: boolean;
  reason?: string;
  shutdown?: boolean;
}

interface RiskConfig {
  maxLeverage: number;
  maxPositionPct: number;
  maxExposurePct: number;
  maxStopLossPct: number;
  maxLossUsd: number;
}

export class RiskManager {
  constructor(private config: RiskConfig) {}

  validate(decision: TradeDecision, portfolio: PortfolioState): ValidationResult {
    if (decision.action === 'HOLD' || decision.action === 'CLOSE') {
      return { approved: true };
    }

    if (portfolio.sessionPnl <= -this.config.maxLossUsd) {
      return { approved: false, reason: 'Session loss exceeded max — shutdown triggered', shutdown: true };
    }

    if (decision.leverage > this.config.maxLeverage) {
      return { approved: false, reason: `leverage ${decision.leverage}x exceeds max ${this.config.maxLeverage}x` };
    }

    if (decision.size_pct > this.config.maxPositionPct) {
      return { approved: false, reason: `position size ${decision.size_pct}% exceeds max ${this.config.maxPositionPct}%` };
    }

    if (!decision.stop_loss_pct || decision.stop_loss_pct <= 0) {
      return { approved: false, reason: 'stop-loss is mandatory' };
    }

    if (decision.stop_loss_pct > this.config.maxStopLossPct) {
      return { approved: false, reason: `stop-loss ${decision.stop_loss_pct}% exceeds max ${this.config.maxStopLossPct}%` };
    }

    const currentExposureUsd = portfolio.positions.reduce((sum, p) => sum + p.sizeUsd, 0);
    const newPositionUsd = (decision.size_pct / 100) * portfolio.balanceUsd;
    const totalExposurePct = ((currentExposureUsd + newPositionUsd) / portfolio.balanceUsd) * 100;

    if (totalExposurePct > this.config.maxExposurePct) {
      return { approved: false, reason: `total exposure ${totalExposurePct.toFixed(1)}% exceeds max ${this.config.maxExposurePct}%` };
    }

    return { approved: true };
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/risk/manager.test.ts
```

Expected: PASS (all 7 tests)

**Step 5: Commit**

```bash
git add tests/risk/manager.test.ts src/risk/manager.ts
git commit -m "feat: add risk manager with leverage, exposure, stop-loss limits"
```

---

## Task 6: Binance Market Data Client (TDD)

**Files:**
- Test: `tests/binance/market-data.test.ts`
- Create: `src/binance/client.ts`
- Create: `src/binance/market-data.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketDataFetcher, MarketSnapshot } from '../../src/binance/market-data.js';

describe('MarketDataFetcher', () => {
  let fetcher: MarketDataFetcher;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      getKlines: vi.fn().mockResolvedValue([
        [1704067200000, '42000', '42500', '41800', '42200', '100', 1704070800000, '4200000', 50, '60', '2520000', '0'],
        [1704070800000, '42200', '42800', '42100', '42600', '120', 1704074400000, '5100000', 60, '70', '2980000', '0'],
      ]),
      getMarkPrice: vi.fn().mockResolvedValue({
        symbol: 'BTCUSDT',
        markPrice: '42500.00',
        lastFundingRate: '0.0001',
        nextFundingTime: 1704096000000,
      }),
      getOpenInterest: vi.fn().mockResolvedValue({
        symbol: 'BTCUSDT',
        openInterest: '80000.00',
      }),
      getPositions: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue([
        { asset: 'USDT', balance: '10.00', availableBalance: '10.00' },
      ]),
    };
    fetcher = new MarketDataFetcher(mockClient);
  });

  it('fetches a complete market snapshot for a pair', async () => {
    const snapshot = await fetcher.getSnapshot('BTCUSDT');

    expect(snapshot.pair).toBe('BTCUSDT');
    expect(snapshot.candles1h).toHaveLength(2);
    expect(snapshot.fundingRate).toBe('0.0001');
    expect(snapshot.openInterest).toBe('80000.00');
    expect(mockClient.getKlines).toHaveBeenCalledTimes(2); // 1h + 4h
  });

  it('fetches portfolio state', async () => {
    const state = await fetcher.getPortfolioState();

    expect(state.balanceUsd).toBe(10);
    expect(state.positions).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/binance/market-data.test.ts
```

Expected: FAIL

**Step 3: Write binance client wrapper**

`src/binance/client.ts`:
```typescript
import { USDMClient } from 'binance';

export interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export function createBinanceClient(config: BinanceConfig): USDMClient {
  return new USDMClient({
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    ...(config.testnet && { baseUrl: 'https://testnet.binancefuture.com' }),
  });
}
```

**Step 4: Write market data fetcher**

`src/binance/market-data.ts`:
```typescript
import type { PortfolioState, Position } from '../risk/manager.js';

export interface CandleData {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface MarketSnapshot {
  pair: string;
  candles1h: CandleData[];
  candles4h: CandleData[];
  fundingRate: string;
  openInterest: string;
  markPrice: string;
}

export class MarketDataFetcher {
  constructor(private client: any) {}

  async getSnapshot(pair: string): Promise<MarketSnapshot> {
    const [candles1h, candles4h, markPrice, oi] = await Promise.all([
      this.client.getKlines({ symbol: pair, interval: '1h', limit: 20 }),
      this.client.getKlines({ symbol: pair, interval: '4h', limit: 20 }),
      this.client.getMarkPrice({ symbol: pair }),
      this.client.getOpenInterest({ symbol: pair }),
    ]);

    return {
      pair,
      candles1h: this.parseCandles(candles1h),
      candles4h: this.parseCandles(candles4h),
      fundingRate: markPrice.lastFundingRate,
      openInterest: oi.openInterest,
      markPrice: markPrice.markPrice,
    };
  }

  async getPortfolioState(): Promise<PortfolioState> {
    const [balances, positions] = await Promise.all([
      this.client.getBalance(),
      this.client.getPositions(),
    ]);

    const usdtBalance = balances.find((b: any) => b.asset === 'USDT');
    const balanceUsd = usdtBalance ? parseFloat(usdtBalance.availableBalance) : 0;

    const openPositions: Position[] = positions
      .filter((p: any) => parseFloat(p.positionAmt) !== 0)
      .map((p: any) => ({
        pair: p.symbol,
        sizeUsd: Math.abs(parseFloat(p.notional)),
        leverage: parseInt(p.leverage, 10),
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' as const : 'SHORT' as const,
      }));

    return {
      balanceUsd,
      positions: openPositions,
      sessionPnl: 0, // tracked externally
    };
  }

  private parseCandles(raw: any[]): CandleData[] {
    return raw.map((c: any) => ({
      openTime: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
  }
}
```

**Step 5: Run test to verify it passes**

```bash
npx vitest run tests/binance/market-data.test.ts
```

Expected: PASS

**Step 6: Commit**

```bash
git add tests/binance/market-data.test.ts src/binance/client.ts src/binance/market-data.ts
git commit -m "feat: add Binance market data fetcher with OHLCV, funding, OI"
```

---

## Task 7: Binance Orders (TDD)

**Files:**
- Test: `tests/binance/orders.test.ts`
- Create: `src/binance/orders.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderExecutor } from '../../src/binance/orders.js';
import type { TradeDecision } from '../../src/risk/manager.js';

describe('OrderExecutor', () => {
  let executor: OrderExecutor;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      setLeverage: vi.fn().mockResolvedValue({ leverage: 10 }),
      submitNewOrder: vi.fn().mockResolvedValue({
        orderId: 123456,
        symbol: 'BTCUSDT',
        status: 'NEW',
        side: 'BUY',
        type: 'MARKET',
      }),
      getSymbolPriceTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', price: '50000.00' }),
    };
    executor = new OrderExecutor(mockClient);
  });

  it('opens a LONG position with market order + stop-loss', async () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };

    const result = await executor.execute(decision, 10);

    expect(mockClient.setLeverage).toHaveBeenCalledWith({ symbol: 'BTCUSDT', leverage: 10 });
    expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(2); // market + stop-loss
    expect(result.success).toBe(true);
  });

  it('opens a SHORT position', async () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'SHORT', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };

    const result = await executor.execute(decision, 10);
    const marketCall = mockClient.submitNewOrder.mock.calls[0][0];
    expect(marketCall.side).toBe('SELL');
    expect(result.success).toBe(true);
  });

  it('closes a position', async () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0,
      leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'taking profit',
    };

    const result = await executor.close('BTCUSDT', 0.001, 'LONG');
    expect(mockClient.submitNewOrder).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('returns error on API failure', async () => {
    mockClient.submitNewOrder.mockRejectedValue(new Error('Insufficient margin'));

    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20,
      leverage: 10, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };

    const result = await executor.execute(decision, 10);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient margin');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/binance/orders.test.ts
```

Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
import type { TradeDecision } from '../risk/manager.js';

export interface OrderResult {
  success: boolean;
  orderId?: number;
  error?: string;
}

export class OrderExecutor {
  constructor(private client: any) {}

  async execute(decision: TradeDecision, balanceUsd: number): Promise<OrderResult> {
    try {
      const side = decision.action === 'LONG' ? 'BUY' : 'SELL';
      const closeSide = decision.action === 'LONG' ? 'SELL' : 'BUY';

      await this.client.setLeverage({ symbol: decision.pair, leverage: decision.leverage });

      const ticker = await this.client.getSymbolPriceTicker({ symbol: decision.pair });
      const price = parseFloat(ticker.price);
      const positionUsd = (decision.size_pct / 100) * balanceUsd * decision.leverage;
      const quantity = this.roundQuantity(positionUsd / price, decision.pair);

      const order = await this.client.submitNewOrder({
        symbol: decision.pair,
        side,
        type: 'MARKET',
        quantity: String(quantity),
      });

      const stopPrice = decision.action === 'LONG'
        ? price * (1 - decision.stop_loss_pct / 100)
        : price * (1 + decision.stop_loss_pct / 100);

      await this.client.submitNewOrder({
        symbol: decision.pair,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: String(this.roundPrice(stopPrice)),
        quantity: String(quantity),
        reduceOnly: 'true',
      });

      return { success: true, orderId: order.orderId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async close(pair: string, quantity: number, side: 'LONG' | 'SHORT'): Promise<OrderResult> {
    try {
      const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
      const order = await this.client.submitNewOrder({
        symbol: pair,
        side: closeSide,
        type: 'MARKET',
        quantity: String(quantity),
        reduceOnly: 'true',
      });
      return { success: true, orderId: order.orderId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private roundQuantity(qty: number, pair: string): number {
    const decimals = pair.includes('BTC') ? 3 : pair.includes('ETH') ? 2 : 1;
    return Math.floor(qty * 10 ** decimals) / 10 ** decimals;
  }

  private roundPrice(price: number): number {
    return Math.round(price * 100) / 100;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/binance/orders.test.ts
```

Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add tests/binance/orders.test.ts src/binance/orders.ts
git commit -m "feat: add order executor with market orders, stop-loss, close"
```

---

## Task 8: LLM Client (TDD)

**Files:**
- Test: `tests/llm/client.test.ts`
- Create: `src/llm/client.ts`
- Create: `src/llm/prompts.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMClient } from '../../src/llm/client.js';
import type { MarketSnapshot } from '../../src/binance/market-data.js';
import type { TradingViewSignal } from '../../src/webhook/signal-buffer.js';
import type { PortfolioState, TradeDecision } from '../../src/risk/manager.js';

describe('LLMClient', () => {
  let llm: LLMClient;
  let mockOpenAI: any;

  const fakeSnapshot: MarketSnapshot = {
    pair: 'BTCUSDT',
    candles1h: [{ openTime: 1, open: '50000', high: '50500', low: '49500', close: '50200', volume: '100' }],
    candles4h: [{ openTime: 1, open: '49000', high: '50500', low: '48500', close: '50200', volume: '400' }],
    fundingRate: '0.0001',
    openInterest: '80000',
    markPrice: '50200',
  };

  const fakePortfolio: PortfolioState = { balanceUsd: 10, positions: [], sessionPnl: 0 };

  beforeEach(() => {
    mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{
              message: {
                content: JSON.stringify({
                  decisions: [{
                    pair: 'BTCUSDT',
                    action: 'LONG',
                    size_pct: 20,
                    leverage: 5,
                    stop_loss_pct: 2,
                    take_profit_pct: 4,
                    reasoning: 'bullish momentum',
                  }],
                }),
              },
            }],
          }),
        },
      },
    };
    llm = new LLMClient(mockOpenAI, 'gpt-4o');
  });

  it('returns parsed trade decisions from GPT', async () => {
    const decisions = await llm.analyze([fakeSnapshot], fakePortfolio, []);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].pair).toBe('BTCUSDT');
    expect(decisions[0].action).toBe('LONG');
    expect(decisions[0].leverage).toBe(5);
  });

  it('handles GPT returning HOLD for all pairs', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            decisions: [{ pair: 'BTCUSDT', action: 'HOLD', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'sideways market' }],
          }),
        },
      }],
    });

    const decisions = await llm.analyze([fakeSnapshot], fakePortfolio, []);
    expect(decisions[0].action).toBe('HOLD');
  });

  it('includes TradingView signals in context', async () => {
    const signals: TradingViewSignal[] = [
      { signal: 'BUY', pair: 'BTCUSDT', indicator: 'RSI', value: 72, timeframe: '1h' },
    ];

    await llm.analyze([fakeSnapshot], fakePortfolio, signals);

    const callArgs = mockOpenAI.chat.completions.create.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toContain('RSI');
    expect(userMsg.content).toContain('BUY');
  });

  it('returns empty decisions on parse error', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
    });

    const decisions = await llm.analyze([fakeSnapshot], fakePortfolio, []);
    expect(decisions).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/llm/client.test.ts
```

Expected: FAIL

**Step 3: Write prompts module**

`src/llm/prompts.ts`:
```typescript
import type { MarketSnapshot } from '../binance/market-data.js';
import type { PortfolioState } from '../risk/manager.js';
import type { TradingViewSignal } from '../webhook/signal-buffer.js';

export const SYSTEM_PROMPT = `You are an expert crypto futures trader analyzing market data to make trading decisions.

You will receive:
- OHLCV candle data (1h and 4h timeframes) for multiple pairs
- Funding rate and open interest data
- Current portfolio state (balance, open positions)
- Optional TradingView indicator signals

Respond ONLY with valid JSON in this exact format:
{
  "decisions": [
    {
      "pair": "BTCUSDT",
      "action": "LONG" | "SHORT" | "CLOSE" | "HOLD",
      "size_pct": <0-33, percentage of balance to use>,
      "leverage": <1-10>,
      "stop_loss_pct": <1-3, mandatory for LONG/SHORT>,
      "take_profit_pct": <1-10>,
      "reasoning": "<brief explanation>"
    }
  ]
}

Rules:
- Always include a decision for each pair provided
- HOLD means do nothing for that pair
- CLOSE means close existing position
- Max leverage: 10x
- Stop-loss is MANDATORY for LONG and SHORT (1-3%)
- Be conservative — only trade when there's a clear signal
- Consider funding rate: very high positive = shorts being squeezed, very negative = longs being squeezed
- Consider open interest changes for momentum confirmation`;

export function buildUserPrompt(
  snapshots: MarketSnapshot[],
  portfolio: PortfolioState,
  signals: TradingViewSignal[],
): string {
  let prompt = '## Market Data\n\n';

  for (const snap of snapshots) {
    const lastCandle1h = snap.candles1h[snap.candles1h.length - 1];
    const lastCandle4h = snap.candles4h[snap.candles4h.length - 1];

    prompt += `### ${snap.pair}\n`;
    prompt += `Mark Price: ${snap.markPrice}\n`;
    prompt += `Funding Rate: ${snap.fundingRate}\n`;
    prompt += `Open Interest: ${snap.openInterest}\n`;
    prompt += `Last 1h candle: O=${lastCandle1h?.open} H=${lastCandle1h?.high} L=${lastCandle1h?.low} C=${lastCandle1h?.close} V=${lastCandle1h?.volume}\n`;
    prompt += `Last 4h candle: O=${lastCandle4h?.open} H=${lastCandle4h?.high} L=${lastCandle4h?.low} C=${lastCandle4h?.close} V=${lastCandle4h?.volume}\n`;

    const recentCloses1h = snap.candles1h.slice(-5).map(c => c.close).join(', ');
    prompt += `Recent 1h closes (last 5): ${recentCloses1h}\n\n`;
  }

  prompt += '## Portfolio\n';
  prompt += `Balance: $${portfolio.balanceUsd.toFixed(2)}\n`;
  prompt += `Session PnL: $${portfolio.sessionPnl.toFixed(2)}\n`;

  if (portfolio.positions.length > 0) {
    prompt += 'Open positions:\n';
    for (const pos of portfolio.positions) {
      prompt += `- ${pos.pair}: ${pos.side} $${pos.sizeUsd.toFixed(2)} @ ${pos.leverage}x\n`;
    }
  } else {
    prompt += 'No open positions.\n';
  }

  if (signals.length > 0) {
    prompt += '\n## TradingView Signals\n';
    for (const sig of signals) {
      prompt += `- ${sig.pair}: ${sig.signal} (${sig.indicator}=${sig.value}, ${sig.timeframe})\n`;
    }
  }

  prompt += '\nProvide your trading decisions as JSON:';
  return prompt;
}
```

**Step 4: Write LLM client**

`src/llm/client.ts`:
```typescript
import type { MarketSnapshot } from '../binance/market-data.js';
import type { PortfolioState, TradeDecision } from '../risk/manager.js';
import type { TradingViewSignal } from '../webhook/signal-buffer.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';

export class LLMClient {
  constructor(
    private openai: any,
    private model: string,
  ) {}

  async analyze(
    snapshots: MarketSnapshot[],
    portfolio: PortfolioState,
    signals: TradingViewSignal[],
  ): Promise<TradeDecision[]> {
    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(snapshots, portfolio, signals) },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const content = response.choices[0]?.message?.content || '';
      return this.parseResponse(content);
    } catch (err) {
      console.error('[LLM] API error:', err);
      return [];
    }
  }

  private parseResponse(content: string): TradeDecision[] {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.decisions || !Array.isArray(parsed.decisions)) return [];

      return parsed.decisions;
    } catch {
      console.error('[LLM] Failed to parse response:', content.slice(0, 200));
      return [];
    }
  }
}
```

**Step 5: Run test to verify it passes**

```bash
npx vitest run tests/llm/client.test.ts
```

Expected: PASS (all 4 tests)

**Step 6: Commit**

```bash
git add tests/llm/client.test.ts src/llm/client.ts src/llm/prompts.ts
git commit -m "feat: add LLM client with GPT analysis and JSON parsing"
```

---

## Task 9: Webhook Server

**Files:**
- Create: `src/webhook/server.ts`

**Step 1: Write the webhook server**

```typescript
import express from 'express';
import { SignalBuffer, TradingViewSignal } from './signal-buffer.js';
import { Logger } from '../logger/index.js';

export function createWebhookServer(
  signalBuffer: SignalBuffer,
  logger: Logger,
  secret?: string,
): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/webhook', (req, res) => {
    if (secret && req.headers['x-webhook-secret'] !== secret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { signal, pair, indicator, value, timeframe } = req.body;

    if (!signal || !pair) {
      res.status(400).json({ error: 'Missing signal or pair' });
      return;
    }

    const tvSignal: TradingViewSignal = {
      signal,
      pair,
      indicator: indicator || 'unknown',
      value: value || 0,
      timeframe: timeframe || '1h',
    };

    signalBuffer.add(tvSignal);
    logger.logDecision({ type: 'WEBHOOK_RECEIVED', ...tvSignal });

    res.json({ ok: true });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}
```

**Step 2: Commit**

```bash
git add src/webhook/server.ts
git commit -m "feat: add Express webhook server for TradingView signals"
```

---

## Task 10: Trading Loop (TDD)

**Files:**
- Test: `tests/trading-loop.test.ts`
- Create: `src/trading-loop.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradingLoop } from '../src/trading-loop.js';

describe('TradingLoop', () => {
  let loop: TradingLoop;
  let mockMarketData: any;
  let mockLlm: any;
  let mockOrders: any;
  let mockRisk: any;
  let mockSignalBuffer: any;
  let mockLogger: any;

  beforeEach(() => {
    mockMarketData = {
      getSnapshot: vi.fn().mockResolvedValue({
        pair: 'BTCUSDT', candles1h: [], candles4h: [],
        fundingRate: '0.0001', openInterest: '80000', markPrice: '50000',
      }),
      getPortfolioState: vi.fn().mockResolvedValue({
        balanceUsd: 10, positions: [], sessionPnl: 0,
      }),
    };
    mockLlm = {
      analyze: vi.fn().mockResolvedValue([
        { pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'bullish' },
      ]),
    };
    mockOrders = {
      execute: vi.fn().mockResolvedValue({ success: true, orderId: 123 }),
      close: vi.fn().mockResolvedValue({ success: true }),
    };
    mockRisk = {
      validate: vi.fn().mockReturnValue({ approved: true }),
    };
    mockSignalBuffer = {
      drain: vi.fn().mockReturnValue([]),
    };
    mockLogger = {
      logDecision: vi.fn(),
      logTrade: vi.fn(),
      logError: vi.fn(),
    };

    loop = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
    });
  });

  it('runs a full cycle: fetch → analyze → validate → execute → log', async () => {
    await loop.runOnce();

    expect(mockMarketData.getSnapshot).toHaveBeenCalledWith('BTCUSDT');
    expect(mockMarketData.getPortfolioState).toHaveBeenCalled();
    expect(mockLlm.analyze).toHaveBeenCalled();
    expect(mockRisk.validate).toHaveBeenCalled();
    expect(mockOrders.execute).toHaveBeenCalled();
    expect(mockLogger.logDecision).toHaveBeenCalled();
    expect(mockLogger.logTrade).toHaveBeenCalled();
  });

  it('skips execution when risk manager rejects', async () => {
    mockRisk.validate.mockReturnValue({ approved: false, reason: 'too risky' });

    await loop.runOnce();

    expect(mockOrders.execute).not.toHaveBeenCalled();
    expect(mockLogger.logDecision).toHaveBeenCalled();
  });

  it('skips execution for HOLD decisions', async () => {
    mockLlm.analyze.mockResolvedValue([
      { pair: 'BTCUSDT', action: 'HOLD', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'no signal' },
    ]);

    await loop.runOnce();

    expect(mockOrders.execute).not.toHaveBeenCalled();
  });

  it('stops when risk manager triggers shutdown', async () => {
    mockRisk.validate.mockReturnValue({ approved: false, reason: 'max loss', shutdown: true });

    await loop.runOnce();

    expect(loop.isShutdown()).toBe(true);
  });

  it('logs errors when order execution fails', async () => {
    mockOrders.execute.mockResolvedValue({ success: false, error: 'Insufficient margin' });

    await loop.runOnce();

    expect(mockLogger.logError).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/trading-loop.test.ts
```

Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
import type { MarketDataFetcher, MarketSnapshot } from './binance/market-data.js';
import type { OrderExecutor } from './binance/orders.js';
import type { LLMClient } from './llm/client.js';
import type { RiskManager, TradeDecision, PortfolioState } from './risk/manager.js';
import type { SignalBuffer } from './webhook/signal-buffer.js';
import type { Logger } from './logger/index.js';

interface TradingLoopDeps {
  pairs: string[];
  marketData: MarketDataFetcher;
  llm: LLMClient;
  orders: OrderExecutor;
  riskManager: RiskManager;
  signalBuffer: SignalBuffer;
  logger: Logger;
}

export class TradingLoop {
  private deps: TradingLoopDeps;
  private _shutdown = false;
  private sessionPnl = 0;

  constructor(deps: TradingLoopDeps) {
    this.deps = deps;
  }

  isShutdown(): boolean {
    return this._shutdown;
  }

  async runOnce(): Promise<void> {
    if (this._shutdown) return;

    const { pairs, marketData, llm, orders, riskManager, signalBuffer, logger } = this.deps;

    try {
      // 1. Fetch market data
      const snapshots: MarketSnapshot[] = await Promise.all(
        pairs.map((pair) => marketData.getSnapshot(pair)),
      );

      // 2. Get portfolio state
      const portfolio: PortfolioState = await marketData.getPortfolioState();
      portfolio.sessionPnl = this.sessionPnl;

      // 3. Drain TradingView signals
      const signals = signalBuffer.drain();

      // 4. LLM analysis
      const decisions = await llm.analyze(snapshots, portfolio, signals);

      // 5. Process each decision
      for (const decision of decisions) {
        logger.logDecision({
          type: 'LLM_DECISION',
          ...decision,
          portfolio: { balance: portfolio.balanceUsd, sessionPnl: this.sessionPnl },
        });

        if (decision.action === 'HOLD') continue;

        // 6. Risk check
        const validation = riskManager.validate(decision, portfolio);
        if (!validation.approved) {
          logger.logDecision({ type: 'RISK_REJECTED', pair: decision.pair, reason: validation.reason });
          if (validation.shutdown) {
            this._shutdown = true;
            logger.logError('SHUTDOWN', 'Max loss reached — stopping bot');
          }
          continue;
        }

        // 7. Execute
        if (decision.action === 'CLOSE') {
          const pos = portfolio.positions.find((p) => p.pair === decision.pair);
          if (pos) {
            const result = await orders.close(decision.pair, pos.sizeUsd, pos.side);
            if (result.success) {
              logger.logTrade({ type: 'CLOSE', pair: decision.pair, orderId: result.orderId });
            } else {
              logger.logError('ORDER_FAIL', result.error || 'Unknown error');
            }
          }
        } else {
          const result = await orders.execute(decision, portfolio.balanceUsd);
          if (result.success) {
            logger.logTrade({
              type: decision.action,
              pair: decision.pair,
              size_pct: decision.size_pct,
              leverage: decision.leverage,
              orderId: result.orderId,
            });
          } else {
            logger.logError('ORDER_FAIL', result.error || 'Unknown error');
          }
        }
      }
    } catch (err: any) {
      logger.logError('LOOP_ERROR', err.message);
    }
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/trading-loop.test.ts
```

Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add tests/trading-loop.test.ts src/trading-loop.ts
git commit -m "feat: add trading loop with fetch → analyze → validate → execute cycle"
```

---

## Task 11: Entry Point

**Files:**
- Create: `src/index.ts`

**Step 1: Write the entry point**

```typescript
import 'dotenv/config';
import OpenAI from 'openai';
import { loadConfig } from './config.js';
import { createBinanceClient } from './binance/client.js';
import { MarketDataFetcher } from './binance/market-data.js';
import { OrderExecutor } from './binance/orders.js';
import { LLMClient } from './llm/client.js';
import { RiskManager } from './risk/manager.js';
import { SignalBuffer } from './webhook/signal-buffer.js';
import { createWebhookServer } from './webhook/server.js';
import { TradingLoop } from './trading-loop.js';
import { Logger } from './logger/index.js';

async function main() {
  const config = loadConfig();
  const logger = new Logger('logs');

  console.log('=== AI Futures Trading Bot ===');
  console.log(`Pairs: ${config.trading.pairs.join(', ')}`);
  console.log(`Max leverage: ${config.trading.maxLeverage}x`);
  console.log(`Loop interval: ${config.trading.loopIntervalMs / 1000}s`);
  console.log(`Max loss: $${config.trading.maxLossUsd}`);
  console.log(`Testnet: ${config.binance.testnet}`);
  console.log('==============================\n');

  // Initialize components
  const binanceClient = createBinanceClient(config.binance);
  const marketData = new MarketDataFetcher(binanceClient);
  const orders = new OrderExecutor(binanceClient);

  const openai = new OpenAI({ apiKey: config.openai.apiKey });
  const llm = new LLMClient(openai, config.openai.model);

  const riskManager = new RiskManager({
    maxLeverage: config.trading.maxLeverage,
    maxPositionPct: config.trading.maxPositionPct,
    maxExposurePct: config.trading.maxExposurePct,
    maxStopLossPct: config.trading.maxStopLossPct,
    maxLossUsd: config.trading.maxLossUsd,
  });

  const signalBuffer = new SignalBuffer({ maxSize: 50, ttlMs: 30 * 60 * 1000 });

  // Start webhook server
  const app = createWebhookServer(signalBuffer, logger, config.webhook.secret);
  app.listen(config.webhook.port, () => {
    console.log(`Webhook server listening on :${config.webhook.port}`);
  });

  // Create trading loop
  const loop = new TradingLoop({
    pairs: config.trading.pairs,
    marketData,
    llm,
    orders,
    riskManager,
    signalBuffer,
    logger,
  });

  // Run loop
  console.log('Starting trading loop...\n');

  const runCycle = async () => {
    if (loop.isShutdown()) {
      console.log('\n*** BOT SHUTDOWN — max loss reached ***');
      process.exit(0);
    }

    console.log(`\n--- Cycle at ${new Date().toISOString()} ---`);
    await loop.runOnce();
  };

  // Run first cycle immediately
  await runCycle();

  // Then every N ms
  setInterval(runCycle, config.trading.loopIntervalMs);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

**Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point wiring all components together"
```

---

## Task 12: Run All Tests

**Step 1: Run the full test suite**

```bash
npx vitest run
```

Expected: ALL PASS (logger 4, signal-buffer 5, risk-manager 7, market-data 2, orders 4, llm 4, trading-loop 5 = 31 tests)

**Step 2: If any fail, fix and re-run**

**Step 3: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve test failures from integration"
```

---

## Task 13: Create .env and Manual Smoke Test

**Step 1: Copy .env.example to .env and fill in real values**

```bash
cp .env.example .env
# Edit .env with actual API keys
```

**Step 2: Run the bot in testnet mode**

```bash
BINANCE_TESTNET=true npx tsx src/index.ts
```

Expected: Bot starts, fetches market data, calls GPT, logs decisions. No real trades on testnet initially — verify the logs.

**Step 3: Test webhook**

In another terminal:
```bash
curl -X POST http://localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"signal":"BUY","pair":"BTCUSDT","indicator":"RSI","value":72,"timeframe":"1h"}'
```

Expected: `{"ok":true}` response, signal appears in next cycle's LLM context.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify bot runs end-to-end on testnet"
```
