import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, PanResponder, Pressable, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';

type GestureSample = {
  duration_ms: number;
  curve: [number, number, number, number];
  vertical_drift: number;
  tilt_delta: number;
};
type ContextTelemetry = {
  ip: string | null; device_id: string; lat: number | null; lon: number | null;
  login_time: string; timestamp: number; simulated: false; risk_flags: string[];
};
type ContextAssessment = {
  baseline: boolean; status: 'baseline' | 'normal' | 'review' | 'alert';
  risk_flags: string[]; changes: Record<string, boolean>; previous_session_at?: string | null;
};
type GestureAssessment = { status: 'pending' | 'passed' | 'warn' | 'alert'; failed_features: string[]; features_within_range: number; reason: string };
type VoiceAssessment = { verdict: 'pending' | 'verified' | 'step_up' | 'alert'; kyc_similarity: number | null; sample_scores?: number[]; speech_duration_seconds?: number | null; layers: Record<string, { status: string; reason: string }> };
type SignalStatus = 'pending' | 'passed' | 'warn' | 'alert';

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');
const ENROLLMENT_COUNT = 5;
const ENROLLMENT_MS = 8_000;
const CALL_MS = 8_000;
const TRACK_WIDTH = 280;

export default function App() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioBusyRef = useRef(false);
  const [riderId, setRiderId] = useState('rider-demo-01');
  const [shiftId] = useState(() => `shift-${new Date().toISOString().slice(0, 10)}`);
  const [voicePermission, setVoicePermission] = useState(false);
  const [context, setContext] = useState<ContextTelemetry | null>(null);
  const [contextResult, setContextResult] = useState<ContextAssessment | null>(null);
  const [contextStatus, setContextStatus] = useState('Not captured');
  const [contextBusy, setContextBusy] = useState(false);
  const [gestureProfile, setGestureProfile] = useState(false);
  const [gestureSamples, setGestureSamples] = useState<GestureSample[]>([]);
  const [gestureMode, setGestureMode] = useState<'idle' | 'enroll' | 'check'>('idle');
  const [gestureStatus, setGestureStatus] = useState<SignalStatus>('pending');
  const [gestureResult, setGestureResult] = useState<GestureAssessment | null>(null);
  const [voiceEnrolled, setVoiceEnrolled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('Voice baseline not enrolled');
  const [voiceResult, setVoiceResult] = useState<VoiceAssessment | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyText, setBusyText] = useState('');
  const [notice, setNotice] = useState('');
  const [callNumber, setCallNumber] = useState(1);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!mounted) return;
        setVoicePermission(permission.granted);
        if (permission.granted) await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      } catch {
        if (mounted) setVoiceStatus('Microphone permission unavailable');
      }
    })();
    return () => {
      mounted = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (audioBusyRef.current) void recorder.stop().catch(() => undefined);
    };
  }, [recorder]);

  useEffect(() => {
    if (!riderId.trim() || !API_BASE_URL) return;
    let active = true;
    void fetch(`${API_BASE_URL}/api/v1/gesture-baselines/${encodeURIComponent(riderId.trim())}`)
      .then((response) => response.json())
      .then((result) => {
        if (!active) return;
        setGestureProfile(Boolean(result.enrolled));
        if (result.enrolled) setGestureStatus('pending');
      })
      .catch(() => undefined);
    void fetch(`${API_BASE_URL}/api/v1/enrollments/${encodeURIComponent(riderId.trim())}`)
      .then((response) => response.json())
      .then((result) => { if (active) setVoiceEnrolled(Boolean(result.enrolled)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [riderId]);

  const signalStatuses = useMemo(() => {
    const contextSignal: SignalStatus = contextResult?.status === 'alert' ? 'alert' : contextResult?.status === 'review' ? 'warn' : contextResult ? 'passed' : 'pending';
    const voiceSignal: SignalStatus = voiceResult?.verdict === 'alert' ? 'alert' : voiceResult?.verdict === 'step_up' ? 'warn' : voiceResult?.verdict === 'verified' ? 'passed' : 'pending';
    return [contextSignal, gestureStatus, voiceSignal];
  }, [contextResult, gestureStatus, voiceResult]);
  const concernCount = signalStatuses.filter((status) => status === 'warn' || status === 'alert').length;
  const allComplete = signalStatuses.every((status) => status === 'passed');
  const overallTitle = concernCount >= 2 ? 'CROSS-SIGNAL REVIEW' : concernCount === 1 ? 'ONE SIGNAL NEEDS REVIEW' : allComplete ? 'SESSION MATCHES BASELINE' : contextResult?.baseline ? 'BASELINE STARTED' : 'BUILD ACCOUNT BASELINE';
  const overallColor = concernCount > 0 ? '#F59E0B' : allComplete ? '#10B981' : '#38BDF8';

  const ensureSetup = () => {
    if (!riderId.trim()) { setNotice('Enter the rider ID before creating or checking a profile.'); return false; }
    if (!API_BASE_URL) { setNotice('Set EXPO_PUBLIC_API_BASE_URL in mobile/.env to the FastAPI address reachable from this phone.'); return false; }
    setNotice('');
    return true;
  };

  const captureContext = async (): Promise<ContextTelemetry> => {
    let ip: string | null = null;
    let lat: number | null = null;
    let lon: number | null = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
        if (response.ok) ip = (await response.json()).ip ?? null;
      } finally { clearTimeout(timeout); }
    } catch { /* Keep network information explicitly unavailable. */ }
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.granted) {
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        lat = Number(position.coords.latitude.toFixed(6));
        lon = Number(position.coords.longitude.toFixed(6));
      }
    } catch { /* Location can be unavailable without blocking the session. */ }
    const deviceId = [Device.brand, Device.modelName, Device.osName, Device.osVersion].filter(Boolean).join('_') || 'device-unavailable';
    return { ip, device_id: deviceId, lat, lon, login_time: new Date().toLocaleTimeString(), timestamp: Date.now(), simulated: false, risk_flags: [] };
  };

  const submitContext = async () => {
    if (!ensureSetup() || contextBusy || busy) return;
    setContextBusy(true);
    setContextStatus('Reading device, network, and location…');
    try {
      const snapshot = await captureContext();
      setContext(snapshot);
      const response = await fetch(`${API_BASE_URL}/api/v1/account-sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rider_id: riderId.trim(), session_id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, telemetry: snapshot }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? `Backend returned ${response.status}`);
      setContextResult(payload as ContextAssessment);
      setContextStatus(payload.baseline ? 'First account context saved' : payload.status === 'normal' ? 'Compared with last session' : 'Context changes found');
    } catch (error) {
      setContextStatus('Context check could not complete');
      setNotice(error instanceof Error ? error.message : 'Could not submit account context.');
    } finally { setContextBusy(false); }
  };

  const submitGestureBaseline = async (samples: GestureSample[]) => {
    const response = await fetch(`${API_BASE_URL}/api/v1/gesture-baselines/${encodeURIComponent(riderId.trim())}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ samples }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail ?? `Backend returned ${response.status}`);
    setGestureProfile(true);
    setGestureStatus('passed');
    setGestureResult({ status: 'passed', failed_features: [], features_within_range: 7, reason: 'Three-swipe account-holder baseline saved on the backend' });
    setGestureMode('idle');
  };

  const submitGestureCheck = async (sample: GestureSample) => {
    const response = await fetch(`${API_BASE_URL}/api/v1/gesture-checks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rider_id: riderId.trim(), sample }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail ?? `Backend returned ${response.status}`);
    setGestureResult(payload as GestureAssessment);
    setGestureStatus(payload.status === 'passed' ? 'passed' : payload.status === 'alert' ? 'alert' : 'warn');
    setGestureMode('idle');
  };

  const onGesture = async (sample: GestureSample) => {
    if (gestureMode === 'idle') return;
    try {
      if (gestureMode === 'check') {
        setNotice('Comparing swipe features with the account-holder baseline…');
        await submitGestureCheck(sample);
      } else {
        const updated = [...gestureSamples, sample];
        setGestureSamples(updated);
        if (updated.length === 3) {
          setNotice('Saving the three-swipe baseline…');
          await submitGestureBaseline(updated);
          setGestureSamples([]);
        }
      }
      setNotice('');
    } catch (error) {
      setGestureMode('idle');
      setNotice(error instanceof Error ? error.message : 'Swipe profile operation failed.');
    }
  };

  const recordClip = async (durationMs: number) => {
    await recorder.prepareToRecordAsync(RecordingPresets.HIGH_QUALITY);
    recorder.record();
    await new Promise<void>((resolve) => { timerRef.current = setTimeout(resolve, durationMs); });
    timerRef.current = null;
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri) throw new Error('Recorder did not produce an audio file.');
    return uri;
  };

  const uploadClip = async (uri: string, endpoint: string, parameters: Record<string, string>) => {
    const response = await FileSystem.uploadAsync(`${API_BASE_URL}${endpoint}`, uri, {
      httpMethod: 'POST', uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'audio', mimeType: 'audio/mp4', parameters,
    });
    let payload: Record<string, any> = {};
    try { payload = JSON.parse(response.body); } catch { /* handled as an HTTP failure below */ }
    if (response.status < 200 || response.status >= 300) throw new Error(payload.detail ?? `Backend returned ${response.status}`);
    return payload;
  };

  const runVoiceEnrollment = async () => {
    if (!ensureSetup() || !voicePermission || busy) {
      if (!voicePermission) setNotice('Allow microphone access before enrolling account-holder voice.');
      return;
    }
    audioBusyRef.current = true;
    setBusy(true);
    setVoiceResult(null);
    const batchId = `enroll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      for (let index = 0; index < ENROLLMENT_COUNT; index += 1) {
        setBusyText(`Voice enrollment ${index + 1}/${ENROLLMENT_COUNT}: speak naturally for ${ENROLLMENT_MS / 1000} seconds`);
        const uri = await recordClip(ENROLLMENT_MS);
        await uploadClip(uri, '/api/v1/enrollments/batch-samples', { rider_id: riderId.trim(), batch_id: batchId, sample_index: String(index) });
      }
      setVoiceEnrolled(true);
      setVoiceStatus('Account-holder voice baseline saved');
      setNotice('');
    } catch (error) {
      setVoiceStatus('Voice enrollment did not complete');
      setNotice(error instanceof Error ? error.message : 'Voice enrollment failed.');
    } finally {
      audioBusyRef.current = false;
      setBusy(false);
      setBusyText('');
    }
  };

  const runVoiceCheck = async () => {
    if (!ensureSetup() || !voicePermission || busy) {
      if (!voicePermission) setNotice('Allow microphone access before checking voice.');
      return;
    }
    audioBusyRef.current = true;
    setBusy(true);
    try {
      setBusyText(`Record a voice sample for ${CALL_MS / 1000} seconds…`);
      const uri = await recordClip(CALL_MS);
      setBusyText('Comparing speaker sample with the account-holder baseline…');
      const payload = await uploadClip(uri, '/api/v1/voice-check', { rider_id: riderId.trim(), shift_id: shiftId, call_label: `Call #${callNumber}` }) as VoiceAssessment;
      setVoiceResult(payload);
      setVoiceEnrolled(true);
      const speakerStatus = payload.layers?.kyc_speaker_match?.status;
      const speakerText = speakerStatus === 'passed' ? 'Speaker matches account-holder enrollment' : speakerStatus === 'warn' ? 'Speaker match is uncertain' : speakerStatus === 'alert' || speakerStatus === 'failed' ? 'Speaker does not match enrollment' : 'No account-holder voice baseline found';
      const otherConcern = Object.entries(payload.layers ?? {}).some(([name, layer]) => name !== 'kyc_speaker_match' && ['warn', 'alert', 'failed'].includes(layer.status));
      setVoiceStatus(otherConcern && speakerStatus === 'passed' ? `${speakerText}; another voice layer needs review` : speakerText);
      setCallNumber((number) => (number % 4) + 1);
      setNotice('');
    } catch (error) {
      setVoiceStatus('Voice check did not complete');
      setNotice(error instanceof Error ? error.message : 'Voice check failed.');
    } finally {
      audioBusyRef.current = false;
      setBusy(false);
      setBusyText('');
    }
  };

  const setAccount = (value: string) => {
    setRiderId(value);
    setContext(null); setContextResult(null); setContextStatus('Not captured');
    setGestureProfile(false); setGestureSamples([]); setGestureMode('idle'); setGestureStatus('pending'); setGestureResult(null);
    setVoiceEnrolled(false); setVoiceResult(null); setVoiceStatus('Voice baseline not enrolled');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.topLine}><View><Text style={styles.eyebrow}>HACK FORGE  /  TRUST OPERATIONS</Text><Text style={styles.title}>Rider account integrity</Text></View><View style={styles.liveBadge}><View style={styles.liveDot} /><Text style={styles.liveText}>DEMO</Text></View></View>
        <Text style={styles.intro}>Can this session be linked to the account holder? Compare sign-in context, swipe behavior, and voice against one rider profile.</Text>

        <View style={styles.accountBar}><View style={{ flex: 1 }}><Text style={styles.label}>RIDER PROFILE</Text><TextInput value={riderId} onChangeText={setAccount} editable={!busy && !contextBusy && gestureMode === 'idle'} autoCapitalize="none" style={styles.input} /></View><View style={styles.shiftMeta}><Text style={styles.label}>SHIFT</Text><Text style={styles.shiftValue}>{shiftId.replace('shift-', '')}</Text></View></View>

        <View style={styles.overallCard}>
          <View style={styles.overallHeader}><Text style={styles.sectionEyebrow}>SESSION ASSESSMENT</Text><Text style={[styles.overallStatus, { color: overallColor }]}>{overallTitle}</Text></View>
          <Text style={styles.body}>A single change raises a review signal. Multiple independent changes create a stronger handoff concern.</Text>
          <View style={styles.statusRow}>
            <StatusChip label="CONTEXT" status={signalStatuses[0]} />
            <StatusChip label="SWIPE" status={signalStatuses[1]} />
            <StatusChip label="VOICE" status={signalStatuses[2]} />
          </View>
        </View>

        <Text style={styles.sectionTitle}>1  /  ACCOUNT HOLDER BASELINE</Text>
        <SignalPanel number="01" title="Sign-in context" subtitle="Compare this phone, public IP, and location with the rider’s previous session." status={contextStatus} statusType={contextResult?.status === 'alert' ? 'alert' : contextResult?.status === 'review' ? 'warn' : contextResult ? 'passed' : 'pending'}>
          {context && <Text style={styles.detailText}>{context.device_id}{'\n'}IP {context.ip ?? 'unavailable'}  ·  GPS {context.lat == null ? 'unavailable' : `${context.lat.toFixed(4)}, ${context.lon?.toFixed(4)}`}</Text>}
          {contextResult && !contextResult.baseline && <Text style={styles.detailText}>{contextResult.risk_flags.join('  /  ') || 'No account context changes found'}</Text>}
          <ActionButton disabled={contextBusy || busy} onPress={() => void submitContext()}>{contextBusy ? 'Reading session…' : contextResult?.baseline ? 'Check a new sign-in' : 'Capture / compare sign-in'}</ActionButton>
        </SignalPanel>

        <SignalPanel number="02" title="Swipe pattern" subtitle="The backend learns timing, swipe path, vertical drift, and phone tilt from three natural gestures." status={gestureResult?.reason ?? (gestureProfile ? 'Pattern baseline available' : `${gestureSamples.length}/3 calibration swipes`)} statusType={gestureStatus}>
          {gestureResult && <Text style={styles.detailText}>{gestureResult.failed_features.length ? `Changed features: ${gestureResult.failed_features.join(', ')}` : 'Saved pattern comparison ready.'}</Text>}
          {gestureMode === 'enroll' && <SwipeCapture onGesture={onGesture} prompt={`Calibration swipe ${gestureSamples.length + 1} of 3 · slide left to right`} />}
          {gestureMode === 'check' && <SwipeCapture onGesture={onGesture} prompt="New session check · slide left to right" />}
          <View style={styles.actionRow}>
            <ActionButton compact onPress={() => { setGestureSamples([]); setGestureMode('enroll'); setGestureStatus('pending'); setNotice(''); }} disabled={busy}>{gestureProfile ? 'Relearn baseline' : 'Calibrate 3 swipes'}</ActionButton>
            <ActionButton compact secondary onPress={() => { if (!gestureProfile) { setNotice('Calibrate the account holder’s swipe pattern first.'); return; } setGestureMode('check'); setNotice(''); }} disabled={busy || !gestureProfile}>Check swipe</ActionButton>
          </View>
        </SignalPanel>

        <SignalPanel number="03" title="Account-holder voice" subtitle="Enroll five varied clips, then compare a fresh call sample with the five reference embeddings." status={voiceStatus} statusType={voiceResult?.layers?.kyc_speaker_match?.status === 'alert' ? 'alert' : voiceResult?.layers?.kyc_speaker_match?.status === 'warn' ? 'warn' : voiceResult?.layers?.kyc_speaker_match?.status === 'passed' ? 'passed' : 'pending'}>
          {voiceResult && <Text style={styles.detailText}>Speaker match: {voiceResult.layers?.kyc_speaker_match?.status ?? 'pending'} · median similarity {voiceResult.kyc_similarity?.toFixed(3) ?? '—'} · {voiceResult.speech_duration_seconds?.toFixed(1) ?? '—'}s detected speech{voiceResult.sample_scores?.length ? `\nReference scores: ${voiceResult.sample_scores.map((score) => score.toFixed(3)).join(' · ')}` : ''} · similarity is not a probability</Text>}
          {busy && <View style={styles.busyRow}><ActivityIndicator color="#38BDF8" /><Text style={styles.busyText}>{busyText}</Text></View>}
          <View style={styles.actionRow}>
            <ActionButton compact disabled={busy || !voicePermission} onPress={() => void runVoiceEnrollment()}>{voiceEnrolled ? 'Re-enroll voice · 5 clips' : 'Enroll voice · 5 clips'}</ActionButton>
            <ActionButton compact secondary disabled={busy || !voicePermission || !voiceEnrolled} onPress={() => void runVoiceCheck()}>Check voice · 8s</ActionButton>
          </View>
          {!voicePermission && <Text style={styles.helper}>Microphone permission is required for voice steps.</Text>}
          {voiceResult && Object.entries(voiceResult.layers).map(([name, layer]) => <Text key={name} style={styles.detailText}>{name.replaceAll('_', ' ')} · {layer.status}: {layer.reason}</Text>)}
        </SignalPanel>

        {busy || notice ? <Text style={notice ? styles.notice : styles.busyText}>{notice || busyText}</Text> : null}
        <View style={styles.demoFooter}><Text style={styles.footerTitle}>DEMO STORY</Text><Text style={styles.body}>Enroll the rider on their usual phone, then have another person use the same account, make a swipe, and speak. Return to the assessment to see which independent signals changed. This is evidence for review, not proof of identity.</Text></View>
        <Text style={styles.privacyNote}>No customer PIN or OTP is requested. Account context and swipe baselines persist in local SQLite; voice enrollments clear when the backend restarts.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatusChip({ label, status }: { label: string; status: SignalStatus }) {
  const color = status === 'passed' ? '#10B981' : status === 'warn' ? '#F59E0B' : status === 'alert' ? '#EF4444' : '#64748B';
  return <View style={styles.chip}><View style={[styles.chipDot, { backgroundColor: color }]} /><Text style={styles.chipText}>{label} · {status.toUpperCase()}</Text></View>;
}

