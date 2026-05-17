/**
 * Major international airports for cargo/courier routing.
 * Mirrors the structure of MAJOR_PORTS in lib/routing/ — hardcoded so we don't
 * pay a network call per shipment.
 *
 * Coverage philosophy: top 1-3 international (passenger + cargo) hubs per
 * country that realistically appears in import/export demos. IATA 3-letter
 * codes, lat/lon verified against airport databases.
 */

export interface AirportCoord {
  iata: string;
  name: string;
  city: string;
  country: string; // ISO-2
  lat: number;
  lon: number;
}

// Per-country airports, ordered by typical cargo throughput (first = preferred).
export const MAJOR_AIRPORTS: Record<string, AirportCoord[]> = {
  // North America
  US: [
    { iata: "LAX", name: "Los Angeles International", city: "Los Angeles", country: "US", lat: 33.9425, lon: -118.4081 },
    { iata: "JFK", name: "John F. Kennedy International", city: "New York", country: "US", lat: 40.6413, lon: -73.7781 },
    { iata: "ORD", name: "Chicago O'Hare International", city: "Chicago", country: "US", lat: 41.9742, lon: -87.9073 },
    { iata: "MIA", name: "Miami International", city: "Miami", country: "US", lat: 25.7959, lon: -80.2870 },
    { iata: "SFO", name: "San Francisco International", city: "San Francisco", country: "US", lat: 37.6213, lon: -122.3790 },
    { iata: "ATL", name: "Hartsfield-Jackson Atlanta", city: "Atlanta", country: "US", lat: 33.6407, lon: -84.4277 },
    { iata: "DFW", name: "Dallas/Fort Worth", city: "Dallas", country: "US", lat: 32.8998, lon: -97.0403 },
    { iata: "SEA", name: "Seattle-Tacoma International", city: "Seattle", country: "US", lat: 47.4502, lon: -122.3088 },
    { iata: "BOS", name: "Boston Logan International", city: "Boston", country: "US", lat: 42.3656, lon: -71.0096 },
    { iata: "IAH", name: "George Bush Houston Intl", city: "Houston", country: "US", lat: 29.9902, lon: -95.3368 },
  ],
  CA: [
    { iata: "YYZ", name: "Toronto Pearson International", city: "Toronto", country: "CA", lat: 43.6777, lon: -79.6248 },
    { iata: "YVR", name: "Vancouver International", city: "Vancouver", country: "CA", lat: 49.1939, lon: -123.1844 },
  ],
  MX: [
    { iata: "MEX", name: "Mexico City International", city: "Mexico City", country: "MX", lat: 19.4361, lon: -99.0719 },
    { iata: "GDL", name: "Guadalajara International", city: "Guadalajara", country: "MX", lat: 20.5235, lon: -103.3105 },
  ],

  // Asia
  CN: [
    { iata: "PVG", name: "Shanghai Pudong International", city: "Shanghai", country: "CN", lat: 31.1443, lon: 121.8083 },
    { iata: "PEK", name: "Beijing Capital International", city: "Beijing", country: "CN", lat: 40.0799, lon: 116.6031 },
    { iata: "CAN", name: "Guangzhou Baiyun International", city: "Guangzhou", country: "CN", lat: 23.3924, lon: 113.2988 },
    { iata: "SZX", name: "Shenzhen Bao'an International", city: "Shenzhen", country: "CN", lat: 22.6393, lon: 113.8108 },
    { iata: "HKG", name: "Hong Kong International", city: "Hong Kong", country: "HK", lat: 22.3080, lon: 113.9185 },
  ],
  HK: [
    { iata: "HKG", name: "Hong Kong International", city: "Hong Kong", country: "HK", lat: 22.3080, lon: 113.9185 },
  ],
  JP: [
    { iata: "NRT", name: "Narita International", city: "Tokyo", country: "JP", lat: 35.7720, lon: 140.3929 },
    { iata: "HND", name: "Tokyo Haneda", city: "Tokyo", country: "JP", lat: 35.5494, lon: 139.7798 },
    { iata: "KIX", name: "Kansai International", city: "Osaka", country: "JP", lat: 34.4347, lon: 135.2440 },
  ],
  KR: [
    { iata: "ICN", name: "Incheon International", city: "Seoul", country: "KR", lat: 37.4602, lon: 126.4407 },
    { iata: "PUS", name: "Gimhae International", city: "Busan", country: "KR", lat: 35.1795, lon: 128.9382 },
  ],
  TW: [
    { iata: "TPE", name: "Taoyuan International", city: "Taipei", country: "TW", lat: 25.0797, lon: 121.2342 },
  ],
  VN: [
    { iata: "SGN", name: "Tan Son Nhat International", city: "Ho Chi Minh City", country: "VN", lat: 10.8188, lon: 106.6520 },
    { iata: "HAN", name: "Noi Bai International", city: "Hanoi", country: "VN", lat: 21.2212, lon: 105.8072 },
  ],
  TH: [
    { iata: "BKK", name: "Suvarnabhumi", city: "Bangkok", country: "TH", lat: 13.6900, lon: 100.7501 },
  ],
  ID: [
    { iata: "CGK", name: "Soekarno-Hatta International", city: "Jakarta", country: "ID", lat: -6.1256, lon: 106.6558 },
    { iata: "DPS", name: "Ngurah Rai International", city: "Denpasar", country: "ID", lat: -8.7482, lon: 115.1672 },
  ],
  PH: [
    { iata: "MNL", name: "Ninoy Aquino International", city: "Manila", country: "PH", lat: 14.5086, lon: 121.0194 },
  ],
  MY: [
    { iata: "KUL", name: "Kuala Lumpur International", city: "Kuala Lumpur", country: "MY", lat: 2.7456, lon: 101.7099 },
  ],
  SG: [
    { iata: "SIN", name: "Singapore Changi", city: "Singapore", country: "SG", lat: 1.3644, lon: 103.9915 },
  ],
  IN: [
    { iata: "DEL", name: "Indira Gandhi International", city: "Delhi", country: "IN", lat: 28.5562, lon: 77.1000 },
    { iata: "BOM", name: "Chhatrapati Shivaji Maharaj Intl", city: "Mumbai", country: "IN", lat: 19.0896, lon: 72.8656 },
    { iata: "BLR", name: "Kempegowda International", city: "Bangalore", country: "IN", lat: 13.1989, lon: 77.7068 },
    { iata: "MAA", name: "Chennai International", city: "Chennai", country: "IN", lat: 12.9941, lon: 80.1709 },
  ],
  PK: [
    { iata: "KHI", name: "Jinnah International", city: "Karachi", country: "PK", lat: 24.9008, lon: 67.1681 },
  ],
  BD: [
    { iata: "DAC", name: "Hazrat Shahjalal International", city: "Dhaka", country: "BD", lat: 23.8431, lon: 90.3978 },
  ],
  LK: [
    { iata: "CMB", name: "Bandaranaike International", city: "Colombo", country: "LK", lat: 7.1808, lon: 79.8842 },
  ],
  KH: [
    { iata: "PNH", name: "Phnom Penh International", city: "Phnom Penh", country: "KH", lat: 11.5466, lon: 104.8444 },
  ],

  // Middle East / Africa
  TR: [
    { iata: "IST", name: "Istanbul Airport", city: "Istanbul", country: "TR", lat: 41.2753, lon: 28.7519 },
  ],
  AE: [
    { iata: "DXB", name: "Dubai International", city: "Dubai", country: "AE", lat: 25.2532, lon: 55.3657 },
    { iata: "AUH", name: "Abu Dhabi International", city: "Abu Dhabi", country: "AE", lat: 24.4330, lon: 54.6511 },
  ],
  EG: [
    { iata: "CAI", name: "Cairo International", city: "Cairo", country: "EG", lat: 30.1219, lon: 31.4056 },
  ],
  MA: [
    { iata: "CMN", name: "Mohammed V International", city: "Casablanca", country: "MA", lat: 33.3675, lon: -7.5898 },
  ],
  ZA: [
    { iata: "JNB", name: "OR Tambo International", city: "Johannesburg", country: "ZA", lat: -26.1392, lon: 28.2460 },
    { iata: "CPT", name: "Cape Town International", city: "Cape Town", country: "ZA", lat: -33.9648, lon: 18.6017 },
  ],
  KE: [
    { iata: "NBO", name: "Jomo Kenyatta International", city: "Nairobi", country: "KE", lat: -1.3192, lon: 36.9275 },
  ],
  ET: [
    { iata: "ADD", name: "Bole International", city: "Addis Ababa", country: "ET", lat: 8.9779, lon: 38.7993 },
  ],
  NG: [
    { iata: "LOS", name: "Murtala Muhammed International", city: "Lagos", country: "NG", lat: 6.5774, lon: 3.3215 },
  ],
  MG: [
    { iata: "TNR", name: "Ivato International", city: "Antananarivo", country: "MG", lat: -18.7969, lon: 47.4788 },
  ],

  // Europe
  DE: [
    { iata: "FRA", name: "Frankfurt am Main", city: "Frankfurt", country: "DE", lat: 50.0379, lon: 8.5622 },
    { iata: "MUC", name: "Munich International", city: "Munich", country: "DE", lat: 48.3537, lon: 11.7750 },
    { iata: "HAM", name: "Hamburg Airport", city: "Hamburg", country: "DE", lat: 53.6304, lon: 9.9882 },
  ],
  GB: [
    { iata: "LHR", name: "London Heathrow", city: "London", country: "GB", lat: 51.4700, lon: -0.4543 },
    { iata: "LGW", name: "London Gatwick", city: "London", country: "GB", lat: 51.1537, lon: -0.1821 },
  ],
  FR: [
    { iata: "CDG", name: "Charles de Gaulle", city: "Paris", country: "FR", lat: 49.0097, lon: 2.5479 },
  ],
  IT: [
    { iata: "MXP", name: "Milan Malpensa", city: "Milan", country: "IT", lat: 45.6306, lon: 8.7281 },
    { iata: "FCO", name: "Leonardo da Vinci–Fiumicino", city: "Rome", country: "IT", lat: 41.7999, lon: 12.2462 },
  ],
  ES: [
    { iata: "MAD", name: "Adolfo Suárez Madrid-Barajas", city: "Madrid", country: "ES", lat: 40.4983, lon: -3.5676 },
    { iata: "BCN", name: "Barcelona-El Prat", city: "Barcelona", country: "ES", lat: 41.2974, lon: 2.0833 },
  ],
  NL: [
    { iata: "AMS", name: "Amsterdam Schiphol", city: "Amsterdam", country: "NL", lat: 52.3105, lon: 4.7683 },
  ],
  BE: [
    { iata: "BRU", name: "Brussels Airport", city: "Brussels", country: "BE", lat: 50.9014, lon: 4.4844 },
  ],
  PT: [
    { iata: "LIS", name: "Lisbon Airport", city: "Lisbon", country: "PT", lat: 38.7813, lon: -9.1359 },
  ],
  GR: [
    { iata: "ATH", name: "Athens International", city: "Athens", country: "GR", lat: 37.9364, lon: 23.9445 },
  ],
  PL: [
    { iata: "WAW", name: "Warsaw Chopin", city: "Warsaw", country: "PL", lat: 52.1657, lon: 20.9671 },
  ],
  UA: [
    { iata: "KBP", name: "Boryspil International", city: "Kyiv", country: "UA", lat: 50.3450, lon: 30.8947 },
  ],
  RO: [
    { iata: "OTP", name: "Henri Coandă International", city: "Bucharest", country: "RO", lat: 44.5722, lon: 26.1022 },
  ],

  // Americas (south)
  BR: [
    { iata: "GRU", name: "São Paulo–Guarulhos International", city: "São Paulo", country: "BR", lat: -23.4356, lon: -46.4731 },
    { iata: "GIG", name: "Rio de Janeiro–Galeão", city: "Rio de Janeiro", country: "BR", lat: -22.8090, lon: -43.2506 },
  ],
  CL: [
    { iata: "SCL", name: "Arturo Merino Benítez", city: "Santiago", country: "CL", lat: -33.3927, lon: -70.7858 },
  ],
  AR: [
    { iata: "EZE", name: "Ministro Pistarini (Ezeiza)", city: "Buenos Aires", country: "AR", lat: -34.8222, lon: -58.5358 },
  ],
  PE: [
    { iata: "LIM", name: "Jorge Chávez International", city: "Lima", country: "PE", lat: -12.0219, lon: -77.1143 },
  ],
  CO: [
    { iata: "BOG", name: "El Dorado International", city: "Bogotá", country: "CO", lat: 4.7016, lon: -74.1469 },
  ],
  EC: [
    { iata: "UIO", name: "Mariscal Sucre", city: "Quito", country: "EC", lat: -0.1292, lon: -78.3575 },
  ],
  HN: [
    { iata: "TGU", name: "Toncontín International", city: "Tegucigalpa", country: "HN", lat: 14.0608, lon: -87.2172 },
  ],

  // Oceania
  AU: [
    { iata: "SYD", name: "Sydney Kingsford Smith", city: "Sydney", country: "AU", lat: -33.9399, lon: 151.1753 },
    { iata: "MEL", name: "Melbourne Airport", city: "Melbourne", country: "AU", lat: -37.6690, lon: 144.8410 },
  ],
  NZ: [
    { iata: "AKL", name: "Auckland Airport", city: "Auckland", country: "NZ", lat: -37.0082, lon: 174.7917 },
  ],
};

