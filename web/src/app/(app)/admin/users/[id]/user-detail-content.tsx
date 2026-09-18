"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import {
  ArrowLeft,
  Shield,
  UserCheck,
  Clock,
  Ban,
  Plus,
  Trash2,
  Loader2,
  Calendar,
  Mail,
  User,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { formatRelativeTime, formatLocalDate } from "@/lib/date-format";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
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
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { useCatalogs } from "@/hooks/use-catalogs";
import { AccessLevel, UserStatus } from "@/generated/prisma/enums";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";

const ACCESS_LEVEL_VALUES = Object.values(AccessLevel);

interface CatalogAccess {
  id: string;
  catalogId: string;
  accessLevel: AccessLevel;
  catalog: {
    id: string;
    label: string | null;
  };
}

interface UserDetails {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  status: UserStatus;
  isSuperadmin: boolean;
  isAdmin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  activatedAt: string | null;
  invitedBy: {
    id: string;
    name: string | null;
    email: string;
  } | null;
  catalogAccess: CatalogAccess[];
}

const statusConfig: Record<
  UserStatus,
  { labelKey: "pending" | "active" | "blocked"; variant: "default" | "secondary" | "destructive"; icon: typeof UserCheck }
> = {
  PENDING: { labelKey: "pending", variant: "secondary", icon: Clock },
  ACTIVE: { labelKey: "active", variant: "default", icon: UserCheck },
  BLOCKED: { labelKey: "blocked", variant: "destructive", icon: Ban },
};

