// TaxFolio – servidor de preços (Cloudflare Worker)
// Cole este código no editor do Worker e carregue em "Deploy".
// Rotas:  /quote?symbols=AAPL,SEC0.DE,IBZL.AS   /history?symbol=VWCE.DE&range=5y   /dividends?symbol=AAPL

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};
const VALID = s => /^[A-Za-z0-9.\-^=]{1,20}$/.test(s);

function json(data, status = 200, maxAge = 60) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` }
  });
}

async function yahoo(symbol, range, interval, events) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}${events ? '&events=' + events : ''}`;
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (TaxFolio)', 'Accept': 'application/json' }, cf: { cacheTtl: 60 } });
  if (!r.ok) return null;
  const j = await r.json();
  return (j && j.chart && j.chart.result && j.chart.result[0]) || null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (url.pathname === '/quote') {
        const symbols = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(VALID).slice(0, 50);
        const out = {};
        await Promise.all(symbols.map(async s => {
          try {
            const r = await yahoo(s, '5d', '1d');
            const m = r && r.meta;
            out[s] = m && m.regularMarketPrice != null ? {
              price: m.regularMarketPrice,
              currency: m.currency,
              time: m.regularMarketTime,
              prevClose: m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose,
              // fecho da sessão anterior (para a variação do dia)
              prev: (() => { const c = ((r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || []).filter(v => v != null);
                return c.length >= 2 ? c[c.length - 2] : (m.previousClose != null ? m.previousClose : null); })(),
              exchange: m.exchangeName,
              name: m.longName || m.shortName || ''
            } : null;
          } catch (e) { out[s] = null; }
        }));
        return json(out, 200, 60);
      }

      if (url.pathname === '/history') {
        const s = url.searchParams.get('symbol') || '';
        if (!VALID(s)) return json({ error: 'símbolo inválido' }, 400);
        const range = /^(1y|2y|5y|10y|max)$/.test(url.searchParams.get('range') || '') ? url.searchParams.get('range') : '5y';
        const r = await yahoo(s, range, '1wk');
        if (!r) return json(null, 404);
        const ts = r.timestamp || [], close = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
        const pts = ts.map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), close[i]]).filter(p => p[1] != null);
        return json({ currency: r.meta && r.meta.currency, pts }, 200, 3600);
      }

      if (url.pathname === '/dividends') {
        const s = url.searchParams.get('symbol') || '';
        if (!VALID(s)) return json({ error: 'símbolo inválido' }, 400);
        const r = await yahoo(s, '2y', '1mo', 'div');
        if (!r) return json(null, 404);
        const d = (r.events && r.events.dividends) || {};
        const list = Object.values(d).map(x => ({ date: new Date(x.date * 1000).toISOString().slice(0, 10), amount: x.amount })).sort((a, b) => a.date.localeCompare(b.date));
        return json({ currency: r.meta && r.meta.currency, dividends: list }, 200, 3600);
      }

      return json({ ok: true, service: 'TaxFolio preços' });
    } catch (e) {
      return json({ error: 'falha ao obter dados' }, 502, 0);
    }
  }
};
