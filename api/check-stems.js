// api/check-stems.js — Poll Replicate for Demucs stem separation result
export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { predictionId } = req.query;
  if (!predictionId) return res.status(400).json({ error: 'predictionId is required' });

  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured' });

  try {
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` },
    });

    if (!pollRes.ok) {
      const errText = await pollRes.text();
      console.error('check-stems poll error:', errText);
      return res.status(500).json({ error: 'Failed to check prediction', details: errText });
    }

    const result = await pollRes.json();
    console.log('check-stems status:', result.status, '| id:', predictionId);

    if (result.status === 'succeeded') {
      const parsed = parseOutput(result.output);
      return res.status(200).json({ status: 'succeeded', ...parsed });
    }

    if (result.status === 'failed' || result.status === 'canceled') {
      return res.status(200).json({ status: 'failed', error: result.error || result.status });
    }

    // Still processing (starting / processing)
    return res.status(200).json({ status: 'processing' });

  } catch (err) {
    console.error('check-stems error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

function parseOutput(output) {
  if (!output) throw new Error('No output from Demucs');
  let vocalsUrl = null, instrumentalUrl = null, bassUrl = null, drumsUrl = null, otherUrl = null;

  if (Array.isArray(output)) {
    vocalsUrl       = output.find(u => typeof u === 'string' && u.includes('vocals') && !u.includes('no_vocals')) ?? null;
    instrumentalUrl = output.find(u => typeof u === 'string' && u.includes('no_vocals')) ?? null;
    if (!instrumentalUrl) instrumentalUrl = output.find(u => typeof u === 'string' && !u.includes('vocals')) ?? output[1] ?? output[0];
  } else if (typeof output === 'object') {
    vocalsUrl       = output.vocals    || null;
    instrumentalUrl = output.no_vocals || null;
    bassUrl         = output.bass      || null;
    drumsUrl        = output.drums     || null;
    otherUrl        = output.other     || null;
    if (!instrumentalUrl) instrumentalUrl = otherUrl || bassUrl || drumsUrl || null;
  }

  if (!instrumentalUrl) throw new Error('Could not find instrumental in output: ' + JSON.stringify(output));
  console.log('Stems parsed — vocals:', vocalsUrl ? 'YES' : 'NO', '| instrumental:', instrumentalUrl ? 'YES' : 'NO');

  return { vocalsUrl, instrumentalUrl, bassUrl: bassUrl||null, drumsUrl: drumsUrl||null, otherUrl: otherUrl||null };
}

