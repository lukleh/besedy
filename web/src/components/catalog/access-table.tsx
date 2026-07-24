"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations, useLocale } from "next-intl";
import { formatRelativeTime } from "@/lib/date-format";
import {
  Pencil,
  Trash2,
  RotateCcw,
  Loader2,
  User as UserIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PermissionIcons } from "@/components/catalog/permission-icons";
import { AccessFormFields } from "@/components/catalog/access-form-fields";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { AccessLevel, AccessStatus } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/api/fetch-json";

const ACCESS_LEVEL_COLORS: Record<AccessLevel, string> = {
  LISTENER: "bg-slate-600 text-white",
  VIEWER: "bg-gray-600 text-white",
  MEMBER: "bg-blue-700 text-white",
  EDITOR: "bg-amber-700 text-white",
  OWNER: "bg-emerald-700 text-white",
};

interface UserInfo {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  status?: string;
}

interface AccessGrant {
  id: string;
  userId: string;
  accessLevel: AccessLevel;
  status: AccessStatus;
  notes: string | null;
  createdAt: string;
  revokedAt: string | null;
  user: UserInfo;
  grantedBy: { id: string; name: string | null; email: string | null } | null;
  revokedBy: { id: string; name: string | null; email: string | null } | null;
}

interface AccessTableProps {
  catalogId: string;
  accessList: AccessGrant[];
  canManageOwnerAccess: boolean;
  accessLevelFilter?: AccessLevel | "all" | "revoked";
  searchQuery?: string;
  onSuccess: () => void;
}

