import { SongResult } from '../types';

// API is on the same domain (Vercel serverless functions)
const API_BASE_URL = '';

// Proxy external URLs through our backend to avoid CORS blocks in the browser
function proxyUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('data:') || url.startsWith('/') || url.startsWith('blob:')) return url;
  return `/api/proxy-audio?url=${encodeURIComponent(url)}`;
}

/**
 * Converts a Blob to base64 string
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Poll for song completion - runs on frontend to avoid server timeout
 */
async function pollForSong(taskId: string, onProgress?: (status: string) => void): Promise<string> {
  const maxAttempts = 240; // 8 minutes max (2 sec intervals)
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    
    if (onProgress) {
      if (attempts < 10) onProgress('Starting generation...');
      else if (attempts < 30) onProgress('AI is composing your song...');
      else if (attempts < 60) onProgress('Adding vocals and mixing...');
      else if (attempts < 120) onProgress('Still working... complex songs take longer...');
      else onProgress('Almost done, hang tight...');
    }
    
    try {
      const response = await fetch(`${API_BASE_URL}/api/check-song?taskId=${taskId}`);
      const result = await response.json();
      
      console.log(`🔍 Poll ${attempts}: status=${result.status}`);
      
      if (result.ready && result.audioUrl) {
        console.log('✅ Song ready:', result.audioUrl);
        return result.audioUrl;
      }
      
      if (result.status === 'FAILED') {
        throw new Error(result.error || 'Song generation failed');
      }
      
      // Wait 2 seconds before next poll
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error('Poll error:', error);
      // Continue polling on network errors
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  throw new Error('Song generation is taking longer than usual. Kie.ai servers may be busy — please try again in a moment!');
}

/**
 * Generates audio track from song data using Kie.ai (Suno V5)
 * Uses polling approach to avoid Vercel timeout
 */
export async function generateTrackAudio(
  song: SongResult, 
  onProgress?: (status: string) => void,
  vocalGender: string = 'f'
): Promise<string> {
  console.log('🎵 Starting audio generation for:', song.title);

  try {
    // Step 1: Start the generation (returns immediately)
    if (onProgress) onProgress('Initializing AI composer...');
    
    const startResponse = await fetch(`${API_BASE_URL}/api/start-song`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lyrics: song.rawLyrics || song.lyrics,  // v28: prefer theme prompt over display lyrics
        style: song.genre || 'Pop',
        title: song.title || 'StarPrep Song',
        vocalGender: vocalGender,
      }),
    });

    if (!startResponse.ok) {
      const errorData = await startResponse.json().catch(() => ({}));
      throw new Error(errorData.error || `Server error: ${startResponse.status}`);
    }

    const startResult = await startResponse.json();
    
    if (!startResult.success || !startResult.taskId) {
      throw new Error(startResult.error || 'Failed to start generation');
    }

    console.log('✅ Generation started, taskId:', startResult.taskId);
    
    // Step 2: Poll for completion (runs on frontend)
    const audioUrl = await pollForSong(startResult.taskId, onProgress);
    
    return audioUrl;
    
  } catch (error) {
    console.error('❌ Audio generation failed:', error);
    throw error;
  }
}

/**
 * Generates instrumental track (karaoke version) using Kie.ai
 */
export async function generateInstrumentalTrack(
  song: SongResult,
  onProgress?: (status: string) => void
): Promise<string> {
  console.log('🎵 Starting instrumental track for:', song.title);

  try {
    if (onProgress) onProgress('Initializing instrumental generation...');
    
    const startResponse = await fetch(`${API_BASE_URL}/api/start-song`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lyrics: song.rawLyrics || song.lyrics,  // v28: prefer theme prompt
        style: song.genre || 'Pop',
        title: song.title || 'StarPrep Song (Instrumental)',
        instrumental: true,
      }),
    });

    if (!startResponse.ok) {
      const errorData = await startResponse.json().catch(() => ({}));
      throw new Error(errorData.error || `Server error: ${startResponse.status}`);
    }

    const startResult = await startResponse.json();
    
    if (!startResult.success || !startResult.taskId) {
      throw new Error(startResult.error || 'Failed to start generation');
    }

    console.log('✅ Instrumental started, taskId:', startResult.taskId);
    
    const audioUrl = await pollForSong(startResult.taskId, onProgress);
    
    return audioUrl;
    
  } catch (error) {
    console.error('❌ Instrumental generation failed:', error);
    throw error;
  }
}

