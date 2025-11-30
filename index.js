// index.js — Solana Hunter Bot (Railway Fix Applied)
// PART 1: Config, State, and Helpers

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const RSSParser = require('rss-parser');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
require('dotenv').config();

// -------------------- Configuration --------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !WEBHOOK_BASE_URL) {
  console.error('CRITICAL: Missing TELEGRAM_TOKEN, TELEGRAM_CHAT_ID or WEBHOOK_BASE_URL in .env');
  process.exit(1);
}

let ENABLE_RAYDIUM = (process.env.ENABLE_RAYDIUM === 'true') || false;
let ENABLE_PUMPFUN = (process.env.ENABLE_PUMPFUN === 'true') || true;
const USERS_TO_MONITOR = (process.env.USERS_TO_MONITOR || '').split(',').map(s=>s.trim()).filter(Boolean);

const POLL_INTERVAL_MS = 15_000;
const MSG_INTERVAL_MS = Number(process.env.MSG_INTERVAL_MS) || 200;
const STATE_FILE = path.join(__dirname, 'state.json');
const ALERTS_FILE = path.join(__dirname, 'alerts.log.json');
const BACKUP_FILE = path.join(__dirname, 'state.backup.json');
const DEBUG = process.env.DEBUG === 'true';

// -------------------- Helpers --------------------
function nowISO(){ return (new Date()).toISOString(); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function escapeMD(text){
  if (text === null || text === undefined) return '';
  text = String(text);
  return text.replace(/([_*\[\]\(\)~`>#+\-=|{}.!\\])/g, '\\$1');
}

// Throttled logger
const LOG_WINDOW_MS = 1000;
const MAX_LOGS_PER_WINDOW = 12;
let recentLogsTimestamps = [];
function throttledLog(...args){
  const t = Date.now();
  recentLogsTimestamps = recentLogsTimestamps.filter(ts => t - ts < LOG_WINDOW_MS);
  if (recentLogsTimestamps.length < MAX_LOGS_PER_WINDOW) {
    recentLogsTimestamps.push(t);
    if (DEBUG) console.log(new Date().toISOString(), ...args);
  }
}
function safeLog(...args){ console.log(new Date().toISOString(), ...args); }

// -------------------- State Management --------------------
let state = { users: [], queries: [], last: {} };
function loadState(){
  try {
    if (fs.existsSync(STATE_FILE)){
      state = Object.assign({users:[], queries:[], last:{}}, JSON.parse(fs.readFileSync(STATE_FILE,'utf8')||'{}'));
    } else {
      state = { users: [], queries: [], last: {} };
      saveState();
    }
  } catch (e){
    console.warn('loadState error (using default):', e.message);
    state = { users: [], queries: [], last: {} };
  }
}
function saveState(){
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch(e){ throttledLog('saveState failed', e.message); }
}
function backupState(){
  try { fs.writeFileSync(BACKUP_FILE, JSON.stringify({ts: nowISO(), state}, null, 2)); }
  catch(e){ throttledLog('backup failed', e.message); }
}
loadState();
for (const u of USERS_TO_MONITOR) if (u && !state.users.includes(u)) state.users.push(u);
saveState();
  State();
// PART 2: Telegram, Webhook (FIXED), and Scanning Logic

// -------------------- Telegram & Webhook --------------------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const app = express();
app.use(express.json());

app.get('/health', (req,res)=> res.json({status:'ok', ts: nowISO()}));

// FIX 1: Instant 200 OK response to prevent 502 Errors
app.post('/webhook', (req,res)=>{
  res.status(200).send('OK'); 
  setImmediate(()=> {
    try { bot.processUpdate(req.body); }
    catch(e){ throttledLog('processUpdate error', e && e.message); }
  });
});

const PORT = process.env.PORT || 8080;

// FIX 2: Bind to 0.0.0.0 for Railway support
app.listen(PORT, '0.0.0.0', ()=> {
  safeLog('Server listening on', PORT);
  safeLog('Webhook URL:', WEBHOOK_BASE_URL + '/webhook');
  (async ()=>{
    try {
      const r = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_BASE_URL + '/webhook')}`, { timeout: 10000 });
      safeLog('setWebhook result', r.data && r.data.ok);
    } catch (e){ throttledLog('setWebhook attempt failed', e.message); }
  })();
});

