import type pg from 'pg';
import { getPool } from './connection.js';
import type {
  DbSession, DbCycle, DbLlmConversation, DbTradeDecision,
  DbTradeExecution, DbTradeClose, DbRiskValidation, DbNewsArticle,
  DbNewsAnalysis, DbMacroSnapshot, DbMacroAnalysis, DbSwarmPersona,
  DbEpisodicMemory, DbTradeStory, DbMemoryReview, DbError,
  DbTokenUsage, DbWebhookSignal, DbIndicatorSnapshot, DbMarketSnapshot,
  DbSlTpAdjustment,
} from './types.js';

function q(): pg.Pool {
  return getPool();
}

// --- Sessions ---

export async function insertSession(s: Pick<DbSession, 'start_balance' | 'config'>): Promise<string> {
  const { rows } = await q().query(
    `INSERT INTO sessions (start_balance, config) VALUES ($1, $2) RETURNING id`,
    [s.start_balance, JSON.stringify(s.config)],
  );
  return rows[0].id;
}

export async function endSession(id: string): Promise<void> {
  await q().query(`UPDATE sessions SET ended_at = NOW() WHERE id = $1`, [id]);
}

// --- Cycles ---

export async function insertCycle(c: Omit<DbCycle, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO cycles (session_id, cycle_number, balance, session_pnl, open_positions, volume_ratio, confluence_score, confluence_factors, regime, regime_confidence, fear_greed_value, layer, filter_warning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [c.session_id, c.cycle_number, c.balance, c.session_pnl,
     c.open_positions ? JSON.stringify(c.open_positions) : null,
     c.volume_ratio, c.confluence_score, c.confluence_factors,
     c.regime, c.regime_confidence, c.fear_greed_value, c.layer, c.filter_warning],
  );
  return rows[0].id;
}

// --- LLM Conversations ---

export async function insertLlmConversation(c: Omit<DbLlmConversation, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO llm_conversations (cycle_id, session_id, layer, model, method, label, system_prompt, user_prompt, raw_response, reasoning_chain, tokens_in, tokens_out, estimated, latency_ms, parsed_ok, parse_error, blackboard_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [c.cycle_id, c.session_id, c.layer, c.model, c.method, c.label,
     c.system_prompt, c.user_prompt, c.raw_response, c.reasoning_chain,
     c.tokens_in, c.tokens_out, c.estimated ?? false, c.latency_ms,
     c.parsed_ok, c.parse_error,
     c.blackboard_state ? JSON.stringify(c.blackboard_state) : null],
  );
  return rows[0].id;
}

// --- Trade Decisions ---

export async function insertTradeDecision(d: Omit<DbTradeDecision, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO trade_decisions (conversation_id, cycle_id, pair, action, size_pct, leverage, stop_loss_pct, take_profit_pct, confidence, reasoning, regime, regime_confidence, regime_override, volume_ratio, confluence_score, confluence_factors)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [d.conversation_id, d.cycle_id, d.pair, d.action, d.size_pct, d.leverage,
     d.stop_loss_pct, d.take_profit_pct, d.confidence, d.reasoning,
     d.regime, d.regime_confidence, d.regime_override,
     d.volume_ratio, d.confluence_score, d.confluence_factors],
  );
  return rows[0].id;
}

// --- Trade Executions ---

export async function insertTradeExecution(e: Omit<DbTradeExecution, 'id' | 'opened_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO trade_executions (decision_id, pair, side, action, entry_price, fill_price, quantity, leverage, sl_price, tp_price, order_id, algo_sl_id, algo_tp_id, size_usd, entry_thesis, strategy_type, commission_usd, commission_asset)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [e.decision_id, e.pair, e.side, e.action, e.entry_price, e.fill_price,
     e.quantity, e.leverage, e.sl_price, e.tp_price, e.order_id,
     e.algo_sl_id, e.algo_tp_id, e.size_usd, e.entry_thesis, e.strategy_type ?? 'swing',
     e.commission_usd ?? 0, e.commission_asset ?? 'USDT'],
  );
  return rows[0].id;
}

// --- Trade Closes ---

