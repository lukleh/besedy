import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSequenceNavigation } from '@/components/catalog/event-sequence-navigation';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  prefetchNeighbors: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));

const neighbor = (id: number) => ({ id, dateYear: 2024, dateMonth: 1, dateDay: id, location: null });
const sequenceStates = [{ sortKey: 'date', sortDir: 'desc' }];

vi.mock('@/hooks/use-event-sequence-navigation', () => ({
  useEventSequenceNavigation: () => ({
    previous: neighbor(4),
    next: neighbor(6),
    position: 2,
    total: 3,
    isLoading: false,
    sequenceStates,
  }),
}));
vi.mock('@/hooks/use-prefetch-event-neighbors', () => ({
  usePrefetchEventNeighbors: (...args: unknown[]) => mocks.prefetchNeighbors(...args),
}));

describe('EventSequenceNavigation', () => {
  beforeEach(() => {
    mocks.push.mockClear();
    mocks.prefetchNeighbors.mockClear();
    render(<EventSequenceNavigation catalogId="cat" eventId={5} showAllColumns={false} showReleaseState={false} />);
  });

  it('slides forward to the next event and back to the previous one', () => {
    fireEvent.click(screen.getByRole('button', { name: /next/ }));
    expect(mocks.push).toHaveBeenLastCalledWith('/catalog/cat/event/6', { transitionTypes: ['event-next'] });

    fireEvent.click(screen.getByRole('button', { name: /previous/ }));
    expect(mocks.push).toHaveBeenLastCalledWith('/catalog/cat/event/4', { transitionTypes: ['event-previous'] });
  });

  it('preloads both neighbors in the same list order', () => {
    expect(mocks.prefetchNeighbors).toHaveBeenCalledWith('cat', [4, 6], sequenceStates);
  });
});