/** Get the primary (highest-throughput) airport for a country, or null if unknown. */
export function primaryAirportForCountry(countryIso2: string): AirportCoord | null {
  const list = MAJOR_AIRPORTS[countryIso2.toUpperCase()];
  return list?.[0] ?? null;
}

/** Get airport by IATA code (searches across all countries). */
export function getAirportByIATA(iata: string): AirportCoord | null {
  const target = iata.toUpperCase();
  for (const list of Object.values(MAJOR_AIRPORTS)) {
    const match = list.find((a) => a.iata === target);
    if (match) return match;
  }
  return null;
}

/** Resolve the nearest US destination airport for a US sea-port code (rough match). */
const SEAPORT_TO_NEAREST_US_AIRPORT: Record<string, string> = {
  USLAX: "LAX", USLGB: "LAX", USOAK: "SFO", USSEA: "SEA", USTAC: "SEA",
  USNYC: "JFK", USPHL: "JFK", USBAL: "JFK", USNFK: "JFK", USBOS: "BOS",
  USMIA: "MIA", USCHS: "ATL", USSAV: "ATL", USHOU: "IAH", USCHI: "ORD",
  USCLE: "ORD", USSFO: "SFO",
};

export function nearestUSAirportForSeaport(locode: string): AirportCoord | null {
  const iata = SEAPORT_TO_NEAREST_US_AIRPORT[locode.toUpperCase()];
  if (!iata) return getAirportByIATA("LAX");
  return getAirportByIATA(iata);
}
