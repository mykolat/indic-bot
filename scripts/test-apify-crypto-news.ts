import * as dotenv from 'dotenv';
dotenv.config();

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

async function checkFinishedRunResults() {
    const datasetId = 'T4rX8X747J3VFxFBz';

    console.log(`Fetching dataset ${datasetId} from the successful run with 16 items...`);
    const datasetRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`);
    const items = await datasetRes.json();
    console.log(`Received ${items.length} news items.`);

    if (items.length > 0) {
        console.log('\nSample Item 1:');
        console.log(JSON.stringify(items[0], null, 2));

        if (items.length > 1) {
            console.log('\nSample Item 2:');
            console.log(JSON.stringify(items[1], null, 2));
        }
    }

}

checkFinishedRunResults().catch(console.error);