/**
 * Clones the user's voice and applies it to a track
 * 
 * v13 PIPELINE (fixed):
 *   1. Generate base song via Kie.ai
 *   2. Separate stems (vocals + instrumental stems) via Demucs
 *   3. Clone voice onto ISOLATED VOCALS via Seed-VC
 *   4. Mix cloned vocals + CLEAN instrumental (from stems, not original song)
 *   5. Return blob URL of the final mixed result
 *
 * v13 KEY FIX: When Demucs returns 4 stems, we combine drums+bass+other
 * into a clean instrumental instead of using the original song (which had
 * AI vocals bleeding through, making the result sound like crap)
 */
export async function generateClonedTrack(
  song: SongResult, 
  referenceAudio: File | Blob,
  voiceModel: string,
  onProgress?: (status: string) => void,
  gender: string = 'f'
): Promise<string> {
  console.log('🎤 Generating cloned track (v13 pipeline — clean instrumental)...');
  console.log('   Song:', song.title);

  // v33: Track the base song URL outside try so fallback can use it
  let fallbackSongUrl: string | null = song.audioUrl || null;

  try {
    // Gather all voice data from localStorage
    const savedVoiceSampleUrl = localStorage.getItem('starprep_voice_sample_url');
    const savedGender = localStorage.getItem('starprep_voice_gender') || gender;
    const isMale = savedGender === 'm' || savedGender === 'male';
    const savedVoiceBase64 = localStorage.getItem('starprep_voice_base64');
    const savedVoiceBase64Type = localStorage.getItem('starprep_voice_base64_type') || 'audio/wav';

    console.log('   Voice base64:', savedVoiceBase64 ? `${Math.round(savedVoiceBase64.length / 1024)} KB` : 'None');
    console.log('   Voice sample URL:', savedVoiceSampleUrl ? savedVoiceSampleUrl.substring(0, 60) : 'None');
    console.log('   Gender:', savedGender);

    // ═════════════════════════════════════════════
    // STEP 1: Generate the base song
    // ═════════════════════════════════════════════
    if (onProgress) onProgress('🎵 Step 1/4: Generating your song...');
    console.log('📝 Step 1: Generating base song...');
    const baseSongUrl = await generateTrackAudio(song, onProgress, savedGender);
    fallbackSongUrl = baseSongUrl;  // v33: save for fallback if cloning fails
    console.log('✅ Base song URL:', baseSongUrl.substring(0, 80));

    // ═════════════════════════════════════════════
    // STEP 2: Separate stems to get CLEAN instrumental
    // v49b: We need the instrumental WITHOUT the AI singer
    // Demucs instrumental may sound slightly thinner, but
    // it's WAY better than two voices bleeding together
    // ═════════════════════════════════════════════
    if (onProgress) onProgress('🎼 Step 2/4: Separating vocals from music...');
    console.log('🎼 Step 2: Separating stems (for clean instrumental)...');
    
    let instrumentalUrl: string | null = null;
    let stemUrls: { drums?: string; bass?: string; other?: string } | null = null;
    let vocalsUrl: string = baseSongUrl;

    try {
      const stemResponse = await fetch(`${API_BASE_URL}/api/separate-stems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl: baseSongUrl }),
      });

      if (stemResponse.ok) {
        const stemResult = await stemResponse.json();

        // If started async, poll check-stems until done
        if (stemResult.success && stemResult.predictionId && stemResult.status === 'started') {
          console.log('   Polling check-stems for:', stemResult.predictionId);
          for (let attempt = 0; attempt < 60; attempt++) {
            await new Promise(r => setTimeout(r, 3000));
            if (onProgress) onProgress(`🎼 Step 2/4: Separating vocals (${attempt * 3}s)...`);
            try {
              const pollRes = await fetch(`${API_BASE_URL}/api/check-stems?predictionId=${stemResult.predictionId}`);
              const pollData = await pollRes.json();
              if (pollData.status === 'succeeded') {
                vocalsUrl = pollData.vocalsUrl || vocalsUrl;
                instrumentalUrl = pollData.instrumentalUrl || null;
                stemUrls = { drums: pollData.drumsUrl, bass: pollData.bassUrl, other: pollData.otherUrl };
                console.log('✅ Stems separated via polling!');
                break;
              }
              if (pollData.status === 'failed') {
                console.warn('⚠️ Stem separation failed:', pollData.error);
                break;
              }
            } catch (pe) { console.warn('Poll error:', pe); }
          }
        } else if (stemResult.success && stemResult.vocalsUrl) {
          vocalsUrl = stemResult.vocalsUrl;
          instrumentalUrl = stemResult.instrumentalUrl;
          stemUrls = stemResult.stemUrls || null;
          console.log('✅ Stems separated!');
          console.log('   Vocals (for cloning):', vocalsUrl?.substring(0, 80));
          console.log('   Instrumental (for mixing):', instrumentalUrl?.substring(0, 80));
          if (stemUrls) console.log('   Individual stems (drums/bass/other) available ✅');
        }
      }
    } catch (stemErr) {
      console.warn('⚠️ Stem separation failed:', stemErr);
    }

    // ═════════════════════════════════════════════
    // STEP 3: Clone voice onto ISOLATED vocals
    // v49b: Send ONLY the isolated vocals to Seed-VC
    // This prevents the AI from trying to "eat" the music
    // ═════════════════════════════════════════════
    if (onProgress) onProgress('🎤 Step 3/4: Cloning your voice...');
    console.log('🎤 Step 3: Cloning voice onto', vocalsUrl === baseSongUrl ? 'FULL MIX (stems failed)' : 'ISOLATED VOCALS ✅');

    const cloneResponse = await fetch(`${API_BASE_URL}/api/clone-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        songUrl: vocalsUrl,
        voiceSampleUrl: savedVoiceSampleUrl || null,
        referenceAudioBase64: savedVoiceBase64 || null,
        referenceAudioType: savedVoiceBase64Type || 'audio/wav',
        trainedModelUrl: localStorage.getItem('starprep_voice_model_url') || null,
        gender: savedGender,
        pitchShift: 0,
        instrumentalUrl: instrumentalUrl || null,
      }),
    });

    if (!cloneResponse.ok) {
      const error = await cloneResponse.json().catch(() => ({}));
      throw new Error(error.error || 'Voice cloning failed — please try again');
    }

    const cloneResult = await cloneResponse.json();
    
    if (!cloneResult.success || cloneResult.method === 'none' || cloneResult.method === 'error') {
      throw new Error(cloneResult.note || cloneResult.error || 'Voice cloning did not produce a result');
    }
    
    let clonedVocalsUrl = cloneResult.clonedAudioUrl || cloneResult.audioUrl || null;

    // Proxy external URLs to avoid CORS errors in the browser
    if (clonedVocalsUrl) {
      clonedVocalsUrl = proxyUrl(clonedVocalsUrl);
      console.log('   Proxied cloned vocals URL:', clonedVocalsUrl.substring(0, 80));
    }

    // If clone-voice returned 'started' (async Seed-VC or RVC), poll check-clone
    if (cloneResult.status === 'started' && !clonedVocalsUrl) {
      console.log('⏳ Clone started async — polling check-clone...', cloneResult.method);
      const pollJobId = cloneResult.jobId || cloneResult.sessionHash;
      const pollMethod = cloneResult.method || '';
      const pollSpaceUrl = cloneResult.spaceUrl || '';

      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        if (onProgress) onProgress(`🎤 Step 3/4: Cloning voice (${attempt * 3}s)...`);
        try {
          const params = new URLSearchParams({
            jobId: pollJobId,
            method: pollMethod,
            ...(pollSpaceUrl ? { spaceUrl: pollSpaceUrl } : {}),
          });
          const pollRes = await fetch(`${API_BASE_URL}/api/check-clone?${params}`);
          const pollData = await pollRes.json();
          if (pollData.status === 'succeeded') {
            clonedVocalsUrl = pollData.clonedAudioUrl || pollData.audioUrl;
            console.log('✅ Clone polling succeeded:', clonedVocalsUrl?.substring(0, 80));
            break;
          }
          if (pollData.status === 'failed') {
            console.warn('⚠️ Clone failed:', pollData.error);
            break;
          }
        } catch (pe) { console.warn('Clone poll error:', pe); }
      }
    }

    console.log('✅ Clone result:', cloneResult.method, '|', cloneResult.note || 'OK');
    console.log('   Cloned vocals URL:', clonedVocalsUrl?.substring(0, 80));

    if (cloneResult.method === 'replicate-rvc' || cloneResult.method === 'rvc-trained') {
      if (onProgress) onProgress('🎤 Voice cloned with your trained RVC model!');
    } else if (cloneResult.method === 'elevenlabs-sts') {
      if (onProgress) onProgress('🎤 Voice cloned with ElevenLabs!');
    } else if (cloneResult.method === 'seed-vc') {
      if (onProgress) onProgress('🎤 Voice cloned with Seed-VC!');
    }

    // ═════════════════════════════════════════════
    // STEP 4: Mix cloned vocals + CLEAN instrumental
    // v74 FIX: Use Demucs instrumental (AI singer removed) as backing track.
    // If Demucs returned 4 individual stems, use mixStemsTogether for best quality.
    // Only fall back to baseSongUrl if stem separation completely failed.
    // ═════════════════════════════════════════════
    if (clonedVocalsUrl && clonedVocalsUrl !== vocalsUrl) {
      if (onProgress) onProgress('🎧 Step 4/4: Mixing your voice with the music...');

      // Proxy all URLs to avoid CORS blocks in the browser
      const proxiedInstrumental = instrumentalUrl ? proxyUrl(instrumentalUrl) : null;
      const proxiedBaseSong = proxyUrl(baseSongUrl);

      try {
        // BEST CASE: 4 individual stems available — mix them cleanly
        if (stemUrls && (stemUrls.drums || stemUrls.bass || stemUrls.other)) {
          console.log('🎧 Step 4: Mixing cloned vocals + individual stems (CLEANEST — no AI singer)');
          const mixedUrl = await mixStemsTogether(clonedVocalsUrl, stemUrls);
          console.log('✅ Stem mix complete!');
          return mixedUrl;
        }

        // GOOD CASE: Combined Demucs instrumental available (AI singer removed)
        if (proxiedInstrumental && instrumentalUrl !== baseSongUrl) {
          console.log('🎧 Step 4: Mixing cloned vocals + Demucs instrumental (AI singer removed ✅)');
          const mixedUrl = await mixAudioTracks(clonedVocalsUrl, proxiedInstrumental!);
          console.log('✅ Mix complete!');
          return mixedUrl;
        }

        // FALLBACK: Stems failed entirely — mix with original song (will have some AI bleed)
        console.warn('⚠️ Step 4: No clean instrumental available — using original song (stems failed)');
        const mixedUrl = await mixAudioTracks(clonedVocalsUrl, proxiedBaseSong);
        console.log('✅ Mix complete (fallback)');
        return mixedUrl;

      } catch (mixErr) {
        console.warn('⚠️ Mix failed, returning cloned vocals only:', mixErr);
        return clonedVocalsUrl;
      }
    }

    // No cloning happened or same URL — return the base song with music
    // v13 FIX: ALWAYS return a URL that has music, never just dry vocals
    return clonedVocalsUrl || baseSongUrl;

  } catch (error) {
    console.error('❌ Cloned track generation failed:', error);
    // v33: Return the base song URL instead of throwing — user still gets their song
    if (fallbackSongUrl) {
      console.log('🎵 Falling back to AI-generated song (no cloning)');
      if (onProgress) onProgress('🎵 Your song is ready! (Voice cloning unavailable — playing AI version)');
      return fallbackSongUrl;
    }
    throw error;
  }
}

