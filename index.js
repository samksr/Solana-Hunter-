// SOLANA HUNTER V13 - "CLEAN SWEEP"
// PART 1: Config, Network & Swarm List

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const https = require('https'); 
require('dotenv').config();

// --- 1. CONFIG ---
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

// ✅ RESTORED "AI AGENT" QUERY
const DEFAULT_QUERIES = [
  'solana "contract address"',
  'deploying "pump.fun"',
  '"ca renounced" solana',
  'solana "ai agent"'
];

// --- 2. WORKER LINK ---
const worker = new Worker(path.join(__dirname, 'worker.js'));
const workerCallbacks = new Map();

worker.on('message', (msg) => {
  const cb = workerCallbacks.get(msg.id);
  if (cb) {
    msg.success ? cb.resolve(msg.data) : cb.reject(new Error(msg.error));
    workerCallbacks.delete(msg.id);
  }
});

function runWorkerTask(type, payload) {
  return new Promise((resolve, reject) => {
    const taskId = Date.now() + Math.random();
    workerCallbacks.set(taskId, { resolve, reject });
    worker.postMessage({ id: taskId, type, ...payload });
    setTimeout(() => {
        if(workerCallbacks.has(taskId)) { workerCallbacks.delete(taskId); reject(new Error('Timeout')); }
    }, 8000);
  });
}

// --- 3. STATE ---
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
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of CACHE.entries()) if (now - ts > 86400000) CACHE.delete(id);
}, 3600000);

// --- 4. THE SWARM (Network) ---
const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const axiosFast = axios.create({ timeout: 10000, httpsAgent: agent, headers: { 'User-Agent': 'Mozilla/5.0' } });

// 20+ INSTANCES FOR MAX UPTIME
const NITTER_NODES = [
  { host: "nitter.net", downUntil: 0 },
  { host: "xcancel.com", downUntil: 0 },
  { host: "nitter.poast.org", downUntil: 0 },
  { host: "nitter.tiekoetter.com", downUntil: 0 },
  { host: "nitter.privacyredirect.com", downUntil: 0 },
  { host: "nitter.lucabased.xyz", downUntil: 0 },
  { host: "nitter.freereddit.com", downUntil: 0 },
  { host: "nitter.no-logs.com", downUntil: 0 },
  { host: "nitter.perennialte.ch", downUntil: 0 },
  { host: "nitter.uni-sonia.com", downUntil: 0 },
  { host: "nitter.moomoo.me", downUntil: 0 },
  { host: "nitter.dafriser.net", downUntil: 0 },
  { host: "nitter.soopy.moe", downUntil: 0 },
  { host: "nitter.rawbit.420blaze.it", downUntil: 0 },
  { host: "nitter.tinfoil-hat.net", downUntil: 0 }
];

function getHealthyNode() {
  const healthy = NITTER_NODES.filter(n => n.downUntil < Date.now());
  return healthy.length > 0 ? healthy[Math.floor(Math.random() * healthy.length)] : null;
}

function markNodeDown(host) {
  const node = NITTER_NODES.find(n => n.host === host);
  if (node) {
    node.downUntil = Date.now() + (60 * 1000); // 1 min cool-down
    console.log(`⚠️ ${host} degr
    aded.`);
  }
}
// PART 2: Scanners & Link Fixer

