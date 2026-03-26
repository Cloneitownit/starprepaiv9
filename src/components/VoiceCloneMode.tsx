import React, { useState, useEffect } from 'react';
import VoiceTraining from './VoiceTraining';
import { VoiceCloneCreateGuide, VoiceCloneRecordGuide } from './TrainingGuide';

interface VoiceCloneModeProps {
  onGoToSongWriter?: () => void;
  trainingMode?: boolean;
  trainingStep?: number;
  advanceStep?: (step: number) => void;
}

const VoiceCloneMode: React.FC<VoiceCloneModeProps> = ({ onGoToSongWriter, trainingMode = false, trainingStep = 0, advanceStep }) => {
  console.log('🎯 VoiceCloneMode v85 (RVC) | trainingMode:', trainingMode, '| step:', trainingStep);
  const [showTraining, setShowTraining] = useState(false);
  const [voiceReady, setVoiceReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  const [processingProgress, setProcessingProgress] = useState(0);
  const [voiceGender, setVoiceGender] = useState<string | null>(null);

  useEffect(() => {
    const isSetup = localStorage.getItem('starprep_voice_setup_complete') === 'true';
    const gender = localStorage.getItem('starprep_voice_gender');
    setVoiceReady(isSetup);
    setVoiceGender(gender);
    if (isSetup && trainingStep === 2 && advanceStep) advanceStep(3);
  }, []);

  const handleReset = () => {
    localStorage.removeItem('starprep_voice_setup_complete');
    localStorage.removeItem('starprep_voice_model_url');
    localStorage.removeItem('starprep_voice_sample_url');
    localStorage.removeItem('starprep_voice_gender');
    localStorage.removeItem('starprep_voice_base64');
    localStorage.removeItem('starprep_voice_base64_type');
    localStorage.removeItem('starprep_voice_method');
    localStorage.removeItem('starprep_voice_prediction_id');
    setVoiceReady(false);
    setVoiceGender(null);
  };

  // ─────────────────────────────────────────────────────────────────
  // RVC TRAINING POLLING
  // Poll /api/check-training every 10 seconds until model is ready
  // Max 180 attempts = 30 minutes (RVC training can take 10-15 min)
  // ─────────────────────────────────────────────────────────────────
  const pollForTrainingComplete = async (predictionId: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const maxAttempts = 180;  // 30 minutes max
      let attempts = 0;

      const checkStatus = async () => {
        attempts++;
        try {
          const response = await fetch(`/api/check-training?predictionId=${predictionId}`);
          const data = await response.json();

          if (data.status === 'ready' && data.modelUrl) {
            console.log('✅ RVC model ready:', data.modelUrl);
            resolve(data.modelUrl);
          } else if (data.status === 'error') {
            reject(new Error(data.message || 'Voice model training failed'));
          } else if (attempts >= maxAttempts) {
            reject(new Error('Training timed out after 30 minutes. Please try again.'));
          } else {
            // Update progress display
            const elapsed = attempts * 10;
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

            const progressMsg = data.progress || 'Training your voice model...';
            setProcessingStatus(`🧬 ${progressMsg} (${timeStr})`);
            setProcessingProgress(30 + Math.min(attempts, 60));

            setTimeout(checkStatus, 10000);  // poll every 10 seconds
          }
        } catch (error) {
          if (attempts >= maxAttempts) {
            reject(new Error('Training check failed after max attempts'));
          } else {
            setTimeout(checkStatus, 10000);
          }
        }
      };

      checkStatus();
    });
  };

  const handleTrainingComplete = async (recordings: Blob[]) => {
    setShowTraining(false);
    setIsProcessing(true);
    setProcessingProgress(10);
    setProcessingStatus('Preparing your voice sample...');

    try {
      // Step 1: Combine recordings — keep as webm
      let combinedBlob = new Blob(recordings, { type: 'audio/webm' });
      let fileSizeMB = (combinedBlob.size / 1024 / 1024).toFixed(2);
      console.log(`📦 Voice sample: ${fileSizeMB} MB (webm)`);

      // CRITICAL: Vercel has a 4.5MB body limit. Base64 adds 33%.
      // Max raw audio = ~3MB (becomes ~4MB base64, under 4.5MB with JSON overhead)
      const MAX_RAW_BYTES = 3 * 1024 * 1024; // 3MB
      if (combinedBlob.size > MAX_RAW_BYTES) {
        console.log(`⚠️ Audio too large (${fileSizeMB}MB) — trimming to fit Vercel limit`);
        // Try just the first recording
        if (recordings.length > 1 && recordings[0].size <= MAX_RAW_BYTES) {
          combinedBlob = new Blob([recordings[0]], { type: 'audio/webm' });
          console.log(`📦 Using first recording only: ${(combinedBlob.size / 1024 / 1024).toFixed(2)} MB`);
        } else {
          // Slice to 3MB — webm may lose some data at the end but RVC only needs ~30-60s
          combinedBlob = combinedBlob.slice(0, MAX_RAW_BYTES, 'audio/webm');
          console.log(`📦 Trimmed to ${(combinedBlob.size / 1024 / 1024).toFixed(2)} MB`);
        }
        fileSizeMB = (combinedBlob.size / 1024 / 1024).toFixed(2);
      }

      setProcessingProgress(20);
      setProcessingStatus(`Uploading ${fileSizeMB}MB voice sample...`);

      // Step 2: Convert to base64
      const audioBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(combinedBlob);
      });

      console.log(`📦 Audio base64 size: ${Math.round(audioBase64.length / 1024)} KB`);

      setProcessingProgress(30);
      setProcessingStatus('🧬 Starting voice model training...');

      // Step 3: Submit to train-voice (RVC on Replicate)
      // Returns immediately with predictionId — training runs async
      console.log('🧬 Calling train-voice API (RVC)...');
      const trainResponse = await fetch('/api/train-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: audioBase64,
          audioType: 'audio/webm',
          userId: 'user_' + Date.now(),
        }),
      });

      if (!trainResponse.ok) {
        const errData = await trainResponse.json().catch(() => ({}));
        throw new Error(errData.error || 'Voice training failed: ' + trainResponse.status);
      }

      const trainResult = await trainResponse.json();
      console.log('🧬 Train result:', trainResult);

      if (!trainResult.success || !trainResult.predictionId) {
        throw new Error(trainResult.error || 'No prediction ID returned from training');
      }

      const predictionId = trainResult.predictionId;
      console.log('✅ RVC training started, predictionId:', predictionId);

      // Save predictionId in case user refreshes
      localStorage.setItem('starprep_voice_prediction_id', predictionId);

      setProcessingProgress(35);
      setProcessingStatus('🧬 Training your voice model... (this takes 10-15 minutes)');

      // Step 4: Poll every 10 seconds until RVC model is trained
      const modelUrl = await pollForTrainingComplete(predictionId);

      // Step 5: Save model URL to localStorage — this is what clone-voice.js uses
      localStorage.setItem('starprep_voice_model_url', modelUrl);
      localStorage.setItem('starprep_voice_method', 'replicate-rvc');
      console.log('✅ RVC model saved:', modelUrl);

      // Step 6: Also save voice sample base64 for reference (only if it fits)
      try {
        localStorage.setItem('starprep_voice_base64', audioBase64);
        localStorage.setItem('starprep_voice_base64_type', 'audio/webm');
      } catch (storageErr) {
        console.warn('⚠️ base64 too large for localStorage — model URL is enough');
        localStorage.removeItem('starprep_voice_base64');
        localStorage.removeItem('starprep_voice_base64_type');
      }

      const gender = localStorage.getItem('starprep_voice_gender') || 'female';

      // Step 7: Mark setup complete
      localStorage.setItem('starprep_voice_setup_complete', 'true');
      localStorage.removeItem('starprep_voice_prediction_id');

      setProcessingProgress(100);
      setProcessingStatus('🎉 Voice model trained! Songs will sound like YOU!');

      setTimeout(() => {
        setIsProcessing(false);
        setVoiceReady(true);
        setVoiceGender(gender);
      }, 1500);

    } catch (error: any) {
      console.error('Voice setup error:', error);
      setIsProcessing(false);
      setProcessingProgress(0);
      setProcessingStatus('');
      alert('Voice setup failed: ' + (error.message || 'Unknown error') + '\n\nPlease try recording again.');
    }
  };

  // Processing screen
  if (isProcessing) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-black/40 backdrop-blur-md rounded-2xl p-8 border border-pink-500/30 text-center">
          <div className="text-8xl mb-6 animate-pulse">🎤</div>
          <h2 className="text-3xl font-bold text-white mb-4">Training Your Voice Model...</h2>
          <p className="text-gray-400 mb-8">{processingStatus}</p>
          <div className="max-w-md mx-auto">
            <div className="h-4 bg-white/10 rounded-full overflow-hidden mb-4">
              <div
                className="h-full bg-gradient-to-r from-pink-500 to-purple-500 transition-all duration-500"
                style={{ width: `${processingProgress}%` }}
              />
            </div>
            <p className="text-pink-500 font-bold text-2xl">{Math.round(processingProgress)}%</p>
          </div>
          <p className="text-gray-500 text-sm mt-4">
            Voice model training can take up to 15 minutes.<br/>
            Please don't close this page!
          </p>
        </div>
      </div>
    );
  }

  // Training modal
  if (showTraining) {
    return (
      <VoiceTraining
        onComplete={handleTrainingComplete}
        onClose={() => setShowTraining(false)}
        jingleUrl="/starprep-jingle.mp3"
      />
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-pink-400 to-purple-500 bg-clip-text text-transparent">
          🎤 Voice Clone
        </h1>
        <p className="text-gray-300">
          Record your voice and AI will create songs that sound like YOU!
        </p>
      </div>

      <div className="bg-black/40 backdrop-blur-md rounded-2xl p-8 border border-pink-500/30 text-center">
        {voiceReady ? (
          <>
            <div className="text-6xl mb-4">✅</div>
            <h2 className="text-2xl font-bold text-green-400 mb-2">Voice Clone Ready!</h2>
            {voiceGender && (
              <p className="text-gray-400 mb-4">
                Voice type: {voiceGender === 'male' ? '👨‍🎤 Male' : '👩‍🎤 Female'}
              </p>
            )}
            <p className="text-gray-300 mb-6">
              Your voice clone is ready! Create songs that sound like you!
            </p>
            <VoiceCloneCreateGuide show={trainingMode && trainingStep === 3} />
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              {onGoToSongWriter && (
                <button
                  onClick={() => onGoToSongWriter()}
                  className="px-8 py-4 rounded-xl bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold text-xl hover:scale-105 transition transform"
                >
                  🎤 Create Your Song!
                </button>
              )}
              <button
                onClick={handleReset}
                className="px-6 py-3 rounded-xl bg-gray-700 text-white hover:bg-gray-600 transition"
              >
                🔄 Record New Sample
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-6xl mb-4">🎙️</div>
            <h2 className="text-2xl font-bold text-pink-400 mb-4">Record Your Voice</h2>
            <p className="text-gray-300 mb-2">
              Sing along to our jingle and we'll capture your unique voice!
            </p>
            <p className="text-gray-500 text-sm mb-8">
              ⚡ Voice model training takes about 10-15 minutes
            </p>
            <VoiceCloneRecordGuide show={trainingMode && trainingStep === 2} />
            <button
              onClick={() => { setShowTraining(true); if (advanceStep) advanceStep(3); }}
              className="px-8 py-4 rounded-xl bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold text-xl hover:scale-105 transition transform"
            >
              🎤 Record Voice Sample
            </button>
          </>
        )}
      </div>

      <div className="mt-8 bg-black/20 rounded-2xl p-6 border border-gray-700">
        <h3 className="text-lg font-bold text-pink-400 mb-4">💡 How Voice Clone Works</h3>
        <div className="grid md:grid-cols-3 gap-4">
          <div className="text-center p-4">
            <div className="text-3xl mb-2">1️⃣</div>
            <p className="text-gray-300 font-semibold">Listen to Jingle</p>
            <p className="text-gray-500 text-sm">Learn the fun melody</p>
          </div>
          <div className="text-center p-4">
            <div className="text-3xl mb-2">2️⃣</div>
            <p className="text-gray-300 font-semibold">Sing & Record</p>
            <p className="text-gray-500 text-sm">Capture your voice</p>
          </div>
          <div className="text-center p-4">
            <div className="text-3xl mb-2">3️⃣</div>
            <p className="text-gray-300 font-semibold">AI Trains Model</p>
            <p className="text-gray-500 text-sm">Up to 15 min to build your voice</p>
          </div>
        </div>
      </div>

      <div className="mt-6 grid md:grid-cols-2 gap-4">
        <div className="bg-gradient-to-br from-pink-900/20 to-purple-900/20 rounded-xl p-4 border border-pink-500/20">
          <h4 className="font-bold text-pink-400 mb-2">🎤 Singing Voice Cloning</h4>
          <ul className="text-gray-400 text-sm space-y-1">
            <li>• Powered by RVC (Retrieval Voice Conversion)</li>
            <li>• Built specifically for singing</li>
            <li>• Preserves pitch, melody & emotion</li>
            <li>• Train once, use forever</li>
          </ul>
        </div>
        <div className="bg-gradient-to-br from-purple-900/20 to-blue-900/20 rounded-xl p-4 border border-purple-500/20">
          <h4 className="font-bold text-purple-400 mb-2">✨ What You Get</h4>
          <ul className="text-gray-400 text-sm space-y-1">
            <li>• Songs generated in YOUR voice</li>
            <li>• Practice with your own sound</li>
            <li>• Hear how you'd sound on stage</li>
            <li>• Prepare for auditions perfectly</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default VoiceCloneMode;
