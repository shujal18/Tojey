import React, { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff, RefreshCw, ScreenShare, Volume2, VolumeX, Minimize2, Maximize2, X } from 'lucide-react';
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

  const other = callMeta?.other || {};
  const name = other.display_name || other.username || '';

  useEffect(() => {
    if (remoteRef.current) {
      remoteRef.current.srcObject = remoteStream || null;
      if (remoteStream) remoteRef.current.play().catch(() => {});
    }
  }, [remoteStream]);

  useEffect(() => {
    if (localRef.current) {
      localRef.current.srcObject = localStream || null;
      if (localStream) localRef.current.play().catch(() => {});
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

  const fmtTime = () => {
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const Avatar = ({ size }) => (
    <div style={{
      width: size, height: size, borderRadius: size / 2,
      background: avatarGrad(other.id),
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
      width: 52, height: 52, borderRadius: 26,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.1)',
      color: '#fff',
      backdropFilter: 'blur(6px)',
      boxShadow: '0 3px 12px rgba(0,0,0,0.3)',
      border: active ? `1px solid ${theme.primary}` : '1px solid rgba(255,255,255,0.18)',
    }}>
      {icon}
    </button>
  );

  // Popup mini-call while chatting.
  if (minimized && (state === 'active' || state === 'connecting')) {
    return (
      <div style={{
        position: 'fixed', right: 12, bottom: 80, zIndex: 4200,
        width: 280, borderRadius: 16, overflow: 'hidden',
        background: '#0b0a12', boxShadow: '0 10px 40px rgba(0,0,0,0.55)',
        border: `1px solid ${theme.primary}`,
        animation: 'msgSlideUp 0.25s ease',
      }}>
        <div style={{ position: 'relative', width: '100%', height: 150, background: '#000' }}>
          {remoteStream ? (
            <video ref={remoteRef} autoPlay playsInline muted={!remoteAudible} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#141221' }}>
              <Avatar size={56} />
            </div>
          )}
          <div style={{
            position: 'absolute', top: 8, left: 10,
            color: '#fff', fontSize: 13, fontWeight: 700,
            textShadow: '0 1px 6px rgba(0,0,0,0.9)',
          }}>
            {name} • {fmtTime()}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-around', padding: 8, background: '#141221' }}>
          <button onClick={() => { setMinimized(false); }} style={{ color: '#fff', padding: 6 }}><Maximize2 size={20} /></button>
          <button onClick={() => { setMinimized(false); toggleScreenShare(); }} style={{ color: sharing ? theme.primary : '#fff', padding: 6 }}><ScreenShare size={20} /></button>
          <button onClick={endCall} style={{
            color: '#fff', padding: 10, borderRadius: 22, background: theme.danger,
            width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <PhoneOff size={18} />
          </button>
        </div>
      </div>
    );
  }

  if (state === 'incoming') {
    return (
      <CallLayer onBackdrop={declineCall}>
        <style>{`
          @keyframes callRing { 0%{transform:scale(1)} 25%{transform:scale(1.06)} 50%{transform:scale(1)} 75%{transform:scale(1.04)} 100%{transform:scale(1)} }
        `}</style>
        <div style={{ textAlign: 'center', paddingBottom: 20 }}>
          <div style={{ display: 'inline-block', animation: 'callRing 1.6s infinite ease-in-out' }}>
            <Avatar size={110} />
          </div>
          <div style={{ color: '#fff', fontSize: 24, fontWeight: 700, marginTop: 18 }}>{name}</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 15, marginTop: 6 }}>Incoming video call…</div>
        </div>
        <div style={{ display: 'flex', gap: 48, justifyContent: 'center', alignItems: 'center', paddingBottom: 8 }}>
          <button onClick={declineCall} title="Decline" style={{
            width: 64, height: 64, borderRadius: 32, background: theme.danger, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 20px rgba(229,57,53,0.5)',
          }}>
            <Phone size={26} style={{ transform: 'rotate(135deg)' }} />
          </button>
          <button onClick={acceptCall} title="Accept" style={{
            width: 64, height: 64, borderRadius: 32, background: '#00C853', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 20px rgba(0,200,83,0.5)',
          }}>
            <Phone size={26} />
          </button>
        </div>
      </CallLayer>
    );
  }

  if (state === 'outgoing') {
    return (
      <CallLayer backdrop>
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
      </CallLayer>
    );
  }

  if (state === 'ended') {
    return (
      <CallLayer backdrop>
        <div style={{ color: '#fff', fontSize: 18, fontWeight: 600 }}>Call ended</div>
      </CallLayer>
    );
  }

  // connecting / active
  const showLocalPlaceholder = !remoteStream;
  return (
    <CallLayer backdrop full>
      <div style={{ position: 'absolute', top: 44, left: 0, right: 0, textAlign: 'center', zIndex: 5, pointerEvents: 'none' }}>
        <div style={{ color: '#fff', fontSize: 17, fontWeight: 700, textShadow: '0 1px 8px rgba(0,0,0,0.9)' }}>{name}</div>
        <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 14, marginTop: 3 }}>
          {state === 'connecting' ? 'Connecting…' : fmtTime()}
        </div>
      </div>

      {remoteStream ? (
        <video ref={remoteRef} autoPlay playsInline muted={!remoteAudible} style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#111',
        }} />
      ) : (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#141221',
        }}>
          <div style={{ textAlign: 'center' }}>
            <Avatar size={110} />
            <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 14, marginTop: 16 }}>
              {state === 'connecting' ? 'Connecting…' : 'Waiting for video…'}
            </div>
          </div>
        </div>
      )}

      {/* Local PIP */}
      <div style={{
        position: 'absolute', right: 12, top: 100, zIndex: 5,
        width: 92, height: 128, borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 6px 24px rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.25)',
        background: '#000',
      }}>
        {localStream && videoEnabled ? (
          <video ref={localRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#221f2e', color: '#fff' }}>
            <Avatar size={40} />
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{
        position: 'absolute', bottom: 34, left: 0, right: 0, zIndex: 6,
        display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '0 24px',
      }}>
        <ControlBtn onClick={toggleMic} icon={micMuted ? <MicOff size={22} /> : <Mic size={22} />} label={micMuted ? 'Unmute' : 'Mute'} />
        <ControlBtn onClick={toggleVideo} icon={videoEnabled ? <Video size={22} /> : <VideoOff size={22} />} label={videoEnabled ? 'Camera off' : 'Camera on'} />
        <ControlBtn onClick={flipCamera} icon={<RefreshCw size={22} />} label="Flip camera" />
        <ControlBtn onClick={toggleScreenShare} active={sharing} icon={<ScreenShare size={22} />} label="Share screen" />
        <ControlBtn onClick={toggleRemoteAudio} icon={remoteAudible ? <Volume2 size={22} /> : <VolumeX size={22} />} label="Remote sound" />
        <ControlBtn onClick={() => setMinimized(true)} icon={<Minimize2 size={22} />} label="Minimize" />
        <button onClick={endCall} title="End call" style={{
          width: 56, height: 56, borderRadius: 28, background: theme.danger, color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 20px rgba(229,57,53,0.55)',
        }}>
          <PhoneOff size={24} />
        </button>
      </div>
    </CallLayer>
  );
}

function CallLayer({ children, backdrop, full }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 4000,
      background: full ? '#0b0a12' : 'rgba(10,9,16,0.92)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      backdropFilter: backdrop ? 'blur(10px)' : undefined,
      animation: 'fadeIn 0.22s ease',
    }}>
      {children}
    </div>
  );
}