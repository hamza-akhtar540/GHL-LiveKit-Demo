import { useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import type { GridColDef, GridPaginationModel, GridSortModel } from "@mui/x-data-grid";
import { post, useApi } from "../api";
import { useAuth } from "../auth";
import { SOURCE_LABEL, fmtDate } from "../format";
import { useFeedback } from "../components/feedback";
import { DataTable, ErrorNote, PageHeader, StatusChip } from "../components/ui";
import { Box, Stack, Typography } from "../components/sys";

interface Lead {
  id: string;
  source: string;
  status: string;
  reason?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  tags: string[];
  attempts: number;
  retryable: boolean;
  receivedAt: string;
  contactId?: string | null;
}
interface LeadDetail extends Lead {
  lead: Record<string, unknown>;
  raw?: unknown;
}

const SOURCES = ["instagram_dm", "facebook_dm", "chat", "voice", "web_form", "facebook_lead_ad", "email", "webhook", "manual"];
const STATUSES = ["created", "merged", "duplicate", "rejected", "received", "failed"];

function LeadDialog({ id, onClose, onChanged }: { id: string | null; onClose(): void; onChanged(): void }) {
  const { data, error } = useApi<LeadDetail>(id ? `leads/${encodeURIComponent(id)}` : null);
  const { isAdmin } = useAuth();
  const { run } = useFeedback();

  async function retry() {
    if (!data) return;
    const out = await run("Retry started", () => post("leads/retry", { id: data.id }));
    if (out) {
      onChanged();
      onClose();
    }
  }

  return (
    <Dialog open={!!id} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{data?.name || "Lead"}</DialogTitle>
      <DialogContent dividers>
        <ErrorNote error={error} />
        {data && (
          <Stack gap={2}>
            <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
              <StatusChip value={data.status} />
              <Chip size="small" variant="outlined" label={SOURCE_LABEL[data.source] ?? data.source} />
              <Typography variant="body2" color="text.secondary">
                Received {fmtDate(data.receivedAt)} · {data.attempts} attempt{data.attempts === 1 ? "" : "s"}
              </Typography>
            </Stack>
            {data.reason && <Alert severity={data.status === "failed" ? "error" : "info"}>{data.reason}</Alert>}
            <Box>
              <Typography variant="overline" color="text.secondary">Tags</Typography>
              <Stack direction="row" gap={0.75} flexWrap="wrap" mt={0.5}>
                {data.tags.length ? data.tags.map((t) => <Chip key={t} size="small" label={t} />) : <Typography variant="body2">None</Typography>}
              </Stack>
            </Box>
            <Box>
              <Typography variant="overline" color="text.secondary">Lead as we understood it</Typography>
              <Box component="pre" sx={{ m: 0, p: 2, bgcolor: "action.hover", borderRadius: 2, overflow: "auto", fontSize: 12.5 }}>
                {JSON.stringify(data.lead, null, 2)}
              </Box>
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        {isAdmin && data?.retryable && (
          <Button variant="contained" onClick={() => void retry()}>
            Retry processing
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export function LeadsPage() {
  const [paging, setPaging] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
  const [sort, setSort] = useState<GridSortModel>([{ field: "receivedAt", sort: "desc" }]);
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const s = sort[0];
  const qs = new URLSearchParams({
    limit: String(paging.pageSize),
    offset: String(paging.page * paging.pageSize),
    sort: s?.field ?? "receivedAt",
    dir: s?.sort ?? "desc",
    ...(status ? { status } : {}),
    ...(source ? { source } : {}),
  });
  const { data, error, loading, reload } = useApi<{ items: Lead[]; total: number }>(`leads?${qs}`);

  const columns: GridColDef<Lead>[] = [
    { field: "name", headerName: "Name", flex: 1, minWidth: 160, sortable: false, valueGetter: (v) => v || "—" },
    { field: "source", headerName: "Source", width: 150, valueFormatter: (v: string) => SOURCE_LABEL[v] ?? v },
    { field: "status", headerName: "Status", width: 150, renderCell: (p) => <StatusChip value={p.value} /> },
    { field: "email", headerName: "Email", flex: 1, minWidth: 190, sortable: false, valueGetter: (v) => v || "—" },
    { field: "phone", headerName: "Phone", width: 150, sortable: false, valueGetter: (v) => v || "—" },
    { field: "attempts", headerName: "Tries", width: 80, type: "number" },
    { field: "receivedAt", headerName: "Received", width: 170, valueFormatter: (v: string) => fmtDate(v) },
  ];

  return (
    <>
      <PageHeader
        title="Leads"
        subtitle="Everyone who reached you — chat, voice, forms and ads — merged by person."
        actions={
          <>
          <TextField select size="small" label="Source" value={source} onChange={(e) => { setSource(e.target.value); setPaging((p) => ({ ...p, page: 0 })); }} sx={{ minWidth: 170 }}>
            <MenuItem value="">All sources</MenuItem>
            {SOURCES.map((v) => <MenuItem key={v} value={v}>{SOURCE_LABEL[v] ?? v}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPaging((p) => ({ ...p, page: 0 })); }} sx={{ minWidth: 160 }}>
            <MenuItem value="">All</MenuItem>
            {STATUSES.map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
          </TextField>
          </>
        }
      />
      <ErrorNote error={error} />
      <DataTable
        rows={data?.items ?? []}
        rowCount={data?.total ?? 0}
        columns={columns}
        loading={loading}
        paginationMode="server"
        sortingMode="server"
        paginationModel={paging}
        onPaginationModelChange={setPaging}
        sortModel={sort}
        onSortModelChange={setSort}
        onRowClick={(p) => setOpen(String(p.id))}
        emptyText="No leads yet"
      />
      <LeadDialog id={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />
    </>
  );
}
