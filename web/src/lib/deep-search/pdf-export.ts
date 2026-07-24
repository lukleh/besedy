import type {
  Content,
  ContentTable,
  TDocumentDefinitions,
  TVirtualFileSystem,
} from 'pdfmake/interfaces';
import { normalizeDeepSearchResultMarkdown } from './result-markdown';

interface CreateDeepSearchResultPdfInput {
  markdown: string;
  title: string;
}

interface PdfMakeApi {
  addVirtualFileSystem(vfs: TVirtualFileSystem): void;
  createPdf(document: TDocumentDefinitions): {
    getBuffer(): Promise<Buffer>;
  };
}

export async function createDeepSearchResultPdfBuffer({
  markdown,
  title,
}: CreateDeepSearchResultPdfInput): Promise<Buffer> {
  const [pdfMakeModule, vfsModule] = await Promise.all([
    import('pdfmake/build/pdfmake.js'),
    import('pdfmake/build/vfs_fonts.js'),
  ]);

  const pdfMake = resolvePdfMakeModule(pdfMakeModule);
  pdfMake.addVirtualFileSystem(resolveVirtualFileSystem(vfsModule));
  return pdfMake
    .createPdf(buildDeepSearchResultPdfDocument(markdown, title))
    .getBuffer();
}

function resolveVirtualFileSystem(module: unknown): TVirtualFileSystem {
  const maybeDefault = (module as { default?: unknown }).default;
  return (maybeDefault ?? module) as TVirtualFileSystem;
}

function resolvePdfMakeModule(module: unknown): PdfMakeApi {
  const maybeDefault = (module as { default?: unknown }).default;
  return (maybeDefault ?? module) as PdfMakeApi;
}

export function buildDeepSearchResultPdfDocument(
  markdown: string,
  title: string,
): TDocumentDefinitions {
  const normalizedMarkdown = normalizeDeepSearchResultMarkdown(markdown);

  return {
    info: {
      title,
      subject: 'Deep Search result',
      creator: 'Besedy',
      producer: 'Besedy',
    },
    pageSize: 'A4',
    pageMargins: [48, 56, 48, 56],
    defaultStyle: {
      font: 'Roboto',
      fontSize: 10.5,
      lineHeight: 1.35,
    },
    styles: {
      documentTitle: {
        fontSize: 18,
        bold: true,
        margin: [0, 0, 0, 18],
      },
      heading1: {
        fontSize: 16,
        bold: true,
        margin: [0, 14, 0, 8],
      },
      heading2: {
        fontSize: 13,
        bold: true,
        margin: [0, 12, 0, 6],
      },
      heading3: {
        fontSize: 11.5,
        bold: true,
        margin: [0, 10, 0, 5],
      },
      paragraph: {
        margin: [0, 0, 0, 7],
      },
      quote: {
        italics: true,
        color: '#4b5563',
        margin: [12, 0, 0, 7],
      },
      code: {
        fontSize: 8.5,
        color: '#111827',
        background: '#f3f4f6',
        margin: [0, 2, 0, 8],
      },
      list: {
        margin: [12, 0, 0, 8],
      },
      table: {
        margin: [0, 2, 0, 10],
      },
    },
    content: [
      { text: title, style: 'documentTitle' },
      ...markdownToPdfContent(normalizedMarkdown),
    ],
  };
}

function markdownToPdfContent(markdown: string): Content[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const content: Content[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const codeFence = trimmed.match(/^```/);
    if (codeFence) {
      const codeLines: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !(lines[index] ?? '').trim().startsWith('```')
      ) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      content.push({ text: codeLines.join('\n'), style: 'code' });
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        tableLines.push(lines[index] ?? '');
        index += 1;
      }
      const table = markdownTableToPdf(tableLines);
      if (table) {
        content.push(table);
      }
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      content.push({
        text: stripInlineMarkdown(heading[2] ?? ''),
        style: `heading${heading[1]?.length ?? 1}`,
      });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (
        index < lines.length &&
        (lines[index] ?? '').trim().startsWith('>')
      ) {
        quoteLines.push((lines[index] ?? '').trim().replace(/^>\s?/, ''));
        index += 1;
      }
      content.push({
        text: stripInlineMarkdown(quoteLines.join(' ')),
        style: 'quote',
      });
      continue;
    }

    const unorderedList = collectList(lines, index, /^[-*+]\s+(.+)$/);
    if (unorderedList) {
      content.push({ ul: unorderedList.items, style: 'list' });
      index = unorderedList.nextIndex;
      continue;
    }

    const orderedList = collectList(lines, index, /^\d+[.)]\s+(.+)$/);
    if (orderedList) {
      content.push({ ol: orderedList.items, style: 'list' });
      index = orderedList.nextIndex;
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && isParagraphLine(lines, index)) {
      paragraphLines.push((lines[index] ?? '').trim());
      index += 1;
    }
    content.push({
      text: stripInlineMarkdown(paragraphLines.join(' ')),
      style: 'paragraph',
    });
  }

  return content.length ? content : [{ text: markdown, style: 'paragraph' }];
}

function collectList(
  lines: string[],
  startIndex: number,
  matcher: RegExp,
): { items: string[]; nextIndex: number } | null {
  const items: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = (lines[index] ?? '').trim().match(matcher);
    if (!match) {
      break;
    }
    items.push(stripInlineMarkdown(match[1] ?? ''));
    index += 1;
  }

  return items.length ? { items, nextIndex: index } : null;
}

function isParagraphLine(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^```/.test(trimmed)) return false;
  if (/^(#{1,6})\s+/.test(trimmed)) return false;
  if (/^>/.test(trimmed)) return false;
  if (/^[-*+]\s+/.test(trimmed)) return false;
  if (/^\d+[.)]\s+/.test(trimmed)) return false;
  if (isTableStart(lines, index)) return false;
  return true;
}

function isTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? '';
  const next = lines[index + 1] ?? '';
  return (
    current.includes('|') &&
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)
  );
}

function markdownTableToPdf(lines: string[]): ContentTable | null {
  if (lines.length < 2) {
    return null;
  }

  const rows = lines
    .filter((line, index) => index !== 1)
    .map(parseTableRow)
    .filter((row) => row.length > 0);
  const columnCount = Math.max(...rows.map((row) => row.length));
  if (!Number.isFinite(columnCount) || columnCount <= 0) {
    return null;
  }

  return {
    style: 'table',
    table: {
      headerRows: 1,
      widths: Array.from({ length: columnCount }, () => '*'),
      body: rows.map((row, rowIndex) =>
        Array.from({ length: columnCount }, (_, cellIndex) => ({
          text: stripInlineMarkdown(row[cellIndex] ?? ''),
          bold: rowIndex === 0,
          fillColor: rowIndex === 0 ? '#f3f4f6' : undefined,
          margin: [4, 3, 4, 3],
        })),
      ),
    },
    layout: 'lightHorizontalLines',
  };
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim();
}
