const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const https = require('https');
require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !WEBHOOK_BASE_URL) {
  console.error('❌ CRITICAL: Missing .env variables.');
  process.exit(1);
}

let ENABLE_RAYDIUM = (process.env.ENABLE_RAYDIUM === 'true') || false;
let ENABLE_PUMPFUN = (process.env.ENABLE_PUMPFUN === 'true') || true;

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000');
const MSG_INTERVAL_MS = parseInt(process.env.MSG_INTERVAL_MS || '350');
const WORKER_TIMEOUT_MS = parseInt(process.env.WORKER_TIMEOUT_MS || '12000');
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');
const STATE_FILE = path.join(__dirname, 'state.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

const DEFAULT_QUERIES = [
  'solana "contract address"',
  'deploying "pump.fun"',
  '"ca renounced" solana',
  'solana "ai agent"',
  'solana "liquidity locked"',
  'solana "fair launch"',
  'solana "gem" -scam',
  'solana "minting now"',
  'solana token launch',
  'solana presale'
];

let worker = null;
const workerCallbacks = new Map();
const CONTRACT_CACHE = new Map();
const commandCooldowns = new Map();

// ✅ FIX 1: Worker Callback Memory Leak + Health Monitoring
function createWorker() {
  try {
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
      console.error('❌ Worker error:', err.message);
      setTimeout(createWorker, 2000);
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error('⚠️ Worker crashed, restarting...');
        setTimeout(createWorker, 2000);
      }
    });
    console.log('✅ Worker active');
  } catch (e) {
    console.error('Failed to create worker:', e.message);
    setTimeout(createWorker, 2000);
  }
}

createWorker();

// ✅ FIX 2: Auto-cleanup orphaned callbacks (Memory Leak Fix)
setInterval(() => {
  const now = Date.now();
  for (const [id, cb] of workerCallbacks.entries()) {
    if (now - cb.created > 15000) {
      workerCallbacks.delete(id);
      console.log(`🧹 Cleaned orphaned callback ${id}`);
    }
  }
  if (workerCallbacks.size > 50) {
    console.log('⚠️ Worker callback limit reached, restarting...');
    if (worker) worker.terminate();
    createWorker();
  }
}, 5000);

function runWorkerTask(type, payload) {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error('Worker unavailable'));
    const id = Date.now() + Math.random();
    workerCallbacks.set(id, { resolve, reject, created: Date.now() });
    try {
      worker.postMessage({ id, type, ...payload });
    } catch (e) {
      workerCallbacks.delete(id);
      return reject(e);
    }
    setTimeout(() => {
      if (workerCallbacks.has(id)) {
        workerCallbacks.delete(id);
        reject(new Error('Worker timeout'));
      }
    }, WORKER_TIMEOUT_MS);
  });
}

let state = { users: [], queries: [] };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } else {
      state.users = (process.env.USERS_TO_MONITOR || '').split(',').map(s => s.trim()).filter(Boolean);
      state.queries = DEFAULT_QUERIES;
      saveState();
    }
  } catch (e) {
    console.error('State load failed:', e.message);
    state = { users: [], queries: DEFAULT_QUERIES };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('State save failed:', e.message);
  }
}

loadState();

const CACHE = new Map();
let lastUserScan = 0;
let lastQueryScan = 0;
let lastRaydium = 0;

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      const now = Date.now();
      const CACHE_TTL = 172800000;
      data.forEach(item => {
        if (now - item.ts < CACHE_TTL) {
          CACHE.set(item.id, item.ts);
        }
      });
      console.log(`📚 Cache: ${CACHE.size} items (48hr TTL)`);
    }
  } catch (e) {
    console.error('History load failed:', e.message);
  }
}

function saveHistory() {
  try {
    const now = Date.now();
    const CACHE_TTL = 172800000;
    const data = Array.from(CACHE.entries())
      .filter(([_, ts]) => now - ts < CACHE_TTL)
      .map(([id, ts]) => ({ id, ts }));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data));
  } catch (e) {}
}

