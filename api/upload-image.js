export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }

  const { siteId, apiToken, fileName, fileBase64, contentType } = body || {};

  if (!siteId) return res.status(400).json({ error: 'Missing siteId' });
  if (!apiToken) return res.status(400).json({ error: 'Missing apiToken' });
  if (!fileName) return res.status(400).json({ error: 'Missing fileName' });
  if (!fileBase64) return res.status(400).json({ error: 'Missing fileBase64' });

  try {
    // Step 1: Compute MD5 hash of the file for Webflow
    const fileBuffer = Buffer.from(fileBase64, 'base64');
    const crypto = await import('crypto');
    const fileHash = crypto.createHash('md5').update(fileBuffer).digest('hex');

    // Step 2: Request upload details from Webflow
    const initResp = await fetch(
      `https://api.webflow.com/v2/sites/${siteId}/assets`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ fileName, fileHash }),
      }
    );

    const initText = await initResp.text();
    let initData;
    try { initData = JSON.parse(initText); } catch { return res.status(initResp.status).json({ error: initText }); }

    if (!initResp.ok) {
      return res.status(initResp.status).json(initData);
    }

    const { uploadUrl, uploadDetails } = initData;
    if (!uploadUrl || !uploadDetails) {
      return res.status(500).json({ error: 'Webflow did not return upload URL', data: initData });
    }

    // Step 3: Upload file to S3 via multipart form
    const boundary = '----ShipItBoundary' + Date.now();
    const parts = [];

    // Add all uploadDetails fields first (order matters for S3)
    for (const [key, value] of Object.entries(uploadDetails)) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      );
    }

    // Add the file last
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(fileHeader, 'utf-8');
    const footerBuf = Buffer.from(fileFooter, 'utf-8');
    const partsBuf = Buffer.from(parts.join(''), 'utf-8');
    const fullBody = Buffer.concat([partsBuf, headerBuf, fileBuffer, footerBuf]);

    const s3Resp = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: fullBody,
    });

    // S3 returns 201 on success (or 204)
    if (!s3Resp.ok && s3Resp.status !== 201 && s3Resp.status !== 204) {
      const s3Text = await s3Resp.text();
      return res.status(s3Resp.status).json({ error: 'S3 upload failed', detail: s3Text });
    }

    // Step 4: Return the asset URL
    // Webflow CDN URL is based on the asset — fetch it to confirm
    const assetUrl = initData.hostedUrl || initData.url || initData.cdnUrl;

    // Also try fetching the asset to get its final URL
    if (initData.assetId || initData.id || initData._id) {
      const assetId = initData.assetId || initData.id || initData._id;
      const assetResp = await fetch(
        `https://api.webflow.com/v2/assets/${assetId}`,
        {
          headers: {
            Authorization: `Bearer ${apiToken}`,
            accept: 'application/json',
          },
        }
      );
      if (assetResp.ok) {
        const assetData = await assetResp.json();
        return res.status(200).json({
          url: assetData.hostedUrl || assetData.url || assetUrl,
          assetId,
        });
      }
    }

    return res.status(200).json({ url: assetUrl, raw: initData });
  } catch (e) {
    return res.status(500).json({ error: 'Proxy error: ' + e.message });
  }
}