export default function UserDetailContent() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const adminStatus = useAdminStatus();
  const t = useTranslations("admin");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const userId = params.id as string;

  // Helper function to get translated access level label
  const getAccessLevelLabel = (level: AccessLevel): string => {
    const key = level.toLowerCase() as "listener" | "viewer" | "member" | "editor" | "owner";
    return t(`accessLevels.${key}`);
  };

  const [blockConfirm, setBlockConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [adminRoleForm, setAdminRoleForm] = useState(false);
  const [newCatalogId, setNewCatalogId] = useState<string>("");
  const [newAccessLevel, setNewAccessLevel] = useState<AccessLevel>("LISTENER");
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState("");

  // Fetch user details
  const { data: user, isLoading, error } = useQuery<UserDetails>({
    queryKey: ["admin-user-detail", userId],
    queryFn: async () => {
      try {
        return await fetchJson<UserDetails>(`/api/admin/users/${userId}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          throw new Error("User not found");
        }
        throw err;
      }
    },
  });

  // Fetch catalogs for adding access
  const { data: catalogs } = useCatalogs();

  // Update user status
  const updateStatus = useMutation({
    mutationFn: async (status: UserStatus) => {
      return fetchJson(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", userId] });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setBlockConfirm(false);
      toast({
        title: t("toasts.userUpdated"),
        description: t("toasts.userStatusUpdated"),
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

  // Update user name
  const updateName = useMutation({
    mutationFn: async (name: string) => {
      return fetchJson(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", userId] });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setIsEditingName(false);
      toast({
        title: t("toasts.userUpdated"),
        description: t("toasts.userNameUpdated"),
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

  // Update admin role
  const updateAdminRole = useMutation({
    mutationFn: async (isAdmin: boolean) => {
      if (!isAdmin) {
        try {
          await fetchJson(`/api/admin/users/${userId}/admin-role`, {
            method: "DELETE",
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            return null;
          }
          throw err;
        }
        return null;
      }
      return fetchJson(`/api/admin/users/${userId}/admin-role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAdmin: true }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", userId] });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setAdminRoleForm(false);
      toast({
        title: t("toasts.adminRoleUpdated"),
        description: t("toasts.adminRoleHasBeenUpdated"),
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

  // Add catalog access
  const addCatalogAccess = useMutation({
    mutationFn: async ({
      catalogId,
      accessLevel,
    }: {
      catalogId: string;
      accessLevel: AccessLevel;
    }) => {
      return fetchJson(`/api/catalogs/${catalogId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, accessLevel }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", userId] });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setNewCatalogId("");
      setNewAccessLevel("LISTENER");
      toast({
        title: t("toasts.accessGranted"),
        description: t("toasts.accessHasBeenGranted"),
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

  // Update catalog access
  const updateCatalogAccess = useMutation({
    mutationFn: async ({
      catalogId,
      accessLevel,
    }: {
      catalogId: string;
      accessLevel: AccessLevel;
    }) => {
      return fetchJson(`/api/catalogs/${catalogId}/access/${userId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessLevel }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", userId] });
      toast({
        title: t("toasts.accessUpdated"),
        description: t("toasts.accessHasBeenUpdated"),
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

  // Remove catalog access
  const removeCatalogAccess = useMutation({
    mutationFn: async (catalogId: string) => {
      return fetchJson(`/api/catalogs/${catalogId}/access/${userId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", userId] });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast({
        title: t("toasts.accessRemoved"),
        description: t("toasts.accessHasBeenRemoved"),
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

  // Delete user permanently
  const deleteUser = useMutation({
    mutationFn: async () => {
      return fetchJson(`/api/admin/users/${userId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-users-stats"] });
      toast({
        title: t("toasts.userDeleted"),
        description: t("toasts.userHasBeenDeleted"),
      });
      router.push("/admin/users");
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const getInitials = (name: string | null, email: string) => {
    if (name) {
      return name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    return email.slice(0, 2).toUpperCase();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !user) {
    return (
      <div className="space-y-4">
        <Link
          href="/admin/users"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("userDetail.backToUsers")}
        </Link>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              {error?.message || t("userDetail.notFound")}
            </p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => router.push("/admin/users")}
            >
              {t("userDetail.returnToUsers")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const StatusIcon = statusConfig[user.status].icon;
  const availableCatalogs = catalogs?.filter(
    (c) => !user.catalogAccess.some((access) => access.catalogId === c.id)
  );

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/admin/users"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("userDetail.backToUsers")}
      </Link>

      {/* User Profile Card */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-4">
            <Avatar className="h-16 w-16">
              <AvatarImage src={user.image || undefined} />
              <AvatarFallback className="text-lg">
                {getInitials(user.name, user.email)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                {isEditingName ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={editedName}
                      onChange={(e) => setEditedName(e.target.value)}
                      className="h-8 w-48 text-lg"
                      placeholder={t("userDetail.enterName")}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && editedName.trim()) {
                          updateName.mutate(editedName.trim());
                        } else if (e.key === "Escape") {
                          setIsEditingName(false);
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        if (editedName.trim()) {
                          updateName.mutate(editedName.trim());
                        }
                      }}
                      disabled={!editedName.trim() || updateName.isPending}
                    >
                      {updateName.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4 text-green-600" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setIsEditingName(false)}
                      disabled={updateName.isPending}
                    >
                      <X className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <CardTitle className="text-xl">
                      {user.name || t("users.noName")}
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        setEditedName(user.name || "");
                        setIsEditingName(true);
                      }}
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </>
                )}
                {user.isSuperadmin && (
                  <Badge className="bg-purple-600">{t("users.roles.superadmin")}</Badge>
                )}
                {user.isAdmin && !user.isSuperadmin && (
                  <Badge variant="secondary" className="text-indigo-600 border-indigo-300">
                    {t("users.roles.admin")}
                  </Badge>
                )}
              </div>
              <CardDescription className="flex items-center gap-1 mt-1">
                <Mail className="h-3 w-3" />
                {user.email}
              </CardDescription>
            </div>
            <Badge variant={statusConfig[user.status].variant}>
              <StatusIcon className="mr-1 h-3 w-3" />
              {t(`users.status.${statusConfig[user.status].labelKey}`)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Timestamps */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div>
                <span className="text-muted-foreground">{t("userDetail.memberSince")} </span>
                {formatLocalDate(user.createdAt, locale, "MMM d, yyyy")}
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <div>
                <span className="text-muted-foreground">{t("userDetail.lastLogin")} </span>
                {user.lastLoginAt
                  ? formatRelativeTime(user.lastLoginAt, locale)
                  : t("users.never")}
              </div>
            </div>
            {user.activatedAt && (
              <div className="flex items-center gap-2 text-sm">
                <UserCheck className="h-4 w-4 text-muted-foreground" />
                <div>
                  <span className="text-muted-foreground">{t("userDetail.activated")} </span>
                  {formatLocalDate(user.activatedAt, locale, "MMM d, yyyy")}
                </div>
              </div>
            )}
          </div>

          {/* Added by */}
          {user.invitedBy && (
            <div className="flex items-center gap-2 text-sm">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">{t("userDetail.addedBy")} </span>
              <span>{user.invitedBy.name || user.invitedBy.email}</span>
            </div>
          )}

          <Separator />

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {/* Status actions */}
            {user.status !== "ACTIVE" && (
              <Button
                size="sm"
                onClick={() => updateStatus.mutate("ACTIVE")}
                disabled={updateStatus.isPending}
              >
                {updateStatus.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <UserCheck className="mr-2 h-4 w-4" />
                )}
                {t("actions.activate")}
              </Button>
            )}
            {user.status !== "BLOCKED" && !user.isSuperadmin && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setBlockConfirm(true)}
                disabled={updateStatus.isPending}
              >
                <Ban className="mr-2 h-4 w-4" />
                {t("actions.block")}
              </Button>
            )}

            {/* Admin role toggle (superadmin only) */}
            {adminStatus.isSuperadmin && !user.isSuperadmin && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAdminRoleForm(true)}
              >
                <Shield className="mr-2 h-4 w-4" />
                {user.isAdmin ? t("actions.removeAdmin") : t("actions.makeAdmin")}
              </Button>
            )}

            {/* Delete user (cannot delete superadmins) */}
            {!user.isSuperadmin && (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => setDeleteConfirm(true)}
                disabled={deleteUser.isPending}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("actions.deleteUser")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Catalog Access Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t("userDetail.catalogAccess")}</CardTitle>
              <CardDescription>
                {t("userDetail.catalogAccessDesc")}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Current access list */}
          {user.catalogAccess.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("userDetail.noAccessYet")}
            </p>
          ) : (
            <div className="border rounded-md divide-y">
              {user.catalogAccess.map((access) => (
                <div
                  key={access.catalogId}
                  className="flex items-center justify-between p-3"
                >
                  <div className="font-medium">
                    {access.catalog.label || access.catalogId}
                  </div>
                  <div className="flex items-center gap-2">
                    <ResponsiveSelect
                      value={access.accessLevel}
                      onValueChange={(value) =>
                        updateCatalogAccess.mutate({
                          catalogId: access.catalogId,
                          accessLevel: value as AccessLevel,
                        })
                      }
                    >
                      <ResponsiveSelectTrigger className="w-[120px]" aria-label={t("userDetail.accessLevel")}>
                        <ResponsiveSelectValue displayValue={getAccessLevelLabel(access.accessLevel)} />
                      </ResponsiveSelectTrigger>
                      <ResponsiveSelectContent title={t("userDetail.accessLevel")}>
                        {ACCESS_LEVEL_VALUES.map((level) => (
                          <ResponsiveSelectItem key={level} value={level}>
                            {getAccessLevelLabel(level)}
                          </ResponsiveSelectItem>
                        ))}
                      </ResponsiveSelectContent>
                    </ResponsiveSelect>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCatalogAccess.mutate(access.catalogId)}
                      disabled={removeCatalogAccess.isPending}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add new access */}
          {availableCatalogs && availableCatalogs.length > 0 && (
            <>
              <Separator />
              <div>
                <h4 className="text-sm font-medium mb-2">{t("userDetail.addCatalogAccess")}</h4>
                <div className="flex gap-2">
                  <ResponsiveSelect value={newCatalogId} onValueChange={setNewCatalogId}>
                    <ResponsiveSelectTrigger className="flex-1" aria-label={t("userDetail.selectCatalog")}>
                      <ResponsiveSelectValue placeholder={t("userDetail.selectCatalog")} displayValue={newCatalogId ? (availableCatalogs?.find(c => c.id === newCatalogId)?.label || newCatalogId) : undefined} />
                    </ResponsiveSelectTrigger>
                    <ResponsiveSelectContent title={t("userDetail.selectCatalog")}>
                      {availableCatalogs.map((catalog) => (
                        <ResponsiveSelectItem key={catalog.id} value={catalog.id}>
                          {catalog.label || catalog.id}
                        </ResponsiveSelectItem>
                      ))}
                    </ResponsiveSelectContent>
                  </ResponsiveSelect>
                  <ResponsiveSelect
                    value={newAccessLevel}
                    onValueChange={(value) =>
                      setNewAccessLevel(value as AccessLevel)
                    }
                  >
                    <ResponsiveSelectTrigger className="w-[120px]" aria-label={t("userDetail.accessLevel")}>
                      <ResponsiveSelectValue displayValue={getAccessLevelLabel(newAccessLevel)} />
                    </ResponsiveSelectTrigger>
                    <ResponsiveSelectContent title={t("userDetail.accessLevel")}>
                      {ACCESS_LEVEL_VALUES.map((level) => (
                        <ResponsiveSelectItem key={level} value={level}>
                          {getAccessLevelLabel(level)}
                        </ResponsiveSelectItem>
                      ))}
                    </ResponsiveSelectContent>
                  </ResponsiveSelect>
                  <Button
                    onClick={() => {
                      if (newCatalogId) {
                        addCatalogAccess.mutate({
                          catalogId: newCatalogId,
                          accessLevel: newAccessLevel,
                        });
                      }
                    }}
                    disabled={!newCatalogId || addCatalogAccess.isPending}
                  >
                    {addCatalogAccess.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Block Confirmation Dialog */}
      <AlertDialog open={blockConfirm} onOpenChange={setBlockConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogs.blockUser.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.blockUser.description", { name: user.name || user.email })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => updateStatus.mutate("BLOCKED")}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("actions.blockUser")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Admin Role Confirmation Dialog */}
      <AlertDialog open={adminRoleForm} onOpenChange={setAdminRoleForm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {user.isAdmin ? t("dialogs.adminRole.removeTitle") : t("dialogs.adminRole.grantTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {user.isAdmin
                ? t("dialogs.adminRole.removeConfirm", { name: user.name || user.email })
                : t("dialogs.adminRole.grantConfirm", { name: user.name || user.email })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => updateAdminRole.mutate(!user.isAdmin)}
            >
              {user.isAdmin ? t("actions.removeAdmin") : t("actions.makeAdmin")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete User Confirmation Dialog */}
      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogs.deleteUser.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.deleteUser.description", { name: user.name || user.email })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteUser.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteUser.isPending}
            >
              {deleteUser.isPending ? t("actions.deleting") : t("actions.deleteUser")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
