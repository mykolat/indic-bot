import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Overview } from './pages/Overview';
import { Decisions } from './pages/Decisions';
import { Trades } from './pages/Trades';
import { Market } from './pages/Market';
import { LlmCosts } from './pages/LlmCosts';
import { Swarm } from './pages/Swarm';
import { Chat } from './pages/Chat';

const navItems = [
  { to: '/', label: 'Overview' },
  { to: '/decisions', label: 'Decisions' },
  { to: '/trades', label: 'Trades' },
  { to: '/market', label: 'Market' },
  { to: '/costs', label: 'LLM Costs' },
  { to: '/swarm', label: 'Swarm' },
  { to: '/chat', label: 'Chat' },
];

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-surface-0 text-[#e4e4ed]">
        <nav className="border-b border-border px-6 py-3 flex items-center gap-1">
          <span className="font-mono font-bold text-accent text-base mr-6 tracking-tight">Indic<span className="text-zinc-500 font-normal text-xs ml-1">bot</span></span>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `text-sm px-3 py-1.5 border-b-2 transition-colors ${
                  isActive
                    ? 'border-accent text-white'
                    : 'border-transparent text-zinc-500 hover:text-zinc-300'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
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
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
