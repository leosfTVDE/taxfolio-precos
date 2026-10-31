// TaxFolio – servidor de preços (Cloudflare Worker)
// Cole este código no editor do Worker e carregue em "Deploy".
// Rotas:  /quote?symbols=AAPL,SEC0.DE,IBZL.AS   /history?symbol=VWCE.DE&range=5y   /dividends?symbol=AAPL   /inflation?geo=PT   /bce

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


// Inflação oficial (Eurostat, IHPC mensal, ECOICOP ver.2): devolve [["AAAA-MM-15", índice], ...]
function parseHicp(j) {
  if (!j || !j.id || !j.dimension || !j.value) return [];
  const ids = j.id, size = j.size, dim = j.dimension;
  const asMap = idx => Array.isArray(idx) ? Object.fromEntries(idx.map((c, i) => [c, i])) : idx;
  const units = asMap(dim.unit.category.index), times = asMap(dim.time.category.index);
  const unit = ['I25', 'I15', 'I05'].find(u => u in units) || Object.keys(units).find(u => /^I\d\d$/.test(u));
  if (!unit) return [];
  const strides = []; let s = 1;
  for (let k = ids.length - 1; k >= 0; k--) { strides[k] = s; s *= size[k]; }
  const out = [];
  for (const [t, ti] of Object.entries(times)) {
    let flat = 0;
    ids.forEach((d, k) => { flat += (d === 'time' ? ti : d === 'unit' ? units[unit] : 0) * strides[k]; });
    const v = j.value[flat] ?? j.value[String(flat)];
    const m = String(t).match(/^(\d{4})-?M?(\d{2})$/);
    if (v != null && m) out.push([`${m[1]}-${m[2]}-15`, v]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (url.pathname === '/inflation') {
        const geo = (url.searchParams.get('geo') || 'PT').toUpperCase();
        if (!/^[A-Z0-9_]{2,12}$/.test(geo)) return json({ error: 'País inválido' }, 400);
        const src = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_minr?format=JSON&lang=EN&geo=${geo}&coicop18=TOTAL&sinceTimePeriod=2015-01`;
        const r = await fetch(src, { headers: { Accept: 'application/json' }, cf: { cacheTtl: 43200, cacheEverything: true } });
        if (!r.ok) return json({ error: 'Eurostat ' + r.status }, 502);
        const pts = parseHicp(await r.json());
        if (!pts.length) return json({ error: 'Sem dados para ' + geo }, 404);
        return json({ geo, source: 'Eurostat (prc_hicp_minr)', last: pts[pts.length - 1][0].slice(0, 7), pts }, 200, 43200);
      }
      if (url.pathname === '/bce') {
        // Taxa de depósito do BCE (dados oficiais do BCE) e câmbio oficial euro/dólar
        const start = new Date(Date.now() - 800 * 864e5).toISOString().slice(0, 10), out = {};
        const opt = { headers: { Accept: 'application/json' }, cf: { cacheTtl: 21600, cacheEverything: true } };
        try {
          const r = await fetch(`https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV?startPeriod=${start}&format=jsondata&detail=dataonly`, opt);
          if (r.ok) {
            const j = await r.json(), ser = Object.values(j.dataSets[0].series)[0].observations;
            const dates = j.structure.dimensions.observation[0].values.map(v => v.id);
            const obs = Object.entries(ser).map(([k, v]) => [dates[+k], v[0]]).filter(x => x[0] && x[1] != null).sort((a, b) => a[0].localeCompare(b[0]));
            if (obs.length) { const last = obs[obs.length - 1]; let since = last[0]; for (let i = obs.length - 1; i >= 0 && obs[i][1] === last[1]; i--) since = obs[i][0]; out.dfr = { rate: last[1], since, date: last[0] }; }
          }
        } catch (e) {}
        for (const u of ['https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD', 'https://api.frankfurter.app/latest?from=EUR&to=USD']) {
          try { const r = await fetch(u, { cf: { cacheTtl: 3600, cacheEverything: true } }); if (r.ok) { const j = await r.json(); if (j.rates && j.rates.USD) { out.fx = { usd: j.rates.USD, date: j.date }; break; } } } catch (e) {}
        }
        return json(out, 200, 3600);
      }
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
