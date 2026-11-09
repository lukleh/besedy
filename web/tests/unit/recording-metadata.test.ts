import { describe, expect, it } from 'vitest';
import { projectRecordingMetadata, resolveCatalogRecordingTitle, resolveRecordingDisplay, resolveRecordingMetadata } from '@/lib/catalog-recordings/metadata';

describe('recording metadata projection', () => {
  it.each([
    { curatedTitle: 'Corrected', curatedArtist: 'Corrector', title: 'Corrected', artist: 'Corrector' },
    { curatedTitle: null, curatedArtist: null, title: 'Source', artist: 'Speaker' },
    { curatedTitle: '', curatedArtist: '', title: '', artist: '' },
  ])('uses one null/empty precedence rule for $title', ({ curatedTitle, curatedArtist, title, artist }) => {
    expect(resolveRecordingMetadata({ hash: 'hash', title: 'Source', artist: 'Speaker',
      curatedTitle, curatedArtist })).toEqual({ title, artist });
  });

  it('falls back to recording identity when neither source contains a title', () => {
    expect(resolveRecordingDisplay({ hash: 'hash' })).toEqual({ title: 'hash', artist: null });
  });

  it('uses the filename as a label without storing it or the hash as editable title', () => {
    const entry = { hash: 'a'.repeat(64), filename: '2026-lecture.wav' };
    expect(resolveRecordingDisplay(entry).title).toBe('2026-lecture.wav');
    expect(resolveRecordingMetadata(entry).title).toBeNull();
  });

  it('keeps empty curated metadata while allowing a readable presentation fallback', () => {
    const entry = { hash: 'hash', title: 'Source', curatedTitle: '', filename: 'recording.wav' };
    expect(resolveRecordingMetadata(entry).title).toBe('');
    expect(resolveRecordingDisplay(entry).title).toBe('recording.wav');
    expect(resolveCatalogRecordingTitle('hash', { sourceTitle: 'Source', curatedTitle: '' })).toBe('');
  });

  it('does not expose extra relation fields through any reader', () => {
    const recorder = { id: 1, name: 'Recorder', workflowGroupId: 'private-source' };
    const projection = projectRecordingMetadata({ recorder, verifiedAt: new Date('2026-01-02T00:00:00Z') });
    expect(projection.recorder).toEqual({ id: 1, name: 'Recorder' });
    expect(projection.verifiedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(projection.recorderId).toBe(1);
  });
});
