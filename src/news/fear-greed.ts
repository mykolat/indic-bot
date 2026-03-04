import type { FearGreedData } from './types.js';

const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=1';

export async function fetchFearGreed(): Promise<FearGreedData> {
  try {
    const response = await fetch(FEAR_GREED_URL);
    if (!response.ok) throw new Error(`Fear & Greed API: ${response.status}`);

    const json = (await response.json()) as any;
    const entry = json.data?.[0];

    if (!entry) throw new Error('No Fear & Greed data');

    return {
      value: parseInt(entry.value, 10),
      label: entry.value_classification,
    };
  } catch (err) {
    console.error('[FearGreed] Error:', err);
    return { value: 50, label: 'Neutral' };
  }
}
