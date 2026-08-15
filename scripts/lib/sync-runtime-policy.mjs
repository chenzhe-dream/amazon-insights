export function shouldBuildAndRestartForSync(env = process.env) {
  return env.AGENT_VOC_LOCAL_FAKE !== "1";
}

export function windowsHiddenChildProcessOptions(platform = process.platform) {
  return platform === "win32" ? { windowsHide: true } : {};
}
