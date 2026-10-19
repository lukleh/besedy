import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  directionOfDrag,
  EventArtworkSwipe,
  shouldOpenOnRelease,
  startsAtScreenEdge,
} from '@/components/catalog/event-artwork-swipe';

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

// The test React build has no ViewTransition.
vi.mock('@/components/catalog/event-page-transition', () => ({
  EventArtworkTransition: ({ children }: { children: ReactNode }) => children,
}));

const WIDTH = 390;

describe('drag rules', () => {
  it('reads a drag to the left as next and to the right as previous', () => {
    expect(directionOfDrag(-150)).toBe('next');
    expect(directionOfDrag(150)).toBe('previous');
  });

  it('opens on a drag across a third of the artwork, or on a flick', () => {
    expect(shouldOpenOnRelease(-120, 0, WIDTH)).toBe(true);
    expect(shouldOpenOnRelease(-100, 0, WIDTH)).toBe(false);
    expect(shouldOpenOnRelease(-50, -0.8, WIDTH)).toBe(true);
    expect(shouldOpenOnRelease(-30, -0.8, WIDTH)).toBe(false);
    // Flicked back towards the start means changing one's mind.
    expect(shouldOpenOnRelease(-80, 0.8, WIDTH)).toBe(false);
  });

  it('needs no longer drag on a wide artwork than on a phone', () => {
    expect(shouldOpenOnRelease(-120, 0, 1100)).toBe(true);
    expect(shouldOpenOnRelease(-100, 0, 1100)).toBe(false);
  });

  it('leaves touches from the screen edges to the browser back gesture', () => {
    expect(startsAtScreenEdge(10, WIDTH)).toBe(true);
    expect(startsAtScreenEdge(WIDTH - 10, WIDTH)).toBe(true);
    expect(startsAtScreenEdge(200, WIDTH)).toBe(false);
  });
});

function swipeArea(eventId: number) {
  return (
    <EventArtworkSwipe catalogId="cat" eventId={eventId} showAllColumns={false} showReleaseState={false}>
      <span>Artwork</span>
    </EventArtworkSwipe>
  );
}

let queryClient: QueryClient;

function withQueryClient(ui: ReactNode) {
  return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
}

/** Marks a neighbour's event as already loaded, with published artwork. */
function loadEvent(eventId: number) {
  queryClient.setQueryData(['catalog-event-detail', 'cat', eventId], {
    publishedArtwork: { id: `art-${eventId}` },
    canViewArtworkCandidates: false,
    latestDraftCandidate: null,
  });
}

