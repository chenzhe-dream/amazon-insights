export async function coordinateAlexaCapturePublication({
  capture,
  publish,
  publishAfterCapture = false,
}) {
  if (typeof capture !== "function" || typeof publish !== "function") {
    throw new Error("Invalid Alexa capture coordinator");
  }
  const result = await capture();
  const publication = publishAfterCapture && result?.okCount > 0
    ? publish()
    : null;
  return Object.freeze({ ...result, publication });
}
