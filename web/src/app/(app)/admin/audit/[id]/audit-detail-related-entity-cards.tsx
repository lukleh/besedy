"use client";

// Owns the related-entity cards for the audit detail page. Card implementations
// live in focused companion modules so this switch stays aligned with the audit
// read-model shape instead of growing into a second-generation monolith.

import {
  CatalogAccessEntityCard,
  EntityNotFound,
  PendingCatalogGrantEntityCard,
  PortalAdmissionEntityCard,
} from "./audit-detail-access-entity-cards";
import {
  AudioEntityCard,
  CatalogEntityCard,
  UserEntityCard,
} from "./audit-detail-core-entity-cards";
import type {
  RelatedAudio,
  RelatedCatalog,
  RelatedCatalogAccess,
  RelatedEntity,
  RelatedPendingCatalogGrant,
  RelatedPortalAdmission,
  RelatedUser,
} from "./audit-detail-types";

export function RelatedEntitySection({
  entity,
  resourceId,
}: {
  entity: RelatedEntity | null | undefined;
  resourceId: string | null;
}) {
  if (!entity) return null;

  if (!entity.found || !entity.data) {
    return <EntityNotFound type={entity.type} resourceId={resourceId} error={entity.error} />;
  }

  switch (entity.type) {
    case "user":
      return <UserEntityCard user={entity.data as RelatedUser} />;
    case "audio":
      return <AudioEntityCard audio={entity.data as RelatedAudio} />;
    case "catalog":
      return <CatalogEntityCard catalog={entity.data as RelatedCatalog} />;
    case "catalog_access":
      return <CatalogAccessEntityCard access={entity.data as RelatedCatalogAccess} />;
    case "portal_admission":
      return <PortalAdmissionEntityCard admission={entity.data as RelatedPortalAdmission} />;
    case "pending_catalog_grant":
      return <PendingCatalogGrantEntityCard grant={entity.data as RelatedPendingCatalogGrant} />;
    default:
      return null;
  }
}
