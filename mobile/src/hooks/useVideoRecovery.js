import { useEffect, useRef } from 'react';

export default function useVideoRecovery({ enabled, lastProgressRef, onRecover, intervalMs = 3000, stallMs = 12000 }) {
  const onRecoverRef = useRef(onRecover);
  onRecoverRef.current = onRecover;

  useEffect(() => {
    if (!enabled || !lastProgressRef) return undefined;
    const timer = setInterval(() => {
      const last = Number(lastProgressRef.current) || 0;
      if (Date.now() - last > stallMs) {
        lastProgressRef.current = Date.now();
        if (typeof onRecoverRef.current === 'function') onRecoverRef.current();
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, lastProgressRef, intervalMs, stallMs]);
}
