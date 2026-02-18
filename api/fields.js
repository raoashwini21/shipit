export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }

  const { collectionId, apiToken } = body || {};
  if (!collectionId) return res.status(400).json({ error: 'Missing collectionId' });
  if (!apiToken) return res.status(400).json({ error: 'Missing apiToken' });

  try {
    const resp = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/fields`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          accept: 'application/json',
        },
      }
    );

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }

    return res.status(resp.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'Proxy error: ' + e.message });
  }
}
