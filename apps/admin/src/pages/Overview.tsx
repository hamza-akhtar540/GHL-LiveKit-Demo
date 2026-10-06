import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import Skeleton from "@mui/material/Skeleton";
import { useApi } from "../api";
import { useAuth } from "../auth";
import { ago } from "../format";
import { ErrorNote, PageHeader } from "../components/ui";
import { Box, Stack, Typography } from "../components/sys";

interface Overview {
  conversations: number;
  bookings: number;
  leads: number;
  emailsSent: number;
  socialPosts: number;
  opportunities?: number;
  contacts?: number;
  queues: { draftsAwaitingSend: number; stuckLeads: number; bookingsNext48h: number; handoffConversations: number };
  generatedAt: string;
}

const grid = { display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, 1fr)" } };

function Stat({ label, value, to }: { label: string; value?: number; to: string }) {
  return (
    <Card>
      <CardActionArea component={RouterLink} to={to} sx={{ p: 2.5 }}>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h4" fontWeight={700} mt={0.5}>
          {value === undefined ? <Skeleton width={60} /> : value.toLocaleString()}
        </Typography>
      </CardActionArea>
    </Card>
  );
}

function Queue({ label, hint, value, to, tone }: { label: string; hint: string; value?: number; to: string; tone: "warning" | "error" | "info" }) {
  const live = (value ?? 0) > 0;
  return (
    <Card sx={{ borderColor: live ? `${tone}.main` : undefined, borderLeftWidth: live ? 4 : 1 }}>
      <CardActionArea component={RouterLink} to={to} sx={{ p: 2.5 }}>
        <Typography variant="h4" fontWeight={700} color={live ? `${tone}.main` : "text.primary"}>
          {value === undefined ? <Skeleton width={40} /> : value}
        </Typography>
        <Typography fontWeight={600}>{label}</Typography>
        <Typography variant="body2" color="text.secondary">
          {hint}
        </Typography>
      </CardActionArea>
    </Card>
  );
}

export function OverviewPage() {
  const { data, error } = useApi<Overview>("overview", { refreshMs: 30_000 });
  const { me } = useAuth();
  const q = data?.queues;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={data ? `Updated ${ago(data.generatedAt)}` : "Loading…"}
        actions={
          <Button component={RouterLink} to="/needs-human" variant="contained">
            Open work queue
          </Button>
        }
      />
      <ErrorNote error={error} />

      {me?.autosend !== "on" && (q?.draftsAwaitingSend ?? 0) > 0 && (
        <Alert severity="warning" sx={{ mb: 3 }} action={<Button component={RouterLink} to="/emails" color="inherit" size="small">Review</Button>}>
          {q!.draftsAwaitingSend} follow-up email{q!.draftsAwaitingSend === 1 ? " is" : "s are"} written and waiting. Automatic sending is{" "}
          {me?.autosend === "off" ? "off" : "in dry-run"}, so nothing goes out until you send it here.
        </Alert>
      )}

      <Typography variant="overline" color="text.secondary">
        Needs attention
      </Typography>
      <Box sx={{ ...grid, mb: 4, mt: 1 }}>
        <Queue label="Emails awaiting send" hint="Written, not yet sent" value={q?.draftsAwaitingSend} to="/emails" tone="warning" />
        <Queue label="Asked for a person" hint="Handed off by the AI" value={q?.handoffConversations} to="/needs-human" tone="error" />
        <Queue label="Stuck leads" hint="Not finished in the CRM" value={q?.stuckLeads} to="/leads" tone="error" />
        <Queue label="Bookings, next 48h" hint="Coming up" value={q?.bookingsNext48h} to="/bookings" tone="info" />
      </Box>

      <Typography variant="overline" color="text.secondary">
        Totals
      </Typography>
      <Box sx={{ ...grid, mt: 1 }}>
        <Stat label="Conversations" value={data?.conversations} to="/conversations" />
        <Stat label="Leads captured" value={data?.leads} to="/leads" />
        <Stat label="Active bookings" value={data?.bookings} to="/bookings" />
        <Stat label="Emails sent" value={data?.emailsSent} to="/emails" />
        <Stat label="Opportunities" value={data?.opportunities} to="/opportunities" />
        <Stat label="Contacts" value={data?.contacts} to="/contacts" />
        <Stat label="Social posts" value={data?.socialPosts} to="/social" />
      </Box>
      <Stack mt={4}>
        <Typography variant="caption" color="text.secondary">
          Follow-ups and social posting run automatically in the background{me?.automation === false ? " (currently switched off)" : ""}.
        </Typography>
      </Stack>
    </>
  );
}
