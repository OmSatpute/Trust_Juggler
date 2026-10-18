import { useEffect, useRef, useState } from 'react';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type ApiResponse = {
  verdict: 'pending' | 'verified' | 'step_up' | 'alert';
  kyc_similarity: number | null;
  shift_similarity: number | null;
  sample_scores: number[];
  sample_score_spread: number | null;
  vad_noise_reduction_pct: number | null;
  speech_duration_seconds: number | null;
  speaker_model: string;
  layers: Record<string, { status: string; reason: string }>;
};

type Props = { riderId: string; shiftId: string; onResult?: (result: ApiResponse) => void };

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');
const BATCH_SAMPLE_COUNT = 5;
const BATCH_CAPTURE_MS = 8_000;
const ENROLLMENT_CAPTURE_MS = 10_000;

export default function VoiceCheckScreen({ riderId, shiftId, onResult }: Props) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [callNumber, setCallNumber] = useState(1);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('Requesting microphone access…');
  const [result, setResult] = useState<ApiResponse | null>(null);
  const speakerStatus = result?.layers.kyc_speaker_match?.status ?? 'pending';
  const speakerVerdict = getSpeakerVerdict(speakerStatus, result?.verdict);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!mounted) return;
        setPermissionGranted(permission.granted);
        setStatusText(permission.granted ? 'Ready for a five-clip voice check' : 'Microphone permission is required');
        if (permission.granted) {
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        }
      } catch {
        if (mounted) setStatusText('Could not initialize microphone access');
      }
    })();
    return () => {
      mounted = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (activeRef.current) void recorder.stop().catch(() => undefined);
    };
  }, [recorder]);

  const validateSetup = () => {
    if (!permissionGranted) {
      Alert.alert('Microphone permission required', 'Allow microphone access in Android settings, then reopen this screen.');
      return false;
    }
    if (!API_BASE_URL) {
      Alert.alert('Backend URL missing', 'Set EXPO_PUBLIC_API_BASE_URL in mobile/.env to your reachable FastAPI URL.');
      return false;
    }
    if (!riderId.trim()) {
      Alert.alert('Rider ID required', 'Enter the rider identifier enrolled on the backend.');
      return false;
    }
    return true;
  };

  const recordClip = async (durationMs: number) => {
    await recorder.prepareToRecordAsync(RecordingPresets.HIGH_QUALITY);
    recorder.record();
    await new Promise<void>((resolve) => {
      timerRef.current = setTimeout(resolve, durationMs);
    });
    timerRef.current = null;
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri) throw new Error('Recorder did not produce an audio file.');
    return uri;
  };

  const uploadClip = async (uri: string, endpoint: string, parameters: Record<string, string>) => {
    const response = await FileSystem.uploadAsync(`${API_BASE_URL}${endpoint}`, uri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'audio',
      mimeType: 'audio/mp4',
      parameters,
    });
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(response.body) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = typeof payload.detail === 'string' ? payload.detail : `Backend returned HTTP ${response.status}`;
      throw new Error(detail);
    }
    return payload;
  };

  const captureEnrollmentBatch = async () => {
    if (busy || activeRef.current) return;
    if (!validateSetup()) return;

    activeRef.current = true;
    setBusy(true);
    setResult(null);
    const batchId = `enroll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      for (let index = 0; index < BATCH_SAMPLE_COUNT; index += 1) {
        setStatusText(`Sample ${index + 1}/${BATCH_SAMPLE_COUNT}: speak naturally for ${ENROLLMENT_CAPTURE_MS / 1000} seconds…`);
        const uri = await recordClip(ENROLLMENT_CAPTURE_MS);
        setStatusText(`Uploading sample ${index + 1}/${BATCH_SAMPLE_COUNT}…`);
        const payload = await uploadClip(uri, '/api/v1/enrollments/batch-samples', {
          rider_id: riderId.trim(),
          batch_id: batchId,
          sample_index: String(index),
        });
        if (index === BATCH_SAMPLE_COUNT - 1) {
          const enrollment = payload.enrollment as Record<string, unknown> | undefined;
          setStatusText(`Five-sample baseline saved for ${String(enrollment?.rider_id ?? riderId.trim())}.`);
        }
      }
    } catch (error) {
      if (activeRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        try { await recorder.stop(); } catch { /* recorder may not have started */ }
      }
      setStatusText('Capture or upload failed');
      Alert.alert('Five-sample enrollment failed', error instanceof Error ? error.message : 'Unexpected capture error.');
    } finally {
      activeRef.current = false;
      setBusy(false);
    }
  };

  const captureCall = async () => {
    if (busy || activeRef.current) return;
    if (!validateSetup()) return;
    activeRef.current = true;
    setBusy(true);
    setResult(null);
    try {
      setStatusText(`Recording Call Customer sample for ${BATCH_CAPTURE_MS / 1000} seconds…`);
      const uri = await recordClip(BATCH_CAPTURE_MS);
      setStatusText('Comparing this voice with the five-sample baseline…');
      const payload = await uploadClip(uri, '/api/v1/voice-check', {
        rider_id: riderId.trim(),
        shift_id: shiftId,
        call_label: `Call #${callNumber}`,
      });
      setResult(payload as ApiResponse);
      onResult?.(payload as ApiResponse);
      setStatusText('Call Customer analysis complete');
      setCallNumber((current) => (current % 4) + 1);
    } catch (error) {
      if (activeRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        try { await recorder.stop(); } catch { /* recorder may not have started */ }
      }
      setStatusText('Capture or upload failed');
      Alert.alert('Voice check failed', error instanceof Error ? error.message : 'Unexpected capture error.');
    } finally {
      activeRef.current = false;
      setBusy(false);
    }
  };

  const verdictColor = result?.verdict === 'verified' ? '#147d53'
    : result?.verdict === 'alert' ? '#ba3038'
      : result?.verdict === 'step_up' ? '#a96800' : '#526579';

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>RIDER VOICE CHECK</Text>
        <Text style={styles.title}>Active delivery</Text>
        <Text style={styles.subtitle}>Build a five-clip rider baseline, then check each Call Customer sample against it.</Text>

        <View style={styles.card}>
          <Text style={styles.label}>ACCOUNT HOLDER</Text>
          <Text style={styles.modelName}>{riderId} · next shift slot: Call #{callNumber}</Text>
          <Pressable disabled={busy || !permissionGranted} onPress={() => void captureEnrollmentBatch()} style={[styles.buttonSecondary, (busy || !permissionGranted) && styles.buttonDisabled]}>
            <Text style={styles.buttonSecondaryText}>Enroll Five Voice Samples · 5 × 10s</Text>
          </Pressable>
          <Text style={styles.helper}>Record five separate 10-second clips from the enrolled rider. Use a different natural sentence in each clip. Then tap Call Customer to compare a new voice sample with the full baseline.</Text>
          <Pressable disabled={busy || !permissionGranted} onPress={() => void captureCall()} style={[styles.button, (busy || !permissionGranted) && styles.buttonDisabled]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Call Customer · Record 8s</Text>}
          </Pressable>
          <Text style={styles.status}>{statusText}</Text>
        </View>

        {result && (
          <View style={[styles.resultCard, { borderColor: verdictColor }]}>
            <View style={[styles.banner, { backgroundColor: verdictColor }]}>
              <Text style={styles.bannerText}>{result.verdict.replace('_', ' ').toUpperCase()}</Text>
            </View>
            <View style={[styles.speakerVerdict, { borderColor: speakerVerdict.color }]}>
              <Text style={styles.metricLabel}>RIDER VOICE MATCH</Text>
              <Text style={[styles.speakerVerdictText, { color: speakerVerdict.color }]}>{speakerVerdict.label}</Text>
              <Text style={styles.layerReason}>{speakerVerdict.description}</Text>
            </View>
            <View style={styles.metrics}>
              <Metric label="Median similarity · 5 samples" value={formatScore(result.kyc_similarity)} />
              <Metric label="Similarity spread" value={formatScore(result.sample_score_spread)} />
              <Metric label="Shift similarity" value={result.shift_similarity == null ? 'Run Call #1 first' : formatScore(result.shift_similarity)} />
              <Metric label="VAD removed" value={result.vad_noise_reduction_pct == null ? '—' : `${result.vad_noise_reduction_pct.toFixed(1)}%`} />
              <Metric label="Detected speech" value={result.speech_duration_seconds == null ? '—' : `${result.speech_duration_seconds.toFixed(1)}s`} />
              {result.sample_scores.map((score, index) => (
                <Metric key={index} label={`Enrollment clip ${index + 1}`} value={formatScore(score)} />
              ))}
            </View>
            <Text style={styles.label}>SPEAKER MODEL</Text>
            <Text style={styles.modelName}>{result.speaker_model}</Text>
            {Object.entries(result.layers).map(([name, layer]) => (
              <View key={name} style={styles.layerRow}>
                <Text style={[styles.layerName, { color: layerColor(layer.status) }]}>{name.replaceAll('_', ' ')} · {layer.status}</Text>
                <Text style={styles.layerReason}>{layer.reason}</Text>
              </View>
            ))}
          </View>
        )}
        <Text style={styles.footnote}>Voice is one account-sharing signal. No customer PIN or OTP is requested or checked.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text></View>;
}

