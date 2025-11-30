require('dotenv').config({ path: '../.env' }); // Look for env in root
const axios = require('axios');
const BASE = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/,'');

if (!BASE) { 
  console.error('WEBHOOK_BASE_URL missing in .env'); 
  process.exit(1); 
}

async function ping(){ 
  try { 
    await axios.get(BASE + '/health', { timeout: 5000 }); 
    console.log(new Date().toISOString(),'ping ok'); 
  } catch(e){ 
    console.warn('ping fail', e.message); 
  } 
}

setInterval(ping, 5*60*1000);
ping();
