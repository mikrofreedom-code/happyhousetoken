const https = require('https');
const http = require('http');

const FEEDS = [
  {
    name: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    count: 4
  },
  {
    name: 'Cointelegraph',
    url: 'https://cointelegraph.com/rss',
    count: 4
  },
  {
    name: 'Decrypt',
    url: 'https://decrypt.co/feed',
    count: 4
  }
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HHTNewsBot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      timeout: 8000
    }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function parseRSS(xml, sourceName, maxItems) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
    const itemXml = match[1];

    const getTag = (tag) => {
      const m = itemXml.match(new RegExp(`<${tag}(?:[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}(?:[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
      return m ? (m[1] || m[2] || '').trim() : '';
    };

    const title = getTag('title');
    const link = getTag('link') || itemXml.match(/<link>([^<]+)<\/link>/)?.[1] || '';
    const pubDate = getTag('pubDate');
    const description = getTag('description').replace(/<[^>]+>/g, '').substring(0, 160);

    // Extract image
    let image = '';
    const mediaMatch = itemXml.match(/url="([^"]+\.(jpg|jpeg|png|webp))"/i);
    const enclosureMatch = itemXml.match(/<enclosure[^>]+url="([^"]+)"[^>]*type="image/i);
    if (mediaMatch) image = mediaMatch[1];
    else if (enclosureMatch) image = enclosureMatch[1];

    if (title && link) {
      items.push({
        title,
        link: link.trim(),
        pubDate,
        description: description + (description.length >= 160 ? '...' : ''),
        image,
        source: sourceName
      });
    }
  }

  return items;
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300' // cache 5 minutes
  };

  try {
    const results = await Promise.allSettled(
      FEEDS.map(feed =>
        fetchUrl(feed.url)
          .then(xml => parseRSS(xml, feed.name, feed.count))
          .catch(() => [])
      )
    );

    const allNews = [];
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        allNews.push(...result.value);
      }
    });

    // Sort by date (newest first)
    allNews.sort((a, b) => {
      const dateA = new Date(a.pubDate || 0);
      const dateB = new Date(b.pubDate || 0);
      return dateB - dateA;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        count: allNews.length,
        lastUpdated: new Date().toISOString(),
        news: allNews
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message,
        news: []
      })
    };
  }
};
