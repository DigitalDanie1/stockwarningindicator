import { yahooChart } from "./_lib.js";

const SERIES = { sp500: "^GSPC", nasdaq: "^IXIC", vix: "^VIX", us10y: "^TNX" };
const START = Date.UTC(2001, 9, 1) / 1000; // 2001-10

async function monthly(sym) {
  const res = await yahooChart(sym, { period1: START, period2: Math.floor(Date.now() / 1000), interval: "1mo" });
  const ts = res.timestamp, closes = res.indicators.quote[0].close;
  const byMonth = new Map();
  ts.forEach((t, i) => {
    const v = closes[i];
    if (!Number.isFinite(v)) return;
    byMonth.set(new Date(t * 1000).toISOString().slice(0, 7), Math.round(v * 100) / 100);
  });
  // 이번 달은 현재가로 덮어씀
  const now = res.meta.regularMarketPrice;
  if (Number.isFinite(now)) byMonth.set(new Date().toISOString().slice(0, 7), Math.round(now * 100) / 100);
  return [...byMonth].map(([d, v]) => ({ d, v }));
}

export default async function handler(req, res) {
  try {
    const entries = await Promise.all(Object.entries(SERIES).map(async ([k, s]) => [k, await monthly(s)]));
    const series = Object.fromEntries(entries);
    const months = series.sp500.map((p) => p.d);
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      range: { start: months[0], end: months[months.length - 1], frequency: "monthly close / month-end observation" },
      sources: Object.fromEntries(Object.entries(SERIES).map(([k, s]) => [k, `Yahoo Finance chart API, symbol ${s}, interval 1mo`])),
      series,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}
