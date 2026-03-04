import os from 'node:os';
import { execSync } from 'node:child_process';
import type { MarketSnapshot } from '../binance/market-data.js';
import type { PortfolioState, TradeDecision } from '../risk/manager.js';
import type { TradingViewSignal } from '../webhook/signal-buffer.js';
import { SYSTEM_PROMPT, buildUserPrompt, buildSystemPrompt, type EnrichedPromptData } from './prompts.js';

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

  constructor(
    private accessToken: string,
    private model: string,
    promptConfig?: { targetReturnPct: number; minTakeProfitPct: number; maxLeverage: number; maxPositionPct: number; maxStopLossPct: number },
  ) {
    this.accountId = extractAccountId(accessToken);
    this.systemPrompt = promptConfig ? buildSystemPrompt(promptConfig) : SYSTEM_PROMPT;
  }

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

      const content = await this.streamSSE(response);

      if (!content) {
        console.error('[LLM] Empty response from Codex API');
        return [];
      }

      return this.parseResponse(content);
    } catch (err: any) {
      console.error('[LLM] API error:', err);
      this.emergencyAlert(err);
      return [];
    }
  }

  private alertCount = 0;
  private readonly maxAlerts = 2;

  private emergencyAlert(err: any): void {
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

  private async streamSSE(response: Response): Promise<string> {
    if (!response.body) {
      const text = await response.text();
      return this.parseSSEText(text);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';
    let reasoning = '';

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
            process.stdout.write(`\x1b[90m${event.delta}\x1b[0m`);
          }

          // Reasoning summary
          if (event.type === 'response.reasoning_summary_text.delta' && event.delta) {
            process.stdout.write(`\x1b[33m${event.delta}\x1b[0m`);
          }

          // Text output deltas
          if (event.type === 'response.output_text.delta' && event.delta) {
            output += event.delta;
            process.stdout.write(event.delta);
          }

          // Response completed — extract full text as fallback
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
          }
        } catch {}

        idx = buffer.indexOf('\n');
      }
    }

    console.log('\n');

    if (reasoning) {
      console.log(`[LLM] Reasoning: ${reasoning.length} chars`);
    }

    return output;
  }

  private parseSSEText(text: string): string {
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
                  return block.text;
                }
              }
            }
          }
        }
      } catch {}
    }

    return output;
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

    return this.streamSSE(response);
  }
}
