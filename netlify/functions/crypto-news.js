const https = require('https');

// ── CryptoCompare free news API — no key needed for basic use
const CRYPTOCOMPARE_URL = 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest';

// ── RSS feeds as fallback
const FEEDS = [
  { name: 'CryptoNews',    url: 'https://cryptonews.com/news/feed/',   count: 4 },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss',       count: 4 },
  { name: 'Decrypt',       url: 'https://decrypt.co/feed',             count: 4 }
];

// Source label mapping from CryptoCompare
const SOURCE_MAP = {
  'cointelegraph': 'Cointelegraph',
  'decrypt':       'Decrypt',
  'cryptonews':   'CryptoNews',
  'coindesk':     'CoinDesk',
  'theblock':     'The Block',
  'bitcoinmagazine': 'Bitcoin Magazine',
  'beincrypto':   'BeInCrypto',
  'ambcrypto':    'AMBCrypto',
  'u.today':      'U.Today',
  'cryptoslate':  'CryptoSlate',
};

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── PRIMARY: CryptoCompare API ──
async function fetchFromCryptoCompare() {
  const { statusCode, body } = await fetchUrl(CRYPTOCOMPARE_URL);
  if (statusCode !== 200) throw new Error(`CC status ${statusCode}`);

  const data = JSON.parse(body);
  if (data.Response !== 'Success' || !data.Data) throw new Error('CC bad response');

  return data.Data.slice(0, 12).map(item => {
    const sourceKey = (item.source || '').toLowerCase();
    const sourceName = SOURCE_MAP[sourceKey] || item.source_info?.name || item.source || 'Crypto News';

    return {
      title:       item.title || '',
      link:        item.url || item.guid || '',
      pubDate:     new Date(item.published_on * 1000).toISOString(),
      description: (item.body || '').replace(/<[^>]+>/g, '').substring(0, 160) + '...',
      image:       item.imageurl || '',
      source:      sourceName
    };
  }).filter(i => i.title && i.link);
}

// ── FALLBACK: RSS parsing ──
function parseRSS(xml, sourceName, maxItems) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
    const itemXml = match[1];

    const getTag = (tag) => {
      const m = itemXml.match(new RegExp(
        `<${tag}(?:[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}(?:[^>]*)?>([\\s\\S]*?)<\\/${tag}>`
      ));
      return m ? (m[1] || m[2] || '').trim() : '';
    };

    const title       = getTag('title');
    const link        = getTag('link') || itemXml.match(/<link>([^<]+)<\/link>/)?.[1] || '';
    const pubDate     = getTag('pubDate');
    const description = getTag('description').replace(/<[^>]+>/g, '').substring(0, 160);

    let image = '';
    const mediaMatch     = itemXml.match(/url="([^"]+\.(jpg|jpeg|png|webp))"/i);
    const enclosureMatch = itemXml.match(/<enclosure[^>]+url="([^"]+)"[^>]*type="image/i);
    if (mediaMatch)     image = mediaMatch[1];
    else if (enclosureMatch) image = enclosureMatch[1];

    if (title && link) {
      items.push({
        title,
        link:        link.trim(),
        pubDate,
        description: description + (description.length >= 160 ? '...' : ''),
        image,
        source:      sourceName
      });
    }
  }
  return items;
}

async function fetchFromRSS() {
  const results = await Promise.allSettled(
    FEEDS.map(feed =>
      fetchUrl(feed.url)
        .then(({ body }) => parseRSS(body, feed.name, feed.count))
        .catch(() => [])
    )
  );

  const allNews = [];
  results.forEach(r => { if (r.status === 'fulfilled') allNews.push(...r.value); });
  return allNews;
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300'
  };

  try {
    let news = [];
    let source = 'cryptocompare';

    // Try CryptoCompare first
    try {
      news = await fetchFromCryptoCompare();
      console.log(`CryptoCompare: ${news.length} articles`);
    } catch(e) {
      console.warn('CryptoCompare failed, trying RSS:', e.message);
      source = 'rss';
      news = await fetchFromRSS();
      console.log(`RSS fallback: ${news.length} articles`);
    }

    // Sort by date
    news.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        count:       news.length,
        source,
        lastUpdated: new Date().toISOString(),
        news
      })
    };

  } catch (error) {
    console.error('Handler error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: error.message, news: [] })
    };
  }
};