export async function insertTradeClose(c: Omit<DbTradeClose, 'id' | 'closed_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO trade_closes (execution_id, close_decision_id, pair, exit_price, exit_reason, pnl_usd, pnl_pct, held_hours, order_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [c.execution_id, c.close_decision_id, c.pair, c.exit_price, c.exit_reason,
     c.pnl_usd, c.pnl_pct, c.held_hours, c.order_id],
  );
  return rows[0].id;
}

// --- Risk Validations ---

export async function insertRiskValidation(v: Omit<DbRiskValidation, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO risk_validations (decision_id, passed, rejection_reason, checks, shutdown_triggered)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [v.decision_id, v.passed, v.rejection_reason,
     v.checks ? JSON.stringify(v.checks) : null, v.shutdown_triggered ?? false],
  );
  return rows[0].id;
}

// --- News Articles ---

export async function insertNewsArticles(articles: Omit<DbNewsArticle, 'id' | 'fetched_at'>[]): Promise<void> {
  if (articles.length === 0) return;
  const client = await q().connect();
  try {
    for (const a of articles) {
      await client.query(
        `INSERT INTO news_articles (title, source, coins, sentiment, published_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (title, published_at) DO NOTHING`,
        [a.title, a.source, a.coins, a.sentiment, a.published_at || null],
      );
    }
  } finally {
    client.release();
  }
}

// --- News Analysis ---

export async function insertNewsAnalysis(a: Omit<DbNewsAnalysis, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO news_analyses (cycle_id, overall_sentiment, fed_stance, risk_appetite, dominance_trend, signals, risk_events, article_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [a.cycle_id, a.overall_sentiment, a.fed_stance, a.risk_appetite,
     a.dominance_trend, a.signals ? JSON.stringify(a.signals) : null,
     a.risk_events, a.article_count],
  );
  return rows[0].id;
}

// --- Macro Snapshots ---

export async function insertMacroSnapshot(s: Omit<DbMacroSnapshot, 'id' | 'fetched_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO macro_snapshots (wti, dxy, sp500, vix, eurusd, gold, btc_dominance)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [s.wti, s.dxy, s.sp500, s.vix, s.eurusd, s.gold, s.btc_dominance],
  );
  return rows[0].id;
}

// --- Macro Analyses ---

export async function insertMacroAnalysis(a: Omit<DbMacroAnalysis, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO macro_analyses (snapshot_id, cycle_id, summary, risk_level, key_factors)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [a.snapshot_id, a.cycle_id, a.summary, a.risk_level,
     a.key_factors ? JSON.stringify(a.key_factors) : null],
  );
  return rows[0].id;
}

// --- Swarm Personas ---

export async function insertSwarmPersona(p: Omit<DbSwarmPersona, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO swarm_personas (conversation_id, persona, model, raw_response, vote, confidence, reasoning, tokens_in, tokens_out, phase, reply_to_id, conflicts_with, signals)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [p.conversation_id, p.persona, p.model, p.raw_response, p.vote,
     p.confidence, p.reasoning, p.tokens_in, p.tokens_out, p.phase ?? 1, p.reply_to_id ?? null,
     p.conflicts_with ? JSON.stringify(p.conflicts_with) : null,
     p.signals ? JSON.stringify(p.signals) : null],
  );
  return rows[0].id;
}

// --- Episodic Memories ---

export async function upsertEpisodicMemory(m: Omit<DbEpisodicMemory, 'id' | 'created_at'>): Promise<number> {
  const embeddingStr = m.embedding ? `[${m.embedding.join(',')}]` : null;
  const { rows } = await q().query(
    `INSERT INTO episodic_memories (episode_key, state_description, outcome, embedding, similarity_score)
     VALUES ($1,$2,$3,$4::extensions.vector,$5)
     ON CONFLICT (episode_key) DO UPDATE SET
       state_description = EXCLUDED.state_description,
       outcome = EXCLUDED.outcome,
       embedding = EXCLUDED.embedding,
       similarity_score = EXCLUDED.similarity_score
     RETURNING id`,
    [m.episode_key, m.state_description, m.outcome, embeddingStr, m.similarity_score],
  );
  return rows[0].id;
}

