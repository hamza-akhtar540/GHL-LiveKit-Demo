import type { ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Chip, { type ChipProps } from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import { DataGrid, type DataGridProps, type GridValidRowModel } from "@mui/x-data-grid";
import { ApiError } from "../api";
import { Box, Stack, Typography } from "./sys";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} gap={2} mb={3}>
      <Box>
        <Typography variant="h5">{title}</Typography>
        {subtitle && (
          <Typography variant="body2" color="text.secondary" mt={0.5}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions && <Stack direction="row" gap={1} flexWrap="wrap">{actions}</Stack>}
    </Stack>
  );
}

const TONE: Record<string, ChipProps["color"]> = {
  // outcomes / statuses that mean good
  booked: "success", confirmed: "success", sent: "success", created: "success", published: "success", won: "success", showed: "success", open: "info",
  // waiting on a person
  send_disabled: "warning", composed: "warning", scheduled: "info", draft: "default", merged: "info", handed_off: "warning", received: "warning",
  // bad
  failed: "error", cancelled: "error", canceled: "error", rejected: "error", no_show: "error", lost: "error", abandoned: "warning",
  // quiet
  duplicate: "default", enquiry_only: "default", discarded: "default", skipped_already_contacted: "default",
};

const LABEL: Record<string, string> = {
  send_disabled: "Held · awaiting send",
  composed: "Ready to send",
  handed_off: "Needs a human",
  enquiry_only: "Enquiry only",
  skipped_already_contacted: "Already contacted",
  no_show: "No-show",
};

export function StatusChip({ value }: { value?: string | null }) {
  if (!value) return <Chip size="small" label="—" variant="outlined" />;
  const label = LABEL[value] ?? value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return <Chip size="small" label={label} color={TONE[value] ?? "default"} variant={TONE[value] ? "filled" : "outlined"} />;
}

/** A failed request, explained — including the "viewers can't see this" case. */
export function ErrorNote({ error }: { error?: ApiError }) {
  if (!error) return null;
  const restricted = error.status === 403;
  const unavailable = error.status === 503;
  return (
    <Alert severity={restricted || unavailable ? "info" : "error"} sx={{ mb: 2 }}>
      {restricted ? "Not available for your account. " : ""}
      {error.message}
    </Alert>
  );
}

export function DataTable<R extends GridValidRowModel>(props: DataGridProps<R> & { emptyText?: string }) {
  const { emptyText = "Nothing here yet", sx, ...rest } = props;
  return (
    <Box sx={{ bgcolor: "background.paper", borderRadius: 2 }}>
      <DataGrid<R>
        autoHeight
        disableRowSelectionOnClick
        pageSizeOptions={[10, 25, 50]}
        initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
        slots={{ loadingOverlay: () => <LinearProgress />, noRowsOverlay: () => <Empty text={emptyText} /> }}
        getRowHeight={() => "auto"}
        sx={{
          border: 1,
          borderColor: "divider",
          "& .MuiDataGrid-columnHeaders": { bgcolor: "action.hover" },
          "& .MuiDataGrid-cell": { py: 1.25, display: "flex", alignItems: "center" },
          "& .MuiDataGrid-row": { cursor: rest.onRowClick ? "pointer" : "default" },
          ...sx,
        }}
        {...rest}
      />
    </Box>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <Stack alignItems="center" justifyContent="center" height="100%" py={6}>
      <Typography color="text.secondary">{text}</Typography>
    </Stack>
  );
}
