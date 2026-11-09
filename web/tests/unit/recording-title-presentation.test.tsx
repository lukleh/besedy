import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesktopCatalogTableRow } from '@/components/catalog/catalog-list/components/desktop-catalog-table-row';
import { MobileCardView } from '@/components/catalog/catalog-list/components/mobile-card-view';
import { useInlineEdit } from '@/components/catalog/inline-edit';
import { useColumnResize } from '@/hooks/use-column-resize';
import type { CatalogEntry } from '@/components/catalog/catalog-list/types';

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/offline/download-button', () => ({ DownloadButton: () => null }));

const entry: CatalogEntry = {
  hash: 'a'.repeat(64), filename: '2026-lecture.wav',
  hasArchived: true, hasMetadata: true, isActionable: true, isPublished: true,
  hasArchivedAudio: true, hasOriginalAudio: false,
};

function EditableRow() {
  const inlineEdit = useInlineEdit({ catalogId: '20260101_000000' });
  const columnResize = useColumnResize(['title']);
  return <>
    <button onClick={inlineEdit.toggleEditMode}>Edit metadata</button>
    <table><tbody><DesktopCatalogTableRow
      entry={entry} inlineEdit={inlineEdit} columnResize={columnResize}
      columnVisibility={{ title: true, date: false, part: false, location: false,
        recorder: false, duration: false, artist: false, album: false,
        status: false, verified: false, duplicates: false, offline: false }}
      allAlbums={[]} allLocations={[]} allRecorders={[]} isPublishing={false}
      onOpenRecording={vi.fn()} onTogglePublication={vi.fn()}
    /></tbody></table>
  </>;
}

describe('untitled recording presentation', () => {
  it('shows the filename in a mobile card', () => {
    render(<MobileCardView entries={[entry]} groupId="20260101_000000" />);
    expect(screen.getByText(entry.filename!)).toBeInTheDocument();
    expect(screen.queryByText(entry.hash)).not.toBeInTheDocument();
  });

  it('shows the filename on desktop but starts the title editor empty', () => {
    render(<EditableRow />);
    expect(screen.getByText(entry.filename!)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit metadata' }));
    fireEvent.click(screen.getByText(entry.filename!));
    expect(screen.getByPlaceholderText(entry.filename!)).toHaveValue('');
  });
});
