export function normalizeDeepSearchResultMarkdown(markdown: string): string {
  return normalizeFootnotes(normalizeMarkdownSpacing(markdown));
}

export function buildDeepSearchResultPdfFilename(
  jobId: string,
  query: string,
): string {
  const slug = slugify(query).slice(0, 64) || 'result';
  const shortJobId = jobId.slice(0, 8);
  return `deep-search-${slug}-${shortJobId}.pdf`;
}

function normalizeMarkdownSpacing(markdown: string): string {
  return markdown
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u180e\u200b\u200c\u200d\u2060\ufeff]/g, '')
    .normalize('NFC');
}

function normalizeFootnotes(markdown: string): string {
  return markdown
    .replace(/\[\^([^\]]+)\]:/g, '$1.')
    .replace(/\[\^([^\]]+)\]/g, '[$1]');
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
