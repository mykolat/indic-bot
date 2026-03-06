interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
}

export function ChatMessage({ role, content }: ChatMessageProps) {
  return (
    <div className={`flex ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
          role === 'user' ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-200'
        }`}
      >
        <pre className="whitespace-pre-wrap font-sans">{content}</pre>
      </div>
    </div>
  );
}