// -------------------- Messaging Queue --------------------
let sending = false;
let queue = [];
async function enqueue(chatId, text, opts = {}) {
  return new Promise((resolve,reject)=>{
    queue.push({chatId, text, opts, resolve, reject});
    if (!sending) processQueue().catch(e=>throttledLog('processQueue crash', e));
  });
}
async function processQueue(){
  if (sending) return;
  sending = true;
  while (queue.length){
    const job = queue.shift();
    let attempts = 0, lastErr = null;
    while (attempts < 6){
      attempts++;
      try {
        await bot.sendMessage(job.chatId, job.text, Object.assign({ parse_mode: 'MarkdownV2', disable_web_page_preview: true }, job.opts));
        lastErr = null;
        job.resolve(true);
        break;
      } catch (e){
        lastErr = e;
        const code = e?.response?.status;
        throttledLog('Telegram send error', code, e && e.message);
        if (code === 429){
          const ra = Number(e.response?.headers?.['retry-after'] || 1);
          await sleep((ra+1)*1000);
        } else if (code >= 500){
          await sleep(300 * attempts);
        } else {
          job.reject(e);
          break;
        }
      }
    }
    if (lastErr) job.reject(lastErr);
    await sleep(MSG_INTERVAL_MS);
  }
  sending = false;
}

// -------------------- Nitter & Fetch --------------------
const DEFAULT_NITTERS = ["nitter.net","nitter.privacydev.net","nitter.poast.org","nitter.ca","nitter.lgbt","nitter.unixfox.eu"];
const NITTER = DEFAULT_NITTERS.map(h=>({host:h, cooldown:0}));
function nowTs(){ return Date.now(); }
function availableHosts(){ const t = nowTs(); const ok = NITTER.filter(x=>x.cooldown < t); if (ok.length) return ok; NITTER.forEach(x=>x.cooldown=0); return NITTER; }
function cooldownHost(host, sec=60){ const it = NITTER.find(x=>x.host===host); if (it) it.cooldown = nowTs() + sec*1000; }

