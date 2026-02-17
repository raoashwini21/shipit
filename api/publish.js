export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { collectionId, apiToken, fieldData } = req.body;

  if (!collectionId || !apiToken || !fieldData) {
    return res.status(400).json({ error: 'Missing collectionId, apiToken, or fieldData' });
  }

  try {
    const resp = await fetch(
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

    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json(data);
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
