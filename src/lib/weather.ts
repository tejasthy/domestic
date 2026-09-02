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

async function geocodeQuery(query: string, revalidateSeconds: number): Promise<GeocodeResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', trimmed);
  url.searchParams.set('count', '1');

  let res: Response;
  try {
    res = await fetch(url, { next: { revalidate: revalidateSeconds } });
  } catch {
    // Network blip against the external geocoder — the kiosk shouldn't crash
    // over decorative weather, just skip it this refresh.
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  const hit = data?.results?.[0];
  if (!hit) return null;

  const label = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', ');
  return { label, lat: hit.latitude, lon: hit.longitude };
}

/** Free, keyless — resolves a place name to coordinates plus a display label.
 * Never cached: an admin searching for a place expects exactly what they
 * typed back, not a stale answer from someone else's earlier attempt. */
export async function geocodeLocation(query: string): Promise<GeocodeResult | null> {
  return geocodeQuery(query, 0);
}

/** Geocodes the house's own street address as the kiosk weather widget's
 * default location, so an admin only has to set one under Settings → Household
 * → Wall display if they want weather for somewhere other than the house
 * itself. A physical address doesn't move, so this is cached for a day rather
 * than the 10 minutes getWeather() itself uses — the kiosk polls every 5
 * seconds and would otherwise hammer the geocoder for no reason. */
export async function geocodeHouseAddress(address: string): Promise<GeocodeResult | null> {
  return geocodeQuery(address, 86400);
}

export type HourlyForecast = { hourLabel: string; tempF: number; emoji: string; precipChance: number };
export type DailyForecast = {
  weekday: string;
  emoji: string;
  highF: number;
  lowF: number;
  precipChance: number;
};

export type Weather = {
  tempF: number;
  emoji: string;
  label: string;
  feelsLikeF: number;
  humidity: number;
  windMph: number;
  windDirection: number;
  highF: number;
  lowF: number;
  uvIndex: number;
  precipChance: number;
  sunrise: string;
  sunset: string;
  hourly: HourlyForecast[];
  daily: DailyForecast[];
};

/** "14:00" -> "2 PM". Open-Meteo returns local wall-clock strings (no offset)
 * when timezone=auto, so slicing the string avoids any server/browser
 * timezone mismatch that constructing a Date would risk. */
function formatHourLabel(iso: string): string {
  const hour = Number(iso.slice(11, 13));
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function formatClockLabel(iso: string): string {
  const hour = Number(iso.slice(11, 13));
  const minute = iso.slice(14, 16);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weekday from a "YYYY-MM-DD" date string, using UTC arithmetic so the
 * server's own timezone can't shift which calendar day it lands on. */
function formatWeekday(dateStr: string, index: number): string {
  if (index === 0) return 'Today';
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Cached for 10 minutes so the kiosk's refresh loop doesn't hammer the API. */
export async function getWeather(lat: number, lon: number): Promise<Weather | null> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code',
  );
  url.searchParams.set('hourly', 'temperature_2m,weather_code,precipitation_probability');
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max',
  );
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '7');

  let res: Response;
  try {
    res = await fetch(url, { next: { revalidate: 600 } });
  } catch {
    // Same reasoning as geocodeQuery: a flaky external API shouldn't crash
    // the kiosk's force-dynamic render loop.
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  const current = data?.current;
  if (!current || typeof current.temperature_2m !== 'number') return null;

  const info = WEATHER_CODES[current.weather_code] ?? { emoji: '🌡️', label: 'Weather' };
  const daily = data?.daily;
  const hourly = data?.hourly;

  // current.time is sampled at 15-minute resolution (e.g. "…T13:30") but
  // hourly.time only has on-the-hour entries (e.g. "…T13:00"), so an exact
  // match against current.time always misses and silently falls back to
  // midnight. Truncate to the hour first so "Now" lines up with reality.
  const currentHour = `${current.time.slice(0, 13)}:00`;
  const hourTimes: string[] = hourly?.time ?? [];
  const startIndex = Math.max(0, hourTimes.indexOf(currentHour));
  const hourPoints: HourlyForecast[] = hourTimes.slice(startIndex, startIndex + 24).map((time, i) => {
    const idx = startIndex + i;
    const code = hourly.weather_code[idx];
    return {
      hourLabel: i === 0 ? 'Now' : formatHourLabel(time),
      tempF: Math.round(hourly.temperature_2m[idx]),
      emoji: (WEATHER_CODES[code] ?? info).emoji,
      precipChance: Math.round(hourly.precipitation_probability?.[idx] ?? 0),
    };
  });

  const dayTimes: string[] = daily?.time ?? [];
  const dayPoints: DailyForecast[] = dayTimes.map((date, i) => ({
    weekday: formatWeekday(date, i),
    emoji: (WEATHER_CODES[daily.weather_code[i]] ?? info).emoji,
    highF: Math.round(daily.temperature_2m_max[i]),
    lowF: Math.round(daily.temperature_2m_min[i]),
    precipChance: Math.round(daily.precipitation_probability_max?.[i] ?? 0),
  }));

  return {
    tempF: Math.round(current.temperature_2m),
    emoji: info.emoji,
    label: info.label,
    feelsLikeF: Math.round(current.apparent_temperature),
    humidity: Math.round(current.relative_humidity_2m),
    windMph: Math.round(current.wind_speed_10m),
    windDirection: current.wind_direction_10m,
    highF: Math.round(daily?.temperature_2m_max?.[0]),
    lowF: Math.round(daily?.temperature_2m_min?.[0]),
    uvIndex: Math.round(daily?.uv_index_max?.[0] ?? 0),
    precipChance: Math.round(daily?.precipitation_probability_max?.[0] ?? 0),
    sunrise: daily?.sunrise?.[0] ? formatClockLabel(daily.sunrise[0]) : '—',
    sunset: daily?.sunset?.[0] ? formatClockLabel(daily.sunset[0]) : '—',
    hourly: hourPoints,
    daily: dayPoints,
  };
}
