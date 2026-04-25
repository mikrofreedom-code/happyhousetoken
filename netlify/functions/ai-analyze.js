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
      const data = await callAnthropic({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: 'You are a crypto market analyst. Write a 2-sentence market brief. Be direct, no disclaimers. Use simple language.',
        messages: [{ role: 'user', content: 'Give me a brief 2-sentence summary of current crypto market sentiment. Mention if meme coins are active.' }]
      });

      const text = data.content?.[0]?.text || '';
      return { statusCode: 200, headers, body: JSON.stringify({ summary: text }) };
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
