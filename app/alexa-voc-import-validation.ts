export function hasManualAlexaVocText(value: unknown) {
  return String(value ?? "").trim().length > 0;
}
