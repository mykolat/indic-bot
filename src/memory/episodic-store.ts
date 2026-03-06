import * as fs from 'fs';
import { cosineSimilarity } from '../llm/embedding-client.js';
import { upsertEpisodicMemory, searchEpisodicMemories } from '../db/repository.js';

export interface Episode {
    id: string;
    timestamp: number;
    textSummary: string; // The text that was embedded
    embedding: number[];
    resultPnl: number;
    // We can add raw state snapshots here later if needed
}

export class EpisodicStore {
    private episodes: Episode[] = [];

    constructor(private filePath: string, private maxEpisodes: number = 500) {
        this.load();
    }

    private load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                if (Array.isArray(parsed)) {
                    this.episodes = parsed.filter(ep =>
                        ep && typeof ep.id === 'string' && Array.isArray(ep.embedding)
                    );
                } else {
                    console.error('Episodic store file is not an array, resetting');
                    this.episodes = [];
                }
            } catch (e) {
                console.error('Failed to load episodic graph', e);
                this.episodes = [];
            }
        }
    }

    private save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.episodes, null, 2));
    }

    addEpisode(episode: Episode) {
        this.episodes.push(episode);
        if (this.episodes.length > this.maxEpisodes) {
            this.episodes = this.episodes.slice(-this.maxEpisodes);
        }
        this.save();

        // Dual-write to DB (pgvector)
        upsertEpisodicMemory({
            episode_key: episode.id,
            state_description: episode.textSummary,
            outcome: String(episode.resultPnl),
            embedding: episode.embedding,
            similarity_score: episode.resultPnl,
        }).catch(() => {});
    }

    getAll(): Episode[] {
        return this.episodes;
    }

    search(queryEmbedding: number[], topK: number = 3): { episode: Episode; score: number }[] {
        const scored = this.episodes.map(ep => ({
            episode: ep,
            score: cosineSimilarity(queryEmbedding, ep.embedding)
        }));

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, Math.min(topK, scored.length));
    }

    async searchDb(queryEmbedding: number[], topK: number = 3): Promise<{ episode: Episode; score: number }[]> {
        try {
            const dbResults = await searchEpisodicMemories(queryEmbedding, topK, 0.7);
            if (dbResults.length > 0) {
                return dbResults.map(r => ({
                    episode: {
                        id: r.episode_key || String(r.id),
                        timestamp: new Date(r.created_at || '').getTime(),
                        textSummary: r.state_description || '',
                        embedding: [],  // Don't return full embeddings from DB
                        resultPnl: parseFloat(r.outcome || '0'),
                    },
                    score: r.score,
                }));
            }
        } catch {
            // Fall back to local search
        }
        return this.search(queryEmbedding, topK);
    }
}
