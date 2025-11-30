/******************************************************************************************
 *  SOLANA HUNTER BOT — ULTRA STABLE EDITION (WEBHOOK + DASHBOARD + HUNTER + PUMPFUN)
 *  PART 1 / 5
 *
 *  DO NOT RUN UNTIL ALL 5 PARTS ARE MERGED INTO ONE FILE.
 *
 *  Features:
 *   ✔ Ultra-fast Telegram webhook
 *   ✔ Nitter multi-instance rotation
 *   ✔ Smart crash-guard + webhook heal
 *   ✔ PumpFun live mint watcher
 *   ✔ Raydium new-pool watcher
 *   ✔ Solana CA extraction
 *   ✔ Dashboard with inline buttons
 *   ✔ Full MarkdownV2 escaping (Telegram safe)
 *   ✔ State persistence + alerts logging
 *   ✔ Throttled logs (safe for Railway)
 ******************************************************************************************/

// ---------------------------------------
// 1. IMPORTS & SETUP
// ---------------------------------------
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const RSSParser = require('rss-parser');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
require('dotenv').config();

// ---------------------------------------
// 2. ENVIRONMENT VARIABLES
// ---------------------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || "";

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !WEBHOOK_BASE_URL) {
  console.error("❌ Missing TELEGRAM_TOKEN, TELEGRAM_CHAT_ID or WEBHOOK_BASE_URL");
  process.exit(1);
}

WEBHOOK_BASE_URL = WEBHOOK_BASE_URL.replace(/\/$/, ""); // remove trailing slash

// Feature Toggles
let ENABLE_RAYDIUM = (process.env.ENABLE_RAYDIUM === "true") || false;
let ENABLE_PUMPFUN = (process.env.ENABLE_PUMPFUN === "true") || true;

// Auto-monitor users via ENV
const USERS_TO_MONITOR =
  (process.env.USERS_TO_MONITOR || "")
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

// ---------------------------------------
// 3. CONSTANTS / PATHS
// ---------------------------------------
const POLL_INTERVAL_MS = 15000; // hunter + user scan every 15s
const MSG_INTERVAL_MS = Number(process.env.MSG_INTERVAL_MS || 200);

const STATE_FILE = path.join(__dirname, "state.json");
const ALERTS_FILE = path.join(__dirname, "alerts.log.json");
const BACKUP_FILE = path.join(__dirname, "state.backup.json");

const DEBUG = process.env.DEBUG === "true";

// ---------------------------------------
// 4. UTILITY HELPERS
// ---------------------------------------
function nowISO() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// Safe MarkdownV2 escape
function escapeMD(text) {
  if (text == null) return "";
  return String(text).replace(/([_*\[\]\(\)~`>#+\-=|{}.!\\])/g, "\\$1");
}

// LOG THROTTLER (Railway safe)
const LOG_WINDOW = 1000;
const MAX_LOGS = 12;
let recent = [];

function throttledLog(...msg) {
  const now = Date.now();
  recent = recent.filter(t => now - t < LOG_WINDOW);
  if (recent.length < MAX_LOGS) {
    recent.push(now);
    if (DEBUG) console.log(nowISO(), ...msg);
  }
}

function safeLog(...msg) {
  console.log(nowISO(), ...msg);
}

// ---------------------------------------
// 5. STATE MANAGEMENT
// ---------------------------------------
let state = { users: [], queries: [], last: {} };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = Object.assign(
        { users: [], queries: [], last: {} },
        JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
      );
    } else {
      saveState();
    }
  } catch (e) {
    state = { users: [], queries: [], last: {} };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {}
}

function backupState() {
  try {
    fs.writeFileSync(
      BACKUP_FILE,
      JSON.stringify({ ts: nowISO(), state }, null, 2)
    );
  } catch (e) {}
}

loadState();

// merge ENV users
for (const u of USERS_TO_MONITOR) {
  if (!state.users.includes(u)) state.users.push(u);
}
saveState();

// ---------------------------------------
// 6. TELEGRAM BOT (WEBHOOK MODE)
// ---------------------------------------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const app = express();
app.use(express.json());

// BASIC HEALTH ENDPOINT
app.get("/health", (req, res) => {
  res.json({ status: "ok", ts: nowISO() });
});

// MAIN WEBHOOK ROUTE
app.post("/webhook", (req, res) => {
  try {
    res.sendStatus(200);
    setImmediate(() => {
      try {
        bot.processUpdate(req.body);
      } catch (e) {
        throttledLog("processUpdate error:", e.message);
      }
    });
  } catch (e) {
    throttledLog("Webhook error:", e.message);
    try { res.sendStatus(200); } catch {}
  }
});

// SERVER START
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  safeLog("🌐 Server running on port", PORT);
  safeLog("🔗 Webhook URL:", WEBHOOK_BASE_URL + "/webhook");

  // Set webhook automatically
  (async () => {
    try {
      const res = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_BASE_URL + "/webhook")}`
      );
      safeLog("Webhook set:", res.data.ok);
    } catch (e) {
      throttledLog("Webhook set failed:", e.message);
    }
  })();
});

