import { useRef, useState } from 'react';
import { ChatMessage } from '../components/ChatMessage';
import { streamChat } from '../lib/chat';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  'What is the current balance and PnL?',
  'Which orders were rejected and why?',
  'Show the latest Swarm debate results',
  'Why did the bot choose SHORT on ADA?',
  'What errors occurred in the last hour?',
  'How many cycles ran today?',
];

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  const sendMessage = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMsg: Message = { role: 'user', content: text.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsStreaming(true);

    let content = '';
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamChat(text.trim(), anonKey)) {
        content += chunk;
        setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', content }]);
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    } catch (err: any) {
      content += `\n\n[Error: ${err.message}]`;
      setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', content }]);
    }

    setIsStreaming(false);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <h1 className="text-xl font-bold mb-4">Bot Assistant</h1>

      <div className="flex-1 overflow-y-auto space-y-3 mb-4">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-zinc-500 text-sm">Ask anything about the bot's activity:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-full"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessage key={i} role={m.role} content={m.content} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendMessage(input)}
          placeholder="Ask about the bot..."
          disabled={isStreaming}
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-zinc-500"
        />
        <button
          onClick={() => sendMessage(input)}
          disabled={isStreaming || !input.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
        >
          Send
        </button>
      </div>
    </div>
  );
}
