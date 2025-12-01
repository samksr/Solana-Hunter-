// SOLANA HUNTER V16 - WARLORD EDITION

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
const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || '').replace(//$/, '');

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
  'solana "minting now"'
];

let worker = null;
const workerCallbacks = new Map();

function createWorker() {
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
}

createWorker();

function runWorkerTask(type, payload) {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error('Worker unavailable'));
    const id = Date.now() + Math.random();
    workerCallbacks.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload });
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
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {}
}

loadState();

const CACHE = new Map();

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      data.forEach(item => CACHE.set(item.id, item.ts));
      console.log(`📚 Cache: ${CACHE.size} items`);
    }
  } catch (e) {}
}

function saveHistory() {
  try {
    const data = Array.from(CACHE.entries()).map(([id, ts]) => ({ id, ts }));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data));
  } catch (e) {}
}

function isCached(id) {
  if (CACHE.has(id)) return true;
  CACHE.set(id, Date.now());
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of CACHE.entries()) {
    if (now - ts > 86400000) CACHE.delete(id);
  }
  if (CACHE.size % 100 === 0) saveHistory();
}, 120000);

loadHistory();

const agent = new https.Agent({ keepAlive: true });
const axiosFast = axios.create({
  timeout: 10000,
  httpsAgent: agent,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});

const NITTER_NODES = [
  { host: "nitter.net", downUntil: 0, failures: 0 },
  { host: "xcancel.com", downUntil: 0, failures: 0 },
  { host: "nitter.poast.org", downUntil: 0, failures: 0 },
  { host: "nitter.tiekoetter.com", downUntil: 0, failures: 0 },
  { host: "nitter.privacyredirect.com", downUntil: 0, failures: 0 },
  { host: "nitter.lucabased.xyz", downUntil: 0, failures: 0 },
  { host: "nitter.freereddit.com", downUntil: 0, failures: 0 }
];

function getHealthyNode() {
  const healthy = NITTER_NODES.filter(n => n.downUntil < Date.now());
  if (healthy.length === 0) {
    console.log('⚠️ No healthy nodes, resetting...');
    NITTER_NODES.forEach(n => { n.downUntil = 0; n.failures = 0; });
    return NITTER_NODES[0];
  }
  return healthy[Math.floor(Math.random() * healthy.length)];
}

function markNodeDown(host) {
  const node = NITTER_NODES.find(n => n.host === host);
  if (node) {
    node.failures = (node.failures || 0) + 1;
    node.downUntil = Date.now() + Math.min(60000 * node.failures, 600000);
  }
}
async function fetchWithRetry(urlPath, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const node = getHealthyNode();
    try {
      const response = await axiosFast.get(`https://${node.host}/${urlPath}?t=${Date.now()}`, {
        responseType: 'text'
      });

      if (response.data.includes('over capacity') || response.data.includes('error')) {
        markNodeDown(node.host);
        continue;
      }

      const items = await runWorkerTask('PARSE_RSS', { xml: response.data });
      return { items: items || [], host: node.host };
    } catch (e) {
      markNodeDown(node.host);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  return null;
}

function escapeHTML(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
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
  for (const user of state.users) {
    const res = await fetchWithRetry(`${user}/rss`);
    if (!res?.items?.length) continue;

    for (const item of res.items.slice(0, 10)) {
      if (isCached(item.id) || firstRun) continue;

      const link = item.link || `https://x.com/${user}`;
      let msg = `<b>🐦 @${escapeHTML(user)}:</b>

${escapeHTML(item.snippet)}`;
      let buttons = [[{ text: '🐦 Tweet', url: `https://x.com/${user}/status/${item.id.split('/').pop()}` }]];

      if (item.ca) {
        msg += `

<b>💎 CA:</b> <code>${escapeHTML(item.ca)}</code>`;
        buttons = getButtons(item.ca, link);
      } else {
        msg += `

<tg-spoiler>via ${res.host}</tg-spoiler>`;
      }
      enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: buttons } });
    }
  }
}