// ---------------------------------------
// 7. QUEUED MESSAGE SENDER (NO RATE LIMIT CRASHES)
// ---------------------------------------
let sending = false;
let queue = [];

function enqueue(chatId, text, opts = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ chatId, text, opts, resolve, reject });
    if (!sending) processQueue();
  });
}

async function processQueue() {
  sending = true;

  while (queue.length) {
    const job = queue.shift();

    let attempts = 0;
    let success = false;

    while (attempts < 6 && !success) {
      attempts++;
      try {
        await bot.sendMessage(
          job.chatId,
          job.text,
          Object.assign(
            {
              parse_mode: "MarkdownV2",
              disable_web_page_preview: true,
            },
            job.opts
          )
        );
        job.resolve(true);
        success = true;
      } catch (e) {
        throttledLog("Telegram send error:", e.message);

        // retry strategy
        const code = e?.response?.status || 0;

        if (code === 429) {
          const ra = Number(e.response?.headers?.["retry-after"] || 1);
          await sleep((ra + 1) * 1000);
        } else if (code >= 500) {
          await sleep(attempts * 300);
        } else {
          // non-retry error
          job.reject(e);
          break;
        }
      }
    }

    await sleep(MSG_INTERVAL_MS);
  }

  sending = false;
}

function sendOwner(text, opts = {}) {
  return enqueue(TELEGRAM_CHAT_ID, text, opts);
}

// ---------------------------------------
// 8. NITTER ENGINE (MULTI INSTANCE ROTATION)
// ---------------------------------------
const DEFAULT_NITTERS = [
  "nitter.net",
  "nitter.poast.org",
  "nitter.privacydev.net",
  "nitter.unixfox.eu",
  "nitter.lgbt",
  "nitter.ca"
];

const NITTER = DEFAULT_NITTERS.map(host => ({ host, cooldown: 0 }));

function ts() {
  return Date.now();
}

function availableHosts() {
  const now = ts();
  const ok = NITTER.filter(h => h.cooldown < now);
  if (ok.length) return ok;

  // all dead → reset
  NITTER.forEach(h => (h.cooldown = 0));
  return NITTER;
}

function cooldownHost(host, sec = 60) {
  const it = NITTER.find(x => x.host === host);
  if (it) it.cooldown = ts() + sec * 1000;
}

const axiosFast = axios.create({
  timeout: 10000,
  headers: { "User-Agent": "Mozilla/5.0" },
});

const rssParser = new RSSParser();

// ----------------------------
// END OF PART 1
// ----------------------------/******************************************************************************************
 *  SOLANA HUNTER BOT — PART 2 / 5
 *  Nitter fetch engines, search engine, CA extractors, filters, alert logger
 ******************************************************************************************/

