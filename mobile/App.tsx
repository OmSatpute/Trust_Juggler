import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Easing,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
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
import * as Location from 'expo-location';

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
const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://10.125.167.120:8000').replace(/\/$/, '');
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
  symmetryEnvelope: { min: 0.33, max: 0.42, margin: 0.06, envMin: 0.27, envMax: 0.48, mean: 0.375 },
  baselineLiftoffVy: -0.320,
  liftoffVyEnvelope: { min: -0.55, max: -0.15, margin: 0.20, envMin: -0.75, envMax: 0.05, mean: -0.320 },
  calibratedAt: 'Enrolled KYC Baseline (Rider-01)',
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
  const [isIpChanged, setIsIpChanged] = useState(false);
  const [locationLabel, setLocationLabel] = useState('Bandra West, Mumbai (Authentic)');
  const [coordinates, setCoordinates] = useState({ lat: 19.1031, lon: 72.8402 });
  const [speedKmh, setSpeedKmh] = useState(24.5);
  const [deviceId, setDeviceId] = useState('SM-G998B_Android_14_OEM');
  const [ipAddress, setIpAddress] = useState('10.125.167.146 (Cellular LTE)');
  const [alertDispatched, setAlertDispatched] = useState<string | null>(null);
  const [alertSeverity, setAlertSeverity] = useState<'normal' | 'warn' | 'alert'>('normal');
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

  // Synchronized refs to eliminate React stale closures in PanResponder
  const sliderModeRef = useRef(sliderMode);
  sliderModeRef.current = sliderMode;

  const calibrationStepRef = useRef(calibrationStep);
  calibrationStepRef.current = calibrationStep;

  const sliderBaselineRef = useRef(sliderBaseline);
  sliderBaselineRef.current = sliderBaseline;

  // Pinned Bottom Slider Pan & Trajectory
  const panX = useRef(new Animated.Value(0)).current;
  const startYRef = useRef(0);
  const startTimeRef = useRef(0);
  const smoothYRef = useRef<number | null>(null);
  const trajectoryRef = useRef<{ progress: number; relY: number; time: number; pitch: number }[]>([]);

  // ── High-Fidelity Google Pay Tick Mark Animation (Parity with face_app) ──
  const [deliverySuccessVisible, setDeliverySuccessVisible] = useState(false);
  const [isForceCompleted, setIsForceCompleted] = useState(false);
  const checkScaleAnim = useRef(new Animated.Value(0)).current;
  const ripple1Anim = useRef(new Animated.Value(0)).current;
  const ripple2Anim = useRef(new Animated.Value(0)).current;
  const cardSlideAnim = useRef(new Animated.Value(40)).current;
  const cardFadeAnim = useRef(new Animated.Value(0)).current;
  const successDismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissDeliverySuccessModal = useCallback(() => {
    if (successDismissTimeoutRef.current) {
      clearTimeout(successDismissTimeoutRef.current);
      successDismissTimeoutRef.current = null;
    }
    setDeliverySuccessVisible(false);
    setIsForceCompleted(false);
    panX.setValue(0);
    setCurrentScreen('call_customer');
    setOrderCompletedBanner(true);
  }, [panX]);

  const playDeliverySuccessAnimation = useCallback(() => {
    setDeliverySuccessVisible(true);
    Vibration.vibrate([0, 50, 40, 100]);
    checkScaleAnim.setValue(0);
    ripple1Anim.setValue(0);
    ripple2Anim.setValue(0);
    cardSlideAnim.setValue(40);
    cardFadeAnim.setValue(0);

    Animated.parallel([
      // Primary Bouncy Checkmark Pop
      Animated.spring(checkScaleAnim, {
        toValue: 1,
        friction: 5,
        tension: 110,
        useNativeDriver: true,
      }),
      // Expanding Ripple 1
      Animated.timing(ripple1Anim, {
        toValue: 1,
        duration: 1000,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      // Expanding Ripple 2 (Staggered)
      Animated.sequence([
        Animated.delay(180),
        Animated.timing(ripple2Anim, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
      // Card Slide Up & Fade In
      Animated.timing(cardSlideAnim, {
        toValue: 0,
        duration: 450,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(cardFadeAnim, {
        toValue: 1,
        duration: 450,
        useNativeDriver: true,
      }),
    ]).start();

    if (successDismissTimeoutRef.current) clearTimeout(successDismissTimeoutRef.current);
    successDismissTimeoutRef.current = setTimeout(() => {
      dismissDeliverySuccessModal();
    }, 3200);
  }, [checkScaleAnim, ripple1Anim, ripple2Anim, cardSlideAnim, cardFadeAnim, dismissDeliverySuccessModal]);

  // IMU sensor readings with 2nd-order cascaded low-pass filter (parity with trust-juggler-app)
  const isSensorInitRef = useRef(false);
  const currentPitchRef = useRef(2.1);
  const stage1PitchRef = useRef(2.1);
  const stage2PitchRef = useRef(2.1);

  // -------------------------------------------------------------------------
  // Sensor Initialization (expo-sensors DeviceMotion) - 50 Hz Cascaded 2nd-Order LPF
  // -------------------------------------------------------------------------
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    void (async () => {
      try {
        const available = await DeviceMotion.isAvailableAsync();
        if (available) {
          DeviceMotion.setUpdateInterval(20); // 50 Hz sampling (parity with trust-juggler-app)
          sub = DeviceMotion.addListener((data: DeviceMotionMeasurement) => {
            const rawPitch = ((data.rotation?.beta ?? 0) * 180) / Math.PI;
            if (!isSensorInitRef.current) {
              stage1PitchRef.current = rawPitch;
              stage2PitchRef.current = rawPitch;
              currentPitchRef.current = rawPitch;
              isSensorInitRef.current = true;
            } else {
              // Cascaded 2nd-order Low-Pass Filter (alpha1 = 0.20, alpha2 = 0.25)
              stage1PitchRef.current = 0.20 * rawPitch + 0.80 * stage1PitchRef.current;
              stage2PitchRef.current = 0.25 * stage1PitchRef.current + 0.75 * stage2PitchRef.current;
              currentPitchRef.current = stage2PitchRef.current;
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
  // Nadaraya-Watson Gaussian Kernel Regression Helper (from trust-juggler-app)
  // -------------------------------------------------------------------------
  const getSmoothedCheckpoint = useCallback(
    (
      trajectory: { progress: number; relY: number; time: number; pitch: number }[],
      targetProgress: number,
      fallbackY: number,
      fallbackTime: number,
      fallbackPitch: number
    ): { y: number; time: number; pitch: number } => {
      if (trajectory.length === 0) {
        return { y: fallbackY, time: fallbackTime, pitch: fallbackPitch };
      }

      const SIGMA = 0.08;
      const TWO_SIGMA_SQ = 2 * SIGMA * SIGMA;

      let weightSum = 0;
      let ySum = 0;
      let timeSum = 0;
      let pitchSum = 0;

      for (let i = 0; i < trajectory.length; i++) {
        const pt = trajectory[i];
        const dist = pt.progress - targetProgress;
        const w = Math.exp(-(dist * dist) / TWO_SIGMA_SQ);
        weightSum += w;
        ySum += w * pt.relY;
        timeSum += w * pt.time;
        pitchSum += w * pt.pitch;
      }

      if (weightSum > 0.001) {
        return {
          y: Number((ySum / weightSum).toFixed(1)),
          time: Math.round(timeSum / weightSum),
          pitch: Number((pitchSum / weightSum).toFixed(2)),
        };
      }

      return { y: fallbackY, time: fallbackTime, pitch: fallbackPitch };
    },
    []
  );

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
    eventType: 'SUDDEN_LOCATION_CHANGE' | 'DEVICE_ID_CHANGE' | 'IP_ADDRESS_CHANGE' | 'SLIDER_BIOMETRIC_FAIL' | 'SLIDER_BIOMETRIC_PASS' | 'SET_CURRENT_LOCATION' | 'GET_CURRENT_GPS' | 'SLIDER_CALIBRATION' | 'FORCE_COMPLETE_DELIVERY',
    customData?: Record<string, unknown>
  ) => {
    const sliderMetrics = (customData?.slider_metrics as LiveSliderMetrics | undefined) || lastSliderResult;
    const stage3SliderPayload = (['SLIDER_BIOMETRIC_FAIL', 'SLIDER_BIOMETRIC_PASS'].includes(eventType) && sliderMetrics) ? {
      curve: sliderMetrics.curve,
      pitch_delta: sliderMetrics.pitchDelta,
      symmetry_ratio: sliderMetrics.symmetryRatio,
      liftoff_vy: sliderMetrics.liftoffVy,
      is_rejected: sliderMetrics.isRejected,
      confidence_pct: sliderMetrics.confidencePct,
    } : (eventType === 'SLIDER_CALIBRATION' ? {
      is_rejected: false,
      confidence_pct: 99,
      reason: '3-swipe kinetic baseline enrolled (Beta)',
    } : null);

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
        ip_address: ipAddress,
        is_ip_changed: isIpChanged || eventType === 'IP_ADDRESS_CHANGE',
      },
      stage_3_slider: stage3SliderPayload,
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
  const handleGetCurrentGps = async () => {
    setIsMockLocation(false);
    setIsRogueDevice(false);
    setIsIpChanged(false);
    setDeviceId('SM-G998B_Android_14_OEM');
    setIpAddress('10.125.167.146 (Cellular LTE)');
    let lat = 19.1031;
    let lon = 72.8402;
    let label = 'Bandra West, Mumbai (Authentic)';
    let speed = 24.5;
    let mockedDetected = false;

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        lat = loc.coords.latitude;
        lon = loc.coords.longitude;
        speed = Math.max(12.0, (loc.coords.speed ?? 0) * 3.6);
        mockedDetected = Boolean((loc.coords as any).mocked);
        label = mockedDetected ? 'Mock GPS Provider Detected' : `Live Device GPS (${lat.toFixed(3)}, ${lon.toFixed(3)})`;
      }
    } catch {
      // Fallback to authentic baseline coordinates
    }

    setCoordinates({ lat, lon });
    setSpeedKmh(mockedDetected ? 850.0 : speed);
    setLocationLabel(label);
    setIsMockLocation(mockedDetected);

    if (mockedDetected) {
      setAlertSeverity('alert');
      setAlertDispatched('🚨 Mock GPS Provider detected by OS! Alert sent to dashboard.');
      Vibration.vibrate([0, 180, 80, 220]);
      await sendAlertToDashboard('SUDDEN_LOCATION_CHANGE', {
        stage_1_network_gps: {
          is_impossible_travel: true,
          mock_location_detected: true,
          velocity_kmh: 850.0,
          distance_km: 840.2,
          latitude: lat,
          longitude: lon,
          device_id: 'SM-G998B_Android_14_OEM',
          ip_address: '10.125.167.146',
          is_ip_changed: false,
        },
      });
    } else {
      setAlertSeverity('normal');
      setAlertDispatched('✅ Current GPS acquired (Authentic). Normal signal sent to dashboard.');
      Vibration.vibrate(35);
      await sendAlertToDashboard('SET_CURRENT_LOCATION', {
        stage_1_network_gps: {
          is_impossible_travel: false,
          mock_location_detected: false,
          velocity_kmh: speed,
          distance_km: 0.1,
          latitude: lat,
          longitude: lon,
          device_id: 'SM-G998B_Android_14_OEM',
          ip_address: '10.125.167.146',
          is_ip_changed: false,
        },
      });
    }
  };

  const handleSetMockLocation = async () => {
    setIsMockLocation(true);
    setLocationLabel('Bengaluru Hub, Karnataka (SPOOFED LEAP)');
    setCoordinates({ lat: 12.9716, lon: 77.5946 });
    setSpeedKmh(850.0);
    setAlertSeverity('alert');
    setAlertDispatched('🚨 Sudden Location Change: Teleport Alert (850 km/h) sent to dashboard!');
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
        ip_address: ipAddress,
        is_ip_changed: isIpChanged,
      },
    });
  };

  const handleSimulateIpChange = async () => {
    const nextIp = !isIpChanged;
    setIsIpChanged(nextIp);
    const newIp = nextIp ? '185.220.101.5 (Datacenter Proxy/VPN)' : '10.125.167.146 (Cellular LTE)';
    setIpAddress(newIp);
    if (nextIp) {
      setAlertSeverity('warn');
      setAlertDispatched('⚠️ IP Changed: Datacenter Subnet detected. Warn signal sent to dashboard!');
      Vibration.vibrate([0, 100, 60, 100]);
      await sendAlertToDashboard('IP_ADDRESS_CHANGE', {
        stage_1_network_gps: {
          is_impossible_travel: isMockLocation,
          mock_location_detected: isMockLocation,
          velocity_kmh: speedKmh,
          distance_km: 0.2,
          latitude: coordinates.lat,
          longitude: coordinates.lon,
          device_id: deviceId,
          ip_address: '185.220.101.5',
          is_ip_changed: true,
        },
      });
    } else {
      setAlertSeverity('normal');
      setAlertDispatched('✅ Genuine Carrier IP restored. Normal signal sent.');
      Vibration.vibrate(30);
      await sendAlertToDashboard('GET_CURRENT_GPS');
    }
  };

  const handleToggleDeviceId = async () => {
    const nextRogue = !isRogueDevice;
    setIsRogueDevice(nextRogue);
    const newId = nextRogue ? 'ROGUE_EMULATOR_SPOOF_X86_ROOT' : 'SM-G998B_Android_14_OEM';
    setDeviceId(newId);
    if (nextRogue) {
      setAlertSeverity('alert');
      setAlertDispatched('🚨 Device Fingerprint Mismatch! Alert signal sent to dashboard!');
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
          ip_address: ipAddress,
          is_ip_changed: isIpChanged,
        },
      });
    } else {
      setAlertSeverity('normal');
      setAlertDispatched('✅ Genuine Device ID restored. Normal signal sent.');
      Vibration.vibrate(30);
      await sendAlertToDashboard('GET_CURRENT_GPS');
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
  // Biometric Gesture Calculation (Parity with trust-juggler-app)
  // -------------------------------------------------------------------------
  const processSwipeTrajectory = (
    trajectory: { progress: number; relY: number; time: number; pitch: number }[],
    totalDurationMs: number,
    rawVy: number,
    baseline: SliderBaselineProfile,
    lastRelYParam?: number
  ): LiveSliderMetrics => {
    const lastPitch = currentPitchRef.current;
    const startTime = startTimeRef.current;
    const endTime = startTime + totalDurationMs;
    const lastRelY = lastRelYParam ?? (trajectory.length > 0 ? trajectory[trajectory.length - 1].relY : 0);

    // 1. Smoothed Checkpoints [y25, y50, y75, y100] via Nadaraya-Watson Gaussian Kernel Regression
    const cp05 = getSmoothedCheckpoint(trajectory, 0.05, 0, startTime, lastPitch);
    const cp25 = getSmoothedCheckpoint(
      trajectory,
      0.25,
      lastRelY * 0.25,
      startTime + totalDurationMs * 0.25,
      lastPitch
    );
    const cp50 = getSmoothedCheckpoint(
      trajectory,
      0.5,
      lastRelY * 0.5,
      startTime + totalDurationMs * 0.5,
      lastPitch
    );
    const cp75 = getSmoothedCheckpoint(
      trajectory,
      0.75,
      lastRelY * 0.75,
      startTime + totalDurationMs * 0.75,
      lastPitch
    );
    const cp100 = getSmoothedCheckpoint(trajectory, 0.98, lastRelY, endTime, lastPitch);

    const liveCurve: [number, number, number, number] = [cp25.y, cp50.y, cp75.y, cp100.y];

    // 2. The 'Pitch-Push' Effect: tilt delta (cp100.pitch - cp05.pitch)
    const pitchAtStart = cp05.pitch;
    const pitchAtEnd = cp100.pitch;
    const pitchDelta = Number((pitchAtEnd - pitchAtStart).toFixed(2));

    // 3. Velocity Symmetry Ratio (MidpointTime / TotalTime)
    const midpointTime = Math.max(1, cp50.time - startTime);
    const symmetryRatio = Number((midpointTime / totalDurationMs).toFixed(3));

    // 4. Terminal Thumb Hook: trajectory derivative with 30ms window + native vy (trust-juggler-app)
    let trajVy = 0;
    if (trajectory.length >= 2) {
      const lastPt = trajectory[trajectory.length - 1];
      const recentPt =
        trajectory.slice().reverse().find((p) => lastPt.time - p.time >= 30) ??
        trajectory[0];
      const dt = Math.max(10, lastPt.time - recentPt.time);
      trajVy = (lastPt.relY - recentPt.relY) / dt;
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

    const failureCount =
      (isCurveFailed ? 1 : 0) +
      (isPitchPushFailed ? 1 : 0) +
      (isSymmetryFailed ? 1 : 0) +
      (isLiftoffFailed ? 1 : 0);
    const isRejected =
      isCurveFailed || isPitchPushFailed || isSymmetryFailed || isLiftoffFailed;

    let confidencePct = 98;
    if (failureCount === 1) confidencePct = 38;
    else if (failureCount === 2) confidencePct = 28;
    else if (failureCount >= 3) confidencePct = 15;

    const failedMetrics: string[] = [];
    if (isPitchPushFailed) {
      failedMetrics.push(
        `Pitch-Push: ${pitchDelta}° [Allowed: ${pEnv.envMin}° to ${pEnv.envMax}°] -> FAIL`
      );
    }
    if (isSymmetryFailed) {
      failedMetrics.push(
        `Velocity Symmetry: ${symmetryRatio} [Allowed: ${sEnv.envMin} to ${sEnv.envMax}] -> FAIL`
      );
    }
    if (isLiftoffFailed) {
      const reason = isLiftoffDivergence ? ' (Liftoff Divergence: missing upward hook)' : '';
      failedMetrics.push(
        `Thumb Hook: ${liftoffVy} [Allowed: ${vEnv.envMin} to ${vEnv.envMax}] -> FAIL${reason}`
      );
    }
    if (isCurveFailed) {
      const breachedStr = failedCurvePoints
        .map(
          (idx) =>
            `CP#${idx + 1} (${liveCurve[idx]}px outside [${baseline.curveEnvelopes[idx].envMin} to ${baseline.curveEnvelopes[idx].envMax}px])`
        )
        .join(', ');
      failedMetrics.push(`Thumb Curve: ${breachedStr} -> FAIL`);
    }

    if (isRejected) {
      console.log('🚨 [SLIDER BIOMETRIC REJECT] Swipe outside envelope (SUSPECT)!', {
        confidencePct,
        failedMetrics,
        pitchDelta,
        symmetryRatio,
        liftoffVy,
        liveCurve,
      });
    } else {
      console.log('✅ [SLIDER BIOMETRIC AUTHENTIC] Swipe matches enrolled envelope!', {
        confidencePct,
        pitchDelta,
        symmetryRatio,
        liftoffVy,
        liveCurve,
      });
    }

    return {
      curve: liveCurve,
      curveCheckpointsPassed,
      failedCurvePoints,
      isCurveFailed,
      pitchAtStart,
      pitchAtEnd,
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
  // Uses synchronized refs to eliminate React hook stale closures completely
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

        if (distanceX >= MAX_SLIDE * 0.75) {
          const currentMode = sliderModeRef.current;
          const currentStep = calibrationStepRef.current;
          const currentBaseline = sliderBaselineRef.current;

          // --- MODE 1: CALIBRATION SWIPE ---
          if (currentMode === 'calibrate') {
            Vibration.vibrate(55);
            const lastRelY = gesture.moveY - startYRef.current;
            const metrics = processSwipeTrajectory(
              trajectoryRef.current,
              durationMs,
              gesture.vy ?? 0,
              DEFAULT_SLIDER_BASELINE,
              lastRelY
            );

            calibrationSwipesRef.current.curves.push(metrics.curve);
            calibrationSwipesRef.current.pitches.push(metrics.pitchDelta);
            calibrationSwipesRef.current.symmetries.push(metrics.symmetryRatio);
            calibrationSwipesRef.current.liftoffs.push(metrics.liftoffVy);

            const nextStep = currentStep + 1;
            panX.setValue(0);

            if (nextStep < 3) {
              setCalibrationStep(nextStep);
              calibrationStepRef.current = nextStep;
              setSliderFeedback({
                type: 'calib',
                message: `✅ Swipe ${nextStep}/3 recorded! Swipe ${nextStep + 1} across the slider now.`,
              });
            } else {
              // 3 Calibration Swipes Complete! Generate new envelopes with authentic precision
              const curves = calibrationSwipesRef.current.curves;
              const pitches = calibrationSwipesRef.current.pitches;
              const symms = calibrationSwipesRef.current.symmetries;
              const liftoffs = calibrationSwipesRef.current.liftoffs;

              const env0 = computeEnvelope(curves.map((c) => c[0]), 3.5);
              const env1 = computeEnvelope(curves.map((c) => c[1]), 3.5);
              const env2 = computeEnvelope(curves.map((c) => c[2]), 3.5);
              const env3 = computeEnvelope(curves.map((c) => c[3]), 3.5);
              const pEnv = computeEnvelope(pitches, 1.25);
              const sEnv = computeEnvelope(symms, 0.06);
              const vEnv = computeEnvelope(liftoffs, 0.20);

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
              sliderBaselineRef.current = newProfile;
              setSliderMode('live');
              sliderModeRef.current = 'live';
              setCalibrationStep(0);
              calibrationStepRef.current = 0;
              calibrationSwipesRef.current = { curves: [], pitches: [], symmetries: [], liftoffs: [] };
              Vibration.vibrate([0, 100, 50, 150]);
              setSliderFeedback({
                type: 'success',
                message: '🎯 Calibration Enrolled (Beta)! Live delivery slider is now matched to your kinetic profile.',
              });
              void sendAlertToDashboard('SLIDER_CALIBRATION');
            }
          }
          // --- MODE 2: LIVE DELIVERY COMPLETION ---
          else {
            const lastRelY = gesture.moveY - startYRef.current;
            const metrics = processSwipeTrajectory(
              trajectoryRef.current,
              durationMs,
              gesture.vy ?? 0,
              currentBaseline,
              lastRelY
            );
            setLastSliderResult(metrics);

            if (metrics.isRejected) {
              // Biometric Breach!
              Vibration.vibrate([0, 160, 80, 220]);
              setSliderFeedback({
                type: 'error',
                message: `⚠️ Biometric Mismatch (${metrics.confidencePct}% Confidence): Trajectory deviated from calibrated baseline!`,
              });
              void sendAlertToDashboard('SLIDER_BIOMETRIC_FAIL', { slider_metrics: metrics });
              Animated.spring(panX, { toValue: 0, bounciness: 6, useNativeDriver: false }).start();
            } else {
              // Biometric Verified! Complete Order & Trigger GPay Success Tick Animation
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
                playDeliverySuccessAnimation();
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
  // Force Complete Delivery Handler (Bypasses kinetic slider with override)
  // -------------------------------------------------------------------------
  const handleForceCompleteDelivery = useCallback(() => {
    Alert.alert(
      '⚡ Force Complete Delivery',
      'Override biometric kinetic slider and mark order #HF-9402 as delivered (Manual supervisor / rider override)?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Force Complete ⚡',
          style: 'destructive',
          onPress: () => {
            setIsForceCompleted(true);
            Vibration.vibrate([0, 90, 50, 130]);
            setSliderFeedback({
              type: 'success',
              message: '⚡ Delivery Force Completed (Authorized Manual Bypass)!',
            });
            void sendAlertToDashboard('FORCE_COMPLETE_DELIVERY');
            Animated.timing(panX, {
              toValue: MAX_SLIDE,
              duration: 150,
              useNativeDriver: false,
            }).start(() => {
              playDeliverySuccessAnimation();
            });
          },
        },
      ]
    );
  }, [panX, playDeliverySuccessAnimation]);

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
            3. Complete Delivery (Beta)
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
            <View style={[
              styles.badge,
              isMockLocation || isRogueDevice ? styles.badgeDanger : (isIpChanged ? styles.badgeWarn : styles.badgeSuccess)
            ]}>
              <Text style={[
                styles.badgeText,
                isMockLocation || isRogueDevice ? styles.badgeTextDanger : (isIpChanged ? styles.badgeTextWarn : styles.badgeTextSuccess)
              ]}>
                {isMockLocation || isRogueDevice ? 'SECURITY ALERT' : (isIpChanged ? 'IP WARNING' : 'AUTHENTIC & NORMAL')}
              </Text>
            </View>
          </View>

          <Text style={styles.title}>Hardware & GPS</Text>
          <Text style={styles.subtitle}>
            Test location telemetry, network IP anomalies, and device identity against the dashboard.
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
              <Text style={styles.metricLabel}>SIGN-IN IP ADDRESS</Text>
              <Text style={[styles.deviceIdText, isIpChanged ? styles.deviceIdTextWarn : styles.deviceIdTextSuccess]}>
                {ipAddress}
              </Text>
            </View>

            <View style={[styles.deviceRow, { marginTop: 6 }]}>
              <Text style={styles.metricLabel}>HARDWARE DEVICE ID</Text>
              <Text style={[styles.deviceIdText, isRogueDevice ? styles.deviceIdTextDanger : styles.deviceIdTextSuccess]}>
                {deviceId}
              </Text>
            </View>
          </View>

          {/* Controls Card */}
          <View style={styles.compactCard}>
            <Text style={styles.compactCardLabel}>TRIGGER DASHBOARD SIGNALS</Text>

            {/* Row 1: GPS Controls */}
            <View style={styles.buttonRow}>
              <Pressable
                onPress={() => void handleGetCurrentGps()}
                style={[styles.locationBtn, styles.locationBtnNormal]}
              >
                <Text style={styles.locationBtnNormalText}>📍 Get Current GPS</Text>
                <Text style={styles.btnSub}>Normal Signal (Clear · 0)</Text>
              </Pressable>

              <Pressable
                onPress={() => void handleSetMockLocation()}
                style={[styles.locationBtn, styles.locationBtnMock]}
              >
                <Text style={styles.locationBtnMockText}>⚡ Mock GPS Leap</Text>
                <Text style={styles.btnSubDanger}>Teleport · Alert (100)</Text>
              </Pressable>
            </View>

            {/* Row 2: Context Anomalies */}
            <View style={[styles.buttonRow, { marginTop: 8 }]}>
              <Pressable
                onPress={() => void handleSimulateIpChange()}
                style={[styles.locationBtn, isIpChanged ? styles.locationBtnWarnActive : styles.locationBtnWarn]}
              >
                <Text style={[styles.locationBtnWarnText, isIpChanged && styles.locationBtnWarnTextActive]}>
                  {isIpChanged ? '🌐 Restore Carrier IP' : '🌐 Simulate IP Change'}
                </Text>
                <Text style={styles.btnSubWarn}>{isIpChanged ? 'Back to LTE Subnet' : 'VPN/Proxy · Warn (65)'}</Text>
              </Pressable>

              <Pressable
                onPress={() => void handleToggleDeviceId()}
                style={[styles.locationBtn, isRogueDevice ? styles.locationBtnRogueActive : styles.locationBtnRogue]}
              >
                <Text style={[styles.locationBtnRogueText, isRogueDevice && styles.locationBtnRogueTextActive]}>
                  {isRogueDevice ? '📱 Restore Device' : '📱 Rogue Device ID'}
                </Text>
                <Text style={styles.btnSubDanger}>{isRogueDevice ? 'Back to OEM Phone' : 'Fingerprint · Alert (100)'}</Text>
              </Pressable>
            </View>
          </View>

          {/* Alert Notification Card */}
          {alertDispatched && (
            <View style={[
              styles.alertBannerBox,
              alertSeverity === 'alert' ? styles.alertBannerDanger : (alertSeverity === 'warn' ? styles.alertBannerWarn : styles.alertBannerSuccess)
            ]}>
              <Text style={[
                styles.alertBannerText,
                alertSeverity === 'alert' ? styles.alertBannerTextDanger : (alertSeverity === 'warn' ? styles.alertBannerTextWarn : styles.alertBannerTextSuccess)
              ]}>
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
              <Text style={styles.forwardScreenBtnText}>3. Complete Delivery (Beta) →</Text>
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
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 120 }}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.headerRow}>
              <Text style={styles.eyebrow}>STEP 3: DROP-OFF COMPLETION</Text>
              <View style={[styles.badge, sliderBaseline.isCustom ? styles.badgeSuccess : styles.badgeNeutral]}>
                <Text style={[styles.badgeText, sliderBaseline.isCustom ? styles.badgeTextSuccess : styles.badgeTextNeutral]}>
                  {sliderBaseline.isCustom ? 'CUSTOM CALIBRATED' : 'DEFAULT BASELINE'}
                </Text>
              </View>
            </View>

            <View style={styles.titleWithBadgeRow}>
              <Text style={[styles.title, { marginTop: 0, marginBottom: 0 }]}>Complete Delivery</Text>
              <View style={styles.betaBadge}>
                <Text style={styles.betaBadgeText}>BETA</Text>
              </View>
            </View>

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
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {sliderBaseline.isCustom && (
                    <Pressable
                      onPress={() => {
                        setSliderBaseline(DEFAULT_SLIDER_BASELINE);
                        sliderBaselineRef.current = DEFAULT_SLIDER_BASELINE;
                        setSliderFeedback({
                          type: 'calib',
                          message: 'Reset to default Enrolled KYC Baseline (Rider-01).',
                        });
                        Vibration.vibrate(40);
                      }}
                      style={styles.calibrateToggleBtn}
                    >
                      <Text style={styles.calibrateToggleBtnText}>↺ Reset Baseline</Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => {
                      if (sliderMode === 'live') {
                        setSliderMode('calibrate');
                        sliderModeRef.current = 'calibrate';
                        setCalibrationStep(0);
                        calibrationStepRef.current = 0;
                        calibrationSwipesRef.current = { curves: [], pitches: [], symmetries: [], liftoffs: [] };
                        setSliderFeedback({
                          type: 'calib',
                          message: 'Calibration active: Swipe 1 of 3 across the slider below.',
                        });
                      } else {
                        setSliderMode('live');
                        sliderModeRef.current = 'live';
                        setCalibrationStep(0);
                        calibrationStepRef.current = 0;
                        setSliderFeedback(null);
                      }
                    }}
                    style={[styles.calibrateToggleBtn, sliderMode === 'calibrate' && styles.calibrateToggleBtnActive]}
                  >
                    <Text style={[styles.calibrateToggleBtnText, sliderMode === 'calibrate' && styles.calibrateToggleBtnTextActive]}>
                      {sliderMode === 'calibrate' ? '✕ Cancel' : '🎯 Calibrate'}
                    </Text>
                  </Pressable>
                </View>
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

            {/* ── Detailed Biometric Failure Diagnostics Card ── */}
            {lastSliderResult && lastSliderResult.isRejected && (
              <View style={styles.failureDiagnosticsCard}>
                <View style={styles.failureDiagnosticsHeader}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 13 }}>🚨</Text>
                    <Text style={styles.failureDiagnosticsTitle}>BIOMETRIC TELEMETRY BREACH</Text>
                  </View>
                  <View style={styles.failureConfidenceBadge}>
                    <Text style={styles.failureConfidenceText}>
                      {lastSliderResult.confidencePct}% CONFIDENCE
                    </Text>
                  </View>
                </View>

                <Text style={styles.failureDiagnosticsSubtitle}>
                  Trajectory deviated from {sliderBaseline.isCustom ? 'custom calibrated baseline' : 'enrolled KYC baseline (Rider-01)'}.
                </Text>

                {/* 4 Metric Breakdown Rows */}
                <View style={styles.diagnosticMetricsContainer}>
                  {/* Metric 1: Thumb Arc Curve */}
                  <View style={styles.diagnosticMetricRow}>
                    <View style={styles.diagnosticMetricHeader}>
                      <Text style={styles.diagnosticMetricName}>1. THUMB ARC CURVE</Text>
                      <View style={[styles.diagStatusBadge, lastSliderResult.isCurveFailed ? styles.diagStatusFail : styles.diagStatusPass]}>
                        <Text style={[styles.diagStatusText, lastSliderResult.isCurveFailed ? styles.diagStatusTextFail : styles.diagStatusTextPass]}>
                          {lastSliderResult.isCurveFailed ? 'BREACH' : 'OPTIMAL'}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.diagnosticMetricDetail}>
                      {lastSliderResult.curveCheckpointsPassed}/4 checkpoints passed
                    </Text>
                    <Text style={styles.diagnosticMetricValues}>
                      Live: [{lastSliderResult.curve.join(', ')}] px
                    </Text>
                    <Text style={styles.diagnosticMetricAllowed}>
                      Envelopes: CP1 [{sliderBaseline.curveEnvelopes[0].envMin}..{sliderBaseline.curveEnvelopes[0].envMax}] · CP2 [{sliderBaseline.curveEnvelopes[1].envMin}..{sliderBaseline.curveEnvelopes[1].envMax}] · CP3 [{sliderBaseline.curveEnvelopes[2].envMin}..{sliderBaseline.curveEnvelopes[2].envMax}] · CP4 [{sliderBaseline.curveEnvelopes[3].envMin}..{sliderBaseline.curveEnvelopes[3].envMax}]
                    </Text>
                  </View>

                  {/* Metric 2: Pitch-Push Tilt */}
                  <View style={styles.diagnosticMetricRow}>
                    <View style={styles.diagnosticMetricHeader}>
                      <Text style={styles.diagnosticMetricName}>2. PITCH-PUSH (IMU TILT)</Text>
                      <View style={[styles.diagStatusBadge, lastSliderResult.isPitchPushFailed ? styles.diagStatusFail : styles.diagStatusPass]}>
                        <Text style={[styles.diagStatusText, lastSliderResult.isPitchPushFailed ? styles.diagStatusTextFail : styles.diagStatusTextPass]}>
                          {lastSliderResult.isPitchPushFailed ? 'BREACH' : 'OPTIMAL'}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.diagnosticMetricDetail}>
                      Tilt delta: {lastSliderResult.pitchDelta > 0 ? '+' : ''}{lastSliderResult.pitchDelta}° (from {lastSliderResult.pitchAtStart.toFixed(1)}° to {lastSliderResult.pitchAtEnd.toFixed(1)}°)
                    </Text>
                    <Text style={styles.diagnosticMetricAllowed}>
                      Allowed envelope: [{sliderBaseline.pitchPushEnvelope.envMin}° .. {sliderBaseline.pitchPushEnvelope.envMax}°]
                    </Text>
                  </View>

                  {/* Metric 3: Velocity Symmetry */}
                  <View style={styles.diagnosticMetricRow}>
                    <View style={styles.diagnosticMetricHeader}>
                      <Text style={styles.diagnosticMetricName}>3. VELOCITY SYMMETRY</Text>
                      <View style={[styles.diagStatusBadge, lastSliderResult.isSymmetryFailed ? styles.diagStatusFail : styles.diagStatusPass]}>
                        <Text style={[styles.diagStatusText, lastSliderResult.isSymmetryFailed ? styles.diagStatusTextFail : styles.diagStatusTextPass]}>
                          {lastSliderResult.isSymmetryFailed ? 'BREACH' : 'OPTIMAL'}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.diagnosticMetricDetail}>
                      Symmetry ratio: {lastSliderResult.symmetryRatio} ({lastSliderResult.midpointTimeMs}ms / {lastSliderResult.totalTimeMs}ms)
                    </Text>
                    <Text style={styles.diagnosticMetricAllowed}>
                      Allowed envelope: [{sliderBaseline.symmetryEnvelope.envMin} .. {sliderBaseline.symmetryEnvelope.envMax}]
                    </Text>
                  </View>

                  {/* Metric 4: Thumb Hook (Liftoff Vy) */}
                  <View style={styles.diagnosticMetricRow}>
                    <View style={styles.diagnosticMetricHeader}>
                      <Text style={styles.diagnosticMetricName}>4. THUMB HOOK (LIFTOFF)</Text>
                      <View style={[styles.diagStatusBadge, lastSliderResult.isLiftoffFailed ? styles.diagStatusFail : styles.diagStatusPass]}>
                        <Text style={[styles.diagStatusText, lastSliderResult.isLiftoffFailed ? styles.diagStatusTextFail : styles.diagStatusTextPass]}>
                          {lastSliderResult.isLiftoffFailed ? 'BREACH' : 'OPTIMAL'}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.diagnosticMetricDetail}>
                      Terminal hook vy: {lastSliderResult.liftoffVy} px/ms
                    </Text>
                    <Text style={styles.diagnosticMetricAllowed}>
                      Allowed envelope: [{sliderBaseline.liftoffVyEnvelope.envMin} .. {sliderBaseline.liftoffVyEnvelope.envMax}]
                    </Text>
                  </View>
                </View>

                {/* Specific Failed Reasons Summary */}
                {lastSliderResult.failedMetrics.length > 0 && (
                  <View style={styles.failedReasonsBox}>
                    <Text style={styles.failedReasonsTitle}>SPECIFIC DEVIATIONS:</Text>
                    {lastSliderResult.failedMetrics.map((reason, idx) => (
                      <Text key={idx} style={styles.failedReasonItem}>• {reason}</Text>
                    ))}
                    <TouchableOpacity
                      style={styles.forceCompleteErrorBtn}
                      activeOpacity={0.85}
                      onPress={handleForceCompleteDelivery}
                    >
                      <Text style={styles.forceCompleteErrorBtnText}>⚡ Force Complete Delivery (Supervisor Override)</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Guidance Tip & Clear Button */}
                <View style={styles.diagFooterRow}>
                  <Text style={styles.diagAdviceText}>
                    💡 Tip: Swipe naturally with your thumb arc, or tap "🎯 Calibrate" above to train your personal profile.
                  </Text>
                  <Pressable
                    onPress={() => {
                      setLastSliderResult(null);
                      setSliderFeedback(null);
                    }}
                    style={styles.diagDismissBtn}
                  >
                    <Text style={styles.diagDismissBtnText}>✕ Dismiss</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </ScrollView>

          {/* PERMANENT STATIC SLIDER AT SCREEN BOTTOM */}
          <View style={styles.staticSliderAnchor}>
            <Text style={styles.sliderInstruction}>
              {sliderMode === 'calibrate'
                ? `CALIBRATION MODE · SWIPE ${calibrationStep + 1} OF 3`
                : 'SLIDE TO COMPLETE ORDER (BETA)'}
            </Text>

            <View style={[styles.sliderTrack, sliderMode === 'calibrate' && styles.sliderTrackCalib]}>
              <Text style={styles.sliderTrackText}>
                {sliderMode === 'calibrate' ? 'Slide across to calibrate →' : 'Slide to Complete Delivery (Beta) →'}
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

            {sliderMode !== 'calibrate' && (
              <TouchableOpacity
                style={styles.forceCompleteBtn}
                activeOpacity={0.8}
                onPress={handleForceCompleteDelivery}
              >
                <Text style={styles.forceCompleteBtnText}>⚡ Force Complete Delivery (Bypass)</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {/* ── High-Fidelity Google Pay Tick Mark Modal (Parity with face_app) ── */}
      <Modal
        visible={deliverySuccessVisible}
        transparent
        animationType="fade"
        onRequestClose={dismissDeliverySuccessModal}
      >
        <View style={styles.gpayModalOverlay}>
          <View style={styles.gpaySuccessCard}>
            {/* Expanding Ripple 1 */}
            <Animated.View
              style={[
                styles.gpayRipple,
                {
                  transform: [
                    {
                      scale: ripple1Anim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.8, 1.7],
                      }),
                    },
                  ],
                  opacity: ripple1Anim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.65, 0],
                  }),
                },
              ]}
            />

            {/* Expanding Ripple 2 (Staggered) */}
            <Animated.View
              style={[
                styles.gpayRipple,
                {
                  transform: [
                    {
                      scale: ripple2Anim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.8, 1.7],
                      }),
                    },
                  ],
                  opacity: ripple2Anim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.5, 0],
                  }),
                },
              ]}
            />

            {/* Main Green Spring Checkmark Circle */}
            <Animated.View
              style={[
                styles.gpayCircle,
                {
                  transform: [{ scale: checkScaleAnim }],
                },
              ]}
            >
              <Text style={styles.gpayCheckmark}>✓</Text>
            </Animated.View>

            {/* Header Title */}
            <Text style={styles.gpayMainTitle}>ORDER DELIVERED</Text>

            {/* Prominent Confidence Badge */}
            <View style={styles.confidencePillBadge}>
              <Text style={styles.confidencePillText}>
                ✓ {lastSliderResult?.confidencePct ?? 98}% BIOMETRIC CONFIDENCE
              </Text>
            </View>

            <Text style={styles.gpaySubtitle}>Pooja K. · #HF-9402 Handover Confirmed</Text>

            {/* Animated Slide-Up Receipt Card */}
            <Animated.View
              style={[
                styles.gpayDetailsCard,
                {
                  transform: [{ translateY: cardSlideAnim }],
                  opacity: cardFadeAnim,
                },
              ]}
            >
              <View style={styles.gpayDetailRowBetween}>
                <Text style={styles.gpayDetailLabel}>VERIFICATION STATUS</Text>
                <View style={isForceCompleted ? styles.badgeOverride : styles.badgeAuthorized}>
                  <Text style={isForceCompleted ? styles.badgeOverrideText : styles.badgeAuthorizedText}>
                    {isForceCompleted ? 'FORCE OVERRIDE ⚡' : 'AUTHORIZED ✓'}
                  </Text>
                </View>
              </View>
              <Text style={styles.gpayDetailVal}>
                {isForceCompleted
                  ? 'Manual Supervisor / Rider Force Complete Authorized'
                  : 'Biometric Slider Kinetics Confirmed • Biological Match'}
              </Text>

              <View style={styles.gpayDivider} />
              <View style={styles.gpayDetailRowBetween}>
                <Text style={styles.gpayDetailLabel}>ASSIGNED ORDER</Text>
                <Text style={styles.gpayDetailValBold}>#HF-9402</Text>
              </View>

              <View style={styles.gpayDivider} />
              <View style={styles.gpayDetailRowBetween}>
                <Text style={styles.gpayDetailLabel}>PAYMENT METHOD</Text>
                <Text style={styles.gpayDetailValBold}>₹420 Cashless Paid</Text>
              </View>

              <View style={styles.gpayDivider} />
              <View style={styles.gpayDetailRowBetween}>
                <Text style={styles.gpayDetailLabel}>TIMESTAMP</Text>
                <Text style={styles.gpayDetailVal}>
                  {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </Text>
              </View>
            </Animated.View>

            <TouchableOpacity
              style={styles.gpayDoneButton}
              activeOpacity={0.85}
              onPress={dismissDeliverySuccessModal}
            >
              <Text style={styles.gpayDoneButtonText}>Done · Next Delivery →</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  titleWithBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
    marginBottom: 4,
  },
  betaBadge: {
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#93c5fd',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  betaBadgeText: {
    color: '#1d4ed8',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
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
  deviceIdTextSuccess: {
    fontSize: 11,
    fontWeight: '700',
    color: '#059669',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginTop: 1,
  },
  deviceIdTextWarn: {
    fontSize: 11,
    fontWeight: '800',
    color: '#d97706',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginTop: 1,
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
  locationBtnWarn: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  locationBtnWarnActive: {
    backgroundColor: '#fef3c7',
    borderWidth: 1,
    borderColor: '#f59e0b',
  },
  locationBtnWarnText: {
    color: '#b45309',
    fontWeight: '800',
    fontSize: 11,
  },
  locationBtnWarnTextActive: {
    color: '#92400e',
    fontWeight: '900',
    fontSize: 11,
  },
  btnSubWarn: {
    fontSize: 8,
    color: '#b45309',
    fontWeight: '700',
    marginTop: 1,
  },
  locationBtnRogue: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  locationBtnRogueActive: {
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#fca5a5',
  },
  locationBtnRogueText: {
    color: '#334155',
    fontWeight: '800',
    fontSize: 11,
  },
  locationBtnRogueTextActive: {
    color: '#b91c1c',
    fontWeight: '900',
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
  alertBannerWarn: {
    backgroundColor: '#fffbeb',
    borderColor: '#fcd34d',
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
  alertBannerTextWarn: {
    color: '#92400e',
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

  // ── High-Fidelity Google Pay Tick Mark Modal Styles (Parity with face_app) ──
  gpayModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  gpaySuccessCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#0f172a',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
    position: 'relative',
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 15,
  },
  gpayRipple: {
    position: 'absolute',
    top: 10,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(16, 185, 129, 0.45)',
  },
  gpayCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#10b981',
    shadowOpacity: 0.8,
    shadowRadius: 18,
    elevation: 14,
    marginBottom: 16,
    zIndex: 2,
  },
  gpayCheckmark: {
    color: '#ffffff',
    fontSize: 52,
    fontWeight: '900',
    lineHeight: 60,
  },
  gpayMainTitle: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 1.2,
  },
  confidencePillBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderColor: '#10b981',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: 8,
    marginBottom: 4,
  },
  confidencePillText: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  gpaySubtitle: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 16,
  },
  gpayDetailsCard: {
    width: '100%',
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  gpayDetailRowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  gpayDetailLabel: {
    color: '#94a3b8',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  gpayDetailVal: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 3,
  },
  gpayDetailValBold: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '800',
  },
  badgeAuthorized: {
    backgroundColor: '#064e3b',
    borderWidth: 1,
    borderColor: '#10b981',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeAuthorizedText: {
    color: '#34d399',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  badgeOverride: {
    backgroundColor: '#451a03',
    borderWidth: 1,
    borderColor: '#f59e0b',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeOverrideText: {
    color: '#fbbf24',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  forceCompleteBtn: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  forceCompleteBtnText: {
    color: '#dc2626',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  forceCompleteErrorBtn: {
    marginTop: 10,
    backgroundColor: '#dc2626',
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forceCompleteErrorBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  gpayDivider: {
    height: 1,
    backgroundColor: '#334155',
    marginVertical: 8,
  },
  gpayDoneButton: {
    width: '100%',
    backgroundColor: '#10b981',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#10b981',
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 4,
  },
  gpayDoneButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  // ── Detailed Biometric Failure Diagnostics Styles ──
  failureDiagnosticsCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1.5,
    borderColor: '#fca5a5',
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  failureDiagnosticsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  failureDiagnosticsTitle: {
    fontSize: 11,
    fontWeight: '900',
    color: '#991b1b',
    letterSpacing: 0.5,
  },
  failureConfidenceBadge: {
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#f87171',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  failureConfidenceText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#b91c1c',
  },
  failureDiagnosticsSubtitle: {
    fontSize: 10,
    color: '#64748b',
    marginBottom: 8,
  },
  diagnosticMetricsContainer: {
    gap: 6,
    marginBottom: 8,
  },
  diagnosticMetricRow: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#cbd5e1',
  },
  diagnosticMetricHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  diagnosticMetricName: {
    fontSize: 10,
    fontWeight: '900',
    color: '#0f172a',
    letterSpacing: 0.4,
  },
  diagStatusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  diagStatusPass: {
    backgroundColor: '#dcfce7',
  },
  diagStatusFail: {
    backgroundColor: '#fee2e2',
  },
  diagStatusText: {
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  diagStatusTextPass: {
    color: '#15803d',
  },
  diagStatusTextFail: {
    color: '#b91c1c',
  },
  diagnosticMetricDetail: {
    fontSize: 11,
    fontWeight: '700',
    color: '#334155',
  },
  diagnosticMetricValues: {
    fontSize: 10,
    fontWeight: '600',
    color: '#475569',
    marginTop: 1,
  },
  diagnosticMetricAllowed: {
    fontSize: 9,
    color: '#64748b',
    marginTop: 1,
  },
  failedReasonsBox: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 6,
    padding: 6,
    marginBottom: 8,
  },
  failedReasonsTitle: {
    fontSize: 9,
    fontWeight: '900',
    color: '#991b1b',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  failedReasonItem: {
    fontSize: 9,
    color: '#b91c1c',
    fontWeight: '700',
    lineHeight: 13,
  },
  diagFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  diagAdviceText: {
    flex: 1,
    fontSize: 9,
    color: '#64748b',
    fontStyle: 'italic',
    lineHeight: 12,
  },
  diagDismissBtn: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  diagDismissBtnText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#475569',
  },
});
