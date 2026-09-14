import type { Service } from "@avtar/agent-core";
import type { HttpClient } from "./http.js";

export interface WeatherRequest {
  /** A place name to look up, e.g. "Tokyo" or "Paris, France". */
  location: string;
}

export interface WeatherResult {
  location: string;
  latitude: number;
  longitude: number;
  temperatureC: number;
  windKph: number;
  weatherCode: number;
  summary: string;
}

// Minimal WMO weather-code -> text map (see open-meteo.com/en/docs).
const WMO: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "rime fog", 51: "light drizzle", 53: "drizzle", 55: "dense drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow",
  80: "rain showers", 81: "rain showers", 82: "violent rain showers",
  95: "thunderstorm", 96: "thunderstorm w/ hail", 99: "thunderstorm w/ heavy hail",
};
export const wmoText = (code: number): string => WMO[code] ?? `code ${code}`;

/**
 * A real metered weather service backed by the keyless Open-Meteo API: it
 * geocodes the place name, then fetches current conditions. One unit per call.
 *
 * The HTTP client is injected so tests run offline with canned responses;
 * production uses {@link FetchHttpClient}. This is what makes the provider
 * agent "meaningful" — it sells genuine, useful work, metered and paid per call
 * through the channel.
 */
export class WeatherService implements Service<WeatherRequest, WeatherResult> {
  readonly name = "open-meteo-weather";

  constructor(
    private readonly http: HttpClient,
    private readonly unitsPerCall: bigint = 1n,
  ) {
    if (unitsPerCall <= 0n) throw new Error("unitsPerCall must be positive");
  }

  price(_req: WeatherRequest): bigint {
    return this.unitsPerCall;
  }

  async handle(req: WeatherRequest): Promise<WeatherResult> {
    const q = encodeURIComponent(req.location.trim());
    const geo = await this.http.getJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=en&format=json`,
    );
    const place = geo?.results?.[0];
    if (!place) throw new Error(`location not found: ${req.location}`);
    const { latitude, longitude, name } = place;

    const wx = await this.http.getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        `&current=temperature_2m,wind_speed_10m,weather_code`,
    );
    const cur = wx?.current ?? {};
    const code = Number(cur.weather_code ?? -1);
    return {
      location: name,
      latitude,
      longitude,
      temperatureC: Number(cur.temperature_2m),
      windKph: Number(cur.wind_speed_10m),
      weatherCode: code,
      summary: wmoText(code),
    };
  }
}
