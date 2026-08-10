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
      const orders = all ? Object.values(all).map(v => typeof v === 'string' ? JSON.parse(v) : v) : [];
      orders.sort((a, b) => b.createdAt - a.createdAt);
      return res.status(200).json({ orders });
    }

    if (req.method === 'POST') {
      const body = req.body;
      if (!body || !body.name || !Array.isArray(body.items) || body.items.length === 0) {
        return res.status(400).json({ error: 'invalid order' });
      }
      let n = 1;
      let claimed = false;
      while (!claimed) {
        const result = await redis.set('numlock:' + n, '1', { nx: true });
        if (result === 'OK') claimed = true;
        else n++;
      }
      const now = Date.now();
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
          // 되돌리기: 매출에서 제거
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
      const existingRaw = await redis.hget('orders', body.id);
      await redis.hdel('orders', body.id);
      if (existingRaw) {
        const existing = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
        if (typeof existing.number === 'number') {
          await redis.del('numlock:' + existing.number);
        }
        // 완료되어 매출에 있던 주문이면 매출에서도 제거
        if (existing.saleDate) {
          await removeFromSales(existing);
        }
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
