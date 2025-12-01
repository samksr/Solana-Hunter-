// worker.js - HTML Decoder & Parser (IMPROVED)
// ✅ Better CA extraction, error handling, logging

const { parentPort } = require('worker_threads');
const RSSParser = require('rss-parser');

const parser = new RSSParser({
  timeout: 8000, // Increased from 5s
  customFields: { item: ['title', 'content', 'description', 'link', 'id', 'guid'] }
});

const BAD_WORDS = ['honeypot', 'scam', 'rug', 'steal', 'phish', 'fake_token', 'test_token', 'rugpull', 'exit scam'];

// ✅ IMPROVED: Better Solana address validation (Base58 check)
function isValidSolanaAddress(addr) {
  if (!addr || addr.length < 32 || addr.length > 44) return false;
  // Base58 alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

// FIX: Decodes &lt; into <, then strips tags
function cleanText(html) {
  if (!html) return '';
  
  // 1. Decode Entities
  let text = html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x[0-9A-Fa-f]+;/g, ''); // Remove hex entities
  
  // 2. Strip Tags
  text = text.replace(/<[^>]*>?/gm, '');
  
  // 3. Clean whitespace
  return text.replace(/s+/g, ' ').trim();
}

// ✅ IMPROVED: Better CA extraction with multiple patterns
function extractCA(text) {
  if (!text) return null;
  
  // Pattern 1: Standard Solana address (32-44 chars, Base58)
  let m = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (m && isValidSolanaAddress(m[0])) return m[0];
  
  // Pattern 2: Preceded by "CA:" or "Contract:"
  m = text.match(/(?:CA|Contract):s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (m && isValidSolanaAddress(m[1])) return m[1];
  
  // Pattern 3: Surrounded by code blocks or backticks
  m = text.match(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/);
  if (m && isValidSolanaAddress(m[1])) return m[1];
  
  return null;
}

function isSuspicious(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return BAD_WORDS.some(w => lower.includes(w));
}

// ✅ IMPROVED: Better error logging
parentPort.on('message', async (task) => {
  if (task.type === 'PARSE_RSS') {
    try {
      const feed = await parser.parseString(task.xml);
      const cleanItems = [];

      for (const item of (feed.items || [])) {
        try {
          const title = item.title || '';
          const rawContent = item.contentSnippet || item.content || item.description || '';
          
          const cleanContent = cleanText(rawContent).substring(0, 350);
          const cleanTitle = cleanText(title).substring(0, 100);
          
          const combined = `${cleanTitle} ${cleanContent}`;
          const ca = extractCA(combined);

          // ✅ Only add if content exists
          if (cleanContent.length > 10) {
            cleanItems.push({
              id: item.id || item.guid || item.link,
              link: item.link,
              title: cleanTitle,
              snippet: cleanContent,
              ca: ca,
              suspicious: isSuspicious(combined),
              date: item.isoDate
            });
          }
        } catch (itemErr) {
          // Skip bad items, don't crash worker
          console.error(`Worker: Item parse error: ${itemErr.message}`);
        }
      }

      parentPort.postMessage({ id: task.id, success: true, data: cleanItems });
    } catch (e) {
      parentPort.postMessage({ id: task.id, success: false, error: e.message });
    }
  }
});

// ✅ IMPROVED: Graceful error handling on exit
process.on('uncaughtException', (err) => {
  console.error('Worker uncaught exception:', err);
});
