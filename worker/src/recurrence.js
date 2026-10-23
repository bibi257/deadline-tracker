// 繰り返しの日付計算（アプリの app.js の nextOccurrence と同じ規則）。
import { DAY, jstParts, fromJst, daysInMonth } from './time.js';

/**
 * base（ミリ秒）を n 回分進める。毎月・毎年は基準日 anchor を保ち、無い日は月末に丸める。
 * weekly / biweekly 以外は、毎月（monthly）でなければ毎年として扱う（build_feed.py と同じ）。
 */
export function addRep(base, rep, n, anchor) {
  if (rep === 'weekly') return base + 7 * n * DAY;
  if (rep === 'biweekly') return base + 14 * n * DAY;
  const months = rep === 'monthly' ? n : 12 * n;
  const p = jstParts(base);
  const m0 = p.mo - 1 + months;
  const y = p.y + Math.floor(m0 / 12);
  const m = (m0 % 12) + 1;
  const day = Math.min(anchor || p.d, daysInMonth(y, m));
  return fromJst(y, m, day, p.h, p.mi, p.s, p.ms);
}
