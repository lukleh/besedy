import { useCallback, useState, type RefObject } from 'react';

/**
 * Volume and mute for the media element, shared by the on-screen slider, the
 * mute button and the keyboard. Every change from the listener also ends a
 * sleep-timer fade in progress: they are awake.
 */
export function useVolumeControls({
  audioRef,
  cancelSleepFade,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  cancelSleepFade: () => void;
}) {
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  const setVolumeLevel = useCallback(
    (value: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const newVolume = Math.max(0, Math.min(1, value));
      cancelSleepFade();
      audio.volume = newVolume;
      setVolume(newVolume);
      setIsMuted(newVolume === 0);
    },
    [audioRef, cancelSleepFade],
  );

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    cancelSleepFade();

    if (isMuted) {
      // Muted by dragging to zero leaves no level to return to; unmuting
      // then restores full volume, and the slider must show it.
      audio.volume = volume || 1;
      setVolume(audio.volume);
      setIsMuted(false);
    } else {
      audio.volume = 0;
      setIsMuted(true);
    }
  }, [audioRef, cancelSleepFade, isMuted, volume]);

  /** Step the level by `delta` (keyboard). Up always unmutes; down mutes at zero. */
  const adjustVolume = useCallback(
    (delta: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      cancelSleepFade();
      audio.volume = Math.max(0, Math.min(1, audio.volume + delta));
      setVolume(audio.volume);
      if (delta > 0) setIsMuted(false);
      else if (audio.volume === 0) setIsMuted(true);
    },
    [audioRef, cancelSleepFade],
  );

  return { volume, isMuted, setVolumeLevel, toggleMute, adjustVolume };
}