const axiosFast = axios.create({ timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
const rssParser = new RSSParser();

async function fetchUserTweets(user){
  const hosts = availableHosts().sort(()=>0.5-Math.random()).slice(0,3);
  for (const h of hosts){
    const url = `https://${h.host}/${user}/rss`;
    try {
      const r = await axiosFast.get(url, { responseType: 'text' });
      const feed = await rssParser.parseString(r.data);
      if (!feed?.items || feed.items.length === 0) throw new Error('empty feed');
      const items = feed.items.map(i=>{
        const idm = i.link ? (i.link.match(/status\/(\d+)/) || [])[1] : (i.id || null);
        return { id: idm, author: user, text: i.contentSnippet || i.title || i.content || '', ts: i.pubDate ? new Date(i.pubDate).getTime() : Date.now(), link: i.link || null };
      }).filter(x=>x.id);
      return { items, instance: h.host };
    } catch (e){
      cooldownHost(h.host, 60);
      throttledLog('fetchUserTweets fail', h.host, e.message);
      continue;
    }
  }
  return null;
}

async function fetchSearch(query){
  const hosts = availableHosts().sort(()=>0.5-Math.random()).slice(0,3);
  for (const h of hosts){
    const url = `https://${h.host}/search/rss?f=tweets&q=${encodeURIComponent(query)}`;
    try {
      const r = await axiosFast.get(url, { responseType: 'text' });
      const feed = await rssParser.parseString(r.data);
      if (!feed?.items || feed.items.length === 0) throw new Error('empty search');
      const items = feed.items.map(i=>{
        const idm = i.link ? (i.link.match(/status\/(\d+)/) || [])[1] : (i.id || null);
        return { id: idm, author: i.creator || '', text: i.contentSnippet || i.title || i.content || '', ts: i.pubDate ? new Date(i.pubDate).getTime() : Date.now(), link: i.link || null };
      }).filter(x=>x.id);
      return { items, instance: h.host };
    } catch (e){
      cooldownHost(h.host, 60);
      throttledLog('fetchSearch fail', h.host, e.message);
      continue;
    }
  }
  return null;
}

// -------------------- Extractors & Filters --------------------
function extractCA(text){ if (!text) return null; const m = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/); return m?m[0]:null; }
function isSuspicious(text){ if (!text) return false; const s = text.toLowerCase(); const bad = ['honeypot','scam','rug','dump','steal','phish','fake','copy','airdrop','presale','tax','fee']; for (const b of bad) if (s.includes(b)) return true; if (/(.)\1{8,}/.test(s)) return true; return false; }

// -------------------- Optimized Alerts (Non-Blocking) --------------------
let ALERTS_CACHE = [];
try { if(fs.existsSync(ALERTS_FILE)) ALERTS_CACHE = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8') || '[]').slice(-100); } catch(e){}

function appendAlert(rec){
  ALERTS_CACHE.push(rec);
  if (ALERTS_CACHE.length > 200) ALERTS_CACHE = ALERTS_CACHE.slice(-200);
  
  fs.readFile(ALERTS_FILE, 'utf8', (err, data) => {
    let arr = [];
    if (!err && data) { try { arr = JSON.parse(data); } catch(e){} }
    arr.push(rec);
    if (arr.length > 2000) arr = arr.slice(-2000);
    fs.writeFile(ALERTS_FILE, JSON.stringify(arr, null, 2), ()=>{});
  });
}

const SENT_IDS = new Set();
function markSent(id){ if (!id) return; SENT_IDS.add(String(id)); }
setInterval(() => { if (SENT_IDS.size > 20000) { SENT_IDS.clear(); safeLog('🧹 Cache Cleared'); } }, 6 * 60 * 60 * 1000);

async function runHunter(){
  try {
    for (const q of state.queries){
      const res = await fetchSearch(q);
      if (!res) continue;
      for (const it of res.items){
        if (SENT_IDS.has(it.id)) continue;
        if (isSuspicious(it.text)) continue;
        const ca = extractCA(it.text);
        if (!ca) continue;
        const snippet = it.text.slice(0,300);
        const link = it.link || `https://x.com/${it.author}/status/${it.id}`;
        const md = `*🎯 HUNTER MATCH*\n\n*Query:* \`${escapeMD(q)}\`\n*CA:* \`${escapeMD(ca)}\`\n\n${escapeMD(snippet)}\n\n[View Tweet](${escapeMD(link)})\n[DexScreener](${escapeMD('https://dexscreener.com/solana/' + ca)})`;
        await enqueue(TELEGRAM_CHAT_ID, md);
        appendAlert({ ts: nowISO(), type:'hunter', query:q, id: it.id, ca, author: it.author, instance: res.instance });
        markSent(it.id);
      }
    }
  } catch (e){ throttledLog('runHunter error', e.message); }
}

async function scanUsers(){
  try {
    for (const u of state.users){
      const res = await fetchUserTweets(u);
      if (!res) continue;
      for (const it of res.items){
        if (SENT_IDS.has(it.id)) continue;
        if (isSuspicious(it.text)) continue;
        const ca = extractCA(it.text);
        const snippet = it.text.slice(0,300);
        const link = it.link || `https://x.com/${it.author}/status/${it.id}`;
        if (ca){
          const md = `*🐦 @${escapeMD(it.author)} posted CA*\n\n*CA:* \`${escapeMD(ca)}\`\n\n${escapeMD(snippet)}\n\n[View Tweet](${escapeMD(link)})\n[DexScreener](${escapeMD('https://dexscreener.com/solana/' + ca)})`;
          await enqueue(TELEGRAM_CHAT_ID, md);
          appendAlert({ ts: nowISO(), type:'user_ca', id: it.id, ca, author: it.author, instance: res.instance });
        }
        markSent(it.id);
      }
    }
  } catch (e){ throttledLog('scanUsers error', e.message); }
}

// -------------------- GeckoTerminal New Pools --------------------
let KNOWN_RAY_MINTS = new Set();
async function checkNewPools(){
  if (!ENABLE_RAYDIUM) return;
  try {
    const url = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1';
    const r = await axiosFast.get(url);
    const pools = r.data?.data || [];

    for (const p of pools){
      const attr = p.attributes;
      if (!attr || attr.dex_id !== 'raydium') continue;
      const mint = attr.base_token_address; 
      const pairName = attr.name; 
      if (!mint) continue;

      if (!KNOWN_RAY_MINTS.has(mint)){
        KNOWN_RAY_MINTS.add(mint);
        if(KNOWN_RAY_MINTS.size > 5000) { const it=KNOWN_RAY_MINTS.values(); KNOWN_RAY_MINTS.delete(it.next().value); }
        appendAlert({ ts: nowISO(), type:'raydium', ca: mint, name: pairName });
        const md = `*🔵 Raydium New Pool*\n\n*Pair:* ${escapeMD(pairName)}\n*Mint:* \`${escapeMD(mint)}\`\n\n[DexScreener](${escapeMD('https://dexscreener.com/solana/' + mint)})`;
        await enqueue(TELEGRAM_CHAT_ID, md);
      }
    }
  } catch (e){ throttledLog('checkNewPools failed', e.message); }
}

// PART 3: PumpFun, Admin Dashboard, and Startup

// -------------------- PumpFun WS Sniper --------------------
let pumpWS = null;
function startPumpFun(){
  if (!ENABLE_PUMPFUN) return throttledLog('PumpFun disabled');
  try {
    pumpWS = new WebSocket('wss://pumpportal.fun/ws');
    pumpWS.on('open', ()=> throttledLog('PumpFun WS open'));
    pumpWS.on('message', async raw => {
      try {
        const data = JSON.parse(String(raw));
        const ca = data?.mint || data?.ca || data?.token || data?.address;
        if (ca){
          appendAlert({ ts: nowISO(), type:'pumpfun', ca, raw: data });
          const md = `*🔥 PumpFun Mint Detected*\n\n*CA:* \`${escapeMD(ca)}\`\n\n[DexScreener](${escapeMD('https://dexscreener.com/solana/' + ca)})`;
          await enqueue(TELEGRAM_CHAT_ID, md);
          markSent(ca + '_' + Date.now());
        }
      } catch (e){ }
    });
    pumpWS.on('error', e=> { throttledLog('PumpFun WS error', e.message); pumpWS.terminate(); setTimeout(startPumpFun, 5000); });
    pumpWS.on('close', ()=> { throttledLog('PumpFun closed'); setTimeout(startPumpFun, 3000); });
  } catch (e){
    throttledLog('startPumpFun failed', e.message);
    setTimeout(startPumpFun, 5000);
  }
}

// -------------------- Webhook heal --------------------
let failureCount = 0;
function recordFailure(){ failureCount++; if (failureCount > 8){ 
  for (let i = NITTER.length -1; i>0; i--){ const j = Math.floor(Math.random()*(i+1)); [NITTER[i], NITTER[j]]=[NITTER[j], NITTER[i]]; }
  safeLog('CrashGuard rotated Nitter pool'); failureCount = 0; } }
function resetFailures(){ failureCount = 0; }

async function checkWebhookHeal(){
  try {
    const r = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`, { timeout: 5000 });
    const info = r.data?.result;
    if (info && info.last_error_message){
      safeLog('Webhook error reported:', info.last_error_message);
      try {
        await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_BASE_URL + '/webhook')}`, { timeout: 10000 });
      } catch(e){ throttledLog('webhook reset failed', e.message); }
    }
  } catch(e){ throttledLog('checkWebhookHeal failed', e.message); }
}