function isCached(id) {
  if (CACHE.has(id)) return true;
  CACHE.set(id, Date.now());
  return false;
}

// ✅ GLOBAL CONTRACT CACHE (2hr TTL)
function isContractCached(ca) {
  const now = Date.now();
  if (CONTRACT_CACHE.has(ca)) {
    const entry = CONTRACT_CACHE.get(ca);
    if (now - entry.ts < 7200000) {
      return true;
    }
    CONTRACT_CACHE.delete(ca);
  }
  CONTRACT_CACHE.set(ca, { ts: now });
  return false;
}

setInterval(() => {
  const now = Date.now();
  const CACHE_TTL = 172800000;
  let pruned = 0;
  for (const [id, ts] of CACHE.entries()) {
    if (now - ts > CACHE_TTL) {
      CACHE.delete(id);
      pruned++;
    }
  }
  if (pruned > 0) console.log(`🗑️ Pruned ${pruned} old cache items`);
  if (CACHE.size % 100 === 0) saveHistory();
}, 60000);

loadHistory();

const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/118.0.0.0 Safari/537.36',
];

const REFERERS = [
  'https://twitter.com/',
  'https://x.com/',
  'https://twitter.com/home',
  'https://x.com/home',
  'https://www.google.com/',
  'https://www.bing.com/',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomReferer() {
  return REFERERS[Math.floor(Math.random() * REFERERS.length)];
}

function getRandomDelay() {
  return Math.random() * 2000 + 500;
}

const NITTER_NODES = [
  { host: "nitter.net", downUntil: 0, failures: 0, requests: 0 },
  { host: "xcancel.com", downUntil: 0, failures: 0, requests: 0 },
  { host: "nitter.poast.org", downUntil: 0, failures: 0, requests: 0 },
  { host: "nitter.tiekoetter.com", downUntil: 0, failures: 0, requests: 0 },
  { host: "nitter.privacyredirect.com", downUntil: 0, failures: 0, requests: 0 },
  { host: "nitter.lucabased.xyz", downUntil: 0, failures: 0, requests: 0 },
  { host: "nitter.freereddit.com", downUntil: 0, failures: 0, requests: 0 },
  { host: "nitter.moomoo.me", downUntil: 0, failures: 0, requests: 0 }
];

function getHealthyNode() {
  const now = Date.now();
  const healthy = NITTER_NODES.filter(n => n.downUntil < now && n.requests < 3);
  if (healthy.length === 0) {
    console.log('⚠️ No healthy nodes, resetting...');
    NITTER_NODES.forEach(n => { 
      n.downUntil = 0; 
      n.failures = 0; 
      n.requests = 0; 
    });
    return NITTER_NODES[0];
  }
  const node = healthy[Math.floor(Math.random() * healthy.length)];
  node.requests++;
  return node;
}

function markNodeDown(host) {
  const node = NITTER_NODES.find(n => n.host === host);
  if (node) {
    node.failures++;
    const backoff = Math.min(60000 * Math.pow(1.5, node.failures - 1), 600000);
    node.downUntil = Date.now() + backoff;
    node.requests = 0;
  }
}

setInterval(() => {
  NITTER_NODES.forEach(n => n.requests = 0);
}, 60000);

async function fetchWithRetry(urlPath, maxRetries = MAX_RETRIES) {
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const node = getHealthyNode();
    try {
      const response = await axios.get(`https://${node.host}/${urlPath}?t=${Date.now()}`, {
        responseType: 'text',
        timeout: 10000,
        httpsAgent: agent,
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Referer': getRandomReferer(),
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }
      });

      if (response.data.includes('over capacity') || response.data.includes('<html') && response.data.length < 500) {
        markNodeDown(node.host);
        lastError = new Error('Over capacity');
        continue;
      }

      const items = await runWorkerTask('PARSE_RSS', { xml: response.data });
      
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, getRandomDelay()));
      }
      
      return { items: items || [], host: node.host };
    } catch (e) {
      lastError = e;
      markNodeDown(node.host);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  return null;
}

