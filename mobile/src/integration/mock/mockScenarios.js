/**
 * Complete End-to-End Mock Scenarios for Trust Juggler
 * Ties together Rider, GPS, Network, and Session telemetry for holistic review.
 * Calculates GPS distance and velocity on-the-fly using the Haversine formula.
 */

import {
  calculateHaversineDistance,
  calculateVelocityKmh,
  formatElapsedTime,
  formatCoordinates,
} from './geoUtils.js';
import { getMockRiderById } from './mockRiders.js';

export const MOCK_SCENARIOS = [
  {
    id: 'normal_rider',
    name: 'Normal Rider',
    badge: 'STAGE 1 PASSED',
    badgeType: 'success', // success | warning | danger
    summary: 'Standard physical delivery within shift hours on registered hardware and clean mobile network.',
    riderId: 'RDR-8821',
    gps: {
      previousLocation: 'Civic Center Logistics Hub, San Francisco',
      previousLat: 37.77928,
      previousLon: -122.41924,
      currentLocation: 'Downtown Market St Corridor, San Francisco',
      currentLat: 37.78912,
      currentLon: -122.40145,
      elapsedSeconds: 480, // 8 mins
      gpsStatus: 'SIMULATED_HIGH_PRECISION_FIX',
    },
    network: {
      testIp: '198.51.100.15',
      testIpLabel: '198.51.100.15 (TEST-NET-2 / Mobile Carrier)',
      networkStatus: 'TEST_ONLINE_VERIFIED',
      connectionType: 'Cellular 5G (Mobile ISP Gateway)',
      networkRiskStatus: 'LOW_RISK',
    },
    session: {
      sessionId: 'SESS-2026-9011',
      loginTime: '10:14:22',
      loginTimestamp: '2026-10-18 10:14:22 UTC',
      loginLocation: 'Downtown Market St Corridor, San Francisco',
      deviceId: 'Apple_iPhone14,2_iOS_17.4',
      isDeviceRecognised: true,
      timeClassification: 'STANDARD_SHIFT (10:14 Daytime)',
      sessionStatus: 'AUTHENTICATED',
    },
    riskFlags: ['STAGE_1_PASSED'],
    riskLevel: 'LOW',
    reviewGuidance: 'All telemetry metrics fall within standard operational baselines. No friction needed.',
  },
  {
    id: 'new_device_login',
    name: 'New Device Login',
    badge: 'UNFAMILIAR HARDWARE',
    badgeType: 'warning',
    summary: 'Courier logs in from a brand new device model. Movement and network are normal.',
    riderId: 'RDR-4409',
    gps: {
      previousLocation: '3rd & Howard Delivery Depot, San Francisco',
      previousLat: 37.78582,
      previousLon: -122.39991,
      currentLocation: '4th & Mission Retail Pickup, San Francisco',
      currentLat: 37.78423,
      currentLon: -122.40352,
      elapsedSeconds: 150, // 2.5 mins
      gpsStatus: 'SIMULATED_HIGH_PRECISION_FIX',
    },
    network: {
      testIp: '198.51.100.44',
      testIpLabel: '198.51.100.44 (TEST-NET-2 / Mobile Carrier)',
      networkStatus: 'TEST_ONLINE_VERIFIED',
      connectionType: 'Cellular 5G (Mobile ISP Gateway)',
      networkRiskStatus: 'LOW_RISK',
    },
    session: {
      sessionId: 'SESS-2026-9012',
      loginTime: '14:15:00',
      loginTimestamp: '2026-10-18 14:15:00 UTC',
      loginLocation: '4th & Mission Retail Pickup, San Francisco',
      deviceId: 'OnePlus_12_Android_14',
      isDeviceRecognised: false,
      timeClassification: 'STANDARD_SHIFT (14:15 Daytime)',
      sessionStatus: 'CHALLENGE_REQUIRED',
    },
    riskFlags: ['UNRECOGNIZED_DEVICE'],
    riskLevel: 'MEDIUM',
    reviewGuidance: 'Policy rule: Do not accuse of fraud based only on hardware change. Issue SMS/push 2FA challenge.',
  },
  {
    id: 'off_hours_login',
    name: 'Off-Hours Login',
    badge: 'SHIFT ANOMALY',
    badgeType: 'warning',
    summary: 'Courier initiates session at 03:22 AM outside the standard 08:00–20:00 working window.',
    riderId: 'RDR-1194',
    gps: {
      previousLocation: 'South Mission Logistics Staging',
      previousLat: 37.75921,
      previousLon: -122.41843,
      currentLocation: 'Valencia Corridor Delivery Hub',
      currentLat: 37.76452,
      currentLon: -122.42154,
      elapsedSeconds: 300, // 5 mins
      gpsStatus: 'SIMULATED_HIGH_PRECISION_FIX',
    },
    network: {
      testIp: '192.0.2.88',
      testIpLabel: '192.0.2.88 (TEST-NET-1 / Commercial Wi-Fi)',
      networkStatus: 'TEST_ONLINE_SHARED',
      connectionType: 'Public Wi-Fi (802.11ax Hotspot)',
      networkRiskStatus: 'MODERATE_RISK_SHARED_NAT',
    },
    session: {
      sessionId: 'SESS-2026-9013',
      loginTime: '03:22:45',
      loginTimestamp: '2026-10-18 03:22:45 UTC',
      loginLocation: 'Valencia Corridor Delivery Hub',
      deviceId: 'Google_Pixel-8-Pro_Android_14',
      isDeviceRecognised: true,
      timeClassification: 'OFF_HOURS_NIGHT_WINDOW (03:22 Local)',
      sessionStatus: 'ANOMALY_FLAGGED',
    },
    riskFlags: ['OFF_HOURS_LOGIN'],
    riskLevel: 'MEDIUM',
    reviewGuidance: 'Known courier hardware. Late night session is an operational anomaly, not definitive fraud.',
  },
  {
    id: 'impossible_travel',
    name: 'Impossible Travel',
    badge: 'CRITICAL ALERT',
    badgeType: 'danger',
    summary: 'GPS position teleports ~25.5 km in 2 minutes, exceeding physical ground velocity limits.',
    riderId: 'RDR-8821',
    gps: {
      previousLocation: 'Civic Center Logistics Hub, San Francisco',
      previousLat: 37.77928,
      previousLon: -122.41924,
      currentLocation: 'San Leandro East Bay Distribution Center',
      currentLat: 37.69170,
      currentLon: -122.15750,
      elapsedSeconds: 120, // 2 mins
      gpsStatus: 'SIMULATED_HIGH_PRECISION_FIX',
    },
    network: {
      testIp: '198.51.100.15',
      testIpLabel: '198.51.100.15 (TEST-NET-2 / Mobile Carrier)',
      networkStatus: 'TEST_ONLINE_VERIFIED',
      connectionType: 'Cellular 5G (Mobile ISP Gateway)',
      networkRiskStatus: 'LOW_RISK',
    },
    session: {
      sessionId: 'SESS-2026-9014',
      loginTime: '11:30:15',
      loginTimestamp: '2026-10-18 11:30:15 UTC',
      loginLocation: 'Hayward Regional Logistics Center (East Bay)',
      deviceId: 'Apple_iPhone14,2_iOS_17.4',
      isDeviceRecognised: true,
      timeClassification: 'STANDARD_SHIFT (11:30 Daytime)',
      sessionStatus: 'ALERT_TRIGGERED',
    },
    riskFlags: ['IMPOSSIBLE_TRAVEL'],
    riskLevel: 'CRITICAL',
    reviewGuidance: 'Physical impossibility: speed >120 km/h threshold indicates location spoofing or account credential sharing.',
  },
  {
    id: 'multiple_suspicious_signals',
    name: 'Multiple Suspicious Signals',
    badge: 'COMPOUND THREAT',
    badgeType: 'danger',
    summary: 'High-confidence anomaly: teleport GPS + 02:48 AM login + unknown VM device + datacenter proxy IP.',
    riderId: 'RDR-4409',
    gps: {
      previousLocation: 'Downtown Market St Corridor, San Francisco',
      previousLat: 37.78912,
      previousLon: -122.40145,
      currentLocation: 'Oakland East Bay Industrial Cluster',
      // ~26.4 km displacement
      currentLat: 37.80436,
      currentLon: -122.27111,
      elapsedSeconds: 90, // 1.5 mins
      gpsStatus: 'SIMULATED_HIGH_PRECISION_FIX',
    },
    network: {
      testIp: '203.0.113.54',
      testIpLabel: '203.0.113.54 (TEST-NET-3 / Hosting VPS Datacenter)',
      networkStatus: 'TEST_ONLINE_DATACENTER',
      connectionType: 'Hosting Datacenter IP (Colocation / VPS)',
      networkRiskStatus: 'ELEVATED_RISK_HOSTING_ASN',
    },
    session: {
      sessionId: 'SESS-2026-9015',
      loginTime: '02:48:19',
      loginTimestamp: '2026-10-18 02:48:19 UTC',
      loginLocation: 'Foreign Datacenter Node (Simulated Ashburn)',
      deviceId: 'Generic_VirtualMachine_Linux_5.15',
      isDeviceRecognised: false,
      timeClassification: 'OFF_HOURS_NIGHT_WINDOW (02:48 Local)',
      sessionStatus: 'QUARANTINED_PENDING_AUDIT',
    },
    riskFlags: [
      'IMPOSSIBLE_TRAVEL',
      'OFF_HOURS_LOGIN',
      'UNRECOGNIZED_DEVICE',
      'DATACENTER_IP',
    ],
    riskLevel: 'CRITICAL',
    reviewGuidance: 'Compound multi-gate alert: Corroboration across GPS, hardware, shift, and network gates signals automated credential stuffing.',
  },
];

