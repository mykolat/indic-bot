import type { EmbeddingClient } from './embedding-client.js';
import type { EpisodicStore } from '../memory/episodic-store.js';

export class EpisodicAgent {
    constructor(
        private embeddingClient: EmbeddingClient,
        private store: EpisodicStore
    ) { }

    async getRelevantContext(currentStateDescription: string, topK: number = 3): Promise<string> {
        let embedding: number[];
        try {
            embedding = await this.embeddingClient.getEmbedding(currentStateDescription);
        } catch (e) {
            console.error('[EpisodicAgent] Failed to get embedding for query:', e);
            return '';
        }

        const matches = this.store.search(embedding, topK);
        // We only want highly relevant matches (e.g. cosine similarity > 0.7)
        const strongMatches = matches.filter(m => m.score > 0.7);

        if (strongMatches.length === 0) return '';

        let promptAddition = '### SIMILAR PAST EPISODES (Graph RAG)\n\nI have retrieved the most similar historical scenarios from your episodic memory. Use these outcomes to inform your current decision:\n\n';

        strongMatches.forEach((m, idx) => {
            const sign = m.episode.resultPnl >= 0 ? '+' : '';
            promptAddition += `**Episode ${idx + 1} (Relevance: ${(m.score * 100).toFixed(0)}%)**\n`;
            promptAddition += `- Scenario: ${m.episode.textSummary}\n`;
            promptAddition += `- Outcome: ${sign}${m.episode.resultPnl}%\n\n`;
        });

        return promptAddition;
    }
}
