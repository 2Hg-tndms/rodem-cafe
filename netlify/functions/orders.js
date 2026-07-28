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

      // 빈 번호를 하나씩 "선점"하면서 찾기 (동시에 들어와도 절대 겹치지 않음)
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
      const existing = await store.get('order:' + body.id, { type: 'json' });
      if (!existing) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'not found' }) };
      }
      existing.status = body.status;
      await store.setJSON('order:' + body.id, existing);
      return { statusCode: 200, headers, body: JSON.stringify({ order: existing }) };
    }

    if (event.httpMethod === 'DELETE') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing id' }) };
      }
      const existing = await store.get('order:' + body.id, { type: 'json' });
      await store.delete('order:' + body.id);
      if (existing && typeof existing.number === 'number') {
        await store.delete('numlock:' + existing.number);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};      const order = {
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

    if (event.httpMethod === 'DELETE') {
      const body = JSON.parse(event.body || '{}');
      if (!body.id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing id' }) };
      }
      await store.delete('order:' + body.id);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
