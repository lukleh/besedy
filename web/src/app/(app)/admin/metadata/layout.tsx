import MetadataLayoutClient from "./metadata-layout-client";

/**
 * The admin layout above already refuses anyone who is not an administrator, and
 * the lookup routes themselves require edit rights on the catalog being worked
 * on, so this layout adds no gate of its own.
 */
export default function MetadataLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <MetadataLayoutClient>{children}</MetadataLayoutClient>;
}
