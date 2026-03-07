export interface DbSession {
  id: string;
  start_balance: number;
  config: Record<string, unknown>;
  started_at: string;
  ended_at?: string;
}

export interface DbCycle {
  id?: number;
  session_id: string;
  cycle_number: number;
  balance: number;
  session_pnl?: number;
  open_positions?: Array<{ pair: string; side: string; sizeUsd: number; pnlPct: number }>;
  volume_ratio?: number;
  confluence_score?: number;
  confluence_factors?: string[];
  regime?: string;
  regime_confidence?: number;
  fear_greed_value?: number;
  layer?: number;
  filter_warning?: string;
  created_at?: string;
}

export interface DbLlmConversation {
  id?: number;
  cycle_id?: number;
  session_id?: string;
  layer: number;
  model: string;
  method: string;
  label?: string;
  system_prompt?: string;
  user_prompt?: string;
  raw_response?: string;
  reasoning_chain?: string;
  tokens_in?: number;
  tokens_out?: number;
  estimated?: boolean;
  latency_ms?: number;
  parsed_ok?: boolean;
  parse_error?: string;
  blackboard_state?: Record<string, unknown>;
  created_at?: string;
}

export interface DbTradeDecision {
  id?: number;
  conversation_id?: number;
  cycle_id?: number;
  pair: string;
  action: string;
  size_pct?: number;
  leverage?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  confidence?: number;
  reasoning?: string;
  regime?: string;
  regime_confidence?: number;
  regime_override?: string;
  volume_ratio?: number;
  confluence_score?: number;
  confluence_factors?: string[];
  created_at?: string;
}

export interface DbTradeExecution {
  id?: number;
  decision_id?: number;
  pair: string;
  side: string;
  action: string;
  entry_price?: number;
  fill_price?: number;
  quantity?: number;
  leverage?: number;
  sl_price?: number;
  tp_price?: number;
  order_id?: number;
  algo_sl_id?: string;
  algo_tp_id?: string;
  size_usd?: number;
  entry_thesis?: string;
  strategy_type?: string;
  commission_usd?: number;
  commission_asset?: string;
  regime_at_entry?: string;
  regime_confidence_at_entry?: number;
  filter_profile_at_entry?: string;
  confluence_at_entry?: number;
  was_swarm?: boolean;
  volume_ratio_at_entry?: number;
  fear_greed_at_entry?: number;
  opened_at?: string;
}

export interface DbTradeClose {
  id?: number;
  execution_id?: number;
  close_decision_id?: number;
  pair: string;
  exit_price?: number;
  exit_reason: string;
  pnl_usd?: number;
  pnl_pct?: number;
  held_hours?: number;
  regime_at_exit?: string;
  holding_time_minutes?: number;
  order_id?: number;
  closed_at?: string;
}

export interface DbRiskValidation {
  id?: number;
  decision_id?: number;
  passed: boolean;
  rejection_reason?: string;
  checks?: Record<string, boolean>;
  shutdown_triggered?: boolean;
  created_at?: string;
}

export interface DbNewsArticle {
  id?: number;
  title: string;
  source: string;
  coins?: string[];
  sentiment?: number;
  published_at?: string;
  fetched_at?: string;
}

export interface DbNewsAnalysis {
  id?: number;
  cycle_id?: number;
  overall_sentiment?: string;
  fed_stance?: string;
  risk_appetite?: string;
  dominance_trend?: string;
  signals?: unknown[];
  risk_events?: string[];
  article_count?: number;
  created_at?: string;
}

export interface DbMacroSnapshot {
  id?: number;
  wti?: number;
  dxy?: number;
  sp500?: number;
  vix?: number;
  eurusd?: number;
  gold?: number;
  btc_dominance?: number;
  fetched_at?: string;
}

export interface DbMacroAnalysis {
  id?: number;
  snapshot_id?: number;
  cycle_id?: number;
  summary?: string;
  risk_level?: string;
  key_factors?: unknown;
  created_at?: string;
}