export async function searchEpisodicMemories(queryEmbedding: number[], topK: number = 3, minScore: number = 0.7): Promise<Array<DbEpisodicMemory & { score: number }>> {
  const embeddingStr = `[${queryEmbedding.join(',')}]`;
  const { rows } = await q().query(
    `SELECT *, 1 - (embedding <=> $1::extensions.vector) AS score
     FROM episodic_memories
     WHERE 1 - (embedding <=> $1::extensions.vector) >= $2
     ORDER BY embedding <=> $1::extensions.vector
     LIMIT $3`,
    [embeddingStr, minScore, topK],
  );
  return rows;
}

// --- Trade Stories ---

export async function insertTradeStory(s: Omit<DbTradeStory, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO trade_stories (execution_id, close_id, pair, direction, entry_price, exit_price, pnl_pct, regime_at_entry, regime_at_exit, story, lesson)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [s.execution_id, s.close_id, s.pair, s.direction, s.entry_price,
     s.exit_price, s.pnl_pct, s.regime_at_entry, s.regime_at_exit,
     s.story, s.lesson],
  );
  return rows[0].id;
}

// --- Memory Reviews ---

export async function insertMemoryReview(r: Omit<DbMemoryReview, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO memory_reviews (session_id, cycle_number, trigger_reason, review_text, actions_taken)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [r.session_id, r.cycle_number, r.trigger_reason, r.review_text,
     r.actions_taken ? JSON.stringify(r.actions_taken) : null],
  );
  return rows[0].id;
}

// --- Errors ---

export async function insertError(e: Omit<DbError, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO errors (cycle_id, code, message, details, stack)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [e.cycle_id, e.code, e.message,
     e.details ? JSON.stringify(e.details) : null, e.stack],
  );
  return rows[0].id;
}

// --- Token Usage ---

export async function insertTokenUsage(t: Omit<DbTokenUsage, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO token_usage (conversation_id, model, method, label, tokens_in, tokens_out, estimated, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [t.conversation_id, t.model, t.method, t.label,
     t.tokens_in, t.tokens_out, t.estimated ?? false, t.cost_usd],
  );
  return rows[0].id;
}

// --- Webhook Signals ---

export async function insertWebhookSignal(s: Omit<DbWebhookSignal, 'id' | 'received_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO webhook_signals (pair, action, source, payload)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [s.pair, s.action, s.source ?? 'tradingview',
     s.payload ? JSON.stringify(s.payload) : null],
  );
  return rows[0].id;
}

export async function markWebhookSignalConsumed(id: number): Promise<void> {
  await q().query(`UPDATE webhook_signals SET consumed_at = NOW() WHERE id = $1`, [id]);
}

// --- Indicator Snapshots ---

export async function insertIndicatorSnapshot(i: Omit<DbIndicatorSnapshot, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO indicator_snapshots (cycle_id, pair, timeframe, rsi, ema_short, ema_long, macd, macd_signal, macd_histogram, adx, atr, atr_pct, vwap, vwap_diff_pct, bb_upper, bb_lower, bb_width, volume_ratio, trend)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [i.cycle_id, i.pair, i.timeframe, i.rsi, i.ema_short, i.ema_long,
     i.macd, i.macd_signal, i.macd_histogram, i.adx, i.atr, i.atr_pct,
     i.vwap, i.vwap_diff_pct, i.bb_upper, i.bb_lower, i.bb_width,
     i.volume_ratio, i.trend],
  );
  return rows[0].id;
}

// --- Market Snapshots ---

export async function insertMarketSnapshot(s: Omit<DbMarketSnapshot, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO market_snapshots (session_id, pair, mark_price, open_interest, funding_rate, long_short_ratio, order_book_bid_pct, order_book_ask_pct, imbalance_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [s.session_id, s.pair, s.mark_price, s.open_interest, s.funding_rate,
     s.long_short_ratio, s.order_book_bid_pct, s.order_book_ask_pct, s.imbalance_pct],
  );
  return rows[0].id;
}

