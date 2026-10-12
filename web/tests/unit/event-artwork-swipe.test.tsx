import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifySwipe, EventArtworkSwipe } from '@/components/catalog/event-artwork-swipe';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  isRecordingPlaying: false,
  sequence: {
    previous: { id: 4 } as { id: number } | null,
    next: { id: 6 } as { id: number } | null,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('@/contexts/audio-playback-context', () => ({
  useAudioPlayback: () => ({ isRecordingPlaying: mocks.isRecordingPlaying }),
}));

vi.mock('@/hooks/use-event-sequence-navigation', () => ({
  useEventSequenceNavigation: () => mocks.sequence,
}));

const WIDTH = 390;

describe('classifySwipe', () => {
  it('reads a swipe to the left as next and to the right as previous', () => {
    expect(classifySwipe({ x: 300, y: 200 }, { x: 150, y: 210 }, WIDTH)).toBe('next');
    expect(classifySwipe({ x: 100, y: 200 }, { x: 250, y: 190 }, WIDTH)).toBe('previous');
  });

  it('ignores short, diagonal and vertical movement', () => {
    expect(classifySwipe({ x: 200, y: 200 }, { x: 150, y: 200 }, WIDTH)).toBeNull();
    expect(classifySwipe({ x: 300, y: 200 }, { x: 150, y: 290 }, WIDTH)).toBeNull();
    expect(classifySwipe({ x: 200, y: 100 }, { x: 205, y: 400 }, WIDTH)).toBeNull();
  });

  it('leaves swipes from the screen edges to the browser back gesture', () => {
    expect(classifySwipe({ x: 10, y: 200 }, { x: 200, y: 200 }, WIDTH)).toBeNull();
    expect(classifySwipe({ x: WIDTH - 10, y: 200 }, { x: 150, y: 200 }, WIDTH)).toBeNull();
  });
});

function swipeArea(eventId: number) {
  return (
    <EventArtworkSwipe catalogId="cat" eventId={eventId} showAllColumns={false} showReleaseState={false}>
      <span>Artwork</span>
    </EventArtworkSwipe>
  );
}

function renderSwipe() {
  const view = render(swipeArea(5));
  return { target: screen.getByTestId('event-artwork-swipe'), rerender: view.rerender };
}

function setZoom(scale: number) {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { scale, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
}

function swipe(target: HTMLElement, fromX: number, toX: number) {
  fireEvent.touchStart(target, { touches: [{ clientX: fromX, clientY: 200 }] });
  fireEvent.touchEnd(target, { touches: [], changedTouches: [{ clientX: toX, clientY: 200 }] });
}

describe('EventArtworkSwipe', () => {
  beforeEach(() => {
    mocks.push.mockClear();
    mocks.sequence = { previous: { id: 4 }, next: { id: 6 } };
    mocks.isRecordingPlaying = false;
    window.innerWidth = WIDTH;
    setZoom(1);
  });

  it('opens the next event on a swipe left, sliding forward in place', () => {
    swipe(renderSwipe().target, 300, 150);
    expect(mocks.push).toHaveBeenCalledWith('/catalog/cat/event/6', {
      scroll: false,
      transitionTypes: ['event-next'],
    });
  });

  it('opens the previous event on a swipe right, sliding back in place', () => {
    swipe(renderSwipe().target, 100, 250);
    expect(mocks.push).toHaveBeenCalledWith('/catalog/cat/event/4', {
      scroll: false,
      transitionTypes: ['event-previous'],
    });
  });

  it('opens one page per event, however often it is swiped before the next one loads', () => {
    const { target, rerender } = renderSwipe();
    swipe(target, 300, 150);
    swipe(target, 300, 150);
    expect(mocks.push).toHaveBeenCalledTimes(1);

    // Back on an event the swipe works again.
    rerender(swipeArea(6));
    rerender(swipeArea(5));
    swipe(target, 300, 150);
    expect(mocks.push).toHaveBeenCalledTimes(2);
  });

  it('does nothing at the end of the sequence', () => {
    mocks.sequence = { previous: { id: 4 }, next: null };
    swipe(renderSwipe().target, 300, 150);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('leaves the event alone while its recording plays', () => {
    mocks.isRecordingPlaying = true;
    swipe(renderSwipe().target, 300, 150);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('leaves a one-finger drag on a zoomed page to panning', () => {
    setZoom(2);
    swipe(renderSwipe().target, 300, 150);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('keeps sideways drags from the browser history gesture', () => {
    expect(renderSwipe().target).toHaveClass('touch-pan-y', 'touch-pinch-zoom');
  });

  it('leaves sideways drags to panning while the page is zoomed', () => {
    setZoom(2);
    expect(renderSwipe().target).not.toHaveClass('touch-pan-y');
  });

  it('ignores a gesture that used a second finger', () => {
    const { target } = renderSwipe();
    fireEvent.touchStart(target, { touches: [{ clientX: 300, clientY: 200 }] });
    fireEvent.touchMove(target, {
      touches: [
        { clientX: 280, clientY: 200 },
        { clientX: 100, clientY: 250 },
      ],
    });
    fireEvent.touchEnd(target, { touches: [], changedTouches: [{ clientX: 150, clientY: 200 }] });
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
