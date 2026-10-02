// 한국 시장 지표 자동 수집 — 네이버 증권 + 금융투자협회(FreeSIS)
import { getJson } from "./_lib.js";

const NV = "https://m.stock.naver.com";
const num = (s) => Number(String(s ?? "").replace(/[^0-9.+-]/g, ""));
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

// 코스피 상장 보통주 시총(억원) 전체 — 시총순 100개씩
async function kospiStocks() {
  const first = await getJson(`${NV}/api/stocks/marketValue/KOSPI?page=1&pageSize=100`);
  const pages = Math.ceil(first.totalCount / 100);
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      getJson(`${NV}/api/stocks/marketValue/KOSPI?page=${i + 2}&pageSize=100`).catch(() => ({ stocks: [] }))
    )
  );
  return [first, ...rest].flatMap((p) => p.stocks).filter((s) => s.stockEndType === "stock");
}

// 시총 상위 종목의 PBR·추정PER로 시총 가중(조화) 평균 → 지수 PBR/선행 PER
async function valuation(stocks, top = 40) {
  const picks = stocks.slice(0, top);
  const infos = await Promise.all(
    picks.map((s) =>
      getJson(`${NV}/api/stock/${s.itemCode}/integration`)
        .then((j) => Object.fromEntries(j.totalInfos.map((x) => [x.code, num(x.value)])))
        .catch(() => null)
    )
  );
  let capB = 0, bookB = 0, capE = 0, earnE = 0;
  picks.forEach((s, i) => {
    const cap = num(s.marketValue), f = infos[i];
    if (!f) return;
    if (f.pbr > 0) { capB += cap; bookB += cap / f.pbr; }
    if (f.cnsPer > 0) { capE += cap; earnE += cap / f.cnsPer; }
  });
  if (!bookB || !earnE) throw new Error("PBR/PER 계산 실패");
  return { pbr: r2(capB / bookB), fper: r1(capE / earnE), coverage: r1((capB / stocks.reduce((a, s) => a + num(s.marketValue), 0)) * 100) };
}

async function investor3m() {
  const j = await getJson(`${NV}/front-api/market/investorTrend?marketType=KOSPI&periodType=THREE_MONTHLY`);
  const it = Object.fromEntries(j.result.items.map((x) => [x.investorType, x.netBuyAmount / 1e12]));
  return { foreign: r1(it.foreigner), inst: r1(it.organization), from: j.result.fromDate, to: j.result.toDate };
}