export interface DbSwarmPersona {
  id?: number;
  conversation_id?: number;
  persona: string;
  model?: string;
  raw_response?: string;
  vote?: string;
  confidence?: number;
  reasoning?: string;
  tokens_in?: number;
  tokens_out?: number;
  phase?: number;
  reply_to_id?: number;
  conflicts_with?: Record<string, string>;
  signals?: { bullish?: string[]; bearish?: string[]; neutral?: string[] };
  created_at?: string;
}

export interface DbEpisodicMemory {
  id?: number;
  episode_key?: string;
  state_description?: string;
  outcome?: string;
  embedding?: number[];
  similarity_score?: number;
  created_at?: string;
}

export interface DbTradeStory {
  id?: number;
  execution_id?: number;
  close_id?: number;
  pair: string;
  direction: string;
  entry_price?: number;
  exit_price?: number;
  pnl_pct?: number;
  regime_at_entry?: string;
  regime_at_exit?: string;
  story?: string;
  lesson?: string;
  created_at?: string;
}

export interface DbMemoryReview {
  id?: number;
  session_id?: string;
  cycle_number?: number;
  trigger_reason?: string;
  review_text?: string;
  actions_taken?: unknown[];
  created_at?: string;
}

export interface DbError {
  id?: number;
  cycle_id?: number;
  code?: string;
  message: string;
  details?: unknown;
  stack?: string;
  created_at?: string;
}

export interface DbTokenUsage {
  id?: number;
  conversation_id?: number;
  model: string;
  method: string;
  label?: string;
  tokens_in?: number;
  tokens_out?: number;
  estimated?: boolean;
  cost_usd?: number;
  created_at?: string;
}

export interface DbWebhookSignal {
  id?: number;
  pair: string;
  action?: string;
  source?: string;
  payload?: unknown;
  consumed_at?: string;
  received_at?: string;
}

export interface DbIndicatorSnapshot {
  id?: number;
  cycle_id?: number;
  pair: string;
  timeframe: string;
  rsi?: number;
  ema_short?: number;
  ema_long?: number;
  macd?: number;
  macd_signal?: number;
  macd_histogram?: number;
  adx?: number;
  atr?: number;
  atr_pct?: number;
  vwap?: number;
  vwap_diff_pct?: number;
  bb_upper?: number;
  bb_lower?: number;
  bb_width?: number;
  volume_ratio?: number;
  trend?: string;
  created_at?: string;
}

export interface DbMarketSnapshot {
  id?: number;
  session_id?: string;
  pair: string;
  mark_price: number;
  open_interest?: number;
  funding_rate?: number;
  long_short_ratio?: number;
  order_book_bid_pct?: number;
  order_book_ask_pct?: number;
  imbalance_pct?: number;
  created_at?: string;
}

export interface DbSlTpAdjustment {
  id?: number;
  cycle_id?: number;
  execution_id?: number;
  pair: string;
  side: string;
  old_sl?: number;
  new_sl?: number;
  old_tp?: number;
  new_tp?: number;
  reasoning?: string;
  created_at?: string;
}

export interface DbDailyDirective {
  id?: string;
  session_id?: string;
  allowed_pairs: string[];
  pair_bias: Record<string, string>;
  max_exposure_pct: number;
  risk_appetite: string;
  banned_pairs: string[];
  key_levels: Record<string, { support: number[]; resistance: number[] }>;
  reasoning: string;
  valid_until?: string;
  created_at?: string;
}

export interface DbHourlyPlan {
  id?: string;
  directive_id?: string;
  session_id?: string;
  watchlist: string[];
  entry_zones: Record<string, { min: number; max: number; bias: string }>;
  position_notes: Record<string, string>;
  escalate_daily: boolean;
  reasoning: string;
  created_at?: string;
}

export interface DbExpertCall {
  id?: number;
  cycle_id?: number;
  tier: string;
  expert_name: string;
  llm_provider: string;
  input_tokens?: number;
  output_tokens?: number;
  result?: any;
  latency_ms?: number;
  created_at?: string;
}

export interface DbLiquidation {
  id?: number;
  session_id?: string;
  pair: string;
  long_liquidations: number;
  short_liquidations: number;
  long_liq_usd: number;
  short_liq_usd: number;
  spike_ratio: number;
  created_at?: string;
}