async function mainLoop(){
  try {
    await Promise.allSettled([ scanUsers(), runHunter() ]);
    if (ENABLE_RAYDIUM) await checkNewPools();
    saveState();
    backupState();
    await checkWebhookHeal();
    resetFailures();
  } catch (e){
    throttledLog('mainLoop error', e.message);
    recordFailure();
  }
}
setInterval(mainLoop, POLL_INTERVAL_MS);
mainLoop();

// -------------------- Admin Dashboard --------------------
async function registerCommands(){
  try {
    await bot.setMyCommands([
      {command:'start', description:'Dashboard'},
      {command:'help', description:'Help'},
      {command:'listusers', description:'List users'},
      {command:'adduser', description:'Add user'},
      {command:'removeuser', description:'Remove user'},
      {command:'listqueries', description:'List queries'},
      {command:'addquery', description:'Add query'},
      {command:'removequery', description:'Remove query'},
      {command:'admin', description:'Admin'}
    ]);
  } catch (e){ throttledLog('setMyCommands failed', e.message); }
}
registerCommands().catch(()=>{});

function adminKeyboard(){
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔁 Restart", callback_data: "DASH_RESTART" },
          { text: ENABLE_PUMPFUN ? "🟢 PumpFun ON" : "⚪ PumpFun OFF", callback_data: "DASH_TOGGLE_PUMPFUN" }
        ],
        [
          { text: ENABLE_RAYDIUM ? "🟢 Raydium ON" : "⚪ Raydium OFF", callback_data: "DASH_TOGGLE_RAYDIUM" },
          { text: "📄 Alerts", callback_data: "DASH_VIEW_ALERTS" }
        ],
        [
          { text: "🔄 Refresh", callback_data: "DASH_REFRESH" },
          { text: "🗑 Clear Cache", callback_data: "DASH_CLEAR_SENT" }
        ]
      ]
    },
    parse_mode: 'MarkdownV2'
  };
}

