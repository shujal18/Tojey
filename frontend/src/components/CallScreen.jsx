import React, { useEffect, useRef, useState, useCallback } from 'react';
import { PhoneOff, Mic, MicOff, Video, VideoOff, Minimize2, Maximize2, Menu, Volume2, VolumeX } from 'lucide-react';
import { useCall } from '../services/CallContext';
import { useTheme } from '../theme/ThemeContext';
import { resolveUrl } from '../services/upload';

function avatarGrad(id) {
  return id === 1 ? 'linear-gradient(135deg,#6C3CE9,#4E22B8)' : 'linear-gradient(135deg,#7C4DFF,#2E7D32)';
}

export default function CallScreen() {
  const { theme } = useTheme();
  const {
    state, callMeta, localStream, remoteStream, micMuted, videoEnabled, remoteAudible,
    sharing, minimized, setMinimized, acceptCall, declineCall, endCall,
    toggleMic, toggleVideo, toggleRemoteAudio, toggleScreenShare, flipCamera,
  } = useCall();

  const remoteRef = useRef(null);
  const localRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const [soundUnlocked, setSoundUnlocked] = useState(false);
  const [mainIsLocal, setMainIsLocal] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // Track which stream is currently attached to each video element so we never
  // reassign srcObject to the same stream (reassignment restarts the pipeline ->
  // black screen / flicker).
  const remoteAttachedRef = useRef(null);
  const localAttachedRef = useRef(null);

  // Minimized (PIP) draggable bubble position
  const [pipPos, setPipPos] = useState({ x: 20, y: 20 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef({ sx: 0, sy: 0, ox: 0, oy: 0 });

  // Remote audio: keep video element muted=TRUE always (prevents black screen on
  // attribute changes). Audio is enabled/disabled via the MediaStream track itself
  // through toggleRemoteAudio (call.js sets track.enabled). soundUnlocked is only
  // used for the "Tap for sound" hint overlay.
  const unlockSound = useCallback(() => {
    if (soundUnlocked) return;
    setSoundUnlocked(true);
    toggleRemoteAudio(true);
    if (remoteRef.current) {
      try { remoteRef.current.play().catch(() => {}); } catch (e) {}
    }
  }, [soundUnlocked, toggleRemoteAudio]);

  const other = callMeta?.other || {};
  const name = other.display_name || other.username || '';

  // Attach remote stream once, never reassign unless the stream object actually
  // changes. Prevents pipeline restart / black screen.
  useEffect(() => {
    const el = remoteRef.current;
    if (!el) return;
    if (remoteAttachedRef.current === remoteStream) return;
    remoteAttachedRef.current = remoteStream;
    el.srcObject = remoteStream || null;
    el.muted = true;
    el.playsInline = true;
    if (remoteStream) {
      el.play().catch((e) => console.warn('remote play failed', e));
    } else {
      el.pause();
    }
  }, [remoteStream]);

  // Attach local stream once, never reassign unless the stream object actually
  // changes. Prevents pipeline restart / flicker.
  useEffect(() => {
    const el = localRef.current;
    if (!el) return;
    if (localAttachedRef.current === localStream) return;
    localAttachedRef.current = localStream;
    el.srcObject = localStream || null;
    el.muted = true;
    el.playsInline = true;
    if (localStream) {
      el.play().catch((e) => console.warn('local play failed', e));
    } else {
      el.pause();
    }
  }, [localStream]);

  useEffect(() => {
    if (state !== 'active') { setElapsed(0); return; }
    const i = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(i);
  }, [state]);

  useEffect(() => {
    if (state === 'idle' || state === 'ended') setMinimized(false);
  }, [state, setMinimized]);

  if (state === 'idle') return null;

  const setRemote = (el) => {
    remoteRef.current = el;
    // Re-attach stream to the new element if we already have one
    if (remoteStream) {
      el.srcObject = remoteStream;
      el.muted = true;
      el.playsInline = true;
      el.play().catch(() => {});
    }
  };
  const setLocal = (el) => {
    localRef.current = el;
    if (localStream) {
      el.srcObject = localStream;
      el.muted = true;
      el.playsInline = true;
      el.play().catch(() => {});
    }
  };

  const swapViews = () => setMainIsLocal((v) => !v);
  const localMain = mainIsLocal;
  const pipIsLocal = !localMain;
  const showPip = pipIsLocal ? true : !!remoteStream;

  const fmtTime = () => {
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const Avatar = ({ size }) => (
    <div style={{
      width: size, height: size, borderRadius: size / 2,
      background: avatarGrad(other.id || 0),
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 700, fontSize: size * 0.4, overflow: 'hidden', flexShrink: 0,
    }}>
      {other.profile_pic_url
        ? <img src={resolveUrl(other.profile_pic_url)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : (name[0] || '?').toUpperCase()}
    </div>
  );

  const ControlBtn = ({ onClick, active, icon, label, danger }) => (
    <button onClick={onClick} title={label} style={{
      width: 44, height: 44, borderRadius: 22,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: danger ? theme.danger : active ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.35)',
      color: '#fff',
      backdropFilter: 'blur(4px)',
      border: danger ? 'none' : active ? `1px solid ${theme.primary}` : 'none',
    }}>
      {icon}
    </button>
  );

  // ---- Draggable minimized (PIP) call bubble ----
  const onPipDown = (e) => {
    e.preventDefault();
    setDragging(true);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pipPos.x, oy: pipPos.y };
  };
  const onPipMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragRef.current.sx;
    const dy = e.clientY - dragRef.current.sy;
    const nx = Math.min(Math.max(0, dragRef.current.ox + dx), (window.innerWidth || 320) - 280);
    const ny = Math.min(Math.max(0, dragRef.current.oy + dy), (window.innerHeight || 480) - 170);
    setPipPos({ x: nx, y: ny });
  };
  const onPipUp = () => setDragging(false);

  if (minimized && (state === 'active' || state === 'connecting')) {
    return (
      <div
        style={{
          position: 'fixed', left: pipPos.x, top: pipPos.y, zIndex: 4200,
          width: 280, height: 170, borderRadius: 16, overflow: 'hidden',
          background: '#0b0a12', boxShadow: '0 10px 40px rgba(0,0,0,0.55)',
          border: `1px solid ${theme.primary}`, touchAction: 'none',
        }}
        onPointerDown={onPipDown}
        onPointerMove={onPipMove}
        onPointerUp={onPipUp}
        onPointerCancel={onPipUp}
      >
        <div style={{ position: 'relative', width: '100%', height: 120, background: '#000' }}>
          {mainIsLocal ? (
            <video ref={setLocal} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          ) : remoteStream ? (
            <video ref={setRemote} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#141221' }}>
              <Avatar size={48} />
            </div>
          )}
          {!mainIsLocal && remoteStream && !soundUnlocked && (
            <button onClick={unlockSound} style={{
              position: 'absolute', bottom: 8, right: 8, zIndex: 3,
              background: 'rgba(0,0,0,0.65)', color: '#fff', border: 'none',
              borderRadius: 14, padding: '4px 8px', fontSize: 10, cursor: 'pointer',
            }}>
              🔊 Tap for sound
            </button>
          )}
          <div style={{
            position: 'absolute', top: 6, left: 8,
            color: '#fff', fontSize: 12, fontWeight: 700,
            textShadow: '0 1px 6px rgba(0,0,0,0.9)',
          }}>
            {name}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', background: '#141221', alignItems: 'center' }}>
          <button onClick={() => setMinimized(false)} style={{ color: '#fff', padding: 6 }}><Maximize2 size={18} /></button>
          <button onClick={endCall} style={{
            color: '#fff', padding: 8, borderRadius: 20, background: theme.danger,
            width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <PhoneOff size={16} />
          </button>
        </div>
      </div>
    );
  }

  // ---- Incoming ----
  if (state === 'incoming') {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(10,9,16,0.5)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(6px)',
      }}>
        <div style={{ textAlign: 'center', paddingBottom: 20 }}>
          <div style={{ display: 'inline-block', animation: 'callRing 1.6s infinite ease-in-out' }}>
            <Avatar size={110} />
          </div>
          <div style={{ color: '#fff', fontSize: 24, fontWeight: 700, marginTop: 18 }}>{name}</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 15, marginTop: 6 }}>Incoming video call…</div>
        </div>
        <style>{`
          @keyframes callRing { 0%{transform:scale(1)} 25%{transform:scale(1.06)} 50%{transform:scale(1)} 75%{transform:scale(1.04)} 100%{transform:scale(1)} }
        `}</style>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', alignItems: 'center', paddingBottom: 8 }}>
          <button onClick={declineCall} title="Decline" style={{
            width: 60, height: 60, borderRadius: 30, background: theme.danger, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 20px rgba(229,57,53,0.5)',
          }}>
            <PhoneOff size={24} style={{ transform: 'rotate(135deg)' }} />
          </button>
          <button onClick={toggleRemoteAudio} title={remoteAudible ? 'Mute remote' : 'Unmute remote'} style={{
            width: 56, height: 56, borderRadius: 28,
            background: remoteAudible ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.35)',
            color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', backdropFilter: 'blur(4px)',
          }}>
            {remoteAudible ? <Volume2 size={20} /> : <VolumeX size={20} />}
          </button>
          <button onClick={acceptCall} title="Accept" style={{
            width: 60, height: 60, borderRadius: 30, background: '#00C853', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 20px rgba(0,200,83,0.5)',
          }}>
            <PhoneOff size={24} />
          </button>
        </div>
      </div>
    );
  }

  // ---- Outgoing ----
  if (state === 'outgoing') {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(10,9,16,0.92)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(10px)',
      }}>
        <div style={{ textAlign: 'center', paddingBottom: 30 }}>
          <Avatar size={110} />
          <div style={{ color: '#fff', fontSize: 24, fontWeight: 700, marginTop: 18 }}>{name}</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 15, marginTop: 6 }}>Ringing…</div>
        </div>
        <button onClick={endCall} style={{
          width: 64, height: 64, borderRadius: 32, background: theme.danger, color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 20px rgba(229,57,53,0.5)',
        }}>
          <PhoneOff size={26} />
        </button>
      </div>
    );
  }

  // ---- Ended ----
  if (state === 'ended') {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(10,9,16,0.92)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(10px)',
      }}>
        <div style={{ color: '#fff', fontSize: 18, fontWeight: 600 }}>Call ended</div>
      </div>
    );
  }

  // ---- Connecting / Active ----
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 4000,
      background: '#0b0a12',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ position: 'absolute', top: 44, left: 0, right: 0, textAlign: 'center', zIndex: 5, pointerEvents: 'none' }}>
        <div style={{ color: '#fff', fontSize: 17, fontWeight: 700, textShadow: '0 1px 8px rgba(0,0,0,0.9)' }}>{name}</div>
        <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 14, marginTop: 3 }}>
          {state === 'connecting' ? 'Connecting…' : fmtTime()}
        </div>
      </div>

      {/* Main stage - always render video elements, toggle srcObject instead of
          mounting/unmounting to avoid pipeline restart / flicker */}
      <div
        onClick={localMain && !remoteStream ? swapViews : undefined}
        style={{
          position: 'absolute', inset: 0, zIndex: 2, background: '#141221', overflow: 'hidden',
          cursor: localMain && !remoteStream ? 'pointer' : 'default',
        }}
      >
        {localMain ? (
          <>
            {localStream && videoEnabled ? (
              <video
                key="local-main"
                ref={setLocal}
                autoPlay
                playsInline
                muted
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
                  background: '#111', transform: sharing ? 'none' : 'scaleX(-1)',
                }}
              />
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#141221' }}>
                <Avatar size={110} />
              </div>
            )}
            {sharing && (
              <div style={{ position: 'absolute', top: 14, left: 14, zIndex: 2, display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 12, fontWeight: 700, borderRadius: 10, padding: '4px 8px' }}>
                <VideoOff size={14} /> Screen
              </div>
            )}
          </>
        ) : (
          remoteStream ? (
            <video ref={setRemote} autoPlay playsInline muted style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#111', transform: 'scaleX(-1)',
            }} />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ textAlign: 'center' }}>
                <Avatar size={110} />
                <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 14, marginTop: 16 }}>
                  {state === 'connecting' ? 'Connecting…' : 'Waiting for video…'}
                </div>
              </div>
            </div>
          )
        )}
      </div>

      {!mainIsLocal && remoteStream && !soundUnlocked && (
        <button onClick={unlockSound} style={{
          position: 'absolute', bottom: 110, right: 16, zIndex: 7,
          background: 'rgba(0,0,0,0.65)', color: '#fff', border: 'none',
          borderRadius: 18, padding: '8px 14px', fontSize: 13, cursor: 'pointer',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}>
          🔊 Tap for sound
        </button>
      )}

      {/* Draggable pip: smaller view. Tap to swap with main stage, drag to move. */}
      {showPip && (
        <div
          onPointerDown={onPipDown}
          onPointerMove={onPipMove}
          onPointerUp={onPipUp}
          onPointerCancel={onPipUp}
          style={{
            position: 'absolute', left: pipPos.x, top: pipPos.y, zIndex: 5,
            width: 92, height: 128, borderRadius: 12, overflow: 'hidden',
            boxShadow: '0 6px 24px rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.25)',
            background: '#000', touchAction: 'none', cursor: 'grab',
          }}
          title="Drag to move · tap to switch"
        >
          {pipIsLocal ? (
            localStream ? (
              videoEnabled ? (
                <video ref={setLocal} autoPlay playsInline muted style={{
                  width: '100%', height: '100%', objectFit: 'cover',
                  transform: sharing ? 'none' : 'scaleX(-1)',
                }} />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#221f2e', color: '#fff' }}>
                  <Avatar size={40} />
                </div>
              )
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#221f2e', color: '#fff' }}>
                <Avatar size={40} />
              </div>
            )
          ) : (
            remoteStream && (
              <video ref={setRemote} autoPlay playsInline muted style={{
                width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', background: '#111',
              }} />
            )
          )}
        </div>
      )}

      {/* Controls - simplified: End, Camera, Remote Audio, Mic, More (3-dot) */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 6,
        display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, padding: '22px 24px',
        background: 'linear-gradient(to top, rgba(10,9,16,0.9), transparent)',
      }}>
        <ControlBtn onClick={endCall} icon={<PhoneOff size={22} />} label="End call" danger />
        <ControlBtn onClick={toggleVideo} icon={videoEnabled ? <Video size={22} /> : <VideoOff size={22} />} label={videoEnabled ? 'Camera off' : 'Camera on'} />
        <ControlBtn onClick={toggleRemoteAudio} icon={remoteAudible ? <Volume2 size={22} /> : <VolumeX size={22} />} active={!remoteAudible} label="Mute remote" />
        <ControlBtn onClick={toggleMic} icon={micMuted ? <MicOff size={22} /> : <Mic size={22} />} label={micMuted ? 'Unmute' : 'Mute'} />

        {/* More options (3-dot) */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setMoreOpen((o) => !o)}
            style={{
              width: 44, height: 44, borderRadius: 22,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.35)', color: '#fff', border: 'none',
              backdropFilter: 'blur(4px)',
            }}
          >
            <Menu size={22} />
          </button>
          {moreOpen && (
            <div style={{
              position: 'absolute', bottom: 52, left: '50%', transform: 'translateX(-50%)',
              background: '#141221', border: `1px solid rgba(255,255,255,0.15)`,
              borderRadius: 12, padding: '8px', boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
              zIndex: 7, minWidth: 160,
            }}>
              <button
                onClick={() => { setMoreOpen(false); toggleScreenShare(); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', border: 'none', background: 'none', color: sharing ? theme.primary : '#fff', fontSize: 13, cursor: 'pointer', borderRadius: 8 }}
              >
                <VideoOff size={16} /> {sharing ? 'Stop Screen Share' : 'Share Screen'}
              </button>
              <button
                onClick={() => { setMoreOpen(false); flipCamera(); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', border: 'none', background: 'none', color: '#fff', fontSize: 13, cursor: 'pointer', borderRadius: 8 }}
              >
                <VideoOff size={16} /> Flip Camera
              </button>
              <button
                onClick={() => { setMoreOpen(false); setMinimized(true); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', border: 'none', background: 'none', color: '#fff', fontSize: 13, cursor: 'pointer', borderRadius: 8 }}
              >
                <Minimize2 size={16} /> Minimize Call
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