function escapeHTML(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ✅ FIX 3: Input Validation
function validateUsername(user) {
  return /^[a-zA-Z0-9_]{1,15}$/.test(user);
}

function validateQuery(query) {
  return query.length <= 100 && !/<script|javascript|onw+=/i.test(query);
}

function isCommandOnCooldown(userId, command) {
  const now = Date.now();
  const key = `${userId}_${command}`;
  if (commandCooldowns.has(key) && now - commandCooldowns.get(key) < 60000) {
    return true;
  }
  commandCooldowns.set(key, now);
  setTimeout(() => commandCooldowns.delete(key), 60000);
  return false;
}

function getButtons(ca, link) {
  const buttons = [
    [{ text: '🦄 Trojan', url: `https://t.me/solana_trojanbot?start=${ca}` }],
    [
      { text: '🦅 DexS', url: `https://dexscreener.com/solana/${ca}` },
      { text: '👻 Photon', url: `https://photon-sol.tinyastro.io/en/lp/${ca}` }
    ]
  ];
  if (link) {
    let cleanLink = link;
    try {
      cleanLink = `https://x.com${new URL(link).pathname}`;
    } catch (e) {}
    buttons.push([{ text: '🐦 Source', url: cleanLink }]);
  }
  return buttons;
}

async function scanUsers(firstRun) {
  if (Date.now() - lastUserScan < 8000) return;
  lastUserScan = Date.now();
  
  for (const user of state.users) {
    try {
      const res = await fetchWithRetry(`${user}/rss`);
      if (!res?.items?.length) continue;

      for (const item of res.items.slice(0, 10)) {
        if (isCached(item.id) || firstRun) continue;

        if (item.ca && !isContractCached(item.ca)) {
          const link = item.link || `https://x.com/${user}`;
          const msg = `<b>🐦 @${escapeHTML(user)}:</b>\n\n${escapeHTML(item.snippet)}\n\n<b>💎 CA:</b> <code>${escapeHTML(item.ca)}</code>`;
          enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getButtons(item.ca, link) } });
        } else if (!item.ca) {
          const link = item.link || `https://x.com/${user}`;
          const msg = `<b>🐦 @${escapeHTML(user)}:</b>\n\n${escapeHTML(item.snippet)}\n\n<tg-spoiler>via ${res.host}</tg-spoiler>`;
          enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: [[{ text: '🐦 Tweet', url: `https://x.com/${user}/status/${item.id.split('/').pop()}` }]] } });
        }
      }
    } catch (e) {
      console.error(`Scan user ${user} failed:`, e.message);
    }
  }
}

async function runHunterQueries(firstRun) {
  if (Date.now() - lastQueryScan < 8000) return;
  lastQueryScan = Date.now();
  
  for (const query of state.queries) {
    try {
      const res = await fetchWithRetry(`search/rss?f=tweets&q=${encodeURIComponent(query)}`);
      if (!res?.items?.length) continue;

      for (const item of res.items) {
        if (isCached(item.id) || !item.ca || item.suspicious || firstRun || isContractCached(item.ca)) continue;

        const link = item.link || `https://x.com/i/status/${item.id.replace(/\D/g, '')}`;
        const msg = `<b>🔎 "${escapeHTML(query)}"</b>\n<b>💎 CA:</b> <code>${escapeHTML(item.ca)}</code>\n\n<i>${escapeHTML(item.snippet)}...</i>\n\n<tg-spoiler>via ${res.host}</tg-spoiler>`;
        enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getButtons(item.ca, link) } });
      }
    } catch (e) {
      console.error(`Query "${query}" failed:`, e.message);
    }
  }
}

// ✅ FIX 4: PumpFun WebSocket Auto-Reconnect + Heartbeat
let pumpWS = null;
let pumpReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

