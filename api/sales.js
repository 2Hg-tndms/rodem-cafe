const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const dates = (await redis.smembers('sales:dates')) || [];
      dates.sort();

      const salesByDate = {};
      for (const d of dates) {
        const h = await redis.hgetall('saleslog:' + d);
        const list = h ? Object.values(h).map(v => typeof v === 'string' ? JSON.parse(v) : v) : [];
        list.sort((a, b) => (a.completedAt || a.createdAt || 0) - (b.completedAt || b.createdAt || 0));
        salesByDate[d] = list;
      }

      const costRaw = await redis.get('menu:costs');
      const costs = costRaw ? (typeof costRaw === 'string' ? JSON.parse(costRaw) : costRaw) : {};

      return res.status(200).json({ dates, salesByDate, costs });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      // 원가 저장
      if (body.action === 'cost') {
        if (!body.costs || typeof body.costs !== 'object') {
          return res.status(400).json({ error: 'invalid costs' });
        }
        await redis.set('menu:costs', JSON.stringify(body.costs));
        return res.status(200).json({ ok: true, costs: body.costs });
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    // 매출 내역 개별 주문 수정 (메뉴/금액 교체)
    if (req.method === 'PUT') {
      const body = req.body || {};
      if (!body.saleDate || !body.id) {
        return res.status(400).json({ error: 'missing saleDate or id' });
      }
      const raw = await redis.hget('saleslog:' + body.saleDate, body.id);
      if (!raw) return res.status(404).json({ error: 'not found' });
      const rec = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(body.items)) rec.items = body.items;
      if (typeof body.total === 'number') rec.total = body.total;
      await redis.hset('saleslog:' + body.saleDate, { [body.id]: JSON.stringify(rec) });

      // 진행중 주문(orders)에도 같은 id가 남아있으면 함께 갱신
      try {
        const oraw = await redis.hget('orders', body.id);
        if (oraw) {
          const o = typeof oraw === 'string' ? JSON.parse(oraw) : oraw;
          if (Array.isArray(body.items)) o.items = body.items;
          if (typeof body.total === 'number') o.total = body.total;
          await redis.hset('orders', { [body.id]: JSON.stringify(o) });
        }
      } catch (_) {}

      return res.status(200).json({ ok: true, record: rec });
    }

    // 매출 내역 개별 주문 삭제
    if (req.method === 'DELETE') {
      const body = req.body || {};
      if (!body.saleDate || !body.id) {
        return res.status(400).json({ error: 'missing saleDate or id' });
      }
      await redis.hdel('saleslog:' + body.saleDate, body.id);
      const remain = await redis.hlen('saleslog:' + body.saleDate);
      if (!remain || remain === 0) {
        await redis.srem('sales:dates', body.saleDate);
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
