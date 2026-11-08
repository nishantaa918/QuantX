export function createReplayController({
  length,
  available = true,
  firstPlayableIndex = 0,
  intervalMs = 450,
  onStep = () => {},
  onState = () => {},
  schedule = (callback, delay) => window.setInterval(callback, delay),
  cancel = (timer) => window.clearInterval(timer),
} = {}) {
  const validLength = Number.isInteger(length) && length > 0;
  const playable = Boolean(available) && validLength && Number.isInteger(firstPlayableIndex) && firstPlayableIndex >= 0 && firstPlayableIndex < length;
  let index = playable ? firstPlayableIndex : 0;
  let timer = null;
  let disposed = false;

  function publish() {
    onStep(index);
  }

  function getState() {
    return { index, playing: timer !== null, available: playable && !disposed, firstPlayableIndex };
  }

  function publishState() {
    onState(getState());
  }

  function pause() {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    publishState();
    return getState();
  }

  function seek(nextIndex) {
    if (!playable || disposed || !Number.isFinite(nextIndex)) return false;
    pause();
    index = Math.max(firstPlayableIndex, Math.min(length - 1, Math.trunc(nextIndex)));
    publish();
    return true;
  }

  function restart() {
    if (!playable || disposed) return false;
    pause();
    index = firstPlayableIndex;
    publish();
    return true;
  }

  function play() {
    if (!playable || disposed) return false;
    if (timer !== null) return true;
    if (index >= length - 1) restart();
    timer = schedule(() => {
      if (index >= length - 1) {
        pause();
        return;
      }
      index += 1;
      if (index >= length - 1) pause();
      publish();
    }, intervalMs);
    publishState();
    return true;
  }

  function previous() {
    return seek(index - 1);
  }

  function next() {
    return seek(index + 1);
  }

  function dispose() {
    pause();
    disposed = true;
    publishState();
    return getState();
  }

  publish();
  return { getState, play, pause, restart, seek, previous, next, dispose };
}
