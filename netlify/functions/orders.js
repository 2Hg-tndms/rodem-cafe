const { getStore, connectLambda } = require('@netlify/blobs');

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

exports.handler = async (event) => {
  connectLambda(event);
  const headers = { 'Content-Type': 'application/json' };
  const store = getStore('rodem-orders', { consistency: 'strong' });

  try {
    if (event.httpMethod === 'GET') {
      const { blobs } = await store.list({ prefix: 'order:' });
      const orders = [];
      for (const b of blobs) {
        const val = await store.get(b.key, { type: 'json' });
        if (val) orders.push(val);
      }
      orders.sort((a, b) => b.createdAt - a.createdAt);
      return { statusCode: 200, headers, body: JSON.stringify({ orders }) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.name || !Array.isArray(body.items) || body.items.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid order' }) };
      }

      let n = 1;
      let claimed = false;
      while (!claimed) {
        const result = await store.setJSON('numlock:' + n, { claimedAt: Date.now() }, { onlyIfNew: true });
        if (result.modified) {
          claimed = true;
        } else {
          n++;
        }
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
      await store.setJSON('order:' + order.id, order);
      return { statusCode: 200, headers, body: JSON.stringify({ order }) };
    }

    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing id' }) };
      }
      const existing = await store.get('order:' + body.id, { t
