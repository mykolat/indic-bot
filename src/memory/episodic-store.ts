import * as fs from 'fs';
import { cosineSimilarity } from '../llm/embedding-client.js';

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
                this.episodes = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
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
}
