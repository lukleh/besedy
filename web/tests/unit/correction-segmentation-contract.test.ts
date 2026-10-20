import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SEGMENTATION_PARAMS,
  SEGMENTATION_VERSION,
  SegmentationError,
  segmentTranscript,
} from '@/lib/correction/segmentation';
import { normalizeSpanText } from '@/lib/correction/text';

// The same file tests/test_correction_segmentation.py checks the Python
// reference against, so the web import and the training export cannot cut
// different spans.
const contract = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../contracts/correction-segmentation.json'),
    'utf-8',
  ),
) as {
  version: string;
  params: Record<string, number>;
  normalization: { input: string; expected: string; why: string }[];
  cases: {
    name: string;
    transcript: unknown;
    expected: { error: string } | { chunkCount: number; spans: unknown[] };
  }[];
};

describe('correction segmentation contract', () => {
  it("uses the contract's version and parameters", () => {
    expect(SEGMENTATION_VERSION).toBe(contract.version);
    expect({ ...SEGMENTATION_PARAMS }).toEqual(contract.params);
  });

  it.each(
    contract.normalization.map((example) => [example.why, example] as const),
  )('normalizes like Python: %s', (_why, example) => {
    expect(normalizeSpanText(example.input)).toBe(example.expected);
  });

  it.each(contract.cases.map((testCase) => [testCase.name, testCase] as const))(
    'cuts %s like Python',
    (_name, testCase) => {
      const expected = testCase.expected;
      if ('error' in expected) {
        let caught: unknown;
        try {
          segmentTranscript(testCase.transcript);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(SegmentationError);
        expect((caught as SegmentationError).code).toBe(expected.error);
        return;
      }
      const result = segmentTranscript(testCase.transcript);
      expect(result.chunkCount).toBe(expected.chunkCount);
      expect(
        result.spans.map(
          ({
            chunk,
            firstRegion,
            lastRegion,
            startSample,
            endSample,
            wordIndices,
            text,
          }) => ({
            chunk,
            firstRegion,
            lastRegion,
            startSample,
            endSample,
            wordIndices,
            text,
          }),
        ),
      ).toEqual(expected.spans);
    },
  );
});
