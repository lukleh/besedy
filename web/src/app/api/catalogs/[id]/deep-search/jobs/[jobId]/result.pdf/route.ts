import { NextRequest, NextResponse } from 'next/server';
import { badRequest, validateParams } from '@/lib/api';
import { requireAuth } from '@/lib/auth/permissions';
import { createDeepSearchResultPdfBuffer } from '@/lib/deep-search/pdf-export';
import { buildDeepSearchResultPdfFilename } from '@/lib/deep-search/result-markdown';
import { deepSearchJobSchema } from '@/lib/jobs-api/schemas';
import { fetchJobsApi } from '@/lib/jobs-api/server';
import {
  authorizeCatalogDeepSearchRead,
  DeepSearchJobParamSchema,
  handleDeepSearchRouteError,
  requireReadableDeepSearchJob,
} from '../../../route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string; jobId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireAuth();
    const paramsResult = validateParams(await params, DeepSearchJobParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, jobId } = paramsResult.data;

    const accessResponse = await authorizeCatalogDeepSearchRead(userId, catalogId);
    if (accessResponse) return accessResponse;

    const job = await fetchJobsApi(`/jobs/${encodeURIComponent(jobId)}`, {
      schema: deepSearchJobSchema,
    });
    const readableResponse = await requireReadableDeepSearchJob(job, {
      catalogId,
      userId,
    });
    if (readableResponse) return readableResponse;

    const markdown = getResultMarkdown(job.result);
    if (!markdown) {
      return badRequest('Deep search result PDF is not available');
    }

    const title = job.payload.query || 'Deep Search result';
    const filename = buildDeepSearchResultPdfFilename(job.id, title);
    const buffer = await createDeepSearchResultPdfBuffer({ markdown, title });
    const forceDownload = request.nextUrl.searchParams.get('download') === '1';

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/pdf',
        'Content-Length': String(buffer.byteLength),
        'Content-Disposition': getContentDisposition(filename, forceDownload),
      },
    });
  } catch (error) {
    return handleDeepSearchRouteError(error, 'fetch');
  }
}

function getResultMarkdown(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  const markdown = (result as { markdown?: unknown }).markdown;
  return typeof markdown === 'string' && markdown.trim() ? markdown : null;
}

function getContentDisposition(
  filename: string,
  forceDownload: boolean,
): string {
  const asciiFallback = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encodedFilename = encodeURIComponent(filename).replace(
    /['()]/g,
    escape,
  );
  const disposition = forceDownload ? 'attachment' : 'inline';
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;
}
