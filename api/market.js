import { getJson, getText, yahooChart, CNN_HEADERS, FALLBACK, FALLBACK_AS_OF } from "./_lib.js";
import { buildKr } from "./_kr.js";

const QUOTES = {
  sp500: ["S&P 500", "^GSPC", ""],
  nasdaq: ["나스닥", "^IXIC", ""],
  dow: ["다우", "^DJI", ""],
  vix: ["VIX", "^VIX", ""],
  dgs10: ["미국 10년 국채 이자", "^TNX", "%"],
  bill3m: ["미국 3개월 국채 이자", "^IRX", "%"],
  dxy: ["달러 지수", "DX-Y.NYB", ""],
  gold: ["금", "GC=F", "$"],
  wti: ["WTI", "CL=F", "$"],
  btc: ["비트코인", "BTC-USD", "$"],
};

// 실시간 소스가 죽었을 때만 쓰는 어림용 앵커
const ANCHOR = { date: "2026-09-01", sp500: 7636.36, buffett: 227.1, cape: 38.0 };

// 한국 지표 수집 실패 시 마지막 저장값
const KR_FALLBACK = [
  { id: "pbr", name: "PBR", unit: "배", raw: 1.1, score: 52, weight: 1 },
  { id: "fper", name: "선행 PER", unit: "배", raw: 10.5, score: 48.5, weight: 0.9 },
  { id: "credit", name: "신용/시총", unit: "%", raw: 0.7, score: 58, weight: 0.85 },
  { id: "foreign", name: "외국인 3M", unit: "조", raw: 8, score: 65.2, weight: 0.75 },
  { id: "samsung", name: "삼성 비중", unit: "%", raw: 22, score: 55, weight: 0.7 },
  { id: "turnover", name: "회전율", unit: "%", raw: 0.6, score: 55, weight: 0.6 },
  { id: "inst", name: "기관 3M 순매수", unit: "조", raw: -2, score: 58, weight: 0.8 },
  { id: "ipo", name: "IPO 30일", unit: "건", raw: 5, score: 42, weight: 0.65 },
];

import { r1, r2, clamp, interp, SCORE } from "./_score.js";
import { buildHistory } from "./_history.js";

function band(v) {
  if (v >= 80) return ["매우 높음 · 경고", "red"];
  if (v >= 62) return ["높음 · 주의", "orange"];
  if (v >= 40) return ["중립", "yellow"];
  return ["낮음 · 여유", "green"];
}

function composite(label, drivers, basis, basisNote) {
  const w = drivers.reduce((s, d) => s + d.weight, 0);
  const value = Math.round(drivers.reduce((s, d) => s + d.score * d.weight, 0) / w);
  const [text, tone] = band(value);
  return { label, value, text, tone, drivers, basis, basisNote };
}

async function quote(key) {
  const [label, sym, unit] = QUOTES[key];
  const res = await yahooChart(sym, { range: "1d", interval: "15m" });
  const m = res.meta;
  const price = m.regularMarketPrice;
  const prev = m.chartPreviousClose ?? m.previousClose;
  if (!Number.isFinite(price)) throw new Error(`가격 없음 ${sym}`);
  return {
    label, value: r2(price), unit,
    asOf: new Date(m.regularMarketTime * 1000).toISOString(),
    source: `Yahoo Finance · ${sym}`, kind: "live",
    changePct: prev ? r2((price / prev - 1) * 100) : null,
  };
}

async function naver(code, label) {
  const j = await getJson(`https://m.stock.naver.com/api/index/${code}/basic`);
  const num = (s) => Number(String(s).replace(/,/g, ""));
  const value = num(j.closePrice);
  if (!Number.isFinite(value)) throw new Error(`네이버 값 없음 ${code}`);
  return {
    label, value, unit: "", asOf: j.localTradedAt,
    source: `네이버 금융 · ${j.marketStatus === "OPEN" ? "실시간" : "종가"}`, kind: "live",
    changePct: num(j.fluctuationsRatio) * (j.compareToPreviousPrice?.name === "FALLING" ? -1 : 1),
  };
}

