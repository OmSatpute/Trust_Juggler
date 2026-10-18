/**
 * Custom Mock Scenario Engine for Trust Juggler
 * Combines mock Rider, GPS, Session, and Network inputs into a unified, internally consistent simulated scenario.
 * Calculates Haversine distance and implied velocity dynamically.
 * Produces neutral, calibrated risk evaluations (Normal, Elevated Risk, High Risk — Review Required).
 */

import {
  calculateHaversineDistance,
  calculateVelocityKmh,
  formatElapsedTime,
  formatCoordinates,
} from './geoUtils.js';
import { MOCK_RIDERS } from './mockRiders.js';

// Predefined Quick Scenario Presets
export const QUICK_SCENARIO_PRESETS = [
  {
    id: 'normal_rider',
    name: 'Normal Rider',
    description: 'Standard delivery in shift hours with registered iPhone and normal GPS pace.',
    config: {
      riderChoice: 'regular',
      gpsChoice: 'normal',
      sessionChoice: 'normal',
      networkChoice: 'normal_network',
    },
  },
  {
    id: 'new_device_login',
    name: 'New Device Login',
    description: 'Courier logs in with unrecognized OnePlus hardware during normal shift.',
    config: {
      riderChoice: 'new_device',
      gpsChoice: 'nearby',
      sessionChoice: 'unknown_device',
      networkChoice: 'normal_network',
    },
  },
  {
    id: 'off_hours_login',
    name: 'Off-Hours Login',
    description: 'Session initiated at 03:22 AM outside the standard 08:00–20:00 window.',
    config: {
      riderChoice: 'unusual_pattern',
      gpsChoice: 'normal',
      sessionChoice: 'off_hours',
      networkChoice: 'normal_network',
    },
  },
  {
    id: 'impossible_travel',
    name: 'Impossible Travel',
    description: 'Rider teleports ~25 km across the bay in 2 minutes (implied velocity >700 km/h).',
    config: {
      riderChoice: 'regular',
      gpsChoice: 'impossible',
      sessionChoice: 'normal',
      networkChoice: 'normal_network',
    },
  },
  {
    id: 'multiple_anomalies',
    name: 'Multiple Anomalies',
    description: 'Compound risk: Impossible travel + Off-hours login + Unknown device + Datacenter IP.',
    config: {
      riderChoice: 'regular',
      gpsChoice: 'impossible',
      sessionChoice: 'suspicious',
      networkChoice: 'different_ip',
    },
  },
];

/**
 * Builds and evaluates a custom mock scenario from component selections.
 * @param {Object} options
 * @param {string} [options.scenarioName]
 * @param {string} [options.riderChoice] - 'regular' | 'new_device' | 'unusual_pattern'
 * @param {string} [options.gpsChoice] - 'normal' | 'nearby' | 'impossible' | 'unavailable'
 * @param {string} [options.sessionChoice] - 'normal' | 'off_hours' | 'unknown_device' | 'suspicious'
 * @param {string} [options.networkChoice] - 'normal_network' | 'different_ip' | 'unavailable'
 */
