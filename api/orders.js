const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.STORAGE_KV_REST_API_URL,
  token: process.env.STORAGE_KV_REST_API_TOKEN,
});

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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

      const order = {
        id: uid(),
        number: n,
        name: body.name,
        items: body.items,
        total: body.total,
        status: 'pending',
        createdAt: Date.now()
      };
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
      existing.status = body.status;
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
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
