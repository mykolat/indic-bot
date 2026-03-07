import type { DbDailyDirective, DbHourlyPlan } from '../db/types.js';

export type DailyDirective = DbDailyDirective;
export type HourlyPlan = DbHourlyPlan;

export interface SessionDeps {
  llm: { call: (system: string, user: string) => Promise<string> };
  grok?: { call: (system: string, user: string) => Promise<string> };
  sessionId: string;
  pairs: string[];
}

export interface MarketContext {
  regimes: Record<string, { regime: string; confidence: number }>;
  fearGreed: { value: number; label: string };
  macroSummary?: string;
  newsSummary?: string;
  memoryContent?: string;
  portfolioSummary?: string;
}
