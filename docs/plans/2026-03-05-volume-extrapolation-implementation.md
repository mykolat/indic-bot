# Volume Extrapolation & Audit Formatting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Fix the false "dead tape" rejections at the start of each hour by extrapolating current volume, and clean up the confidence format in the audit scripts.

**Architecture:** Change `volumeRatio` to take `openTimes`, extrapolating current 1h volume up to 5x average if it's 10-60 mins old, or falling back to the previous candle if < 10 mins old. This prevents 0.02x volume blocks. Also lowers Range `volumeMin` slightly to allow quiet trading, and formats `confidence/2` to `confidence.toFixed(1)%` in audits.

**Tech Stack:** TypeScript, Node.js, Vitest.

---

### Task 1: Update Confidence Formatting in Audits

**Files:**
- Modify: `scripts/audit.ts`
- Modify: `scripts/audit-md.ts`

**Step 1: Modify `scripts/audit.ts`**
Change `row('Confidence', \`\${confidence}/2\`);` to `row('Confidence', \`\${confidence.toFixed(1)}%\`);` around line 172.

**Step 2: Modify `scripts/audit-md.ts`**
Change `| **Confidence** | \${confidence}/2 |` to `| **Confidence** | \${confidence.toFixed(1)}% |` around line 240.

**Step 3: Commit**
```bash
git add scripts/audit.ts scripts/audit-md.ts
git commit -m "fix: format regime confidence as percentage in audits #gemini"
```

---

### Task 2: Extrapolate Volume Ratio

**Files:**
- Modify: `src/indicators/technical.ts`
- Test: `tests/indicators/technical.test.ts`

**Step 1: Write the failing test**
In `tests/indicators/technical.test.ts`, add:
```typescript
  it('extrapolates volume when openTimes are provided', () => {
    const volumes = [...Array(20).fill(1000), 100]; // last volume is 100
    const now = Date.now();
    // 15 mins into the candle
    const openTimes = [...Array(20).fill(0), now - 15 * 60000];
    const ratio = computeVolumeRatio(volumes, openTimes);
    // 100 * (60/15) = 400. 400/1000 = 0.4
    expect(ratio).toBeCloseTo(0.4, 1);
  });

  it('uses previous volume if candle is younger than 10 mins', () => {
    const volumes = [...Array(20).fill(1000), 10]; // last volume is 10
    const now = Date.now();
    // 5 mins into the candle
    const openTimes = [...Array(20).fill(0), now - 5 * 60000];
    const ratio = computeVolumeRatio(volumes, openTimes);
    expect(ratio).toBeCloseTo(1.0, 1); // Uses previous volume (1000)
  });
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/indicators/technical.test.ts`

**Step 3: Write minimal implementation**
In `src/indicators/technical.ts`, update `computeVolumeRatio` and `computeIndicators`:
```typescript
export function computeVolumeRatio(volumes: number[], openTimes?: number[], period = 20): number {
  if (volumes.length < 2) return 1;
  const avgSlice = volumes.slice(-period - 1, -1);
  const avg = avgSlice.reduce((s, v) => s + v, 0) / avgSlice.length;
  if (avg === 0) return 1;
  
  let currentVol = volumes[volumes.length - 1];

  if (openTimes && openTimes.length > 0) {
    const lastOpenTime = openTimes[openTimes.length - 1];
    const ageMins = (Date.now() - lastOpenTime) / 60000;
    
    if (ageMins >= 10 && ageMins < 60) {
      currentVol = Math.min(currentVol * (60 / ageMins), avg * 5);
    } else if (ageMins < 10) {
      currentVol = volumes[volumes.length - 2] ?? currentVol;
    }
  }

  return currentVol / avg;
}

export function computeIndicators(
  closes: number[], highs: number[], lows: number[], volumes: number[] = [], openTimes?: number[]
): Indicators {
  // ... other code ...
  const volumeRatio = volumes.length > 0 ? computeVolumeRatio(volumes, openTimes) : 1;
  // ... rest of the code ...
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/indicators/technical.test.ts`

**Step 5: Commit**
```bash
git add tests/indicators/technical.test.ts src/indicators/technical.ts
git commit -m "feat: extrapolate volume ratio for active candles #gemini"
```

---

### Task 3: Wire Extrapolation & Modify Filter Profiles

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `scripts/audit.ts`
- Modify: `scripts/audit-md.ts`
- Modify: `src/market/filter-profiles.ts`

**Step 1: Wire openTimes into loop**
In `src/trading-loop.ts`, `scripts/audit.ts`, and `scripts/audit-md.ts`, find where `computeIndicators` is called and pass `openTimes`. Example:
```typescript
const openTimes = klines.map(k => k.openTime || k[0]); // fallback for raw klines
const btcInd = computeIndicators(closes, highs, lows, volumes, openTimes);
```

**Step 2: Update `Range` volume bound**
In `src/market/filter-profiles.ts`, locate `[MarketRegime.Range]`, and change `volumeMin: 0.5` to `volumeMin: 0.4`.

**Step 3: Test and build**
Run: `npx vitest run`
Run: `npm run build`

**Step 4: Commit**
```bash
git add src/trading-loop.ts scripts/audit.ts scripts/audit-md.ts src/market/filter-profiles.ts
git commit -m "feat: wire volume extrapolation and lower range threshold #gemini"
```