// ---------------------------------------
// 9. FETCH TWEETS FROM USER (NITTER ENGINE)
// ---------------------------------------
async function fetchUserTweets(username) {
  const hosts = availableHosts()
    .sort(() => 0.5 - Math.random())
    .slice(0, 3);

  for (const entry of hosts) {
    const host = entry.host;
    const url = `https://${host}/${username}/rss`;

    try {
      const res = await axiosFast.get(url, { responseType: "text" });
      const feed = await rssParser.parseString(res.data);

      if (!feed?.items || feed.items.length === 0) throw new Error("empty feed");

      const items = feed.items.map(i => {
        let idm = null;

        if (i.link) {
          const m = i.link.match(/status\/(\d+)/);
          if (m) idm = m[1];
        }

        return {
          id: idm,
          author: username,
          text: i.contentSnippet || i.title || i.content || "",
          ts: i.pubDate ? new Date(i.pubDate).getTime() : Date.now(),
          link: i.link || null,
        };
      });

      const valid = items.filter(x => x.id);
      if (valid.length === 0) throw new Error("no IDs");

      return {
        items: valid,
        instance: host,
      };
    } catch (e) {
      throttledLog(`fetchUserTweets error from ${host}:`, e.message);
      cooldownHost(entry, 60);
    }
  }

  return null;
}

// ---------------------------------------
// 10. SEARCH ENGINE (Hunter Queries)
// ---------------------------------------
async function fetchSearch(query) {
  const hosts = availableHosts()
    .sort(() => 0.5 - Math.random())
    .slice(0, 3);

  for (const entry of hosts) {
    const host = entry.host;
    const url = `https://${host}/search/rss?f=tweets&q=${encodeURIComponent(query)}`;

    try {
      const res = await axiosFast.get(url, { responseType: "text" });
      const feed = await rssParser.parseString(res.data);

      if (!feed?.items || feed.items.length === 0) throw new Error("empty search");

      const items = feed.items.map(i => {
        let idm = null;
        if (i.link) {
          const m = i.link.match(/status\/(\d+)/);
          if (m) idm = m[1];
        }

        return {
          id: idm,
          author: i.creator || "",
          text: i.contentSnippet || i.title || i.content || "",
          ts: i.pubDate ? new Date(i.pubDate).getTime() : Date.now(),
          link: i.link || null,
        };
      });

      const valid = items.filter(x => x.id);
      if (valid.length === 0) throw new Error("no IDs");

      return {
        items: valid,
        instance: host,
      };

    } catch (e) {
      throttledLog(`fetchSearch error from ${host}:`, e.message);
      cooldownHost(entry, 60);
    }
  }

  return null;
}

// ---------------------------------------
// 11. CA EXTRACTOR + FILTERS
// ---------------------------------------
function extractCA(txt) {
  if (!txt) return null;
  const m = txt.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  return m ? m[0] : null;
}

function isSuspicious(txt) {
  if (!txt) return false;

  const low = txt.toLowerCase();

  const bad = [
    "honeypot",
    "rug",
    "scam",
    "airdrop",
    "presale",
    "pump dump",
    "dump",
    "phish",
    "steal",
    "hack",
    "copy",
    "fake"
  ];

  for (const w of bad) {
    if (low.includes(w)) return true;
  }

  // repeated letters (spam filter)
  if (/(.)\1{8,}/.test(low)) return true;

  return false;
}

