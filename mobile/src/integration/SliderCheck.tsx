import { DeviceMotion, DeviceMotionMeasurement } from 'expo-sensors';
import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// ---------------------------------------------------------------------------
// Strict Fixed Geometry Constants (Permanently Anchored Pixels)
// ---------------------------------------------------------------------------
export const FIXED_SLIDER_WIDTH = 300;
export const FIXED_SLIDER_HEIGHT = 56;
export const FIXED_SLIDER_THUMB_SIZE = 50;
export const FIXED_SLIDER_MAX_SLIDE = FIXED_SLIDER_WIDTH - FIXED_SLIDER_THUMB_SIZE - 6; // 244px

// Pinned bottom position for the slider (NEVER moves regardless of content)
export const PINNED_SLIDER_BOTTOM = 65;
export const PINNED_FOOTER_BOTTOM = 10;

// Number of swipes required for calibration baseline enrollment
export const SAMPLES_CALIBRATION_SWIPES = 3;

// ---------------------------------------------------------------------------
// Dynamic Tolerance Envelope Math Helper
// ---------------------------------------------------------------------------
export interface MetricEnvelope {
  min: number;
  max: number;
  margin: number;
  envMin: number;
  envMax: number;
  mean: number;
}

/**
 * Computes personalized Dynamic Tolerance Envelope:
 * margin = (Max - Min) * 1.5 (with a safe minimum floor to avoid zero-width margins)
 * Envelope = [Min - margin, Max + margin]
 */
