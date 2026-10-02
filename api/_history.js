// 최근 12개월 미국 위험점수 + S&P 월봉 — 실제 과거값으로 다시 계산
import { getText, getJson, yahooChart, CNN_HEADERS } from "./_lib.js";
import { r1, SCORE, usScore } from "./_score.js";
import { KR_SCORE } from "./_kr.js";

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
export function lastAt(arr, ts) {
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

  // 같은 시점들로 경제·한국 점수와 자산 가격도 계산
  const ends = {
    weekly: weekly.map((p) => [p.d, p.d === now.toISOString().slice(0, 10) ? Date.now() : Date.parse(p.d + "T23:59:00Z")]),
    monthly: monthly.map((p, i) => [p.d, i === monthly.length - 1 ? Date.now() : Date.UTC(+p.d.slice(0, 4), +p.d.slice(5), 1) - 1]),
    yearly: yearly.map((p, i) => [p.d, i === yearly.length - 1 ? Date.now() : Date.UTC(+p.d + 1, 0, 1) - 1]),
  };
  const extra = await buildExtraTrends(ends, vixD).catch((e) => ({ error: e.message }));

  const us = monthly.slice(-13);
  const spxMonthly = [...spxM].filter(([d]) => d >= "2019-01").map(([d, v]) => ({ d, v: Math.round(v * 100) / 100 }));
  const nvda = nvM ? await nvdaSeries(nvM).catch(() => null) : null;
  const strip = (a) => a.map(({ d, v, spx }) => ({ d, v, spx }));
  const data = {
    usHistory: us, spxMonthly, nvda,
    trend: { us: { weekly: strip(weekly), monthly: strip(monthly), yearly: strip(yearly) }, ...(extra.scores ?? {}) },
    assets: extra.assets ?? null,
    trendErrors: extra.error ? [extra.error] : extra.errors ?? [],
  };
  cache = { at: Date.now(), data };
  return data;
}

// ───────── 경제·한국 점수, 위험자산 가격 추이 ─────────
const ASSETS = {
  sp500: ["S&P 500", "^GSPC"], nasdaq: ["나스닥", "^IXIC"], dow: ["다우", "^DJI"],
  kospi: ["코스피", "^KS11"], kosdaq: ["코스닥", "^KQ11"], btc: ["비트코인", "BTC-USD"],
  gold: ["금", "GC=F"], wti: ["WTI 원유", "CL=F"], dxy: ["달러 지수", "DX-Y.NYB"],
};

async function fredDaily(id, from) {
  const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${from}`, { timeout: 15000 });
  return csv.trim().split("\n").slice(1).map((l) => l.split(",")).map(([d, v]) => [Date.parse(d + "T00:00:00Z"), Number(v)]).filter(([, v]) => Number.isFinite(v));
}

async function kofia(objNm, from) {
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const r = await fetch("https://freesis.kofia.or.kr/meta/getMetaDataList.do", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "User-Agent": "Mozilla/5.0", Referer: "https://freesis.kofia.or.kr/" },
    body: JSON.stringify({ dmSearch: { tmpV40: "1000000", tmpV41: "1", tmpV1: "D", tmpV45: from, tmpV46: ymd(new Date()), OBJ_NM: objNm } }),
  });
  if (!r.ok) throw new Error(`FreeSIS ${objNm} ${r.status}`);
  const rows = (await r.json()).ds1 ?? [];
  return rows.map((x) => ({ ...x, ts: Date.UTC(+x.TMPV1.slice(0, 4), +x.TMPV1.slice(4, 6) - 1, +x.TMPV1.slice(6), 15) })).sort((a, b) => a.ts - b.ts);
}

async function ipoDates(fromIso) {
  const out = [];
  for (let page = 1; page <= 25; page++) {
    const j = await getJson(`https://m.stock.naver.com/front-api/ipo/recent?gsrClass=G,S,R&page=${page}&pageSize=30`);
    const list = j.result?.ipoList ?? [];
    for (const x of list) out.push(Date.parse(x.lcalDate + "T00:00:00Z"));
    if (!list.length || list[list.length - 1].lcalDate < fromIso) break;
  }
  return out.sort((a, b) => a - b);
}

