"use client";

import { useState, useCallback, useId } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations, useLocale } from "next-intl";
import { formatLocalDate } from "@/lib/date-format";
import { parseDateFromString } from "@/lib/date-utils";
import {
  Check,
  Copy,
  Loader2,
  Save,
  X,
  Tag,
  FileText,
  CheckCircle,
  Mic,
  MapPin,
  Hash,
  Disc,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { copyToClipboard } from "@/lib/clipboard";
import { useRecorders, useLocations, useAlbums, MetadataRecorder, MetadataLocation, MetadataAlbum } from "@/hooks/use-metadata-enums";
import { fetchJson } from "@/lib/api/fetch-json";

interface SourceMetadata {
  title?: string;
  artist?: string;
  album?: string;
  date?: string;
}

interface CuratedMetadata {
  hash: string;
  curated: boolean;
  title?: string | null;
  artist?: string | null;
  albumId?: number | null;
  album?: MetadataAlbum | null;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  notes?: string | null;
  tags?: string[];
  verified?: boolean;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  recorderId?: number | null;
  locationId?: number | null;
  part?: number | null;
  recorder?: MetadataRecorder | null;
  location?: MetadataLocation | null;
}

interface MetadataEditorProps {
  hash: string;
  source: SourceMetadata;
  groupId?: string;
}

interface MetadataEditorFormProps {
  hash: string;
  source: SourceMetadata;
  groupId?: string;
  groupKey: string;
  curated: CuratedMetadata;
  recorders: MetadataRecorder[];
  locations: MetadataLocation[];
  albums: MetadataAlbum[];
}

export function MetadataEditor({ hash, source, groupId }: MetadataEditorProps) {
  const groupKey = groupId || "default";

  // Fetch enum data for dropdowns
  const { data: recorders } = useRecorders();
  const { data: locations } = useLocations();
  const { data: albums } = useAlbums();

  // Fetch curated metadata - use nested catalog path when groupId is available
  const { data: curated, isLoading } = useQuery<CuratedMetadata>({
    queryKey: ["recording-metadata", hash, groupKey],
    queryFn: async () => {
      const url = groupId
        ? `/api/catalogs/${groupId}/recordings/${hash}/metadata`
        : `/api/metadata/${hash}`;
      return fetchJson<CuratedMetadata>(url);
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!curated) return null;

  return (
    <MetadataEditorForm
      key={`${groupKey}:${hash}`}
      hash={hash}
      source={source}
      groupId={groupId}
      groupKey={groupKey}
      curated={curated}
      recorders={recorders ?? []}
      locations={locations ?? []}
      albums={albums ?? []}
    />
  );
}

function MetadataEditorForm({
  hash,
  source,
  groupId,
  groupKey,
  curated,
  recorders,
  locations,
  albums,
}: MetadataEditorFormProps) {
  const t = useTranslations("metadata");
  const tCommon = useTranslations("common");
  const tCatalog = useTranslations("catalog");
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Local form state
  const [title, setTitle] = useState<string>(() => curated.title || "");
  const [artist, setArtist] = useState<string>(() => curated.artist || "");
  const [albumId, setAlbumId] = useState<string>(() => curated.albumId?.toString() || "");
  // Parse source.date as fallback when ALL curated date fields are empty
  const sourceDateParts = (() => {
    if (curated.dateYear || curated.dateMonth || curated.dateDay) return null;
    return parseDateFromString(source.date);
  })();
  const [dateYear, setDateYear] = useState<string>(
    () => curated.dateYear?.toString() || sourceDateParts?.year?.toString() || ""
  );
  const [dateMonth, setDateMonth] = useState<string>(
    () => curated.dateMonth?.toString() || sourceDateParts?.month?.toString() || ""
  );
  const [dateDay, setDateDay] = useState<string>(
    () => curated.dateDay?.toString() || sourceDateParts?.day?.toString() || ""
  );
  const [notes, setNotes] = useState<string>(() => curated.notes || "");
  const [tags, setTags] = useState<string[]>(() => curated.tags || []);
  const [tagInput, setTagInput] = useState<string>("");
  const [verified, setVerified] = useState<boolean>(() => curated.verified || false);
  const [recorderId, setRecorderId] = useState<string>(() => curated.recorderId?.toString() || "");
  const [locationId, setLocationId] = useState<string>(() => curated.locationId?.toString() || "");
  const [part, setPart] = useState<string>(() => curated.part?.toString() || "");
  const [copiedHash, setCopiedHash] = useState(false);

  // Copy hash to clipboard
  const copyHashToClipboard = useCallback(async () => {
    try {
      await copyToClipboard(hash);
      setCopiedHash(true);
      setTimeout(() => setCopiedHash(false), 2000);
    } catch (err) {
      console.error("Failed to copy hash:", err);
      toast({
        title: tCommon("error"),
        description: "Failed to copy to clipboard",
        variant: "destructive",
      });
    }
  }, [hash, toast, tCommon]);

  // Save mutation - use nested catalog path when groupId is available
  const saveMutation = useMutation({
    mutationFn: async (data: Partial<CuratedMetadata>) => {
      const url = groupId
        ? `/api/catalogs/${groupId}/recordings/${hash}/metadata`
        : `/api/metadata/${hash}`;
      return fetchJson(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recording-metadata", hash, groupKey] });
      queryClient.invalidateQueries({ queryKey: ["catalog", groupKey] });
      toast({
        title: t("saved"),
        description: t("savedDescription"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSave = useCallback(() => {
    saveMutation.mutate({
      title: title || null,
      artist: artist || null,
      albumId: albumId ? parseInt(albumId) : null,
      dateYear: dateYear ? parseInt(dateYear) : null,
      dateMonth: dateMonth ? parseInt(dateMonth) : null,
      dateDay: dateDay ? parseInt(dateDay) : null,
      notes: notes || null,
      tags,
      verified,
      recorderId: recorderId ? parseInt(recorderId) : null,
      locationId: locationId ? parseInt(locationId) : null,
      part: part ? parseInt(part) : null,
    });
  }, [title, artist, albumId, dateYear, dateMonth, dateDay, notes, tags, verified, recorderId, locationId, part, saveMutation]);

  // Copy source value to curated
  const copyFromSource = (field: "title" | "artist" | "date") => {
    if (field === "title" && source.title) {
      setTitle(source.title);
    } else if (field === "artist" && source.artist) {
      setArtist(source.artist);
    } else if (field === "date" && source.date) {
      // Use parseDateFromString for consistent behavior with initial state
      const parsed = parseDateFromString(source.date);
      if (parsed) {
        setDateYear(parsed.year?.toString() || "");
        setDateMonth(parsed.month?.toString() || "");
        setDateDay(parsed.day?.toString() || "");
      }
    }
  };

  // Tag management
  const addTag = () => {
    const trimmed = tagInput.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
      setTagInput("");
    }
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">{t("title")}</CardTitle>
            <CardDescription>
              {curated?.curated ? t("editCurated") : t("addCurated")}
            </CardDescription>
          </div>
          <Button onClick={handleSave} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {tCommon("save")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Title */}
        <FieldEditor
          label={tCatalog("columns.title")}
          sourceValue={source.title}
          value={title}
          onChange={setTitle}
          onCopyFromSource={() => copyFromSource("title")}
          onClear={() => setTitle("")}
          t={t}
        />

        {/* Artist */}
        <FieldEditor
          label={t("artist")}
          sourceValue={source.artist}
          value={artist}
          onChange={setArtist}
          onCopyFromSource={() => copyFromSource("artist")}
          onClear={() => setArtist("")}
          t={t}
        />

        {/* Album */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Disc className="h-4 w-4" />
              {t("album")}
            </Label>
            {albumId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setAlbumId("")}
                aria-label={t("clearField", { field: t("album") })}
              >
                <X className="mr-1 h-3 w-3" />
                {t("clear")}
              </Button>
            )}
          </div>
          {source.album && (
            <div className="text-xs text-muted-foreground">
              {t("source")}: {source.album}
            </div>
          )}
          <Select value={albumId || "none"} onValueChange={(v) => setAlbumId(v === "none" ? "" : v)}>
            <SelectTrigger>
              <SelectValue placeholder={t("albumPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{tCommon("none")}</SelectItem>
              {albums?.map((album) => (
                <SelectItem key={album.id} value={album.id.toString()}>
                  {album.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Date */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t("date")}</Label>
            <div className="flex items-center gap-1">
              {(dateYear || dateMonth || dateDay) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    setDateYear("");
                    setDateMonth("");
                    setDateDay("");
                  }}
                  aria-label={t("clearField", { field: t("date") })}
                >
                  <X className="mr-1 h-3 w-3" />
                  {t("clear")}
                </Button>
              )}
              {source.date && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => copyFromSource("date")}
                >
                  <Copy className="mr-1 h-3 w-3" />
                  {t("useSource")}: {source.date}
                </Button>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                placeholder={t("year")}
                value={dateYear}
                onChange={(e) => setDateYear(e.target.value)}
                type="number"
                min="1900"
                max="2100"
              />
            </div>
            <div className="w-20">
              <Input
                placeholder={t("month")}
                value={dateMonth}
                onChange={(e) => setDateMonth(e.target.value)}
                type="number"
                min="1"
                max="12"
              />
            </div>
            <div className="w-20">
              <Input
                placeholder={t("day")}
                value={dateDay}
                onChange={(e) => setDateDay(e.target.value)}
                type="number"
                min="1"
                max="31"
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Recorder */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Mic className="h-4 w-4" />
              {t("recorder")}
            </Label>
            {recorderId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setRecorderId("")}
                aria-label={t("clearField", { field: t("recorder") })}
              >
                <X className="mr-1 h-3 w-3" />
                {t("clear")}
              </Button>
            )}
          </div>
          <Select value={recorderId || "none"} onValueChange={(v) => setRecorderId(v === "none" ? "" : v)}>
            <SelectTrigger>
              <SelectValue placeholder={t("recorderPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{tCommon("none")}</SelectItem>
              {recorders?.map((recorder) => (
                <SelectItem key={recorder.id} value={recorder.id.toString()}>
                  {recorder.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Part */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Hash className="h-4 w-4" />
              {t("part")}
            </Label>
            {part && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setPart("")}
                aria-label={t("clearField", { field: t("part") })}
              >
                <X className="mr-1 h-3 w-3" />
                {t("clear")}
              </Button>
            )}
          </div>
          <Input
            type="number"
            min="1"
            value={part}
            onChange={(e) => setPart(e.target.value)}
            placeholder={t("partPlaceholder")}
            className="w-32"
          />
        </div>

        {/* Location */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium flex items-center gap-2">
              <MapPin className="h-4 w-4" />
              {t("location")}
            </Label>
            {locationId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setLocationId("")}
                aria-label={t("clearField", { field: t("location") })}
              >
                <X className="mr-1 h-3 w-3" />
                {t("clear")}
              </Button>
            )}
          </div>
          <Select value={locationId || "none"} onValueChange={(v) => setLocationId(v === "none" ? "" : v)}>
            <SelectTrigger>
              <SelectValue placeholder={t("locationPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{tCommon("none")}</SelectItem>
              {locations?.map((location) => (
                <SelectItem key={location.id} value={location.id.toString()}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Separator />

        {/* Tags */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Tag className="h-4 w-4" />
            {t("tags")}
          </Label>
          <div className="flex gap-2">
            <Input
              placeholder={t("addTagPlaceholder")}
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              className="flex-1"
            />
            <Button type="button" variant="secondary" size="sm" onClick={addTag}>
              {t("add")}
            </Button>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1">
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Notes */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium flex items-center gap-2">
              <FileText className="h-4 w-4" />
              {t("notes")}
            </Label>
            {notes && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setNotes("")}
                aria-label={t("clearField", { field: t("notes") })}
              >
                <X className="mr-1 h-3 w-3" />
                {t("clear")}
              </Button>
            )}
          </div>
          <Textarea
            placeholder={t("notesPlaceholder")}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </div>

        <Separator />

        {/* Verified */}
        <div className="flex items-center space-x-2">
          <Checkbox
            id="verified"
            checked={verified}
            onCheckedChange={(checked) => setVerified(checked === true)}
          />
          <Label
            htmlFor="verified"
            className="text-sm font-medium flex items-center gap-2 cursor-pointer"
          >
            <CheckCircle className={`h-4 w-4 ${verified ? "text-green-600" : "text-muted-foreground"}`} />
            {t("markVerified")}
          </Label>
        </div>
        {curated?.verified && curated.verifiedAt && (
          <p className="text-xs text-muted-foreground ml-6">
            {t("verifiedAt", { date: formatLocalDate(curated.verifiedAt, locale) })}
          </p>
        )}

        {/* Technical Information */}
        {hash && (
          <>
            <Separator />
            <div className="space-y-2">
              <Label className="text-sm font-medium flex items-center gap-2">
                <Hash className="h-4 w-4" />
                {t("audioContentHash")}
              </Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded-md border bg-muted/50 text-xs font-mono truncate">
                  {hash}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={copyHashToClipboard}
                >
                  {copiedHash ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("audioContentHashDescription")}
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface FieldEditorProps {
  label: string;
  sourceValue?: string;
  value: string;
  onChange: (value: string) => void;
  onCopyFromSource: () => void;
  onClear: () => void;
  t: ReturnType<typeof useTranslations<"metadata">>;
}

function FieldEditor({
  label,
  sourceValue,
  value,
  onChange,
  onCopyFromSource,
  onClear,
  t,
}: FieldEditorProps) {
  const inputId = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium" htmlFor={inputId}>
          {label}
        </Label>
        <div className="flex items-center gap-1">
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onClear}
              aria-label={t("clearField", { field: label })}
            >
              <X className="mr-1 h-3 w-3" />
              {t("clear")}
            </Button>
          )}
          {sourceValue && sourceValue !== value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onCopyFromSource}
            >
              <Copy className="mr-1 h-3 w-3" />
              {t("useSource")}
            </Button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("source")}</span>
          <div className="h-9 px-3 py-2 rounded-md border bg-muted/50 text-sm truncate">
            {sourceValue || <span className="text-muted-foreground italic">{t("empty")}</span>}
          </div>
        </div>
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("curated")}</span>
          <Input
            id={inputId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("enterPlaceholder", { field: label.toLowerCase() })}
          />
        </div>
      </div>
      {sourceValue && value && sourceValue === value && (
        <div className="flex items-center gap-1 text-xs text-green-600">
          <Check className="h-3 w-3" />
          {t("matchesSource")}
        </div>
      )}
    </div>
  );
}
