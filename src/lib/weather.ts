import 'server-only';

/** WMO weather codes, collapsed to what fits on a kiosk card. */
const WEATHER_CODES: Record<number, { emoji: string; label: string }> = {
  0: { emoji: '☀️', label: 'Clear' },
  1: { emoji: '🌤️', label: 'Mostly clear' },
  2: { emoji: '⛅', label: 'Partly cloudy' },
  3: { emoji: '☁️', label: 'Overcast' },
  45: { emoji: '🌫️', label: 'Fog' },
  48: { emoji: '🌫️', label: 'Fog' },
  51: { emoji: '🌦️', label: 'Drizzle' },
  53: { emoji: '🌦️', label: 'Drizzle' },
  55: { emoji: '🌦️', label: 'Drizzle' },
  56: { emoji: '🌧️', label: 'Freezing drizzle' },
  57: { emoji: '🌧️', label: 'Freezing drizzle' },
  61: { emoji: '🌧️', label: 'Rain' },
  63: { emoji: '🌧️', label: 'Rain' },
  65: { emoji: '🌧️', label: 'Heavy rain' },
  66: { emoji: '🌧️', label: 'Freezing rain' },
  67: { emoji: '🌧️', label: 'Freezing rain' },
  71: { emoji: '🌨️', label: 'Snow' },
  73: { emoji: '🌨️', label: 'Snow' },
  75: { emoji: '🌨️', label: 'Heavy snow' },
  77: { emoji: '🌨️', label: 'Snow grains' },
  80: { emoji: '🌦️', label: 'Rain showers' },
  81: { emoji: '🌦️', label: 'Rain showers' },
  82: { emoji: '🌦️', label: 'Heavy showers' },
  85: { emoji: '🌨️', label: 'Snow showers' },
  86: { emoji: '🌨️', label: 'Snow showers' },
  95: { emoji: '⛈️', label: 'Thunderstorm' },
  96: { emoji: '⛈️', label: 'Thunderstorm' },
  99: { emoji: '⛈️', label: 'Thunderstorm' },
};

export type GeocodeResult = { label: string; lat: number; lon: number };

/** Free, keyless — resolves a place name to coordinates plus a display label. */
export async function geocodeLocation(query: string): Promise<GeocodeResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', trimmed);
  url.searchParams.set('count', '1');

  const res = await fetch(url, { next: { revalidate: 0 } });
  if (!res.ok) return null;

  const data = await res.json();
  const hit = data?.results?.[0];
  if (!hit) return null;

  const label = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', ');
  return { label, lat: hit.latitude, lon: hit.longitude };
}

export type Weather = { tempF: number; emoji: string; label: string };

/** Cached for 10 minutes so the kiosk's 45s refresh loop doesn't hammer the API. */
export async function getWeather(lat: number, lon: number): Promise<Weather | null> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('current', 'temperature_2m,weather_code');
  url.searchParams.set('temperature_unit', 'fahrenheit');

  const res = await fetch(url, { next: { revalidate: 600 } });
  if (!res.ok) return null;

  const data = await res.json();
  const current = data?.current;
  if (!current || typeof current.temperature_2m !== 'number') return null;

  const info = WEATHER_CODES[current.weather_code] ?? { emoji: '🌡️', label: 'Weather' };
  return { tempF: Math.round(current.temperature_2m), emoji: info.emoji, label: info.label };
}
