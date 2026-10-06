import { useEffect, useState } from "react";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import SearchIcon from "@mui/icons-material/Search";
import type { GridColDef } from "@mui/x-data-grid";
import { get, useApi, type ApiError } from "../api";
import { fmtDate, money } from "../format";
import { DataTable, ErrorNote, PageHeader, StatusChip } from "../components/ui";
import { ConversationDrawer } from "./ConversationDrawer";
import { Box, Stack, Typography } from "../components/sys";

// ------------------------------------------------------------ needs a human --

interface Needs {
  items: {
    source: "conversation" | "crm-tag";
    conversationId: string | null;
    contactId: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    channel: string;
    lastMessage: string | null;
    at: string;
  }[];
  counts: { fromConversations: number; fromCrm: number };
}

export function NeedsHumanPage() {
  const { data, error, loading } = useApi<Needs>("needs-human", { refreshMs: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  const columns: GridColDef<Needs["items"][number]>[] = [
    { field: "name", headerName: "Who", flex: 1, minWidth: 170, valueGetter: (v, r) => v || r.email || r.phone || "Unknown" },
    { field: "channel", headerName: "Where", width: 110, renderCell: (p) => <StatusChip value={p.value} /> },
    { field: "lastMessage", headerName: "Last thing they said", flex: 2, minWidth: 280, valueGetter: (v) => v || "—" },
    { field: "email", headerName: "Email", width: 220, valueGetter: (v) => v || "—" },
    { field: "phone", headerName: "Phone", width: 150, valueGetter: (v) => v || "—" },
    { field: "at", headerName: "Since", width: 170, valueFormatter: (v: string) => fmtDate(v) },
  ];
  return (
    <>
      <PageHeader title="Needs a human" subtitle="People the AI handed off, or that someone tagged in the CRM. Work through these first." />
      <ErrorNote error={error} />
      <DataTable
        rows={data?.items ?? []}
        columns={columns}
        loading={loading}
        getRowId={(r) => r.conversationId ?? r.contactId ?? `${r.at}-${r.name}`}
        onRowClick={(p) => p.row.conversationId && setOpen(p.row.conversationId)}
        emptyText="Nobody is waiting on a person"
      />
      <ConversationDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}

// ------------------------------------------------------------ opportunities --

interface Opp {
  id: string;
  name: string;
  status: string;
  stageName: string;
  monetaryValue?: number;
  updatedAt?: string;
}

export function OpportunitiesPage() {
  const { data, error, loading } = useApi<{ items: Opp[]; total: number }>("opportunities?limit=100");
  const columns: GridColDef<Opp>[] = [
    { field: "name", headerName: "Opportunity", flex: 1, minWidth: 200 },
    { field: "stageName", headerName: "Stage", width: 170 },
    { field: "status", headerName: "Status", width: 120, renderCell: (p) => <StatusChip value={p.value} /> },
    { field: "monetaryValue", headerName: "Value", width: 120, valueFormatter: (v: unknown) => money(v) },
    { field: "updatedAt", headerName: "Updated", width: 170, valueFormatter: (v: string) => fmtDate(v) },
  ];
  return (
    <>
      <PageHeader title="Opportunities" subtitle={data ? `${data.total} in the pipeline` : "From GoHighLevel"} />
      <ErrorNote error={error} />
      <DataTable rows={data?.items ?? []} columns={columns} loading={loading} emptyText="No opportunities yet" />
    </>
  );
}

// ----------------------------------------------------------------- contacts --

interface Contact {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  tags?: string[];
  dnd?: boolean;
  source?: string;
  dateAdded?: string;
}
interface ContactsRes {
  items: Contact[];
  total: number;
  nextCursor: { startAfter: string; startAfterId: string } | null;
}

export function ContactsPage() {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Contact[]>([]);
  const [cursor, setCursor] = useState<ContactsRes["nextCursor"]>(null);
  const [total, setTotal] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError>();

  // Debounced, so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);

  async function load(append: boolean, from?: ContactsRes["nextCursor"]) {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: "50", ...(q ? { q } : {}), ...(from ?? {}) });
      const res = await get<ContactsRes>(`contacts?${qs}`);
      setRows((prev) => (append ? [...prev, ...res.items] : res.items));
      setCursor(res.nextCursor);
      setTotal(res.total);
      setError(undefined);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const columns: GridColDef<Contact>[] = [
    { field: "name", headerName: "Name", flex: 1, minWidth: 170, valueGetter: (_v, r) => [r.firstName, r.lastName].filter(Boolean).join(" ") || "—" },
    { field: "email", headerName: "Email", flex: 1, minWidth: 210, valueGetter: (v) => v || "—" },
    { field: "phone", headerName: "Phone", width: 150, valueGetter: (v) => v || "—" },
    {
      field: "tags", headerName: "Tags", flex: 1, minWidth: 220, sortable: false,
      renderCell: (p) => (
        <Stack direction="row" gap={0.5} flexWrap="wrap" py={0.5}>
          {(p.row.tags ?? []).slice(0, 4).map((t) => <Chip key={t} size="small" label={t} />)}
          {p.row.dnd && <Chip size="small" color="error" label="Do not contact" />}
        </Stack>
      ),
    },
    { field: "dateAdded", headerName: "Added", width: 170, valueFormatter: (v: string) => fmtDate(v) },
  ];

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle={total !== undefined ? `${total.toLocaleString()} in GoHighLevel` : "From GoHighLevel"}
        actions={
          <TextField
            size="small"
            placeholder="Search name, email or phone"
            value={text}
            onChange={(e) => setText(e.target.value)}
            sx={{ minWidth: 280 }}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
          />
        }
      />
      <ErrorNote error={error} />
      <DataTable rows={rows} columns={columns} loading={loading} emptyText={q ? "No contacts match" : "No contacts yet"} />
      {cursor && (
        <Box textAlign="center" mt={2}>
          <Button onClick={() => void load(true, cursor)} disabled={loading}>Load more</Button>
        </Box>
      )}
    </>
  );
}

// -------------------------------------------------------------------- live --

interface Rooms {
  rooms: { name: string; numParticipants: number; createdAt?: string; participants: { identity: string; name?: string; hasAudio: boolean }[] }[];
  error?: string;
}

export function LivePage() {
  const { data, error } = useApi<Rooms>("live", { refreshMs: 4000 });
  return (
    <>
      <PageHeader title="Live sessions" subtitle="Calls and voice chats happening right now. Refreshes every few seconds." />
      <ErrorNote error={error} />
      {data?.error && <ErrorNote error={{ message: data.error, status: 503, name: "" } as ApiError} />}
      {!data?.rooms.length ? (
        <Card><CardContent><Typography color="text.secondary">No live sessions at the moment.</Typography></CardContent></Card>
      ) : (
        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)" } }}>
          {data.rooms.map((r) => (
            <Card key={r.name}>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography fontWeight={700} noWrap>{r.name}</Typography>
                  <Chip size="small" color="success" label="Live" />
                </Stack>
                <Typography variant="body2" color="text.secondary" mt={0.5}>
                  {r.numParticipants} participant{r.numParticipants === 1 ? "" : "s"} · started {fmtDate(r.createdAt)}
                </Typography>
                <Stack direction="row" gap={0.75} flexWrap="wrap" mt={1.5}>
                  {r.participants.map((p) => (
                    <Chip key={p.identity} size="small" variant="outlined" label={`${p.name || p.identity}${p.hasAudio ? " · mic on" : ""}`} />
                  ))}
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Box>
      )}
    </>
  );
}
