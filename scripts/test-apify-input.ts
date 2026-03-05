import * as dotenv from 'dotenv';
dotenv.config();

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

async function checkInput() {
    const storeId = 'QIv6WNCl7jZF3NZL4';
    const url = `https://api.apify.com/v2/key-value-stores/${storeId}/records/INPUT?token=${APIFY_TOKEN}`;
    const res = await fetch(url);
    const data = await res.json();
    console.log('INPUT configuration:', JSON.stringify(data, null, 2));
}

checkInput().catch(console.error);
