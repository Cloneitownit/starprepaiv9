// api/train-voice.js — ElevenLabs Instant Voice Clone
// Follows ElevenLabs instructions exactly:
// 1. Submit voice clone request
// 2. Return immediately with voice_id — do NOT wait
// 3. Frontend polls /api/check-training to confirm voice is ready

export const config = { api: { bodyParser: { sizeLimit: '50mb' } }, maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const audioBase64 = body.audioBase64 || '';
    const audioMime = body.audioMime || 'audio/webm';
    const userId = body.userId || 'user_' + Date.now();

    if (!audioBase64) {
      return res.status(400).json({ error: 'audioBase64 is required' });
    }

    console.log('==================================================');
    console.log('TRAIN-VOICE — ElevenLabs Instant Voice Clone');
    console.log('User:', userId);
    console.log('Audio size:', Math.round(audioBase64.length / 1024), 'KB base64');
    console.log('==================================================');

    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    if (!ELEVENLABS_API_KEY) {
      return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
    }

    // Convert base64 to buffer
    const audioBuffer = Buffer.from(
      audioBase64.replace(/^data:audio\/[^;]+;base64,/, ''),
      'base64'
    );
    console.log('Audio buffer:', audioBuffer.length, 'bytes');

    // Build voice name
    const voiceName = 'StarPrep_' + userId + '_' + Date.now();

    // Build FormData exactly as ElevenLabs instructed
    const formData = new FormData();
    formData.append('name', voiceName);
    formData.append('description', 'StarprepAI singer voice');
    formData.append('remove_background_noise', 'true');

    // Map mime type to file extension
    const extMap = { 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' };
    const ext = extMap[audioMime] || 'webm';
    formData.append('files', new Blob([audioBuffer], { type: audioMime }), 'voice_sample.' + ext);

    console.log('Uploading to ElevenLabs /v1/voices/add ...');
    console.log('Voice name:', voiceName);
    console.log('Audio:', Math.round(audioBuffer.length / 1024), 'KB', audioMime);

    // POST to ElevenLabs — exactly as instructed
    const response = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    const responseText = await response.text();
    console.log('ElevenLabs response:', response.status, responseText.substring(0, 300));

    if (!response.ok) {
      throw new Error('ElevenLabs ' + response.status + ': ' + responseText.substring(0, 200));
    }

    const data = JSON.parse(responseText);
    if (!data.voice_id) {
      throw new Error('No voice_id in ElevenLabs response');
    }

    console.log('ElevenLabs voice created! voiceId:', data.voice_id);

    // ✅ Return immediately with voice_id — do NOT wait for processing
    // Frontend will poll /api/check-training to confirm voice is ready
    return res.status(200).json({
      success: true,
      voiceId: data.voice_id,
      voice_id: data.voice_id,
      modelUrl: data.voice_id,
      predictionId: data.voice_id,
      method: 'elevenlabs-ivc',
      status: 'processing',
      message: 'Voice cloning started! Checking status...',
      estimatedMinutes: 1,
    });

  } catch (err) {
    console.error('train-voice error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