// ---------------------------------------
// 12. ALERT LOGGER
// ---------------------------------------
function appendAlert(rec) {
  try {
    let arr = [];

    if (fs.existsSync(ALERTS_FILE)) {
      arr = JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8") || "[]");
    }

    arr.push(rec);

    if (arr.length > 10000) arr = arr.slice(-10000);

    fs.writeFileSync(ALERTS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    throttledLog("appendAlert failed:", e.message);
  }
}

// ---------------------------------------
// 13. IN-MEMORY SENT-ID CACHE
// ---------------------------------------
const SENT_IDS = new Set();

function markSent(id) {
  if (!id) return;
  SENT_IDS.add(String(id));
}

// ----------------------------
// END OF PART 2
// ----------------------------/******************************************************************************************
 *  SOLANA HUNTER BOT — PART 3 / 5
 *  User feed scanning, Hunter queries, Raydium watcher, PumpFun WS sniper
 ******************************************************************************************/

// ---------------------------------------
// 14. USER SCAN LOOP (MONITORED ACCOUNTS)
// ---------------------------------------
async function scanUsers() {
  try {
    for (const user of state.users) {
      const res = await fetchUserTweets(user);
      if (!res) continue;

      for (const tw of res.items) {
        if (SENT_IDS.has(tw.id)) continue;
        if (isSuspicious(tw.text)) continue;

        const ca = extractCA(tw.text);
        const snippet = tw.text.slice(0, 300);
        const link = tw.link || `https://x.com/${tw.author}/status/${tw.id}`;

        if (ca) {
          const md = `*🐦 New CA from @${escapeMD(tw.author)}*\n\n` +
                     `*CA:* \`${escapeMD(ca)}\`\n\n` +
                     `${escapeMD(snippet)}\n\n` +
                     `[View Tweet](${escapeMD(link)})\n` +
                     `[DexScreener](${escapeMD("https://dexscreener.com/solana/" + ca)})`;

          await enqueue(TELEGRAM_CHAT_ID, md);
          appendAlert({
            ts: nowISO(),
            type: "user_ca",
            id: tw.id,
            ca,
            author: tw.author,
            instance: res.instance
          });
        }

        markSent(tw.id);
      }
    }
  } catch (e) {
    throttledLog("scanUsers error:", e.message);
  }
}

// ---------------------------------------
// 15. HUNTER LOOP (SEARCH QUERIES)
// ---------------------------------------
async function runHunter() {
  try {
    for (const query of state.queries) {
      const res = await fetchSearch(query);
      if (!res) continue;

      for (const tw of res.items) {
        if (SENT_IDS.has(tw.id)) continue;
        if (isSuspicious(tw.text)) continue;

        const ca = extractCA(tw.text);
        if (!ca) continue;

        const snippet = tw.text.slice(0, 300);
        const link = tw.link || `https://x.com/${tw.author}/status/${tw.id}`;

        const md = `*🎯 Hunter Match*\n\n` +
                   `*Query:* \`${escapeMD(query)}\`\n` +
                   `*CA:* \`${escapeMD(ca)}\`\n\n` +
                   `${escapeMD(snippet)}\n\n` +
                   `[View Tweet](${escapeMD(link)})\n` +
                   `[DexScreener](${escapeMD("https://dexscreener.com/solana/" + ca)})`;

        await enqueue(TELEGRAM_CHAT_ID, md);
        appendAlert({
          ts: nowISO(),
          type: "hunter",
          query,
          id: tw.id,
          ca,
          author: tw.author,
          instance: res.instance
        });

        markSent(tw.id);
      }
    }
  } catch (e) {
    throttledLog("runHunter error:", e.message);
  }
}

// ---------------------------------------
// 16. RAYDIUM NEW POOL WATCHER
// ---------------------------------------
let KNOWN_RAY_MINTS = new Set();

async function checkRaydium() {
  try {
    const url = "https://api.raydium.io/v2/sdk/liquidity/mainnet/pools";
    const res = await axiosFast.get(url, { timeout: 8000 });

    const pools = Array.isArray(res.data) ? res.data : [];
    for (const p of pools) {
      const mint = p.lpMint || p.mint || p.mintA || p.mintB;
      if (!mint) continue;

      if (!KNOWN_RAY_MINTS.has(mint)) {
        KNOWN_RAY_MINTS.add(mint);

        appendAlert({
          ts: nowISO(),
          type: "raydium",
          ca: mint
        });

        const md = `*🔵 Raydium New Pool Detected*\n\n` +
                   `*Mint:* \`${escapeMD(mint)}\`\n\n` +
                   `[DexScreener](${escapeMD("https://dexscreener.com/solana/" + mint)})`;

        await enqueue(TELEGRAM_CHAT_ID, md);
      }
    }
  } catch (e) {
    throttledLog("checkRaydium error:", e.message);
  }
}

// ---------------------------------------
// 17. PUMPFUN WEBSOCKET SNIPER
// ---------------------------------------
let pumpWS = null;

function startPumpFun() {
  if (!ENABLE_PUMPFUN) {
    throttledLog("PumpFun disabled");
    return;
  }

  try {
    pumpWS = new WebSocket("wss://pumpportal.fun/ws");

    pumpWS.on("open", () => throttledLog("PumpFun WS open"));

    pumpWS.on("message", async raw => {
      try {
        const data = JSON.parse(raw.toString());
        const ca = data?.mint || data?.ca || data?.token || data?.address;

        if (ca) {
          appendAlert({
            ts: nowISO(),
            type: "pumpfun",
            ca,
            raw: data
          });

          const md = `*🔥 PumpFun Mint Detected*\n\n` +
                     `*CA:* \`${escapeMD(ca)}\`\n\n` +
                     `[DexScreener](${escapeMD("https://dexscreener.com/solana/" + ca)})`;

          await enqueue(TELEGRAM_CHAT_ID, md);

          markSent(ca + "_" + Date.now());
        }
      } catch (e) {
        // ignore parse error
      }
    });

    pumpWS.on("error", e => {
      throttledLog("PumpFun WS error:", e.message);
      try { pumpWS.terminate(); } catch {}
      setTimeout(startPumpFun, 5000);
    });

    pumpWS.on("close", () => {
      throttledLog("PumpFun WS closed");
      setTimeout(startPumpFun, 3000);
    });

  } catch (e) {
    throttledLog("startPumpFun failed:", e.message);
    setTimeout(startPumpFun, 5000);
  }
}

// ----------------------------
// END OF PART 3
// ----------------------------/******************************************************************************************
 *  SOLANA HUNTER BOT — PART 4 / 5
 *  Admin dashboard, command registration, callback handlers, and command processing
 ******************************************************************************************/

// ---------------------------------------
// 18. REGISTER TELEGRAM COMMANDS (SAFE DESCRIPTIONS)
// ---------------------------------------
async function registerCommands() {
  try {
    await bot.setMyCommands([
      { command: "start", description: "Start or show dashboard" },
      { command: "help", description: "Show quick help" },
      { command: "listusers", description: "List monitored users" },
      { command: "adduser", description: "Add a user (admin only)" },
      { command: "removeuser", description: "Remove a user (admin only)" },
      { command: "listqueries", description: "List hunter queries" },
      { command: "addquery", description: "Add a hunter query (admin only)" },
      { command: "removequery", description: "Remove a hunter query (admin only)" },
      { command: "admin", description: "Admin operations and status" }
    ]);
    throttledLog("Commands registered");
  } catch (e) {
    throttledLog("registerCommands failed:", e.message);
  }
}
registerCommands().catch(() => {});

// ---------------------------------------
// 19. ADMIN DASHBOARD / INLINE KEYBOARD
// ---------------------------------------
function adminKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔁 Restart", callback_data: "DASH_RESTART" },
          { text: ENABLE_PUMPFUN ? "🟢 PumpFun ON" : "⚪ PumpFun OFF", callback_data: "DASH_TOGGLE_PUMPFUN" }
        ],
        [
          { text: ENABLE_RAYDIUM ? "🟢 Raydium ON" : "⚪ Raydium OFF", callback_data: "DASH_TOGGLE_RAYDIUM" },
          { text: "📄 Recent Alerts", callback_data: "DASH_VIEW_ALERTS" }
        ],
        [
          { text: "🔄 Refresh", callback_data: "DASH_REFRESH" },
          { text: "🗑 Clear Sent Cache", callback_data: "DASH_CLEAR_SENT" }
        ]
      ]
    },
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true
  };
}

