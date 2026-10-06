import { useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Avatar from "@mui/material/Avatar";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import DashboardIcon from "@mui/icons-material/SpaceDashboardOutlined";
import SensorsIcon from "@mui/icons-material/SensorsOutlined";
import SupportAgentIcon from "@mui/icons-material/SupportAgentOutlined";
import ChatIcon from "@mui/icons-material/ChatBubbleOutlineOutlined";
import PersonSearchIcon from "@mui/icons-material/PersonSearchOutlined";
import EventIcon from "@mui/icons-material/EventAvailableOutlined";
import TrendingUpIcon from "@mui/icons-material/TrendingUpOutlined";
import ContactsIcon from "@mui/icons-material/ContactsOutlined";
import MailIcon from "@mui/icons-material/MailOutlined";
import CampaignIcon from "@mui/icons-material/CampaignOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import DarkModeIcon from "@mui/icons-material/DarkModeOutlined";
import LightModeIcon from "@mui/icons-material/LightModeOutlined";
import LockIcon from "@mui/icons-material/LockOutlined";
import { useAuth } from "../auth";
import { Box, Typography } from "./sys";

const WIDTH = 250;

const NAV: { heading: string; items: { to: string; label: string; icon: ReactNode }[] }[] = [
  {
    heading: "Operations",
    items: [
      { to: "/", label: "Overview", icon: <DashboardIcon /> },
      { to: "/live", label: "Live sessions", icon: <SensorsIcon /> },
      { to: "/needs-human", label: "Needs a human", icon: <SupportAgentIcon /> },
    ],
  },
  {
    heading: "Pipeline",
    items: [
      { to: "/conversations", label: "Conversations", icon: <ChatIcon /> },
      { to: "/leads", label: "Leads", icon: <PersonSearchIcon /> },
      { to: "/bookings", label: "Bookings", icon: <EventIcon /> },
      { to: "/opportunities", label: "Opportunities", icon: <TrendingUpIcon /> },
      { to: "/contacts", label: "Contacts", icon: <ContactsIcon /> },
    ],
  },
  {
    heading: "Engagement",
    items: [
      { to: "/emails", label: "Emails", icon: <MailIcon /> },
      { to: "/social", label: "Social", icon: <CampaignIcon /> },
    ],
  },
];

const AUTOSEND_CHIP = {
  on: { label: "Email sending: live", color: "success" as const },
  dry_run: { label: "Email sending: held (dry run)", color: "warning" as const },
  off: { label: "Email sending: off", color: "default" as const },
};

export function Layout({
  children,
  mode,
  onToggleMode,
}: {
  children: ReactNode;
  mode: "light" | "dark";
  onToggleMode: () => void;
}) {
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const { me, logout, isAdmin } = useAuth();
  const { pathname } = useLocation();

  const nav = (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toolbar sx={{ gap: 1.5 }}>
        <Avatar sx={{ bgcolor: "primary.main", width: 34, height: 34, fontWeight: 700 }}>
          {(me?.business.name ?? "A").slice(0, 1)}
        </Avatar>
        <Box minWidth={0}>
          <Typography variant="subtitle2" noWrap fontWeight={700}>
            {me?.business.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Admin console
          </Typography>
        </Box>
      </Toolbar>
      <Divider />
      <Box sx={{ overflowY: "auto", flex: 1, py: 1 }}>
        {NAV.map((group) => (
          <List
            key={group.heading}
            dense
            subheader={
              <ListSubheader disableSticky sx={{ bgcolor: "transparent", lineHeight: "32px", fontWeight: 700, letterSpacing: 0.6, fontSize: 11, textTransform: "uppercase" }}>
                {group.heading}
              </ListSubheader>
            }
          >
            {group.items.map((item) => {
              const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
              return (
                <ListItemButton
                  key={item.to}
                  component={NavLink}
                  to={item.to}
                  selected={active}
                  onClick={() => setOpen(false)}
                  sx={{ mx: 1, borderRadius: 2, mb: 0.25 }}
                >
                  <ListItemIcon sx={{ minWidth: 38, color: active ? "primary.main" : "inherit" }}>{item.icon}</ListItemIcon>
                  <ListItemText primary={item.label} slotProps={{ primary: { sx: { fontWeight: active ? 700 : 500 } } }} />
                </ListItemButton>
              );
            })}
          </List>
        ))}
      </Box>
    </Box>
  );

  const autosend = AUTOSEND_CHIP[me?.autosend ?? "dry_run"];

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar
        position="fixed"
        elevation={0}
        color="inherit"
        sx={{ width: { md: `calc(100% - ${WIDTH}px)` }, ml: { md: `${WIDTH}px` }, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}
      >
        <Toolbar sx={{ gap: 1 }}>
          {!wide && (
            <IconButton edge="start" onClick={() => setOpen(true)} aria-label="Open navigation">
              <MenuIcon />
            </IconButton>
          )}
          <Box flex={1} />
          {me && me.capabilities.ghl && wide && <Chip size="small" variant="outlined" color={autosend.color} label={autosend.label} />}
          {!isAdmin && <Chip size="small" icon={<LockIcon />} color="info" label="Read-only" />}
          <Tooltip title={mode === "dark" ? "Light mode" : "Dark mode"}>
            <IconButton onClick={onToggleMode}>{mode === "dark" ? <LightModeIcon /> : <DarkModeIcon />}</IconButton>
          </Tooltip>
          <IconButton onClick={(e) => setMenu(e.currentTarget)} aria-label="Account menu">
            <Avatar sx={{ width: 32, height: 32, fontSize: 14, bgcolor: "secondary.main" }}>
              {(me?.user.email ?? "?").slice(0, 1).toUpperCase()}
            </Avatar>
          </IconButton>
          <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
            <Box px={2} py={1}>
              <Typography variant="body2" fontWeight={600}>
                {me?.user.email}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {isAdmin ? "Administrator" : "Viewer · read-only"}
              </Typography>
            </Box>
            <Divider />
            <MenuItem onClick={() => void logout()}>Sign out</MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { md: WIDTH }, flexShrink: { md: 0 } }}>
        <Drawer
          variant={wide ? "permanent" : "temporary"}
          open={wide || open}
          onClose={() => setOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{ "& .MuiDrawer-paper": { width: WIDTH, boxSizing: "border-box" } }}
        >
          {nav}
        </Drawer>
      </Box>

      <Box component="main" sx={{ flex: 1, minWidth: 0, bgcolor: "background.default" }}>
        <Toolbar />
        <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 1500, mx: "auto" }}>{children}</Box>
      </Box>
    </Box>
  );
}
