import { useState, useRef, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Overview } from './pages/Overview';
import { Decisions } from './pages/Decisions';
import { Trades } from './pages/Trades';
import { Market } from './pages/Market';
import { LlmCosts } from './pages/LlmCosts';
import { Swarm } from './pages/Swarm';
import { Chat } from './pages/Chat';
import { Wiki } from './pages/Wiki';
import { Tokens } from './pages/Tokens';

const primaryNav = [
  { to: '/', label: 'Dashboard' },
  { to: '/trades', label: 'Trades' },
  { to: '/swarm', label: 'Engine' },
];

const secondaryNav = [
  { to: '/market', label: 'Market' },
  { to: '/decisions', label: 'Decisions' },
  { to: '/costs', label: 'LLM Costs' },
  { to: '/chat', label: 'Chat' },
  { to: '/wiki', label: 'Wiki' },
  { to: '/tokens', label: 'Tokens' },
];

function MoreMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`text-sm px-2 py-1.5 border-b-2 transition-colors ${
          open ? 'border-accent text-fg' : 'border-transparent text-fg-faint hover:text-fg-muted'
        }`}
      >
        &bull;&bull;&bull;
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-surface-2 border border-border rounded-lg shadow-xl py-1 min-w-[140px] z-50">
          {secondaryNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `block px-4 py-2 text-sm transition-colors ${
                  isActive ? 'text-accent bg-surface-3' : 'text-fg-muted hover:text-fg hover:bg-surface-3/50'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem('theme');
    if (stored) return stored === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  return (
    <BrowserRouter>
      <div className="min-h-screen bg-surface-0 text-fg">
        <nav className="border-b border-border px-6 py-3 flex items-center gap-1">
          <span className="font-mono font-bold text-accent text-base mr-6 tracking-tight">Indic<span className="text-fg-muted font-normal text-xs ml-1">bot</span></span>
          {primaryNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `text-sm px-3 py-1.5 border-b-2 transition-colors ${
                  isActive
                    ? 'border-accent text-fg'
                    : 'border-transparent text-fg-muted hover:text-fg'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
          <MoreMenu />
          <button onClick={() => setDark(!dark)} className="ml-auto text-sm px-2 py-1 rounded" style={{ color: 'var(--text-muted)' }}>
            {dark ? '\u2600\uFE0F' : '\uD83C\uDF19'}
          </button>
        </nav>
        <main className="max-w-7xl mx-auto p-6">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/trades" element={<Trades />} />
            <Route path="/market" element={<Market />} />
            <Route path="/costs" element={<LlmCosts />} />
            <Route path="/swarm" element={<Swarm />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/wiki" element={<Wiki />} />
            <Route path="/tokens" element={<Tokens />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