async function fearGreed() {
  const j = await getJson("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", { headers: CNN_HEADERS });
  const f = j.fear_and_greed;
  return {
    label: "Fear & Greed", value: Math.round(f.score), unit: "", asOf: f.timestamp,
    source: "CNN Business", kind: "live", note: f.rating,
    changePct: f.previous_close ? r2((f.score / f.previous_close - 1) * 100) : null,
  };
}

async function fredSeries(id, start) {
  const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`);
  return csv.trim().split("\n").slice(1)
    .map((l) => l.split(","))
    .map(([d, v]) => [d, Number(v)])
    .filter(([, v]) => Number.isFinite(v));
}

async function fredYoY(id, label) {
  const y = new Date().getUTCFullYear() - 2;
  const rows = await fredSeries(id, `${y}-01-01`);
  const [d, v] = rows[rows.length - 1];
  const prevD = `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  const prev = rows.find(([dd]) => dd === prevD);
  if (!prev) throw new Error(`FRED ${id} 1년 전 값 없음`);
  return {
    label, value: r2((v / prev[1] - 1) * 100), unit: "%", asOf: d,
    source: `FRED ${id} · 1년 전 같은 달과 비교`, kind: "monthly", note: "한 달에 한 번 발표",
  };
}

async function fredHy() {
  const d0 = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
  const rows = await fredSeries("BAMLH0A0HYM2", d0);
  const [d, v] = rows[rows.length - 1];
  return { label: "회사 빚 이자", value: v, unit: "%p", asOf: d, source: "FRED BAMLH0A0HYM2", kind: "live", note: "하루 한 번 갱신" };
}

// 버핏 지수 = 윌셔 5000 ÷ 미국 명목 GDP (FRED, 분기)
async function buffettLive() {
  const [w, gdpRows] = await Promise.all([
    yahooChart("^W5000", { range: "1d", interval: "15m" }),
    fredSeries("GDP", `${new Date().getUTCFullYear() - 2}-01-01`),
  ]);
  const [gd, gdp] = gdpRows[gdpRows.length - 1];
  const v = w.meta.regularMarketPrice;
  if (!Number.isFinite(v) || !gdp) throw new Error("W5000/GDP 없음");
  return { label: "버핏 지수", value: r1((v / gdp) * 100), unit: "%", asOf: new Date(w.meta.regularMarketTime * 1000).toISOString(), source: `윌셔 5000 ÷ GDP(${gd} 분기, FRED)`, kind: "derived", note: "주식 전체 값 ÷ 나라 전체 소득" };
}

// CAPE — multpl.com 월간 실러 PER
async function capeLive() {
  const html = await getText("https://www.multpl.com/shiller-pe", { headers: { "User-Agent": CNN_HEADERS["User-Agent"] } });
  const m = html.match(/id="current">[\s\S]*?<\/b>\s*([\d.]+)/);
  const v = m && Number(m[1]);
  if (!Number.isFinite(v) || v < 5 || v > 80) throw new Error("multpl 파싱 실패");
  return { label: "CAPE", value: r1(v), unit: "배", asOf: new Date().toISOString(), source: "multpl.com · 실러 PER", kind: "live", note: "지난 10년 평균 이익으로 잰 주가 수준" };
}

// S&P 2년 일봉 → 200일 평균 거리, RSI(14)
async function spxTechnicals() {
  const res = await yahooChart("^GSPC", { range: "2y", interval: "1d" });
  const closes = res.indicators.quote[0].close.filter((c) => Number.isFinite(c));
  const last = res.meta.regularMarketPrice ?? closes[closes.length - 1];
  if (closes.length < 220) throw new Error("S&P 일봉 부족");
  const sma = closes.slice(-200).reduce((s, c) => s + c, 0) / 200;
  let g = 0, l = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  g /= 14; l /= 14;
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * 13 + Math.max(d, 0)) / 14;
    l = (l * 13 + Math.max(-d, 0)) / 14;
  }
  const asOf = new Date(res.meta.regularMarketTime * 1000).toISOString();
  return {
    ma200: { label: "200일 평균과의 거리", value: r1((last / sma - 1) * 100), unit: "%", asOf, source: "S&P 500 종가 2년 계산", kind: "derived", note: "200일 평균보다 얼마나 위에 있는지" },
    rsi: { label: "RSI(14)", value: r1(100 - 100 / (1 + g / l)), unit: "", asOf, source: "S&P 500 종가 계산", kind: "derived", note: "최근 14일 기준" },
  };
}

