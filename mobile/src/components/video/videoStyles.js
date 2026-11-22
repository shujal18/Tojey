import { StyleSheet } from 'react-native';
import { fs } from '../../utils/size';
import { VIDEO_ACCENT } from './videoConfig';

export const videoStyles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFillObject },
  topShade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 150,
    backgroundColor: 'rgba(2,6,14,0.58)',
  },
  bottomShade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 210,
    backgroundColor: 'rgba(2,6,14,0.72)',
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  disabled: { opacity: 0.38 },
  overlay: {
    position: 'absolute',
    zIndex: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayCard: {
    minWidth: 118,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 13,
    backgroundColor: 'rgba(5,12,24,0.88)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
  },
  overlayText: {
    color: '#fff',
    fontSize: fs(12),
    fontWeight: '800',
    marginTop: 5,
  },
  meter: {
    flexDirection: 'row',
    gap: 3,
    marginTop: 9,
  },
  meterSegment: {
    width: 8,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  meterSegmentOn: { backgroundColor: VIDEO_ACCENT },
  lockButton: {
    position: 'absolute',
    right: 18,
    bottom: 22,
    zIndex: 40,
  },
});
