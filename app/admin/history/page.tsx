import { HistoryClient } from "@/components/history/HistoryClient";
import { AdminShell } from "@/components/admin/AdminShell";

export default function AdminHistoryPage() {
  return (
    <AdminShell
      active="history"
      title="历史与素材"
      description="管理员视角：默认展示全部用户的生成记录，可按用户筛选。"
    >
      <HistoryClient embedded />
    </AdminShell>
  );
}
