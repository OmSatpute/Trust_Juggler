/**
 * Fictional Rider Profiles for Trust Juggler
 * All names, phone numbers, device IDs, and locations are strictly fictional/simulated.
 * Conforms to RFC 555 fictional telephony series.
 */

export const MOCK_RIDERS = [
  {
    riderId: 'RDR-8821',
    name: 'Alex "Swift" Vance',
    phoneNumber: '+1-555-0142',
    registeredDeviceId: 'Apple_iPhone14,2_iOS_17.4',
    usualWorkingLocation: 'Downtown Metro Zone (Central Sector 4)',
    usualLoginHours: '08:00 – 18:00 (Standard Day Shift)',
    accountStatus: 'VERIFIED_ACTIVE',
    knownDevices: [
      'Apple_iPhone14,2_iOS_17.4',
      'Apple_iPad13,1_iOS_17.1',
    ],
    tier: 'Senior Courier',
    rating: 4.94,
    notes: 'Consistent route adherence. Primary carrier is domestic 5G.',
    simulated: true,
  },
  {
    riderId: 'RDR-4409',
    name: 'Elena Rostova',
    phoneNumber: '+1-555-0187',
    registeredDeviceId: 'Samsung_SM-G998B_Android_14',
    usualWorkingLocation: 'North Waterfront & Financial District',
    usualLoginHours: '09:00 – 20:00 (Extended Day Shift)',
    accountStatus: 'VERIFIED_ACTIVE',
    knownDevices: [
      'Samsung_SM-G998B_Android_14',
    ],
    tier: 'Express Logistics Courier',
    rating: 4.88,
    notes: 'Operates high-density urban routes. Single registered device.',
    simulated: true,
  },
  {
    riderId: 'RDR-1194',
    name: 'Marcus Chen',
    phoneNumber: '+1-555-0199',
    registeredDeviceId: 'Google_Pixel-8-Pro_Android_14',
    usualWorkingLocation: 'South Mission & Airport Logistics Hub',
    usualLoginHours: '07:00 – 16:00 (Early Morning Shift)',
    accountStatus: 'FLAGGED_FOR_REVIEW',
    knownDevices: [
      'Google_Pixel-8-Pro_Android_14',
      'Google_Pixel-6a_Android_13',
    ],
    tier: 'Logistics Specialist',
    rating: 4.65,
    notes: 'Periodic shift variations reported. Multi-device fleet profile.',
    simulated: true,
  },
];

/**
 * Returns all fictional rider profiles
 */
export function getMockRiders() {
  return MOCK_RIDERS;
}

/**
 * Retrieves a fictional rider by ID or defaults to first rider
 * @param {string} id
 */
export function getMockRiderById(id) {
  const rider = MOCK_RIDERS.find((r) => r.riderId === id);
  return rider || MOCK_RIDERS[0];
}
