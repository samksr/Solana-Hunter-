const { parentPort } = require('worker_threads');
const RSSParser = require('rss-parser');

const parser = new RSSParser({ timeout: 10000 });
const BAD_WORDS = ['honeypot','scam','rug','steal','phish','fake','test','rugpull','exit','compromised'];

function cleanText(html) {
  if (!html) return '';
  let text = html
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
    .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/<[^>]*>/g,'');
  return text.replace(/\s+/g,' ').trim().substring(0,400);
}

function extractCA(text) {
  if (!text) return null;
  const match = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  return match ? match[0] : null;
}

function isSuspicious(text) {
  if (!text) return false;
  return BAD_WORDS.some(w => text.toLowerCase().includes(w));
}

parentPort.on('message', async (task) => {
  if (task.type === 'PARSE_RSS') {
    try {
      const feed = await parser.parseString(task.xml);
      const items = [];
      
      for (const item of (feed.items || [])) {
        try {
          const title = item.title || '';
          const content = item.contentSnippet || item.content || item.description || '';
          const cleanContent = cleanText(content);
          const cleanTitle = cleanText(title);
          const combined = `${cleanTitle} ${cleanContent}`;
          
          items.push({
            id: item.id || item.guid || item.link || `${Date.now()}_${Math.random()}`,
            link: item.link,
            title: cleanTitle,
            snippet: cleanContent,
            ca: extractCA(combined),
            suspicious: isSuspicious(combined),
            date: item.isoDate || new Date().toISOString()
          });
        } catch (itemErr) {
          continue;
        }
      }
      
      parentPort.postMessage({ id: task.id, success: true, data: items });
    } catch (e) {
      parentPort.postMessage({ id: task.id, success: false, error: e.message });
    }
  }
});

process.on('uncaughtException', (err) => {
  console.error('Worker exception:', err);
  parentPort.postMessage({ id: 'error', success: false, error: err.message });
});
