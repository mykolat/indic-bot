import os from 'node:os';
import { execSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import type { MarketSnapshot } from '../binance/market-data.js';
import type { PortfolioState, TradeDecision } from '../risk/manager.js';
import type { TradingViewSignal } from '../webhook/signal-buffer.js';
import { SYSTEM_PROMPT, buildUserPrompt, buildSystemPrompt, type EnrichedPromptData } from './prompts.js';
import { TokenLogger } from './token-logger.js';
import { insertLlmConversation } from '../db/repository.js';
import { parseDecisions } from './decision-schema.js';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex/responses';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

function extractAccountId(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT token');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (!accountId) throw new Error('No chatgpt_account_id in token');
  return accountId;
}

export class LLMClient {
  private accountId: string;
  private systemPrompt: string;
  private tokenLogger = new TokenLogger('logs/tokens.jsonl');
  private _rateLimitHeaders: Record<string, string> = {};

  get rateLimitHeaders(): Record<string, string> {
    return this._rateLimitHeaders;
  }

  constructor(
    private accessToken: string,
    private model: string,
    promptConfig?: { targetReturnPct: number; minTakeProfitPct: number; maxLeverage: number; maxPositionPct: number; maxStopLossPct: number },
  ) {
    this.accountId = extractAccountId(accessToken);
    this.systemPrompt = promptConfig ? buildSystemPrompt(promptConfig) : SYSTEM_PROMPT;
  }

  sessionId: string | undefined;
  cycleId: number | undefined;
  lastNextCheckMinutes: number | undefined;

  async analyze(
    data: EnrichedPromptData,
  ): Promise<TradeDecision[]> {
    try {
      const userPrompt = buildUserPrompt(data);

      const body = {
        model: this.model,
        store: false,
        stream: true,
        instructions: this.systemPrompt,
        input: [{ role: 'user', content: userPrompt }],
        text: { verbosity: 'medium' },
        include: ['reasoning.encrypted_content'],
      };

      const response = await fetch(CODEX_BASE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'chatgpt-account-id': this.accountId,
          'OpenAI-Beta': 'responses=experimental',
          'User-Agent': `indic-bot (${os.platform()} ${os.release()}; ${os.arch()})`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Codex API ${response.status}: ${errText.slice(0, 300)}`);
      }

      const promptLength = this.systemPrompt.length + userPrompt.length;
      const { content, usageIn, usageOut, estimated } = await this.streamSSE(response, promptLength);
      this.tokenLogger.log({ method: 'analyze', tokensIn: usageIn, tokensOut: usageOut, model: this.model, estimated });

      if (!content) {
        console.error('[LLM] Empty response from Codex API');
        return [];
      }

      let result = this.parseResponse(content);

      // Retry once if parse failed (null = parse error, [] = valid empty)
      if (result === null && content.length > 10) {
        console.log('[LLM] Parse failed, retrying with clarification prompt...');
        const retryBody = {
          model: this.model,
          store: false,
          stream: true,
          instructions: this.systemPrompt,
          input: [{ role: 'user', content: 'Your last response was not valid JSON. Respond ONLY with the JSON object containing "decisions" array. No explanation.' }],
          text: { verbosity: 'medium' },
          include: ['reasoning.encrypted_content'],
        };
        try {
          const retryResponse = await fetch(CODEX_BASE_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.accessToken}`,
              'chatgpt-account-id': this.accountId,
              'OpenAI-Beta': 'responses=experimental',
              'User-Agent': `indic-bot (${os.platform()} ${os.release()}; ${os.arch()})`,
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
            body: JSON.stringify(retryBody),
          });
          if (retryResponse.ok) {
            const retryPromptLen = this.systemPrompt.length + 100; // retry prompt is short
            const retryResult = await this.streamSSE(retryResponse, retryPromptLen);
            this.tokenLogger.log({ method: 'analyze', label: 'retry', tokensIn: retryResult.usageIn, tokensOut: retryResult.usageOut, model: this.model, estimated: retryResult.estimated });
            result = this.parseResponse(retryResult.content);
          }
        } catch (retryErr) {
          console.error('[LLM] Retry failed:', retryErr);
        }
      }

      // Save conversation to DB (fire-and-forget)
      if (this.sessionId) {
        insertLlmConversation({
          cycle_id: this.cycleId,
          session_id: this.sessionId,
          layer: 1,
          model: this.model,
          method: 'analyze',
          system_prompt: this.systemPrompt,
          user_prompt: userPrompt,
          raw_response: content,
          tokens_in: usageIn,
          tokens_out: usageOut,
          estimated,
          parsed_ok: result !== null,
        }).catch(() => {});
      }

      if (result) {
        this.lastNextCheckMinutes = result.nextCheckMinutes;
        if (result.nextCheckMinutes) {
          console.log(`[LLM] Next check in ${result.nextCheckMinutes} min`);
        }
        return result.decisions;
      }
      return [];
    } catch (err: any) {
      console.error('[LLM] API error:', err);
      this.emergencyAlert(err);
      throw err;  // Let TradingLoop switch to Layer 2/3
    }
  }

  private alertCount = 0;
  private readonly maxAlerts = 2;

  private emergencyAlert(err: any): void {
    if (process.env.NODE_ENV === 'test') return;
    if (this.alertCount >= this.maxAlerts) {
      console.error(`[LLM] Alert suppressed (limit ${this.maxAlerts} reached):`, err?.message);
      return;
    }
    this.alertCount++;
    console.error(`[LLM] Emergency alert ${this.alertCount}/${this.maxAlerts}:`, err?.message);
    try {
      const msg = err?.message || '';
      let text: string;

      if (msg.includes('401') || msg.includes('account_id') || msg.includes('Unauthorized')) {
        text = 'Токен AI прострочений, потрібна авторизація';
      } else if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
        text = 'Ліміт запитів до AI вичерпано';
      } else if (msg.match(/50[0-9]/)) {
        text = 'Сервер AI недоступний';
      } else if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('UND_ERR') || msg.includes('socket')) {
        text = 'Немає зʼєднання з AI';
      } else if (msg.includes('parse') || msg.includes('JSON') || msg.includes('decisions')) {
        text = 'AI відповів некоректно, не вдалося розпарсити рішення';
      } else {
        text = `Помилка AI: ${msg.slice(0, 60).replace(/"/g, '')}`;
      }

      execSync('afplay /System/Library/Sounds/Basso.aiff', { stdio: 'ignore' });
      execSync(`say "${text}"`, { stdio: 'ignore' });
    } catch {
      // Non-macOS or audio unavailable — silently skip
    }
  }

  private async streamSSE(response: Response, promptLength = 0): Promise<{ content: string; usageIn: number; usageOut: number; estimated: boolean }> {
    // Capture rate limit headers
    this._rateLimitHeaders = {};
    for (const key of ['x-codex-primary-used-percent', 'x-codex-secondary-used-percent',
      'x-codex-primary-reset-at', 'x-codex-secondary-reset-at',
      'x-codex-plan-type', 'x-codex-active-limit']) {
      const val = response.headers?.get(key);
      if (val) this._rateLimitHeaders[key] = val;
    }

    if (!response.body) {
      const text = await response.text();
      const result = this.parseSSEText(text);
      return { ...result, estimated: result.usageIn === 0 };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';
    let reasoning = '';
    let usageIn = 0;
    let usageOut = 0;

    console.log('[LLM] Streaming response...\n');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);

        if (!line.startsWith('data:')) {
          idx = buffer.indexOf('\n');
          continue;
        }

        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') {
          idx = buffer.indexOf('\n');
          continue;
        }

        try {
          const event = JSON.parse(data);

          // Reasoning/thinking deltas
          if (event.type === 'response.reasoning.delta' && event.delta) {
            reasoning += event.delta;
          }

          // Text output deltas
          if (event.type === 'response.output_text.delta' && event.delta) {
            output += event.delta;
          }

          // Response completed — extract full text as fallback and usage
          if (event.type === 'response.completed' && event.response?.output) {
            for (const item of event.response.output) {
              if (item.type === 'message' && item.content) {
                for (const block of item.content) {
                  if (block.type === 'output_text' && block.text && !output) {
                    output = block.text;
                  }
                }
              }
            }
            // Extract usage
            const usage = event.response.usage;
            if (usage) {
              usageIn = usage.input_tokens ?? 0;
              usageOut = usage.output_tokens ?? 0;
            }
          }
        } catch {}

        idx = buffer.indexOf('\n');
      }
    }

    console.log('\n');

    if (reasoning) {
      console.log(`[LLM] Reasoning: ${reasoning.length} chars`);
    }

    // Estimation fallback if API didn't provide usage
    let estimated = false;
    if (usageIn === 0 && usageOut === 0 && (promptLength > 0 || output.length > 0)) {
      usageIn = Math.ceil(promptLength / 4);
      usageOut = Math.ceil(output.length / 4);
      estimated = true;
    }

    return { content: output, usageIn, usageOut, estimated };
  }

  private parseSSEText(text: string): { content: string; usageIn: number; usageOut: number } {
    let output = '';

    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      try {
        const event = JSON.parse(data);
        if (event.type === 'response.output_text.delta' && event.delta) {
          output += event.delta;
        }
        if (event.type === 'response.completed' && event.response?.output) {
          for (const item of event.response.output) {
            if (item.type === 'message' && item.content) {
              for (const block of item.content) {
                if (block.type === 'output_text' && block.text) {
                  return { content: block.text, usageIn: 0, usageOut: 0 };
                }
              }
            }
          }
        }
      } catch {}
    }

    return { content: output, usageIn: 0, usageOut: 0 };
  }

  private parseResponse(content: string): { decisions: TradeDecision[]; nextCheckMinutes?: number } | null {
    const result = parseDecisions(content);
    if (!result) {
      this.logParseError(content, 'parseDecisions returned null');
      return null;
    }
    return { decisions: result.decisions, nextCheckMinutes: result.nextCheckMinutes };
  }

  private logParseError(content: string, reason: string): void {
    console.error(`[LLM] Parse failed: ${reason} — response: ${content.slice(0, 200)}`);
    try {
      mkdirSync('logs', { recursive: true });
      appendFileSync('logs/parse-errors.jsonl', JSON.stringify({
        ts: new Date().toISOString(),
        reason,
        response: content.slice(0, 2000),
      }) + '\n', 'utf-8');
    } catch { /* non-critical */ }
  }

  updateAccessToken(token: string): void {
    this.accessToken = token;
    this.accountId = extractAccountId(token);
  }

  async call(systemPrompt: string, userPrompt: string): Promise<string> {
    const body = {
      model: this.model,
      store: false,
      stream: true,
      instructions: systemPrompt,
      input: [{ role: 'user', content: userPrompt }],
      text: { verbosity: 'medium' },
    };

    const response = await fetch(CODEX_BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'chatgpt-account-id': this.accountId,
        'OpenAI-Beta': 'responses=experimental',
        'User-Agent': `indic-bot (${os.platform()} ${os.release()}; ${os.arch()})`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Codex API ${response.status}: ${errText.slice(0, 300)}`);
    }

    const callPromptLen = systemPrompt.length + userPrompt.length;
    const { content, usageIn, usageOut, estimated } = await this.streamSSE(response, callPromptLen);
    this.tokenLogger.log({ method: 'call', tokensIn: usageIn, tokensOut: usageOut, model: this.model, estimated });

    // Save to DB (fire-and-forget)
    if (this.sessionId) {
      insertLlmConversation({
        cycle_id: this.cycleId,
        session_id: this.sessionId,
        layer: 1,
        model: this.model,
        method: 'call',
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        raw_response: content,
        tokens_in: usageIn,
        tokens_out: usageOut,
        estimated,
      }).catch(() => {});
    }

    return content;
  }
}
