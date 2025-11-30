// worker.js - HTML Decoder & Parser

const { parentPort } = require('worker_threads');
const RSSParser = require('rss-parser');

const parser = new RSSParser({
  timeout: 5000,
  customFields: { item: ['title', 'content', 'description', 'link', 'id', 'guid'] }
});

const BAD_WORDS = ['honeypot', 'scam', 'rug', 'steal', 'phish', 'fake_token', 'test_token'];

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
    .replace(/&nbsp;/g, ' ');

  // 2. Strip Tags
  text = text.replace(/<[^>]*>?/gm, '');
  
  // 3. Clean whitespace
  return text.replace(/\s+/g, ' ').trim();
}

function extractCA(text) {
  if (!text) return null;
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
        // Combine all possible content fields
        const rawContent = item.contentSnippet || item.content || item.description || '';
        
        // CLEAN THE TEXT
        const cleanContent = cleanText(rawContent).substring(0, 350);
        const cleanTitle = cleanText(title).substring(0, 100);
        
        const combined = `${cleanTitle} ${cleanContent}`;

        cleanItems.push({
          id: item.id || item.guid || item.link,
          link: item.link,
          title: cleanTitle,
          snippet: cleanContent,
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