async function getDashboardText() {
  const users = state.users.length ? state.users.slice(0, 10).map(u => escapeMD(u)).join(", ") : "_none_";
  const queries = state.queries.length ? state.queries.slice(0, 10).map(q => escapeMD(q)).join("\\n") : "_none_";
  let alertsCount = 0;
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8") || "[]");
      alertsCount = arr.length;
    }
  } catch (e) {
    throttledLog("getDashboardText alerts read failed", e.message);
  }

  const mem = process.memoryUsage();
  const memStr = `rss:${Math.round(mem.rss / 1024 / 1024)}MB heap:${Math.round(mem.heapUsed / 1024 / 1024)}MB`;

  const lines = [
    `*🧭 Admin Dashboard*`,
    ``,
    `*Users:* ${escapeMD(String(state.users.length))}`,
    `*Queries:* ${escapeMD(String(state.queries.length))}`,
    `*Alerts logged:* ${escapeMD(String(alertsCount))}`,
    `*PumpFun:* ${escapeMD(ENABLE_PUMPFUN ? "ON" : "OFF")}`,
    `*Raydium:* ${escapeMD(ENABLE_RAYDIUM ? "ON" : "OFF")}`,
    `*Memory:* ${escapeMD(memStr)}`,
    ``,
    `*Monitored users (first 10):*`,
    `${users}`,
    ``,
    `*Top queries (first 10):*`,
    `${queries}`
  ];

  return lines.join("\n");
}

