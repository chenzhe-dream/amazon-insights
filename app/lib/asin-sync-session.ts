export function createSyncStartGate() {
  let started = false;

  return () => {
    if (started) return false;
    started = true;
    return true;
  };
}
