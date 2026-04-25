const https = require('https');

function callAnthropic(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { type, title, description } = JSON.parse(event.body || '{}');

    // ── Article sentiment + summary ──
    if (type === 'article') {
      if (!title) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing title' }) };

      const data = await callAnthropic({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system: `You analyze crypto news headlines. Respond ONLY with JSON, no markdown, no explanation.
Format: {"sentiment":"bullish"|"bearish"|"neutral","summary":"max 15 words summary"}`,
        messages: [{ role: 'user', content: `Headline: ${title}\nDescription: ${description || ''}` }]
      });

      const text = data.content?.[0]?.text || '';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return { statusCode: 200, headers, body: JSON.stringify(parsed) };
    }

    // ── Market summary ──
    if (type === 'market') {
      // First fetch real BTC price from CoinGecko
      let btcPrice = null;
      let fgValue = null;
      try {
        const cgData = await new Promise((resolve, reject) => {
          https.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true', {
            headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000
          }, (res) => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
          }).on('error', reject);
        });
        btcPrice = cgData?.bitcoin?.usd;
        const btcChange = cgData?.bitcoin?.usd_24h_change?.toFixed(1);
        const ethPrice = cgData?.ethereum?.usd;

        const aiData = await callAnthropic({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 100,
          system: 'You are a crypto market analyst. Write a 2-sentence market brief. Be direct, no disclaimers. Use simple language. Use the real price data provided.',
          messages: [{ role: 'user', content: `Current market data: BTC $${btcPrice?.toLocaleString()} (${btcChange}% 24h), ETH $${ethPrice?.toLocaleString()}. Write a brief 2-sentence market summary mentioning these real prices and whether meme coins seem active.` }]
        });
        const text = aiData.content?.[0]?.text || '';
        return { statusCode: 200, headers, body: JSON.stringify({ summary: text }) };
      } catch(e) {
        const data = await callAnthropic({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 80,
          system: 'You are a crypto market analyst. Write a neutral 2-sentence market brief. Do NOT mention specific prices since you lack real-time data. Focus on general sentiment.',
          messages: [{ role: 'user', content: 'Write a brief general crypto market sentiment summary without specific prices.' }]
        });
        const text = data.content?.[0]?.text || '';
        return { statusCode: 200, headers, body: JSON.stringify({ summary: text }) };
      }
    }

    // ── HHT Price from DexScreener ──
    if (type === 'hht-price') {
      const CA = '4KrNyA5FpFGQj4jQZh1yKzBkobq7mGVftWYVWjfwpump';
      try {
        const dexResult = await new Promise((resolve, reject) => {
          const req = https.get(`https://api.dexscreener.com/latest/dex/tokens/${CA}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json'
            },
            timeout: 10000
          }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });

        console.log('DexScreener status:', dexResult.statusCode);
        if (dexResult.statusCode !== 200) throw new Error(`DexScreener status ${dexResult.statusCode}`);

        const dexData = JSON.parse(dexResult.body);
        const pairs = dexData.pairs || [];
        console.log('Pairs found:', pairs.length);
        if (!pairs.length) return { statusCode: 200, headers, body: JSON.stringify({ error: 'no pairs' }) };

        const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        const price = parseFloat(pair.priceUsd || 0);
        const change = pair.priceChange?.h24 || 0;
        const mcap = pair.marketCap || pair.fdv || 0;
        const vol = pair.volume?.h24 || 0;
        const liq = pair.liquidity?.usd || 0;

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ price, change, mcap, vol, liq })
        };
      } catch(e) {
        console.error('HHT price error:', e.message);
        return { statusCode: 200, headers, body: JSON.stringify({ error: e.message }) };
      }
    }

    // ── Sentinel chat ──
    if (type === 'sentinel') {
      const { system, messages } = JSON.parse(event.body);
      if (!messages?.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing messages' }) };

      const data = await callAnthropic({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: system || '',
        messages: messages.slice(-10) // keep last 10 messages
      });

      const reply = data.content?.[0]?.text || "Something went wrong 🔧";
      return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid type' }) };

  } catch (e) {
    console.error('AI analyze error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
