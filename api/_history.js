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

async function gdpQuarterly(from = new Date().getUTCFullYear() - 3) {
  const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=GDP&cosd=${from}-01-01`);
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

// 엔비디아 주가 vs 순이익 (2020년 = 100). 이익은 1월 결산 회계연도 → 그 전 해 달력연도로 표시
const NV_NI_FIXED = { 2020: 4332, 2021: 9752, 2022: 4368 }; // FY2021~FY2023 10-K, 백만 달러
async function nvdaSeries(nvM) {
  const H = { "User-Agent": CNN_HEADERS["User-Agent"] };
  const [ann, qtr] = await Promise.all([
    getJson("https://api.stock.naver.com/stock/NVDA.O/finance/annual", { headers: H }),
    getJson("https://api.stock.naver.com/stock/NVDA.O/finance/quarter", { headers: H }),
  ]);
  const ni = (d) => d.rowList.find((r) => r.title === "당기순이익").columns;
  const num = (v) => Number(String(v).replace(/,/g, ""));
  const byYear = { ...NV_NI_FIXED };
  for (const [k, v] of Object.entries(ni(ann))) byYear[Number(k.slice(0, 4)) - 1] = num(v.value);
  const qs = Object.entries(ni(qtr)).sort(([a], [b]) => a.localeCompare(b)).slice(-4);
  const ttm = qs.length === 4 ? qs.reduce((a, [, v]) => a + num(v.value), 0) : null;
  const years = Object.keys(byYear).map(Number).sort();
  const p0 = nvM.get("2020-12"), e0 = byYear[2020];
  const price = years.map((y) => nvM.get(`${y}-12`)).map((v) => (v ? Math.round((v / p0) * 100) : null));
  const earnings = years.map((y) => Math.round((byYear[y] / e0) * 100));
  const now = [...nvM.values()].pop();
  return {
    years: [...years.map(String), "현재"],
    price: [...price, Math.round((now / p0) * 100)],
    earnings: [...earnings, ttm ? Math.round((ttm / e0) * 100) : null],
  };
}

// 정렬된 [ts, v] 배열에서 ts 이하 마지막 값
function lastAt(arr, ts) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m][0] <= ts) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
async function dailySeries(sym, fromYear) {
  const res = await yahooChart(sym, { period1: Math.floor(Date.UTC(fromYear, 0, 1) / 1000), period2: Math.floor(Date.now() / 1000), interval: "1d" });
  const q = res.indicators.quote[0].close;
  const out = res.timestamp.map((t, i) => [t * 1000, q[i]]).filter(([, v]) => Number.isFinite(v));
  const p = res.meta.regularMarketPrice;
  if (Number.isFinite(p)) out.push([Math.max(Date.now(), out[out.length - 1][0] + 1), p]);
  return out;
}

let cache = null;
export async function buildHistory() {
  if (cache && Date.now() - cache.at < 60 * 60e3) return cache.data;
  const safe = (p) => p.catch(() => null);
  const [spxD, vixD, wD, cape, gdpAll, fg, nvM, spxM] = await Promise.all([
    dailySeries("^GSPC", 1998), safe(dailySeries("^VIX", 1999)), safe(dailySeries("^W5000", 2000)),
    safe(capeByMonth()), safe(gdpQuarterly(1998)), safe(fgDaily()), safe(monthlyCloses("NVDA", "10y")), monthlyCloses("^GSPC", "10y"),
  ]);
  const closes = spxD.map(([, v]) => v);
  // RSI(14) 누적 계산 — 인덱스별로 저장
  const rsiArr = new Array(closes.length).fill(null);
  { let g = 0, l = 0;
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (i <= 14) { d > 0 ? (g += d) : (l -= d); if (i === 14) { g /= 14; l /= 14; rsiArr[i] = 100 - 100 / (1 + g / l); } }
      else { g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; rsiArr[i] = 100 - 100 / (1 + g / l); }
    } }
  const pre = [0]; for (const c of closes) pre.push(pre[pre.length - 1] + c);

  const at = (end) => {
    const idx = lastAt(spxD, end);
    const v = {};
    if (idx >= 199) v.ma200 = r1((closes[idx] / ((pre[idx + 1] - pre[idx - 199]) / 200) - 1) * 100);
    if (rsiArr[idx] != null) v.rsi = r1(rsiArr[idx]);
    const vi = vixD ? lastAt(vixD, end) : -1; if (vi >= 0) v.vix = vixD[vi][1];
    const mk = ym(Math.min(end, Date.now()));
    v.cape = cape?.get(mk) ?? cape?.get(ym(Date.UTC(+mk.slice(0, 4), +mk.slice(5) - 2, 1)));
    const wi = wD ? lastAt(wD, end) : -1;
    const g = gdpAll?.filter(([d]) => Date.parse(d) <= end).pop();
    if (wi >= 0 && g && end - wD[wi][0] < 10 * 864e5) v.buffett = r1((wD[wi][1] / g[1]) * 100);
    const f = fg?.filter(([t]) => t <= end).pop();
    if (f && Math.min(end, Date.now()) - f[0] < 10 * 864e5) v.fg = Math.round(f[1]);
    return { v: usScore(v), spx: idx >= 0 ? Math.round(closes[idx]) : null, inputs: v };
  };

  const now = new Date(), Y = now.getUTCFullYear(), M = now.getUTCMonth();
  const pt = (d, end) => ({ d, ...at(end) });
  // 주간: 최근 52주 금요일 마감 + 지금
  const lastFri = new Date(Date.UTC(Y, M, now.getUTCDate() - ((now.getUTCDay() + 2) % 7), 23, 59));
  const weekly = Array.from({ length: 52 }, (_, i) => {
    const e = new Date(lastFri.getTime() - (51 - i) * 7 * 864e5);
    return pt(e.toISOString().slice(0, 10), e.getTime());
  });
  // 월간: 최근 60개월 말 + 이번 달
  const monthly = Array.from({ length: 61 }, (_, i) => {
    const d = new Date(Date.UTC(Y, M - 60 + i, 1));
    return pt(d.toISOString().slice(0, 7), Math.min(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1, Date.now()));
  });
  // 연간: 2000년부터 연말 + 올해(현재)
  const yearly = Array.from({ length: Y - 2000 + 1 }, (_, i) => pt(String(2000 + i), Math.min(Date.UTC(2001 + i, 0, 1) - 1, Date.now())));
  if (weekly[weekly.length - 1].d < now.toISOString().slice(0, 10)) weekly.push(pt(now.toISOString().slice(0, 10), Date.now()));

  const us = monthly.slice(-13);
  const spxMonthly = [...spxM].filter(([d]) => d >= "2019-01").map(([d, v]) => ({ d, v: Math.round(v * 100) / 100 }));
  const nvda = nvM ? await nvdaSeries(nvM).catch(() => null) : null;
  const strip = (a) => a.map(({ d, v, spx }) => ({ d, v, spx }));
  const data = { usHistory: us, spxMonthly, nvda, trend: { weekly: strip(weekly), monthly: strip(monthly), yearly: strip(yearly) } };
  cache = { at: Date.now(), data };
  return data;
}