function formatScore(value: number | null | undefined) {
  return value == null ? '—' : value.toFixed(3);
}

function getSpeakerVerdict(status: string, overallVerdict?: ApiResponse['verdict']) {
  if (overallVerdict === 'step_up') {
    return {
      label: 'UNCERTAIN · STEP-UP',
      description: status === 'warn'
        ? 'The voice match is marginal. Review the similarity and use an approved in-app step-up.'
        : 'The overall check needs a step-up. Treat the rider match as unconfirmed until it is resolved.',
      color: '#a96800',
    };
  }
  if (status === 'passed') {
    return { label: 'SAME SPEAKER LIKELY', description: 'The sample matches the enrolled rider voice above the demo threshold.', color: '#147d53' };
  }
  if (status === 'warn') {
    return { label: 'UNCERTAIN · STEP-UP', description: 'The voice match is marginal. Review the similarity and use an approved in-app step-up.', color: '#a96800' };
  }
  if (status === 'alert' || status === 'failed') {
    return { label: 'VOICE MISMATCH SUSPECTED', description: 'The sample is below the demo match threshold; this is a signal for review, not proof of account sharing.', color: '#ba3038' };
  }
  return { label: 'NOT COMPARED', description: 'No enrolled KYC baseline was available for this rider.', color: '#526579' };
}

