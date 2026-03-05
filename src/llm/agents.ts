import type { LLMClient } from './client.js';

export interface Layer1Inputs {
    newsData: string;
    macroData: string;
    memoryData: string;
}

export interface Layer1Outputs {
    newsReport: string;
    macroReport: string;
    memoryReport: string;
}

export async function runLayer1Experts(llm: LLMClient, inputs: Layer1Inputs): Promise<Layer1Outputs> {
    // We run 3 parallel LLM calls to distill noisy data into clean summaries for Layer 2.
    const [news, macro, soul] = await Promise.all([
        llm.call('You are NewsExpert. Summarize catalysts as JSON.', inputs.newsData),
        llm.call('You are MacroExpert. Summarize risk as JSON.', inputs.macroData),
        llm.call('You are MemoryExpert. Review past failures and warn as JSON.', inputs.memoryData)
    ]);

    return {
        newsReport: news,
        macroReport: macro,
        memoryReport: soul
    };
}
