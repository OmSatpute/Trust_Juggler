/**
 * Mock GPS & Location Telemetry Datasets for Trust Juggler
 * Computes Haversine distance and travel velocity dynamically without hardcoded results.
 * Clearly labels all coordinates and fixes as SIMULATED.
 */

import {
  calculateHaversineDistance,
  calculateVelocityKmh,
  formatElapsedTime,
  formatCoordinates,
} from './geoUtils.js';

export const MOCK_GPS_SCENARIOS = [
  {
    id: 'normal_movement',
    title: 'Normal GPS Movement',
    subtitle: 'Standard bicycle/scooter courier pace across urban grid',
    riderId: 'RDR-8821',
    previousLocationName: 'Civic Center Logistics Hub, San Francisco',
    previousLat: 37.77928,
    previousLon: -122.41924,
    currentLocationName: 'Downtown Market St Corridor, San Francisco',
    currentLat: 37.78912,
    currentLon: -122.40145,
    elapsedSeconds: 480, // 8 minutes
    gpsStatus: 'SIMULATED_HIGH_PRECISION_FIX',
    simulated: true,
  },
  {
    id: 'nearby_movement',
    title: 'Rider Moving Nearby',
    subtitle: 'Short pedestrian or staging hop between adjacent delivery blocks',
    riderId: 'RDR-4409',
    previousLocationName: '3rd & Howard Delivery Depot, San Francisco',
    previousLat: 37.78582,
    previousLon: -122.39991,
    currentLocationName: '4th & Mission Retail Pickup, San Francisco',
    currentLat: 37.78423,
    currentLon: -122.40352,
    elapsedSeconds: 150, // 2.5 minutes
    gpsStatus: 'SIMULATED_HIGH_PRECISION_FIX',
    simulated: true,
  },
  {
    id: 'impossible_travel',
    title: 'Impossible Travel (Teleport +25km)',
    subtitle: 'Sudden displacement across the bay with superhuman implied velocity',
    riderId: 'RDR-8821',
    previousLocationName: 'Civic Center Logistics Hub, San Francisco',
    previousLat: 37.77928,
    previousLon: -122.41924,
    currentLocationName: 'San Leandro East Bay Distribution Center',
    // Exactly ~25.0 km away from SF Civic Center
    currentLat: 37.69170,
    currentLon: -122.15750,
    elapsedSeconds: 120, // 2 minutes
    gpsStatus: 'SIMULATED_HIGH_PRECISION_FIX',
    simulated: true,
  },
  {
    id: 'gps_unavailable',
    title: 'GPS Unavailable',
    subtitle: 'Location sensor disabled, hardware offline or permission denied',
    riderId: 'RDR-8821',
    previousLocationName: 'N/A',
    previousLat: null,
    previousLon: null,
    currentLocationName: 'Location Unavailable (Offline)',
    currentLat: null,
    currentLon: null,
    elapsedSeconds: null,
    gpsStatus: 'LOCATION_UNAVAILABLE',
    simulated: true,
  },
];

/**
 * Computes dynamic distance and velocity for a mock GPS scenario using the Haversine formula.
 * @param {string} scenarioId
 */
export function getComputedGpsScenario(scenarioId) {
  const scenario =
    MOCK_GPS_SCENARIOS.find((s) => s.id === scenarioId) ||
    MOCK_GPS_SCENARIOS[0];

  const isUnavailable = scenario.currentLat == null || scenario.previousLat == null;

  // Dynamic Haversine distance calculation (NOT hardcoded)
  const distanceKm = !isUnavailable
    ? calculateHaversineDistance(
        scenario.previousLat,
        scenario.previousLon,
        scenario.currentLat,
        scenario.currentLon
      )
    : null;

  // Dynamic velocity calculation (km/h) based on actual distance and elapsed seconds
  const velocityKmh = !isUnavailable
    ? calculateVelocityKmh(distanceKm, scenario.elapsedSeconds)
    : null;

  // Threshold evaluation: >120 km/h is flagged as physically impossible for ground courier
  const isSuspicious = velocityKmh != null && velocityKmh > 120;

  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    scenarioSubtitle: scenario.subtitle,
    riderId: scenario.riderId,
    isUnavailable,
    // Current coordinate & location
    currentLat: scenario.currentLat,
    currentLon: scenario.currentLon,
    currentCoordinatesFormatted: formatCoordinates(scenario.currentLat, scenario.currentLon),
    currentLocationName: scenario.currentLocationName,
    // Previous coordinate & location
    previousLat: scenario.previousLat,
    previousLon: scenario.previousLon,
    previousCoordinatesFormatted: formatCoordinates(scenario.previousLat, scenario.previousLon),
    previousLocationName: scenario.previousLocationName,
    // Calculated physics metrics (null when unavailable)
    distanceKm,
    elapsedSeconds: scenario.elapsedSeconds,
    elapsedTimeFormatted: scenario.elapsedSeconds != null ? formatElapsedTime(scenario.elapsedSeconds) : 'N/A',
    velocityKmh,
    // Evaluation flags
    gpsStatus: scenario.gpsStatus,
    isSuspicious,
    movementStatus: isUnavailable
      ? 'LOCATION_UNAVAILABLE'
      : isSuspicious
      ? 'SUSPICIOUS_IMPOSSIBLE_TRAVEL'
      : 'NORMAL_PHYSICAL_MOVEMENT',
    movementAssessment: isUnavailable
      ? '⚠️ Location Telemetry Unavailable: GPS sensor or permissions offline.'
      : isSuspicious
      ? '🚨 Suspicious: Implied velocity exceeds 120 km/h physical courier threshold'
      : '✅ Normal: Velocity is well within physical courier/urban limits',
    simulated: true,
    coordinateLabel: 'SIMULATED COORDINATES (TEST FIX)',
  };
}

/**
 * Returns all raw GPS scenarios
 */
export function getGpsScenarios() {
  return MOCK_GPS_SCENARIOS;
}