function startPumpFun() {
  if (!ENABLE_PUMPFUN || pumpWS?.readyState === WebSocket.OPEN) return;
  
  try {
    console.log(`🔄 PumpFun reconnecting (attempt ${pumpReconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
    pumpWS = new WebSocket('wss://pumpportal.fun/ws');
    
    pumpWS.on('open', () => {
      console.log('🟢 PumpFun connected');
      pumpReconnectAttempts = 0;
      const heartbeat = setInterval(() => {
        if (pumpWS.readyState === WebSocket.OPEN) {
          pumpWS.ping();
        } else {
          clearInterval(heartbeat);
        }
      }, 30000);
    });
    
    pumpWS.on('message', (data) => {
      try {
        const p = JSON.parse(data.toString());
        const ca = p.mint || p.token;
        if (ca && !isCached(ca) && !isContractCached(ca)) {
          const msg = `<b>💊 PumpFun Mint</b>\n<code>${escapeHTML(ca)}</code>`;
          enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getButtons(ca) } });
        }
      } catch (e) {}
    });
    
    pumpWS.on('close', (code) => {
      console.log(`🔌 PumpFun closed (code: ${code})`);
      pumpWS = null;
      if (pumpReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(1000 * Math.pow(2, pumpReconnectAttempts), 60000);
        pumpReconnectAttempts++;
        setTimeout(startPumpFun, delay);
      }
    });
    
    pumpWS.on('error', (e) => {
      console.error('PumpFun error:', e.message);
      pumpWS = null;
      if (pumpReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(5000 * Math.pow(1.5, pumpReconnectAttempts), 60000);
        pumpReconnectAttempts++;
        setTimeout(startPumpFun, delay);
      }
    });
  } catch (e) {
    console.error('Failed to start PumpFun:', e.message);
    setTimeout(startPumpFun, 5000);
  }
}

async function checkRaydium() {
  if (!ENABLE_RAYDIUM || Date.now() - lastRaydium < 30000) return;
  lastRaydium = Date.now();
  
  try {
    const { data } = await axios.get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1', {
      timeout: 10000,
      httpsAgent: agent
    });
    
    for (const pool of (data?.data || [])) {
      if (pool.attributes?.dex_id !== 'raydium') continue;
      const mint = pool.attributes.base_token_address;
      if (!mint || isCached(mint) || isContractCached(mint)) continue;
      
      const msg = `<b>🔷 Raydium Pool</b>\n<b>${escapeHTML(pool.attributes.name)}</b>\n<code>${escapeHTML(mint)}</code>`;
      enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getButtons(mint) } });
    }
  } catch (e) {
    console.error('Raydium API failed:', e.message);
  }
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  setImmediate(() => {
    try {
      bot.processUpdate(req.body);
    } catch (e) {
      console.error('Webhook process error:', e.message);
    }
  });
});

app.get('/health', (req, res) => {
  const healthy = NITTER_NODES.filter(n => n.downUntil < Date.now() && n.requests < 3).length;
  res.json({
    status: 'alive',
    version: 'v16.2.0',
    worker: !!worker,
    cache: CACHE.size,
    contracts: CONTRACT_CACHE.size,
    nodes: `${healthy}/${NITTER_NODES.length}`,
    pumpfun: ENABLE_PUMPFUN ? (pumpWS?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected') : 'disabled',
    raydium: ENABLE_RAYDIUM ? 'enabled' : 'disabled',
    users: state.users.length,
    queries: state.queries.length,
    callbacks: workerCallbacks.size
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 V16.2 WARLORD listening on ${PORT}`);
  axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${WEBHOOK_BASE_URL}/webhook`)
    .catch(e => console.error('Webhook setup failed:', e.message));

  setTimeout(() => {
    bot.sendMessage(TELEGRAM_CHAT_ID, '<b>⚔️ V16.2 WARLORD ONLINE</b>\n🎯 All critical fixes applied!\n🔧 PumpFun reconnect + Memory leaks fixed', {
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true }
    }).catch(() => {});
  }, 3000);
});

const queue = [];
let sending = false;

function enqueue(chatId, text, options = {}) {
  queue.push({ chatId, text, options });
  if (!sending) processQueue();
}

async function processQueue() {
  if (sending || !queue.length) return;
  sending = true;

  while (queue.length) {
    const { chatId, text, options } = queue.shift();
    try {
      await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
      });
    } catch (e) {
      if (e.response?.statusCode === 429) {
        const delay = ((e.response.parameters?.retry_after || 5) * 1000);
        queue.unshift({ chatId, text, options });
        console.warn(`⏱️ Rate limited, waiting ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`Send error: ${e.message}`);
      }
    }
    await new Promise(r => setTimeout(r, MSG_INTERVAL_MS));
  }
  sending = false;
}

