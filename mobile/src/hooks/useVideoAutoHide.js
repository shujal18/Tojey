import { useCallback, useEffect, useRef, useState } from 'react';

export default function useVideoAutoHide({ playing, controlsVisible, setControlsVisible, disabled = false, delay = 3000 }) {
  const [token, setToken] = useState(0);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const wake = useCallback(() => {
    setControlsVisible(true);
    setToken((value) => value + 1);
  }, [setControlsVisible]);

  useEffect(() => {
    if (!controlsVisible || !playing || disabledRef.current) return undefined;
    const timer = setTimeout(() => {
      if (!disabledRef.current) setControlsVisible(false);
    }, delay);
    return () => clearTimeout(timer);
  }, [controlsVisible, playing, disabled, delay, token]);

  return wake;
}
