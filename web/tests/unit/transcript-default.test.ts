import { describe, expect, it, vi } from 'vitest';
import { selectDefaultTranscriptBackend } from '@/lib/transcript-default';

vi.mock('@/lib/runtime-config', () => ({
  getRagBackendKey: () => 'faster-whisper/model@lang-cs',
}));

describe('default transcript backend', () => {
  it('selects the exact configured language variant', () => {
    expect(
      selectDefaultTranscriptBackend([
        'faster-whisper/model',
        'faster-whisper/model@lang-cs',
      ]),
    ).toBe('faster-whisper/model@lang-cs');
  });

  it('uses priority order when the configured variant is absent', () => {
    expect(
      selectDefaultTranscriptBackend([
        'whisperx/other@lang-cs',
        'faster-whisper/model',
      ]),
    ).toBe('whisperx/other@lang-cs');
  });
});
