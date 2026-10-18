/**
 * Geospatial and Physics Calculation Utilities for Trust Juggler
 * Handles Haversine great-circle distance and velocity calculations.
 */

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
  if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) return 0;
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
  return Number((R * c).toFixed(3));
}

/**
 * Calculates travel velocity in kilometers per hour.
 * @param {number|null} distanceKm - Distance travelled in km
 * @param {number|null} elapsedSeconds - Time elapsed in seconds
 * @returns {number|null} Velocity in km/h or null if calculation is not possible
 */
export function calculateVelocityKmh(distanceKm, elapsedSeconds) {
  if (distanceKm == null || elapsedSeconds == null || elapsedSeconds <= 0) {
    return null;
  }
  if (isNaN(distanceKm) || isNaN(elapsedSeconds)) {
    return null;
  }
  const hours = elapsedSeconds / 3600;
  const velocity = distanceKm / hours;
  return Number(velocity.toFixed(2));
}

/**
 * Formats elapsed seconds into human readable string.
 * @param {number|null} sec - Seconds
 * @returns {string} e.g. "2m 00s (120s)"
 */
export function formatElapsedTime(sec) {
  if (sec == null || isNaN(sec)) return 'N/A';
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${mins}m ${rem < 10 ? '0' : ''}${rem}s (${sec}s)`;
}

/**
 * Safe coordinate formatting
 * @param {number|null} lat
 * @param {number|null} lon
 * @returns {string}
 */
export function formatCoordinates(lat, lon) {
  if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return 'N/A';
  return `${Number(lat).toFixed(5)}°, ${Number(lon).toFixed(5)}°`;
}
