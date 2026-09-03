const SHA256 = /^[a-f0-9]{64}$/;
const MANUAL_REFRESH_NOTICE = "新数据已发布，请手动刷新";

export function publicationArtifactNotice(currentArtifactId: string, targetArtifactId: string): string | null {
  if (!SHA256.test(targetArtifactId) || currentArtifactId === targetArtifactId) return null;
  return MANUAL_REFRESH_NOTICE;
}