function SignalPanel({ number, title, subtitle, status, statusType, children }: { number: string; title: string; subtitle: string; status: string; statusType: SignalStatus | 'baseline' | 'normal'; children: ReactNode }) {
  const color = statusType === 'passed' || statusType === 'baseline' || statusType === 'normal' ? '#10B981' : statusType === 'warn' ? '#F59E0B' : statusType === 'alert' ? '#EF4444' : '#94A3B8';
  return <View style={styles.panel}><View style={styles.panelHead}><Text style={styles.panelNumber}>{number}</Text><View style={styles.panelCopy}><Text style={styles.panelTitle}>{title}</Text><Text style={styles.panelSubtitle}>{subtitle}</Text></View></View><Text style={[styles.panelStatus, { color }]}>{status}</Text>{children}</View>;
}

function ActionButton({ children, onPress, disabled, secondary, compact }: { children: string; onPress: () => void; disabled?: boolean; secondary?: boolean; compact?: boolean }) {
  return <Pressable disabled={disabled} onPress={onPress} style={[styles.button, secondary && styles.secondaryButton, compact && styles.compactButton, disabled && styles.disabled]}><Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{children}</Text></Pressable>;
}

function SwipeCapture({ onGesture, prompt }: { onGesture: (sample: GestureSample) => void; prompt: string }) {
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const callbackRef = useRef(onGesture);
  const promptRef = useRef(prompt);
  const pitchRef = useRef(0);
  const startPitchRef = useRef(0);
  const startTimeRef = useRef(0);
  const pointsRef = useRef<{ progress: number; y: number }[]>([]);
  useEffect(() => { callbackRef.current = onGesture; promptRef.current = prompt; }, [onGesture, prompt]);
  useEffect(() => {
    DeviceMotion.setUpdateInterval(50);
    const subscription = DeviceMotion.addListener((data) => { pitchRef.current = ((data.rotation?.beta ?? 0) * 180) / Math.PI; });
    return () => subscription.remove();
  }, []);
  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      setError(''); setProgress(0); startTimeRef.current = Date.now(); startPitchRef.current = pitchRef.current; pointsRef.current = [{ progress: 0, y: 0 }];
    },
    onPanResponderMove: (_, gesture) => {
      const p = clamp(gesture.dx / TRACK_WIDTH);
      setProgress(p); pointsRef.current.push({ progress: p, y: gesture.dy });
    },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx < TRACK_WIDTH * 0.65) { setProgress(0); setError('Swipe farther across the track, then release.'); return; }
      const curve = ([0.25, 0.5, 0.75, 0.95] as const).map((target) => nearestPoint(pointsRef.current, target)) as [number, number, number, number];
      const sample: GestureSample = { duration_ms: Math.max(100, Date.now() - startTimeRef.current), curve, vertical_drift: gesture.dy, tilt_delta: pitchRef.current - startPitchRef.current };
      setProgress(0); callbackRef.current(sample);
    },
    onPanResponderTerminate: () => setProgress(0),
  })).current;
  return <View style={styles.swipeBox}><Text style={styles.swipePrompt}>{error || promptRef.current}</Text><View {...responder.panHandlers} style={styles.swipeTrack}><View style={[styles.swipeProgress, { width: `${Math.max(12, progress * 100)}%` }]} /><View style={[styles.swipeThumb, { left: `${Math.max(0, Math.min(88, progress * 88))}%` }]}><Text style={styles.swipeChevron}>››</Text></View></View></View>;
}

