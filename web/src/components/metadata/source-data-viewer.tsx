"use client";

import { useTranslations } from "next-intl";
import {
  HardDrive,
  Archive,
  FileAudio,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { trimScanRoot } from "@/lib/utils";
import type { SourceMetadataFields, SourceArchivedFields } from "@/types/catalog";

interface SourceDataViewerProps {
  metadata: SourceMetadataFields | null;
  archived: SourceArchivedFields | null;
}

export function SourceDataViewer({ metadata, archived }: SourceDataViewerProps) {
  const t = useTranslations("sourceData");

  if (!metadata && !archived) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* File Info Section */}
        {metadata && (
          <section>
            <h4 className="font-medium flex items-center gap-2 mb-3 text-sm">
              <HardDrive className="h-4 w-4" />
              {t("fileInfo")}
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <DataRow label={t("filename")} value={metadata.filename} />
              <DataRow label={t("size")} value={metadata.sizeHuman} />
              <DataRow label={t("status")} value={metadata.status} />
              <DataRow label={t("duration")} value={metadata.duration} />
              <DataRow
                label={t("path")}
                value={metadata.fullPath ? trimScanRoot(metadata.fullPath, metadata.scanRoot) : undefined}
                title={metadata.fullPath}
                span={2}
                mono
              />
            </div>
          </section>
        )}

        <Separator />

        {/* Archived Info Section */}
        {archived && (
          <section>
            <h4 className="font-medium flex items-center gap-2 mb-3 text-sm">
              <Archive className="h-4 w-4" />
              {t("archivedInfo")}
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <DataRow label={t("format")} value={archived.format} />
              <DataRow
                label={t("archiveBitrate")}
                value={archived.bitrateKbps ? `${archived.bitrateKbps} kbps` : undefined}
              />
              <DataRow label={t("originalSize")} value={formatBytes(archived.originalSizeBytes)} />
              <DataRow label={t("compressedSize")} value={formatBytes(archived.compressedSizeBytes)} />
              <DataRow label={t("compressionRatio")} value={archived.compressionRatio} />
            </div>
          </section>
        )}

        <Separator />

        {/* Original Metadata Tags */}
        {metadata && (
          <section>
            <h4 className="font-medium flex items-center gap-2 mb-3 text-sm">
              <FileAudio className="h-4 w-4" />
              {t("metadataTags")}
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <DataRow label={t("tagTitle")} value={metadata.title} />
              <DataRow label={t("tagArtist")} value={metadata.artist} />
              <DataRow label={t("tagAlbum")} value={metadata.album} />
              <DataRow label={t("tagDate")} value={metadata.date} />
              <DataRow label={t("tagGenre")} value={metadata.genre} />
              <DataRow label={t("tagTrack")} value={metadata.track} />
              <DataRow label={t("tagEncodedBy")} value={metadata.encodedBy} />
              <DataRow label={t("tagEncoder")} value={metadata.encoder} />
              <DataRow label={t("tagComment")} value={metadata.comment} span={2} />
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

interface DataRowProps {
  label: string;
  value?: string | null;
  title?: string;
  span?: 1 | 2;
  mono?: boolean;
}

function DataRow({ label, value, title, span = 1, mono }: DataRowProps) {
  return (
    <div className={span === 2 ? "col-span-2" : ""}>
      <span className="text-muted-foreground">{label}:</span>{" "}
      <span className={mono ? "font-mono text-xs break-all" : ""} title={title}>
        {value || <span className="text-muted-foreground italic">-</span>}
      </span>
    </div>
  );
}

function formatBytes(bytesStr?: string): string | undefined {
  if (!bytesStr) return undefined;
  const bytes = parseInt(bytesStr, 10);
  if (isNaN(bytes)) return bytesStr;

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
