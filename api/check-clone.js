// api/check-clone.js — Poll Replicate RVC voice conversion status (v85)
//
// v85: Simplified to only handle Replicate RVC polling
//   - REMOVED: Seed-VC / HuggingFace polling
//   - REMOVED: ElevenLabs (doesn't need polling — but also doesn't do singing)
//   - Only polls Replicate predictions by jobId
//
// Query params:
//   jobId     = Replicate prediction ID (required)
//   method    = 'replicate-rvc' (optional, for logging)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var jobId = req.query.jobId;
  var method = req.query.method || 'replicate-rvc';

  console.log('🔍 check-clone v85: jobId=' + jobId + ' method=' + method);

  if (!jobId) {
    return res.status(400).json({ error: 'Missing jobId parameter' });
  }

  var REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    return res.status(500).json({ error: 'REPLICATE_API_TOKEN not set' });
  }

  try {
    // Poll the Replicate prediction
    var pollRes = await fetch('https://api.replicate.com/v1/predictions/' + jobId, {
      headers: {
        'Authorization': 'Bearer ' + REPLICATE_API_TOKEN,
      },
    });

    if (!pollRes.ok) {
      var errText = await pollRes.text();
      console.error('❌ Replicate poll failed:', pollRes.status, errText);
      return res.status(200).json({
        status: 'processing',
        note: 'Could not reach Replicate — will retry',
      });
    }

    var prediction = await pollRes.json();
    console.log('   Prediction status:', prediction.status);

    // ── Succeeded ────────────────────────────────────────────────────────
    if (prediction.status === 'succeeded') {
      var outputUrl = null;

      if (typeof prediction.output === 'string') {
        outputUrl = prediction.output;
      } else if (Array.isArray(prediction.output) && prediction.output.length > 0) {
        outputUrl = prediction.output[0];
      } else if (prediction.output && prediction.output.url) {
        outputUrl = prediction.output.url;
      }

      console.log('✅ RVC voice conversion complete:', outputUrl);

      return res.status(200).json({
        status: 'succeeded',
        clonedAudioUrl: outputUrl,
        audioUrl: outputUrl,
        method: 'replicate-rvc',
        note: 'Voice cloned successfully via RVC!',
      });
    }

    // ── Failed ───────────────────────────────────────────────────────────
    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      console.error('❌ RVC prediction failed:', prediction.error);
      return res.status(200).json({
        status: 'failed',
        error: prediction.error || 'Voice conversion failed',
        method: 'replicate-rvc',
      });
    }

    // ── Still processing ─────────────────────────────────────────────────
    var logs = prediction.logs || '';
    var lastLog = logs.split('\n').filter(Boolean).slice(-1)[0] || 'Processing...';
    console.log('   Progress:', lastLog);

    return res.status(200).json({
      status: 'processing',
      progress: lastLog,
      method: 'replicate-rvc',
      note: 'Voice conversion in progress...',
    });

  } catch (err) {
    console.error('❌ check-clone error:', err);
    return res.status(200).json({
      status: 'processing',
      note: 'Error checking status — will retry: ' + err.message,
    });
  }
}