function fallbackMetric(key, label, unit, err) {
  return { label, value: FALLBACK[key], unit, asOf: FALLBACK_AS_OF, source: "저장값 (실시간 연결 실패)", kind: "snapshot", note: String(err?.message ?? err).slice(0, 120) };
}

export async function buildMarket() {
  const errors = [];
  const metrics = {};
  const settle = async (key, label, unit, fn) => {
    try {
      metrics[key] = await fn();
    } catch (e) {
      errors.push(`${key}: ${e.message}`);
      metrics[key] = fallbackMetric(key, label, unit, e);
    }
  };

  let tech = null, kr = null, hist = null;
  await Promise.all([
    buildHistory().then((h) => (hist = h)).catch((e) => errors.push(`history: ${e.message}`)),
    settle("buffett", "버핏 지수", "%", buffettLive),
    settle("cape", "CAPE", "배", capeLive),
    buildKr().then((k) => (kr = k)).catch((e) => errors.push(`kr: ${e.message}`)),
    ...Object.entries(QUOTES).map(([k, [label, , unit]]) => settle(k, label, unit, () => quote(k))),
    settle("kospi", "코스피", "", () => naver("KOSPI", "코스피")),
    settle("kosdaq", "코스닥", "", () => naver("KOSDAQ", "코스닥")),
    settle("fg", "Fear & Greed", "", fearGreed),
    settle("coreCpi", "근원 물가 (1년 전 대비)", "%", () => fredYoY("CPILFESL", "근원 물가 (1년 전 대비)")),
    settle("headlineCpi", "물가 (1년 전 대비)", "%", () => fredYoY("CPIAUCSL", "물가 (1년 전 대비)")),
    settle("hy", "회사 빚 이자", "%p", fredHy),
    spxTechnicals().then((t) => (tech = t)).catch((e) => errors.push(`ma200/rsi: ${e.message}`)),
  ]);
  metrics.ma200 = tech?.ma200 ?? fallbackMetric("ma200", "200일 평균과의 거리", "%", "계산 실패");
  metrics.rsi = tech?.rsi ?? fallbackMetric("rsi", "RSI(14)", "", "계산 실패");

  const m = metrics;
  m.curve = { label: "금리 곡선", value: r2(m.dgs10.value - m.bill3m.value), unit: "%p", asOf: m.dgs10.asOf, source: "Yahoo ^TNX − ^IRX", kind: "derived" };
  const spRatio = m.sp500.value / ANCHOR.sp500;
  if (m.buffett.kind === "snapshot") m.buffett = { label: "버핏 지수", value: r1(ANCHOR.buffett * spRatio), unit: "%", asOf: m.sp500.asOf, source: `앵커 ${ANCHOR.date} × 지수 (실시간 실패)`, kind: "estimate" };
  if (m.cape.kind === "snapshot") m.cape = { label: "CAPE", value: r1(ANCHOR.cape * spRatio), unit: "배", asOf: m.sp500.asOf, source: `앵커 ${ANCHOR.date} × 지수 (실시간 실패)`, kind: "estimate" };
  if (kr) errors.push(...kr.errors.map((e) => `kr ${e}`));
  if (hist?.trendErrors?.length) errors.push(...hist.trendErrors.map((e) => `trend ${e}`));

  // 화면에 그리는 순서 유지
  const order = ["sp500", "nasdaq", "dow", "vix", "dgs10", "bill3m", "dxy", "gold", "wti", "btc", "kospi", "kosdaq", "fg", "curve", "ma200", "rsi", "buffett", "cape", "coreCpi", "headlineCpi", "hy"];
  const ordered = { ...Object.fromEntries(order.map((k) => [k, m[k]])), ...(kr?.metrics ?? {}) };

  const d = (id, name, unit, raw, score, weight) => ({ id, name, unit, raw, score: r1(score), weight });
  const usDrivers = [
    d("buffett", "버핏 지수", "%", m.buffett.value, SCORE.buffett(m.buffett.value), 1),
    d("shiller", "CAPE", "배", m.cape.value, SCORE.shiller(m.cape.value), 1),
    d("vix", "VIX (공포지수)", "", m.vix.value, SCORE.vixUs(m.vix.value), 0.7),
    d("fg", "Fear & Greed", "", m.fg.value, SCORE.fg(m.fg.value), 0.7),
    d("ma200", "200일 평균과의 거리", "%", m.ma200.value, SCORE.ma200(m.ma200.value), 0.8),
    d("rsi", "RSI(14)", "", m.rsi.value, SCORE.rsi(m.rsi.value), 0.6),
  ];
  const usLive = ["buffett", "cape", "vix", "fg", "ma200", "rsi"].filter((k) => !["snapshot", "estimate"].includes(m[k].kind)).length;
  const macroDrivers = [
    d("dgs10", "미국 10년 국채 이자", "%", m.dgs10.value, SCORE.dgs10(m.dgs10.value), 1),
    d("coreCpi", "Core CPI YoY", "%", m.coreCpi.value, SCORE.coreCpi(m.coreCpi.value), 1),
    d("hy", "회사 빚 이자", "%p", m.hy.value, SCORE.hy(m.hy.value), 0.8),
    d("curve", "금리 곡선", "%p", m.curve.value, SCORE.curve(m.curve.value), 0.7),
    d("vix", "VIX", "", m.vix.value, SCORE.vixMacro(m.vix.value), 0.6),
  ];

  const krComposite = kr?.drivers?.length >= 6
    ? composite("한국 주식은?", kr.drivers, "live", `자동 수집 ${kr.drivers.length}개 · 네이버 증권·금융투자협회`)
    : composite("한국 주식은?", KR_FALLBACK, "manual", "수집 실패 · 마지막 저장값");
  const macroComposite = composite("경제는 버틸까?", macroDrivers, "live", "이자·물가·돈줄·금리곡선·공포지수");
  const usComposite = composite("미국 주식, 비싼가?", usDrivers, "live", usLive === 6 ? "지표 6개 모두 자동 수집" : `지표 6개 · 자동 ${usLive} + 어림 ${6 - usLive}`);
  const liveKeys = [...Object.keys(QUOTES), "kospi", "kosdaq"];
  const liveCount = liveKeys.filter((k) => m[k].kind === "live").length;
  const dataAsOf = liveKeys.filter((k) => m[k].kind === "live").map((k) => m[k].asOf)
    .sort((a, b) => new Date(b) - new Date(a))[0] ?? FALLBACK_AS_OF;

  return {
    asOf: new Date().toISOString(),
    dataAsOf: new Date(dataAsOf).toISOString(),
    degraded: errors.length > 0,
    liveCount,
    liveTotal: liveKeys.length,
    errors,
    metrics: ordered,
    history: hist ? {
      us: hist.usHistory.map(({ d, v }, i, all) => ({ d, v: i === all.length - 1 ? usComposite.value : v })),
      trend: Object.fromEntries(Object.entries(hist.trend).map(([key, modes]) => {
        const cur = { us: [usComposite.value, m.sp500.value], kr: [null, m.kospi.value], macro: [macroComposite.value, null] }[key];
        return [key, Object.fromEntries(Object.entries(modes).map(([mode, arr]) => [mode, arr.map((p, i) => (i === arr.length - 1 && cur ? { ...p, ...(cur[0] != null ? { v: cur[0] } : {}), ...(cur[1] != null ? { spx: Math.round(cur[1]) } : {}) } : p))]))];
      })),
      assets: hist.assets ? Object.fromEntries(Object.entries(hist.assets).map(([k, a]) => [k, { label: a.label, ...Object.fromEntries(["weekly", "monthly", "yearly"].map((mode) => [mode, a[mode].map((p, i, arr) => (i === arr.length - 1 && m[k]?.kind === "live" ? { ...p, v: m[k].value } : p))])) }])) : null,
    } : null,
    series: hist ? { spxMonthly: hist.spxMonthly, nvda: hist.nvda } : null,
    scores: {
      us: usComposite,
      kr: krComposite,
      macro: macroComposite,
    },
  };
}

export default async function handler(req, res) {
  try {
    const data = await buildMarket();
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");
    res.status(200).json(data);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}
