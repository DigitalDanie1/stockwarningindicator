// 최근 12개월 미국 위험점수 + S&P 월봉 — 실제 과거값으로 다시 계산
import { getText, getJson, yahooChart, CNN_HEADERS } from "./_lib.js";
import { r1, usScore } from "./_score.js";

const ym = (t) => new Date(t).toISOString().slice(0, 7);

async function monthlyCloses(sym, range = "5y") {
  const res = await yahooChart(sym, { range, interval: "1mo" });
  const map = new Map();
  res.timestamp.forEach((t, i) => {
    const v = res.indicators.quote[0].close[i];
    if (Number.isFinite(v)) map.set(ym(t * 1000), v);
  });
  if (Number.isFinite(res.meta.regularMarketPrice)) map.set(ym(Date.now()), res.meta.regularMarketPrice);
  return map;
}

async function capeByMonth() {
  const html = await getText("https://www.multpl.com/shiller-pe/table/by-month", { headers: { "User-Agent": CNN_HEADERS["User-Agent"] } });
  const map = new Map();
  for (const m of html.matchAll(/<td>([A-Z][a-z]{2} \d{1,2}, \d{4})<\/td>\s*<td>(?:\s|&#x?[0-9a-fA-F]+;)*([\d.]+)\s*<\/td>/g)) {
    const d = new Date(m[1] + " UTC");
    if (!isNaN(d)) map.set(ym(d), Number(m[2]));
  }
  return map;
}

async function gdpQuarterly() {
  const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=GDP&cosd=${new Date().getUTCFullYear() - 3}-01-01`);
  return csv.trim().split("\n").slice(1).map((l) => l.split(",")).map(([d, v]) => [d, Number(v)]).filter(([, v]) => Number.isFinite(v));
}

async function fgDaily() {
  const j = await getJson("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", { headers: CNN_HEADERS });
  return j.fear_and_greed_historical.data.map((p) => [p.x, p.y]);
}

function technicalsAt(closes, idx) {
  if (idx < 200) return {};
  const win = closes.slice(idx - 199, idx + 1);
  const sma = win.reduce((a, c) => a + c, 0) / 200;
  let g = 0, l = 0;
  for (let i = 1; i <= 14; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? (g += d) : (l -= d); }
  g /= 14; l /= 14;
  for (let i = 15; i <= idx; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14;
  }
  return { ma200: r1((closes[idx] / sma - 1) * 100), rsi: r1(100 - 100 / (1 + g / l)) };
}

let cache = null;
export async function buildHistory() {
  if (cache && Date.now() - cache.at < 60 * 60e3) return cache.data;
  const safe = (p) => p.catch(() => null);
  const [spxM, vixM, wM, daily, cape, gdp, fg] = await Promise.all([
    monthlyCloses("^GSPC", "10y"), safe(monthlyCloses("^VIX")), safe(monthlyCloses("^W5000")),
    yahooChart("^GSPC", { range: "2y", interval: "1d" }), safe(capeByMonth()), safe(gdpQuarterly()), safe(fgDaily()),
  ]);

  const ts = daily.timestamp, closesRaw = daily.indicators.quote[0].close;
  const days = ts.map((t, i) => [t * 1000, closesRaw[i]]).filter(([, c]) => Number.isFinite(c));
  const closes = days.map(([, c]) => c);

  // 지난 12개월 말일 + 이번 달(현재)
  const now = new Date();
  const months = Array.from({ length: 13 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12 + i, 1));
    return d.toISOString().slice(0, 7);
  });

  const us = months.map((m) => {
    const [y, mo] = m.split("-").map(Number);
    const end = Date.UTC(y, mo, 1) - 1; // 그 달 마지막 순간
    let idx = -1;
    for (let i = days.length - 1; i >= 0; i--) if (days[i][0] <= end) { idx = i; break; }
    const v = { ...technicalsAt(closes, idx) };
    v.vix = vixM?.get(m);
    v.cape = cape?.get(m);
    const g = gdp?.filter(([d]) => Date.parse(d) <= end).pop();
    const w = wM?.get(m);
    if (g && Number.isFinite(w)) v.buffett = r1((w / g[1]) * 100);
    const f = fg?.filter(([t]) => t <= end).pop();
    if (f && Math.min(end, Date.now()) - f[0] < 10 * 864e5) v.fg = Math.round(f[1]);
    return { d: m, v: usScore(v), inputs: v };
  });

  const spxMonthly = [...spxM].filter(([d]) => d >= "2019-01").map(([d, v]) => ({ d, v: Math.round(v * 100) / 100 }));
  const data = { usHistory: us, spxMonthly };
  cache = { at: Date.now(), data };
  return data;
}
