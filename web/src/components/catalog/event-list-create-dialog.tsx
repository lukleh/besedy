"use client";

import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FormEvent } from "react";
import type { LocationItem } from "./event-list-types";

interface EventListCreateDialogProps {
  createOpen: boolean;
  dateDay: string;
  dateMonth: string;
  dateYear: string;
  description: string;
  isPending: boolean;
  locationId: string;
  metadataLocations: LocationItem[];
  sessionIndex: string;
  onDateDayChange: (value: string) => void;
  onDateMonthChange: (value: string) => void;
  onDateYearChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onLocationIdChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSessionIndexChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTitleChange: (value: string) => void;
  title: string;
}

export function EventListCreateDialog({
  createOpen,
  dateDay,
  dateMonth,
  dateYear,
  description,
  isPending,
  locationId,
  metadataLocations,
  sessionIndex,
  onDateDayChange,
  onDateMonthChange,
  onDateYearChange,
  onDescriptionChange,
  onLocationIdChange,
  onOpenChange,
  onSessionIndexChange,
  onSubmit,
  onTitleChange,
  title,
}: EventListCreateDialogProps) {
  const t = useTranslations("events.list");

  return (
    <Dialog open={createOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createDialogTitle")}</DialogTitle>
          <DialogDescription>{t("createDialogDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="event-location">{t("fieldLocation")}</Label>
            <select
              id="event-location"
              value={locationId}
              onChange={(event) => onLocationIdChange(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">{t("selectLocation")}</option>
              {metadataLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-2">
              <Label htmlFor="event-year">{t("fieldYear")}</Label>
              <Input
                id="event-year"
                value={dateYear}
                onChange={(event) => onDateYearChange(event.target.value)}
                placeholder={t("fieldYearPlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-month">{t("fieldMonth")}</Label>
              <Input
                id="event-month"
                value={dateMonth}
                onChange={(event) => onDateMonthChange(event.target.value)}
                placeholder={t("fieldMonthPlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-day">{t("fieldDay")}</Label>
              <Input
                id="event-day"
                value={dateDay}
                onChange={(event) => onDateDayChange(event.target.value)}
                placeholder={t("fieldDayPlaceholder")}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="event-session-index">{t("fieldSessionIndexOptional")}</Label>
            <Input
              id="event-session-index"
              value={sessionIndex}
              onChange={(event) => onSessionIndexChange(event.target.value)}
              placeholder={t("fieldSessionIndexPlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="event-title">{t("fieldTitleOptional")}</Label>
            <Input
              id="event-title"
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder={t("fieldTitlePlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="event-description">{t("fieldDescriptionOptional")}</Label>
            <Textarea
              id="event-description"
              value={description}
              onChange={(event) => onDescriptionChange(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
