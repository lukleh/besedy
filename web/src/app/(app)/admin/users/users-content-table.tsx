"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
  Ban,
  Eye,
  FolderKey,
  Mail,
  MoreHorizontal,
  Pencil,
  Settings2,
  Shield,
  StickyNote,
  Trash2,
  UserCheck,
} from "lucide-react";
import { formatRelativeTime } from "@/lib/date-format";
import { PermissionIcons } from "@/components/catalog/permission-icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuSeparator,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AccessLevel, UserStatus } from "@/generated/prisma/enums";
import {
  getUserInitials,
  isPendingPortalAdmission,
  statusConfig,
  summarizeCatalogNames,
  type PendingPortalAdmission,
  type User,
  type UserOrPortalAdmission,
} from "./users-content-types";

interface UsersTableProps {
  adminStatusIsSuperadmin: boolean;
  getAccessLevelLabel: (level: AccessLevel) => string;
  isLoading: boolean;
  onDeleteUser: (user: User) => void;
  onEditAdmission: (admission: PendingPortalAdmission) => void;
  onManageAdminRole: (user: User) => void;
  onManageCatalogAccess: (user: User) => void;
  onRevokeAdmission: (admission: PendingPortalAdmission) => void;
  onStatusChange: (userId: string, status: UserStatus, userName: string) => void;
  statusFilter: string;
  usersOrAdmissions?: UserOrPortalAdmission[];
}

/**
 * Owns the main admin users table and row-level actions once data and handlers
 * have been prepared by the page-level orchestration component.
 */
