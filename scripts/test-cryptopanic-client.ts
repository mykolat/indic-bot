import * as dotenv from 'dotenv';
dotenv.config();
import { CryptoPanicClient } from '../src/news/cryptopanic.js';

async function testClient() {
    const token = process.env.APIFY_API_TOKEN;
    if (!token) {
        console.error('Missing APIFY_API_TOKEN');
        return;
    }

    const client = new CryptoPanicClient(token);
    console.log('Fetching news...');
    const news = await client.fetchNews(5);
    console.log(`Received ${news.length} news items.`);
    if (news.length > 0) {
        console.log('Sample item:', news[0]);
    }
}

testClient().catch(console.error);
