// api/clone-voice.js — Voice cloning via Replicate RVC (v85)
//
// v85 REWRITE (2026-03-25):
//   - REMOVED: ElevenLabs Speech-to-Speech — ElevenLabs confirmed they do NOT support singing
//   - REMOVED: Seed-VC (HuggingFace) — unreliable, cold starts, timeouts
//   - PRIMARY: Replicate RVC (zsxkib/realistic-voice-cloning) — built for singing voice conversion
//
// Pipeline:
//   1. Frontend sends: songUrl (isolated vocals from Demucs), trained RVC model URL
//   2. This handler sends vocals + model to Replicate RVC
//   3. RVC converts the AI singer's voice → user's cloned voice
//   4. Returns the cloned audio URL
//
// Keys needed: REPLICATE_API_TOKEN
//
// NOTE: ElevenLabs voice_id is NOT used here. ElevenLabs is for speech feedback only (future feature).
//       RVC is the correct tool for singing voice conversion.

export const config = { api: { bodyParser: { sizeLimit: '25mb' } }, maxDuration: 60 };

export default async function handler(req, res) {
  console.log('🔔 clone-voice v85 (RVC-primary) invoked:', req.method);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Health check ──────────────────────────────────────────────────────
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      version: 'v85-RVC-PRIMARY',
      method: 'replicate-rvc',
      replicateKey: process.env.REPLICATE_API_TOKEN ? 'set' : 'MISSING',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Parse request body ────────────────────────────────────────────────
  try {
    var body = req.body || {};
    var songUrl              = body.songUrl              || null;  // isolated vocals URL (from Demucs)
    var voiceSampleUrl       = body.voiceSampleUrl       || null;  // raw user recording URL
    var referenceAudioBase64 = body.referenceAudioBase64 || null;  // raw user recording as base64
    var referenceAudioType   = body.referenceAudioType   || 'audio/wav';
    var trainedModelUrl      = body.trainedModelUrl      || null;  // trained RVC model .zip URL
    var pitchShift           = parseInt(body.pitchShift)  || 0;
    var instrumentalUrl      = body.instrumentalUrl      || null;  // not used by RVC, passed through
    var gender               = body.gender               || 'f';

    console.log('==================================================');
    console.log('VOICE CLONE v85 — Replicate RVC (PRIMARY)');
    console.log('Song/vocals URL:', songUrl ? songUrl.substring(0, 80) : 'NONE');
    console.log('Trained RVC model:', trainedModelUrl ? trainedModelUrl.substring(0, 80) : 'NONE');
    console.log('Voice sample URL:', voiceSampleUrl ? voiceSampleUrl.substring(0, 60) : 'NONE');
    console.log('Voice base64:', referenceAudioBase64 ? Math.round(referenceAudioBase64.length / 1024) + ' KB' : 'NONE');
    console.log('Pitch shift:', pitchShift);
    console.log('Gender:', gender);
    console.log('==================================================');

    // ── Validate: we need the song/vocals URL ───────────────────────────
    if (!songUrl) {
      return res.status(400).json({
        success: false,
        error: 'No songUrl provided — need the vocals to convert',
      });
    }

    // ── Validate: we need REPLICATE_API_TOKEN ───────────────────────────
    var REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
    if (!REPLICATE_API_TOKEN) {
      return res.status(500).json({
        success: false,
        error: 'REPLICATE_API_TOKEN not set in Vercel environment variables',
      });
    }

    // ── Check if user has a trained RVC model ───────────────────────────
    // If they went through train-voice.js, they'll have a model URL
    // If not, we need their voice sample to upload for training first
    if (!trainedModelUrl) {
      console.log('⚠️ No trained RVC model URL provided');
      console.log('   User needs to train their voice first via train-voice.js');

      // If we have a voice sample, tell the frontend to train first
      if (voiceSampleUrl || referenceAudioBase64) {
        return res.status(200).json({
          success: false,
          method: 'none',
          error: 'Voice model not trained yet. Please complete voice training first.',
          note: 'No trained RVC model found. The user needs to record their voice and wait for training to complete before voice cloning will work.',
          needsTraining: true,
        });
      }

      // No model AND no voice sample — nothing to work with
      return res.status(200).json({
        success: false,
        method: 'none',
        error: 'No voice model and no voice sample provided',
        note: 'Please record your voice first so we can create your voice model.',
        needsTraining: true,
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    // REPLICATE RVC — Singing Voice Conversion
    //
    // zsxkib/realistic-voice-cloning takes:
    //   - song_input: URL of the audio to convert (isolated vocals)
    //   - rvc_model: "CUSTOM" to use a custom trained model
    //   - custom_rvc_model_download_url: URL to the trained .zip model
    //   - pitch_change: integer for pitch adjustment
    //   - Various quality settings
    //
    // This is specifically designed for singing voice conversion.
    // Unlike ElevenLabs (speech only), RVC preserves melody and pitch.
    // ══════════════════════════════════════════════════════════════════════

    console.log('🎤 Starting Replicate RVC voice conversion...');
    console.log('   Model: zsxkib/realistic-voice-cloning');
    console.log('   Input vocals:', songUrl.substring(0, 80));
    console.log('   RVC model:', trainedModelUrl.substring(0, 80));

    // Auto pitch shift based on gender if not manually set
    var effectivePitch = pitchShift;
    if (effectivePitch === 0) {
      // If the AI singer gender doesn't match the user, adjust pitch
      // Female AI singer → male user: shift down
      // Male AI singer → female user: shift up
      // This is a rough default; users can fine-tune later
      var isMale = gender === 'm' || gender === 'male';
      if (isMale) {
        effectivePitch = -4;  // lower pitch for male voices
        console.log('   Auto pitch shift: -4 (male user)');
      }
    }

    var rvcInput = {
      protect: 0.33,              // protect consonants/breath sounds
      song_input: songUrl,        // the isolated vocals to convert
      rvc_model: 'CUSTOM',        // use the user's trained model
      index_rate: 0.5,            // balance between AI accent and original
      pitch_change: effectivePitch,
      filter_radius: 3,           // smoothing
      rms_mix_rate: 0.25,         // volume envelope mix
      output_format: 'mp3',       // smaller file size for web
      pitch_detection_algorithm: 'rmvpe',  // best quality pitch detection
      reverb_room_size: 0.15,     // subtle reverb for naturalness
      reverb_wetness: 0.2,
      reverb_dryness: 0.8,
      reverb_damping: 0.7,
      main_vocals_volume_change: 0,  // keep vocals at natural level
      instrumental_volume_change: 0,
      custom_rvc_model_download_url: trainedModelUrl,
    };

    console.log('   RVC input config:', JSON.stringify(rvcInput, null, 2));

    // Start the prediction (async — we'll return the job ID for polling)
    var startRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + REPLICATE_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: '0a9c7c558af4c0f20667c1bd1260ce32a2879944a0b9e44e1398660c077b1550',
        input: rvcInput,
      }),
    });

    var startText = await startRes.text();
    console.log('   Replicate response status:', startRes.status);

    if (!startRes.ok) {
      console.error('❌ Replicate RVC failed to start:', startText);
      return res.status(200).json({
        success: false,
        method: 'error',
        error: 'Failed to start voice conversion: ' + startText,
        note: 'Replicate RVC could not start. Please try again.',
      });
    }

    var prediction = JSON.parse(startText);
    console.log('✅ RVC prediction started:', prediction.id);
    console.log('   Status:', prediction.status);

    // If it completed immediately (unlikely but possible)
    if (prediction.status === 'succeeded' && prediction.output) {
      var outputUrl = typeof prediction.output === 'string'
        ? prediction.output
        : prediction.output[0] || prediction.output;
      console.log('✅ RVC completed immediately:', outputUrl);
      return res.status(200).json({
        success: true,
        method: 'replicate-rvc',
        clonedAudioUrl: outputUrl,
        audioUrl: outputUrl,
        status: 'succeeded',
        note: 'Voice cloned via Replicate RVC!',
      });
    }

    // Otherwise return the job ID so the frontend can poll via check-clone.js
    return res.status(200).json({
      success: true,
      method: 'replicate-rvc',
      status: 'started',
      jobId: prediction.id,
      note: 'RVC voice conversion started — polling via check-clone.js',
    });

  } catch (err) {
    console.error('❌ clone-voice v85 error:', err);
    return res.status(500).json({
      success: false,
      method: 'error',
      error: err.message || 'Unknown error in clone-voice',
    });
  }
}
