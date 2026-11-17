import { DEFAULT_GRACE_MINUTES } from "hevy2garmin";

/** Canonical `sync.grace_period_minutes`; zero explicitly disables the wait. */
export function parseGraceMinutes(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : undefined;
}

/** Invalid or absent stored config keeps the engine's watch-upload safety window. */
export function effectiveGraceMinutes(value: unknown): number {
  return parseGraceMinutes(value) ?? DEFAULT_GRACE_MINUTES;
}
