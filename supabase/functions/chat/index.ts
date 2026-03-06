import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const { question } = await req.json();
  if (!question) {
    return new Response(JSON.stringify({ error: 'Missing question' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const [cycleRes, decisionsRes, errorsRes, execRes, snapshotRes, closesRes, swarmRes] =
    await Promise.all([
      supabase.from('cycles').select('*').order('created_at', { ascending: false }).limit(3),
      supabase.from('trade_decisions')
        .select('pair, action, confidence, reasoning, regime, created_at')
        .order('created_at', { ascending: false }).limit(10),
      supabase.from('errors').select('code, message, created_at')
        .order('created_at', { ascending: false }).limit(10),
      supabase.from('trade_executions')
        .select('pair, side, fill_price, quantity, leverage, sl_price, tp_price, entry_thesis, opened_at')
        .order('opened_at', { ascending: false }).limit(5),
      supabase.from('market_snapshots')
        .select('pair, mark_price, funding_rate, created_at')
        .order('created_at', { ascending: false }).limit(8),
      supabase.from('trade_closes').select('*').order('closed_at', { ascending: false }).limit(5),
      supabase.from('swarm_personas')
        .select('persona, vote, confidence, reasoning')
        .order('created_at', { ascending: false }).limit(6),
    ]);

  const dbContext = `
## Recent Cycles (last 3)
${JSON.stringify(cycleRes.data, null, 2)}

## Trade Decisions (last 10)
${JSON.stringify(decisionsRes.data, null, 2)}

## Trade Executions (last 5)
${JSON.stringify(execRes.data, null, 2)}

## Trade Closes (last 5)
${JSON.stringify(closesRes.data, null, 2)}

## Recent Errors (last 10)
${JSON.stringify(errorsRes.data, null, 2)}

## Latest Market Prices
${JSON.stringify(snapshotRes.data, null, 2)}

## Latest Swarm Personas
${JSON.stringify(swarmRes.data, null, 2)}
`;

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!anthropicKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      stream: true,
      system: `You are the Indic Bot Dashboard Assistant. You help the user understand what their crypto trading bot is doing.
You have access to the bot's database. Answer questions about trades, decisions, errors, swarm debates, and bot health.
Be concise. Use numbers and specifics from the data. If data is missing, say so.
Answer in Ukrainian unless the user writes in English.

Current DB context:
${dbContext}`,
      messages: [{ role: 'user', content: question }],
    }),
  });

  return new Response(response.body, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
    },
  });
});
