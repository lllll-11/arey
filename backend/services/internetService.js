const https = require('https');

function getJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} en ${url}`));
        }

        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`JSON invalido en ${url}: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout (${timeoutMs}ms) en ${url}`));
    });
  });
}

function pickDuckDuckGoItems(payload, limit = 4) {
  const out = [];

  if (payload?.AbstractText) {
    out.push({
      title: payload.Heading || 'Resumen',
      snippet: String(payload.AbstractText),
      url: payload.AbstractURL || '',
      source: 'duckduckgo',
    });
  }

  const related = Array.isArray(payload?.RelatedTopics) ? payload.RelatedTopics : [];
  for (const item of related) {
    if (out.length >= limit) break;

    if (item?.Text) {
      out.push({
        title: String(item.FirstURL || 'Relacionado').split('/').pop() || 'Relacionado',
        snippet: String(item.Text),
        url: item.FirstURL || '',
        source: 'duckduckgo',
      });
      continue;
    }

    const nested = Array.isArray(item?.Topics) ? item.Topics : [];
    for (const sub of nested) {
      if (out.length >= limit) break;
      if (!sub?.Text) continue;

      out.push({
        title: String(sub.FirstURL || 'Relacionado').split('/').pop() || 'Relacionado',
        snippet: String(sub.Text),
        url: sub.FirstURL || '',
        source: 'duckduckgo',
      });
    }
  }

  return out.slice(0, limit);
}

async function searchDuckDuckGo(query, limit = 4) {
  const q = encodeURIComponent(query);
  const url = `https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  const payload = await getJson(url);
  return pickDuckDuckGoItems(payload, limit);
}

async function searchWikipedia(query, limit = 2) {
  const q = encodeURIComponent(query);
  const searchUrl = `https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&utf8=1&srlimit=${Math.max(1, Math.min(5, limit))}`;
  const searchPayload = await getJson(searchUrl);
  const results = Array.isArray(searchPayload?.query?.search) ? searchPayload.query.search : [];

  return results.slice(0, limit).map((item) => ({
    title: item.title,
    snippet: String(item.snippet || '').replace(/<[^>]+>/g, ''),
    url: `https://es.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, '_'))}`,
    source: 'wikipedia',
  }));
}

async function gatherInternetContext(query, options = {}) {
  const maxResults = Math.max(1, Number(options.maxResults || 5));

  const [ddgItems, wikiItems] = await Promise.allSettled([
    searchDuckDuckGo(query, maxResults),
    searchWikipedia(query, 2),
  ]);

  const items = [];
  if (ddgItems.status === 'fulfilled') items.push(...ddgItems.value);
  if (wikiItems.status === 'fulfilled') items.push(...wikiItems.value);

  const normalized = [];
  const seen = new Set();
  for (const item of items) {
    const key = `${item.title}|${item.url}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(item);
    if (normalized.length >= maxResults) break;
  }

  const contextText = normalized.length
    ? normalized.map((item, idx) => {
      const snippet = String(item.snippet || '').replace(/\s+/g, ' ').trim();
      return `${idx + 1}. ${item.title}\nFuente: ${item.url || 'N/D'}\nExtracto: ${snippet}`;
    }).join('\n\n')
    : '';

  return {
    query,
    items: normalized,
    contextText,
  };
}

module.exports = {
  gatherInternetContext,
};
