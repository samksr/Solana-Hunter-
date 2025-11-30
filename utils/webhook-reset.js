require('dotenv').config();
const axios = require('axios');
const TOKEN = process.env.TELEGRAM_TOKEN;
const BASE = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/,'');
if (!TOKEN || !BASE) { console.error('Missing TELEGRAM_TOKEN or WEBHOOK_BASE_URL'); process.exit(1); }
(async ()=> {
  try {
    const url = `https://api.telegram.org/bot${TOKEN}/setWebhook?url=${encodeURIComponent(BASE + '/webhook')}`;
    const r = await axios.get(url, { timeout: 10000 });
    console.log('setWebhook result', r.data);
  } catch (e) { console.error('setWebhook failed', e.message); process.exit(1); }
})();
