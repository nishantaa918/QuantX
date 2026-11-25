export function createRequestVersion() {
  let currentVersion = 0;

  return {
    next() {
      currentVersion += 1;
      return currentVersion;
    },
    invalidate() {
      currentVersion += 1;
      return currentVersion;
    },
    isCurrent(version) {
      return version === currentVersion;
    },
  };
}
