import { HttpError } from "../utils/http";

export const resolutions = { seconds: 1, minutes: 60, hours: 3600, days: 86400 } as const;
export type Resolution = keyof typeof resolutions;
export const maxIntervalSeconds = 900;
export const maxPoints = 1800;

export function analyticsQuery(params: URLSearchParams) {
  const start = new Date(params.get("start") || "");
  const end = new Date(params.get("end") || "");
  const resolution = (params.get("resolution") || "minutes") as Resolution;
  const timezone = params.get("timezone") || "Africa/Accra";
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start ||
      end.getTime() - start.getTime() > 366 * 86400000 || end.getTime() > Date.now() + 60000) {
    throw new HttpError(400, "Choose a valid UTC range of at most 366 days ending no later than now.");
  }
  if (!Object.hasOwn(resolutions, resolution)) throw new HttpError(400, "Invalid resolution");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { throw new HttpError(400, "Invalid timezone"); }
  if (Math.ceil((end.getTime() - start.getTime()) / (resolutions[resolution] * 1000)) + 2 > maxPoints) {
    throw new HttpError(400, "This range is too large for that resolution. Choose a coarser resolution (maximum 1,800 points).");
  }
  return { start, end, resolution, timezone };
}

// Wall-clock input explicitly belongs to the selected IANA timezone, not the browser timezone.
export function zonedInputToUtc(value: string, timezone: string): string {
  const wall = Date.parse(value + "Z");
  if (!Number.isFinite(wall)) throw new Error("Choose a valid date and time.");
  const format = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let candidate = wall;
  for (let i = 0; i < 4; i++) {
    const displayed = Date.parse(format.format(new Date(candidate)).replace(" ", "T") + "Z");
    const correction = wall - displayed;
    if (correction === 0) return new Date(candidate).toISOString();
    candidate += correction;
  }
  throw new Error("That local time does not exist due to a daylight-saving transition.");
}
