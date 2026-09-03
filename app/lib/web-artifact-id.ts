export type WebArtifactEnvironment = Readonly<
  Record<string, string | undefined>
>;

export function webArtifactId(env: WebArtifactEnvironment): string {
  const value = env.WEB_PUBLICATION_ARTIFACT_ID?.trim();
  return value && /^[a-f0-9]{64}$/.test(value) ? value : "legacy";
}
