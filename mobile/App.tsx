import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { DeviceMotion, DeviceMotionMeasurement } from 'expo-sensors';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ---------------------------------------------------------------------------
// Types & API Interfaces
// ---------------------------------------------------------------------------
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

type EnrollmentStatus = {
  rider_id: string;
  enrolled: boolean;
  sample_count: number;
  created_at: string | null;
  has_previous_baseline: boolean;
  previous_created_at: string | null;
  similarity_with_previous: number | null;
  re_enrollment_verdict: string | null;
};

export interface MetricEnvelope {
  min: number;
  max: number;
  margin: number;
  envMin: number;
  envMax: number;
  mean: number;
}

export interface SliderBaselineProfile {
  name: string;
  baselineCurve: [number, number, number, number];
  curveEnvelopes: [MetricEnvelope, MetricEnvelope, MetricEnvelope, MetricEnvelope];
  baselinePitchPush: number;
  pitchPushEnvelope: MetricEnvelope;
  baselineSymmetry: number;
  symmetryEnvelope: MetricEnvelope;
  baselineLiftoffVy: number;
  liftoffVyEnvelope: MetricEnvelope;
  calibratedAt: string;
  isCustom: boolean;
}

export interface LiveSliderMetrics {
  curve: [number, number, number, number];
  curveCheckpointsPassed: number;
  failedCurvePoints: number[];
  isCurveFailed: boolean;
  pitchAtStart: number;
  pitchAtEnd: number;
  pitchDelta: number;
  isPitchPushFailed: boolean;
  midpointTimeMs: number;
  totalTimeMs: number;
  symmetryRatio: number;
  isSymmetryFailed: boolean;
  liftoffVy: number;
  isLiftoffFailed: boolean;
  isRejected: boolean;
  confidencePct: number;
  failedMetrics: string[];
}

// ---------------------------------------------------------------------------
// Configuration & Defaults
// ---------------------------------------------------------------------------
const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://10.125.167.137:8000').replace(/\/$/, '');
const BATCH_SAMPLE_COUNT = 5;
const BATCH_CAPTURE_MS = 8_000;
const ENROLLMENT_CAPTURE_MS = 10_000;

export const SLIDER_WIDTH = Math.min(SCREEN_WIDTH - 44, 340);
export const SLIDER_HEIGHT = 58;
export const SLIDER_THUMB_SIZE = 50;
export const MAX_SLIDE = SLIDER_WIDTH - SLIDER_THUMB_SIZE - 8;

export function computeEnvelope(values: number[], minBaseMargin: number, decimals: number = 2): MetricEnvelope {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const rawMargin = (max - min) * 1.5;
  const margin = Math.max(minBaseMargin, rawMargin);
  const envMin = Number((min - margin).toFixed(decimals));
  const envMax = Number((max + margin).toFixed(decimals));
  return {
    min: Number(min.toFixed(decimals)),
    max: Number(max.toFixed(decimals)),
    margin: Number(margin.toFixed(decimals)),
    envMin,
    envMax,
    mean: Number(mean.toFixed(decimals)),
  };
}