export async function getLatestMarketSnapshot(pair: string): Promise<DbMarketSnapshot | null> {
  const { rows } = await q().query(
    `SELECT * FROM market_snapshots WHERE pair = $1 ORDER BY created_at DESC LIMIT 1`,
    [pair],
  );
  return rows[0] || null;
}

export async function getMarketSnapshotsSince(pair: string, sinceMinutes: number): Promise<DbMarketSnapshot[]> {
  const { rows } = await q().query(
    `SELECT * FROM market_snapshots
     WHERE pair = $1 AND created_at > NOW() - INTERVAL '1 minute' * $2
     ORDER BY created_at ASC`,
    [pair, sinceMinutes],
  );
  return rows;
}

// --- Open Position Contexts ---

export interface OpenPositionContext {
  id: number;
  pair: string;
  side: string;
  fill_price: number;
  sl_price: number;
  tp_price: number;
  entry_thesis: string;
  leverage: number;
  size_usd: number;
  opened_at: string;
}

// --- Recent Decisions ---

export interface RecentDecision {
  pair: string;
  action: string;
  confidence: number;
  reasoning: string;
  regime: string;
  created_at: string;
  execution_result?: string;
}

export async function getRecentDecisions(limit: number = 3): Promise<RecentDecision[]> {
  const { rows } = await q().query(
    `SELECT td.pair, td.action, td.confidence, td.reasoning, td.regime, td.created_at,
            CASE
              WHEN te.id IS NOT NULL THEN 'filled'
              WHEN e.message IS NOT NULL THEN 'ORDER_FAIL: ' || e.message
              ELSE NULL
            END as execution_result
     FROM trade_decisions td
     LEFT JOIN trade_executions te ON te.decision_id = td.id
     LEFT JOIN errors e ON e.cycle_id = td.cycle_id AND e.code = 'ORDER_FAIL'
     ORDER BY td.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getRecentDecisionsBySession(sessionId: string, limit: number = 20): Promise<RecentDecision[]> {
  const { rows } = await q().query(
    `SELECT td.pair, td.action, td.confidence, td.reasoning, td.regime, td.created_at,
            CASE
              WHEN te.id IS NOT NULL THEN 'filled'
              WHEN e.message IS NOT NULL THEN 'ORDER_FAIL: ' || e.message
              ELSE NULL
            END as execution_result
     FROM trade_decisions td
     LEFT JOIN trade_executions te ON te.decision_id = td.id
     LEFT JOIN errors e ON e.cycle_id = td.cycle_id AND e.code = 'ORDER_FAIL'
     WHERE td.session_id = $1
     ORDER BY td.created_at DESC
     LIMIT $2`,
    [sessionId, limit],
  );
  return rows;
}

export async function getOpenPositionContexts(pairs: string[]): Promise<OpenPositionContext[]> {
  if (pairs.length === 0) return [];
  const placeholders = pairs.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await q().query(
    `SELECT DISTINCT ON (te.pair)
            te.id, te.pair, te.side, te.fill_price, te.sl_price, te.tp_price,
            te.entry_thesis, te.leverage, te.size_usd, te.opened_at
     FROM trade_executions te
     LEFT JOIN trade_closes tc ON tc.execution_id = te.id
     WHERE te.pair IN (${placeholders})
       AND tc.id IS NULL
       AND te.fill_price IS NOT NULL
       AND te.opened_at > NOW() - INTERVAL '48 hours'
     ORDER BY te.pair, te.opened_at DESC`,
    pairs,
  );
  return rows;
}

// --- SL/TP Adjustments ---

export async function insertSlTpAdjustment(a: Omit<DbSlTpAdjustment, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO sl_tp_adjustments (cycle_id, execution_id, pair, side, old_sl, new_sl, old_tp, new_tp, reasoning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [a.cycle_id, a.execution_id, a.pair, a.side, a.old_sl, a.new_sl, a.old_tp, a.new_tp, a.reasoning],
  );
  return rows[0].id;
}

export async function updateExecutionSlTp(executionId: number, slPrice: number, tpPrice: number): Promise<void> {
  await q().query(
    `UPDATE trade_executions SET sl_price = $1, tp_price = $2 WHERE id = $3`,
    [slPrice, tpPrice, executionId],
  );
}