// 시총 상위 40종목 장부가 합계(연도별) — PBR 과거값용
async function bookByYear() {
  const NV = "https://m.stock.naver.com";
  const first = await getJson(`${NV}/api/stocks/marketValue/KOSPI?page=1&pageSize=40`);
  const stocks = first.stocks.filter((s) => s.stockEndType === "stock");
  const num = (v) => Number(String(v ?? "").replace(/,/g, ""));
  const fins = await Promise.all(stocks.map((s) => getJson(`${NV}/api/stock/${s.itemCode}/finance/annual`).catch(() => null)));
  const book = {}; let capNow = 0, bookNow = 0;
  stocks.forEach((s, i) => {
    const f = fins[i]?.financeInfo; if (!f) return;
    const row = f.rowList.find((r) => r.title === "BPS"), pbrRow = f.rowList.find((r) => r.title === "PBR");
    const cap = num(s.marketValue) * 1e8, price = num(s.closePrice);
    if (!row || !price) return;
    const shares = cap / price;
    capNow += cap;
    for (const t of f.trTitleList) {
      if (t.isConsensus === "Y") continue;
      const bps = num(row.columns[t.key]?.value);
      if (bps > 0) book[t.key.slice(0, 4)] = (book[t.key.slice(0, 4)] ?? 0) + bps * shares;
    }
  });
  return { book, capNow };
}

const sumW = (parts) => {
  let w = 0, t = 0;
  for (const [score, weight] of parts) if (Number.isFinite(score)) { w += weight; t += score * weight; }
  return { v: w ? Math.round(t / w) : null, w };
};