const DEFAULT_SLIDER_BASELINE: SliderBaselineProfile = {
  name: 'Enrolled KYC Baseline (Rider-01)',
  baselineCurve: [-2.0, -8.5, -6.2, 1.2],
  curveEnvelopes: [
    { min: -3.5, max: -0.5, margin: 3.5, envMin: -7.0, envMax: 3.0, mean: -2.0 },
    { min: -11.0, max: -6.0, margin: 3.5, envMin: -14.5, envMax: -2.5, mean: -8.5 },
    { min: -9.0, max: -3.5, margin: 3.5, envMin: -12.5, envMax: 0.0, mean: -6.2 },
    { min: -0.5, max: 2.8, margin: 3.5, envMin: -4.0, envMax: 6.3, mean: 1.2 },
  ],
  baselinePitchPush: 2.1,
  pitchPushEnvelope: { min: 1.2, max: 3.1, margin: 1.25, envMin: -0.05, envMax: 4.35, mean: 2.1 },
  baselineSymmetry: 0.375,
  symmetryEnvelope: { min: 0.33, max: 0.42, margin: 0.08, envMin: 0.25, envMax: 0.50, mean: 0.375 },
  baselineLiftoffVy: -0.320,
  liftoffVyEnvelope: { min: -0.55, max: -0.15, margin: 0.25, envMin: -0.80, envMax: 0.10, mean: -0.320 },
  calibratedAt: 'Enrolled KYC Baseline (Arnav Nisal)',
  isCustom: false,
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function App() {
  // Navigation: screen 1 = active_delivery (call customer), screen 2 = complete_delivery
  const [currentScreen, setCurrentScreen] = useState<'active_delivery' | 'complete_delivery'>('active_delivery');

  // Audio & Voice check state
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [riderId, setRiderId] = useState('rider-demo-01');
  const [shiftId] = useState(() => `shift-demo-${new Date().toISOString().slice(0, 10)}`);
  const [callNumber, setCallNumber] = useState(1);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('Requesting microphone access…');
  const [result, setResult] = useState<ApiResponse | null>(null);

  // Persistent baseline info
  const [enrollmentStatus, setEnrollmentStatus] = useState<EnrollmentStatus | null>(null);
  const [lastEnrollmentComparison, setLastEnrollmentComparison] = useState<{
    similarity: number | null;
    verdict: string | null;
    previousTime: string | null;
  } | null>(null);

  // Screen 2: Location & Device ID state
  const [isMockLocation, setIsMockLocation] = useState(false);
  const [isRogueDevice, setIsRogueDevice] = useState(false);
  const [locationLabel, setLocationLabel] = useState('Bandra West, Mumbai (Authentic)');
  const [coordinates, setCoordinates] = useState({ lat: 19.1031, lon: 72.8402 });
  const [speedKmh, setSpeedKmh] = useState(24.5);
  const [deviceId, setDeviceId] = useState('SM-G998B_Android_14_OEM');
  const [alertDispatched, setAlertDispatched] = useState<string | null>(null);
  const [orderCompletedBanner, setOrderCompletedBanner] = useState(false);

  // Slider Biometrics State
  const [sliderBaseline, setSliderBaseline] = useState<SliderBaselineProfile>(DEFAULT_SLIDER_BASELINE);
  const [lastSliderResult, setLastSliderResult] = useState<LiveSliderMetrics | null>(null);
  const [sliderBanner, setSliderBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Slider Calibration / Enrollment Modal
  const [isCalibratingSlider, setIsCalibratingSlider] = useState(false);
  const [calibrationStep, setCalibrationStep] = useState(0); // 0, 1, 2
  const calibrationSwipesRef = useRef<{
    curves: [number, number, number, number][];
    pitches: number[];
    symmetries: number[];
    liftoffs: number[];
  }>({ curves: [], pitches: [], symmetries: [], liftoffs: [] });

  // Slider Pan & Animation
  const panX = useRef(new Animated.Value(0)).current;
  const calibPanX = useRef(new Animated.Value(0)).current;
  const startYRef = useRef(0);
  const startTimeRef = useRef(0);
  const smoothYRef = useRef<number | null>(null);
  const trajectoryRef = useRef<{ progress: number; relY: number; time: number; pitch: number }[]>([]);

  // IMU sensor readings
  const currentPitchRef = useRef(2.1);
  const isSensorInitRef = useRef(false);

  // -------------------------------------------------------------------------
  // Sensor Initialization (expo-sensors DeviceMotion)
  // -------------------------------------------------------------------------
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    void (async () => {
      try {
        const available = await DeviceMotion.isAvailableAsync();
        if (available) {
          DeviceMotion.setUpdateInterval(25);
          sub = DeviceMotion.addListener((data: DeviceMotionMeasurement) => {
            const rawPitch = ((data.rotation?.beta ?? 0) * 180) / Math.PI;
            if (!isSensorInitRef.current) {
              currentPitchRef.current = rawPitch;
              isSensorInitRef.current = true;
            } else {
              currentPitchRef.current = 0.25 * rawPitch + 0.75 * currentPitchRef.current;
            }
          });
        }
      } catch {
        // Fallback gracefully on simulator
      }
    })();
    return () => {
      sub?.remove();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Mic Permission & Baseline Status Loading
  // -------------------------------------------------------------------------
  const fetchBaselineStatus = useCallback(async (rider: string) => {
    if (!API_BASE_URL) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/enrollments/${rider.trim()}`);
      if (res.ok) {
        const data = (await res.json()) as EnrollmentStatus;
        setEnrollmentStatus(data);
        if (data.has_previous_baseline) {
          setLastEnrollmentComparison({
            similarity: data.similarity_with_previous,
            verdict: data.re_enrollment_verdict,
            previousTime: data.previous_created_at,
          });
        }
      }
    } catch {
      // Backend may be offline
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!mounted) return;
        setPermissionGranted(permission.granted);
        setStatusText(permission.granted ? 'Microphone ready' : 'Microphone permission required');
        if (permission.granted) {
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        }
      } catch {
        if (mounted) setStatusText('Could not initialize microphone access');
      }
    })();
    void fetchBaselineStatus(riderId);
    return () => {
      mounted = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (activeRef.current) void recorder.stop().catch(() => undefined);
    };
  }, [recorder, fetchBaselineStatus, riderId]);

  // -------------------------------------------------------------------------
  // Telemetry & Alert Dispatcher (sends to backend -> Dashboard WebSocket)
  // -------------------------------------------------------------------------
  const sendAlertToDashboard = async (
    eventType: 'SUDDEN_LOCATION_CHANGE' | 'DEVICE_ID_CHANGE' | 'SLIDER_BIOMETRIC_FAIL' | 'SLIDER_BIOMETRIC_PASS' | 'SET_CURRENT_LOCATION',
    customData?: Record<string, unknown>
  ) => {
    const payload = {
      trigger_event: eventType,
      rider_id: riderId,
      timestamp: new Date().toISOString(),
      stage_1_network_gps: {
        is_impossible_travel: isMockLocation || eventType === 'SUDDEN_LOCATION_CHANGE',
        mock_location_detected: isMockLocation || eventType === 'SUDDEN_LOCATION_CHANGE',
        velocity_kmh: eventType === 'SUDDEN_LOCATION_CHANGE' ? 850.0 : speedKmh,
        distance_km: eventType === 'SUDDEN_LOCATION_CHANGE' ? 840.2 : 0.8,
        latitude: coordinates.lat,
        longitude: coordinates.lon,
        device_id: deviceId,
      },
      stage_3_slider: lastSliderResult ? {
        curve: lastSliderResult.curve,
        pitch_delta: lastSliderResult.pitchDelta,
        symmetry_ratio: lastSliderResult.symmetryRatio,
        liftoff_vy: lastSliderResult.liftoffVy,
        is_rejected: lastSliderResult.isRejected,
        confidence_pct: lastSliderResult.confidencePct,
      } : null,
      ...customData,
    };

    try {
      const res = await fetch(`${API_BASE_URL}/api/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        console.log(`[ALERT DISPATCHED] Event: ${eventType} broadcast to dashboard`);
      }
    } catch {
      console.log(`[ALERT OFFLINE] Could not reach ${API_BASE_URL}/api/telemetry`);
    }
  };

  // -------------------------------------------------------------------------
  // Location & Hardware Controls
  // -------------------------------------------------------------------------
  const handleSetCurrentLocation = async () => {
    setIsMockLocation(false);
    setIsRogueDevice(false);
    setLocationLabel('Bandra West, Mumbai (Authentic)');
    setCoordinates({ lat: 19.1031, lon: 72.8402 });
    setSpeedKmh(24.5);
    setDeviceId('SM-G998B_Android_14_OEM');
    setAlertDispatched('✅ Current location & genuine device restored.');
    Vibration.vibrate(40);
    await sendAlertToDashboard('SET_CURRENT_LOCATION', {
      stage_1_network_gps: {
        is_impossible_travel: false,
        mock_location_detected: false,
        velocity_kmh: 24.5,
        distance_km: 0.1,
        latitude: 19.1031,
        longitude: 72.8402,
        device_id: 'SM-G998B_Android_14_OEM',
      },
    });
  };

  const handleSetMockLocation = async () => {
    setIsMockLocation(true);
    setLocationLabel('Bengaluru Hub, Karnataka (SPOOFED LEAP)');
    setCoordinates({ lat: 12.9716, lon: 77.5946 });
    setSpeedKmh(850.0);
    setAlertDispatched('🚨 Sudden Location Change: Teleport Alert Dispatched to Dashboard (850 km/h)!');
    Vibration.vibrate([0, 180, 80, 220]);
    await sendAlertToDashboard('SUDDEN_LOCATION_CHANGE', {
      stage_1_network_gps: {
        is_impossible_travel: true,
        mock_location_detected: true,
        velocity_kmh: 850.0,
        distance_km: 840.2,
        latitude: 12.9716,
        longitude: 77.5946,
        device_id: deviceId,
      },
    });
  };

  const handleToggleDeviceId = async () => {
    const nextRogue = !isRogueDevice;
    setIsRogueDevice(nextRogue);
    const newId = nextRogue ? 'ROGUE_EMULATOR_SPOOF_X86_ROOT' : 'SM-G998B_Android_14_OEM';
    setDeviceId(newId);
    if (nextRogue) {
      setAlertDispatched('⚠️ Alert Dispatched to Dashboard: Hardware Device ID Mismatch!');
      Vibration.vibrate([0, 150, 100, 150]);
      await sendAlertToDashboard('DEVICE_ID_CHANGE', {
        stage_1_network_gps: {
          is_impossible_travel: isMockLocation,
          mock_location_detected: isMockLocation,
          velocity_kmh: speedKmh,
          distance_km: 0.5,
          latitude: coordinates.lat,
          longitude: coordinates.lon,
          device_id: newId,
        },
      });
    } else {
      setAlertDispatched('✅ Genuine Device ID restored.');
      Vibration.vibrate(30);
      await sendAlertToDashboard('SET_CURRENT_LOCATION');
    }
  };

  // -------------------------------------------------------------------------
  // Audio Recording & Upload Helpers
  // -------------------------------------------------------------------------
  const validateSetup = () => {
    if (!permissionGranted) {
      Alert.alert('Microphone permission required', 'Allow microphone access in settings, then return.');
      return false;
    }
    if (!API_BASE_URL) {
      Alert.alert('Backend URL missing', 'Configure EXPO_PUBLIC_API_BASE_URL in mobile/.env');
      return false;
    }
    if (!riderId.trim()) {
      Alert.alert('Rider ID required', 'Enter the rider ID.');
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
        setStatusText(`Sample ${index + 1}/${BATCH_SAMPLE_COUNT}: speak naturally for ${ENROLLMENT_CAPTURE_MS / 1000}s…`);
        const uri = await recordClip(ENROLLMENT_CAPTURE_MS);
        setStatusText(`Uploading sample ${index + 1}/${BATCH_SAMPLE_COUNT}…`);
        const payload = await uploadClip(uri, '/api/v1/enrollments/batch-samples', {
          rider_id: riderId.trim(),
          batch_id: batchId,
          sample_index: String(index),
        });

        if (index === BATCH_SAMPLE_COUNT - 1) {
          const enrollment = payload.enrollment as Record<string, unknown> | undefined;
          const hasPrev = Boolean(enrollment?.has_previous_baseline);
          const simPrev = typeof enrollment?.similarity_with_previous === 'number' ? enrollment.similarity_with_previous : null;
          const prevTime = typeof enrollment?.previous_created_at === 'string' ? enrollment.previous_created_at : null;
          const reVerdict = typeof enrollment?.re_enrollment_verdict === 'string' ? enrollment.re_enrollment_verdict : null;

          if (hasPrev) {
            setLastEnrollmentComparison({
              similarity: simPrev,
              verdict: reVerdict,
              previousTime: prevTime,
            });
            setStatusText(`Baseline updated! (Similarity with previous: ${simPrev?.toFixed(3) ?? '—'} · ${reVerdict})`);
          } else {
            setStatusText(`Initial 5-sample baseline enrolled & saved to storage for ${riderId.trim()}.`);
          }
          await fetchBaselineStatus(riderId);
        }
      }
    } catch (error) {
      if (activeRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        try { await recorder.stop(); } catch {}
      }
      setStatusText('Capture or upload failed');
      Alert.alert('Enrollment failed', error instanceof Error ? error.message : 'Unexpected capture error.');
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
      setStatusText('Comparing voice with 5-sample baseline…');
      const payload = await uploadClip(uri, '/api/v1/voice-check', {
        rider_id: riderId.trim(),
        shift_id: shiftId,
        call_label: `Call #${callNumber}`,
      });
      setResult(payload as ApiResponse);
      setStatusText('Call Customer analysis complete');
      setCallNumber((current) => (current % 4) + 1);
    } catch (error) {
      if (activeRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        try { await recorder.stop(); } catch {}
      }
      setStatusText('Capture or upload failed');
      Alert.alert('Voice check failed', error instanceof Error ? error.message : 'Unexpected capture error.');
    } finally {
      activeRef.current = false;
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Slider Biometrics Calculation & Live Verification
  // -------------------------------------------------------------------------
  const processSwipeTrajectory = (
    trajectory: { progress: number; relY: number; time: number; pitch: number }[],
    dx: number,
    totalDurationMs: number,
    rawVy: number,
    baseline: SliderBaselineProfile
  ): LiveSliderMetrics => {
    const lastPitch = currentPitchRef.current;
    const startTime = startTimeRef.current;
    const endTime = Date.now();

    // Checkpoint extraction helper (at progress = 0.25, 0.50, 0.75, 0.98)
    const getPointAt = (targetProgress: number, fallbackY: number): { y: number; time: number; pitch: number } => {
      if (trajectory.length === 0) return { y: fallbackY, time: startTime + totalDurationMs * targetProgress, pitch: lastPitch };
      const closePts = trajectory.filter((p) => Math.abs(p.progress - targetProgress) < 0.12);
      if (closePts.length > 0) {
        const avgY = closePts.reduce((s, p) => s + p.relY, 0) / closePts.length;
        const avgTime = closePts.reduce((s, p) => s + p.time, 0) / closePts.length;
        const avgPitch = closePts.reduce((s, p) => s + p.pitch, 0) / closePts.length;
        return { y: Number(avgY.toFixed(1)), time: Math.round(avgTime), pitch: Number(avgPitch.toFixed(2)) };
      }
      return { y: fallbackY, time: Math.round(startTime + totalDurationMs * targetProgress), pitch: lastPitch };
    };

    const lastRelY = trajectory.length > 0 ? trajectory[trajectory.length - 1].relY : 0;
    const cp05 = getPointAt(0.05, 0);
    const cp25 = getPointAt(0.25, lastRelY * 0.25);
    const cp50 = getPointAt(0.50, lastRelY * 0.50);
    const cp75 = getPointAt(0.75, lastRelY * 0.75);
    const cp100 = getPointAt(0.98, lastRelY);

    const liveCurve: [number, number, number, number] = [cp25.y, cp50.y, cp75.y, cp100.y];
    const pitchDelta = Number((cp100.pitch - cp05.pitch).toFixed(2));
    const midpointTime = Math.max(1, cp50.time - startTime);
    const symmetryRatio = Number((midpointTime / totalDurationMs).toFixed(3));

    // Terminal liftoff velocity
    let trajVy = 0;
    if (trajectory.length >= 2) {
      const p1 = trajectory[trajectory.length - 1];
      const p0 = trajectory[Math.max(0, trajectory.length - 3)];
      const dt = Math.max(10, p1.time - p0.time);
      trajVy = (p1.relY - p0.relY) / dt;
    }
    const liftoffVy = Number((0.6 * trajVy + 0.4 * rawVy).toFixed(3));

    // Validate against baseline envelopes
    let curveFailures = 0;
    const failedCurvePoints: number[] = [];
    liveCurve.forEach((val, idx) => {
      const env = baseline.curveEnvelopes[idx];
      if (val < env.envMin || val > env.envMax) {
        curveFailures++;
        failedCurvePoints.push(idx);
      }
    });
    const curveCheckpointsPassed = 4 - curveFailures;
    const isCurveFailed = curveFailures >= 2;

    const pEnv = baseline.pitchPushEnvelope;
    const isPitchPushFailed = pitchDelta < pEnv.envMin || pitchDelta > pEnv.envMax;

    const sEnv = baseline.symmetryEnvelope;
    const isSymmetryFailed = symmetryRatio < sEnv.envMin || symmetryRatio > sEnv.envMax;

    const vEnv = baseline.liftoffVyEnvelope;
    const isLiftoffOutside = liftoffVy < vEnv.envMin || liftoffVy > vEnv.envMax;
    const isLiftoffDivergence = vEnv.mean < -0.05 && liftoffVy > 0.08;
    const isLiftoffFailed = isLiftoffOutside || isLiftoffDivergence;

    const isRejected = isCurveFailed || isPitchPushFailed || isSymmetryFailed || isLiftoffFailed;
    const failureCount = (isCurveFailed ? 1 : 0) + (isPitchPushFailed ? 1 : 0) + (isSymmetryFailed ? 1 : 0) + (isLiftoffFailed ? 1 : 0);

    let confidencePct = 98;
    if (failureCount === 1) confidencePct = 42;
    else if (failureCount === 2) confidencePct = 28;
    else if (failureCount >= 3) confidencePct = 14;

    const failedMetrics: string[] = [];
    if (isPitchPushFailed) failedMetrics.push(`Pitch-Push: ${pitchDelta}° [Env: ${pEnv.envMin}°..${pEnv.envMax}°]`);
    if (isSymmetryFailed) failedMetrics.push(`Velocity Symmetry: ${symmetryRatio} [Env: ${sEnv.envMin}..${sEnv.envMax}]`);
    if (isLiftoffFailed) failedMetrics.push(`Liftoff Hook: ${liftoffVy} [Env: ${vEnv.envMin}..${vEnv.envMax}]`);
    if (isCurveFailed) failedMetrics.push(`Thumb Curve: ${failedCurvePoints.length} checkpoints outside baseline envelope`);

    return {
      curve: liveCurve,
      curveCheckpointsPassed,
      failedCurvePoints,
      isCurveFailed,
      pitchAtStart: cp05.pitch,
      pitchAtEnd: cp100.pitch,
      pitchDelta,
      isPitchPushFailed,
      midpointTimeMs: midpointTime,
      totalTimeMs: totalDurationMs,
      symmetryRatio,
      isSymmetryFailed,
      liftoffVy,
      isLiftoffFailed,
      isRejected,
      confidencePct,
      failedMetrics,
    };
  };

  // -------------------------------------------------------------------------
  // Live Slider PanResponder (Complete Delivery Slider)
  // -------------------------------------------------------------------------
  const livePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 3,
      onPanResponderGrant: (_, gesture) => {
        startYRef.current = gesture.y0;
        startTimeRef.current = Date.now();
        smoothYRef.current = null;
        trajectoryRef.current = [];
        setSliderBanner(null);
      },
      onPanResponderMove: (_, gesture) => {
        const clampedDx = Math.max(0, Math.min(MAX_SLIDE, gesture.dx));
        const progress = clampedDx / MAX_SLIDE;
        const rawRelY = gesture.moveY - startYRef.current;
        const prevSmooth = smoothYRef.current ?? rawRelY;
        const diffY = Math.abs(rawRelY - prevSmooth);
        const alpha = diffY < 1.5 ? 0.20 : 0.40;
        const smoothRelY = alpha * rawRelY + (1 - alpha) * prevSmooth;
        smoothYRef.current = smoothRelY;

        trajectoryRef.current.push({
          progress,
          relY: smoothRelY,
          time: Date.now(),
          pitch: currentPitchRef.current,
        });
        panX.setValue(clampedDx);
      },
      onPanResponderRelease: (_, gesture) => {
        const endTime = Date.now();
        const durationMs = Math.max(1, endTime - startTimeRef.current);
        const distanceX = Math.max(0, gesture.dx);

        if (distanceX >= MAX_SLIDE * 0.72) {
          const metrics = processSwipeTrajectory(
            trajectoryRef.current,
            distanceX,
            durationMs,
            gesture.vy ?? 0,
            sliderBaseline
          );
          setLastSliderResult(metrics);

          if (metrics.isRejected) {
            // Biometric Mismatch!
            Vibration.vibrate([0, 150, 80, 200]);
            setSliderBanner({
              type: 'error',
              message: `⚠️ Biometric Mismatch (Confidence: ${metrics.confidencePct}%): Swipe did not match enrolled rider!`,
            });
            void sendAlertToDashboard('SLIDER_BIOMETRIC_FAIL', {
              slider_metrics: metrics,
            });
            // Snap back
            Animated.spring(panX, { toValue: 0, bounciness: 6, useNativeDriver: false }).start();
          } else {
            // Biometric Authentic! Complete delivery & Return to First Screen
            Vibration.vibrate(80);
            setSliderBanner({
              type: 'success',
              message: `✅ Biometric Match (Confidence: ${metrics.confidencePct}%)! Order Completed.`,
            });
            void sendAlertToDashboard('SLIDER_BIOMETRIC_PASS', {
              slider_metrics: metrics,
            });

            Animated.timing(panX, {
              toValue: MAX_SLIDE,
              duration: 150,
              useNativeDriver: false,
            }).start(() => {
              // Return to the first screen (Call Customer) as requested!
              setTimeout(() => {
                panX.setValue(0);
                setCurrentScreen('active_delivery');
                setOrderCompletedBanner(true);
              }, 1200);
            });
          }
        } else {
          // Incomplete swipe snap back
          Animated.spring(panX, { toValue: 0, bounciness: 5, useNativeDriver: false }).start();
        }
      },
    })
  ).current;

  // -------------------------------------------------------------------------
  // Calibration Slider PanResponder (Enroll New Slider Biometric)
  // -------------------------------------------------------------------------
  const calibPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 3,
      onPanResponderGrant: (_, gesture) => {
        startYRef.current = gesture.y0;
        startTimeRef.current = Date.now();
        smoothYRef.current = null;
        trajectoryRef.current = [];
      },
      onPanResponderMove: (_, gesture) => {
        const clampedDx = Math.max(0, Math.min(MAX_SLIDE, gesture.dx));
        const progress = clampedDx / MAX_SLIDE;
        const rawRelY = gesture.moveY - startYRef.current;
        const prevSmooth = smoothYRef.current ?? rawRelY;
        const diffY = Math.abs(rawRelY - prevSmooth);
        const alpha = diffY < 1.5 ? 0.20 : 0.40;
        const smoothRelY = alpha * rawRelY + (1 - alpha) * prevSmooth;
        smoothYRef.current = smoothRelY;

        trajectoryRef.current.push({
          progress,
          relY: smoothRelY,
          time: Date.now(),
          pitch: currentPitchRef.current,
        });
        calibPanX.setValue(clampedDx);
      },
      onPanResponderRelease: (_, gesture) => {
        const durationMs = Math.max(1, Date.now() - startTimeRef.current);
        const distanceX = Math.max(0, gesture.dx);

        if (distanceX >= MAX_SLIDE * 0.72) {
          Vibration.vibrate(50);
          const metrics = processSwipeTrajectory(
            trajectoryRef.current,
            distanceX,
            durationMs,
            gesture.vy ?? 0,
            DEFAULT_SLIDER_BASELINE
          );

          calibrationSwipesRef.current.curves.push(metrics.curve);
          calibrationSwipesRef.current.pitches.push(metrics.pitchDelta);
          calibrationSwipesRef.current.symmetries.push(metrics.symmetryRatio);
          calibrationSwipesRef.current.liftoffs.push(metrics.liftoffVy);

          const nextStep = calibrationStep + 1;
          calibPanX.setValue(0);

          if (nextStep < 3) {
            setCalibrationStep(nextStep);
          } else {
            // 3 Swipes collected! Compute new personalized baseline
            const curves = calibrationSwipesRef.current.curves;
            const pitches = calibrationSwipesRef.current.pitches;
            const symms = calibrationSwipesRef.current.symmetries;
            const liftoffs = calibrationSwipesRef.current.liftoffs;

            const env0 = computeEnvelope(curves.map((c) => c[0]), 3.5);
            const env1 = computeEnvelope(curves.map((c) => c[1]), 3.5);
            const env2 = computeEnvelope(curves.map((c) => c[2]), 3.5);
            const env3 = computeEnvelope(curves.map((c) => c[3]), 3.5);
            const pEnv = computeEnvelope(pitches, 1.25);
            const sEnv = computeEnvelope(symms, 0.08);
            const vEnv = computeEnvelope(liftoffs, 0.25);

            const newProfile: SliderBaselineProfile = {
              name: `Custom Enrolled Profile (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
              baselineCurve: [env0.mean, env1.mean, env2.mean, env3.mean],
              curveEnvelopes: [env0, env1, env2, env3],
              baselinePitchPush: pEnv.mean,
              pitchPushEnvelope: pEnv,
              baselineSymmetry: sEnv.mean,
              symmetryEnvelope: sEnv,
              baselineLiftoffVy: vEnv.mean,
              liftoffVyEnvelope: vEnv,
              calibratedAt: new Date().toISOString(),
              isCustom: true,
            };

            setSliderBaseline(newProfile);
            setIsCalibratingSlider(false);
            setCalibrationStep(0);
            calibrationSwipesRef.current = { curves: [], pitches: [], symmetries: [], liftoffs: [] };
            Vibration.vibrate([0, 100, 50, 150]);
            setSliderBanner({
              type: 'success',
              message: '🎉 New Slider Biometric Baseline successfully calibrated and enrolled!',
            });
          }
        } else {
          Animated.spring(calibPanX, { toValue: 0, bounciness: 5, useNativeDriver: false }).start();
        }
      },
    })
  ).current;

  // -------------------------------------------------------------------------
  // Speaker Verdict Styling
  // -------------------------------------------------------------------------
  const speakerStatus = result?.layers.kyc_speaker_match?.status ?? 'pending';
  const speakerVerdict = getSpeakerVerdict(speakerStatus, result?.verdict);
  const verdictColor = result?.verdict === 'verified' ? '#147d53'
    : result?.verdict === 'alert' ? '#ba3038'
      : result?.verdict === 'step_up' ? '#a96800' : '#526579';

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />

      {/* Top Header Navigation Tabs */}
      <View style={styles.topNav}>
        <Pressable
          onPress={() => setCurrentScreen('active_delivery')}
          style={[styles.navTab, currentScreen === 'active_delivery' && styles.navTabActive]}
        >
          <Text style={[styles.navTabText, currentScreen === 'active_delivery' && styles.navTabTextActive]}>
            1. Call Customer
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setCurrentScreen('complete_delivery')}
          style={[styles.navTab, currentScreen === 'complete_delivery' && styles.navTabActive]}
        >
          <Text style={[styles.navTabText, currentScreen === 'complete_delivery' && styles.navTabTextActive]}>
            2. Complete Delivery
          </Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.page}>
        {/* =================================================================== */}
        {/* SCREEN 1: ACTIVE DELIVERY (CALL CUSTOMER)                           */}
        {/* =================================================================== */}
        {currentScreen === 'active_delivery' && (
          <View>
            <View style={styles.orderBadgeRow}>
              <View style={styles.statusPill}>
                <View style={styles.greenDot} />
                <Text style={styles.statusPillText}>ACTIVE ORDER #HF-9402</Text>
              </View>
              <Pressable
                onPress={() => setCurrentScreen('complete_delivery')}
                style={styles.goToCompleteButton}
              >
                <Text style={styles.goToCompleteButtonText}>Complete Delivery Screen →</Text>
              </Pressable>
            </View>

            {orderCompletedBanner && (
              <View style={styles.completedToast}>
                <Text style={styles.completedToastTitle}>🎉 ORDER DELIVERED SUCCESSFULLY</Text>
                <Text style={styles.completedToastSub}>Biometric slider verification passed. Ready for next order assignment.</Text>
              </View>
            )}

            <Text style={styles.eyebrow}>RIDER VOICE CHECK</Text>
            <Text style={styles.title}>Customer Voice Check</Text>
            <Text style={styles.subtitle}>
              Build a five-clip rider baseline (saved persistently on backend), then verify the rider during Call Customer.
            </Text>

            {/* Baseline Profile Status Card */}
            <View style={styles.baselineStatusCard}>
              <View style={styles.baselineHeader}>
                <Text style={styles.baselineTitle}>RIDER VOICE BASELINE</Text>
                <View style={[styles.badge, enrollmentStatus?.enrolled ? styles.badgeSuccess : styles.badgeWarn]}>
                  <Text style={[styles.badgeText, enrollmentStatus?.enrolled ? styles.badgeTextSuccess : styles.badgeTextWarn]}>
                    {enrollmentStatus?.enrolled ? `${enrollmentStatus.sample_count}/5 CLIPS ENROLLED` : 'NO BASELINE'}
                  </Text>
                </View>
              </View>

              {enrollmentStatus?.enrolled ? (
                <View>
                  <Text style={styles.baselineDetailText}>
                    Active KYC baseline saved to disk. Last updated: {enrollmentStatus.created_at ? new Date(enrollmentStatus.created_at).toLocaleTimeString() : 'Recent session'}.
                  </Text>
                  {enrollmentStatus.has_previous_baseline && enrollmentStatus.similarity_with_previous != null && (
                    <View style={styles.previousComparisonBox}>
                      <Text style={styles.previousComparisonLabel}>PREVIOUS BASELINE COMPARISON</Text>
                      <Text style={styles.previousComparisonValue}>
                        Cosine Similarity: {enrollmentStatus.similarity_with_previous.toFixed(3)}
                      </Text>
                      <Text style={styles.previousComparisonSub}>
                        {enrollmentStatus.similarity_with_previous >= 0.25
                          ? '✅ Verified: Matches previous baseline (Consistent speaker)'
                          : '⚠️ Caution: Drift from previous baseline'}
                      </Text>
                    </View>
                  )}
                </View>
              ) : (
                <Text style={styles.baselineDetailText}>
                  No baseline on record for this rider. Tap Enroll Five Voice Samples below to record 5 clips and save the profile.
                </Text>
              )}
            </View>

            {/* Voice Capture Controls */}
            <View style={styles.card}>
              <Text style={styles.label}>RIDER IDENTIFIER</Text>
              <TextInput
                value={riderId}
                onChangeText={(val) => {
                  setRiderId(val);
                  void fetchBaselineStatus(val);
                }}
                autoCapitalize="none"
                editable={!busy}
                style={styles.input}
              />
              <Text style={styles.helper}>Next shift slot: Call #{callNumber}</Text>

              <Pressable
                disabled={busy || !permissionGranted}
                onPress={() => void captureEnrollmentBatch()}
                style={[styles.buttonSecondary, (busy || !permissionGranted) && styles.buttonDisabled]}
              >
                <Text style={styles.buttonSecondaryText}>
                  {enrollmentStatus?.enrolled ? 'Re-enroll Baseline · 5 × 10s (Compares with Old)' : 'Enroll Five Voice Samples · 5 × 10s'}
                </Text>
              </Pressable>
              <Text style={styles.helper}>
                Records five separate 10s clips from the rider. The backend persists the baseline on disk and compares re-enrollment against your previous baseline.
              </Text>

              <Pressable
                disabled={busy || !permissionGranted}
                onPress={() => void captureCall()}
                style={[styles.button, (busy || !permissionGranted) && styles.buttonDisabled]}
              >
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Call Customer · Record 8s</Text>}
              </Pressable>
              <Text style={styles.status}>{statusText}</Text>
            </View>

            {/* Voice Check Result Card */}
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
                    <Text style={[styles.layerName, { color: layerColor(layer.status) }]}>
                      {name.replaceAll('_', ' ')} · {layer.status}
                    </Text>
                    <Text style={styles.layerReason}>{layer.reason}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Next Screen CTA */}
            <View style={styles.proceedCard}>
              <Text style={styles.proceedCardTitle}>READY FOR DELIVERY COMPLETION?</Text>
              <Text style={styles.proceedCardSub}>Proceed to complete delivery, test mock locations, and swipe the biometric slider.</Text>
              <Pressable
                onPress={() => setCurrentScreen('complete_delivery')}
                style={styles.proceedPrimaryButton}
              >
                <Text style={styles.proceedPrimaryButtonText}>Go to Complete Delivery Screen →</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* =================================================================== */}
        {/* SCREEN 2: COMPLETE DELIVERY SCREEN                                  */}
        {/* =================================================================== */}
        {currentScreen === 'complete_delivery' && (
          <View>
            <View style={styles.orderBadgeRow}>
              <Pressable
                onPress={() => setCurrentScreen('active_delivery')}
                style={styles.backButton}
              >
                <Text style={styles.backButtonText}>← Back to Call Customer</Text>
              </Pressable>
              <View style={[styles.badge, isMockLocation ? styles.badgeDanger : styles.badgeSuccess]}>
                <Text style={[styles.badgeText, isMockLocation ? styles.badgeTextDanger : styles.badgeTextSuccess]}>
                  {isMockLocation ? 'SPOOFED GPS' : 'NORMAL GPS'}
                </Text>
              </View>
            </View>

            <Text style={styles.eyebrow}>ORDER DROP-OFF</Text>
            <Text style={styles.title}>Complete Delivery</Text>
            <Text style={styles.subtitle}>
              Test sudden mock location and device ID alerts sent to the dashboard, and verify the biometric slider.
            </Text>

            {/* Alert banner if triggered */}
            {alertDispatched && (
              <View style={[styles.alertBannerBox, isMockLocation ? styles.alertBannerDanger : styles.alertBannerSuccess]}>
                <Text style={styles.alertBannerText}>{alertDispatched}</Text>
              </View>
            )}

            {/* SECTION 1: Location & Hardware Telemetry (The 2 Mock Location Controls) */}
            <View style={styles.card}>
              <Text style={styles.sectionHeader}>LOCATION & HARDWARE CONTROLS</Text>
              <Text style={styles.helper}>
                Sudden jumps in location or changed device ID will trigger immediate alerts on the Control Tower Dashboard via WebSocket.
              </Text>

              <View style={styles.telemetryGrid}>
                <View style={styles.telemetryCol}>
                  <Text style={styles.metricLabel}>CURRENT LOCATION</Text>
                  <Text style={styles.telemetryValue} numberOfLines={1}>{locationLabel}</Text>
                  <Text style={styles.subtext}>{coordinates.lat.toFixed(4)}° N, {coordinates.lon.toFixed(4)}° E</Text>
                </View>
                <View style={styles.telemetryCol}>
                  <Text style={styles.metricLabel}>SIMULATED SPEED</Text>
                  <Text style={[styles.telemetryValue, speedKmh > 100 && styles.telemetryValueDanger]}>
                    {speedKmh.toFixed(1)} km/h
                  </Text>
                  <Text style={styles.subtext}>{speedKmh > 100 ? 'IMPOSSIBLE TRAVEL' : 'Road Transit'}</Text>
                </View>
              </View>

              <View style={styles.deviceRow}>
                <Text style={styles.metricLabel}>DEVICE HARDWARE ID</Text>
                <Text style={[styles.deviceIdText, isRogueDevice && styles.deviceIdTextDanger]}>{deviceId}</Text>
              </View>

              {/* Location Control Buttons */}
              <View style={styles.buttonRow}>
                <Pressable
                  onPress={() => void handleSetCurrentLocation()}
                  style={[styles.locationBtn, styles.locationBtnNormal]}
                >
                  <Text style={styles.locationBtnNormalText}>📍 Set Current Location</Text>
                  <Text style={styles.btnSub}>Authentic GPS & Device</Text>
                </Pressable>

                <Pressable
                  onPress={() => void handleSetMockLocation()}
                  style={[styles.locationBtn, styles.locationBtnMock]}
                >
                  <Text style={styles.locationBtnMockText}>⚡ Set Mock Location</Text>
                  <Text style={styles.btnSubDanger}>Sudden Leap Alert (850km/h)</Text>
                </Pressable>
              </View>

              <Pressable
                onPress={() => void handleToggleDeviceId()}
                style={[styles.deviceToggleBtn, isRogueDevice && styles.deviceToggleBtnActive]}
              >
                <Text style={[styles.deviceToggleText, isRogueDevice && styles.deviceToggleTextActive]}>
                  {isRogueDevice ? '📱 Restore Genuine Device ID' : '📱 Switch to Rogue / Spoofed Device ID'}
                </Text>
              </Pressable>
            </View>

            {/* SECTION 2: Slider Biometric Baseline & Enrollment */}
            <View style={styles.card}>
              <View style={styles.baselineHeader}>
                <Text style={styles.sectionHeader}>SLIDER BIOMETRIC PROFILE</Text>
                <View style={[styles.badge, sliderBaseline.isCustom ? styles.badgeSuccess : styles.badgeNeutral]}>
                  <Text style={[styles.badgeText, sliderBaseline.isCustom ? styles.badgeTextSuccess : styles.badgeTextNeutral]}>
                    {sliderBaseline.isCustom ? 'CUSTOM CALIBRATED' : 'DEFAULT BASELINE'}
                  </Text>
                </View>
              </View>

              <Text style={styles.sliderProfileName}>{sliderBaseline.name}</Text>

              <View style={styles.sliderProfileGrid}>
                <View style={styles.profileParam}>
                  <Text style={styles.metricLabel}>THUMB CURVE</Text>
                  <Text style={styles.profileParamVal}>[{sliderBaseline.baselineCurve.map((v) => v.toFixed(1)).join(', ')}] px</Text>
                </View>
                <View style={styles.profileParam}>
                  <Text style={styles.metricLabel}>PITCH-PUSH</Text>
                  <Text style={styles.profileParamVal}>+{sliderBaseline.baselinePitchPush.toFixed(1)}°</Text>
                </View>
                <View style={styles.profileParam}>
                  <Text style={styles.metricLabel}>VELOCITY SYMMETRY</Text>
                  <Text style={styles.profileParamVal}>{sliderBaseline.baselineSymmetry.toFixed(3)}</Text>
                </View>
                <View style={styles.profileParam}>
                  <Text style={styles.metricLabel}>LIFTOFF HOOK</Text>
                  <Text style={styles.profileParamVal}>{sliderBaseline.baselineLiftoffVy.toFixed(3)} px/ms</Text>
                </View>
              </View>

              <Pressable
                onPress={() => {
                  setCalibrationStep(0);
                  calibrationSwipesRef.current = { curves: [], pitches: [], symmetries: [], liftoffs: [] };
                  setIsCalibratingSlider(true);
                }}
                style={styles.enrollSliderBtn}
              >
                <Text style={styles.enrollSliderBtnText}>🎯 Enroll New Slider Biometric (3 Swipes)</Text>
              </Pressable>
              <Text style={styles.helper}>
                Calibrate a personalized neuromuscular biometric profile. The slider below verifies authentic thumb curvature vs robotic or impostor swipes.
              </Text>
            </View>

            {/* Last Slider Result Card */}
            {lastSliderResult && (
              <View style={[styles.resultCard, { borderColor: lastSliderResult.isRejected ? '#ba3038' : '#147d53' }]}>
                <View style={[styles.banner, { backgroundColor: lastSliderResult.isRejected ? '#ba3038' : '#147d53' }]}>
                  <Text style={styles.bannerText}>
                    {lastSliderResult.isRejected ? 'SLIDER BIOMETRIC REJECTED · IMPOSTOR SUSPECTED' : 'SLIDER BIOMETRIC VERIFIED · AUTHENTIC'}
                  </Text>
                </View>
                <View style={styles.metrics}>
                  <Metric label="Rider Confidence" value={`${lastSliderResult.confidencePct}%`} />
                  <Metric label="Thumb Checkpoints" value={`${lastSliderResult.curveCheckpointsPassed}/4 passed`} />
                  <Metric label="Pitch-Push Delta" value={`${lastSliderResult.pitchDelta}°`} />
                  <Metric label="Velocity Symmetry" value={`${lastSliderResult.symmetryRatio}`} />
                  <Metric label="Swipe Duration" value={`${lastSliderResult.totalTimeMs} ms`} />
                  <Metric label="Liftoff Hook (vy)" value={`${lastSliderResult.liftoffVy}`} />
                </View>
                {lastSliderResult.failedMetrics.length > 0 && (
                  <View style={styles.failedMetricsBox}>
                    <Text style={styles.failedMetricsTitle}>DIVERGENCE BREACHES:</Text>
                    {lastSliderResult.failedMetrics.map((msg, i) => (
                      <Text key={i} style={styles.failedMetricItem}>• {msg}</Text>
                    ))}
                  </View>
                )}
              </View>
            )}

            {sliderBanner && (
              <View style={[styles.sliderBannerBox, sliderBanner.type === 'error' ? styles.sliderBannerError : styles.sliderBannerSuccess]}>
                <Text style={styles.sliderBannerText}>{sliderBanner.message}</Text>
              </View>
            )}

            {/* SECTION 3: The Live Swipe to Complete Delivery Slider */}
            <View style={styles.sliderContainerCard}>
              <Text style={styles.sliderPromptText}>SLIDE TO COMPLETE ORDER</Text>
              <Text style={styles.sliderSubPrompt}>
                Verifies thumb arc, tilt, and velocity against enrolled baseline. Successfully completing will return you to Call Customer.
              </Text>

              <View style={styles.sliderTrack}>
                <View style={styles.sliderTrackGlow} />
                <Text style={styles.sliderTrackLabel}>Slide to Complete →</Text>

                <Animated.View
                  {...livePanResponder.panHandlers}
                  style={[
                    styles.sliderThumb,
                    { transform: [{ translateX: panX }] },
                  ]}
                >
                  <Text style={styles.sliderThumbIcon}>→</Text>
                </Animated.View>
              </View>
            </View>
          </View>
        )}

        <Text style={styles.footnote}>Trust Juggler Multi-Modal Biometric Security · ECAPA Voice & Kinetic Slider</Text>
      </ScrollView>

      {/* =================================================================== */}
      {/* MODAL: ENROLL NEW SLIDER BIOMETRIC (3-SWIPE CALIBRATION)            */}
      {/* =================================================================== */}
      <Modal visible={isCalibratingSlider} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>ENROLL SLIDER BIOMETRIC</Text>
            <Text style={styles.modalStep}>Swipe {calibrationStep + 1} of 3</Text>
            <Text style={styles.modalInstructions}>
              Slide naturally across the track below. Maintain your normal one-handed grip to record your personal thumb arc and pressure dynamics.
            </Text>

            <View style={styles.modalStepIndicatorRow}>
              {[0, 1, 2].map((step) => (
                <View
                  key={step}
                  style={[
                    styles.stepPill,
                    step === calibrationStep && styles.stepPillActive,
                    step < calibrationStep && styles.stepPillCompleted,
                  ]}
                >
                  <Text style={styles.stepPillText}>
                    {step < calibrationStep ? '✓ Done' : `Swipe ${step + 1}`}
                  </Text>
                </View>
              ))}
            </View>

            <View style={styles.modalSliderTrack}>
              <Text style={styles.modalTrackLabel}>Swipe naturally across →</Text>
              <Animated.View
                {...calibPanResponder.panHandlers}
                style={[
                  styles.sliderThumb,
                  { transform: [{ translateX: calibPanX }] },
                ]}
              >
                <Text style={styles.sliderThumbIcon}>→</Text>
              </Animated.View>
            </View>

            <Pressable
              onPress={() => {
                setIsCalibratingSlider(false);
                setCalibrationStep(0);
              }}
              style={styles.modalCancelBtn}
            >
              <Text style={styles.modalCancelBtnText}>Cancel Calibration</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Helpers & Subcomponents
// ---------------------------------------------------------------------------
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function formatScore(value: number | null | undefined) {
  return value == null ? '—' : value.toFixed(3);
}

function getSpeakerVerdict(status: string, overallVerdict?: ApiResponse['verdict']) {
  if (overallVerdict === 'step_up') {
    return {
      label: 'UNCERTAIN · STEP-UP',
      description: status === 'warn'
        ? 'Voice match is marginal. Review similarity and use in-app step-up.'
        : 'Overall check needs step-up. Rider match is unconfirmed.',
      color: '#a96800',
    };
  }
  if (status === 'passed') {
    return { label: 'SAME SPEAKER LIKELY', description: 'Voice sample matches the enrolled 5-clip baseline.', color: '#147d53' };
  }
  if (status === 'warn') {
    return { label: 'UNCERTAIN · STEP-UP', description: 'Voice match is marginal. Review similarity and step-up.', color: '#a96800' };
  }
  if (status === 'alert' || status === 'failed') {
    return { label: 'VOICE MISMATCH SUSPECTED', description: 'Sample is below demo match threshold.', color: '#ba3038' };
  }
  return { label: 'NOT COMPARED', description: 'No enrolled KYC baseline was available for this rider.', color: '#526579' };
}

function layerColor(status: string) {
  if (status === 'passed') return '#147d53';
  if (status === 'alert' || status === 'failed') return '#ba3038';
  if (status === 'warn') return '#a96800';
  return '#526579';
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f1f5f9' },
  topNav: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  navTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  navTabActive: {
    borderBottomColor: '#0f766e',
  },
  navTabText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748b',
  },
  navTabTextActive: {
    color: '#0f766e',
    fontWeight: '800',
  },
  page: { padding: 18, paddingBottom: 40 },

  orderBadgeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  greenDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#0284c7',
    marginRight: 6,
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0369a1',
    letterSpacing: 0.5,
  },
  goToCompleteButton: {
    backgroundColor: '#0f766e',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  goToCompleteButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  backButton: {
    paddingVertical: 6,
  },
  backButtonText: {
    color: '#0f766e',
    fontSize: 13,
    fontWeight: '800',
  },

  completedToast: {
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  completedToastTitle: {
    color: '#065f46',
    fontWeight: '900',
    fontSize: 13,
  },
  completedToastSub: {
    color: '#047857',
    fontSize: 12,
    marginTop: 2,
  },

  eyebrow: { color: '#0f766e', fontWeight: '800', letterSpacing: 1.5, fontSize: 11, marginTop: 4 },
  title: { color: '#0f172a', fontSize: 26, fontWeight: '900', marginTop: 4 },
  subtitle: { color: '#475569', fontSize: 13, lineHeight: 19, marginTop: 4, marginBottom: 14 },

  baselineStatusCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  baselineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  baselineTitle: {
    fontSize: 12,
    fontWeight: '900',
    color: '#334155',
    letterSpacing: 0.8,
  },
  baselineDetailText: {
    fontSize: 12,
    color: '#64748b',
    lineHeight: 18,
  },
  previousComparisonBox: {
    backgroundColor: '#f8fafc',
    borderLeftWidth: 3,
    borderLeftColor: '#0f766e',
    padding: 9,
    borderRadius: 6,
    marginTop: 8,
  },
  previousComparisonLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#0f766e',
    letterSpacing: 0.6,
  },
  previousComparisonValue: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 2,
  },
  previousComparisonSub: {
    fontSize: 11,
    color: '#334155',
    marginTop: 2,
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '900',
    color: '#1e293b',
    letterSpacing: 0.8,
  },
  label: { color: '#64748b', fontSize: 10, fontWeight: '800', letterSpacing: 1.1 },
  input: {
    color: '#0f172a',
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontWeight: '600',
  },
  button: {
    backgroundColor: '#0f766e',
    borderRadius: 12,
    marginTop: 14,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSecondary: {
    backgroundColor: '#ccfbf1',
    borderRadius: 12,
    marginTop: 12,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSecondaryText: { color: '#0f766e', fontSize: 13, fontWeight: '800' },
  buttonDisabled: { opacity: 0.55 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  status: { color: '#64748b', fontSize: 12, textAlign: 'center', marginTop: 10 },
  helper: { color: '#64748b', fontSize: 11, lineHeight: 16, marginTop: 6 },

  resultCard: {
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderRadius: 16,
    marginTop: 14,
    overflow: 'hidden',
    paddingBottom: 14,
    elevation: 2,
  },
  banner: { paddingVertical: 12, paddingHorizontal: 16 },
  bannerText: { color: '#fff', fontSize: 15, fontWeight: '900', letterSpacing: 0.8 },
  speakerVerdict: {
    marginHorizontal: 14,
    marginTop: 12,
    padding: 12,
    borderWidth: 1,
    borderRadius: 10,
    backgroundColor: '#fff',
  },
  speakerVerdictText: { fontSize: 15, fontWeight: '900', marginTop: 3 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', padding: 14, paddingBottom: 4 },
  metric: { width: '50%', marginBottom: 10 },
  metricLabel: { color: '#64748b', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  metricValue: { color: '#0f172a', fontWeight: '800', marginTop: 2, fontSize: 14 },
  modelName: { color: '#334155', fontSize: 12, marginHorizontal: 14, marginTop: 4, marginBottom: 10 },
  layerRow: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#e2e8f0', paddingHorizontal: 14, paddingVertical: 8 },
  layerName: { color: '#1e293b', fontWeight: '800', fontSize: 12 },
  layerReason: { color: '#64748b', fontSize: 11, lineHeight: 15, marginTop: 2 },

  proceedCard: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    borderRadius: 14,
    padding: 14,
    marginTop: 14,
  },
  proceedCardTitle: {
    color: '#166534',
    fontWeight: '900',
    fontSize: 12,
    letterSpacing: 0.6,
  },
  proceedCardSub: {
    color: '#15803d',
    fontSize: 11,
    marginTop: 2,
    marginBottom: 10,
  },
  proceedPrimaryButton: {
    backgroundColor: '#16a34a',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  proceedPrimaryButtonText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 13,
  },

  // Telemetry styles
  telemetryGrid: {
    flexDirection: 'row',
    marginTop: 10,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 10,
  },
  telemetryCol: {
    flex: 1,
  },
  telemetryValue: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 2,
  },
  telemetryValueDanger: {
    color: '#dc2626',
  },
  subtext: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 2,
  },
  deviceRow: {
    marginTop: 8,
    backgroundColor: '#f8fafc',
    padding: 10,
    borderRadius: 8,
  },
  deviceIdText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    marginTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  deviceIdTextDanger: {
    color: '#dc2626',
  },

  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  locationBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  locationBtnNormal: {
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  locationBtnNormalText: {
    color: '#0369a1',
    fontWeight: '800',
    fontSize: 12,
  },
  locationBtnMock: {
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#fca5a5',
  },
  locationBtnMockText: {
    color: '#b91c1c',
    fontWeight: '800',
    fontSize: 12,
  },
  btnSub: {
    fontSize: 9,
    color: '#0284c7',
    marginTop: 2,
  },
  btnSubDanger: {
    fontSize: 9,
    color: '#dc2626',
    fontWeight: '700',
    marginTop: 2,
  },

  deviceToggleBtn: {
    marginTop: 10,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  deviceToggleBtnActive: {
    backgroundColor: '#fef2f2',
    borderColor: '#f87171',
  },
  deviceToggleText: {
    color: '#334155',
    fontWeight: '800',
    fontSize: 12,
  },
  deviceToggleTextActive: {
    color: '#dc2626',
  },

  alertBannerBox: {
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
  },
  alertBannerDanger: {
    backgroundColor: '#fef2f2',
    borderColor: '#f87171',
  },
  alertBannerSuccess: {
    backgroundColor: '#f0fdf4',
    borderColor: '#86efac',
  },
  alertBannerText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#991b1b',
  },

  // Slider Profile Card
  sliderProfileName: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 4,
    marginBottom: 8,
  },
  sliderProfileGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 10,
    gap: 8,
  },
  profileParam: {
    width: '46%',
  },
  profileParamVal: {
    fontSize: 12,
    fontWeight: '800',
    color: '#1e293b',
    marginTop: 2,
  },
  enrollSliderBtn: {
    backgroundColor: '#0f766e',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 12,
  },
  enrollSliderBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
  },

  failedMetricsBox: {
    backgroundColor: '#fef2f2',
    marginHorizontal: 14,
    padding: 10,
    borderRadius: 8,
    marginTop: 6,
  },
  failedMetricsTitle: {
    color: '#991b1b',
    fontWeight: '800',
    fontSize: 11,
    marginBottom: 4,
  },
  failedMetricItem: {
    color: '#b91c1c',
    fontSize: 11,
    lineHeight: 16,
  },

  sliderBannerBox: {
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  sliderBannerError: {
    backgroundColor: '#fef2f2',
  },
  sliderBannerSuccess: {
    backgroundColor: '#f0fdf4',
  },
  sliderBannerText: {
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
    color: '#1e293b',
  },

  // Pinned Bottom Slider Track
  sliderContainerCard: {
    backgroundColor: '#0f172a',
    borderRadius: 20,
    padding: 18,
    marginTop: 10,
    alignItems: 'center',
  },
  sliderPromptText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  sliderSubPrompt: {
    color: '#94a3b8',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 15,
    marginTop: 4,
    marginBottom: 14,
    paddingHorizontal: 8,
  },
  sliderTrack: {
    width: SLIDER_WIDTH,
    height: SLIDER_HEIGHT,
    backgroundColor: '#1e293b',
    borderRadius: 30,
    justifyContent: 'center',
    paddingHorizontal: 4,
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1.5,
    borderColor: '#334155',
  },
  sliderTrackGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0f766e',
    opacity: 0.15,
  },
  sliderTrackLabel: {
    position: 'absolute',
    alignSelf: 'center',
    color: '#cbd5e1',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 0.5,
  },
  sliderThumb: {
    width: SLIDER_THUMB_SIZE,
    height: SLIDER_THUMB_SIZE,
    borderRadius: 25,
    backgroundColor: '#14b8a6',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#14b8a6',
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 4,
  },
  sliderThumbIcon: {
    color: '#042f2e',
    fontSize: 22,
    fontWeight: '900',
  },

  // Badges
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  badgeSuccess: { backgroundColor: '#dcfce7' },
  badgeTextSuccess: { color: '#15803d' },
  badgeWarn: { backgroundColor: '#fef3c7' },
  badgeTextWarn: { color: '#b45309' },
  badgeDanger: { backgroundColor: '#fee2e2' },
  badgeTextDanger: { color: '#b91c1c' },
  badgeNeutral: { backgroundColor: '#f1f5f9' },
  badgeTextNeutral: { color: '#475569' },

  // Calibration Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
  },
  modalTitle: {
    color: '#0f766e',
    fontWeight: '900',
    fontSize: 14,
    letterSpacing: 1,
  },
  modalStep: {
    color: '#0f172a',
    fontSize: 22,
    fontWeight: '900',
    marginTop: 4,
  },
  modalInstructions: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 17,
    marginTop: 6,
    marginBottom: 16,
  },
  modalStepIndicatorRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
  },
  stepPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
  },
  stepPillActive: {
    backgroundColor: '#ccfbf1',
    borderWidth: 1,
    borderColor: '#14b8a6',
  },
  stepPillCompleted: {
    backgroundColor: '#dcfce7',
  },
  stepPillText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#334155',
  },
  modalSliderTrack: {
    width: '100%',
    height: SLIDER_HEIGHT,
    backgroundColor: '#0f172a',
    borderRadius: 30,
    justifyContent: 'center',
    paddingHorizontal: 4,
    overflow: 'hidden',
    position: 'relative',
    marginBottom: 16,
  },
  modalTrackLabel: {
    position: 'absolute',
    alignSelf: 'center',
    color: '#94a3b8',
    fontWeight: '800',
    fontSize: 13,
  },
  modalCancelBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  modalCancelBtnText: {
    color: '#64748b',
    fontWeight: '700',
    fontSize: 13,
  },

  footnote: {
    textAlign: 'center',
    color: '#94a3b8',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 20,
    paddingHorizontal: 20,
  },
});
