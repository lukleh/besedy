import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextSizeProvider, useTextSize } from '@/contexts/text-size-context';

describe('text size persistence', () => {
  beforeEach(() => { vi.mocked(localStorage.getItem).mockReset(); });

  it('keeps the preference usable when browser storage is unavailable', () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error('denied'); });
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('quota'); });
    try {
      const { result } = renderHook(useTextSize, { wrapper: TextSizeProvider });
      expect(result.current.textSize).toBe('default');
      act(() => result.current.setTextSize('large'));
      expect(result.current.textSize).toBe('large');
      expect(document.documentElement.style.fontSize).toBe('112%');
    } finally {
      vi.mocked(localStorage.getItem).mockReset();
      vi.mocked(localStorage.setItem).mockReset();
    }
  });

  it('rejects an unknown persisted size', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('toString');
    const { result } = renderHook(useTextSize, { wrapper: TextSizeProvider });
    expect(result.current.textSize).toBe('default');
  });
});