export function AccessTable({
  catalogId,
  accessList,
  canManageOwnerAccess,
  accessLevelFilter = "all",
  searchQuery = "",
  onSuccess,
}: AccessTableProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("catalogSettings");
  const locale = useLocale();

  const [editDialog, setEditDialog] = useState<AccessGrant | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<AccessGrant | null>(null);
  const [restoreDialog, setRestoreDialog] = useState<AccessGrant | null>(null);

  // Edit form state
  const [editAccessLevel, setEditAccessLevel] = useState<AccessLevel>("LISTENER");
  const [editUserName, setEditUserName] = useState("");
  const [editNotes, setEditNotes] = useState("");

  // Update access mutation
  const updateAccess = useMutation({
    mutationFn: async ({
      userId,
      accessLevel,
      notes,
      userName,
    }: {
      userId: string;
      accessLevel: AccessLevel;
      notes?: string;
      userName?: string;
    }) => {
      return fetchJson(`/api/catalogs/${catalogId}/access/${userId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessLevel, notes, userName }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["catalog-access", catalogId] });
      setEditDialog(null);
      onSuccess();
      toast({
        title: t("toasts.accessUpdated"),
        description: t("toasts.accessUpdatedDesc"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Revoke access mutation
  const revokeAccess = useMutation({
    mutationFn: async (userId: string) => {
      return fetchJson(`/api/catalogs/${catalogId}/access/${userId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["catalog-access", catalogId] });
      setDeleteDialog(null);
      onSuccess();
      toast({
        title: t("toasts.accessRevoked"),
        description: t("toasts.accessRevokedDesc"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Restore access mutation
  const restoreAccess = useMutation({
    mutationFn: async (userId: string) => {
      return fetchJson(`/api/catalogs/${catalogId}/access/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore" }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["catalog-access", catalogId] });
      setRestoreDialog(null);
      onSuccess();
      toast({
        title: t("toasts.accessRestored"),
        description: t("toasts.accessRestoredDesc"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const openEditDialog = (grant: AccessGrant) => {
    setEditAccessLevel(grant.accessLevel);
    setEditUserName(grant.user.name || "");
    setEditNotes(grant.notes || "");
    setEditDialog(grant);
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editDialog) return;

    updateAccess.mutate({
      userId: editDialog.userId,
      accessLevel: editAccessLevel,
      notes: editNotes || undefined,
      userName: editUserName || undefined,
    });
  };

  const getInitials = (name: string | null, email: string | null): string => {
    if (name) {
      return name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
    }
    if (email) {
      return email.slice(0, 2).toUpperCase();
    }
    return "??";
  };

  // Search matching helper
  const matchesSearch = (grant: AccessGrant) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      grant.user.name?.toLowerCase().includes(query) ||
      grant.user.email?.toLowerCase().includes(query)
    );
  };

  // Separate active and revoked users based on filter
  const isRevokedFilter = accessLevelFilter === "revoked";
  const activeUsers = isRevokedFilter
    ? []
    : accessList.filter((g) =>
        g.status === "ACTIVE" &&
        (accessLevelFilter === "all" || g.accessLevel === accessLevelFilter) &&
        matchesSearch(g)
      );
  const revokedUsers = accessList.filter((g) =>
    g.status === "REVOKED" &&
    (isRevokedFilter || accessLevelFilter === "all" || g.accessLevel === accessLevelFilter) &&
    matchesSearch(g)
  );

  return (
    <>
      <Table data-testid="access-table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[250px]">{t("table.user")}</TableHead>
            <TableHead>{t("table.access")}</TableHead>
            <TableHead>{t("table.grantedBy")}</TableHead>
            <TableHead>{t("table.notes")}</TableHead>
            <TableHead className="text-right">{t("table.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* Active users */}
          {activeUsers.map((grant) => (
            <TableRow key={grant.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {getInitials(grant.user.name, grant.user.email)}
                  </div>
                  <div>
                    <div className="font-medium">
                      {grant.user.name || t("table.noName")}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {grant.user.email}
                    </div>
                    {grant.user.status === "PENDING" && (
                      <Badge variant="outline" className="mt-1 text-xs">
                        {t("table.pending")}
                      </Badge>
                    )}
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Badge className={cn(ACCESS_LEVEL_COLORS[grant.accessLevel], "text-white")}>
                    {t(`accessLevels.${grant.accessLevel.toLowerCase()}`)}
                  </Badge>
                  <PermissionIcons accessLevel={grant.accessLevel} />
                </div>
              </TableCell>
              <TableCell>
                {grant.grantedBy ? (
                  <span className="text-sm">
                    {grant.grantedBy.name || grant.grantedBy.email}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {grant.notes || "—"}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  {/* Can edit if admin or if not OWNER level */}
                  {(canManageOwnerAccess || grant.accessLevel !== "OWNER") && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEditDialog(grant)}
                      aria-label={t("buttons.edit")}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  {/* Can revoke if admin or if not OWNER level */}
                  {(canManageOwnerAccess || grant.accessLevel !== "OWNER") && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteDialog(grant)}
                      aria-label={t("buttons.revoke")}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}

          {/* Revoked users */}
          {revokedUsers.map((grant) => (
            <TableRow key={grant.id} className={isRevokedFilter ? "" : "bg-muted/30"}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {getInitials(grant.user.name, grant.user.email)}
                  </div>
                  <div>
                    <div className="font-medium text-foreground">
                      {grant.user.name || t("table.noName")}
                    </div>
                    <div className="text-sm text-foreground/70">
                      {grant.user.email}
                    </div>
                    <Badge variant="outline" className="mt-1 text-xs border-amber-700 text-amber-900">
                      {t("table.revoked")}
                    </Badge>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-foreground/70">
                    {t(`accessLevels.${grant.accessLevel.toLowerCase()}`)}
                  </Badge>
                  <PermissionIcons accessLevel={grant.accessLevel} className="text-foreground/70" />
                </div>
              </TableCell>
              <TableCell>
                <div className="space-y-0.5">
                  {grant.grantedBy && (
                    <span className="text-sm text-muted-foreground">
                      {grant.grantedBy.name || grant.grantedBy.email}
                    </span>
                  )}
                  {grant.revokedBy && (
                    <div className="text-xs text-amber-700">
                      {t("table.revokedByUser", { name: grant.revokedBy.name ?? grant.revokedBy.email ?? "—" })}
                    </div>
                  )}
                  {!grant.grantedBy && !grant.revokedBy && (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className="space-y-0.5">
                  {grant.notes && (
                    <span className="text-sm text-muted-foreground">{grant.notes}</span>
                  )}
                  {grant.revokedAt && (
                    <div className="text-xs text-muted-foreground">
                      {formatRelativeTime(grant.revokedAt, locale)}
                    </div>
                  )}
                  {!grant.notes && !grant.revokedAt && (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRestoreDialog(grant)}
                  className="text-amber-900 hover:text-amber-950"
                >
                  <RotateCcw className="h-4 w-4 mr-1" />
                  {t("buttons.restore")}
                </Button>
              </TableCell>
            </TableRow>
          ))}

          {accessList.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center py-8">
                <UserIcon className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-muted-foreground">{t("table.noUsers")}</p>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* Edit Dialog */}
      <Dialog open={!!editDialog} onOpenChange={(open) => !open && setEditDialog(null)}>
        <DialogContent>
          <form onSubmit={handleEditSubmit}>
            <DialogHeader>
              <DialogTitle>{t("dialogs.edit.title")}</DialogTitle>
              <DialogDescription>
                {t("dialogs.edit.description", {
                  name: editDialog?.user.name ?? editDialog?.user.email ?? "—",
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <AccessFormFields
                userName={editUserName}
                onUserNameChange={setEditUserName}
                accessLevel={editAccessLevel}
                onAccessLevelChange={setEditAccessLevel}
                notes={editNotes}
                onNotesChange={setEditNotes}
                canManageOwnerAccess={canManageOwnerAccess}
                idPrefix="edit"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditDialog(null)}
              >
                {t("buttons.cancel")}
              </Button>
              <Button type="submit" disabled={updateAccess.isPending}>
                {updateAccess.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("buttons.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Revoke Confirmation Dialog */}
      <AlertDialog open={!!deleteDialog} onOpenChange={(open) => !open && setDeleteDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogs.revoke.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.revoke.description", {
                name: deleteDialog?.user.name ?? deleteDialog?.user.email ?? "—",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("buttons.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteDialog && revokeAccess.mutate(deleteDialog.userId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revokeAccess.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("dialogs.revoke.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restore Confirmation Dialog */}
      <AlertDialog open={!!restoreDialog} onOpenChange={(open) => !open && setRestoreDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogs.restore.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.restore.description", {
                name: restoreDialog?.user.name ?? restoreDialog?.user.email ?? "—",
                level: restoreDialog?.accessLevel ? t(`accessLevels.${restoreDialog.accessLevel.toLowerCase()}`) : "—",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("buttons.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => restoreDialog && restoreAccess.mutate(restoreDialog.userId)}
            >
              {restoreAccess.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("dialogs.restore.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
