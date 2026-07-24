"use client";

import { Pencil, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PermissionIcons } from "@/components/catalog/permission-icons";
import type {
  PendingCatalogGrant,
  PendingUsersResponse,
} from "./catalog-settings-content-types";

interface CatalogSettingsPendingUsersCardProps {
  accessLevelColors: Record<string, string>;
  accessLevelFilter: string;
  canManageOwnerAccess: boolean;
  onEditPendingUser: (pendingUser: PendingCatalogGrant) => void;
  onRemovePendingUser: (pendingUser: PendingCatalogGrant) => void;
  pendingUsersData?: PendingUsersResponse;
  search: string;
  t: (key: string) => string;
}

export function CatalogSettingsPendingUsersCard({
  accessLevelColors,
  accessLevelFilter,
  canManageOwnerAccess,
  onEditPendingUser,
  onRemovePendingUser,
  pendingUsersData,
  search,
  t,
}: CatalogSettingsPendingUsersCardProps) {
  const filteredPendingUsers = pendingUsersData?.pendingUsers.filter(
    (user) =>
      (accessLevelFilter === "all" || user.accessLevel === accessLevelFilter) &&
      (!search || user.email.toLowerCase().includes(search.toLowerCase()))
  ) ?? [];

  if (accessLevelFilter === "revoked" || filteredPendingUsers.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="h-5 w-5" />
          {t("pendingUsers.title")}
        </CardTitle>
        <CardDescription>
          {t("pendingUsers.description")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table data-testid="pending-users-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("pendingUsers.email")}</TableHead>
              <TableHead>{t("pendingUsers.accessLevel")}</TableHead>
              <TableHead className="hidden md:table-cell landscape-mobile:hidden">
                {t("pendingUsers.addedBy")}
              </TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredPendingUsers.map((pendingUser) => (
              <TableRow key={pendingUser.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <UserPlus className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{pendingUser.email}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge
                      className={`${accessLevelColors[pendingUser.accessLevel]} text-white`}
                    >
                      {t(`accessLevels.${pendingUser.accessLevel.toLowerCase()}`)}
                    </Badge>
                    <PermissionIcons accessLevel={pendingUser.accessLevel} />
                  </div>
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell landscape-mobile:hidden">
                  {pendingUser.grantedBy?.name || pendingUser.grantedBy?.email || "—"}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onEditPendingUser(pendingUser)}
                      aria-label={t("buttons.editPendingUser")}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onRemovePendingUser(pendingUser)}
                      aria-label={t("buttons.removePendingUser")}
                      disabled={
                        !canManageOwnerAccess && pendingUser.accessLevel === "OWNER"
                      }
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