function escapeHTML(text) {
  if (!text) return '';
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function getButtons(ca, link = null) {
  const btns = [
    [ { text: '🦄 Trojan', url: `https://t.me/solana_trojanbot?start=${ca}` } ], 
    [
      { text: '🦅 DexS', url: `https://dexscreener.com/solana/${ca}` },
      { text: '👻 Photon', url: `https://photon-sol.tinyastro.io/en/lp/${ca}` }
    ]
  ];
  if (link) {
    // FIX: Force any Nitter/Twitter link to open as x.com
    // This solves "Source not opening"
    let cleanLink = link;
    try {
      const urlObj = new URL(link);
      cleanLink = `https://x.com${urlObj.pathname}`;
    } catch(e) { cleanLink = link; } // Fallback if invalid URL
    
    btns.push([{ text: '🐦 Source (X.com)', url: cleanLink }]);
  }
  return btns;
}

async function fetchRSS(pathUrl){
  let node = getHealthyNode();
  if (!node) node = NITTER_NODES[Math.floor(Math.random() * NITTER_NODES.length)];

  try {
    const r = await axiosFast.get(`https://${node.host}/${pathUrl}?t=${Date.now()}`, { responseType: 'text' });
    if(r.data.includes('over capacity')) throw new Error('RateLimit');
    const items = await runWorkerTask('PARSE_RSS', { xml: r.data });
    return { items: items || [], host: node.host };
  } catch(e){
    markNodeDown(node.host);
    return null;
  }
}

async function scanUsers(firstRun){
  for (const user of state.users){
    const res = await fetchRSS(`${user}/rss`);
    if (!res || !res.items) continue;
    
    for (const item of res.items.slice(0, 10)){
      if (isCached(item.id)) continue;
      if (firstRun) continue; 

      const link = item.link || `https://x.com/${user}`;
      let msg = `<b>🐦 @${escapeHTML(user)} Tweeted:</b>\n\n${escapeHTML(item.snippet)}`;
      
      // Basic button for tweets without CA
      let buttons = [[{ text: '🐦 View Tweet', url: `https://x.com/${user}/status/${item.id.split('/').pop()}` }]];

      if (item.ca) {
        msg += `\n\n<b>💎 CA:</b> <code>${escapeHTML(item.ca)}</code>`;
        buttons = getButtons(item.ca, link);
      } else {
        msg += `\n\n<tg-spoiler>via ${res.host}</tg-spoiler>`;
      }
      await enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: buttons } });
    }
  }
}

async function runHunterQueries(firstRun){
  for (const query of state.queries){
    const res = await fetchRSS(`search/rss?f=tweets&q=${encodeURIComponent(query)}`);
    if (!res || !res.items) continue;

    for (const item of res.items){
      if (isCached(item.id)) continue;
      if (!item.ca) continue; 
      if (item.suspicious) continue;
      if (firstRun) continue; 

      const link = item.link || `https://x.com/i/status/${item.id.replace(/\D/g,'')}`;
      const msg = `<b>🔎 Hit: "${escapeHTML(query)}"</b>\n` +
                  `<b>💎 CA:</b> <code>${escapeHTML(item.ca)}</code>\n\n` +
                  `<i>${escapeHTML(item.snippet)}...</i>` +
                  `\n\n<tg-spoiler>via ${res.host}</tg-spoiler>`;
      
      await enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getButtons(item.ca, link) } });
    }
  }
}
// PART 3: Server & UI Cleanup

// --- SNIPER ---
let pumpWS = null;
function startPumpFun(){
  if (!ENABLE_PUMPFUN) return;
  try {
    pumpWS = new WebSocket('wss://pumpportal.fun/ws');
    pumpWS.on('open', ()=> console.log('🟢 PumpFun Connected'));
    pumpWS.on('message', data => {
      try {
        const p = JSON.parse(data);
        const ca = p.mint || p.token;
        if(ca && !isCached(ca)){
          const msg = `<b>💊 PumpFun Mint</b>\n<code>${escapeHTML(ca)}</code>`;
          enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getButtons(ca) } });
        }
      } catch(e){}
    });
    pumpWS.on('error', ()=> setTimeout(startPumpFun, 5000));
    pumpWS.on('close', ()=> setTimeout(startPumpFun, 3000));
  } catch(e){ setTimeout(startPumpFun, 5000); }
}