/**
 * v13 NEW: Mix cloned vocals with individual stems (drums, bass, other)
 * v48: Removed all original vocal blending — ONLY cloned voice + instruments
 */
async function mixStemsTogether(
  clonedVocalsUrl: string,
  stemUrls: { drums?: string; bass?: string; other?: string },
): Promise<string> {
  console.log('🎛️ Mixing stems: cloned vocals + drums + bass + other (NO original singer)');

  // Collect all URLs to download
  const urls: { url: string; gain: number; label: string }[] = [
    { url: clonedVocalsUrl, gain: 1.2, label: 'cloned vocals (lead)' },
  ];
  
  if (stemUrls.drums) urls.push({ url: stemUrls.drums, gain: 1.1, label: 'drums' });
  if (stemUrls.bass) urls.push({ url: stemUrls.bass, gain: 1.1, label: 'bass' });
  if (stemUrls.other) urls.push({ url: stemUrls.other, gain: 0.75, label: 'other (lowered to reduce vocal bleed)' });

  console.log('   Downloading', urls.length, 'tracks...');

  // Download all tracks
  const responses = await Promise.all(
    urls.map(async ({ url, label }) => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`${label}: HTTP ${resp.status}`);
        return await resp.arrayBuffer();
      } catch (e) {
        console.warn(`   ⚠️ Failed to download ${label}:`, e);
        return null;
      }
    })
  );

  // Decode all audio buffers
  const audioContext = new AudioContext({ sampleRate: 44100 });
  const decodedBuffers: { buffer: AudioBuffer; gain: number; label: string }[] = [];

  for (let i = 0; i < responses.length; i++) {
    if (!responses[i]) continue;
    try {
      const buffer = await audioContext.decodeAudioData(responses[i]!.slice(0));
      decodedBuffers.push({ buffer, gain: urls[i].gain, label: urls[i].label });
      console.log(`   ✅ Decoded ${urls[i].label}: ${buffer.duration.toFixed(1)}s`);
    } catch (e) {
      console.warn(`   ⚠️ Failed to decode ${urls[i].label}:`, e);
    }
  }

  if (decodedBuffers.length === 0) {
    throw new Error('No audio tracks could be decoded');
  }

  // Find the longest duration
  const maxDuration = Math.max(...decodedBuffers.map(d => d.buffer.duration));
  const sampleRate = 44100;
  const totalSamples = Math.ceil(maxDuration * sampleRate);

  // Create offline context for rendering
  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

  // Add each track with its gain
  for (const { buffer, gain, label } of decodedBuffers) {
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    const gainNode = offlineCtx.createGain();
    gainNode.gain.value = gain;
    source.connect(gainNode);
    gainNode.connect(offlineCtx.destination);
    source.start(0);
    console.log(`   🔊 Added ${label} at gain ${gain}`);
  }

  // Render the mix
  const renderedBuffer = await offlineCtx.startRendering();
  audioContext.close();

  // Convert to WAV blob
  const wavBlob = audioBufferToWav(renderedBuffer);
  const blobUrl = URL.createObjectURL(wavBlob);
  
  console.log('✅ Stem mix complete! Duration:', maxDuration.toFixed(1), 's');
  return blobUrl;
}

