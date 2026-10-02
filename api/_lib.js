// 공용 fetch 헬퍼 + 9/10 스냅샷 기반 예비값

const UA_SHORT = "Mozilla/5.0";
const UA_BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

export async function getJson(url, { headers = {}, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA_SHORT, Accept: "application/json", ...headers },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function getText(url, { headers = {}, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA_SHORT, ...headers }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// Yahoo chart API — query1이 막히면 query2로
export async function yahooChart(symbol, params) {
  const qs = new URLSearchParams(params).toString();
  let lastErr;
  for (const host of ["query1", "query2"]) {
    try {
      const j = await getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`);
      const res = j?.chart?.result?.[0];
      if (!res) throw new Error(`Yahoo 빈 응답 ${symbol}`);
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export const CNN_HEADERS = {
  "User-Agent": UA_BROWSER,
  Referer: "https://edition.cnn.com/",
  Origin: "https://edition.cnn.com",
};

// 실시간 소스가 죽었을 때 쓰는 마지막 저장값 (2026-09-10 스냅샷)
export const FALLBACK = {
  sp500: 7636.36, nasdaq: 26253.34, dow: 52380.66, vix: 16.46, dgs10: 4.84, bill3m: 3.81,
  dxy: 98.76, gold: 4456.6, wti: 96.49, btc: 78091.42, kospi: 6963.89, kosdaq: 821.72,
  fg: 39, ma200: 6.8, rsi: 47.5, coreCpi: 2.47, headlineCpi: 3.3, hy: 2.65,
};
export const FALLBACK_AS_OF = "2026-09-10T02:34:02.000Z";