async function sendAdminDashboard(chatId) {
  try {
    const txt = await getDashboardText();
    await bot.sendMessage(chatId, txt, adminKeyboard());
  } catch (e) {
    throttledLog("sendAdminDashboard failed", e.message);
  }
}

// ---------------------------------------
// 20. CALLBACK QUERY HANDLER (INLINE BUTTONS)
// ---------------------------------------
bot.on("callback_query", async q => {
  try {
    const cid = q.message?.chat?.id;
    if (String(cid) !== String(TELEGRAM_CHAT_ID)) {
      return bot.answerCallbackQuery(q.id, { text: "Unauthorized", show_alert: true });
    }

    const data = q.data;
    if (!data) return bot.answerCallbackQuery(q.id, { text: "No action" });

    if (data === "DASH_REFRESH") {
      await bot.answerCallbackQuery(q.id, { text: "Refreshed" });
      await sendAdminDashboard(cid);
      return;
    }

    if (data === "DASH_VIEW_ALERTS") {
      await bot.answerCallbackQuery(q.id, { text: "Fetching alerts..." });
      let list = [];
      try {
        const arr = fs.existsSync(ALERTS_FILE) ? JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8") || "[]") : [];
        list = arr.slice(-8).reverse().map(a => `${escapeMD(a.ts || "")} • ${escapeMD(a.ca || a.type || "")} • ${escapeMD(a.author || "")}`);
      } catch (e) {
        list = ["_failed to read alerts_"];
      }
      const msg = "*📄 Recent Alerts*\n\n" + (list.join("\n") || "_none_");
      await bot.sendMessage(cid, msg, { parse_mode: "MarkdownV2" });
      return;
    }

    if (data === "DASH_TOGGLE_PUMPFUN") {
      ENABLE_PUMPFUN = !ENABLE_PUMPFUN;
      await bot.answerCallbackQuery(q.id, { text: `PumpFun ${ENABLE_PUMPFUN ? "Enabled" : "Disabled"}` });
      if (ENABLE_PUMPFUN) {
        try { startPumpFun(); } catch (e) { throttledLog("startPumpFun error", e.message); }
      } else {
        try { if (pumpWS) pumpWS.terminate(); } catch (e) {}
      }
      await sendAdminDashboard(cid);
      return;
    }

    if (data === "DASH_TOGGLE_RAYDIUM") {
      ENABLE_RAYDIUM = !ENABLE_RAYDIUM;
      await bot.answerCallbackQuery(q.id, { text: `Raydium ${ENABLE_RAYDIUM ? "Enabled" : "Disabled"}` });
      await sendAdminDashboard(cid);
      return;
    }

    if (data === "DASH_CLEAR_SENT") {
      try { SENT_IDS.clear(); } catch (e) {}
      await bot.answerCallbackQuery(q.id, { text: "Sent cache cleared" });
      await sendAdminDashboard(cid);
      return;
    }

    if (data === "DASH_RESTART") {
      await bot.answerCallbackQuery(q.id, { text: "Restarting..." });
      await bot.sendMessage(cid, escapeMD("*Restarting bot as requested.*"));
      process.exit(0);
    }

    await bot.answerCallbackQuery(q.id, { text: "Unknown action" });
  } catch (e) {
    throttledLog("callback_query error", e.message);
    try { await bot.answerCallbackQuery(q.id, { text: "Error", show_alert: true }); } catch (_) {}
  }
});

