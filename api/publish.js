export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body is empty or not an object' });
  }

  const { collectionId, apiToken, fieldData } = body;

  if (!collectionId) return res.status(400).json({ error: 'Missing collectionId' });
  if (!apiToken) return res.status(400).json({ error: 'Missing apiToken' });
  if (!fieldData) return res.status(400).json({ error: 'Missing fieldData' });

  try {
    const webflowResp = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          isArchived: false,
          isDraft: true,
          fieldData,
        }),
      }
    );

    const text = await webflowResp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }

    return res.status(webflowResp.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'Proxy error: ' + e.message });
  }
}