async function checkRaydiumGecko(){
  if (!ENABLE_RAYDIUM) return;
  try {
    const { data } = await axiosFast.get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1');
    for (const p of data?.data || []){
      if (p.attributes?.dex_id !== 'raydium') continue;
      const mint = p.attributes.base_token_address;
      if (!mint || isCached(mint)) continue;
      
      const msg = `<b>🔷 Raydium New Pool</b>\n<b>${escapeHTML(p.attributes.name)}</b>\n<code>${escapeHTML(mint)}</code>`;
      await enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getButtons(mint) } });
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
  console.log(`🚀 V13 Cleanup Started on Port ${PORT}`);
  try { await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${WEBHOOK_BASE_URL}/webhook`); } catch(e){}
  
  // 🔥 FIX: Send a message on startup to REMOVE old keyboards
  setTimeout(() => {
    bot.sendMessage(TELEGRAM_CHAT_ID, '<b>♻️ System Loaded. UI Cleaned.</b>', { 
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true } // THIS KILLS THE SQUARE 4 DOTS
    }).catch(()=>{});
  }, 5000);
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
        await new Promise(r=>setTimeout(r, wait*1000));
      } else { console.error(`Send Error: ${e.message}`); }
    }
    await new Promise(r=>setTimeout(r, MSG_INTERVAL_MS));
  }
  sending = false;
}

// --- DASHBOARD ---
bot.on('message', async (msg) => {
  if (!msg || !msg.text) return;
  const cid = msg.chat.id.toString();
  if (cid !== TELEGRAM_CHAT_ID) return;
  const text = msg.text.trim();
  
  if (text === '/start' || text === '/admin') {
    // Also remove keyboard on /start just in case
    await bot.sendMessage(cid, 'Loading...', { reply_markup: { remove_keyboard: true } });
    return sendDashboard(cid);
  }
  
  if (text === '/help') return bot.sendMessage(cid, `<b>Commands:</b>\n/adduser [name]\n/removeuser [name]\n/addquery [text]\n/removequery [text]\n/listusers\n/listqueries`, { parse_mode: 'HTML' });
  
  if (text.startsWith('/adduser ')) {
    const u = text.split(' ')[1].replace('@', '');
    if(u && !state.users.includes(u)) { state.users.push(u); saveState(); bot.sendMessage(cid, `✅ Added: ${u}`, { parse_mode: 'HTML' }); }
  }
  if (text.startsWith('/addquery ')) {
    const q = text.substring(10).trim();
    if(q && !state.queries.includes(q)) { state.queries.push(q); saveState(); bot.sendMessage(cid, `✅ Added: ${q}`, { parse_mode: 'HTML' }); }
  }
  if (text === '/listusers') return bot.sendMessage(cid, `<b>Users:</b>\n${state.users.join('\n')}`, { parse_mode: 'HTML' });
  if (text === '/listqueries') return bot.sendMessage(cid, `<b>Queries:</b>\n${state.queries.join('\n')}`, { parse_mode: 'HTML' });
});

async function sendDashboard(chatId, msgId = null) {
  const healthy = NITTER_NODES.filter(n => n.downUntil < Date.now()).length;
  const status = `<b>🛡️ SOLANA HUNTER V13</b>\n\n👤 Users: ${state.users.length}\n🔎 Queries: ${state.queries.length}\n📡 Swarm: ${healthy}/${NITTER_NODES.length}\n\nRunning...`;
  const markup = { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'REFRESH' }]] };
  if(msgId) try{ await bot.editMessageText(status, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: markup }); }catch(e){}
  else await bot.sendMessage(chatId, status, { parse_mode: 'HTML', reply_markup: markup });
}

bot.on('callback_query', async (q) => {
  if (q.message.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  if (q.data === 'REFRESH') sendDashboard(TELEGRAM_CHAT_ID, q.message.message_id);
  await bot.answerCallbackQuery(q.id);
});

// --- LOOP ---
async function startSafeLoop(){
  console.log('⚔️ V13 Clean Engine - Syncing...');
  let firstRun = true; 
  if (ENABLE_PUMPFUN) startPumpFun();
  while(true){
    try {
      await Promise.allSettled([ scanUsers(firstRun), runHunterQueries(firstRun), checkRaydiumGecko() ]);
      if(firstRun) { console.log('✅ Sync Complete.'); firstRun = false; }
    } catch(e){ console.error('Loop Error:', e.message); }
    await new Promise(r=>setTimeout(r, POLL_INTERVAL_MS));
  }
}
startSafeLoop();
