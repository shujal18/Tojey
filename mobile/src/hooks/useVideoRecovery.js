import { useEffect, useRef } from 'react';

export default function useVideoRecovery({
  enabled,
  lastProgressRef,
  onRecover,
  intervalMs = 3000,
  stallMs = 10000,
  cooldownMs = 30000,
}) {
  const onRecoverRef = useRef(onRecover);
  const lastRecoveryRef = useRef(0);
  onRecoverRef.current = onRecover;

  useEffect(() => {
    if (!enabled || !lastProgressRef) {
      lastRecoveryRef.current = 0;
      return undefined;
    }
    const timer = setInterval(() => {
      const last = Number(lastProgressRef.current) || 0;
      const now = Date.now();
      if (now - last <= stallMs) return;
      if (now - lastRecoveryRef.current < cooldownMs) return;
      lastRecoveryRef.current = now;
      lastProgressRef.current = now;
      if (typeof onRecoverRef.current === 'function') onRecoverRef.current();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, lastProgressRef, stallMs, cooldownMs]);
}