// ---------------------------------------
// 21. MESSAGE / COMMAND HANDLER
// ---------------------------------------
function isAdminChat(msg) {
  return String(msg.chat?.id) === String(TELEGRAM_CHAT_ID);
}

bot.on("message", async msg => {
  try {
    if (!msg || !msg.text) return;
    const text = msg.text.trim();
    const cid = msg.chat.id;

    // /start: show dashboard to owner, or a user-friendly message otherwise
    if (text === "/start") {
      if (String(cid) === String(TELEGRAM_CHAT_ID)) {
        return sendAdminDashboard(cid);
      } else {
        return bot.sendMessage(cid, "Solana Hunter Bot is running. Contact the owner for access.");
      }
    }

    // /help
    if (text === "/help") {
      const help = [
        "*Commands*",
        "\\/adduser `name` \\- add user (admin)",
        "\\/removeuser `name` \\- remove user (admin)",
        "\\/listusers \\- list monitored users",
        "\\/addquery `query` \\- add hunter query (admin)",
        "\\/removequery `query` \\- remove a hunter query (admin)",
        "\\/listqueries \\- list queries",
        "\\/admin status \\- admin only"
      ].join("\n\n");
      return bot.sendMessage(cid, help, { parse_mode: "MarkdownV2" });
    }

    // Non-admin users stop here
    if (!isAdminChat(msg)) return;

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ").trim();

    // /listusers
    if (cmd === "/listusers") {
      const list = state.users.length ? state.users.map(u => "• " + escapeMD(u)).join("\n") : "_none_";
      return bot.sendMessage(cid, `*👥 Users Being Monitored:*\n${list}`, { parse_mode: "MarkdownV2" });
    }

    // /adduser
    if (cmd === "/adduser") {
      if (!arg) return bot.sendMessage(cid, escapeMD("Usage: /adduser <username>"));
      const u = arg.replace("@", "").trim();
      if (!state.users.includes(u)) { state.users.push(u); saveState(); }
      return bot.sendMessage(cid, escapeMD(`Added user ${u}`), { parse_mode: "MarkdownV2" });
    }

    // /removeuser
    if (cmd === "/removeuser") {
      if (!arg) return bot.sendMessage(cid, escapeMD("Usage: /removeuser <username>"));
      const u = arg.replace("@", "").trim();
      state.users = state.users.filter(x => x !== u);
      saveState();
      return bot.sendMessage(cid, escapeMD(`Removed user ${u}`), { parse_mode: "MarkdownV2" });
    }

    // /listqueries
    if (cmd === "/listqueries") {
      const list = state.queries.length ? state.queries.map(q => "• " + escapeMD(q)).join("\n") : "_none_";
      return bot.sendMessage(cid, `*🔍 Hunter Queries:*\n${list}`, { parse_mode: "MarkdownV2" });
    }

    // /addquery
    if (cmd === "/addquery") {
      if (!arg) return bot.sendMessage(cid, escapeMD("Usage: /addquery <query>"));
      if (!state.queries.includes(arg)) { state.queries.push(arg); saveState(); }
      return bot.sendMessage(cid, escapeMD("Added query"), { parse_mode: "MarkdownV2" });
    }

    // /removequery
    if (cmd === "/removequery") {
      if (!arg) return bot.sendMessage(cid, escapeMD("Usage: /removequery <query>"));
      state.queries = state.queries.filter(x => x !== arg);
      saveState();
      return bot.sendMessage(cid, escapeMD("Removed query"), { parse_mode: "MarkdownV2" });
    }

    // /admin status
    if (cmd === "/admin" && parts[1] === "status") {
      const info = {
        users: state.users.length,
        queries: state.queries.length,
        pumpfun: ENABLE_PUMPFUN,
        raydium: ENABLE_RAYDIUM,
        sent_cache: SENT_IDS.size || 0
      };
      return bot.sendMessage(cid, "```" + JSON.stringify(info, null, 2) + "```", { parse_mode: "MarkdownV2" });
    }

    // /admin heal
    if (cmd === "/admin" && parts[1] === "heal") {
      try {
        const r = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_BASE_URL + "/webhook")}`, { timeout: 10000 });
        return bot.sendMessage(cid, escapeMD("Webhook healed: " + JSON.stringify(r.data)), { parse_mode: "MarkdownV2" });
      } catch (e) {
        return bot.sendMessage(cid, escapeMD("Heal failed: " + e.message), { parse_mode: "MarkdownV2" });
      }
    }

  } catch (e) {
    throttledLog("message handler error:", e.message);
  }
});/******************************************************************************************
 *  SOLANA HUNTER BOT — PART 5 / 5
 *  Final startup loops, safe intervals, webhook heal, and EOF
 ******************************************************************************************/

// ---------------------------------------
// 22. SAFE INTERVAL WRAPPER
// ---------------------------------------
function safeInterval(fn, ms) {
  setInterval(() => {
    try { fn(); } catch (e) { throttledLog("interval runner error:", e.message); }
  }, ms);
}

// ---------------------------------------
// 23. WEBHOOK SELF-HEAL (EVERY 10 MIN)
// ---------------------------------------
async function healWebhook() {
  try {
    const info = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`);
    const current = info.data?.result?.url || "";
    const desired = WEBHOOK_BASE_URL + "/webhook";

    if (current !== desired) {
      throttledLog("⚠️ Webhook mismatch detected. Auto-fixing...");
      await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(desired)}`
      );
      throttledLog("Webhook healed.");
    }
  } catch (e) {
    throttledLog("healWebhook failed:", e.message);
  }
}

// ---------------------------------------
// 24. STARTUP SEQUENCE
// ---------------------------------------
async function startBot() {
  safeLog("🚀 Solana Hunter Bot Starting...");
  safeLog("PumpFun:", ENABLE_PUMPFUN ? "ON" : "OFF");
  safeLog("Raydium:", ENABLE_RAYDIUM ? "ON" : "OFF");

  try {
    await registerCommands();
  } catch (e) {
    throttledLog("registerCommands startup error:", e.message);
  }

  // Start PumpFun WS
  if (ENABLE_PUMPFUN) {
    try { startPumpFun(); } catch (e) { throttledLog("PumpFun start failed", e.message); }
  }

  // Initialize Raydium known mints (avoid false alerts)
  try {
    const url = "https://api.raydium.io/v2/sdk/liquidity/mainnet/pools";
    const r = await axiosFast.get(url);
    if (Array.isArray(r.data)) {
      for (const p of r.data) {
        const mint = p.lpMint || p.mint || p.mintA || p.mintB;
        if (mint) KNOWN_RAY_MINTS.add(mint);
      }
    }
  } catch (e) {
    throttledLog("initial Raydium scan failed", e.message);
  }

  // Start periodic loops
  safeInterval(scanUsers, POLL_INTERVAL_MS);
  safeInterval(runHunter, POLL_INTERVAL_MS);
  safeInterval(() => { if (ENABLE_RAYDIUM) checkRaydium(); }, 20000);
  safeInterval(backupState, 120000);   // backup every 2 minutes
  safeInterval(healWebhook, 600000);   // heal every 10 minutes

  safeLog("Bot started successfully.");
}

// ---------------------------------------
// 25. CRASH SAFETY
// ---------------------------------------
process.on("uncaughtException", e => {
  throttledLog("uncaughtException:", e.message);
});

process.on("unhandledRejection", e => {
  throttledLog("unhandledRejection:", e?.message || e);
});

// ---------------------------------------
// 26. START
// ---------------------------------------
startBot();
