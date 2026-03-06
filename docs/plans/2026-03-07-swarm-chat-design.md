# Swarm Chat Redesign — Design Doc

## Goal

Transform the Swarm page from a dropdown+cards layout into a messenger-style chat interface where AI personas debate in a group chat, the Judge moderates between levels, and the user can inject messages as superuser.

## Inspiration

- Messenger/Telegram group chat UX (screenshot reference)
- `dashboard/tmp/ConosSelfDev/src/components/layout/TutorialChatbot.tsx` — chat bubble layout, auto-scroll, input bar patterns

## Layout

```
┌──────────────────────────────────────────────────┐
│  Swarm Debate                                    │
├────────────┬─────────────────────────────────────┤
│  SIDEBAR   │  CHAT THREAD                        │
│  (debates) │                                     │
│            │  ── Level 1: Analysis ──             │
│  ● Cyc 42  │                                     │
│  🟢🔴⚪🟢⚪│  🐂 Bull         reasoning...       │
│  14:32     │  🐻 Bear         reasoning...       │
│  "HOLD 45" │  🛡️ Risk         reasoning...       │
│            │  🔬 Structure    reasoning...       │
│  ○ Cyc 41  │  😈 DA           reasoning...       │
│  🔴🔴⚪🔴⚪│  📰 Narrative    reasoning...       │
│  12:15     │                                     │
│  "SHORT 72"│              ⚖️ Judge    [RIGHT]    │
│            │         "Розбіжність висока,        │
│  ○ Cyc 40  │          продовжуємо Level 2"       │
│  ...       │                                     │
│            │  ── Level 2: Critique ──             │
│            │                                     │
│            │  🐂 Bull    > 🐻: "funding не..."   │
│            │  😈 DA      > 🐂: "але shorts..."   │
│            │                                     │
│            │              ⚖️ Judge    [RIGHT]    │
│            │         "Consensus: HOLD, conf 45"  │
│            │                                     │
│            │  ── 👑 Superuser ──                  │
│            │  [  Type a message...    ] [Send]    │
├────────────┴─────────────────────────────────────┤
```

## Sidebar Item

Each debate in the sidebar:
- **Vote dots**: colored circles per persona (🟢=LONG, 🔴=SHORT, ⚪=HOLD)
- **Time**: `14:32` from `created_at`
- **Summary**: 1 line from judge_response (first ~60 chars) or "N experts, VERDICT"
- **Active state**: highlighted background

## Chat Messages

### Persona message (incoming, left-aligned)
```
┌──────────────────────────────────┐
│ 🐂  BULL THESIS           14:32 │
│ ┌──────────────────────────────┐ │
│ │ EMA200 bounce, RSI oversold, │ │
│ │ volume confirms reversal...  │ │
│ └──────────────────────────────┘ │
│                    conf: 72 LONG │
└──────────────────────────────────┘
```

### Reply message (quote-reply)
```
┌──────────────────────────────────┐
│ 😈  DEVIL'S ADVOCATE       14:33 │
│ ┌─ replying to 🐂 BULL ───────┐ │
│ │ "EMA200 bounce, RSI overs…" │ │
│ └──────────────────────────────┘ │
│ ┌──────────────────────────────┐ │
│ │ Crowded short, everyone sees │ │
│ │ the same bounce pattern...   │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

### Judge verdict (outgoing, right-aligned)
```
                 ┌──────────────────────┐
                 │           ⚖️  JUDGE  │
                 │ Consensus: HOLD      │
                 │ Conf: 45             │
                 │ Розбіжність висока,  │
                 │ продовжуємо Level 2  │
                 └──────────────────────┘
```

### Superuser message (gold accent)
```
┌──────────────────────────────────┐
│ 👑  SUPERUSER              14:35 │
│ ┌──────────────────────────────┐ │
│ │ Зверніть увагу на ETF flows  │ │
│ │ — вчора -$200M відтік        │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

### Level divider
```
─────────── Level 2: Critique ───────────
```

## Emoji Avatars

| Persona | Emoji | Color |
|---------|-------|-------|
| bull_thesis | 🐂 | #4ade80 (green) |
| bear_thesis | 🐻 | #f87171 (red) |
| risk_manager | 🛡️ | #eab308 (yellow) |
| market_structure | 🔬 | #60a5fa (blue) |
| devils_advocate | 😈 | #a78bfa (purple) |
| narrative_expert | 📰 | #fb923c (orange) |
| judge | ⚖️ | #e2e8f0 (light) |
| superuser | 👑 | #f59e0b (gold) |

## Vote Colors (sidebar dots)

| Vote | Color | Dot |
|------|-------|-----|
| LONG | #4ade80 | 🟢 |
| SHORT | #f87171 | 🔴 |
| HOLD | #71717a | ⚪ |

## Backend Changes

### DB Migration

```sql
ALTER TABLE swarm_personas ADD COLUMN phase INT DEFAULT 1;
ALTER TABLE swarm_personas ADD COLUMN reply_to_id INT REFERENCES swarm_personas(id);
```

### SwarmAgent Redesign

Current flow: 3 hardcoded stages (generate → critique → revise)
New flow: Dynamic loop (1-5 levels), Judge-as-moderator

```
Level 1: ALL personas speak
  → Judge verdict: {continue: bool, next_speakers: string[], verdict: string}
Level 2: Judge-selected personas respond (can reply to specific others)
  → Judge verdict: {continue: bool, ...}
...
Level N (max 5): Final verdict, stop
```

Key changes to `src/llm/swarm-agent.ts`:
1. Replace 3-stage hardcoded pipeline with `for (let level = 1; level <= 5; level++)` loop
2. After each level, run Judge with ALL prior messages as context
3. Judge returns `{continue, next_speakers[], verdict}` — if `continue=false`, stop
4. Store `phase=N` on each `swarm_personas` row
5. Store `reply_to_id` when a persona responds to a specific other

### Superuser Injection

- New webhook/API endpoint: `POST /api/swarm/inject` with `{debate_id, message}`
- Stores as `swarm_personas` row with `persona='superuser'`
- Next level includes superuser message in context
- Frontend: input bar at bottom of chat sends to this endpoint

## Frontend Components

### New/Modified Files
- `dashboard/src/pages/Swarm.tsx` — full rewrite
- `dashboard/src/components/swarm/DebateSidebar.tsx` — sidebar list
- `dashboard/src/components/swarm/ChatMessage.tsx` — single message bubble
- `dashboard/src/components/swarm/LevelDivider.tsx` — hr between levels
- `dashboard/src/components/swarm/SuperuserInput.tsx` — input bar

### Reused Patterns from TutorialChatbot
- Chat bubble alignment (`justify-end` / `justify-start`)
- Auto-scroll with `bottomRef`
- Input + send button layout
- Message list with overflow scroll

## Scope & Phasing

| Phase | What | Effort |
|-------|------|--------|
| **Phase 1** | Frontend: sidebar + chat layout with existing data (no phase/reply) | Small |
| **Phase 2** | DB migration: `phase` + `reply_to_id` columns | Small |
| **Phase 3** | Backend: SwarmAgent dynamic loop + Judge-as-moderator | Medium |
| **Phase 4** | Frontend: level dividers, reply quotes (needs Phase 2+3 data) | Small |
| **Phase 5** | Superuser injection: API + input bar | Medium |
