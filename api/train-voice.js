// api/train-voice.js — Train RVC voice model on Replicate (v85)
//
// v85 REWRITE (2026-03-25):
//   - REMOVED: ElevenLabs Instant Voice Clone (speech only — can't be used for singing)
//   - PRIMARY: Replicate RVC training — creates a model that actually works for singing
//
// Flow:
//   1. Receive user's voice recording (base64 or URL)
//   2. Upload to Replicate as a zip file
//   3. Start RVC training (async, takes ~5-10 min)
//   4. Return prediction ID for polling via check-training.js
//
// Keys needed: REPLICATE_API_TOKEN

export const config = { api: { bodyParser: { sizeLimit: '4mb' } }, maxDuration: 60 };

/**
 * Create a simple ZIP file containing the voice sample
 * Replicate's RVC training expects a zip with audio files
 */
function createSimpleZip(filename, audioBuffer) {
  // Minimal ZIP file format
  var nameBytes = Buffer.from(filename, 'utf8');
  var crc = crc32(audioBuffer);
  var now = new Date();
  var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  // Local file header
  var localHeader = Buffer.alloc(30 + nameBytes.length);
  localHeader.writeUInt32LE(0x04034b50, 0);  // local file header sig
  localHeader.writeUInt16LE(20, 4);           // version needed
  localHeader.writeUInt16LE(0, 6);            // flags
  localHeader.writeUInt16LE(0, 8);            // compression (none)
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(audioBuffer.length, 18);  // compressed size
  localHeader.writeUInt32LE(audioBuffer.length, 22);  // uncompressed size
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);           // extra field length
  nameBytes.copy(localHeader, 30);

  // Central directory
  var centralDir = Buffer.alloc(46 + nameBytes.length);
  centralDir.writeUInt32LE(0x02014b50, 0);
  centralDir.writeUInt16LE(20, 4);
  centralDir.writeUInt16LE(20, 6);
  centralDir.writeUInt16LE(0, 8);
  centralDir.writeUInt16LE(0, 10);
  centralDir.writeUInt16LE(dosTime, 12);
  centralDir.writeUInt16LE(dosDate, 14);
  centralDir.writeUInt32LE(crc, 16);
  centralDir.writeUInt32LE(audioBuffer.length, 20);
  centralDir.writeUInt32LE(audioBuffer.length, 24);
  centralDir.writeUInt16LE(nameBytes.length, 28);
  centralDir.writeUInt16LE(0, 30);
  centralDir.writeUInt16LE(0, 32);
  centralDir.writeUInt16LE(0, 34);
  centralDir.writeUInt16LE(0, 36);
  centralDir.writeUInt32LE(0, 38);
  centralDir.writeUInt32LE(0, 42);  // offset of local header
  nameBytes.copy(centralDir, 46);

  // End of central directory
  var localFileSize = localHeader.length + audioBuffer.length;
  var endOfDir = Buffer.alloc(22);
  endOfDir.writeUInt32LE(0x06054b50, 0);
  endOfDir.writeUInt16LE(0, 4);
  endOfDir.writeUInt16LE(0, 6);
  endOfDir.writeUInt16LE(1, 8);   // entries on this disk
  endOfDir.writeUInt16LE(1, 10);  // total entries
  endOfDir.writeUInt32LE(centralDir.length, 12);
  endOfDir.writeUInt32LE(localFileSize, 16);
  endOfDir.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, audioBuffer, centralDir, endOfDir]);
}

/**
 * Simple CRC32 implementation for ZIP
 */