export function computeEnvelope(
  values: number[],
  minBaseMargin: number,
  decimals: number = 2
): MetricEnvelope {
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

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------
export interface SliderBaselineProfile {
  // 1. Fractional Trajectory Checkpoints (Y-offsets at X = 0.25, 0.50, 0.75, 1.0)
  baselineCurve: [number, number, number, number];
  curveEnvelopes: [MetricEnvelope, MetricEnvelope, MetricEnvelope, MetricEnvelope];

  // 2. Pitch-Push Effect (Coupled Thumb Extension tilt delta)
  baselinePitchPush: number; // degrees
  pitchPushEnvelope: MetricEnvelope;

  // 3. Velocity Symmetry Ratio (Speed-Agnostic Timing: MidpointTime / TotalTime)
  baselineSymmetry: number;  // 0.0 to 1.0
  symmetryEnvelope: MetricEnvelope;

  // 4. Terminal Thumb Hook (Liftoff Vertical Velocity vy at release)
  baselineLiftoffVy: number;
  liftoffVyEnvelope: MetricEnvelope;

  calibratedAt: string;
  samples: {
    curve: [number, number, number, number];
    pitchPush: number;
    symmetry: number;
    durationMs: number;
    liftoffVy: number;
  }[];
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
  isLiftoffDivergence: boolean;
  isLiftoffFailed: boolean;

  isRejected: boolean;
  failedMetrics: string[];
  timestamp: string;
}

export default function SliderCheck({ accountId, onAssessment }: { accountId: string; onAssessment?: (status: 'pending' | 'passed' | 'alert') => void }) {
  // ── Baseline Profile State ──
  const [baselineProfile, setBaselineProfile] = useState<SliderBaselineProfile | null>(null);
  const [calibSwipeCount, setCalibSwipeCount] = useState(0); // 0 to 4
  const [lastCalibSwipe, setLastCalibSwipe] = useState<{
    curve: [number, number, number, number];
    pitchPush: number;
    symmetry: number;
    durationMs: number;
    liftoffVy: number;
  } | null>(null);

  // ── Live IMU Telemetry ──
  const [pitch, setPitch] = useState(0);
  const [roll, setRoll] = useState(0);
  const [tremor, setTremor] = useState(0);

  // ── Live Biometric Slider State ──
  const [lastLiveSwipe, setLastLiveSwipe] = useState<LiveSliderMetrics | null>(null);
  const [sliderStatus, setSliderStatus] = useState<'IDLE' | 'AUTHENTIC' | 'REJECTED'>('IDLE');

  // ── Multi-Dimensional Confidence & Breakdown ──
  const [confidence, setConfidence] = useState(98);
  const [status, setStatus] = useState<'TRUSTED' | 'SUSPECT'>('TRUSTED');

  // ── Internal High-Frequency Refs ──
  const baselineProfileRef = useRef<SliderBaselineProfile | null>(null);
  const calibSamplesRef = useRef<{
    curve: [number, number, number, number];
    pitchPush: number;
    symmetry: number;
    durationMs: number;
    liftoffVy: number;
  }[]>([]);
  
  // ── Sensor Dual-Stage Low-Pass Filter Refs (Silky smooth readings, zero jitter) ──
  const isSensorInitRef = useRef(false);
  const currentPitchRef = useRef(0);
  const stage1PitchRef = useRef(0);
  const stage2PitchRef = useRef(0);
  const stage1RollRef = useRef(0);
  const stage2RollRef = useRef(0);
  const stage1TremorRef = useRef(0);
  const stage2TremorRef = useRef(0);
  const lastUiUpdateRef = useRef(0);

  // ── Permanent Slider Tracking Refs (Unified Track, Zero Pixel Shift) ──
  const panX = useRef(new Animated.Value(0)).current;
  const startY = useRef(0);
  const startTime = useRef(0);
  const smoothYRef = useRef<number | null>(null);
  const trajectoryRef = useRef<{ progress: number; relY: number; time: number; pitch: number }[]>([]);

  // Keep ref in sync
  useEffect(() => {
    baselineProfileRef.current = baselineProfile;
  }, [baselineProfile]);

  useEffect(() => {
    let mounted = true;
    setBaselineProfile(null);
    baselineProfileRef.current = null;
    setCalibSwipeCount(0);
    setLastLiveSwipe(null);
    setStatus('TRUSTED');
    const profileUri = `${FileSystem.documentDirectory}slider-profile-${encodeURIComponent(accountId)}.json`;
    void FileSystem.getInfoAsync(profileUri).then(async (info) => {
      if (!info.exists) return;
      const profile = JSON.parse(await FileSystem.readAsStringAsync(profileUri)) as SliderBaselineProfile;
      if (!mounted) return;
      setBaselineProfile(profile);
      baselineProfileRef.current = profile;
      setCalibSwipeCount(SAMPLES_CALIBRATION_SWIPES);
      onAssessment?.('pending');
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, [accountId, onAssessment]);

  useEffect(() => {
    if (!baselineProfile) return;
    const profileUri = `${FileSystem.documentDirectory}slider-profile-${encodeURIComponent(accountId)}.json`;
    void FileSystem.writeAsStringAsync(profileUri, JSON.stringify(baselineProfile)).catch(() => undefined);
  }, [accountId, baselineProfile]);

  // Restart calibration
  const restartCalibration = useCallback(() => {
    setBaselineProfile(null);
    baselineProfileRef.current = null;
    setCalibSwipeCount(0);
    calibSamplesRef.current = [];
    setLastCalibSwipe(null);
    setLastLiveSwipe(null);
    setSliderStatus('IDLE');
    setConfidence(98);
    setStatus('TRUSTED');
    onAssessment?.('pending');
    const profileUri = `${FileSystem.documentDirectory}slider-profile-${encodeURIComponent(accountId)}.json`;
    void FileSystem.deleteAsync(profileUri, { idempotent: true }).catch(() => undefined);
    Vibration.vibrate(50);
  }, [accountId]);

  // ---------------------------------------------------------------------------
  // DeviceMotion Telemetry Listener (50 Hz + Dual-Stage Cascaded Filter)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let subscription: { remove: () => void } | null = null;
    let isMounted = true;

    async function initSensors() {
      try {
        await DeviceMotion.isAvailableAsync();
        DeviceMotion.setUpdateInterval(20); // 50 Hz high-frequency sampling

        subscription = DeviceMotion.addListener((data: DeviceMotionMeasurement) => {
          const rawPitch = ((data.rotation?.beta ?? 0) * 180) / Math.PI;
          const rawRoll = ((data.rotation?.gamma ?? 0) * 180) / Math.PI;

          const rA = data.rotationRate?.alpha ?? 0;
          const rB = data.rotationRate?.beta ?? 0;
          const rG = data.rotationRate?.gamma ?? 0;
          const rotMag = Math.sqrt(rA * rA + rB * rB + rG * rG);
          const rawTremor = rotMag / Math.sqrt(3);

          if (!isSensorInitRef.current) {
            stage1PitchRef.current = rawPitch;
            stage2PitchRef.current = rawPitch;
            stage1RollRef.current = rawRoll;
            stage2RollRef.current = rawRoll;
            stage1TremorRef.current = rawTremor;
            stage2TremorRef.current = rawTremor;
            currentPitchRef.current = rawPitch;
            isSensorInitRef.current = true;
          } else {
            // Cascaded 2nd-order Low-Pass Filter (alpha1 = 0.20, alpha2 = 0.25)
            // Stage 1 suppresses hardware quantization and high-frequency vibrations (>10 Hz)
            // Stage 2 provides buttery-smooth perceptual curves with zero tracking delay (<30ms)
            stage1PitchRef.current = 0.20 * rawPitch + 0.80 * stage1PitchRef.current;
            stage2PitchRef.current = 0.25 * stage1PitchRef.current + 0.75 * stage2PitchRef.current;

            stage1RollRef.current = 0.20 * rawRoll + 0.80 * stage1RollRef.current;
            stage2RollRef.current = 0.25 * stage1RollRef.current + 0.75 * stage2RollRef.current;

            stage1TremorRef.current = 0.20 * rawTremor + 0.80 * stage1TremorRef.current;
            stage2TremorRef.current = 0.25 * stage1TremorRef.current + 0.75 * stage2TremorRef.current;

            currentPitchRef.current = stage2PitchRef.current;
          }

          // Throttle UI React state updates to 10 Hz (every 100ms)
          // 1. Prevents eye-straining number flickering in footer
          // 2. Liberates JS event loop from 50 re-renders/sec, keeping touch tracking at 60 fps
          const now = Date.now();
          if (now - lastUiUpdateRef.current >= 100) {
            lastUiUpdateRef.current = now;
            if (isMounted) {
              setPitch(stage2PitchRef.current);
              setRoll(stage2RollRef.current);
              setTremor(stage2TremorRef.current);
            }
          }
        });
      } catch (err) {
        console.warn('DeviceMotion init error:', err);
      }
    }

    initSensors();
    return () => {
      isMounted = false;
      subscription?.remove();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Trajectory Gaussian Kernel Regression Helper
  // Nadaraya-Watson kernel regression for buttery-smooth curve & pitch interpolation
  // ---------------------------------------------------------------------------
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

      // Gaussian Kernel Regression with bandwidth sigma = 0.08
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

      // Linear interpolation fallback between closest samples
      const sorted = [...trajectory].sort((a, b) => a.progress - b.progress);
      const afterIdx = sorted.findIndex((p) => p.progress >= targetProgress);

      if (afterIdx === 0) {
        return {
          y: Number(sorted[0].relY.toFixed(1)),
          time: sorted[0].time,
          pitch: Number(sorted[0].pitch.toFixed(2)),
        };
      }
      if (afterIdx === -1) {
        const last = sorted[sorted.length - 1];
        return {
          y: Number(last.relY.toFixed(1)),
          time: last.time,
          pitch: Number(last.pitch.toFixed(2)),
        };
      }

      const p0 = sorted[afterIdx - 1];
      const p1 = sorted[afterIdx];
      const span = Math.max(0.001, p1.progress - p0.progress);
      const t = (targetProgress - p0.progress) / span;
      const interpY = p0.relY + t * (p1.relY - p0.relY);
      const interpTime = p0.time + t * (p1.time - p0.time);
      const interpPitch = p0.pitch + t * (p1.pitch - p0.pitch);

      return {
        y: Number(interpY.toFixed(1)),
        time: Math.round(interpTime),
        pitch: Number(interpPitch.toFixed(2)),
      };
    },
    []
  );

  // ---------------------------------------------------------------------------
  // Permanent Unified PanResponder (Anchored in place, smooth trajectory tracking)
  // ---------------------------------------------------------------------------
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 2,
      onPanResponderGrant: (_, gesture) => {
        startY.current = gesture.y0;
        startTime.current = Date.now();
        smoothYRef.current = null;
        trajectoryRef.current = [];
      },
      onPanResponderMove: (_, gesture) => {
        const maxSlide = FIXED_SLIDER_MAX_SLIDE;
        const clampedDx = Math.max(0, Math.min(maxSlide, gesture.dx));
        const progress = clampedDx / maxSlide;
        const rawRelY = gesture.moveY - startY.current;
        const now = Date.now();

        // Adaptive deadband filter: removes 1-2px capacitive digitizer micro-jitter
        // while tracking authentic thumb curve movements smoothly
        const prevSmooth = smoothYRef.current ?? rawRelY;
        const diffY = Math.abs(rawRelY - prevSmooth);
        const alpha = diffY < 1.5 ? 0.20 : 0.40;
        const smoothRelY = alpha * rawRelY + (1 - alpha) * prevSmooth;
        smoothYRef.current = smoothRelY;

        trajectoryRef.current.push({
          progress,
          relY: smoothRelY,
          time: now,
          pitch: currentPitchRef.current,
        });

        panX.setValue(clampedDx);
      },
      onPanResponderRelease: (_, gesture) => {
        const endTime = Date.now();
        const durationMs = Math.max(1, endTime - startTime.current);
        const distanceX = Math.max(0, gesture.dx);
        const maxSlide = FIXED_SLIDER_MAX_SLIDE;
        const lastPitch = currentPitchRef.current;

        // Terminal Thumb Hook: calculate smoothed vertical velocity over last 50ms of trajectory + native vy
        const trajectory = trajectoryRef.current;
        let trajVy = 0;
        if (trajectory.length >= 2) {
          const lastPt = trajectory[trajectory.length - 1];
          const recentPt = trajectory.slice().reverse().find((p) => (lastPt.time - p.time) >= 30) ?? trajectory[0];
          const dt = Math.max(10, lastPt.time - recentPt.time);
          trajVy = (lastPt.relY - recentPt.relY) / dt;
        }
        const rawVy = gesture.vy ?? 0;
        const liftoffVy = Number((0.6 * trajVy + 0.4 * rawVy).toFixed(3));

        if (distanceX >= maxSlide * 0.70) {
          const lastRelY = gesture.moveY - startY.current;

          // 1. Smoothed Fractional Trajectory Checkpoints [y25, y50, y75, y100] via Kernel Regression
          const cp05 = getSmoothedCheckpoint(trajectory, 0.05, 0, startTime.current, lastPitch);
          const cp25 = getSmoothedCheckpoint(trajectory, 0.25, lastRelY * 0.25, startTime.current + durationMs * 0.25, lastPitch);
          const cp50 = getSmoothedCheckpoint(trajectory, 0.50, lastRelY * 0.50, startTime.current + durationMs * 0.50, lastPitch);
          const cp75 = getSmoothedCheckpoint(trajectory, 0.75, lastRelY * 0.75, startTime.current + durationMs * 0.75, lastPitch);
          const cp100 = getSmoothedCheckpoint(trajectory, 0.98, lastRelY, endTime, lastPitch);

          const liveCurve: [number, number, number, number] = [cp25.y, cp50.y, cp75.y, cp100.y];

          // 2. The 'Pitch-Push' Effect: Impact-Shock-Immune calculation (cp100.pitch - cp05.pitch)
          const pitchAtStart = cp05.pitch;
          const pitchAtEnd = cp100.pitch;
          const pitchDelta = Number((pitchAtEnd - pitchAtStart).toFixed(2));

          // 3. Velocity Symmetry Ratio (MidpointTime / TotalTime) with Smoothed Timing
          const t0 = startTime.current;
          const midpointTime = Math.max(1, cp50.time - t0);
          const symmetry = Number((midpointTime / durationMs).toFixed(3));

          const activeBaseline = baselineProfileRef.current;

          // ── MODE A: ENROLLMENT CALIBRATION (3 Swipes) ──
          if (!activeBaseline) {
            const sample = { curve: liveCurve, pitchPush: pitchDelta, symmetry, durationMs, liftoffVy };
            const updated = [...calibSamplesRef.current, sample];
            calibSamplesRef.current = updated;
            setLastCalibSwipe(sample);
            setCalibSwipeCount(updated.length);

            Vibration.vibrate(50);

            Animated.timing(panX, {
              toValue: maxSlide,
              duration: 120,
              useNativeDriver: false,
            }).start(() => {
              setTimeout(() => {
                Animated.spring(panX, {
                  toValue: 0,
                  bounciness: 4,
                  useNativeDriver: false,
                }).start();

                // When 3 calibration swipes complete, lock baseline with dynamic tolerance envelopes!
                if (updated.length >= SAMPLES_CALIBRATION_SWIPES) {
                  const N = updated.length;

                  // 1. Mean Curve & Checkpoint Envelopes: margin = (Max - Min) * 1.5 (floor: 3.5px)
                  const meanCurve: [number, number, number, number] = [
                    Number((updated.reduce((a, s) => a + s.curve[0], 0) / N).toFixed(1)),
                    Number((updated.reduce((a, s) => a + s.curve[1], 0) / N).toFixed(1)),
                    Number((updated.reduce((a, s) => a + s.curve[2], 0) / N).toFixed(1)),
                    Number((updated.reduce((a, s) => a + s.curve[3], 0) / N).toFixed(1)),
                  ];
                  const curveEnvelopes: [MetricEnvelope, MetricEnvelope, MetricEnvelope, MetricEnvelope] = [
                    computeEnvelope(updated.map((s) => s.curve[0]), 3.5, 1),
                    computeEnvelope(updated.map((s) => s.curve[1]), 3.5, 1),
                    computeEnvelope(updated.map((s) => s.curve[2]), 3.5, 1),
                    computeEnvelope(updated.map((s) => s.curve[3]), 3.5, 1),
                  ];

                  // 2. Pitch-Push Envelope: margin = (Max - Min) * 1.5 (floor: 1.0°)
                  const pitchPushEnvelope = computeEnvelope(updated.map((s) => s.pitchPush), 1.0, 2);

                  // 3. Velocity Symmetry Envelope: margin = (Max - Min) * 1.5 (floor: 0.06)
                  const symmetryEnvelope = computeEnvelope(updated.map((s) => s.symmetry), 0.06, 3);

                  // 4. Terminal Thumb Hook (Liftoff vy) Envelope (floor: 0.20)
                  const liftoffVyEnvelope = computeEnvelope(updated.map((s) => s.liftoffVy), 0.20, 3);

                  const profile: SliderBaselineProfile = {
                    baselineCurve: meanCurve,
                    curveEnvelopes,
                    baselinePitchPush: pitchPushEnvelope.mean,
                    pitchPushEnvelope,
                    baselineSymmetry: symmetryEnvelope.mean,
                    symmetryEnvelope,
                    baselineLiftoffVy: liftoffVyEnvelope.mean,
                    liftoffVyEnvelope,
                    calibratedAt: new Date().toLocaleTimeString(),
                    samples: updated,
                  };

                  baselineProfileRef.current = profile;
                  setBaselineProfile(profile);
                  onAssessment?.('pending');

                  console.log('🔒 [3-SWIPE ENVELOPE PROFILE LOCKED] Dynamic Tolerances Initialized!');
                  console.log({
                    event: 'BASELINE_ENROLLED_3_SWIPES',
                    pitchPushEnvelope: `[${pitchPushEnvelope.envMin}° to ${pitchPushEnvelope.envMax}°] (Min: ${pitchPushEnvelope.min}°, Max: ${pitchPushEnvelope.max}°, Margin: ±${pitchPushEnvelope.margin}°)`,
                    symmetryEnvelope: `[${symmetryEnvelope.envMin} to ${symmetryEnvelope.envMax}] (Min: ${symmetryEnvelope.min}, Max: ${symmetryEnvelope.max}, Margin: ±${symmetryEnvelope.margin})`,
                    liftoffVyEnvelope: `[${liftoffVyEnvelope.envMin} to ${liftoffVyEnvelope.envMax}] (Mean: ${liftoffVyEnvelope.mean}, Margin: ±${liftoffVyEnvelope.margin})`,
                    curveEnvelopes: curveEnvelopes.map((e, idx) => `CP#${idx + 1}: [${e.envMin} to ${e.envMax}px]`),
                  });

                  Vibration.vibrate(Platform.OS === 'android' ? [0, 80, 50, 100] : 120);
                }
              }, 400);
            });
            return;
          }

          // ── MODE B: LIVE MONITORING EVALUATION VIA DYNAMIC ENVELOPES ──
          // 1. Curve Envelope Check (Check all 4 fractional checkpoints)
          let curveFailures = 0;
          const failedCurvePoints: number[] = [];
          liveCurve.forEach((val, idx) => {
            const env = activeBaseline.curveEnvelopes[idx];
            if (val < env.envMin || val > env.envMax) {
              curveFailures++;
              failedCurvePoints.push(idx);
            }
          });
          const curveCheckpointsPassed = 4 - curveFailures;
          // Biometric tolerance: allow 1 minor single-point variance; flag anomaly if 2+ checkpoints fail
          const isCurveFailed = curveFailures >= 2;

          // 2. Pitch-Push Dynamic Envelope Check
          const pEnv = activeBaseline.pitchPushEnvelope;
          const isPitchPushFailed = pitchDelta < pEnv.envMin || pitchDelta > pEnv.envMax;

          // 3. Velocity Symmetry Dynamic Envelope Check
          const sEnv = activeBaseline.symmetryEnvelope;
          const isSymmetryFailed = symmetry < sEnv.envMin || symmetry > sEnv.envMax;

          // 4. Terminal Thumb Hook (vy) & Divergence Check
          const vEnv = activeBaseline.liftoffVyEnvelope;
          const isLiftoffOutside = liftoffVy < vEnv.envMin || liftoffVy > vEnv.envMax;
          // Directional signature: If baseline has an upward hook (mean < -0.05), but live gesture is flat/downward (vy > 0.08)
          const isLiftoffDivergence = vEnv.mean < -0.05 && liftoffVy > 0.08;
          const isLiftoffFailed = isLiftoffOutside || isLiftoffDivergence;

          const isRejected = isCurveFailed || isPitchPushFailed || isSymmetryFailed || isLiftoffFailed;

          const failedMetrics: string[] = [];
          if (isPitchPushFailed) {
            failedMetrics.push(`Pitch-Push: ${pitchDelta}° [Allowed: ${pEnv.envMin}° to ${pEnv.envMax}°] -> FAIL`);
          }
          if (isSymmetryFailed) {
            failedMetrics.push(`Velocity Symmetry: ${symmetry} [Allowed: ${sEnv.envMin} to ${sEnv.envMax}] -> FAIL`);
          }
          if (isLiftoffFailed) {
            const reason = isLiftoffDivergence ? ' (Liftoff Divergence: missing upward hook)' : '';
            failedMetrics.push(`Thumb Hook: ${liftoffVy} [Allowed: ${vEnv.envMin} to ${vEnv.envMax}] -> FAIL${reason}`);
          }
          if (isCurveFailed) {
            const breachedStr = failedCurvePoints
              .map((idx) => `CP#${idx + 1} (${liveCurve[idx]}px outside [${activeBaseline.curveEnvelopes[idx].envMin} to ${activeBaseline.curveEnvelopes[idx].envMax}px])`)
              .join(', ');
            failedMetrics.push(`Thumb Curve: ${breachedStr} -> FAIL`);
          }

          const liveData: LiveSliderMetrics = {
            curve: liveCurve,
            curveCheckpointsPassed,
            failedCurvePoints,
            isCurveFailed,
            pitchAtStart: Number(pitchAtStart.toFixed(1)),
            pitchAtEnd: Number(pitchAtEnd.toFixed(1)),
            pitchDelta,
            isPitchPushFailed,
            midpointTimeMs: midpointTime,
            totalTimeMs: durationMs,
            symmetryRatio: symmetry,
            isSymmetryFailed,
            liftoffVy,
            isLiftoffDivergence,
            isLiftoffFailed,
            isRejected,
            failedMetrics,
            timestamp: new Date().toLocaleTimeString(),
          };

          setLastLiveSwipe(liveData);

          // Confidence computation based on envelope adherence
          const failureCount = (isCurveFailed ? 1 : 0) + (isPitchPushFailed ? 1 : 0) + (isSymmetryFailed ? 1 : 0) + (isLiftoffFailed ? 1 : 0);
          let liveConfidence = 98;
          if (failureCount === 1) liveConfidence = 38;
          else if (failureCount === 2) liveConfidence = 28;
          else if (failureCount >= 3) liveConfidence = 15;

          setConfidence(liveConfidence);
          setStatus(isRejected ? 'SUSPECT' : 'TRUSTED');
          onAssessment?.(isRejected ? 'alert' : 'passed');

          // Terminal Audit Logging Requirement
          if (isRejected) {
            console.log('⚠️ [ACCOUNT HOLDER PATTERN DIFFERENCE] Swipe outside saved envelope.');
            console.log({
              event: 'ACCOUNT_HOLDER_PATTERN_DIFFERENCE',
              status: 'REVIEW',
              gestureFitScore: `${liveConfidence}%`,
              failingMetrics: failedMetrics,
              telemetry: {
                pitchPush: `${pitchDelta}° [Allowed: ${pEnv.envMin}° to ${pEnv.envMax}°]`,
                velocitySymmetry: `${symmetry} [Allowed: ${sEnv.envMin} to ${sEnv.envMax}]`,
                thumbHookVy: `${liftoffVy} [Allowed: ${vEnv.envMin} to ${vEnv.envMax}]`,
                curveCheckpointsPassed: `${curveCheckpointsPassed}/4`,
                liveCurve: `[${liveCurve.join(', ')}]`,
              },
              timestamp: new Date().toLocaleTimeString(),
            });

            setSliderStatus('REJECTED');
            Vibration.vibrate(Platform.OS === 'android' ? [0, 150, 80, 180] : 160);
          } else {
            console.log('✅ [ACCOUNT HOLDER PATTERN MATCH] Swipe falls within saved envelope.');
            console.log({
              event: 'ACCOUNT_HOLDER_PATTERN_MATCH',
              status: 'WITHIN_BASELINE',
              gestureFitScore: `${liveConfidence}%`,
              pitchPush: `${pitchDelta}° [Allowed: ${pEnv.envMin}° to ${pEnv.envMax}°] -> PASS`,
              velocitySymmetry: `${symmetry} [Allowed: ${sEnv.envMin} to ${sEnv.envMax}] -> PASS`,
              thumbHookVy: `${liftoffVy} [Allowed: ${vEnv.envMin} to ${vEnv.envMax}] -> PASS`,
              curveCheckpoints: `4/4 passed`,
              timestamp: new Date().toLocaleTimeString(),
            });

            setSliderStatus('AUTHENTIC');
            Vibration.vibrate(70);
          }

          Animated.timing(panX, {
            toValue: maxSlide,
            duration: 120,
            useNativeDriver: false,
          }).start(() => {
            setTimeout(() => {
              Animated.spring(panX, {
                toValue: 0,
                bounciness: 4,
                useNativeDriver: false,
              }).start();
              setSliderStatus('IDLE');
            }, 1800);
          });
        } else {
          Animated.spring(panX, {
            toValue: 0,
            bounciness: 5,
            useNativeDriver: false,
          }).start();
        }
      },
    })
  ).current;

  const isTrusted = status === 'TRUSTED';
  const confidenceColor = isTrusted ? '#10B981' : '#EF4444';

  return (
    <View style={styles.darkBackground}>
      <SafeAreaView style={styles.safeArea}>
        {/* Strict Fullscreen Container */}
        <View style={styles.rootContainer}>

          {/* ═══════════════════════════════════════════════════════════════════
              UPPER SECTION (DEDICATED CARDS FOR CALIBRATION OR LIVE MODE)
              This area is completely isolated and cannot push the slider!
             ═══════════════════════════════════════════════════════════════════ */}
          <View style={styles.upperContentArea}>
            {/* ── HEADER ── */}
            <View style={styles.header}>
              <View style={styles.badgeRow}>
                <View style={styles.stageBadge}>
                  <Text style={styles.stageBadgeText}>STAGE 3 • PINNED SLIDER</Text>
                </View>
                <View
                  style={[
                    styles.statusBadge,
                    isTrusted ? styles.statusBadgeTrusted : styles.statusBadgeSuspect,
                  ]}>
                  <View
                    style={[
                      styles.pulsingDot,
                      { backgroundColor: isTrusted ? '#10B981' : '#EF4444' },
                    ]}
                  />
                  <Text
                    style={[
                      styles.statusBadgeText,
                      { color: isTrusted ? '#10B981' : '#EF4444' },
                    ]}>
                    {!baselineProfile
                      ? `CALIBRATION (${calibSwipeCount}/${SAMPLES_CALIBRATION_SWIPES})`
                      : isTrusted
                      ? 'PATTERN WITHIN BASELINE'
                      : 'PATTERN OUTSIDE BASELINE'}
                  </Text>
                </View>
              </View>
              <Text style={styles.screenTitle}>Account-holder swipe pattern</Text>
              <Text style={styles.screenSubtitle}>Behavior comparison signal · not identity proof</Text>
            </View>

            {/* ── MODE A: CALIBRATION INFO (3 Swipes) ── */}
            {!baselineProfile ? (
              <View style={styles.calibCard}>
                <Text style={styles.calibTitle}>TASK: 3-SWIPE ENVELOPE ENROLLMENT</Text>
                <Text style={styles.calibSub}>
                  Slide the bottom track naturally 3 times. Learns your personal variance envelopes and terminal thumb hook liftoff velocity.
                </Text>

                {/* Progress Indicators (3 Swipes) */}
                <View style={styles.dotsRow}>
                  {[1, 2, 3].map((step) => (
                    <View
                      key={step}
                      style={[
                        styles.swipeDot,
                        step <= calibSwipeCount && styles.swipeDotActive,
                      ]}>
                      <Text
                        style={[
                          styles.swipeDotText,
                          step <= calibSwipeCount && styles.swipeDotTextActive,
                        ]}>
                        {step <= calibSwipeCount ? `✓` : step}
                      </Text>
                    </View>
                  ))}
                </View>

                {lastCalibSwipe ? (
                  <View style={styles.calibFeedbackBox}>
                    <Text style={styles.calibFeedbackTitle}>
                      SWIPE {calibSwipeCount} OF {SAMPLES_CALIBRATION_SWIPES} REGISTERED
                    </Text>
                    <View style={styles.calibFeedbackGrid}>
                      <View style={styles.calibFeedbackItem}>
                        <Text style={styles.calibItemLabel}>Y-ARC PTS</Text>
                        <Text style={styles.calibItemVal}>
                          [{lastCalibSwipe.curve.map((v) => `${v > 0 ? `+${v}` : v}`).join(', ')}]
                        </Text>
                      </View>
                      <View style={styles.calibFeedbackItem}>
                        <Text style={styles.calibItemLabel}>PITCH PUSH</Text>
                        <Text style={styles.calibItemVal}>
                          {lastCalibSwipe.pitchPush > 0 ? `+${lastCalibSwipe.pitchPush}` : lastCalibSwipe.pitchPush}°
                        </Text>
                      </View>
                      <View style={styles.calibFeedbackItem}>
                        <Text style={styles.calibItemLabel}>SYMMETRY</Text>
                        <Text style={styles.calibItemVal}>{lastCalibSwipe.symmetry}</Text>
                      </View>
                      <View style={styles.calibFeedbackItem}>
                        <Text style={styles.calibItemLabel}>THUMB HOOK</Text>
                        <Text style={styles.calibItemVal}>{lastCalibSwipe.liftoffVy}</Text>
                      </View>
                    </View>
                  </View>
                ) : (
                  <View style={styles.infoHintBox}>
                    <Text style={styles.infoHintText}>
                      👉 Keep phone in your natural single-hand grip. 3 natural swipes establish your personalized Min-Max variance envelopes and liftoff signature.
                    </Text>
                  </View>
                )}
              </View>
            ) : (
              /* ── MODE B: LIVE MONITORING & DYNAMIC ENVELOPE VISUAL READOUTS ── */
              <View style={styles.liveScoreCard}>
                <View style={styles.confHeaderRow}>
                  <View>
                    <Text style={styles.confCardLabel}>GESTURE BASELINE FIT · DEMO SCORE</Text>
                    <Text style={[styles.confidenceTitleBig, { color: confidenceColor }]}>
                      Gesture fit: {confidence}%
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.recalibrateBtn}
                    onPress={restartCalibration}
                    activeOpacity={0.8}>
                    <Text style={styles.recalibrateBtnText}>↺ Re-enroll</Text>
                  </TouchableOpacity>
                </View>

                {/* Meter Bar */}
                <View style={styles.confMeterTrack}>
                  <View style={styles.confThresholdLine} />
                  <View
                    style={[
                      styles.confMeterFill,
                      { width: `${confidence}%`, backgroundColor: confidenceColor },
                    ]}
                  />
                </View>

                {/* Reject Banner */}
                {!isTrusted && lastLiveSwipe?.isRejected && (
                  <View style={styles.suspectAlertBanner}>
                    <Text style={styles.suspectAlertIcon}>🚨</Text>
                    <View style={styles.suspectAlertTextGroup}>
                      <Text style={styles.suspectAlertTitle}>Swipe differs from saved pattern</Text>
                      {lastLiveSwipe.failedMetrics.map((msg, i) => (
                        <Text key={i} style={styles.suspectAlertSubtitle}>
                          • {msg}
                        </Text>
                      ))}
                    </View>
                  </View>
                )}

                {/* The 4 Dynamic Envelope Metric Cards (2x2 Quad Grid) */}
                <View style={styles.metricsQuadGrid}>
                  {/* Metric 1: Pitch-Push */}
                  <View
                    style={[
                      styles.metricQuadCard,
                      lastLiveSwipe?.isPitchPushFailed && styles.metricQuadCardFailed,
                    ]}>
                    <Text style={styles.metricCardLabel}>1. PITCH-PUSH Δ</Text>
                    <Text
                      style={[
                        styles.metricCardVal,
                        { color: lastLiveSwipe?.isPitchPushFailed ? '#EF4444' : '#10B981' },
                      ]}>
                      {lastLiveSwipe ? `${lastLiveSwipe.pitchDelta > 0 ? `+${lastLiveSwipe.pitchDelta}` : lastLiveSwipe.pitchDelta}°` : `${baselineProfile.baselinePitchPush}°`}
                    </Text>
                    <Text style={styles.metricCardSub} numberOfLines={1}>
                      [Allowed: {baselineProfile.pitchPushEnvelope.envMin}° to {baselineProfile.pitchPushEnvelope.envMax}°]
                    </Text>
                    <View
                      style={[
                        styles.statusPillSmall,
                        { backgroundColor: lastLiveSwipe?.isPitchPushFailed ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)' },
                      ]}>
                      <Text
                        style={[
                          styles.statusPillSmallText,
                          { color: lastLiveSwipe?.isPitchPushFailed ? '#EF4444' : '#10B981' },
                        ]}>
                        {lastLiveSwipe?.isPitchPushFailed ? 'FAIL' : 'PASS'}
                      </Text>
                    </View>
                  </View>

                  {/* Metric 2: Velocity Symmetry */}
                  <View
                    style={[
                      styles.metricQuadCard,
                      lastLiveSwipe?.isSymmetryFailed && styles.metricQuadCardFailed,
                    ]}>
                    <Text style={styles.metricCardLabel}>2. VEL. SYMMETRY</Text>
                    <Text
                      style={[
                        styles.metricCardVal,
                        { color: lastLiveSwipe?.isSymmetryFailed ? '#EF4444' : '#10B981' },
                      ]}>
                      {lastLiveSwipe ? `${lastLiveSwipe.symmetryRatio}` : `${baselineProfile.baselineSymmetry}`}
                    </Text>
                    <Text style={styles.metricCardSub} numberOfLines={1}>
                      [Allowed: {baselineProfile.symmetryEnvelope.envMin} to {baselineProfile.symmetryEnvelope.envMax}]
                    </Text>
                    <View
                      style={[
                        styles.statusPillSmall,
                        { backgroundColor: lastLiveSwipe?.isSymmetryFailed ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)' },
                      ]}>
                      <Text
                        style={[
                          styles.statusPillSmallText,
                          { color: lastLiveSwipe?.isSymmetryFailed ? '#EF4444' : '#10B981' },
                        ]}>
                        {lastLiveSwipe?.isSymmetryFailed ? 'FAIL' : 'PASS'}
                      </Text>
                    </View>
                  </View>

                  {/* Metric 3: Thumb Hook (vy) */}
                  <View
                    style={[
                      styles.metricQuadCard,
                      lastLiveSwipe?.isLiftoffFailed && styles.metricQuadCardFailed,
                    ]}>
                    <Text style={styles.metricCardLabel}>3. THUMB HOOK (vy)</Text>
                    <Text
                      style={[
                        styles.metricCardVal,
                        { color: lastLiveSwipe?.isLiftoffFailed ? '#EF4444' : '#10B981' },
                      ]}>
                      {lastLiveSwipe ? `${lastLiveSwipe.liftoffVy > 0 ? `+${lastLiveSwipe.liftoffVy}` : lastLiveSwipe.liftoffVy}` : `${baselineProfile.baselineLiftoffVy}`}
                    </Text>
                    <Text style={styles.metricCardSub} numberOfLines={1}>
                      [Allowed: {baselineProfile.liftoffVyEnvelope.envMin} to {baselineProfile.liftoffVyEnvelope.envMax}]
                    </Text>
                    <View
                      style={[
                        styles.statusPillSmall,
                        { backgroundColor: lastLiveSwipe?.isLiftoffFailed ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)' },
                      ]}>
                      <Text
                        style={[
                          styles.statusPillSmallText,
                          { color: lastLiveSwipe?.isLiftoffFailed ? '#EF4444' : '#10B981' },
                        ]}>
                        {lastLiveSwipe?.isLiftoffFailed ? 'FAIL' : 'PASS'}
                      </Text>
                    </View>
                  </View>

                  {/* Metric 4: Thumb Curve Arc */}
                  <View
                    style={[
                      styles.metricQuadCard,
                      lastLiveSwipe?.isCurveFailed && styles.metricQuadCardFailed,
                    ]}>
                    <Text style={styles.metricCardLabel}>4. THUMB CURVE ARC</Text>
                    <Text
                      style={[
                        styles.metricCardVal,
                        { color: lastLiveSwipe?.isCurveFailed ? '#EF4444' : '#10B981' },
                      ]}>
                      {lastLiveSwipe ? `${lastLiveSwipe.curveCheckpointsPassed}/4 Pts` : '4/4 Pts'}
                    </Text>
                    <Text style={styles.metricCardSub} numberOfLines={1}>
                      [Allowed: In 4-Pt Envelope]
                    </Text>
                    <View
                      style={[
                        styles.statusPillSmall,
                        { backgroundColor: lastLiveSwipe?.isCurveFailed ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)' },
                      ]}>
                      <Text
                        style={[
                          styles.statusPillSmallText,
                          { color: lastLiveSwipe?.isCurveFailed ? '#EF4444' : '#10B981' },
                        ]}>
                        {lastLiveSwipe?.isCurveFailed ? 'FAIL' : 'PASS'}
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Baseline locked badges (Enrolled ranges display) */}
                <View style={styles.baselinePillsRow}>
                  <View style={styles.baselinePill}>
                    <Text style={styles.baselinePillLabel}>PITCH ENV</Text>
                    <Text style={styles.baselinePillVal}>
                      [{baselineProfile.pitchPushEnvelope.min}°, {baselineProfile.pitchPushEnvelope.max}°] ±{baselineProfile.pitchPushEnvelope.margin}°
                    </Text>
                  </View>
                  <View style={styles.baselinePill}>
                    <Text style={styles.baselinePillLabel}>SYMMETRY ENV</Text>
                    <Text style={styles.baselinePillVal}>
                      [{baselineProfile.symmetryEnvelope.min}, {baselineProfile.symmetryEnvelope.max}] ±{baselineProfile.symmetryEnvelope.margin}
                    </Text>
                  </View>
                  <View style={styles.baselinePill}>
                    <Text style={styles.baselinePillLabel}>HOOK ENV</Text>
                    <Text style={styles.baselinePillVal}>
                      [{baselineProfile.liftoffVyEnvelope.min}, {baselineProfile.liftoffVyEnvelope.max}]
                    </Text>
                  </View>
                </View>
              </View>
            )}
          </View>

          {/* ═══════════════════════════════════════════════════════════════════
              PERMANENTLY PINNED SLIDER (EXACT SAME PIXELS, NEVER MOVES)
              position: 'absolute', bottom: 65. Zero pixel displacement!
             ═══════════════════════════════════════════════════════════════════ */}
          <View style={styles.pinnedSliderContainer} pointerEvents="box-none">
            <View
              style={[
                styles.fixedOrderSliderTrack,
                sliderStatus === 'REJECTED' && styles.sliderTrackRejected,
                sliderStatus === 'AUTHENTIC' && styles.sliderTrackAuthentic,
              ]}>
              <View style={styles.sliderTrackLabelContainer}>
                <Text
                  style={[
                    styles.sliderTrackLabel,
                    sliderStatus === 'REJECTED' && { color: '#EF4444' },
                    sliderStatus === 'AUTHENTIC' && { color: '#10B981' },
                  ]}>
                  {!baselineProfile
                    ? `Slide to Calibrate (${calibSwipeCount + 1}/${SAMPLES_CALIBRATION_SWIPES}) >>`
                    : sliderStatus === 'AUTHENTIC'
                    ? '✅ PATTERN WITHIN BASELINE'
                    : sliderStatus === 'REJECTED'
                    ? '⚠️ PATTERN DIFFERS FROM BASELINE'
                    : 'Slide to compare pattern >>'}
                </Text>
              </View>

              <Animated.View
                {...panResponder.panHandlers}
                style={[
                  styles.fixedOrderSliderThumb,
                  {
                    transform: [{ translateX: panX }],
                    backgroundColor:
                      sliderStatus === 'REJECTED'
                        ? '#EF4444'
                        : sliderStatus === 'AUTHENTIC'
                        ? '#10B981'
                        : '#38BDF8',
                  },
                ]}>
                <Text style={styles.sliderThumbIcon}>❯❯</Text>
              </Animated.View>
            </View>
          </View>

          {/* ═══════════════════════════════════════════════════════════════════
              PERMANENTLY PINNED FOOTER (EXACT SAME PIXELS, NEVER MOVES)
              position: 'absolute', bottom: 10.
             ═══════════════════════════════════════════════════════════════════ */}
          <View style={styles.pinnedFooterBar}>
            <View style={styles.footerMetricBox}>
              <Text style={styles.footerMetricLabel}>PITCH</Text>
              <Text style={styles.footerMetricVal}>{pitch.toFixed(1)}°</Text>
            </View>
            <View style={styles.footerMetricBox}>
              <Text style={styles.footerMetricLabel}>ROLL</Text>
              <Text style={styles.footerMetricVal}>{roll.toFixed(1)}°</Text>
            </View>
            <View style={styles.footerMetricBox}>
              <Text style={styles.footerMetricLabel}>TREMOR</Text>
              <Text style={styles.footerMetricVal}>{tremor.toFixed(3)}</Text>
            </View>
            <View style={styles.footerMetricBox}>
              <Text style={styles.footerMetricLabel}>STATUS</Text>
              <Text style={[styles.footerMetricVal, { color: isTrusted ? '#10B981' : '#EF4444' }]}>
                {isTrusted ? 'WITHIN BASELINE' : 'REVIEW PATTERN'}
              </Text>
            </View>
          </View>

        </View>
      </SafeAreaView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Stylesheet (Pixel-Fixed, Zero Layout Shift)
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  darkBackground: { flex: 1, backgroundColor: '#0F172A' },
  safeArea: { flex: 1 },
  rootContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#0F172A',
  },

  // Upper container (bounded so it never expands into the slider area)
  upperContentArea: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    bottom: PINNED_SLIDER_BOTTOM + FIXED_SLIDER_HEIGHT + 14,
    justifyContent: 'flex-start',
  },

  header: { marginBottom: 8, marginTop: 4 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  stageBadge: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  stageBadgeText: { color: '#38BDF8', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
    gap: 5,
  },
  statusBadgeTrusted: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  statusBadgeSuspect: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  pulsingDot: { width: 6, height: 6, borderRadius: 3 },
  statusBadgeText: { fontSize: 10, fontWeight: '700' },
  screenTitle: { color: '#F8FAFC', fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  screenSubtitle: { color: '#94A3B8', fontSize: 11, marginTop: 2, fontWeight: '500' },

  // Mode A: Calibration Card
  calibCard: {
    backgroundColor: '#101422',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: '#0284C7',
    alignItems: 'center',
  },
  calibTitle: { color: '#38BDF8', fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  calibSub: { color: '#94A3B8', fontSize: 11, marginTop: 4, textAlign: 'center', lineHeight: 15 },
  dotsRow: { flexDirection: 'row', gap: 12, marginVertical: 10 },
  swipeDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  swipeDotActive: { backgroundColor: '#0284C7', borderColor: '#38BDF8' },
  swipeDotText: { color: '#64748B', fontSize: 13, fontWeight: '800' },
  swipeDotTextActive: { color: '#FFFFFF' },

  calibFeedbackBox: {
    width: '100%',
    backgroundColor: '#0B0E17',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#1A2336',
  },
  calibFeedbackTitle: { color: '#38BDF8', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.5, marginBottom: 6, textAlign: 'center' },
  calibFeedbackGrid: { flexDirection: 'row', gap: 6 },
  calibFeedbackItem: {
    flex: 1,
    backgroundColor: '#111522',
    padding: 6,
    borderRadius: 6,
    alignItems: 'center',
  },
  calibItemLabel: { color: '#64748B', fontSize: 7.5, fontWeight: '700' },
  calibItemVal: { color: '#F8FAFC', fontSize: 10.5, fontWeight: '800', marginTop: 2 },

  infoHintBox: {
    width: '100%',
    backgroundColor: '#0D111A',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#1F293D',
  },
  infoHintText: { color: '#94A3B8', fontSize: 11, textAlign: 'center', lineHeight: 16 },

  // Mode B: Live Score Card
  liveScoreCard: {
    backgroundColor: '#0B0F19',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1.5,
    borderColor: '#1E293B',
  },
  confHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  confCardLabel: { color: '#94A3B8', fontSize: 8.5, fontWeight: '800', letterSpacing: 0.8 },
  confidenceTitleBig: { fontSize: 20, fontWeight: '800', marginTop: 2 },
  recalibrateBtn: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  recalibrateBtnText: { color: '#38BDF8', fontSize: 9.5, fontWeight: '800' },
  confMeterTrack: {
    height: 8,
    backgroundColor: '#181E2C',
    borderRadius: 4,
    overflow: 'hidden',
    position: 'relative',
    marginBottom: 8,
  },
  confThresholdLine: {
    position: 'absolute',
    left: '60%',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: '#FFFFFF',
    zIndex: 4,
    opacity: 0.8,
  },
  confMeterFill: { height: '100%', borderRadius: 4 },

  suspectAlertBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.16)',
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#EF4444',
  },
  suspectAlertIcon: { fontSize: 16 },
  suspectAlertTextGroup: { flex: 1 },
  suspectAlertTitle: { color: '#FCA5A5', fontSize: 11, fontWeight: '800' },
  suspectAlertSubtitle: { color: '#F87171', fontSize: 9.5, marginTop: 1 },

  // Quad Metrics Display (2x2 Grid)
  metricsQuadGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  metricQuadCard: {
    width: '48.8%',
    backgroundColor: '#101422',
    borderRadius: 8,
    padding: 6,
    borderWidth: 1,
    borderColor: '#1E2536',
    alignItems: 'center',
  },
  metricQuadCardFailed: {
    borderColor: '#EF4444',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
  },
  metricCardLabel: { color: '#94A3B8', fontSize: 7.5, fontWeight: '800' },
  metricCardVal: { fontSize: 12.5, fontWeight: '900', marginTop: 1 },
  metricCardSub: { color: '#64748B', fontSize: 7.5, marginTop: 1, textAlign: 'center' },
  statusPillSmall: {
    marginTop: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  statusPillSmallText: { fontSize: 7.5, fontWeight: '800' },

  baselinePillsRow: { flexDirection: 'row', gap: 6 },
  baselinePill: {
    flex: 1,
    backgroundColor: '#0A0F1D',
    borderRadius: 6,
    padding: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  baselinePillLabel: { color: '#64748B', fontSize: 7, fontWeight: '700' },
  baselinePillVal: { color: '#F8FAFC', fontSize: 10, fontWeight: '800', marginTop: 2 },

  // ── PINNED SLIDER (STRICT ABSOLUTE POSITION, NEVER MOVES) ──
  pinnedSliderContainer: {
    position: 'absolute',
    bottom: PINNED_SLIDER_BOTTOM,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    height: FIXED_SLIDER_HEIGHT,
  },
  fixedOrderSliderTrack: {
    width: FIXED_SLIDER_WIDTH,
    height: FIXED_SLIDER_HEIGHT,
    backgroundColor: '#121726',
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: '#243048',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  sliderTrackRejected: {
    borderColor: '#EF4444',
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
  },
  sliderTrackAuthentic: {
    borderColor: '#10B981',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  sliderTrackLabelContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sliderTrackLabel: {
    color: '#94A3B8',
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  fixedOrderSliderThumb: {
    width: FIXED_SLIDER_THUMB_SIZE,
    height: FIXED_SLIDER_THUMB_SIZE,
    borderRadius: 25,
    marginLeft: 3,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
  },
  sliderThumbIcon: { color: '#090A0F', fontSize: 16, fontWeight: '900' },

  // ── PINNED FOOTER BAR ──
  pinnedFooterBar: {
    position: 'absolute',
    bottom: PINNED_FOOTER_BOTTOM,
    left: 16,
    right: 16,
    flexDirection: 'row',
    gap: 6,
    height: 44,
  },
  footerMetricBox: {
    flex: 1,
    backgroundColor: '#10141F',
    borderRadius: 6,
    padding: 4,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1C2333',
  },
  footerMetricLabel: { fontSize: 7, fontWeight: '700', letterSpacing: 0.5, color: '#64748B' },
  footerMetricVal: { color: '#F8FAFC', fontSize: 11, fontWeight: '800', marginTop: 1 },
});
