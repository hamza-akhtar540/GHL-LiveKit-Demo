import { useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import type { GridColDef } from "@mui/x-data-grid";
import { post, useApi } from "../api";
import { useAuth } from "../auth";
import { fmtDate } from "../format";
import { useFeedback } from "../components/feedback";
import { DataTable, ErrorNote, PageHeader, StatusChip } from "../components/ui";
import { Box, Stack, Typography } from "../components/sys";

interface Account {
  id: string;
  name: string;
  platform: string;
  expire?: string;
  isExpired?: boolean;
}
interface Post {
  id: string;
  platform: string;
  status: string;
  summary?: string;
  scheduleDate?: string | null;
  publishedAt?: string | null;
  topic?: string | null;
  askedBy?: number | null;
  accountName?: string | null;
}
interface Insight {
  weekday: number;
  name: string;
  days: number;
  avgImpressions: number;
  avgLikes: number;
  score: number;
}
interface Res {
  accounts: Account[];
  posts: Post[];
  unmanageable: { id: string; platform: string; status: string; topic: string; error: string | null }[];
  insights: Insight[];
  duplicateSlots: { at: string; count: number }[];
  timezone: string;
}

export function SocialPage() {
  const { data, error, loading, reload } = useApi<Res>("social", { refreshMs: 60_000 });
  const { isAdmin } = useAuth();
  const { confirm, run } = useFeedback();
  const [busy, setBusy] = useState(false);
  const tz = data?.timezone;

  async function act(kind: "draft" | "schedule" | "publish") {
    if (kind === "publish") {
      const ok = await confirm({
        title: "Publish to your live accounts now?",
        body: "Posts go out immediately to real audiences and can't be recalled from feeds that already showed them. Scheduling is the safer option.",
        confirmLabel: "Publish now",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    const label = { draft: "Drafts created", schedule: "Posts scheduled", publish: "Posts published" }[kind];
    await run(label, () => post(`social/${kind}`));
    setBusy(false);
    void reload();
  }

  async function remove(p: Post) {
    const ok = await confirm({ title: "Delete this post?", body: "It is removed from GoHighLevel's Social Planner.", confirmLabel: "Delete", danger: true });
    if (ok && (await run("Post deleted", () => post("social/delete", { id: p.id })))) void reload();
  }

  const columns: GridColDef<Post>[] = [
    { field: "platform", headerName: "Platform", width: 120, renderCell: (p) => <Chip size="small" variant="outlined" label={p.value} /> },
    { field: "accountName", headerName: "Account", width: 170, valueGetter: (v) => v || "—" },
    { field: "status", headerName: "Status", width: 130, renderCell: (p) => <StatusChip value={p.value} /> },
    { field: "summary", headerName: "Post", flex: 3, minWidth: 320 },
    { field: "topic", headerName: "Based on", width: 170, valueGetter: (v, r) => (v ? `${v}${r.askedBy ? ` · asked ${r.askedBy}×` : ""}` : "—") },
    { field: "when", headerName: "When", width: 180, valueGetter: (_v, r) => r.scheduleDate ?? r.publishedAt ?? null, valueFormatter: (v: string | null) => fmtDate(v, tz) },
    ...(isAdmin
      ? [{
          field: "actions", headerName: "", width: 100, sortable: false,
          renderCell: (p) => <Button size="small" color="error" onClick={() => void remove(p.row)}>Delete</Button>,
        } satisfies GridColDef<Post>]
      : []),
  ];

  const best = data?.insights?.slice().sort((a, b) => b.score - a.score)[0];

  return (
    <>
      <PageHeader
        title="Social"
        subtitle="Posts are written from what customers actually ask, then scheduled through GoHighLevel."
        actions={
          isAdmin && (
            <>
              <Button variant="outlined" disabled={busy} onClick={() => void act("draft")}>Create drafts</Button>
              <Button variant="contained" disabled={busy} onClick={() => void act("schedule")}>Schedule at best time</Button>
              <Button color="error" disabled={busy} onClick={() => void act("publish")}>Publish now</Button>
            </>
          )
        }
      />
      <ErrorNote error={error} />

      {data?.duplicateSlots?.length ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {data.duplicateSlots.map((d) => `${d.count} posts share ${fmtDate(d.at, tz)}`).join(" · ")}. Delete the extras you don't want.
        </Alert>
      ) : null}

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "2fr 1fr" }, mb: 3 }}>
        <Card>
          <CardContent>
            <Typography variant="overline" color="text.secondary">Connected accounts</Typography>
            <Stack direction="row" gap={1} flexWrap="wrap" mt={1}>
              {data?.accounts.length ? (
                data.accounts.map((a) => (
                  <Chip key={a.id} label={`${a.platform} · ${a.name}`} color={a.isExpired ? "error" : "success"} variant="outlined" />
                ))
              ) : (
                <Typography color="text.secondary">{loading ? "Loading…" : "No accounts connected in GoHighLevel."}</Typography>
              )}
            </Stack>
            {data?.accounts.some((a) => a.isExpired) && (
              <Alert severity="error" sx={{ mt: 2 }}>An account's connection has expired. Reconnect it in GoHighLevel's Social Planner or posts will fail.</Alert>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="overline" color="text.secondary">Best day to post</Typography>
            <Typography variant="h6" mt={1}>{best ? best.name : "Still learning"}</Typography>
            <Typography variant="body2" color="text.secondary">
              {best ? `Based on ${best.days} day${best.days === 1 ? "" : "s"} of engagement data.` : "Needs a few weeks of real engagement before it can say anything true."}
            </Typography>
          </CardContent>
        </Card>
      </Box>

      <DataTable rows={data?.posts ?? []} columns={columns} loading={loading} emptyText="No posts yet — create drafts or schedule one" />

      {data?.unmanageable?.length ? (
        <Typography variant="body2" color="text.secondary" mt={2}>
          {data.unmanageable.length} older record{data.unmanageable.length === 1 ? "" : "s"} no longer exist in GoHighLevel and can't be managed here.
        </Typography>
      ) : null}
    </>
  );
}
