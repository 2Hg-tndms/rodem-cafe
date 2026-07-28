const { getStore } = require('@netlify/blobs');

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };
  const store = getStore('rodem-orders');

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
      const counterVal = await store.get('counter', { type: 'text' });
      const n = (counterVal ? parseInt(counterVal, 10) : 0) + 1;
      await store.set('counter', String(n));

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
      const existing = await store.get('order:' + body.id, { type: 'json' });
      if (!existing) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'not found' }) };
      }
      existing.status = body.status;
      await store.setJSON('order:' + body.id, existing);
      return { statusCode: 200, headers, body: JSON.stringify({ order: existing }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
