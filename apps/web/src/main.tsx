import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useLocation, useNavigate } from '@tanstack/react-router';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import {
  PRODUCT_NAME,
  appearanceResponseSchema,
  type AppearanceResponse,
} from "@station/shared";
import { applyTheme, DEFAULT_SEED } from "@station/theme";
import {
  cleared,
  events,
  inbox,
  needs,
  orbits,
  promises,
  proposals,
  tasks,
  type OrbitId,
} from "./demo-data.js";
import "@fontsource/rubik/latin-400.css";
import "@fontsource/rubik/latin-500.css";
import "@fontsource/rubik/latin-600.css";
import "material-symbols/rounded.css";
import "./style.css";
import { AuthGate, csrfHeaders, logout } from "./auth-screen.js";
import { SetupScreen } from './setup-screen.js';
import { GoogleScreen, GoogleContinuationScreen } from './google-screen.js';
import { MailBody } from './mail-body.js';
import { MailScreen } from './mail-screen.js';

const queryClient = new QueryClient();
window.addEventListener('station:logout', () => {
  void queryClient.cancelQueries({ queryKey: ['mail-reader'] });
  queryClient.removeQueries({ queryKey: ['mail-reader'] });
});
function cachedMode(): AppearanceResponse["mode"] {
  try {
    const mode = localStorage.getItem("station-theme-mode");
    return mode === "light" || mode === "dark" ? mode : "system";
  } catch {
    return "system";
  }
}
function cacheMode(mode: AppearanceResponse["mode"]): void {
  try {
    localStorage.setItem("station-theme-mode", mode);
  } catch {
    // Settings remain saved on the server when browser storage is disabled.
  }
}
const fallback: AppearanceResponse = {
  mode: cachedMode(),
  showWallpaper: true,
  seed: DEFAULT_SEED,
  hasWallpaper: false,
};
const media = window.matchMedia("(prefers-color-scheme: dark)");
const subscribeSystemDark = (onChange: () => void) => {
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
const getSystemDark = () => media.matches;
const icon = (name: string, className = "") => (
  <span
    className={`material-symbols-rounded icon ${className}`}
    aria-hidden="true"
  >
    {name}
  </span>
);
const orbit = (id: OrbitId) => orbits.find((item) => item.id === id)!;
const orbitClass = (id: OrbitId) => `orbit-${orbit(id).slot}`;
const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function requestAppearance(): Promise<AppearanceResponse> {
  const response = await fetch("/api/appearance");
  if (!response.ok) throw new Error("Appearance settings are unavailable.");
  return appearanceResponseSchema.parse(await response.json());
}
async function changeAppearance(value: {
  mode: AppearanceResponse["mode"];
  showWallpaper: boolean;
}): Promise<AppearanceResponse> {
  const response = await fetch("/api/appearance", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify(value),
  });
  if (!response.ok)
    throw new Error("Appearance settings could not be saved. Try again.");
  return appearanceResponseSchema.parse(await response.json());
}
async function wallpaperRequest(
  method: "POST" | "DELETE",
  file?: File,
): Promise<AppearanceResponse> {
  const response = await fetch("/api/appearance/wallpaper", {
    method,
    ...(file
      ? { headers: { "Content-Type": file.type, ...csrfHeaders() }, body: file }
      : { headers: csrfHeaders() }),
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      result.error ?? "The wallpaper could not be changed. Try again.",
    );
  }
  return appearanceResponseSchema.parse(await response.json());
}