export function UsersTable({
  adminStatusIsSuperadmin,
  getAccessLevelLabel,
  isLoading,
  onDeleteUser,
  onEditAdmission,
  onManageAdminRole,
  onManageCatalogAccess,
  onRevokeAdmission,
  onStatusChange,
  statusFilter,
  usersOrAdmissions,
}: UsersTableProps) {
  const locale = useLocale();
  const t = useTranslations("admin");

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("users.table.user")}</TableHead>
            <TableHead>
              {statusFilter === "PENDING"
                ? t("users.table.addedBy")
                : t("users.table.status")}
            </TableHead>
            <TableHead className="hidden md:table-cell landscape-mobile:hidden">
              {statusFilter === "PENDING"
                ? t("users.table.access")
                : t("users.table.role")}
            </TableHead>
            <TableHead className="hidden lg:table-cell">
              {t("users.table.catalogs")}
            </TableHead>
            <TableHead className="hidden xl:table-cell">
              {statusFilter === "PENDING"
                ? t("users.table.added")
                : t("users.table.lastLogin")}
            </TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center py-8">
                {t("users.loading")}
              </TableCell>
            </TableRow>
          ) : usersOrAdmissions?.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center py-8">
                {statusFilter === "PENDING"
                  ? t("users.noPendingAdmissionsFound")
                  : t("users.noUsersFound")}
              </TableCell>
            </TableRow>
          ) : (
            usersOrAdmissions?.map((item) =>
              isPendingPortalAdmission(item) ? (
                <PendingAdmissionRow
                  key={item.id}
                  getAccessLevelLabel={getAccessLevelLabel}
                  admission={item}
                  locale={locale}
                  onEditAdmission={onEditAdmission}
                  onRevokeAdmission={onRevokeAdmission}
                />
              ) : (
                <UserRow
                  key={item.id}
                  adminStatusIsSuperadmin={adminStatusIsSuperadmin}
                  getAccessLevelLabel={getAccessLevelLabel}
                  locale={locale}
                  onDeleteUser={onDeleteUser}
                  onManageAdminRole={onManageAdminRole}
                  onManageCatalogAccess={onManageCatalogAccess}
                  onStatusChange={onStatusChange}
                  user={item}
                />
              )
            )
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function PendingAdmissionRow({
  getAccessLevelLabel,
  admission,
  locale,
  onEditAdmission,
  onRevokeAdmission,
}: {
  getAccessLevelLabel: (level: AccessLevel) => string;
  admission: PendingPortalAdmission;
  locale: string;
  onEditAdmission: (admission: PendingPortalAdmission) => void;
  onRevokeAdmission: (admission: PendingPortalAdmission) => void;
}) {
  const t = useTranslations("admin");
  const catalogSummary =
    summarizeCatalogNames(admission.catalogNames) ?? admission.catalogLabel;

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-yellow-100 text-yellow-700">
                {getUserInitials(null, admission.email)}
              </AvatarFallback>
            </Avatar>
            <Mail className="absolute -bottom-1 -right-1 h-3.5 w-3.5 text-yellow-600 bg-background rounded-full p-0.5" />
          </div>
          <div className="font-medium flex items-center gap-1.5">
            {admission.email}
            {admission.notes && (
              <span title={admission.notes}>
                <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <span className="text-sm text-muted-foreground">
          {admission.invitedBy
            ? admission.invitedBy.name || admission.invitedBy.email
            : "-"}
        </span>
      </TableCell>
      <TableCell className="hidden md:table-cell landscape-mobile:hidden">
        {admission.accessLevel ? (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-muted-foreground">
              {getAccessLevelLabel(admission.accessLevel)}
            </Badge>
            <PermissionIcons accessLevel={admission.accessLevel} />
          </div>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        {catalogSummary ? (
          <span
            className="text-sm"
            title={admission.catalogNames.length > 0 ? admission.catalogNames.join(", ") : undefined}
          >
            {catalogSummary}
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="hidden xl:table-cell text-muted-foreground">
        {formatRelativeTime(admission.invitedAt, locale)}
      </TableCell>
      <TableCell>
        <ResponsiveMenu>
          <ResponsiveMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("users.table.actions")}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </ResponsiveMenuTrigger>
          <ResponsiveMenuContent align="end" title={t("users.table.actions")}>
            <>
              <ResponsiveMenuItem onClick={() => onEditAdmission(admission)}>
                <Pencil className="mr-2 h-4 w-4" />
                {t("actions.editPendingAccess")}
              </ResponsiveMenuItem>
              <ResponsiveMenuSeparator />
            </>
            <ResponsiveMenuItem
              onClick={() => onRevokeAdmission(admission)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("actions.revokePendingAccess")}
            </ResponsiveMenuItem>
          </ResponsiveMenuContent>
        </ResponsiveMenu>
      </TableCell>
    </TableRow>
  );
}

function UserRow({
  adminStatusIsSuperadmin,
  getAccessLevelLabel,
  locale,
  onDeleteUser,
  onManageAdminRole,
  onManageCatalogAccess,
  onStatusChange,
  user,
}: {
  adminStatusIsSuperadmin: boolean;
  getAccessLevelLabel: (level: AccessLevel) => string;
  locale: string;
  onDeleteUser: (user: User) => void;
  onManageAdminRole: (user: User) => void;
  onManageCatalogAccess: (user: User) => void;
  onStatusChange: (userId: string, status: UserStatus, userName: string) => void;
  user: User;
}) {
  const t = useTranslations("admin");
  const StatusIcon = statusConfig[user.status].icon;

  const roleBadge = user.isSuperadmin ? (
    <Badge className="bg-purple-600">{t("users.roles.superadmin")}</Badge>
  ) : user.isAdmin ? (
    <Badge variant="secondary" className="text-indigo-600 border-indigo-300">
      {t("users.roles.admin")}
    </Badge>
  ) : user.highestAccessLevel ? (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="text-muted-foreground">
        {getAccessLevelLabel(user.highestAccessLevel)}
      </Badge>
      <PermissionIcons accessLevel={user.highestAccessLevel} />
    </div>
  ) : (
    <span className="text-muted-foreground">-</span>
  );

  const catalogSummary = summarizeCatalogNames(user.catalogNames);

  return (
    <TableRow>
      <TableCell>
        <Link
          href={`/admin/users/${user.id}`}
          className="flex items-center gap-3 hover:opacity-80"
        >
          <Avatar className="h-8 w-8">
            <AvatarImage src={user.image || undefined} />
            <AvatarFallback>
              {getUserInitials(user.name, user.email)}
            </AvatarFallback>
          </Avatar>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium hover:underline">
                {user.name || t("users.noName")}
              </span>
              {user.isSuperadmin && (
                <Shield className="h-4 w-4 text-purple-600" />
              )}
            </div>
            <div className="text-sm text-muted-foreground">{user.email}</div>
          </div>
        </Link>
      </TableCell>
      <TableCell>
        <Badge variant={statusConfig[user.status].variant}>
          <StatusIcon className="mr-1 h-3 w-3" />
          {t(`users.status.${statusConfig[user.status].labelKey}`)}
        </Badge>
      </TableCell>
      <TableCell className="hidden md:table-cell landscape-mobile:hidden">
        {roleBadge}
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        {catalogSummary ? (
          <span className="text-sm" title={user.catalogNames.join(", ")}>
            {catalogSummary}
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="hidden xl:table-cell text-muted-foreground">
        {user.lastLoginAt
          ? formatRelativeTime(user.lastLoginAt, locale)
          : t("users.never")}
      </TableCell>
      <TableCell>
        <ResponsiveMenu>
          <ResponsiveMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("users.table.actions")}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </ResponsiveMenuTrigger>
          <ResponsiveMenuContent align="end" title={t("users.table.actions")}>
            <ResponsiveMenuItem asChild>
              <Link href={`/admin/users/${user.id}`}>
                <Eye className="mr-2 h-4 w-4" />
                {t("actions.viewDetails")}
              </Link>
            </ResponsiveMenuItem>
            <ResponsiveMenuSeparator />
            {user.status !== "ACTIVE" && (
              <ResponsiveMenuItem
                onClick={() => onStatusChange(user.id, "ACTIVE", user.name || user.email)}
              >
                <UserCheck className="mr-2 h-4 w-4" />
                {t("actions.activate")}
              </ResponsiveMenuItem>
            )}
            {user.status !== "BLOCKED" && !user.isSuperadmin && (
              <ResponsiveMenuItem
                onClick={() => onStatusChange(user.id, "BLOCKED", user.name || user.email)}
                className="text-destructive"
              >
                <Ban className="mr-2 h-4 w-4" />
                {t("actions.block")}
              </ResponsiveMenuItem>
            )}
            <ResponsiveMenuSeparator />
            <ResponsiveMenuItem onClick={() => onManageCatalogAccess(user)}>
              <FolderKey className="mr-2 h-4 w-4" />
              {t("actions.manageCatalogAccess")}
            </ResponsiveMenuItem>
            {!user.isSuperadmin && adminStatusIsSuperadmin && (
              <ResponsiveMenuItem onClick={() => onManageAdminRole(user)}>
                <Settings2 className="mr-2 h-4 w-4" />
                {t("actions.manageAdminRole")}
              </ResponsiveMenuItem>
            )}
            {!user.isSuperadmin && (
              <>
                <ResponsiveMenuSeparator />
                <ResponsiveMenuItem
                  onClick={() => onDeleteUser(user)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("actions.deleteUser")}
                </ResponsiveMenuItem>
              </>
            )}
          </ResponsiveMenuContent>
        </ResponsiveMenu>
      </TableCell>
    </TableRow>
  );
}
