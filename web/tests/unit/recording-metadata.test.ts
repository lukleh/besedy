import { describe, expect, it } from 'vitest';
import { projectRecordingMetadata, resolveRecordingDisplay } from '@/lib/catalog-recordings/metadata';

describe('recording metadata projection', () => {
  it.each([
    { curatedTitle: 'Corrected', curatedArtist: 'Corrector', title: 'Corrected', artist: 'Corrector' },
    { curatedTitle: null, curatedArtist: null, title: 'Source', artist: 'Speaker' },
    { curatedTitle: '', curatedArtist: '', title: '', artist: '' },
  ])('uses one null/empty precedence rule for $title', ({ curatedTitle, curatedArtist, title, artist }) => {
    expect(resolveRecordingDisplay({ hash: 'hash', title: 'Source', artist: 'Speaker',
      curatedTitle, curatedArtist })).toEqual({ title, artist });
  });

  it('falls back to recording identity when neither source contains a title', () => {
    expect(resolveRecordingDisplay({ hash: 'hash' })).toEqual({ title: 'hash', artist: null });
  });

  it('does not expose extra relation fields through any reader', () => {
    const recorder = { id: 1, name: 'Recorder', workflowGroupId: 'private-source' };
    const projection = projectRecordingMetadata({ recorder, verifiedAt: new Date('2026-01-02T00:00:00Z') });
    expect(projection.recorder).toEqual({ id: 1, name: 'Recorder' });
    expect(projection.verifiedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(projection.recorderId).toBe(1);
  });
});
