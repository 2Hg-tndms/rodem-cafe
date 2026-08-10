const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      // 판매가 있었던 날짜 목록
      const dates = (await redis.smembers('sales:dates')) || [];
      dates.sort(); // 오래된 날짜부터

      // 각 날짜의 판매 기록을 모두 읽어옴
      const salesByDate = {};
      for (const d of dates) {
        const rawList = (await redis.lrange('sales:' + d, 0, -1)) || [];
        salesByDate[d] = rawList.map(v => typeof v === 'string' ? JSON.parse(v) : v);
      }

      // 저장된 메뉴별 원가
      const costRaw = await redis.get('menu:costs');
      const costs = costRaw ? (typeof costRaw === 'string' ? JSON.parse(costRaw) : costRaw) : {};

      return res.status(200).json({ dates, salesByDate, costs });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.action === 'cost') {
        // 메뉴별 원가 저장: { costs: { 아메리카노: 500, ... } }
        if (!body.costs || typeof body.costs !== 'object') {
          return res.status(400).json({ error: 'invalid costs' });
        }
        await redis.set('menu:costs', JSON.stringify(body.costs));
        return res.status(200).json({ ok: true, costs: body.costs });
      }
      return res.status(400).json({ error: 'unknown action' });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
