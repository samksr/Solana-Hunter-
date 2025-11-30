// worker.js
const { parentPort } = require('worker_threads');
const RSSParser = require('rss-parser');
const parser = new RSSParser({ timeout: 5000 });
const BAD_WORDS = ['honeypot', 'scam', 'rug', 'steal', 'phish', 'fake_token', 'test_token'];

function extractCA(text) {
  if (!text) return null;
  // Regex: Base58, 32-44 chars, strictly alphanumeric (no spaces/symbols)
  const m = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  return m ? m[0] : null;
}

function isSuspicious(text) {
  if (!text) return false;
  return BAD_WORDS.some(w => text.toLowerCase().includes(w));
}

parentPort.on('message', async (task) => {
  if (task.type === 'PARSE_RSS') {
    try {
      const feed = await parser.parseString(task.xml);
      const cleanItems = [];
      for (const item of (feed.items || [])) {
        const title = item.title || '';
        const content = item.content || item.contentSnippet || '';
        const combined = `${title} ${content}`;
        cleanItems.push({
          id: item.id || item.guid || item.link,
          link: item.link,
          title: title.substring(0, 100),
          snippet: content.substring(0, 300),
          ca: extractCA(combined),
          suspicious: isSuspicious(combined),
          date: item.isoDate
        });
      }
      parentPort.postMessage({ id: task.id, success: true, data: cleanItems });
    } catch (e) {
      parentPort.postMessage({ id: task.id, success: false, error: e.message });
    }
  }
});