async function sendDashboard(chatId) {
  const healthy = NITTER_NODES.filter(n => n.downUntil < Date.now() && n.requests < 3).length;
  const pumpStatus = pumpWS?.readyState === WebSocket.OPEN ? '✅' : '🔄';
  
  const dashboard = `<b>⚔️ SOLANA WARLORD V16.2</b>

<b>📊 Status:</b>
✅ Worker: ${worker ? 'Active' : 'Offline'}
🌐 Nodes: ${healthy}/${NITTER_NODES.length}
📦 Cache: ${CACHE.size} items
💎 Contracts: ${CONTRACT_CACHE.size}
👥 Users: ${state.users.length}
🔍 Queries: ${state.queries.length}

<b>🎯 Features:</b>
💊 PumpFun: ${ENABLE_PUMPFUN ? `${pumpStatus}` : '❌'}
🔷 Raydium: ${ENABLE_RAYDIUM ? '✅' : '❌'}

<b>📋 Commands:</b>
/adduser [name] - Track user
/removeuser [name] - Stop tracking
/addquery [text] - Add search
/removequery [text] - Remove search
/listusers - Show users
/listqueries - Show queries
/togglepump - Toggle PumpFun
/toggleraydium - Toggle Raydium
/health - Network status
/help - This menu`;

  bot.sendMessage(chatId, dashboard, { parse_mode: 'HTML' }).catch(e => console.error('Dashboard send failed:', e.message));
}

