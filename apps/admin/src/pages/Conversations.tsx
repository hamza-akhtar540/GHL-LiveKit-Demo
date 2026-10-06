import { useState } from "react";
import type { GridColDef } from "@mui/x-data-grid";
import { useApi } from "../api";
import { fmtDate } from "../format";
import { DataTable, ErrorNote, PageHeader, StatusChip } from "../components/ui";
import { ConversationDrawer } from "./ConversationDrawer";

interface Row {
  id: string;
  channel: string;
  contact: Record<string, string>;
  outcome?: string | null;
  messageCount: number;
  lastMessage?: string;
  updatedAt: string;
}

const columns: GridColDef<Row>[] = [
  { field: "who", headerName: "Customer", flex: 1, minWidth: 180, valueGetter: (_v, r) => r.contact?.full_name || r.contact?.email || "Anonymous visitor" },
  { field: "channel", headerName: "Channel", width: 100, renderCell: (p) => <StatusChip value={p.value} /> },
  { field: "outcome", headerName: "Outcome", width: 170, renderCell: (p) => <StatusChip value={p.value ?? "open"} /> },
  { field: "messageCount", headerName: "Msgs", width: 80, type: "number" },
  { field: "lastMessage", headerName: "Last message", flex: 2, minWidth: 260 },
  { field: "updatedAt", headerName: "Updated", width: 170, valueFormatter: (v: string) => fmtDate(v) },
];

export function ConversationsPage() {
  const { data, error, loading } = useApi<Row[]>("conversations?limit=200", { refreshMs: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Conversations" subtitle="Every chat and call the AI has handled. Select one to read the transcript." />
      <ErrorNote error={error} />
      <DataTable rows={data ?? []} columns={columns} loading={loading} onRowClick={(p) => setOpen(String(p.id))} emptyText="No conversations yet" />
      <ConversationDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}
