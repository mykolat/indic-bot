import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Overview } from './pages/Overview';
import { Trades } from './pages/Trades';
import { Swarm } from './pages/Swarm';
import { Chat } from './pages/Chat';

const navItems = [
  { to: '/', label: 'Overview' },
  { to: '/trades', label: 'Trades' },
  { to: '/swarm', label: 'Swarm' },
  { to: '/chat', label: 'Chat' },
];

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-zinc-950 text-white">
        <nav className="border-b border-zinc-800 px-4 py-2 flex gap-4 items-center">
          <span className="text-sm font-bold text-zinc-300 mr-4">Indic Bot</span>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `text-sm px-3 py-1 rounded ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <main className="max-w-7xl mx-auto p-6">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/trades" element={<Trades />} />
            <Route path="/swarm" element={<Swarm />} />
            <Route path="/chat" element={<Chat />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
