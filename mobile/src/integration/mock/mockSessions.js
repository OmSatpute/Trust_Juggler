/**
 * Mock Login and Session Data for Trust Juggler
 * Demonstrates session authentication, shift classification, device hardware recognition,
 * and multi-signal risk evaluations.
 * All IP addresses use RFC 5737 reserved documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
 */

export const MOCK_SESSION_SCENARIOS = [
  {
    id: 'normal_login',
    title: 'Normal Login',
    subtitle: 'Recognized mobile device during standard daytime shift hours',
    sessionId: 'SESS-2026-8801',
    riderId: 'RDR-8821',
    riderName: 'Alex "Swift" Vance',
    loginTimestamp: '2026-10-18 10:14:22 UTC',
    loginLocation: 'Downtown Hub Staging, San Francisco',
    deviceId: 'Apple_iPhone14,2_iOS_17.4',
    ipAddress: '198.51.100.42',
    ipLabel: '198.51.100.42 (TEST-NET-2 / Mobile Gateway)',
    loginTimeClassification: 'STANDARD_SHIFT (10:14 Daytime)',
    isDeviceRecognised: true,
    deviceRecognitionStatus: 'RECOGNIZED_KNOWN_DEVICE',
    sessionStatus: 'AUTHENTICATED',
    riskFlags: ['SESSION_VERIFIED'],
    riskLevel: 'LOW',
    details: 'Hardware fingerprint matches registered courier profile. Login time falls inside 08:00–18:00 window.',
    simulated: true,
  },
  {
    id: 'off_hours_login',
    title: 'Login Outside Usual Hours',
    subtitle: 'Legitimate device connecting during the 03:00 night window',
    sessionId: 'SESS-2026-8802',
    riderId: 'RDR-8821',
    riderName: 'Alex "Swift" Vance',
    loginTimestamp: '2026-10-18 03:22:45 UTC',
    loginLocation: 'Downtown Hub Staging, San Francisco',
    deviceId: 'Apple_iPhone14,2_iOS_17.4',
    ipAddress: '198.51.100.42',
    ipLabel: '198.51.100.42 (TEST-NET-2 / Mobile Gateway)',
    loginTimeClassification: 'OFF_HOURS_NIGHT_WINDOW (03:22 Local)',
    isDeviceRecognised: true,
    deviceRecognitionStatus: 'RECOGNIZED_KNOWN_DEVICE',
    sessionStatus: 'ANOMALY_FLAGGED',
    riskFlags: ['OFF_HOURS_LOGIN'],
    riskLevel: 'MEDIUM',
    details: 'Shift window alert: login outside regular 08:00–20:00 schedule. Device is trusted; flagged for administrative review, not immediate fraud.',
    simulated: true,
  },
  {
    id: 'unknown_device_login',
    title: 'Login from an Unknown Device',
    subtitle: 'Valid account credentials used on unfamiliar hardware',
    sessionId: 'SESS-2026-8803',
    riderId: 'RDR-8821',
    riderName: 'Alex "Swift" Vance',
    loginTimestamp: '2026-10-18 11:45:10 UTC',
    loginLocation: 'Downtown Hub Staging, San Francisco',
    deviceId: 'Xiaomi_Redmi-Note-12_Android_13',
    ipAddress: '198.51.100.89',
    ipLabel: '198.51.100.89 (TEST-NET-2 / Mobile Subnet)',
    loginTimeClassification: 'STANDARD_SHIFT (11:45 Daytime)',
    isDeviceRecognised: false,
    deviceRecognitionStatus: 'UNRECOGNIZED_NEW_HARDWARE',
    sessionStatus: 'CHALLENGE_REQUIRED',
    riskFlags: ['UNRECOGNIZED_DEVICE'],
    riskLevel: 'MEDIUM',
    details: 'New hardware fingerprint does not match known registered devices. MFA step-up challenge triggered.',
    simulated: true,
  },
  {
    id: 'suspicious_multi_risk',
    title: 'Suspicious Multi-Risk Login',
    subtitle: 'Compound anomalies: off-hours + unrecognized hardware + datacenter IP',
    sessionId: 'SESS-2026-8804',
    riderId: 'RDR-4409',
    riderName: 'Elena Rostova',
    loginTimestamp: '2026-10-18 02:48:19 UTC',
    loginLocation: 'Foreign Hosting Facility (Simulated Ashburn, VA)',
    deviceId: 'Generic_VirtualMachine_Linux_5.15',
    ipAddress: '203.0.113.199',
    ipLabel: '203.0.113.199 (TEST-NET-3 / DATACENTER_HOSTING)',
    loginTimeClassification: 'OFF_HOURS_NIGHT_WINDOW (02:48 Local)',
    isDeviceRecognised: false,
    deviceRecognitionStatus: 'UNRECOGNIZED_NEW_HARDWARE',
    sessionStatus: 'QUARANTINED_PENDING_AUDIT',
    riskFlags: [
      'OFF_HOURS_LOGIN',
      'UNRECOGNIZED_DEVICE',
      'DATACENTER_IP',
      'GEOGRAPHIC_MISMATCH',
    ],
    riskLevel: 'CRITICAL',
    details: 'Multiple concurrent risk indicators: login outside shift hours, completely unknown device ID, and ASN points to cloud server instead of mobile network.',
    simulated: true,
  },
];

/**
 * Retrieves a mock session scenario by ID or returns the first scenario.
 * @param {string} scenarioId
 */
export function getMockSessionScenario(scenarioId) {
  const scenario =
    MOCK_SESSION_SCENARIOS.find((s) => s.id === scenarioId) ||
    MOCK_SESSION_SCENARIOS[0];
  return scenario;
}

/**
 * Returns all mock session scenarios
 */
export function getSessionScenarios() {
  return MOCK_SESSION_SCENARIOS;
}
