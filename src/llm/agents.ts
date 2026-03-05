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
    const results = await Promise.allSettled([
        llm.call('You are NewsExpert. Summarize catalysts as JSON.', inputs.newsData),
        llm.call('You are MacroExpert. Summarize risk as JSON.', inputs.macroData),
        llm.call('You are MemoryExpert. Review past failures and warn as JSON.', inputs.memoryData)
    ]);

    const extract = (r: PromiseSettledResult<string>, label: string): string => {
        if (r.status === 'fulfilled') return r.value;
        console.warn(`[Layer1] ${label} expert failed:`, r.reason);
        return '';
    };

    return {
        newsReport: extract(results[0], 'News'),
        macroReport: extract(results[1], 'Macro'),
        memoryReport: extract(results[2], 'Memory')
    };
}
