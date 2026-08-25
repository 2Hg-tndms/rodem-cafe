const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
// 한국 시간(KST) 기준 날짜 문자열(YYYY-MM-DD)
function kstDateStr(ts) {
  const d = new Date(ts + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
// ===== 운영시간 자동 개폐 =====
// 일요일 09:30~10:35, 13:00~13:40 (한국시간)
const KST_OFFSET = 9 * 60 * 60 * 1000;
const OPEN_WEEKDAY = 0; // 0=일요일
const OPEN_WINDOWS = [
  { start: 9 * 60 + 30, end: 10 * 60 + 35 },
  { start: 13 * 60, end: 13 * 60 + 40 }
];
// 한국시간 기준 요일/분 단위 시각
function kstParts(ts) {
  const d = new Date(ts + KST_OFFSET);
  return { day: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
// 지금이 운영시간인지 (스케줄 기준)
function scheduleOpen(ts) {
  const p = kstParts(ts);
  if (p.day !== OPEN_WEEKDAY) return false;
  return OPEN_WINDOWS.some(w => p.min >= w.start && p.min < w.end);
}
// 다음으로 상태가 바뀌는 시각 (수동 설정이 풀리는 시점)
function nextBoundary(ts) {
  const p = kstParts(ts);
  const marks = [];
  OPEN_WINDOWS.forEach(w => { marks.push(w.start); marks.push(w.end); });
  marks.push(24 * 60); // 자정
  const next = marks.filter(m => m > p.min).sort((a, b) => a - b)[0];
  return ts + (next - p.min) * 60 * 1000;
}
// 실제 오픈 여부: 수동 설정이 살아있으면 그것, 아니면 스케줄
async function computeOpenState() {
  const now = Date.now();
  const scheduled = scheduleOpen(now);
  let ov = await redis.get('cafe:override');
  if (typeof ov === 'string') {
    try { ov = JSON.parse(ov); } catch (_) { ov = null; }
  }
  if (ov && typeof ov.open === 'boolean' && ov.until && now < ov.until) {
    return { isOpen: ov.open, manual: true, until: ov.until, scheduled };
  }
  return { isOpen: scheduled, manual: false, until: nextBoundary(now), scheduled };
}
// 완료된 주문을 매출 원장에 기록 (날짜별 해시, 키=주문id)
async function addToSales(order) {
  const dateStr = order.saleDate || kstDateStr(order.completedAt || Date.now());
  const saleRecord = {
    id: order.id,
    number: order.number,
    items: order.items,
    total: order.total,
    cash: order.cash,
    coupon: order.coupon,
    createdAt: order.createdAt,
    completedAt: order.completedAt || Date.now(),
    saleDate: dateStr
  };
  await redis.hset('saleslog:' + dateStr, { [order.id]: JSON.stringify(saleRecord) });
  await redis.sadd('sales:dates', dateStr);
  return dateStr;
}
// 매출 원장에서 제거
async function removeFromSales(order) {
  const dateStr = order.saleDate;
  if (!dateStr) return;
  await redis.hdel('saleslog:' + dateStr, order.id);
  // 그 날짜에 남은 기록이 없으면 날짜 목록에서도 제거
  const remain = await redis.hlen('saleslog:' + dateStr);
  if (!remain || remain === 0) {
    await redis.srem('sales:dates', dateStr);
  }
}
module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const all = await redis.hgetall('orders');
      let orders = all ? Object.values(all).map(v => typeof v === 'string' ? JSON.parse(v) : v) : [];

      // 하루가 지난 "완료" 주문은 카운터 목록에서 자동으로 정리한다.
      // 매출 원장(saleslog:날짜)은 건드리지 않으므로 매출 기록은 그대로 남는다.
      const today = kstDateStr(Date.now());
      const staleIds = orders
        .filter(o => o.status === 'done' && kstDateStr(o.completedAt || o.createdAt) !== today)
        .map(o => o.id);
      if (staleIds.length > 0) {
        await redis.hdel('orders', ...staleIds);
        const staleSet = new Set(staleIds);
        orders = orders.filter(o => !staleSet.has(o.id));
      }

      orders.sort((a, b) => b.createdAt - a.createdAt);
      const state = await computeOpenState();
      return res.status(200).json({
        orders,
        isOpen: state.isOpen,
        manual: state.manual,
        until: state.until,
        scheduled: state.scheduled
      });
    }

    if (req.method === 'POST') {
      const body = req.body;

      // 주문번호 초기화 (오늘 카운터를 0으로)
      if (body && body.action === 'resetNumber') {
        const today = kstDateStr(Date.now());
        await redis.set('ordernum:' + today, 0);
        return res.status(200).json({ ok: true, date: today });
      }

      // 오픈/마감 수동 변경 (다음 운영시간 경계까지만 유지되고 이후 자동으로 복귀)
      if (body && body.action === 'setOpen') {
        const now = Date.now();
        const until = nextBoundary(now);
        const ttl = Math.max(60, Math.ceil((until - now) / 1000));
        await redis.set('cafe:override', JSON.stringify({ open: !!body.open, until }), { ex: ttl });
        return res.status(200).json({ ok: true, isOpen: !!body.open, manual: true, until });
      }

      // 수동 설정 해제 → 즉시 자동(스케줄)으로 복귀
      if (body && body.action === 'clearOverride') {
        await redis.del('cafe:override');
        const state = await computeOpenState();
        return res.status(200).json({ ok: true, isOpen: state.isOpen, manual: false, until: state.until });
      }

      if (!body || !body.name || !Array.isArray(body.items) || body.items.length === 0) {
        return res.status(400).json({ error: 'invalid order' });
      }
      // 마감 상태면 주문 거부 (고객 화면 우회 대비 서버에서도 차단)
      const state = await computeOpenState();
      if (!state.isOpen) {
        return res.status(403).json({ error: 'closed' });
      }
      const now = Date.now();
      const today = kstDateStr(now);
      // 날짜별 카운터를 1씩 증가 (원자적). 날짜가 바뀌면 키가 달라져 자동으로 1부터 시작.
      const n = await redis.incr('ordernum:' + today);
      // 카운터 키가 무한정 안 남도록 이틀 뒤 만료
      await redis.expire('ordernum:' + today, 60 * 60 * 48);

      const order = {
        id: uid(),
        number: n,
        name: body.name,
        bell: body.bell || body.name,
        items: body.items,
        total: body.total,
        cash: !!body.cash,
        coupon: !!body.coupon,
        status: 'pending',
        createdAt: now
      };
      // 주문 생성 시점에는 매출 기록 안 함 (완료 시 기록)
      await redis.hset('orders', { [order.id]: JSON.stringify(order) });
      return res.status(200).json({ order });
    }

    if (req.method === 'PUT') {
      const body = req.body;
      if (!body || !body.id) {
        return res.status(400).json({ error: 'missing id' });
      }
      const existingRaw = await redis.hget('orders', body.id);
      if (!existingRaw) {
        return res.status(404).json({ error: 'not found' });
      }
      const existing = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;

      // 메뉴 내용 수정 (items / total 교체)
      if (Array.isArray(body.items)) {
        existing.items = body.items;
        if (typeof body.total === 'number') existing.total = body.total;
        // 이미 완료되어 매출에 있으면 원장도 갱신
        if (existing.status === 'done' && existing.saleDate) {
          await addToSales(existing); // 같은 id로 덮어써짐
        }
      }

      // 상태 변경 (완료 처리 / 되돌리기)
      if (body.status && body.status !== existing.status) {
        if (body.status === 'done') {
          existing.status = 'done';
          existing.completedAt = Date.now();
          const dateStr = await addToSales(existing);
          existing.saleDate = dateStr;
        } else if (body.status === 'pending') {
          // 되돌리기: 매출에서 제거 (실수로 완료 처리한 경우를 되돌리는 용도)
          await removeFromSales(existing);
          existing.status = 'pending';
          delete existing.saleDate;
          delete existing.completedAt;
        } else {
          existing.status = body.status;
        }
      }

      await redis.hset('orders', { [body.id]: JSON.stringify(existing) });
      return res.status(200).json({ order: existing });
    }

    if (req.method === 'DELETE') {
      const body = req.body;
      if (!body || !body.id) {
        return res.status(400).json({ error: 'missing id' });
      }
      // 카운터 목록에서만 제거한다.
      // 완료 처리되어 매출 원장(saleslog:날짜)에 들어간 기록은 그대로 남긴다.
      // 매출에서 지우려면 매출 화면의 삭제 버튼(/api/sales DELETE)을 사용한다.
      await redis.hdel('orders', body.id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
