import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  SafeAreaView,
  Platform,
} from 'react-native';
import * as Location from 'expo-location';
import * as Device from 'expo-device';
import MockDataLab from './MockDataLab';

/**
 * Calculates the great-circle distance between two GPS coordinates using the Haversine formula.
 * @param {number|null} lat1 - Latitude of first point in decimal degrees
 * @param {number|null} lon1 - Longitude of first point in decimal degrees
 * @param {number|null} lat2 - Latitude of second point in decimal degrees
 * @param {number|null} lon2 - Longitude of second point in decimal degrees
 * @returns {number} Distance in kilometers (0 if coordinates are invalid or identical)
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return 0;
  if (lat1 === lat2 && lon1 === lon2) return 0;

  const R = 6371; // Earth's mean radius in kilometers
  const toRad = (angle) => (angle * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Stage1Screen Component
 * Stage 1: Foundational Session & Network Security Gate for "The Trust Juggler"
 *
 * @param {Object} props
 * @param {Function} [props.onStage1Result] - Optional pipeline callback returning raw telemetry payload
 */
export default function Stage1Screen({ onStage1Result }) {
  // Concurrency & unmount guard refs
  const isMountedRef = useRef(true);
  const isPingingRef = useRef(false);
  const hasRunInitialLivePing = useRef(false);

  // Active View Mode: 'mock' | 'live' | 'all' (Default to mock per user goal)
  const [activeMode, setActiveMode] = useState('mock');
  const [showLivePayload, setShowLivePayload] = useState(false);

  // Loading & Error States
  const [loading, setLoading] = useState(false);
  const [loadingType, setLoadingType] = useState(''); // 'normal' | 'simulation' | 'initial'
  const [errorMsg, setErrorMsg] = useState(null);

  // Signal 1: Public IP
  const [ipAddress, setIpAddress] = useState(null);
  const [ipLoading, setIpLoading] = useState(false);

  // Signal 2: Device Fingerprint
  const [deviceInfo, setDeviceInfo] = useState({
    brand: null,
    modelName: null,
    osName: null,
    osVersion: null,
    deviceId: '',
  });

  // Signal 3: GPS Telemetry & Implied Velocity
  const [currentSample, setCurrentSample] = useState(null);
  const [previousSample, setPreviousSample] = useState(null);
  const [distanceKm, setDistanceKm] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(null);
  const [velocityKmh, setVelocityKmh] = useState(null);
  const [isImpossibleTravel, setIsImpossibleTravel] = useState(false);
  const [isSimulatedPing, setIsSimulatedPing] = useState(false);

  // Signal 4: Login Timestamp & Shift Hours (08:00 - 20:00)
  const [loginTime, setLoginTime] = useState('--:--:--');
  const [isOffHours, setIsOffHours] = useState(false);

  // Comprehensive Multi-Risk State
  const [primaryRiskFlag, setPrimaryRiskFlag] = useState('PENDING_BASELINE');
  const [activeRiskFlags, setActiveRiskFlags] = useState([]);
  const [latestPayload, setLatestPayload] = useState(null);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /**
   * 1. Public IP Resolver with AbortController timeout
   */
  const fetchPublicIP = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
      setIpLoading(true);
      const response = await fetch('https://api.ipify.org?format=json', {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data?.ip || null;
    } catch {
      return null; // Do not invent an IP address
    } finally {
      clearTimeout(timeoutId);
      if (isMountedRef.current) setIpLoading(false);
    }
  };

  /**
   * 2. Device Fingerprint Collector
   */
  const getDeviceFingerprint = () => {
    const brand = Device.brand || (Platform.OS === 'ios' ? 'Apple' : 'Android');
    const model = Device.modelName || Device.deviceName || 'Device';
    const os = Device.osName || (Platform.OS === 'ios' ? 'iOS' : 'Android');
    const version = Device.osVersion || `${Platform.Version || 'Unknown'}`;
    const cleanId = `${brand}_${model}_${os}_${version}`.replace(/\s+/g, '-');

    return {
      brand,
      modelName: model,
      osName: os,
      osVersion: version,
      deviceId: cleanId,
    };
  };

  /**
   * Shift Window Evaluator (08:00 - 20:00)
   */
  const evaluateShiftWindow = (dateObj) => {
    const hours = dateObj.getHours();
    const offHours = hours < 8 || hours >= 20;
    const timeStr = dateObj.toTimeString().split(' ')[0]; // HH:MM:SS
    return { timeStr, offHours };
  };

  /**
   * Core Session Ping Execution
   * @param {boolean} simulateFraud - When true, computes a controlled +25 km teleport simulation
   */
  const executeSessionPing = useCallback(
    async (simulateFraud = false) => {
      // Prevent overlapping concurrent operations
      if (isPingingRef.current) return;
      isPingingRef.current = true;

      if (isMountedRef.current) {
        setLoading(true);
        setLoadingType(simulateFraud ? 'simulation' : 'normal');
        setErrorMsg(null);
      }

      try {
        const now = Date.now();
        const dateObj = new Date(now);
        const { timeStr, offHours } = evaluateShiftWindow(dateObj);

        // 1. Resolve Network IP
        const ip = await fetchPublicIP();

        // 2. Hardware Fingerprint
        const devInfo = getDeviceFingerprint();

        // 3. Acquire Real GPS
        let acquiredLat = null;
        let acquiredLon = null;
        let locationError = null;

        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const loc = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.High,
            });
            acquiredLat = loc.coords.latitude;
            acquiredLon = loc.coords.longitude;
          } else {
            locationError = 'Location permission was denied by the user.';
          }
        } catch (err) {
          locationError = err?.message || 'GPS location sensor unavailable.';
        }

        // Handle Fallback if simulation requested but hardware GPS is denied in emulator
        if (simulateFraud && (acquiredLat == null || acquiredLon == null)) {
          // If starting sample is missing during simulation, use verified baseline coordinates
          acquiredLat = currentSample?.lat ?? 37.7749;
          acquiredLon = currentSample?.lon ?? -122.4194;
          locationError = null;
        }

        // Establish Sample Target Coordinates
        let sampleLat = acquiredLat;
        let sampleLon = acquiredLon;
        let calculatedDistance = null;
        let calculatedVelocity = null;
        let deltaSeconds = null;

        let baselineForComparison = currentSample || previousSample;

        if (simulateFraud) {
          // Controlled Fraud Simulation:
          // If no previous sample exists, establish a clean origin sample first
          if (!baselineForComparison) {
            baselineForComparison = {
              lat: acquiredLat ?? 37.7749,
              lon: acquiredLon ?? -122.4194,
              timestamp: now - 120 * 1000, // 2 minutes ago
              simulated: false,
            };
          }

          // Generate destination precisely ~25 km away:
          // deltaLat = 25 / (sqrt(2) * 111) ≈ 0.1592 deg
          // deltaLon = 25 / (sqrt(2) * 111 * cos(lat))
          const originLat = baselineForComparison.lat;
          const originLon = baselineForComparison.lon;
          const cosLat = Math.cos((originLat * Math.PI) / 180) || 1;
          const deltaDegLat = 25 / (Math.SQRT2 * 111);
          const deltaDegLon = 25 / (Math.SQRT2 * 111 * Math.abs(cosLat));

          sampleLat = Number((originLat + deltaDegLat).toFixed(6));
          sampleLon = Number((originLon + deltaDegLon).toFixed(6));

          // Controlled elapsed time: 120 seconds (2 minutes = 0.0333 hours)
          deltaSeconds = 120;
          calculatedDistance = calculateHaversineDistance(
            originLat,
            originLon,
            sampleLat,
            sampleLon
          );

          // Implied velocity = distance (km) / elapsed_hours
          const elapsedHours = deltaSeconds / 3600;
          calculatedVelocity = calculatedDistance / elapsedHours;
        } else {
          // Normal Live Sample Ping
          if (acquiredLat != null && acquiredLon != null && baselineForComparison?.lat != null) {
            calculatedDistance = calculateHaversineDistance(
              baselineForComparison.lat,
              baselineForComparison.lon,
              acquiredLat,
              acquiredLon
            );

            // Elapsed time in seconds (floor at 1s to prevent division by near-zero)
            const actualDeltaMs = now - (baselineForComparison.timestamp || now);
            deltaSeconds = Math.max(1, Math.round(actualDeltaMs / 1000));
            const elapsedHours = deltaSeconds / 3600;
            calculatedVelocity = calculatedDistance / elapsedHours;
          } else {
            // First sample or missing GPS: Do NOT report 0 km/h as confirmed measurement!
            calculatedDistance = null;
            calculatedVelocity = null;
            deltaSeconds = null;
          }
        }

        // Impossible Travel Detection (> 120 km/h threshold)
        const impossible = calculatedVelocity != null && calculatedVelocity > 120;

        // Construct Composite Risk Flags (All conditions preserved)
        const flags = [];
        if (impossible) {
          flags.push('IMPOSSIBLE_TRAVEL');
        }
        if (acquiredLat == null && !simulateFraud) {
          flags.push('LOCATION_UNAVAILABLE');
        }
        if (ip == null) {
          flags.push('NETWORK_UNAVAILABLE');
        }
        if (offHours) {
          flags.push('OFF_HOURS_LOGIN');
        }
        if (calculatedVelocity == null && acquiredLat != null && !impossible) {
          flags.push('PENDING_BASELINE');
        }
        if (flags.length === 0 || (flags.length === 1 && flags[0] === 'OFF_HOURS_LOGIN' && !impossible)) {
          if (!impossible && calculatedVelocity != null) {
            flags.unshift('STAGE_1_PASSED');
          }
        }

        // Primary flag precedence:
        // IMPOSSIBLE_TRAVEL > LOCATION_UNAVAILABLE > NETWORK_UNAVAILABLE > PENDING_BASELINE > OFF_HOURS_LOGIN > STAGE_1_PASSED
        let primaryFlag = 'STAGE_1_PASSED';
        if (impossible) {
          primaryFlag = 'IMPOSSIBLE_TRAVEL';
        } else if (acquiredLat == null && !simulateFraud) {
          primaryFlag = 'LOCATION_UNAVAILABLE';
        } else if (ip == null) {
          primaryFlag = 'NETWORK_UNAVAILABLE';
        } else if (calculatedVelocity == null) {
          primaryFlag = 'PENDING_BASELINE';
        } else if (offHours) {
          primaryFlag = 'OFF_HOURS_LOGIN';
        }

        const newSampleObj = {
          lat: sampleLat,
          lon: sampleLon,
          timestamp: now,
          simulated: simulateFraud,
        };

        // Update Component State
        if (isMountedRef.current) {
          setLoginTime(timeStr);
          setIsOffHours(offHours);
          setIpAddress(ip);
          setDeviceInfo(devInfo);

          if (baselineForComparison && currentSample) {
            setPreviousSample(currentSample);
          } else if (baselineForComparison) {
            setPreviousSample(baselineForComparison);
          }

          setCurrentSample(newSampleObj);
          setDistanceKm(calculatedDistance != null ? Number(calculatedDistance.toFixed(3)) : null);
          setElapsedSeconds(deltaSeconds);
          setVelocityKmh(calculatedVelocity != null ? Number(calculatedVelocity.toFixed(2)) : null);
          setIsImpossibleTravel(impossible);
          setIsSimulatedPing(simulateFraud);
          setPrimaryRiskFlag(primaryFlag);
          setActiveRiskFlags(flags);

          if (locationError) {
            setErrorMsg(locationError);
          }
        }

        // Build Team Integration Payload
        const payload = {
          ip: ip ?? null,
          device_id: devInfo.deviceId,
          lat: sampleLat != null ? Number(sampleLat.toFixed(6)) : null,
          lon: sampleLon != null ? Number(sampleLon.toFixed(6)) : null,
          velocity_kmh: calculatedVelocity != null ? Number(calculatedVelocity.toFixed(2)) : null,
          login_time: timeStr,
          risk_flag: primaryFlag,
          risk_flags: flags,
          is_off_hours: offHours,
          distance_km: calculatedDistance != null ? Number(calculatedDistance.toFixed(3)) : null,
          timestamp: now,
          simulated: simulateFraud,
        };

        if (isMountedRef.current) {
          setLatestPayload(payload);
        }

        // Fire Integration Callback
        if (typeof onStage1Result === 'function') {
          onStage1Result(payload);
        }
      } catch (err) {
        if (isMountedRef.current) {
          setErrorMsg(err?.message || 'Error occurred during session ping assessment.');
        }
      } finally {
        isPingingRef.current = false;
        if (isMountedRef.current) {
          setLoading(false);
          setLoadingType('');
        }
      }
    },
    [currentSample, previousSample, onStage1Result]
  );

  // Initial Ping on Mount (Only triggered if Live Hardware Gate is activated, ensuring no permission prompts during Mock Lab usage)
  useEffect(() => {
    if ((activeMode === 'live' || activeMode === 'all') && !hasRunInitialLivePing.current) {
      hasRunInitialLivePing.current = true;
      executeSessionPing(false);
    }
  }, [activeMode, executeSessionPing]);

  // Format Elapsed Time Display
  const formatElapsedTime = (sec) => {
    if (sec == null) return 'N/A';
    if (sec < 60) return `${sec}s`;
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${mins}m ${rem}s`;
  };

  const showMock = activeMode === 'mock' || activeMode === 'all';
  const showLive = activeMode === 'live' || activeMode === 'all';

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ==================================================
            1. POLISHED SECURITY HEADER
           ================================================== */}
        <View style={styles.header}>
          <View style={styles.headerTopRow}>
            <View style={styles.stageBadge}>
              <Text style={styles.stageBadgeText}>STAGE 1</Text>
            </View>
            <View
              style={[
                styles.statusIndicatorBadge,
                activeMode === 'mock'
                  ? styles.indicatorPurple
                  : primaryRiskFlag === 'IMPOSSIBLE_TRAVEL'
                  ? styles.indicatorDanger
                  : primaryRiskFlag === 'PENDING_BASELINE'
                  ? styles.indicatorWarning
                  : styles.indicatorSuccess,
              ]}
            >
              <View
                style={[
                  styles.statusDot,
                  activeMode === 'mock'
                    ? styles.dotPurple
                    : primaryRiskFlag === 'IMPOSSIBLE_TRAVEL'
                    ? styles.dotDanger
                    : primaryRiskFlag === 'PENDING_BASELINE'
                    ? styles.dotWarning
                    : styles.dotSuccess,
                ]}
              />
              <Text
                style={[
                  styles.statusIndicatorText,
                  activeMode === 'mock'
                    ? styles.textPurple
                    : primaryRiskFlag === 'IMPOSSIBLE_TRAVEL'
                    ? styles.textDanger
                    : primaryRiskFlag === 'PENDING_BASELINE'
                    ? styles.textWarning
                    : styles.textSuccess,
                ]}
              >
                {activeMode === 'mock'
                  ? 'MOCK LAB ACTIVE'
                  : primaryRiskFlag === 'IMPOSSIBLE_TRAVEL'
                  ? 'CRITICAL ALERT'
                  : primaryRiskFlag === 'PENDING_BASELINE'
                  ? 'BASELINE INITIALIZING'
                  : 'GATE ACTIVE'}
              </Text>
            </View>
          </View>

          <Text style={styles.brandTitle}>The Trust Juggler</Text>
          <Text style={styles.brandSubtitle}>
            {activeMode === 'mock'
              ? 'Interactive Simulated Data Lab — Isolated testing of GPS, rider, session, and network telemetry.'
              : 'Foundational Session & Network Gate — Real-time telemetry, device profiling & impossible-travel defense.'}
          </Text>
        </View>

        {/* ==================================================
            TAB NAVIGATION: MOCK LAB vs LIVE GATE
           ================================================== */}
        <View style={styles.modeTabsContainer}>
          <TouchableOpacity
            style={[styles.modeTab, activeMode === 'mock' && styles.modeTabActiveMock]}
            onPress={() => setActiveMode('mock')}
            activeOpacity={0.8}
            accessibilityRole="tab"
            accessibilityLabel="Mock Data Lab"
          >
            <Text style={[styles.modeTabText, activeMode === 'mock' && styles.modeTabTextActive]}>
              🧪 Mock Data Lab
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, activeMode === 'live' && styles.modeTabActiveLive]}
            onPress={() => {
              setActiveMode('live');
              if (!hasRunInitialLivePing.current) {
                hasRunInitialLivePing.current = true;
                executeSessionPing(false);
              }
            }}
            activeOpacity={0.8}
            accessibilityRole="tab"
            accessibilityLabel="Live Telemetry Gate"
          >
            <Text style={[styles.modeTabText, activeMode === 'live' && styles.modeTabTextActive]}>
              📡 Live Hardware Gate
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, activeMode === 'all' && styles.modeTabActiveAll]}
            onPress={() => {
              setActiveMode('all');
              if (!hasRunInitialLivePing.current) {
                hasRunInitialLivePing.current = true;
                executeSessionPing(false);
              }
            }}
            activeOpacity={0.8}
            accessibilityRole="tab"
            accessibilityLabel="Show Both Sections"
          >
            <Text style={[styles.modeTabText, activeMode === 'all' && styles.modeTabTextActive]}>
              📄 Both
            </Text>
          </TouchableOpacity>
        </View>

        {/* ==================================================
            INTERACTIVE MOCK DATA LAB
           ================================================== */}
        {showMock && (
          <MockDataLab onStage1Result={onStage1Result} />
        )}

        {/* ==================================================
            LIVE HARDWARE GATE SECTION
           ================================================== */}
        {showLive && (
          <View>
            {activeMode === 'all' && (
              <View style={styles.liveSectionDivider}>
                <Text style={styles.liveSectionDividerText}>
                  📡 LIVE HARDWARE GATE TELEMETRY
                </Text>
              </View>
            )}

            {/* SECURITY EVALUATION HERO BANNER */}
            <View
              style={[
                styles.banner,
                primaryRiskFlag === 'IMPOSSIBLE_TRAVEL'
                  ? styles.bannerDanger
                  : primaryRiskFlag === 'PENDING_BASELINE'
                  ? styles.bannerInfo
                  : primaryRiskFlag === 'LOCATION_UNAVAILABLE'
                  ? styles.bannerWarning
                  : styles.bannerSuccess,
              ]}
        >
          <Text style={styles.bannerIcon}>
            {primaryRiskFlag === 'IMPOSSIBLE_TRAVEL'
              ? '🚨'
              : primaryRiskFlag === 'PENDING_BASELINE'
              ? '📡'
              : primaryRiskFlag === 'LOCATION_UNAVAILABLE'
              ? '📍'
              : '🛡️'}
          </Text>
          <View style={styles.bannerContent}>
            <Text
              style={[
                styles.bannerTitle,
                primaryRiskFlag === 'IMPOSSIBLE_TRAVEL'
                  ? styles.textDanger
                  : primaryRiskFlag === 'PENDING_BASELINE'
                  ? styles.textInfo
                  : primaryRiskFlag === 'LOCATION_UNAVAILABLE'
                  ? styles.textWarning
                  : styles.textSuccess,
              ]}
            >
              {primaryRiskFlag === 'IMPOSSIBLE_TRAVEL'
                ? 'IMPOSSIBLE TRAVEL DETECTED'
                : primaryRiskFlag === 'PENDING_BASELINE'
                ? 'BASELINE ESTABLISHED (1st SAMPLE)'
                : primaryRiskFlag === 'LOCATION_UNAVAILABLE'
                ? 'LOCATION TELEMETRY UNAVAILABLE'
                : 'STAGE 1 PASSED — SESSION VERIFIED'}
            </Text>
            <Text style={styles.bannerSubtitle}>
              {primaryRiskFlag === 'IMPOSSIBLE_TRAVEL'
                ? `Implied speed ${velocityKmh} km/h strictly exceeds the 120 km/h physical limit.`
                : primaryRiskFlag === 'PENDING_BASELINE'
                ? 'Initial GPS position recorded. Subsequent pings will evaluate travel velocity.'
                : primaryRiskFlag === 'LOCATION_UNAVAILABLE'
                ? 'GPS permissions or sensor not responding. Check device settings.'
                : `Travel speed ${velocityKmh != null ? `${velocityKmh} km/h` : 'verified'} is well within physical boundaries.`}
            </Text>
          </View>
        </View>

        {/* Transient Error Notice */}
        {errorMsg ? (
          <View style={styles.errorNoticeCard}>
            <Text style={styles.errorNoticeText}>⚠️ {errorMsg}</Text>
          </View>
        ) : null}

        {/* ==================================================
            SIGNAL 1: NETWORK INTELLIGENCE
           ================================================== */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderLeft}>
              <Text style={styles.cardIcon}>🌐</Text>
              <Text style={styles.cardTitle}>Network Intelligence</Text>
            </View>
            {ipLoading && <ActivityIndicator size="small" color="#3B82F6" />}
          </View>

          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Public IP Address:</Text>
            {ipLoading ? (
              <Text style={styles.metricMuted}>Resolving...</Text>
            ) : ipAddress ? (
              <Text style={styles.metricMonospaceHighlight}>{ipAddress}</Text>
            ) : (
              <Text style={styles.metricTextWarning}>Unavailable (Offline)</Text>
            )}
          </View>

          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Service Gateway:</Text>
            <Text style={styles.metricValue}>api.ipify.org</Text>
          </View>

          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Network Status:</Text>
            <Text
              style={[
                styles.badgeStatus,
                ipAddress ? styles.badgeSuccess : styles.badgeWarning,
              ]}
            >
              {ipAddress ? 'Online / Public IPv4' : 'Network Degraded'}
            </Text>
          </View>
        </View>

        {/* ==================================================
            SIGNAL 2: DEVICE FINGERPRINT
           ================================================== */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderLeft}>
              <Text style={styles.cardIcon}>📱</Text>
              <Text style={styles.cardTitle}>Device Fingerprint Profile</Text>
            </View>
            <Text style={styles.heuristicTag}>Descriptive Profile</Text>
          </View>

          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Device Identifier:</Text>
            <Text style={styles.metricDeviceId} numberOfLines={1} ellipsizeMode="middle">
              {deviceInfo.deviceId || 'Identifying...'}
            </Text>
          </View>

          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Hardware Brand & Model:</Text>
            <Text style={styles.metricValue}>
              {deviceInfo.brand || 'Generic'} {deviceInfo.modelName || 'Device'}
            </Text>
          </View>

          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Operating System:</Text>
            <Text style={styles.metricValue}>
              {deviceInfo.osName || Platform.OS} {deviceInfo.osVersion || ''}
            </Text>
          </View>

          <Text style={styles.disclaimerText}>
            ℹ️ Descriptive hardware heuristic collected via expo-device. Non-cryptographic.
          </Text>
        </View>

        {/* ==================================================
            SIGNAL 3: GPS & IMPOSSIBLE TRAVEL ENGINE
           ================================================== */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderLeft}>
              <Text style={styles.cardIcon}>📍</Text>
              <Text style={styles.cardTitle}>GPS Telemetry & Velocity Engine</Text>
            </View>
            {isSimulatedPing && (
              <View style={styles.simulatedPill}>
                <Text style={styles.simulatedPillText}>SIMULATED PING</Text>
              </View>
            )}
          </View>

          {/* Current GPS Coordinates */}
          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Current GPS Sample:</Text>
            {currentSample?.lat != null ? (
              <Text style={styles.metricMonospace}>
                {currentSample.lat.toFixed(5)}°, {currentSample.lon.toFixed(5)}°
              </Text>
            ) : (
              <Text style={styles.metricTextWarning}>No valid GPS reading</Text>
            )}
          </View>

          {/* Previous GPS Coordinates */}
          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Previous GPS Sample:</Text>
            {previousSample?.lat != null ? (
              <Text style={styles.metricMonospace}>
                {previousSample.lat.toFixed(5)}°, {previousSample.lon.toFixed(5)}°
              </Text>
            ) : (
              <Text style={styles.metricMuted}>Initial Baseline (No Prior)</Text>
            )}
          </View>

          {/* Haversine Distance */}
          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Haversine Distance:</Text>
            <Text style={styles.metricValue}>
              {distanceKm != null ? `${distanceKm} km` : 'Pending 2nd sample'}
            </Text>
          </View>

          {/* Elapsed Time */}
          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Elapsed Sample Time:</Text>
            <Text style={styles.metricValue}>{formatElapsedTime(elapsedSeconds)}</Text>
          </View>

          {/* Implied Velocity with Threshold Comparison */}
          <View style={[styles.metricRow, styles.metricRowHighlight]}>
            <Text style={styles.metricLabelBold}>Implied Velocity:</Text>
            {velocityKmh != null ? (
              <Text
                style={[
                  styles.velocityText,
                  isImpossibleTravel ? styles.textDanger : styles.textSuccess,
                ]}
              >
                {velocityKmh} km/h{' '}
                <Text style={styles.thresholdSubtext}>
                  (Limit: 120 km/h)
                </Text>
              </Text>
            ) : (
              <Text style={styles.metricTextInfo}>
                Baseline Established (Awaiting 2nd ping)
              </Text>
            )}
          </View>
        </View>

        {/* ==================================================
            SIGNAL 4: LOGIN TIMESTAMP & SHIFT WINDOW
           ================================================== */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderLeft}>
              <Text style={styles.cardIcon}>⏱️</Text>
              <Text style={styles.cardTitle}>Session Timestamp & Shift Window</Text>
            </View>
          </View>

          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Session Login Time:</Text>
            <Text style={styles.metricMonospaceHighlight}>{loginTime}</Text>
          </View>

          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Standard Shift Window:</Text>
            <Text style={styles.metricValue}>08:00 – 20:00 (Local)</Text>
          </View>

          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Shift Window Status:</Text>
            <Text
              style={[
                styles.badgeStatus,
                isOffHours ? styles.badgeWarning : styles.badgeSuccess,
              ]}
            >
              {isOffHours ? '⚠️ Off-Hours Login (Night Window)' : '✅ Standard Daytime Shift'}
            </Text>
          </View>

          {isOffHours && (
            <Text style={styles.disclaimerText}>
              Note: Off-hours logins represent an anomaly signal but are not automatically flagged as fraud.
            </Text>
          )}
        </View>

        {/* ==================================================
            7. COLLAPSIBLE INTEGRATION PAYLOAD (PART 1 #5)
           ================================================== */}
        {latestPayload && (
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.accordionPayloadHeader}
              onPress={() => setShowLivePayload(!showLivePayload)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Toggle Integration Payload"
            >
              <View style={styles.cardHeaderLeft}>
                <Text style={styles.cardIcon}>📦</Text>
                <Text style={styles.cardTitle}>
                  {showLivePayload ? '▼' : '▶'} View Integration Payload
                </Text>
              </View>
              <Text style={styles.contractVersionTag}>v1.0 Live</Text>
            </TouchableOpacity>

            {showLivePayload && (
              <View style={styles.codeContainer}>
                <Text style={styles.codeText}>
                  {JSON.stringify(latestPayload, null, 2)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* ==================================================
            DEMO & DIAGNOSTIC CONTROLS ("GOD-MODE")
           ================================================== */}
        <View style={styles.controlsSection}>
          <Text style={styles.controlsHeading}>DEMO & DIAGNOSTIC CONTROLS</Text>

          {/* Normal Ping Button */}
          <TouchableOpacity
            style={[styles.button, styles.buttonNormal]}
            onPress={() => executeSessionPing(false)}
            disabled={loading}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Ping Normal Login"
          >
            {loading && loadingType === 'normal' ? (
              <ActivityIndicator color="#F8FAFC" />
            ) : (
              <Text style={styles.buttonText}>🔄 Ping Normal Login</Text>
            )}
          </TouchableOpacity>

          {/* Fraud Teleport Simulation Button */}
          <TouchableOpacity
            style={[styles.button, styles.buttonDanger]}
            onPress={() => executeSessionPing(true)}
            disabled={loading}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Simulate Fraud Teleport +25km"
          >
            {loading && loadingType === 'simulation' ? (
              <ActivityIndicator color="#F8FAFC" />
            ) : (
              <Text style={styles.buttonText}>
                ⚡ Simulate Fraud (Teleport +25km)
              </Text>
            )}
          </TouchableOpacity>

          <Text style={styles.controlsHelpText}>
            Simulate Fraud applies a controlled +25 km displacement from your latest sample over a 120s window to demonstrate the &gt;120 km/h impossible travel trigger.
          </Text>
        </View>
        </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  scrollContent: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 36,
  },
  header: {
    marginBottom: 10,
  },
  headerTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  stageBadge: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  stageBadgeText: {
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  statusIndicatorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 14,
    borderWidth: 1,
  },
  indicatorSuccess: {
    backgroundColor: '#064E3B',
    borderColor: '#059669',
  },
  indicatorWarning: {
    backgroundColor: '#78350F',
    borderColor: '#D97706',
  },
  indicatorDanger: {
    backgroundColor: '#7F1D1D',
    borderColor: '#DC2626',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 5,
  },
  dotSuccess: {
    backgroundColor: '#10B981',
  },
  dotWarning: {
    backgroundColor: '#F59E0B',
  },
  dotDanger: {
    backgroundColor: '#EF4444',
  },
  statusIndicatorText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  brandTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: -0.4,
  },
  brandSubtitle: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
    lineHeight: 15,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 14,
    borderWidth: 1.5,
    marginBottom: 16,
  },
  bannerSuccess: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
  },
  bannerWarning: {
    backgroundColor: '#78350F',
    borderColor: '#F59E0B',
  },
  bannerDanger: {
    backgroundColor: '#7F1D1D',
    borderColor: '#EF4444',
  },
  bannerInfo: {
    backgroundColor: '#1E293B',
    borderColor: '#3B82F6',
  },
  bannerIcon: {
    fontSize: 28,
    marginRight: 14,
  },
  bannerContent: {
    flex: 1,
  },
  bannerTitle: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  bannerSubtitle: {
    color: '#E2E8F0',
    fontSize: 12,
    marginTop: 3,
    lineHeight: 16,
  },
  errorNoticeCard: {
    backgroundColor: '#451A03',
    borderColor: '#B45309',
    borderWidth: 1,
    padding: 12,
    borderRadius: 8,
    marginBottom: 14,
  },
  errorNoticeText: {
    color: '#FCD34D',
    fontSize: 12,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardIcon: {
    fontSize: 17,
    marginRight: 8,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#F8FAFC',
    letterSpacing: 0.2,
  },
  heuristicTag: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94A3B8',
    backgroundColor: '#0F172A',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  simulatedPill: {
    backgroundColor: '#7C3AED',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  simulatedPillText: {
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: '800',
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 5,
  },
  metricRowHighlight: {
    paddingTop: 8,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  metricLabel: {
    fontSize: 13,
    color: '#94A3B8',
  },
  metricLabelBold: {
    fontSize: 13,
    fontWeight: '700',
    color: '#E2E8F0',
  },
  metricValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#F8FAFC',
  },
  metricMonospace: {
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '600',
    color: '#CBD5E1',
  },
  metricMonospaceHighlight: {
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '700',
    color: '#38BDF8',
  },
  metricDeviceId: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#93C5FD',
    maxWidth: '65%',
  },
  metricMuted: {
    fontSize: 12,
    fontStyle: 'italic',
    color: '#64748B',
  },
  velocityText: {
    fontSize: 14,
    fontWeight: '800',
  },
  thresholdSubtext: {
    fontSize: 11,
    fontWeight: '400',
    color: '#94A3B8',
  },
  badgeStatus: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
  },
  badgeSuccess: {
    backgroundColor: '#064E3B',
    color: '#34D399',
  },
  badgeWarning: {
    backgroundColor: '#78350F',
    color: '#FBBF24',
  },
  disclaimerText: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 10,
    lineHeight: 15,
  },
  payloadCard: {
    backgroundColor: '#090D16',
    borderRadius: 14,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  contractVersionTag: {
    fontSize: 10,
    fontWeight: '700',
    color: '#10B981',
    backgroundColor: '#064E3B',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  codeContainer: {
    backgroundColor: '#020617',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  codeText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    color: '#A5F3FC',
    lineHeight: 16,
  },
  controlsSection: {
    marginTop: 8,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  controlsHeading: {
    fontSize: 12,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 1,
    marginBottom: 12,
    textAlign: 'center',
  },
  button: {
    minHeight: 48,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  buttonNormal: {
    backgroundColor: '#3B82F6',
  },
  buttonDanger: {
    backgroundColor: '#DC2626',
  },
  buttonText: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  controlsHelpText: {
    fontSize: 11,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 15,
    marginTop: 4,
    paddingHorizontal: 8,
  },
  textSuccess: {
    color: '#10B981',
  },
  textWarning: {
    color: '#F59E0B',
  },
  textDanger: {
    color: '#EF4444',
  },
  textInfo: {
    color: '#3B82F6',
  },
  metricTextWarning: {
    color: '#F59E0B',
    fontSize: 12,
    fontWeight: '600',
  },
  metricTextInfo: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '600',
  },
  modeTabsContainer: {
    flexDirection: 'row',
    backgroundColor: '#0F172A',
    borderRadius: 10,
    padding: 3,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modeTab: {
    flex: 1,
    minHeight: 38,
    paddingVertical: 8,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeTabActiveMock: {
    backgroundColor: '#4C1D95',
  },
  modeTabActiveLive: {
    backgroundColor: '#1E3A8A',
  },
  modeTabActiveAll: {
    backgroundColor: '#334155',
  },
  modeTabText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '700',
  },
  modeTabTextActive: {
    color: '#F8FAFC',
    fontWeight: '800',
  },
  indicatorPurple: {
    backgroundColor: '#2E1065',
    borderColor: '#7C3AED',
  },
  dotPurple: {
    backgroundColor: '#A78BFA',
  },
  textPurple: {
    color: '#C4B5FD',
  },
  accordionPayloadHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  liveSectionDivider: {
    paddingVertical: 10,
    marginBottom: 10,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    alignItems: 'center',
  },
  liveSectionDividerText: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
});
