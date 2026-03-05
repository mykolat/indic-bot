
import { RssNewsFetcher } from '../src/news/rss-fetcher.js';
import { fetchFearGreed } from '../src/news/fear-greed.js';
import { CryptoPanicClient } from '../src/news/cryptopanic.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    const fetcher = new RssNewsFetcher();
    console.log('--- RSS FETCH TEST ---');
    const news = await fetcher.fetchNews(20);
    console.log(`Successfully fetched ${news.length} items.`);

    const sources = [...new Set(news.map(n => n.source))];
    console.log('Sources found:', sources);

    if (news.length > 0) {
        console.log('\nSample items:');
        news.slice(0, 3).forEach((item, idx) => {
            console.log(`${idx + 1}. [${item.source}] ${item.title} (${item.date})`);
        });
    } else {
        console.log('WARNING: No news items found. Check network or source URLs.');
    }

    console.log('\n--- FEAR & GREED TEST ---');
    const fng = await fetchFearGreed();
    console.log(`Value: ${fng.value} (${fng.label})`);

    if (process.env.APIFY_API_TOKEN) {
        console.log('\n--- CRYPTOPANIC (APIFY) TEST ---');
        const cpFetcher = new CryptoPanicClient(process.env.APIFY_API_TOKEN);
        const cpNews = await cpFetcher.fetchNews(5);
        console.log(`Successfully fetched ${cpNews.length} items from CryptoPanic.`);
        cpNews.forEach((item, idx) => {
            console.log(`${idx + 1}. [${item.source}] ${item.title} (${item.date})`);
        });
    } else {
        console.log('\n--- CRYPTOPANIC TEST ---');
        console.log('Skipping: APIFY_API_TOKEN not found in .env');
    }
}

main().catch(console.error);