async function runHunterQueries(firstRun) {
  for (const query of state.queries) {
    const res = await fetchWithRetry(`search/rss?f=tweets&q=${encodeURIComponent(query)}`);
    if (!res?.items?.length) continue;

    for (const item of res.items) {
      if (isCached(item.id) || !item.ca || item.suspicious || firstRun) continue;

      const link = item.link || `https://x.com/i/status/${item.id.replace(/D/g, '')}`;
      const msg = `<b>🔎 "${escapeHTML(query)}"</b>
<b>💎 CA:</b> <code>${escapeHTML(item.ca)}</code>

<i>${escapeHTML(item.snippet)}...</i>

<tg-spoiler>via ${res.host}</tg-spoiler>`;
      enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getButtons(item.ca, link) } });
    }
  }
}

let pumpWS = null;

function startPumpFun() {
  if (!ENABLE_PUMPFUN || pumpWS) return;
  pumpWS = new WebSocket('wss://pumpportal.fun/ws');
  pumpWS.on('open', () => console.log('🟢 PumpFun live'));
  pumpWS.on('message', (data) => {
    try {
      const p = JSON.parse(data);
      const ca = p.mint || p.token;
      if (ca && !isCached(ca)) {
        const msg = `<b>💊 PumpFun Mint</b>
<code>${escapeHTML(ca)}</code>`;
        enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getButtons(ca) } });
      }
    } catch (e) {}
  });
  pumpWS.on('close', () => { pumpWS = null; setTimeout(startPumpFun, 3000); });
  pumpWS.on('error', () => { pumpWS = null; setTimeout(startPumpFun, 5000); });
}

async function checkRaydium() {
  if (!ENABLE_RAYDIUM) return;
  try {
    const { data } = await axiosFast.get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1');
    for (const pool of data?.data || []) {
      if (pool.attributes?.dex_id !== 'raydium') continue;
      const mint = pool.attributes.base_token_address;
      if (!mint || isCached(mint)) continue;

      const msg = `<b>🔷 Raydium Pool</b>
<b>${escapeHTML(pool.attributes.name)}</b>
<code>${escapeHTML(mint)}</code>`;
      enqueue(TELEGRAM_CHAT_ID, msg, { reply_markup: { inline_keyboard: getButtons(mint) } });
    }
  } catch (e) {
    console.error('Raydium API failed');
  }
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  setImmediate(() => bot.processUpdate(req.body).catch(() => {}));
});

