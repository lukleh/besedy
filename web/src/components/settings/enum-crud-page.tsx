"use client";

import { useState } from "react";
import type { MouseEvent, KeyboardEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { formatRelativeTime } from "@/lib/date-format";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Check,
  X,
  LucideIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useActiveGroup } from "@/hooks/use-active-group";
import { fetchJson } from "@/lib/api/fetch-json";

/**
 * Configuration for the enum CRUD page.
 */
export interface EnumCrudConfig {
  /** Entity type name (used for translation keys and API) */
  entityName: "recorder" | "location" | "album";
  /** Base API path for CRUD operations */
  apiPath: string;
  /** Icon component to display */
  icon: LucideIcon;
  /** React Query cache key */
  queryKey: string[];
}

interface EnumItem {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  _count: {
    audioMetadata: number;
  };
}

const MAX_NAME_LENGTH = 255;
const ROW_ACTION_SELECTOR =
  "button, a, input, textarea, select, [role='menuitem']";

const FILTER_PARAM_BY_ENTITY: Record<EnumCrudConfig["entityName"], string> = {
  recorder: "recorder",
  location: "location",
  album: "album",
};

/**
 * Generic CRUD page component for enum-like entities (recorders, locations).
 * Provides list, create, update, and delete functionality with a consistent UI.
 */
export function EnumCrudPage({ config }: { config: EnumCrudConfig }) {
  const { entityName, apiPath, icon: Icon, queryKey } = config;
  const t = useTranslations("enums");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { activeGroupId } = useActiveGroup();

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    item: EnumItem;
  } | null>(null);

  // Translation key helpers
  const pluralMap: Record<EnumCrudConfig["entityName"], string> = {
    recorder: "recorders",
    location: "locations",
    album: "albums",
  };
  const plural = pluralMap[entityName];
  const capitalizedEntity = entityName.charAt(0).toUpperCase() + entityName.slice(1);

  // Fetch items
  const { data: items, isLoading } = useQuery<EnumItem[]>({
    queryKey,
    queryFn: () => fetchJson<EnumItem[]>(apiPath),
  });

  // Create item
  const createItem = useMutation({
    mutationFn: async (name: string) => {
      return fetchJson(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setNewName("");
      toast({
        title: t("created"),
        description: t(`${entityName}Created`),
      });
    },
    onError: (error: Error) => {
      toast({
        title: tCommon("error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Update item
  const updateItem = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      return fetchJson(`${apiPath}/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    },
    onSuccess: async () => {
      // Wait for data refetch to complete before clearing edit state
      // This prevents a race condition where the old row and new row both appear briefly
      await queryClient.invalidateQueries({ queryKey });
      setEditingId(null);
      toast({
        title: t("updated"),
        description: t(`${entityName}Updated`),
      });
    },
    onError: (error: Error) => {
      toast({
        title: tCommon("error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Delete item
  const deleteItem = useMutation({
    mutationFn: async (id: number) => {
      return fetchJson(`${apiPath}/${id}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setDeleteDialog(null);
      toast({
        title: t("deleted"),
        description: t(`${entityName}Deleted`),
      });
    },
    onError: (error: Error) => {
      toast({
        title: tCommon("error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleCreate = () => {
    if (newName.trim()) {
      createItem.mutate(newName.trim());
    }
  };

  const handleUpdate = (id: number) => {
    if (editingName.trim()) {
      updateItem.mutate({ id, name: editingName.trim() });
    }
  };

  const startEditing = (item: EnumItem) => {
    setEditingId(item.id);
    setEditingName(item.name);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditingName("");
  };

  const navigateToCatalog = (item: EnumItem) => {
    const filterKey = FILTER_PARAM_BY_ENTITY[entityName];
    const params = new URLSearchParams({ [filterKey]: item.id.toString() });
    const basePath = activeGroupId ? `/catalog/${activeGroupId}` : "/catalog";
    router.push(`${basePath}?${params.toString()}`);
  };

  const handleRowClick = (item: EnumItem, event: MouseEvent<HTMLTableRowElement>) => {
    if (editingId === item.id) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(ROW_ACTION_SELECTOR)) return;
    navigateToCatalog(item);
  };

  const handleRowKeyDown = (item: EnumItem, event: KeyboardEvent<HTMLTableRowElement>) => {
    if (editingId === item.id) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(ROW_ACTION_SELECTOR)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      navigateToCatalog(item);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Icon className="h-6 w-6" />
        <h1 className="text-2xl font-bold">{t(plural)}</h1>
      </div>

      {/* Add new item */}
      <div className="flex gap-2 max-w-md">
        <Input
          placeholder={t(`new${capitalizedEntity}Placeholder`)}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          disabled={createItem.isPending}
          maxLength={MAX_NAME_LENGTH}
        />
        <Button
          onClick={handleCreate}
          disabled={!newName.trim() || createItem.isPending}
        >
          {createItem.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          <span className="ml-2">{t("add")}</span>
        </Button>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : items && items.length > 0 ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("usageCount")}</TableHead>
                <TableHead className="hidden md:table-cell landscape-mobile:hidden">{t("created")}</TableHead>
                <TableHead className="w-[100px]">{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  key={item.id}
                  className={editingId === item.id ? "" : "cursor-pointer transition-colors hover:bg-muted/50"}
                  role={editingId === item.id ? undefined : "button"}
                  tabIndex={editingId === item.id ? undefined : 0}
                  onClick={(event) => handleRowClick(item, event)}
                  onKeyDown={(event) => handleRowKeyDown(item, event)}
                >
                  <TableCell>
                    {editingId === item.id ? (
                      <div className="flex items-center gap-2">
                        <Input
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleUpdate(item.id);
                            if (e.key === "Escape") cancelEditing();
                          }}
                          className="h-8 max-w-[200px]"
                          autoFocus
                          maxLength={MAX_NAME_LENGTH}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => handleUpdate(item.id)}
                          disabled={updateItem.isPending}
                          aria-label={tCommon("save")}
                        >
                          {updateItem.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4 text-green-600" />
                          )}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={cancelEditing}
                          aria-label={tCommon("cancel")}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <span className="font-medium">{item.name}</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant="secondary">
                      {item._count.audioMetadata}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell landscape-mobile:hidden text-muted-foreground text-sm">
                    {formatRelativeTime(item.createdAt, locale)}
                  </TableCell>
                  <TableCell>
                    {editingId !== item.id && (
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => startEditing(item)}
                          aria-label={tCommon("edit")}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => setDeleteDialog({ open: true, item })}
                          aria-label={t("delete")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          <Icon className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>{t(`no${capitalizedEntity}s`)}</p>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={deleteDialog?.open ?? false}
        onOpenChange={(open) => !open && setDeleteDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(`confirmDelete${capitalizedEntity}`, { name: deleteDialog?.item.name ?? "" })}
              {deleteDialog?.item._count.audioMetadata ? (
                <span className="block mt-2 text-amber-600">
                  {t("usedByRecordings", { count: deleteDialog.item._count.audioMetadata })}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteDialog && deleteItem.mutate(deleteDialog.item.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteItem.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