/**
 * Mix two audio tracks together using Web Audio API
 * Downloads both, decodes, overlays, renders to WAV blob URL
 */
async function mixAudioTracks(vocalsUrl: string, instrumentalUrl: string): Promise<string> {
  console.log('🎛️ Mixing audio tracks (2-track)...');

  const [vocalsResp, instResp] = await Promise.all([
    fetch(vocalsUrl),
    fetch(instrumentalUrl),
  ]);

  if (!vocalsResp.ok) throw new Error('Failed to download cloned vocals');
  if (!instResp.ok) throw new Error('Failed to download instrumental');

  const [vocalsBuffer, instBuffer] = await Promise.all([
    vocalsResp.arrayBuffer(),
    instResp.arrayBuffer(),
  ]);

  const audioContext = new AudioContext({ sampleRate: 44100 });
  
  const [vocalsAudio, instAudio] = await Promise.all([
    audioContext.decodeAudioData(vocalsBuffer.slice(0)),
    audioContext.decodeAudioData(instBuffer.slice(0)),
  ]);

  const duration = Math.max(vocalsAudio.duration, instAudio.duration);
  const sampleRate = 44100;
  const totalSamples = Math.ceil(duration * sampleRate);

  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

  // Vocals: your cloned voice is the star
  const vocalsSource = offlineCtx.createBufferSource();
  vocalsSource.buffer = vocalsAudio;
  const vocalsGain = offlineCtx.createGain();
  vocalsGain.gain.value = 1.2;  // v74: slightly reduced from 1.5 — prevents clipping
  vocalsSource.connect(vocalsGain);
  vocalsGain.connect(offlineCtx.destination);
  vocalsSource.start(0);

  // Backing: clean Demucs instrumental (AI singer removed) — full volume
  const instSource = offlineCtx.createBufferSource();
  instSource.buffer = instAudio;
  const instGain = offlineCtx.createGain();
  instGain.gain.value = 0.85;  // v74 FIX: raised from 0.4 — instrumental is now clean (no AI singer)
  instSource.connect(instGain);
  instGain.connect(offlineCtx.destination);
  instSource.start(0);

  const renderedBuffer = await offlineCtx.startRendering();
  audioContext.close();

  const wavBlob = audioBufferToWav(renderedBuffer);
  const blobUrl = URL.createObjectURL(wavBlob);
  
  console.log('✅ Audio mixed! Duration:', duration.toFixed(1), 's');
  return blobUrl;
}

