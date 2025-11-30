// SOLANA HUNTER V10.1 - IMMORTAL WARLORD
// PART 1: Config & Self-Healing Worker System

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const https = require('https'); 
require('dotenv').config();

// --- 1. CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !WEBHOOK_BASE_URL) {
  console.error('❌ CRITICAL: Missing .env variables.');
  process.exit(1);
}

let ENABLE_RAYDIUM = (process.env.ENABLE_RAYDIUM === 'true') || false;
let ENABLE_PUMPFUN = (process.env.ENABLE_PUMPFUN === 'true') || true;

const POLL_INTERVAL_MS = 15000; 
const MSG_INTERVAL_MS = 350; 
const STATE_FILE = path.join(__dirname, 'state.json');

const DEFAULT_QUERIES = [
  'solana "contract address"',
  'deploying "pump.fun"',
  '"ca renounced" solana',
  'solana "ai agent"'
];

// --- 2. WORKER RESURRECTION SYSTEM ---
let worker;
const workerCallbacks = new Map();

function startWorker() {
  worker = new Worker(path.join(__dirname, 'worker.js'));
  
  worker.on('message', (msg) => {
    const cb = workerCallbacks.get(msg.id);
    if (cb) {
      if (msg.success) cb.resolve(msg.data);
      else cb.reject(new Error(msg.error));
      workerCallbacks.delete(msg.id);
    }
  });

  worker.on('error', (err) => {
    console.error('⚠️ WORKER CRASHED:', err);
    workerCallbacks.forEach(cb => cb.reject(new Error('Worker crashed')));
    workerCallbacks.clear();
    setTimeout(startWorker, 1000); // Auto-respawn
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      console.error(`⚠️ Worker stopped with exit code ${code}. Restarting...`);
      setTimeout(startWorker, 1000); // Auto-respawn
    }
  });
  
  console.log('✅ Worker Thread Online');
}
startWorker();

// Task Runner with Timeout (Prevents hanging)
function runWorkerTask(type, payload) {
  return new Promise((resolve, reject) => {
    const taskId = Date.now() + Math.random();
    
    // Timeout safety net: 10s
    const timeout = setTimeout(() => {
      if (workerCallbacks.has(taskId)) {
        workerCallbacks.delete(taskId);
        reject(new Error('Worker Timeout'));
      }
    }, 10000);

    workerCallbacks.set(taskId, { 
      resolve: (data) => { clearTimeout(timeout); resolve(data); }, 
      reject: (err) => { clearTimeout(timeout); reject(err); } 
    });

    worker.postMessage({ id: taskId, type, ...payload });
  });
}

// --- 3. STATE & CACHE ---
let state = { users: [], queries: [] };
function loadState(){
  try {
    if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    else { state = { users: (process.env.USERS_TO_MONITOR||'').split(',').map(s=>s.trim()).filter(Boolean), queries: DEFAULT_QUERIES }; saveState(); }
  } catch (e){ console.error('State Error:', e.message); }
}
function saveState(){ try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch(e){} }
loadState();

const CACHE = new Map();
function isCached(id) {
  if (CACHE.has(id)) return true;
  CACHE.set(id, Date.now());
  return false;
}
setInterval(() => { // Auto Prune 24h
  const now = Date.now();
  for (const [id, ts] of CACHE.entries()) if (now - ts > 86400000) CACHE.delete(id);
}, 3600000);

// --- 4. NETWORK HARDENING ---
const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const axiosFast = axios.create({ timeout: 12000, httpsAgent: agent, headers: { 'User-Agent': 'Mozilla/5.0 (Compatible; Bot/10.1)' } });

// GLOBAL NITTER POOL
const NITTER_NODES = [
  { host: "nitter.net", downUntil: 0 },
  { host: "xcancel.com", downUntil: 0 },
  { host: "nitter.poast.org", downUntil: 0 },
  { host: "nitter.tiekoetter.com", downUntil: 0 },
  { host: "nitter.privacyredirect.com", downUntil: 0 }
];

function getHealthyNode() {
  const healthy = NITTER_NODES.filter(n => n.downUntil < Date.now());
  return healthy.length > 0 ? healthy[Math.floor(Math.random() * healthy.length)] : null;
}

function markNodeDown(host) {
  const node = NITTER_NODES.find(n => n.host === host);
  if (node) {
    node.downUntil = Date.now() + (300000); // 5 min ban
    console.log(`⚠️ ${host} degraded. Banned 5m.`);
  }
}

function safeLog(...args){ console.log(new Date().toISOString(), ...args); }
// PART 2: Scanners & Trojan Deep Links