async function getDashboardText(){
  const users = state.users.length ? state.users.slice(0,10).map(u=>escapeMD(u)).join(', ') : '_none_';
  const queries = state.queries.length ? state.queries.slice(0,10).map(q=>escapeMD(q)).join('\\n') : '_none_';
  const mem = process.memoryUsage();
  const memStr = `rss:${Math.round(mem.rss/1024/1024)}MB heap:${Math.round(mem.heapUsed/1024/1024)}MB`;
  return `*🧭 Dashboard*\n\n*Users:* ${state.users.length}\n*Queries:* ${state.queries.length}\n*Alerts:* ${ALERTS_CACHE.length}\n*PumpFun:* ${ENABLE_PUMPFUN?'ON':'OFF'}\n*Raydium:* ${ENABLE_RAYDIUM?'ON':'OFF'}\n*Memory:* ${escapeMD(memStr)}\n\n*Users:*\n${users}\n\n*Queries:*\n${queries}`;
}

async function sendAdminDashboard(chatId){
  try { const txt = await getDashboardText(); await bot.sendMessage(chatId, txt, adminKeyboard()); } catch (e){}
}

bot.on('callback_query', async q => {
  try {
    const cid = q.message.chat.id;
    if (String(cid) !== String(TELEGRAM_CHAT_ID)) return;
    const data = q.data;
    if (data === 'DASH_REFRESH') { await bot.answerCallbackQuery(q.id); return sendAdminDashboard(cid); }
    if (data === 'DASH_VIEW_ALERTS') {
      await bot.answerCallbackQuery(q.id);
      const list = ALERTS_CACHE.slice(-8).reverse().map(a => `${escapeMD(a.ts)} • ${escapeMD(a.ca||a.type)}`);
      return bot.sendMessage(cid, '*📄 Alerts*\n' + (list.join('\n') || '_none_'), { parse_mode: 'MarkdownV2' });
    }
    if (data === 'DASH_TOGGLE_PUMPFUN') {
      ENABLE_PUMPFUN = !ENABLE_PUMPFUN;
      await bot.answerCallbackQuery(q.id, { text: `PumpFun ${ENABLE_PUMPFUN?'ON':'OFF'}` });
      if(ENABLE_PUMPFUN) startPumpFun(); else if(pumpWS) try{pumpWS.terminate()}catch(_){}
      return sendAdminDashboard(cid);
    }
    if (data === 'DASH_TOGGLE_RAYDIUM') {
      ENABLE_RAYDIUM = !ENABLE_RAYDIUM;
      await bot.answerCallbackQuery(q.id, { text: `Raydium ${ENABLE_RAYDIUM?'ON':'OFF'}` });
      return sendAdminDashboard(cid);
    }
    if (data === 'DASH_RESTART') { await bot.answerCallbackQuery(q.id); await bot.sendMessage(cid, 'Restarting...'); process.exit(0); }
    if (data === 'DASH_CLEAR_SENT') { SENT_IDS.clear(); await bot.answerCallbackQuery(q.id, { text: 'Cleared' }); return sendAdminDashboard(cid); }
  } catch (e) {}
});

bot.on('message', async msg => {
  try {
    if (!msg || !msg.text) return;
    const text = msg.text.trim();
    const cid = msg.chat.id;
    const isAdmin = String(cid) === String(TELEGRAM_CHAT_ID);

    if (text === '/start') return isAdmin ? sendAdminDashboard(cid) : bot.sendMessage(cid, 'Running.');
    if (!isAdmin) return;

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();

    if (cmd === '/adduser' && arg) { if (!state.users.includes(arg)){ state.users.push(arg); saveState(); } return bot.sendMessage(cid, `Added ${arg}`); }
    if (cmd === '/removeuser' && arg) { state.users = state.users.filter(x=>x!==arg); saveState(); return bot.sendMessage(cid, `Removed ${arg}`); }
    if (cmd === '/addquery' && arg) { if (!state.queries.includes(arg)){ state.queries.push(arg); saveState(); } return bot.sendMessage(cid, 'Added query'); }
    if (cmd === '/removequery' && arg) { state.queries = state.queries.filter(x=>x!==arg); saveState(); return bot.sendMessage(cid, 'Removed query'); }
    if (cmd === '/listusers') return bot.sendMessage(cid, `Users:\n${state.users.join('\n')}`);
    if (cmd === '/listqueries') return bot.sendMessage(cid, `Queries:\n${state.queries.join('\n')}`);
  } catch (e){}
});

// -------------------- Startup --------------------
safeLog('Solana Hunter Bot starting...');
if (ENABLE_PUMPFUN) startPumpFun();
if (!fs.existsSync(ALERTS_FILE)) fs.writeFileSync(ALERTS_FILE, '[]', 'utf8');
process.on('SIGINT', ()=>{ saveState(); process.exit(0); });
process.on('SIGTERM', ()=>{ saveState(); process.exit(0); });
