// api/check-training.js — Poll Replicate RVC training status (v85)
//
// v85 REWRITE:
//   - REMOVED: ElevenLabs voice status check
//   - NOW: Polls Replicate prediction for RVC model training
//
// GET /api/check-training?predictionId=xxx
//
// Returns:
//   { status: 'training', progress: '...' }
//   { status: 'ready', modelUrl: 'https://...' }
//   { status: 'error', message: '...' }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Support both parameter names for backwards compatibility
  var predictionId = req.query.predictionId || req.query.voice_id || null;

  if (!predictionId) {
    return res.status(400).json({ error: 'predictionId required' });
  }

  var REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    return res.status(500).json({ error: 'REPLICATE_API_TOKEN not set' });
  }

  try {
    console.log('check-training v85: polling prediction', predictionId);

    var pollRes = await fetch('https://api.replicate.com/v1/predictions/' + predictionId, {
      headers: {
        'Authorization': 'Bearer ' + REPLICATE_API_TOKEN,
      },
    });

    if (!pollRes.ok) {
      var errText = await pollRes.text();
      console.error('Replicate poll failed:', pollRes.status, errText);
      return res.status(200).json({
        status: 'training',
        progress: 'Checking training status...',
      });
    }

    var prediction = await pollRes.json();
    console.log('  Prediction status:', prediction.status);

    // ── Succeeded ─────────────────────────────────────────────────────
    if (prediction.status === 'succeeded') {
      // RVC training output is a URL to the trained model zip
      var modelUrl = null;

      if (typeof prediction.output === 'string') {
        modelUrl = prediction.output;
      } else if (Array.isArray(prediction.output) && prediction.output.length > 0) {
        modelUrl = prediction.output[0];
      } else if (prediction.output && prediction.output.url) {
        modelUrl = prediction.output.url;
      }

      console.log('✅ RVC training complete! Model URL:', modelUrl);

      return res.status(200).json({
        status: 'ready',
        modelUrl: modelUrl,
        predictionId: predictionId,
      });
    }

    // ── Failed ────────────────────────────────────────────────────────
    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      console.error('❌ RVC training failed:', prediction.error);
      return res.status(200).json({
        status: 'error',
        message: prediction.error || 'Voice model training failed',
      });
    }

    // ── Still training ────────────────────────────────────────────────
    var logs = prediction.logs || '';
    var lastLog = logs.split('\n').filter(Boolean).slice(-1)[0] || 'Training in progress...';
    console.log('  Progress:', lastLog);

    return res.status(200).json({
      status: 'training',
      progress: lastLog,
      predictionId: predictionId,
    });

  } catch (error) {
    console.error('check-training error:', error.message);
    return res.status(200).json({
      status: 'training',
      progress: 'Checking status...',
    });
  }
}
