"use client";

import dynamic from "next/dynamic";

const UserDetailContent = dynamic(() => import("./user-detail-content"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  ),
});

export default function UserDetailPage() {
  return <UserDetailContent />;
}
