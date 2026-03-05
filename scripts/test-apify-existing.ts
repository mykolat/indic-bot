import * as dotenv from 'dotenv';
dotenv.config();

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

async function checkExistingRun() {
    const runId = 'JrjFKs00ZOTWPVV6d';
    console.log(`Checking run ${runId}...`);
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    const data = await res.json();
    console.log('Run details:', JSON.stringify(data.data, null, 2));

    const logRes = await fetch(`https://api.apify.com/v2/logs/${runId}?token=${APIFY_TOKEN}`);
    const logText = await logRes.text();
    console.log('\nRun Logs:\n', logText.slice(-1000));
}

checkExistingRun().catch(console.error);