function OrbitTag({ id }: { id: OrbitId }) {
  return (
    <span className={`orbit-tag ${orbitClass(id)}`}>
      <span className="dot" />
      {orbit(id).name}
    </span>
  );
}
function Panel({
  title,
  meta,
  children,
  className = "",
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <h2>{title}</h2>
        {meta && <span className="meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Timeline({ setNotice }: { setNotice: (value: string) => void }) {
  return (
    <Panel
      title="Today across all Orbits"
      meta="8 am to 6 pm"
      className="timeline-panel"
    >
      <div className="timeline-scroll">
        <div className="timeline">
          <div className="time-labels">
            <span />
            {[8, 10, 12, 14, 16, 18].map((hour) => (
              <span key={hour}>
                {hour > 12 ? hour - 12 : hour} {hour >= 12 ? "pm" : "am"}
              </span>
            ))}
          </div>
          {orbits.map((item) => (
            <div className={`timeline-row orbit-${item.slot}`} key={item.id}>
              <div className="lane-name">
                <span className="dot" />
                {item.name}
              </div>
              <div className="lane-track">
                {events
                  .filter((event) => event.orbit === item.id)
                  .map((event) => (
                    <button
                      key={event.title}
                      className="event"
                      style={{
                        left: `${(event.start - 8) * 10}%`,
                        width: `${(event.end - event.start) * 10}%`,
                      }}
                      title={`${event.title}, ${event.start}:00`}
                      onClick={() =>
                        setNotice(`${event.title} is sample calendar data.`)
                      }
                    >
                      {event.title}
                    </button>
                  ))}
                <span className="now-line" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="conflict-note">
        {icon("warning")}Client network review (Consulting) overlaps Campaign
        check-in (Campaigns) at 11 am.
      </div>
    </Panel>
  );
}

function Mission({
  openCapcom,
  setNotice,
}: {
  openCapcom: () => void;
  setNotice: (value: string) => void;
}) {
  const [hiddenProposals, setHiddenProposals] = useState<number[]>([]);
  const [hiddenCleared, setHiddenCleared] = useState<number[]>([]);
  const [scheduled, setScheduled] = useState<Record<number, number | null>>({});
  const [tag, setTag] = useState("All");
  const filteredTasks = tasks.filter(
    (task) => tag === "All" || task.tag === tag,
  );
  return (
    <div className="mission-content">
      <section className="briefing">
        <div>
          <span className="eyebrow">Good morning, Alex</span>
          <h1>Monday, October 19</h1>
          <p>
            Six meetings today, and two of them overlap at 11:00. Four replies
            are waiting on you, the oldest from Thursday. The batch materials
            quote is due Wednesday and still has no draft.
          </p>
        </div>
        <button className="button primary" onClick={openCapcom}>
          {icon("auto_awesome")}Plan my day
        </button>
      </section>
      <Timeline setNotice={setNotice} />
      <div className="two-columns">
        <Panel title="Needs you" meta="Most urgent first">
          <div className="stack">
            {needs.map((item) => (
              <article
                className={`need-item ${orbitClass(item.orbit)}`}
                key={item.who}
              >
                <span className="monogram">{orbit(item.orbit).letter}</span>
                <div className="need-copy">
                  <div className="item-top">
                    <strong>{item.who}</strong>
                    <span className="muted">{item.via}</span>
                    <small>{item.age}</small>
                  </div>
                  <p>{item.what}</p>
                  <div className={`why ${item.urgent ? "urgent" : ""}`}>
                    {icon(item.urgent ? "priority_high" : "info")}
                    {item.why}
                  </div>
                </div>
                <div className="item-actions">
                  <button
                    className="button soft"
                    onClick={() =>
                      setNotice(
                        `Reply to ${item.who} is unavailable in this demo.`,
                      )
                    }
                  >
                    {icon("reply")}Reply
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Make task for ${item.who}`}
                    onClick={() =>
                      setNotice("Task creation is unavailable in this demo.")
                    }
                  >
                    {icon("add_task")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </Panel>
        <Panel title="Up next" meta="10:30 am">
          <div className="upnext">
            <OrbitTag id="consulting" />
            <h3>Client network review</h3>
            <p className="muted">10:30 to 11:30 am on Teams</p>
            <div className="conflict-note">
              {icon("warning")}Overlaps Campaign check-in at 11:00
            </div>
            <h4>Attendees</h4>
            <div className="chips">
              <span className="chip">Priya Shah, Northgate IT</span>
              <span className="chip">Marcus Lee, Northgate operations</span>
            </div>
            <h4>Before you join</h4>
            <ul className="prep">
              <li>
                Priya replied 20 minutes ago with a question about VLAN 30.
              </li>
              <li>
                The revised SOW they asked for this morning is still unsent.
              </li>
              <li>
                On October 5 you agreed to price a second switch. No pricing has
                gone out yet.
              </li>
            </ul>
            <div className="item-actions">
              <button
                className="button soft"
                onClick={() =>
                  setNotice("Joining calls is unavailable in this demo.")
                }
              >
                {icon("videocam")}Join call
              </button>
              <button className="button soft" onClick={openCapcom}>
                {icon("auto_awesome")}Prep me
              </button>
            </div>
          </div>
        </Panel>
      </div>
      <div className="three-columns">
        <Panel
          title="Review tray"
          meta={`${proposals.length - hiddenProposals.length} proposals`}
        >
          <div className="stack">
            {proposals
              .filter((item) => !hiddenProposals.includes(item.id))
              .map((item) => (
                <article className="small-item" key={item.id}>
                  <strong>{item.title}</strong>
                  <OrbitTag id={item.orbit} />
                  <p className="muted">{item.source}</p>
                  <div className="item-actions">
                    <button
                      className="button soft"
                      onClick={() =>
                        setNotice(
                          "This is a sample proposal. No task was created.",
                        )
                      }
                    >
                      Review
                    </button>
                    <button
                      className="button text"
                      onClick={() =>
                        setHiddenProposals([...hiddenProposals, item.id])
                      }
                    >
                      Dismiss
                    </button>
                  </div>
                </article>
              ))}
            {hiddenProposals.length > 0 && (
              <button
                className="button text"
                onClick={() => setHiddenProposals([])}
              >
                Restore dismissed samples
              </button>
            )}
          </div>
        </Panel>
        <Panel title="Promises" meta="Yours and theirs">
          <div className="promise-group">
            <h3>You promised</h3>
            {promises.mine.map(([title, detail]) => (
              <article className="small-item" key={title}>
                <strong>{title}</strong>
                <p className="muted">{detail}</p>
                <button
                  className="button text"
                  onClick={() =>
                    setNotice("Task creation is unavailable in this demo.")
                  }
                >
                  Make task
                </button>
              </article>
            ))}
            <h3>They promised</h3>
            {promises.theirs.map(([title, detail]) => (
              <article className="small-item" key={title}>
                <strong>{title}</strong>
                <p className="muted">{detail}</p>
                <button
                  className="button text"
                  onClick={() =>
                    setNotice("Drafting a nudge is unavailable in this demo.")
                  }
                >
                  Draft nudge
                </button>
              </article>
            ))}
          </div>
        </Panel>
        <Panel title="Recently auto-cleared">
          <div className="stack">
            {cleared
              .filter((item) => !hiddenCleared.includes(item.id))
              .map((item) => (
                <article className="small-item" key={item.id}>
                  <strong>{item.title}</strong>
                  <OrbitTag id={item.orbit} />
                  <p className="muted">{item.why}</p>
                  <button
                    className="button text"
                    onClick={() =>
                      setHiddenCleared([...hiddenCleared, item.id])
                    }
                  >
                    Undo sample
                  </button>
                </article>
              ))}
            {hiddenCleared.length > 0 && (
              <button
                className="button text"
                onClick={() => setHiddenCleared([])}
              >
                Restore cleared samples
              </button>
            )}
          </div>
        </Panel>
      </div>
      <Panel
        title="This week"
        meta="Move a sample task to another day. The due date stays the same."
        className="week-panel"
      >
        <div className="tag-filters">
          {["All", "finance", "IT", "marketing", "purchasing"].map((item) => (
            <button
              key={item}
              className={`chip-button ${tag === item ? "selected" : ""}`}
              aria-pressed={tag === item}
              onClick={() => setTag(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="board-scroll">
          <div className="week-board">
            {[null, 6, 0, 1, 2, 3, 4, 5].map((day) => (
              <div className="day-column" key={day ?? "unscheduled"}>
                <h3>{day === null ? "Unscheduled" : dayNames[day]}</h3>
                <small className="meeting-load">
                  {day === null
                    ? "No day selected"
                    : `${[4.5, 6, 2, 3, 1.5, 0, 0][day]}h meetings`}
                </small>
                {filteredTasks
                  .filter(
                    (task) =>
                      (scheduled[task.id] === undefined
                        ? task.day
                        : scheduled[task.id]) === day,
                  )
                  .map((task) => (
                    <article
                      className={`task-card ${orbitClass(task.orbit)}`}
                      key={task.id}
                    >
                      <span className="task-mark" />
                      <strong>{task.title}</strong>
                      <small>
                        {orbit(task.orbit).name} · {task.tag}
                      </small>
                      {task.due !== null && (
                        <small>Due {dayNames[task.due]}</small>
                      )}
                      <label className="schedule-label">
                        Schedule{" "}
                        <select
                          aria-label={`Schedule ${task.title}`}
                          value={day ?? "unscheduled"}
                          onChange={(event) =>
                            setScheduled({
                              ...scheduled,
                              [task.id]:
                                event.target.value === "unscheduled"
                                  ? null
                                  : Number(event.target.value),
                            })
                          }
                        >
                          {dayNames.map((name, index) => (
                            <option key={name} value={index}>
                              {name}
                            </option>
                          ))}
                          <option value="unscheduled">Unscheduled</option>
                        </select>
                      </label>
                    </article>
                  ))}
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function OrbitView({
  id,
  setNotice,
}: {
  id: OrbitId;
  setNotice: (value: string) => void;
}) {
  const item = orbit(id);
  return (
    <div className={`orbit-view ${orbitClass(id)}`}>
      <section className="orbit-hero">
        <span className="eyebrow">Orbit</span>
        <h1>{item.name}</h1>
        <p>{item.context}</p>
        <div className="chips">
          {item.sources.map((source) => (
            <span className="chip" key={source}>
              {source}
            </span>
          ))}
        </div>
      </section>
      <div className="two-columns">
        <Panel title="Inbox and chat" meta="Sample items">
          <div className="stack">
            {inbox[id].map((message) => (
              <button
                className="message-row"
                key={message.subject}
                onClick={() => setNotice(`${message.subject} is sample data.`)}
              >
                <span className="message-main">
                  <strong>{message.from}</strong>
                  <span className="muted">
                    {message.via} · {message.subject}
                  </span>
                  <small>{message.snippet}</small>
                </span>
                <small>{message.when}</small>
              </button>
            ))}
          </div>
        </Panel>
        <Panel title="Today" meta="Meetings">
          <div className="stack">
            {events
              .filter((event) => event.orbit === id)
              .map((event) => (
                <article className="small-item" key={event.title}>
                  <strong>{event.title}</strong>
                  <p className="muted">
                    {event.start}:00 to {event.end}:00
                  </p>
                </article>
              ))}
          </div>
        </Panel>
      </div>
      <Panel title="Open tasks" meta="Sample tasks">
        <div className="stack">
          {tasks
            .filter((task) => task.orbit === id)
            .map((task) => (
              <article className="small-item" key={task.id}>
                <strong>{task.title}</strong>
                <p className="muted">
                  {task.tag}
                  {task.due !== null ? ` · Due ${dayNames[task.due]}` : ""}
                </p>
              </article>
            ))}
        </div>
      </Panel>
    </div>
  );
}

function App({ active, thread, draftRoute }: { active: 'mission' | OrbitId | 'mail'; thread?: { accountId: string; threadId: string }; draftRoute?: { accountId: string; draftId: string } }) {
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [capcomOpen, setCapcomOpen] = useState(false);
  const [blackout, setBlackout] = useState(false);
  const [notice, setNotice] = useState("");
  const systemDark = useSyncExternalStore(subscribeSystemDark, getSystemDark);
  const [wallVersion, setWallVersion] = useState(0);
  const [clock, setClock] = useState(() =>
    new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  );
  const settingsRef = useRef<HTMLDialogElement>(null);
  const capcomRef = useRef<HTMLDivElement>(null);
  const launchRef = useRef<HTMLButtonElement>(null);
  const capcomWasOpen = useRef(false);
  const appearance = useQuery({
    queryKey: ["appearance"],
    queryFn: requestAppearance,
    retry: false,
  });
  const value = appearance.data ?? fallback;
  const save = useMutation({
    mutationFn: changeAppearance,
    onSuccess: (result) => {
      queryClient.setQueryData(["appearance"], result);
      cacheMode(result.mode);
    },
    onError: (error) => setNotice(error.message),
  });
  const wall = useMutation({
    mutationFn: ({
      method,
      file,
    }: {
      method: "POST" | "DELETE";
      file?: File;
    }) => wallpaperRequest(method, file),
    onSuccess: (result) => {
      queryClient.setQueryData(["appearance"], result);
      setWallVersion((current) => current + 1);
    },
    onError: (error) => setNotice(error.message),
  });
  useEffect(() => {
    if (appearance.data) cacheMode(appearance.data.mode);
  }, [appearance.data]);
  useEffect(() => {
    applyTheme(
      value.seed,
      value.mode === "dark" || (value.mode === "system" && systemDark),
    );
  }, [value.seed, value.mode, systemDark]);
  useEffect(() => {
    const timer = window.setInterval(
      () =>
        setClock(
          new Date().toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          }),
        ),
      30_000,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (settingsOpen) settingsRef.current?.showModal();
    else settingsRef.current?.close();
  }, [settingsOpen]);
  useEffect(() => {
    if (capcomOpen) {
      capcomWasOpen.current = true;
      capcomRef.current?.focus();
    } else if (capcomWasOpen.current) {
      capcomWasOpen.current = false;
      launchRef.current?.focus();
    }
  }, [capcomOpen]);
  useEffect(() => {
    if (active === 'mail') return;
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!settingsRef.current?.open) setCapcomOpen(true);
      }
      if (event.key === "Escape") setCapcomOpen(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [active]);
  useEffect(() => {
    if (!capcomOpen) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const close = capcomRef.current?.querySelector<HTMLButtonElement>(
        'button[aria-label="Close CAPCOM"]',
      );
      if (close) {
        event.preventDefault();
        close.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [capcomOpen]);
  const selected = active === "mission" || active === 'mail' ? null : orbit(active);
  const wallpaper =
    value.hasWallpaper && value.showWallpaper
      ? `/api/appearance/wallpaper?v=${wallVersion}`
      : undefined;
  return (
    <div
      className={`app-frame ${wallpaper ? "has-wallpaper" : ""}`}
      style={
        wallpaper
          ? {
              backgroundImage: `url('${wallpaper}')`,
            }
          : undefined
      }
    >
      <nav className="side-bar" aria-label="Main">
        <div className="logo" title={PRODUCT_NAME}>
          {icon("planet")}
        </div>
        <button
          className={`nav-button ${active === "mission" ? "active" : ""}`}
          aria-label="Mission Control"
          aria-current={active === "mission" ? "page" : undefined}
          onClick={() => void navigate({ to: '/' })}
        >
          {icon("space_dashboard")}
        </button>
        <span className="bar-divider" />
        {orbits.map((item) => (
          <button
            key={item.id}
            className={`orbit-button orbit-${item.slot} ${active === item.id ? "active" : ""}`}
            aria-label={item.name}
            aria-current={active === item.id ? "page" : undefined}
            title={`${item.name} sample Orbit`}
            onClick={() => void navigate({ to: '/demo/orbits/$orbitId', params: { orbitId: item.id } })}
          >
            <span>{item.letter}</span>
            <small>{item.badge}</small>
          </button>
        ))}
        <span className="bar-divider tools" />
        <button
          className={`nav-button ${active === 'mail' ? 'active' : ''}`}
          aria-label="Mail"
          aria-current={active === 'mail' ? 'page' : undefined}
          onClick={() => void navigate({ to: '/mail' })}
        >
          {icon("mail")}
        </button>
        <button
          className="nav-button tools"
          disabled
          title="Calendar is coming later"
          aria-label="Calendar unavailable"
        >
          {icon("calendar_month")}
        </button>
        <span className="bar-spacer" />
        <span className="avatar" title="Demo account">
          AK
        </span>
        <button
          className="nav-button"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          {icon("settings")}
        </button>
        <button
          className="nav-button"
          aria-label="Sign out"
          onClick={() => void logout()}
        >
          {icon("logout")}
        </button>
      </nav>
      <header className="top-bar">
        <div className="location">
          <h2>{active === 'mail' ? 'Mail' : selected?.name ?? "Mission Control"}</h2>
          <small>
            {active === 'mail' ? 'Connected mailboxes · Live data' : selected ? "Orbit · Sample data" : "All Orbits · Sample data"}
          </small>
        </div>
        {active !== 'mail' && <button
          ref={launchRef}
          className="search-launch"
          aria-label="Search or ask CAPCOM"
          onClick={() => setCapcomOpen(true)}
        >
          {icon("search")}
          <span>Search or ask CAPCOM</span>
          <kbd>Ctrl K</kbd>
        </button>}
        <div className="top-tools">
          <time>{clock}</time>
          {active !== 'mail' && <button
            className={`nav-button ${blackout ? "active" : ""}`}
            aria-label="Blackout"
            aria-pressed={blackout}
            title="Hold other Orbit notifications in this demo"
            onClick={() => setBlackout(!blackout)}
          >
            {icon("do_not_disturb_on")}
          </button>}
        </div>
      </header>
      <main className="interior">
        {active === 'mail' ? <MailScreen {...(thread ? { thread } : {})} {...(draftRoute ? { draftRoute } : {})} /> : <>
        <div className="sample-setup-link"><a href="/setup">Set up your first Orbit</a><span>Sample Mission Control</span></div>
        {blackout && (
          <div className="blackout-note">
            Blackout is on for this demo. Notifications are not connected.
          </div>
        )}
        {active === "mission" ? (
          <Mission
            openCapcom={() => setCapcomOpen(true)}
            setNotice={setNotice}
          />
        ) : (
          <OrbitView id={active} setNotice={setNotice} />
        )}
        </>}
      </main>
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button
            className="icon-button"
            aria-label="Dismiss message"
            onClick={() => setNotice("")}
          >
            {icon("close")}
          </button>
        </div>
      )}
      {capcomOpen && (
        <>
          <button
            className="overlay"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setCapcomOpen(false)}
          />
          <aside
            ref={capcomRef}
            tabIndex={-1}
            className="capcom-panel"
            role="dialog"
            aria-modal="true"
            aria-label="CAPCOM"
          >
            <div className="panel-head">
              <h2>CAPCOM</h2>
              <button
                className="icon-button"
                aria-label="Close CAPCOM"
                onClick={() => setCapcomOpen(false)}
              >
                {icon("close")}
              </button>
            </div>
            <span className="demo-badge">Demo preview</span>
            <p>
              CAPCOM will answer questions from connected sources and cite what
              it used. No sources are connected yet.
            </p>
            <div className="sample-answer">
              <strong>Example question</strong>
              <p>
                What did the sand supplier say about price changes this fall?
              </p>
              <strong>Example answer</strong>
              <p>
                Riverside Silica announced a 6% increase on batch sand starting
                November 1. This is sample content and has no live sources.
              </p>
            </div>
            <label htmlFor="capcom-question">Ask CAPCOM</label>
            <input
              id="capcom-question"
              placeholder="Connect sources to ask a question"
              disabled
            />
            <p className="muted">Questions become available after setup.</p>
          </aside>
        </>
      )}
      <dialog
        ref={settingsRef}
        className="settings-dialog"
        onClose={() => setSettingsOpen(false)}
        aria-label="Settings"
      >
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <h2>Settings</h2>
            <button className="selected">{icon("palette")}Appearance</button>
            <button disabled>{icon("alternate_email")}Accounts</button>
            <button disabled>{icon("orbit")}Orbits</button>
            <button disabled>{icon("auto_awesome")}AI provider</button>
            <button disabled>{icon("shield")}Privacy</button>
          </nav>
          <div className="settings-body">
            <button
              className="icon-button close-settings"
              aria-label="Close settings"
              onClick={() => setSettingsOpen(false)}
            >
              {icon("close")}
            </button>
            <h2>Appearance</h2>
            <p className="muted">
              Choose how your workspace looks on this device.
            </p>
            {appearance.isError && (
              <p role="alert">
                Appearance settings are unavailable. Check the server
                connection.
              </p>
            )}
            <div className="setting-row wall-row">
              <div
                className="wall-preview"
                style={
                  value.hasWallpaper
                    ? {
                        backgroundImage: `url('/api/appearance/wallpaper?v=${wallVersion}')`,
                      }
                    : undefined
                }
              />
              <div>
                <h3>Wallpaper</h3>
                <p className="muted">
                  Upload a PNG, JPEG, or WebP. The server stores a smaller
                  private copy.
                </p>
                <div className="palette" aria-label="Current palette">
                  {[
                    "primary",
                    "secondary-container",
                    "tertiary",
                    "orbit-1-container",
                    "orbit-2-container",
                    "orbit-3-container",
                    "orbit-4-container",
                  ].map((role) => (
                    <span key={role} style={{ background: `var(--${role})` }} />
                  ))}
                </div>
                <div className="item-actions">
                  <input
                    id="wall-file"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) wall.mutate({ method: "POST", file });
                      event.target.value = "";
                    }}
                    disabled={appearance.isError || wall.isPending}
                  />
                  <label
                    className="button primary upload-label"
                    htmlFor="wall-file"
                  >
                    {icon("upload")}Upload image
                  </label>
                  <button
                    className="button soft"
                    disabled={
                      !value.hasWallpaper ||
                      wall.isPending ||
                      appearance.isError
                    }
                    onClick={() => wall.mutate({ method: "DELETE" })}
                  >
                    {icon("restart_alt")}Use default
                  </button>
                </div>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <h3>Theme</h3>
                <p className="muted">
                  System follows your device's light or dark setting.
                </p>
              </div>
              <div className="segmented" role="group" aria-label="Theme">
                {(["system", "light", "dark"] as const).map((mode) => (
                  <button
                    key={mode}
                    aria-pressed={value.mode === mode}
                    disabled={save.isPending || appearance.isError}
                    onClick={() =>
                      save.mutate({ mode, showWallpaper: value.showWallpaper })
                    }
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <div>
                <h3>Show wallpaper between panels</h3>
                <p className="muted">Turn off for a solid background.</p>
              </div>
              <button
                className={`switch ${value.showWallpaper ? "on" : ""}`}
                role="switch"
                aria-label="Show wallpaper between panels"
                aria-checked={value.showWallpaper}
                disabled={save.isPending || appearance.isError}
                onClick={() =>
                  save.mutate({
                    mode: value.mode,
                    showWallpaper: !value.showWallpaper,
                  })
                }
              >
                <span />
              </button>
            </div>
          </div>
        </div>
      </dialog>
    </div>
  );
}

document.title = PRODUCT_NAME;
const rootRoute = createRootRoute({ component: () => <Outlet /> });
const missionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <App active="mission" /> });
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/setup', component: SetupScreen });
const googleRoute = createRoute({ getParentRoute: () => rootRoute, path: '/setup/google', component: GoogleScreen });
const googleContinueRoute = createRoute({ getParentRoute: () => rootRoute, path: '/setup/google/continue', component: GoogleContinuationScreen });
const orbitRoute = createRoute({ getParentRoute: () => rootRoute, path: '/demo/orbits/$orbitId', component: () => {
  const { orbitId } = orbitRoute.useParams();
  return <App active={orbits.some((entry) => entry.id === orbitId) ? orbitId as OrbitId : 'mission'} />;
} });
const mailRoute = createRoute({ getParentRoute: () => rootRoute, path: '/mail', component: () => <App active="mail" /> });
const mailThreadRoute = createRoute({ getParentRoute: () => rootRoute, path: '/mail/thread/$accountId/$threadId', component: () => {
  const { accountId, threadId } = mailThreadRoute.useParams();
  return <App active="mail" thread={{ accountId, threadId }} />;
} });
const mailDraftRoute = createRoute({ getParentRoute: () => rootRoute, path: '/mail/draft/$accountId/$draftId', component: () => {
  const { accountId, draftId } = mailDraftRoute.useParams();
  return <App active="mail" draftRoute={{ accountId, draftId }} />;
} });
const mailBodyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/mail/body/$accountId/$itemId', component: () => {
  const { accountId, itemId } = mailBodyRoute.useParams();
  const search = useLocation({ select: (location) => location.searchStr });
  const orbitId = new URLSearchParams(search).get('orbitId') ?? undefined;
  return <MailBody accountId={accountId} itemId={itemId} {...(orbitId ? { orbitId } : {})} />;
} });
const router = createRouter({ routeTree: rootRoute.addChildren([missionRoute, setupRoute, googleRoute, googleContinueRoute, orbitRoute, mailRoute, mailThreadRoute, mailDraftRoute, mailBodyRoute]) });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <RouterProvider router={router} />
      </AuthGate>
    </QueryClientProvider>
  </React.StrictMode>,
);
