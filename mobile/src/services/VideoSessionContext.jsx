import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import TojeyVideoPlayer from '../components/video/TojeyVideoPlayer';

const VideoSessionContext = createContext(null);

export function VideoSessionProvider({ children }) {
  const [session, setSession] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const positionRef = useRef(0);

  const openSession = useCallback((payload) => {
    if (!payload || !payload.source || !payload.source.uri) return;
    const position = Number(payload.position) || 0;
    positionRef.current = position;
    setExpanded(false);
    setSession({ ...payload, position });
  }, []);

  const closeSession = useCallback(() => {
    positionRef.current = 0;
    setExpanded(false);
    setSession(null);
  }, []);

  const expandSession = useCallback(() => setExpanded(true), []);
  const minimizeSession = useCallback(() => setExpanded(false), []);

  const handleMiniAction = useCallback((action) => {
    if (action === 'close') closeSession();
    else if (action === 'expand') setExpanded(true);
  }, [closeSession]);

  const updatePosition = useCallback((state) => {
    const next = Number(state && state.currentTime);
    if (Number.isFinite(next)) positionRef.current = next;
  }, []);

  const value = useMemo(() => ({
    openSession,
    closeSession,
    expandSession,
    minimizeSession,
    hasSession: !!session,
  }), [closeSession, expandSession, minimizeSession, openSession, session]);

  const sharedPlayerProps = session ? {
    source: session.source,
    title: session.title,
    initialTime: positionRef.current,
    initialRate: session.rate || 1,
    initialMuted: !!session.muted,
    initialVolume: session.volume == null ? 1 : session.volume,
    availableQualities: session.availableQualities || ['Auto'],
    statusLabel: session.statusLabel,
    onTimeUpdate: updatePosition,
    onRetry: session.onRetry,
    onQualityChange: session.onQualityChange,
  } : {};

  return (
    <VideoSessionContext.Provider value={value}>
      {children}
      {session && !expanded ? (
        <TojeyVideoPlayer
          {...sharedPlayerProps}
          ref={null}
          mode="mini"
          onMinimize={handleMiniAction}
        />
      ) : null}
      {session && expanded ? (
        <Modal visible transparent={false} animationType="slide" onRequestClose={minimizeSession}>
          <View style={styles.expanded}>
            <TojeyVideoPlayer
              {...sharedPlayerProps}
              style={styles.expandedVideo}
              mode="full"
              onBack={minimizeSession}
              onMinimize={minimizeSession}
            />
          </View>
        </Modal>
      ) : null}
    </VideoSessionContext.Provider>
  );
}

export function useVideoSession() {
  const value = useContext(VideoSessionContext);
  return value || {
    openSession: () => {},
    closeSession: () => {},
    expandSession: () => {},
    minimizeSession: () => {},
    hasSession: false,
  };
}

const styles = StyleSheet.create({
  expanded: { flex: 1, backgroundColor: '#000' },
  expandedVideo: { flex: 1 },
});
