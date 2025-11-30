// SOLANA HUNTER V2 - "THE TANK"
// PART 1: Config, State, and Pre-loaded Intel

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const RSSParser = require('rss-parser');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
require('dotenv').config();

// --- 1. CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');

// Fail fast if env is wrong
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !WEBHOOK_BASE_URL) {
  console.error('❌ CRITICAL: Missing .env variables. Check TELEGRAM_TOKEN/CHAT_ID/URL.');
  process.exit(1);
}

// Features Config
let ENABLE_RAYDIUM = (process.env.ENABLE_RAYDIUM === 'true') || false;
let ENABLE_PUMPFUN = (process.env.ENABLE_PUMPFUN === 'true') || true;

// Intervals
const POLL_INTERVAL_MS = 20000; // 20s (Safer for Nitter)
const MSG_INTERVAL_MS = 300;    // Rate limit protection

// File Paths
const STATE_FILE = path.join(__dirname, 'state.json');
const ALERTS_FILE = path.join(__dirname, 'alerts.log.json');

// --- 2. HIGH VALUE DEFAULT DATA ---
// These are the "Golden Queries" added by default if your state is empty.
const DEFAULT_QUERIES = [
  'solana "contract address"',   // The classic
  'deploying "pump.fun"',        // PumpFun dev announcements
  '"ca renounced" solana',       // Safety Plays
  'solana "ai agent"',           // Current Meta (AI)
  'solana gem 100x'              // Hype scanning
];

// --- 3. STATE MANAGEMENT ---
let state = { users: [], queries: [] };

function loadState(){
  try {
    if (fs.existsSync(STATE_FILE)){
      state = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    } else {
      // Initialize with defaults
      state = { 
        users: (process.env.USERS_TO_MONITOR||'').split(',').map(s=>s.trim()).filter(Boolean),
        queries: DEFAULT_QUERIES 
      };
      saveState();
    }
  } catch (e){ console.error('LoadState Error:', e.message); }
}

function saveState(){
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch(e){ console.error('SaveState Error:', e.message); }
}

loadState(); // Load immediately on start

