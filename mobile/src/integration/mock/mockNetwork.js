/**
 * Mock Network Intelligence Datasets for Trust Juggler
 * Uses reserved documentation/test IP addresses according to RFC 5737.
 * Explicitly separates simulated network profiles from user hardware interfaces.
 */

export const MOCK_NETWORK_PRESETS = [
  {
    id: 'cellular_5g',
    title: 'Domestic 5G Mobile Carrier',
    subtitle: 'Standard clean mobile broadband assigned to courier SIM',
    testIpAddress: '198.51.100.15',
    testIpLabel: '198.51.100.15 (RFC 5737 / TEST-NET-2)',
    networkStatus: 'TEST_ONLINE_VERIFIED',
    connectionType: 'Cellular 5G (Mobile ISP Gateway)',
    networkRiskStatus: 'LOW_RISK',
    asnInfo: 'AS64512 (Simulated Telecom Mobile Network)',
    ispCategory: 'Mobile Wireless Carrier',
    vpnProxyDetected: false,
    torRelayDetected: false,
    riskSignals: ['CARRIER_IP_CLEAN'],
    notes: 'Clean domestic carrier allocation. Latency and jitter conform to mobile standard.',
    simulated: true,
  },
  {
    id: 'public_wifi',
    title: 'Public Commercial Wi-Fi',
    subtitle: 'Coffee shop / commercial center hotspot with shared NAT',
    testIpAddress: '192.0.2.88',
    testIpLabel: '192.0.2.88 (RFC 5737 / TEST-NET-1)',
    networkStatus: 'TEST_ONLINE_SHARED',
    connectionType: 'Public Wi-Fi (802.11ax Commercial Hotspot)',
    networkRiskStatus: 'MODERATE_RISK_SHARED_NAT',
    asnInfo: 'AS64513 (Simulated Commercial Broadband)',
    ispCategory: 'Commercial Wi-Fi Operator',
    vpnProxyDetected: false,
    torRelayDetected: false,
    riskSignals: ['SHARED_PUBLIC_GATEWAY', 'HIGH_DEVICE_DENSITY'],
    notes: 'Multiple concurrent devices share this gateway. Normal for couriers during break periods.',
    simulated: true,
  },
  {
    id: 'datacenter_proxy',
    title: 'Commercial Datacenter / Cloud Proxy',
    subtitle: 'Traffic routed through a cloud VPS or automated server center',
    testIpAddress: '203.0.113.54',
    testIpLabel: '203.0.113.54 (RFC 5737 / TEST-NET-3)',
    networkStatus: 'TEST_ONLINE_DATACENTER',
    connectionType: 'Hosting Datacenter IP (Colocation / VPS)',
    networkRiskStatus: 'ELEVATED_RISK_HOSTING_ASN',
    asnInfo: 'AS64514 (Simulated Cloud Infrastructure Corp)',
    ispCategory: 'Cloud Hosting / Colocation Facility',
    vpnProxyDetected: true,
    torRelayDetected: false,
    riskSignals: ['DATACENTER_ASN_DETECTED', 'NON_RESIDENTIAL_IP'],
    notes: 'Autonomous systems data shows this IP belongs to a server hosting provider, not a mobile telephone.',
    simulated: true,
  },
  {
    id: 'anonymized_relay',
    title: 'Anonymized Onion / VPN Relay',
    subtitle: 'Encrypted tunnel hiding geographic origin and hardware trace',
    testIpAddress: '198.51.100.210',
    testIpLabel: '198.51.100.210 (RFC 5737 / TEST-NET-2)',
    networkStatus: 'TEST_ONLINE_RELAY',
    connectionType: 'Anonymized VPN / Multi-Hop Tunnel',
    networkRiskStatus: 'HIGH_RISK_ANONYMIZED_TRAFFIC',
    asnInfo: 'AS64515 (Simulated Privacy Network Exit)',
    ispCategory: 'Anonymizing Proxy Network',
    vpnProxyDetected: true,
    torRelayDetected: true,
    riskSignals: ['KNOWN_EXIT_NODE', 'GEOIP_SPOOFING_SUSPECT', 'ANONYMIZING_TUNNEL'],
    notes: 'High anomaly signature: active exit node directory match. Immediate step-up verification indicated.',
    simulated: true,
  },
  {
    id: 'network_unavailable',
    title: 'Network Unavailable (Offline)',
    subtitle: 'Simulated connection failure or airplane mode',
    testIpAddress: null,
    testIpLabel: 'Unavailable (Offline)',
    networkStatus: 'NETWORK_UNAVAILABLE',
    connectionType: 'None (Device Offline)',
    networkRiskStatus: 'NETWORK_UNAVAILABLE',
    asnInfo: 'N/A',
    ispCategory: 'None',
    vpnProxyDetected: false,
    torRelayDetected: false,
    riskSignals: ['NETWORK_UNAVAILABLE'],
    notes: 'Simulated network disconnection. Device cannot resolve gateway IP address.',
    simulated: true,
  },
];

/**
 * Retrieves mock network data by preset ID or returns first preset.
 * @param {string} presetId
 */
export function getMockNetworkData(presetId) {
  const preset =
    MOCK_NETWORK_PRESETS.find((p) => p.id === presetId) ||
    MOCK_NETWORK_PRESETS[0];
  return preset;
}

/**
 * Returns all network presets
 */
export function getNetworkPresets() {
  return MOCK_NETWORK_PRESETS;
}