/**
 * Convert AudioBuffer to WAV Blob
 */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = 2;
  const dataSize = length * numChannels * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  let offset = headerSize;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/**
 * Generate a full AI song with vocals using Kie.ai (Suno V5)
 */
export async function generateFullSong(
  lyrics: string,
  style: string,
  _duration: number = 60,
  onProgress?: (status: string) => void,
  vocalGender: string = 'f'
): Promise<string> {
  console.log('🎵 Generating full song with AI vocals...');
  
  try {
    if (onProgress) onProgress('Starting AI song generation...');
    
    const startResponse = await fetch(`${API_BASE_URL}/api/start-song`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        lyrics, 
        style: style || 'pop, professional vocals, high quality',
        title: 'StarPrep Song',
        vocalGender: vocalGender,
      }),
    });

    if (!startResponse.ok) {
      const error = await startResponse.json().catch(() => ({}));
      throw new Error(error.error || 'Song generation failed');
    }

    const startResult = await startResponse.json();
    
    if (!startResult.success || !startResult.taskId) {
      throw new Error(startResult.error || 'Failed to start generation');
    }

    console.log('✅ Full song started, taskId:', startResult.taskId);
    
    const audioUrl = await pollForSong(startResult.taskId, onProgress);
    
    return audioUrl;
  } catch (error) {
    console.error('❌ Full song generation failed:', error);
    throw error;
  }
}

/**
 * Separate vocals from instrumentals for karaoke mode
 */
export async function separateStems(audioUrl: string): Promise<{ vocalsUrl: string; instrumentalUrl: string }> {
  console.log('🎵 Separating stems for karaoke...');
  
  try {
    const response = await fetch(`${API_BASE_URL}/api/separate-stems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioUrl }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Stem separation failed');
    }

    const result = await response.json();
    console.log('✅ Stems separated!');
    
    return {
      vocalsUrl: result.vocalsUrl,
      instrumentalUrl: result.instrumentalUrl,
    };
  } catch (error) {
    console.error('❌ Stem separation failed:', error);
    throw error;
  }
}