// 신용거래융자 잔고 (백만원) — 유가증권시장
async function creditBalance() {
  const end = new Date(), start = new Date(Date.now() - 20 * 864e5);
  const r = await fetch("https://freesis.kofia.or.kr/meta/getMetaDataList.do", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "User-Agent": "Mozilla/5.0", Referer: "https://freesis.kofia.or.kr/" },
    body: JSON.stringify({ dmSearch: { tmpV40: "1000000", tmpV41: "1", tmpV1: "D", tmpV45: ymd(start), tmpV46: ymd(end), OBJ_NM: "STATSCU0100000070BO" } }),
  });
  if (!r.ok) throw new Error(`FreeSIS HTTP ${r.status}`);
  const row = (await r.json()).ds1?.[0];
  if (!row) throw new Error("FreeSIS 빈 응답");
  const d = row.TMPV1;
  return { kospiMil: row.TMPV3, asOf: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` };
}

async function ipo30d() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  let n = 0;
  for (let page = 1; page <= 3; page++) {
    const j = await getJson(`${NV}/front-api/ipo/recent?gsrClass=G,S,R&page=${page}&pageSize=30`);
    const list = j.result.ipoList;
    n += list.filter((x) => x.lcalDate >= cutoff).length;
    if (!list.length || list[list.length - 1].lcalDate < cutoff) break;
  }
  return n;
}

const clamp = (x) => Math.max(0, Math.min(100, x));
function interp(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}
export const KR_SCORE = {
  pbr: (x) => clamp(interp(x, [[0.8, 10], [1.0, 35], [1.2, 55], [1.5, 75], [2.0, 92], [2.5, 100]])),
  fper: (x) => clamp(interp(x, [[6, 5], [8, 20], [10, 45], [12, 62], [14, 78], [17, 95]])),
  credit: (x) => clamp(interp(x, [[0.2, 10], [0.3, 20], [0.5, 40], [0.7, 58], [0.9, 75], [1.2, 95]])),
  foreign: (x) => clamp(interp(x, [[-20, 15], [-5, 35], [0, 45], [8, 65], [20, 85], [30, 95]])),
  samsung: (x) => clamp(interp(x, [[10, 20], [15, 35], [22, 55], [30, 75], [40, 95]])),
  turnover: (x) => clamp(interp(x, [[0.15, 10], [0.3, 30], [0.6, 55], [1.0, 80], [1.5, 100]])),
  inst: (x) => clamp(interp(x, [[-15, 85], [-5, 65], [0, 52], [5, 40], [15, 20]])),
  ipo: (x) => clamp(interp(x, [[0, 5], [2, 20], [5, 42], [10, 70], [15, 90]])),
};

// 함수 인스턴스가 살아 있는 동안 30분 캐시 (요청 50여 개라서)
let cache = null;
export async function buildKr() {
  if (cache && Date.now() - cache.at < 30 * 60e3) return cache.data;

  const errors = [];
  const safe = (p, label) => p.catch((e) => (errors.push(`${label}: ${e.message}`), null));
  const [stocks, kospiInfo, inv, credit, ipo] = await Promise.all([
    safe(kospiStocks(), "kospiStocks"),
    safe(getJson(`${NV}/api/index/KOSPI/integration`), "kospiInfo"),
    safe(investor3m(), "investor"),
    safe(creditBalance(), "credit"),
    safe(ipo30d(), "ipo"),
  ]);
  const val = stocks ? await safe(valuation(stocks), "valuation") : null;

  const now = new Date().toISOString();
  const metrics = {};
  const add = (id, label, unit, value, source, asOf = now, kind = "live", note) => {
    if (value == null || !Number.isFinite(value)) return;
    metrics[id] = { label, value, unit, asOf, source, kind, ...(note ? { note } : {}) };
  };

  if (stocks) {
    const capEok = stocks.reduce((a, s) => a + num(s.marketValue), 0); // 억원
    const sam = stocks.find((s) => s.itemCode === "005930");
    add("samsung", "삼성 비중", "%", sam ? r1((num(sam.marketValue) / capEok) * 100) : null, "네이버 증권 · 코스피 시총 합계");
    if (credit) add("credit", "신용/시총", "%", r2((credit.kospiMil / 100 / capEok) * 100), "금융투자협회 신용융자 ÷ 코스피 시총", credit.asOf, "live", "신용으로 산 돈이 시총의 몇 %인지");
    const tv = kospiInfo?.totalInfos?.find((x) => x.code === "accumulatedTradingValue");
    if (tv) add("turnover", "회전율", "%", r2((num(tv.value) / 100 / capEok) * 100), "네이버 증권 · 거래대금 ÷ 시총", now, "live", "하루 거래대금이 시총의 몇 %인지");
  }
  if (val) {
    add("pbr", "코스피 PBR", "배", val.pbr, `네이버 증권 · 시총 상위 40종목 가중 (시총의 ${val.coverage}%)`, now, "derived");
    add("fper", "코스피 선행 PER", "배", val.fper, `네이버 증권 · 추정 PER, 시총 상위 40종목 가중`, now, "derived");
  }
  if (inv) {
    const asOf = `${inv.to.slice(0, 4)}-${inv.to.slice(4, 6)}-${inv.to.slice(6)}`;
    add("foreign", "외국인 3개월 순매수", "조", inv.foreign, "네이버 증권 · 코스피 투자자별 3개월", asOf);
    add("inst", "기관 3개월 순매수", "조", inv.inst, "네이버 증권 · 코스피 투자자별 3개월", asOf);
  }
  add("ipo", "최근 30일 신규상장", "건", ipo, "네이버 증권 · 공모주 상장 일정");

  const M = metrics;
  const drv = (id, key, name, unit, weight) =>
    M[key] ? { id, name, unit, raw: M[key].value, score: r1(KR_SCORE[id](M[key].value)), weight } : null;
  const drivers = [
    drv("pbr", "pbr", "PBR", "배", 1),
    drv("fper", "fper", "선행 PER", "배", 0.9),
    drv("credit", "credit", "신용/시총", "%", 0.85),
    drv("foreign", "foreign", "외국인 3M", "조", 0.75),
    drv("samsung", "samsung", "삼성 비중", "%", 0.7),
    drv("turnover", "turnover", "회전율", "%", 0.6),
    drv("inst", "inst", "기관 3M 순매수", "조", 0.8),
    drv("ipo", "ipo", "IPO 30일", "건", 0.65),
  ].filter(Boolean);

  const data = { metrics, drivers, errors };
  if (drivers.length >= 6) cache = { at: Date.now(), data };
  return data;
}