function nearestPoint(points: { progress: number; y: number }[], target: number) {
  if (!points.length) return 0;
  return points.reduce((best, point) => Math.abs(point.progress - target) < Math.abs(best.progress - target) ? point : best).y;
}
function clamp(value: number) { return Math.max(0, Math.min(1, value)); }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0F172A' },
  page: { padding: 16, paddingBottom: 30, gap: 12 },
  topLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  eyebrow: { color: '#38BDF8', fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: '#F8FAFC', fontSize: 24, fontWeight: '900', marginTop: 4 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#064E3B', borderColor: '#10B981', borderWidth: 1, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 5 },
  liveDot: { width: 6, height: 6, borderRadius: 4, backgroundColor: '#10B981' }, liveText: { color: '#34D399', fontSize: 8, fontWeight: '900' },
  intro: { color: '#94A3B8', fontSize: 12, lineHeight: 18, marginTop: -5 },
  accountBar: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, backgroundColor: '#111C2E', borderWidth: 1, borderColor: '#263449', borderRadius: 13, padding: 12 },
  label: { color: '#64748B', fontSize: 8, fontWeight: '900', letterSpacing: 1.1 },
  input: { color: '#F8FAFC', backgroundColor: '#0F172A', borderColor: '#334155', borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginTop: 5, fontSize: 12 },
  shiftMeta: { width: 82, paddingBottom: 2 }, shiftValue: { color: '#CBD5E1', fontSize: 11, fontWeight: '700', marginTop: 8 },
  overallCard: { backgroundColor: '#111C2E', borderColor: '#334155', borderWidth: 1, borderRadius: 15, padding: 14 },
  overallHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 5 },
  sectionEyebrow: { color: '#94A3B8', fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  overallStatus: { fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },
  body: { color: '#94A3B8', fontSize: 10, lineHeight: 16, marginTop: 7 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 11 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#0F172A', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 5 }, chipDot: { width: 5, height: 5, borderRadius: 3 }, chipText: { color: '#CBD5E1', fontSize: 7, fontWeight: '900' },
  sectionTitle: { color: '#64748B', fontSize: 9, fontWeight: '900', letterSpacing: 1.3, marginTop: 5, marginBottom: -4 },
  panel: { backgroundColor: '#111C2E', borderWidth: 1, borderColor: '#263449', borderRadius: 14, padding: 13, gap: 8 },
  panelHead: { flexDirection: 'row', gap: 10 }, panelNumber: { color: '#38BDF8', fontSize: 10, fontWeight: '900', paddingTop: 2 }, panelCopy: { flex: 1 }, panelTitle: { color: '#F8FAFC', fontSize: 14, fontWeight: '800' }, panelSubtitle: { color: '#94A3B8', fontSize: 10, lineHeight: 15, marginTop: 3 },
  panelStatus: { fontSize: 10, fontWeight: '800' }, detailText: { color: '#CBD5E1', fontSize: 9, lineHeight: 14, backgroundColor: '#0F172A', padding: 8, borderRadius: 7, overflow: 'hidden' },
  button: { minHeight: 42, justifyContent: 'center', alignItems: 'center', backgroundColor: '#2563EB', borderRadius: 9, paddingHorizontal: 11 }, compactButton: { flex: 1 }, secondaryButton: { backgroundColor: '#1E293B', borderColor: '#334155', borderWidth: 1 }, disabled: { opacity: 0.45 }, buttonText: { color: '#F8FAFC', fontSize: 10, fontWeight: '900', textAlign: 'center' }, secondaryButtonText: { color: '#BFDBFE' }, actionRow: { flexDirection: 'row', gap: 8 },
  swipeBox: { backgroundColor: '#0F172A', borderColor: '#334155', borderWidth: 1, borderRadius: 10, padding: 10, gap: 8 }, swipePrompt: { color: '#CBD5E1', fontSize: 9, fontWeight: '700' }, swipeTrack: { height: 48, borderRadius: 10, backgroundColor: '#1E293B', justifyContent: 'center', overflow: 'hidden' }, swipeProgress: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#1D4ED8', opacity: 0.55 }, swipeThumb: { position: 'absolute', top: 4, width: 40, height: 40, borderRadius: 8, backgroundColor: '#38BDF8', alignItems: 'center', justifyContent: 'center' }, swipeChevron: { color: '#0F172A', fontSize: 23, fontWeight: '900', marginTop: -3 },
  busyRow: { flexDirection: 'row', gap: 8, alignItems: 'center' }, busyText: { color: '#94A3B8', fontSize: 10, flex: 1 }, helper: { color: '#64748B', fontSize: 9 }, notice: { color: '#FBBF24', backgroundColor: '#422006', borderRadius: 8, padding: 9, fontSize: 10, lineHeight: 15 },
  demoFooter: { backgroundColor: '#132238', borderColor: '#26466C', borderWidth: 1, borderRadius: 12, padding: 12 }, footerTitle: { color: '#93C5FD', fontSize: 8, fontWeight: '900', letterSpacing: 1 }, privacyNote: { color: '#64748B', fontSize: 8, lineHeight: 13, textAlign: 'center', paddingHorizontal: 10 },
});