function setReducedMotion(reduce: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

function renderSwipe() {
  const view = render(withQueryClient(swipeArea(5)));
  return {
    target: screen.getByTestId('event-artwork-swipe'),
    track: screen.getByTestId('event-artwork-track'),
    rerender: (ui: ReactNode) => view.rerender(withQueryClient(ui)),
    unmount: view.unmount,
  };
}

function setZoom(scale: number) {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { scale, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
}

let now = 0;

function touch(target: HTMLElement, type: 'start' | 'move', x: number, y = 200) {
  const touches = [{ clientX: x, clientY: y }];
  if (type === 'start') fireEvent.touchStart(target, { touches });
  else fireEvent.touchMove(target, { touches });
}

/** Drags through the given x positions, `msPerStep` apart, without letting go. */
function dragThrough(target: HTMLElement, xs: number[], msPerStep = 100) {
  touch(target, 'start', xs[0]);
  for (const x of xs.slice(1)) {
    now += msPerStep;
    touch(target, 'move', x);
  }
}

function drag(target: HTMLElement, xs: number[], msPerStep = 100) {
  dragThrough(target, xs, msPerStep);
  fireEvent.touchEnd(target, { touches: [] });
}

describe('EventArtworkSwipe', () => {
  beforeEach(() => {
    mocks.push.mockClear();
    mocks.sequence = { previous: { id: 4 }, next: { id: 6 } };
    mocks.isRecordingPlaying = false;
    window.innerWidth = WIDTH;
    setZoom(1);
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    queryClient = new QueryClient();
    setReducedMotion(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    queryClient.clear();
  });

  it('moves the artwork with the finger', () => {
    const { target, track } = renderSwipe();
    dragThrough(target, [300, 280, 250]);
    expect(track.style.transform).toBe('translateX(-50px)');
    expect(track.style.transition).toBe('none');
  });

  it('opens the next event when dragged left far enough, sliding forward in place', () => {
    drag(renderSwipe().target, [300, 250, 200, 150]);
    expect(mocks.push).toHaveBeenCalledWith('/catalog/cat/event/6', {
      scroll: false,
      transitionTypes: ['event-next'],
    });
  });

  it('opens the previous event when dragged right far enough, sliding back in place', () => {
    drag(renderSwipe().target, [100, 150, 200, 250]);
    expect(mocks.push).toHaveBeenCalledWith('/catalog/cat/event/4', {
      scroll: false,
      transitionTypes: ['event-previous'],
    });
  });

  it('opens the next event on a short quick flick', () => {
    drag(renderSwipe().target, [300, 275, 250], 25);
    expect(mocks.push).toHaveBeenCalledWith('/catalog/cat/event/6', expect.anything());
  });

  it('springs back when the finger stopped before letting go', () => {
    const { target, track } = renderSwipe();
    dragThrough(target, [300, 275, 250], 25);
    now += 300;
    fireEvent.touchEnd(target, { touches: [] });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(track.style.transform).toBe('');
  });

  it('centres an unfinished drag again when the next touch starts', () => {
    const { target, track } = renderSwipe();
    dragThrough(target, [300, 250, 200]);
    touch(target, 'start', 300);
    expect(track.style.transform).toBe('');
  });

  it('springs back when let go too early', () => {
    const { target, track } = renderSwipe();
    drag(target, [300, 275, 250], 200);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(track.style.transform).toBe('');
    expect(track.style.transition).toBe('');
  });

  it('opens one page per event, however often it is swiped before the next one loads', () => {
    const { target, rerender } = renderSwipe();
    drag(target, [300, 250, 200, 150]);
    drag(target, [300, 250, 200, 150]);
    expect(mocks.push).toHaveBeenCalledTimes(1);

    // Back on an event the swipe works again.
    rerender(swipeArea(6));
    rerender(swipeArea(5));
    drag(target, [300, 250, 200, 150]);
    expect(mocks.push).toHaveBeenCalledTimes(2);
  });

  it('resists and springs back at the end of the sequence', () => {
    mocks.sequence = { previous: { id: 4 }, next: null };
    const { target, track } = renderSwipe();
    dragThrough(target, [300, 250, 200]);
    expect(track.style.transform).toBe('translateX(-30px)');
    fireEvent.touchEnd(target, { touches: [] });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(track.style.transform).toBe('');
  });

  it('leaves an upright movement to scrolling', () => {
    const { target, track } = renderSwipe();
    touch(target, 'start', 300, 200);
    now += 50;
    touch(target, 'move', 302, 240);
    now += 50;
    touch(target, 'move', 150, 260);
    fireEvent.touchEnd(target, { touches: [] });
    expect(track.style.transform).toBe('');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('leaves drags from the screen edges to the browser back gesture', () => {
    const { target, track } = renderSwipe();
    drag(target, [10, 100, 200]);
    drag(target, [WIDTH - 10, 300, 200]);
    expect(track.style.transform).toBe('');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('leaves the artwork alone while its recording plays', () => {
    mocks.isRecordingPlaying = true;
    const { target, track } = renderSwipe();
    dragThrough(target, [300, 250, 200]);
    expect(track.style.transform).toBe('');
    fireEvent.touchEnd(target, { touches: [] });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('leaves a one-finger drag on a zoomed page to panning', () => {
    setZoom(2);
    const { target, track } = renderSwipe();
    drag(target, [300, 250, 200, 150]);
    expect(track.style.transform).toBe('');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('keeps sideways drags from the browser history gesture', () => {
    expect(renderSwipe().target).toHaveClass('touch-pan-y', 'touch-pinch-zoom');
  });

  it('leaves sideways drags to panning while the page is zoomed', () => {
    setZoom(2);
    expect(renderSwipe().target).not.toHaveClass('touch-pan-y');
  });

  it('springs back when a second finger joins', () => {
    const { target, track } = renderSwipe();
    dragThrough(target, [300, 250]);
    fireEvent.touchMove(target, {
      touches: [
        { clientX: 200, clientY: 200 },
        { clientX: 100, clientY: 250 },
      ],
    });
    fireEvent.touchEnd(target, { touches: [] });
    expect(track.style.transform).toBe('');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('springs back when the browser cancels the touch', () => {
    const { target, track } = renderSwipe();
    dragThrough(target, [300, 250, 200]);
    fireEvent.touchCancel(target, { touches: [] });
    expect(track.style.transform).toBe('');
    fireEvent.touchEnd(target, { touches: [] });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  describe('with the neighbours already loaded', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    it('shows their artwork beside it, hidden from assistive technology', () => {
      loadEvent(4);
      loadEvent(6);
      renderSwipe();
      const left = screen.getByTestId('event-artwork-neighbor-left');
      const right = screen.getByTestId('event-artwork-neighbor-right');
      expect(left).toHaveAttribute('aria-hidden', 'true');
      expect(right).toHaveAttribute('aria-hidden', 'true');
      expect(left.querySelector('img')?.getAttribute('src')).toContain('art-4');
      expect(right.querySelector('img')?.getAttribute('src')).toContain('art-6');
    });

    it('shows nothing beside it for events not loaded yet', () => {
      renderSwipe();
      expect(screen.queryByTestId('event-artwork-neighbor-left')).toBeNull();
      expect(screen.queryByTestId('event-artwork-neighbor-right')).toBeNull();
    });

    it('brings the next artwork into place before opening its event', () => {
      loadEvent(6);
      const { target, track } = renderSwipe();
      drag(target, [300, 250, 200, 150]);
      expect(track.style.transform).toBe('translateX(-406px)');
      expect(mocks.push).not.toHaveBeenCalled();

      // Something inside the artwork finishing does not count.
      fireEvent.transitionEnd(track.firstElementChild!);
      expect(mocks.push).not.toHaveBeenCalled();

      fireEvent.transitionEnd(track);
      expect(mocks.push).toHaveBeenCalledWith('/catalog/cat/event/6', {
        scroll: false,
        transitionTypes: ['event-next', 'event-artwork-carried'],
      });
      // The fallback does not open it a second time.
      vi.advanceTimersByTime(300);
      expect(mocks.push).toHaveBeenCalledTimes(1);
    });

    it('opens the event anyway when the end of the move is never reported', () => {
      loadEvent(6);
      const { target } = renderSwipe();
      drag(target, [300, 250, 200, 150]);
      vi.advanceTimersByTime(299);
      expect(mocks.push).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(mocks.push).toHaveBeenCalledTimes(1);
    });

    it('brings the previous artwork into place from the other side', () => {
      loadEvent(4);
      const { target, track } = renderSwipe();
      drag(target, [100, 150, 200, 250]);
      expect(track.style.transform).toBe('translateX(406px)');
      fireEvent.transitionEnd(track);
      expect(mocks.push).toHaveBeenCalledWith('/catalog/cat/event/4', {
        scroll: false,
        transitionTypes: ['event-previous', 'event-artwork-carried'],
      });
    });

    it('opens at once under reduced motion', () => {
      setReducedMotion(true);
      loadEvent(6);
      const { target, track } = renderSwipe();
      drag(target, [300, 250, 200, 150]);
      expect(track.style.transition).toBe('none');
      expect(mocks.push).toHaveBeenCalledWith('/catalog/cat/event/6', {
        scroll: false,
        transitionTypes: ['event-next', 'event-artwork-carried'],
      });
    });

    it('opens nothing once the page has left the event', () => {
      loadEvent(6);
      const { target, unmount } = renderSwipe();
      drag(target, [300, 250, 200, 150]);
      unmount();
      vi.advanceTimersByTime(300);
      expect(mocks.push).not.toHaveBeenCalled();
    });
  });
});