function crc32(buf) {
  var table = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i;
    for (var j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  var crc = 0xFFFFFFFF;
  for (var k = 0; k < buf.length; k++) {
    crc = table[(crc ^ buf[k]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export default async function handler(req, res) {
  console.log('🔔 train-voice v85 (RVC-only) invoked:', req.method);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      version: 'v85-RVC-ONLY',
      replicateKey: process.env.REPLICATE_API_TOKEN ? 'set' : 'MISSING',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    var body = req.body || {};
    var audioBase64 = body.audioBase64 || body.audio || null;
    var audioType = body.audioType || body.mimeType || 'audio/wav';
    var audioUrl = body.audioUrl || body.voiceSampleUrl || null;
    var userId = body.userId || 'user_' + Date.now();

    console.log('==================================================');
    console.log('TRAIN VOICE v85 — Replicate RVC Training');
    console.log('User ID:', userId);
    console.log('Audio base64:', audioBase64 ? Math.round(audioBase64.length / 1024) + ' KB' : 'NONE');
    console.log('Audio URL:', audioUrl ? audioUrl.substring(0, 60) : 'NONE');
    console.log('Audio type:', audioType);
    console.log('==================================================');

    // ── Validate ────────────────────────────────────────────────────────
    var REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
    if (!REPLICATE_API_TOKEN) {
      return res.status(500).json({
        error: 'REPLICATE_API_TOKEN not set in Vercel environment variables',
      });
    }

    // ── Get audio buffer ────────────────────────────────────────────────
    var audioBuffer = null;

    if (audioBase64) {
      // Strip data URL prefix if present
      var raw = audioBase64;
      if (raw.includes(',')) raw = raw.split(',')[1];
      audioBuffer = Buffer.from(raw, 'base64');
      console.log('Audio from base64:', audioBuffer.length, 'bytes');
    } else if (audioUrl) {
      // Download the audio from URL
      console.log('Downloading audio from URL:', audioUrl.substring(0, 60));
      var audioRes = await fetch(audioUrl);
      if (!audioRes.ok) {
        return res.status(400).json({ error: 'Failed to download audio from URL' });
      }
      var arrayBuf = await audioRes.arrayBuffer();
      audioBuffer = Buffer.from(arrayBuf);
      console.log('Audio from URL:', audioBuffer.length, 'bytes');
    }

    if (!audioBuffer || audioBuffer.length < 1000) {
      return res.status(400).json({
        error: 'No valid audio provided. Please record your voice first.',
      });
    }

    // ── Create ZIP for Replicate ────────────────────────────────────────
    var extension = 'wav';
    if (audioType.includes('mp3') || audioType.includes('mpeg')) extension = 'mp3';
    else if (audioType.includes('webm')) extension = 'webm';
    else if (audioType.includes('ogg')) extension = 'ogg';
    else if (audioType.includes('m4a') || audioType.includes('mp4')) extension = 'm4a';

    var zipBuffer = createSimpleZip('voice_sample.' + extension, audioBuffer);
    console.log('ZIP created:', zipBuffer.length, 'bytes');

    // ── Upload ZIP to Replicate Files API ───────────────────────────────
    var datasetZipUrl = null;
    try {
      var form = new FormData();
      form.append(
        'content',
        new Blob([zipBuffer], { type: 'application/zip' }),
        'dataset_' + userId + '_' + Date.now() + '.zip'
      );

      var uploadRes = await fetch('https://api.replicate.com/v1/files', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + REPLICATE_API_TOKEN },
        body: form,
      });

      var uploadText = await uploadRes.text();
      if (uploadRes.ok) {
        var uploadData = JSON.parse(uploadText);
        datasetZipUrl = (uploadData.urls && uploadData.urls.get) || uploadData.url || null;
        console.log('✅ Replicate Files upload success:', datasetZipUrl);
      } else {
        console.warn('⚠️ Replicate Files upload failed:', uploadRes.status, uploadText);
      }
    } catch (e) {
      console.warn('⚠️ Replicate Files upload error:', e.message);
    }

    // Fallback: use base64 data URL if file upload failed
    if (!datasetZipUrl) {
      console.log('Using base64 data URL as fallback...');
      var zipBase64 = zipBuffer.toString('base64');
      datasetZipUrl = 'data:application/zip;base64,' + zipBase64;
    }

    // ── Start RVC Training on Replicate ─────────────────────────────────
    console.log('🚀 Starting RVC training on Replicate...');

    var trainRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + REPLICATE_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: '920d08bcf911546897a4bf5a5b78cf0b387a79d74d847cc9523ced6603ac1b90',
        input: {
          dataset_zip: datasetZipUrl,
          sample_rate: '48k',
          version: 'v2',
          f0method: 'rmvpe_gpu',
          epoch: 100,
          batch_size: 7,
          save_every_epoch: 50,
          total_epoch: 100,
        },
      }),
    });

    var trainText = await trainRes.text();
    console.log('Replicate training response status:', trainRes.status);

    if (!trainRes.ok) {
      console.error('❌ RVC training failed to start:', trainText);
      return res.status(500).json({
        error: 'Failed to start RVC training',
        details: trainText,
      });
    }

    var prediction = JSON.parse(trainText);
    console.log('✅ RVC training started!');
    console.log('   Prediction ID:', prediction.id);
    console.log('   Status:', prediction.status);

    return res.status(200).json({
      success: true,
      predictionId: prediction.id,
      method: 'replicate-rvc',
      status: prediction.status === 'succeeded' ? 'succeeded' : 'training',
      message: 'Voice model training started! This takes about 5-10 minutes.',
      estimatedMinutes: 8,
    });

  } catch (err) {
    console.error('❌ train-voice v85 error:', err);
    return res.status(500).json({
      error: err.message || 'Unknown error in train-voice',
    });
  }
}