export function buildCustomScenario(options = {}) {
  const {
    scenarioName = 'Custom Scenario',
    riderChoice = 'regular',
    gpsChoice = 'normal',
    sessionChoice = 'normal',
    networkChoice = 'normal_network',
  } = options;

  // ----------------------------------------------------
  // 1. Resolve Rider Profile
  // ----------------------------------------------------
  let baseRider = MOCK_RIDERS[0]; // Alex Vance
  let riderLabel = 'Regular Rider (Alex Vance)';

  if (riderChoice === 'new_device') {
    baseRider = MOCK_RIDERS[1]; // Elena Rostova
    riderLabel = 'New Device Rider (Elena Rostova)';
  } else if (riderChoice === 'unusual_pattern') {
    baseRider = MOCK_RIDERS[2]; // Marcus Chen
    riderLabel = 'Unusual Login Pattern Rider (Marcus Chen)';
  }

  // ----------------------------------------------------
  // 2. Resolve GPS Telemetry & Physics Calculation
  // ----------------------------------------------------
  let previousLat = null;
  let previousLon = null;
  let previousLocation = 'N/A';
  let currentLat = null;
  let currentLon = null;
  let currentLocation = 'N/A';
  let elapsedSeconds = null;
  let gpsStatus = 'LOCATION_UNAVAILABLE';
  let isGpsUnavailable = false;

  if (gpsChoice === 'normal') {
    previousLat = 37.77928;
    previousLon = -122.41924;
    previousLocation = 'Civic Center Logistics Hub, San Francisco';
    currentLat = 37.78912;
    currentLon = -122.40145;
    currentLocation = 'Downtown Market St Corridor, San Francisco';
    elapsedSeconds = 480; // 8 minutes
    gpsStatus = 'SIMULATED_HIGH_PRECISION_FIX';
  } else if (gpsChoice === 'nearby') {
    previousLat = 37.78582;
    previousLon = -122.39991;
    previousLocation = '3rd & Howard Delivery Depot, San Francisco';
    currentLat = 37.78423;
    currentLon = -122.40352;
    currentLocation = '4th & Mission Retail Pickup, San Francisco';
    elapsedSeconds = 150; // 2.5 minutes
    gpsStatus = 'SIMULATED_HIGH_PRECISION_FIX';
  } else if (gpsChoice === 'impossible') {
    previousLat = 37.77928;
    previousLon = -122.41924;
    previousLocation = 'Civic Center Logistics Hub, San Francisco';
    currentLat = 37.69170;
    currentLon = -122.15750;
    currentLocation = 'San Leandro East Bay Distribution Center (~25km)';
    elapsedSeconds = 120; // 2 minutes
    gpsStatus = 'SIMULATED_HIGH_PRECISION_FIX';
  } else {
    // 'unavailable'
    isGpsUnavailable = true;
    gpsStatus = 'LOCATION_UNAVAILABLE';
  }

  // Haversine distance and velocity calculation
  let distanceKm = null;
  let velocityKmh = null;
  let isImpossibleSpeed = false;

  if (!isGpsUnavailable && previousLat != null && currentLat != null) {
    distanceKm = calculateHaversineDistance(previousLat, previousLon, currentLat, currentLon);
    velocityKmh = calculateVelocityKmh(distanceKm, elapsedSeconds);
    if (velocityKmh != null && velocityKmh > 120) {
      isImpossibleSpeed = true;
    }
  }

  // ----------------------------------------------------
  // 3. Resolve Device & Session Authentication
  // ----------------------------------------------------
  let isDeviceRecognised = true;
  let sessionDeviceId = baseRider.registeredDeviceId;
  let loginTime = '10:14:22';
  let loginTimestamp = '2026-10-18 10:14:22 UTC';
  let timeClassification = 'STANDARD_SHIFT (10:14 Daytime)';
  let isOffHours = false;
  let sessionStatus = 'AUTHENTICATED';

  const isUnknownDevice =
    sessionChoice === 'unknown_device' ||
    sessionChoice === 'suspicious' ||
    riderChoice === 'new_device';

  const isOffHoursSession =
    sessionChoice === 'off_hours' ||
    sessionChoice === 'suspicious' ||
    riderChoice === 'unusual_pattern';

  if (isUnknownDevice) {
    isDeviceRecognised = false;
    sessionDeviceId =
      sessionChoice === 'suspicious'
        ? 'Generic_VirtualMachine_Linux_5.15'
        : 'OnePlus_12_Android_14';
  }

  if (isOffHoursSession) {
    isOffHours = true;
    loginTime = '03:22:45';
    loginTimestamp = '2026-10-18 03:22:45 UTC';
    timeClassification = 'OFF_HOURS_NIGHT_WINDOW (03:22 Local)';
  }

  if (sessionChoice === 'suspicious') {
    sessionStatus = 'QUARANTINED_PENDING_AUDIT';
  } else if (isUnknownDevice) {
    sessionStatus = 'CHALLENGE_REQUIRED';
  } else if (isOffHoursSession) {
    sessionStatus = 'ANOMALY_FLAGGED';
  } else {
    sessionStatus = 'AUTHENTICATED';
  }

  // ----------------------------------------------------
  // 4. Resolve Network Intelligence
  // ----------------------------------------------------
  let testIp = '198.51.100.15';
  let testIpLabel = '198.51.100.15 (RFC 5737 / TEST-NET-2)';
  let networkStatus = 'TEST_ONLINE_VERIFIED';
  let connectionType = 'Cellular 5G (Mobile ISP Gateway)';
  let networkRiskStatus = 'LOW_RISK';
  let isNetworkUnavailable = false;

  if (networkChoice === 'different_ip') {
    testIp = '203.0.113.54';
    testIpLabel = '203.0.113.54 (RFC 5737 / TEST-NET-3)';
    networkStatus = 'TEST_ONLINE_DATACENTER';
    connectionType = 'Hosting Datacenter IP (Colocation / VPS)';
    networkRiskStatus = 'ELEVATED_RISK_HOSTING_ASN';
  } else if (networkChoice === 'unavailable') {
    testIp = null;
    testIpLabel = 'Unavailable (Offline)';
    networkStatus = 'NETWORK_UNAVAILABLE';
    connectionType = 'None (Device Offline)';
    networkRiskStatus = 'NETWORK_UNAVAILABLE';
    isNetworkUnavailable = true;
  }

  // ----------------------------------------------------
  // 5. Synthesize Simultaneous Risk Flags
  // ----------------------------------------------------
  const riskFlags = [];

  if (isImpossibleSpeed) {
    riskFlags.push('IMPOSSIBLE_TRAVEL');
  }
  if (isGpsUnavailable) {
    riskFlags.push('LOCATION_UNAVAILABLE');
  }
  if (isOffHours) {
    riskFlags.push('OFF_HOURS_LOGIN');
  }
  if (!isDeviceRecognised) {
    riskFlags.push('UNRECOGNIZED_DEVICE');
  }
  if (networkChoice === 'different_ip') {
    riskFlags.push('DATACENTER_IP');
  }
  if (isNetworkUnavailable) {
    riskFlags.push('NETWORK_UNAVAILABLE');
  }

  if (riskFlags.length === 0) {
    riskFlags.push('STAGE_1_PASSED');
  }

  // ----------------------------------------------------
  // 6. Neutral Combined Risk Assessment
  // ----------------------------------------------------
  let overallAssessment = 'Normal';
  let assessmentBadge = 'NORMAL';
  let badgeType = 'success'; // 'success' | 'warning' | 'danger'
  let assessmentGuidance =
    'All observed telemetry signals conform to standard baseline thresholds. Session approved.';

  const anomalyCount = riskFlags.filter((f) => f !== 'STAGE_1_PASSED').length;

  if (isImpossibleSpeed || anomalyCount >= 2) {
    overallAssessment = 'High Risk — Review Required';
    assessmentBadge = 'HIGH RISK — REVIEW REQUIRED';
    badgeType = 'danger';
    assessmentGuidance =
      'Multiple corroborating anomalies or physically impossible movement detected across gates. Immediate review or step-up verification required.';
  } else if (anomalyCount === 1) {
    overallAssessment = 'Elevated Risk';
    assessmentBadge = 'ELEVATED RISK';
    badgeType = 'warning';
    assessmentGuidance =
      'Single anomaly indicator detected. Rule: Review required before action. Never label as fraudulent based on a single isolated signal.';
  }

  // ----------------------------------------------------
  // 7. Integration Payload (JSON Contract)
  // ----------------------------------------------------
  const payload = {
    ip: testIp,
    device_id: sessionDeviceId,
    lat: currentLat,
    lon: currentLon,
    distance_km: distanceKm,
    velocity_kmh: velocityKmh,
    login_time: loginTime,
    is_off_hours: isOffHours,
    risk_flag: riskFlags[0],
    risk_flags: riskFlags,
    overall_assessment: overallAssessment,
    timestamp: Date.now(),
    simulated: true,
  };

  return {
    scenarioName,
    riderLabel,
    overallAssessment,
    assessmentBadge,
    badgeType,
    assessmentGuidance,
    riskFlags,
    simulated: true,

    // Compact Statuses
    summary: {
      riderName: `${baseRider.name} (${baseRider.riderId})`,
      gpsStatus: isGpsUnavailable
        ? 'Location Unavailable'
        : isImpossibleSpeed
        ? `Impossible Speed (${velocityKmh} km/h)`
        : `Verified Normal (${velocityKmh != null ? `${velocityKmh} km/h` : 'Nearby'})`,
      deviceStatus: isDeviceRecognised ? 'Recognized Hardware' : 'New / Unrecognized Hardware',
      sessionStatus: isOffHours ? 'Off-Hours Night Session' : 'Standard Daytime Shift',
      networkStatus: isNetworkUnavailable
        ? 'Network Offline'
        : networkChoice === 'different_ip'
        ? 'Datacenter / Foreign IP'
        : 'Domestic Mobile Carrier',
    },

    // Detailed Sections (Expandable)
    rider: {
      riderId: baseRider.riderId,
      name: baseRider.name,
      phoneNumber: baseRider.phoneNumber,
      registeredDeviceId: baseRider.registeredDeviceId,
      usualWorkingLocation: baseRider.usualWorkingLocation,
      usualLoginHours: baseRider.usualLoginHours,
      accountStatus: baseRider.accountStatus,
      knownDevices: baseRider.knownDevices,
      simulated: true,
    },
    gps: {
      riderId: baseRider.riderId,
      gpsStatus,
      isUnavailable: isGpsUnavailable,
      previousLocation,
      previousCoordinatesFormatted: formatCoordinates(previousLat, previousLon),
      previousLat,
      previousLon,
      currentLocation,
      currentCoordinatesFormatted: formatCoordinates(currentLat, currentLon),
      currentLat,
      currentLon,
      distanceKm,
      elapsedSeconds,
      elapsedTimeFormatted: formatElapsedTime(elapsedSeconds),
      velocityKmh,
      isImpossibleSpeed,
      simulated: true,
    },
    session: {
      sessionId: `SESS-${Date.now().toString().slice(-6)}`,
      riderId: baseRider.riderId,
      loginTime,
      loginTimestamp,
      loginLocation: currentLocation,
      deviceId: sessionDeviceId,
      isDeviceRecognised,
      timeClassification,
      sessionStatus,
      simulated: true,
    },
    network: {
      testIp,
      testIpLabel,
      networkStatus,
      connectionType,
      networkRiskStatus,
      simulated: true,
    },
    payload,
  };
}
