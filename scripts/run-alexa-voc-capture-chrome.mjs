process.env.ALEXA_CHROME_PROFILE = "1";
process.env.ALEXA_HEADLESS = "0";
await import("./run-alexa-voc-capture.mjs");
