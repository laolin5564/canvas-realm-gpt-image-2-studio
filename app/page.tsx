import { WorkbenchClient } from "@/components/workbench/WorkbenchClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function HomePage() {
  return <WorkbenchClient />;
}