async function buildExtraTrends(ends, vixD) {
  const errors = [];
  const safe = (p, label) => p.catch((e) => (errors.push(`${label}: ${e.message}`), null));
  const [assetD, tnx, irx, cpi, hy, kospi, credit, samsung, ipos, books] = await Promise.all([
    Promise.all(Object.entries(ASSETS).map(([k, [, sym]]) => safe(dailySeries(sym, 1999), k).then((d) => [k, d]))),
    safe(dailySeries("^TNX", 1999), "tnx"), safe(dailySeries("^IRX", 1999), "irx"),
    safe(fredDaily("CPILFESL", "1998-01-01"), "cpi"), safe(fredDaily("BAMLH0A0HYM2", "1999-01-01"), "hy"),
    safe(kofia("STATSCU0100000020BO", "20000101"), "kospiStats"), safe(kofia("STATSCU0100000070BO", "20000101"), "credit"),
    safe(dailySeries("005930.KS", 1999), "samsung"),
    safe(ipoDates(`${new Date().getUTCFullYear() - 6}-01-01`), "ipo"), safe(bookByYear(), "book"),
  ]);
  const D = Object.fromEntries(assetD);

  // 삼성 주식 수: 지금 시총 ÷ 지금 주가 (네이버)
  let samShares = null;
  try {
    const j = await getJson("https://m.stock.naver.com/api/stock/005930/integration");
    const v = (c) => Number(String(j.totalInfos.find((x) => x.code === c)?.value ?? "").replace(/[^0-9.]/g, ""));
    const capStr = j.totalInfos.find((x) => x.code === "marketValue")?.value ?? "";
    const jo = Number((capStr.match(/([\d,]+)조/) ?? [, "0"])[1].replace(/,/g, "")), eok = Number((capStr.match(/([\d,]+)억/) ?? [, "0"])[1].replace(/,/g, ""));
    samShares = ((jo * 1e4 + eok) * 1e8) / v("lastClosePrice");
  } catch (e) { errors.push(`samShares: ${e.message}`); }

  // 외국인 순매수 추정: 외국인 보유 시총 변화 − 가격 변동분
  const fNet = [0];
  if (kospi) for (let i = 1; i < kospi.length; i++) {
    const a = kospi[i - 1], b = kospi[i];
    fNet.push(fNet[i - 1] + (b.TMPV6 - a.TMPV6 - a.TMPV6 * (b.TMPV5 / a.TMPV5 - 1)));
  }
  const cpiYoY = cpi ? cpi.map(([t, v], i) => { const p = cpi.find(([tt]) => new Date(tt).getUTCFullYear() === new Date(t).getUTCFullYear() - 1 && new Date(tt).getUTCMonth() === new Date(t).getUTCMonth()); return p ? [t + 45 * 864e5, (v / p[1] - 1) * 100] : null; }).filter(Boolean) : null; // 발표 지연 반영(+45일)
  const val = (arr, end, maxAge = 10) => { if (!arr) return null; const i = lastAt(arr, end); return i >= 0 && end - arr[i][0] < maxAge * 864e5 ? arr[i][1] : null; };
  const kRows = kospi?.map((r) => [r.ts, r]); const cRows = credit?.map((r) => [r.ts, r]);

  const scores = { kr: {}, macro: {} }, assets = {};
  for (const [mode, list] of Object.entries(ends)) {
    scores.macro[mode] = list.map(([d, end]) => {
      const t = val(tnx, end), b = val(irx, end), vx = val(vixD, end), c = val(cpiYoY, end, 75), h = val(hy, end);
      const { v } = sumW([[t != null ? SCORE.dgs10(t) : NaN, 1], [c != null ? SCORE.coreCpi(c) : NaN, 1], [h != null ? SCORE.hy(h) : NaN, 0.8], [t != null && b != null ? SCORE.curve(t - b) : NaN, 0.7], [vx != null ? SCORE.vixMacro(vx) : NaN, 0.6]]);
      return { d, v };
    });
    scores.kr[mode] = list.map(([d, end]) => {
      const ki = kRows ? lastAt(kRows, end) : -1;
      if (ki < 0 || end - kRows[ki][0] > 10 * 864e5) return { d, v: null, spx: null };
      const k = kRows[ki][1], capW = k.TMPV5 * 1e6; // 원
      const parts = [];
      const cr = cRows ? val(cRows.map(([t, r]) => [t, r.TMPV3]), end) : null;
      if (cr != null) parts.push([KR_SCORE.credit((cr * 1e6) / capW * 100), 0.85]);
      // 3개월(63거래일) 외국인 순매수 추정, 조 원
      if (ki >= 63) parts.push([KR_SCORE.foreign((fNet[ki] - fNet[ki - 63]) / 1e6), 0.75]);
      const sp = val(samsung, end);
      if (sp != null && samShares) parts.push([KR_SCORE.samsung((sp * samShares) / capW * 100), 0.7]);
      parts.push([KR_SCORE.turnover((k.TMPV4 / k.TMPV5) * 100), 0.6]);
      if (ipos && end >= ipos[0] + 30 * 864e5) parts.push([KR_SCORE.ipo(ipos.filter((t) => t <= end && t > end - 30 * 864e5).length), 0.65]);
      if (books) {
        const y = new Date(end).getUTCFullYear() - 1, bk = books.book[String(y)];
        if (bk) parts.push([KR_SCORE.pbr((capW * (books.capNow / (kospi[kospi.length - 1].TMPV5 * 1e6))) / bk), 1]);
      }
      const { v, w } = sumW(parts);
      return { d, v: w >= 2 ? v : null, spx: Math.round(k.TMPV2) };
    });
    for (const [k, [label]] of Object.entries(ASSETS)) {
      assets[k] ??= { label };
      assets[k][mode] = list.map(([d, end]) => { const x = D[k] ? val(D[k], end, 7) : null; return { d, v: x != null ? Math.round(x * 100) / 100 : null }; });
    }
  }
  return { scores, assets, errors };
}
