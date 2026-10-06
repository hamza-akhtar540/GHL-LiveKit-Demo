import { useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import TextField from "@mui/material/TextField";
import CloseIcon from "@mui/icons-material/Close";
import { post, useApi } from "../api";
import { useAuth } from "../auth";
import { fmtDate } from "../format";
import { useFeedback } from "../components/feedback";
import { ErrorNote, StatusChip } from "../components/ui";
import { Box, Stack, Typography } from "../components/sys";

interface Message {
  role: "caller" | "agent" | "admin";
  text: string;
  at: string;
}
interface Convo {
  id: string;
  channel: string;
  contactId?: string | null;
  contact: Record<string, string>;
  messages: Message[];
  outcome?: string | null;
  bookingCode?: string | null;
  updatedAt: string;
}

const WHO = { caller: "Customer", agent: "AI agent", admin: "Staff" } as const;

export function ConversationDrawer({ id, onClose }: { id: string | null; onClose(): void }) {
  const { data, error, loading, reload } = useApi<Convo>(id ? `conversations/${encodeURIComponent(id)}` : null, { refreshMs: 8000 });
  const { isAdmin } = useAuth();
  const { run, confirm } = useFeedback();
  const [reply, setReply] = useState("");

  async function send() {
    if (!data?.contactId || !reply.trim()) return;
    const ok = await confirm({
      title: "Send this reply?",
      body: `This emails ${data.contact.email ?? "the customer"} through GoHighLevel and is recorded in the transcript.`,
      confirmLabel: "Send reply",
    });
    if (!ok) return;
    const out = await run("Reply sent", () =>
      post("conversations/reply", { conversationId: data.id, contactId: data.contactId, message: reply.trim() }),
    );
    if (out) {
      setReply("");
      void reload();
    }
  }

  return (
    <Drawer anchor="right" open={!!id} onClose={onClose} slotProps={{ paper: { sx: { width: { xs: "100%", sm: 520 } } } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" px={3} py={2}>
        <Box minWidth={0}>
          <Typography variant="h6" noWrap>
            {data?.contact.full_name || "Conversation"}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {data ? `${data.channel} · updated ${fmtDate(data.updatedAt)}` : id}
          </Typography>
        </Box>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseIcon />
        </IconButton>
      </Stack>
      <Divider />
      {loading && <LinearProgress />}
      <Box px={3} py={2} flex={1} overflow="auto">
        <ErrorNote error={error} />
        {data && (
          <>
            <Stack direction="row" gap={1} flexWrap="wrap" mb={2}>
              <StatusChip value={data.outcome ?? "open"} />
              {data.bookingCode && <StatusChip value="booked" />}
              {data.contact.email && <Typography variant="body2">{data.contact.email}</Typography>}
              {data.contact.phone && <Typography variant="body2">· {data.contact.phone}</Typography>}
            </Stack>
            <Stack gap={1.5}>
              {data.messages.map((m, i) => {
                const mine = m.role !== "caller";
                return (
                  <Box key={i} alignSelf={mine ? "flex-end" : "flex-start"} maxWidth="85%">
                    <Typography variant="caption" color="text.secondary" display="block" textAlign={mine ? "right" : "left"}>
                      {WHO[m.role]} · {fmtDate(m.at)}
                    </Typography>
                    <Box
                      sx={{
                        mt: 0.25,
                        px: 1.75,
                        py: 1,
                        borderRadius: 2,
                        whiteSpace: "pre-wrap",
                        bgcolor: m.role === "caller" ? "action.hover" : m.role === "admin" ? "secondary.main" : "primary.main",
                        color: m.role === "caller" ? "text.primary" : "primary.contrastText",
                      }}
                    >
                      {m.text}
                    </Box>
                  </Box>
                );
              })}
              {!data.messages.length && <Typography color="text.secondary">No messages recorded.</Typography>}
            </Stack>
          </>
        )}
      </Box>
      {isAdmin && data && (
        <>
          <Divider />
          <Box p={2}>
            {!data.contactId || !data.contact.email ? (
              <Alert severity="info">Replies need a CRM contact with an email address.</Alert>
            ) : (
              <Stack gap={1}>
                <TextField size="small" multiline minRows={2} placeholder="Reply by email…" value={reply} onChange={(e) => setReply(e.target.value)} />
                <Button variant="contained" onClick={() => void send()} disabled={!reply.trim()} sx={{ alignSelf: "flex-end" }}>
                  Send reply
                </Button>
              </Stack>
            )}
          </Box>
        </>
      )}
    </Drawer>
  );
}