// --- 4. HELPERS ---
function nowISO(){ return (new Date()).toISOString(); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function escapeMD(text){
  if (!text) return '';
  return String(text).replace(/([_*\[\]\(\)~`>#+\-=|{}.!\\])/g, '\\$1');
}
function extractCA(text){ 
  if (!text) return null; 
  // Matches standard Solana addresses (base58, 32-44 chars)
  const m = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/); 
  return m ? m[0] : null; 
}
function isSuspicious(text){ 
  if (!text) return false; 
  const bad = ['honeypot','scam','rug','steal','phish','fake_token','test_token']; 
  return bad.some(b => text.toLowerCase().includes(b));
}

// Logger
function safeLog(...args){ console.log(nowISO(), ...args); }
// PART 2: The Hunter Engine & Sniper

// --- 5. NETWORK & FETCHING ---
const axiosFast = axios.create({ timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (Compatible; Bot/2.0)' } });
const rssParser = new RSSParser();

// "Best & Fastest" Nitter Rotation
// Nitter is hard to keep alive. We use a pool and rotate on failure.
const NITTER_INSTANCES = [
  "nitter.privacydev.net", 
  "nitter.poast.org", 
  "nitter.lucabased.xyz",
  "nitter.freereddit.com"
];
let nitterIndex = 0;

async function fetchRSS(pathUrl){
  // Try up to 2 instances before giving up
  for(let i=0; i<2; i++){
    const host = NITTER_INSTANCES[nitterIndex % NITTER_INSTANCES.length];
    try {
      const url = `https://${host}/${pathUrl}`;
      const r = await axiosFast.get(url, { responseType: 'text' });
      const feed = await rssParser.parseString(r.data);
      if(!feed?.items?.length) throw new Error('empty');
      return { items: feed.items, host };
    } catch(e){
      nitterIndex++; // Rotate to next server
      if(i===1) return null; // Failed twice
    }
  }
}

// --- 6. HUNTING LOGIC ---
const SENT_IDS = new Set();
// Auto-prune memory every 4 hours
setInterval(() => { if (SENT_IDS.size > 15000) SENT_IDS.clear(); }, 4*60*60*1000);

async function scanUsers(){
  for (const user of state.users){
    const res = await fetchRSS(`${user}/rss`);
    if (!res) continue;
    
    for (const item of res.items){
      if (SENT_IDS.has(item.id || item.guid)) continue;
      SENT_IDS.add(item.id || item.guid);

      // FEATURE: Users send EVERYTHING (CA or not)
      const ca = extractCA(item.content || item.title);
      const link = item.link || `https://x.com/${user}`;
      const snippet = (item.contentSnippet || item.title || '').slice(0, 250);
      
      let msg = `*🐦 User Alert: @${escapeMD(user)}*\n\n${escapeMD(snippet)}`;
      if (ca) msg += `\n\n*💎 CA Detected:* \`${escapeMD(ca)}\`\n[DexScreener](${escapeMD('https://dexscreener.com/solana/' + ca)})`;
      msg += `\n[View Tweet](${escapeMD(link)})`;
      
      await enqueue(TELEGRAM_CHAT_ID, msg);
    }
  }
}

async function runHunterQueries(){
  for (const query of state.queries){
    const res = await fetchRSS(`search/rss?f=tweets&q=${encodeURIComponent(query)}`);
    if (!res) continue;

    for (const item of res.items){
      if (SENT_IDS.has(item.id || item.guid)) continue;
      
      // FEATURE: Queries only send if CA is found
      const ca = extractCA(item.content || item.title);
      if (!ca) continue; // Skip if no CA
      if (isSuspicious(item.content)) continue; // Skip scams

      SENT_IDS.add(item.id || item.guid);
      
      const snippet = (item.contentSnippet || item.title || '').slice(0, 200);
      const link = item.link || 'https://x.com/i/status/' + (item.id.match(/\d+/) || [''])[0];

      const msg = `*🔍 Query Hit: "${escapeMD(query)}"*` +
                  `\n\n*💎 CA:* \`${escapeMD(ca)}\`` +
                  `\n\n${escapeMD(snippet)}` +
                  `\n\n[DexScreener](${escapeMD('https://dexscreener.com/solana/' + ca)}) | [Tweet](${escapeMD(link)})`;
      
      await enqueue(TELEGRAM_CHAT_ID, msg);
    }
  }
}

// --- 7. SNIPER LOGIC (PumpFun & Raydium) ---
let pumpWS = null;
function startPumpFun(){
  if (!ENABLE_PUMPFUN) return;
  try {
    pumpWS = new WebSocket('wss://pumpportal.fun/ws');
    pumpWS.on('open', ()=> safeLog('🟢 PumpFun WS Connected'));
    pumpWS.on('message', data => {
      try {
        const p = JSON.parse(data);
        const ca = p.mint || p.token;
        if(ca && !SENT_IDS.has(ca)){
          SENT_IDS.add(ca); // Anti-spam
          const msg = `*💊 PumpFun New Mint*\n\`${escapeMD(ca)}\`\n[DexScreener](${escapeMD('https://dexscreener.com/solana/'+ca)})`;
          enqueue(TELEGRAM_CHAT_ID, msg);
        }
      } catch(e){}
    });
    pumpWS.on('error', ()=> setTimeout(startPumpFun, 5000));
    pumpWS.on('close', ()=> setTimeout(startPumpFun, 3000));
  } catch(e){ setTimeout(startPumpFun, 5000); }
}

const KNOWN_POOLS = new Set();
async function checkRaydiumGecko(){
  if (!ENABLE_RAYDIUM) return;
  try {
    // Lightweight check
    const { data } = await axiosFast.get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1');
    const pools = data?.data || [];
    for (const p of pools){
      if (p.attributes?.dex_id !== 'raydium') continue;
      const mint = p.attributes.base_token_address;
      const name = p.attributes.name;
      if (!mint) continue;
      
      if (!KNOWN_POOLS.has(mint)){
        KNOWN_POOLS.add(mint);
        if(KNOWN_POOLS.size > 2000) KNOWN_POOLS.clear();
        
        const msg = `*🔷 Raydium New Pool*\n*${escapeMD(name)}*\n\`${escapeMD(mint)}\`\n[DexScreener](${escapeMD('https://dexscreener.com/solana/'+mint)})`;
        await enqueue(TELEGRAM_CHAT_ID, msg);
      }
    }
  } catch(e){}
}
// PART 3: Telegram Server, Dashboard, and Safety Systems

// --- 8. TELEGRAM SERVER (Railway Optimized) ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const app = express();
app.use(express.json());

// ⚡ FAST WEBHOOK RESPONSE (Fixes 502 Errors)
app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  setImmediate(() => {
    try { bot.processUpdate(req.body); } 
    catch(e){ console.error('Update Error:', e.message); }
  });
});
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Bind to 0.0.0.0 (Fixes Railway Crash)
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', async () => {
  safeLog(`🚀 Tank Started on Port ${PORT}`);
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${WEBHOOK_BASE_URL}/webhook`;
    await axios.get(url);
    safeLog('Webhook Set Successfully');
  } catch(e){ safeLog('Webhook Set Failed:', e.message); }
});

// --- 9. MESSAGE QUEUE (Rate Limit Safety) ---
const queue = [];
let sending = false;
function enqueue(chatId, text){
  queue.push({ chatId, text });
  if(!sending) processQueue();
}
async function processQueue(){
  if(sending || queue.length === 0) return;
  sending = true;
  while(queue.length > 0){
    const { chatId, text } = queue.shift();
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
    } catch(e){
      if(e.response?.statusCode === 429) await sleep(5000); // Cool down
    }
    await sleep(MSG_INTERVAL_MS);
  }
  sending = false;
}

// --- 10. ADMIN DASHBOARD & COMMANDS ---
// Inline Keyboard
const dashMarkup = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🟢 PumpFun ON', callback_data: 'PF_ON'}, { text: '🔴 PumpFun OFF', callback_data: 'PF_OFF'}],
      [{ text: '🟢 Raydium ON', callback_data: 'RAY_ON'}, { text: '🔴 Raydium OFF', callback_data: 'RAY_OFF'}],
      [{ text: '🔄 Refresh Status', callback_data: 'REFRESH'}, { text: '🧹 Clear Cache', callback_data: 'CLEAR'}]
    ]
  }
};

bot.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  const text = msg.text || '';
  
  if (text === '/start' || text === '/admin') {
    const status = `*🛡️ Solana Hunter V2 Status*\n\n` +
                   `*Users Monitored:* ${state.users.length}\n` +
                   `*Active Queries:* ${state.queries.length}\n` +
                   `*PumpFun:* ${ENABLE_PUMPFUN ? '✅' : '❌'}\n` +
                   `*Raydium:* ${ENABLE_RAYDIUM ? '✅' : '❌'}\n` +
                   `*Memory Usage:* ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`;
    return bot.sendMessage(TELEGRAM_CHAT_ID, status, Object.assign({ parse_mode: 'MarkdownV2' }, dashMarkup));
  }

  // Commands
  if (text.startsWith('/adduser ')) {
    const u = text.split(' ')[1];
    if(u && !state.users.includes(u)) { state.users.push(u); saveState(); bot.sendMessage(TELEGRAM_CHAT_ID, `Added User: ${u}`); }
  }
  if (text.startsWith('/addquery ')) {
    const q = text.substring(10);
    if(q && !state.queries.includes(q)) { state.queries.push(q); saveState(); bot.sendMessage(TELEGRAM_CHAT_ID, `Added Query: ${q}`); }
  }
  if (text === '/list') {
    let msg = `*Users:*\n${state.users.join('\n')}\n\n*Queries:*\n${state.queries.join('\n')}`;
    bot.sendMessage(TELEGRAM_CHAT_ID, escapeMD(msg), { parse_mode: 'MarkdownV2' });
  }
});

bot.on('callback_query', async (q) => {
  if (String(q.message.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  const d = q.data;
  
  if (d === 'PF_ON') ENABLE_PUMPFUN = true;
  if (d === 'PF_OFF') ENABLE_PUMPFUN = false;
  if (d === 'RAY_ON') ENABLE_RAYDIUM = true;
  if (d === 'RAY_OFF') ENABLE_RAYDIUM = false;
  if (d === 'CLEAR') SENT_IDS.clear();
  
  if (d === 'REFRESH' || d.includes('_')) {
    bot.answerCallbackQuery(q.id, { text: 'Updated' });
    // Re-trigger dashboard update
    const status = `*🛡️ Solana Hunter V2 Status*\n\n*PumpFun:* ${ENABLE_PUMPFUN ? '✅' : '❌'}\n*Raydium:* ${ENABLE_RAYDIUM ? '✅' : '❌'}`;
    bot.sendMessage(TELEGRAM_CHAT_ID, status, Object.assign({ parse_mode: 'MarkdownV2' }, dashMarkup));
  }
  
  if (ENABLE_PUMPFUN && !pumpWS) startPumpFun();
  if (!ENABLE_PUMPFUN && pumpWS) { pumpWS.close(); pumpWS = null; }
});

// --- 11. THE SAFE LOOP (Prevents Overlap Crashes) ---
async function startSafeLoop(){
  safeLog('⚔️ Hunter Engine Started');
  if (ENABLE_PUMPFUN) startPumpFun();
  
  while(true){
    try {
      await Promise.allSettled([ scanUsers(), runHunterQueries(), checkRaydiumGecko() ]);
    } catch(e){ console.error('Loop Error:', e.message); }
    
    // Wait for interval AFTER work is done
    await sleep(POLL_INTERVAL_MS);
  }
}
startSafeLoop();
