import { useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import type { GridColDef } from "@mui/x-data-grid";
import { post, useApi } from "../api";
import { useAuth } from "../auth";
import { TRIGGER_LABEL, fmtDate } from "../format";
import { useFeedback } from "../components/feedback";
import { DataTable, ErrorNote, PageHeader, StatusChip } from "../components/ui";
import { Box, Stack, Typography } from "../components/sys";

interface Email {
  id: string;
  trigger: string;
  recipient?: string | null;
  subject: string;
  status: string;
  reason?: string | null;
  composedAt: string;
  sentAt?: string | null;
}
interface EmailDetail extends Email {
  body: string;
  sendError?: string | null;
}

const WAITING = ["send_disabled", "composed"];
const FILTERS = {
  all: () => true,
  waiting: (e: Email) => WAITING.includes(e.status),
  sent: (e: Email) => e.status === "sent",
  problems: (e: Email) => e.status === "failed",
} as const;

function EmailDialog({ id, onClose, onChanged }: { id: string | null; onClose(): void; onChanged(): void }) {
  const { data, error } = useApi<EmailDetail>(id ? `emails/${encodeURIComponent(id)}` : null);
  const { isAdmin } = useAuth();
  const { confirm, run } = useFeedback();
  const waiting = !!data && (WAITING.includes(data.status) || data.status === "failed");

  async function send() {
    if (!data) return;
    const ok = await confirm({
      title: "Send this email now?",
      body: `It will be delivered to ${data.recipient ?? "the recipient"} through GoHighLevel.`,
      confirmLabel: "Send email",
    });
    if (ok && (await run("Email sent", () => post("emails/send", { id: data.id })))) {
      onChanged();
      onClose();
    }
  }
  async function discard() {
    if (!data) return;
    if (await run("Email discarded", () => post("emails/discard", { id: data.id }))) {
      onChanged();
      onClose();
    }
  }

  return (
    <Dialog open={!!id} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{data?.subject ?? "Email"}</DialogTitle>
      <DialogContent dividers>
        <ErrorNote error={error} />
        {data && (
          <Stack gap={2}>
            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <StatusChip value={data.status} />
              <Typography variant="body2" color="text.secondary">
                {TRIGGER_LABEL[data.trigger] ?? data.trigger} · to {data.recipient ?? "no address"}
              </Typography>
            </Stack>
            {data.reason && <Alert severity="info">{data.reason}</Alert>}
            {data.sendError && <Alert severity="error">{data.sendError}</Alert>}
            <Box sx={{ whiteSpace: "pre-wrap", p: 2, bgcolor: "action.hover", borderRadius: 2 }}>{data.body}</Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        {isAdmin && waiting && (
          <>
            <Button color="inherit" onClick={() => void discard()}>Discard</Button>
            <Button variant="contained" onClick={() => void send()} disabled={!data?.recipient}>Send now</Button>
          </>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export function EmailsPage() {
  const { data, error, loading, reload } = useApi<{ composed: Email[] }>("emails?limit=200", { refreshMs: 20_000 });
  const [filter, setFilter] = useState<keyof typeof FILTERS>("all");
  const [open, setOpen] = useState<string | null>(null);
  const rows = (data?.composed ?? []).filter(FILTERS[filter]);
  const waiting = (data?.composed ?? []).filter(FILTERS.waiting).length;

  const columns: GridColDef<Email>[] = [
    { field: "recipient", headerName: "To", flex: 1, minWidth: 200, valueGetter: (v) => v || "No address" },
    { field: "trigger", headerName: "Type", width: 160, valueFormatter: (v: string) => TRIGGER_LABEL[v] ?? v },
    { field: "subject", headerName: "Subject", flex: 2, minWidth: 260 },
    { field: "status", headerName: "Status", width: 190, renderCell: (p) => <StatusChip value={p.value} /> },
    { field: "composedAt", headerName: "Written", width: 170, valueFormatter: (v: string) => fmtDate(v) },
    { field: "sentAt", headerName: "Sent", width: 170, valueFormatter: (v: string) => fmtDate(v) },
  ];

  return (
    <>
      <PageHeader
        title="Emails"
        subtitle="Follow-ups the AI wrote from each conversation. Open one to read it, send it or discard it."
        actions={
          <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_e, v) => v && setFilter(v)}>
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="waiting">Awaiting send{waiting ? ` (${waiting})` : ""}</ToggleButton>
            <ToggleButton value="sent">Sent</ToggleButton>
            <ToggleButton value="problems">Failed</ToggleButton>
          </ToggleButtonGroup>
        }
      />
      <ErrorNote error={error} />
      <DataTable rows={rows} columns={columns} loading={loading} onRowClick={(p) => setOpen(String(p.id))} emptyText="No emails in this view" />
      <EmailDialog id={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />
    </>
  );
}
