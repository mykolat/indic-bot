import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EpisodicStore, type Episode } from '../../src/memory/episodic-store.js';
import * as fs from 'fs';
import * as path from 'path';

describe('EpisodicStore', () => {
    const testDir = path.join(process.cwd(), 'tmp_test_memory');
    const dbPath = path.join(testDir, 'memory-graph.json');

    beforeEach(() => {
        if (!fs.existsSync(testDir)) fs.mkdirSync(testDir);
    });

    afterEach(() => {
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
    });

    it('saves and loads episodes', () => {
        const store = new EpisodicStore(dbPath);
        const episode: Episode = {
            id: '1',
            timestamp: Date.now(),
            textSummary: 'Market chopped. Longed.',
            embedding: [0.1, 0.5],
            resultPnl: -2
        };

        store.addEpisode(episode);

        const store2 = new EpisodicStore(dbPath);
        expect(store2.getAll()).toHaveLength(1);
        expect(store2.getAll()[0].id).toBe('1');
    });

    it('evicts oldest episodes when exceeding maxEpisodes', () => {
        const store = new EpisodicStore(dbPath, 3);
        for (let i = 1; i <= 5; i++) {
            store.addEpisode({ id: `${i}`, timestamp: i, textSummary: `ep${i}`, embedding: [i], resultPnl: 0 });
        }

        const all = store.getAll();
        expect(all).toHaveLength(3);
        expect(all[0].id).toBe('3');
        expect(all[2].id).toBe('5');
    });

    it('retrieves top K similar episodes', () => {
        const store = new EpisodicStore(dbPath);
        store.addEpisode({ id: '1', timestamp: 1, textSummary: 'A', embedding: [1, 0], resultPnl: 0 }); // Sim: 1.0 (exact match)
        store.addEpisode({ id: '2', timestamp: 2, textSummary: 'B', embedding: [0, 1], resultPnl: 0 }); // Sim: 0.0 (orthogonal)
        store.addEpisode({ id: '3', timestamp: 3, textSummary: 'C', embedding: [0.707, 0.707], resultPnl: 0 }); // Sim: ~0.707

        const results = store.search([1, 0], 2);
        expect(results).toHaveLength(2);
        expect(results[0].episode.id).toBe('1');
        expect(results[1].episode.id).toBe('3');
    });
});
