export function shouldBuildAndRestartForSync(env = process.env) {
  return env.AGENT_VOC_LOCAL_FAKE !== "1";
}