// 🦄 TROJAN-ONLY BUTTONS
function getTrojanButtons(ca, link = null) {
  const btns = [
    [ { text: '🦄 Trojan Quick Buy', url: `https://t.me/solana_trojanbot?start=${ca}` } ],
    [
      { text: '🦅 DexS', url: `https://dexscreener.com/solana/${ca}` },
      { text: '👻 Photon', url: `https://photon-sol.tinyastro.io/en/lp/${ca}` }
    ]
  ];
  if (link) btns.push([{ text: '🐦 Source Tweet', url: link }]);
  return btns;
}

function escapeHTML(text) {
  if (!text) return '';
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function fetchRSS(pathUrl){
  let node = getHealthyNode();
  // Fallback if all restricted
  if (!node) node = NITTER_NODES[Math.floor(Math.random() * NITTER_NODES.length)];

  try {
    const r = await axiosFast.get(`https://${node.host}/${pathUrl}`, { responseType: 'text' });
    if(r.data.includes('over capacity')) throw new Error('RateLimit');

    // ⚡ DELEGATE TO WORKER
    const items = await runWorkerTask('PARSE_RSS', { xml: r.data });
    return { items: items || [], host: node.host };

  } catch(e){
    markNodeDown(node.host);
    return null;
  }
}

// --- SCAN USERS ---
async function scanUsers(firstRun){
  for (const user of state.users){
    const res = await fetchRSS(`${user}/rss`);
    if (!res || !res.items) continue;
    
    const items = res.items.slice(0, 10); 
    for (const item of items){
      if (isCached(item.id)) continue;
      if (firstRun) continue; 

      const link = item.link || `https://x.com/${user}`;
      
      let msg = `<b>🐦 @${escapeHTML(user)} Tweeted:</b>\n\n${escapeHTML(item.snippet)}`;
      let buttons = [[{ text: '🐦 View Tweet', url: link }]];

      if (item.ca) {
        msg += `\n\n<b>💎 CA Detected:</b>\n<code>${escapeHTML(item.ca)}</code>`;
        buttons = getTrojanButtons(item.ca, link);
      } else {
        msg += `\n\n<tg-spoiler>via ${res.host}</tg-spoiler>`;
      }
      
      await enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: buttons } });
    }
  }
}

// --- SCAN QUERIES ---
async function runHunterQueries(firstRun){
  for (const query of state.queries){
    const res = await fetchRSS(`search/rss?f=tweets&q=${encodeURIComponent(query)}`);
    if (!res || !res.items) continue;

    for (const item of res.items){
      if (isCached(item.id)) continue;
      if (!item.ca) continue; 
      if (item.suspicious) continue;

      if (firstRun) continue; 

      const link = item.link || 'https://x.com/i/status/' + (item.id.match(/\d+/) || [''])[0];

      const msg = `<b>🔎 Hit: "${escapeHTML(query)}"</b>\n` +
                  `<b>💎 CA:</b> <code>${escapeHTML(item.ca)}</code>\n\n` +
                  `<i>${escapeHTML(item.snippet)}...</i>` +
                  `\n\n<tg-spoiler>via ${res.host}</tg-spoiler>`;
      
      await enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getTrojanButtons(item.ca, link) } });
    }
  }
}
// PART 3: Sniper, Dashboard & Safe Loop

// --- SNIPER ---
let pumpWS = null;
function startPumpFun(){
  if (!ENABLE_PUMPFUN) return;
  try {
    pumpWS = new WebSocket('wss://pumpportal.fun/ws');
    pumpWS.on('open', ()=> safeLog('🟢 PumpFun Connected'));
    pumpWS.on('message', data => {
      try {
        const p = JSON.parse(data);
        const ca = p.mint || p.token;
        if(ca && !isCached(ca)){
          const msg = `<b>💊 PumpFun Mint</b>\n<code>${escapeHTML(ca)}</code>`;
          enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getTrojanButtons(ca) } });
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
    const { data } = await axiosFast.get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1');
    for (const p of data?.data || []){
      if (p.attributes?.dex_id !== 'raydium') continue;
      const mint = p.attributes.base_token_address;
      if (!mint || KNOWN_POOLS.has(mint)) continue;
      
      KNOWN_POOLS.add(mint);
      if(KNOWN_POOLS.size > 2000) KNOWN_POOLS.clear();
      
      const msg = `<b>🔷 Raydium New Pool</b>\n<b>${escapeHTML(p.attributes.name)}</b>\n<code>${escapeHTML(mint)}</code>`;
      await enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getTrojanButtons(mint) } });
    }
  } catch(e){}
}