app.get('/health', (req, res) => {
  const healthy = NITTER_NODES.filter(n => n.downUntil < Date.now()).length;
  res.json({
    status: 'alive',
    worker: !!worker,
    cache: CACHE.size,
    nodes: `${healthy}/${NITTER_NODES.length}`,
    pumpfun: !!pumpWS
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 V16 listening on ${PORT}`);
  axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${WEBHOOK_BASE_URL}/webhook`)
    .catch(console.error);

  setTimeout(() => {
    bot.sendMessage(TELEGRAM_CHAT_ID, '<b>⚔️ V16 WARLORD ONLINE</b>', {
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
        const delay = (e.response.parameters?.retry_after || 5) * 1000;
        queue.unshift({ chatId, text, options });
        await new Promise(r => setTimeout(r, delay));
      }
    }
    await new Promise(r => setTimeout(r, MSG_INTERVAL_MS));
  }
  sending = false;
}
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID || !msg.text) return;

  const text = msg.text.trim();
  if (text === '/start' || text === '/admin') {
    bot.sendMessage(msg.chat.id, 'Dashboard loading...', {
      reply_markup: { remove_keyboard: true }
    }).then(() => sendDashboard(msg.chat.id));
    return;
  }

  if (text === '/health') {
    const status = NITTER_NODES.map(n => {
      const icon = n.downUntil > Date.now() ? '🔴' : '🟢';
      return `${icon} <b>${n.host}</b>`;
    }).join('
');
    bot.sendMessage(TELEGRAM_CHAT_ID, `<b>🌐 Network:</b>

${status}`, { parse_mode: 'HTML' });
    return;
  }

  if (text.startsWith('/adduser ')) {
    const user = text.split(' ')[1]?.replace('@', '');
    if (user && !state.users.includes(user)) {
      state.users.push(user);
      saveState();
      bot.sendMessage(msg.chat.id, `✅ <b>${user}</b> added`, { parse_mode: 'HTML' });
    }
  }

  if (text.startsWith('/removeuser ')) {
    const user = text.split(' ')[1]?.replace('@', '');
    state.users = state.users.filter(u => u !== user);
    saveState();
    bot.sendMessage(msg.chat.id, `🗑️ <b>${user}</b> removed`, { parse_mode: 'HTML' });
  }

  if (text.startsWith('/addquery ')) {
    const query = text.substring(10).trim();
    if (query && !state.queries.includes(query)) {
      state.queries.push(query);
      saveState();
      bot.sendMessage(msg.chat.id, `✅ <b>${query}</b> added`, { parse_mode: 'HTML' });
    }
  }

  if (text.startsWith('/removequery ')) {
    const query = text.substring(13).trim();
    state.queries = state.queries.filter(q => q !== query);
    saveState();
    bot.sendMessage(msg.chat.id, `🗑️ <b>${query}</b> removed`, { parse_mode: 'HTML' });
  }

  if (text === '/listusers') {
    const users = state.users.length ? state.users.join('
') : 'None';
    bot.sendMessage(msg.chat.id, `<b>👥 Users (${state.users.length}):</b>

${users}`, { parse_mode: 'HTML' });
  }

  if (text === '/listqueries') {
    const queries = state.queries.join('
');
    bot.sendMessage(msg.chat.id, `<b>🔎 Queries (${state.queries.length}):</b>

${queries}`, { parse_mode: 'HTML' });
  }
});

async function sendDashboard(chatId, msgId) {
  const healthy = NITTER_NODES.filter(n => n.downUntil < Date.now()).length;
  const status = `<b>⚔️ SOLANA HUNTER V16</b>

👥 Users: <b>${state.users.length}</b>
🔎 Queries: <b>${state.queries.length}</b>
📡 Nodes: <b>${healthy}/${NITTER_NODES.length}</b>
💊 PumpFun: <b>${ENABLE_PUMPFUN ? '🟢' : '🔴'}</b>
🔷 Raydium: <b>${ENABLE_RAYDIUM ? '🟢' : '🔴'}</b>
⚙️ Cache: <b>${CACHE.size}</b>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `💊 PumpFun ${ENABLE_PUMPFUN ? 'OFF' : 'ON'}`, callback_data: 'toggle_pf' }],
      [{ text: `🔷 Raydium ${ENABLE_RAYDIUM ? 'OFF' : 'ON'}`, callback_data: 'toggle_ray' }],
      [{ text: '🔄 Refresh', callback_data: 'refresh' }, { text: '🏥 Health', callback_data: 'health' }]
    ]
  };

  if (msgId) {
    try {
      await bot.editMessageText(status, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } catch (e) {}
  } else {
    await bot.sendMessage(chatId, status, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

bot.on('callback_query', async (query) => {
  if (query.message.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  const data = query.data;
  if (data === 'toggle_pf') {
    ENABLE_PUMPFUN = !ENABLE_PUMPFUN;
    if (ENABLE_PUMPFUN) startPumpFun();
    else if (pumpWS) { pumpWS.close(); pumpWS = null; }
  }

  if (data === 'toggle_ray') ENABLE_RAYDIUM = !ENABLE_RAYDIUM;

  if (data === 'health') {
    const health = NITTER_NODES.map(n => {
      const status = n.downUntil > Date.now() ? '🔴' : '🟢';
      return `${status} <b>${n.host}</b>`;
    }).join('
');
    bot.sendMessage(TELEGRAM_CHAT_ID, `<b>🌐 Health Check:</b>

${health}`, { parse_mode: 'HTML' });
    bot.answerCallbackQuery(query.id);
    return;
  }

  sendDashboard(TELEGRAM_CHAT_ID, query.message.message_id);
  bot.answerCallbackQuery(query.id);
});

async function mainLoop() {
  console.log('⚔️ V16 starting...');
  let firstRun = true;

  while (true) {
    try {
      await Promise.allSettled([
        scanUsers(firstRun),
        runHunterQueries(firstRun),
        checkRaydium()
      ]);

      if (firstRun) {
        console.log('✅ LIVE - All systems operational');
        firstRun = false;
      }
    } catch (e) {
      console.error('Main loop error:', e.message);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS + Math.random() * 2000));
  }
}

process.on('SIGTERM', () => {
  console.log('🛑 Graceful shutdown');
  saveState();
  saveHistory();
  process.exit(0);
});

mainLoop();
console.log(`🚀 V16 WARLORD - POLL:${POLL_INTERVAL_MS}ms READY`);