/**
 * Returns complete calculated scenario object with dynamic Haversine metrics.
 * @param {string} scenarioId
 */
export function getComputedScenario(scenarioId) {
  const scenario =
    MOCK_SCENARIOS.find((s) => s.id === scenarioId) || MOCK_SCENARIOS[0];

  const rider = getMockRiderById(scenario.riderId);

  // Dynamic Haversine distance calculation (NOT hardcoded)
  const distanceKm = calculateHaversineDistance(
    scenario.gps.previousLat,
    scenario.gps.previousLon,
    scenario.gps.currentLat,
    scenario.gps.currentLon
  );

  // Dynamic velocity calculation
  const velocityKmh = calculateVelocityKmh(
    distanceKm,
    scenario.gps.elapsedSeconds
  );

  const isSuspiciousGps = velocityKmh != null && velocityKmh > 120;

  return {
    id: scenario.id,
    name: scenario.name,
    badge: scenario.badge,
    badgeType: scenario.badgeType,
    summary: scenario.summary,
    riskLevel: scenario.riskLevel,
    riskFlags: scenario.riskFlags,
    reviewGuidance: scenario.reviewGuidance,
    simulated: true,

    // Rider telemetry section
    rider: {
      riderId: rider.riderId,
      name: rider.name,
      phoneNumber: rider.phoneNumber,
      registeredDeviceId: rider.registeredDeviceId,
      usualWorkingLocation: rider.usualWorkingLocation,
      usualLoginHours: rider.usualLoginHours,
      accountStatus: rider.accountStatus,
      knownDevices: rider.knownDevices,
      simulated: true,
    },

    // GPS telemetry section (dynamically calculated)
    gps: {
      riderId: scenario.riderId,
      currentLat: scenario.gps.currentLat,
      currentLon: scenario.gps.currentLon,
      currentCoordinatesFormatted: formatCoordinates(
        scenario.gps.currentLat,
        scenario.gps.currentLon
      ),
      currentLocationName: scenario.gps.currentLocation,
      previousLat: scenario.gps.previousLat,
      previousLon: scenario.gps.previousLon,
      previousCoordinatesFormatted: formatCoordinates(
        scenario.gps.previousLat,
        scenario.gps.previousLon
      ),
      previousLocationName: scenario.gps.previousLocation,
      distanceKm: distanceKm != null ? distanceKm : 0,
      elapsedSeconds: scenario.gps.elapsedSeconds,
      elapsedTimeFormatted: formatElapsedTime(scenario.gps.elapsedSeconds),
      velocityKmh: velocityKmh != null ? velocityKmh : 0,
      gpsStatus: scenario.gps.gpsStatus,
      isSuspicious: isSuspiciousGps,
      movementAssessment: isSuspiciousGps
        ? '🚨 Suspicious: Velocity exceeds 120 km/h physical courier threshold'
        : '✅ Normal: Velocity is within human physical/vehicular boundaries',
      simulated: true,
    },

    // Network telemetry section
    network: {
      testIpAddress: scenario.network.testIp,
      testIpLabel: scenario.network.testIpLabel,
      networkStatus: scenario.network.networkStatus,
      connectionType: scenario.network.connectionType,
      networkRiskStatus: scenario.network.networkRiskStatus,
      simulated: true,
    },

    // Session telemetry section
    session: {
      sessionId: scenario.session.sessionId,
      riderId: scenario.riderId,
      loginTimestamp: scenario.session.loginTimestamp,
      loginTime: scenario.session.loginTime,
      loginLocation: scenario.session.loginLocation,
      deviceId: scenario.session.deviceId,
      testIpAddress: scenario.network.testIpLabel,
      loginTimeClassification: scenario.session.timeClassification,
      isDeviceRecognised: scenario.session.isDeviceRecognised,
      sessionStatus: scenario.session.sessionStatus,
      simulated: true,
    },
  };
}

/**
 * Returns all scenarios list
 */
export function getScenariosList() {
  return MOCK_SCENARIOS;
}
