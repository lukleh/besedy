"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { AccessFormFields } from "@/components/catalog/access-form-fields";
import { useDebounce } from "@/hooks/use-debounce";
import { useToast } from "@/hooks/use-toast";
import { AccessLevel } from "@/generated/prisma/enums";
import { fetchJson } from "@/lib/api/fetch-json";

interface UserSearchResult {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  type: "active" | "available" | "revoked";
  currentAccessLevel?: AccessLevel;
  previousAccessLevel?: AccessLevel;
  notes?: string | null;
}

interface UserSearchResponse {
  users: UserSearchResult[];
  canInvite: boolean;
  inviteEmail?: string;
}

interface InviteResponse {
  email: string;
  userStatus: string;
}

interface GrantAccessDialogProps {
  catalogId: string;
  canManageOwnerAccess: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function GrantAccessDialog({
  catalogId,
  canManageOwnerAccess,
  open,
  onOpenChange,
  onSuccess,
}: GrantAccessDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("catalogSettings");

  // Form state
  const [searchValue, setSearchValue] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserSearchResult | null>(null);
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("LISTENER");
  const [userName, setUserName] = useState("");
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"search" | "invite" | "grant">("search");

  const debouncedSearch = useDebounce(searchValue, 300);

  // Reset form when dialog closes - valid external system sync pattern
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchValue("");
      setSelectedUserId("");
      setSelectedUser(null);
      setAccessLevel("LISTENER");
      setUserName("");
      setNotes("");
      setMode("search");
    }
  }, [open]);

  // Search users query
  const { data: searchResults, isLoading: isSearching } = useQuery<UserSearchResponse>({
    queryKey: ["user-search", catalogId, debouncedSearch],
    queryFn: async () => {
      if (debouncedSearch.length < 2) {
        return { users: [], canInvite: false };
      }
      return fetchJson<UserSearchResponse>(
        `/api/catalogs/${catalogId}/users?search=${encodeURIComponent(debouncedSearch)}`
      );
    },
    enabled: open && debouncedSearch.length >= 2,
  });

  // Grant access mutation (for existing users and restore)
  const grantAccess = useMutation({
    mutationFn: async (data: {
      userId: string;
      accessLevel: AccessLevel;
      notes?: string;
      userName?: string;
    }) => {
      return fetchJson(`/api/catalogs/${catalogId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    },
  });

  // Update access with name mutation
  const updateAccess = useMutation({
    mutationFn: async (data: {
      userId: string;
      accessLevel: AccessLevel;
      notes?: string;
      userName?: string;
    }) => {
      return fetchJson(`/api/catalogs/${catalogId}/access/${data.userId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessLevel: data.accessLevel,
          notes: data.notes,
          userName: data.userName,
        }),
      });
    },
  });

  // Invite new user mutation
  const inviteUser = useMutation({
    mutationFn: async (data: { email: string; accessLevel: AccessLevel; message?: string }) => {
      return fetchJson<InviteResponse>(
        `/api/catalogs/${catalogId}/pending-catalog-grants`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      );
    },
  });

  // Convert search results to combobox options
  const options: ComboboxOption[] = (searchResults?.users ?? []).map((user) => ({
    id: user.id,
    label: user.name || user.email || user.id,
    description: user.name ? user.email || undefined : undefined,
    type: user.type,
    image: user.image,
    currentAccessLevel: user.currentAccessLevel,
    previousAccessLevel: user.previousAccessLevel,
  }));

  const handleSelectUser = (option: ComboboxOption) => {
    const user = searchResults?.users.find((u) => u.id === option.id);
    if (user) {
      setSelectedUserId(user.id);
      setSelectedUser(user);
      setUserName(user.name || "");
      setAccessLevel(user.currentAccessLevel || user.previousAccessLevel || "LISTENER");
      setNotes(user.notes || "");
      setMode("grant");
    }
  };

  const handleInviteNew = () => {
    if (searchResults?.inviteEmail) {
      setMode("invite");
      setAccessLevel("LISTENER");
      setUserName(searchResults.inviteEmail.split("@")[0]);
      setNotes("");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      if (mode === "invite" && searchResults?.inviteEmail) {
        const result = await inviteUser.mutateAsync({
          email: searchResults.inviteEmail,
          accessLevel,
          message: notes || undefined,
        });

        queryClient.invalidateQueries({ queryKey: ["catalog-access", catalogId] });
        queryClient.invalidateQueries({ queryKey: ["catalog-pending-users", catalogId] });
        onSuccess();
        onOpenChange(false);

        if (result.userStatus === "ACTIVE") {
          toast({
            title: t("toasts.accessGranted"),
            description: t("toasts.accessGrantedDirect"),
          });
        } else {
          toast({
            title: t("toasts.userAdded"),
            description: t("toasts.userAddedDesc", { email: result.email }),
          });
        }
        return;
      }

      if (mode !== "grant" || !selectedUserId || !selectedUser) {
        return;
      }

      if (selectedUser.type === "active") {
        await updateAccess.mutateAsync({
          userId: selectedUserId,
          accessLevel,
          notes,
          userName: userName || undefined,
        });

        queryClient.invalidateQueries({ queryKey: ["catalog-access", catalogId] });
        queryClient.invalidateQueries({ queryKey: ["user-search", catalogId] });
        onSuccess();
        onOpenChange(false);
        toast({
          title: t("toasts.accessUpdated"),
          description: t("toasts.accessUpdatedDesc"),
        });
        return;
      }

      await grantAccess.mutateAsync({
        userId: selectedUserId,
        accessLevel,
        notes: notes || undefined,
        userName: userName || undefined,
      });

      queryClient.invalidateQueries({ queryKey: ["catalog-access", catalogId] });
      queryClient.invalidateQueries({ queryKey: ["user-search", catalogId] });
      onSuccess();
      onOpenChange(false);
      toast({
        title:
          selectedUser.type === "revoked"
            ? t("toasts.accessRestored")
            : t("toasts.accessGranted"),
        description:
          selectedUser.type === "revoked"
            ? t("toasts.accessRestoredDesc")
            : t("toasts.accessGrantedDesc"),
      });
    } catch (error) {
      toast({
        title: t("toasts.error"),
        description: error instanceof Error ? error.message : t("toasts.error"),
        variant: "destructive",
      });
    }
  };

  const isSubmitting = grantAccess.isPending || inviteUser.isPending || updateAccess.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("dialogs.grantAccess.title")}</DialogTitle>
            <DialogDescription>
              {t("dialogs.grantAccess.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {mode === "search" && (
              <div>
                <Label>{t("dialogs.grantAccess.searchLabel")}</Label>
                <Combobox
                  value={selectedUserId}
                  onValueChange={setSelectedUserId}
                  searchValue={searchValue}
                  onSearchChange={setSearchValue}
                  options={options}
                  isLoading={isSearching}
                  placeholder={t("dialogs.grantAccess.selectUser")}
                  emptyMessage={t("dialogs.grantAccess.noResults")}
                  activeSectionLabel={t("dialogs.grantAccess.activeSection")}
                  revokedSectionLabel={t("dialogs.grantAccess.revokedSection")}
                  availableSectionLabel={t("dialogs.grantAccess.availableSection")}
                  inviteLabel={t("dialogs.grantAccess.inviteLabel")}
                  shortSearchMessage={t("dialogs.grantAccess.shortSearchMessage")}
                  currentAccessPrefix={t("dialogs.grantAccess.currentPrefix")}
                  previousAccessPrefix={t("dialogs.grantAccess.previousPrefix")}
                  showInviteOption={searchResults?.canInvite ?? false}
                  inviteEmail={searchResults?.inviteEmail}
                  onInvite={handleInviteNew}
                  onSelect={handleSelectUser}
                  className="mt-2"
                />
              </div>
            )}

            {(mode === "grant" || mode === "invite") && (
              <>
                {/* User indicator */}
                <div className="rounded-md bg-muted p-3">
                  <p className="text-sm font-medium">
                    {mode === "invite"
                      ? t("dialogs.grantAccess.invitingNew", { email: searchResults?.inviteEmail ?? "" })
                      : selectedUser?.type === "active"
                      ? t("dialogs.grantAccess.updatingAccess", { name: selectedUser?.name ?? selectedUser?.email ?? "—" })
                      : selectedUser?.type === "revoked"
                      ? t("dialogs.grantAccess.restoringAccess", { name: selectedUser?.name ?? selectedUser?.email ?? "—" })
                      : t("dialogs.grantAccess.grantingTo", { name: selectedUser?.name ?? selectedUser?.email ?? "—" })}
                  </p>
                  {selectedUser?.type === "active" && selectedUser?.currentAccessLevel && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("dialogs.grantAccess.currentLevel", {
                        level: t(`accessLevels.${selectedUser.currentAccessLevel.toLowerCase()}`),
                      })}
                    </p>
                  )}
                  {selectedUser?.type === "revoked" && selectedUser?.previousAccessLevel && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("dialogs.grantAccess.previousLevel", { level: t(`accessLevels.${selectedUser.previousAccessLevel.toLowerCase()}`) })}
                    </p>
                  )}
                </div>

                <AccessFormFields
                  userName={userName}
                  onUserNameChange={setUserName}
                  accessLevel={accessLevel}
                  onAccessLevelChange={setAccessLevel}
                  notes={notes}
                  onNotesChange={setNotes}
                  canManageOwnerAccess={canManageOwnerAccess}
                  idPrefix="grant"
                  showAccessLevelHint
                />

                {/* Back button */}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => {
                    setMode("search");
                    setSelectedUserId("");
                    setSelectedUser(null);
                    setAccessLevel("LISTENER");
                    setUserName("");
                    setNotes("");
                  }}
                >
                  <ArrowLeft className="mr-1 h-3 w-3" />
                  {t("dialogs.grantAccess.backToSearch")}
                </Button>
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("buttons.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || mode === "search"}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === "invite"
                ? t("dialogs.grantAccess.inviteButton")
                : selectedUser?.type === "active"
                ? t("dialogs.grantAccess.updateButton")
                : selectedUser?.type === "revoked"
                ? t("dialogs.grantAccess.restoreButton")
                : t("dialogs.grantAccess.grantButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
