import Chip from "@mui/material/Chip";
import Button from "@mui/material/Button";
import type { GridColDef } from "@mui/x-data-grid";
import { post, useApi } from "../api";
import { useAuth } from "../auth";
import { fmtDate } from "../format";
import { useFeedback } from "../components/feedback";
import { DataTable, ErrorNote, PageHeader, StatusChip } from "../components/ui";
import { Typography } from "../components/sys";

interface Booking {
  code: string | null;
  externalId?: string | null;
  fullName?: string | null;
  resourceId?: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  source: "both" | "index-only" | "ghl-only";
  canCancel?: boolean;
  email?: string | null;
}
interface Res {
  items: Booking[];
  counts: { total: number; both: number; indexOnly: number; ghlOnly: number };
  timezone: string;
}

const SOURCE = { both: "Synced", "index-only": "Not in GHL", "ghl-only": "Added in GHL" } as const;

export function BookingsPage() {
  const { data, error, loading, reload } = useApi<Res>("bookings?limit=200", { refreshMs: 30_000 });
  const { isAdmin } = useAuth();
  const { confirm, run } = useFeedback();
  const tz = data?.timezone;

  async function cancel(b: Booking) {
    const ok = await confirm({
      title: "Cancel this booking?",
      body: `${b.fullName ?? "This booking"} (${b.code}) will be cancelled in GoHighLevel. This can't be undone from here.`,
      confirmLabel: "Cancel booking",
      danger: true,
    });
    if (ok && (await run("Booking cancelled", () => post("bookings/cancel", { code: b.code })))) void reload();
  }

  const columns: GridColDef<Booking>[] = [
    { field: "startsAt", headerName: "When", width: 190, valueFormatter: (v: string) => fmtDate(v, tz) },
    { field: "fullName", headerName: "Guest", flex: 1, minWidth: 160, valueGetter: (v) => v || "—" },
    { field: "resourceId", headerName: "What", width: 150, valueGetter: (v) => v || "—" },
    { field: "status", headerName: "Status", width: 130, renderCell: (p) => <StatusChip value={p.value} /> },
    { field: "source", headerName: "Source", width: 140, renderCell: (p) => <Chip size="small" variant="outlined" label={SOURCE[p.value as Booking["source"]] ?? p.value} /> },
    { field: "code", headerName: "Reference", width: 130, valueGetter: (v) => v || "—" },
    ...(isAdmin
      ? [{
          field: "actions", headerName: "", width: 110, sortable: false,
          renderCell: (p) => p.row.canCancel && p.row.status === "confirmed"
            ? <Button size="small" color="error" onClick={(e) => { e.stopPropagation(); void cancel(p.row); }}>Cancel</Button>
            : null,
        } satisfies GridColDef<Booking>]
      : []),
  ];

  return (
    <>
      <PageHeader title="Bookings" subtitle={data ? `${data.counts.total} total · times shown in ${data.timezone}` : "Appointments from the calendar and our index"} />
      <ErrorNote error={error} />
      {data && data.counts.ghlOnly > 0 && (
        <Typography variant="body2" color="text.secondary" mb={2}>
          {data.counts.ghlOnly} booking{data.counts.ghlOnly === 1 ? " was" : "s were"} created directly in GoHighLevel.
        </Typography>
      )}
      <DataTable rows={data?.items ?? []} columns={columns} loading={loading} getRowId={(r) => r.code ?? r.externalId ?? `${r.startsAt}-${r.fullName}`} emptyText="No bookings yet" />
    </>
  );
}
