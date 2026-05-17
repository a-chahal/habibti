// Open-Meteo Marine API — free, no key required
const BASE = "https://marine-api.open-meteo.com/v1/marine";

export interface MarineForecast {
  latitude: number;
  longitude: number;
  timezone: string;
  hourly: {
    time: string[];
    wave_height?: number[];
    wave_direction?: number[];
    wave_period?: number[];
    wind_wave_height?: number[];
    swell_wave_height?: number[];
  };
  current?: {
    wave_height?: number;
    wave_direction?: number;
    wind_wave_height?: number;
  };
}

export async function getMarineForecast(
  lat: number,
  lon: number,
  hourlyVars = ["wave_height", "wave_direction", "wave_period", "wind_wave_height", "swell_wave_height"]
): Promise<MarineForecast> {
  const url = new URL(BASE);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("hourly", hourlyVars.join(","));
  url.searchParams.set("current", "wave_height,wave_direction,wind_wave_height");
  url.searchParams.set("forecast_days", "3");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}: ${await res.text()}`);

  const json = await res.json();
  return {
    latitude: json.latitude,
    longitude: json.longitude,
    timezone: json.timezone,
    hourly: {
      time: json.hourly?.time ?? [],
      wave_height: json.hourly?.wave_height,
      wave_direction: json.hourly?.wave_direction,
      wave_period: json.hourly?.wave_period,
      wind_wave_height: json.hourly?.wind_wave_height,
      swell_wave_height: json.hourly?.swell_wave_height,
    },
    current: json.current
      ? {
          wave_height: json.current.wave_height,
          wave_direction: json.current.wave_direction,
          wind_wave_height: json.current.wind_wave_height,
        }
      : undefined,
  };
}