bot.on('message', async (msg) => {
  if (!msg || !msg.text || msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  const text = msg.text.trim();
  const userId = msg.from.id.toString();

  if (text === '/start' || text === '/admin' || text === '/help') {
    await sendDashboard(msg.chat.id);
    return;
  }

  if (text === '/health') {
    const status = NITTER_NODES.map(n => {
      const icon = n.downUntil > Date.now() ? '🔴' : '🟢';
      return `${icon} <b>${n.host}</b> (${n.failures}❌, ${n.requests}/3)`;
    }).join('\n');
    bot.sendMessage(msg.chat.id, `<b>🌐 Network Health:</b>\n\n${status}`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  if (text === '/listusers') {
    const list = state.users.length > 0 ? state.users.map((u, i) => `${i + 1}. @${u}`).join('\n') : 'No users';
    bot.sendMessage(msg.chat.id, `<b>👥 Tracked Users:</b>\n\n${list}`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  if (text === '/listqueries') {
    const list = state.queries.map((q, i) => `${i + 1}. "${q}"`).join('\n');
    bot.sendMessage(msg.chat.id, `<b>🔍 Search Queries:</b>\n\n${list}`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  if (text === '/togglepump') {
    ENABLE_PUMPFUN = !ENABLE_PUMPFUN;
    if (ENABLE_PUMPFUN) startPumpFun();
    bot.sendMessage(msg.chat.id, `💊 PumpFun: ${ENABLE_PUMPFUN ? '✅ ON' : '❌ OFF'}`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  if (text === '/toggleraydium') {
    ENABLE_RAYDIUM = !ENABLE_RAYDIUM;
    bot.sendMessage(msg.chat.id, `🔷 Raydium: ${ENABLE_RAYDIUM ? '✅ ON' : '❌ OFF'}`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  if (text.startsWith('/adduser ')) {
    if (isCommandOnCooldown(userId, 'adduser')) {
      bot.sendMessage(msg.chat.id, '⏱️ Slow down! Wait 1 minute between commands.', { parse_mode: 'HTML' });
      return;
    }
    const user = text.split(' ')[1]?.replace('@', '').toLowerCase().trim();
    if (!user || !validateUsername(user)) {
      bot.sendMessage(msg.chat.id, '❌ Invalid username (1-15 chars, letters/numbers/_ only)', { parse_mode: 'HTML' });
      return;
    }
    if (!state.users.includes(user)) {
      state.users.push(user);
      saveState();
      bot.sendMessage(msg.chat.id, `✅ Added @${user}`, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(msg.chat.id, `ℹ️ @${user} already tracked`, { parse_mode: 'HTML' });
    }
    return;
  }

  if (text.startsWith('/removeuser ')) {
    if (isCommandOnCooldown(userId, 'removeuser')) {
      bot.sendMessage(msg.chat.id, '⏱️ Slow down! Wait 1 minute between commands.', { parse_mode: 'HTML' });
      return;
    }
    const user = text.split(' ')[1]?.replace('@', '').toLowerCase().trim();
    if (user) {
      state.users = state.users.filter(u => u !== user);
      saveState();
      bot.sendMessage(msg.chat.id, `🗑️ Removed @${user}`, { parse_mode: 'HTML' });
    }
    return;
  }

  if (text.startsWith('/addquery ')) {
    if (isCommandOnCooldown(userId, 'addquery')) {
      bot.sendMessage(msg.chat.id, '⏱️ Slow down! Wait 1 minute between commands.', { parse_mode: 'HTML' });
      return;
    }
    const query = text.substring(9).trim();
    if (!query || !validateQuery(query)) {
      bot.sendMessage(msg.chat.id, '❌ Invalid query (max 100 chars, no HTML/JS)', { parse_mode: 'HTML' });
      return;
    }
    if (!state.queries.includes(query)) {
      state.queries.push(query);
      saveState();
      bot.sendMessage(msg.chat.id, `✅ Added: "${query}"`, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(msg.chat.id, `ℹ️ "${query}" already exists`, { parse_mode: 'HTML' });
    }
    return;
  }

  if (text.startsWith('/removequery ')) {
    if (isCommandOnCooldown(userId, 'removequery')) {
      bot.sendMessage(msg.chat.id, '⏱️ Slow down! Wait 1 minute between commands.', { parse_mode: 'HTML' });
      return;
    }
    const query = text.substring(12).trim();
    if (query) {
      state.queries = state.queries.filter(q => q !== query);
      saveState();
      bot.sendMessage(msg.chat.id, `🗑️ Removed: "${query}"`, { parse_mode: 'HTML' });
    }
    return;
  }
});

let firstRun = true;

async function mainLoop() {
  try {
    await scanUsers(firstRun);
    await runHunterQueries(firstRun);
    await checkRaydium();
    firstRun = false;
  } catch (e) {
    console.error('Main loop error:', e.message);
  }
  setTimeout(mainLoop, POLL_INTERVAL_MS);
}

setTimeout(() => {
  console.log('📍 Starting main loop...');
  mainLoop();
}, 2000);

if (ENABLE_PUMPFUN) {
  setTimeout(startPumpFun, 1000);
}

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  if (pumpWS) pumpWS.close();
  saveHistory();
  saveState();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Interrupted...');
  if (pumpWS) pumpWS.close();
  saveHistory();
  saveState();
  process.exit(0);
});

console.log('⚔️ Solana Hunter v16.2 - All critical fixes applied!');
