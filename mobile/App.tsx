import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  PanResponder,
  Platform,
  Pressable,
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
const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://10.180.142.251:8000').replace(/\/$/, '');
const BATCH_SAMPLE_COUNT = 5;
const BATCH_CAPTURE_MS = 8_000;
const ENROLLMENT_CAPTURE_MS = 10_000;

// Strict Fixed Slider Geometry (Position NEVER shifts)
export const SLIDER_WIDTH = Math.min(SCREEN_WIDTH - 36, 350);
export const SLIDER_HEIGHT = 56;
export const SLIDER_THUMB_SIZE = 48;
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
  name: 'KYC Reference Baseline (Rider-01)',
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
  calibratedAt: 'Enrolled KYC Baseline',
  isCustom: false,
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
export default function App() {
  // Three Dedicated Non-Scrollable Screens
  const [currentScreen, setCurrentScreen] = useState<'call_customer' | 'hardware_gps' | 'complete_delivery'>('call_customer');

  // Audio & Voice check state
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [riderId, setRiderId] = useState('rider-demo-01');
  const [shiftId] = useState(() => `shift-demo-${new Date().toISOString().slice(0, 10)}`);
  const [callNumber, setCallNumber] = useState(1);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('Ready for voice verification');
  const [result, setResult] = useState<ApiResponse | null>(null);

  // Persistent baseline info
  const [enrollmentStatus, setEnrollmentStatus] = useState<EnrollmentStatus | null>(null);
  const [lastEnrollmentComparison, setLastEnrollmentComparison] = useState<{
    similarity: number | null;
    verdict: string | null;
  } | null>(null);

  // Screen 2: Hardware & GPS state
  const [isMockLocation, setIsMockLocation] = useState(false);
  const [isRogueDevice, setIsRogueDevice] = useState(false);
  const [locationLabel, setLocationLabel] = useState('Bandra West, Mumbai (Authentic)');
  const [coordinates, setCoordinates] = useState({ lat: 19.1031, lon: 72.8402 });
  const [speedKmh, setSpeedKmh] = useState(24.5);
  const [deviceId, setDeviceId] = useState('SM-G998B_Android_14_OEM');
  const [alertDispatched, setAlertDispatched] = useState<string | null>(null);
  const [orderCompletedBanner, setOrderCompletedBanner] = useState(false);

  // Screen 3: Slider Biometrics State & STATIC SLIDER
  const [sliderBaseline, setSliderBaseline] = useState<SliderBaselineProfile>(DEFAULT_SLIDER_BASELINE);
  const [lastSliderResult, setLastSliderResult] = useState<LiveSliderMetrics | null>(null);
  const [sliderFeedback, setSliderFeedback] = useState<{ type: 'success' | 'error' | 'calib'; message: string } | null>(null);

  // Slider Mode: 'live' (slide to complete delivery) OR 'calibrate' (3 guided swipes on the SAME static slider)
  const [sliderMode, setSliderMode] = useState<'live' | 'calibrate'>('live');
  const [calibrationStep, setCalibrationStep] = useState(0); // 0, 1, 2
  const calibrationSwipesRef = useRef<{
    curves: [number, number, number, number][];
    pitches: number[];
    symmetries: number[];
    liftoffs: number[];
  }>({ curves: [], pitches: [], symmetries: [], liftoffs: [] });

  // Pinned Bottom Slider Pan & Trajectory
  const panX = useRef(new Animated.Value(0)).current;
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
  // Baseline Status Loading
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
  // Telemetry & Alert Dispatcher (Sends to backend -> updates Dashboard HTML)
  // -------------------------------------------------------------------------
  const sendAlertToDashboard = async (
    eventType: 'SUDDEN_LOCATION_CHANGE' | 'DEVICE_ID_CHANGE' | 'SLIDER_BIOMETRIC_FAIL' | 'SLIDER_BIOMETRIC_PASS' | 'SET_CURRENT_LOCATION' | 'SLIDER_CALIBRATION',
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
      await fetch(`${API_BASE_URL}/api/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      // Offline fallback
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
    Vibration.vibrate(35);
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
      Vibration.vibrate([0, 140, 80, 140]);
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
  // Audio Recording & Upload
  // -------------------------------------------------------------------------
  const validateSetup = () => {
    if (!permissionGranted) {
      Alert.alert('Microphone permission required', 'Allow microphone access in settings.');
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
        setStatusText(`Sample ${index + 1}/${BATCH_SAMPLE_COUNT}: speak for ${ENROLLMENT_CAPTURE_MS / 1000}s…`);
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
          const reVerdict = typeof enrollment?.re_enrollment_verdict === 'string' ? enrollment.re_enrollment_verdict : null;

          if (hasPrev) {
            setLastEnrollmentComparison({
              similarity: simPrev,
              verdict: reVerdict,
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
      Alert.alert('Enrollment failed', error instanceof Error ? error.message : 'Capture error.');
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
      Alert.alert('Voice check failed', error instanceof Error ? error.message : 'Capture error.');
    } finally {
      activeRef.current = false;
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Biometric Gesture Calculation
  // -------------------------------------------------------------------------
  const processSwipeTrajectory = (
    trajectory: { progress: number; relY: number; time: number; pitch: number }[],
    totalDurationMs: number,
    rawVy: number,
    baseline: SliderBaselineProfile
  ): LiveSliderMetrics => {
    const lastPitch = currentPitchRef.current;
    const startTime = startTimeRef.current;

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

    let trajVy = 0;
    if (trajectory.length >= 2) {
      const p1 = trajectory[trajectory.length - 1];
      const p0 = trajectory[Math.max(0, trajectory.length - 3)];
      const dt = Math.max(10, p1.time - p0.time);
      trajVy = (p1.relY - p0.relY) / dt;
    }
    const liftoffVy = Number((0.6 * trajVy + 0.4 * rawVy).toFixed(3));

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
    if (isPitchPushFailed) failedMetrics.push(`Pitch-Push: ${pitchDelta}° [${pEnv.envMin}°..${pEnv.envMax}°]`);
    if (isSymmetryFailed) failedMetrics.push(`Velocity Symmetry: ${symmetryRatio} [${sEnv.envMin}..${sEnv.envMax}]`);
    if (isLiftoffFailed) failedMetrics.push(`Liftoff Hook: ${liftoffVy} [${vEnv.envMin}..${vEnv.envMax}]`);
    if (isCurveFailed) failedMetrics.push(`Curve Checkpoints Failed: ${failedCurvePoints.length}/4 outside envelope`);

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
  // PERMANENT STATIC SLIDER PANRESPONDER (Both Live & Calibration Modes)
  // Position NEVER shifts by 1 pixel between enrollment and completion
  // -------------------------------------------------------------------------
  const sliderPanResponder = useRef(
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
        panX.setValue(clampedDx);
      },
      onPanResponderRelease: (_, gesture) => {
        const endTime = Date.now();
        const durationMs = Math.max(1, endTime - startTimeRef.current);
        const distanceX = Math.max(0, gesture.dx);

        if (distanceX >= MAX_SLIDE * 0.72) {
          // --- MODE 1: CALIBRATION SWIPE ---
          if (sliderMode === 'calibrate') {
            Vibration.vibrate(50);
            const metrics = processSwipeTrajectory(
              trajectoryRef.current,
              durationMs,
              gesture.vy ?? 0,
              DEFAULT_SLIDER_BASELINE
            );

            calibrationSwipesRef.current.curves.push(metrics.curve);
            calibrationSwipesRef.current.pitches.push(metrics.pitchDelta);
            calibrationSwipesRef.current.symmetries.push(metrics.symmetryRatio);
            calibrationSwipesRef.current.liftoffs.push(metrics.liftoffVy);

            const nextStep = calibrationStep + 1;
            panX.setValue(0);

            if (nextStep < 3) {
              setCalibrationStep(nextStep);
              setSliderFeedback({
                type: 'calib',
                message: `Recorded Swipe ${nextStep}/3. Perform Swipe ${nextStep + 1} across the same slider.`,
              });
            } else {
              // 3 Calibration Swipes Complete! Generate new envelopes
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
                name: `Custom Calibrated Profile (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
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
              setSliderMode('live');
              setCalibrationStep(0);
              calibrationSwipesRef.current = { curves: [], pitches: [], symmetries: [], liftoffs: [] };
              Vibration.vibrate([0, 100, 50, 150]);
              setSliderFeedback({
                type: 'success',
                message: '✅ New Slider Biometric Enrolled! Slider is now locked to your personal swipe dynamics.',
              });
              void sendAlertToDashboard('SLIDER_CALIBRATION');
            }
          }
          // --- MODE 2: LIVE DELIVERY COMPLETION ---
          else {
            const metrics = processSwipeTrajectory(
              trajectoryRef.current,
              durationMs,
              gesture.vy ?? 0,
              sliderBaseline
            );
            setLastSliderResult(metrics);

            if (metrics.isRejected) {
              // Biometric Breach!
              Vibration.vibrate([0, 160, 80, 220]);
              setSliderFeedback({
                type: 'error',
                message: `⚠️ Biometric Mismatch (${metrics.confidencePct}% Confidence): Trajectory outside biological baseline!`,
              });
              void sendAlertToDashboard('SLIDER_BIOMETRIC_FAIL', { slider_metrics: metrics });
              Animated.spring(panX, { toValue: 0, bounciness: 6, useNativeDriver: false }).start();
            } else {
              // Biometric Verified! Complete Order & Return to Screen 1 (Call Customer)
              Vibration.vibrate(70);
              setSliderFeedback({
                type: 'success',
                message: `✅ Biometric Match (${metrics.confidencePct}% Confidence)! Order Completed.`,
              });
              void sendAlertToDashboard('SLIDER_BIOMETRIC_PASS', { slider_metrics: metrics });

              Animated.timing(panX, {
                toValue: MAX_SLIDE,
                duration: 140,
                useNativeDriver: false,
              }).start(() => {
                setTimeout(() => {
                  panX.setValue(0);
                  setCurrentScreen('call_customer');
                  setOrderCompletedBanner(true);
                }, 1000);
              });
            }
          }
        } else {
          // Snap back if swipe wasn't completed
          Animated.spring(panX, { toValue: 0, bounciness: 5, useNativeDriver: false }).start();
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

      {/* Top Fixed Screen Switcher Tabs */}
      <View style={styles.topNav}>
        <Pressable
          onPress={() => setCurrentScreen('call_customer')}
          style={[styles.navTab, currentScreen === 'call_customer' && styles.navTabActive]}
        >
          <Text style={[styles.navTabText, currentScreen === 'call_customer' && styles.navTabTextActive]}>
            1. Call Customer
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setCurrentScreen('hardware_gps')}
          style={[styles.navTab, currentScreen === 'hardware_gps' && styles.navTabActive]}
        >
          <Text style={[styles.navTabText, currentScreen === 'hardware_gps' && styles.navTabTextActive]}>
            2. Hardware & GPS
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setCurrentScreen('complete_delivery')}
          style={[styles.navTab, currentScreen === 'complete_delivery' && styles.navTabActive]}
        >
          <Text style={[styles.navTabText, currentScreen === 'complete_delivery' && styles.navTabTextActive]}>
            3. Complete Delivery
          </Text>
        </Pressable>
      </View>

      {/* =================================================================== */}
      {/* SCREEN 1: CALL CUSTOMER (VOICE CHECK) — STRICTLY NON-SCROLLABLE    */}
      {/* =================================================================== */}
      {currentScreen === 'call_customer' && (
        <View style={styles.nonScrollablePage}>
          <View style={styles.headerRow}>
            <View style={styles.statusPill}>
              <View style={styles.greenDot} />
              <Text style={styles.statusPillText}>ACTIVE ORDER #HF-9402</Text>
            </View>
            <View style={[styles.badge, enrollmentStatus?.enrolled ? styles.badgeSuccess : styles.badgeWarn]}>
              <Text style={[styles.badgeText, enrollmentStatus?.enrolled ? styles.badgeTextSuccess : styles.badgeTextWarn]}>
                {enrollmentStatus?.enrolled ? '5/5 BASELINE ENROLLED' : 'NO BASELINE'}
              </Text>
            </View>
          </View>

          {orderCompletedBanner && (
            <View style={styles.completedToast}>
              <Text style={styles.completedToastTitle}>🎉 ORDER DELIVERED SUCCESSFULLY</Text>
              <Text style={styles.completedToastSub}>Biometric slider verification passed on device.</Text>
            </View>
          )}

          <Text style={styles.eyebrow}>STEP 1: RIDER VOICE CHECK</Text>
          <Text style={styles.title}>Call Customer</Text>

          {/* Voice Baseline Status Card */}
          <View style={styles.compactCard}>
            <Text style={styles.compactCardLabel}>ENROLLED VOICE BASELINE</Text>
            <Text style={styles.compactCardVal}>
              {enrollmentStatus?.enrolled
                ? `Saved to persistent storage (${enrollmentStatus.created_at ? new Date(enrollmentStatus.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Ready'})`
                : 'No baseline enrolled yet.'}
            </Text>
            {enrollmentStatus?.has_previous_baseline && lastEnrollmentComparison?.similarity != null && (
              <View style={styles.previousComparisonBox}>
                <Text style={styles.previousComparisonText}>
                  Previous baseline cosine match: <Text style={styles.boldText}>{lastEnrollmentComparison.similarity.toFixed(3)}</Text> ({lastEnrollmentComparison.verdict ?? 'Same speaker'})
                </Text>
              </View>
            )}
          </View>

          {/* Voice Actions Card */}
          <View style={styles.compactCard}>
            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>RIDER ID:</Text>
              <TextInput
                value={riderId}
                onChangeText={(val) => {
                  setRiderId(val);
                  void fetchBaselineStatus(val);
                }}
                autoCapitalize="none"
                editable={!busy}
                style={styles.compactInput}
              />
              <Text style={styles.shiftSlotText}>Slot: Call #{callNumber}</Text>
            </View>

            <Pressable
              disabled={busy || !permissionGranted}
              onPress={() => void captureEnrollmentBatch()}
              style={[styles.buttonSecondary, (busy || !permissionGranted) && styles.buttonDisabled]}
            >
              <Text style={styles.buttonSecondaryText}>
                {enrollmentStatus?.enrolled ? 'Re-enroll Baseline · 5 × 10s (Compares with Old)' : 'Enroll Five Voice Samples · 5 × 10s'}
              </Text>
            </Pressable>

            <Pressable
              disabled={busy || !permissionGranted}
              onPress={() => void captureCall()}
              style={[styles.buttonPrimary, (busy || !permissionGranted) && styles.buttonDisabled]}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonPrimaryText}>Call Customer · Record 8s</Text>}
            </Pressable>

            <Text style={styles.statusHelper}>{statusText}</Text>
          </View>

          {/* Result Card if available */}
          {result && (
            <View style={[styles.compactResultCard, { borderColor: verdictColor }]}>
              <View style={[styles.resultTopBar, { backgroundColor: verdictColor }]}>
                <Text style={styles.resultTopBarText}>{result.verdict.toUpperCase()} · SIMILARITY: {result.kyc_similarity?.toFixed(3) ?? '—'}</Text>
              </View>
              <Text style={[styles.speakerVerdictText, { color: speakerVerdict.color }]}>{speakerVerdict.label}</Text>
              <Text style={styles.resultReason}>{speakerVerdict.description}</Text>
            </View>
          )}

          {/* Screen 1 Bottom Navigation CTA */}
          <View style={styles.screenBottomNav}>
            <Pressable
              onPress={() => setCurrentScreen('hardware_gps')}
              style={styles.nextScreenBtn}
            >
              <Text style={styles.nextScreenBtnText}>Next: 2. Hardware & GPS Controls →</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* =================================================================== */}
      {/* SCREEN 2: HARDWARE & GPS CONTROLS — STRICTLY NON-SCROLLABLE        */}
      {/* =================================================================== */}
      {currentScreen === 'hardware_gps' && (
        <View style={styles.nonScrollablePage}>
          <View style={styles.headerRow}>
            <Text style={styles.eyebrow}>STEP 2: TELEMETRY & HARDWARE</Text>
            <View style={[styles.badge, isMockLocation ? styles.badgeDanger : styles.badgeSuccess]}>
              <Text style={[styles.badgeText, isMockLocation ? styles.badgeTextDanger : styles.badgeTextSuccess]}>
                {isMockLocation ? 'SPOOFED GPS' : 'NORMAL GPS'}
              </Text>
            </View>
          </View>

          <Text style={styles.title}>Hardware & GPS</Text>
          <Text style={styles.subtitle}>
            Simulate sudden location jumps or rogue device IDs. Instant alerts are dispatched to the dashboard.
          </Text>

          {/* Status Details Card */}
          <View style={styles.compactCard}>
            <View style={styles.telemetryRow}>
              <View style={styles.telemetryCol}>
                <Text style={styles.metricLabel}>LOCATION</Text>
                <Text style={styles.telemetryValue} numberOfLines={1}>{locationLabel}</Text>
                <Text style={styles.subtext}>{coordinates.lat.toFixed(4)}° N, {coordinates.lon.toFixed(4)}° E</Text>
              </View>
              <View style={styles.telemetryCol}>
                <Text style={styles.metricLabel}>VELOCITY</Text>
                <Text style={[styles.telemetryValue, speedKmh > 100 && styles.telemetryValueDanger]}>
                  {speedKmh.toFixed(1)} km/h
                </Text>
                <Text style={styles.subtext}>{speedKmh > 100 ? '⚡ Impossible Travel' : 'Road Transit'}</Text>
              </View>
            </View>

            <View style={styles.deviceRow}>
              <Text style={styles.metricLabel}>HARDWARE DEVICE ID</Text>
              <Text style={[styles.deviceIdText, isRogueDevice && styles.deviceIdTextDanger]}>{deviceId}</Text>
            </View>
          </View>

          {/* Controls Card */}
          <View style={styles.compactCard}>
            <Text style={styles.compactCardLabel}>TRIGGER DASHBOARD ALERTS</Text>

            <View style={styles.buttonRow}>
              <Pressable
                onPress={() => void handleSetCurrentLocation()}
                style={[styles.locationBtn, styles.locationBtnNormal]}
              >
                <Text style={styles.locationBtnNormalText}>📍 Set Current Location</Text>
                <Text style={styles.btnSub}>Normal GPS (24km/h)</Text>
              </Pressable>

              <Pressable
                onPress={() => void handleSetMockLocation()}
                style={[styles.locationBtn, styles.locationBtnMock]}
              >
                <Text style={styles.locationBtnMockText}>⚡ Set Mock Location</Text>
                <Text style={styles.btnSubDanger}>Sudden Leap (850km/h)</Text>
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

          {/* Alert Notification Card */}
          {alertDispatched && (
            <View style={[styles.alertBannerBox, isMockLocation || isRogueDevice ? styles.alertBannerDanger : styles.alertBannerSuccess]}>
              <Text style={[styles.alertBannerText, isMockLocation || isRogueDevice ? styles.alertBannerTextDanger : styles.alertBannerTextSuccess]}>
                {alertDispatched}
              </Text>
            </View>
          )}

          {/* Screen 2 Bottom Navigation CTA */}
          <View style={styles.screenBottomNavRow}>
            <Pressable
              onPress={() => setCurrentScreen('call_customer')}
              style={styles.backScreenBtn}
            >
              <Text style={styles.backScreenBtnText}>← 1. Call Customer</Text>
            </Pressable>
            <Pressable
              onPress={() => setCurrentScreen('complete_delivery')}
              style={styles.forwardScreenBtn}
            >
              <Text style={styles.forwardScreenBtnText}>3. Complete Delivery →</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* =================================================================== */}
      {/* SCREEN 3: COMPLETE DELIVERY — STRICTLY NON-SCROLLABLE              */}
      {/* Slider is permanently pinned at bottom; position NEVER changes      */}
      {/* =================================================================== */}
      {currentScreen === 'complete_delivery' && (
        <View style={styles.nonScrollablePage}>
          <View style={styles.headerRow}>
            <Text style={styles.eyebrow}>STEP 3: DROP-OFF COMPLETION</Text>
            <View style={[styles.badge, sliderBaseline.isCustom ? styles.badgeSuccess : styles.badgeNeutral]}>
              <Text style={[styles.badgeText, sliderBaseline.isCustom ? styles.badgeTextSuccess : styles.badgeTextNeutral]}>
                {sliderBaseline.isCustom ? 'CUSTOM CALIBRATED' : 'DEFAULT BASELINE'}
              </Text>
            </View>
          </View>

          <Text style={styles.title}>Complete Delivery</Text>

          {/* Compact Order Drop-off Card */}
          <View style={styles.compactCard}>
            <View style={styles.orderSummaryRow}>
              <View>
                <Text style={styles.customerName}>Pooja K. · Flat 402, Sea Breeze</Text>
                <Text style={styles.orderItems}>2x Farmhouse Pizza · ₹420 Cashless Paid</Text>
              </View>
              <Pressable
                onPress={() => setCurrentScreen('call_customer')}
                style={styles.screenChangeLink}
              >
                <Text style={styles.screenChangeLinkText}>← Call Customer</Text>
              </Pressable>
            </View>
          </View>

          {/* Slider Biometric Profile & Mode Card */}
          <View style={styles.compactCard}>
            <View style={styles.sliderProfileHeader}>
              <Text style={styles.compactCardLabel}>BIOMETRIC PROFILE STATUS</Text>
              <Pressable
                onPress={() => {
                  if (sliderMode === 'live') {
                    setSliderMode('calibrate');
                    setCalibrationStep(0);
                    calibrationSwipesRef.current = { curves: [], pitches: [], symmetries: [], liftoffs: [] };
                    setSliderFeedback({
                      type: 'calib',
                      message: 'Calibration active: Swipe 1 of 3 across the slider below.',
                    });
                  } else {
                    setSliderMode('live');
                    setSliderFeedback(null);
                  }
                }}
                style={[styles.calibrateToggleBtn, sliderMode === 'calibrate' && styles.calibrateToggleBtnActive]}
              >
                <Text style={[styles.calibrateToggleBtnText, sliderMode === 'calibrate' && styles.calibrateToggleBtnTextActive]}>
                  {sliderMode === 'calibrate' ? '✕ Cancel Calibration' : '🎯 Calibrate (3 Swipes)'}
                </Text>
              </Pressable>
            </View>

            {sliderMode === 'calibrate' ? (
              <View style={styles.calibrationStatusBox}>
                <Text style={styles.calibTitle}>CALIBRATING BIOMETRIC SLIDER</Text>
                <Text style={styles.calibInstruction}>
                  Swipe naturally on the slider below. Hand posture and thumb joint angle are recorded.
                </Text>
                <View style={styles.stepPillRow}>
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
              </View>
            ) : (
              <View style={styles.baselineMetricsGrid}>
                <View style={styles.baselineMetricCol}>
                  <Text style={styles.metricLabel}>PITCH-PUSH</Text>
                  <Text style={styles.baselineVal}>+{sliderBaseline.baselinePitchPush.toFixed(1)}°</Text>
                </View>
                <View style={styles.baselineMetricCol}>
                  <Text style={styles.metricLabel}>SYMMETRY</Text>
                  <Text style={styles.baselineVal}>{sliderBaseline.baselineSymmetry.toFixed(3)}</Text>
                </View>
                <View style={styles.baselineMetricCol}>
                  <Text style={styles.metricLabel}>LIFTOFF HOOK</Text>
                  <Text style={styles.baselineVal}>{sliderBaseline.baselineLiftoffVy.toFixed(3)}</Text>
                </View>
              </View>
            )}
          </View>

          {/* Feedback Notification Box */}
          {sliderFeedback && (
            <View style={[
              styles.feedbackBox,
              sliderFeedback.type === 'error' && styles.feedbackBoxError,
              sliderFeedback.type === 'success' && styles.feedbackBoxSuccess,
              sliderFeedback.type === 'calib' && styles.feedbackBoxCalib,
            ]}>
              <Text style={[
                styles.feedbackText,
                sliderFeedback.type === 'error' && styles.feedbackTextError,
                sliderFeedback.type === 'success' && styles.feedbackTextSuccess,
                sliderFeedback.type === 'calib' && styles.feedbackTextCalib,
              ]}>
                {sliderFeedback.message}
              </Text>
            </View>
          )}

          {/* --------------------------------------------------------------- */}
          {/* PERMANENT STATIC SLIDER AT SCREEN BOTTOM                        */}
          {/* Position NEVER shifts between live and calibration modes        */}
          {/* --------------------------------------------------------------- */}
          <View style={styles.staticSliderAnchor}>
            <Text style={styles.sliderInstruction}>
              {sliderMode === 'calibrate'
                ? `CALIBRATION MODE · SWIPE ${calibrationStep + 1} OF 3`
                : 'SLIDE TO COMPLETE ORDER'}
            </Text>

            <View style={[styles.sliderTrack, sliderMode === 'calibrate' && styles.sliderTrackCalib]}>
              <Text style={styles.sliderTrackText}>
                {sliderMode === 'calibrate' ? 'Slide across to calibrate →' : 'Slide to Complete Delivery →'}
              </Text>

              <Animated.View
                {...sliderPanResponder.panHandlers}
                style={[
                  styles.sliderThumb,
                  sliderMode === 'calibrate' && styles.sliderThumbCalib,
                  { transform: [{ translateX: panX }] },
                ]}
              >
                <Text style={styles.sliderThumbText}>→</Text>
              </Animated.View>
            </View>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getSpeakerVerdict(status: string, overallVerdict?: ApiResponse['verdict']) {
  if (overallVerdict === 'step_up') {
    return {
      label: 'UNCERTAIN · STEP-UP',
      description: status === 'warn'
        ? 'Voice match is marginal. Use in-app step-up.'
        : 'Overall check needs step-up. Rider unconfirmed.',
      color: '#a96800',
    };
  }
  if (status === 'passed') {
    return { label: 'SAME SPEAKER LIKELY', description: 'Voice matches enrolled baseline.', color: '#147d53' };
  }
  if (status === 'warn') {
    return { label: 'UNCERTAIN · STEP-UP', description: 'Voice match marginal. Review similarity.', color: '#a96800' };
  }
  if (status === 'alert' || status === 'failed') {
    return { label: 'VOICE MISMATCH SUSPECTED', description: 'Sample below match threshold.', color: '#ba3038' };
  }
  return { label: 'NOT COMPARED', description: 'No enrolled KYC baseline available.', color: '#526579' };
}

// ---------------------------------------------------------------------------
// Stylesheet — Strict Non-Scrollable Layouts & Static Pinned Slider
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f1f5f9' },

  // Fixed top navigation bar
  topNav: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 8,
  },
  navTab: {
    flex: 1,
    paddingVertical: 11,
    alignItems: 'center',
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  navTabActive: {
    borderBottomColor: '#0f766e',
  },
  navTabText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
  },
  navTabTextActive: {
    color: '#0f766e',
    fontWeight: '900',
  },

  // Strictly non-scrollable page container
  nonScrollablePage: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    position: 'relative',
  },

  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  greenDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#0284c7',
    marginRight: 5,
  },
  statusPillText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#0369a1',
    letterSpacing: 0.5,
  },

  eyebrow: { color: '#0f766e', fontWeight: '800', letterSpacing: 1.2, fontSize: 10 },
  title: { color: '#0f172a', fontSize: 22, fontWeight: '900', marginTop: 2, marginBottom: 4 },
  subtitle: { color: '#64748b', fontSize: 11, lineHeight: 16, marginBottom: 8 },

  completedToast: {
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
    borderRadius: 10,
    padding: 8,
    marginBottom: 8,
  },
  completedToastTitle: { color: '#065f46', fontWeight: '900', fontSize: 12 },
  completedToastSub: { color: '#047857', fontSize: 11, marginTop: 1 },

  // Compact Cards
  compactCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  compactCardLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748b',
    letterSpacing: 0.6,
  },
  compactCardVal: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
    marginTop: 2,
  },

  previousComparisonBox: {
    backgroundColor: '#f8fafc',
    borderLeftWidth: 3,
    borderLeftColor: '#0f766e',
    padding: 6,
    borderRadius: 4,
    marginTop: 6,
  },
  previousComparisonText: {
    fontSize: 11,
    color: '#334155',
  },
  boldText: {
    fontWeight: '800',
    color: '#0f172a',
  },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  inputLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748b',
  },
  compactInput: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
  },
  shiftSlotText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#0f766e',
  },

  buttonPrimary: {
    backgroundColor: '#0f766e',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
  },
  buttonPrimaryText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
  },
  buttonSecondary: {
    backgroundColor: '#ccfbf1',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSecondaryText: {
    color: '#0f766e',
    fontWeight: '800',
    fontSize: 11,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  statusHelper: {
    fontSize: 10,
    color: '#64748b',
    textAlign: 'center',
    marginTop: 6,
  },

  compactResultCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1.5,
    overflow: 'hidden',
    paddingBottom: 8,
    marginBottom: 8,
  },
  resultTopBar: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  resultTopBarText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  speakerVerdictText: {
    fontSize: 12,
    fontWeight: '900',
    marginTop: 6,
    marginHorizontal: 10,
  },
  resultReason: {
    fontSize: 10,
    color: '#64748b',
    marginHorizontal: 10,
    marginTop: 2,
  },

  screenBottomNav: {
    marginTop: 'auto',
  },
  nextScreenBtn: {
    backgroundColor: '#0f766e',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  nextScreenBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
  },

  screenBottomNavRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 'auto',
  },
  backScreenBtn: {
    flex: 1,
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  backScreenBtnText: {
    color: '#475569',
    fontWeight: '800',
    fontSize: 12,
  },
  forwardScreenBtn: {
    flex: 1,
    backgroundColor: '#0f766e',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  forwardScreenBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 12,
  },

  // Screen 2 Telemetry styles
  telemetryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  telemetryCol: {
    flex: 1,
  },
  metricLabel: {
    color: '#64748b',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  telemetryValue: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 1,
  },
  telemetryValueDanger: {
    color: '#dc2626',
  },
  subtext: {
    fontSize: 9,
    color: '#64748b',
    marginTop: 1,
  },
  deviceRow: {
    marginTop: 8,
    backgroundColor: '#f8fafc',
    padding: 8,
    borderRadius: 6,
  },
  deviceIdText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#334155',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginTop: 1,
  },
  deviceIdTextDanger: {
    color: '#dc2626',
  },

  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  locationBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 10,
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
    fontSize: 11,
  },
  locationBtnMock: {
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#fca5a5',
  },
  locationBtnMockText: {
    color: '#b91c1c',
    fontWeight: '800',
    fontSize: 11,
  },
  btnSub: {
    fontSize: 8,
    color: '#0284c7',
    marginTop: 1,
  },
  btnSubDanger: {
    fontSize: 8,
    color: '#dc2626',
    fontWeight: '700',
    marginTop: 1,
  },

  deviceToggleBtn: {
    marginTop: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  deviceToggleBtnActive: {
    backgroundColor: '#fef2f2',
    borderColor: '#f87171',
  },
  deviceToggleText: {
    color: '#334155',
    fontWeight: '800',
    fontSize: 11,
  },
  deviceToggleTextActive: {
    color: '#dc2626',
  },

  alertBannerBox: {
    padding: 10,
    borderRadius: 8,
    marginBottom: 8,
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
    fontSize: 11,
    fontWeight: '800',
  },
  alertBannerTextDanger: {
    color: '#991b1b',
  },
  alertBannerTextSuccess: {
    color: '#166534',
  },

  // Screen 3 Complete Delivery styles
  orderSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  customerName: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  orderItems: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  screenChangeLink: {
    padding: 4,
  },
  screenChangeLinkText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0f766e',
  },

  sliderProfileHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  calibrateToggleBtn: {
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  calibrateToggleBtnActive: {
    backgroundColor: '#fee2e2',
  },
  calibrateToggleBtnText: {
    color: '#0369a1',
    fontSize: 10,
    fontWeight: '800',
  },
  calibrateToggleBtnTextActive: {
    color: '#b91c1c',
  },

  baselineMetricsGrid: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  baselineMetricCol: {
    flex: 1,
  },
  baselineVal: {
    fontSize: 12,
    fontWeight: '800',
    color: '#1e293b',
    marginTop: 1,
  },

  calibrationStatusBox: {
    backgroundColor: '#f0fdfa',
    borderWidth: 1,
    borderColor: '#99f6e4',
    padding: 8,
    borderRadius: 8,
  },
  calibTitle: {
    color: '#0f766e',
    fontWeight: '900',
    fontSize: 11,
  },
  calibInstruction: {
    color: '#115e59',
    fontSize: 10,
    marginTop: 1,
    marginBottom: 6,
  },
  stepPillRow: {
    flexDirection: 'row',
    gap: 6,
  },
  stepPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: '#ccfbf1',
  },
  stepPillActive: {
    backgroundColor: '#0f766e',
  },
  stepPillCompleted: {
    backgroundColor: '#bbf7d0',
  },
  stepPillText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#0f172a',
  },

  feedbackBox: {
    padding: 8,
    borderRadius: 8,
    marginBottom: 8,
  },
  feedbackBoxError: { backgroundColor: '#fef2f2' },
  feedbackBoxSuccess: { backgroundColor: '#f0fdf4' },
  feedbackBoxCalib: { backgroundColor: '#f0fdfa' },
  feedbackText: { fontSize: 11, fontWeight: '800', textAlign: 'center' },
  feedbackTextError: { color: '#b91c1c' },
  feedbackTextSuccess: { color: '#166534' },
  feedbackTextCalib: { color: '#0f766e' },

  // -------------------------------------------------------------------------
  // THE PERMANENT STATIC SLIDER ANCHOR
  // Position NEVER shifts by 1 pixel regardless of mode
  // -------------------------------------------------------------------------
  staticSliderAnchor: {
    position: 'absolute',
    bottom: 24,
    left: 18,
    right: 18,
    alignItems: 'center',
  },
  sliderInstruction: {
    fontSize: 10,
    fontWeight: '900',
    color: '#0f766e',
    letterSpacing: 1.1,
    marginBottom: 8,
  },
  sliderTrack: {
    width: SLIDER_WIDTH,
    height: SLIDER_HEIGHT,
    backgroundColor: '#0f172a',
    borderRadius: 28,
    justifyContent: 'center',
    paddingHorizontal: 4,
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1.5,
    borderColor: '#334155',
  },
  sliderTrackCalib: {
    borderColor: '#14b8a6',
    backgroundColor: '#042f2e',
  },
  sliderTrackText: {
    position: 'absolute',
    alignSelf: 'center',
    color: '#cbd5e1',
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 0.5,
  },
  sliderThumb: {
    width: SLIDER_THUMB_SIZE,
    height: SLIDER_THUMB_SIZE,
    borderRadius: 24,
    backgroundColor: '#14b8a6',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  sliderThumbCalib: {
    backgroundColor: '#38bdf8',
  },
  sliderThumbText: {
    color: '#042f2e',
    fontSize: 20,
    fontWeight: '900',
  },

  // Badges
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 9,
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
});
