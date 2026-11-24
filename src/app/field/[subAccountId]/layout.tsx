import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BrandSplash } from "@/components/field-portal/brand-splash";
import { WorkspaceScope } from "@/components/field-portal/workspace-scope";
import { WORKSPACE_ID } from "@/lib/field-portal/identity";

export async function generateMetadata({ params }: { params: Promise<{ subAccountId: string }> }): Promise<Metadata> {
  const { subAccountId } = await params;
  return {
    manifest: `/field/${subAccountId}/manifest.webmanifest`,
  };
}

export default async function FieldWorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ subAccountId: string }>;
}) {
  const { subAccountId } = await params;
  if (!WORKSPACE_ID.test(subAccountId)) notFound();
  // The page behind this does database reads, so the launch screen goes out first.
  return (
    <WorkspaceScope subAccountId={subAccountId}>
      <Suspense fallback={<BrandSplash subAccountId={subAccountId} />}>{children}</Suspense>
    </WorkspaceScope>
  );
}
