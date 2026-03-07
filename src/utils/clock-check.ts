export async function checkClockSkew(): Promise<number> {
  try {
    const before = Date.now();
    const res = await fetch('https://fapi.binance.com/fapi/v1/time');
    const after = Date.now();
    const data = await res.json() as { serverTime: number };
    const latency = (after - before) / 2;
    const localTime = before + latency;
    return data.serverTime - localTime;
  } catch {
    return 0;
  }
}

export async function warnIfClockSkewed(thresholdMs = 1000): Promise<void> {
  const skew = await checkClockSkew();
  const absSkew = Math.abs(skew);
  if (absSkew > thresholdMs) {
    console.error(`[Clock] WARNING: Local clock is ${absSkew}ms ${skew > 0 ? 'behind' : 'ahead of'} Binance. Risk of -1021 INVALID_TIMESTAMP errors. Run NTP sync.`);
  } else {
    console.log(`[Clock] Clock skew: ${absSkew}ms (OK)`);
  }
}
