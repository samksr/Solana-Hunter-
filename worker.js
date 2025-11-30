// worker.js - The Heavy Lifter
// Handles parsing and filtering. Designed to fail fast if needed.

const { parentPort } = require('worker_threads');
const RSSParser = require('rss-parser');

const parser = new RSSParser({
  timeout: 5000, // RSS Parser timeout
  customFields: { item: ['title', 'content', 'link', 'id', 'guid'] }
});

// STRICT SCAM FILTER
const BAD_WORDS = ['honeypot', 'scam', 'rug', 'steal', 'phish', 'fake_token', 'test_token'];

function extractCA(text) {
  if (!text) return null;
  // Regex for Solana Addresses (Base58, 32-44 chars)
  const m = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  return m ? m[0] : null;
}

function isSuspicious(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return BAD_WORDS.some(w => lower.includes(w));
}

// Listen for jobs from index.js
parentPort.on('message', async (task) => {
  if (task.type === 'PARSE_RSS') {
    try {
      // Parse the raw XML string
      const feed = await parser.parseString(task.xml);
      const cleanItems = [];

      for (const item of (feed.items || [])) {
        const title = item.title || '';
        const content = item.content || item.contentSnippet || '';
        const combined = `${title} ${content}`;

        const ca = extractCA(combined);
        const suspicious = isSuspicious(combined);

        cleanItems.push({
          id: item.id || item.guid || item.link,
          link: item.link,
          title: title.substring(0, 100),
          snippet: content.substring(0, 300), // Trim for speed
          ca: ca,
          suspicious: suspicious,
          date: item.isoDate
        });
      }

      // Send processed data back
      parentPort.postMessage({ id: task.id, success: true, data: cleanItems });
    } catch (e) {
      parentPort.postMessage({ id: task.id, success: false, error: e.message });
    
}
  }
});
