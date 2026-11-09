// Runtime copy of contracts/catalog-csv.json validation rules. The web image
// builds from web/ alone; catalog-csv-contract.test.ts checks this copy against
// the canonical file, whose rules are also checked against Python writers.
export const CATALOG_CSV_VALIDATION = {
  'metadata': {
    'requiredHeaders': [
      'Hash',
      'Hash Algorithm',
      'Filename',
      'Size (bytes)',
      'Size (human)',
      'Full Path',
      'Scan Root',
      'Status',
      'Duration',
      'added_at',
      'album',
      'artist',
      'comment',
      'date',
      'encoded_by',
      'encoder',
      'genre',
      'title',
      'track'
    ],
    'nonBlankCells': [
      'Hash',
      'Full Path'
    ]
  },
  'archived': {
    'requiredHeaders': [
      'Hash',
      'Original Path',
      'Compressed Path',
      'Compressed AAC Path',
      'Format',
      'Bitrate (kbps)',
      'Original Size (bytes)',
      'Compressed Size (bytes)',
      'Compressed AAC Size (bytes)',
      'Compressed AAC Bitrate (kbps)',
      'Compression Ratio',
      'Duration',
      'added_at'
    ],
    'nonBlankCells': [
      'Hash',
      'Original Path',
      'Compressed Path'
    ]
  },
  'duplicates': {
    'requiredHeaders': [
      'Hash',
      'Original Path',
      'Duplicate Path',
      'Scan Root',
      'Size (bytes)',
      'Size (human)',
      'Duration',
      'added_at',
      'album',
      'artist',
      'comment',
      'date',
      'encoded_by',
      'encoder',
      'genre',
      'title',
      'track'
    ],
    'nonBlankCells': [
      'Hash',
      'Duplicate Path'
    ]
  }
} as const;