function layerColor(status: string) {
  if (status === 'passed') return '#147d53';
  if (status === 'alert' || status === 'failed') return '#ba3038';
  if (status === 'warn') return '#a96800';
  return '#526579';
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0F172A' },
  page: { padding: 22, paddingBottom: 38 },
  eyebrow: { color: '#38BDF8', fontWeight: '800', letterSpacing: 1.8, fontSize: 11, marginTop: 12 },
  title: { color: '#F8FAFC', fontSize: 27, fontWeight: '800', marginTop: 7 },
  subtitle: { color: '#94A3B8', fontSize: 13, lineHeight: 20, marginTop: 5, marginBottom: 20 },
  card: { backgroundColor: '#111C2E', borderColor: '#263449', borderWidth: 1, borderRadius: 18, padding: 18 },
  label: { color: '#94A3B8', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  labelGap: { marginTop: 16 },
  input: { color: '#F8FAFC', backgroundColor: '#0F172A', borderRadius: 10, borderWidth: 1, borderColor: '#334155', marginTop: 7, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15 },
  button: { backgroundColor: '#2563EB', borderRadius: 12, marginTop: 18, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  buttonSecondary: { backgroundColor: '#1E293B', borderColor: '#334155', borderWidth: 1, borderRadius: 12, marginTop: 16, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  buttonSecondaryText: { color: '#BFDBFE', fontSize: 13, fontWeight: '800' },
  buttonDisabled: { opacity: 0.55 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  status: { color: '#94A3B8', fontSize: 12, textAlign: 'center', marginTop: 11 },
  helper: { color: '#94A3B8', fontSize: 11, lineHeight: 16, marginTop: 8 },
  resultCard: { backgroundColor: '#111C2E', borderWidth: 1, borderRadius: 18, marginTop: 18, overflow: 'hidden', paddingBottom: 15 },
  banner: { paddingVertical: 13, paddingHorizontal: 17 },
  bannerText: { color: '#fff', fontSize: 16, fontWeight: '900', letterSpacing: 1 },
  speakerVerdict: { marginHorizontal: 14, marginTop: 14, padding: 12, borderWidth: 1, borderRadius: 11, backgroundColor: '#0F172A' },
  speakerVerdictText: { fontSize: 16, fontWeight: '900', marginTop: 4 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', padding: 14, paddingBottom: 5 },
  metric: { width: '50%', marginBottom: 12 },
  metricLabel: { color: '#94A3B8', fontSize: 11 },
  metricValue: { color: '#F8FAFC', fontWeight: '800', marginTop: 3, fontSize: 14 },
  modelName: { color: '#CBD5E1', fontSize: 12, lineHeight: 18, marginHorizontal: 14, marginTop: 7, marginBottom: 12 },
  layerRow: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#334155', paddingHorizontal: 14, paddingVertical: 9 },
  layerName: { color: '#CBD5E1', fontWeight: '800', fontSize: 12, textTransform: 'capitalize' },
  layerReason: { color: '#94A3B8', fontSize: 11, lineHeight: 16, marginTop: 3 },
  footnote: { textAlign: 'center', color: '#64748B', fontSize: 11, lineHeight: 17, marginTop: 18, paddingHorizontal: 18 },
});
