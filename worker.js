// worker.js - HTML Stripper & Parser

const { parentPort } = require('worker_threads');
const RSSParser = require('rss-parser');

const parser = new RSSParser({
  timeout: 5000,
  customFields: { item: ['title', 'content', 'description', 'link', 'id', 'guid'] }
});

const BAD_WORDS = ['honeypot', 'scam', 'rug', 'steal', 'phish', 'fake_token', 'test_token'];

// CRITICAL FIX: Removes <span>, <div>, <br> tags
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>?/gm, '').trim();
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
        // Prioritize snippet, fallback to description, STRIP HTML
        const rawContent = item.contentSnippet || item.content || item.description || '';
        const cleanContent = stripHtml(rawContent).substring(0, 300);
        
        const combined = `${title} ${cleanContent}`;

        cleanItems.push({
          id: item.id || item.guid || item.link,
          link: item.link,
          title: title.substring(0, 100),
          snippet: cleanContent, // Sending Clean Text
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
