"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { EventCatalogHealth } from "./catalog-settings-content-types";

interface CatalogSettingsEventHealthCardProps {
  catalogId: string;
  error: Error | null;
  health?: EventCatalogHealth;
  isLoading: boolean;
}

export function CatalogSettingsEventHealthCard({
  catalogId,
  error,
  health,
  isLoading,
}: CatalogSettingsEventHealthCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Event Catalog Health</CardTitle>
        <CardDescription>
          Backfill/publish readiness overview for this catalog
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error ? (
          <div className="text-sm text-destructive">
            {error.message}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Metric label="Total events" value={health?.totalEvents ?? 0} />
              <Metric label="Released" value={health?.releasedEvents ?? 0} />
              <Metric label="Unreleased" value={health?.unreleasedEvents ?? 0} />
              <Metric label="Unassigned recordings" value={health?.unassignedRecordings ?? 0} />
              <Metric label="Zero-recording events" value={health?.zeroRecordingEvents ?? 0} />
              <Metric label="Missing primary" value={health?.missingPrimaryEvents ?? 0} />
            </div>
            <div>
              <Link href={`/catalog/${catalogId}?tab=events`}>
                <Button variant="outline">Open Catalog Events</Button>
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}