// --- SERVER ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  setImmediate(() => { try { bot.processUpdate(req.body); } catch(e){} });
});
app.get('/health', (req, res) => res.json({ status: 'ok', worker: 'active' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', async () => {
  safeLog(`🚀 V10.1 Immortal Started on Port ${PORT}`);
  try { await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${WEBHOOK_BASE_URL}/webhook`); } catch(e){}
});

// --- QUEUE ---
const queue = [];
let sending = false;
function enqueue(chatId, text, opts = {}) { queue.push({ chatId, text, opts }); if(!sending) processQueue(); }

async function processQueue(){
  if(sending || queue.length === 0) return;
  sending = true;
  while(queue.length > 0){
    const { chatId, text, opts } = queue.shift();
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...opts });
    } catch(e){
      if(e.response?.statusCode === 429){
        const wait = (e.response.parameters?.retry_after || 5) + 1;
        queue.unshift({ chatId, text, opts });
        await sleep(wait * 1000);
      } else { console.error(`Send Error: ${e.message}`); }
    }
    await sleep(MSG_INTERVAL_MS);
  }
  sending = false;
}

// --- DASHBOARD ---
let lastLoopTime = 0;
const dashMarkup = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '💊 PumpFun', callback_data: 'PF_TOGGLE'}, { text: '🔷 Raydium', callback_data: 'RAY_TOGGLE'}],
      [{ text: '🔄 Refresh', callback_data: 'REFRESH'}, { text: '🏥 Network', callback_data: 'HEALTH'}]
    ]
  }
};

async function sendDashboard(chatId, msgId = null) {
  const healthyNodes = NITTER_NODES.filter(n => n.downUntil < Date.now()).length;
  const status = `<b>🛡️ SOLANA HUNTER V10.1 (IMMORTAL)</b>\n\n` +
                 `⚡ <b>Engine:</b> Dual-Core Worker\n` +
                 `👤 <b>Users:</b> ${state.users.length}\n` +
                 `🔎 <b>Queries:</b> ${state.queries.length}\n` +
                 `⏱️ <b>Latency:</b> ${lastLoopTime}ms\n` +
                 `📡 <b>Nitter:</b> ${healthyNodes}/${NITTER_NODES.length} Active\n` +
                 `🦄 <b>Mode:</b> Trojan Only`;
  
  if(msgId) try{ await bot.editMessageText(status, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', ...dashMarkup }); }catch(e){}
  else await bot.sendMessage(chatId, status, { parse_mode: 'HTML', ...dashMarkup });
}

bot.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  const text = msg.text || '';
  if (text === '/start' || text === '/admin') return sendDashboard(TELEGRAM_CHAT_ID);
  if (text.startsWith('/adduser ')) {
    const u = text.split(' ')[1];
    if(u && !state.users.includes(u)) { state.users.push(u); saveState(); bot.sendMessage(TELEGRAM_CHAT_ID, `✅ Added: <b>${u}</b>`, { parse_mode: 'HTML' }); }
  }
  if (text.startsWith('/addquery ')) {
    const q = text.substring(10);
    if(q && !state.queries.includes(q)) { state.queries.push(q); saveState(); bot.sendMessage(TELEGRAM_CHAT_ID, `✅ Added: <b>${q}</b>`, { parse_mode: 'HTML' }); }
  }
});

bot.on('callback_query', async (q) => {
  if (String(q.message.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
  const d = q.data;
  if (d === 'PF_TOGGLE') { ENABLE_PUMPFUN = !ENABLE_PUMPFUN; if(ENABLE_PUMPFUN && !pumpWS) startPumpFun(); if(!ENABLE_PUMPFUN && pumpWS) {pumpWS.close(); pumpWS=null;} }
  if (d === 'RAY_TOGGLE') ENABLE_RAYDIUM = !ENABLE_RAYDIUM;
  if (d === 'HEALTH') {
    const report = NITTER_NODES.map(n => {
        const status = n.downUntil > Date.now() ? `🔴` : '🟢';
        return `${status} <b>${n.host}</b>`;
    }).join('\n');
    await bot.sendMessage(TELEGRAM_CHAT_ID, `<b>🏥 Network Health:</b>\n\n${report}`, { parse_mode: 'HTML' });
    return;
  }
  await bot.answerCallbackQuery(q.id, { text: 'Updated' });
  sendDashboard(TELEGRAM_CHAT_ID, q.message.message_id);
});

// --- SAFE LOOP ---
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function startSafeLoop(){
  safeLog('⚔️ V10.1 Immortal Engine - Syncing...');
  let firstRun = true; 
  if (ENABLE_PUMPFUN) startPumpFun();
  
  while(true){
    const start = Date.now();
    try {
      await Promise.allSettled([ scanUsers(firstRun), runHunterQueries(firstRun), checkRaydiumGecko() ]);
      if(firstRun) { safeLog('✅ Sync Complete.'); firstRun = false; }
    } catch(e){ console.error('Loop Error:', e.message); }
    lastLoopTime = Date.now() - start; 
    await sleep(POLL_INTERVAL_MS);
  }
}
startSafeLoop();
  
