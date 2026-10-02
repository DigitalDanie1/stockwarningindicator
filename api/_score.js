// 점수 곡선 — market.js와 _history.js가 같이 씀
export const r2 = (x) => Math.round(x * 100) / 100;
export const r1 = (x) => Math.round(x * 10) / 10;
export const clamp = (x) => Math.max(0, Math.min(100, x));
// 구간 선형 보간 — 점은 x 오름차순
export function interp(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}

// 점수 곡선 — 9/9·9/10 두 스냅샷의 점수를 그대로 재현하도록 맞춘 것
export const SCORE = {
  buffett: (x) => clamp(interp(x, [[70, 0], [100, 30], [150, 70], [190, 88], [237.5, 100]])),
  shiller: (x) => clamp(interp(x, [[10, 0], [17, 25], [25, 60], [30, 80.2], [43.2, 100]])),
  vixUs: (x) => clamp(57.7 - 5.405 * (x - 16.46)),
  fg: (x) => clamp(x + 1.9),
  ma200: (x) => clamp(45 + 3 * x),
  rsi: (x) => clamp(41.8 + 1.4706 * (x - 47.5)),
  dgs10: (x) => clamp(79.6 + 36.67 * (x - 4.84)),
  coreCpi: (x) => clamp(44.1 + 30 * (x - 2.47)),
  hy: (x) => clamp(24.8 + 15 * (x - 2.65)),
  curve: (x) => clamp(31.6 - 30 * (x - 1.03)),
  vixMacro: (x) => clamp(30.8 + 3.92 * (x - 16.46)),
};


// 미국 점수 가중치 (화면 drivers 순서와 동일)
export const US_WEIGHTS = { buffett: 1, cape: 1, vix: 0.7, fg: 0.7, ma200: 0.8, rsi: 0.6 };
export function usScore(v) {
  const f = { buffett: SCORE.buffett, cape: SCORE.shiller, vix: SCORE.vixUs, fg: SCORE.fg, ma200: SCORE.ma200, rsi: SCORE.rsi };
  let w = 0, t = 0;
  for (const k in US_WEIGHTS) {
    if (!Number.isFinite(v[k])) continue;
    w += US_WEIGHTS[k]; t += f[k](v[k]) * US_WEIGHTS[k];
  }
  // 6개 중 4개 이상 있을 때만 점수로 인정
  return w >= 3.2 ? Math.round(t / w) : null;
}
